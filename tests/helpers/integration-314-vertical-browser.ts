import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build, normalizePath } from 'vite';
import type { Page } from '@playwright/test';

const root = normalizePath(path.resolve(import.meta.dirname, '../..'));
/** Only external data, config and presentation boundaries are substituted. */
export async function verticalBrowserBundle() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-vertical-browser-'),
  );
  const entry = path.join(directory, 'entry.ts');
  const modules: string[] = [];
  const actual = (file: string) =>
    JSON.stringify(normalizePath(path.join(root, file)));
  await writeFile(
    entry,
    [
      `export {createMusicRendererController} from ${actual('src/providers/music-renderer.ts')};`,
      `export {publishMusicActionsOwner,getMusicActionsOwner} from ${actual('src/providers/music-actions.ts')};`,
      `export {adoptPlaybackOwner} from ${actual('src/providers/playback-owner.ts')};`,
      `export {setupSongInfo,getSongInfo} from ${actual('src/providers/song-info-front.ts')};`,
      `export {default as blocklist} from ${actual('src/plugins/blocklist/index.ts')};`,
      `export {renderer as lyrics} from ${actual('src/plugins/synced-lyrics/renderer/index.ts')};`,
      `export {lyricsStore,currentLyrics} from ${actual('src/plugins/synced-lyrics/renderer/store.ts')};`,
    ].join('\n'),
  );
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          ...['@/utils', '@/i18n', '@/providers/prompt-options'].map(
            (find) => ({ find, replacement: '\0vertical:' + find }),
          ),
          { find: '@', replacement: normalizePath(path.join(root, 'src')) },
        ],
      },
      plugins: [
        {
          name: 'vertical-controlled-external-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id === 'electron' || id === 'electron-store')
              throw Error('Native runtime import prohibited');
            if (
              [
                '@/utils',
                '@/i18n',
                '@/providers/prompt-options',
                'custom-electron-prompt',
              ].includes(id)
            )
              return '\0vertical:' + id;
            if (
              importer &&
              normalizePath(importer).includes('/synced-lyrics/')
            ) {
              if (id === './renderer' || id === '../renderer/renderer')
                return '\0vertical:lyrics-presentation';
              if (id === './utils') return '\0vertical:lyrics-view';
              if (id === './components/LyricsPicker')
                return '\0vertical:picker';
              if (id === '../providers/renderer') return '\0vertical:providers';
            }
            if (id.endsWith('?inline')) return '\0vertical:style';
            return undefined;
          },
          load(id) {
            if (id === '\0vertical:@/utils')
              return 'export const createPlugin=x=>x;export const createRenderer=x=>x;';
            if (id === '\0vertical:@/i18n') return 'export const t=x=>x;';
            if (id === '\0vertical:@/providers/prompt-options')
              return 'export default ()=>({});';
            if (id === '\0vertical:custom-electron-prompt')
              return 'export default async()=>null;';
            if (id === '\0vertical:style') return 'export default "";';
            if (id === '\0vertical:picker')
              return 'export const resetLyricsPickerSelection=()=>{};';
            if (id === '\0vertical:lyrics-presentation')
              return `import{createSignal}from 'solid-js';export const[config,setConfig]=createSignal(null);export const setCurrentTime=()=>{},setIsPlaying=()=>{},startLyricsEffects=()=>{};`;
            if (id === '\0vertical:lyrics-view')
              return `export const selectors={head:'#lyrics-header'},tabStates={};export const startLyricsView=()=>{},disposeLyricsView=()=>{};export const waitForLyricsElement=async(selector,signal)=>signal.aborted?null:document.querySelector(selector);`;
            if (id === '\0vertical:providers')
              return `import{LRCLib}from ${actual('src/plugins/synced-lyrics/providers/LRCLib.ts')};const unavailable={search:async()=>null};export const providers={LRCLib:new LRCLib(),YTMusic:unavailable,MusixMatch:unavailable,LyricsGenius:unavailable,NetEase:unavailable};`;
            return undefined;
          },
          transform(code, id) {
            if (
              process.env.VERTICAL_314_PROBE_BYPASS_PREVIOUS_ARM === '1' &&
              normalizePath(id) ===
                normalizePath(path.join(root, 'src/providers/music-actions.ts'))
            ) {
              const marker = 'armNavigation?.();';
              if (code.split(marker).length !== 2)
                throw Error(
                  'Previous-arm mutation no longer has one exact target',
                );
              return {
                code: code.replace(
                  marker,
                  '/* Deliberate negative control: omit ticket arming. */',
                ),
                map: null,
              };
            }
            return undefined;
          },
          generateBundle() {
            modules.push(
              ...Array.from(this.getModuleIds())
                .map((id) => normalizePath(id))
                .filter((id) => id.startsWith(root + '/src/')),
            );
            if (modules.some((id) => /electron-store|\/src\/config\//.test(id)))
              throw Error('Profile storage imported');
            for (const suffix of [
              'song-info-front.ts',
              'music-renderer.ts',
              'music-actions.ts',
              'playback-navigation.ts',
              'playback-filter.ts',
              'synced-lyrics/renderer/index.ts',
              'synced-lyrics/renderer/store.ts',
              'providers/LRCLib.ts',
            ]) {
              if (modules.filter((id) => id.endsWith(suffix)).length !== 1)
                throw Error('Missing/duplicate real module: ' + suffix);
            }
          },
        },
      ],
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry,
          formats: ['iife'],
          name: 'VerticalSource',
          fileName: () => 'browser.js',
        },
      },
    });
    return {
      code: await readFile(path.join(directory, 'browser.js'), 'utf8'),
      modules,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Real attached DOM and controlled native player leaf, never a navigation substitute. */
export async function installVerticalBrowser(page: Page, code: string) {
  await page.evaluate(() => {
    const w = window as any;
    w.verticalListeners = new Map<string, Set<any>>();
    w.verticalPackets = [];
    w.ipcRenderer = {
      on(channel: string, fn: any) {
        const listeners = w.verticalListeners.get(channel) ?? new Set();
        const wrapped = (...args: any[]) => fn({}, ...args);
        listeners.add(wrapped);
        w.verticalListeners.set(channel, listeners);
        return () => listeners.delete(wrapped);
      },
      send(channel: string, ...args: any[]) {
        return w.verticalSend({ channel, args });
      },
    };
    w.verticalDeliver = (channel: string, args: any[]) => {
      w.verticalPackets.push({ channel, args });
      for (const listener of [...(w.verticalListeners.get(channel) ?? [])])
        listener(...args);
    };
  });
  await page.addScriptTag({ content: code });
  await page.evaluate(async () => {
    const w = window as any,
      source = w.VerticalSource;
    w.v = {
      state: {
        index: 1,
        id: 'trackA00001',
        author: 'Allowed',
        title: 'Short A',
        time: 1.5,
        duration: 2,
      },
      effects: [] as any[],
      handlers: new Map<string, Set<any>>(),
      ipc: {
        subscribe(channel: string, listener: any) {
          const set = w.verticalListeners.get(channel) ?? new Set();
          set.add(listener);
          w.verticalListeners.set(channel, set);
          return () => set.delete(listener);
        },
        send: (channel: string, ...args: any[]) =>
          w.ipcRenderer.send(channel, ...args),
        invoke: async () => {
          throw Error('Unexpected lyrics IPC transport');
        },
      },
    };
    const v = w.v;
    w.mainConfig = {
      get: (key: string) =>
        key === 'plugins' ? { 'music-together': { enabled: false } } : false,
    };
    v.rows = ['trackB00001', 'trackA00001', 'trackC00001'].map((videoId) => ({
      playlistPanelVideoRenderer: { videoId },
    }));
    v.queue = {
      items: v.rows,
      selectedItemIndex: 1,
      queueContextParams: 'vertical-queue',
    };
    v.storeState = { queue: v.queue, castStatus: {} };
    const store = { getState: () => v.storeState };
    (document.querySelector('#queue') as any).queue = {
      store: { store },
      getItems: () => v.rows,
    };
    (document.querySelector('ytmusic-player-bar') as any).getState = () =>
      v.storeState;
    Object.defineProperty(document.querySelector('video'), 'readyState', {
      configurable: true,
      value: 1,
    });
    const app = document.querySelector('ytmusic-app') as any;
    app.networkManager = {
      fetch: () => {
        throw Error('Unexpected player network request');
      },
    };
    v.announce = () => {
      const data = {
        videoId: v.state.id,
        title: v.state.title,
        author: v.state.author,
      };
      for (const name of ['dataloaded', 'dataupdated']) {
        for (const listener of [...(v.handlers.get('videodatachange') ?? [])])
          listener(name, data);
      }
    };
    v.arrive = (index: number) => {
      const id = v.rows[index].playlistPanelVideoRenderer.videoId;
      Object.assign(v.state, {
        index,
        id,
        author: index === 0 ? 'Blocked' : 'Allowed',
        title:
          index === 0 ? 'Blocked B' : index === 1 ? 'Short A' : 'Current C',
        time: 0,
        duration: index === 1 ? 2 : 20,
      });
      v.queue.selectedItemIndex = index;
      v.announce();
    };
    v.makeApi = () => {
      const api = document.querySelector('#movie_player') as any;
      return Object.assign(api, {
        getVideoData: () => ({
          video_id: v.state.id,
          title: v.state.title,
          author: v.state.author,
        }),
        getPlayerResponse: () => ({
          videoDetails: {
            videoId: v.state.id,
            title: v.state.title,
            author: v.state.author,
            channelId: v.state.author === 'Blocked' ? 'UCblocked' : 'UCallowed',
            lengthSeconds: String(v.state.duration),
            musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
          },
          microformat: {
            microformatDataRenderer: {
              urlCanonical: 'https://music.youtube.com/watch?v=' + v.state.id,
              linkAlternates: [],
              tags: [],
            },
          },
        }),
        getWatchNextResponse: () => ({}),
        getPlaylistIndex: () => v.state.index,
        getCurrentTime: () => v.state.time,
        getDuration: () => v.state.duration,
        getPlayerState: () => 1,
        getVolume: () => 50,
        previousVideo: () => {
          v.effects.push({
            action: 'previous',
            id: v.state.id,
            time: v.state.time,
          });
          if (v.state.time > 3) v.state.time = 0;
          else v.arrive(Math.max(0, v.state.index - 1));
        },
        nextVideo: () => {
          v.effects.push({ action: 'next', id: v.state.id });
          v.arrive(Math.min(2, v.state.index + 1));
        },
        pauseVideo: () => v.effects.push({ action: 'pause', id: v.state.id }),
        addEventListener(name: string, fn: any) {
          const set = v.handlers.get(name) ?? new Set();
          set.add(fn);
          v.handlers.set(name, set);
        },
        removeEventListener(name: string, fn: any) {
          v.handlers.get(name)?.delete(fn);
        },
      });
    };
    v.bind = async () => {
      v.api = v.makeApi();
      source.adoptPlaybackOwner(v.api);
      v.disposeOwner = source.publishMusicActionsOwner(v.api, {
        getApi: () => v.api,
        repeatPreference: {},
        playlistQueue: {},
      });
      source.setupSongInfo(v.api);
      v.controller = source.createMusicRendererController(
        v.api,
        () => v.api,
        v.ipc,
      );
      const context = {
        getConfig: async () => ({
          enabled: true,
          blockedArtists: [{ name: 'Blocked', channelId: 'UCblocked' }],
          allowIntentionalPrevious: true,
        }),
        setConfig: async () => {},
        ipc: v.ipc,
      };
      await source.blocklist.renderer.start(context);
      source.blocklist.renderer.onPlayerApiReady(v.api);
      await source.lyrics.start({
        ...context,
        getConfig: async () => ({
          enabled: true,
          showLyricsEvenIfInexact: false,
        }),
      });
      await source.lyrics.onPlayerApiReady(v.api);
    };
    await v.bind();
  });
}
