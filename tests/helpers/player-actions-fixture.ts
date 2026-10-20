import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { Window, PropertySymbol } from 'happy-dom';

const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

export async function playerActionsFixture({ nativeTimers = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-player-actions-'));
  const dom = new Window({ url: 'https://fixture.invalid/' });
  dom.document.body.innerHTML =
    '<ytmusic-app-layout><ytmusic-player-bar><div class="volume-container"><div id="volume-slider"></div></div></ytmusic-player-bar></ytmusic-app-layout><div id="movie_player"><video></video></div><ytmusic-popup-container><ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer></ytmusic-popup-container>';
  const globals = globalThis as any;
  const keys = [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLVideoElement',
    'MutationObserver',
    'CustomEvent',
    'Event',
    'AudioWorkletNode',
  ];
  const saved = new Map(keys.map((key) => [key, globals[key]]));
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  const activeObservers = new Set<unknown>();
  const listenerSets = new Map<string, Set<unknown>>();
  const loads: {
    url: string;
    resolve: () => void;
    reject: (err: unknown) => void;
  }[] = [];
  const nodes: any[] = [];
  const speedControls: any[] = [];
  let speedDisposals = 0;
  const rateEvents: any[] = [];
  const trackedMedia = new WeakSet<object>();
  let serial = 0;
  const key = `playerActions_${crypto.randomUUID()}`;
  const clock = {
    setInterval: (fn: () => void, ms: number) => {
      const id = ++serial;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++serial;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: number) => timeouts.delete(id),
  };
  (clock as any).speedControls = speedControls;
  (clock as any).disposed = () => speedDisposals++;
  globals[key] = clock;
  class Observer extends dom.MutationObserver {
    private callbacks = new Set<unknown>();
    observe(target: any, options: any) {
      super.observe(target, options);
      activeObservers.add(this);
      for (const listener of target[PropertySymbol.mutationListeners]) {
        const fn = listener.callback.deref();
        if (fn) this.callbacks.add(fn);
      }
    }
    disconnect() {
      super.disconnect();
      activeObservers.delete(this);
      this.callbacks.clear();
    }
  }
  (dom as unknown as { MutationObserver: typeof Observer }).MutationObserver =
    Observer;
  const nativeAdd = dom.document.addEventListener.bind(dom.document) as (
    ...args: any[]
  ) => void;
  const nativeRemove = dom.document.removeEventListener.bind(dom.document) as (
    ...args: any[]
  ) => void;
  (dom.document as any).addEventListener = (
    type: string,
    fn: any,
    opts: any,
  ) => {
    if (!listenerSets.has(type)) listenerSets.set(type, new Set());
    listenerSets.get(type)!.add(fn);
    nativeAdd(type, fn, opts);
  };
  (dom.document as any).removeEventListener = (
    type: string,
    fn: any,
    opts: any,
  ) => {
    listenerSets.get(type)?.delete(fn);
    nativeRemove(type, fn, opts);
  };
  class Node {
    connections = new Set<any>();
    gain = {
      value: 1,
      cancelScheduledValues() {
        return this;
      },
      setValueAtTime(value: number) {
        this.value = value;
        return this;
      },
    };
    frequency = { value: 350 };
    Q = { value: 1 };
    type = 'lowpass';
    messages: any[] = [];
    portClosed = false;
    port = {
      postMessage: (value: any) => this.messages.push(value),
      close: () => {
        this.portClosed = true;
      },
    };
    constructor(
      public context?: any,
      public kind = 'node',
    ) {
      nodes.push(this);
    }
    connect(target: any) {
      if (this.kind === 'worklet' && this.context.failWorkletConnection)
        throw new Error('fixture worklet connect failure');
      this.connections.add(target);
      return target;
    }
    disconnect(target?: any) {
      if (target) this.connections.delete(target);
      else this.connections.clear();
    }
  }
  class Worklet extends Node {
    constructor(context: any) {
      super(context, 'worklet');
    }
  }
  Object.assign(globals, {
    window: dom,
    document: dom.document,
    Node: dom.Node,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLVideoElement: dom.HTMLVideoElement,
    MutationObserver: Observer,
    CustomEvent: dom.CustomEvent,
    Event: dom.Event,
    AudioWorkletNode: Worklet,
  });
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `export {default as plugin} from ${JSON.stringify(path.join(root, 'src/plugins/player-actions/index.ts'))};export {createSectionRepeatController} from ${JSON.stringify(path.join(root, 'src/plugins/player-actions/section-repeat/controller.ts'))};export {createSlowedReverbController} from ${JSON.stringify(path.join(root, 'src/plugins/player-actions/slowed-reverb/controller.ts'))};export * from '@/providers/renderer-audio';export * from '@/plugins/utils/renderer/player-panel';export * from '@/plugins/utils/renderer/playback-rate-owner';export {createAdSpeedup} from ${JSON.stringify(path.join(root, 'src/plugins/adblocker/ad-speedup.ts'))};export * as playbackSpeed from ${JSON.stringify(path.join(root, 'src/plugins/playback-speed/renderer.tsx'))};export {default as playbackSpeedPlugin} from ${JSON.stringify(path.join(root, 'src/plugins/playback-speed/index.ts'))};`,
  );
  const output = path.join(directory, 'actual.cjs');
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    define: nativeTimers
      ? {}
      : Object.fromEntries(
          Object.keys(clock).map((name) => [
            name,
            `globalThis[${JSON.stringify(key)}].${name}`,
          ]),
        ),
    plugins: [
      solid(),
      {
        name: 'controlled-player-native-boundaries',
        enforce: 'pre',
        async resolveId(id: string, importer?: string) {
          if (id === 'solid-js')
            return requireRoot
              .resolve('solid-js/dist/solid.js')
              .replaceAll('\\', '/');
          if (id === 'solid-js/web')
            return requireRoot
              .resolve('solid-js/web/dist/web.js')
              .replaceAll('\\', '/');
          if (
            id === './components/slider' &&
            importer
              ?.replaceAll('\\', '/')
              .endsWith('/plugins/playback-speed/renderer.tsx')
          )
            return '\0speed-slider';
          if (id === '@/plugins/utils/renderer/check') return '\0speed-check';
          if (id === '@/providers/dom-elements') return '\0song-menu';
          if (['@/i18n', '@/utils', '@/providers/song-info-front'].includes(id))
            return '\0' + id;
          if (id.endsWith('?inline')) return '\0css';
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            for (const suffix of ['.ts', '.tsx', '/index.ts']) {
              try {
                await access(target + suffix);
                return (target + suffix).replaceAll('\\', '/');
              } catch {
                /* next */
              }
            }
          }
          if (
            !id.startsWith('.') &&
            !path.isAbsolute(id) &&
            !id.startsWith('\0')
          )
            return {
              id: requireRoot.resolve(id).replaceAll('\\', '/'),
              external: true,
            };
          return undefined;
        },
        load(id: string) {
          if (id === '\0song-menu')
            return "export const getSongMenu=()=>document.querySelector('ytmusic-menu-popup-renderer');";
          if (id === '\0speed-check')
            return 'export const isMusicOrVideoTrack=()=>true;export const isPlayerMenu=()=>true;';
          if (id === '\0speed-slider')
            return `import {createRenderEffect,onCleanup} from 'solid-js';export const PlaybackSpeedSlider=props=>{globalThis[${JSON.stringify(key)}].speedControls.push(props);const node=document.createElement('div');createRenderEffect(()=>node.dataset.speed=String(props.speed));onCleanup(()=>globalThis[${JSON.stringify(key)}].disposed());return node;};`;
          if (id === '\0@/i18n') return 'export const t=key=>key;';
          if (id === '\0@/utils')
            return 'export const createPlugin=value=>value;';
          if (id === '\0@/providers/song-info-front')
            return 'export const getSongInfo=()=>({});';
          if (id === '\0css') return 'export default "";';
          return undefined;
        },
        generateBundle() {
          const identities = [...this.getModuleIds()].filter((id) =>
            id.replaceAll('\\', '/').endsWith('/playback-rate-owner.ts'),
          );
          if (identities.length !== 1)
            this.error(
              `Expected one playback rate owner, found ${identities.length}`,
            );
        },
      },
    ],
    build: {
      write: true,
      emptyOutDir: false,
      outDir: directory,
      minify: false,
      lib: { entry, formats: ['cjs'], fileName: () => 'actual.cjs' },
    },
  });
  const source = requireRoot(output);
  function video() {
    const media = dom.document.querySelector('video')! as any;
    if (!trackedMedia.has(media)) {
      trackedMedia.add(media);
      let rate = media.playbackRate;
      Object.defineProperty(media, 'playbackRate', {
        configurable: true,
        get: () => rate,
        set: (value: number) => {
          if (value === rate) return;
          rate = value;
          rateEvents.push(media);
        },
      });
    }
    Object.defineProperty(media, 'duration', {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(media, 'paused', {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(media, 'preservesPitch', {
      configurable: true,
      writable: true,
      value: true,
    });
    return media;
  }
  const media = video();
  const graph = (id: string) => {
    const context: any = {
      id,
      destination: { id: 'destination-' + id },
      state: 'running',
      sampleRate: 48000,
      currentTime: 0,
      addEventListener() {},
      removeEventListener() {},
      createGain: () => new Node(context, 'gain'),
      createBiquadFilter: () => new Node(context, 'biquad'),
      audioWorklet: {
        addModule: (url: string) => {
          const d = deferred();
          loads.push({ url, resolve: () => d.resolve(), reject: d.reject });
          return d.promise;
        },
      },
    };
    const audioSource: any = new Node(context, 'source');
    audioSource.id = id;
    audioSource.mediaElement = dom.document.querySelector('video');
    audioSource.connect(context.destination);
    const unrelated = new Node(context, 'unrelated');
    audioSource.connect(unrelated);
    const audioGraph = source.initializeAudioGraph(context, audioSource);
    return { audioContext: context, audioSource, unrelated, audioGraph };
  };
  return {
    dom,
    source,
    media,
    video,
    graph,
    loads,
    nodes,
    speedControls,
    get speedDisposals() {
      return speedDisposals;
    },
    drainRates: (limit = 30) => {
      let count = 0;
      while (rateEvents.length && count++ < limit)
        rateEvents.shift().dispatchEvent(new dom.Event('ratechange'));
      return rateEvents.length;
    },
    intervals,
    timeouts,
    activeObservers,
    listenerSets,
    api: (id: string) => ({
      getPlayerResponse: () => ({ videoDetails: { videoId: id } }),
      getVideoData: () => ({ video_id: id }),
    }),
    announce: (detail: any) =>
      dom.document.dispatchEvent(
        new dom.CustomEvent('peard:audio-can-play', { detail }),
      ),
    tick: (ms: number) => {
      for (const timer of [...intervals.values()])
        if (timer.ms === ms) timer.fn();
    },
    flush: (ms: number) => {
      for (const [id, timer] of [...timeouts])
        if (timer.ms === ms) {
          timeouts.delete(id);
          timer.fn();
        }
    },
    settle: async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await dom.happyDOM.whenAsyncComplete();
    },
    close: async () => {
      if (speedControls.length) {
        try {
          source.playbackSpeed.onUnload();
        } catch {
          /* Tests can assert unload failure separately. */
        }
      }
      source.plugin.renderer.stop();
      for (const load of loads) load.resolve();
      for (let i = 0; i < 8; i++) await Promise.resolve();
      intervals.clear();
      timeouts.clear();
      delete requireRoot.cache[output];
      delete globals[key];
      await dom.happyDOM.close();
      await rm(directory, { recursive: true, force: true });
      for (const [name, value] of saved) {
        if (value === undefined) delete globals[name];
        else globals[name] = value;
      }
    },
  };
}
