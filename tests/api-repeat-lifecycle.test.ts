import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { test, expect } from '@playwright/test';
import { PropertySymbol, Window } from 'happy-dom';
import { headlessApiMenuBoundary } from './helpers/api-headless-menu-boundary';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));

async function fixture({
  ready = true,
  bar = true,
  upgraded = true,
  control = true,
  otherOwner = false,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-repeat-test-'));
  const dom = new Window({ url: 'https://fixture.invalid/' });
  const renderer = new EventEmitter();
  let source: any;
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(
    [
      'window',
      'document',
      'CustomEvent',
      'HTMLVideoElement',
      'MutationObserver',
    ].map((key) => [key, globals[key]]),
  );
  (dom as unknown as Record<string, unknown>).ipcRenderer = {
    on: (event: string, listener: (...args: unknown[]) => void) =>
      renderer.on(event, listener),
    emit: (event: string, ...args: unknown[]) => renderer.emit(event, ...args),
    send: (event: string, ...args: unknown[]) => {
      source.state.received.push([event, ...args]);
      source.ipcMain.emit(event, {}, ...args);
    },
  };
  globals.window = dom;
  globals.document = dom.document;
  globals.CustomEvent = dom.CustomEvent;
  globals.HTMLVideoElement = dom.HTMLVideoElement;
  const observerCallbacks: unknown[] = [];
  globals.MutationObserver = class extends dom.MutationObserver {
    observe(
      ...args: Parameters<InstanceType<typeof dom.MutationObserver>['observe']>
    ) {
      super.observe(...args);
      // happy-dom keeps its delivery callback only in a WeakRef. Retain the
      // real callback so GC cannot silently stop delivery between fixtures.
      for (const listener of args[0][PropertySymbol.mutationListeners]) {
        const callback = listener.callback.deref();
        if (callback) observerCallbacks.push(callback);
      }
    }
  };
  const modes = { mode: 'ALL' };
  const makeBar = (withControl = true) => {
    const node = dom.document.createElement('ytmusic-player-bar');
    if (withControl)
      node.innerHTML =
        '<div id="right-controls"><button class="repeat" title="Repeat all"></button></div>';
    return node;
  };
  const initial = makeBar(control);
  const upgrade = (node: any, state = modes) => {
    node.getState = () => ({ queue: { repeatMode: state.mode } });
    const button = node.querySelector('.repeat');
    if (button) button.__dataHost = node;
  };
  if (upgraded) upgrade(initial);
  if (bar) dom.document.body.append(initial);
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/main.ts'))};export {setupRepeatChangedListener} from ${JSON.stringify(path.join(root, 'src/providers/song-info-front.ts'))};export {ipcMain,window as nativeWindow,state} from 'electron';`,
  );
  const native = `import {EventEmitter} from 'node:events';export const ipcMain=new EventEmitter();export const app=new EventEmitter();export const state={sent:[],received:[]};export const window={webContents:{send:(event,...args)=>{state.sent.push([event,...args]);globalThis.window.ipcRenderer.emit(event,{},...args);},executeJavaScript:async()=>undefined}};export const dialog={};export const nativeImage={};export const net={fetch:()=>{throw new Error('Remote fixture network prohibited');}};`;
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const build = await rolldown({
    input: entry,
    platform: 'node',
    plugins: [
      headlessApiMenuBoundary(root),
      {
        name: 'controlled-native-config-translation-boundaries',
        async resolveId(id: string) {
          if (id === 'electron') return '\0native';
          if (id === '@/config') return '\0config';
          if (id === '@/i18n') return '\0i18n';
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            for (const suffix of ['.ts', '/index.ts', '.tsx']) {
              try {
                await access(target + suffix);
                return target + suffix;
              } catch {
                /* next source suffix */
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
                : requireRoot.resolve(id).replaceAll('\\', '/'),
              external: true,
            };
        },
        load(id: string) {
          if (id === '\0native') return native;
          if (id === '\0config')
            return 'export const get=()=>false;export const set=()=>{};';
          if (id === '\0i18n')
            return "export const APPLICATION_NAME='Fixture';export const t=(key)=>key;";
        },
      },
    ],
  });
  const output = path.join(directory, 'actual-source.cjs');
  await build.write({ file: output, format: 'cjs', codeSplitting: false });
  await build.close();
  source = requireRoot(output);
  let installed = false;
  const markReady = () => {
    if (!installed) {
      renderer.on('peard:setup-repeat-changed-listener', () =>
        source.setupRepeatChangedListener(),
      );
      installed = true;
    }
    source.ipcMain.emit('peard:player-api-loaded', {});
  };
  if (ready) markReady();
  if (otherOwner) source.setupRepeatChangedListener();
  const config = {
    enabled: true,
    hostname: '127.0.0.1',
    port: 0,
    authStrategy: 'NONE',
    secret: 'public-fixture',
    authorizedClients: [],
    useHttps: false,
    certPath: '',
    keyPath: '',
  };
  const repeatReceivers: ((...args: unknown[]) => void)[] = [];
  const ctx = {
    getConfig: async () => config,
    setConfig: async () => {},
    window: source.nativeWindow,
    ipc: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'peard:repeat-changed') repeatReceivers.push(listener);
        return source.ipcMain.on(event, (_: unknown, ...args: unknown[]) =>
          listener(...args),
        );
      },
      send: (...args: unknown[]) =>
        source.nativeWindow.webContents.send(...args),
    },
  };
  const stop = async () => {
    const server = source.backend.server;
    const closed = server ? once(server, 'close') : undefined;
    source.backend.stop();
    if (closed) await closed;
  };
  const listening = async () => {
    if (source.backend.server && !source.backend.server.listening)
      await once(source.backend.server, 'listening');
  };
  const start = async () => {
    await source.backend.start(ctx);
    await listening();
  };
  return {
    source,
    dom,
    modes,
    initial,
    upgrade,
    makeBar,
    ctx,
    config,
    repeatReceivers,
    start,
    stop,
    listening,
    markReady,
    setup: () =>
      source.nativeWindow.webContents.send(
        'peard:setup-repeat-changed-listener',
      ),
    reports: () =>
      source.state.received.filter(
        (x: unknown[]) => x[0] === 'peard:repeat-changed',
      ).length,
    flush: () => dom.happyDOM.whenAsyncComplete(),
    get: async () => {
      const response = await fetch(
        `http://127.0.0.1:${source.backend.server.address().port}/api/v1/repeat-mode`,
      );
      expect(response.status).toBe(200);
      return response.json();
    },
    close: async () => {
      await stop();
      delete requireRoot.cache[output];
      await dom.happyDOM.close();
      observerCallbacks.length = 0;
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of saved) globals[key] = value;
    },
  };
}

