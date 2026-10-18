import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

import { test } from '@playwright/test';
import { ts } from 'ts-morph';

type Callback = () => void;
type Config = { enabled: boolean; type: 'butterchurn' | 'vudio' | 'wave' };
type AudioEvent = { detail: { audioContext: Context; audioSource: Source } };
type Listener = (event: AudioEvent) => void | Promise<void>;
type Renderer = {
  onPlayerApiReady: (
    api: null,
    context: { getConfig: () => Promise<Config> },
  ) => unknown;
  onConfigChange: (config: Config) => void;
  stop?: Callback;
};
type Plugin = { config: Config; renderer: Renderer };
class Canvas {
  id = '';
  width = 300;
  height = 150;
  connected = false;
  constructor(readonly container: Container) {}
  remove() {
    this.connected = false;
    this.container.nodes.delete(this);
  }
}
class Container {
  readonly nodes = new Set<Canvas>();
  prepend(canvas: Canvas) {
    canvas.connected = true;
    this.nodes.add(canvas);
  }
}
class Video {
  readyState = 4;
  captureStream() {
    return {};
  }
}
class Context {
  state: 'running' | 'suspended' | 'closed' = 'running';
  createGain() {
    return { gain: { value: 1 } };
  }
}
class Source {
  readonly edges = new Set<object>();
  disconnects = 0;
  constructor(
    public context: Context,
    public mediaElement: Video | null,
  ) {}
  connect(node: object) {
    this.edges.add(node);
  }
  disconnect(node: object) {
    this.disconnects++;
    this.edges.delete(node);
  }
}
type Graph = { audioContext: Context; audioSource: Source };
type Record = {
  type: Config['type'];
  canvas: Canvas;
  context: Context;
  source?: Source;
  renders: number;
  resizes: number;
  destroys: number;
};
const source = (path: string) =>
  readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const strip = (raw: string) =>
  stripTypeScriptTypes(raw, { mode: 'transform' }).replace(
    /^import[\s\S]*?;\n/gm,
    '',
  );
function variable(path: string, name: string) {
  const raw = source(path),
    sf = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true);
  const statement = sf.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (decl) => ts.isIdentifier(decl.name) && decl.name.text === name,
      ),
  );
  assert(statement, name);
  return strip(statement.getText(sf).replace(/^export /, ''));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}
