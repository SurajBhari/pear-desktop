import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import { expect, test } from '@playwright/test';
import { Window } from 'happy-dom';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const popupSelector =
  'ytmusic-miniplayer .ytMusicMiniPlayerVolumePopup input[type="range"]';
let compiled = '';
let coreVolume = '';
test.beforeAll(async ({}, info) => {
  const owned = info.outputPath('precise-volume-source');
  await mkdir(owned, { recursive: true });
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': path.join(root, 'src') } },
    build: {
      ssr: path.join(root, 'src/plugins/precise-volume/renderer.ts'),
      outDir: owned,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'renderer.cjs' },
      },
    },
  });
  compiled = await readFile(path.join(owned, 'renderer.cjs'), 'utf8');
  expect(compiled).not.toContain('custom-electron-prompt');
  expect(compiled).not.toMatch(/require\(["']electron["']\)/);
  // Reuse the existing volume-write source boundary without its HTTP server.
  const requireRoot = createRequire(path.join(root, 'package.json'));
  const requireVite = createRequire(requireRoot.resolve('vite'));
  const { parse } = requireVite('@babel/parser');
  const renderer = await readFile(path.join(root, 'src/renderer.ts'), 'utf8');
  const pending: any[] = [
    parse(renderer, { sourceType: 'module', plugins: ['typescript'] }),
  ];
  const registrations: any[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (
      node?.type === 'CallExpression' &&
      node.callee?.object?.object?.name === 'window' &&
      node.callee?.object?.property?.name === 'ipcRenderer' &&
      node.callee?.property?.name === 'on' &&
      node.arguments?.[0]?.value === 'peard:update-volume'
    )
      registrations.push(node);
    for (const value of Object.values(node ?? {})) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  expect(registrations).toHaveLength(1);
  const selected = registrations[0],
    entry = path.join(owned, 'core-volume.ts');
  await writeFile(
    entry,
    `export function register(api: unknown) {${renderer.slice(selected.start, selected.end)}}`,
  );
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: entry,
      outDir: owned,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'core-volume.cjs' },
      },
    },
  });
  coreVolume = await readFile(path.join(owned, 'core-volume.cjs'), 'utf8');
});

