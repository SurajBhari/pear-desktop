import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  downloaderFixturePolicy,
  normalizeDownloaderFixtureId,
} from './downloader-fixture-policy';

import type { DownloaderPluginConfig } from '../../src/plugins/downloader';
import type { Preset } from '../../src/plugins/downloader/types';
import type { BackendContext } from '../../src/types/contexts';
import type { BrowserWindow } from 'electron';
import type { EventEmitter } from 'node:events';

interface InitializationOptions {
  cookie: string;
  fetch: typeof fetch;
}
interface FixtureState {
  creates: InitializationOptions[];
  clients: { options: InitializationOptions; session: { po_token?: string } }[];
  pending: { resolve: () => void; reject: (error: Error) => void }[];
  tokens: { resolve: () => void }[];
  infoCalls: { id: string; cookie: string; index: number }[];
  continuations: number;
  network: { url: string; init?: RequestInit }[];
  runs: string[][];
  dialogs: unknown[];
  feedback: { window: string; name: string; args: unknown[] }[];
  logs: string[];
  initMode: 'resolve' | 'reject' | 'defer';
  infoMode: 'resolve' | 'reject' | 'defer';
  mediaError: string;
  pendingInfo: { reject: (error: Error) => void }[];
  badges: number[];
  progress: { window: string; value: number }[];
  networkMode: 'resolve' | 'defer';
  pages: string[][];
  album: boolean;
  visitor: boolean;
  tokenMode: 'resolve' | 'defer' | 'reject';
  dialogMode: 'resolve' | 'defer';
  pendingDialogs: { reject: (error: Error) => void }[];
  lastFormat?: { type: string };
  mediaBytes?: number;
  sourceLength?: number | null;
  live?: boolean;
  loginRequired?: boolean;
  basicInfoCalls?: { id: string; client: string }[];
}
interface FixtureSource {
  downloader: {
    onMainLoad: (
      context: BackendContext<DownloaderPluginConfig>,
    ) => Promise<void>;
    onMainStop?: (context: BackendContext<DownloaderPluginConfig>) => void;
    downloadSongFromId: (id: string, folder?: string) => Promise<void>;
    downloadPlaylist: (url: string) => Promise<void>;
  };
  DefaultPresetList: Record<string, Preset>;
  getFolder: (folder?: string) => string;
  fixtureCallbacks: Set<unknown>;
  aliasFixtureCallbacks: Set<unknown>;
  loadI18n: () => Promise<unknown>;
  state: FixtureState;
  FixtureWindow: new (name: string) => BrowserWindow;
  ipcMain: EventEmitter;
  app: { setBadgeCount: (value: number) => void };
}
interface BuildApi {
  rolldown: (options: unknown) => Promise<{
    write: (options: unknown) => Promise<unknown>;
    close: () => Promise<void>;
  }>;
}
interface FixtureModuleInfo {
  id: string;
  importers: string[];
  importedIds: string[];
  exports: string[];
}
interface FixtureGraphContext {
  getModuleIds: () => IterableIterator<string>;
  getModuleInfo: (id: string) => FixtureModuleInfo | null;
}

const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));

