import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';

import { serve, upgradeWebSocket } from '@hono/node-server';
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono as Hono } from '@hono/zod-openapi';
import { app as electronApp } from 'electron';
import { cors } from 'hono/cors';
import { jwt } from 'hono/jwt';
import { WebSocketServer } from 'ws';

import { APPLICATION_NAME } from '@/i18n';
import { registerCallback } from '@/providers/song-info';
import { createBackend } from '@/utils';

import { API_VERSION } from './api-version';
import { MusicGrantStore } from './music-grant-store';
import { createMusicService } from './music-service';
import { registerAuth, registerControl, registerWebsocket } from './routes';
import { registerMusicRoutes } from './routes/music';
import { JWTPayloadSchema } from './scheme';

import { type APIServerConfig, AuthStrategy } from '../config';

import type { BackendType } from './types';
import type {
  LikeType,
  RepeatMode,
  VolumeState,
} from '@/types/datahost-get-state';
import type { MiddlewareHandler } from 'hono';

export const backend = createBackend<BackendType, APIServerConfig>({
  async start(ctx) {
    this.musicService?.stop();
    this.musicService = undefined;
    this.musicWindow = undefined;
    this.queueRequestScope?.abort();
    this.queueRequestScope = undefined;
    const revision = (this.startRevision = (this.startRevision ?? 0) + 1);
    this.unsubscribeSongInfo?.();
    this.unsubscribeSongInfo = undefined;
    this.songInfo = undefined;
    this.currentRepeatMode = undefined;
    const configRevision = this.musicConfigRevision ?? 0;
    let config = await ctx.getConfig();
    if (revision !== this.startRevision) return;
    if (configRevision !== (this.musicConfigRevision ?? 0) && this.musicConfig)
      config = this.musicConfig;

    this.init(ctx);
    this.unsubscribeSongInfo = registerCallback(
      (songInfo) => {
        if (revision === this.startRevision) this.songInfo = songInfo;
      },
      { replayCurrent: true },
    );

    ctx.ipc.on('peard:volume-changed', (newVolumeState: VolumeState) => {
      if (revision === this.startRevision) this.volumeState = newVolumeState;
    });
    const setupVolume = () => {
      if (revision === this.startRevision)
        ctx.ipc.send('peard:setup-volume-changed-listener');
    };
    ctx.ipc.on('peard:repeat-changed', (mode: RepeatMode) => {
      if (revision === this.startRevision) this.currentRepeatMode = mode;
    });
    const setupRepeat = () => {
      if (revision === this.startRevision)
        ctx.ipc.send('peard:setup-repeat-changed-listener');
    };
    ctx.ipc.on('peard:player-api-loaded', () => {
      ctx.ipc.send('peard:setup-seeked-listener');
      ctx.ipc.send('peard:setup-time-changed-listener');
      setupRepeat();
      ctx.ipc.send('peard:setup-like-changed-listener');
      setupVolume();
      ctx.ipc.send('peard:setup-shuffle-changed-listener');
    });

    setupRepeat();
    setupVolume();
    this.run(config);
  },
  stop() {
    this.startRevision = (this.startRevision ?? 0) + 1;
    this.unsubscribeSongInfo?.();
    this.unsubscribeSongInfo = undefined;
    this.songInfo = undefined;
    this.end();
  },
  onConfigChange(config) {
    this.musicConfigRevision = (this.musicConfigRevision ?? 0) + 1;
    // Reconfiguration, including authorization changes, retires admitted playlist work.
    this.queueRequestScope?.abort();
    this.queueRequestScope = new AbortController();
    this.configureMusic(config);
    const old = this.oldConfig;
    if (
      old?.hostname === config.hostname &&
      old?.port === config.port &&
      old?.useHttps === config.useHttps &&
      old?.certPath === config.certPath &&
      old?.keyPath === config.keyPath
    ) {
      this.oldConfig = config;
      return;
    }

    this.end();
    this.run(config);
    this.oldConfig = config;
  },

  // Custom
  init(backendCtx) {
    this.musicWindow = backendCtx.window;
    this.app = new Hono<{ Variables: { playlistQueueSignal?: AbortSignal } }>();
    const owningApp = this.app;

    registerMusicRoutes(
      this.app,
      () => (this.app === owningApp ? this.musicService : undefined),
      () => {
        const service = this.app === owningApp ? this.musicService : undefined;
        if (!service) return;
        const config = this.musicConfig;
        return {
          resource: service.resource,
          current: () =>
            this.app === owningApp &&
            this.musicService === service &&
            this.musicConfig === config,
        };
      },
    );

    this.app.use('*', cors());

    // for web remote control
    this.app.use('*', async (ctx, next) => {
      ctx.header('Access-Control-Allow-Private-Network', 'true');
      await next();
    });

    // Capture scope before asynchronous authentication so stop/reconfigure cannot admit old work later.
    this.app.use(`/api/${API_VERSION}/queue/playlist`, async (ctx, next) => {
      ctx.set(
        'playlistQueueSignal',
        this.app === owningApp
          ? (this.queueRequestScope?.signal ?? AbortSignal.abort())
          : AbortSignal.abort(),
      );
      await next();
    });
    // middlewares
    const jwtGuard: MiddlewareHandler = async (ctx, next) => {
      if (ctx.req.path.endsWith(`${API_VERSION}/ws`)) {
        return await next();
      }

      const config = await backendCtx.getConfig();

      if (config.authStrategy !== AuthStrategy.NONE) {
        return await jwt({
          secret: config.secret,
          alg: 'HS256',
        })(ctx, next);
      }
      return await next();
    };
    this.app.use('/api/*', jwtGuard);
    this.app.use('/api/*', async (ctx, next) => {
      if (ctx.req.path.endsWith(`${API_VERSION}/ws`)) {
        return await next();
      }

      const result = await JWTPayloadSchema.spa(await ctx.get('jwtPayload'));
      const config = await backendCtx.getConfig();

      const isAuthorized =
        config.authStrategy === AuthStrategy.NONE ||
        (result.success && config.authorizedClients.includes(result.data.id));
      if (!isAuthorized) {
        ctx.status(401);
        return ctx.body('Unauthorized');
      }

      return await next();
    });

    // routes
    registerControl(
      this.app,
      backendCtx,
      () => this.songInfo,
      () => this.currentRepeatMode,
      () =>
        backendCtx.window.webContents.executeJavaScript(
          'document.querySelector("#like-button-renderer")?.likeStatus',
        ) as Promise<LikeType>,
      () => this.volumeState,
    );
    registerAuth(this.app, backendCtx);
    registerWebsocket(this.app, backendCtx, upgradeWebSocket);

    // swagger
    this.app.openAPIRegistry.registerComponent(
      'securitySchemes',
      'bearerAuth',
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    );
    this.app.doc('/doc', {
      openapi: '3.1.0',
      info: {
        version: '1.0.0',
        title: `${APPLICATION_NAME} API Server`,
        description:
          'Note: You need to get an access token using the `/auth/{id}` endpoint first to call any API endpoints under `/api`.',
      },
      security: [
        {
          bearerAuth: [],
        },
      ],
    });

    this.app.get('/swagger', swaggerUI({ url: '/doc' }));
  },
  run(config) {
    if (!this.app) return;
    this.configureMusic(config);
    if (!this.queueRequestScope || this.queueRequestScope.signal.aborted)
      this.queueRequestScope = new AbortController();

    try {
      const wss = new WebSocketServer({ noServer: true });
      const serveOptions =
        config.useHttps && config.certPath && config.keyPath
          ? {
              fetch: this.app.fetch.bind(this.app),
              port: config.port,
              hostname: config.hostname,
              createServer: createHttpsServer,
              serverOptions: {
                key: readFileSync(config.keyPath),
                cert: readFileSync(config.certPath),
              },
              websocket: { server: wss },
            }
          : {
              fetch: this.app.fetch.bind(this.app),
              port: config.port,
              hostname: config.hostname,
              createServer: createHttpServer,
              websocket: { server: wss },
            };

      this.server = serve(serveOptions);
    } catch (err) {
      console.error(err);
    }
  },
  end() {
    this.musicService?.stop();
    this.musicService = undefined;
    this.queueRequestScope?.abort();
    this.queueRequestScope = undefined;
    this.server?.close();
    this.server = undefined;
  },
  configureMusic(config) {
    this.musicConfig = { ...config };
    if (this.musicService) {
      this.musicService.configure(config);
      return;
    }
    if (!config.musicApiEnabled || !this.musicWindow) return;
    this.musicGrants ??= new MusicGrantStore(
      path.join(electronApp.getPath('userData'), 'music-client-grants'),
    );
    this.musicService = createMusicService({
      window: this.musicWindow,
      config,
      grants: this.musicGrants,
    });
  },
});
