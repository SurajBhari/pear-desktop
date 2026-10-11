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
};
type Request = {
  controller: AbortController;
  remainingBytes: number;
  owned(): boolean;
  active(): boolean;
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
    return {
      identity,
      timed: !!timedLines,
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
  ): Promise<unknown[]> {
    const assertCurrent = () => {
      if (!request.active()) {
        request.controller.abort(retired);
        throw retired;
      }
    };
    assertCurrent();
    const response = await Promise.race([
      fetch(`${this.baseUrl}/api/search?${query.toString()}`, {
        signal: request.controller.signal,
      }),
      interrupt,
    ]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      assertCurrent();
      if (!response.ok) throw new Error(`LRCLib HTTP ${response.status}`);
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
    const better = (a: Candidate, b: Candidate) =>
      a.identity.rank - b.identity.rank ||
      Number(a.timed) - Number(b.timed) ||
      a.identity.album - b.identity.album ||
      b.identity.duration - a.identity.duration;
    try {
      for (const query of planned.queries) {
        const data = await this.response(query, request, interrupt);
        if (data.length > LRCLIB_LIMITS.candidates - examined)
          throw new Error('LRCLib candidate budget exceeded');
        for (const value of data) {
          examined++;
          const track = parseLRCLibTrack(value);
          if (!track) continue;
          const identity = rankLRCLibIdentity(planned, track, fuzzy);
          if (!identity) continue;
          const candidate = this.result(track, identity);
          if (candidate && (!best || better(candidate, best) > 0))
            best = candidate;
        }
        if (
          best?.identity.exact &&
          best.timed &&
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
