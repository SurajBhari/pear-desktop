import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { test, expect } from '@playwright/test';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
let scratch: string;
let backend: any;
let native: any;
let rendererCode: string;
test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(root, '.tmp-status-test-'));
  const entry = path.join(scratch, 'backend.ts');
  await writeFile(
    entry,
    `export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/statusbar-lyrics/backend.ts'))};export {state} from 'electron';`,
  );
  const aliases = [
    { find: /^@\/utils$/, replacement: '\0utils' },
    { find: /^electron$/, replacement: '\0electron' },
    { find: /^electron-is$/, replacement: '\0is' },
    { find: '@', replacement: path.join(root, 'src') },
  ];
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    ssr: { noExternal: true },
    resolve: { alias: aliases },
    plugins: [
      {
        name: 'native-title-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('\0')) return id;
        },
        load(id) {
          if (id === '\0utils') return 'export const createBackend=x=>x;';
          if (id === '\0is')
            return 'import{state}from"electron";export default {macOS:()=>state.mac};';
          if (id === '\0electron')
            return 'export const state={mac:true,trays:[]};export const nativeImage={createEmpty:()=>({})};export class Tray{constructor(){this.title="";this.destroyed=false;state.trays.push(this)}setTitle(text){if(this.destroyed)throw Error("Destroyed tray");this.title=text}isDestroyed(){return this.destroyed}destroy(){this.destroyed=true}}';
        },
      },
    ],
    build: {
      ssr: true,
      outDir: scratch,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'native.mjs' } },
    },
  });
  ({ backend, state: native } = await import(
    pathToFileURL(path.join(scratch, 'native.mjs')).href
  ));
  const rendererEntry = path.join(scratch, 'renderer.ts');
  await writeFile(
    rendererEntry,
    `export {renderer} from ${JSON.stringify(path.join(root, 'src/plugins/statusbar-lyrics/renderer.ts'))};export * from 'status-state';`,
  );
  const fixture = `import{createSignal}from'solid-js';export const [config,setConfig]=createSignal(null),[currentTime,setCurrentTime]=createSignal(-1),[state,setState]=createSignal({state:'fetching',data:null});export const currentLyrics=()=>state();let info={videoId:'A',songDuration:120};export const getSongInfo=()=>info;export const setSong=value=>info=value;export let _ytAPI=null;export const setApi=value=>_ytAPI=value;export const pending=[];export const romanize=text=>new Promise(resolve=>pending.push({text,resolve}));export const convertChineseCharacter=text=>text;`;
  const browser = await build({
    root,
    configFile: false,
    logLevel: 'error',
    resolve: {
      conditions: ['browser'],
      alias: [
        { find: /^@\/utils$/, replacement: '\0utils' },
        { find: /^@\/i18n$/, replacement: '\0i18n' },
        {
          find: /^@\/providers\/song-info-front$/,
          replacement: '\0status-state',
        },
        {
          find: /^@\/plugins\/synced-lyrics\/renderer(?:\/renderer|\/store|\/utils)?$/,
          replacement: '\0status-state',
        },
        {
          find: /^solid-js$/,
          replacement: requireRoot.resolve('solid-js/dist/solid.js'),
        },
        { find: '@', replacement: path.join(root, 'src') },
      ],
    },
    plugins: [
      {
        name: 'actual-status-state-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'status-state') return '\0status-state';
          if (id.startsWith('\0')) return id;
        },
        load(id) {
          if (id === '\0status-state') return fixture;
          if (id === '\0utils') return 'export const createRenderer=x=>x;';
          if (id === '\0i18n') return 'export const t=x=>x;';
        },
      },
    ],
    build: {
      lib: { entry: rendererEntry, formats: ['iife'], name: 'StatusFixture' },
      write: false,
      minify: false,
    },
  });
  const output = Array.isArray(browser) ? browser[0] : browser;
  rendererCode = output.output.find((item: any) => item.type === 'chunk')!.code;
});
test.afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function nativeContext() {
  const window = new EventEmitter() as any;
  window.isDestroyed = () => false;
  window.webContents = { session: {}, isDestroyed: () => false };
  const handlers = new Map<string, (...args: any[]) => any>();
  const context = () => ({
    window,
    ipc: {
      handle: (name: string, fn: (...args: any[]) => any) =>
        handlers.set(name, fn),
      removeHandler: (name: string) => handlers.delete(name),
    },
    getConfig: () => ({
      enabled: true,
      maxLength: 55,
      includePronunciation: false,
    }),
  });
  return { window, handlers, context };
}