function fixture(foreign = false) {
  const container = new Container(),
    video = new Video(),
    context = new Context(),
    audioSource = new Source(context, video);
  const state: {
    video: Video | null;
    container: Container | null;
    graph: Graph | null;
  } = { video, container, graph: null };
  const frames = new Map<number, Callback>(),
    listeners = new Set<Listener>(),
    records: Record[] = [],
    observers: Observer[] = [],
    canvases: Canvas[] = [];
  let serial = 0;
  class Observer {
    active = false;
    constructor(readonly callback: Callback) {
      observers.push(this);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
  }
  if (foreign) {
    const canvas = new Canvas(container);
    canvas.id = 'visualizer';
    container.prepend(canvas);
    canvases.push(canvas);
  }
  class StubVisualizer {
    readonly record: Record;
    constructor(
      ctx: Context,
      readonly audioSource: Source,
      canvas: Canvas,
      readonly node: object,
    ) {
      this.record = {
        type: 'vudio',
        canvas,
        context: ctx,
        source: audioSource,
        renders: 0,
        resizes: 0,
        destroys: 0,
      };
      records.push(this.record);
    }
    resize() {
      this.record.resizes++;
    }
    destroy() {
      this.record.destroys++;
      this.audioSource.disconnect(this.node);
    }
  }
  class WaveStub extends StubVisualizer {
    constructor(...args: ConstructorParameters<typeof StubVisualizer>) {
      super(...args);
      this.record.type = 'wave';
    }
  }
  const environment = {
    console: { log() {}, error() {}, trace() {} },
    performance: { now: () => 0 },
    LoggerPrefix: 'test',
    t: (key: string) => key,
    createPlugin: (value: unknown) => value,
    emptyStyle: '',
    getCurrentAudioGraph: () => state.graph,
    Butterchurn: {
      createVisualizer: (ctx: Context, canvas: Canvas) => {
        const record: Record = {
          type: 'butterchurn',
          canvas,
          context: ctx,
          renders: 0,
          resizes: 0,
          destroys: 0,
        };
        records.push(record);
        return {
          render: () => {
            record.renders++;
          },
          loadPreset() {},
          connectAudio() {},
          setRendererSize: () => {
            record.resizes++;
          },
        };
      },
    },
    ButterchurnPresets: {},
    vudio: StubVisualizer,
    wave: WaveStub,
    requestAnimationFrame: (fn: Callback) => {
      const id = ++serial;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: Observer,
    window: { getComputedStyle: () => ({ width: '640', height: '360' }) },
    document: {
      adoptedStyleSheets: [],
      querySelector: (selector: string) =>
        selector === 'video'
          ? state.video
          : selector === '#player'
            ? state.container
            : selector === '#visualizer'
              ? ([...container.nodes].find(
                  (canvas) => canvas.id === 'visualizer',
                ) ?? null)
              : null,
      createElement: (tag: string) => {
        assert.equal(tag, 'canvas');
        const canvas = new Canvas(container);
        canvases.push(canvas);
        return canvas;
      },
      addEventListener: (name: string, fn: Listener) => {
        assert.equal(name, 'peard:audio-can-play');
        listeners.add(fn);
      },
      removeEventListener: (name: string, fn: Listener) => {
        assert.equal(name, 'peard:audio-can-play');
        listeners.delete(fn);
      },
    },
    createContext: () => ({}),
    pluginStyleMap: { visualizer: [] },
    loadedPluginMap: {} as { visualizer?: Plugin },
  };
  const host = vm.createContext(environment);
  // Complete actual plugin/base/Butterchurn source and actual framework functions;
  // every DOM, audio, library and scheduling primitive is injected, never native.
  vm.runInContext(
    strip(source('src/plugins/visualizer/visualizers/visualizer.ts')).replace(
      /^export /gm,
      '',
    ),
    host,
  );
  vm.runInContext(
    strip(source('src/plugins/visualizer/visualizers/butterchurn.ts')).replace(
      'export default ButterchurnVisualizer;',
      '',
    ) + '\nconst butterchurn=ButterchurnVisualizer;',
    host,
  );
  vm.runInContext(
    strip(source('src/plugins/visualizer/index.ts')).replace(
      'export default createPlugin(',
      'globalThis.plugin=createPlugin(',
    ),
    host,
  );
  vm.runInContext(
    variable('src/utils/index.ts', 'stopPlugin') +
      '\n' +
      variable('src/loader/renderer.ts', 'unloadRendererPlugin') +
      '\nglobalThis.unload=unloadRendererPlugin;',
    host,
  );
  const plugin = host.plugin as Plugin,
    unload = host.unload as (id: string) => Promise<void>;
  let config: Config = { ...plugin.config, enabled: true };
  const ready = (getConfig = () => Promise.resolve(config)) => {
    environment.loadedPluginMap.visualizer = plugin;
    return plugin.renderer.onPlayerApiReady(null, { getConfig });
  };
  const announce = (ctx = context, src = audioSource) =>
    Promise.all(
      [...listeners].map((fn) =>
        Promise.resolve(
          fn({ detail: { audioContext: ctx, audioSource: src } }),
        ),
      ),
    );
  const configure = (patch: Partial<Config>) => {
    config = { ...config, ...patch };
    plugin.renderer.onConfigChange(config);
  };
  return {
    plugin,
    ready,
    announce,
    configure,
    unload: () => unload('visualizer'),
    stop: () => plugin.renderer.stop?.(),
    state,
    video,
    context,
    audioSource,
    container,
    frames,
    listeners,
    records,
    observers,
    canvases,
    get config() {
      return config;
    },
    get loaded() {
      return environment.loadedPluginMap.visualizer !== undefined;
    },
    liveObservers: () => observers.filter((observer) => observer.active).length,
  };
}

test('actual completed framework unload retires active Butterchurn and held callbacks', async () => {
  const h = fixture();
  h.ready();
  await h.announce();
  const frame = [...h.frames.values()][0],
    resize = h.observers[0].callback,
    audio = [...h.listeners][0];
  assert.equal(h.frames.size, 1);
  assert.equal(h.liveObservers(), 1);
  const foreignListener: Listener = () => {};
  const foreignEdge = {};
  h.listeners.add(foreignListener);
  h.audioSource.edges.add(foreignEdge);
  await h.unload();
  assert.equal(h.loaded, false);
  assert.equal(
    h.frames.size,
    0,
    'Completed framework unload must cancel actual Butterchurn RAF',
  );
  assert.equal(h.liveObservers(), 0);
  assert.equal(h.listeners.size, 1);
  assert.equal(h.listeners.has(foreignListener), true);
  assert.equal(h.audioSource.edges.has(foreignEdge), true);
  assert.equal(h.audioSource.disconnects, 1);
  assert.equal(h.container.nodes.size, 0);
  frame();
  resize();
  await audio({
    detail: { audioContext: h.context, audioSource: h.audioSource },
  });
  assert.equal(h.records[0].renders, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.records.length, 1);
  h.stop();
  h.stop();
  assert.equal(h.audioSource.disconnects, 1);
});

test('readiness replacement and config reconstruction retain exact created canvas and retire observers before early returns', async () => {
  const h = fixture();
  h.ready();
  await h.announce();
  const canvas = h.canvases[0];
  const oldResize = h.observers[0].callback;
  h.configure({ type: 'vudio' });
  assert.equal(h.liveObservers(), 1);
  const resizeCount = h.records[1].resizes;
  canvas.width = 123;
  oldResize();
  assert.equal(canvas.width, 123);
  assert.equal(h.records[1].resizes, resizeCount);
  assert.equal(h.canvases.length, 1);
  assert.equal(canvas.connected, true);
  h.configure({ type: 'wave' });
  assert.equal(h.records[1].destroys, 1);
  h.state.video = null;
  h.configure({ type: 'vudio' });
  assert.equal(h.liveObservers(), 0);
  assert.equal(h.records[2].destroys, 1);
  h.state.video = h.video;
  h.configure({ type: 'vudio' });
  h.state.container = null;
  h.configure({ type: 'wave' });
  assert.equal(h.liveObservers(), 0);
  h.state.container = h.container;
  h.configure({ type: 'vudio' });
  h.configure({ enabled: false });
  assert.equal(h.liveObservers(), 0);
  h.ready();
  assert.equal(h.listeners.size, 1);
  assert.equal(canvas.connected, false);
  h.stop();
  const repeated = fixture();
  repeated.ready();
  await repeated.announce();
  repeated.ready();
  assert.equal(repeated.listeners.size, 1);
  assert.equal(repeated.frames.size, 0);
  assert.equal(repeated.audioSource.disconnects, 1);
  assert.equal(repeated.canvases[0].connected, false);
  await repeated.announce();
  assert.equal(repeated.records.length, 2);
  repeated.stop();
  for (const record of h.records.filter((item) => item.type !== 'butterchurn'))
    assert.equal(record.destroys, 1);
  const foreign = fixture(true);
  foreign.ready();
  await foreign.announce();
  const foreignCanvas = foreign.canvases[0];
  foreign.stop();
  assert.equal(foreignCanvas.connected, true);
  assert.equal(foreign.container.nodes.size, 1);
});

test('audio await stop/new-owner and same-owner A/B reversal cannot overwrite current construction', async () => {
  const h = fixture(),
    gate = deferred<Config>();
  h.ready(() => gate.promise);
  const old = h.announce();
  h.stop();
  h.ready();
  assert.equal(
    h.listeners.size,
    1,
    'New lifetime must replace old listener before event dispatch',
  );
  await h.announce();
  const count = h.records.length;
  gate.resolve({ ...h.config, type: 'wave' });
  await old;
  assert.equal(h.records.length, count);
  assert.equal(h.records.at(-1)?.type, 'butterchurn');
  assert.equal(h.listeners.size, 1);
  h.stop();
  const v = fixture(),
    a = deferred<Config>(),
    b = deferred<Config>();
  let calls = 0;
  v.ready(() => (++calls === 1 ? a.promise : b.promise));
  const eventA = v.announce(),
    contextB = new Context(),
    sourceB = new Source(contextB, v.video),
    eventB = v.announce(contextB, sourceB);
  b.resolve({ ...v.config, type: 'vudio' });
  await eventB;
  a.resolve({ ...v.config, type: 'wave' });
  await eventA;
  assert.equal(v.records.length, 1);
  assert.equal(v.records[0].context, contextB);
  assert.equal(v.records[0].type, 'vudio');
  v.stop();
});

test('config during audio await uses synchronously admitted refs and supersedes awaited config', async () => {
  const h = fixture(),
    gate = deferred<Config>();
  h.ready(() => gate.promise);
  const pending = h.announce();
  h.configure({ type: 'wave' });
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].context, h.context);
  gate.resolve({ ...h.config, type: 'vudio' });
  await pending;
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].type, 'wave');
  h.stop();
});

