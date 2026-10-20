import { test, expect } from '@playwright/test';
import vm from 'node:vm';
import {
  normalize,
  computeDattorroParams,
} from '../src/plugins/player-actions/slowed-reverb/engine';
import { DATTORRO_WORKLET_SOURCE } from '../src/plugins/player-actions/slowed-reverb/worklet';
import { playerActionsFixture } from './helpers/player-actions-fixture';

// A saved pre-tone config must retain its speed/intensity while gaining safe wet defaults.
test('legacy reverb settings gain wet tone defaults and invalid cutoffs are bounded', () => {
  expect(normalize({ slow: 0.85, reverbIntensity: 0.7 })).toEqual({
    slow: 0.85,
    reverbIntensity: 0.7,
    wetHighpass: 180,
    wetLowpass: 6500,
  });
  expect(normalize({ wetHighpass: -5, wetLowpass: 100000 })).toMatchObject({
    wetHighpass: 20,
    wetLowpass: 20000,
  });
  expect(normalize({ wetHighpass: Infinity, wetLowpass: 'bad' })).toMatchObject(
    { wetHighpass: 180, wetLowpass: 6500 },
  );
  expect(normalize({ wetHighpass: 10000, wetLowpass: 10 })).toMatchObject({
    wetHighpass: 1000,
    wetLowpass: 1000,
  });
});

function tailEnergy(params: ReturnType<typeof computeDattorroParams>) {
  let Processor: any;
  vm.runInNewContext(DATTORRO_WORKLET_SOURCE, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { onmessage: null };
    },
    registerProcessor: (_name: string, ctor: any) => {
      Processor = ctor;
    },
  });
  const dsp = new Processor();
  dsp.handleMessage({ type: 'setParams', params });
  let energy = 0;
  for (let block = 0; block < 1125; block++) {
    const input = new Float32Array(128);
    if (block === 0) input[0] = 0.25;
    const left = new Float32Array(128),
      right = new Float32Array(128);
    dsp.process([[input, input]], [[left, right]]);
    for (const sample of [...left, ...right]) energy += sample * sample;
  }
  return energy;
}

test('the maximum produces a substantially stronger tail than the former maximum', () => {
  const former = { ...computeDattorroParams(1), decay: 0.58, wetGain: 0.42 };
  expect(tailEnergy(computeDattorroParams(1))).toBeGreaterThan(
    tailEnergy(former) * 4,
  );
  expect(computeDattorroParams(0).wetGain).toBe(0);
  for (const intensity of [0.25, 0.5, 0.75]) {
    expect(tailEnergy(computeDattorroParams(intensity))).toBeLessThan(
      tailEnergy(computeDattorroParams(intensity + 0.25)),
    );
  }
});

test('wet filters share the EQ master route and teardown preserves the EQ insert', async () => {
  const f = await playerActionsFixture();
  try {
    const graph = f.graph('tone');
    const eqInput = graph.audioContext.createGain(),
      eqOutput = graph.audioContext.createGain();
    eqInput.connect(eqOutput);
    const releaseEq = graph.audioGraph.insertMaster(eqInput, eqOutput);
    f.announce(graph);
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: {
          active: true,
          slow: 0.85,
          reverbIntensity: 1,
          wetHighpass: 300,
          wetLowpass: 4500,
        },
      }),
      setConfig: async () => {},
    });
    f.loads[0].resolve();
    await f.settle();
    const c = r.slowedReverb;
    expect(c.wetHighpass.type).toBe('highpass');
    expect(c.wetLowpass.type).toBe('lowpass');
    expect(c.wetHighpass.frequency.value).toBe(300);
    expect(c.wetLowpass.frequency.value).toBe(4500);
    expect(c.reverbNode.connections).toEqual(new Set([c.wetHighpass]));
    expect(c.wetHighpass.connections).toEqual(new Set([c.wetLowpass]));
    expect(c.wetLowpass.connections).toEqual(new Set([c.wetGain]));
    expect(c.wetGain.connections).toEqual(
      new Set([graph.audioGraph.masterInput]),
    );
    expect(graph.audioGraph.masterInput.connections).toEqual(
      new Set([eqInput]),
    );
    expect(graph.audioGraph.dryInput.connections).toEqual(
      new Set([graph.audioGraph.masterInput]),
    );
    const oldFilters = [c.wetHighpass, c.wetLowpass];
    r.onConfigChange({
      ...r.getCurrent(),
      slowedReverb: {
        ...r.getCurrent().slowedReverb,
        wetHighpass: 600,
        wetLowpass: 3000,
      },
    });
    expect(c.wetHighpass).toBe(oldFilters[0]);
    expect(c.wetHighpass.frequency.value).toBe(600);
    expect(c.wetLowpass.frequency.value).toBe(3000);
    r.stop();
    for (const filter of oldFilters) expect(filter.connections.size).toBe(0);
    expect(c.wetHighpass).toBeNull();
    expect(c.wetLowpass).toBeNull();
    expect(graph.audioGraph.masterInput.connections).toEqual(
      new Set([eqInput]),
    );
    expect(eqOutput.connections).toEqual(new Set([graph.audioGraph.musicGate]));
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
    releaseEq();
  } finally {
    await f.close();
  }
});

