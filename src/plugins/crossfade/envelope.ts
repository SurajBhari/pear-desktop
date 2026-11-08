import { validScaling, type CrossfadeScaling } from './config';

/** Analytical values also hold interrupted automation; AudioParam.value may expose the target. */
export function envelopeValue(
  from: number,
  to: number,
  progress: number,
  scaling: CrossfadeScaling,
): number {
  const t = Math.max(0, Math.min(1, progress));
  if (t === 0) return from;
  if (t === 1) return to;
  if (scaling === 'equalPower') {
    const mix = Math.sin((t * Math.PI) / 2) ** 2;
    const fromPower = from ** 2;
    const toPower = to ** 2;
    const outgoing = fromPower * (1 - mix);
    const incoming = toPower * mix;
    return Math.sqrt(outgoing + incoming);
  }
  if (scaling === 'linear') {
    const movement = (to - from) * t;
    return from + movement;
  }
  const range = (typeof scaling === 'number' ? scaling : 60) / 20;
  const internal = (value: number) => {
    const logarithm = Math.log10(value) / range;
    return value === 0 ? 0 : Math.max(1 + logarithm, 0);
  };
  const movement = (internal(to) - internal(from)) * t;
  const level = internal(from) + movement;
  return Math.max(
    Math.min(from, to),
    Math.min(Math.max(from, to), level === 0 ? 0 : 10 ** ((level - 1) * range)),
  );
}
export function scheduleOverlap(
  context: BaseAudioContext,
  main: AudioParam,
  auxiliary: AudioParam,
  options: {
    fadeInMs: number;
    fadeOutMs: number;
    scaling: CrossfadeScaling;
    availableTailMs: number;
  },
): { endTime: number; cancel(): void } | null {
  const { fadeInMs, fadeOutMs, availableTailMs, scaling } = options;
  if (
    ![fadeInMs, fadeOutMs, availableTailMs].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    fadeInMs > 60000 ||
    fadeOutMs > 60000 ||
    availableTailMs < 100 ||
    !validScaling(scaling)
  )
    return null;
  const factor = Math.min(1, availableTailMs / Math.max(fadeInMs, fadeOutMs));
  const rise = (fadeInMs * factor) / 1000,
    fall = (fadeOutMs * factor) / 1000,
    start = context.currentTime;
  const curve = (from: number, to: number) =>
    Float32Array.from({ length: 129 }, (_, i) =>
      envelopeValue(from, to, i / 128, scaling),
    );
  main.cancelScheduledValues(start);
  auxiliary.cancelScheduledValues(start);
  main.setValueAtTime(0, start);
  auxiliary.setValueAtTime(1, start);
  try {
    main.setValueCurveAtTime(curve(0, 1), start, rise);
    auxiliary.setValueCurveAtTime(curve(1, 0), start, fall);
  } catch (error) {
    main.cancelScheduledValues(start);
    auxiliary.cancelScheduledValues(start);
    main.setValueAtTime(1, start);
    auxiliary.setValueAtTime(0, start);
    throw error;
  }
  let cancelled = false;
  return {
    endTime: start + Math.max(rise, fall),
    cancel() {
      if (cancelled) return;
      cancelled = true;
      const now = context.currentTime;
      const a = envelopeValue(0, 1, (now - start) / rise, scaling),
        b = envelopeValue(1, 0, (now - start) / fall, scaling);
      main.cancelScheduledValues(now);
      auxiliary.cancelScheduledValues(now);
      main.setValueAtTime(a, now);
      auxiliary.setValueAtTime(b, now);
    },
  };
}