const defaults = {
  enabled: true,
  steps: 1,
  arrowsShortcut: true,
  globalShortcuts: { volumeUp: '', volumeDown: '' },
  savedVolume: 37,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture(kind: 'old' | 'new' | 'both' | 'none' = 'new', volume = 37) {
  const dom = new Window(),
    doc = dom.document;
  doc.body.innerHTML =
    '<div class="center-content ytmusic-nav-bar"></div><div id="main-panel"></div><ytmusic-player><div id="movie_player"><video></video></div></ytmusic-player><div id="song-video"></div>';
  (doc.querySelector('#main-panel') as any).computedStyleMap = () =>
    new Map([['display', { value: 'none' }]]);
  let now = 0,
    nextTimer = 0,
    reads = 0,
    queryCount = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const setTimer = (callback: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimer = (id: number) => {
    timers.delete(id);
  };
  const tick = (ms: number) => {
    const until = now + ms;
    for (let n = 0; n < 100; n++) {
      const next = [...timers]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = until;
  };
  const listeners = new Map<any, Map<string, Set<any>>>();
  function track(target: any) {
    if (listeners.has(target)) return;
    const registered = new Map<string, Set<any>>();
    listeners.set(target, registered);
    const add = target.addEventListener.bind(target),
      remove = target.removeEventListener.bind(target);
    target.addEventListener = (name: string, fn: any, options?: any) => {
      const key =
        name +
        ':' +
        Boolean(typeof options === 'boolean' ? options : options?.capture);
      if (!registered.has(key)) registered.set(key, new Set());
      registered.get(key)!.add(fn);
      add(name, fn, options);
    };
    target.removeEventListener = (name: string, fn: any, options?: any) => {
      const key =
        name +
        ':' +
        Boolean(typeof options === 'boolean' ? options : options?.capture);
      registered.get(key)?.delete(fn);
      remove(name, fn, options);
    };
  }
  track(doc);
  track(dom);
  track(doc.querySelector('#main-panel'));
  const observers: any[] = [];
  class OwnedObserver {
    callback: any;
    records: any[] = [];
    connected = false;
    disconnects = 0;
    constructor(callback: any) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
      this.disconnects++;
      this.records = [];
    }
  }
  function values(element: any, initial = '37') {
    let value = initial;
    Object.defineProperty(element, 'value', {
      configurable: true,
      get: () => value,
      set: (next: string) => {
        const oldValue = value;
        value = String(next);
        if (
          element.id === 'volume-slider' ||
          element.id === 'expand-volume-slider'
        )
          for (const observer of observers)
            if (observer.connected)
              observer.records.push({
                type: 'attributes',
                attributeName: 'value',
                target: element,
                oldValue,
              });
      },
    });
    return element;
  }
  const addOld = () => {
    const bar = doc.createElement('ytmusic-player-bar');
    bar.innerHTML =
      '<tp-yt-paper-slider id="volume-slider"></tp-yt-paper-slider><tp-yt-paper-slider id="expand-volume-slider"></tp-yt-paper-slider><tp-yt-paper-icon-button class="volume"></tp-yt-paper-icon-button><span id="expand-volume"></span>';
    doc.body.append(bar);
    track(bar);
    values(bar.querySelector('#volume-slider'));
    values(bar.querySelector('#expand-volume-slider'));
    return bar;
  };
  const addNew = () => {
    const host = doc.createElement('ytmusic-miniplayer');
    host.innerHTML =
      '<div class="ytMusicMiniPlayerVolumePopup"><input type="range" min="0" max="100" step="any"></div>';
    doc.body.append(host);
    track(host);
    values(host.querySelector('input'));
    return host;
  };
  if (kind === 'old' || kind === 'both') addOld();
  if (kind === 'new' || kind === 'both') addNew();
  const sets: number[] = [],
    saves: any[] = [],
    channels = new Map<string, Set<(...args: any[]) => void>>();
  let releases = 0,
    removeAll = 0,
    apiVolume = volume;
  const api = doc.querySelector('#movie_player') as any;
  const hooks: {
    onSet?: () => void;
    onRead?: () => void;
    onSave?: (value: any) => void;
  } = {};
  Object.assign(api, {
    getVolume: () => {
      reads++;
      hooks.onRead?.();
      return apiVolume;
    },
    setVolume: (value: number) => {
      sets.push(value);
      apiVolume = value;
      hooks.onSet?.();
    },
    getPlayerResponse: () => ({
      videoDetails: { musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' },
    }),
  });
  const on = (name: string, fn: (...args: any[]) => void) => {
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name)!.add(fn);
  };
  const subscribe = (name: string, fn: (...args: any[]) => void) => {
    on(name, fn);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        releases++;
        channels.get(name)?.delete(fn);
      }
    };
  };
  const config = { ...defaults };
  const context = {
    getConfig: () => config,
    setConfig: (value: any) => {
      saves.push({ ...value });
      hooks.onSave?.(value);
    },
    ipc: {
      on,
      subscribe,
      removeAllListeners: () => {
        removeAll++;
      },
    },
  };
  (dom as any).mainConfig = { plugins: { isEnabled: async () => false } };
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    window: dom,
    document: doc,
    MutationObserver: OwnedObserver,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    require() {
      throw Error('Runtime graph import prohibited');
    },
  });
  const source = module.exports;
  const query = doc.querySelector.bind(doc);
  doc.querySelector = ((...args: any[]) => {
    queryCount++;
    return query(...args);
  }) as any;
  const deps = {
    api,
    document: doc,
    window: dom,
    subscribe,
    setConfig: context.setConfig,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    createObserver: (callback: any) => new OwnedObserver(callback),
    videoToggleEnabled: async () => false,
    isCurrent: () => true,
  };
  const session = () => {
    expect(typeof source.createVolumeSession).toBe('function');
    return source.createVolumeSession(deps);
  };
  const emit = (name: string, value: any) => {
    for (const fn of [...(channels.get(name) ?? [])]) fn(value);
  };
  const change = (element: any, value: any) => {
    element.value = value;
    element.dispatchEvent(new dom.Event('change', { bubbles: true }));
  };
  const notify = (
    added: any[] = [],
    removed: any[] = [],
    target: any = doc.body,
  ) => {
    for (const observer of observers)
      if (observer.connected)
        observer.callback(
          [
            {
              type: 'childList',
              addedNodes: added,
              removedNodes: removed,
              target,
            },
          ],
          observer,
        );
  };
  const flush = () => {
    for (const observer of observers)
      if (observer.connected && observer.records.length)
        observer.callback(observer.records.splice(0), observer);
  };
  const listenerCount = () =>
    [...listeners.values()].reduce(
      (sum, map) => sum + [...map.values()].reduce((n, s) => n + s.size, 0),
      0,
    );
  return {
    dom,
    doc,
    api,
    source,
    context,
    deps,
    session,
    emit,
    change,
    notify,
    flush,
    tick,
    timers,
    observers,
    sets,
    saves,
    hooks,
    channels,
    addOld,
    addNew,
    values,
    listenerCount,
    reads: () => reads,
    queries: () => queryCount,
    releases: () => releases,
    removeAll: () => removeAll,
    external: (value: number) => {
      apiVolume = value;
    },
  };
}

