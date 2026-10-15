import {
  MUSIC_LIMITS,
  MusicServiceError,
  utf8Bytes,
  type MusicReadInput,
  type NativeMusicResult,
  type PlaybackSnapshot,
  type MusicFailure,
  type MetadataBinding,
  type NativeNavigationValue,
} from '@/plugins/api-server/music-types';

import { dispatchMusicControl, parseControlCommand } from './music-actions';
import { normalizeMusicSource } from './music-catalog';
import {
  assertMetadataWorkBudget,
  parseWatchNextTabs,
  parseLyrics,
  parseRelated,
} from './music-metadata';
import {
  directNavigation,
  parseNavigationCommand,
  projectNavigationRecipe,
} from './music-navigation';
import { createMusicQueueOwner } from './music-queue';
import {
  nativeElapsedMilliseconds,
  nativePlaybackIdentity,
} from './playback-owner';
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
  fetch: MusicPlayerAppElement['networkManager']['fetch'];
};
type Job = {
  requestId: string;
  nonce: string;
  documentId: string;
  sourceId: string;
  owner: Owner;
  input?: MusicReadInput;
  canceled: boolean;
  currentBinding?: MetadataBinding;
  playbackRetired?: boolean;
  currentMetadata?: boolean;
  navigationEntered?: boolean;
  controlEntered?: boolean;
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
  if (
    ['lyrics', 'related', 'metadata-current', 'related-continuation'].includes(
      Object.getOwnPropertyDescriptor(value, 'operation')?.value as string,
    ) ||
    Object.hasOwn(value, 'expectedCurrent')
  ) {
    try {
      assertMetadataWorkBudget(value);
    } catch {
      return null;
    }
  }
  const keys = Object.keys(value);
  const own = keys.every((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return !!d && 'value' in d;
  });
  const deadlineValue = Object.getOwnPropertyDescriptor(value, 'deadlineAt')
    ?.value as unknown;
  const deadline =
    typeof deadlineValue === 'number' &&
    Number.isFinite(deadlineValue) &&
    deadlineValue > 0;
  if (
    Object.getOwnPropertyDescriptor(value, 'operation')?.value === 'control'
  ) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !own ||
      (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(value).length !== 3 ||
      keys.length !== 3 ||
      !keys.every((key) =>
        ['operation', 'command', 'deadlineAt'].includes(key),
      ) ||
      !deadline
    )
      return null;
    const command = parseControlCommand(value.command);
    return command
      ? { operation: 'control', command, deadlineAt: deadlineValue }
      : null;
  }
  if (own && value.operation === 'navigate' && keys.length === 3 && deadline) {
    const command = parseNavigationCommand(value.command);
    if (command)
      return { operation: 'navigate', command, deadlineAt: deadlineValue };
    return null;
  }
  const metadataBinding = (v: unknown): v is MetadataBinding =>
    isRecord(v) &&
    Object.keys(v).length === 2 &&
    Object.hasOwn(v, 'videoId') &&
    Object.hasOwn(v, 'playbackEpoch') &&
    isVideoId(v.videoId) &&
    (v.playbackEpoch === null ||
      (typeof v.playbackEpoch === 'string' &&
        /^[0-9a-f]{32}:[0-9a-f]{32}$/.test(v.playbackEpoch)));
  if (
    own &&
    deadline &&
    (value.operation === 'lyrics' || value.operation === 'related') &&
    keys.length === 3 &&
    isRecord(value.target) &&
    Object.keys(value.target).length === 1 &&
    (isVideoId(value.target.videoId) || value.target.current === true)
  )
    return value as unknown as MusicReadInput;
  if (
    own &&
    deadline &&
    value.operation === 'metadata-current' &&
    keys.length === 2
  )
    return {
      operation: 'metadata-current',
      deadlineAt: value.deadlineAt as number,
    };
  if (
    own &&
    deadline &&
    value.operation === 'related-continuation' &&
    keys.length === 4 &&
    metadataBinding(value.binding) &&
    safeText(value.token, MUSIC_LIMITS.recipeBytes) &&
    utf8Bytes(value.token as string) <= MUSIC_LIMITS.recipeBytes
  )
    return value as unknown as MusicReadInput;
  if (
    (value.operation === 'home' || value.operation === 'library') &&
    keys.length === 1
  )
    return { operation: value.operation };
  if (value.operation === 'queue' && keys.length === 1)
    return { operation: 'queue' };
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
    keys.every((key) =>
      [
        'operation',
        'browseId',
        'params',
        'expectedCurrent',
        'deadlineAt',
      ].includes(key),
    ) &&
    browseId(value.browseId) &&
    (value.expectedCurrent === undefined
      ? value.deadlineAt === undefined
      : metadataBinding(value.expectedCurrent) &&
        value.expectedCurrent.playbackEpoch !== null &&
        deadline) &&
    (value.params === undefined ||
      (safeText(value.params, MUSIC_LIMITS.recipeBytes) &&
        utf8Bytes(value.params as string) <= MUSIC_LIMITS.recipeBytes))
  )
    return {
      operation: 'browse',
      browseId: value.browseId as string,
      ...(value.expectedCurrent === undefined
        ? {}
        : {
            expectedCurrent: value.expectedCurrent as MetadataBinding,
            deadlineAt: value.deadlineAt as number,
          }),
      ...(value.params === undefined ? {} : { params: value.params as string }),
    };
  if (
    value.operation === 'continuation' &&
    keys.every((key) =>
      [
        'operation',
        'endpoint',
        'token',
        'expectedCurrent',
        'deadlineAt',
      ].includes(key),
    ) &&
    ['search', 'browse'].includes(value.endpoint as string) &&
    (value.expectedCurrent === undefined
      ? value.deadlineAt === undefined
      : metadataBinding(value.expectedCurrent) &&
        value.expectedCurrent.playbackEpoch !== null &&
        value.endpoint === 'browse' &&
        deadline) &&
    safeText(value.token, MUSIC_LIMITS.recipeBytes) &&
    utf8Bytes(value.token as string) <= MUSIC_LIMITS.recipeBytes
  )
    return {
      operation: 'continuation',
      endpoint: value.endpoint as 'search' | 'browse',
      token: value.token as string,
      ...(value.expectedCurrent === undefined
        ? {}
        : {
            expectedCurrent: value.expectedCurrent as MetadataBinding,
            deadlineAt: value.deadlineAt as number,
          }),
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
  let queueOwner: ReturnType<typeof createMusicQueueOwner> | undefined;
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
  const binding = (object: object, key: string) => {
    let holder: object | null = object;
    for (
      let depth = 0;
      holder && depth < 16;
      depth++, holder = Object.getPrototypeOf(holder) as object | null
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(holder, key);
      if (descriptor) return { object, holder, descriptor };
    }
    return undefined;
  };
  const bindingCurrent = (link: ReturnType<typeof binding>, key: string) => {
    if (!link) return false;
    const current = binding(link.object, key),
      next = current?.descriptor,
      old = link.descriptor;
    return (
      current?.holder === link.holder &&
      !!next &&
      next.value === old.value &&
      next.get === old.get &&
      next.set === old.set &&
      next.writable === old.writable &&
      next.configurable === old.configurable
    );
  };
  const capture = (): Owner | undefined => {
    try {
      const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
      if (!app) return;
      const networkLink = binding(app, 'networkManager');
      const network = app.networkManager;
      if (!network) return;
      const fetchLink = binding(network, 'fetch');
      const fetch = network.fetch;
      const api = getApi();
      // Native getters/getApi can synchronously retire the controller. Check
      // scalar lifetime after all callouts and retain the exact fetch function.
      if (
        disposed ||
        api !== apiOwner ||
        (apiOwner as MusicPlayer & Partial<HTMLElement>).isConnected ===
          false ||
        !app.isConnected ||
        typeof fetch !== 'function' ||
        !bindingCurrent(networkLink, 'networkManager') ||
        !bindingCurrent(fetchLink, 'fetch') ||
        disposed
      )
        return;
      return { app, network, fetch };
    } catch {
      return;
    }
  };
  const same = (a: Owner | undefined, b: Owner | undefined) =>
    !!a &&
    !!b &&
    a.app === b.app &&
    a.network === b.network &&
    a.fetch === b.fetch;
  const invalidate = (
    nextOwner?: Owner,
    expectedSource = sourceId,
    expectedOwner = owner,
  ) => {
    const nextSource = randomId();
    if (sourceId !== expectedSource || owner !== expectedOwner) return false;
    // Publish the complete transition before IPC can synchronously reenter.
    // Old physical jobs remain active until settlement, preserving capacity.
    sourceId = nextSource;
    owner = nextOwner;
    for (const job of active)
      if (job.sourceId === expectedSource) job.canceled = true;
    const retiredQueue = queued.splice(0);
    handshakes.clear();
    for (const job of retiredQueue) job.canceled = true;
    send({ type: 'retire', documentId, sourceId: expectedSource });
    for (const job of retiredQueue)
      settled(job, { ok: false, reason: 'retired' });
    return !disposed && sourceId === nextSource && owner === nextOwner;
  };
  const refresh = () => {
    const registeredOwner = owner,
      registeredSource = sourceId;
    const next = capture();
    // A native getter may have already adopted a newer source or disposed us.
    if (disposed || owner !== registeredOwner || sourceId !== registeredSource)
      return;
    if (
      !same(registeredOwner, next) &&
      !invalidate(next, registeredSource, registeredOwner)
    )
      return;
    return next;
  };
  const valid = (job: Job) => {
    // A retired physical job must not call native getters for a newer source.
    if (
      job.canceled ||
      job.playbackRetired ||
      disposed ||
      sourceId !== job.sourceId ||
      !same(job.owner, owner)
    )
      return false;
    const registeredOwner = owner,
      registeredSource = sourceId;
    const captured = capture();
    if (
      job.canceled ||
      job.playbackRetired ||
      disposed ||
      owner !== registeredOwner ||
      sourceId !== registeredSource
    )
      return false;
    if (!same(registeredOwner, captured)) {
      invalidate(captured, registeredSource, registeredOwner);
      return false;
    }
    return !job.canceled && !disposed && sourceId === job.sourceId;
  };
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
      nativePlaybackIdentity(apiOwner) !== id
    )
      throw new MusicServiceError('retired');
    const elapsedSeconds =
      nativeElapsedMilliseconds(elapsed) !== undefined ? elapsed : null;
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
  const probe = (job: Job): MetadataBinding => {
    if (!valid(job)) throw new MusicServiceError('retired');
    observePlayback();
    const sampledEpoch = playbackEpoch;
    const id = nativePlaybackIdentity(apiOwner);
    if (!valid(job) || sampledEpoch !== playbackEpoch)
      throw new MusicServiceError('retired');
    if (!isVideoId(id)) throw new MusicServiceError('unavailable');
    observePlayback();
    if (!valid(job) || sampledEpoch !== playbackEpoch)
      throw new MusicServiceError('retired');
    return { videoId: id, playbackEpoch: `${documentId}:${sampledEpoch}` };
  };
  const metadataValid = (job: Job, deadlineAt: number) => {
    if (!valid(job)) throw new MusicServiceError('retired');
    if (Date.now() >= deadlineAt) throw new MusicServiceError('timeout');
    if (job.currentBinding) {
      const next = probe(job);
      if (
        next.videoId !== job.currentBinding.videoId ||
        next.playbackEpoch !== job.currentBinding.playbackEpoch ||
        !valid(job)
      ) {
        job.playbackRetired = true;
        throw new MusicServiceError('retired');
      }
    }
    if (!valid(job)) throw new MusicServiceError('retired');
    if (Date.now() >= deadlineAt) throw new MusicServiceError('timeout');
  };
  const metadata = async (
    job: Job,
    input: Extract<
      MusicReadInput,
      {
        operation:
          | 'lyrics'
          | 'related'
          | 'metadata-current'
          | 'related-continuation';
      }
    >,
  ) => {
    metadataValid(job, input.deadlineAt);
    if (input.operation === 'metadata-current') {
      const value = { version: 1 as const, binding: probe(job) };
      metadataValid(job, input.deadlineAt);
      return value;
    }
    const binding =
      input.operation === 'related-continuation'
        ? input.binding
        : 'videoId' in input.target
          ? { videoId: input.target.videoId, playbackEpoch: null }
          : probe(job);
    if (binding.playbackEpoch !== null) job.currentBinding = binding;
    metadataValid(job, input.deadlineAt);
    let raw: unknown;
    if (input.operation === 'related-continuation') {
      raw = await job.owner.fetch.call(job.owner.network, '/browse', {
        continuation: input.token,
      });
    } else {
      const next = await job.owner.fetch.call(job.owner.network, '/next', {
        videoId: binding.videoId,
        isAudioOnly: true,
      });
      metadataValid(job, input.deadlineAt);
      const tabs = parseWatchNextTabs(next, binding.videoId),
        id = tabs[input.operation];
      metadataValid(job, input.deadlineAt);
      if (id === null)
        return input.operation === 'lyrics'
          ? {
              version: 1 as const,
              binding,
              lyrics: {
                videoId: binding.videoId,
                available: false,
                lyrics: null,
                source: null,
              },
            }
          : {
              version: 1 as const,
              binding,
              source: {
                version: 1 as const,
                items: [],
                shelves: [],
                continuation: null,
                targetRecipes: [],
              },
            };
      raw = await job.owner.fetch.call(job.owner.network, '/browse', {
        browseId: id,
      });
    }
    metadataValid(job, input.deadlineAt);
    const value =
      input.operation === 'lyrics'
        ? {
            version: 1 as const,
            binding,
            lyrics: { videoId: binding.videoId, ...parseLyrics(raw) },
          }
        : { version: 1 as const, binding, source: parseRelated(raw) };
    metadataValid(job, input.deadlineAt);
    return value;
  };
  const navigate = async (
    job: Job,
    input: Extract<MusicReadInput, { operation: 'navigate' }>,
  ): Promise<NativeNavigationValue> => {
    metadataValid(job, input.deadlineAt);
    let command = input.command;
    if (command.action === 'radio' && command.seed.kind === 'current') {
      job.currentBinding = probe(job);
      command = {
        action: 'radio',
        seed: { kind: 'video', videoId: job.currentBinding.videoId },
      };
    }
    metadataValid(job, input.deadlineAt);
    let endpoint = directNavigation(command);
    if (!endpoint) {
      const seedVideo =
        command.action === 'radio' && command.seed.kind === 'video'
          ? command.seed.videoId
          : undefined;
      const video = seedVideo !== undefined;
      const data = video
        ? { videoId: seedVideo, isAudioOnly: true }
        : {
            browseId:
              'VL' +
              (command.action === 'play_playlist'
                ? command.playlistId
                : command.action === 'radio' && command.seed.kind === 'playlist'
                  ? command.seed.playlistId
                  : ''),
          };
      const raw = await Reflect.apply(job.owner.fetch, job.owner.network, [
        video ? '/next' : '/browse',
        data,
      ]);
      metadataValid(job, input.deadlineAt);
      endpoint = projectNavigationRecipe(raw, command);
    }
    metadataValid(job, input.deadlineAt);
    const app = job.owner.app,
      dispatchLink = binding(app, 'dispatchEvent'),
      // oxlint-disable-next-line typescript/unbound-method -- Captured once, invoked below with the exact owned app receiver.
      dispatch = app.dispatchEvent,
      EventClass = app.ownerDocument.defaultView?.CustomEvent;
    if (typeof dispatch !== 'function' || !EventClass)
      throw new MusicServiceError('unavailable');
    const event = new EventClass('yt-navigate', {
      detail: { endpoint },
      bubbles: true,
      composed: true,
    });
    metadataValid(job, input.deadlineAt);
    if (!bindingCurrent(dispatchLink, 'dispatchEvent'))
      throw new MusicServiceError('retired');
    // Entering dispatch may itself change playback. No post-effect playback fence.
    job.navigationEntered = true;
    Reflect.apply(dispatch, app, [event]);
    return {
      version: 1,
      phase: 'owned_dispatch',
      ...(job.currentBinding ? { binding: job.currentBinding } : {}),
    };
  };
  const process = async (job: Job) => {
    active.add(job);
    try {
      if (!valid(job)) throw new MusicServiceError('retired');
      const input = job.input!;
      job.currentMetadata =
        (input.operation === 'navigate' &&
          input.command.action === 'radio' &&
          input.command.seed.kind === 'current') ||
        input.operation === 'metadata-current' ||
        ((input.operation === 'lyrics' || input.operation === 'related') &&
          'current' in input.target) ||
        (input.operation === 'related-continuation' &&
          input.binding.playbackEpoch !== null) ||
        ((input.operation === 'browse' || input.operation === 'continuation') &&
          !!input.expectedCurrent);
      if (input.operation === 'control') {
        let controlEpoch: string | null | undefined;
        // Scalar-only fence after native getter callouts: no DOM/API probing.
        const current = () => {
          if (Date.now() >= input.deadlineAt)
            throw new MusicServiceError('timeout');
          return (
            !disposed &&
            !job.canceled &&
            !job.playbackRetired &&
            sourceId === job.sourceId &&
            same(job.owner, owner) &&
            (controlEpoch === undefined ||
              controlEpoch === `${documentId}:${playbackEpoch}`)
          );
        };
        const value = dispatchMusicControl(apiOwner, input.command, {
          valid: () => current() && valid(job),
          current,
          probe: () => {
            const binding = probe(job);
            if (controlEpoch === undefined)
              controlEpoch = binding.playbackEpoch;
            return binding;
          },
          enter: () => {
            job.controlEntered = true;
          },
        });
        settled(job, { ok: true, value });
      } else if (input.operation === 'navigate') {
        const value = await navigate(job, input);
        settled(job, { ok: true, value });
      } else if (
        input.operation === 'lyrics' ||
        input.operation === 'related' ||
        input.operation === 'metadata-current' ||
        input.operation === 'related-continuation'
      ) {
        const value = await metadata(job, input);
        metadataValid(job, input.deadlineAt);
        settled(job, { ok: true, value });
      } else if (input.operation === 'current')
        settled(job, { ok: true, value: snapshot(job) });
      else if (input.operation === 'queue') {
        queueOwner ??= createMusicQueueOwner(apiOwner, getApi, document);
        const value = queueOwner.snapshot();
        if (!valid(job)) throw new MusicServiceError('retired');
        settled(job, { ok: true, value });
      } else {
        if (
          (input.operation === 'browse' ||
            input.operation === 'continuation') &&
          input.expectedCurrent
        ) {
          job.currentBinding = input.expectedCurrent;
          metadataValid(job, input.deadlineAt!);
        }
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
        } else if (
          input.operation === 'home' ||
          input.operation === 'library'
        ) {
          endpoint = 'browse';
          data = {
            browseId:
              input.operation === 'home'
                ? 'FEmusic_home'
                : 'FEmusic_liked_playlists',
          };
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
        if (!valid(job)) throw new MusicServiceError('retired');
        if (
          (input.operation === 'browse' ||
            input.operation === 'continuation') &&
          input.expectedCurrent
        )
          metadataValid(job, input.deadlineAt!);
        const raw = await job.owner.fetch.call(
          job.owner.network,
          `/${endpoint}`,
          data,
        );
        if (!valid(job)) throw new MusicServiceError('retired');
        if (
          (input.operation === 'browse' ||
            input.operation === 'continuation') &&
          input.expectedCurrent
        )
          metadataValid(job, input.deadlineAt!);
        const value = normalizeMusicSource(
          raw,
          input.operation === 'home' || input.operation === 'library'
            ? input.operation
            : endpoint,
        );
        if (!valid(job)) throw new MusicServiceError('retired');
        if (
          (input.operation === 'browse' ||
            input.operation === 'continuation') &&
          input.expectedCurrent
        )
          metadataValid(job, input.deadlineAt!);
        settled(job, { ok: true, value });
      }
    } catch (error) {
      const reason: MusicFailure = !valid(job)
        ? 'retired'
        : error instanceof MusicServiceError
          ? error.code
          : 'source';
      settled(
        job,
        (job.input?.operation === 'navigate' && !job.navigationEntered) ||
          (job.input?.operation === 'control' && !job.controlEntered)
          ? {
              ok: true,
              value: { version: 1, phase: 'pre_effect_denial', reason },
            }
          : { ok: false, reason },
      );
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
    for (const job of active)
      if (job.currentMetadata) job.playbackRetired = true;
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
    disposed = true;
    invalidate();
    queueOwner?.dispose();
    for (const release of releases.splice(0)) release();
    window.removeEventListener('pagehide', dispose);
    clearInterval(timer);
  };
  window.addEventListener('pagehide', dispose);
  const timer = setInterval(refresh, 100);
  const initialOwner = owner,
    initialSource = sourceId;
  const capturedOwner = capture();
  if (!disposed && owner === initialOwner && sourceId === initialSource)
    owner = capturedOwner;
  return {
    dispose,
    refresh,
    isCurrent: () => {
      const registeredOwner = owner,
        registeredSource = sourceId;
      const captured = capture();
      if (
        disposed ||
        owner !== registeredOwner ||
        sourceId !== registeredSource
      )
        return false;
      if (!same(registeredOwner, captured)) {
        invalidate(captured, registeredSource, registeredOwner);
        return false;
      }
      return (
        !disposed && owner === registeredOwner && sourceId === registeredSource
      );
    },
    stats: () => ({ active: active.size, queued: queued.length }),
  };
}