test('hot-enable bootstraps current ready graph synchronously admitted with a nonawaited hook', async () => {
  for (const readyState of [2, 3, 4]) {
    const h = fixture(),
      gate = deferred<Config>();
    h.video.readyState = readyState;
    h.context.state = 'suspended';
    h.state.graph = { audioContext: h.context, audioSource: h.audioSource };
    assert.equal(
      h.ready(() => gate.promise),
      undefined,
    );
    assert.equal(h.listeners.size, 1);
    h.configure({ type: 'vudio' });
    assert.equal(
      h.records.length,
      1,
      'Current config can use immediately admitted bootstrap refs',
    );
    gate.resolve({ ...h.config, type: 'wave' });
    await flush();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].type, 'vudio');
    h.stop();
    h.ready();
    await flush();
    assert.equal(
      h.records.length,
      2,
      'Hot re-enable does not need another audio announcement',
    );
    h.stop();
  }
});

test('bootstrap completion tolerates readiness drop and rejects changed graph/source/video/context snapshots', async () => {
  const h = fixture(),
    gate = deferred<Config>();
  h.state.graph = { audioContext: h.context, audioSource: h.audioSource };
  h.ready(() => gate.promise);
  h.video.readyState = 3;
  gate.resolve(h.config);
  await flush();
  assert.equal(
    h.records.length,
    1,
    'Readiness drop after admission must not strand valid bootstrap',
  );
  h.video.readyState = 4;
  assert.equal(h.records.length, 1);
  h.stop();
  for (const mutation of [
    'graph',
    'source',
    'video',
    'context',
    'sourceContext',
    'mediaElement',
    'closed',
  ]) {
    const v = fixture(),
      config = deferred<Config>(),
      graph = { audioContext: v.context, audioSource: v.audioSource };
    v.state.graph = graph;
    v.ready(() => config.promise);
    if (mutation === 'graph') v.state.graph = { ...graph };
    if (mutation === 'source')
      graph.audioSource = new Source(v.context, v.video);
    if (mutation === 'video') v.state.video = new Video();
    if (mutation === 'context') graph.audioContext = new Context();
    if (mutation === 'sourceContext') v.audioSource.context = new Context();
    if (mutation === 'mediaElement') v.audioSource.mediaElement = new Video();
    if (mutation === 'closed') v.context.state = 'closed';
    config.resolve(v.config);
    await flush();
    assert.equal(v.records.length, 0, mutation);
    v.stop();
  }
});

