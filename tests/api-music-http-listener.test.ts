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
async function fixture({ controlledRestListener = false } = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-api-music-listener-'),
  );
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `
export {setupSongInfo,registerCallback,SongInfoEvent} from ${JSON.stringify(path.join(root, 'src/providers/song-info.ts'))};
export {getMcpGrantTarget} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/mcp-owner.ts'))};
export {getMusicService} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/music-service.ts'))};
export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/main.ts'))};
export {onMenu} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/menu.ts'))};
export {menuState,setMenuContext,refreshMenu} from '@/menu';
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
export const clipboard={writeText:()=>{throw new Error('Fixture prohibits credential copies');}};
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
          if (controlledRestListener && id === '@hono/node-server')
            return '\0fixture-rest-listener';
          if (id === 'electron') return '\0fixture-electron';
          if (id === '@/config') return '\0fixture-config';
          if (id === '@/i18n') return '\0fixture-i18n';
          if (id === '@/menu') return '\0fixture-menu';
          if (id === '@/providers/prompt-options')
            return '\0fixture-prompt-options';
          if (id === 'custom-electron-prompt') return '\0fixture-prompt';
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
          if (id === '\0fixture-rest-listener')
            return `
import {EventEmitter} from 'node:events';
export const upgradeWebSocket=()=>()=>{throw Error('Fixture prohibits HTTP requests');};
export const serve=options=>Object.assign(new EventEmitter(),{
 listening:false,address:()=>({address:options.hostname,port:options.port}),
 close(){this.listening=false;this.emit('close');},closeAllConnections(){}
});
`;
          if (id === '\0fixture-electron') return electron;
          if (id === '\0fixture-config')
            return 'export const get=()=>false; export const set=()=>{};';
          if (id === '\0fixture-i18n')
            return "export const APPLICATION_NAME='Public Fixture'; export const t=(key)=>key;";
          if (id === '\0fixture-prompt-options')
            return 'export default ()=>({});';
          if (id === '\0fixture-prompt')
            return "export default async()=>{throw new Error('Fixture prohibits native prompts');};";
          if (id === '\0fixture-menu')
            return `
import {onMenu} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/menu.ts'))};
export const menuState={requests:[],published:[],hold:false,releases:[],reject:false};
let context;
export const setMenuContext=value=>context=value;
export async function refreshMenu(window,isCurrent=()=>true){
  menuState.requests.push({window,isCurrent});
  if(menuState.reject)throw Error('Owned native menu failure');
  const menu=await onMenu(context);
  if(menuState.hold)await new Promise(resolve=>menuState.releases.push(resolve));
  if(isCurrent())menuState.published.push(menu);
}
`;
          return undefined;
        },
      },
    ],
  });
  const output = path.join(directory, 'actual-source.cjs');
  await bundle.write({ file: output, format: 'cjs', codeSplitting: false });
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
  const configWrites: unknown[] = [];
  const ctx = {
    getConfig: async () => config,
    setConfig: async (value: unknown) => {
      configWrites.push(value);
    },
    window: fixtureWindow,
    ipc: {
      on: (event: string, handler: (...args: unknown[]) => void) =>
        ipcMain.on(event, (_: unknown, ...args: unknown[]) => handler(...args)),
      send: (...args: unknown[]) => fixtureWindow.webContents.send(...args),
    },
  };
  source.setMenuContext({ ...ctx, refresh: () => {} });
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
    configWrites,
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

test('actual main keeps MCP off by default and shares one service while native target retires before reconfiguration', async () => {
  const f = await fixture();
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string')
    throw Error('Missing owned port');
  const mcpPort = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  try {
    await f.backend.start(f.ctx);
    await f.waitListening();
    expect(f.backend.mcpListener).toBeUndefined();
    expect(f.source.getMcpGrantTarget(f.ctx.window)).toBeUndefined();
    const config = {
      ...f.config,
      port: f.backend.server.address().port,
      musicApiEnabled: false,
      mcpEnabled: true,
      mcpPort,
    };
    f.backend.oldConfig = config;
    f.backend.onConfigChange(config);
    await expect
      .poll(() => Boolean(f.backend.mcpListener?.owner.current()))
      .toBe(true);
    const service = f.backend.musicService;
    expect(service).toBeDefined();
    expect(f.source.getMusicService(f.ctx.window)).toBeUndefined();
    const target = f.source.getMcpGrantTarget(f.ctx.window);
    expect(target.resource).toBe(`http://127.0.0.1:${mcpPort}/mcp`);
    const native = target.captureNativeOwner();
    expect(native.current()).toBe(true);
    const grant = await target.grants.issue(
      'Owned main fixture',
      'mcp',
      target.resource,
      [],
      () => native.current(),
    );
    const initialized = await fetch(target.resource, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grant.token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'main-init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'owned-main', version: '1' },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    await initialized.arrayBuffer();
    f.backend.onConfigChange({ ...config, musicApiEnabled: true });
    expect(f.backend.musicService).toBe(service);
    expect(native.current()).toBe(false);
    expect(f.source.getMcpGrantTarget(f.ctx.window)).toBeUndefined();
    await expect
      .poll(() =>
        Boolean(
          f.source
            .getMcpGrantTarget(f.ctx.window)
            ?.captureNativeOwner()
            .current(),
        ),
      )
      .toBe(true);
    f.backend.onConfigChange({
      ...config,
      mcpEnabled: false,
      musicApiEnabled: true,
    });
    expect(f.backend.musicService).toBe(service);
    expect(f.backend.mcpListener).toBeUndefined();
    expect(f.source.getMcpGrantTarget(f.ctx.window)).toBeUndefined();
  } finally {
    await f.close();
  }
});

