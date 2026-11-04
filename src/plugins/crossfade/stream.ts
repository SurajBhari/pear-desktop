/** youtubei.js 17.2 Format fields; no private session or credential copying. */
export type AudioFormatCandidate = {
  has_audio: boolean;
  has_video: boolean;
  is_type_otf: boolean;
  mime_type: string;
  bitrate: number;
  content_length?: number;
  itag: number;
  is_original?: boolean;
  is_dubbed?: boolean;
  is_descriptive?: boolean;
  is_secondary?: boolean;
  is_auto_dubbed?: boolean;
  is_drc?: boolean;
  audio_track?: { audio_is_default?: boolean };
};
export type StreamResult = {
  url: string;
  mimeType: string;
  contentLength: number;
};
const maxBytes = 64 * 1024 * 1024;
const audioMime = (mime: unknown): mime is string =>
  typeof mime === 'string' &&
  /^audio\/(?:webm|mp4|ogg|mpeg|wav)(?:\s*;[^\r\n]*)?$/.test(mime);
const size = (bytes: unknown): bytes is number =>
  typeof bytes === 'number' &&
  Number.isSafeInteger(bytes) &&
  bytes > 0 &&
  bytes <= maxBytes;
export function selectCrossfadeAudioFormat<T extends AudioFormatCandidate>(
  formats: readonly T[],
): T | null {
  return (
    formats
      .filter(
        (f) =>
          f.has_audio === true &&
          f.has_video === false &&
          f.is_type_otf === false &&
          audioMime(f.mime_type) &&
          Number.isFinite(f.bitrate) &&
          f.bitrate > 0 &&
          f.bitrate <= 256000 &&
          size(f.content_length) &&
          Number.isSafeInteger(f.itag) &&
          ![
            f.is_dubbed,
            f.is_descriptive,
            f.is_secondary,
            f.is_auto_dubbed,
            f.is_drc,
          ].some((v) => v === true) &&
          f.is_original !== false &&
          (f.is_original === true ||
            f.audio_track?.audio_is_default === true) &&
          (!f.audio_track || f.audio_track.audio_is_default === true),
      )
      .sort((a, b) => b.bitrate - a.bitrate || a.itag - b.itag)[0] ?? null
  );
}
export function validCrossfadeStream(value: unknown): value is StreamResult {
  if (!value || typeof value !== 'object') return false;
  const stream = value as Partial<StreamResult>;
  if (
    !audioMime(stream.mimeType) ||
    !size(stream.contentLength) ||
    typeof stream.url !== 'string'
  )
    return false;
  try {
    const url = new URL(stream.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
