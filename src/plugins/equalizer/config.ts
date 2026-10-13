import { presetConfigs, type FilterConfig } from './presets';

export type EqualizerMode =
  | 'graphic-8'
  | 'graphic-14'
  | 'graphic-20'
  | 'custom';
export type EqualizerBand = FilterConfig & { id: string };
export type EqualizerProfile = {
  mode: EqualizerMode;
  bands: EqualizerBand[];
  preamp: number;
};
export type UserPreset = {
  id: string;
  name: string;
  profile: EqualizerProfile;
};
export type EqualizerPluginConfig = {
  enabled: boolean;
  schemaVersion: number;
  bypass: boolean;
  profile: EqualizerProfile;
  rememberedProfiles: Partial<Record<EqualizerMode, EqualizerProfile>>;
  userPresets: UserPreset[];
  filters?: FilterConfig[];
  presets?: Record<string, boolean>;
  legacy?: { filters: FilterConfig[]; presets: Record<string, boolean> };
};

export const MAX_BANDS = 64;
export const modes: EqualizerMode[] = [
  'graphic-8',
  'graphic-14',
  'graphic-20',
  'custom',
];
// Plain deepmerge readers concatenate arrays. Defaults must never contain bands/presets.
export const defaultConfig: EqualizerPluginConfig = {
  enabled: false,
  schemaVersion: 0,
  bypass: false,
  profile: { mode: 'graphic-8', bands: [], preamp: 0 },
  rememberedProfiles: {},
  userPresets: [],
};

export function flatProfile(mode: EqualizerMode): EqualizerProfile {
  if (mode === 'custom') return { mode, bands: [], preamp: 0 };
  const count = Number(mode.split('-')[1]);
  const ratio = (16000 / 31.5) ** (1 / (count - 1));
  const rootRatio = Math.sqrt(ratio);
  const reciprocal = 1 / rootRatio;
  const bandwidth = rootRatio - reciprocal;
  const Q = 1 / bandwidth;
  return {
    mode,
    preamp: 0,
    bands: Array.from({ length: count }, (_, i) => ({
      id: `${mode}-${i}`,
      type: 'peaking',
      frequency: 31.5 * Math.pow(ratio, i),
      gain: 0,
      Q,
    })),
  };
}

const types = new Set<BiquadFilterType>([
  'peaking',
  'lowshelf',
  'highshelf',
  'lowpass',
  'highpass',
  'bandpass',
  'notch',
  'allpass',
]);
function validBand(value: unknown): value is EqualizerBand {
  if (!value || typeof value !== 'object') return false;
  const b = value as EqualizerBand;
  return (
    typeof b.id === 'string' &&
    types.has(b.type) &&
    Number.isFinite(b.frequency) &&
    b.frequency >= 0 &&
    b.frequency <= 20000 &&
    Number.isFinite(b.gain) &&
    Math.abs(b.gain) <= 48 &&
    Number.isFinite(b.Q) &&
    b.Q > 0 &&
    b.Q <= 1000
  );
}
function readProfile(value: unknown): EqualizerProfile | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as EqualizerProfile;
  if (
    !modes.includes(p.mode) ||
    !Array.isArray(p.bands) ||
    p.bands.length > MAX_BANDS ||
    !Number.isFinite(p.preamp) ||
    p.preamp < -24 ||
    p.preamp > 12 ||
    !p.bands.every(validBand) ||
    new Set(p.bands.map((b) => b.id)).size !== p.bands.length
  )
    return null;
  if (p.mode !== 'custom' && !p.bands.length)
    return { ...flatProfile(p.mode), preamp: p.preamp };
  if (p.mode !== 'custom' && p.bands.length !== Number(p.mode.split('-')[1]))
    return null;
  if (p.mode !== 'custom') {
    const expected = flatProfile(p.mode).bands;
    if (
      p.bands.some(
        (band, i) =>
          band.type !== 'peaking' ||
          Math.abs(band.frequency - expected[i].frequency) > 0.000001 ||
          Math.abs(band.Q - expected[i].Q) > 0.000001,
      )
    )
      return null;
  }
  return structuredClone(p);
}

export function normalizeConfig(raw: EqualizerPluginConfig) {
  const errors: string[] = [];
  let profile: EqualizerProfile | null = null;
  let legacy: EqualizerPluginConfig['legacy'];
  if (raw.schemaVersion > 2) errors.push('future-version');
  else if (raw.schemaVersion === 2) profile = readProfile(raw.profile);
  else if (raw.schemaVersion !== undefined && raw.schemaVersion !== 0)
    errors.push('invalid-config');
  else {
    const filters = raw.filters ?? [];
    if (
      !Array.isArray(filters) ||
      filters.length + (raw.presets?.['bass-booster'] ? 1 : 0) > MAX_BANDS
    )
      errors.push('invalid-config');
    else {
      const bands = filters.map((b, i) => ({ ...b, id: `legacy-${i}` }));
      if (raw.presets?.['bass-booster'])
        bands.push({
          ...presetConfigs['bass-booster'],
          id: 'legacy-bass-booster',
        });
      legacy = {
        filters: structuredClone(filters),
        presets: { ...raw.presets },
      };
      profile = bands.length
        ? readProfile({ mode: 'custom', bands, preamp: 0 })
        : flatProfile('graphic-8');
    }
  }
  if (!profile && !errors.length) errors.push('invalid-config');
  const rememberedProfiles: EqualizerPluginConfig['rememberedProfiles'] = {};
  for (const mode of modes) {
    const value = raw.rememberedProfiles?.[mode];
    if (value !== undefined) {
      const p = readProfile(value);
      if (!p || p.mode !== mode) errors.push('invalid-config');
      else rememberedProfiles[mode] = p;
    }
  }
  const userPresets: UserPreset[] = [];
  if (raw.userPresets !== undefined && !Array.isArray(raw.userPresets))
    errors.push('invalid-config');
  else
    for (const preset of raw.userPresets ?? []) {
      const p = readProfile(preset?.profile);
      if (
        !p ||
        typeof preset.id !== 'string' ||
        typeof preset.name !== 'string' ||
        !preset.name.trim() ||
        preset.name.length > 80 ||
        userPresets.some((item) => item.id === preset.id)
      )
        errors.push('invalid-config');
      else
        userPresets.push({
          id: preset.id,
          name: preset.name.trim(),
          profile: p,
        });
    }
  return {
    profile,
    rememberedProfiles,
    userPresets,
    legacy,
    errors: [...new Set(errors)],
    editable: errors.length === 0,
  };
}

/** Complete replacement values, preserving retained raw keys through setPartial. Never called on read/start. */
export function editedConfig(
  raw: EqualizerPluginConfig,
  profile: EqualizerProfile,
  changes: Partial<EqualizerPluginConfig> = {},
) {
  const normalized = normalizeConfig(raw);
  if (!normalized.editable)
    throw new Error(
      'Equalizer configuration requires a supported schema/profile',
    );
  const next = {
    schemaVersion: 2,
    profile: structuredClone(profile),
    rememberedProfiles: normalized.rememberedProfiles,
    userPresets: normalized.userPresets,
    ...(normalized.legacy ? { legacy: normalized.legacy } : {}),
    ...changes,
  };
  if (!normalizeConfig({ ...raw, ...next }).editable)
    throw new Error('Invalid equalizer edit');
  return next;
}

export function bassProfile(): EqualizerProfile {
  return {
    mode: 'custom',
    preamp: -12,
    bands: [{ ...presetConfigs['bass-booster'], id: 'bass-booster' }],
  };
}
