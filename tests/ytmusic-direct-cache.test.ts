import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { build } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const directory = path.join(root, 'src/plugins/synced-lyrics/renderer');
let scratch: string;
let code: string;

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'pear-lyrics-direct-cache-'));
  const entry = path.join(scratch, 'entry.tsx');
  await writeFile(
    entry,
    `import{renderer,_ytAPI,exportCurrentLyrics}from ${JSON.stringify(path.join(directory, 'index.ts'))};import{fetchLyrics,retrySearch,lyricsStore,setLyricsStore,currentLyrics}from ${JSON.stringify(path.join(directory, 'store.ts'))};import{config,currentTime}from ${JSON.stringify(path.join(directory, 'renderer.tsx'))};import{providerIdx}from ${JSON.stringify(path.join(directory, 'components/LyricsPicker.tsx'))};import{tabStates}from ${JSON.stringify(path.join(directory, 'utils.tsx'))};import{pending,setSong}from'fixture-lyrics-state';window.lyricsFixture={exporter:()=>exportCurrentLyrics,renderer,fetchLyrics,retrySearch,lyricsStore,setLyricsStore,currentLyrics,config,currentTime,providerIdx,tabStates,pending,setSong,api:()=>_ytAPI};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^@\/utils$/, replacement: '\0fixture-lyrics-utils' },
        {
          find: /^@\/providers\/song-info-front$/,
          replacement: '\0fixture-lyrics-song',
        },
        { find: /^@\/i18n$/, replacement: '\0fixture-lyrics-i18n' },
        { find: /^@\/solit$/, replacement: '\0fixture-lyrics-lit' },
        {
          find: /^solid-js$/,
          replacement: requireRoot.resolve('solid-js/dist/solid.js'),
        },
        {
          find: /^solid-js\/web$/,
          replacement: requireRoot.resolve('solid-js/web/dist/web.js'),
        },
        { find: '@', replacement: path.join(root, 'src') },
      ],
      conditions: ['browser'],
    },
    plugins: [
      solidPlugin(),
      {
        name: 'actual-lyrics-owned-boundaries',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === 'fixture-lyrics-state') return '\0fixture-lyrics-state';
          if (id === '@/utils') return '\0fixture-lyrics-utils';
          if (id === '@/providers/song-info-front')
            return '\0fixture-lyrics-song';
          if (
            id === '../providers/renderer' &&
            importer?.endsWith('/renderer/store.ts')
          )
            return '\0fixture-lyrics-providers';
          if (id === '@/i18n') return '\0fixture-lyrics-i18n';
          if (id === '@/solit') return '\0fixture-lyrics-lit';
          if (id.startsWith('@mdui/icons/')) return '\0fixture-lyrics-icon';
          if (id === 'virtua/solid') return '\0fixture-lyrics-list.tsx';
        },
        load(id) {
          if (id === '\0fixture-lyrics-state')
            return `export const pending=[];let song={};export const setSong=value=>song=value;export const getSongInfo=()=>song;export function search(provider,info,mode){return new Promise((resolve,reject)=>pending.push({provider,info,mode,resolve,reject}))}`;
          if (id === '\0fixture-lyrics-utils')
            return 'export const createRenderer=value=>value;';
          if (id === '\0fixture-lyrics-song')
            return "export{getSongInfo}from'fixture-lyrics-state';";
          if (id === '\0fixture-lyrics-providers')
            return `import{search}from'fixture-lyrics-state';import{config}from ${JSON.stringify(path.join(directory, 'renderer.tsx'))};export const providers=Object.fromEntries(['YTMusic','LRCLib','MusixMatch','LyricsGenius','NetEase'].map(name=>[name,{search:info=>search(name,info,config()?.useYTMLyricsWithoutProxy===true)}]));`;
          if (id === '\0fixture-lyrics-i18n')
            return `export const t=value=>({'plugins.synced-lyrics.tools.export':'Export lyrics…','plugins.synced-lyrics.tools.saved':'Lyrics saved'}[value]??value);`;
          if (id === '\0fixture-lyrics-lit')
            return 'export const LitElementWrapper=args=>{const element=document.createElement("button");element.onclick=args.props?.onClick;return element};';
          if (id === '\0fixture-lyrics-icon')
            return 'export const IconCheckCircle=class{},IconChevronLeft=class{},IconChevronRight=class{},IconError=class{},IconStarBorder=class{},IconStar=class{},IconWarning=class{},IconReplay=class{};';
          if (id === '\0fixture-lyrics-list.tsx')
            return `import{For,createComponent}from'solid-js';import{insert}from'solid-js/web';export const VList=props=>{props.ref?.({scrollOffset:0,scrollToIndex(){}});const div=document.createElement('div');div.className=props.class;insert(div,createComponent(For,{get each(){return props.data},children:(item,index)=>props.children(item,index)}));return div};`;
        },
      },
    ],
    build: {
      lib: { entry, formats: ['iife'], name: 'lyricsRequestFixture' },
      minify: false,
      write: false,
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  code = bundle.output.find((item) => item.type === 'chunk')!.code;
});
test.afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
const info = (videoId: string, title = videoId) => ({
  videoId,
  title,
  artist: 'fixture',
  tags: [],
  songDuration: 120,
});
const result = (lyrics: string) => ({
  title: 'fixture',
  artists: ['fixture'],
  lyrics,
});
const cfg = {
  enabled: true,
  preciseTiming: true,
  lineEffect: 'fancy',
  romanization: false,
  defaultTextString: '',
  showTimeCodes: false,
  useYTMLyricsWithoutProxy: false,
};
function fixture() {
  const window = new Window();
  const intervals = new Map<number, () => void>();
  let intervalId = 0;
  const activeObservers = new Set<object>();
  const Observer = window.MutationObserver;
  class TrackedObserver extends Observer {
    observe(...args: Parameters<InstanceType<typeof Observer>['observe']>) {
      activeObservers.add(this);
      super.observe(...args);
    }
    disconnect() {
      activeObservers.delete(this);
      super.disconnect();
    }
  }
  Object.assign(window, {
    MutationObserver: TrackedObserver,
    setInterval: (callback: () => void) => {
      intervals.set(++intervalId, callback);
      return intervalId;
    },
    clearInterval: (id: number) => intervals.delete(id),
    mainConfig: { get: () => undefined, plugins: { getPlugins: () => ({}) } },
    ipcRenderer: {
      invoke: async () => undefined,
      on() {},
      send() {},
      removeAllListeners() {},
    },
    electronIs: {
      linux: () => false,
      windows: () => false,
      osx: () => true,
      macOS: () => true,
    },
    fetch: () =>
      Promise.reject(
        new Error('No external network in lyrics lifecycle fixture'),
      ),
  });
  window.eval(code);
  const state = (window as any).lyricsFixture;
  const listeners = new Set<(value: unknown) => void>();
  const context = {
    getConfig: async () => cfg,
    ipc: {
      invoke: async () => undefined,
      on: (_channel: string, listener: (value: unknown) => void) => {
        listeners.add(listener);
      },
      subscribe: (_channel: string, listener: (value: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const api = () => ({
    listeners: new Set<(...args: unknown[]) => void>(),
    time: 7,
    getCurrentTime() {
      return this.time;
    },
    addEventListener(_name: string, fn: (...args: unknown[]) => void) {
      this.listeners.add(fn);
    },
    removeEventListener(_name: string, fn: (...args: unknown[]) => void) {
      this.listeners.delete(fn);
    },
    emit(...args: unknown[]) {
      for (const fn of this.listeners) fn(...args);
    },
  });
  const tick = () => {
    for (const callback of [...intervals.values()]) callback();
  };
  const track = async (id: string, title = id) => {
    const song = info(id, title);
    state.setSong(song);
    state.fetchLyrics(song);
    await settle();
  };
  const mountDom = (selected = false) => {
    window.document.body.innerHTML = `<div id="tabsContent"><div class="tab-header"></div><div class="tab-header" disabled aria-selected="${selected}"></div></div><div id="tab-renderer" page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"></div>`;
    // happy-dom lacks the browser's ariaSelected attribute reflection.
    (
      window.document.querySelector('.tab-header:nth-of-type(2)') as any
    ).ariaSelected = String(selected);
  };
  return {
    window,
    state,
    listeners,
    context,
    api,
    tick,
    track,
    mountDom,
    intervals,
    activeObservers,
    request: () => state.pending.at(-1),
    close: async () => {
      state.renderer.stop();
      intervals.clear();
      await window.happyDOM.close();
    },
  };
}

