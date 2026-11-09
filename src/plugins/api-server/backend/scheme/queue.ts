import { z } from '@hono/zod-openapi';

import {
  PLAYLIST_ID_PATTERN,
  VIDEO_ID_PATTERN,
} from '@/providers/queue-playlist';

export const QueueParamsSchema = z.object({
  index: z.coerce.number().int().nonnegative(),
});

export const AddSongToQueueSchema = z.object({
  videoId: z.string(),
  insertPosition: z
    .enum(['INSERT_AT_END', 'INSERT_AFTER_CURRENT_VIDEO'])
    .optional()
    .default('INSERT_AT_END'),
});
export const AddPlaylistToQueueSchema = z
  .object({
    playlistId: z
      .string()
      .max(128)
      .regex(PLAYLIST_ID_PATTERN)
      .describe('Raw supported playlist ID; URLs are not accepted.'),
    videoId: z
      .string()
      .regex(VIDEO_ID_PATTERN)
      .optional()
      .describe(
        'Start at the first matching track; an absent valid ID retains the verified full batch.',
      ),
    insertPosition: z
      .enum(['INSERT_AT_END', 'INSERT_AFTER_CURRENT_VIDEO'])
      .optional()
      .default('INSERT_AT_END'),
  })
  .strict();

export const MoveSongInQueueSchema = z.object({
  toIndex: z.number(),
});
export const SetQueueIndexSchema = z.object({
  index: z.number().int().nonnegative(),
});