test('late API enable receives existing ALL snapshot before another UI mutation', async () => {
  const f = await fixture();
  try {
    await f.start();
    expect(await f.get()).toEqual({ mode: 'ALL' });
    expect(
      f.source.state.sent
        .filter((x: unknown[]) => x[0]?.toString().startsWith('peard:setup-'))
        .map((x: unknown[]) => x[0]),
    ).toEqual([
      'peard:setup-repeat-changed-listener',
      'peard:setup-volume-changed-listener',
    ]);
  } finally {
    await f.close();
  }
});

test('early API start retains readiness fallback for repeat snapshot', async () => {
  const f = await fixture({ ready: false });
  try {
    await f.start();
    f.markReady();
    expect(await f.get()).toEqual({ mode: 'ALL' });
  } finally {
    await f.close();
  }
});

test('another owner does not consume the API snapshot and each setup refreshes current mode', async () => {
  const f = await fixture({ otherOwner: true });
  try {
    await f.start();
    expect(await f.get()).toEqual({ mode: 'ALL' });
    f.modes.mode = 'ONE';
    const before = f.reports();
    f.setup();
    expect(f.reports() - before).toBe(1);
    expect(await f.get()).toEqual({ mode: 'ONE' });
  } finally {
    await f.close();
  }
});

test('repeated setup and a title batch yield one current observer update through ALL ONE NONE', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.markReady();
    f.setup();
    f.setup();
    const button = f.initial.querySelector('.repeat')!;
    for (const mode of ['ONE', 'NONE', 'ALL']) {
      const before = f.reports();
      f.modes.mode = mode;
      button.setAttribute('title', mode + ' first');
      button.setAttribute('title', mode + ' final');
      await f.flush();
      expect(f.reports() - before).toBe(1);
      expect(await f.get()).toEqual({ mode });
    }
  } finally {
    await f.close();
  }
});