const complete = async (f: ReturnType<typeof fixture>, label: string) => {
  for (const request of f.state.pending.filter(
    (value: any) => !value.completed,
  )) {
    request.completed = true;
    request.resolve(result(label + '-' + request.provider));
  }
  await settle();
};
const agreeingApi = (f: ReturnType<typeof fixture>, id: string) =>
  Object.assign(f.api(), {
    getVideoData: () => ({ video_id: id }),
    getPlayerResponse: () => ({ videoDetails: { videoId: id } }),
  });

test('mode change retries only current YTMusic and preserves completed other providers', async () => {
  const f = fixture();
  try {
    f.mountDom();
    await f.state.renderer.start(f.context);
    await f.track('A');
    await complete(f, 'proxy');
    await f.state.renderer.onPlayerApiReady(agreeingApi(f, 'A'));
    const before = f.state.pending.length;
    f.state.renderer.onConfigChange({ ...cfg, useYTMLyricsWithoutProxy: true });
    await settle();
    expect(f.state.pending.length).toBe(before + 1);
    const current = f.request();
    expect(current.provider).toBe('YTMusic');
    expect(current.mode).toBe(true);
    expect(f.state.lyricsStore.lyrics.LRCLib.data.lyrics).toBe('proxy-LRCLib');
    expect(f.state.lyricsStore.lyrics.YTMusic.state).toBe('fetching');
    current.resolve(result('direct-current'));
    await settle();
    expect(f.state.lyricsStore.lyrics.YTMusic.data.lyrics).toBe(
      'direct-current',
    );
  } finally {
    await f.close();
  }
});

