import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

import { expect, test } from '@playwright/test';

type Callback = (...args: unknown[]) => void;
type AmbientConfig = {
  enabled: boolean;
  quality: number;
  buffer: number;
  interpolationTime: number;
  blur: number;
  size: number;
  opacity: number;
  fullscreen: boolean;
};
type TestPlugin = {
  config: AmbientConfig;
  renderer: {
    start: (context: {
      getConfig: () => Promise<AmbientConfig>;
    }) => Promise<void>;
    stop: () => void;
    [key: string]: unknown;
  };
};
type Loader = {
  forceLoadRendererPlugin: (id: string) => Promise<void>;
  forceUnloadRendererPlugin: (id: string) => Promise<void>;
  getLoadedRendererPlugin: (id: string) => unknown;
};
type Lifecycle = {
  startPlugin: (...args: unknown[]) => Promise<unknown>;
  stopPlugin: (...args: unknown[]) => Promise<unknown>;
};
const root = new URL('../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
const stripImports = (source: string) =>
  source.replace(/^import[\s\S]*?;\s*/gm, '');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class EventTargetFixture {
  readonly listeners = new Map<string, Set<Callback>>();
  addEventListener(name: string, callback: Callback) {
    const listeners = this.listeners.get(name) ?? new Set<Callback>();
    listeners.add(callback);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, callback: Callback) {
    this.listeners.get(name)?.delete(callback);
  }
}

class FixtureNode extends EventTargetFixture {
  isConnected = false;
  width = 300;
  height = 150;
  readonly children = new Set<FixtureNode>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  readonly style = { setProperty() {} };
  readonly context = { globalAlpha: 1, drawImage() {} };
  constructor(readonly tag: string) {
    super();
  }
  prepend(node: FixtureNode) {
    this.children.add(node);
    node.isConnected = true;
  }
  remove() {
    for (const parent of containers) parent.children.delete(this);
    this.isConnected = false;
  }
  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }
  querySelector() {
    return null;
  }
  getContext(kind: string) {
    expect(kind).toBe('2d');
    return this.context;
  }
}

const containers = new Set<FixtureNode>();

class VideoFixture extends EventTargetFixture {
  paused = true;
  ended = false;
  readyState = 2;
  src = 'fixture-video';
  width = 16;
  height = 9;
  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }
}