test('actual native title backend clears lazily and truncates complete emoji/combining graphemes', async () => {
  native.trays = [];
  const f = nativeContext();
  await backend.start(f.context());
  try {
    const token = f.handlers.get('statusbar-lyrics:session')!();
    expect(f.handlers.get('statusbar-lyrics:clear')!(token)).toBe(true);
    expect(native.trays).toHaveLength(0);
    expect(f.handlers.get('statusbar-lyrics:set-text')!(token, '😀ab', 2)).toBe(
      true,
    );
    expect(native.trays.at(-1).title).toBe('😀…');
    f.handlers.get('statusbar-lyrics:set-text')!(token, 'e\u0301abc', 2);
    expect(native.trays.at(-1).title).toBe('e\u0301…');
  } finally {
    backend.stop(f.context());
  }
  expect(native.trays.every((tray: any) => tray.destroyed)).toBe(true);
});

test('native window/session ownership rejects retained and queued old-token writes after fresh-context restart', async () => {
  native.trays = [];
  const f = nativeContext();
  await backend.start(f.context());
  const token = f.handlers.get('statusbar-lyrics:session')!();
  const retained = f.handlers.get('statusbar-lyrics:set-text')!;
  retained(token, 'old', 55);
  backend.stop(f.context());
  await backend.start(f.context());
  try {
    const fresh = f.handlers.get('statusbar-lyrics:session')!();
    expect(fresh).not.toBe(token);
    f.handlers.get('statusbar-lyrics:set-text')!(fresh, 'current', 55);
    retained(token, 'obsolete', 55);
    f.handlers.get('statusbar-lyrics:set-text')!(token, 'queued obsolete', 55);
    f.handlers.get('statusbar-lyrics:clear')!(token);
    expect(native.trays.at(-1).title).toBe('current');
    f.window.emit('closed');
    expect(native.trays.at(-1).destroyed).toBe(true);
    expect(f.handlers.size).toBe(0);
  } finally {
    backend.stop(f.context());
  }
});

test('non-macOS backend does not allocate a tray', async () => {
  native.mac = false;
  native.trays = [];
  const f = nativeContext();
  await backend.start(f.context());
  try {
    expect(f.handlers.get('statusbar-lyrics:session')?.()).toBeFalsy();
    expect(native.trays).toHaveLength(0);
  } finally {
    backend.stop(f.context());
    native.mac = true;
  }
});

test('a new renderer handshake renews the native lease without requiring a backend restart', async () => {
  native.trays = [];
  const f = nativeContext();
  await backend.start(f.context());
  try {
    const claim = f.handlers.get('statusbar-lyrics:session')!;
    const set = f.handlers.get('statusbar-lyrics:set-text')!;
    const clear = f.handlers.get('statusbar-lyrics:clear')!;
    const old = claim();
    set(old, 'Previous renderer', 55);
    const current = claim();
    expect(current).not.toBe(old);
    set(current, 'Current renderer', 55);
    expect(set(old, 'Queued previous renderer', 55)).toBe(false);
    expect(clear(old)).toBe(false);
    expect(native.trays.at(-1).title).toBe('Current renderer');
  } finally {
    backend.stop(f.context());
  }
});

