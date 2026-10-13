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
  scratch = await mkdtemp(path.join(tmpdir(), 'pear-lyrics-request-'));
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
            return `export const pending=[];let song={};export const setSong=value=>song=value;export const getSongInfo=()=>song;export function search(provider,info){return new Promise((resolve,reject)=>pending.push({provider,info,resolve,reject}))}`;
          if (id === '\0fixture-lyrics-utils')
            return 'export const createRenderer=value=>value;';
          if (id === '\0fixture-lyrics-song')
            return "export{getSongInfo}from'fixture-lyrics-state';";
          if (id === '\0fixture-lyrics-providers')
            return "import{search}from'fixture-lyrics-state';export const providers=Object.fromEntries(['YTMusic','LRCLib','MusixMatch','LyricsGenius'].map(name=>[name,{search:info=>search(name,info)}]));";
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

for (const stale of ['success', 'error'])
  test(`retry ${stale} cannot overwrite a newer track`, async () => {
    const f = fixture();
    try {
      await f.state.renderer.start(f.context);
      await f.track('A');
      f.state.retrySearch('YTMusic', info('A'));
      await settle();
      const old = f.request();
      await f.track('B');
      f.state.pending
        .findLast((p: any) => p.provider === 'YTMusic')
        .resolve(result('B'));
      await settle();
      stale === 'success'
        ? old.resolve(result('old-A'))
        : old.reject(new Error('old-A'));
      await settle();
      expect(f.state.currentLyrics().data?.lyrics).toBe('B');
    } finally {
      await f.close();
    }
  });

test('newer retry wins when two same-track provider attempts finish backwards', async () => {
  const f = fixture();
  try {
    await f.state.renderer.start(f.context);
    await f.track('A');
    f.state.retrySearch('YTMusic', info('A'));
    await settle();
    const first = f.request();
    f.state.retrySearch('YTMusic', info('A'));
    await settle();
    const second = f.request();
    second.resolve(result('new'));
    await settle();
    first.resolve(result('old'));
    await settle();
    expect(f.state.currentLyrics().data?.lyrics).toBe('new');
  } finally {
    await f.close();
  }
});

test('normal search and retry are fenced across ABA and same-ID refresh', async () => {
  const f = fixture();
  try {
    await f.state.renderer.start(f.context);
    await f.track('A', 'old');
    const oldNormal = f.state.pending.find(
      (p: any) => p.provider === 'YTMusic',
    );
    f.state.retrySearch('YTMusic', info('A', 'old'));
    await settle();
    const oldRetry = f.request();
    await f.track('B');
    await f.track('A', 'new');
    const newer = f.state.pending.findLast(
      (p: any) => p.provider === 'YTMusic',
    );
    expect(newer.info.title).toBe('new');
    newer.resolve(result('new-A'));
    await settle();
    oldNormal.resolve(result('old-normal'));
    oldRetry.reject(new Error('old-retry'));
    await settle();
    expect(f.state.currentLyrics().data?.lyrics).toBe('new-A');
  } finally {
    await f.close();
  }
});

test('an original provider request cannot overwrite a newer retry', async () => {
  const f = fixture();
  try {
    await f.state.renderer.start(f.context);
    await f.track('A');
    const original = f.state.pending.find((p: any) => p.provider === 'YTMusic');
    f.state.retrySearch('YTMusic', info('A'));
    await settle();
    f.request().resolve(result('retry'));
    await settle();
    original.resolve(result('normal'));
    await settle();
    expect(f.state.currentLyrics().data?.lyrics).toBe('retry');
  } finally {
    await f.close();
  }
});

