import {
  LRCLIB_LIMITS,
  parseLRCLibTrack,
  planLRCLibSearch,
  rankLRCLibIdentity,
  type LRCLibIdentity,
  type LRCLibTrack,
} from './lrclib-matching';

import { LRC } from '../parsers/lrc';
import { LyricsFile } from '../parsers/lyricsfile';
import { config } from '../renderer/renderer';

import type { LyricProvider, LyricResult, SearchSongInfo } from '../types';

type Candidate = {
  result: LyricResult;
  identity: LRCLibIdentity;
  timed: boolean;
  timing?: 'sparse' | 'distributed';
};
type Request = {
  controller: AbortController;
  remainingBytes: number;
  remainingRequests: number;
  retryAvailable: boolean;
  deadlineAt: number;
  owned(): boolean;
  active(): boolean;
};
class HTTPError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`LRCLib HTTP ${status}`);
  }
}
const retryDelay = (error: HTTPError): number => {
  const value = error.retryAfter?.trim();
  if (!value) return 500;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(500, delay) : 500;
};
const retired = new Error('LRCLib request retired');
const deadline = new Error('LRCLib request deadline exceeded');
const hasFiniteClocks = (
  lines: {
    timeInMs: number;
    words: { timeInMs: number; endTimeInMs?: number }[];
  }[],
) =>
  lines.length > 0 &&
  lines.every(
    (line) =>
      Number.isFinite(line.timeInMs) &&
      line.words.every(
        (word) =>
          Number.isFinite(word.timeInMs) &&
          (word.endTimeInMs === undefined || Number.isFinite(word.endTimeInMs)),
      ),
  );

// Query expansion and synchronized preference adapted from #3254 @AARP41298.
// Retain the fork's exact recording guards and LyricsFile/enhanced-LRC pipeline.
export class LRCLib implements LyricProvider {
  name = 'LRCLib';
  baseUrl = 'https://lrclib.net';
  private request?: Request;

  private result(
    track: LRCLibTrack,
    identity: LRCLibIdentity,
    duration?: number,
  ): Candidate | null {
    if (track.instrumental)
      return {
        identity,
        timed: true,
        result: {
          title: track.trackName,
          artists: identity.artists,
          lines: [
            {
              time: '00:00',
              timeInMs: 0,
              duration: track.duration * 1000,
              text: '',
              words: [],
              instrumental: true,
              status: 'upcoming',
            },
          ],
        },
      };
    let timedLines:
      | ReturnType<typeof LyricsFile.parse>['lines']
      | ReturnType<typeof LRC.parse>['lines']
      | undefined;
    if (track.lyricsfile) {
      try {
        const parsed = LyricsFile.parse(track.lyricsfile).lines;
        if (hasFiniteClocks(parsed)) timedLines = parsed;
      } catch {
        /* Optional format cannot mask valid LRC/plain lyrics. */
      }
    }
    if (!timedLines && track.syncedLyrics) {
      const parsed = LRC.parse(track.syncedLyrics).lines;
      if (hasFiniteClocks(parsed)) timedLines = parsed;
    }
    if (timedLines && timedLines.length > 5000) return null;
    const plain = track.plainLyrics?.trim() ? track.plainLyrics : undefined;
    if (!timedLines && !plain) return null;
    const positions = [
      ...new Set(
        timedLines
          ?.filter((line) => line.text.trim())
          .map((line) => line.timeInMs),
      ),
    ];
    return {
      identity,
      timed: !!timedLines,
      timing:
        positions.length === 1
          ? 'sparse'
          : duration !== undefined &&
              positions.length >= 3 &&
              Math.max(...positions) - Math.min(...positions) >= duration * 500
            ? 'distributed'
            : undefined,
      result: {
        title: track.trackName,
        artists: identity.artists,
        lines: timedLines?.map((line) => ({
          ...line,
          status: 'upcoming' as const,
        })),
        lyrics: plain,
      },
    };
  }

