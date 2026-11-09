// Adapted from @ImMALWARE's pear-devs/pear-desktop#4632 (386c536a4620).
// Conservative matching: uncertainty retains the supplied metadata.
import { hasControls } from './base';

type Fields = { title: string; artist: string };
export type MusicBrainzEvidence = {
  originalArtist?: string;
  durationSeconds?: number;
};
type Recording = Fields & { score: number; lengthMs?: number };
type RateState = { tail: Promise<void>; queued: number; lastStart: number };
const sharedRate: RateState = {
  tail: Promise.resolve(),
  queued: 0,
  lastStart: -Infinity,
};
type Dependencies = {
  fetcher: typeof fetch;
  identity: string;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  budgetMs?: number;
  positiveTtlMs?: number;
  rate?: RateState;
};
export const validMusicBrainzEmail = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 254 &&
  !hasControls(value) &&
  /^[^\s@()]+@[^\s@()]+\.[^\s@()]+$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !!value.trim() &&
  !hasControls(value);
// Matching, candidate grouping and cache identity must preserve symbols alike.
const normalize = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const abortable = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(Error('Metadata operation retired'));
    signal.addEventListener('abort', abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(Error('Metadata wait retired'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
function candidate(value: unknown): Recording | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.score !== 'number' ||
    !Number.isFinite(record.score) ||
    record.score < 0 ||
    record.score > 100 ||
    !text(record.title)
  )
    return;
  const credits = record['artist-credit'];
  if (!Array.isArray(credits) || !credits.length || credits.length > 20) return;
  let artist = '';
  for (const credit of credits) {
    if (!credit || typeof credit !== 'object') return;
    const entry = credit as Record<string, unknown>;
    if (!text(entry.name)) return;
    const join = entry.joinphrase ?? '';
    if (typeof join !== 'string' || join.length > 100 || hasControls(join))
      return;
    artist += entry.name + join;
  }
  if (!text(artist)) return;
  return {
    title: record.title,
    artist,
    score: record.score,
    lengthMs:
      typeof record.length === 'number' &&
      Number.isFinite(record.length) &&
      record.length > 0
        ? record.length
        : undefined,
  };
}
function splitQuery(input: Fields): Fields | undefined {
  const parts = input.title.split(/\s+[-–—]\s+/u);
  if (parts.length !== 2) return;
  const [artist, title] = parts.map((part) => part.trim());
  if (!text(artist) || !text(title) || !normalize(artist) || !normalize(title))
    return;
  return { title, artist };
}
function select(
  data: unknown,
  input: Fields,
  evidence?: MusicBrainzEvidence,
): Fields | undefined {
  if (
    !data ||
    typeof data !== 'object' ||
    !('recordings' in data) ||
    !Array.isArray(data.recordings) ||
    data.recordings.length > 5
  )
    return;
  const parsed = data.recordings.map(candidate);
  // Unknown entries could conceal a competing match; fail closed.
  if (parsed.some((entry) => !entry)) return;
  const unique = new Map<string, { top: Recording; recordings: Recording[] }>();
  for (const entry of parsed) {
    if (!entry) return;
    const key = JSON.stringify([
      normalize(entry.title),
      normalize(entry.artist),
    ]);
    const group = unique.get(key);
    if (group) {
      group.recordings.push(entry);
      if (group.top.score < entry.score) group.top = entry;
    } else unique.set(key, { top: entry, recordings: [entry] });
  }
  const ranked = [...unique.values()].sort((a, b) => b.top.score - a.top.score);
  const group = ranked[0],
    top = group?.top;
  if (
    !top ||
    top.score < 95 ||
    (ranked[1] && top.score - ranked[1].top.score < 5)
  )
    return;
  // Exact field identities keep live/remix/featured qualifiers and full credits.
  if (
    normalize(top.title) !== normalize(input.title) ||
    normalize(top.artist) !== normalize(input.artist)
  )
    return;
  if (evidence) {
    const originalArtist = evidence.originalArtist;
    const artistAgrees =
      text(originalArtist) &&
      normalize(originalArtist) === normalize(input.artist);
    const seconds = evidence.durationSeconds;
    // A channel-name artist may only be replaced with independent duration proof.
    // Conflicting lengths among equivalent candidates do not establish that proof.
    const durationAgrees =
      typeof seconds === 'number' &&
      Number.isFinite(seconds) &&
      seconds > 0 &&
      group.recordings.every((entry) => {
        if (entry.lengthMs === undefined) return false;
        const recordingSeconds = entry.lengthMs / 1000;
        return Math.abs(recordingSeconds - seconds) <= 2;
      });
    if (!artistAgrees && !durationAgrees) return;
  }
  return { title: top.title, artist: top.artist };
}
export class MusicBrainz {
  private readonly lifetime = new AbortController();
  private readonly rate: RateState;
  private readonly cache = new Map<
    string,
    { result?: Fields; expires: number }
  >();
  constructor(private readonly dependencies: Dependencies) {
    this.rate = dependencies.rate ?? sharedRate;
  }
  stop() {
    this.lifetime.abort();
    this.cache.clear();
  }
  async correct<T extends Fields>(
    input: T,
    email: unknown,
    owner: AbortSignal,
    remainingMs = 2500,
    evidence: MusicBrainzEvidence = {},
  ): Promise<T> {
    if (
      !validMusicBrainzEmail(email) ||
      !text(input.title) ||
      !text(input.artist) ||
      owner.aborted ||
      this.lifetime.signal.aborted ||
      this.rate.queued >= 8
    )
      return input;
    const now = this.dependencies.now ?? Date.now;
    const key = JSON.stringify([
      'symbol-preserving-split-v3',
      normalize(input.title),
      normalize(input.artist),
      normalize(
        text(evidence.originalArtist) ? evidence.originalArtist : input.artist,
      ),
      typeof evidence.durationSeconds === 'number' &&
      Number.isFinite(evidence.durationSeconds) &&
      evidence.durationSeconds > 0
        ? evidence.durationSeconds
        : null,
    ]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.result ? { ...input, ...cached.result } : input;
    }
    this.cache.delete(key);
    const budget = Math.min(
      2500,
      this.dependencies.budgetMs ?? 2500,
      remainingMs,
    );
    if (!Number.isFinite(budget) || budget <= 0) return input;
    const expiry = now() + budget;
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      owner,
      this.lifetime.signal,
      deadline.signal,
    ]);
    const timer = setTimeout(() => deadline.abort(), budget);
    const previous = this.rate.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.rate.tail = previous.then(() => gate);
    this.rate.queued++;
    try {
      await abortable(previous, signal);
      const escape = (value: string) => value.replace(/[\\"]/g, '\\$&');
      const url = new URL('https://musicbrainz.org/ws/2/recording/');
      const split = splitQuery(input);
      let search = input as Fields;
      let splitSearch = false;
      let backoff = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        url.search = new URLSearchParams({
          query: `recording:"${escape(search.title)}" AND artist:"${escape(search.artist)}"`,
          fmt: 'json',
          limit: '5',
        }).toString();
        const pause = Math.max(0, this.rate.lastStart + 1100 - now(), backoff);
        if (now() + pause >= expiry || signal.aborted) return input;
        if (pause)
          await abortable(
            (this.dependencies.wait ?? delay)(pause, signal),
            signal,
          );
        if (signal.aborted || now() >= expiry) return input;
        this.rate.lastStart = now();
        let response: Response;
        try {
          const request = this.dependencies.fetcher(url.href, {
            signal,
            redirect: 'error',
            credentials: 'omit',
            headers: {
              'User-Agent': `${this.dependencies.identity} ( ${email} )`,
              'Accept': 'application/json',
            },
          });
          // Even a transport that ignores abort must release a late unread body.
          request.then(
            (late) => {
              if (signal.aborted) late.body?.cancel().catch(() => {});
            },
            () => {},
          );
          response = await abortable(request, signal);
        } catch {
          return input;
        }
        if (signal.aborted) {
          response.body?.cancel().catch(() => {});
          return input;
        }
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          if (response.status !== 429 && response.status !== 503) return input;
          const retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const date = retryAfter === null ? NaN : Date.parse(retryAfter);
          backoff = Math.max(
            1100,
            Number.isFinite(seconds)
              ? seconds * 1000
              : Number.isFinite(date)
                ? date - now()
                : 1100,
          );
          continue;
        }
        const reader = response.body?.getReader();
        if (!reader) return input;
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await abortable(reader.read(), signal);
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 256 * 1024) return input;
            chunks.push(chunk.value);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        if (signal.aborted) return input;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const data: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        // A malformed response is not a genuine no-match and never enters cache.
        if (
          !data ||
          typeof data !== 'object' ||
          !('recordings' in data) ||
          !Array.isArray(data.recordings) ||
          data.recordings.length > 5 ||
          data.recordings.some((entry: unknown) => !candidate(entry))
        )
          return input;
        const result = select(
          data,
          search,
          splitSearch
            ? {
                ...evidence,
                originalArtist: text(evidence.originalArtist)
                  ? evidence.originalArtist
                  : input.artist,
              }
            : undefined,
        );
        if (signal.aborted) return input;
        if (!result && !splitSearch && split && attempt === 0) {
          search = split;
          splitSearch = true;
          backoff = 0;
          continue;
        }
        this.cache.set(key, {
          result,
          expires:
            now() +
            (result ? (this.dependencies.positiveTtlMs ?? 86400000) : 300000),
        });
        while (this.cache.size > 200)
          this.cache.delete(this.cache.keys().next().value!);
        return result ? { ...input, ...result } : input;
      }
    } catch {
      return input;
    } finally {
      clearTimeout(timer);
      release();
      this.rate.queued--;
    }
    return input;
  }
}
