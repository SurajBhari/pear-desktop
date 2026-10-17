import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { commentsToken } from '@/providers/music-comments';
import { isVideoId } from '@/providers/queue-playlist';

import { MUSIC_LIMITS, MusicServiceError } from '../music-types';

/** Bound #4744 @SurajBhari WEB context. No Electron/profile credentials or arbitrary endpoint. */
const WEB_CONTEXT = Object.freeze({
  client: Object.freeze({
    clientName: 'WEB',
    clientVersion: '2.20250925.01.00',
    hl: 'en',
  }),
});
export function createPublicCommentsWeb(test?: {
  testPort: number;
  testCa?: string;
}) {
  if (
    test &&
    (!Number.isInteger(test.testPort) ||
      test.testPort < 1 ||
      test.testPort > 65535)
  )
    throw new MusicServiceError('invalid');
  return Object.freeze({
    request(
      body: { videoId: string } | { continuation: string },
      options: { signal: AbortSignal; deadline: number },
    ): Promise<unknown> {
      if (
        !body ||
        typeof body !== 'object' ||
        Reflect.ownKeys(body).length !== 1
      )
        return Promise.reject(new MusicServiceError('invalid'));
      const prototype: unknown = Object.getPrototypeOf(body);
      const key = Object.keys(body)[0],
        descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        !descriptor ||
        !('value' in descriptor) ||
        !['videoId', 'continuation'].includes(key)
      )
        return Promise.reject(new MusicServiceError('invalid'));
      if (
        key === 'videoId'
          ? !isVideoId(descriptor.value)
          : typeof descriptor.value !== 'string'
      )
        return Promise.reject(new MusicServiceError('invalid'));
      if (key === 'continuation') commentsToken(descriptor.value);
      if (options.signal.aborted)
        return Promise.reject(new MusicServiceError('retired'));
      const lifetime = Math.min(15000, options.deadline - Date.now());
      if (!Number.isFinite(lifetime) || lifetime <= 0)
        return Promise.reject(new MusicServiceError('timeout'));
      const payload = Buffer.from(
        JSON.stringify({
          context: WEB_CONTEXT,
          [key]: descriptor.value as unknown,
        }),
      );
      return new Promise((resolve, reject) => {
        let failure: MusicServiceError | undefined,
          value: unknown,
          ended = false,
          bytes = 0;
        const chunks: Buffer[] = [];
        const request = test && !test.testCa ? httpRequest : httpsRequest;
        const req = request({
          hostname: test ? '127.0.0.1' : 'www.youtube.com',
          ...(test ? { port: test.testPort } : { port: 443 }),
          ...(test?.testCa ? { ca: test.testCa, servername: 'localhost' } : {}),
          method: 'POST',
          path: '/youtubei/v1/next?prettyPrint=false',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Content-Length': payload.byteLength,
          },
        });
        const stop = (reason: MusicServiceError) => {
          failure ??= reason;
          req.destroy();
        };
        const abort = () =>
          stop(
            new MusicServiceError(
              options.signal.reason instanceof MusicServiceError &&
                options.signal.reason.code === 'timeout'
                ? 'timeout'
                : 'retired',
            ),
          );
        const timer = setTimeout(
          () => stop(new MusicServiceError('timeout')),
          lifetime,
        );
        timer.unref?.();
        options.signal.addEventListener('abort', abort, { once: true });
        req.on('response', (response) => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            stop(new MusicServiceError('source'));
            response.destroy();
            return;
          }
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MUSIC_LIMITS.nativeBytes) {
              stop(new MusicServiceError('budget'));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on('aborted', () => stop(new MusicServiceError('source')));
          response.on('error', () => stop(new MusicServiceError('source')));
          response.on('end', () => {
            if (failure) return;
            try {
              value = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                  Buffer.concat(chunks, bytes),
                ),
              );
              ended = true;
            } catch {
              stop(new MusicServiceError('source'));
            }
          });
        });
        req.on('error', () => {
          failure ??= new MusicServiceError('source');
        });
        // Settlement follows actual request/socket close, including cancellation.
        req.on('close', () => {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', abort);
          if (failure || !ended)
            reject(failure ?? new MusicServiceError('source'));
          else resolve(value);
        });
        if (options.signal.aborted) abort();
        else req.end(payload);
      });
    },
  });
}
export type PublicCommentsWeb = ReturnType<typeof createPublicCommentsWeb>;
