import { z } from 'zod';

import {
  parseControlCommand,
  parseQueueCommand,
} from '@/providers/music-actions';
import { assertMetadataWorkBudget } from '@/providers/music-metadata';
import { isPlaylistId, isVideoId } from '@/providers/queue-playlist';

import { MUSIC_LIMITS, failMusic, utf8Bytes } from '../../music-types';

const scalarText = (maximum: number) =>
  z.string().refine(
    (v) =>
      !!v.trim() &&
      v.length <= maximum * 2 &&
      Array.from(v).length <= maximum &&
      Array.from(v).every((c) => {
        const n = c.charCodeAt(0);
        return (
          n >= 32 &&
          n !== 127 &&
          !(c.length === 1 && n >= 0xd800 && n <= 0xdfff)
        );
      }),
  );
const artistId = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
  albumId = z.string().regex(/^MPRE[A-Za-z0-9_-]{1,124}$/),
  playlistId = z.string().refine(isPlaylistId);
const categoryId = z.enum(['explore', 'charts', 'genres', 'new-releases']);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artist'), id: artistId }).strict(),
  z.object({ kind: z.literal('album'), id: albumId }).strict(),
  z.object({ kind: z.literal('playlist'), id: playlistId }).strict(),
  z.object({ kind: z.literal('category'), id: categoryId }).strict(),
  z
    .object({
      kind: z.literal('reference'),
      id: z.string().regex(/^mref_[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
]);
export type MusicTarget = z.infer<typeof targetSchema>;
const limit = z.number().int().min(1).max(MUSIC_LIMITS.pageItems).default(50);
const cursorSchema = z
  .object({ cursor: z.string().regex(/^mcur_[A-Za-z0-9_-]{43}$/), limit })
  .strict();
const searchSchema = z
  .object({
    query: scalarText(256).refine((v) => utf8Bytes(v) <= 1024),
    kind: z.enum(['song', 'video', 'album', 'artist', 'playlist']).optional(),
    limit,
  })
  .strict();
const browseSchema = z.object({ target: targetSchema, limit }).strict();
export type MusicClientInput =
  | (z.infer<typeof searchSchema> & { operation: 'search' })
  | (z.infer<typeof browseSchema> & { operation: 'browse' })
  | (z.infer<typeof cursorSchema> & {
      operation: 'page';
      route: 'search' | 'browse';
    });
export function parseMusicInput(
  value: unknown,
  operation: 'search' | 'browse',
): MusicClientInput {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'cursor')) {
    const parsed = cursorSchema.safeParse(value);
    if (!parsed.success) return failMusic('invalid');
    return { operation: 'page', route: operation, ...parsed.data };
  }
  if (operation === 'search') {
    const parsed = searchSchema.safeParse(value);
    if (!parsed.success) return failMusic('invalid');
    return { operation, ...parsed.data };
  }
  const parsed = browseSchema.safeParse(value);
  if (!parsed.success) return failMusic('invalid');
  return { operation, ...parsed.data };
}
const nullableClock = z.number().finite().nonnegative().nullable();
const itemSchema = z
  .object({
    kind: z.enum(['song', 'video', 'artist', 'album', 'playlist', 'category']),
    id: z.string(),
    title: scalarText(512),
    artists: z
      .array(
        z.object({ name: scalarText(256), id: artistId.optional() }).strict(),
      )
      .max(8),
    durationSeconds: nullableClock,
    album: z
      .object({ id: albumId, title: scalarText(512) })
      .strict()
      .optional(),
    thumbnailUrl: z
      .string()
      .refine((v) => {
        if (utf8Bytes(v) > 2048) return false;
        try {
          const url = new URL(v);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      })
      .optional(),
  })
  .strict()
  .refine((item) =>
    item.kind === 'song' || item.kind === 'video'
      ? isVideoId(item.id)
      : item.kind === 'artist'
        ? artistId.safeParse(item.id).success
        : item.kind === 'album'
          ? albumId.safeParse(item.id).success
          : item.kind === 'playlist'
            ? isPlaylistId(item.id)
            : categoryId.safeParse(item.id).success,
  );
const shelfSchema = z
  .object({
    title: scalarText(512),
    start: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();
const privateCategories = z.enum([
  'FEmusic_explore',
  'FEmusic_charts',
  'FEmusic_moods_and_genres',
  'FEmusic_moods_and_genres_category',
  'FEmusic_new_releases',
  'FEmusic_new_releases_albums',
]);
const privateText = scalarText(MUSIC_LIMITS.recipeBytes).refine(
  (v) => utf8Bytes(v) <= MUSIC_LIMITS.recipeBytes,
);
const catalogSchema = z
  .object({
    version: z.literal(1),
    items: z.array(itemSchema).max(MUSIC_LIMITS.sourceItems),
    shelves: z.array(shelfSchema).max(MUSIC_LIMITS.sourceShelves),
    continuation: z
      .object({ endpoint: z.enum(['search', 'browse']), token: privateText })
      .strict()
      .nullable(),
    targetRecipes: z
      .array(
        z
          .object({
            itemIndex: z.number().int().nonnegative(),
            browseId: privateCategories,
            params: privateText.optional(),
          })
          .strict(),
      )
      .max(MUSIC_LIMITS.sourceItems),
  })
  .strict()
  .refine(
    (v) =>
      v.shelves.every((s) => s.start + s.count <= v.items.length) &&
      v.targetRecipes.every((r) => v.items[r.itemIndex]?.kind === 'category') &&
      new Set(v.targetRecipes.map((r) => r.itemIndex)).size ===
        v.targetRecipes.length,
  );
const snapshotSchema = z
  .object({
    version: z.literal(1),
    playbackEpoch: z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{32}$/),
    current: itemSchema.nullable(),
    state: z.enum(['playing', 'paused', 'buffering', 'stopped', 'unknown']),
    elapsedSeconds: nullableClock,
    elapsedMilliseconds: nullableClock,
    durationSeconds: nullableClock,
    volume: z.number().finite().min(0).max(100).nullable(),
  })
  .strict()
  .refine((v) =>
    v.elapsedSeconds === null
      ? v.elapsedMilliseconds === null
      : v.elapsedMilliseconds === v.elapsedSeconds * 1000,
  );
export function parseNativeCatalog(
  value: unknown,
  operation?: 'search' | 'browse',
) {
  const parsed = catalogSchema.safeParse(value);
  if (
    !parsed.success ||
    (operation &&
      parsed.data.continuation &&
      parsed.data.continuation.endpoint !== operation) ||
    utf8Bytes(JSON.stringify(parsed.data)) > MUSIC_LIMITS.nativeBytes
  )
    return failMusic('source');
  return parsed.data;
}
export function parseNativeSnapshot(value: unknown) {
  const parsed = snapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    utf8Bytes(JSON.stringify(parsed.data)) > MUSIC_LIMITS.pageBytes
  )
    return failMusic('source');
  return parsed.data;
}

const queueInputSchema = z
  .object({
    limit,
    cursor: z
      .string()
      .regex(/^mcur_[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict();
export function parseMusicQueueInput(value: unknown) {
  const parsed = queueInputSchema.safeParse(value);
  if (!parsed.success) return failMusic('invalid');
  return parsed.data;
}
export function parseMusicQueueQuery(query: URLSearchParams) {
  const value: Record<string, unknown> = {};
  for (const [key, field] of query) {
    if (!['limit', 'cursor'].includes(key) || Object.hasOwn(value, key))
      return failMusic('invalid');
    if (key === 'limit') {
      if (!/^[1-9][0-9]{0,2}$/.test(field)) return failMusic('invalid');
      value.limit = Number(field);
    } else value.cursor = field;
  }
  return parseMusicQueueInput(value);
}
/** Collections share the canonical limit/cursor grammar; no native recipe is client input. */
export const parseMusicCollectionInput = parseMusicQueueInput;
export const parseMusicCollectionQuery = parseMusicQueueQuery;
const queueSchema = z
  .object({
    version: z.literal(1),
    queueRevision: z.string().regex(/^[0-9a-f]{32}$/),
    selectedIndex: z.number().int().nonnegative().nullable(),
    items: z.array(itemSchema).max(MUSIC_LIMITS.sourceItems),
  })
  .strict()
  .refine((v) => v.selectedIndex === null || v.selectedIndex < v.items.length);
export function parseNativeQueue(value: unknown) {
  const parsed = queueSchema.safeParse(value);
  if (
    !parsed.success ||
    utf8Bytes(JSON.stringify(parsed.data)) > MUSIC_LIMITS.nativeBytes
  )
    return failMusic('source');
  return parsed.data;
}

const metadataSelector = z.union([
  z.object({ videoId: z.string().refine(isVideoId) }).strict(),
  z.object({ current: z.literal(true) }).strict(),
]);
const relatedSelector = z.union([
  z.object({ videoId: z.string().refine(isVideoId), limit }).strict(),
  z.object({ current: z.literal(true), limit }).strict(),
  cursorSchema,
]);
export function parseMusicLyricsInput(value: unknown) {
  try {
    assertMetadataWorkBudget(value);
  } catch {
    return failMusic('invalid');
  }
  const parsed = metadataSelector.safeParse(value);
  if (!parsed.success) return failMusic('invalid');
  return parsed.data;
}
export function parseMusicRelatedInput(value: unknown) {
  try {
    assertMetadataWorkBudget(value);
  } catch {
    return failMusic('invalid');
  }
  const parsed = relatedSelector.safeParse(value);
  if (!parsed.success) return failMusic('invalid');
  return parsed.data;
}
function metadataQuery(query: URLSearchParams, related: boolean) {
  const value: Record<string, unknown> = {};
  for (const [key, field] of query) {
    if (
      !['videoId', 'current', ...(related ? ['limit', 'cursor'] : [])].includes(
        key,
      ) ||
      Object.hasOwn(value, key)
    )
      return failMusic('invalid');
    if (key === 'current') {
      if (field !== 'true') return failMusic('invalid');
      value.current = true;
    } else if (key === 'limit') {
      if (!/^[1-9][0-9]{0,2}$/.test(field)) return failMusic('invalid');
      value.limit = Number(field);
    } else value[key] = field;
  }
  return value;
}
export const parseMusicLyricsQuery = (query: URLSearchParams) =>
  parseMusicLyricsInput(metadataQuery(query, false));
export const parseMusicRelatedQuery = (query: URLSearchParams) =>
  parseMusicRelatedInput(metadataQuery(query, true));
const metadataBinding = z
  .object({
    videoId: z.string().refine(isVideoId),
    playbackEpoch: z
      .string()
      .regex(/^[0-9a-f]{32}:[0-9a-f]{32}$/)
      .nullable(),
  })
  .strict();
const lyricText = (bytes: number, chars?: number) =>
  z
    .string()
    .refine(
      (v) =>
        utf8Bytes(v) <= bytes &&
        (chars === undefined || Array.from(v).length <= chars) &&
        Array.from(v).every(
          (c) =>
            c.length !== 1 ||
            c.charCodeAt(0) < 0xd800 ||
            c.charCodeAt(0) > 0xdfff,
        ),
    );
const lyricsSchema = z
  .object({
    videoId: z.string().refine(isVideoId),
    available: z.boolean(),
    lyrics: lyricText(65536).nullable(),
    source: lyricText(2048, 512).nullable(),
  })
  .strict()
  .refine((v) =>
    v.available
      ? v.lyrics !== null && v.lyrics.length > 0
      : v.lyrics === null && v.source === null,
  );
const lyricsMetadataSchema = z
  .object({
    version: z.literal(1),
    binding: metadataBinding,
    lyrics: lyricsSchema,
  })
  .strict()
  .refine((v) => v.lyrics.videoId === v.binding.videoId);
const relatedMetadataSchema = z
  .object({
    version: z.literal(1),
    binding: metadataBinding,
    source: catalogSchema,
  })
  .strict();
const probeSchema = z
  .object({
    version: z.literal(1),
    binding: metadataBinding.refine((v) => v.playbackEpoch !== null),
  })
  .strict();
function nativeMetadata<T>(schema: z.ZodType<T>, value: unknown): T {
  assertMetadataWorkBudget(value);
  const parsed = schema.safeParse(value);
  if (
    !parsed.success ||
    utf8Bytes(JSON.stringify(parsed.data)) > MUSIC_LIMITS.nativeBytes
  )
    return failMusic('source');
  return parsed.data;
}
export const parseNativeLyricsMetadata = (value: unknown) =>
  nativeMetadata(lyricsMetadataSchema, value);
export const parseNativeRelatedMetadata = (value: unknown) => {
  const result = nativeMetadata(relatedMetadataSchema, value);
  parseNativeCatalog(result.source, 'browse');
  return result;
};
export const parseNativeMetadataProbe = (value: unknown) =>
  nativeMetadata(probeSchema, value);

const navigationCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('play_song'),
      videoId: z.string().refine(isVideoId),
      playlistId: playlistId.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('play_playlist'),
      playlistId,
      videoId: z.string().refine(isVideoId).optional(),
      shuffle: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal('radio'),
      seed: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('video'),
            videoId: z.string().refine(isVideoId),
          })
          .strict(),
        z.object({ kind: z.literal('playlist'), playlistId }).strict(),
        z.object({ kind: z.literal('current') }).strict(),
      ]),
    })
    .strict(),
]);
function navigationOwnData(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object') return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    depth > 4 ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  )
    return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === 'string' &&
      !!descriptor &&
      'value' in descriptor &&
      navigationOwnData(descriptor.value, depth + 1)
    );
  });
}
export function parseMusicPrepareInput(
  value: unknown,
): import('../../music-types').MusicPrepareInput {
  if (!navigationOwnData(value)) return failMusic('invalid');
  const parsed = navigationCommandSchema.safeParse(value);
  if (!parsed.success) return failMusic('invalid');
  return parsed.data;
}
export function parseMusicOperationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return failMusic('invalid');
  return value.toLowerCase();
}
export function parseMusicMutationInput(
  value: unknown,
): import('../../music-types').MusicMutationInput {
  if (
    !navigationOwnData(value) ||
    !value ||
    typeof value !== 'object' ||
    !Object.hasOwn(value, 'operationId')
  )
    return failMusic('invalid');
  const { operationId, ...command } = value as Record<string, unknown>;
  return {
    ...parseMusicPrepareInput(command),
    operationId: parseMusicOperationId(operationId),
  };
}