test('wet tone controls persist on commit, reset defaults, and flush pending wheel edits', async () => {
  const f = await playerActionsFixture();
  const writes: any[] = [];
  try {
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({ ...f.source.plugin.config, enabled: true }),
      setConfig: async (patch) => {
        writes.push(patch);
      },
    });
    const find = (name: string) =>
      r.slowedReverb.section.root.querySelector(
        `[aria-label="plugins.slowed-reverb.panel.${name}"]`,
      ) as HTMLInputElement;
    const high = find('wet-highpass'),
      low = find('wet-lowpass');
    expect(high).not.toBeNull();
    expect(low).not.toBeNull();
    high.value = '350';
    high.dispatchEvent(new f.dom.Event('input'));
    expect(r.slowedReverb.getCurrent().wetHighpass).toBe(350);
    expect(writes).toHaveLength(0);
    high.dispatchEvent(new f.dom.Event('change'));
    await f.settle();
    expect(writes.at(-1).slowedReverb.wetHighpass).toBe(350);
    low.dispatchEvent(new f.dom.WheelEvent('wheel', { deltaY: -1 }));
    const wheelValue = Number(low.value);
    expect(wheelValue).toBeGreaterThan(6500);
    r.stop();
    await f.settle();
    expect(writes.at(-1).slowedReverb.wetLowpass).toBe(wheelValue);
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: {
          ...f.source.plugin.config.slowedReverb,
          wetHighpass: 500,
          wetLowpass: 3000,
        },
      }),
      setConfig: async (patch) => {
        writes.push(patch);
      },
    });
    (
      r.slowedReverb.section.root.querySelector('button') as HTMLButtonElement
    ).click();
    await f.settle();
    expect(r.getCurrent().slowedReverb).toMatchObject({
      wetHighpass: 180,
      wetLowpass: 6500,
    });
    expect(writes.at(-1).slowedReverb).toMatchObject({
      wetHighpass: 180,
      wetLowpass: 6500,
    });
  } finally {
    await f.close();
  }
});

// An explicit graph can be announced by another renderer module instance; its
// source must become canonical before consumers request the source-only fallback.
test('an explicitly announced graph remains canonical for source-only fallback', async () => {
  const f = await playerActionsFixture();
  try {
    const registered = f.graph('announcer');
    const source = new registered.audioSource.constructor(
      registered.audioContext,
      'external-source',
    );
    source.mediaElement = f.media;
    source.connect(registered.audioGraph.dryInput);
    const announced = { ...registered.audioGraph, audioSource: source };
    f.announce({
      audioContext: registered.audioContext,
      audioSource: source,
      audioGraph: announced,
    });
    expect(
      f.source.graphFromAnnouncement({
        audioContext: registered.audioContext,
        audioSource: source,
      }),
    ).toBe(announced);
    expect(source.connections).toEqual(new Set([announced.dryInput]));
  } finally {
    await f.close();
  }
});

test('silencing during module load retires wet filters and re-engagement builds only one owned branch', async () => {
  const f = await playerActionsFixture();
  try {
    const graph = f.graph('pending-tone');
    f.announce(graph);
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 1 },
      }),
      setConfig: async () => {},
    });
    const c = r.slowedReverb;
    const firstFilters = [c.wetHighpass, c.wetLowpass];
    r.onConfigChange({
      ...r.getCurrent(),
      slowedReverb: { ...r.getCurrent().slowedReverb, reverbIntensity: 0 },
    });
    for (const filter of firstFilters) expect(filter.connections.size).toBe(0);
    expect(c.wetHighpass).toBeNull();
    f.loads[0].resolve();
    await f.settle();
    expect(c.reverbNode).toBeNull();
    for (let i = 0; i < 5; i++) {
      r.onConfigChange({
        ...r.getCurrent(),
        slowedReverb: { ...r.getCurrent().slowedReverb, reverbIntensity: 1 },
      });
      await f.settle();
      expect(
        f.nodes.filter(
          (node) => node.kind === 'biquad' && node.connections.size,
        ),
      ).toHaveLength(2);
      expect(graph.audioSource.connections).toEqual(
        new Set([graph.audioGraph.dryInput, graph.unrelated, c.reverbNode]),
      );
      r.onConfigChange({
        ...r.getCurrent(),
        slowedReverb: { ...r.getCurrent().slowedReverb, reverbIntensity: 0 },
      });
      expect(
        f.nodes.filter(
          (node) => node.kind === 'biquad' && node.connections.size,
        ),
      ).toHaveLength(0);
    }
    expect(f.loads).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('worklet connection failure retires both wet filters without releasing the EQ master insert', async () => {
  const f = await playerActionsFixture();
  try {
    const graph = f.graph('failed-tone');
    const eqInput = graph.audioContext.createGain(),
      eqOutput = graph.audioContext.createGain();
    eqInput.connect(eqOutput);
    const releaseEq = graph.audioGraph.insertMaster(eqInput, eqOutput);
    graph.audioContext.failWorkletConnection = true;
    f.announce(graph);
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 1 },
      }),
      setConfig: async () => {},
    });
    f.loads[0].resolve();
    await f.settle();
    expect(r.slowedReverb.wetHighpass).toBeNull();
    expect(r.slowedReverb.wetLowpass).toBeNull();
    expect(
      f.nodes.filter((node) => node.kind === 'biquad' && node.connections.size),
    ).toHaveLength(0);
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
    expect(graph.audioGraph.masterInput.connections).toEqual(
      new Set([eqInput]),
    );
    expect(eqOutput.connections).toEqual(new Set([graph.audioGraph.musicGate]));
    releaseEq();
  } finally {
    await f.close();
  }
});
