import {
  getPlaybackRateOwner,
  getUnforcedPlaybackRate,
  isAdSpeedupOverride,
} from '@/plugins/utils/renderer/playback-rate-owner';
import {
  getPlaybackOwner,
  samePlaybackBinding,
  type PlaybackBinding,
} from '@/providers/playback-owner';
import {
  getCurrentAudioGraph,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';

import type { PlaybackSnapshot } from './transition-audio';
import type { MusicPlayer } from '@/types/music-player';
import type { QueueElement } from '@/types/queue';

type Data = Record<string, unknown>;
const record = (value: unknown): Data | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : undefined;
const value = (target: unknown, key: string): unknown => {
  const d =
    target !== null && typeof target === 'object'
      ? Object.getOwnPropertyDescriptor(target, key)
      : undefined;
  return d && 'value' in d ? d.value : undefined;
};
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[\w-]{11}$/.test(v);
function rows(input: unknown): { ids: string[]; selected: number[] } | null {
  if (!Array.isArray(input) || !input.length || input.length > 200) return null;
  const ids: string[] = [],
    selected: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = value(input, String(i));
    const direct = value(raw, 'playlistPanelVideoRenderer');
    const wrapped = value(
      value(value(raw, 'playlistPanelVideoWrapperRenderer'), 'primaryRenderer'),
      'playlistPanelVideoRenderer',
    );
    const row = direct ?? wrapped,
      videoId = value(row, 'videoId');
    if (!id(videoId)) return null;
    ids.push(videoId);
    if (value(row, 'selected') === true) selected.push(i);
  }
  return { ids, selected };
}
/** config/plugins.ts defaults absent plugin records to {enabled:false}. Reject malformed overrides. */
function ambiguityModesDisabled(config: {
  get(key: string): unknown;
}): boolean {
  const plugins = config.get('plugins');
  if (
    !record(plugins) ||
    (Object.getPrototypeOf(plugins) !== Object.prototype &&
      Object.getPrototypeOf(plugins) !== null)
  )
    return false;
  for (const key of ['music-together', 'skip-disliked-songs']) {
    const descriptor = Object.getOwnPropertyDescriptor(plugins, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || !record(descriptor.value)) return false;
    const enabled = Object.getOwnPropertyDescriptor(
      descriptor.value,
      'enabled',
    );
    if (enabled && (!('value' in enabled) || enabled.value !== false))
      return false;
  }
  return true;
}
export type NativeCrossfadeState = {
  api: MusicPlayer;
  main: HTMLVideoElement;
  graph: RendererAudioGraph;
  audioSource: MediaElementAudioSourceNode;
  audioContext: AudioContext;
  document: Document;
  owner: NonNullable<ReturnType<typeof getPlaybackOwner>>;
  binding: PlaybackBinding;
  source: string;
  time: number;
  duration: number;
  revision: number;
  rateOwner: string | null;
  playback: PlaybackSnapshot;
  queue: QueueElement;
  queueApi: QueueElement['queue'];
  store: QueueElement['queue']['store']['store'];
  order: string;
  context: string;
  selectedIndex: number;
  videoId: string;
  nextId: string | null;
};
/** Factual read only. Unknown provenance is unsupported; never creates a playback owner. */
export function readNativeCrossfadeState(
  api: MusicPlayer,
  main: HTMLVideoElement,
  graph: RendererAudioGraph,
): NativeCrossfadeState | null {
  try {
    const audioSource = graph.audioSource,
      audioContext = graph.audioContext;
    const document = main.ownerDocument,
      view = document.defaultView;
    const host = view as unknown as {
      blockerSceneGuard?: { userRevision?: () => number };
      mainConfig?: { get(key: string): unknown };
    };
    const revision = host.blockerSceneGuard?.userRevision?.();
    const config = host.mainConfig;
    if (
      !Number.isSafeInteger(revision) ||
      !config ||
      !ambiguityModesDisabled(config)
    )
      return null;
    const owner = getPlaybackOwner(api);
    const videoId = api.getVideoData()?.video_id;
    if (!owner || !id(videoId)) return null;
    const binding = owner.binding(videoId);
    if (!binding) return null;
    const methods = [
      api.getVideoData,
      api.getPlayerResponse,
      api.getPlayerState,
      api.getCurrentTime,
      api.getPlaybackRate,
      api.nextVideo,
    ];
    const fence = () =>
      getCurrentAudioGraph() === graph &&
      graph.audioSource === audioSource &&
      graph.audioContext === audioContext &&
      audioSource.mediaElement === main &&
      graph.audioContext.state === 'running' &&
      main.isConnected &&
      document.querySelector('video') === main &&
      document.querySelector('#movie_player') === (api as unknown as Element) &&
      getPlaybackOwner(api) === owner &&
      samePlaybackBinding(owner.binding(videoId), binding) &&
      host.blockerSceneGuard?.userRevision?.() === revision &&
      ambiguityModesDisabled(config) &&
      methods.every(
        (method, i) =>
          method ===
          [
            api.getVideoData,
            api.getPlayerResponse,
            api.getPlayerState,
            api.getCurrentTime,
            api.getPlaybackRate,
            api.nextVideo,
          ][i],
      );
    if (!fence()) return null;
    const native = api.getVideoData();
    if (!fence()) return null;
    const response = api.getPlayerResponse();
    if (!fence()) return null;
    if (
      native.video_id !== videoId ||
      response?.videoDetails?.videoId !== videoId ||
      native.isLive !== false ||
      native.isPremiere === true ||
      response.videoDetails.isLiveContent !== false ||
      api.getPlayerState() !== 1 ||
      main.paused ||
      main.ended ||
      main.seeking ||
      (api as unknown as Element).classList?.contains('ad-showing') ||
      (api as unknown as Element).classList?.contains('ad-interrupting') ||
      isAdSpeedupOverride(main)
    )
      return null;
    const source = main.currentSrc,
      time = main.currentTime,
      duration = main.duration,
      rate = main.playbackRate;
    if (
      !source ||
      source.length > 16384 ||
      main.readyState < 2 ||
      !main.seekable.length ||
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > 7200 ||
      !Number.isFinite(time) ||
      time < 0 ||
      time >= duration ||
      !Number.isFinite(rate) ||
      rate < 0.07 ||
      rate > 16 ||
      getUnforcedPlaybackRate(main, rate) !== rate ||
      api.getPlaybackRate() !== rate ||
      Math.abs(api.getCurrentTime() - time) > 0.5
    )
      return null;
    const flags: PlaybackSnapshot['flags'][number][] = [];
    for (const key of [
      'preservesPitch',
      'mozPreservesPitch',
      'webkitPreservesPitch',
    ] as const)
      if (key in main) {
        const v = (main as unknown as Data)[key];
        if (typeof v !== 'boolean') return null;
        flags.push({ key, value: v });
        if (!fence()) return null;
      }
    if (!flags.length) return null;
    const queue = document.querySelector<QueueElement>('#queue'),
      bar = document.querySelector<HTMLElement & { getState?: () => unknown }>(
        'ytmusic-player-bar',
      );
    if (!queue || !bar?.getState || !queue.queue?.store?.store) return null;
    const queueApi = queue.queue,
      store = queueApi.store.store;
    // Captured for an identity fence; always invoked with its original receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const getItems = queueApi.getItems;
    const getState = store.getState;
    const state = record(getState.call(store)),
      q = record(state?.queue),
      barQueue = record(record(bar.getState())?.queue);
    const cast = record(state?.castStatus),
      connection = record(cast?.castConnectionData);
    const first = rows(getItems.call(queueApi)),
      stored = rows(q?.items),
      selectedIndex = q?.selectedItemIndex;
    if (
      !fence() ||
      !q ||
      !first ||
      !stored ||
      !Number.isSafeInteger(selectedIndex) ||
      typeof selectedIndex !== 'number' ||
      selectedIndex < 0 ||
      selectedIndex >= first.ids.length ||
      first.ids[selectedIndex] !== videoId ||
      first.selected.length !== 1 ||
      first.selected[0] !== selectedIndex ||
      JSON.stringify(first) !== JSON.stringify(stored) ||
      q.repeatMode !== 'NONE' ||
      barQueue?.repeatMode !== 'NONE' ||
      q.shuffleEnabled !== false ||
      barQueue.shuffleEnabled !== false ||
      typeof q.queueContextParams !== 'string' ||
      q.queueContextParams.length > 8192 ||
      cast?.remoteWatchEndpoint !== null ||
      connection?.castConnectionState !== 'DISCONNECTED'
    )
      return null;
    const order = JSON.stringify(first.ids),
      context = q.queueContextParams,
      rateOwner = getPlaybackRateOwner(main);
    const again = record(getState.call(store)),
      finalQueue = record(again?.queue),
      finalRows = rows(getItems.call(queueApi));
    if (
      !fence() ||
      queue !== document.querySelector('#queue') ||
      queue.queue !== queueApi ||
      queueApi.store.store !== store ||
      queueApi.getItems !== getItems ||
      store.getState !== getState ||
      finalQueue?.selectedItemIndex !== selectedIndex ||
      finalQueue.repeatMode !== 'NONE' ||
      finalQueue.shuffleEnabled !== false ||
      finalQueue.queueContextParams !== context ||
      JSON.stringify(finalRows) !== JSON.stringify(first) ||
      main.currentSrc !== source ||
      main.playbackRate !== rate ||
      getPlaybackRateOwner(main) !== rateOwner ||
      flags.some(({ key, value: v }) => (main as unknown as Data)[key] !== v)
    )
      return null;
    return {
      api,
      main,
      graph,
      audioSource,
      audioContext,
      document,
      owner,
      binding,
      source,
      time,
      duration,
      revision: revision as number,
      rateOwner,
      playback: { rate, flags },
      queue,
      queueApi,
      store,
      order,
      context,
      selectedIndex,
      videoId,
      nextId:
        first.ids[selectedIndex + 1] !== videoId
          ? (first.ids[selectedIndex + 1] ?? null)
          : null,
    };
  } catch {
    return null;
  }
}
export function sameCrossfadeOwners(
  a: NativeCrossfadeState,
  b: NativeCrossfadeState,
): boolean {
  return (
    a.api === b.api &&
    a.main === b.main &&
    a.graph === b.graph &&
    a.audioSource === b.audioSource &&
    a.audioContext === b.audioContext &&
    a.document === b.document &&
    a.owner === b.owner &&
    a.queue === b.queue &&
    a.queueApi === b.queueApi &&
    a.store === b.store &&
    a.revision === b.revision &&
    a.order === b.order &&
    a.context === b.context &&
    a.rateOwner === b.rateOwner &&
    a.playback.rate === b.playback.rate &&
    JSON.stringify(a.playback.flags) === JSON.stringify(b.playback.flags)
  );
}
