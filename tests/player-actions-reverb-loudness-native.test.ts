/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';

import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { reverbNativeSource } from './helpers/reverb-native-source';

test('native reverb keeps ordinary clean-mix loudness instead of a parameter-driven master drop', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, await equalizerBundle(reverbNativeSource));
  const rows = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rows = [];
    for (const intensity of [0.35, 0.4, 1])
      for (const volume of [0.02, 0.25, 0.5, 0.75, 1]) {
        const options = {
          intensity,
          volume,
          kind: 'music',
          eq: 'off',
          highpass: 20,
          lowpass: 20000,
        };
        const actual = await f.renderReverbStress(options),
          reference = await f.renderReverbStress({
            ...options,
            referenceUnprotected: true,
          });
        rows.push({
          intensity,
          volume,
          rms: actual.rms,
          referenceRms: reference.rms,
          ratio: actual.rms / reference.rms,
          peak: actual.peak,
          gain: actual.gain,
          finite: actual.finite,
        });
      }
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    // This bounded music fixture needs at most1.2dB peak reduction; no claim of
    // constant RMS is made for arbitrary/clipped audio or extreme EQ boosts.
    expect(row.ratio).toBeGreaterThan(0.84);
    expect(row.ratio).toBeLessThan(1.01);
    expect(row.gain).toBe(1);
    expect(row.peak).toBeLessThanOrEqual(Math.fround(0.99));
    expect(row.finite).toBe(true);
  }
});

test('native actual-mix ceiling and baseline volume-aware EQ hold across intensity, volume and signal matrices', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, await equalizerBundle(reverbNativeSource));
  const rows = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rows = [];
    for (const intensity of [0.35, 0.4, 1])
      for (const volume of [0.02, 0.25, 0.5, 0.75, 1])
        for (const eq of ['off', 'flat', 'boost'])
          for (const signal of [
            { kind: 'music' },
            { kind: 'pink' },
            { kind: 'impulse' },
            { kind: 'sine', frequency: 27 },
            { kind: 'sine', frequency: 600 },
            { kind: 'sine', frequency: 1000 },
          ]) {
            const options = {
              intensity,
              volume,
              eq,
              ...signal,
              highpass: 20,
              lowpass: 20000,
            };
            const audio = await f.renderReverbStress(options);
            rows.push({
              ...options,
              peak: audio.peak,
              rms: audio.rms,
              finite: audio.finite,
              masterGain: audio.gain,
              preamp: audio.preamp,
            });
          }
    return rows;
  });
  console.log(JSON.stringify(rows));
  expect(rows.length).toBe(270);
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThanOrEqual(Math.fround(0.99));
    expect(row.masterGain).toBe(1);
    if (row.eq === 'flat') expect(row.preamp).toBe(0);
    if (row.eq === 'boost') {
      const total = 18 + 20 * Math.log10(row.volume);
      expect(row.preamp).toBeCloseTo(total > 0 ? -total - 0.1 : 0, 3);
    }
  }
});
