import {
  MUSIC_LIMITS,
  MusicServiceError,
  type MusicFailure,
} from '../../music-types';
import { type MusicGrantRecord } from '../music-grants';
import {
  musicHttpPolicy,
  isMusicHttpNamespace,
  MusicHttpFailure,
  type MusicHttpListenerOwner,
} from '../music-http-policy';
import {
  parseMusicQueueQuery,
  parseMusicLyricsQuery,
  parseMusicCommentsQuery,
  parseMusicRelatedQuery,
  parseMusicCollectionQuery,
} from '../scheme/music';

import type { MusicService } from '../music-service';
import type { Env, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type MusicTransportOwner = MusicHttpListenerOwner;
const prefix = '/api/v1/music';
class HttpMusicFailure extends MusicServiceError {
  constructor(
    code: MusicFailure,
    readonly status: ContentfulStatusCode,
  ) {
    super(code);
  }
}
const reject = (
  status: ContentfulStatusCode,
  code: MusicFailure = 'invalid',
): never => {
  throw new HttpMusicFailure(code, status);
};
const codes: Record<MusicFailure, ContentfulStatusCode> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  retired: 409,
  busy: 429,
  source: 502,
  unsupported: 502,
  budget: 502,
  unavailable: 503,
  timeout: 504,
  unknown_operation: 404,
  expired_operation: 409,
  conflict: 409,
};
const failure = (error: unknown) => {
  if (error instanceof HttpMusicFailure || error instanceof MusicHttpFailure)
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  let code: MusicFailure = 'source';
  if (error instanceof MusicServiceError) code = error.code;
  else if (error instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (
      descriptor &&
      'value' in descriptor &&
      Object.hasOwn(codes, descriptor.value as string)
    )
      code = descriptor.value as MusicFailure;
  }
  const safe = new MusicServiceError(code);
  return {
    status: codes[code],
    body: { error: { code, message: safe.message } },
  };
};
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () =>
    signal.reason instanceof MusicServiceError
      ? signal.reason
      : new MusicServiceError('retired');
  if (signal.aborted) return Promise.reject(reason());
  return new Promise((resolve, rejectPromise) => {
    const abort = () => rejectPromise(reason());
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, rejectPromise)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}
async function jsonBody(
  request: Request,
  incoming: IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      incoming.headers['content-type'] ?? '',
    )
  )
    return reject(415);
  const length = incoming.headers['content-length'];
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > MUSIC_LIMITS.bodyBytes)
  )
    return reject(413);
  const reader = request.body?.getReader();
  if (!reader) return reject(400);
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const packet = await wait(reader.read(), signal);
      if (packet.done) break;
      bytes += packet.value.byteLength;
      if (bytes > MUSIC_LIMITS.bodyBytes) {
        await reader.cancel();
        return reject(413);
      }
      chunks.push(packet.value);
    }
    if (!bytes) return reject(400);
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer),
      );
    } catch {
      return reject(400);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
/** Mandatory independent namespace handler, registered before every legacy authorization/CORS middleware. */
export function registerMusicRoutes<E extends Env>(
  app: Hono<E>,
  getService: () => MusicService | undefined,
  getTransportOwner: (
    incoming: IncomingMessage,
  ) => MusicTransportOwner | undefined,
) {
  app.use('*', async (context, next) => {
    const bindings = context.env as
      | { incoming?: IncomingMessage; outgoing?: ServerResponse }
      | undefined;
    const incoming = bindings?.incoming,
      outgoing = bindings?.outgoing;
    const rawTarget = incoming?.url ?? context.req.path;
    if (!isMusicHttpNamespace(rawTarget, context.req.path)) return next();
    context.header('Cache-Control', 'no-store');
    let timer: ReturnType<typeof setTimeout> | undefined,
      detachGrant = () => {},
      detachSocket = () => {};
    try {
      const service = getService();
      if (!service?.httpConfigured || !incoming || !outgoing)
        return reject(503, 'unavailable');
      const transport = getTransportOwner(incoming);
      if (!transport?.current()) return reject(503, 'unavailable');
      const { token, resource } = musicHttpPolicy(incoming, transport);
      const owner = service.captureNativeOwner(resource);
      if (!transport.current() || !owner.current() || getService() !== service)
        return reject(409, 'retired');
      if (
        !rawTarget.startsWith(prefix + '/') ||
        /[%#\\]/.test(rawTarget.split('?')[0]) ||
        rawTarget.includes('//')
      )
        return reject(400);
      const route = rawTarget.split('?')[0].slice(prefix.length);
      const prepare = route === '/operations/prepare';
      const control = route === '/control';
      const queueIndex = /^\/queue\/(0|[1-9][0-9]*)$/.exec(route)?.[1];
      const queueMutation =
        route === '/queue/song' ||
        route === '/queue/playlist' ||
        queueIndex !== undefined ||
        (route === '/queue' && context.req.method === 'DELETE');
      const mutation = ['/play/song', '/play/playlist', '/radio'].includes(
        route,
      );
      const operationId = /^\/operations\/([^/]+)$/.exec(route)?.[1];
      const status = !!operationId && !prepare;
      const navigation = prepare || mutation || control || status;
      const current = route === '/current',
        queue = route === '/queue' && !queueMutation,
        home = route === '/home',
        library = route === '/library/playlists',
        collection = home || library,
        lyrics = route === '/song/lyrics',
        comments = route === '/song/comments',
        related = route === '/song/related',
        metadata = lyrics || related || comments,
        get = current || queue || collection || metadata || status;
      if (rawTarget.includes('?') && !queue && !collection && !metadata)
        return reject(400);
      if (
        !get &&
        !prepare &&
        !mutation &&
        !control &&
        !queueMutation &&
        route !== '/search' &&
        route !== '/browse'
      )
        return reject(404, 'not_found');
      if (
        context.req.method !==
        (queueMutation && (route === '/queue' || queueIndex !== undefined)
          ? 'DELETE'
          : get
            ? 'GET'
            : 'POST')
      )
        return reject(405);
      if (
        get &&
        (incoming.headers['transfer-encoding'] !== undefined ||
          Number(incoming.headers['content-length'] ?? '0') > 0)
      )
        return reject(400);
      const deadlineAt =
        Date.now() +
        (prepare || mutation || control || queueMutation
          ? 10000
          : current || queue
            ? 5000
            : 15000);
      const controller = new AbortController();
      const socketLost = () => {
        if (!outgoing.writableFinished)
          controller.abort(new MusicServiceError('retired'));
      };
      incoming.on('aborted', socketLost);
      outgoing.on('close', socketLost);
      detachSocket = () => {
        incoming.removeListener('aborted', socketLost);
        outgoing.removeListener('close', socketLost);
      };
      const signal = AbortSignal.any([
        controller.signal,
        transport.signal,
        ...(Object.hasOwn(owner, 'signal')
          ? [(owner as typeof owner & { signal: AbortSignal }).signal]
          : []),
      ]);
      timer = setTimeout(
        () => controller.abort(new MusicServiceError('timeout')),
        Math.max(0, deadlineAt - Date.now()),
      );
      timer.unref?.();
      const scope = queueMutation
        ? 'queue.write'
        : navigation
          ? 'playback.control'
          : current || queue
            ? 'playback.read'
            : comments
              ? 'comments.read'
              : home
                ? 'personalized.read'
                : library
                  ? 'library.read'
                  : 'catalog.read';
      let principal: MusicGrantRecord | undefined;
      const invocation = Object.freeze({
        token,
        transport: 'rest' as const,
        resource,
        signal,
      });
      const unchanged = () =>
        !signal.aborted &&
        !transport.signal.aborted &&
        getService() === service;
      const live = () => {
        if (!unchanged() || !transport.current() || !unchanged()) return false;
        if (!owner.current() || !unchanged()) return false;
        if (principal && !service.grants.isCurrent(principal, scope))
          return false;
        return (
          unchanged() &&
          transport.current() &&
          unchanged() &&
          owner.current() &&
          unchanged()
        );
      };
      detachGrant = service.grants.subscribe(() => {
        if (!live()) controller.abort(new MusicServiceError('retired'));
      });
      if (!prepare && !status)
        principal = await wait(
          service.grants.authorize(token, 'rest', resource, scope),
          signal,
        );
      if (!live()) return reject(409, 'retired');
      const query = rawTarget.includes('?')
        ? rawTarget.slice(rawTarget.indexOf('?') + 1)
        : '';
      if ((queue || collection || metadata) && /[%#\\]/.test(query))
        return reject(400);
      const input = comments
        ? parseMusicCommentsQuery(new URLSearchParams(query))
        : lyrics
          ? parseMusicLyricsQuery(new URLSearchParams(query))
          : related
            ? parseMusicRelatedQuery(new URLSearchParams(query))
            : current || status
              ? undefined
              : queue
                ? parseMusicQueueQuery(new URLSearchParams(query))
                : collection
                  ? parseMusicCollectionQuery(new URLSearchParams(query))
                  : await jsonBody(context.req.raw, incoming, signal);
      if (!live()) return reject(409, 'retired');
      if (
        (mutation || queueMutation) &&
        input &&
        typeof input === 'object' &&
        Object.hasOwn(input, 'action')
      )
        return reject(400);
      if (
        queueIndex !== undefined &&
        input &&
        typeof input === 'object' &&
        Object.hasOwn(input, 'index') &&
        (input as { index: unknown }).index !== Number(queueIndex)
      )
        return reject(400);
      const result = await wait<
        | Awaited<ReturnType<MusicService['current']>>
        | Awaited<ReturnType<MusicService['search']>>
        | Awaited<ReturnType<MusicService['queue']>>
        | Awaited<ReturnType<MusicService['lyrics']>>
        | Awaited<ReturnType<MusicService['comments']>>
        | Awaited<ReturnType<MusicService['prepare']>>
      >(
        prepare
          ? service.prepareFor(invocation, input, deadlineAt)
          : status
            ? service.operationFor(invocation, operationId, deadlineAt)
            : queueMutation
              ? service.mutateQueueFor(
                  invocation,
                  {
                    ...(input as object),
                    action:
                      route === '/queue/song'
                        ? 'enqueue_song'
                        : route === '/queue/playlist'
                          ? 'enqueue_playlist'
                          : queueIndex !== undefined
                            ? 'remove_from_queue'
                            : 'clear_queue',
                    ...(queueIndex !== undefined
                      ? { index: Number(queueIndex) }
                      : {}),
                  },
                  deadlineAt,
                )
              : control
                ? service.controlFor(invocation, input, deadlineAt)
                : mutation
                  ? service.navigateFor(
                      invocation,
                      {
                        ...(input as object),
                        action:
                          route === '/play/song'
                            ? 'play_song'
                            : route === '/play/playlist'
                              ? 'play_playlist'
                              : 'radio',
                      },
                      deadlineAt,
                    )
                  : comments
                    ? service.commentsFor(invocation, input, deadlineAt)
                    : lyrics
                      ? service.lyricsFor(invocation, input, deadlineAt)
                      : related
                        ? service.relatedFor(invocation, input, deadlineAt)
                        : current
                          ? service.currentFor(invocation, deadlineAt)
                          : queue
                            ? service.queueFor(invocation, input, deadlineAt)
                            : home
                              ? service.homeFor(invocation, input, deadlineAt)
                              : library
                                ? service.libraryFor(
                                    invocation,
                                    input,
                                    deadlineAt,
                                  )
                                : route === '/search'
                                  ? service.searchFor(
                                      invocation,
                                      input,
                                      deadlineAt,
                                    )
                                  : service.browseFor(
                                      invocation,
                                      input,
                                      deadlineAt,
                                    ),
        signal,
      );
      if (!live()) return reject(409, 'retired');
      return context.json(result);
    } catch (error) {
      const safe = failure(error);
      return context.json(safe.body, safe.status);
    } finally {
      clearTimeout(timer);
      detachGrant();
      detachSocket();
    }
  });
}
