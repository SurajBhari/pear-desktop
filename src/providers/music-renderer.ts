import {
  MUSIC_LIMITS,
  MusicServiceError,
  utf8Bytes,
  type MusicReadInput,
  type NativeMusicResult,
  type PlaybackSnapshot,
  type MusicFailure,
} from '@/plugins/api-server/music-types';

import { normalizeMusicSource } from './music-catalog';
import {
  isOwnerId,
  isRecord,
  isRequestId,
  isVideoId,
  isPlaylistId,
} from './queue-playlist';

import type { APIServerConfig } from '@/plugins/api-server/config';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';
import type { MusicPlayerAppElement } from '@/types/music-player-app-element';

type Ipc = RendererContext<APIServerConfig>['ipc'];
type Owner = {
  app: MusicPlayerAppElement;
  network: MusicPlayerAppElement['networkManager'];
};
type Job = {
  requestId: string;
  nonce: string;
  documentId: string;
  sourceId: string;
  owner: Owner;
  input?: MusicReadInput;
  canceled: boolean;
};
const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const categories = [
  'FEmusic_explore',
  'FEmusic_charts',
  'FEmusic_moods_and_genres',
  'FEmusic_moods_and_genres_category',
  'FEmusic_new_releases',
  'FEmusic_new_releases_albums',
];
const safeText = (value: unknown, maximum: number) =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= maximum * 2 &&
  Array.from(value).length <= maximum &&
  !Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const browseId = (value: unknown) =>
  typeof value === 'string' &&
  (/^UC[A-Za-z0-9_-]{22}$/.test(value) ||
    /^MPRE[A-Za-z0-9_-]{1,124}$/.test(value) ||
    (value.startsWith('VL') && isPlaylistId(value.slice(2))) ||
    categories.includes(value));
