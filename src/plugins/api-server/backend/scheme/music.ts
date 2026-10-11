import { z } from 'zod';

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
