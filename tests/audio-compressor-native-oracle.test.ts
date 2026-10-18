import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

import { test } from '@playwright/test';

type Phase = 'stale' | 'lost' | 'during';
type Sample = {
  target: number;
  end: number;
  audioTime: number;
  state: string;
  sampleRate: number;
  quantum: number;
  value: number;
  wallTime: number;
};
type Call = {
  value: number;
  time: number;
  audioTime: number;
  wallTime: number;
};
type PhaseResult = {
  staleRendered?: number;
  stillLost?: number;
  duringRendered?: number;
  timingRecord: {
    wall: Sample;
    settled: Sample;
    immediate: Sample;
    guard: { before: Sample; calls: Call[] };
  };
};
type ModelGain = {
  value: number;
  cancelScheduledValues: (at: number) => void;
  setValueAtTime: (value: number, time: number) => ModelGain;
  linearRampToValueAtTime: (value: number, time: number) => ModelGain;
};
type ModelNode = {
  gain: ModelGain;
  context: { currentTime: number; sampleRate: number; state: string };
};
type ModelApi = {
  getVideoData: () => { video_id: string };
  getPlayerResponse: () => {
    videoDetails: { videoId: string };
    playerConfig: { audioConfig: { loudnessDb: number } };
  };
  addEventListener: (name: string, callback: () => void) => void;
  removeEventListener: (name: string, callback: () => void) => void;
};
type ModelTrack = {
  configure: (config: {
    enabled: boolean;
    autoTrackGain: boolean;
    maxTrackGainDb: number;
  }) => void;
  setApi: (api: ModelApi) => void;
  auxiliary: (count: number) => void;
};
type Model = {
  wall: number;
  advanceAudio: boolean;
  native: string;
  response: string;
  anchor: number;
  events: { value: number; time: number }[];
  timers: Map<number, { callback: () => void; at: number }>;
  serial: number;
  delegateReturned: boolean;
  wrongValue?: number;
  skipDispatch?: boolean;
  onDispatch?: () => void;
  node: ModelNode;
  timing: unknown;
  track: ModelTrack;
  render: (time: number) => void;
  tick: (ms: number) => Promise<void>;
  run: (phase: Phase) => Promise<PhaseResult>;
};

const fixture = readFileSync(
  new URL('./audio-compressor-native.test.ts', import.meta.url),
  'utf8',
);
const production = stripTypeScriptTypes(
  readFileSync(
    new URL('../src/plugins/audio-compressor/track-gain.ts', import.meta.url),
    'utf8',
  ).replace(/^import type .*;\n/m, ''),
  { mode: 'transform' },
).replaceAll('export ', '');
const start = fixture.indexOf('const timingFixture = `');
const end = fixture.indexOf('`;\ntest.beforeAll', start);
assert(start >= 0 && end > start);
const timingSource = fixture
  .slice(start + 'const timingFixture = `'.length, end)
  .replaceAll('export ', '');
function phaseSource(from: string, to: string) {
  const first = fixture.indexOf(from);
  const last = fixture.indexOf(to, first);
  assert(first >= 0 && last > first, 'Extract the actual native phase');
  return stripTypeScriptTypes(fixture.slice(first, last), {
    mode: 'transform',
  });
}
const phases: Record<Phase, string> = {
  stale: phaseSource('    const enabled = read();', "    response = 'B';"),
  lost: phaseSource('    const retry = read();', "    native = 'C';"),
  during: phaseSource(
    "    const aux = document.createElement('audio');",
    '    release();',
  ),
};
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};

