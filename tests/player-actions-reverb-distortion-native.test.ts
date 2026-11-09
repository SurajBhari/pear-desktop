/* oxlint-disable typescript/no-explicit-any, @stylistic/no-mixed-operators */
import { test, expect } from '@playwright/test';

import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { reverbNativeSource } from './helpers/reverb-native-source';

let bundle: string;
test.beforeAll(async () => {
  bundle = await equalizerBundle(`
    export {DATTORRO_WORKLET_SOURCE} from '@/plugins/player-actions/slowed-reverb/worklet';
    export {computeDattorroParams} from '@/plugins/player-actions/slowed-reverb/engine';
  `);
});

test('native reverb remains linear and controls tank resonance at 35/40/100 percent', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const render = async (
      intensity: number,
      amplitude: number,
      frequency = 1000,
    ) => {
      const rate = 48000,
        seconds = 6;
      const context = new OfflineAudioContext(2, rate * seconds, rate);
      let source = f.DATTORRO_WORKLET_SOURCE;
      source = source.replace(
        "registerProcessor('dattorro-reverb', DattorroReverbProcessor);",
        "class Ready extends DattorroReverbProcessor {handleMessage(data){super.handleMessage(data);if(data.type==='setParams')this.port.postMessage('ready')}};registerProcessor('dattorro-reverb',Ready);",
      );
      const url = URL.createObjectURL(
        new Blob([source], { type: 'application/javascript' }),
      );
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(context, 'dattorro-reverb', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const ready = new Promise<void>(
        (resolve) =>
          (node.port.onmessage = (e) => {
            if (e.data === 'ready') resolve();
          }),
      );
      node.port.postMessage({
        type: 'setParams',
        params: f.computeDattorroParams(intensity),
      });
      await ready;
      const input = context.createBufferSource(),
        buffer = context.createBuffer(2, rate * seconds, rate);
      for (let c = 0; c < 2; c++)
        for (let i = 0; i < rate * 3; i++)
          buffer.getChannelData(c)[i] =
            amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
      input.buffer = buffer;
      input.connect(node);
      node.connect(context.destination);
      input.start();
      const audio = await context.startRendering();
      let energy = 0,
        peak = 0,
        mixPeak = 0,
        late = 0,
        harmonics = 0,
        fundamental = 0;
      const samples = audio.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        peak = Math.max(peak, Math.abs(x));
        if (i >= rate && i < rate * 3) {
          energy += x * x;
          mixPeak = Math.max(
            mixPeak,
            Math.abs(x + buffer.getChannelData(0)[i]),
          );
        }
        if (i >= rate * 5) late += x * x;
      }
      for (let h = 1; h <= 10; h++) {
        let re = 0,
          im = 0;
        for (let i = rate * 2; i < rate * 3; i++) {
          re += samples[i] * Math.cos((2 * Math.PI * 1000 * h * i) / rate);
          im += samples[i] * Math.sin((2 * Math.PI * 1000 * h * i) / rate);
        }
        const power = re * re + im * im;
        if (h === 1) fundamental = power;
        else harmonics += power;
      }
      node.port.close();
      return {
        samples: Array.from(samples),
        peak,
        mixPeak,
        rms: Math.sqrt(energy / (rate * 2)),
        late,
        thd: Math.sqrt(harmonics / fundamental),
      };
    };
    const rows = [];
    for (const intensity of [0.35, 0.4, 1]) {
      const low = await render(intensity, 0.09),
        high = await render(intensity, 0.9);
      let error = 0,
        energy = 0;
      for (let i = 0; i < high.samples.length; i++) {
        error += (high.samples[i] - low.samples[i] * 10) ** 2;
        energy += high.samples[i] ** 2;
      }
      const highStats = {
        peak: high.peak,
        mixPeak: high.mixPeak,
        rms: high.rms,
        late: high.late,
        thd: high.thd,
      };
      rows.push({
        intensity,
        high: highStats,
        nonlinearity: Math.sqrt(error / energy),
      });
    }
    const scan = [];
    for (const frequency of [
      20, 30, 40, 60, 80, 100, 150, 180, 250, 400, 600, 1000, 2000, 4000, 6500,
      10000, 15000, 20000,
    ]) {
      const v = await render(1, 0.99, frequency);
      scan.push({ frequency, peak: v.peak, rms: v.rms, mix: v.mixPeak });
    }
    return {
      rows,
      scan,
    };
  });
  console.log(JSON.stringify(result));
  for (const row of result.rows) {
    expect(row.nonlinearity).toBeLessThan(0.001);
    expect(row.high.thd).toBeLessThan(0.001);
  }
  expect(Math.max(...result.scan.map((x) => x.peak))).toBeLessThan(2);
});

test('native full-scale dry+wet mix has output headroom without a limiter', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, await equalizerBundle(reverbNativeSource));
  const rows = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rows = [];
    for (const intensity of [0.35, 0.4, 1])
      for (const volume of [1, 0.02])
        for (const eq of ['off', 'flat', 'boost'])
          rows.push({
            intensity,
            volume,
            eq,
            ...(await f.renderReverbStress({
              intensity,
              volume,
              eq,
              frequency: 600,
              changes: true,
            })),
          });
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThan(1);
    expect(row.sameNode).toBe(true);
    expect(row.wetConnections).toBe(1);
    expect(row.liveEdges).toBe(2);
    expect(row.retiredEdges).toBe(1);
    expect(row.late).toBeLessThan(row.tail * 0.01);
    if (row.volume === 0.02) expect(row.gain).toBe(1);
    if (row.eq === 'flat') expect(row.preamp).toBe(0);
    if (row.eq === 'boost' && row.volume === 1)
      expect(row.preamp).toBeCloseTo(-18.1, 3);
  }
});

test('native full-scale music, pink noise, transients and tone extremes keep stable clean output', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, await equalizerBundle(reverbNativeSource));
  const rows = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rows = [];
    for (const kind of ['music', 'pink', 'impulse'])
      for (const [highpass, lowpass] of [
        [20, 20000],
        [1000, 1000],
      ])
        for (const intensity of [0.35, 0.4, 1])
          rows.push({
            kind,
            highpass,
            lowpass,
            intensity,
            ...(await f.renderReverbStress({
              kind,
              highpass,
              lowpass,
              intensity,
              changes: true,
            })),
          });
    for (const frequency of [
      20, 40, 80, 180, 250, 400, 1000, 2000, 4000, 6500, 10000, 15000, 20000,
    ])
      rows.push({
        frequency,
        ...(await f.renderReverbStress({
          frequency,
          highpass: 20,
          lowpass: 20000,
        })),
      });
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThan(1);
    expect(row.late).toBeLessThan(row.tail * 0.01);
    expect(row.sameNode).toBe(true);
    expect(row.wetConnections).toBe(1);
    expect(row.retiredEdges).toBe(1);
  }
  const openMusic = rows.filter(
    (row) => row.kind === 'music' && row.highpass === 20,
  );
  expect(openMusic.find((row) => row.intensity === 1)!.tail).toBeGreaterThan(
    openMusic.find((row) => row.intensity === 0.35)!.tail * 3,
  );
});
