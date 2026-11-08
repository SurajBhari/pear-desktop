import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, normalizePath } from 'vite';
import { musicRemoteHttpFixture } from './api-music-remote-http';

const root = normalizePath(path.resolve(import.meta.dirname, '../..'));
let serial = 0;
/** Keep real REST/service/broker; replace its canned responder before any request. */
export async function verticalMainFixture() {
  const transport = await musicRemoteHttpFixture({ remoteEnabled: true });
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-vertical-main-'));
  const globals = globalThis as any,
    key = '__verticalMain' + ++serial;
  const state = {
    info: [] as string[],
    runs: [] as string[][],
    feedback: [] as any[],
    jobs: 0,
  };
  const modules: string[] = [];
  transport.contents.send = (channel: string, ...args: any[]) =>
    state.feedback.push({ channel, args });
  Object.assign(transport.contents, {
    session: { cookies: { get: async () => [] } },
    getURL: () => 'https://music.youtube.com/watch?v=trackA00001',
    executeJavaScript: async () => false,
  });
  Object.assign(transport.window, {
    isFocused: () => false,
    setProgressBar: () => {},
    getSize: () => [800, 600],
  });
  globals[key] = { ipcMain: transport.ipcMain, state, directory };
  const entry = path.join(directory, 'entry.ts');
  const actual = (file: string) =>
    JSON.stringify(normalizePath(path.join(root, file)));
  await writeFile(
    entry,
    [
      `export * as downloader from ${actual('src/plugins/downloader/main/index.ts')};`,
      `export {setupSongInfo,registerCallback,SongInfoEvent,verticalCallbacks} from ${actual('src/providers/song-info.ts')};`,
      `export {verticalCallbacks as aliasCallbacks} from '@/providers/song-info';`,
    ].join('\n'),
  );
  const native = `
import {EventEmitter} from 'node:events';
const owned=globalThis[${JSON.stringify(key)}];export const state=owned.state;
export const ipcMain=owned.ipcMain;
export const app={getPath:()=>owned.directory,setBadgeCount:()=>{}};
export const dialog={showMessageBox:async()=>({response:0})};
export class Notification extends EventEmitter{static isSupported(){return false;}show(){}close(){}}
export const nativeImage={createFromBuffer:()=>({isEmpty:()=>true,getSize:()=>({width:0,height:0})})};
export const net={fetch:async()=>new Response(new Uint8Array([1,2,3]))};
`;
  const sdk = `
import{state}from 'electron';
export const Platform={shim:{}};export class UniversalCache{};export const YTNodes={};
export const Utils={InnertubeError:class extends Error{}};
export const FormatUtils={download:async()=>new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close();}})};
const info=id=>{const format={itag:140,mime_type:'audio/mp4; codecs="mp4a.40.2"',has_audio:true,has_video:false,is_original:true,bitrate:128000,content_length:3};return{basic_info:{id,title:'Short A',author:'Allowed',duration:2,thumbnail:[]},playability_status:{status:'OK'},streaming_data:{formats:[],adaptive_formats:[format]},actions:{session:{}},cpn:'owned',page:[{video_details:{is_live:false}}]};};
export const Innertube={create:async()=>({session:{context:{client:{}}},music:{getInfo:async(id)=>{state.info.push(id);return info(id);}}})};
`;
  const ffmpeg = `
import{state}from 'electron';
export const createFFmpeg=()=>{let loaded=false;const files=new Map();return{isLoaded:()=>loaded,load:async()=>{loaded=true;},setProgress:()=>{},run:async(...args)=>{state.jobs++;try{state.runs.push(args);files.set(args.at(-1),new Uint8Array([4,5,6]));}finally{state.jobs--;}},FS:(method,...args)=>{if(method==='writeFile')files.set(args[0],args[1]);if(method==='readFile')return files.get(args[0]);if(method==='readdir')return [...files.keys()];if(method==='unlink')files.delete(args[0]);}};};
`;
  let source: any;
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      resolve: {
        alias: [
          ...['@/config', '@/i18n', '@/plugins/utils/main'].map((find) => ({
            find,
            replacement: '\0vertical-main:' + find,
          })),
          { find: '@', replacement: normalizePath(path.join(root, 'src')) },
        ],
      },
      plugins: [
        {
          name: 'vertical-main-owned-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (id === 'electron-store')
              throw Error('Profile/native store prohibited');
            if (
              [
                'electron',
                'electron-is',
                'youtubei.js',
                '@ffmpeg.wasm/main',
                'bgutils-js',
                '@/config',
                '@/i18n',
                '@/plugins/utils/main',
              ].includes(id)
            )
              return '\0vertical-main:' + id;
            return undefined;
          },
          load(id) {
            if (id === '\0vertical-main:electron') return native;
            if (id === '\0vertical-main:youtubei.js') return sdk;
            if (id === '\0vertical-main:@ffmpeg.wasm/main') return ffmpeg;
            if (id === '\0vertical-main:electron-is')
              return 'export default {macOS:()=>true,linux:()=>false,dev:()=>false};';
            if (id === '\0vertical-main:bgutils-js')
              return 'export const BG={};';
            if (id === '\0vertical-main:@/config')
              return 'export const get=()=>false,set=()=>{};';
            if (id === '\0vertical-main:@/i18n') return 'export const t=x=>x;';
            if (id === '\0vertical-main:@/plugins/utils/main')
              return `import{net}from'electron';export const getNetFetchAsFetch=()=>net.fetch;`;
            return undefined;
          },
          transform(code, id) {
            if (
              normalizePath(id) ===
              normalizePath(path.join(root, 'src/providers/song-info.ts'))
            )
              return {
                code: code + '\nexport {callbacks as verticalCallbacks};',
                map: null,
              };
            return undefined;
          },
          generateBundle() {
            modules.push(
              ...Array.from(this.getModuleIds())
                .map((id) => normalizePath(id))
                .filter((id) => id.startsWith(root + '/src/')),
            );
            if (
              modules.filter((id) => id.endsWith('/providers/song-info.ts'))
                .length !== 1
            )
              throw Error('Metadata callback module duplicated/missing');
            if (modules.some((id) => /electron-store|\/src\/config\//.test(id)))
              throw Error('Native/profile import closure violation');
          },
        },
      ],
      build: {
        ssr: entry,
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          output: {
            entryFileNames: 'main.mjs',
            chunkFileNames: 'assets/[name]-[hash].mjs',
          },
        },
      },
    });
    source = await import(pathToFileURL(path.join(directory, 'main.mjs')).href);
    if (source.verticalCallbacks !== source.aliasCallbacks)
      throw Error('Callback module identity differs');
  } catch (error) {
    await transport.close();
    delete globals[key];
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const handlers = new Map<string, any>();
  const config = {
    enabled: true,
    downloadFolder: directory,
    selectedPreset: 'Source',
    skipExisting: false,
    downloadOnFinish: {
      enabled: true,
      mode: 'seconds',
      seconds: 1,
      percent: 90,
    },
  };
  const context = {
    window: transport.window,
    getConfig: () => ({ ...config }),
    setConfig: (patch: any) => Object.assign(config, patch),
    ipc: {
      handle: (key: string, fn: any) => handlers.set(key, fn),
      removeHandler: (key: string) => handlers.delete(key),
      send: (channel: string, ...args: any[]) =>
        transport.contents.send(channel, ...args),
      on: () => {},
    },
  };
  const callbacks: any[] = [];
  const releaseWitness = source.registerCallback((info: any, event: string) =>
    callbacks.push({ id: info.videoId, event, elapsed: info.elapsedSeconds }),
  );
  const stopProvider = source.setupSongInfo(transport.window);
  await source.downloader.onMainLoad(context);
  return {
    ...transport,
    source,
    state,
    callbacks,
    modules,
    context,
    handlers,
    directory,
    async rebind() {
      source.downloader.onMainStop(context);
      await source.downloader.onMainLoad(context);
    },
    async close() {
      source.downloader.onMainStop(context);
      stopProvider();
      releaseWitness();
      const callbackCount = source.verticalCallbacks.size;
      const handlerCount = handlers.size;
      const transportClosed = await transport.close();
      delete globals[key];
      await rm(directory, { recursive: true, force: true });
      return {
        ...transportClosed,
        callbackCount,
        handlerCount,
        jobs: state.jobs,
        ipcListeners: transport.ipcMain
          .eventNames()
          .reduce((n, name) => n + transport.ipcMain.listenerCount(name), 0),
      };
    },
  };
}