// Explicitly synthetic queued AudioParam: a countermodel, not a reconstruction
// of the failed native run or a claim about a particular browser's getter.
function model(): Model {
  const h = {
    wall: 0,
    advanceAudio: true,
    native: 'A',
    response: 'A',
    anchor: 1,
    events: [],
    timers: new Map(),
    serial: 0,
    delegateReturned: false,
  } as Model;
  const context: ModelNode['context'] = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
  };
  const gain: ModelGain = {
    value: 1,
    cancelScheduledValues(at) {
      h.events = h.events.filter((event) => event.time < at);
    },
    setValueAtTime(value, time) {
      h.anchor = value;
      h.events.push({ value, time });
      return gain;
    },
    linearRampToValueAtTime(value, time) {
      h.events.push({ value, time });
      return gain;
    },
  };
  h.node = { gain, context };
  h.render = (audioTime) => {
    context.currentTime = audioTime;
    for (const event of h.events
      .filter((event) => event.time <= audioTime)
      .sort((a, b) => a.time - b.time))
      gain.value = Math.fround(event.value);
    if (h.wrongValue !== undefined) gain.value = h.wrongValue;
  };
  const timer = (callback: () => void, ms: number) => {
    const id = ++h.serial;
    h.timers.set(id, { callback, at: h.wall + ms });
    return id;
  };
  const env = {
    performance: { now: () => h.wall },
    setTimeout: timer,
    clearTimeout: (id: number) => h.timers.delete(id),
  };
  const source = vm.runInNewContext(
    production + '\n' + timingSource + '\n({TrackGain, observeGainTiming});',
    env,
  ) as {
    TrackGain: new (node: ModelNode) => ModelTrack;
    observeGainTiming: (node: ModelNode) => unknown;
  };
  h.timing = source.observeGainTiming(h.node);
  h.track = new source.TrackGain(h.node);
  const listeners = new Set<() => void>();
  h.track.configure({ enabled: true, autoTrackGain: true, maxTrackGainDb: 6 });
  h.track.setApi({
    getVideoData: () => ({ video_id: h.native }),
    getPlayerResponse: () => ({
      videoDetails: { videoId: h.response },
      playerConfig: { audioConfig: { loudnessDb: -6 } },
    }),
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
  });
  h.render(0.136);
  const advance = (wall: number) => {
    if (h.advanceAudio && context.state === 'running') {
      const audioDelta = (wall - h.wall) / 1000;
      h.render(context.currentTime + audioDelta);
    }
    h.wall = wall;
  };
  h.tick = async (ms) => {
    const deadline = h.wall + ms;
    for (let n = 0; n < 2000; n++) {
      const next = [...h.timers]
        .filter(([, entry]) => entry.at <= deadline)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) {
        advance(deadline);
        await flush();
        return;
      }
      const [id, entry] = next;
      h.timers.delete(id);
      advance(entry.at);
      entry.callback();
      await flush();
    }
    assert.fail('Synthetic timer bound exceeded');
  };
  h.run = (phase) => {
    let registered = false;
    const sandbox = {
      timing: h.timing,
      setTimeout: timer,
      read: () => gain.value,
      trackGain: h.node,
      gain: {},
      document: { createElement: () => ({}) },
      graph: {
        registerMedia() {
          if (registered) throw Error('duplicate synthetic registration');
          registered = true;
          h.track.auxiliary(1);
          return () => h.track.auxiliary(0);
        },
      },
      events: {
        dispatchEvent() {
          if (!h.skipDispatch) for (const listener of listeners) listener();
          h.onDispatch?.();
          h.delegateReturned = true;
        },
      },
      Event: class {},
      wait: (ms: number) => new Promise<void>((resolve) => timer(resolve, ms)),
    };
    Object.defineProperties(sandbox, {
      native: {
        get: () => h.native,
        set: (value: string) => {
          h.native = value;
        },
      },
      response: {
        get: () => h.response,
        set: (value: string) => {
          h.response = value;
        },
      },
      anchor: { get: () => h.anchor },
    });
    const fields =
      phase === 'stale'
        ? 'staleRendered, timingRecord: typeof staleTiming === "undefined" ? undefined : staleTiming'
        : phase === 'lost'
          ? 'stillLost, timingRecord: typeof lostTiming === "undefined" ? undefined : lostTiming'
          : 'duringRendered, timingRecord: typeof duringTiming === "undefined" ? undefined : duringTiming';
    return vm.runInNewContext(
      '(async () => {' + phases[phase] + '\nreturn {' + fields + '};})()',
      sandbox,
    ) as Promise<PhaseResult>;
  };
  return h;
}
function watch(promise: Promise<PhaseResult>) {
  const result: { status: string; value?: PhaseResult; error?: unknown } = {
    status: 'pending',
  };
  promise.then(
    (value) => Object.assign(result, { status: 'fulfilled', value }),
    (error: unknown) => Object.assign(result, { status: 'rejected', error }),
  );
  return result;
}

test('actual stale phase keeps the wall fence separate from an unready owned clock', async () => {
  const h = model();
  h.advanceAudio = false;
  const pending = h.run('stale');
  const state = watch(pending);
  await h.tick(20);
  assert.equal(state.status, 'pending', '20ms wall time alone cannot settle');
  h.advanceAudio = true;
  await h.tick(10);
  const result = await pending;
  assert.equal(result.staleRendered, 1);
  assert.equal(result.timingRecord.wall.wallTime, 20);
  assert.equal(result.timingRecord.wall.audioTime, 0.136);
  assert.notEqual(result.timingRecord.wall.value, 1);
  assert.equal(result.timingRecord.settled.wallTime, 30);
});

test('actual stale phase rejects a transient wrong target even if later corrected', async () => {
  const h = model();
  h.onDispatch = () => {
    h.node.gain.setValueAtTime(1.5, h.node.context.currentTime);
    h.timers.set(++h.serial, {
      at: 10,
      callback: () => h.node.gain.setValueAtTime(1, h.node.context.currentTime),
    });
  };
  const pending = h.run('stale');
  const state = watch(pending);
  await h.tick(20);
  assert.equal(h.delegateReturned, true, 'Production delegate must return');
  assert.equal(
    state.status,
    'rejected',
    'Later unity must not erase violation',
  );
  await assert.rejects(pending, /Unity phase.*target/);
});