test('setup before DOM and an unupgraded bar stay unknown until current state is available', async () => {
  const f = await fixture({ bar: false });
  try {
    await f.start();
    expect(await f.get()).toEqual({ mode: null });
    const node = f.makeBar();
    f.dom.document.body.append(node);
    f.setup();
    expect(await f.get()).toEqual({ mode: null });
    (node as any).getState = () => ({});
    f.setup();
    expect(await f.get()).toEqual({ mode: null });
    f.upgrade(node);
    const button = node.querySelector('.repeat')!;
    f.modes.mode = 'ONE';
    button.setAttribute('title', 'Repeat one');
    await f.flush();
    expect(await f.get()).toEqual({ mode: 'ONE' });
    f.modes.mode = 'ALL';
    f.setup();
    expect(await f.get()).toEqual({ mode: 'ALL' });
  } finally {
    await f.close();
  }
});

test('current primary bar owns repeat events while secondary detached and unrelated titles are ignored', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.markReady();
    const old = f.initial;
    const current = f.makeBar();
    const currentMode = { mode: 'ONE' };
    f.upgrade(current, currentMode);
    old.remove();
    f.dom.document.body.prepend(current);
    f.setup();
    expect(await f.get()).toEqual({ mode: 'ONE' });
    f.dom.document.body.append(old);
    const div = f.dom.document.createElement('div');
    f.dom.document.body.append(div);
    const detached = f.makeBar();
    f.upgrade(detached);
    const before = f.reports();
    f.modes.mode = 'NONE';
    old.querySelector('.repeat')!.setAttribute('title', 'Old changed');
    detached
      .querySelector('.repeat')!
      .setAttribute('title', 'Detached changed');
    div.setAttribute('title', 'Unrelated churn');
    await f.flush();
    expect(f.reports() - before).toBe(0);
    expect(await f.get()).toEqual({ mode: 'ONE' });
    currentMode.mode = 'ALL';
    current.querySelector('.repeat')!.setAttribute('title', 'Primary changed');
    await f.flush();
    expect(f.reports() - before).toBe(1);
    expect(await f.get()).toEqual({ mode: 'ALL' });
    current.querySelector('#right-controls')!.remove();
    old
      .querySelector('.repeat')!
      .setAttribute('title', 'Only secondary control');
    const count = f.reports();
    await f.flush();
    expect(f.reports()).toBe(count);
    f.setup();
    expect(await f.get()).toEqual({ mode: 'ALL' });
  } finally {
    await f.close();
  }
});

test('new API context resets unknown and rejects retained old responses and readiness requests', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.markReady();
    const old = f.repeatReceivers.at(-1)!;
    await f.stop();
    const stopped = f.source.backend.currentRepeatMode;
    old('NONE');
    expect(f.source.backend.currentRepeatMode).toBe(stopped);
    f.initial.remove();
    await f.start();
    expect(await f.get()).toEqual({ mode: null });
    old('ALL');
    expect(await f.get()).toEqual({ mode: null });
    const before = f.source.state.sent.filter(
      (x: unknown[]) => x[0] === 'peard:setup-repeat-changed-listener',
    ).length;
    f.markReady();
    const after = f.source.state.sent.filter(
      (x: unknown[]) => x[0] === 'peard:setup-repeat-changed-listener',
    ).length;
    expect(after - before).toBe(1);
  } finally {
    await f.close();
  }
});

test('canceled configuration startup cannot reset a newer repeat context or install callbacks', async () => {
  const f = await fixture();
  try {
    let release: ((value: typeof f.config) => void) | undefined;
    const delayed = new Promise<typeof f.config>(
      (resolve) => (release = resolve),
    );
    const stale = f.source.backend.start({
      ...f.ctx,
      getConfig: () => delayed,
    });
    f.source.backend.stop();
    await f.start();
    const count = f.repeatReceivers.length;
    release!(f.config);
    await stale;
    expect(f.repeatReceivers.length).toBe(count);
    expect(await f.get()).toEqual({ mode: 'ALL' });
  } finally {
    await f.close();
  }
});
