import type { FilterTrack } from '@/plugins/utils/renderer/playback-filter';

export type BlockedArtist = { name: string; channelId?: string };
export const normalizeArtist = (name: string) =>
  name
    .normalize('NFC')
    .replace(/\s*-\s*topic\s*$/i, '')
    .trim()
    .toLowerCase();
export const channelIdFromUrl = (value?: string) => {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value, 'https://music.youtube.com');
    if (
      ![
        'https://music.youtube.com',
        'https://www.youtube.com',
        'https://youtube.com',
        'https://m.youtube.com',
      ].includes(url.origin) ||
      url.username ||
      url.password
    )
      return;
    return url.pathname.match(/^\/(?:channel|browse)\/(UC[\w-]+)\/?$/)?.[1];
  } catch {
    return;
  }
};

export function artistsFromConfig(value: unknown): BlockedArtist[] {
  if (!Array.isArray(value)) return [];
  return value.filter((artist): artist is BlockedArtist => {
    if (!artist || typeof artist !== 'object') return false;
    const record = artist as Record<string, unknown>;
    return (
      typeof record.name === 'string' &&
      !!normalizeArtist(record.name) &&
      (record.channelId === undefined ||
        (typeof record.channelId === 'string' &&
          /^UC[\w-]+$/.test(record.channelId)))
    );
  });
}
export const validArtistList = (value: unknown): value is BlockedArtist[] =>
  Array.isArray(value) && artistsFromConfig(value).length === value.length;
export const sameArtist = (a: BlockedArtist, b: BlockedArtist) =>
  a.channelId && b.channelId
    ? a.channelId === b.channelId
    : normalizeArtist(a.name) === normalizeArtist(b.name);
export function matchesArtist(value: unknown, track: FilterTrack) {
  const channelId = channelIdFromUrl(track.artistUrl) || track.channelId;
  const whole = normalizeArtist(track.artist);
  // Explicit collaboration markers are meaningful; punctuation alone can be a band name.
  const parts = track.artist
    .split(/\s+(?:feat\.?|ft\.?)\s+/i)
    .map(normalizeArtist);
  return artistsFromConfig(value).some((artist) => {
    if (
      track.artists.some((item) =>
        artist.channelId
          ? item.channelId === artist.channelId
          : normalizeArtist(item.name) === normalizeArtist(artist.name),
      )
    )
      return true;
    // A keyed collaborator with this name is authoritative even when no native
    // primary channel is available. Never weaken a known conflict to a name.
    if (
      artist.channelId &&
      track.artists.some(
        (item) => normalizeArtist(item.name) === normalizeArtist(artist.name),
      )
    )
      return false;
    return artist.channelId && channelId
      ? artist.channelId === channelId
      : normalizeArtist(artist.name) === whole ||
          parts.includes(normalizeArtist(artist.name));
  });
}