test('stop suppresses pending provider completion and resets state before reenabling', async () => {
  const f = fixture();
  try {
    await f.state.renderer.start(f.context);
    await f.track('A');
    f.state.retrySearch('YTMusic', info('A'));
    await settle();
    const old = f.request();
    f.state.renderer.stop();
    old.resolve(result('stopped'));
    await settle();
    expect(f.state.currentLyrics().data).toBeNull();
    await f.state.renderer.start(f.context);
    await f.track('A');
    f.state.pending
      .findLast((p: any) => p.provider === 'YTMusic')
      .resolve(result('reenabled'));
    await settle();
    expect(f.state.currentLyrics().data?.lyrics).toBe('reenabled');
    f.state.setLyricsStore('provider', 'LRCLib');
    expect(f.state.providerIdx()).toBe(1);
  } finally {
    await f.close();
  }
});

test('stop owns API listeners, timestamp interval, observer and only its IPC subscription', async () => {
  const f = fixture();
  try {
    f.mountDom();
    const unrelated = () => {};
    f.listeners.add(unrelated);
    await f.state.renderer.start(f.context);
    const a = f.api();
    const ready = f.state.renderer.onPlayerApiReady(a);
    f.tick();
    await ready;
    expect(a.listeners.size).toBe(1);
    expect(f.intervals.size).toBe(1);
    f.state.renderer.stop();
    expect(a.listeners.size).toBe(0);
    expect(f.intervals.size).toBe(0);
    expect(f.activeObservers.size).toBe(0);
    expect(f.listeners).toEqual(new Set([unrelated]));
    expect(f.state.api()).toBeNull();
    expect(f.state.currentTime()).toBe(-1);
  } finally {
    await f.close();
  }
});

