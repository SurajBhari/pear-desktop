import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));
async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-api-music-listener-'),
  );
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `
export {setupSongInfo,registerCallback,SongInfoEvent} from ${JSON.stringify(path.join(root, 'src/providers/song-info.ts'))};
export {getMusicService} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/music-service.ts'))};
export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/main.ts'))};
export {ipcMain,fixtureWindow,createFixtureWindow,fixtureNetwork,app} from 'electron';
`,
  );
  const electron = `
import {EventEmitter} from 'node:events';
export const ipcMain=new EventEmitter(); export const app=Object.assign(new EventEmitter(),{getPath:()=>${JSON.stringify(directory)}});
class FixtureWindow extends EventEmitter {
 destroyed=false; messages=[]; webContents=Object.assign(new EventEmitter(),{isDestroyed:()=>this.destroyed,mainFrame:{},send:(...args)=>this.messages.push(args),executeJavaScript:async()=>undefined});
 isDestroyed(){return this.destroyed;} destroy(){this.destroyed=true;this.emit('closed');}
}
export const createFixtureWindow=()=>new FixtureWindow();export const fixtureWindow=createFixtureWindow();
export const fixtureNetwork=[];
export const nativeImage={createFromBuffer:()=>({isEmpty:()=>false})};
export const net={fetch:async(...args)=>{fixtureNetwork.push(args);throw new Error('Fixture prohibits remote artwork/network');}};
export const dialog={showMessageBox:async()=>({response:1})};
`;
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const bundle = await rolldown({
    input: entry,
    platform: 'node',
    plugins: [
      {
        name: 'controlled-native-boundaries',
        async resolveId(id: string) {
          if (id === 'electron') return '\0fixture-electron';
          if (id === '@/config') return '\0fixture-config';
          if (id === '@/i18n') return '\0fixture-i18n';
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            const { access } = await import('node:fs/promises');
            for (const suffix of ['.ts', '/index.ts', '.tsx']) {
              try {
                await access(target + suffix);
                return target + suffix;
              } catch {
                /* try next source suffix */
              }
            }
          }
          if (
            !id.startsWith('.') &&
            !path.isAbsolute(id) &&
            !id.startsWith('\0')
          ) {
            return {
              id: id.startsWith('node:')
                ? id
                : requireRoot.resolve(id).replaceAll('\\', '/'),
              external: true,
            };
          }
          return undefined;
        },
        load(id: string) {
          if (id === '\0fixture-electron') return electron;
          if (id === '\0fixture-config')
            return 'export const get=()=>false; export const set=()=>{};';
          if (id === '\0fixture-i18n')
            return "export const APPLICATION_NAME='Public Fixture'; export const t=(key)=>key;";
          return undefined;
        },
      },
    ],
  });
  const output = path.join(directory, 'actual-source.cjs');
  await bundle.write({ file: output, format: 'cjs' });
  await bundle.close();
  // Only native/config/translation boundaries are supplied. Provider, mutex,
  // backend lifecycle, Hono middleware, route handlers and schemas are real.
  const source = requireRoot(output);
  const { backend, ipcMain, fixtureWindow } = source;
  source.setupSongInfo(fixtureWindow);
  let cached: unknown;
  let writes = 0;
  Object.defineProperty(backend, 'songInfo', {
    configurable: true,
    get: () => cached,
    set(value: unknown) {
      if (value) writes++;
      cached = value;
    },
  });
  const config = {
    enabled: true,
    hostname: '127.0.0.1',
    port: 0,
    authStrategy: 'NONE',
    secret: 'public-fixture-secret',
    authorizedClients: [],
    useHttps: false,
    certPath: '',
    keyPath: '',
  };
  const ctx = {
    getConfig: async () => config,
    setConfig: async () => {},
    window: fixtureWindow,
    ipc: {
      on: (event: string, handler: (...args: unknown[]) => void) =>
        ipcMain.on(event, (_: unknown, ...args: unknown[]) => handler(...args)),
      send: (...args: unknown[]) => fixtureWindow.webContents.send(...args),
    },
  };
  const waitListening = async () => {
    const server = backend.server;
    if (server && !server.listening)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(Error('owned main listen timed out'));
        }, 3000);
        const cleanup = () => {
          clearTimeout(timer);
          server.removeListener('listening', ready);
          server.removeListener('error', failed);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        server.once('listening', ready);
        server.once('error', failed);
      });
  };
  const stop = async () => {
    const server = backend.server;
    const closed = server?.listening
      ? new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error('owned main close timed out')),
            3000,
          );
          server.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        })
      : undefined;
    backend.stop();
    server?.closeAllConnections();
    if (closed) await closed;
  };
  return {
    source,
    backend,
    ctx,
    config,
    writes: () => writes,
    emit: async (event: string, ...args: unknown[]) => {
      for (const listener of ipcMain.listeners(event))
        await listener(
          {
            sender: fixtureWindow.webContents,
            senderFrame: fixtureWindow.webContents.mainFrame,
          },
          ...args,
        );
    },
    start: async () => {
      await backend.start(ctx);
      await waitListening();
    },
    waitListening,
    stop,
    query: async (endpoint = 'song') =>
      fetch(
        `http://127.0.0.1:${backend.server.address().port}/api/v1/${endpoint}`,
      ),
    close: async () => {
      await stop();
      delete requireRoot.cache[output];
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('main supplies a fail-closed production seam before listen and owns only successful current listener epochs', async () => {
  const f = await fixture();
  try {
    f.backend.init(f.ctx);
    f.backend.configureMusic({
      ...f.config,
      musicApiEnabled: true,
      port: 26538,
    });
    expect(f.source.getMusicService(f.ctx.window)).toBeUndefined();
    expect(f.backend.musicHttpOwner).toBeUndefined();
    f.backend.run({ ...f.config, musicApiEnabled: true });
    await f.waitListening();
    const server = f.backend.server,
      port = server.address().port;
    const cfg = {
      ...f.config,
      musicApiEnabled: true,
      port,
      musicApiRemoteEnabled: true,
      musicApiRemoteResource: `http://music-http.fixture.invalid:${port}/api/v1/music`,
    };
    // No endpoint restart: explicitly bind the fixture's selected ephemeral endpoint.
    f.backend.oldConfig = cfg;
    f.backend.onConfigChange(cfg);
    const a = f.backend.musicHttpOwner;
    expect(a).toBeDefined();
    expect(a.address).toBe('127.0.0.1');
    expect(a.port).toBe(port);
    expect(a.tls).toBe(false);
    expect(a.current()).toBe(true);
    expect(f.source.getMusicService(f.ctx.window)).toBe(f.backend.musicService);
    let socket: any;
    server.once('request', (incoming: any) => {
      socket = incoming.socket;
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/song`);
    await response.text();
    expect(a.ownsSocket(socket)).toBe(true);
    expect(a.ownsSocket({})).toBe(false);
    f.backend.onConfigChange({ ...cfg, musicApiRemoteEnabled: false });
    const b = f.backend.musicHttpOwner;
    expect(b.identity).not.toBe(a.identity);
    expect(a.current()).toBe(false);
    expect(a.signal.aborted).toBe(true);
    expect(b.current()).toBe(true);
    const remoteCfg = { ...cfg };
    f.backend.onConfigChange(remoteCfg);
    const c = f.backend.musicHttpOwner;
    expect(b.current()).toBe(false);
    expect(c.current()).toBe(true);
    // An old callback cannot clear the new owner; actual close does retire it.
    f.backend.retireMusicHttpOwner(a);
    expect(f.backend.musicHttpOwner).toBe(c);
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    expect(c.current()).toBe(false);
    expect(c.signal.aborted).toBe(true);
    expect(f.source.getMusicService(f.ctx.window)).toBeUndefined();
    f.backend.run(cfg);
    await f.waitListening();
    const replacement = f.backend.musicHttpOwner;
    expect(replacement.port).toBe(port);
    expect(replacement.identity).not.toBe(c.identity);
    expect(replacement.ownsSocket(socket)).toBe(false);
    expect(c.current()).toBe(false);
    server.emit(
      'error',
      Error('Old physical listener after same-endpoint restart'),
    );
    expect(replacement.current()).toBe(true);
    expect(f.backend.musicHttpOwner).toBe(replacement);
  } finally {
    await f.close();
  }
});

test('actual main HTTPS publishes TLS facts and final secure socket membership', async () => {
  const f = await fixture();
  try {
    const certPath = path.join(
        root,
        'tests/fixtures/api-music-http-tls/cert.pem',
      ),
      keyPath = path.join(root, 'tests/fixtures/api-music-http-tls/key.pem');
    Object.assign(f.config, { useHttps: true, certPath, keyPath });
    await f.start();
    const server = f.backend.server,
      port = server.address().port,
      cfg = { ...f.config, port, musicApiEnabled: true };
    f.backend.oldConfig = cfg;
    f.backend.onConfigChange(cfg);
    const owner = f.backend.musicHttpOwner;
    expect(owner.tls).toBe(true);
    expect(owner.port).toBe(port);
    let socket: any;
    server.once('request', (incoming: any) => (socket = incoming.socket));
    const { request } = await import('node:https');
    const { readFile } = await import('node:fs/promises');
    const ca = await readFile(certPath);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/song',
          ca,
          servername: 'music-http.fixture.invalid',
          rejectUnauthorized: true,
          agent: false,
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.setTimeout(3000, () => req.destroy(Error('owned TLS timeout')));
      req.on('error', reject);
      req.end();
    });
    expect(socket.encrypted).toBe(true);
    expect(owner.ownsSocket(socket)).toBe(true);
    expect(owner.current()).toBe(true);
    expect(f.source.getMusicService(f.ctx.window)).toBe(f.backend.musicService);
  } finally {
    await f.close();
  }
});

test('listener error cannot be republished by config-only change without a new successful listen', async () => {
  const f = await fixture();
  try {
    await f.start();
    const server = f.backend.server,
      port = server.address().port;
    const cfg = { ...f.config, port, musicApiEnabled: true };
    f.backend.oldConfig = cfg;
    f.backend.onConfigChange(cfg);
    const a = f.backend.musicHttpOwner;
    expect(a.current()).toBe(true);
    server.emit('error', Error('Owned listener error'));
    expect(a.current()).toBe(false);
    expect(f.source.getMusicService(f.ctx.window)).toBeUndefined();
    f.backend.onConfigChange({
      ...cfg,
      musicApiRemoteEnabled: true,
      musicApiRemoteResource: `http://music-http.fixture.invalid:${port}/api/v1/music`,
    });
    expect(f.backend.musicHttpOwner).toBeUndefined();
    expect(f.source.getMusicService(f.ctx.window)).toBeUndefined();
    // Legacy serving stays available; expanded failure does not close another API lane.
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/song`)).status).toBe(
      204,
    );
  } finally {
    await f.close();
  }
});

test('actual owned EADDRINUSE failure never publishes and old physical server callbacks cannot clear replacement', async () => {
  const occupied = createServer();
  await new Promise<void>((r) => occupied.listen(0, '127.0.0.1', r));
  const f = await fixture();
  try {
    f.backend.init(f.ctx);
    f.backend.run({
      ...f.config,
      musicApiEnabled: true,
      port: (occupied.address() as any).port,
    });
    const failed = f.backend.server;
    const error = await new Promise<any>((r) => failed.once('error', r));
    expect(error.code).toBe('EADDRINUSE');
    expect(f.backend.musicHttpOwner).toBeUndefined();
    expect(f.source.getMusicService(f.ctx.window)).toBeUndefined();
    f.backend.end();
    f.backend.run({ ...f.config, musicApiEnabled: true });
    await f.waitListening();
    const b = f.backend.musicHttpOwner;
    expect(b.current()).toBe(true);
    failed.emit('error', Error('Old failed listener'));
    expect(b.current()).toBe(true);
    expect(f.backend.musicHttpOwner).toBe(b);
  } finally {
    await f.close();
    await new Promise<void>((r) => occupied.close(() => r()));
  }
});
