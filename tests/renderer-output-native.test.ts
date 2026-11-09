/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';

import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { reverbNativeSource } from './helpers/reverb-native-source';
let bundle: string;
test.beforeAll(async () => {
  bundle = await equalizerBundle(
    reverbNativeSource + '\nexport {initializeAudioGraph};',
  );
});

test('native output processor fault retains hot EQ safely and keeps Slow/dry audio alive', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(() =>
    (window as any).EqualizerFixture.renderReverbStress({
      kind: 'sine',
      frequency: 27,
      intensity: 1,
      volume: 1,
      eq: 'boost',
      highpass: 20,
      lowpass: 20000,
      slow: 0.85,
      failOutputAt: 1,
    }),
  );
  console.log(JSON.stringify(result));
  expect(result.finite).toBe(true);
  expect(result.peak).toBeLessThanOrEqual(1);
  expect(result.faultAudit[0]).toMatchObject({
    failed: true,
    sourceEdges: 1,
    wetRemoved: true,
    playbackRate: 0.85,
  });
  expect(result.rms).toBeGreaterThan(0.1);
  // Hot post-EQ state actually engages the degraded failure-only hard ceiling.
  expect(result.peak).toBeGreaterThan(0.99);
});

test('rapid native mute/unmute and zero-volume recovery discard pre-mute loud delayed PCM', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, bundle);
  const rows = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rows = [];
    for (const muteMode of ['muted', 'volume'])
      for (const eq of ['off', 'flat', 'boost']) {
        const options = {
          kind: 'sine',
          frequency: 27,
          intensity: 1,
          eq,
          highpass: 20,
          lowpass: 20000,
        };
        const edited = await f.renderReverbStress({
            ...options,
            muteMode,
            volume: 1,
            unmuteVolume: 0.02,
          }),
          reference = await f.renderReverbStress({ ...options, volume: 0.02 }),
          history = await f.renderReverbStress({
            ...options,
            muteMode,
            volume: 1,
            unmuteVolume: 0.02,
            referenceUnprotected: true,
          });
        rows.push({
          muteMode,
          eq,
          peak: edited.peak,
          mutedPeak: edited.mutedWindowPeak,
          windowPeak: edited.muteWindowPeak,
          historyPeak: history.muteWindowPeak,
          referencePeak: reference.peak,
          audit: edited.muteAudit,
          finite: edited.finite,
        });
      }
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThanOrEqual(Math.fround(0.99));
    expect(row.audit[0].gate).toBe(0);
    expect(row.audit[1].gate).toBe(0);
    expect(row.audit[2].gate).toBe(1);
    expect(row.mutedPeak).toBe(0);
    expect(row.windowPeak).toBeLessThanOrEqual(row.historyPeak * 1.05 + 1e-5);
    if (row.eq !== 'boost')
      expect(row.windowPeak).toBeLessThan(row.referencePeak * 1.5);
  }
});

test('native normal output is delayed identity; fault-only native guard is identity below full scale', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const rows = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rows = [];
    for (const fault of [false, true]) {
      const rate = 48000,
        context = new OfflineAudioContext(2, rate * 2 + 512, rate),
        source = context.createBufferSource(),
        buffer = context.createBuffer(2, rate * 2 + 512, rate);
      let seed = 7;
      for (let i = 0; i < rate * 2; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        buffer.getChannelData(0)[i] = (0.2 * seed) / 2147483648;
        buffer.getChannelData(1)[i] = buffer.getChannelData(0)[i] * 0.25;
      }
      source.buffer = buffer;
      Object.defineProperty(source, 'mediaElement', {
        value: document.querySelector('video'),
      });
      if (fault) {
        const add = context.audioWorklet.addModule.bind(context.audioWorklet);
        context.audioWorklet.addModule = async (url) => {
          let body = await fetch(url).then((r) => r.text());
          body = body.replace(
            'if (this.disposed) return false;',
            'if(currentTime>=1)throw Error("native identity recovery fault");if (this.disposed) return false;',
          );
          const replacement = URL.createObjectURL(
            new Blob([body], { type: 'application/javascript' }),
          );
          try {
            await add(replacement);
          } finally {
            URL.revokeObjectURL(replacement);
          }
        };
      }
      const graph = f.initializeAudioGraph(context, source);
      let failures = 0;
      const lease = graph.registerWetOutput(
        context.createGain(),
        () => failures++,
      );
      await lease.ready;
      const pause = fault ? context.suspend(1.02) : null;
      source.start();
      const start = performance.now(),
        rendering = context.startRendering();
      if (pause) {
        await pause;
        await new Promise((r) => setTimeout(r, 0));
        await context.resume();
      }
      const output = await rendering;
      const wallMs = performance.now() - start;
      let error = 0,
        peak = 0;
      for (let c = 0; c < 2; c++)
        for (let i = fault ? rate * 1.05 : 192; i < rate * 2; i++) {
          const expected = buffer.getChannelData(c)[i - (fault ? 0 : 192)],
            actual = output.getChannelData(c)[i];
          error = Math.max(error, Math.abs(actual - expected));
          peak = Math.max(peak, Math.abs(actual));
        }
      lease.release();
      rows.push({ fault, error, peak, failures, wallMs });
    }
    return rows;
  });
  console.log(JSON.stringify(rows));
  expect(rows[0].error).toBe(0);
  expect(rows[0].peak).toBeLessThan(0.21);
  expect(rows[1].error).toBeLessThan(1e-7);
  expect(rows[1].failures).toBeGreaterThanOrEqual(1);
});

test('native held bass limiting has low steady THD and release returns quiet audio to unity', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rate = 48000,
      context = new OfflineAudioContext(2, rate * 4 + 512, rate),
      source = context.createBufferSource(),
      buffer = context.createBuffer(2, rate * 4 + 512, rate);
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < rate * 4; i++)
        buffer.getChannelData(c)[i] =
          (i < rate * 3 ? 2 : 0.2) * Math.sin((2 * Math.PI * 27 * i) / rate);
    source.buffer = buffer;
    Object.defineProperty(source, 'mediaElement', {
      value: document.querySelector('video'),
    });
    const graph = f.initializeAudioGraph(context, source),
      lease = graph.registerWetOutput(context.createGain(), () => {});
    await lease.ready;
    source.start();
    const output = await context.startRendering(),
      samples = output.getChannelData(0);
    let fundamental = 0,
      harmonics = 0,
      energy = 0,
      reference = 0,
      peak = 0;
    for (let h = 1; h <= 8; h++) {
      let re = 0,
        im = 0;
      for (let i = rate * 2; i < rate * 3; i++) {
        re += samples[i] * Math.cos((2 * Math.PI * 27 * h * i) / rate);
        im += samples[i] * Math.sin((2 * Math.PI * 27 * h * i) / rate);
      }
      const power = re * re + im * im;
      if (h === 1) fundamental = power;
      else harmonics += power;
    }
    for (let i = 0; i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
      if (i >= rate * 3.8 + 192 && i < rate * 4 + 192) {
        energy += samples[i] ** 2;
        reference += buffer.getChannelData(0)[i - 192] ** 2;
      }
    }
    lease.release();
    return {
      peak,
      thd: Math.sqrt(harmonics / fundamental),
      releasedRatio: Math.sqrt(energy / reference),
    };
  });
  console.log(JSON.stringify(result));
  expect(result.peak).toBeLessThanOrEqual(Math.fround(0.99));
  expect(result.thd).toBeLessThan(0.001);
  expect(result.releasedRatio).toBeGreaterThan(0.999);
});
