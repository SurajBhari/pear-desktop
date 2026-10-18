import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

import { test } from '@playwright/test';

type Callback = () => void;
type Config = {
  enabled: boolean;
  quality: number;
  buffer: number;
  interpolationTime: number;
  blur: number;
  size: number;
  opacity: number;
  fullscreen: boolean;
};
type Renderer = {
  start: (context: { getConfig: () => Promise<Config> }) => Promise<void>;
  onConfigChange: (config: Config) => void;
  stop: Callback;
  unregister: Callback | null;
  update: Callback | null;
};
type Plugin = { config: Config; renderer: Renderer };
type Draw = { node: FakeNode; alpha: number };
class Target {
  readonly listeners = new Map<string, Set<Callback>>();
  addEventListener(name: string, callback: Callback) {
    const listeners = this.listeners.get(name) ?? new Set<Callback>();
    listeners.add(callback);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, callback: Callback) {
    this.listeners.get(name)?.delete(callback);
  }
  dispatch(name: string) {
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback();
  }
  held() {
    return [...this.listeners.values()].flatMap((listeners) => [...listeners]);
  }
  listenerCount() {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}
class Container extends Target {
  readonly children = new Set<FakeNode>();
  prepend(node: FakeNode) {
    node.parent = this;
    node.isConnected = true;
    this.children.add(node);
  }
}
class Video extends Target {
  paused = true;
  ended = false;
  readyState = 2;
  src = 'same-video';
  width = 4;
  height = 4;
  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }
}
class FakeNode {
  private widthValue = 300;
  private heightValue = 150;
  resizeWrites = 0;
  onRemove: Callback | null = null;
  isConnected = false;
  parent: Container | null = null;
  src = 'same-image';
  readonly classes = new Set<string>();
  readonly styles = new Map<string, string>();
  readonly classList = {
    add: (name: string) => {
      this.classes.add(name);
    },
    remove: (name: string) => {
      this.classes.delete(name);
    },
  };
  readonly style = {
    setProperty: (name: string, value: string) => {
      this.styles.set(name, value);
    },
  };
  readonly context: {
    globalAlpha: number;
    drawImage: (...args: unknown[]) => void;
  };
  constructor(
    readonly tag: string,
    draw: (node: FakeNode, alpha: number) => void,
  ) {
    this.context = {
      globalAlpha: 1,
      drawImage: () => draw(this, this.context.globalAlpha),
    };
  }
  get width() {
    return this.widthValue;
  }
  set width(value: number) {
    this.widthValue = value;
    this.resizeWrites++;
  }
  get height() {
    return this.heightValue;
  }
  set height(value: number) {
    this.heightValue = value;
    this.resizeWrites++;
  }
  getContext(kind: string) {
    assert.equal(kind, '2d');
    return this.context;
  }
  remove() {
    this.parent?.children.delete(this);
    this.parent = null;
    this.isConnected = false;
    this.onRemove?.();
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
const raw = readFileSync(
  new URL('../src/plugins/ambient-mode/index.ts', import.meta.url),
  'utf8',
);
const actual = stripTypeScriptTypes(raw, { mode: 'transform' })
  .replace(/^import[\s\S]*?;\n/gm, '')
  .replace('export default createPlugin(', 'return createPlugin(');

function fixture(
  options: {
    paused?: boolean;
    readyState?: number;
    delayConfig?: boolean;
    delayVideo?: boolean;
  } = {},
) {
  const video = new Video();
  video.paused = options.paused ?? true;
  video.readyState = options.readyState ?? 2;
  const songVideo = new Target(),
    songImage = new Container(),
    wrapper = new Container();
  const image = new FakeNode('img', () => {}),
    foreign = new FakeNode('foreign', () => {});
  wrapper.prepend(foreign);
  const page = {},
    state = { open: true, videoMode: true };
  const nodes: FakeNode[] = [],
    draws: Draw[] = [];
  const intervals = new Map<number, { fn: Callback; delay: number }>(),
    frames = new Map<number, Callback>();
  let serial = 0,
    frameRequests = 0;
  const configGate = deferred<Config>(),
    videoGate = deferred<Video>();
  const observers: Observer[] = [];
  class Observer {
    active = false;
    disconnects = 0;
    constructor(readonly callback: (records: { type: string }[]) => void) {
      observers.push(this);
    }
    observe(target: object, settings: { attributes: boolean }) {
      assert.equal(target, page);
      assert.equal(settings.attributes, true);
      this.active = true;
    }
    disconnect() {
      this.active = false;
      this.disconnects++;
    }
    deliver() {
      if (this.active) this.callback([{ type: 'attributes' }]);
    }
  }
  const environment = {
    t: (key: string) => key,
    createPlugin: (value: unknown) => value,
    menu: {},
    style: '',
    document: {
      querySelector: (selector: string) => {
        if (selector === '#song-image')
          return {
            querySelector: () => image,
            prepend: (node: FakeNode) => songImage.prepend(node),
          };
        if (selector === '#song-video') return songVideo;
        if (selector === '#song-video > .player-wrapper') return wrapper;
        if (selector === '#player-page') return page;
        if (selector === '#layout') return { hasAttribute: () => state.open };
        throw Error('Unexpected source selector: ' + selector);
      },
      createElement: (tag: string) => {
        assert(['canvas', 'img'].includes(tag));
        const node = new FakeNode(tag, (canvas, alpha) =>
          draws.push({ node: canvas, alpha }),
        );
        nodes.push(node);
        return node;
      },
    },
    getComputedStyle: (target: Target) => {
      assert.equal(target, songVideo);
      return { display: state.videoMode ? 'block' : 'none' };
    },
    waitForElement: (selector: string) => {
      assert.equal(selector, '.html5-video-container > video');
      return options.delayVideo ? videoGate.promise : Promise.resolve(video);
    },
    MutationObserver: Observer,
    setInterval: (fn: Callback, delay: number) => {
      const id = ++serial;
      intervals.set(id, { fn, delay });
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
    requestAnimationFrame: (fn: Callback) => {
      const id = ++serial;
      frameRequests++;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  // Actual plugin source, only imports removed and metadata construction injected.
  // All DOM/media/scheduler primitives are owned fakes; no plugin module import.
  const plugin = vm.runInNewContext(
    '(function(){' + actual + '\n})()',
    environment,
  ) as Plugin;
  let config: Config = {
    ...plugin.config,
    enabled: true,
    quality: 4,
    buffer: 2,
    interpolationTime: 1000,
  };
  const start = (
    getConfig = () =>
      options.delayConfig ? configGate.promise : Promise.resolve(config),
  ) => plugin.renderer.start({ getConfig });
  const tick = (delay: number) => {
    for (const timer of [...intervals.values()])
      if (timer.delay === delay) timer.fn();
  };
  const flushFrames = () => {
    for (const [id, fn] of [...frames]) {
      frames.delete(id);
      fn();
    }
  };
  const canvas = () => {
    const node = nodes.filter((value) => value.tag === 'canvas').at(-1);
    assert(node);
    return node;
  };
  const paintCount = () =>
    [...intervals.values()].filter((timer) => timer.delay === 500).length;
  return {
    renderer: plugin.renderer,
    start,
    tick,
    flushFrames,
    canvas,
    paintCount,
    video,
    songVideo,
    songImage,
    wrapper,
    foreign,
    state,
    nodes,
    draws,
    intervals,
    frames,
    observers,
    configGate,
    videoGate,
    get frameRequests() {
      return frameRequests;
    },
    get config() {
      return config;
    },
    configure: (patch: Partial<Config>) => {
      config = { ...config, ...patch };
      plugin.renderer.onConfigChange(config);
    },
  };
}

test('paused initial/readiness requests draw once and event bursts coalesce without recurring paint', async () => {
  const h = fixture();
  await h.start();
  h.tick(1000);
  assert.equal(
    h.paintCount(),
    0,
    'Paused attachment must not start recurring paint',
  );
  assert.equal(h.frames.size, 1);
  h.flushFrames();
  assert.deepEqual(
    h.draws.map((draw) => draw.alpha),
    [1],
  );
  for (let n = 0; n < 30; n++) {
    h.tick(500);
    h.tick(1000);
    h.flushFrames();
  }
  assert.equal(h.draws.length, 1);
  const unready = fixture({ readyState: 0 });
  await unready.start();
  unready.tick(1000);
  assert.equal(unready.frames.size, 0);
  assert.equal(unready.paintCount(), 0);
  unready.video.dispatch('seeked');
  unready.video.dispatch('loadeddata');
  unready.flushFrames();
  assert.equal(unready.draws.length, 0);
  unready.video.readyState = 2;
  unready.video.dispatch('loadeddata');
  unready.video.dispatch('seeked');
  unready.video.dispatch('resize');
  assert.equal(unready.frames.size, 1);
  unready.flushFrames();
  assert.deepEqual(
    unready.draws.map((draw) => draw.alpha),
    [1],
  );
  assert.equal(unready.frames.size, 0);
  h.renderer.stop();
  unready.renderer.stop();
});

test('actual-video pause/play/ended obey properties and distinguish explicit from periodic queued frames', async () => {
  const h = fixture({ paused: false });
  await h.start();
  h.tick(1000);
  h.flushFrames();
  assert.equal(h.paintCount(), 1);
  const requests = h.frameRequests;
  for (let n = 0; n < 5; n++) h.tick(500);
  assert.equal(h.frames.size, 1);
  assert.equal(
    h.frameRequests - requests,
    1,
    'Ticks coalesce instead of cancel/requeue',
  );
  const retiredPeriodic = [...h.frames.values()][0];
  h.video.paused = true;
  h.video.dispatch('pause');
  assert.equal(h.paintCount(), 0);
  assert.equal(h.frames.size, 0, 'Pure periodic frame is canceled by pause');
  h.video.dispatch('seeked');
  assert.equal(h.frames.size, 1);
  const before = h.draws.length;
  retiredPeriodic();
  assert.equal(h.draws.length, before);
  assert.equal(
    h.frames.size,
    1,
    'Held canceled frame cannot consume a newer request',
  );
  h.flushFrames();
  h.video.dispatch('play');
  assert.equal(h.paintCount(), 0, 'Stray play cannot override paused property');
  h.video.paused = false;
  h.video.ended = true;
  h.video.dispatch('play');
  assert.equal(h.paintCount(), 0);
  h.video.ended = false;
  h.video.dispatch('play');
  h.video.dispatch('play');
  assert.equal(h.paintCount(), 1);
  h.video.dispatch('pause');
  assert.equal(
    h.paintCount(),
    1,
    'Stray pause cannot override playing property',
  );
  h.tick(500);
  h.video.dispatch('seeked');
  h.video.paused = true;
  h.video.dispatch('pause');
  assert.equal(h.paintCount(), 0);
  assert.equal(h.frames.size, 1, 'Explicit redraw survives pause');
  h.flushFrames();
  h.video.paused = false;
  h.video.dispatch('play');
  h.tick(500);
  h.video.ended = true;
  h.video.dispatch('ended');
  assert.equal(h.paintCount(), 0);
  assert.equal(h.frames.size, 0);
  h.renderer.stop();
});

test('paused seek preserves fractional history and actual/config resize requests an opaque ready frame', async () => {
  const h = fixture();
  await h.start();
  h.tick(1000);
  h.flushFrames();
  assert.deepEqual(
    h.draws.map((draw) => draw.alpha),
    [1],
  );
  const originalWrites = h.canvas().resizeWrites;
  h.video.dispatch('seeked');
  h.flushFrames();
  assert.equal(h.draws.at(-1)?.alpha, 0.5);
  assert.equal(h.canvas().resizeWrites, originalWrites);
  h.configure({ opacity: 0.7 });
  h.flushFrames();
  assert.equal(h.draws.at(-1)?.alpha, 0.5);
  assert.equal(h.canvas().resizeWrites, originalWrites);
  h.configure({ quality: 2 });
  assert.equal(h.frames.size, 1);
  h.flushFrames();
  assert.equal(h.draws.at(-1)?.alpha, 1);
  assert.equal(h.canvas().width, 2);
  h.video.readyState = 0;
  h.configure({ quality: 3 });
  assert.equal(h.frames.size, 0);
  const count = h.draws.length;
  for (let n = 0; n < 10; n++) h.flushFrames();
  assert.equal(h.draws.length, count);
  h.video.readyState = 2;
  h.video.dispatch('loadeddata');
  h.flushFrames();
  assert.equal(h.draws.at(-1)?.alpha, 1);
  h.video.width = 8;
  h.video.dispatch('resize');
  h.flushFrames();
  assert.equal(h.draws.at(-1)?.alpha, 1);
  assert.equal(h.canvas().height, 1);
  h.renderer.stop();
});

test('completed stop disconnects observer and retires held callbacks without removing foreign nodes', async () => {
  const h = fixture({ paused: false });
  await h.start();
  h.tick(1000);
  const observer = h.observers[0],
    fallback = [...h.intervals.values()].find(
      (timer) => timer.delay === 1000,
    )!.fn;
  const frame = [...h.frames.values()][0];
  h.tick(500);
  const periodic = [...h.intervals.values()].find(
    (timer) => timer.delay === 500,
  )!.fn;
  const listeners = [...h.video.held(), ...h.songVideo.held()];
  h.renderer.stop();
  assert.equal(
    observer.active,
    false,
    'Actual stop must disconnect its observer',
  );
  assert.equal(h.intervals.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.video.listenerCount(), 0);
  assert.equal(h.songVideo.listenerCount(), 0);
  assert.equal(h.renderer.unregister, null);
  assert.equal(h.renderer.update, null);
  const nodes = h.nodes.length,
    draws = h.draws.length;
  observer.callback([{ type: 'attributes' }]);
  fallback();
  frame?.();
  periodic();
  for (const callback of listeners) callback();
  assert.equal(h.nodes.length, nodes);
  assert.equal(h.draws.length, draws);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.wrapper.children.has(h.foreign), true);
  h.renderer.stop();
});

test('same-session replacement rejects old attachment handles and same-source restart reinjects', async () => {
  const h = fixture({ paused: false });
  await h.start();
  h.tick(1000);
  h.tick(500);
  const old = h.canvas(),
    cleanup = h.renderer.unregister!,
    update = h.renderer.update!,
    frame = [...h.frames.values()][0];
  const oldListeners = [...h.video.held(), ...h.songVideo.held()];
  h.observers[0].deliver();
  const current = h.canvas();
  assert.notEqual(current, old);
  const draws = h.draws.length,
    writes = old.resizeWrites,
    currentCleanup = h.renderer.unregister;
  frame();
  cleanup();
  update();
  for (const callback of oldListeners) callback();
  assert.equal(h.draws.length, draws, 'Retired attachment frame stays inert');
  assert.equal(old.resizeWrites, writes);
  assert.equal(current.isConnected, true);
  assert.equal(h.renderer.unregister, currentCleanup);
  assert.equal(h.paintCount(), 1);
  assert.equal(h.frames.size, 1);
  h.flushFrames();
  h.renderer.stop();
  await h.start();
  h.tick(1000);
  assert.equal(h.canvas().isConnected, true);
  assert.notEqual(h.canvas(), current);
  assert.equal(h.paintCount(), 1);
  h.renderer.stop();
  h.state.videoMode = false;
  await h.start();
  h.tick(1000);
  assert.equal([...h.songImage.children].length, 1);
  h.renderer.stop();
  assert.equal(h.songImage.children.size, 0);
  assert.equal(h.wrapper.children.has(h.foreign), true);
});

test('raw await completions are defensively retired without canceling helper promises or newer sessions', async () => {
  for (const phase of ['config', 'video']) {
    const h = fixture({
      delayConfig: phase === 'config',
      delayVideo: phase === 'video',
    });
    const pending = h.start();
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await flush();
    h.renderer.stop();
    await flush();
    assert.equal(settled, false, 'Stop does not cancel the uncancellable wait');
    h.configGate.resolve(h.config);
    h.videoGate.resolve(h.video);
    await pending;
    assert.equal(
      h.observers.length,
      0,
      'Late raw start cannot publish observer',
    );
    assert.equal(h.intervals.size, 0);
    assert.equal(h.nodes.length, 0);
  }
  const h = fixture({ delayConfig: true });
  const old = h.start();
  await flush();
  await h.start(() => Promise.resolve(h.config));
  h.tick(1000);
  const current = h.canvas();
  h.configGate.resolve(h.config);
  await old;
  assert.equal(h.observers.length, 1);
  assert.equal(current.isConnected, true);
  assert.equal(h.canvas(), current);
  assert.equal(h.paintCount(), 0);
  h.renderer.stop();
});

test('replacement claims before cleanup reentry', async () => {
  const h = fixture({ paused: false });
  await h.start();
  h.tick(1000);
  const old = h.canvas();
  old.onRemove = () => {
    old.onRemove = null;
    h.observers[0].deliver();
  };
  h.observers[0].deliver();
  assert.equal(
    [...h.wrapper.children].filter((node) => node.tag === 'canvas').length,
    1,
    'Cleanup reentry cannot strand an intermediate canvas',
  );
  assert.equal(h.paintCount(), 1);
  h.renderer.stop();
});

test('ready zero geometry preserves initial and explicit draw eligibility', async () => {
  for (const paused of [true, false]) {
    const h = fixture({ paused });
    h.video.width = 0;
    h.video.height = 0;
    await h.start();
    h.tick(1000);
    assert.equal(
      h.frames.size,
      1,
      'Ready zero-geometry owner retains initial request',
    );
    assert.equal(h.paintCount(), paused ? 0 : 1);
    h.flushFrames();
    assert.deepEqual(
      h.draws.map((draw) => draw.alpha),
      [1],
    );
    h.video.dispatch('seeked');
    h.flushFrames();
    assert.equal(h.draws.at(-1)?.alpha, 0.5);
    h.renderer.stop();
  }
});