function ownedLoaderFixture() {
  let targetReady = false;
  let targetQueries = 0;
  let observerCreated = 0;
  let observerDisconnected = 0;
  let throwOnWrapperQuery = false;
  let onConsoleError: ((...args: unknown[]) => void) | undefined;
  const activeIntervals = new Map<ReturnType<typeof setInterval>, number>();
  const observers: ObserverFixture[] = [];
  const nodes: FixtureNode[] = [];
  const frames = new Map<number, Callback>();
  let frameId = 0;
  const video = new VideoFixture();
  const songVideo = new FixtureNode('div');
  const playerPage = {};
  const layout = {
    hasAttribute: (name: string) => name === 'player-page-open',
  };
  const image = new FixtureNode('img');
  const wrapper = new FixtureNode('div');
  containers.add(wrapper);
  const songImage = new FixtureNode('div');
  containers.add(songImage);
  let plugin: TestPlugin | undefined;

  class ObserverFixture {
    connected = false;
    constructor(readonly callback: (records: { type: string }[]) => void) {
      observerCreated++;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      observerDisconnected++;
    }
    deliver() {
      if (this.connected) this.callback([{ type: 'attributes' }]);
    }
  }

  const ownedSetInterval = (fn: Callback, ms: number) => {
    const handle = setInterval(fn, ms);
    activeIntervals.set(handle, ms);
    return handle;
  };
  const ownedClearInterval = (handle: ReturnType<typeof setInterval>) => {
    clearInterval(handle);
    activeIntervals.delete(handle);
  };
  const document = {
    adoptedStyleSheets: [] as FixtureSheet[],
    querySelector(selector: string) {
      if (selector === '.html5-video-container > video') {
        targetQueries++;
        return targetReady ? video : null;
      }
      if (selector === '#song-image') return songImage;
      if (selector === 'yt-img-shadow > img') return image;
      if (selector === '#song-video') return songVideo;
      if (selector === '#song-video > .player-wrapper') {
        if (throwOnWrapperQuery) throw Error('owned wrapper lookup failure');
        return wrapper;
      }
      if (selector === '#player-page') return playerPage;
      if (selector === '#layout') return layout;
      return null;
    },
    createElement(tag: string) {
      const node = new FixtureNode(tag);
      nodes.push(node);
      containers.add(tag === 'img' ? songImage : wrapper);
      return node;
    },
  };
  class FixtureSheet {
    replaceSync() {}
  }
  const consoleFixture = {
    log() {},
    error(...args: unknown[]) {
      onConsoleError?.(...args);
    },
    warn() {},
    trace() {},
  };
  const env = {
    AbortController,
    CSSStyleSheet: FixtureSheet,
    MutationObserver: ObserverFixture,
    clearInterval: ownedClearInterval,
    clearTimeout,
    console: consoleFixture,
    createPlugin: (value: unknown) => value,
    deepmerge: (...values: object[]) => Object.assign({}, ...values) as unknown,
    document,
    getComputedStyle: (element: FixtureNode) => {
      expect(element).toBe(songVideo);
      return { display: 'block' };
    },
    menu: [],
    performance,
    requestAnimationFrame: (callback: Callback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setInterval: ownedSetInterval,
    setTimeout,
    style: '',
    t: (key: string) => key,
    window: {
      mainConfig: {
        plugins: { getPlugins: () => ({ ambient: { enabled: true } }) },
      },
      ipcRenderer: {
        invoke: (event: string) =>
          Promise.resolve(
            event === 'peard:get-config' ? plugin!.config : undefined,
          ),
      },
    },
  };
  const helperSource = stripTypeScriptTypes(
    stripImports(read('src/utils/wait-for-element.ts')),
    { mode: 'transform' },
  ).replace('export const waitForElement =', 'const waitForElement =');
  const waitForElement = vm.runInNewContext(
    `(function(){${helperSource}\nreturn waitForElement;})()`,
    env,
  ) as (selector: string) => Promise<HTMLVideoElement>;
  // Resolve ambient's imported helper inside the source-evaluated module scope.
  // It is a lexical binding in production, so re-evaluate with that exact helper.
  const boundAmbient = stripTypeScriptTypes(
    stripImports(read('src/plugins/ambient-mode/index.ts')),
    { mode: 'transform' },
  )
    .replace('export default createPlugin(', 'return createPlugin(')
    .replace("import { waitForElement } from '@/utils/wait-for-element';", '');
  // Imports are stripped above; inject the production helper before module code.
  plugin = vm.runInNewContext(
    `(function(){const waitForElement=globalThis.__waitForElement;${boundAmbient}\n})()`,
    { ...env, __waitForElement: waitForElement },
  ) as unknown as TestPlugin;

  const utils = read('src/utils/index.ts');
  const startAt = utils.indexOf('export const startPlugin');
  const lifecycleSource = stripTypeScriptTypes(
    utils.slice(startAt).replaceAll('export const ', 'const '),
    { mode: 'transform' },
  );
  const lifecycle = vm.runInNewContext(
    `(function(){${lifecycleSource}\nreturn {startPlugin,stopPlugin};})()`,
    { LoggerPrefix: 'test', console: env.console, performance, t: env.t },
  ) as unknown as Lifecycle;
  const loaderSource = stripTypeScriptTypes(
    stripImports(read('src/loader/renderer.ts')).replaceAll(
      'export const ',
      'const ',
    ),
    { mode: 'transform' },
  );
  const loader = vm.runInNewContext(
    `(function(){${loaderSource}\nreturn {forceLoadRendererPlugin,forceUnloadRendererPlugin,getLoadedRendererPlugin};})()`,
    {
      CSSStyleSheet: FixtureSheet,
      LoggerPrefix: 'test',
      console: env.console,
      createContext: (_id: string) => ({
        getConfig: () => Promise.resolve(plugin.config),
        setConfig: () => Promise.resolve(),
        ipc: {
          send() {},
          invoke: () => Promise.resolve(undefined),
          on() {},
          subscribe() {},
          removeAllListeners() {},
        },
      }),
      deepmerge: env.deepmerge,
      document,
      performance,
      rendererPlugins: () => Promise.resolve({ ambient: plugin }),
      startPlugin: lifecycle.startPlugin,
      stopPlugin: lifecycle.stopPlugin,
      t: env.t,
      window: env.window,
    },
  ) as unknown as Loader;

  return {
    activeIntervals,
    document,
    get plugin() {
      return plugin;
    },
    get observerCreated() {
      return observerCreated;
    },
    get observerDisconnected() {
      return observerDisconnected;
    },
    get observers() {
      return observers;
    },
    get targetQueries() {
      return targetQueries;
    },
    get targetReady() {
      return targetReady;
    },
    get nodes() {
      return nodes;
    },
    loader,
    setTargetReady(value: boolean) {
      targetReady = value;
    },
    setThrowOnWrapperQuery(value: boolean) {
      throwOnWrapperQuery = value;
    },
    setConsoleErrorHook(callback: ((...args: unknown[]) => void) | undefined) {
      onConsoleError = callback;
    },
    cleanup() {
      for (const handle of activeIntervals.keys()) ownedClearInterval(handle);
      containers.clear();
    },
  };
}

const eventually = async (predicate: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await delay(10);
  }
  return true;
};

