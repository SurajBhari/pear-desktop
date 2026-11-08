/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';

import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { reverbNativeSource } from './helpers/reverb-native-source';

test('native post-filter intensity changes do not add a control step to a sustained 27Hz sine', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, await equalizerBundle(reverbNativeSource));
  const rows = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture,
      rows = [];
    for (const volume of [0.25, 1])
      for (const [
        intensity,
        transitionIntensity,
        changeAt,
        interruptedIntensity,
      ] of [
        [1, 0.01, 1, null],
        [0.01, 1, 1.01, null],
        [1, 0.01, 1, 1],
      ]) {
        const options = {
          volume,
          intensity,
          transitionIntensity,
          changeAt,
          interruptedIntensity,
          frequency: 27,
          highpass: 20,
          lowpass: 1000,
          captureTransition: true,
        };
        const edit = await fixture.renderReverbStress({
            ...options,
            changes: true,
          }),
          reference = await fixture.renderReverbStress(options);
        let delta = 0,
          referenceDelta = 0,
          residualDelta = 0;
        for (let c = 0; c < 2; c++)
          for (let i = 1; i < edit.transitionSamples[c].length; i++) {
            const d =
                edit.transitionSamples[c][i] - edit.transitionSamples[c][i - 1],
              r =
                reference.transitionSamples[c][i] -
                reference.transitionSamples[c][i - 1];
            delta = Math.max(delta, Math.abs(d));
            referenceDelta = Math.max(referenceDelta, Math.abs(r));
            residualDelta = Math.max(residualDelta, Math.abs(d - r));
          }
        rows.push({
          volume,
          intensity,
          transitionIntensity,
          interruptedIntensity,
          delta,
          referenceDelta,
          residualDelta,
          peak: edit.peak,
          finite: edit.finite,
        });
      }
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThan(1);
    // A fixture-specific continuity regression, relative to the same unedited
    // sine and the 960-sample control ramp; not a click-free claim for all PCM.
    if (row.volume === 0.25)
      expect(row.residualDelta).toBeLessThan(row.referenceDelta * 3 + 2 / 960);
  }
});

test('native suspended audio retains the old reserve through a wet ramp and keeps low-volume EQ headroom', async ({
  page,
}) => {
  test.setTimeout(120000);
  await fixturePage(page, await equalizerBundle(reverbNativeSource));
  const rows = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      rows = [];
    for (const [volume, changeVolume] of [
      [1, 1],
      [0.02, 0.02],
      [1, 0.02],
      [0.02, 1],
    ])
      for (const eq of ['off', 'flat', 'boost'])
        for (const [intensity, transitionIntensity] of [
          [1, 0.01],
          [0.01, 1],
        ]) {
          const options = {
            volume,
            changeVolume,
            eq,
            intensity,
            transitionIntensity,
            changes: true,
            auditRamp: true,
            frequency: 27,
            highpass: 20,
            lowpass: 1000,
          };
          rows.push({ ...options, ...(await f.renderReverbStress(options)) });
        }
    return rows;
  });
  console.log(JSON.stringify(rows));
  for (const row of rows) {
    expect(row.finite).toBe(true);
    expect(row.peak).toBeLessThan(1);
    const [ack, paused, middle, complete] = row.rampAudit;
    expect(ack.time).toBe(paused.time);
    expect(ack.wetGain).toBe(paused.wetGain);
    expect(middle.time).toBeLessThan(middle.envelope.end);
    expect(middle.masterGain).toBe(1);
    expect(complete.time).toBeGreaterThan(complete.envelope.end);
    expect(complete.wetGain).toBeCloseTo(
      complete.envelope.to * row.changeVolume,
      6,
    );
    if (row.changeVolume === 0.02) expect(row.gain).toBe(1);
    if (row.eq === 'flat') expect(row.preamp).toBe(0);
  }
});
