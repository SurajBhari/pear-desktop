import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { deepmergeCustom } from 'deepmerge-ts';

const deepmerge = deepmergeCustom({ mergeArrays: false });

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const device = (deviceId: string, label = deviceId, kind = 'audiooutput') => ({
  deviceId,
  label,
  kind,
});
const settle = async () => {
  for (let n = 0; n < 6; n++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-output-fixture-'));
  const dom = new Window({ url: 'https://fixture.invalid/' });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(
    ['window', 'document', 'navigator', 'CustomEvent'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globals, key),
    ]),
  );
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    CustomEvent: dom.CustomEvent,
  }))
    Object.defineProperty(globals, key, { configurable: true, value });
  let devices = [device('default'), device('A'), device('B')];
  let microphoneRequests = 0;
  let enumerationCalls = 0;
  let enumeration = async () => devices;
  const media = new dom.EventTarget() as any;
  media.enumerateDevices = () => {
    enumerationCalls++;
    return enumeration();
  };
  media.getUserMedia = async () => {
    microphoneRequests++;
    return { getTracks: () => [] };
  };
  Object.defineProperty(dom.navigator, 'mediaDevices', {
    configurable: true,
    value: media,
  });
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `
export {renderer} from ${JSON.stringify(path.join(root, 'src/plugins/custom-output-device/renderer.ts'))};
export {initializeAudioGraph,getCurrentAudioGraph} from ${JSON.stringify(path.join(root, 'src/providers/renderer-audio.ts'))};
`,
  );
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const build = await rolldown({
    input: entry,
    platform: 'node',
    plugins: [
      {
        name: 'public-renderer-boundaries',
        async resolveId(id: string) {
          if (id === '@/utils') return '\0utils';
          if (id === '@/i18n') return '\0i18n';
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            for (const suffix of ['.ts', '/index.ts']) {
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
            return { id: requireRoot.resolve(id), external: true };
        },
        load(id: string) {
          if (id === '\0utils')
            return 'export const createRenderer=(renderer)=>renderer;';
          if (id === '\0i18n')
            return 'export const t=(key,values)=>key+(values?.number ?? "");';
        },
      },
    ],
  });
  const output = path.join(directory, 'fixture.mjs');
  await build.write({ file: output, format: 'esm' });
  await build.close();
  const source = await import(pathToFileURL(output).href);
  let config: any = { enabled: true, output: 'A', devices: { stale: 'Stale' } };
  let read = async () => structuredClone(config);
  const writes: any[] = [];
  let write = async (patch: any) => {
    config = deepmerge(config, patch);
  };
  const context: any = {
    getConfig: () => read(),
    setConfig: async (patch: any) => {
      writes.push(structuredClone(patch));
      await write(patch);
    },
    ipc: {},
  };
  const contexts: any[] = [];
  const audio = (initialSink = '') => {
    const ctx = new dom.EventTarget() as any;
    ctx.state = 'running';
    ctx.sinkId = initialSink;
    ctx.destination = {};
    ctx.createGain = () => ({
      connect() {},
      disconnect() {},
      gain: { value: 1 },
    });
    ctx.calls = [];
    ctx.setSinkId = async (id: string) => {
      ctx.calls.push(id);
      ctx.sinkId = id;
    };
    const node = {
      context: ctx,
      connect() {},
      disconnect() {},
      mediaElement: dom.document.createElement('video'),
    };
    ctx.graph = () => source.initializeAudioGraph(ctx, node);
    ctx.announce = () =>
      dom.document.dispatchEvent(
        new dom.CustomEvent('peard:audio-can-play', {
          detail: {
            audioContext: ctx,
            audioSource: node,
            audioGraph: source.getCurrentAudioGraph(),
          },
        }),
      );
    ctx.closeFixture = () => {
      ctx.state = 'closed';
      ctx.dispatchEvent(new dom.Event('statechange'));
    };
    contexts.push(ctx);
    return ctx;
  };
  return {
    source,
    dom,
    media,
    context,
    writes,
    audio,
    get config() {
      return config;
    },
    get microphoneRequests() {
      return microphoneRequests;
    },
    get enumerationCalls() {
      return enumerationCalls;
    },
    setDevices(value: any[]) {
      devices = value;
    },
    setEnumeration(value: typeof enumeration) {
      enumeration = value;
    },
    setRead(value: typeof read) {
      read = value;
    },
    setWrite(value: typeof write) {
      write = value;
    },
    async start() {
      // Run the actual old readiness entry point in RED; corrected source owns start.
      if (source.renderer.start) await source.renderer.start(context);
      else await source.renderer.onPlayerApiReady({}, context);
    },
    async change(patch: any) {
      config = deepmerge(config, patch);
      await source.renderer.onConfigChange(structuredClone(config));
    },
    emitDevices() {
      media.dispatchEvent(new dom.Event('devicechange'));
      void media.ondevicechange?.(new dom.Event('devicechange'));
    },
    async dispose() {
      await source.renderer.stop(context);
      await settle();
      for (const ctx of contexts) ctx.closeFixture();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globals, key, descriptor);
        else delete globals[key];
      }
      await dom.happyDOM.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('start enumerates before media readiness without requesting microphone permission and replaces stale maps', async () => {
  const f = await fixture();
  try {
    expect(typeof f.source.renderer.start).toBe('function');
    await f.start();
    await settle();
    expect(f.microphoneRequests).toBe(0);
    expect(f.config.devices).toEqual({ default: 'default', A: 'A', B: 'B' });
  } finally {
    await f.dispose();
  }
});

test('late enable uses the actual canonical graph without an announcement or a second context', async () => {
  const f = await fixture();
  try {
    const audio = f.audio();
    const graph = audio.graph();
    await f.start();
    await settle();
    expect(audio.calls).toEqual(['A']);
    expect(f.source.getCurrentAudioGraph()).toBe(graph);
  } finally {
    await f.dispose();
  }
});

test('closed and stale announcements never replace the canonical current context', async () => {
  const f = await fixture();
  try {
    const retired = f.audio();
    retired.graph();
    retired.closeFixture();
    const active = f.audio();
    active.graph();
    await f.start();
    retired.announce();
    active.announce();
    await settle();
    expect(retired.calls).toEqual([]);
    expect(active.calls).toEqual(['A']);
  } finally {
    await f.dispose();
  }
});

test('stop while initial config is pending cannot attach, enumerate, or route later', async () => {
  const f = await fixture();
  try {
    const config = deferred<any>();
    f.setRead(() => config.promise);
    const pending = f.start();
    await f.source.renderer.stop(f.context);
    config.resolve({ enabled: true, output: 'A', devices: {} });
    await pending;
    f.emitDevices();
    await settle();
    expect(f.enumerationCalls).toBe(0);
    expect(f.microphoneRequests).toBe(0);
    expect(f.writes).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('a newer config wins over delayed initial config and device-map writes never overwrite output', async () => {
  const f = await fixture();
  try {
    const audio = f.audio();
    audio.graph();
    const config = deferred<any>();
    f.setRead(() => config.promise);
    const pending = f.start();
    await f.change({ output: 'B' });
    config.resolve({ enabled: true, output: 'A', devices: {} });
    await pending;
    await settle();
    expect(audio.sinkId).toBe('B');
    expect(f.config.output).toBe('B');
    expect(f.writes.every((patch) => !Object.hasOwn(patch, 'output'))).toBe(
      true,
    );
  } finally {
    await f.dispose();
  }
});

test('devicechange snapshots are serialized and only the latest snapshot replaces the map', async () => {
  const f = await fixture();
  try {
    await f.start();
    await settle();
    const enumeration = deferred<any[]>();
    let active = 0;
    let maximum = 0;
    let round = 0;
    f.setEnumeration(async () => {
      maximum = Math.max(maximum, ++active);
      const result =
        ++round === 1
          ? await enumeration.promise
          : [device('default'), device('B')];
      active--;
      return result;
    });
    f.emitDevices();
    f.emitDevices();
    f.emitDevices();
    enumeration.resolve([device('default'), device('removed')]);
    await settle();
    expect(maximum).toBe(1);
    expect(f.config.devices).toEqual({ default: 'default', B: 'B' });
  } finally {
    await f.dispose();
  }
});

test('enumeration completion after stop cannot clear or repopulate persisted devices', async () => {
  const f = await fixture();
  try {
    await f.start();
    await settle();
    const before = f.writes.length;
    const enumeration = deferred<any[]>();
    f.setEnumeration(() => enumeration.promise);
    f.emitDevices();
    await f.source.renderer.stop(f.context);
    enumeration.resolve([device('retired')]);
    await settle();
    expect(f.writes).toHaveLength(before);
  } finally {
    await f.dispose();
  }
});

test('stop after device-map clear awaits does not publish the retired snapshot', async () => {
  const f = await fixture();
  try {
    await f.start();
    await settle();
    const clear = deferred<void>();
    f.setWrite(async (patch) => {
      if (Object.hasOwn(patch, 'devices') && patch.devices === null)
        await clear.promise;
    });
    const before = f.writes.length;
    f.emitDevices();
    await settle();
    await f.source.renderer.stop(f.context);
    clear.resolve();
    await settle();
    expect(
      f.writes.slice(before).filter((patch) => patch.devices !== null),
    ).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('disappeared selected device uses default, preserves preference and returns when available', async () => {
  const f = await fixture();
  try {
    const audio = f.audio();
    audio.graph();
    await f.start();
    await settle();
    f.setDevices([device('default'), device('B')]);
    f.emitDevices();
    await settle();
    expect(audio.sinkId).toBe('');
    expect(f.config.output).toBe('A');
    expect(f.config.deviceStatus).toBe('unavailable');
    f.setDevices([device('default'), device('A')]);
    f.emitDevices();
    await settle();
    expect(audio.sinkId).toBe('A');
    expect(f.config.deviceStatus).toBeNull();
  } finally {
    await f.dispose();
  }
});

test('serialized sink awaits reconcile newest config rather than finishing backwards', async () => {
  const f = await fixture();
  try {
    const audio = f.audio();
    audio.graph();
    const sink = deferred<void>();
    let inFlight = 0;
    let maximum = 0;
    audio.setSinkId = async (id: string) => {
      audio.calls.push(id);
      maximum = Math.max(maximum, ++inFlight);
      if (id === 'A') await sink.promise;
      audio.sinkId = id;
      inFlight--;
    };
    await f.start();
    await settle();
    const changed = f.change({ output: 'B' });
    await settle();
    sink.resolve();
    await changed;
    await settle();
    expect(maximum).toBe(1);
    expect(audio.sinkId).toBe('B');
  } finally {
    await f.dispose();
  }
});

test('stop during sink await restores the original route once the uncancellable call settles', async () => {
  const f = await fixture();
  try {
    const audio = f.audio('original');
    audio.graph();
    const sink = deferred<void>();
    audio.setSinkId = async (id: string) => {
      audio.calls.push(id);
      if (id === 'A') await sink.promise;
      audio.sinkId = id;
    };
    await f.start();
    await settle();
    const stopped = f.source.renderer.stop(f.context);
    sink.resolve();
    await stopped;
    await settle();
    expect(audio.sinkId).toBe('original');
    expect(audio.calls).toEqual(['A', 'original']);
  } finally {
    await f.dispose();
  }
});

test('a new session after an old pending sink owns the latest route and keeps the original restoration target', async () => {
  const f = await fixture();
  try {
    const audio = f.audio('original');
    audio.graph();
    const sink = deferred<void>();
    audio.setSinkId = async (id: string) => {
      audio.calls.push(id);
      if (id === 'A') await sink.promise;
      audio.sinkId = id;
    };
    await f.start();
    await settle();
    const stopped = f.source.renderer.stop(f.context);
    await f.change({ output: 'B' });
    await f.start();
    sink.resolve();
    await stopped;
    await settle();
    expect(audio.sinkId).toBe('B');
    await f.source.renderer.stop(f.context);
    await settle();
    expect(audio.sinkId).toBe('original');
  } finally {
    await f.dispose();
  }
});

test('repeated start owns one listener and stop preserves another devicechange subscriber', async () => {
  const f = await fixture();
  try {
    let other = 0;
    const listener = () => other++;
    f.media.addEventListener('devicechange', listener);
    await f.start();
    await f.start();
    await settle();
    const before = f.enumerationCalls;
    f.emitDevices();
    await settle();
    expect(f.enumerationCalls - before).toBe(1);
    await f.source.renderer.stop(f.context);
    const stopped = f.enumerationCalls;
    f.emitDevices();
    await settle();
    expect(f.enumerationCalls).toBe(stopped);
    expect(other).toBe(2);
  } finally {
    await f.dispose();
  }
});

test('hidden labels have usable generic options and do not trigger microphone access', async () => {
  const f = await fixture();
  try {
    f.setDevices([
      device('default', ''),
      device('A', ''),
      device('input', '', 'audioinput'),
    ]);
    await f.start();
    await settle();
    expect(f.config.devices.A).toBeTruthy();
    expect(f.config.devices.input).toBeUndefined();
    expect(f.config.deviceStatus).toBe('limited');
    expect(f.microphoneRequests).toBe(0);
  } finally {
    await f.dispose();
  }
});

test('own clear/map watcher echoes do not restart an identical pending publication', async () => {
  const f = await fixture();
  try {
    let echoes = 0;
    f.setWrite(async () => {
      if (++echoes <= 8)
        f.source.renderer.onConfigChange(structuredClone(f.config));
    });
    await f.start();
    await settle();
    expect(f.writes).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test('unsupported sink routing and denied sink permission are contained and reported', async () => {
  for (const supported of [false, true]) {
    const f = await fixture();
    try {
      const audio = f.audio();
      audio.graph();
      if (supported)
        audio.setSinkId = async () => {
          throw new DOMException('Fixture denial', 'NotAllowedError');
        };
      else delete audio.setSinkId;
      await f.start();
      audio.announce();
      await settle();
      expect(f.config.deviceStatus).toBe(
        supported ? 'permission' : 'unsupported',
      );
      expect(f.microphoneRequests).toBe(0);
    } finally {
      await f.dispose();
    }
  }
});

test('missing enumeration API is contained with default route and capability feedback', async () => {
  const f = await fixture();
  try {
    const audio = f.audio();
    audio.graph();
    delete f.media.enumerateDevices;
    await f.start();
    await settle();
    expect(f.config.deviceStatus).toBe('unsupported');
    expect(audio.sinkId).toBe('');
    expect(f.microphoneRequests).toBe(0);
  } finally {
    await f.dispose();
  }
});

test('an existing silent sink is preserved and restored instead of becoming an audible default', async () => {
  const f = await fixture();
  try {
    const audio = f.audio();
    audio.sinkId = { type: 'none' };
    audio.graph();
    await f.start();
    await settle();
    await f.source.renderer.stop(f.context);
    await settle();
    expect(audio.sinkId).toEqual({ type: 'none' });
  } finally {
    await f.dispose();
  }
});

test('a native NotFound sink failure falls back and a later successful device refresh clears the notice', async () => {
  const f = await fixture();
  try {
    const audio = f.audio();
    audio.graph();
    let missing = true;
    audio.setSinkId = async (id: string) => {
      audio.calls.push(id);
      if (missing && id === 'A')
        throw new DOMException('Fixture missing', 'NotFoundError');
      audio.sinkId = id;
    };
    await f.start();
    await settle();
    expect(audio.sinkId).toBe('');
    expect(f.config.deviceStatus).toBe('unavailable');
    missing = false;
    f.emitDevices();
    await settle();
    expect(audio.sinkId).toBe('A');
    expect(f.config.deviceStatus).toBeNull();
  } finally {
    await f.dispose();
  }
});

test('enable before canonical readiness adopts its later graph and context replacement restores only the retired route', async () => {
  const f = await fixture();
  try {
    await f.start();
    await settle();
    const first = f.audio('original');
    first.graph();
    first.announce();
    await settle();
    expect(first.sinkId).toBe('A');
    const second = f.audio('second');
    second.graph();
    second.announce();
    await settle();
    expect(first.sinkId).toBe('original');
    expect(second.sinkId).toBe('A');
    first.announce();
    await settle();
    expect(first.sinkId).toBe('original');
  } finally {
    await f.dispose();
  }
});

test('a retired in-flight device clear cannot finish after a new session publishes its map', async () => {
  const f = await fixture();
  try {
    const clear = deferred<void>();
    let first = true;
    f.setWrite(async (patch) => {
      if (first && patch.devices === null) {
        first = false;
        await clear.promise;
      }
      Object.assign(f.config, deepmerge(f.config, patch));
    });
    await f.start();
    await settle();
    await f.source.renderer.stop(f.context);
    f.setDevices([device('default'), device('B')]);
    await f.start();
    await settle();
    clear.resolve();
    await settle();
    expect(f.config.devices).toEqual({ default: 'default', B: 'B' });
  } finally {
    await f.dispose();
  }
});
