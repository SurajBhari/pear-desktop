import { test, expect } from '@playwright/test';
import {
  scheduleOverlap,
  envelopeValue,
} from '../src/plugins/crossfade/envelope';

class Param {
  value = 99;
  curves: { values: Float32Array; start: number; duration: number }[] = [];
  sets: { value: number; time: number }[] = [];
  cancelScheduledValues(_time: number) {}
  setValueAtTime(value: number, time: number) {
    this.sets.push({ value, time });
    return this;
  }
  setValueCurveAtTime(values: Float32Array, start: number, duration: number) {
    this.curves.push({ values, start, duration });
    return this;
  }
}
test('paired equal-power automation shares clock and exact endpoints', () => {
  const context = { currentTime: 4 };
  const main = new Param(),
    aux = new Param();
  const overlap = scheduleOverlap(
    context as BaseAudioContext,
    main as unknown as AudioParam,
    aux as unknown as AudioParam,
    {
      fadeInMs: 5000,
      fadeOutMs: 5000,
      availableTailMs: 6000,
      scaling: 'equalPower',
    },
  );
  expect(overlap?.endTime).toBe(9);
  expect(main.curves[0].start).toBe(4);
  expect(aux.curves[0].start).toBe(4);
  const a = main.curves[0].values,
    b = aux.curves[0].values;
  expect([a[0], a[128], b[0], b[128]]).toEqual([0, 1, 1, 0]);
  expect(a[64]).toBeCloseTo(Math.SQRT1_2, 5);
  expect(b[64]).toBeCloseTo(Math.SQRT1_2, 5);
  for (let i = 0; i < 129; i++) expect(a[i] ** 2 + b[i] ** 2).toBeCloseTo(1, 5);
});
test('short tails scale asymmetric saved durations together; cancellation computes clock value, never AudioParam.value', () => {
  const context = { currentTime: 2 };
  const main = new Param(),
    aux = new Param();
  const overlap = scheduleOverlap(
    context as BaseAudioContext,
    main as unknown as AudioParam,
    aux as unknown as AudioParam,
    {
      fadeInMs: 1500,
      fadeOutMs: 5000,
      availableTailMs: 1000,
      scaling: 'linear',
    },
  )!;
  expect(main.curves[0].duration).toBeCloseTo(0.3);
  expect(aux.curves[0].duration).toBe(1);
  context.currentTime = 2.5;
  overlap.cancel();
  expect(main.sets.at(-1)?.value).toBe(1);
  expect(aux.sets.at(-1)?.value).toBeCloseTo(0.5);
  overlap.cancel();
  expect(aux.sets).toHaveLength(2);
  expect(
    scheduleOverlap(
      context as BaseAudioContext,
      main as unknown as AudioParam,
      aux as unknown as AudioParam,
      {
        fadeInMs: 0,
        fadeOutMs: 5000,
        availableTailMs: 1000,
        scaling: 'linear',
      },
    ),
  ).toBeNull();
});
test('linear handover is unity; legacy and interrupted equal-power endpoints remain bounded', () => {
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    expect(
      envelopeValue(0, 1, t, 'linear') + envelopeValue(1, 0, t, 'linear'),
    ).toBeCloseTo(1, 10);
    for (const scaling of ['equalPower', 'logarithmic', 60] as const)
      expect(envelopeValue(0.3, 0.8, t, scaling)).toBeGreaterThanOrEqual(0.3);
  }
  expect(envelopeValue(1, 0, 0.5, 'equalPower')).toBeCloseTo(Math.SQRT1_2, 10);
});

test('legacy VolumeFader has correct equal-power falling midpoint and immediate cancellable callback', async () => {
  const { VolumeFader } = await import('../src/plugins/crossfade/fader');
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const previous = (globalThis as any).window;
  (globalThis as any).window = {
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      frames.set(++id, cb);
      return id;
    },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  };
  try {
    const target = { volume: 1 };
    let calls = 0;
    const fader = new VolumeFader(target, {
      fadeScaling: 'equalPower',
      fadeDuration: 1000,
    });
    fader.fadeOut(() => calls++);
    now = 500;
    frames.clear();
    fader.updateVolume();
    expect(target.volume).toBeCloseTo(Math.SQRT1_2, 6);
    fader.cancelFade();
    expect(frames.size).toBe(0);
    now = 2000;
    fader.updateVolume();
    expect(calls).toBe(0);
  } finally {
    Date.now = originalNow;
    (globalThis as any).window = previous;
  }
});