async function rendererFixture(
  page: import('@playwright/test').Page,
  pronunciation = false,
) {
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: rendererCode });
  await page.evaluate(async (pronunciation) => {
    const f = (window as any).StatusFixture;
    const api = new EventTarget() as any;
    api.id = 'A';
    api.getVideoData = () => ({ video_id: api.id });
    api.getPlayerResponse = () => ({ videoDetails: { videoId: api.id } });
    (window as any).statusApi = api;
    (window as any).messages = [];
    (window as any).title = '';
    (window as any).statusEpoch = 0;
    const cfg = {
      enabled: true,
      maxLength: 55,
      includePronunciation: pronunciation,
    };
    const context = () => ({
      getConfig: async () => cfg,
      ipc: {
        invoke: async (name: string, ...args: any[]) => {
          (window as any).messages.push({ name, args });
          if (name === 'statusbar-lyrics:session')
            return `session-${++(window as any).statusEpoch}`;
          if (args[0] !== `session-${(window as any).statusEpoch}`)
            return false;
          if (name === 'statusbar-lyrics:clear') (window as any).title = '';
          if (name === 'statusbar-lyrics:set-text')
            (window as any).title = args[1];
          return true;
        },
      },
    });
    (window as any).statusContext = context;
    f.setApi(api);
    f.setConfig({ enabled: true, timingOffsetMs: 0 });
    f.setState({
      state: 'done',
      data: {
        lines: [
          {
            time: '00:01',
            timeInMs: 1000,
            duration: 1000,
            text: 'First',
            status: 'upcoming',
            words: [],
          },
          {
            time: '00:05',
            timeInMs: 5000,
            duration: 1000,
            text: 'Second',
            status: 'upcoming',
            words: [],
          },
        ],
      },
    });
    f.setCurrentTime(1000);
    await f.renderer.start(context());
    f.renderer.onPlayerApiReady(api, context());
  }, pronunciation);
}

test('actual renderer follows media time while DOM is absent, clears explicit gaps/store invalidation and fences native identity', async ({
  page,
}) => {
  await rendererFixture(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('First');
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => (window as any).title)).toBe('First');
  await page.evaluate(() => (window as any).StatusFixture.setCurrentTime(2000));
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
  await page.evaluate(() => (window as any).StatusFixture.setCurrentTime(5000));
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('Second');
  await page.evaluate(() =>
    (window as any).StatusFixture.setState({ state: 'fetching', data: null }),
  );
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
  await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    f.setState({
      state: 'done',
      data: {
        lines: [
          { timeInMs: 0, duration: 120000, text: 'Old metadata', words: [] },
        ],
      },
    });
    (window as any).statusApi.id = 'B';
    (window as any).statusApi.dispatchEvent(
      new CustomEvent('videodatachange', {
        detail: ['dataupdated', { videoId: 'B' }],
      }),
    );
    f.setCurrentTime(5001);
  });
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
  await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    f.setSong({ videoId: 'B', songDuration: 120 });
    f.setState({
      state: 'done',
      data: {
        lines: [
          { timeInMs: 0, duration: 120000, text: 'Current B', words: [] },
        ],
      },
    });
    f.setCurrentTime(5002);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('Current B');
  await page.evaluate(() => (window as any).StatusFixture.setConfig(null));
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
});

test('status uses the approved positive-later timing offset and invalid-offset fallback', async ({
  page,
}) => {
  await rendererFixture(page);
  await page.evaluate(() =>
    (window as any).StatusFixture.setConfig({
      enabled: true,
      timingOffsetMs: 500,
    }),
  );
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
  await page.evaluate(() => (window as any).StatusFixture.setCurrentTime(1500));
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('First');
  await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    f.setCurrentTime(1000);
    f.setConfig({ enabled: true, timingOffsetMs: 40000 });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('First');
});

