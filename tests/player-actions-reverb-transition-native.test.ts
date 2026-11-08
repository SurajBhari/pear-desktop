/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';

import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { reverbNativeSource } from './helpers/reverb-native-source';

let bundle: string;
test.beforeAll(async () => {
  bundle = await equalizerBundle(reverbNativeSource);
});

test('native sustained 100-to-1-percent reverb controls retained 20Hz tone-filter state', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(() =>
    (window as any).EqualizerFixture.renderReverbStress({
      intensity: 1,
      transitionIntensity: 0.01,
      changes: true,
      frequency: 27,
      highpass: 20,
      lowpass: 20000,
    }),
  );
  console.log(JSON.stringify(result));
  expect(result.finite).toBe(true);
  // peak scans EVERY sample of both channels, including the gain transition.
  expect(result.peak).toBeLessThan(1);
});

test('native reverb reductions and disable keep every transition sample bounded with EQ and volume changes', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, bundle);
  const rows = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture,
      rows = [];
    for (const transitionIntensity of [0, 0.01, 0.35, 0.4])
      for (const [volume, changeVolume] of [
        [1, 1],
        [0.02, 0.02],
        [0.02, 1],
        [1, 0.02],
      ])
        for (const eq of ['off', 'boost']) {
          const options = {
            intensity: 1,
            transitionIntensity,
            changes: true,
            frequency: 27,
            highpass: 20,
            lowpass: 20000,
            volume,
            changeVolume,
            eq,
          };
          rows.push({
            ...options,
            ...(await fixture.renderReverbStress(options)),
          });
        }
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThan(1);
    expect(row.sameNode).toBe(row.transitionIntensity !== 0);
    expect(row.liveEdges).toBe(row.transitionIntensity === 0 ? 1 : 2);
    expect(row.retiredEdges).toBe(1);
    if (row.changeVolume === 0.02) expect(row.gain).toBe(1);
  }
});

test('native simultaneous wet filter and intensity changes do not expose retained filter state', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, bundle);
  const rows = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture,
      rows = [];
    const filters = [
      {
        frequency: 27,
        highpass: 20,
        lowpass: 20000,
        changeHighpass: 1000,
        changeLowpass: 1000,
      },
      {
        frequency: 27,
        highpass: 1000,
        lowpass: 1000,
        changeHighpass: 20,
        changeLowpass: 20000,
      },
      {
        frequency: 6000,
        highpass: 20,
        lowpass: 1000,
        changeHighpass: 20,
        changeLowpass: 20000,
      },
      {
        frequency: 6000,
        highpass: 20,
        lowpass: 20000,
        changeHighpass: 20,
        changeLowpass: 1000,
      },
    ];
    for (const transitionIntensity of [0, 0.01, 0.35, 0.4, 1])
      for (const filter of filters)
        for (const eq of ['off', 'boost']) {
          const options = {
            intensity: 1,
            transitionIntensity,
            changes: true,
            ...filter,
            eq,
          };
          rows.push({
            ...options,
            ...(await fixture.renderReverbStress(options)),
          });
        }
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThan(1);
    expect(row.retiredEdges).toBe(1);
  }
});
