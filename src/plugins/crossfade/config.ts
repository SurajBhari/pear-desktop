/** Runtime validation never writes or migrates the user's saved configuration. */
export type CrossfadeScaling = 'linear' | 'logarithmic' | 'equalPower' | number;
export type CrossfadePluginConfig = {
  enabled: boolean;
  fadeInDuration: number;
  fadeOutDuration: number;
  secondsBeforeEnd: number;
  fadeScaling: CrossfadeScaling;
};
export const crossfadeDefaults: CrossfadePluginConfig = {
  enabled: false,
  fadeInDuration: 5000,
  fadeOutDuration: 5000,
  secondsBeforeEnd: 10,
  fadeScaling: 'equalPower',
};
export type EffectiveCrossfadeConfig = CrossfadePluginConfig & {
  overlapEligible: boolean;
};
const bounded = (value: unknown, max: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;
export const validScaling = (value: unknown): value is CrossfadeScaling =>
  value === 'linear' ||
  value === 'logarithmic' ||
  value === 'equalPower' ||
  (typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 120);
export function normalizeCrossfadeConfig<T extends CrossfadePluginConfig>(
  config: T,
): T & EffectiveCrossfadeConfig {
  return {
    ...config,
    overlapEligible:
      config.enabled === true &&
      bounded(config.fadeInDuration, 60000) &&
      config.fadeInDuration > 0 &&
      bounded(config.fadeOutDuration, 60000) &&
      config.fadeOutDuration > 0 &&
      bounded(config.secondsBeforeEnd, 60) &&
      config.secondsBeforeEnd > 0 &&
      validScaling(config.fadeScaling),
  };
}
/** Saved secondsBeforeEnd is a ceiling; overlap timing derives an in-memory lead. */
export function effectiveCrossfadeLead(
  config: EffectiveCrossfadeConfig,
): number {
  if (!config.overlapEligible) return 0;
  const fadeSeconds =
    Math.max(config.fadeInDuration, config.fadeOutDuration) / 1000;
  return Math.min(config.secondsBeforeEnd, fadeSeconds + 2);
}
export function parseCrossfadeMenu(
  values: readonly unknown[],
): Omit<CrossfadePluginConfig, 'enabled'> | undefined {
  if (
    values.length !== 4 ||
    values.some((v) => typeof v !== 'string' && typeof v !== 'number') ||
    values.some((v) => String(v).trim() === '')
  )
    return;
  const fadeInDuration = Number(values[0]),
    fadeOutDuration = Number(values[1]),
    secondsBeforeEnd = Number(values[2]);
  const raw = values[3];
  const fadeScaling =
    raw === 'linear' || raw === 'logarithmic' || raw === 'equalPower'
      ? raw
      : Number(raw);
  if (
    !bounded(fadeInDuration, 60000) ||
    !bounded(fadeOutDuration, 60000) ||
    !bounded(secondsBeforeEnd, 60) ||
    !validScaling(fadeScaling)
  )
    return;
  return { fadeInDuration, fadeOutDuration, secondsBeforeEnd, fadeScaling };
}
