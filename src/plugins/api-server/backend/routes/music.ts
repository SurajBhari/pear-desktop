import { isIP } from 'node:net';

import {
  MUSIC_LIMITS,
  MusicServiceError,
  type MusicFailure,
} from '../../music-types';
import { parseMusicBearer, type MusicGrantRecord } from '../music-grants';
import {
  parseMusicQueueQuery,
  parseMusicLyricsQuery,
  parseMusicRelatedQuery,
  parseMusicCollectionQuery,
} from '../scheme/music';

import type { MusicService } from '../music-service';
import type { Env, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface MusicTransportOwner {
  resource: string;
  current(): boolean;
}
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
  if (error instanceof HttpMusicFailure)
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
function loopback(peer: string | undefined) {
  if (!peer) return false;
  if (peer === '::1') return true;
  const ipv4 = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}
function policy(incoming: IncomingMessage, resource: string) {
  if (!loopback(incoming.socket.remoteAddress)) return reject(403, 'forbidden');
  const audience = new URL(resource);
  const expectedPort = Number(
    audience.port || (audience.protocol === 'https:' ? 443 : 80),
  );
  const localAddress = incoming.socket.localAddress?.replace(/^::ffff:/, '');
  const hostname = audience.hostname.startsWith('[')
    ? audience.hostname.slice(1, -1)
    : audience.hostname;
  if (
    incoming.socket.localPort !== expectedPort ||
    (hostname === 'localhost'
      ? !loopback(localAddress)
      : localAddress !== hostname)
  )
    return reject(403, 'forbidden');
  const entries = new Map<string, string[]>();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    const key = incoming.rawHeaders[i].toLowerCase();
    const values = entries.get(key) ?? [];
    values.push(incoming.rawHeaders[i + 1]);
    entries.set(key, values);
  }
  const host = entries.get('host');
  if (!host || host.length !== 1 || host[0] !== new URL(resource).host)
    return reject(403, 'forbidden');
  const encrypted =
    (incoming.socket as typeof incoming.socket & { encrypted?: boolean })
      .encrypted === true;
  if (encrypted !== (new URL(resource).protocol === 'https:'))
    return reject(403, 'forbidden');
  if (
    [...entries.keys()].some(
      (key) =>
        key === 'origin' ||
        key === 'forwarded' ||
        key.startsWith('x-forwarded-'),
    )
  )
    return reject(403, 'forbidden');
  const authorization = entries.get('authorization');
  if (!authorization || authorization.length !== 1)
    return reject(
      authorization?.length ? 403 : 401,
      authorization?.length ? 'forbidden' : 'unauthorized',
    );
  const token = parseMusicBearer(authorization[0]);
  if (!token) return reject(401, 'unauthorized');
  if ((entries.get('content-type')?.length ?? 0) > 1) return reject(400);
  return token;
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
  getTransportOwner: () => MusicTransportOwner | undefined,
) {
  app.use('*', async (context, next) => {
    const bindings = context.env as
      | { incoming?: IncomingMessage; outgoing?: ServerResponse }
      | undefined;
    const incoming = bindings?.incoming,
      outgoing = bindings?.outgoing;
    const rawTarget = incoming?.url ?? context.req.path;
    const namespace = (target: string) =>
      target === prefix ||
      [prefix + '/', prefix + '%', prefix + '?', prefix + '\\'].some((start) =>
        target.startsWith(start),
      );
    if (!namespace(rawTarget) && !namespace(context.req.path)) return next();
    context.header('Cache-Control', 'no-store');
    let timer: ReturnType<typeof setTimeout> | undefined,
      detachGrant = () => {},
      detachSocket = () => {};
    try {
      const service = getService(),
        transport = getTransportOwner();
      if (!service?.enabled || !transport?.current() || !incoming || !outgoing)
        return reject(503, 'unavailable');
      const owner = service.captureNativeOwner(),
        token = policy(incoming, transport.resource);
      if (transport.resource !== service.resource)
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
      const mutation = ['/play/song', '/play/playlist', '/radio'].includes(
        route,
      );
      const operationId = /^\/operations\/([^/]+)$/.exec(route)?.[1];
      const status = !!operationId && !prepare;
      const navigation = prepare || mutation || control || status;
      const current = route === '/current',
        queue = route === '/queue',
        home = route === '/home',
        library = route === '/library/playlists',
        collection = home || library,
        lyrics = route === '/song/lyrics',
        related = route === '/song/related',
        metadata = lyrics || related,
        get = current || queue || collection || metadata || status;
      if (rawTarget.includes('?') && !queue && !collection && !metadata)
        return reject(400);
      if (
        !get &&
        !prepare &&
        !mutation &&
        !control &&
        route !== '/search' &&
        route !== '/browse'
      )
        return reject(404, 'not_found');
      if (context.req.method !== (get ? 'GET' : 'POST')) return reject(405);
      if (
        get &&
        (incoming.headers['transfer-encoding'] !== undefined ||
          Number(incoming.headers['content-length'] ?? '0') > 0)
      )
        return reject(400);
      const deadlineAt =
        Date.now() +
        (prepare || mutation || control
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
        ...(Object.hasOwn(owner, 'signal')
          ? [(owner as typeof owner & { signal: AbortSignal }).signal]
          : []),
      ]);
      timer = setTimeout(
        () => controller.abort(new MusicServiceError('timeout')),
        Math.max(0, deadlineAt - Date.now()),
      );
      timer.unref?.();
      const scope = navigation
        ? 'playback.control'
        : current || queue
          ? 'playback.read'
          : home
            ? 'personalized.read'
            : library
              ? 'library.read'
              : 'catalog.read';
      let principal: MusicGrantRecord | undefined;
      const live = () =>
        !signal.aborted &&
        getService() === service &&
        transport.current() &&
        owner.current() &&
        (!principal || service.grants.isCurrent(principal, scope));
      detachGrant = service.grants.subscribe(() => {
        if (!live()) controller.abort(new MusicServiceError('retired'));
      });
      principal = await wait(
        service.grants.authorize(token, 'rest', transport.resource, scope),
        signal,
      );
      if (!live()) return reject(409, 'retired');
      const query = rawTarget.includes('?')
        ? rawTarget.slice(rawTarget.indexOf('?') + 1)
        : '';
      if ((queue || collection || metadata) && /[%#\\]/.test(query))
        return reject(400);
      const input = lyrics
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
        mutation &&
        input &&
        typeof input === 'object' &&
        Object.hasOwn(input, 'action')
      )
        return reject(400);
      const result = await wait<
        | Awaited<ReturnType<MusicService['current']>>
        | Awaited<ReturnType<MusicService['search']>>
        | Awaited<ReturnType<MusicService['queue']>>
        | Awaited<ReturnType<MusicService['lyrics']>>
        | Awaited<ReturnType<MusicService['prepare']>>
      >(
        prepare
          ? service.prepare(token, input, signal, deadlineAt)
          : status
            ? service.operation(token, operationId, signal, deadlineAt)
            : control
              ? service.control(token, input, signal, deadlineAt)
              : mutation
                ? service.navigate(
                    token,
                    {
                      ...(input as object),
                      action:
                        route === '/play/song'
                          ? 'play_song'
                          : route === '/play/playlist'
                            ? 'play_playlist'
                            : 'radio',
                    },
                    signal,
                    deadlineAt,
                  )
                : lyrics
                  ? service.lyrics(token, input, signal, deadlineAt)
                  : related
                    ? service.related(token, input, signal, deadlineAt)
                    : current
                      ? service.current(token, signal)
                      : queue
                        ? service.queue(token, input, signal)
                        : home
                          ? service.home(token, input, signal)
                          : library
                            ? service.library(token, input, signal)
                            : route === '/search'
                              ? service.search(token, input, signal)
                              : service.browse(token, input, signal),
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