test('API replacement retires the old listener and keeps one timestamp owner', async () => {
  const f = fixture();
  try {
    f.mountDom();
    await f.state.renderer.start(f.context);
    const a = f.api();
    const b = f.api();
    let ready = f.state.renderer.onPlayerApiReady(a);
    f.tick();
    await ready;
    ready = f.state.renderer.onPlayerApiReady(b);
    f.tick();
    await ready;
    expect(a.listeners.size).toBe(0);
    expect(b.listeners.size).toBe(1);
    expect(f.intervals.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('late config completion cannot resurrect a stopped renderer', async () => {
  const f = fixture();
  try {
    let resolve: (value: unknown) => void = () => {};
    const config = new Promise((yes) => {
      resolve = yes;
    });
    const started = f.state.renderer.start({
      ...f.context,
      getConfig: () => config,
    });
    f.state.renderer.stop();
    resolve(cfg);
    await started;
    expect(f.listeners.size).toBe(0);
    expect(f.state.config()).toBeNull();
  } finally {
    await f.close();
  }
});

test('stopped DOM wait cannot attach a header observer or mount delayed lyrics', async () => {
  const f = fixture();
  try {
    await f.state.renderer.start(f.context);
    const api = f.api();
    const ready = f.state.renderer.onPlayerApiReady(api);
    await settle();
    f.state.renderer.stop();
    expect(f.activeObservers.size).toBe(0);
    expect(
      f.window.document.documentElement.style.getPropertyValue(
        '--lyrics-font-size',
      ),
    ).toBe('');
    expect(f.intervals.size).toBe(0);
    f.mountDom(true);
    f.tick();
    await settle();
    expect(f.activeObservers.size).toBe(0);
    expect(f.intervals.size).toBe(0);
    expect(
      f.window.document.querySelector('#synced-lyrics-container'),
    ).toBeNull();
    await ready;
  } finally {
    await f.close();
  }
});

test('a native track change retires old work before delayed song-info metadata catches up', async () => {
  const f = fixture();
  try {
    f.mountDom();
    await f.state.renderer.start(f.context);
    const api = f.api();
    const ready = f.state.renderer.onPlayerApiReady(api);
    f.tick();
    await ready;
    await f.track('A');
    f.state.retrySearch('YTMusic', info('A'));
    await settle();
    const old = f.request();
    api.emit('dataloaded', { videoId: 'B' });
    await settle();
    old.resolve(result('old-A'));
    await settle();
    expect(f.state.currentLyrics().data).toBeNull();
  } finally {
    await f.close();
  }
});

test('the mounted picker preserves Auto and starred-provider selection and is disposed on stop', async () => {
  const f = fixture();
  try {
    f.mountDom(true);
    await f.state.renderer.start(f.context);
    const api = f.api();
    await f.state.renderer.onPlayerApiReady(api);
    await settle();
    await f.track('A');
    expect(
      f.window.document.querySelector('#synced-lyrics-container'),
    ).not.toBeNull();
    expect(api.listeners.size).toBe(2);
    f.state.pending
      .findLast((p: any) => p.provider === 'LRCLib')
      .resolve(result('plain'));
    await settle();
    expect(f.state.lyricsStore.provider).toBe('LRCLib');
    f.state.pending
      .findLast((p: any) => p.provider === 'MusixMatch')
      .resolve({
        ...result(''),
        lines: [
          {
            time: '00:00',
            timeInMs: 0,
            duration: 120000,
            text: 'synced',
            status: 'upcoming',
          },
        ],
      });
    await settle();
    expect(f.state.lyricsStore.provider).toBe('MusixMatch');
    f.window.localStorage.setItem(
      'ytmd-sl-starred-A',
      JSON.stringify({ provider: 'LRCLib' }),
    );
    api.emit('dataupdated', { videoId: 'A' });
    await settle();
    expect(f.state.lyricsStore.provider).toBe('LRCLib');
    expect(f.state.currentLyrics().data?.lyrics).toBe('plain');
    expect(
      f.window.document.querySelector('#synced-lyrics-container'),
    ).not.toBeNull();
    f.state.renderer.stop();
    expect(api.listeners.size).toBe(0);
    expect(
      f.window.document.querySelector('#synced-lyrics-container'),
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test('reenabling recreates config effects and a stopped lyrics-body wait cannot mount later', async () => {
  const f = fixture();
  try {
    f.mountDom(true);
    f.window.document.querySelector('#tab-renderer')!.remove();
    await f.state.renderer.start(f.context);
    await f.state.renderer.onPlayerApiReady(f.api());
    await settle();
    expect(f.activeObservers.size).toBeGreaterThan(0);
    f.state.renderer.stop();
    expect(f.activeObservers.size).toBe(0);
    f.mountDom(true);
    await settle();
    expect(
      f.window.document.querySelector('#synced-lyrics-container'),
    ).toBeNull();
    await f.state.renderer.start({
      ...f.context,
      getConfig: async () => ({ ...cfg, lineEffect: 'offset' }),
    });
    await settle();
    expect(
      f.window.document.documentElement.style.getPropertyValue(
        '--lyrics-font-size',
      ),
    ).toBe('clamp(1.4rem, 1.1vmax, 3rem)');
  } finally {
    await f.close();
  }
});

test('a manual provider choice survives same-API remount and resets on a new enabled session', async () => {
  const f = fixture();
  try {
    f.mountDom(true);
    await f.state.renderer.start(f.context);
    const api = f.api();
    await f.state.renderer.onPlayerApiReady(api);
    await settle();
    await f.track('A');
    f.state.pending
      .findLast((p: any) => p.provider === 'LRCLib')
      .resolve(result('plain'));
    await settle();
    (
      Array.from(
        f.window.document.querySelectorAll('.lyrics-picker-left button'),
      ).at(-1) as any
    ).click();
    await settle();
    expect(f.state.lyricsStore.provider).toBe('MusixMatch');
    await f.state.renderer.onPlayerApiReady(api);
    await settle();
    expect(f.state.lyricsStore.provider).toBe('MusixMatch');
    f.state.renderer.stop();
    await f.state.renderer.start(f.context);
    await f.state.renderer.onPlayerApiReady(api);
    await settle();
    await f.track('A');
    f.state.pending
      .findLast((p: any) => p.provider === 'LRCLib')
      .resolve(result('new'));
    await settle();
    expect(f.state.lyricsStore.provider).toBe('LRCLib');
  } finally {
    await f.close();
  }
});

test('unknown native payload clears the mounted picker without retaining the previous song', async () => {
  const f = fixture();
  try {
    f.mountDom(true);
    await f.state.renderer.start(f.context);
    const api = f.api();
    await f.state.renderer.onPlayerApiReady(api);
    await settle();
    await f.track('A');
    expect(() => api.emit('dataloaded', null)).not.toThrow();
    await settle();
    expect(f.state.currentLyrics().data).toBeNull();
  } finally {
    await f.close();
  }
});

for (const native of [{ videoId: 'B' }, null]) {
  test(`same-API remount retains the observed ${native ? 'B' : 'unknown'} fence against delayed A metadata`, async () => {
    const f = fixture();
    try {
      f.mountDom();
      await f.state.renderer.start(f.context);
      const api = Object.assign(f.api(), {
        getVideoData: () => ({ video_id: 'A' }),
        getPlayerResponse: () => ({ videoDetails: { videoId: 'A' } }),
      });
      await f.state.renderer.onPlayerApiReady(api);
      await f.track('A');
      for (const pending of f.state.pending) pending.resolve(result('A'));
      await settle();
      expect(f.state.currentLyrics().data?.lyrics).toBe('A');
      api.emit('dataloaded', native);
      await settle();
      expect(f.state.currentLyrics().data).toBeNull();
      await f.state.renderer.onPlayerApiReady(api);
      await settle();
      const stale = info('A');
      f.state.setSong(stale);
      for (const listener of f.listeners) listener(stale);
      await settle();
      expect(f.state.currentLyrics().data).toBeNull();
    } finally {
      await f.close();
    }
  });
}

for (const mode of ['agreeing B', 'disagreeing IDs', 'missing identity']) {
  test(`a replacement API with ${mode} cannot admit delayed old A metadata`, async () => {
    const f = fixture();
    try {
      f.mountDom();
      await f.state.renderer.start(f.context);
      await f.state.renderer.onPlayerApiReady(f.api());
      await f.track('A');
      for (const pending of f.state.pending) pending.resolve(result('A'));
      await settle();
      const replacement =
        mode === 'missing identity'
          ? f.api()
          : Object.assign(f.api(), {
              getVideoData: () => ({ video_id: 'B' }),
              getPlayerResponse: () => ({
                videoDetails: { videoId: mode === 'agreeing B' ? 'B' : 'A' },
              }),
            });
      await f.state.renderer.onPlayerApiReady(replacement);
      const stale = info('A');
      f.state.setSong(stale);
      for (const listener of f.listeners) listener(stale);
      await settle();
      expect(f.state.currentLyrics().data).toBeNull();
      replacement.emit('dataupdated', { videoId: 'B' });
      await settle();
      const fresh = info('B');
      f.state.setSong(fresh);
      for (const listener of f.listeners) listener(fresh);
      await settle();
      f.state.pending
        .findLast((p: any) => p.provider === 'YTMusic')
        .resolve(result('B'));
      await settle();
      expect(f.state.currentLyrics().data?.lyrics).toBe('B');
    } finally {
      await f.close();
    }
  });
}

test('unobserved initial API bootstrap still admits its first song metadata', async () => {
  const f = fixture();
  try {
    f.mountDom();
    await f.state.renderer.start(f.context);
    const api = Object.assign(f.api(), {
      getVideoData: () => ({}),
      getPlayerResponse: () => ({}),
    });
    await f.state.renderer.onPlayerApiReady(api);
    const fresh = info('A');
    f.state.setSong(fresh);
    for (const listener of f.listeners) listener(fresh);
    await settle();
    f.state.pending
      .findLast((p: any) => p.provider === 'YTMusic')
      .resolve(result('A'));
    await settle();
    expect(f.state.currentLyrics().data?.lyrics).toBe('A');
  } finally {
    await f.close();
  }
});

for (const native of [{ videoId: 'B' }, null]) {
  test(`same-API ${native ? 'B' : 'unknown'} fence rejects stale IPC while old A normal/retry work is pending`, async () => {
    const f = fixture();
    try {
      f.mountDom();
      await f.state.renderer.start(f.context);
      const api = Object.assign(f.api(), {
        getVideoData: () => ({ video_id: 'A' }),
        getPlayerResponse: () => ({ videoDetails: { videoId: 'A' } }),
      });
      await f.state.renderer.onPlayerApiReady(api);
      const a = info('A');
      f.state.setSong(a);
      for (const listener of f.listeners) listener(a);
      await settle();
      f.state.retrySearch('YTMusic', a);
      await settle();
      const pending = [...f.state.pending];
      api.emit('dataloaded', native);
      await settle();
      await f.state.renderer.onPlayerApiReady(api);
      for (const listener of f.listeners) listener(a);
      await settle();
      expect(f.state.pending).toHaveLength(pending.length);
      for (const request of pending) request.resolve(result('obsolete-A'));
      await settle();
      expect(f.state.currentLyrics().data).toBeNull();
    } finally {
      await f.close();
    }
  });
}

for (const completed of [false, true]) {
  test(`a verified first API B retires ${completed ? 'completed' : 'pending'} IPC A received before API readiness`, async () => {
    const f = fixture();
    try {
      f.mountDom();
      await f.state.renderer.start(f.context);
      const a = info('A');
      f.state.setSong(a);
      for (const listener of f.listeners) listener(a);
      await settle();
      const pending = [...f.state.pending];
      if (completed) {
        for (const request of pending) request.resolve(result('A'));
        await settle();
      }
      const api = Object.assign(f.api(), {
        getVideoData: () => ({ video_id: 'B' }),
        getPlayerResponse: () => ({ videoDetails: { videoId: 'B' } }),
      });
      await f.state.renderer.onPlayerApiReady(api);
      if (!completed) {
        for (const request of pending) request.resolve(result('old-A'));
        await settle();
      }
      expect(f.state.currentLyrics().data).toBeNull();
    } finally {
      await f.close();
    }
  });
}

test('a verified agreeing first API preserves already received bootstrap lyrics', async () => {
  const f = fixture();
  try {
    f.mountDom();
    await f.state.renderer.start(f.context);
    const a = info('A');
    f.state.setSong(a);
    for (const listener of f.listeners) listener(a);
    await settle();
    for (const pending of f.state.pending) pending.resolve(result('A'));
    await settle();
    const api = Object.assign(f.api(), {
      getVideoData: () => ({ video_id: 'A' }),
      getPlayerResponse: () => ({ videoDetails: { videoId: 'A' } }),
    });
    await f.state.renderer.onPlayerApiReady(api);
    expect(f.state.currentLyrics().data?.lyrics).toBe('A');
  } finally {
    await f.close();
  }
});

for (const lifecycle of ['remount', 'stop/re-enable']) {
  test(`a retained old API handler cannot mutate the current registration after ${lifecycle}`, async () => {
    const f = fixture();
    try {
      f.mountDom();
      await f.state.renderer.start(f.context);
      const api = f.api();
      await f.state.renderer.onPlayerApiReady(api);
      const oldHandler = f.state.renderer.apiHandler;
      if (lifecycle === 'stop/re-enable') {
        f.state.renderer.stop();
        await f.state.renderer.start(f.context);
      }
      await f.state.renderer.onPlayerApiReady(api);
      api.emit('dataloaded', { videoId: 'B' });
      await settle();
      const b = info('B');
      f.state.setSong(b);
      for (const listener of f.listeners) listener(b);
      await settle();
      for (const request of f.state.pending) request.resolve(result('B'));
      await settle();
      expect(f.state.currentLyrics().data?.lyrics).toBe('B');
      const currentHandler = f.state.renderer.apiHandler;
      expect(currentHandler).not.toBe(oldHandler);
      oldHandler('dataloaded', { videoId: 'A' });
      await settle();
      expect(f.state.renderer.nativeVideoId).toBe('B');
      expect(f.state.currentLyrics().data?.lyrics).toBe('B');
      currentHandler('dataloaded', { videoId: 'C' });
      await settle();
      expect(f.state.renderer.nativeVideoId).toBe('C');
      expect(f.state.currentLyrics().data).toBeNull();
      const c = info('C');
      f.state.setSong(c);
      for (const listener of f.listeners) listener(c);
      await settle();
      f.state.pending
        .findLast((p: any) => p.provider === 'YTMusic')
        .resolve(result('C'));
      await settle();
      expect(f.state.currentLyrics().data?.lyrics).toBe('C');
    } finally {
      await f.close();
    }
  });
}

test('export bridge rejects wrong native identity and retires captured calls on stop', async () => {
  const f = fixture();
  try {
    const calls: any[] = [];
    (f.context.ipc as any).invoke = async (...args: any[]) => {
      calls.push(args);
      return 'saved';
    };
    await f.state.renderer.start(f.context);
    const api = f.api();
    f.mountDom();
    let id = 'A';
    (api as any).getVideoData = () => ({ video_id: id });
    (api as any).getPlayerResponse = () => ({ videoDetails: { videoId: id } });
    await f.state.renderer.onPlayerApiReady(api);
    await f.track('A');
    f.state.setLyricsStore('lyrics', 'YTMusic', {
      state: 'done',
      data: result('Hello'),
      error: null,
    });
    const retained = f.state.exporter();
    expect(await retained()).toBe('saved');
    expect(calls[0][0]).toBe('synced-lyrics:export');
    expect(calls[0][1].videoId).toBe('A');
    id = 'B';
    expect(await retained()).toBe('cancelled');
    expect(calls).toHaveLength(1);
    f.state.renderer.stop();
    expect(await retained()).toBe('cancelled');
    expect(await f.state.exporter()()).toBe('cancelled');
    expect(calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('current provider export works through the actual keyboard-accessible picker button', async ({
  page,
}) => {
  await page.setContent(
    '<style>html{font-size:16px;background:#151515;color:#fff}#tab-renderer{width:600px;height:420px}</style><div id="tabsContent"><div class="tab-header"></div><div class="tab-header" aria-selected="true"></div></div><div id="tab-renderer" page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"></div>',
  );
  await page.addStyleTag({
    content: await (await import('node:fs/promises')).readFile(
      path.join(directory, '../style.css'),
      'utf8',
    ),
  });
  await page.evaluate(() => {
    Object.assign(window, {
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
    });
    (window as any).exportCalls = [];
  });
  await page.addScriptTag({ content: code });
  await page.evaluate(async () => {
    const f = (window as any).lyricsFixture;
    f.setSong({
      videoId: 'A',
      title: 'Song',
      artist: 'Artist',
      songDuration: 10,
      tags: [],
    });
    await f.renderer.start({
      getConfig: async () => ({
        enabled: true,
        lineEffect: 'fancy',
        romanization: false,
        defaultTextString: '',
        showTimeCodes: false,
      }),
      ipc: {
        subscribe: () => () => {},
        invoke: async (...args: any[]) => {
          (window as any).exportCalls.push(args);
          return 'saved';
        },
      },
    });
    const events = new EventTarget();
    await f.renderer.onPlayerApiReady({
      getCurrentTime: () => 2,
      getVideoData: () => ({ video_id: 'A' }),
      getPlayerResponse: () => ({ videoDetails: { videoId: 'A' } }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    f.setLyricsStore('lyrics', 'YTMusic', {
      state: 'done',
      data: { title: 'Song', artists: ['Artist'], lyrics: 'Hello' },
      error: null,
    });
  });
  const button = page.locator('.lyrics-export');
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.lyrics-export-status')).toHaveText(
    'Lyrics saved',
  );
  expect(await page.evaluate(() => (window as any).exportCalls)).toHaveLength(
    1,
  );
  expect(
    await button.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe('none');
  if (process.env.PEAR_LYRICS_TOOLS_EVIDENCE_DIR)
    await page.locator('#tab-renderer').screenshot({
      path: path.join(
        process.env.PEAR_LYRICS_TOOLS_EVIDENCE_DIR,
        'lyrics-export-picker.png',
      ),
    });
  await page.evaluate(() => (window as any).lyricsFixture.renderer.stop());
});