for (const proxyOutcome of ['data', 'error', 'not-found'])
  test(`revisited completed ${proxyOutcome} cache refreshes only YTMusic after mode change`, async () => {
    const f = fixture();
    try {
      await f.state.renderer.start(f.context);
      await f.track('A');
      const ytm = f.state.pending.find(
        (value: any) => value.provider === 'YTMusic',
      );
      ytm.completed = true;
      if (proxyOutcome === 'error') ytm.reject(Error('owned proxy failure'));
      else ytm.resolve(proxyOutcome === 'data' ? result('old-proxy') : null);
      await complete(f, 'A');
      await f.track('B');
      await complete(f, 'B');
      const before = f.state.pending.length;
      f.state.renderer.onConfigChange({
        ...cfg,
        useYTMLyricsWithoutProxy: true,
      });
      await settle();
      expect(f.state.pending.length).toBe(before);
      await f.track('A');
      expect(f.state.pending.length).toBe(before + 1);
      expect(f.request().provider).toBe('YTMusic');
      expect(f.request().mode).toBe(true);
      expect(f.state.lyricsStore.lyrics.YTMusic.data).toBeNull();
      expect(f.state.lyricsStore.lyrics.LRCLib.data.lyrics).toBe('A-LRCLib');
      f.request().resolve(result('fresh-direct'));
      await settle();
      expect(f.state.lyricsStore.lyrics.YTMusic.data.lyrics).toBe(
        'fresh-direct',
      );
    } finally {
      await f.close();
    }
  });