async function mcpMenuFixture() {
  const f = await fixture();
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string')
    throw Error('Missing owned port');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await f.start();
  const config = {
    ...f.config,
    port: f.backend.server.address().port,
    musicApiEnabled: false,
    mcpEnabled: true,
    mcpPort: address.port,
  };
  Object.assign(f.config, config);
  f.backend.oldConfig = config;
  const menu = () => f.source.onMenu({ ...f.ctx, refresh: () => {} });
  const enabled = (template: any[]) =>
    template
      .find((item) => item.label === 'MCP music access')
      .submenu.filter(
        (item: any) =>
          item.label === 'Create client grant…' ||
          item.label === 'Revoke client grants…',
      )
      .map((item: any) => item.enabled);
  return {
    ...f,
    config,
    menu,
    enabled,
    enable: () => f.backend.onConfigChange(config),
  };
}

async function restMenuFixture() {
  const f = await fixture({ controlledRestListener: true });
  Object.assign(f.config, {
    musicApiEnabled: true,
    mcpEnabled: false,
    musicApiRemoteEnabled: false,
    port: 26538,
  });
  const enabled = (template: any[]) =>
    template
      .find((item) => item.label === 'Expanded music API')
      .submenu.filter(
        (item: any) =>
          item.label === 'Create local REST grant…' ||
          item.label === 'Revoke client grants…',
      )
      .map((item: any) => item.enabled);
  return {
    ...f,
    enabled,
    begin: () => f.backend.start(f.ctx),
    ready: (server = f.backend.server) => {
      server.listening = true;
      server.emit('listening');
    },
  };
}