test('initial unready/absent/mismatched/closed graph waits for existing audio announcements', async () => {
  for (const reason of [
    'zero',
    'one',
    'absent',
    'missingVideo',
    'video',
    'sourceContext',
    'closed',
  ]) {
    const h = fixture();
    const graph = { audioContext: h.context, audioSource: h.audioSource };
    h.state.graph = graph;
    if (reason === 'zero') h.video.readyState = 0;
    if (reason === 'one') h.video.readyState = 1;
    if (reason === 'absent') h.state.graph = null;
    if (reason === 'missingVideo') h.state.video = null;
    if (reason === 'video')
      graph.audioSource = new Source(h.context, new Video());
    if (reason === 'sourceContext')
      graph.audioSource = new Source(new Context(), h.video);
    if (reason === 'closed') {
      graph.audioContext = new Context();
      graph.audioContext.state = 'closed';
    }
    h.ready();
    await flush();
    assert.equal(h.records.length, 0, reason);
    assert.equal(h.listeners.size, 1);
    h.state.video = h.video;
    await h.announce();
    assert.equal(
      h.records.length,
      1,
      'Existing announcement path remains functional',
    );
    h.stop();
  }
});

test('bootstrap await is superseded by real announcements, config changes and a restarted lifetime', async () => {
  const h = fixture(),
    gate = deferred<Config>();
  h.state.graph = { audioContext: h.context, audioSource: h.audioSource };
  let bootstrapPhase = true;
  h.ready(() =>
    bootstrapPhase
      ? gate.promise
      : Promise.resolve({ ...h.config, type: 'vudio' }),
  );
  bootstrapPhase = false;
  const nextContext = new Context(),
    nextSource = new Source(nextContext, h.video);
  await h.announce(nextContext, nextSource);
  gate.resolve({ ...h.config, type: 'wave' });
  await flush();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].context, nextContext);
  assert.equal(h.records[0].type, 'vudio');
  h.stop();
  const v = fixture(),
    old = deferred<Config>();
  v.state.graph = { audioContext: v.context, audioSource: v.audioSource };
  v.ready(() => old.promise);
  v.stop();
  v.ready();
  await flush();
  old.resolve({ ...v.config, type: 'wave' });
  await flush();
  assert.equal(v.records.length, 1);
  assert.equal(v.records[0].type, 'butterchurn');
  assert.equal(v.listeners.size, 1);
  v.stop();
});

