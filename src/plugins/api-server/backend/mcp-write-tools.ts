import { z } from 'zod';

import {
  VIDEO_ID_PATTERN,
  PLAYLIST_ID_PATTERN,
} from '@/providers/queue-playlist';

import { encodeMusicReadSuccess } from './music-read-result';

import type { MusicScope } from '../music-types';
import type { MusicInvocation } from './music-access';
import type { MusicService } from './music-service';

export type McpWriteToolName =
  | 'music_previous'
  | 'music_next'
  | 'music_play'
  | 'music_pause'
  | 'music_toggle_playback'
  | 'music_toggle_shuffle'
  | 'music_switch_repeat'
  | 'music_seek'
  | 'music_set_volume'
  | 'music_play_video'
  | 'music_play_playlist'
  | 'music_start_radio'
  | 'music_enqueue'
  | 'music_enqueue_playlist'
  | 'music_remove_from_queue'
  | 'music_clear_queue'
  | 'music_operation_status';
export interface McpWriteDescriptor {
  name: McpWriteToolName;
  description: string;
  /** Any listed scope admits discovery only; the service authorizes the actual receipt. */
  scope: MusicScope | readonly MusicScope[];
  inputSchema: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: false;
    openWorldHint: true;
  };
}
export interface McpWriteEntry {
  descriptor: McpWriteDescriptor;
  invoke(args: unknown, invocation: MusicInvocation): Promise<string>;
}
const operationId = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
  );
const videoId = z.string().regex(VIDEO_ID_PATTERN);
const playlistId = z.string().max(128).regex(PLAYLIST_ID_PATTERN);
const insertPosition = z
  .enum(['INSERT_AT_END', 'INSERT_AFTER_CURRENT_VIDEO'])
  .default('INSERT_AT_END');
const queueRevision = z.string().regex(/^[0-9a-f]{32}$/);

/** Fixed actions only. Preparation, execution, replay and physical effects stay in MusicService. */
export function createMcpWriteTools(service: MusicService): McpWriteEntry[] {
  const entries: McpWriteEntry[] = [];
  const add = (
    name: Exclude<McpWriteToolName, 'music_operation_status'>,
    action: string,
    lane: 'control' | 'navigate' | 'queue',
    fields: z.ZodRawShape,
  ) => {
    const schema = z
      .object({ ...fields, operationId: operationId.optional() })
      .strict();
    entries.push({
      descriptor: {
        name,
        scope: lane === 'queue' ? 'queue.write' : 'playback.control',
        inputSchema: schema,
        description: `Prepare ${action} without effects by omitting operationId. Repeat the exact arguments with the returned operationId to dispatch once; inspect music_operation_status after a lost response. Accepted means owned dispatch, not audible playback.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      invoke(args, invocation) {
        const { operationId: id, ...parameters } = schema.parse(args);
        const command = { action, ...parameters };
        if (id === undefined)
          return service.prepareFor(
            invocation,
            command,
            undefined,
            encodeMusicReadSuccess,
          );
        const input = { ...command, operationId: id };
        return lane === 'control'
          ? service.controlFor(
              invocation,
              input,
              undefined,
              encodeMusicReadSuccess,
            )
          : lane === 'navigate'
            ? service.navigateFor(
                invocation,
                input,
                undefined,
                encodeMusicReadSuccess,
              )
            : service.mutateQueueFor(
                invocation,
                input,
                undefined,
                encodeMusicReadSuccess,
              );
      },
    });
  };
  for (const action of [
    'previous',
    'next',
    'play',
    'pause',
    'toggle_playback',
    'toggle_shuffle',
  ] as const)
    add(`music_${action}`, action, 'control', {});
  add('music_switch_repeat', 'switch_repeat', 'control', {
    iterations: z.union([z.literal(1), z.literal(2)]).default(1),
  });
  add('music_seek', 'seek', 'control', {
    seconds: z
      .number()
      .min(0)
      .max(Number.MAX_VALUE / 1000),
    playbackEpoch: z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{32}$/),
  });
  add('music_set_volume', 'set_volume', 'control', {
    volume: z.number().min(0).max(100),
  });
  add('music_play_video', 'play_song', 'navigate', {
    videoId,
    playlistId: playlistId.optional(),
  });
  add('music_play_playlist', 'play_playlist', 'navigate', {
    playlistId,
    videoId: videoId.optional(),
    shuffle: z.boolean().default(false),
  });
  add('music_start_radio', 'radio', 'navigate', {
    seed: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('video'), videoId }).strict(),
      z.object({ kind: z.literal('playlist'), playlistId }).strict(),
      z.object({ kind: z.literal('current') }).strict(),
    ]),
  });
  add('music_enqueue', 'enqueue_song', 'queue', { videoId, insertPosition });
  add('music_enqueue_playlist', 'enqueue_playlist', 'queue', {
    playlistId,
    videoId: videoId.optional(),
    insertPosition,
  });
  add('music_remove_from_queue', 'remove_from_queue', 'queue', {
    queueRevision,
    index: z.number().int().min(0).max(2047),
    expectedVideoId: videoId,
  });
  add('music_clear_queue', 'clear_queue', 'queue', { queueRevision });
  const statusSchema = z.object({ operationId }).strict();
  entries.push({
    descriptor: {
      name: 'music_operation_status',
      scope: Object.freeze(['playback.control', 'queue.write'] as const),
      description:
        'Read your exact session-owned operation receipt using its original action permission. This never dispatches or retries an effect.',
      inputSchema: statusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    invoke: (args, invocation) =>
      service.operationFor(
        invocation,
        statusSchema.parse(args).operationId,
        undefined,
        encodeMusicReadSuccess,
      ),
  });
  return entries;
}
