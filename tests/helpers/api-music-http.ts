import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { request } from 'node:http';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { musicModuleSource } from './api-music-source';
import { musicServiceFixture } from './api-music-service';
export async function musicHttpFixture() {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/routes/music.ts',
    { ipcMain: new EventEmitter() },
  );
  if (!m.registerMusicRoutes) throw Error('Missing guarded music routes');
  const f = await musicServiceFixture(),
    app = new Hono();
  m.registerMusicRoutes(
    app,
    () => f.service,
    () => ({ resource: f.service.resource, current: () => true }),
  );
  app.use('*', cors());
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Private-Network', 'true');
    await next();
  });
  app.get('/api/v1/song', (c) => c.json({ legacy: 'NONE unchanged' }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  f.service.configure({ ...f.config, port });
  const grant = await f.store.issue(
    'Socket',
    'rest',
    f.service.resource,
    ['catalog.read', 'playback.read'],
    () => true,
  );
  const host = '127.0.0.1:' + port,
    url = 'http://' + host;
  const http = (
    target: string,
    method = 'GET',
    body?: string,
    headers: Record<string, string> = {},
  ) =>
    new Promise<any>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: target,
          method,
          headers: {
            host,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              body: text ? JSON.parse(text) : null,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const raw = (message: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.end(message));
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (c) => (data += c));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
  return {
    ...f,
    app,
    server,
    grant,
    host,
    port,
    url,
    http,
    raw,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await f.close();
    },
  };
}
