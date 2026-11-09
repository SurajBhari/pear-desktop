import { jaroWinkler } from '@skyra/jaro-winkler';

import { matchesMusixMatchTrack } from './musixmatch-matching';

import type { SearchSongInfo } from '../types';

export const LRCLIB_LIMITS = {
  queries: 4,
  candidates: 200,
  responseBytes: 1024 * 1024,
  lyricsCharacters: 65536,
  deadlineMs: 8000,
} as const;

const metadataText = (value: unknown, maximum = 512): string | undefined => {
  if (typeof value !== 'string' || value.length > maximum) return;
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return result && result.length <= maximum ? result : undefined;
};
const compare = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
const cleanArtist = (value: string) =>
  value.replace(/\s*[-–—]\s*topic$/i, '').trim();
const compareArtist = (value: string) =>
  compare(value) || value.normalize('NFKC').toLowerCase().trim();
const artistParts = (value: string) => [
  ...new Map(
    value
      .split(/\s*(?:&|,|;)\s*|\s+(?:featuring|feat\.?)\s+/i)
      .map(cleanArtist)
      .filter(Boolean)
      .map((part) => [compareArtist(part), part]),
  ).values(),
];
const artistKeys = (value: string) => artistParts(value).map(compareArtist);
const sameArtists = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));
const unprefix = (title: string, artist: string) => {
  const parts = title.split(/\s[-–—]\s/);
  return parts.length > 1 &&
    sameArtists(artistKeys(parts[0]), artistKeys(artist))
    ? parts.slice(1).join(' - ')
    : title;
};
const presentationTitle = (title: string, artist: string) =>
  unprefix(title, artist)
    .replace(
      /\b(?:official\s+(?:music\s+)?(?:video|audio|lyric(?:s)?\s+video)|lyrics?\s+video)\b/gi,
      '',
    )
    .replace(/[[(](?:hd|4k|lyrics?)[\])]/gi, '')
    .replace(/[[(]\s*[\])]/g, '')
    .trim() || unprefix(title, artist);
const version = (title: string) =>
  Array.from(title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]|\s[-–—]\s(.+)$/g))
    .map((part) => compare(part[1] ?? part[2] ?? part[3]))
    .filter((part) =>
      /\b(?:live|remix(?:ed)?|remaster(?:ed)?|acoustic|instrumental|karaoke|sped up|slowed|edit|mix|version)\b/.test(
        part,
      ),
    )
    .join('|');

export interface LRCLibRequest {
  info: SearchSongInfo;
  titles: string[];
  artists: string[];
  artistVariants: string[];
  album?: string;
  duration?: number;
  version: string;
  queries: URLSearchParams[];
}
export function planLRCLibSearch(info: SearchSongInfo): LRCLibRequest | null {
  const title = metadataText(info.title),
    artist = metadataText(info.artist, 256);
  if (!title || !artist) return null;
  const normalizedArtist = cleanArtist(artist),
    artists = artistParts(normalizedArtist);
  if (!artists.length || artists.length > 8) return null;
  const primaryVersion = version(unprefix(title, normalizedArtist));
  const alt = metadataText(info.alternativeTitle);
  const titles = [
    title,
    ...(alt && version(unprefix(alt, normalizedArtist)) === primaryVersion
      ? [alt]
      : []),
  ];
  const album = metadataText(info.album);
  const duration =
    Number.isFinite(info.songDuration) && info.songDuration > 0
      ? info.songDuration
      : undefined;
  const artistVariants = [normalizedArtist];
  const tags = Array.isArray(info.tags)
    ? info.tags
        .slice(0, 16)
        .map((tag) => metadataText(tag, 256))
        .filter((tag): tag is string => !!tag)
        .map(compare)
    : [];
  for (const candidate of titles) {
    const parts = candidate.split(/\s[-–—]\s/),
      prefix = parts[0];
    if (
      parts.length > 1 &&
      tags.includes(compare(prefix)) &&
      !/^(?:music|video|official|audio|lyrics|live|song|pop|rock)$/.test(
        compare(prefix),
      ) &&
      artistParts(prefix).length <= 8 &&
      !artistVariants.includes(prefix)
    )
      artistVariants.push(prefix);
  }
  const main = presentationTitle(title, normalizedArtist),
    alternative =
      alt && titles.includes(alt)
        ? presentationTitle(alt, normalizedArtist)
        : undefined;
  const queries: URLSearchParams[] = [],
    seen = new Set<string>();
  const add = (params: Record<string, string>) => {
    const query = new URLSearchParams(params),
      key = query.toString();
    if (
      key.length <= 8192 &&
      !seen.has(key) &&
      queries.length < LRCLIB_LIMITS.queries
    ) {
      seen.add(key);
      queries.push(query);
    }
  };
  add({
    artist_name: normalizedArtist,
    track_name: main,
    ...(album ? { album_name: album } : {}),
  });
  if (alternative && compare(alternative) !== compare(main))
    add({
      artist_name: normalizedArtist,
      track_name: alternative,
      ...(album ? { album_name: album } : {}),
    });
  add({ q: `${normalizedArtist} ${alternative ?? main}` });
  add({ q: main });
  return {
    info: {
      ...info,
      title,
      alternativeTitle: titles.length > 1 ? titles[1] : undefined,
      artist: normalizedArtist,
    },
    titles,
    artists,
    artistVariants,
    album,
    duration,
    version: primaryVersion,
    queries,
  };
}

