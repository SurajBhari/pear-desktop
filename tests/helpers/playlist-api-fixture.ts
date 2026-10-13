import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build, transformWithOxc } from 'vite';

export async function playlistApiFixture() {
  const root = path.resolve(import.meta.dirname, '../..');
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-playlist-api-'));
  const entry = path.join(directory, 'entry.ts');
  const ipcMain = new EventEmitter(),
    contents = new EventEmitter() as any,
    window = new EventEmitter() as any;
  const sent: any[] = [];
  const timers = new Map<number, () => void>();
  let serial = 0;
  contents.mainFrame = {};
  contents.isDestroyed = () => false;
  contents.executeJavaScript = async () => undefined;
  contents.send = (...args: any[]) => sent.push(args);
  window.webContents = contents;
  window.dead = false;
  window.isDestroyed = () => window.dead;
  const boundary = {
    ipcMain,
    setTimeout: (fn: () => void) => {
      timers.set(++serial, fn);
      return serial;
    },
    clearTimeout: (id: number) => timers.delete(id),
    serve: () => ({ close() {} }),
  };
  (globalThis as any).__playlistApiBoundary = boundary;
  await writeFile(
    entry,
    `export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/main.ts'))};export {getSongControls} from ${JSON.stringify(path.join(root, 'src/providers/song-controls.ts'))};export {AuthStrategy} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/config.ts'))};`,
  );
  const provider = await readFile(
    path.join(root, 'src/providers/song-info.ts'),
    'utf8',
  );
  const mediaEnum = (
    await transformWithOxc(
      provider.match(/export enum MediaType \{[\s\S]*?\n\}/)![0],
      'media.ts',
    )
  ).code;
  const eventEnum = (
    await transformWithOxc(
      provider.match(/export enum SongInfoEvent \{[\s\S]*?\n\}/)![0],
      'event.ts',
    )
  ).code;
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'playlist-node-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (
            [
              'electron',
              '@/utils',
              '@/i18n',
              '@/providers/song-info',
              '@hono/node-server',
              'ws',
            ].includes(id)
          )
            return '\0' + id;
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            return [target, target + '.ts', path.join(target, 'index.ts')].find(
              (p) => existsSync(p) && statSync(p).isFile(),
            );
          }
        },
        load(id) {
          if (id === '\0electron')
            return 'export const ipcMain=globalThis.__playlistApiBoundary.ipcMain;export const app={on(){},once(){},removeListener(){}};export const dialog={showMessageBox:async()=>({response:1})};';
          if (id === '\0@/utils')
            return 'export const createBackend=value=>value;export const LoggerPrefix="fixture";';
          if (id === '\0@/i18n')
            return 'export const APPLICATION_NAME="Owned fixture";export const t=x=>x;';
          if (id === '\0@/providers/song-info')
            return (
              mediaEnum +
              '\n' +
              eventEnum +
              '\nexport const registerCallback=()=>()=>{};export const getSongInfoPlaybackBinding=()=>null;export const getSongInfoProvenance=()=>null;export const isSongInfoCurrent=()=>false;'
            );
          if (id === '\0@hono/node-server')
            return 'export const serve=options=>globalThis.__playlistApiBoundary.serve(options);export const upgradeWebSocket=()=>async()=>{};';
          if (id === '\0ws')
            return 'export class WebSocketServer{};export class WebSocket{static OPEN=1};export default WebSocket;';
        },
        transform(code, id) {
          if (id === path.join(root, 'src/providers/queue-playlist-request.ts'))
            return {
              code:
                'const setTimeout=(fn,ms)=>globalThis.__playlistApiBoundary.setTimeout(fn,ms);const clearTimeout=id=>globalThis.__playlistApiBoundary.clearTimeout(id);\n' +
                code,
            };
        },
      },
    ],
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      ssr: true,
      rolldownOptions: { output: { entryFileNames: 'fixture.mjs' } },
      lib: { entry, formats: ['es'], fileName: () => 'fixture.mjs' },
    },
  });
  const source = await import(path.join(directory, 'fixture.mjs'));
  const config = {
    enabled: true,
    hostname: '127.0.0.1',
    port: 0,
    authStrategy: source.AuthStrategy.NONE,
    secret: 'owned-fixture-key',
    authorizedClients: [],
    useHttps: false,
    certPath: '',
    keyPath: '',
  };
  const ctx = {
    window,
    getConfig: async () => config,
    setConfig: async () => {},
    ipc: { on() {}, send() {} },
  };
  await source.backend.start(ctx);
  const request = (body: any, signal?: AbortSignal) =>
    source.backend.app.request('http://owned.fixture/api/v1/queue/playlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  const query = () =>
    sent.filter((x) => x[0] === 'peard:playlist-queue-owner-query').at(-1)?.[1];
  const owner = '1'.repeat(32);
  const ready = (id: string) =>
    ipcMain.emit(
      'peard:playlist-queue-reply',
      { sender: contents, senderFrame: contents.mainFrame },
      { requestId: id, ownerId: owner, type: 'owner' },
    );
  const ack = (id: string, result: any) =>
    ipcMain.emit(
      'peard:playlist-queue-reply',
      { sender: contents, senderFrame: contents.mainFrame },
      { requestId: id, ownerId: owner, type: 'result', result },
    );
  return {
    source,
    config,
    ctx,
    window,
    contents,
    sent,
    timers,
    request,
    query,
    ready,
    ack,
    owner,
    flush: async () => {
      for (let i = 0; i < 16; i++) await Promise.resolve();
    },
    tick: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    close: async () => {
      source.backend.stop();
      window.dead = true;
      window.emit('closed');
      delete (globalThis as any).__playlistApiBoundary;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
