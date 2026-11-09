import type { SearchSongInfo } from '../types';

type MatchedTrack = {
  track_name: string;
  artist_name: string;
  track_length?: number;
};

// Adapted from PR4734's comparison/normalization, without its candidate model.
const comparisonText = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const artistText = (text: string) =>
  comparisonText(text.replace(/\s*[-–—]\s*topic$/i, ''));

const titleText = (text: string) =>
  comparisonText(
    text
      .replace(
        /\b(?:official\s+(?:music\s+)?(?:video|audio|lyric(?:s)?\s+video)|lyrics?\s+video)\b/gi,
        '',
      )
      .replace(/[[(](?:hd|4k|lyrics?)[\])]/gi, ''),
  );

const artists = (text: string) =>
  text
    .split(/\s*(?:&|,|;)\s*|\s+(?:featuring|feat\.?)\s+/i)
    .map(artistText)
    .filter(Boolean);

const withoutArtistPrefix = (title: string, artist: string) => {
  const normalized = title.normalize('NFKC');
  const parts = normalized.split(/\s[-–—]\s/);
  return parts.length > 1 && artistText(parts[0]) === artistText(artist)
    ? parts.slice(1).join(' - ')
    : normalized;
};

const hasExplicitVersion = (title: string) =>
  Array.from(
    title
      .normalize('NFKC')
      .matchAll(/\(([^)]*)\)|\[([^\]]*)\]|\s[-–—]\s(.+)$/g),
  ).some((annotation) =>
    /\b(?:live|remix(?:ed)?|remaster(?:ed)?|acoustic|instrumental|karaoke|sped up|slowed|edit|mix|version)\b/.test(
      comparisonText(annotation[1] ?? annotation[2] ?? annotation[3]),
    ),
  );

export const matchesMusixMatchTrack = (
  info: SearchSongInfo,
  track: MatchedTrack,
) => {
  // Service metadata is authoritative. Presentation cleanup belongs only to
  // request fallbacks, never to a legitimate title such as "Official Audio".
  const actualTitle = comparisonText(track.track_name);
  const primaryHasVersion = hasExplicitVersion(
    withoutArtistPrefix(info.title, info.artist),
  );
  const expectedTitles = [
    info.title,
    // linkAlternates titles are opportunistic, not recording identity. Keep
    // explicit primary versions instead of accepting a plainer studio alias.
    ...(primaryHasVersion ? [] : [info.alternativeTitle]),
  ].filter((title): title is string => typeof title === 'string' && !!title);
  const matchesRequestTitle = (title: string) =>
    comparisonText(title) === actualTitle || titleText(title) === actualTitle;
  const titleMatches = expectedTitles.some((title) => {
    if (matchesRequestTitle(title)) return true;
    // Video titles may explicitly prefix the same artist; keep other/version
    // suffixes intact rather than stripping arbitrary parentheses or dashes.
    const unprefixed = withoutArtistPrefix(title, info.artist);
    return unprefixed !== title && matchesRequestTitle(unprefixed);
  });
  const expectedArtists = artists(info.artist);
  const actualArtists = artists(track.artist_name);
  return (
    !!actualTitle &&
    titleMatches &&
    expectedArtists.length > 0 &&
    expectedArtists.every((artist) => actualArtists.includes(artist)) &&
    !(
      track.track_length !== undefined &&
      track.track_length > 0 &&
      Number.isFinite(info.songDuration) &&
      info.songDuration > 0 &&
      Math.abs(track.track_length - info.songDuration) > 15
    )
  );
};
