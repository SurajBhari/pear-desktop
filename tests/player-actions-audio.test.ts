import { test, expect } from '@playwright/test';
import vm from 'node:vm';
import { DATTORRO_WORKLET_SOURCE } from '../src/plugins/player-actions/slowed-reverb/worklet';
import { computeDattorroParams } from '../src/plugins/player-actions/slowed-reverb/engine';
import { playerActionsFixture } from './helpers/player-actions-fixture';

function processor(sampleRate: number) {
  let Processor: any;
  vm.runInNewContext(DATTORRO_WORKLET_SOURCE, {
    sampleRate,
    AudioWorkletProcessor: class {
      port = { onmessage: null };
    },
    registerProcessor: (_name: string, value: any) => {
      Processor = value;
    },
  });
  return new Processor();
}

for (const rate of [8000, 44100, 48000, 96000])
  for (const intensity of [0, 0.05, 0.5, 1])
    test(`actual worklet impulse stays finite and bounded at ${rate} Hz intensity ${intensity}`, () => {
      const dsp = processor(rate);
      const params = computeDattorroParams(intensity);
      dsp.handleMessage({ type: 'setParams', params });
      const input = new Float32Array(128);
      input[0] = 1;
      const right = new Float32Array(128);
      right[0] = -0.5;
      let peak = 0;
      let finite = true;
      for (let block = 0; block < Math.ceil(rate / 128); block++) {
        const leftOut = new Float32Array(128),
          rightOut = new Float32Array(128);
        expect(dsp.process([[input, right]], [[leftOut, rightOut]])).toBe(true);
        for (const sample of [...leftOut, ...rightOut]) {
          finite = finite && Number.isFinite(sample);
          peak = Math.max(peak, Math.abs(sample));
        }
        input.fill(0);
        right.fill(0);
      }
      expect(finite).toBe(true);
      expect(peak).toBeLessThanOrEqual(params.wetGain + 0.000001);
      if (intensity === 0) expect(peak).toBe(0);
    });

test('the actual processor returns false after an explicit owned dispose message', () => {
  const dsp = processor(48000);
  dsp.handleMessage({ type: 'dispose' });
  expect(
    dsp.process(
      [[new Float32Array(128)]],
      [[new Float32Array(128), new Float32Array(128)]],
    ),
  ).toBe(false);
});

test('a wet-node connection failure rolls back the local source edge and closes the owned port', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const graph = f.graph('fail');
  graph.audioContext.failWorkletConnection = true;
  f.announce(graph);
  try {
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 0.5 },
      }),
      setConfig: async () => {},
    });
    f.loads[0].resolve();
    await f.settle();
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
    const node = f.nodes.find((n) => n.kind === 'worklet');
    expect(node.portClosed).toBe(true);
    expect(node.messages.some((m: any) => m.type === 'dispose')).toBe(true);
    expect(r.slowedReverb.reverbNode).toBeNull();
  } finally {
    await f.close();
  }
});

test('normal disable retires processor/port and leaves existing dry and unrelated graph edges', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const graph = f.graph('release');
  f.announce(graph);
  try {
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 0.5 },
      }),
      setConfig: async () => {},
    });
    f.loads[0].resolve();
    await f.settle();
    const node = r.slowedReverb.reverbNode;
    r.stop();
    expect(node.portClosed).toBe(true);
    expect(node.messages.some((m: any) => m.type === 'dispose')).toBe(true);
    expect(node.connections.size).toBe(0);
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
  } finally {
    await f.close();
  }
});

test('native offline worklet adds one wet route while original output remains intact', async ({
  page,
}) => {
  await page.route('https://audio.fixture.invalid/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>Owned audio fixture</body></html>',
    }),
  );
  await page.goto('https://audio.fixture.invalid/');
  const result = await page.evaluate(
    async ({ source, params }) => {
      const context = new OfflineAudioContext(2, 48000, 48000);
      // Instrument only the native message boundary; inherited DSP/process code
      // remains the actual production processor. Await parameter delivery before
      // offline rendering, which can finish before a normal queued port message.
      const instrumented = source + `class ReadyDattorro extends DattorroReverbProcessor {handleMessage(data){super.handleMessage(data);if(data.type==='setParams')this.port.postMessage('ready')}};registerProcessor('fixture-dattorro',ReadyDattorro);`;
      const blob = new Blob([instrumented], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const buffer = context.createBuffer(2, 48000, 48000);
      buffer.getChannelData(0)[0] = 0.25;
      buffer.getChannelData(1)[0] = -0.125;
      const input = context.createBufferSource();
      input.buffer = buffer;
      input.connect(context.destination);
      const wet = new AudioWorkletNode(context, 'fixture-dattorro', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const ready = new Promise<void>((resolve) => {wet.port.onmessage=event=>{if(event.data==='ready')resolve();};});
      wet.port.postMessage({ type: 'setParams', params });
      await ready;
      input.connect(wet);
      wet.connect(context.destination);
      input.start();
      const output = await context.startRendering();
      const left = output.getChannelData(0),
        right = output.getChannelData(1);
      const first = [left[0], right[0]];
      const finite = [...left, ...right].every(Number.isFinite);
      const tail = left.slice(128).some((value) => Math.abs(value) > 0.0000001);
      input.disconnect(wet);
      wet.port.postMessage({ type: 'dispose' });
      wet.disconnect();
      wet.port.close();
      return { first, finite, tail, state: context.state };
    },
    { source: DATTORRO_WORKLET_SOURCE, params: computeDattorroParams(0.5) },
  );
  expect(result.first).toEqual([0.25, -0.125]);
  expect(result.finite).toBe(true);
  expect(result.tail).toBe(true);
  expect(result.state).toBe('closed');
});
