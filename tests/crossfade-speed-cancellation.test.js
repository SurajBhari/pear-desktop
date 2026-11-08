import { test, expect } from '@playwright/test';
import { startCrossfadeFixture } from './helpers/crossfade-native';
import { installCrossfadeDiagnosticReporter } from './helpers/crossfade-diagnostic-reporter';

installCrossfadeDiagnosticReporter();

// These actual-module fixtures supersede the old eager-navigation/RAF VM host.
// Numeric rate can be unchanged when ownership or the clamped speed command changes.
for (const direction of [1, -1])
  test(`owned same-value speed command ${direction} retires an admitted outgoing source`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page, {
      diagnosticCase: direction === -1 ? 'SPEED_SAME_NEGATIVE' : undefined,
      startNearAdmission: true,
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.crossfadeFixture.graph.auxiliaryMediaCount),
      )
      .toBe(1);
    const result = await page.evaluate((direction) => {
      const f = window.crossfadeFixture,
        rate = f.main.playbackRate,
        volume = f.main.volume;
      window.speed(direction);
      return {
        count: f.graph.auxiliaryMediaCount,
        rate: f.main.playbackRate,
        volume: f.main.volume,
        previousRate: rate,
        previousVolume: volume,
      };
    }, direction);
    expect(result.count).toBe(0);
    expect(result.rate).toBe(result.previousRate);
    expect(result.volume).toBe(result.previousVolume);
  });
for (const command of [0, 2, '1', null, [], {}])
  test(`invalid speed command ${JSON.stringify(command)} does not acquire cancellation ownership`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page, {
      startNearAdmission: true,
      diagnosticCase:
        command === 2
          ? 'SPEED_INVALID_NUMBER_TWO'
          : command === '1'
            ? 'SPEED_INVALID_STRING_ONE'
            : Array.isArray(command)
              ? 'SPEED_INVALID_ARRAY'
              : undefined,
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.crossfadeFixture.graph.auxiliaryMediaCount),
      )
      .toBe(1);
    expect(
      await page.evaluate((command) => {
        window.speed(command);
        return window.crossfadeFixture.graph.auxiliaryMediaCount;
      }, command),
    ).toBe(1);
  });
test('speed-owner transfer at the same numeric rate retires outgoing without touching user controls', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    diagnosticCase: 'SPEED_TRANSFER',
    startNearAdmission: true,
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.crossfadeFixture.graph.auxiliaryMediaCount),
    )
    .toBe(1);
  const result = await page.evaluate(() => {
    const f = window.crossfadeFixture;
    window.EqualizerFixture.claimPlaybackRate(
      'owned-fixture',
      f.main.playbackRate,
    );
    return {
      count: f.graph.auxiliaryMediaCount,
      rate: f.main.playbackRate,
      volume: f.main.volume,
    };
  });
  expect(result).toEqual({ count: 0, rate: 1, volume: 0.65 });
});
for (const action of ['stop', 'speed', 'manual', 'seek', 'config'])
  test(`late physical request after ${action} cannot resurrect retired playback or status`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page, { requestDelay: true });
    await expect
      .poll(() => page.evaluate(() => window.crossfadeFixture.requests))
      .toBe(1);
    await page.evaluate((action) => {
      const f = window.crossfadeFixture;
      if (action === 'stop') f.renderer.stop();
      else if (action === 'speed') window.speed(1);
      else if (action === 'manual') f.manual();
      else if (action === 'seek') f.main.currentTime = 2;
      else f.setConfig({ enabled: false });
      f.resolve();
    }, action);
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() => {
        const f = window.crossfadeFixture;
        return {
          aux: f.aux.length,
          count: f.graph.auxiliaryMediaCount,
          next: f.nexts,
          status: document.querySelector('[role=status]')?.textContent ?? null,
        };
      }),
    ).toEqual({ aux: 0, count: 0, next: 0, status: null });
  });
for (const action of ['pause', 'seek', 'stop', 'config', 'manual'])
  test(`${action} during prepared playback restores ordinary native route and exact owned cleanup`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page);
    await expect
      .poll(() => page.evaluate(() => window.crossfadeFixture.requests))
      .toBe(1);
    await page.waitForTimeout(50);
    await page.evaluate((action) => {
      const f = window.crossfadeFixture;
      if (action === 'pause') f.main.pause();
      else if (action === 'seek') f.main.currentTime = 2;
      else if (action === 'stop') f.renderer.stop();
      else if (action === 'config') f.setConfig({ enabled: false });
      else f.manual();
    }, action);
    await expect
      .poll(() =>
        page.evaluate(() => window.crossfadeFixture.graph.auxiliaryMediaCount),
      )
      .toBe(0);
    expect(await page.evaluate(() => window.crossfadeFixture.nexts)).toBe(0);
  });
test('old speed callback and stop cannot retire successor controller resources', async ({
  page,
}) => {
  await startCrossfadeFixture(page, { startNearAdmission: true });
  await expect
    .poll(() => page.evaluate(() => window.crossfadeFixture.requests))
    .toBe(1);
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const f = window.crossfadeFixture,
      old = window.speed;
    f.renderer.onPlayerApiReady(f.api);
    old(1);
    f.main.dispatchEvent(new Event('timeupdate'));
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.crossfadeFixture.graph.auxiliaryMediaCount),
    )
    .toBe(1);
  expect(await page.evaluate(() => window.crossfadeFixture.requests)).toBe(2);
});
test('missing required native ownership leaves navigation and main controls untouched', async ({
  page,
}) => {
  await startCrossfadeFixture(page, { config: { enabled: false } });
  await page.evaluate(() => {
    const f = window.crossfadeFixture;
    history.replaceState(null, '', '/watch?v=BBBBBBBBBBB');
    f.main.dispatchEvent(new Event('timeupdate'));
  });
  expect(
    await page.evaluate(() => {
      const f = window.crossfadeFixture;
      return {
        requests: f.requests,
        nexts: f.nexts,
        count: f.graph.auxiliaryMediaCount,
        volume: f.main.volume,
      };
    }),
  ).toEqual({ requests: 0, nexts: 0, count: 0, volume: 0.65 });
});