  private async response(
    query: URLSearchParams,
    request: Request,
    interrupt: Promise<never>,
    allowRetry: boolean,
  ): Promise<unknown[]> {
    try {
      return await this.responseOnce(query, request, interrupt);
    } catch (error) {
      if (
        !allowRetry ||
        !request.active() ||
        !request.retryAvailable ||
        request.remainingRequests === 0 ||
        !(error instanceof HTTPError) ||
        ![429, 502, 503, 504].includes(error.status)
      )
        throw error;
      const delay = retryDelay(error);
      // Do not shorten the service's Retry-After or extend the search lease.
      if (delay >= request.deadlineAt - Date.now()) throw error;
      request.retryAvailable = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, delay);
          }),
          interrupt,
        ]);
      } finally {
        clearTimeout(timer);
      }
      return this.responseOnce(query, request, interrupt);
    }
  }

  private async responseOnce(
    query: URLSearchParams,
    request: Request,
    interrupt: Promise<never>,
  ): Promise<unknown[]> {
    const assertCurrent = () => {
      if (!request.active()) {
        request.controller.abort(retired);
        throw retired;
      }
    };
    assertCurrent();
    request.remainingRequests--;
    const response = await Promise.race([
      fetch(`${this.baseUrl}/api/search?${query.toString()}`, {
        signal: request.controller.signal,
      }),
      interrupt,
    ]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      assertCurrent();
      if (!response.ok)
        throw new HTTPError(
          response.status,
          response.headers.get('retry-after'),
        );
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) > request.remainingBytes)
        throw new Error('LRCLib response budget exceeded');
      if (!response.body) throw new Error('LRCLib response body is missing');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      while (true) {
        assertCurrent();
        const chunk = await Promise.race([reader.read(), interrupt]);
        assertCurrent();
        if (chunk.done) break;
        request.remainingBytes -= chunk.value.byteLength;
        if (request.remainingBytes < 0)
          throw new Error('LRCLib response budget exceeded');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      assertCurrent();
      const data: unknown = JSON.parse(text);
      if (!Array.isArray(data))
        throw new Error('LRCLib response must be an array');
      return data;
    } finally {
      // Retire this response without aborting the search lease or waiting on
      // an unresponsive cancellation hook. Cleanup cannot replace its error.
      try {
        if (reader) {
          reader.cancel().catch(() => {});
          reader.releaseLock();
        } else {
          response.body?.cancel().catch(() => {});
        }
      } catch {
        /* The acquired response is already locked or retired. */
      }
    }
  }

  async search(info: SearchSongInfo): Promise<LyricResult | null> {
    this.request?.controller.abort(retired);
    this.request = undefined;
    const planned = planLRCLibSearch(info);
    if (!planned) return null;
    const cfg = config(),
      fuzzy = cfg?.showLyricsEvenIfInexact === true,
      managed = cfg?.enabled === true;
    const controller = new AbortController();
    const request: Request = {
      controller,
      remainingBytes: LRCLIB_LIMITS.responseBytes,
      remainingRequests: LRCLIB_LIMITS.queries,
      retryAvailable: true,
      deadlineAt: Date.now() + LRCLIB_LIMITS.deadlineMs,
      owned: () =>
        this.request === request &&
        (!managed || config()?.enabled === true) &&
        (config()?.showLyricsEvenIfInexact === true) === fuzzy,
      active: () => request.owned() && !controller.signal.aborted,
    };
    this.request = request;
    let interruptRequest!: (reason: unknown) => void;
    const interrupt = new Promise<never>((_resolve, reject) => {
      interruptRequest = reject;
    });
    const onAbort = () => interruptRequest(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(deadline),
      LRCLIB_LIMITS.deadlineMs,
    );
    timer.unref?.();
    let best: Candidate | undefined,
      examined = 0;
    const candidates: Candidate[] = [];
    const qualityEligible = (candidate: Candidate) =>
      planned.duration !== undefined &&
      candidate.identity.exact &&
      candidate.identity.duration <= 4 &&
      (!planned.album || candidate.identity.album === 1);
    const better = (a: Candidate, b: Candidate) =>
      a.identity.rank - b.identity.rank ||
      Number(a.timed) - Number(b.timed) ||
      a.identity.album - b.identity.album ||
      b.identity.duration - a.identity.duration;
    try {
      for (const query of planned.queries) {
        if (request.remainingRequests === 0) break;
        const data = await this.response(query, request, interrupt, !best);
        if (data.length > LRCLIB_LIMITS.candidates - examined)
          throw new Error('LRCLib candidate budget exceeded');
        for (const value of data) {
          examined++;
          const track = parseLRCLibTrack(value);
          if (!track) continue;
          const identity = rankLRCLibIdentity(planned, track, fuzzy);
          if (!identity) continue;
          const candidate = this.result(track, identity, planned.duration);
          if (candidate) candidates.push(candidate);
        }
        // Apply a group-level penalty before the existing ordering so the
        // outcome cannot depend on a non-transitive pairwise comparison.
        const distributed = candidates.some(
          (candidate) =>
            qualityEligible(candidate) && candidate.timing === 'distributed',
        );
        best = undefined;
        for (const candidate of candidates) {
          if (
            distributed &&
            qualityEligible(candidate) &&
            candidate.timing === 'sparse'
          )
            continue;
          if (!best || better(candidate, best) > 0) best = candidate;
        }
        if (
          best?.identity.exact &&
          best.timed &&
          best.timing !== 'sparse' &&
          best.identity.duration <= 2 &&
          (!planned.album || best.identity.album === 1)
        )
          return request.active() ? best.result : null;
        if (examined === LRCLIB_LIMITS.candidates) break;
      }
      return request.active() ? (best?.result ?? null) : null;
    } catch (error) {
      if (!request.owned() || controller.signal.reason === retired) return null;
      if (best) return best.result;
      if (controller.signal.reason === deadline) throw deadline;
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (this.request === request) this.request = undefined;
    }
  }
}