export function parseMusicQueueCommand(
  value: unknown,
): import('../../music-types').MusicQueueCommand {
  return parseQueueCommand(value) ?? failMusic('invalid');
}
export function parseMusicQueueMutationInput(
  value: unknown,
): import('../../music-types').MusicQueueMutationInput {
  if (
    !navigationOwnData(value) ||
    !value ||
    typeof value !== 'object' ||
    !Object.hasOwn(value, 'operationId')
  )
    return failMusic('invalid');
  const { operationId, ...command } = value as Record<string, unknown>;
  return {
    ...parseMusicQueueCommand(command),
    operationId: parseMusicOperationId(operationId),
  };
}

export function parseMusicOperationPrepareInput(
  value: unknown,
): import('../../music-types').MusicOperationCommand {
  const command = parseControlCommand(value);
  if (command) return command;
  if (
    navigationOwnData(value) &&
    value &&
    typeof value === 'object' &&
    [
      'enqueue_song',
      'enqueue_playlist',
      'remove_from_queue',
      'clear_queue',
    ].includes((value as { action: string }).action)
  )
    return parseMusicQueueCommand(value);
  return parseMusicPrepareInput(value);
}
export function parseMusicControlMutationInput(
  value: unknown,
): import('../../music-types').MusicControlMutationInput {
  if (
    !navigationOwnData(value) ||
    !value ||
    typeof value !== 'object' ||
    !Object.hasOwn(value, 'operationId')
  )
    return failMusic('invalid');
  const { operationId, ...data } = value as Record<string, unknown>;
  const command = parseControlCommand(data);
  if (!command) return failMusic('invalid');
  return { ...command, operationId: parseMusicOperationId(operationId) };
}
