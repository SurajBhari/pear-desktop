export const recordingCategoryNames = [
  'live',
  'acoustic',
  'demo',
  'session',
  'venue',
] as const;
export type RecordingCategory = (typeof recordingCategoryNames)[number];
export type RecordingCategories = Record<RecordingCategory, boolean>;
export interface SkipLiveSongsConfig {
  enabled: boolean;
  categories?: Partial<RecordingCategories>;
}

const defaults: RecordingCategories = {
  live: true,
  acoustic: false,
  demo: false,
  session: false,
  venue: false,
};

/** Read-only normalization. Unsupported data must never opt a listener in. */
export const resolveRecordingCategories = (
  raw: unknown,
): RecordingCategories | null => {
  if (raw === undefined) return { ...defaults };
  try {
    if (!raw || typeof raw !== 'object') return null;
    const prototype: unknown = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const fields = Object.getOwnPropertyDescriptors(raw);
    if (
      Reflect.ownKeys(fields).some(
        (key) => !('value' in fields[key as keyof typeof fields]),
      )
    )
      return null;
    const result = { ...defaults };
    for (const key of recordingCategoryNames) {
      if (!Object.hasOwn(fields, key)) continue;
      const value: unknown = fields[key].value;
      if (typeof value !== 'boolean') return null;
      result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
};