test('actual REST readiness republishes disabled native grants without config writes', async () => {
  const f = await restMenuFixture();
  try {
    await f.begin();
    await f.source.refreshMenu(f.ctx.window);
    expect(f.enabled(f.source.menuState.published[0])).toEqual([false, false]);
    f.ready();
    expect(f.backend.musicHttpOwner.current()).toBe(true);
    expect(f.source.getMusicService(f.ctx.window)).toBe(f.backend.musicService);
    await expect.poll(() => f.source.menuState.published.length).toBe(2);
    expect(f.enabled(f.source.menuState.published[1])).toEqual([true, true]);
    expect(f.source.menuState.requests).toHaveLength(2);
    expect(f.configWrites).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const retirement of [
  'stop',
  'reconfigure',
  'destroy',
  'close',
  'error',
] as const) {
  test(`actual REST readiness cannot refresh after ${retirement} before listening`, async () => {
    const f = await restMenuFixture();
    try {
      await f.begin();
      const listener = f.backend.server;
      if (retirement === 'stop') f.backend.stop();
      else if (retirement === 'reconfigure')
        f.backend.onConfigChange({ ...f.config, port: 26540 });
      else if (retirement === 'destroy') f.ctx.window.destroy();
      else listener.emit(retirement);
      f.ready(listener);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.source.menuState.requests).toHaveLength(0);
      expect(f.source.menuState.published).toHaveLength(0);
      expect(f.configWrites).toEqual([]);
      if (retirement === 'reconfigure') {
        expect(f.backend.server).not.toBe(listener);
        f.ready();
        await expect.poll(() => f.source.menuState.published.length).toBe(1);
        expect(f.enabled(f.source.menuState.published[0])).toEqual([
          true,
          true,
        ]);
        expect(f.configWrites).toEqual([]);
      }
    } finally {
      await f.close();
    }
  });

  test(`held actual REST readiness menu cannot publish after ${retirement}`, async () => {
    const f = await restMenuFixture();
    try {
      f.source.menuState.hold = true;
      await f.begin();
      f.ready();
      await expect.poll(() => f.source.menuState.releases.length).toBe(1);
      const request = f.source.menuState.requests[0];
      expect(request.window).toBe(f.ctx.window);
      expect(request.isCurrent()).toBe(true);
      if (retirement === 'stop') f.backend.stop();
      else if (retirement === 'reconfigure') {
        // Same physical endpoint, changed authorization: owner lifetime still retires.
        f.backend.oldConfig = { ...f.config };
        f.backend.onConfigChange({
          ...f.config,
          authorizedClients: ['changed'],
        });
      } else if (retirement === 'destroy') f.ctx.window.destroy();
      else f.backend.server.emit(retirement);
      expect(request.isCurrent()).toBe(false);
      f.source.menuState.releases.shift()();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.source.menuState.published).toHaveLength(0);
      expect(f.configWrites).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test('actual REST readiness leaves disabled expanded API menus unavailable', async () => {
  const f = await restMenuFixture();
  try {
    Object.assign(f.config, { musicApiEnabled: false });
    await f.begin();
    f.ready();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.source.getMusicService(f.ctx.window)).toBeUndefined();
    expect(f.source.menuState.requests).toHaveLength(0);
    expect(f.configWrites).toEqual([]);
  } finally {
    await f.close();
  }
});

test('REST readiness menu refresh failure preserves the current service and owner', async () => {
  const f = await restMenuFixture();
  try {
    f.source.menuState.reject = true;
    await f.begin();
    f.ready();
    await expect.poll(() => f.source.menuState.requests.length).toBe(1);
    expect(f.backend.musicHttpOwner.current()).toBe(true);
    expect(f.source.getMusicService(f.ctx.window)).toBe(f.backend.musicService);
    expect(f.source.menuState.published).toHaveLength(0);
    expect(f.configWrites).toEqual([]);
  } finally {
    await f.close();
  }
});

test('actual main refreshes disabled native MCP grant entries when the listener becomes ready without config writes', async () => {
  const f = await mcpMenuFixture();
  try {
    f.enable();
    expect(f.enabled(await f.menu())).toEqual([false, false]);
    await expect
      .poll(() => Boolean(f.source.getMcpGrantTarget(f.ctx.window)))
      .toBe(true);
    // The real listener is ready; rebuilding only after an unrelated config write
    // would leave the native snapshot permanently disabled.
    expect(f.source.menuState.requests).toHaveLength(1);
    await expect.poll(() => f.source.menuState.published.length).toBe(1);
    expect(f.enabled(f.source.menuState.published[0])).toEqual([true, true]);
    expect(f.configWrites).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const retirement of ['stop', 'reconfigure', 'destroy'] as const) {
  test(`actual MCP readiness cannot publish a native target or refresh after ${retirement} during bind`, async () => {
    const f = await mcpMenuFixture();
    try {
      f.enable();
      // Drain import/creation microtasks while the actual Node bind is pending.
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
      const listener = f.backend.mcpListener;
      expect(listener).toBeDefined();
      expect(listener.owner.current()).toBe(false);
      if (retirement === 'stop') f.backend.stop();
      else if (retirement === 'reconfigure')
        f.backend.onConfigChange({ ...f.config, mcpEnabled: false });
      else f.ctx.window.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.source.getMcpGrantTarget(f.ctx.window)).toBeUndefined();
      expect(f.source.menuState.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  test(`held actual MCP menu snapshot cannot publish after ${retirement}`, async () => {
    const f = await mcpMenuFixture();
    try {
      f.source.menuState.hold = true;
      f.enable();
      await expect.poll(() => f.source.menuState.releases.length).toBe(1);
      const request = f.source.menuState.requests[0];
      expect(request.window).toBe(f.ctx.window);
      expect(request.isCurrent()).toBe(true);
      if (retirement === 'stop') f.backend.stop();
      else if (retirement === 'reconfigure')
        f.backend.onConfigChange({ ...f.config, mcpEnabled: false });
      else f.ctx.window.destroy();
      expect(request.isCurrent()).toBe(false);
      f.source.menuState.releases.shift()();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.source.menuState.published).toHaveLength(0);
      expect(f.configWrites).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test('failed actual MCP bind cannot publish a native grant target or menu refresh', async () => {
  const f = await mcpMenuFixture();
  const occupied = createServer();
  try {
    occupied.listen(f.config.mcpPort, '127.0.0.1');
    await once(occupied, 'listening');
    f.enable();
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    expect(f.backend.mcpListener).toBeDefined();
    await expect.poll(() => f.backend.mcpListener).toBeUndefined();
    expect(f.source.getMcpGrantTarget(f.ctx.window)).toBeUndefined();
    expect(f.source.menuState.requests).toHaveLength(0);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await f.close();
  }
});

test('native menu refresh failure leaves the ready MCP listener and target healthy', async () => {
  const f = await mcpMenuFixture();
  try {
    f.source.menuState.reject = true;
    f.enable();
    await expect.poll(() => f.source.menuState.requests.length).toBe(1);
    const listener = f.backend.mcpListener;
    expect(f.source.getMcpGrantTarget(f.ctx.window)).toBe(listener);
    expect(listener.owner.current()).toBe(true);
    expect(f.source.menuState.published).toHaveLength(0);
  } finally {
    await f.close();
  }
});
