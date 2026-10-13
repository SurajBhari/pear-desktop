export interface StatusbarLyricsPluginConfig {
  enabled: boolean;
  maxLength: number;
  includePronunciation: boolean;
}
export const defaultConfig: StatusbarLyricsPluginConfig = {
  enabled: false,
  maxLength: 55,
  includePronunciation: false,
};
export const statusLength = (value: unknown) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 1 &&
  value <= 200
    ? Math.floor(value)
    : 55;

export function normalizeStatusText(value: unknown, length: unknown) {
  if (typeof value !== 'string' || value.length > 16384) return '';
  const text = value.replaceAll('\0', ' ').replace(/\s+/gu, ' ').trim();
  const limit = statusLength(length);
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
  ].map((part) => part.segment);
  return graphemes.length <= limit
    ? text
    : `${graphemes
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`;
}
