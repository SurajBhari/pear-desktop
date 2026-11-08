import { test, expect } from '@playwright/test';
import {
  normalizeCrossfadeConfig,
  effectiveCrossfadeLead,
  crossfadeDefaults,
  parseCrossfadeMenu,
} from '../src/plugins/crossfade/config';

test('new defaults are equal power and five seconds; saved/future fields survive without writes', () => {
  expect(crossfadeDefaults.fadeInDuration).toBe(5000);
  expect(crossfadeDefaults.fadeScaling).toBe('equalPower');
  const saved = {
    enabled: true,
    fadeInDuration: 1500,
    fadeOutDuration: 5000,
    secondsBeforeEnd: 10,
    fadeScaling: 'linear' as const,
    future: 'keep',
  };
  expect(normalizeCrossfadeConfig(saved)).toEqual({
    ...saved,
    overlapEligible: true,
  });
  expect(saved).not.toHaveProperty('overlapEligible');
});
test('invalid values and zero disable overlap without normalizing the saved object', () => {
  for (const change of [
    { fadeInDuration: NaN },
    { fadeOutDuration: Infinity },
    { secondsBeforeEnd: -1 },
    { fadeInDuration: 60001 },
    { fadeScaling: 121 },
    { fadeScaling: 'unknown' },
    { secondsBeforeEnd: 0 },
    { fadeOutDuration: 0 },
  ]) {
    expect(
      normalizeCrossfadeConfig({
        ...crossfadeDefaults,
        enabled: true,
        ...change,
      }).overlapEligible,
    ).toBe(false);
  }
  expect(
    normalizeCrossfadeConfig({
      ...crossfadeDefaults,
      enabled: true,
      fadeScaling: 60,
    }).overlapEligible,
  ).toBe(true);
});
test('menu rejects nonfinite, negative, blank and unknown inputs; accepts explicit legacy scaling', () => {
  for (const values of [
    ['NaN', '5000', '10', 'linear'],
    ['Infinity', '5000', '10', 'linear'],
    ['', '5000', '10', 'linear'],
    ['5000', '-1', '10', 'linear'],
    ['5000', '5000', '10', 'x'],
  ])
    expect(parseCrossfadeMenu(values)).toBeUndefined();
  expect(parseCrossfadeMenu(['1500', '5000', '10', '60'])).toEqual({
    fadeInDuration: 1500,
    fadeOutDuration: 5000,
    secondsBeforeEnd: 10,
    fadeScaling: 60,
  });
});

test('actual menu saves only valid explicit fields and preserves concurrent and future settings', async () => {
  const { crossfadeDefinition } =
    await import('./helpers/crossfade-definition');
  for (const response of [
    ['NaN', '5000', '10', 'linear'],
    ['5000', '5000', '10', 'equalPower'],
  ]) {
    const plugin = crossfadeDefinition({ prompt: async () => response });
    const updates: any[] = [];
    const saved = { ...crossfadeDefaults, enabled: true, future: 'concurrent' };
    const menu = plugin.menu({
      window: {},
      getConfig: async () => saved,
      setConfig: (value: unknown) => updates.push(value),
    });
    await menu[0].click();
    if (response[0] === 'NaN') expect(updates).toEqual([]);
    else
      expect(updates).toEqual([
        {
          fadeInDuration: 5000,
          fadeOutDuration: 5000,
          secondsBeforeEnd: 10,
          fadeScaling: 'equalPower',
        },
      ]);
    expect(saved.future).toBe('concurrent');
  }
});

test('effective lead is derived without altering saved ceiling or invalid/zero fallback', () => {
  const saved = { ...crossfadeDefaults, enabled: true };
  expect(effectiveCrossfadeLead(normalizeCrossfadeConfig(saved))).toBe(7);
  expect(saved.secondsBeforeEnd).toBe(10);
  expect(
    effectiveCrossfadeLead(
      normalizeCrossfadeConfig({
        ...saved,
        fadeInDuration: 1500,
        secondsBeforeEnd: 3,
      }),
    ),
  ).toBe(3);
  for (const change of [
    { secondsBeforeEnd: 0 },
    { fadeInDuration: 0 },
    { fadeOutDuration: NaN },
    { secondsBeforeEnd: Infinity },
  ])
    expect(
      effectiveCrossfadeLead(normalizeCrossfadeConfig({ ...saved, ...change })),
    ).toBe(0);
});
