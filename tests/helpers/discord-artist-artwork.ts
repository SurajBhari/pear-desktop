import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
const root = path.resolve(import.meta.dirname, '../..');
export async function discordArtworkFixture({ actualProvider = false } = {}) {
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-discord-artwork-'));
  const entry = path.join(owned, 'entry.ts');
  await writeFile(
    entry,
    `export {DiscordService} from ${JSON.stringify(root + '/src/plugins/discord/discord-service.ts')};export {default as plugin} from ${JSON.stringify(root + '/src/plugins/discord/index.ts')};export {onMenu} from ${JSON.stringify(root + '/src/plugins/discord/menu.ts')};export {state} from 'owned-discord';`,
  );
  if (actualProvider)
    await writeFile(
      entry,
      `export {DiscordService} from ${JSON.stringify(root + '/src/plugins/discord/discord-service.ts')};export {default as plugin} from ${JSON.stringify(root + '/src/plugins/discord/index.ts')};export {onMenu} from ${JSON.stringify(root + '/src/plugins/discord/menu.ts')};export * from ${JSON.stringify(root + '/src/providers/song-info.ts')};export {state} from 'owned-discord';`,
    );
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'owned-discord-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (actualProvider && id === '@/providers/song-info')
            return root + '/src/providers/song-info.ts';
          if (
            [
              'owned-discord',
              '@xhayper/discord-rpc',
              'electron',
              'electron-is',
              'custom-electron-prompt',
              '@/providers/song-info',
              '@/utils',
              '@/i18n',
              '@/config/plugins',
              '@/providers/decorators',
              '@/providers/prompt-options',
              '@/config',
            ].includes(id)
          )
            return '\0owned:' + id;
          if (id.startsWith('@/')) {
            const p = path.join(root, 'src', id.slice(2));
            return [p, p + '.ts', path.join(p, 'index.ts')].find(existsSync);
          }
        },
        load(id) {
          if (id === '\0owned:owned-discord')
            return `import {EventEmitter} from 'node:events';export const state={clients:[],activities:[],clears:0,current:null,provenance:new WeakMap(),callbacks:[],now:100000,ipc:new EventEmitter(),packets:[]};state.window=new EventEmitter();state.window.destroyed=false;state.window.isDestroyed=()=>state.window.destroyed;state.window.webContents=new EventEmitter();state.window.webContents.destroyed=false;state.window.webContents.isDestroyed=()=>state.window.webContents.destroyed;state.window.webContents.mainFrame={};state.window.webContents.send=(...a)=>state.packets.push(a);`;
          if (id === '\0owned:@xhayper/discord-rpc')
            return `import {EventEmitter} from 'node:events';import {state} from 'owned-discord';export class Client extends EventEmitter{constructor(){super();this.isConnected=true;this.user={setActivity:p=>{state.activities.push(p);return Promise.resolve()},clearActivity:()=>{state.clears++;return Promise.resolve()}};state.clients.push(this)}login(){return Promise.resolve()}destroy(){this.isConnected=false}}`;
          if (id === '\0owned:@/providers/song-info')
            return `import {state} from 'owned-discord';export const getSongInfoProvenance=s=>state.provenance.get(s)??null;export const getCurrentSongInfoProvenance=w=>w===state.window&&!w.destroyed&&!w.webContents.destroyed?state.current:null;export const SongInfoEvent={TimeChanged:'time',VideoSrcChanged:'video',PlayOrPaused:'paused'};export const registerCallback=fn=>{state.callbacks.push(fn);return ()=>{state.callbacks=state.callbacks.filter(v=>v!==fn)}};`;
          if (id === '\0owned:electron')
            return `import {EventEmitter} from 'node:events';import {state} from 'owned-discord';export const app=new EventEmitter(),ipcMain=state.ipc,net={fetch:async()=>{throw Error('Unexpected owned metadata-cover request')}},nativeImage={createFromBuffer:()=>({isEmpty:()=>false})};`;
          if (id === '\0owned:@/config')
            return 'export const get=()=>false,set=()=>{};';
          if (id === '\0owned:electron-is')
            return 'export default {dev:()=>false};';
          if (id === '\0owned:@/utils')
            return 'export const createPlugin=v=>v,createBackend=v=>v,LoggerPrefix="Owned Discord";';
          if (id === '\0owned:@/i18n')
            return 'export const t=v=>v,APPLICATION_NAME="Pear";';
          if (id === '\0owned:@/config/plugins')
            return 'export const setMenuOptions=()=>{};';
          if (id === '\0owned:@/providers/decorators')
            return 'export const singleton=fn=>{let called=false;return(...a)=>{if(!called){called=true;return fn(...a)}}};';
          if (id === '\0owned:@/providers/prompt-options')
            return 'export default()=>({});';
          if (id === '\0owned:custom-electron-prompt')
            return 'export default async()=>null;';
        },
      },
    ],
    build: {
      ssr: entry,
      outDir: owned,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'bundle.mjs' } },
    },
  });
  const module = await import(
    pathToFileURL(path.join(owned, 'bundle.mjs')).href
  );
  const state = module.state;
  const originalFetch = globalThis.fetch,
    originalNow = Date.now;
  const requests: any[] = [];
  let html =
      '<head><meta property="og:image" content="https://yt3.googleusercontent.com/artist-avatar"></head>',
    hold = false,
    failure = false,
    status = 200;
  let responseFactory: (() => Response) | undefined;
  const response = () =>
    responseFactory?.() ??
    new Response(html, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  globalThis.fetch = async (url: any, options: any) => {
    const request: any = { url: String(url), options };
    requests.push(request);
    if (failure) throw Error('Owned network failure');
    if (hold)
      return await new Promise<Response>(
        (resolve) => (request.resolve = () => resolve(response())),
      );
    return response();
  };
  Date.now = () => state.now;
  const config = {
    ...module.plugin.config,
    enabled: true,
    autoReconnect: false,
  };
  const service = new module.DiscordService(state.window, config);
  service.rpc.emit('ready');
  const song = (overrides: any = {}) => ({
    title: 'Owned track',
    artist: 'Owned artist',
    artistUrl: 'https://music.youtube.com/channel/UC' + 'a'.repeat(22),
    videoId: 'AAAAAAAAAAA',
    imageSrc: 'https://i.ytimg.com/cover',
    songDuration: 100,
    elapsedSeconds: 10,
    isPaused: false,
    url: 'https://music.youtube.com/watch?v=AAAAAAAAAAA',
    album: 'Owned album',
    ...overrides,
  });
  const admit = (info: any, token: any = {}) => {
    state.current = token;
    state.provenance.set(info, token);
    service.updateActivity(info);
    return token;
  };
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
  };
  return {
    module,
    state,
    service,
    config,
    requests,
    song,
    admit,
    flush,
    set hold(v: boolean) {
      hold = v;
    },
    set html(v: string) {
      html = v;
    },
    set failure(v: boolean) {
      failure = v;
    },
    set status(v: number) {
      status = v;
    },
    set responseFactory(v: () => Response) {
      responseFactory = v;
    },
    close: async () => {
      service.cleanup();
      state.window.destroyed = true;
      state.window.emit('closed');
      for (const request of requests) request.resolve?.();
      await flush();
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      await rm(owned, { recursive: true, force: true });
    },
  };
}
