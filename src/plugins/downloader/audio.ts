/** Source selection is independent of the output encoder/preset. */
export interface AudioFormat {
  itag: number;
  mime_type: string;
  has_audio: boolean;
  has_video: boolean;
  has_text?: boolean;
  content_length?: number;
  bitrate?: number;
  average_bitrate?: number;
  audio_quality?: string;
  audio_sample_rate?: number;
  audio_channels?: number;
  audio_track?: { id?: string };
  language?: string | null;
  is_original?: boolean;
  is_drc?: boolean;
  is_dubbed?: boolean;
  is_descriptive?: boolean;
  is_secondary?: boolean;
  is_auto_dubbed?: boolean;
  is_type_otf?: boolean;
  drm_families?: string[];
  fair_play_key_uri?: string;
}
export interface AudioDescriptor {
  muxed?: boolean;
  client?: 'YTMUSIC' | 'TV_EMBEDDED';
  key: string;
  itag: number;
  codec: string;
  container: string;
  bitrate?: number;
  averageBitrate?: number;
  quality?: string;
  sampleRate?: number;
  channels?: number;
  track?: string;
  language: string;
  original: boolean;
  drc: boolean;
  length?: number;
  supported: boolean;
  reason?: string;
}
export interface AudioPreference {
  mode: 'best' | 'opus' | 'aac' | 'bitrate' | 'itag';
  bitrate?: number;
  itag?: number;
  language?: string;
  drc?: boolean;
}
export type DuplicatePolicy =
  | 'legacy'
  | 'skip-any'
  | 'keep-better'
  | 'save-variant'
  | 'ask';