for (const stale of ['success', 'error'])
  test(`a pending old-mode ${stale} cannot overwrite the toggle retry and other pending providers remain owned`, async () => {
    const f = fixture();
    try {
      f.mountDom();
      await f.state.renderer.start(f.context);
      await f.track('A');
      await f.state.renderer.onPlayerApiReady(agreeingApi(f, 'A'));
      const old = f.state.pending.find(
          (value: any) => value.provider === 'YTMusic',
        ),
        peers = f.state.pending.filter((value: any) => value !== old),
        before = f.state.pending.length;
      f.state.renderer.onConfigChange({
        ...cfg,
        useYTMLyricsWithoutProxy: true,
      });
      await settle();
      expect(f.state.pending.length).toBe(before + 1);
      const fresh = f.request();
      fresh.resolve(result('new-direct'));
      for (const peer of peers) peer.resolve(result('owned-' + peer.provider));
      await settle();
      stale === 'success'
        ? old.resolve(result('stale-proxy'))
        : old.reject(Error('stale-proxy'));
      await settle();
      expect(f.state.lyricsStore.lyrics.YTMusic.data.lyrics).toBe('new-direct');
      expect(f.state.lyricsStore.lyrics.LRCLib.data.lyrics).toBe(
        'owned-LRCLib',
      );
    } finally {
      await f.close();
    }
  });

test('unchanged mode and unrelated preferences retain completed caches and request owners', async () => {
  const f = fixture();
  try {
    f.mountDom();
    await f.state.renderer.start(f.context);
    await f.track('A');
    await complete(f, 'cached');
    await f.state.renderer.onPlayerApiReady(agreeingApi(f, 'A'));
    const before = f.state.pending.length;
    f.state.renderer.onConfigChange({ ...cfg, showTimeCodes: true });
    await settle();
    await f.track('A');
    expect(f.state.pending.length).toBe(before);
    expect(f.state.lyricsStore.lyrics.YTMusic.data.lyrics).toBe(
      'cached-YTMusic',
    );
  } finally {
    await f.close();
  }
});

for (const identity of ['disagrees', 'unknown', 'retired'])
  test(`mode changes cannot retry against ${identity} native ownership`, async () => {
    const f = fixture();
    try {
      f.mountDom();
      await f.state.renderer.start(f.context);
      await f.track('A');
      await complete(f, 'cached');
      const api = agreeingApi(f, 'A');
      await f.state.renderer.onPlayerApiReady(api);
      if (identity === 'disagrees')
        api.getPlayerResponse = () => ({ videoDetails: { videoId: 'B' } });
      if (identity === 'unknown') api.emit('dataloaded', null);
      if (identity === 'retired') f.state.renderer.stop();
      const before = f.state.pending.length;
      f.state.renderer.onConfigChange({
        ...cfg,
        useYTMLyricsWithoutProxy: true,
      });
      await settle();
      expect(f.state.pending.length).toBe(before);
    } finally {
      await f.close();
    }
  });

test('rapid direct/proxy round trip retires both older attempts and keeps the latest completed mode cache', async () => {
  const f = fixture();
  try {
    f.mountDom();
    await f.state.renderer.start(f.context);
    await f.track('A');
    await complete(f, 'initial');
    await f.state.renderer.onPlayerApiReady(agreeingApi(f, 'A'));
    const before = f.state.pending.length;
    f.state.renderer.onConfigChange({ ...cfg, useYTMLyricsWithoutProxy: true });
    await settle();
    const direct = f.request();
    f.state.renderer.onConfigChange({
      ...cfg,
      useYTMLyricsWithoutProxy: false,
    });
    await settle();
    const proxy = f.request();
    expect(f.state.pending.length).toBe(before + 2);
    expect(direct.mode).toBe(true);
    expect(proxy.mode).toBe(false);
    proxy.resolve(result('latest-proxy'));
    direct.resolve(result('obsolete-direct'));
    await settle();
    expect(f.state.lyricsStore.lyrics.YTMusic.data.lyrics).toBe('latest-proxy');
    await f.track('A');
    expect(f.state.pending.length).toBe(before + 2);
    expect(f.state.lyricsStore.lyrics.LRCLib.data.lyrics).toBe(
      'initial-LRCLib',
    );
  } finally {
    await f.close();
  }
});