for (const next of ['clear', 'new text', 'same failed payload'])
  test(`a failed admitted status send drains ${next} without retrying the failed payload`, async ({
    page,
  }) => {
    await rendererFixture(page);
    await expect
      .poll(() => page.evaluate(() => (window as any).title))
      .toBe('First');
    await page.evaluate(async (next) => {
      const w = window as any;
      const f = w.StatusFixture;
      const original = w.statusContext().ipc.invoke;
      f.renderer.stop();
      await new Promise((resolve) => setTimeout(resolve, 0));
      w.deliveryAttempts = [];
      let reject: ((reason: Error) => void) | undefined;
      const context = {
        ...w.statusContext(),
        ipc: {
          invoke: async (name: string, ...args: unknown[]) => {
            w.deliveryAttempts.push({ name, text: args[1] });
            if (name === 'statusbar-lyrics:set-text' && args[1] === 'Second')
              return new Promise((_, fail) => {
                reject = fail;
              });
            return original(name, ...args);
          },
        },
      };
      await f.renderer.start(context);
      f.renderer.onPlayerApiReady(w.statusApi);
      await new Promise((resolve) => setTimeout(resolve, 0));
      f.setCurrentTime(5000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!reject) throw Error('Second line was not admitted');
      if (next === 'clear') f.setState({ state: 'fetching', data: null });
      if (next === 'new text')
        f.setState({
          state: 'done',
          data: {
            lines: [
              { timeInMs: 0, duration: 120000, text: 'Third', words: [] },
            ],
          },
        });
      reject(new Error('Owned transient IPC failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }, next);
    await expect
      .poll(() => page.evaluate(() => (window as any).title))
      .toBe(next === 'clear' ? '' : next === 'new text' ? 'Third' : 'First');
    expect(
      await page.evaluate(
        () =>
          (window as any).deliveryAttempts.filter(
            (item: any) => item.text === 'Second',
          ).length,
      ),
    ).toBe(1);
    await page.evaluate(() => (window as any).StatusFixture.renderer.stop());
  });

test('async pronunciation and stopped reactive roots cannot publish obsolete lines or clear a restarted title', async ({
  page,
}) => {
  await rendererFixture(page, true);
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('First');
  await page.evaluate(() => (window as any).StatusFixture.setCurrentTime(5000));
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('Second');
  await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    f.pending
      .find((item: any) => item.text === 'First')
      .resolve('Obsolete pronunciation');
    f.pending
      .find((item: any) => item.text === 'Second')
      .resolve('Current pronunciation');
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('Second · Current pronunciation');
  await page.evaluate(async () => {
    const f = (window as any).StatusFixture;
    f.renderer.stop((window as any).statusContext());
    await f.renderer.start((window as any).statusContext());
    f.renderer.onPlayerApiReady(
      (window as any).statusApi,
      (window as any).statusContext(),
    );
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('Second');
  await page.evaluate(() =>
    (window as any).StatusFixture.renderer.stop(
      (window as any).statusContext(),
    ),
  );
  const count = await page.evaluate(() => (window as any).messages.length);
  await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    f.setCurrentTime(1000);
    f.pending.at(-1)?.resolve('retired');
  });
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => (window as any).messages.length)).toBe(
    count,
  );
  expect(await page.evaluate(() => (window as any).title)).toBe('');
});

test('media ticks within one line do not restart its pending pronunciation', async ({
  page,
}) => {
  await rendererFixture(page, true);
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('First');
  const count = await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    for (let time = 1001; time <= 1010; time++) f.setCurrentTime(time);
    return f.pending.length;
  });
  expect(count).toBe(1);
});

