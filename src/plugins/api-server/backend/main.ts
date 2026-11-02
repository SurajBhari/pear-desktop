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
import {
  captureLegacyClock,
  captureLegacyRequestScope,
  configureLegacyClock,
  stopLegacyClock,
} from './legacy-clock';
import { publishMcpGrantTarget, retireMcpGrantTarget } from './mcp-owner';
import { MusicGrantStore } from './music-grant-store';
import {
  musicHttpResources,
  normalizeMusicIp,
  type MusicHttpListenerOwner,
} from './music-http-policy';
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
    this.retireMcpListener();
    this.retireMusicHttpOwner();
    if (this.musicWindow) stopLegacyClock(this.musicWindow);
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
    this.retireMcpListener();
    this.retireMusicHttpOwner();
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
      this.publishMusicHttpOwner();
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
      (incoming) => {
        const owner = this.app === owningApp ? this.musicHttpOwner : undefined;
        return owner?.ownsSocket(incoming.socket) ? owner : undefined;
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
    for (const alias of ['song', 'song-info'])
      this.app.use(`/api/${API_VERSION}/${alias}`, async (ctx, next) => {
        captureLegacyRequestScope(ctx.req.raw, backendCtx.window);
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
      (info, ctx) => {
        const payload: unknown = ctx.get('jwtPayload');
        const principal =
          payload &&
          typeof payload === 'object' &&
          'id' in payload &&
          typeof payload.id === 'string'
            ? payload.id
            : 'legacy-anonymous';
        return captureLegacyClock(
          backendCtx.window,
          info,
          principal,
          ctx.req.raw,
          () => this.app === owningApp && this.songInfo === info,
        );
      },
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
    this.retireMusicHttpOwner();
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

      const server = serve(serveOptions);
      this.server = server;
      this.musicHttpServer = server;
      this.musicHttpTls = !!(
        config.useHttps &&
        config.certPath &&
        config.keyPath
      );
      const sockets = new WeakSet<object>();
      this.musicHttpSockets = sockets;
      server.on('connection', (socket: object) => sockets.add(socket));
      server.on('secureConnection', (socket: object) => sockets.add(socket));
      server.once('listening', () => {
        if (this.server !== server) return;
        this.publishMusicHttpOwner();
        const owner = this.musicHttpOwner,
          service = this.musicService,
          window = this.musicWindow;
        if (!owner || !service || !window || !service.enabled) return;
        const isCurrent = () =>
          this.musicHttpOwner === owner &&
          this.server === server &&
          this.musicService === service &&
          this.musicWindow === window &&
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          owner.current();
        // A startup menu may have captured unavailable REST access before bind.
        // Fence its replacement to this exact listener/authorization lifetime.
        import('@/menu')
          .then(({ refreshMenu }) =>
            isCurrent() ? refreshMenu(window, isCurrent) : undefined,
          )
          .catch(() => {});
      });
      const retired = () => {
        if (this.server === server) {
          this.retireMusicHttpOwner();
          this.musicHttpServer = undefined;
          this.musicHttpSockets = undefined;
        }
      };
      server.once('close', retired);
      server.on('error', retired);
    } catch (err) {
      console.error(err);
    }
  },
  end() {
    this.retireMcpListener();
    this.retireMusicHttpOwner();
    this.musicHttpServer = undefined;
    this.musicHttpSockets = undefined;
    if (this.musicWindow) stopLegacyClock(this.musicWindow);
    this.musicService?.stop();
    this.musicService = undefined;
    this.queueRequestScope?.abort();
    this.queueRequestScope = undefined;
    this.server?.close();
    this.server = undefined;
  },
  retireMusicHttpOwner(owner?: MusicHttpListenerOwner) {
    if (owner && this.musicHttpOwner !== owner) return;
    this.musicHttpRetirement?.abort();
    this.musicHttpRetirement = undefined;
    this.musicHttpOwner = undefined;
  },
  publishMusicHttpOwner() {
    this.retireMusicHttpOwner();
    const server = this.server,
      service = this.musicService,
      sockets = this.musicHttpSockets;
    const config = this.musicConfig;
    if (
      !server?.listening ||
      this.musicHttpServer !== server ||
      !service ||
      !sockets ||
      !config
    )
      return;
    const address = server.address();
    if (
      !address ||
      typeof address === 'string' ||
      !normalizeMusicIp(address.address)
    )
      return;
    const revision = this.musicConfigRevision,
      start = this.startRevision,
      app = this.app;
    const controller = new AbortController();
    const owner: MusicHttpListenerOwner = Object.freeze({
      identity: {},
      address: address.address,
      port: address.port,
      tls: this.musicHttpTls === true,
      resources: musicHttpResources(config),
      signal: controller.signal,
      ownsSocket: (socket: object) => sockets.has(socket),
      current: () =>
        !controller.signal.aborted &&
        this.musicHttpOwner === owner &&
        this.server === server &&
        this.musicHttpServer === server &&
        this.musicHttpSockets === sockets &&
        this.musicService === service &&
        this.app === app &&
        this.musicConfigRevision === revision &&
        this.startRevision === start &&
        server.listening,
    });
    this.musicHttpRetirement = controller;
    this.musicHttpOwner = owner;
  },
  configureMusic(config) {
    if (this.musicWindow) configureLegacyClock(this.musicWindow, config);
    this.musicConfig = { ...config };
    if (this.musicService) {
      this.musicService.configure(config);
      this.configureMcp(config);
      return;
    }
    if ((!config.musicApiEnabled && !config.mcpEnabled) || !this.musicWindow)
      return;
    this.musicGrants ??= new MusicGrantStore(
      path.join(electronApp.getPath('userData'), 'music-client-grants'),
    );
    this.musicService = createMusicService({
      window: this.musicWindow,
      config,
      grants: this.musicGrants,
      restListenerOwner: () => this.musicHttpOwner,
      resolveAccessOwner: (transport, resource) =>
        transport === 'mcp' && this.mcpListener?.resource === resource
          ? this.mcpListener.owner
          : undefined,
    });
    this.configureMcp(config);
  },
  retireMcpListener() {
    this.mcpRevision = (this.mcpRevision ?? 0) + 1;
    const listener = this.mcpListener;
    this.mcpListener = undefined;
    if (listener) {
      if (this.musicWindow) retireMcpGrantTarget(this.musicWindow, listener);
      listener.stop().catch(() => {});
    }
  },
  configureMcp(config) {
    this.retireMcpListener();
    const revision = this.mcpRevision,
      service = this.musicService,
      grants = this.musicGrants,
      window = this.musicWindow;
    const port = config.mcpPort ?? 26539;
    if (
      !config.enabled ||
      !config.mcpEnabled ||
      !service ||
      !grants ||
      !window ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      return;
    import('./mcp')
      .then(async ({ createMcpListener }) => {
        if (
          revision !== this.mcpRevision ||
          this.musicService !== service ||
          this.musicWindow !== window
        )
          return;
        const listener = createMcpListener({ service, grants, port });
        this.mcpListener = listener;
        const isCurrent = () =>
          revision === this.mcpRevision &&
          this.mcpListener === listener &&
          this.musicService === service &&
          this.musicWindow === window &&
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          listener.owner.current();
        try {
          await listener.start();
          if (!isCurrent()) {
            await listener.stop();
            return;
          }
          publishMcpGrantTarget(window, listener);
          // Config-driven menus can snapshot before the asynchronous bind is ready.
          // Keep later template publication fenced to this exact listener owner.
          import('@/menu')
            .then(({ refreshMenu }) =>
              isCurrent() ? refreshMenu(window, isCurrent) : undefined,
            )
            .catch(() => {});
        } catch {
          if (this.mcpListener === listener) this.mcpListener = undefined;
          await listener.stop();
        }
      })
      .catch(() => {});
  },
});
