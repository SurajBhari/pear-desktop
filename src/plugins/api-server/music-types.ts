/** Work/IPC/output limits derived in PUBLIC-FIXTURE-BUDGETS.json, not wire caps. */
export const MUSIC_LIMITS = Object.freeze({
  sourceItems: 2048,
  sourceShelves: 64,
  sourceNodes: 100_000,
  sourceDepth: 32,
  nativeBytes: 1024 * 1024,
  pageItems: 100,
  pageBytes: 256 * 1024,
  bodyBytes: 16 * 1024,
  recipeBytes: 8192,
  cursorMs: 120_000,
  principalCursors: 32,
  globalCursors: 128,
  cacheBytes: 4 * 1024 * 1024,
});
export const MUSIC_SCOPES = [
  'playback.read',
  'catalog.read',
  'personalized.read',
  'library.read',
  'comments.read',
  'playback.control',
  'queue.write',
] as const;
export type MusicScope = (typeof MUSIC_SCOPES)[number];
export type MusicKind =
  | 'song'
  | 'video'
  | 'artist'
  | 'album'
  | 'playlist'
  | 'category';
export type CatalogOperation = 'search' | 'browse' | 'home' | 'library';
export type MusicReadInput =
  | { operation: 'current' }
  | {
      operation: 'search';
      query: string;
      filter?: 'songs' | 'videos' | 'albums' | 'artists' | 'playlists';
    }
  | { operation: 'browse'; browseId: string; params?: string }
  | { operation: 'continuation'; endpoint: 'search' | 'browse'; token: string };
export type NativeMusicValue = PlaybackSnapshot | NormalizedMusicSource;
export type NativeMusicResult =
  | { ok: true; value: NativeMusicValue }
  | { ok: false; reason: MusicFailure };
export interface ArtistReference {
  name: string;
  id?: string;
}
export interface MusicItem {
  kind: MusicKind;
  id: string;
  title: string;
  artists: ArtistReference[];
  durationSeconds: number | null;
  album?: { id: string; title: string };
  thumbnailUrl?: string;
}
export interface MusicShelf {
  title: string;
  start: number;
  count: number;
}
export interface MusicRecipe {
  itemIndex: number;
  browseId: string;
  params?: string;
}
export interface MusicContinuation {
  endpoint: 'search' | 'browse';
  token: string;
}
export interface NormalizedMusicSource {
  version: 1;
  items: MusicItem[];
  shelves: MusicShelf[];
  continuation: MusicContinuation | null;
  targetRecipes: MusicRecipe[];
}
export interface PlaybackSnapshot {
  version: 1;
  playbackEpoch: string;
  current: MusicItem | null;
  state: 'playing' | 'paused' | 'buffering' | 'stopped' | 'unknown';
  elapsedSeconds: number | null;
  elapsedMilliseconds: number | null;
  durationSeconds: number | null;
  volume: number | null;
}
export type MusicFailure =
  | 'invalid'
  | 'source'
  | 'unsupported'
  | 'budget'
  | 'retired'
  | 'busy'
  | 'unavailable'
  | 'timeout'
  | 'forbidden'
  | 'unauthorized'
  | 'not_found';
const messages: Record<MusicFailure, string> = {
  invalid: 'Invalid music request.',
  source: 'Invalid music service response.',
  unsupported: 'Unsupported music service layout.',
  budget: 'Music response budget exceeded.',
  retired: 'Music request owner retired.',
  busy: 'Music service is busy.',
  unavailable: 'Native music API is not ready.',
  timeout: 'Music request deadline exceeded.',
  forbidden: 'Music access is not permitted.',
  unauthorized: 'A valid client grant is required.',
  not_found: 'Music reference not found.',
};
export class MusicServiceError extends Error {
  constructor(readonly code: MusicFailure) {
    super(messages[code]);
  }
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;
export const failMusic = (code: MusicFailure): never => {
  throw new MusicServiceError(code);
};