test('stop during config or token waits cannot create a late reactive owner', async ({
  page,
}) => {
  await rendererFixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).StatusFixture;
    const base = (window as any).statusContext;
    f.renderer.stop(base());
    let resolveConfig!: (value: unknown) => void;
    const pendingConfig = f.renderer.start({
      ...base(),
      getConfig: () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    });
    f.renderer.onPlayerApiReady((window as any).statusApi, base());
    f.renderer.stop(base());
    const beforeConfig = (window as any).messages.length;
    resolveConfig({
      enabled: true,
      maxLength: 55,
      includePronunciation: false,
    });
    await pendingConfig;
    let resolveToken!: (value: unknown) => void;
    const context = base();
    const invoke = context.ipc.invoke;
    context.ipc.invoke = (name: string, ...args: unknown[]) =>
      name === 'statusbar-lyrics:session'
        ? new Promise((resolve) => {
            resolveToken = resolve;
          })
        : invoke(name, ...args);
    const pendingToken = f.renderer.start(context);
    while (!resolveToken) await Promise.resolve();
    f.renderer.stop(base());
    const beforeToken = (window as any).messages.length;
    resolveToken('retired-token');
    await pendingToken;
    f.setCurrentTime(5000);
    return {
      beforeConfig,
      beforeToken,
      after: (window as any).messages.length,
      title: (window as any).title,
    };
  });
  expect(result.beforeToken).toBe(result.beforeConfig);
  expect(result.after).toBe(result.beforeConfig);
  expect(result.title).toBe('');
});

test('a delayed old IPC request cannot overwrite a replacement renderer session title', async ({
  page,
}) => {
  await rendererFixture(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('First');
  await page.evaluate(async () => {
    const f = (window as any).StatusFixture;
    const base = (window as any).statusContext;
    f.renderer.stop(base());
    const context = base();
    const invoke = context.ipc.invoke;
    context.ipc.invoke = async (name: string, ...args: any[]) => {
      if (name === 'statusbar-lyrics:set-text' && args[1] === 'Delayed old') {
        await new Promise((resolve) => {
          (window as any).releaseOldStatus = resolve;
        });
      }
      return invoke(name, ...args);
    };
    f.setState({
      state: 'done',
      data: {
        lines: [
          { timeInMs: 0, duration: 120000, text: 'Delayed old', words: [] },
        ],
      },
    });
    await f.renderer.start(context);
    f.renderer.onPlayerApiReady((window as any).statusApi, context);
    while (!(window as any).releaseOldStatus) await Promise.resolve();
    f.renderer.stop(base());
    f.setState({
      state: 'done',
      data: {
        lines: [
          { timeInMs: 0, duration: 120000, text: 'New current', words: [] },
        ],
      },
    });
    await f.renderer.start(base());
    f.renderer.onPlayerApiReady((window as any).statusApi, base());
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('New current');
  await page.evaluate(() => (window as any).releaseOldStatus());
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => (window as any).title)).toBe('New current');
});

test('a cached LRC final cue retains its unknown-end window after the store JSON round trip and clears at native track end', async ({
  page,
}) => {
  await rendererFixture(page);
  await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    f.setState(
      JSON.parse(
        JSON.stringify({
          state: 'done',
          data: {
            lines: [
              {
                timeInMs: 0,
                duration: Infinity,
                text: 'Cached final cue',
                words: [],
              },
            ],
          },
        }),
      ),
    );
    f.setCurrentTime(10000);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('Cached final cue');
  await page.evaluate(() =>
    (window as any).StatusFixture.setCurrentTime(120000),
  );
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
});

test('unobserved bootstrap can become verified, while a same-API remount cannot undo observed native identity loss', async ({
  page,
}) => {
  await rendererFixture(page);
  await page.evaluate(async () => {
    const f = (window as any).StatusFixture;
    const api = (window as any).statusApi;
    const context = (window as any).statusContext;
    f.renderer.stop(context());
    api.id = '';
    await f.renderer.start(context());
    f.renderer.onPlayerApiReady(api, context());
  });
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
  await page.evaluate(() => {
    (window as any).statusApi.id = 'A';
    (window as any).StatusFixture.renderer.onPlayerApiReady(
      (window as any).statusApi,
      (window as any).statusContext(),
    );
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).title))
    .toBe('First');
  await page.evaluate(() => {
    const f = (window as any).StatusFixture;
    const api = (window as any).statusApi;
    api.dispatchEvent(
      new CustomEvent('videodatachange', { detail: ['dataupdated', {}] }),
    );
    f.renderer.onPlayerApiReady(api, (window as any).statusContext());
    f.setCurrentTime(1001);
  });
  await expect.poll(() => page.evaluate(() => (window as any).title)).toBe('');
});