test('disable cancels missing ambient target wait before the video appears', async () => {
  const h = ownedLoaderFixture();
  let startSettled = false;
  let unloadSettled = false;
  const start = h.loader.forceLoadRendererPlugin('ambient').then(() => {
    startSettled = true;
  });
  let unload: Promise<void> | undefined;
  try {
    expect(await eventually(() => h.targetQueries >= 1)).toBe(true);
    unload = h.loader.forceUnloadRendererPlugin('ambient').then(() => {
      unloadSettled = true;
    });
    await delay(220);
    const beforeTarget = {
      startSettled,
      unloadSettled,
      activeIntervals: h.activeIntervals.size,
      connectedObservers: h.observers.filter((observer) => observer.connected)
        .length,
      attachedNodes: h.nodes.filter((node) => node.isConnected).length,
    };

    // Release the target before asserting so a RED run cannot leave a poll timer.
    h.setTargetReady(true);
    await Promise.all([start, unload]);
    expect(h.activeIntervals.size).toBe(0);
    expect(h.observerDisconnected).toBe(h.observerCreated);
    expect(h.nodes.filter((node) => node.isConnected)).toHaveLength(0);
    expect(Boolean(h.loader.getLoadedRendererPlugin('ambient'))).toBe(false);
    expect(beforeTarget.startSettled).toBe(true);
    expect(beforeTarget.unloadSettled).toBe(true);
    expect(beforeTarget.activeIntervals).toBe(0);
    expect(beforeTarget.connectedObservers).toBe(0);
    expect(beforeTarget.attachedNodes).toBe(0);

    await h.loader.forceLoadRendererPlugin('ambient');
    expect(
      await eventually(() =>
        h.observers.some((observer) => observer.connected),
      ),
    ).toBe(true);
    const current = h.observers.find((observer) => observer.connected);
    expect(current).toBeTruthy();
    current!.deliver();
    expect(
      h.nodes.filter((node) => node.isConnected && node.tag === 'canvas'),
    ).toHaveLength(1);
    await h.loader.forceUnloadRendererPlugin('ambient');
    expect(h.activeIntervals.size).toBe(0);
    expect(h.nodes.filter((node) => node.isConnected)).toHaveLength(0);
  } finally {
    h.setTargetReady(true);
    if (unload) await Promise.race([unload, delay(1500)]);
    await Promise.race([start, delay(1500)]);
    h.cleanup();
  }
});

test('initializer error logging cannot invalidate a replacement ambient owner', async () => {
  const h = ownedLoaderFixture();
  h.setTargetReady(true);
  h.setThrowOnWrapperQuery(true);
  let errorCount = 0;
  let replacementStart: Promise<void> | undefined;
  h.setConsoleErrorHook((message) => {
    if (message !== '[ambient-mode] Failed to initialize renderer') return;
    errorCount++;
    if (errorCount !== 1) return;
    h.setThrowOnWrapperQuery(false);
    replacementStart = h.plugin.renderer.start({
      getConfig: () => Promise.resolve(h.plugin.config),
    });
  });

  try {
    await h.loader.forceLoadRendererPlugin('ambient');
    expect(await eventually(() => errorCount === 1)).toBe(true);
    expect(replacementStart).toBeTruthy();
    await replacementStart;
    expect(
      await eventually(() =>
        h.observers.some((observer) => observer.connected),
      ),
    ).toBe(true);
    expect(h.observers.filter((observer) => observer.connected)).toHaveLength(
      1,
    );
    const current = h.observers.find((observer) => observer.connected);
    current!.deliver();
    expect(
      h.nodes.filter((node) => node.isConnected && node.tag === 'canvas'),
    ).toHaveLength(1);
  } finally {
    h.setThrowOnWrapperQuery(false);
    h.setConsoleErrorHook(undefined);
    await h.loader.forceUnloadRendererPlugin('ambient');
    h.cleanup();
  }
});
