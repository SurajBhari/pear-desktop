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
export type MetadataTarget = { videoId: string } | { current: true };
export interface MetadataBinding {
  videoId: string;
  playbackEpoch: string | null;
}
export interface LyricsResult {
  videoId: string;
  available: boolean;
  lyrics: string | null;
  source: string | null;
}
export interface NativeLyricsMetadata {
  version: 1;
  binding: MetadataBinding;
  lyrics: LyricsResult;
}
export interface NativeRelatedMetadata {
  version: 1;
  binding: MetadataBinding;
  source: NormalizedMusicSource;
}
export interface NativeMetadataProbe {
  version: 1;
  binding: MetadataBinding;
}
export type MusicPrepareInput =
  | { action: 'play_song'; videoId: string; playlistId?: string }
  | {
      action: 'play_playlist';
      playlistId: string;
      videoId?: string;
      shuffle: boolean;
    }
  | {
      action: 'radio';
      seed:
        | { kind: 'video'; videoId: string }
        | { kind: 'playlist'; playlistId: string }
        | { kind: 'current' };
    };
export type MusicMutationInput = MusicPrepareInput & { operationId: string };
export type MusicControlCommand =
  | {
      action:
        | 'previous'
        | 'next'
        | 'play'
        | 'pause'
        | 'toggle_playback'
        | 'toggle_shuffle';
    }
  | { action: 'switch_repeat'; iterations: 1 | 2 }
  | { action: 'seek'; seconds: number; playbackEpoch: string }
  | { action: 'set_volume'; volume: number };
export type MusicQueueCommand =
  | {
      action: 'enqueue_song';
      videoId: string;
      insertPosition: 'INSERT_AT_END' | 'INSERT_AFTER_CURRENT_VIDEO';
    }
  | {
      action: 'enqueue_playlist';
      playlistId: string;
      videoId?: string;
      insertPosition: 'INSERT_AT_END' | 'INSERT_AFTER_CURRENT_VIDEO';
    }
  | {
      action: 'remove_from_queue';
      queueRevision: string;
      index: number;
      expectedVideoId: string;
    }
  | { action: 'clear_queue'; queueRevision: string };
export type MusicQueueMutationInput = MusicQueueCommand & {
  operationId: string;
};
export type MusicOperationCommand =
  | MusicPrepareInput
  | MusicControlCommand
  | MusicQueueCommand;
export const musicOperationScope = (
  command: MusicOperationCommand,
): 'queue.write' | 'playback.control' =>
  [
    'enqueue_song',
    'enqueue_playlist',
    'remove_from_queue',
    'clear_queue',
  ].includes(command.action)
    ? 'queue.write'
    : 'playback.control';
export type NativeQueueActionValue =
  | { version: 1; phase: 'owned_queue_dispatch'; count?: number }
  | { version: 1; phase: 'owned_queue_noop'; count: 0 }
  | { version: 1; phase: 'pre_effect_denial'; reason: MusicFailure };
export type MusicControlMutationInput = MusicControlCommand & {
  operationId: string;
};
export type NativeControlValue =
  | { version: 1; phase: 'owned_control_dispatch' }
  | { version: 1; phase: 'pre_effect_denial'; reason: MusicFailure };
export interface MusicOperationReceipt {
  operationId: string;
  status: 'pending' | 'accepted' | 'failed' | 'uncertain' | 'retired';
  meaning?:
    | 'owned_navigation_dispatch'
    | 'owned_control_dispatch'
    | 'owned_queue_dispatch'
    | 'owned_queue_noop';
  error?: MusicFailure | 'outcome_unknown';
}
export type NativeNavigationValue =
  | { version: 1; phase: 'owned_dispatch'; binding?: MetadataBinding }
  | { version: 1; phase: 'pre_effect_denial'; reason: MusicFailure };
export type MusicReadInput =
  | {
      operation: 'mutate-queue';
      command: MusicQueueCommand;
      deadlineAt: number;
    }
  | { operation: 'control'; command: MusicControlCommand; deadlineAt: number }
  | { operation: 'navigate'; command: MusicPrepareInput; deadlineAt: number }
  | { operation: 'lyrics'; target: MetadataTarget; deadlineAt: number }
  | { operation: 'related'; target: MetadataTarget; deadlineAt: number }
  | { operation: 'metadata-current'; deadlineAt: number }
  | {
      operation: 'related-continuation';
      token: string;
      binding: MetadataBinding;
      deadlineAt: number;
    }
  | { operation: 'current' }
  | { operation: 'queue' }
  | { operation: 'home' }
  | { operation: 'library' }
  | {
      operation: 'search';
      query: string;
      filter?: 'songs' | 'videos' | 'albums' | 'artists' | 'playlists';
    }
  | {
      operation: 'browse';
      browseId: string;
      params?: string;
      expectedCurrent?: MetadataBinding;
      deadlineAt?: number;
    }
  | {
      operation: 'continuation';
      endpoint: 'search' | 'browse';
      token: string;
      expectedCurrent?: MetadataBinding;
      deadlineAt?: number;
    };
export type NativeMusicValue =
  | NativeNavigationValue
  | NativeControlValue
  | NativeQueueActionValue
  | NativeLyricsMetadata
  | NativeRelatedMetadata
  | NativeMetadataProbe
  | PlaybackSnapshot
  | NormalizedMusicSource
  | NativeQueueSnapshot;
export interface NativeQueueSnapshot {
  version: 1;
  queueRevision: string;
  selectedIndex: number | null;
  items: MusicItem[];
}
export interface QueuePage {
  version: 1;
  queueRevision: string;
  total: number;
  selectedIndex: number | null;
  items: { index: number; selected: boolean; item: MusicItem }[];
  nextCursor: string | null;
}
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
  | 'not_found'
  | 'unknown_operation'
  | 'expired_operation'
  | 'conflict';
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
  unknown_operation: 'Music operation history is unavailable.',
  expired_operation: 'Music operation has expired.',
  conflict: 'Music operation command conflicts with its preparation.',
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