export interface LRCLibTrack {
  trackName: string;
  artistName: string;
  albumName?: string;
  duration: number;
  instrumental: boolean;
  syncedLyrics?: string;
  plainLyrics?: string;
  lyricsfile?: string;
}
export function parseLRCLibTrack(value: unknown): LRCLibTrack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>,
    title = metadataText(row.trackName),
    artist = metadataText(row.artistName, 256);
  if (
    !title ||
    !artist ||
    typeof row.duration !== 'number' ||
    !Number.isFinite(row.duration) ||
    row.duration <= 0 ||
    row.duration > 86400 ||
    typeof row.instrumental !== 'boolean'
  )
    return null;
  const text = (input: unknown) =>
    typeof input === 'string' && input.length <= LRCLIB_LIMITS.lyricsCharacters
      ? input
      : undefined;
  return {
    trackName: title,
    artistName: artist,
    albumName: metadataText(row.albumName),
    duration: row.duration,
    instrumental: row.instrumental,
    syncedLyrics: text(row.syncedLyrics),
    plainLyrics: text(row.plainLyrics),
    lyricsfile: text(row.lyricsfile),
  };
}
export interface LRCLibIdentity {
  exact: boolean;
  rank: number;
  album: number;
  duration: number;
  artists: string[];
}
export function rankLRCLibIdentity(
  request: LRCLibRequest,
  track: LRCLibTrack,
  fuzzy: boolean,
): LRCLibIdentity | null {
  const actualParts = artistParts(track.artistName),
    actual = actualParts.map(compareArtist);
  if (
    !actual.length ||
    actual.length > 8 ||
    version(track.trackName) !== request.version
  )
    return null;
  const delta =
    request.duration === undefined
      ? 15
      : Math.abs(track.duration - request.duration);
  if (delta > 15) return null;
  let best: LRCLibIdentity | null = null;
  for (const [variant, artist] of request.artistVariants.entries()) {
    const expectedParts = artistParts(artist),
      expected = expectedParts.map(compareArtist);
    const literalSymbolIdentity =
      expected.some((name) => !compare(name)) &&
      request.titles.some(
        (title) =>
          unprefix(title, artist).toLowerCase() ===
          track.trackName.toLowerCase(),
      );
    const strict =
      (matchesMusixMatchTrack(
        { ...request.info, artist },
        {
          track_name: track.trackName,
          artist_name: track.artistName,
          track_length: track.duration,
        },
      ) ||
        literalSymbolIdentity) &&
      sameArtists(expected, actual);
    let ordered: string[];
    if (!strict) {
      if (!fuzzy || expected.length !== actual.length) continue;
      const remaining = actualParts.map((part) => ({
          part,
          key: compareArtist(part),
        })),
        assigned: string[] = [];
      if (
        !expected.every((name) => {
          const index = remaining.findIndex(
            (item) => jaroWinkler(name, item.key) > 0.94,
          );
          if (index < 0) return false;
          assigned.push(remaining.splice(index, 1)[0].part);
          return true;
        })
      )
        continue;
      if (
        !request.titles.some(
          (title) =>
            jaroWinkler(
              compare(presentationTitle(title, artist)),
              compare(track.trackName),
            ) > 0.94,
        )
      )
        continue;
      ordered = assigned;
    } else {
      ordered = expected.map(
        (name) => actualParts.find((part) => compareArtist(part) === name)!,
      );
    }
    const album =
      request.album && track.albumName
        ? jaroWinkler(compare(request.album), compare(track.albumName))
        : 0;
    const rank = strict ? (variant === 0 ? 3 : 2) : 1;
    if (!best || rank > best.rank)
      best = {
        exact: strict && variant === 0,
        rank,
        album,
        duration: delta,
        artists: ordered,
      };
  }
  return best;
}
