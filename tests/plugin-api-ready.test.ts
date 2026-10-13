import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { playlistProviderSource } from './helpers/playlist-provider-source';

// Run the actual renderer entry's startup and IPC hooks. Only native, style,
// translation and plugin-registry boundaries are replaced; no copied hook logic.
async function fixture(plugins: Record<string, any>) {
  const dom = new Window();
  dom.document.body.innerHTML = '<div id="movie_player"></div><video></video>';
  const handlers = new Map<string, (...args: any[]) => any>();
  const errors: unknown[][] = [];
  const traces: unknown[] = [];
  const contexts = new Map<string, object>();
  const key = `ready_${crypto.randomUUID()}`;
  const state = {
    dom,
    plugins,
    handlers,
    errors,
    traces,
    contexts,
    window: {
      addEventListener: dom.addEventListener.bind(dom),
      removeEventListener: dom.removeEventListener.bind(dom),
      setTimeout: dom.setTimeout.bind(dom),
      clearTimeout: dom.clearTimeout.bind(dom),
      electronIs: {
        osx: () => false,
        windows: () => false,
        linux: () => true,
        dev: () => false,
      },
      mainConfig: { get: () => undefined },
      ipcRenderer: {
        subscribe: (id: string, fn: (...args: unknown[]) => void) => {
          const handler = (_: unknown, ...args: unknown[]) => fn(...args);
          handlers.set(id, handler);
          return () => {
            if (handlers.get(id) === handler) handlers.delete(id);
          };
        },
        on: (id: string, fn: (...args: any[]) => any) => handlers.set(id, fn),
        removeListener: (id: string, fn: (...args: any[]) => any) => {
          if (handlers.get(id) === fn) handlers.delete(id);
        },
        send() {},
      },
    },
  };
  const graphSource = stripTypeScriptTypes(
    await readFile(
      new URL('../src/providers/renderer-audio.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const graph = await import(
    `data:text/javascript;base64,${Buffer.from(graphSource).toString('base64')}`
  );
  (state as any).initializeAudioGraph = graph.initializeAudioGraph;
  (globalThis as any)[key] = state;
  const raw = await readFile(
    new URL('../src/renderer.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(
      /initObserver\(\)\s*\.then\(preload\)[\s\S]*?;\s*$/,
      'export { main };',
    );
  const repeatProvider = stripTypeScriptTypes(
    await readFile(
      new URL('../src/providers/repeat-preference.ts', import.meta.url),
      'utf8',
    ),
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export /gm, '');
  const shareProvider = (await readFile(new URL('../src/utils/share-url.ts', import.meta.url), 'utf8')) + '\n' + (await readFile(new URL('../src/providers/share-links.ts', import.meta.url), 'utf8')).replace(/^import[^;]+;\n/gm, '');
  const shareSource = stripTypeScriptTypes(shareProvider).replace(/^export /gm, '');
  const boundaries = `
const fixture=globalThis[${JSON.stringify(key)}];
const {window}=fixture; const document=fixture.dom.document;
const {Element,CustomEvent}=fixture.dom;
const initializeAudioGraph=fixture.initializeAudioGraph;
const setTheme=()=>{}; const registerWindowDefaultTrustedTypePolicy=()=>{};
const retireLanguageRequests=()=>{};const i18t=(key,options)=>({key,options}); const LoggerPrefix='[YTMusic]';
const console={error:(...args)=>fixture.errors.push(args),trace:err=>fixture.traces.push(err)};
const startingPages={}; const setInterval=()=>0;
const createContext=id=>{if(!fixture.contexts.has(id))fixture.contexts.set(id,{id});return fixture.contexts.get(id)};
const getAllLoadedRendererPlugins=()=>fixture.plugins;
const getLoadedRendererPlugin=id=>fixture.plugins[id];
const loadAllRendererPlugins=async()=>{}; const forceLoadRendererPlugin=async()=>{};
const forceUnloadRendererPlugin=async()=>{};
class AudioContext {destination={};addEventListener(){}removeEventListener(){}createGain(){return {gain:{value:1},connect(){},disconnect(){}}}createMediaElementSource(){return {connect(){},disconnect(){}}}}
`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundaries + shareSource + repeatProvider + (await playlistProviderSource()) + actual).toString('base64')}`
  );
  return {
    ...state,
    source,
    player: dom.document.querySelector('#movie_player'),
    close: async () => {
      dom.dispatchEvent(new dom.Event('pagehide'));
      delete (globalThis as any)[key];
      await dom.happyDOM.close();
    },
  };
}

for (const asynchronous of [false, true]) {
  test(`startup continues after a ${asynchronous ? 'rejected' : 'throwing'} plugin and preserves hook arguments`, async () => {
    const failure = new Error('fixture failure');
    const calls: unknown[] = [];
    const broken = {
      onPlayerApiReady() {
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      },
    };
    const healthy = {
      onPlayerApiReady(this: unknown, api: unknown, context: unknown) {
        calls.push([this, api, context]);
      },
    };
    let functionCalls = 0;
    const fn = Object.assign(() => functionCalls++, {
      onPlayerApiReady: () => functionCalls++,
    });
    const f = await fixture({
      broken: { renderer: broken },
      healthy: { renderer: healthy },
      final: { renderer: healthy },
      function: { renderer: fn },
    });
    try {
      await expect(f.source.main()).resolves.toBeUndefined();
      expect(calls).toEqual([
        [healthy, f.player, f.contexts.get('healthy')],
        [healthy, f.player, f.contexts.get('final')],
      ]);
      expect(functionCalls).toBe(0);
      expect(f.errors).toHaveLength(1);
      expect(f.traces).toEqual([failure]);
      expect(f.errors[0][1]).toEqual({
        key: 'common.console.plugins.execute-failed',
        options: { pluginName: 'broken', contextName: 'onPlayerApiReady' },
      });
    } finally {
      await f.close();
    }
  });
  test(`late enable isolates a ${asynchronous ? 'rejected' : 'throwing'} API-ready hook`, async () => {
    const calls: unknown[] = [];
    const failure = new Error('late failure');
    const f = await fixture({});
    const healthy = {
      onPlayerApiReady(this: unknown, api: unknown, context: unknown) {
        calls.push([this, api, context]);
      },
    };
    try {
      await f.source.main();
      f.plugins.broken = {
        renderer: {
          onPlayerApiReady() {
            if (asynchronous) return Promise.reject(failure);
            throw failure;
          },
        },
      };
      f.plugins.healthy = { renderer: healthy };
      const enable = f.handlers.get('plugin:enable')!;
      await expect(enable({}, 'broken')).resolves.toBeUndefined();
      await enable({}, 'healthy');
      expect(calls).toEqual([[healthy, f.player, f.contexts.get('healthy')]]);
      expect(f.errors).toHaveLength(1);
      expect(f.traces).toEqual([failure]);
    } finally {
      await f.close();
    }
  });
}

test('actual renderer share option changes Copy input and retires IPC updates on pagehide', async () => {
  const f = await fixture({});
  const music = 'https://music.youtube.com/watch?v=OtherVideo1';
  try {
    f.dom.document.body.insertAdjacentHTML('beforeend', '<yt-copy-link-renderer><input id="share-url"></yt-copy-link-renderer>');
    const input = f.dom.document.querySelector<HTMLInputElement>('#share-url')!;
    input.value = music;
    await f.source.main();
    const update = f.handlers.get('peard:strip-music-from-shared-links')!;
    expect(input.value).toBe(music);
    update({}, true);
    expect(input.value).toBe(music.replace('music.', ''));
    f.dom.dispatchEvent(new f.dom.Event('pagehide'));
    expect(input.value).toBe(music);
    expect(f.handlers.has('peard:strip-music-from-shared-links')).toBe(false);
    update({}, true);
    expect(input.value).toBe(music);
    expect(f.handlers.has('plugin:enable')).toBe(true);
  } finally {
    await f.close();
  }
});