test('first clock-qualified wrong value fails without waiting for convergence', async () => {
  const h = model();
  h.advanceAudio = false;
  const pending = h.run('stale');
  watch(pending);
  await h.tick(20);
  h.advanceAudio = true;
  h.wrongValue = 1.5;
  await h.tick(10);
  await assert.rejects(pending, /first qualified.*value/);
  h.wrongValue = undefined;
  await h.tick(10);
  assert.equal(h.node.gain.value, 1);
});

test('already qualified original wall sample must have exact unity value', async () => {
  const h = model();
  h.wrongValue = 1.5;
  const pending = h.run('stale');
  watch(pending);
  await h.tick(20);
  await assert.rejects(pending, /first qualified.*value/);
  assert.equal(h.wall, 20);
});

test('missing synchronous reset fails even when a later retry resets unity', async () => {
  const h = model();
  h.skipDispatch = true;
  h.onDispatch = () => {
    h.timers.set(++h.serial, {
      at: 10,
      callback: () => h.node.gain.setValueAtTime(1, h.node.context.currentTime),
    });
  };
  const pending = h.run('stale');
  watch(pending);
  await h.tick(20);
  await assert.rejects(pending, /immediate unity reset/);
});

test('a future-dated unity reset fails the dispatch audio-time window', async () => {
  const h = model();
  h.skipDispatch = true;
  h.onDispatch = () =>
    h.node.gain.setValueAtTime(1, h.node.context.currentTime + 0.1);
  const pending = h.run('stale');
  watch(pending);
  await h.tick(20);
  await assert.rejects(pending, /immediate unity reset/);
});

test('repeated immediate unity is allowed and valid handoff releases the guard', async () => {
  const h = model();
  h.onDispatch = () =>
    h.node.gain.setValueAtTime(1, h.node.context.currentTime);
  const pending = h.run('stale');
  await h.tick(20);
  const result = await pending;
  assert.equal(result.staleRendered, 1);
  const record = result.timingRecord;
  assert(record.guard.calls.length >= 3);
  assert(record.guard.calls.every((call) => call.value === 1));
  assert(record.immediate.end >= record.guard.before.audioTime);
  assert(record.immediate.end <= record.immediate.audioTime);
  h.response = 'B';
  await h.tick(500);
  assert.equal(h.node.gain.value, Math.fround(10 ** (6 / 20)));
  assert(record.guard.calls.every((call) => call.value === 1));
});

for (const contextState of ['running', 'suspended', 'closed']) {
  test(`unready ${contextState} context remains bounded by the original deadline`, async () => {
    const h = model();
    h.advanceAudio = false;
    h.node.context.state = contextState;
    const pending = h.run('stale');
    watch(pending);
    await h.tick(3020);
    await assert.rejects(
      pending,
      /Owned gain did not reach its scheduled audio-clock end/,
    );
    assert.equal(h.wall, 3020);
  });
}

test('lost phase keeps the full 450ms retry fence before qualification', async () => {
  const h = model();
  const pending = h.run('lost');
  const state = watch(pending);
  await h.tick(449);
  assert.equal(state.status, 'pending');
  await h.tick(1);
  const result = await pending;
  assert.equal(result.stillLost, 1);
  assert.equal(result.timingRecord.wall.wallTime, 450);
  assert.equal(result.timingRecord.settled.wallTime, 450);
  assert(result.timingRecord.guard.calls.length >= 3);
});

test('auxiliary phase uses the original wall sample and first qualified unity read', async () => {
  const h = model();
  h.advanceAudio = false;
  const pending = h.run('during');
  const state = watch(pending);
  await h.tick(20);
  assert.equal(state.status, 'pending');
  h.advanceAudio = true;
  await h.tick(10);
  const result = await pending;
  assert.equal(result.duringRendered, 1);
  assert.equal(result.timingRecord.wall.wallTime, 20);
  assert.equal(result.timingRecord.settled.wallTime, 30);
});

test('guard retains a wrong ramp between polls after its later correction', async () => {
  const h = model();
  h.advanceAudio = false;
  const pending = h.run('stale');
  watch(pending);
  await h.tick(20);
  h.timers.set(++h.serial, {
    at: 25,
    callback: () =>
      h.node.gain.linearRampToValueAtTime(1.5, h.node.context.currentTime),
  });
  h.timers.set(++h.serial, {
    at: 26,
    callback: () => h.node.gain.setValueAtTime(1, h.node.context.currentTime),
  });
  await h.tick(10);
  await assert.rejects(pending, /Unity phase.*target/);
});