export function parseNativeMusicInput(value: unknown): MusicReadInput | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (value.operation === 'current' && keys.length === 1)
    return { operation: 'current' };
  if (
    value.operation === 'search' &&
    keys.every((key) => ['operation', 'query', 'filter'].includes(key)) &&
    safeText(value.query, 256) &&
    utf8Bytes(value.query as string) <= 1024 &&
    (value.filter === undefined ||
      ['songs', 'videos', 'albums', 'artists', 'playlists'].includes(
        value.filter as string,
      ))
  )
    return {
      operation: 'search',
      query: value.query as string,
      ...(value.filter === undefined
        ? {}
        : {
            filter: value.filter as Extract<
              MusicReadInput,
              { operation: 'search' }
            >['filter'],
          }),
    };
  if (
    value.operation === 'browse' &&
    keys.every((key) => ['operation', 'browseId', 'params'].includes(key)) &&
    browseId(value.browseId) &&
    (value.params === undefined ||
      (safeText(value.params, MUSIC_LIMITS.recipeBytes) &&
        utf8Bytes(value.params as string) <= MUSIC_LIMITS.recipeBytes))
  )
    return {
      operation: 'browse',
      browseId: value.browseId as string,
      ...(value.params === undefined ? {} : { params: value.params as string }),
    };
  if (
    value.operation === 'continuation' &&
    keys.every((key) => ['operation', 'endpoint', 'token'].includes(key)) &&
    ['search', 'browse'].includes(value.endpoint as string) &&
    safeText(value.token, MUSIC_LIMITS.recipeBytes) &&
    utf8Bytes(value.token as string) <= MUSIC_LIMITS.recipeBytes
  )
    return {
      operation: 'continuation',
      endpoint: value.endpoint as 'search' | 'browse',
      token: value.token as string,
    };
  return null;
}
/** Owned native reads only; raw provider envelopes and errors never leave this controller. */
export function createMusicRendererController(
  apiOwner: MusicPlayer,
  getApi: () => MusicPlayer | null,
  ipc: Ipc,
) {
  const documentId = randomId(),
    handshakes = new Map<string, Job>(),
    active = new Set<Job>(),
    queued: Job[] = [];
  let sourceId = randomId(),
    owner: Owner | undefined,
    disposed = false;
  const releases: (() => void)[] = [];
  const send = (packet: object) => {
    try {
      ipc.send('peard:music-reply', packet);
    } catch {
      /* Retired document. */
    }
  };
  const settled = (job: Job, result: NativeMusicResult) =>
    send({
      requestId: job.requestId,
      nonce: job.nonce,
      documentId,
      sourceId: job.sourceId,
      type: 'settled',
      result,
    });
  const rawCurrent = () =>
    `${apiOwner.getVideoData()?.video_id ?? ''}/${apiOwner.getPlayerResponse()?.videoDetails?.videoId ?? ''}`;
  let observedPlayback: string | undefined,
    playbackEpoch = randomId();
  const observePlayback = () => {
    const next = rawCurrent();
    if (next !== observedPlayback) {
      observedPlayback = next;
      playbackEpoch = randomId();
    }
  };
  const capture = (): Owner | undefined => {
    try {
      const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
      if (
        disposed ||
        getApi() !== apiOwner ||
        (apiOwner as MusicPlayer & Partial<HTMLElement>).isConnected ===
          false ||
        !app?.isConnected ||
        !app.networkManager ||
        typeof app.networkManager.fetch !== 'function'
      )
        return;
      return { app, network: app.networkManager };
    } catch {
      return;
    }
  };
  const same = (a: Owner | undefined, b: Owner | undefined) =>
    !!a && !!b && a.app === b.app && a.network === b.network;
  const invalidate = () => {
    send({ type: 'retire', documentId, sourceId });
    sourceId = randomId();
    for (const job of active) job.canceled = true;
    for (const job of queued.splice(0))
      settled(job, { ok: false, reason: 'retired' });
    handshakes.clear();
  };
  const refresh = () => {
    const next = capture();
    if (!same(owner, next)) {
      invalidate();
      owner = next;
    }
    return next;
  };
  const valid = (job: Job) =>
    !job.canceled &&
    !disposed &&
    sourceId === job.sourceId &&
    same(job.owner, capture());
  const snapshot = (job: Job): PlaybackSnapshot => {
    observePlayback();
    const sampledEpoch = playbackEpoch;
    const data = apiOwner.getVideoData(),
      response = apiOwner.getPlayerResponse()?.videoDetails;
    const id = data?.video_id;
    if (
      !isVideoId(id) ||
      response?.videoId !== id ||
      !safeText(response.title, 512) ||
      !safeText(response.author, 256)
    )
      throw new MusicServiceError('unavailable');
    const title = response.title,
      author = response.author;
    const elapsed = apiOwner.getCurrentTime(),
      duration = apiOwner.getDuration(),
      volume = apiOwner.getVolume(),
      state = apiOwner.getPlayerState();
    observePlayback();
    if (
      sampledEpoch !== playbackEpoch ||
      !valid(job) ||
      apiOwner.getVideoData()?.video_id !== id ||
      apiOwner.getPlayerResponse()?.videoDetails?.videoId !== id
    )
      throw new MusicServiceError('retired');
    const elapsedSeconds =
      Number.isFinite(elapsed) &&
      Number.isFinite(elapsed * 1000) &&
      elapsed >= 0
        ? elapsed
        : null;
    const durationSeconds =
      Number.isFinite(duration) && duration >= 0 ? duration : null;
    return {
      version: 1,
      playbackEpoch: `${documentId}:${sampledEpoch}`,
      current: {
        kind:
          response.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : 'video',
        id,
        title,
        artists: [{ name: author }],
        durationSeconds,
      },
      state:
        state === 1
          ? 'playing'
          : state === 2
            ? 'paused'
            : state === 3
              ? 'buffering'
              : state === 0
                ? 'stopped'
                : 'unknown',
      elapsedSeconds,
      elapsedMilliseconds:
        elapsedSeconds === null ? null : elapsedSeconds * 1000,
      durationSeconds,
      volume:
        Number.isFinite(volume) && volume >= 0 && volume <= 100 ? volume : null,
    };
  };
  const process = async (job: Job) => {
    active.add(job);
    try {
      if (!valid(job)) throw new MusicServiceError('retired');
      const input = job.input!;
      if (input.operation === 'current')
        settled(job, { ok: true, value: snapshot(job) });
      else {
        let endpoint: 'search' | 'browse', data: Record<string, string>;
        if (input.operation === 'search') {
          endpoint = 'search';
          data = { query: input.query };
          if (input.filter) {
            // Public SearchFilter.filters(2).music_search_type(17).enum bool(1..5).
            const field =
              ['songs', 'videos', 'albums', 'artists', 'playlists'].indexOf(
                input.filter,
              ) + 1;
            data.params = encodeURIComponent(
              btoa(
                String.fromCharCode(
                  0x12,
                  0x05,
                  0x8a,
                  0x01,
                  0x02,
                  field * 8,
                  0x01,
                ),
              ),
            );
          }
        } else if (input.operation === 'browse') {
          endpoint = 'browse';
          data = {
            browseId: input.browseId,
            ...(input.params === undefined ? {} : { params: input.params }),
          };
        } else {
          endpoint = input.endpoint;
          data = { continuation: input.token };
        }
        const raw = await job.owner.network.fetch<
          unknown,
          Record<string, string>
        >(`/${endpoint}`, data);
        if (!valid(job)) throw new MusicServiceError('retired');
        const value = normalizeMusicSource(raw, endpoint);
        if (!valid(job)) throw new MusicServiceError('retired');
        settled(job, { ok: true, value });
      }
    } catch (error) {
      const reason: MusicFailure = !valid(job)
        ? 'retired'
        : error instanceof MusicServiceError
          ? error.code
          : 'source';
      settled(job, { ok: false, reason });
    } finally {
      active.delete(job);
      pump();
    }
  };
  const pump = () => {
    while (!disposed && active.size < 4 && queued.length)
      process(queued.shift()!);
  };
  const subscribe = (channel: string, fn: (packet: unknown) => void) => {
    if (!ipc.subscribe) throw new MusicServiceError('unavailable');
    releases.push(ipc.subscribe(channel, fn));
  };
  subscribe('peard:music-owner-query', (packet) => {
    if (
      !isRecord(packet) ||
      !isRequestId(packet.requestId) ||
      !isOwnerId(packet.nonce) ||
      handshakes.has(packet.requestId)
    )
      return;
    const captured = refresh();
    if (!captured) {
      send({ ...packet, type: 'unavailable' });
      return;
    }
    if (handshakes.size + active.size + queued.length >= 12) return;
    const job: Job = {
      requestId: packet.requestId,
      nonce: packet.nonce,
      documentId,
      sourceId,
      owner: captured,
      canceled: false,
    };
    handshakes.set(job.requestId, job);
    send({
      requestId: job.requestId,
      nonce: job.nonce,
      documentId,
      sourceId,
      type: 'ready',
    });
  });
  subscribe('peard:music-read', (packet) => {
    if (!isRecord(packet) || !isRequestId(packet.requestId)) return;
    const job = handshakes.get(packet.requestId);
    if (
      !job ||
      packet.nonce !== job.nonce ||
      packet.documentId !== documentId ||
      packet.sourceId !== job.sourceId
    )
      return;
    handshakes.delete(job.requestId);
    const input = parseNativeMusicInput(packet.input);
    if (!input) {
      settled(job, { ok: false, reason: 'invalid' });
      return;
    }
    if (!valid(job)) {
      settled(job, { ok: false, reason: 'retired' });
      return;
    }
    job.input = input;
    if (active.size < 4) process(job);
    else if (queued.length < 8) queued.push(job);
    else settled(job, { ok: false, reason: 'busy' });
  });
  subscribe('peard:music-cancel', (packet) => {
    if (!isRecord(packet)) return;
    if (packet.phase === 'owner') {
      if (
        !isRequestId(packet.requestId) ||
        !isOwnerId(packet.nonce) ||
        packet.documentId !== undefined ||
        packet.sourceId !== undefined
      )
        return;
      const job = handshakes.get(packet.requestId);
      if (job?.nonce === packet.nonce) handshakes.delete(packet.requestId);
      return;
    }
    // Keep exact source-bound read cancellation, including existing callers
    // without a phase marker; an owner challenge cannot cancel physical work.
    if (packet.phase !== undefined && packet.phase !== 'read') return;
    for (const job of [...active, ...queued])
      if (
        job.requestId === packet.requestId &&
        job.nonce === packet.nonce &&
        job.documentId === packet.documentId &&
        job.sourceId === packet.sourceId
      ) {
        job.canceled = true;
        const index = queued.indexOf(job);
        if (index >= 0) {
          queued.splice(index, 1);
          settled(job, { ok: false, reason: 'retired' });
        }
      }
  });
  const videoChanged = () => {
    playbackEpoch = randomId();
    try {
      observedPlayback = rawCurrent();
    } catch {
      observedPlayback = undefined;
    }
  };
  apiOwner.addEventListener('videodatachange', videoChanged);
  releases.push(() =>
    apiOwner.removeEventListener('videodatachange', videoChanged),
  );
  const dispose = () => {
    if (disposed) return;
    invalidate();
    disposed = true;
    for (const release of releases.splice(0)) release();
    window.removeEventListener('pagehide', dispose);
    clearInterval(timer);
  };
  window.addEventListener('pagehide', dispose);
  const timer = setInterval(refresh, 100);
  owner = capture();
  return {
    dispose,
    refresh,
    isCurrent: () => !disposed && same(owner, capture()),
    stats: () => ({ active: active.size, queued: queued.length }),
  };
}