test('bootstrap pending video replacement cannot construct via explicit config or reuse rejected refs', async () => {
  const h = fixture(),
    gate = deferred<Config>();
  h.state.graph = { audioContext: h.context, audioSource: h.audioSource };
  h.ready(() => gate.promise);
  h.state.video = new Video();
  h.configure({ type: 'vudio' });
  assert.equal(
    h.records.length,
    0,
    'Explicit config must validate admitted bootstrap source/video',
  );
  gate.resolve({ ...h.config, type: 'wave' });
  await flush();
  h.state.video = h.video;
  h.configure({ type: 'vudio' });
  assert.equal(
    h.records.length,
    0,
    'Invalidated refs must remain retired when the old snapshot returns',
  );
  await h.announce();
  assert.equal(
    h.records.length,
    1,
    'A fresh announcement replaces retired admission',
  );
  h.stop();
});

test('rejected unavailable bootstrap refs cannot be resurrected by a later config', async () => {
  const h = fixture(),
    gate = deferred<Config>();
  const graph = { audioContext: h.context, audioSource: h.audioSource };
  h.state.graph = graph;
  h.ready(() => gate.promise);
  h.state.graph = null;
  gate.resolve(h.config);
  await flush();
  assert.equal(h.records.length, 0);
  h.configure({ type: 'vudio' });
  assert.equal(
    h.records.length,
    0,
    'Later config must not reuse rejected bootstrap refs',
  );
  h.state.graph = graph;
  h.configure({ type: 'vudio' });
  assert.equal(
    h.records.length,
    0,
    'Rejected refs must be retired rather than waiting for predicate recovery',
  );
  h.state.graph = null;
  const context = new Context(),
    source = new Source(context, h.video);
  await h.announce(context, source);
  assert.equal(
    h.records.length,
    1,
    'Real announcement must replace the previous bootstrap predicate',
  );
  assert.equal(h.records[0].context, context);
  h.stop();
});

test('closed bootstrap context cannot construct through config while config acquisition is pending', async () => {
  const h = fixture(),
    gate = deferred<Config>();
  h.state.graph = { audioContext: h.context, audioSource: h.audioSource };
  h.ready(() => gate.promise);
  h.context.state = 'closed';
  h.configure({ type: 'vudio' });
  assert.equal(
    h.records.length,
    0,
    'Explicit config must reject closed admitted bootstrap context',
  );
  gate.resolve(h.config);
  await flush();
  h.configure({ type: 'wave' });
  assert.equal(h.records.length, 0);
  const context = new Context(),
    source = new Source(context, h.video);
  await h.announce(context, source);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].context, context);
  h.stop();
});
