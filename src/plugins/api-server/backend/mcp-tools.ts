import {
  createMcpWriteTools,
  type McpWriteDescriptor,
} from './mcp-write-tools';
import {
  encodeMusicReadSuccess,
  decodeMusicReadResult,
  musicReadFailure,
  type McpReadLogicalResult,
} from './music-read-result';
import {
  musicCurrentArgumentsSchema,
  musicQueueArgumentsSchema,
  musicCollectionArgumentsSchema,
  musicSearchArgumentsSchema,
  musicBrowseArgumentsSchema,
  musicLyricsArgumentsSchema,
  musicRelatedArgumentsSchema,
  musicCommentsArgumentsSchema,
} from './scheme/music';

import { MusicServiceError, type MusicScope } from '../music-types';

import type { MusicInvocation } from './music-access';
import type { MusicDeliverySink } from './music-publication';
import type { MusicService } from './music-service';
import type { z } from 'zod';

export type McpReadToolName =
  | 'music_now_playing'
  | 'music_get_queue'
  | 'music_search'
  | 'music_browse'
  | 'music_home'
  | 'music_get_library_playlists'
  | 'music_lyrics'
  | 'music_related'
  | 'music_comments';
export interface McpReadDescriptor {
  name: McpReadToolName;
  description: string;
  scope: MusicScope;
  inputSchema: z.ZodType;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: false;
    openWorldHint: true;
  };
}
/** Internal source adapter only: no SDK registration, listener or request authority. */
export function createMcpReadToolRegistry(service: MusicService) {
  return createRegistry(service, false);
}
export function createMcpToolRegistry(service: MusicService) {
  return createRegistry(service, true);
}
function createRegistry(service: MusicService, writes: boolean) {
  const entries: {
    descriptor: McpReadDescriptor | McpWriteDescriptor;
    invoke(args: unknown, invocation: MusicInvocation): Promise<string>;
  }[] = [];
  const add = (
    name: McpReadToolName,
    scope: MusicScope,
    inputSchema: z.ZodType,
    description: string,
    invoke: (args: unknown, invocation: MusicInvocation) => Promise<string>,
  ) =>
    entries.push({
      descriptor: {
        name,
        scope,
        inputSchema,
        description,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      invoke,
    });
  add(
    'music_now_playing',
    'playback.read',
    musicCurrentArgumentsSchema,
    'Read the owned current playback snapshot.',
    (args, invocation) => {
      if (!musicCurrentArgumentsSchema.safeParse(args).success)
        throw new MusicServiceError('invalid');
      return service.currentFor(invocation, undefined, encodeMusicReadSuccess);
    },
  );
  add(
    'music_get_queue',
    'playback.read',
    musicQueueArgumentsSchema,
    'Read one owned queue page.',
    (args, invocation) =>
      service.queueFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  add(
    'music_search',
    'catalog.read',
    musicSearchArgumentsSchema,
    'Search a typed query or request its next page.',
    (args, invocation) =>
      service.searchFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  add(
    'music_browse',
    'catalog.read',
    musicBrowseArgumentsSchema,
    'Browse an explicit target or owned page cursor.',
    (args, invocation) =>
      service.browseFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  add(
    'music_home',
    'personalized.read',
    musicCollectionArgumentsSchema,
    'Read an explicitly requested home page.',
    (args, invocation) =>
      service.homeFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  add(
    'music_get_library_playlists',
    'library.read',
    musicCollectionArgumentsSchema,
    'Read one owned library-playlist page.',
    (args, invocation) =>
      service.libraryFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  add(
    'music_lyrics',
    'catalog.read',
    musicLyricsArgumentsSchema,
    'Read lyrics for an explicit video or current track.',
    (args, invocation) =>
      service.lyricsFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  add(
    'music_related',
    'catalog.read',
    musicRelatedArgumentsSchema,
    'Read related tracks for an explicit target or cursor.',
    (args, invocation) =>
      service.relatedFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  add(
    'music_comments',
    'comments.read',
    musicCommentsArgumentsSchema,
    'Read comments with explicit optional public-WEB fallback consent.',
    (args, invocation) =>
      service.commentsFor(invocation, args, undefined, encodeMusicReadSuccess),
  );
  if (writes) entries.push(...createMcpWriteTools(service));
  return {
    /** Scopes come from main-owned authenticated admission, never arguments. */
    list(scopes: readonly MusicScope[]) {
      return entries
        .filter(({ descriptor }) =>
          typeof descriptor.scope === 'string'
            ? scopes.includes(descriptor.scope)
            : descriptor.scope.some((scope) => scopes.includes(scope)),
        )
        .map(({ descriptor }) => ({
          ...descriptor,
          annotations: { ...descriptor.annotations },
        }));
    },
    async callOwned(
      name: string,
      args: unknown,
      invocation: MusicInvocation,
      delivery: MusicDeliverySink,
    ): Promise<McpReadLogicalResult> {
      let armed = false;
      const result = await this.call(name, args, {
        ...invocation,
        delivery: {
          capture(witness) {
            if (armed || delivery.capture(witness) !== true) return false;
            armed = true;
            return true;
          },
        },
      });
      return !armed && !('isError' in result)
        ? musicReadFailure(new MusicServiceError('source'))
        : result;
    },
    async call(
      name: string,
      args: unknown,
      invocation: MusicInvocation,
    ): Promise<McpReadLogicalResult> {
      try {
        const entry = entries.find(
          ({ descriptor }) => descriptor.name === name,
        );
        if (!entry) throw new MusicServiceError('invalid');
        return decodeMusicReadResult(await entry.invoke(args, invocation));
      } catch (error) {
        return musicReadFailure(error);
      }
    },
  };
}
