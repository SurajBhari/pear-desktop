/* oxlint-disable @stylistic/no-mixed-operators */
export const SLOW_MIN = 0.7;
export const SLOW_MAX = 1.3;
export const INTENSITY_MIN = 0;
export const INTENSITY_MAX = 1;

export function clamp(value: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

export function clampSlow(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.round(clamp(numeric, SLOW_MIN, SLOW_MAX) * 100) / 100;
}

export function clampIntensity(value: number): number {
  return Math.round(clamp(value, INTENSITY_MIN, INTENSITY_MAX) * 100) / 100;
}

export const WET_HIGHPASS_DEFAULT = 180;
export const WET_LOWPASS_DEFAULT = 6500;

// Non-overlapping ranges keep the wet passband valid even for external config edits.
export function clampWetHighpass(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.round(clamp(numeric, 20, 1000))
    : WET_HIGHPASS_DEFAULT;
}

export function clampWetLowpass(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.round(clamp(numeric, 1000, 20000))
    : WET_LOWPASS_DEFAULT;
}

export function normalize(raw: unknown): {
  slow: number;
  reverbIntensity: number;
  wetHighpass: number;
  wetLowpass: number;
} {
  const next =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    slow: clampSlow(
      Object.prototype.hasOwnProperty.call(next, 'slow')
        ? (next['slow'] as number)
        : 1,
    ),
    wetHighpass: clampWetHighpass(next['wetHighpass']),
    wetLowpass: clampWetLowpass(next['wetLowpass']),
    reverbIntensity: clampIntensity(
      Object.prototype.hasOwnProperty.call(next, 'reverbIntensity')
        ? (next['reverbIntensity'] as number)
        : 0,
    ),
  };
}

/**
 * Whether the slow feature has work to do: enabled and not at 1x. Gate for
 * the rate watchdog and for the rate-claim paths.
 */
export function isSlowEngaged(config: {
  active: boolean;
  slow: number;
}): boolean {
  return config.active && clampSlow(config.slow) !== 1;
}

/**
 * Whether the reverb has audio to produce: enabled with a non-zero
 * intensity. Gate for building the wet audio path (it stays unbuilt while
 * silent) and for posting parameters.
 */
export function isReverbEngaged(config: {
  active: boolean;
  reverbIntensity: number;
}): boolean {
  return config.active && clampIntensity(config.reverbIntensity) > 0;
}

export function formatRate(value: number): string {
  return `${clampSlow(value).toFixed(2)}x`;
}

export function formatPercent(value: number): string {
  return `${Math.round(clampIntensity(value) * 100)}%`;
}

export interface DattorroParams {
  wetGain: number;
  decay: number;
  damping: number;
  preDelay: number;
  preFilter?: number;
  inputDiff1?: number;
  inputDiff2?: number;
  decayDiff1?: number;
}

export function computeDattorroParams(intensity: number): DattorroParams {
  const i = clamp(intensity, INTENSITY_MIN, INTENSITY_MAX);
  if (i <= 0) {
    return { wetGain: 0, decay: 0, damping: 1, preDelay: 0 };
  }
  return {
    preDelay: 0.44 + i * 0.1,
    preFilter: 0.7 + i * 0.1,
    inputDiff1: 0.75,
    inputDiff2: 0.625,
    decayDiff1: 0.65 + i * 0.05,
    // Keep low settings gentle; reserve the extra tail and level for the upper range.
    decay: Math.pow(i, 0.75) * 0.58 + Math.pow(i, 3) * 0.2,
    damping: Math.min(0.5 + Math.pow(i, 0.6) * 0.4, 0.78),
    wetGain: Math.pow(i, 0.75) * 0.42 + Math.pow(i, 3) * 0.68,
  };
}