test('native miniplayer popup commits persist despite stopped bubbling and never duplicate the native API write', async () => {
  const h = fixture();
  await h.source.onPlayerApiReady(h.api, h.context);
  const input = h.doc.querySelector(popupSelector)!;
  input.addEventListener('change', (event) => event.stopPropagation());
  h.change(input, '12.5');
  h.tick(1000);
  expect(h.sets).toEqual([]);
  expect(h.saves).toEqual([{ savedVolume: 12.5 }]);
});
test('default-disabled renderer setup performs no API, binding, observer, HUD or persistence actions', async () => {
  const h = fixture();
  h.context.getConfig = () => ({
    ...defaults,
    enabled: false,
    savedVolume: 18,
  });
  await h.source.onPlayerApiReady(h.api, h.context);
  h.tick(5000);
  expect(h.sets).toEqual([]);
  expect(h.reads()).toBe(0);
  expect(h.saves).toEqual([]);
  expect(h.listenerCount()).toBe(0);
  expect(h.observers).toHaveLength(0);
  expect(h.channels.size).toBe(0);
  expect(h.doc.querySelector('#volumeHud')).toBeNull();
});
test('API-equal saved volume projects precise legacy and miniplayer values without a setter or save', async () => {
  const h = fixture('both', 1);
  h.context.getConfig = () => ({ ...defaults, savedVolume: 1 });
  await h.source.onPlayerApiReady(h.api, h.context);
  expect((h.doc.querySelector('#volume-slider') as any).value).toBe('5');
  expect((h.doc.querySelector('#expand-volume-slider') as any).value).toBe('5');
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('1');
  expect(
    (h.doc.querySelector(popupSelector) as any).style.getPropertyValue(
      '--yt-slider-shape-gradient-percent',
    ),
  ).toBe('1%');
  h.flush();
  h.tick(1000);
  expect(h.sets).toEqual([]);
  expect(h.saves).toEqual([]);
});
test('reinitialization and stop dispose both IPC owners and all session resources', async () => {
  const h = fixture('both');
  await h.source.onPlayerApiReady(h.api, h.context);
  await h.source.onPlayerApiReady(h.api, h.context);
  expect([...h.channels.values()].map((s) => s.size)).toEqual([1, 1]);
  expect(typeof h.source.stop).toBe('function');
  h.source.stop();
  h.source.stop();
  expect([...h.channels.values()].every((s) => s.size === 0)).toBe(true);
  expect(h.releases()).toBe(4);
  expect(h.removeAll()).toBe(0);
  expect(h.listenerCount()).toBe(0);
  expect(h.observers.every((o) => !o.connected)).toBe(true);
  expect(h.timers.size).toBe(0);
  expect(h.doc.querySelector('#volumeHud')).toBeNull();
});
test('disabled owned session stays completely inert', async () => {
  const h = fixture();
  const s = h.session();
  const queries = h.queries();
  await s.start({ ...defaults, enabled: false });
  expect(h.queries()).toBe(queries);
  expect(h.listenerCount()).toBe(0);
  expect(h.channels.size).toBe(0);
  expect(h.observers).toHaveLength(0);
  expect(h.reads()).toBe(0);
});
test('old, new, both and absent hosts accept one owned startup and later popup discovery', async () => {
  for (const kind of ['old', 'new', 'both', 'none'] as const) {
    const h = fixture(kind, 12.5),
      s = h.session();
    await s.start({ ...defaults, savedVolume: 12.5 });
    expect(h.sets).toEqual([]);
    expect(h.observers).toHaveLength(1);
    const host = h.addNew();
    h.external(73.5);
    h.notify([host]);
    expect((host.querySelector('input') as any).value).toBe('73.5');
    h.tick(1000);
    expect(h.saves).toEqual([]);
    expect(h.sets).toEqual([]);
    s.stop();
  }
});
test('saved values clamp finitely while retaining 1-4 canonical precision and rounded legacy display only', async () => {
  for (const [given, expected] of [
    [0, 0],
    [1, 1],
    [4, 4],
    [12.5, 12.5],
    [100, 100],
    [-20, 0],
    [120, 100],
  ]) {
    const h = fixture('both', 37),
      s = h.session();
    await s.start({ ...defaults, savedVolume: given });
    expect(h.sets).toEqual([expected]);
    expect((h.doc.querySelector('#volume-slider') as any).value).toBe(
      expected > 0 && expected < 5 ? '5' : String(expected),
    );
    expect((h.doc.querySelector(popupSelector) as any).value).toBe(
      String(expected),
    );
    h.flush();
    h.tick(1000);
    expect(h.saves).toEqual(
      given < 0 || given > 100 ? [{ savedVolume: expected }] : [],
    );
    s.stop();
  }
});
test('invalid saved values do not restore, persist or project invalid input', async () => {
  for (const value of [NaN, Infinity, -Infinity, 'junk', ''] as any[]) {
    const h = fixture(),
      s = h.session();
    await s.start({ ...defaults, savedVolume: value });
    h.tick(1000);
    expect(h.sets).toEqual([]);
    expect(h.saves).toEqual([]);
    expect((h.doc.querySelector(popupSelector) as any).value).toBe('37');
    s.stop();
  }
});
test('native popup values validate before side effects and finite outliers clamp without an API setter', async () => {
  for (const [value, accepted] of [
    ['0', 0],
    ['1', 1],
    ['4', 4],
    ['12.5', 12.5],
    ['100', 100],
    ['-20', 0],
    ['120', 100],
    ['', null],
    [' ', null],
    ['junk', null],
    ['NaN', null],
    ['Infinity', null],
    ['-Infinity', null],
    ['0x10', null],
  ] as const) {
    const h = fixture(),
      s = h.session();
    await s.start(defaults);
    h.change(h.doc.querySelector(popupSelector), value);
    h.tick(1000);
    expect(h.sets).toEqual([]);
    expect(h.saves).toEqual(
      accepted === null || accepted === 37 ? [] : [{ savedVolume: accepted }],
    );
    s.stop();
  }
});
test('unrelated, disconnected and wrong-scope ranges cannot save or change playback', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  const outside = h.values(h.doc.createElement('input'));
  outside.type = 'range';
  h.doc.body.append(outside);
  h.change(outside, '9');
  const detached = h.doc.querySelector(popupSelector)!;
  detached.remove();
  h.change(detached, '8');
  h.tick(1000);
  expect(h.sets).toEqual([]);
  expect(h.saves).toEqual([]);
  s.stop();
});
test('plugin IPC commands write once and accept one finite readback with no synthetic events', async () => {
  const h = fixture('both'),
    s = h.session();
  await s.start(defaults);
  const reads = h.reads();
  let synthetic = 0;
  h.doc.addEventListener('input', () => synthetic++);
  h.doc.addEventListener('change', () => synthetic++);
  h.hooks.onSet = () =>
    h.api.querySelector('video').dispatchEvent(new h.dom.Event('volumechange'));
  h.emit('setVolume', 12.5);
  h.flush();
  h.tick(1000);
  expect(h.sets).toEqual([12.5]);
  expect(h.reads() - reads).toBe(1);
  expect(h.saves).toEqual([{ savedVolume: 12.5 }]);
  expect(synthetic).toBe(0);
  s.stop();
});
test('IPC rejects nonnumeric/nonfinite values and directions, clamps numeric values and bounds readback', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  for (const value of ['', '12', NaN, Infinity, -Infinity, undefined, null])
    h.emit('setVolume', value);
  for (const value of [1, 'true', undefined]) h.emit('changeVolume', value);
  expect(h.sets).toEqual([]);
  h.emit('setVolume', -20);
  h.emit('setVolume', 120);
  expect(h.sets).toEqual([0, 100]);
  h.hooks.onSet = () => h.external(NaN);
  h.emit('setVolume', 50);
  h.tick(1000);
  expect(h.saves).toEqual([{ savedVolume: 100 }]);
  s.stop();
});
test('manual legacy commit persists but rounded deferred observer echoes never overwrite canonical precision', async () => {
  const h = fixture('both', 1),
    s = h.session();
  await s.start({ ...defaults, savedVolume: 1 });
  h.flush();
  h.tick(1000);
  expect(h.saves).toEqual([]);
  h.emit('setVolume', 4);
  h.flush();
  h.tick(1000);
  expect(h.saves).toEqual([{ savedVolume: 4 }]);
  h.change(h.doc.querySelector('#volume-slider'), '17');
  h.flush();
  h.tick(1000);
  expect(h.saves).toEqual([{ savedVolume: 4 }, { savedVolume: 17 }]);
  expect(h.sets).toEqual([4]);
  s.stop();
});
test('external media readback and legacy notifications project only, ignoring unrelated media', async () => {
  const h = fixture('both'),
    s = h.session();
  await s.start(defaults);
  h.external(63.5);
  h.api.querySelector('video').dispatchEvent(new h.dom.Event('volumechange'));
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('63.5');
  const unrelated = h.doc.createElement('video');
  h.doc.body.append(unrelated);
  h.external(22);
  unrelated.dispatchEvent(new h.dom.Event('volumechange'));
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('63.5');
  (h.doc.querySelector('#volume-slider') as any).value = '22';
  h.flush();
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('22');
  h.tick(1000);
  expect(h.sets).toEqual([]);
  expect(h.saves).toEqual([]);
  s.stop();
});
test('recreated popup and replaced hosts discover current API state without a second playback write', async () => {
  const h = fixture('both'),
    s = h.session();
  await s.start(defaults);
  const old = h.doc.querySelector('ytmusic-miniplayer')!;
  old.remove();
  const next = h.addNew();
  h.external(81);
  h.notify([next], [old]);
  expect((next.querySelector('input') as any).value).toBe('81');
  h.change(next.querySelector('input'), '19');
  h.tick(1000);
  const oldWheel = new h.dom.WheelEvent('wheel', {
    deltaY: -1,
    cancelable: true,
  });
  old.dispatchEvent(oldWheel);
  expect(h.sets).toEqual([]);
  expect(h.saves).toEqual([{ savedVolume: 19 }]);
  s.stop();
});
test('hover reopening refreshes current readback while unrelated mutations do not scan or persist', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  const before = h.reads();
  const unrelated = h.doc.createElement('section');
  unrelated.innerHTML = '<span>unrelated</span>';
  h.doc.body.append(unrelated);
  h.notify([unrelated]);
  expect(h.reads()).toBe(before);
  h.external(44);
  h.doc
    .querySelector('ytmusic-miniplayer')!
    .dispatchEvent(new h.dom.MouseEvent('mouseenter'));
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('44');
  expect(h.sets).toEqual([]);
  h.tick(1000);
  expect(h.saves).toEqual([]);
  s.stop();
});
test('config callbacks during a partial debounced save cannot recursively write playback or stale config', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  h.hooks.onSave = (partial) =>
    s.updateConfig({ ...defaults, steps: 9, ...partial });
  h.emit('setVolume', 28);
  h.tick(1000);
  h.tick(5000);
  expect(h.saves).toEqual([{ savedVolume: 28 }]);
  expect(h.sets).toEqual([28]);
  h.emit('changeVolume', true);
  expect(h.sets).toEqual([28, 37]);
  s.stop();
});
test('API setter retirement and native event value retirement cannot perform trailing reads, projection or saves', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  const reads = h.reads();
  h.hooks.onSet = () => s.stop();
  h.emit('setVolume', 20);
  expect(h.sets).toEqual([20]);
  expect(h.reads()).toBe(reads);
  h.tick(5000);
  expect(h.saves).toEqual([]);
  const next = fixture(),
    session = next.session();
  await session.start(defaults);
  const input = next.doc.querySelector(popupSelector) as any;
  Object.defineProperty(input, 'value', {
    get() {
      session.stop();
      return '18';
    },
    configurable: true,
  });
  input.dispatchEvent(new next.dom.Event('change', { bubbles: true }));
  next.tick(5000);
  expect(next.saves).toEqual([]);
  expect(next.sets).toEqual([]);
});
test('stop invalidates observer, timer and IPC callbacks retained before disposal and supports a fresh session', async () => {
  const h = fixture('both'),
    s = h.session();
  await s.start(defaults);
  h.emit('setVolume', 15);
  const callbacks = [...h.timers.values()].map((t) => t.callback),
    ipc = [...h.channels.get('setVolume')!],
    observer = h.observers[0];
  s.stop();
  s.stop();
  const priorSets = [...h.sets],
    priorSaves = [...h.saves];
  callbacks.forEach((fn) => fn());
  ipc.forEach((fn) => fn(99));
  observer.callback([
    { type: 'childList', addedNodes: [h.addNew()], removedNodes: [] },
  ]);
  h.tick(10000);
  expect(h.sets).toEqual(priorSets);
  expect(h.saves).toEqual(priorSaves);
  expect(h.releases()).toBe(2);
  expect(observer.disconnects).toBe(1);
  expect(h.removeAll()).toBe(0);
  await s.start(defaults);
  expect(h.sets).toEqual([15, 37]);
  ipc.forEach((fn) => fn(99));
  expect(h.sets).toEqual([15, 37]);
  s.stop();
  expect(h.releases()).toBe(4);
});
test('config disable and stale getConfig resolution cannot revive an old renderer owner', async () => {
  const h = fixture(),
    loaded = deferred<any>();
  h.context.getConfig = () => loaded.promise as any;
  const pending = h.source.onPlayerApiReady(h.api, h.context);
  h.source.onConfigChange({ ...defaults, enabled: false });
  loaded.resolve({ ...defaults, savedVolume: 8 });
  await pending;
  expect(h.sets).toEqual([]);
  expect(h.listenerCount()).toBe(0);
  expect(h.channels.size).toBe(0);
  expect(h.observers).toHaveLength(0);
});
test('a newer API-ready owner wins over an older deferred config await', async () => {
  const h = fixture(),
    loaded = deferred<any>();
  const old = h.source.onPlayerApiReady(h.api, {
    ...h.context,
    getConfig: () => loaded.promise,
  });
  await h.source.onPlayerApiReady(h.api, {
    ...h.context,
    getConfig: () => ({ ...defaults, savedVolume: 72 }),
  });
  loaded.resolve({ ...defaults, savedVolume: 3 });
  await old;
  expect(h.sets).toEqual([72]);
  expect([...h.channels.values()].map((s) => s.size)).toEqual([1, 1]);
  h.source.stop();
});
test('video-toggle await and queued HUD movement cannot resurrect disposed listeners or nodes', async () => {
  const h = fixture();
  (h.doc.querySelector('#main-panel') as any).computedStyleMap = () =>
    new Map([['display', { value: 'block' }]]);
  const toggled = deferred<boolean>();
  (h.dom as any).mainConfig.plugins.isEnabled = () => toggled.promise;
  const pending = h.source.onPlayerApiReady(h.api, h.context);
  await Promise.resolve();
  expect(typeof h.source.stop).toBe('function');
  h.source.moveVolumeHud(true);
  h.source.stop();
  toggled.resolve(false);
  await pending;
  h.tick(10000);
  expect(h.doc.querySelector('#volumeHud')).toBeNull();
  expect(h.listenerCount()).toBe(0);
  expect(h.timers.size).toBe(0);
});
test('arrow and wheel commands preserve native input focus, search focus and finite direction checks', async () => {
  const h = fixture('both'),
    s = h.session();
  await s.start(defaults);
  const input = h.doc.querySelector(popupSelector) as any;
  input.focus();
  input.dispatchEvent(
    new h.dom.KeyboardEvent('keydown', {
      code: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(h.sets).toEqual([]);
  input.blur();
  const search = h.doc.createElement('ytmusic-search-box') as any;
  search.opened = true;
  h.doc.body.append(search);
  h.dom.dispatchEvent(new h.dom.KeyboardEvent('keydown', { code: 'ArrowUp' }));
  expect(h.sets).toEqual([]);
  search.opened = false;
  h.dom.dispatchEvent(
    new h.dom.KeyboardEvent('keydown', { code: 'ArrowUp', cancelable: true }),
  );
  expect(h.sets).toEqual([38]);
  const host = h.doc.querySelector('ytmusic-miniplayer')!;
  host.dispatchEvent(
    new h.dom.WheelEvent('wheel', { deltaY: 0, cancelable: true }),
  );
  host.dispatchEvent(
    new h.dom.WheelEvent('wheel', { deltaY: -1, cancelable: true }),
  );
  expect(h.sets).toEqual([38, 39]);
  s.stop();
});
test('projection property callouts cannot write to tooltip or gradient after retiring the owner', async () => {
  for (const target of ['tooltip', 'gradient']) {
    const h = fixture('both'),
      s = h.session();
    await s.start(defaults);
    let trailingWrites = 0;
    if (target === 'tooltip') {
      Object.defineProperty(h.doc.querySelector('#expand-volume'), 'title', {
        configurable: true,
        get() {
          s.stop();
          return 'old';
        },
        set() {
          trailingWrites++;
        },
      });
    } else {
      const style = (h.doc.querySelector(popupSelector) as any).style;
      style.getPropertyValue = () => {
        s.stop();
        return 'old';
      };
      style.setProperty = () => {
        trailingWrites++;
      };
    }
    h.emit('setVolume', 52);
    h.tick(5000);
    expect(trailingWrites).toBe(0);
    expect(h.saves).toEqual([]);
  }
});
test('HUD geometry reads cannot mutate a disposed HUD after owner retirement', async () => {
  const h = fixture(),
    s = h.session();
  (h.doc.querySelector('#main-panel') as any).computedStyleMap = () =>
    new Map([['display', { value: 'block' }]]);
  await s.start(defaults);
  const hud = h.doc.querySelector('#volumeHud') as any;
  let writes = 0;
  Object.defineProperty(hud.style, 'top', {
    configurable: true,
    set() {
      writes++;
    },
  });
  Object.defineProperty(h.doc.querySelector('ytmusic-player'), 'clientHeight', {
    configurable: true,
    get() {
      s.stop();
      return 100;
    },
  });
  s.moveHud(true);
  h.tick(250);
  expect(writes).toBe(0);
  expect(h.doc.querySelector('#volumeHud')).toBeNull();
});
test('retirement during IPC subscription or observer construction releases the newly returned resource', async () => {
  for (const boundary of ['subscribe', 'observer']) {
    const h = fixture();
    let s: any;
    if (boundary === 'subscribe') {
      const previous = h.deps.subscribe;
      h.deps.subscribe = (name, listener) => {
        const release = previous(name, listener);
        s.stop();
        return release;
      };
    } else {
      const previous = h.deps.createObserver;
      h.deps.createObserver = (callback) => {
        const observer = previous(callback);
        s.stop();
        return observer;
      };
    }
    s = h.session();
    await s.start(defaults);
    expect(h.listenerCount()).toBe(0);
    expect([...h.channels.values()].every((values) => values.size === 0)).toBe(
      true,
    );
    expect(h.sets).toEqual([]);
    expect(h.observers.every((observer) => observer.disconnects === 1)).toBe(
      true,
    );
  }
});
test('latest enabled config wins across loading and a disabled update cancels queued persistence', async () => {
  const h = fixture(),
    loaded = deferred<any>();
  h.context.getConfig = () => loaded.promise as any;
  const pending = h.source.onPlayerApiReady(h.api, h.context);
  h.source.onConfigChange({ ...defaults, savedVolume: 46 });
  loaded.resolve({ ...defaults, savedVolume: 2 });
  await pending;
  expect(h.sets).toEqual([46]);
  h.emit('setVolume', 17);
  h.source.onConfigChange({ ...defaults, enabled: false });
  h.tick(5000);
  expect(h.saves).toEqual([]);
  expect(h.listenerCount()).toBe(0);
  expect(h.doc.querySelector('#volumeHud')).toBeNull();
});
test('session cleanup preserves a pre-existing HUD and pre-existing hover class', async () => {
  const h = fixture('old');
  const external = h.doc.createElement('span');
  external.id = 'volumeHud';
  external.textContent = 'external';
  h.doc.body.append(external);
  const host = h.doc.querySelector('ytmusic-player-bar')!;
  host.classList.add('on-hover');
  const s = h.session();
  await s.start(defaults);
  h.emit('setVolume', 25);
  s.moveHud(false);
  h.tick(250);
  s.stop();
  expect(external.isConnected).toBe(true);
  expect(external.textContent).toBe('external');
  expect(host.classList.contains('on-hover')).toBe(true);
});
test('retirement while looking up an API setter prevents invoking the returned stale capability', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  let staleCalls = 0;
  Object.defineProperty(h.api, 'setVolume', {
    configurable: true,
    get() {
      s.stop();
      return () => {
        staleCalls++;
      };
    },
  });
  h.emit('setVolume', 29);
  h.tick(5000);
  expect(staleCalls).toBe(0);
  expect(h.saves).toEqual([]);
});
test('retirement while looking up readback prevents calling its returned getter or committing UI', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  let staleCalls = 0;
  Object.defineProperty(h.api, 'getVolume', {
    configurable: true,
    get() {
      s.stop();
      return () => {
        staleCalls++;
        return 29;
      };
    },
  });
  h.emit('setVolume', 29);
  h.tick(5000);
  expect(h.sets).toEqual([29]);
  expect(staleCalls).toBe(0);
  expect(h.saves).toEqual([]);
});
test('existing extracted core volume IPC keeps scene cancellation and one percentage write with the plugin active', async () => {
  const h = fixture('both'),
    s = h.session();
  await s.start(defaults);
  const trace: string[] = [];
  let callback: any,
    legacyWrites = 0;
  (h.dom as any).ipcRenderer = {
    on: (_name: string, listener: any) => {
      callback = listener;
    },
  };
  (h.dom as any).blockerSceneGuard = {
    cancelFromUser: () => trace.push('cancel'),
  };
  (h.doc.querySelector('ytmusic-player-bar') as any).updateVolume = () => {
    legacyWrites++;
    h.external(29);
  };
  h.hooks.onSet = () => {
    trace.push('set');
    h.api.querySelector('video').dispatchEvent(new h.dom.Event('volumechange'));
  };
  const module = { exports: {} as any };
  vm.runInNewContext(coreVolume, {
    module,
    exports: module.exports,
    window: h.dom,
    document: h.doc,
  });
  module.exports.register(h.api);
  callback({}, 60);
  h.flush();
  h.tick(1000);
  expect(h.sets).toEqual([60]);
  expect(trace).toEqual(['cancel', 'set']);
  expect(legacyWrites).toBe(0);
  expect(h.saves).toEqual([]);
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('60');
  s.stop();
});
test('existing extracted core volume IPC clamps endpoints, rejects nonfinite data and needs no bar or slider', async () => {
  const h = fixture('none'),
    s = h.session();
  await s.start(defaults);
  let callback: any,
    cancelled = 0;
  (h.dom as any).ipcRenderer = {
    on: (_name: string, listener: any) => {
      callback = listener;
    },
  };
  (h.dom as any).blockerSceneGuard = { cancelFromUser: () => cancelled++ };
  const module = { exports: {} as any };
  vm.runInNewContext(coreVolume, {
    module,
    exports: module.exports,
    window: h.dom,
    document: h.doc,
  });
  module.exports.register(h.api);
  for (const value of [NaN, Infinity, -Infinity, '12', undefined])
    callback({}, value);
  expect(cancelled).toBe(0);
  expect(h.sets).toEqual([]);
  for (const value of [0, 1, 4, 12.5, 100, -20, 120]) callback({}, value);
  expect(h.sets).toEqual([0, 1, 4, 12.5, 100, 0, 100]);
  expect(cancelled).toBe(7);
  h.tick(1000);
  expect(h.saves).toEqual([]);
  s.stop();
});
test('replacing a hovered host releases its owned hover state before the session ends', async () => {
  const h = fixture(),
    s = h.session();
  await s.start(defaults);
  const old = h.doc.querySelector('ytmusic-miniplayer')!;
  old.dispatchEvent(new h.dom.MouseEvent('mouseenter'));
  expect(old.classList.contains('on-hover')).toBe(true);
  old.remove();
  const next = h.addNew();
  h.notify([next], [old]);
  expect(old.classList.contains('on-hover')).toBe(false);
  expect(h.sets).toEqual([]);
  s.stop();
});

test('F1: a retired projection cannot overwrite the newer session gradient through a style getter', async () => {
  const h = fixture('new', 37),
    session = h.session();
  await session.start({ ...defaults });
  const input = h.doc.querySelector(popupSelector) as any;
  const style = input.style;
  let styleReads = 0,
    restarted: Promise<void> | undefined;
  Object.defineProperty(input, 'style', {
    configurable: true,
    get() {
      if (++styleReads === 2) {
        h.external(20);
        restarted = session.start({ ...defaults, savedVolume: 20 });
      }
      return style;
    },
  });
  h.emit('setVolume', 60);
  await restarted;
  expect(h.api.getVolume()).toBe(20);
  expect(input.value).toBe('20');
  expect(style.getPropertyValue('--yt-slider-shape-gradient-percent')).toBe(
    '20%',
  );
});

test('F2: a newer API-ready owner created during old unsubscribe wins over the older caller', async () => {
  const h = fixture('new', 37);
  const subscribe = h.context.ipc.subscribe;
  let armed = false,
    fired = false,
    newer: Promise<void> | undefined;
  h.context.ipc.subscribe = (channel: string, listener: any) => {
    const release = subscribe(channel, listener);
    return () => {
      release();
      if (armed && !fired) {
        fired = true;
        h.external(20);
        newer = h.source.onPlayerApiReady(h.api, {
          ...h.context,
          getConfig: () => ({ ...defaults, savedVolume: 20 }),
        });
      }
    };
  };
  await h.source.onPlayerApiReady(h.api, h.context);
  armed = true;
  await h.source.onPlayerApiReady(h.api, {
    ...h.context,
    getConfig: () => ({ ...defaults, savedVolume: 60 }),
  });
  await newer;
  expect(fired).toBe(true);
  expect(h.api.getVolume()).toBe(20);
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('20');
});

test('control: style accessor with no retirement still projects the command exactly once', async () => {
  const h = fixture(),
    session = h.session();
  await session.start({ ...defaults });
  const input = h.doc.querySelector(popupSelector) as any,
    style = input.style;
  Object.defineProperty(input, 'style', {
    configurable: true,
    get: () => style,
  });
  h.emit('setVolume', 60);
  expect(h.sets).toEqual([60]);
  expect(input.value).toBe('60');
  expect(style.getPropertyValue('--yt-slider-shape-gradient-percent')).toBe(
    '60%',
  );
});

test('control: ordinary unsubscribe and reinit retain the requested current owner', async () => {
  const h = fixture();
  await h.source.onPlayerApiReady(h.api, h.context);
  await h.source.onPlayerApiReady(h.api, {
    ...h.context,
    getConfig: () => ({ ...defaults, savedVolume: 60 }),
  });
  expect(h.api.getVolume()).toBe(60);
  expect([...h.channels.values()].map((s) => s.size)).toEqual([1, 1]);
  h.source.stop();
  expect([...h.channels.values()].map((s) => s.size)).toEqual([0, 0]);
});

test('F1 HUD: reentry during element creation cannot orphan the newer owned HUD', async () => {
  const h = fixture(),
    session = h.session();
  const create = h.doc.createElement.bind(h.doc);
  let armed = true,
    restarted: Promise<void> | undefined;
  h.doc.createElement = ((name: string, options?: any) => {
    const node = create(name, options);
    if (name === 'span' && armed) {
      armed = false;
      restarted = session.start({ ...defaults, savedVolume: 20 });
    }
    return node;
  }) as any;
  await session.start({ ...defaults });
  await restarted;
  expect(h.doc.querySelector('#volumeHud')).not.toBeNull();
  session.stop();
  expect(h.doc.querySelector('#volumeHud')).toBeNull();
});

for (const method of ['getPropertyValue', 'setProperty'] as const) {
  test(`retired popup projection cannot invoke a returned ${method} capability`, async () => {
    const h = fixture('new'),
      session = h.session();
    await session.start(defaults);
    const input = h.doc.querySelector(popupSelector) as any,
      style = input.style;
    const original = style[method];
    let armed = true,
      restarted: Promise<void> | undefined,
      staleCalls = 0;
    Object.defineProperty(style, method, {
      configurable: true,
      get() {
        if (!armed) return original;
        armed = false;
        h.external(20);
        restarted = session.start({ ...defaults, savedVolume: 20 });
        return (...args: any[]) => {
          staleCalls++;
          return original.apply(style, args);
        };
      },
    });
    h.emit('setVolume', 60);
    await restarted;
    expect(armed).toBe(false);
    expect(staleCalls).toBe(0);
    expect(input.value).toBe('20');
    expect(style.getPropertyValue('--yt-slider-shape-gradient-percent')).toBe(
      '20%',
    );
    session.stop();
  });
}

for (const boundary of [
  'id',
  'style',
  'cssText',
  'append',
  'insertAdjacentElement',
] as const) {
  test(`HUD ${boundary} acquisition preserves the newer handle and its cleanup`, async () => {
    const h = fixture(),
      session = h.session();
    if (boundary === 'insertAdjacentElement')
      (h.doc.querySelector('#main-panel') as any).computedStyleMap = () =>
        new Map([['display', { value: 'block' }]]);
    const create = h.doc.createElement.bind(h.doc);
    let armed = true,
      restarted: Promise<void> | undefined,
      staleAttachments = 0;
    const restart = () => {
      if (!armed) return;
      armed = false;
      h.external(20);
      restarted = session.start({ ...defaults, savedVolume: 20 });
    };
    if (boundary === 'append' || boundary === 'insertAdjacentElement') {
      const anchor = h.doc.querySelector(
        boundary === 'append' ? '.center-content' : '#song-video',
      ) as any;
      const attach = anchor[boundary];
      Object.defineProperty(anchor, boundary, {
        configurable: true,
        get() {
          if (!armed) return attach;
          restart();
          return (...args: any[]) => {
            staleAttachments++;
            return attach.apply(anchor, args);
          };
        },
      });
    } else {
      h.doc.createElement = ((name: string, options?: any) => {
        const node = create(name, options);
        if (name !== 'span' || !armed) return node;
        const style = node.style;
        if (boundary === 'id')
          Object.defineProperty(node, 'id', {
            configurable: true,
            set(value: string) {
              node.setAttribute('id', value);
              restart();
            },
          });
        else if (boundary === 'style')
          Object.defineProperty(node, 'style', {
            configurable: true,
            get() {
              restart();
              return style;
            },
          });
        else
          Object.defineProperty(style, 'cssText', {
            configurable: true,
            set() {
              restart();
            },
          });
        return node;
      }) as any;
    }
    await session.start(defaults);
    await restarted;
    expect(armed).toBe(false);
    expect(staleAttachments).toBe(0);
    expect(h.api.getVolume()).toBe(20);
    expect(h.doc.querySelectorAll('#volumeHud')).toHaveLength(1);
    h.emit('setVolume', 21);
    expect(h.doc.querySelector('#volumeHud')!.textContent).toBe('21%');
    session.stop();
    expect(h.doc.querySelectorAll('#volumeHud')).toHaveLength(0);
    expect(h.listenerCount()).toBe(0);
    expect([...h.channels.values()].every((s) => s.size === 0)).toBe(true);
  });
}

for (const property of ['opacity', 'top'] as const) {
  test(`HUD ${property} style lookup cannot apply a retired write`, async () => {
    const h = fixture(),
      session = h.session();
    await session.start(defaults);
    const node = h.doc.querySelector('#volumeHud') as any,
      style = node.style;
    let armed = true,
      restarted: Promise<void> | undefined,
      staleWrites = 0;
    Object.defineProperty(style, property, {
      configurable: true,
      set() {
        staleWrites++;
      },
    });
    Object.defineProperty(node, 'style', {
      configurable: true,
      get() {
        if (armed) {
          armed = false;
          h.external(20);
          restarted = session.start({ ...defaults, savedVolume: 20 });
        }
        return style;
      },
    });
    if (property === 'opacity') h.emit('setVolume', 60);
    else {
      session.moveHud(false);
      h.tick(250);
    }
    await restarted;
    expect(armed).toBe(false);
    expect(staleWrites).toBe(0);
    expect(h.api.getVolume()).toBe(20);
    session.stop();
    expect(h.doc.querySelector('#volumeHud')).toBeNull();
  });
}

test('newer same-session start during unsubscribe wins over the older start', async () => {
  const h = fixture(),
    subscribe = h.deps.subscribe;
  let session: any,
    armed = false,
    fired = false,
    newer: Promise<void> | undefined;
  h.deps.subscribe = (channel, listener) => {
    const release = subscribe(channel, listener);
    return () => {
      release();
      if (armed && !fired) {
        fired = true;
        h.external(20);
        newer = session.start({ ...defaults, savedVolume: 20 });
      }
    };
  };
  session = h.session();
  await session.start(defaults);
  armed = true;
  await session.start({ ...defaults, savedVolume: 60 });
  await newer;
  expect(fired).toBe(true);
  expect(h.sets).toEqual([]);
  expect(h.api.getVolume()).toBe(20);
  expect((h.doc.querySelector(popupSelector) as any).value).toBe('20');
  expect([...h.channels.values()].map((s) => s.size)).toEqual([1, 1]);
  h.tick(5000);
  expect(h.saves).toEqual([]);
  session.stop();
  expect(h.listenerCount()).toBe(0);
  expect(h.doc.querySelector('#volumeHud')).toBeNull();
});