export const validAudioLength = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const positive = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
export const describeAudioFormats = (
  formats: readonly AudioFormat[],
  allowMuxed = false,
): AudioDescriptor[] =>
  formats.map((f) => {
    const codecs =
      f.mime_type
        ?.match(/codecs=["']?([^;"']+)/i)?.[1]
        ?.trim()
        .toLowerCase() ?? '';
    const codec =
      codecs
        .split(',')
        .map((v) => v.trim())
        .find((v) => /^(opus|mp4a\.)/.test(v)) ?? codecs;
    const container = ['audio/webm', 'video/webm'].includes(
      f.mime_type?.split(';')[0].trim().toLowerCase(),
    )
      ? 'webm'
      : ['audio/mp4', 'video/mp4'].includes(
            f.mime_type?.split(';')[0].trim().toLowerCase(),
          )
        ? 'm4a'
        : '';
    const original =
      !f.is_dubbed &&
      !f.is_descriptive &&
      !f.is_secondary &&
      !f.is_auto_dubbed &&
      (f.is_original === true || (f.is_original !== false && !f.is_drc));
    const row: AudioDescriptor = {
      key: '',
      itag: f.itag,
      codec,
      container,
      bitrate: positive(f.bitrate),
      averageBitrate: positive(f.average_bitrate),
      quality: f.audio_quality,
      sampleRate: positive(f.audio_sample_rate),
      channels: positive(f.audio_channels),
      track: f.audio_track?.id,
      language: f.language ?? 'original',
      original,
      drc: !!f.is_drc,
      length: f.content_length,
      supported: true,
      muxed: !!f.has_video || f.mime_type?.startsWith('video/'),
    };
    if (row.muxed) {
      row.bitrate = undefined;
      row.averageBitrate = undefined;
    }
    row.key = JSON.stringify([
      row.itag,
      row.codec,
      row.container,
      row.track ?? '',
      row.language,
      row.original,
      row.drc,
      row.muxed,
      row.quality,
      row.averageBitrate ?? row.bitrate,
      row.sampleRate,
      row.channels,
      row.length,
    ]);
    row.reason =
      !Number.isSafeInteger(f.itag) || f.itag <= 0
        ? 'Invalid source itag'
        : !f.has_audio || (row.muxed && !allowMuxed) || f.has_text
          ? 'Audio-only source required'
          : f.is_type_otf || f.drm_families?.length || f.fair_play_key_uri
            ? 'DRM or segmented source unsupported'
            : !container || !/^(opus|mp4a\.)/.test(codec)
              ? 'Unsupported source container/codec'
              : !validAudioLength(row.length)
                ? 'Cannot verify complete audio: content length missing or invalid'
                : undefined;
    row.supported = !row.reason;
    return row;
  });
export const reportedBitrate = (f: AudioDescriptor) =>
  f.averageBitrate ?? f.bitrate ?? 0;
export const qualityTier = (f: AudioDescriptor) =>
  ({ AUDIO_QUALITY_HIGH: 3, AUDIO_QUALITY_MEDIUM: 2, AUDIO_QUALITY_LOW: 1 })[
    f.quality ?? ''
  ] ?? 0;
export function selectAudioFormat(
  rows: readonly AudioDescriptor[],
  preference: AudioPreference = { mode: 'best' },
  key?: string,
): AudioDescriptor {
  if (key) {
    const exact = rows.filter((f) => f.supported && f.key === key);
    if (exact.length !== 1)
      throw new Error(
        'Selected source variant is no longer available or has ambiguous identity',
      );
    return exact[0];
  }
  const language = preference.language ?? 'original';
  let candidates = rows.filter(
    (f) =>
      f.supported &&
      (language === 'original'
        ? f.original ||
          (preference.drc &&
            f.drc &&
            rows.some(
              (plain) =>
                plain.original &&
                !plain.drc &&
                plain.itag === f.itag &&
                plain.codec === f.codec &&
                plain.track === f.track &&
                plain.language === f.language &&
                plain.channels === f.channels &&
                plain.sampleRate === f.sampleRate,
            ))
        : f.language === language) &&
      (preference.drc || !f.drc),
  );
  if (preference.mode === 'opus')
    candidates = candidates.filter((f) => f.codec === 'opus');
  if (preference.mode === 'aac')
    candidates = candidates.filter((f) => f.codec.startsWith('mp4a.'));
  if (preference.mode === 'itag')
    candidates = candidates.filter((f) => f.itag === preference.itag);
  if (preference.mode === 'bitrate')
    candidates = candidates.filter(
      (f) =>
        reportedBitrate(f) > 0 &&
        reportedBitrate(f) <= (preference.bitrate ?? 0) * 1000,
    );
  if (preference.mode !== 'itag' && candidates.some((f) => !f.muxed))
    candidates = candidates.filter((f) => !f.muxed);
  if (!candidates.length)
    throw new Error(
      'Requested source is not offered for this track/current session',
    );
  // Best prefers server-declared tier, then Opus; bitrate orders only that codec.
  candidates.sort(
    (a, b) =>
      (preference.mode === 'bitrate'
        ? reportedBitrate(b) - reportedBitrate(a)
        : 0) ||
      qualityTier(b) - qualityTier(a) ||
      Number(b.codec === 'opus') - Number(a.codec === 'opus') ||
      reportedBitrate(b) - reportedBitrate(a) ||
      a.key.localeCompare(b.key),
  );
  const chosen = candidates[0];
  if (candidates.filter((f) => f.key === chosen.key).length !== 1)
    throw new Error('Ambiguous source format identity');
  return chosen;
}
export function sourceContainer(row: AudioDescriptor) {
  if (!row.supported || !['webm', 'm4a'].includes(row.container))
    throw new Error(row.reason ?? 'Unsupported source container');
  return row.container;
}
export function validateAudioPreference(value: unknown): AudioPreference {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid source preference');
  const p = value as AudioPreference;
  if (!['best', 'opus', 'aac', 'bitrate', 'itag'].includes(p.mode))
    throw new Error('Invalid source mode');
  if (
    (p.mode === 'bitrate' || p.bitrate !== undefined) &&
    (!Number.isFinite(p.bitrate) || p.bitrate! <= 0 || p.bitrate! > 10000)
  )
    throw new Error('Invalid source bitrate');
  if (
    (p.mode === 'itag' || p.itag !== undefined) &&
    (!Number.isSafeInteger(p.itag) || p.itag! <= 0)
  )
    throw new Error('Invalid source itag');
  if (
    p.language !== undefined &&
    (typeof p.language !== 'string' || !/^[\w-]{1,40}$/.test(p.language))
  )
    throw new Error('Invalid audio language');
  if (p.drc !== undefined && typeof p.drc !== 'boolean')
    throw new Error('Invalid DRC preference');
  return {
    mode: p.mode,
    bitrate: p.bitrate,
    itag: p.itag,
    language: p.language,
    drc: p.drc,
  };
}