export async function downloaderFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-downloader-small-'),
  );
  const downloads = path.join(directory, 'Downloads');
  await mkdir(downloads);
  const main = normalizeDownloaderFixtureId(
    path.join(root, 'src/plugins/downloader/main/index.ts'),
  );
  const songInfo = normalizeDownloaderFixtureId(
    path.join(root, 'src/providers/song-info.ts'),
  );
  const policy = downloaderFixturePolicy(main, songInfo);
  const entry = path.join(directory, 'entry.ts');
  const moduleGraph: FixtureModuleInfo[] = [];
  const aliasResolutions: {
    source: string;
    importer: string | undefined;
    resolvedId: string;
  }[] = [];
  await writeFile(
    entry,
    `
export * as downloader from ${JSON.stringify(main)};
export {DefaultPresetList} from ${JSON.stringify(normalizeDownloaderFixtureId(path.join(root, 'src/plugins/downloader/types.ts')))};
export {getFolder} from ${JSON.stringify(normalizeDownloaderFixtureId(path.join(root, 'src/plugins/downloader/main/utils.ts')))};
export {fixtureCallbacks,SongInfoEvent} from ${JSON.stringify(songInfo)};
export {fixtureCallbacks as aliasFixtureCallbacks} from '@/providers/song-info';
export {loadI18n} from ${JSON.stringify(normalizeDownloaderFixtureId(path.join(root, 'src/i18n/index.ts')))};
export {state,FixtureWindow,ipcMain,app} from 'electron';
`,
  );
  const native = `
import {EventEmitter} from 'node:events';
export const state={dialogMode:'resolve',pendingDialogs:[],pendingInfo:[],badges:[],progress:[],networkMode:'resolve',creates:[],clients:[],pending:[],infoCalls:[],continuations:0,network:[],runs:[],dialogs:[],feedback:[],logs:[],initMode:'resolve',infoMode:'reject',mediaError:'Owned fixture media failure',pages:[['one','two']],album:false,visitor:false,tokenMode:'resolve',tokens:[],destroyedCalls:[]};
export class FixtureWindow extends EventEmitter {
 constructor(name){super();this.name=name;this.destroyed=false;this.signed=false;this.focused=false;this.session={cookies:{get:async()=>[{name:'SID',value:'fixture-'+name}]}};this.webContents=new EventEmitter();Object.assign(this.webContents,{session:this.session,isDestroyed:()=>this.destroyed,getURL:()=> 'https://fixture.test/watch?v=one&list=owned-playlist',send:(name,...args)=>{if(this.destroyed)throw Error('Destroyed window');state.feedback.push({window:this.name,name,args});},executeJavaScript:async(code)=>code.includes('LOGGED_IN')?this.signed:code.includes('firstChild')?'owned-icon':true});}
 isDestroyed(){return this.destroyed;}isFocused(){return this.focused;}getSize(){return [800,600];}setProgressBar(value){state.progress.push({window:this.name,value});}focus(){}show(){}
 destroy(){this.destroyed=true;this.emit('closed');this.webContents.emit('destroyed');}
}
export {FixtureWindow as BrowserWindow};
export const ipcMain=new EventEmitter();
export const app={getPath:()=>${JSON.stringify(downloads)},setBadgeCount(value){state.badges.push(value);}};
export const dialog={showMessageBox:async(_window,options)=>{state.dialogs.push(options);if(state.dialogMode==='defer')return new Promise((_resolve,reject)=>state.pendingDialogs.push({reject}));return {response:0};}};
export class Notification extends EventEmitter {static isSupported(){return false;}show(){}close(){}}
export const nativeImage={createFromBuffer:()=>({isEmpty:()=>true,getSize:()=>({width:0,height:0})})};
export const net={fetch:async(input,init)=>{const url=String(input.url??input);state.network.push({url,init});if(state.networkMode==='defer')return new Promise((_resolve,reject)=>{const signal=init?.signal??input.signal;const abort=()=>reject(new DOMException('Owned request aborted','AbortError'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});return new Response(new Uint8Array(url.includes('/media?')?(state.mediaBytes??3):1));}};
`;
  const youtube = `
import {state} from 'electron';
import {FormatUtils as actualFormatUtils} from 'owned-real-sdk';
export const FormatUtils={download:(options,...args)=>{state.lastFormat=options;return actualFormatUtils.download(options,...args);}};
export const Platform={shim:{}};export class UniversalCache{};
class MusicResponsiveListItem {constructor(id){this.id=id;this.title='Track '+id;this.author={name:'Fixture artist'};}}
export const YTNodes={MusicResponsiveListItem};
export const Utils={streamToIterable:async function*(stream){const reader=stream.getReader();try{while(true){const chunk=await reader.read();if(chunk.done)return;yield chunk.value;}}finally{reader.releaseLock();}}};
const playlist=(page)=>({header:state.album?undefined:{title:{text:'Fixture playlist'}},page:{contents_memo:{get:()=>[null,null,{as:()=>({title:{text:'Fixture album'}})}]}},items:(state.pages[page]??[]).map(id=>new MusicResponsiveListItem(id)),has_continuation:page+1<state.pages.length,getContinuation:async()=>{state.continuations++;return playlist(page+1);}});
const makeInfo=(id,options,muxed=false)=>{const format={itag:muxed?18:140,mime_type:muxed?'video/mp4; codecs="avc1.42001E, mp4a.40.2"':'audio/mp4; codecs="mp4a.40.2"',has_audio:true,has_video:muxed,is_original:true,bitrate:muxed?3000000:128000,content_length:state.sourceLength===null?undefined:(state.sourceLength??3),decipher:async()=> 'https://fixture.test/media?x=1'};return {basic_info:{id,title:'Track '+id,author:'Fixture artist',duration:30,thumbnail:[{url:'https://fixture.test/cover.png'}]},playability_status:{status:'OK'},streaming_data:{formats:[],adaptive_formats:[format]},actions:{session:{http:{fetch_function:options.fetch}}},cpn:'fixture',page:[{video_details:{is_live:!!state.live}}]};};
const client=(options,index)=>({options,session:{context:{client:{visitorData:state.visitor?'fixture-visitor':undefined}}},getBasicInfo:async(id,args)=>{state.basicInfoCalls??=[];state.basicInfoCalls.push({id,client:args.client});return makeInfo(id,options,true);},music:{getPlaylist:async()=>playlist(0),getInfo:async(id)=>{state.infoCalls.push({id,cookie:options.cookie,index});if(state.infoMode==='reject')throw Error(state.mediaError);if(state.infoMode==='defer')return new Promise((_resolve,reject)=>state.pendingInfo.push({reject}));const info=makeInfo(id,options);if(state.loginRequired)info.playability_status.status='LOGIN_REQUIRED';return info;}}});
export const Innertube={create:(options)=>{const index=state.creates.length;state.creates.push(options);const value=client(options,index);state.clients.push(value);if(state.initMode==='reject')return Promise.reject(Error('Owned fixture initialization failure'));if(state.initMode==='defer')return new Promise((resolve,reject)=>state.pending.push({resolve:()=>resolve(value),reject}));return Promise.resolve(value);}};
`;
  const ffmpeg = `
import {state} from 'electron';
export const createFFmpeg=()=>{let loaded=false;const files=new Map();return {isLoaded:()=>loaded,load:async()=>{loaded=true;},setProgress(){},run:async(...args)=>{state.runs.push(args);files.set(args.at(-1),new Uint8Array([1,2,3]));},FS:(action,name,value)=>{if(action==='writeFile')files.set(name,value);if(action==='readFile')return files.get(name);if(action==='unlink')files.delete(name);}};};
`;
  const bg = `
import {state} from 'electron';
export const BG={Challenge:{create:async()=>({program:'owned-program',globalName:'fixtureBotguard',interpreterJavascript:{privateDoNotAccessOrElseSafeScriptWrappedValue:'globalThis.fixtureBotguard={};'}})},PoToken:{generate:async()=>{if(state.tokenMode==='reject')throw Error('Owned token failure');if(state.tokenMode==='defer')return new Promise(resolve=>state.tokens.push({resolve:()=>resolve({poToken:'fixture-token'})}));return {poToken:'fixture-token'};}}};
`;
  const loaderUrl = pathToFileURL(requireVite.resolve('rolldown')).href;
  const { rolldown } = (await import(loaderUrl)) as BuildApi;
  const build = await rolldown({
    input: entry,
    platform: 'node',
    // Config/store startup is not part of these operations. Keeping the actual
    // song helpers while discarding their unused config readers avoids profiles.
    treeshake: {
      moduleSideEffects: policy.moduleSideEffects,
    },
    plugins: [
      {
        name: 'owned-downloader-network-ffmpeg-native',
        async resolveId(id: string, importer: string | undefined) {
          if (id === 'owned-real-sdk')
            return {
              id: normalizeDownloaderFixtureId(
                requireRoot.resolve('youtubei.js'),
              ),
              external: true,
            };
          if (id === 'electron') return '\0owned-native';
          if (id === 'youtubei.js') return '\0owned-youtube';
          if (id === '@ffmpeg.wasm/main') return '\0owned-ffmpeg';
          if (id === 'bgutils-js') return '\0owned-bg';
          if (id === 'filenamify') return '\0owned-filenamify';
          if (id === 'virtual:i18n') return '\0owned-languages';
          if (id === 'virtual:plugins') return '\0unused-plugins';
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            for (const suffix of ['.ts', '/index.ts', '.tsx']) {
              try {
                await access(target + suffix);
                const resolvedId = path.normalize(target + suffix);
                if (
                  policy.isSongInfo(resolvedId) ||
                  normalizeDownloaderFixtureId(resolvedId).includes(
                    '/src/plugins/downloader/',
                  )
                )
                  aliasResolutions.push({ source: id, importer, resolvedId });
                return resolvedId;
              } catch {
                /* next suffix */
              }
            }
          }
          if (
            !id.startsWith('.') &&
            !path.isAbsolute(id) &&
            !id.startsWith('\0')
          )
            return {
              id: id.startsWith('node:')
                ? id
                : normalizeDownloaderFixtureId(requireRoot.resolve(id)),
              external: true,
            };
        },
        load(id: string) {
          if (id === '\0owned-native') return native;
          if (id === '\0owned-youtube') return youtube;
          if (id === '\0owned-ffmpeg') return ffmpeg;
          if (id === '\0owned-bg') return bg;
          if (id === '\0owned-filenamify')
            return `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(path.join(root, 'package.json'))});const value=require('filenamify');export default value.default??value;`;
          if (id === '\0unused-plugins')
            return 'export const allPlugins=async()=>({});';
          if (id === '\0owned-languages')
            return `import en from ${JSON.stringify(path.join(root, 'src/i18n/resources/en.json'))};export const availableLanguages=["en"];export const loadLanguageResource=async(name)=>name==="en"?en:undefined;export const languageResources=async()=>({en:{translation:en}});`;
        },
        transform(code: string, id: string) {
          if (policy.isSongInfo(id))
            return {
              code: `${code}\nexport {callbacks as fixtureCallbacks};`,
              map: null,
            };
          if (policy.isMain(id))
            return {
              code: `import {state as __state} from 'electron';const console={error:(v)=>__state.logs.push(String(v)),warn:(v)=>__state.logs.push(String(v)),trace:(v)=>__state.logs.push(String(v)),info:()=>{},log:()=>{}};\n${code}`,
              map: null,
            };
        },
        generateBundle(this: FixtureGraphContext) {
          for (const id of this.getModuleIds()) {
            const normalizedId = normalizeDownloaderFixtureId(id);
            if (
              normalizedId !== normalizeDownloaderFixtureId(entry) &&
              !policy.isSongInfo(id) &&
              !normalizedId.includes('/src/plugins/downloader/')
            )
              continue;
            const info = this.getModuleInfo(id);
            if (info)
              moduleGraph.push({
                id: info.id,
                importers: [...info.importers],
                importedIds: [...info.importedIds],
                exports: [...info.exports],
              });
          }
        },
      },
    ],
  });
  const output = path.join(directory, 'actual.cjs');
  await build.write({ file: output, format: 'cjs', codeSplitting: false });
  await build.close();
  const source = policy.evaluate(
    await readFile(output, 'utf8'),
    () => requireRoot(output) as FixtureSource,
  );
  await source.loadI18n();
  const previousCwd = process.cwd();
  process.chdir(directory);
  const contexts: BackendContext<DownloaderPluginConfig>[] = [];
  const bridges = new WeakMap<
    BackendContext<DownloaderPluginConfig>,
    Map<string, (...args: unknown[]) => unknown>
  >();
  const config: DownloaderPluginConfig = {
    enabled: true,
    downloadFolder: downloads,
    selectedPreset: 'Source',
    customPresetSetting: { extension: 'flac', ffmpegArgs: ['-c:a', 'flac'] },
    skipExisting: false,
    downloadOnFinish: {
      enabled: false,
      seconds: 20,
      percent: 10,
      mode: 'seconds',
    },
  };
  const createContext = (name: string) => {
    const window = new source.FixtureWindow(name);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const context: BackendContext<DownloaderPluginConfig> = {
      window,
      getConfig: () => ({ ...config }),
      setConfig(patch) {
        Object.assign(config, patch);
      },
      ipc: {
        handle: (key, fn) =>
          handlers.set(key, fn as (...args: unknown[]) => unknown),
        on() {},
        removeHandler: (key) => {
          handlers.delete(key);
        },
        send: (...args) => window.webContents.send(...args),
      },
    };
    contexts.push(context);
    bridges.set(context, handlers);
    return context;
  };
  return {
    source,
    state: source.state,
    config,
    directory,
    output,
    moduleGraph,
    aliasResolutions,
    downloads,
    createContext,
    invoke: async (
      context: BackendContext<DownloaderPluginConfig>,
      event: string,
      ...args: unknown[]
    ) => {
      const handler = bridges.get(context)?.get(event);
      if (!handler) throw new Error('Handler unavailable');
      return await handler(...args);
    },
    flush: () => new Promise<void>((resolve) => setImmediate(resolve)),
    close: async () => {
      for (const context of contexts) source.downloader.onMainStop?.(context);
      for (const pending of source.state.pending) pending.resolve();
      for (const token of source.state.tokens) token.resolve();
      for (const dialog of source.state.pendingDialogs)
        dialog.reject(new Error('Owned dialog teardown'));
      for (const info of source.state.pendingInfo)
        info.reject(new Error('Owned fixture teardown'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      delete requireRoot.cache[output];
      process.chdir(previousCwd);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
