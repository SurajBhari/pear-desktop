import {
  isInsertPosition,
  isRecord,
  isRequestId,
  isVideoId,
  MAX_QUEUE_REQUESTS,
  parsePlaylistInput,
  queueItemsFromDatas,
  queueVideoRenderer,
  sliceQueueDatasFromVideo,
  validatedPlaylistQueueDatas,
  type PlaylistInput,
  type PlaylistResult,
  type QueueInsertPosition,
} from './queue-playlist';

import type { MusicPlayer } from '@/types/music-player';
import type { MusicPlayerAppElement } from '@/types/music-player-app-element';
import type { QueueElement, Store } from '@/types/queue';

type Owner = {
  app: MusicPlayerAppElement;
  queue: QueueElement;
  store: Store;
  network: MusicPlayerAppElement['networkManager'];
};
type Job = {
  requestId?: string;
  input:
    | PlaylistInput
    | { videoId: string; insertPosition: QueueInsertPosition };
  owner: Owner;
  generation: number;
  finished: boolean;
};

/** One physical service lane; canceled work is retired but an unabortable fetch must settle before the next fetch. */
export function createPlaylistQueueController(
  apiOwner: MusicPlayer | null,
  getApi: () => MusicPlayer | null,
) {
  const ownerId = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
  let disposed = false,
    generation = 0,
    committing = false;
  let active: Job | undefined;
  const queued: Job[] = [];
  const pending = new Set<Job>();
  const requests = new Map<string, Job>();
  let observedStore: Store | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let previousItems: unknown, previousContext: unknown;
  const apiAlive = () =>
    !!apiOwner &&
    getApi() === apiOwner &&
    (apiOwner as MusicPlayer & Partial<HTMLElement>).isConnected !== false;
  const send = (requestId: string, result: PlaylistResult) => {
    try {
      window.ipcRenderer.send('peard:playlist-queue-reply', {
        requestId,
        ownerId,
        type: 'result',
        result,
      });
    } catch {
      /* retired window */
    }
  };
  const releaseStore = () => {
    unsubscribeStore?.();
    unsubscribeStore = undefined;
    observedStore = undefined;
  };
  const finish = (job: Job, result: PlaylistResult) => {
    if (job.finished) return;
    job.finished = true;
    pending.delete(job);
    if (job.requestId) {
      requests.delete(job.requestId);
      send(job.requestId, result);
    } else if (!result.ok && result.reason === 'service')
      console.warn('[queue] Unsupported service response');
    if (!pending.size) releaseStore();
  };
  const cancelAll = () => {
    generation++;
    queued.length = 0;
    for (const job of [...pending])
      finish(job, { ok: false, reason: 'retired' });
  };
  const bindStore = (store: Store) => {
    if (observedStore === store) return true;
    if (observedStore) cancelAll();
    releaseStore();
    const state = store.getState().queue;
    previousItems = state.items;
    previousContext = state.queueContextParams;
    const unsubscribe = store.subscribe(() => {
      if (disposed) return;
      const current = store.getState().queue;
      const changedContext = current.queueContextParams !== previousContext;
      const cleared =
        current.items !== previousItems && current.items.length === 0;
      previousItems = current.items;
      previousContext = current.queueContextParams;
      if (!committing && (changedContext || cleared)) cancelAll();
    });
    if (typeof unsubscribe !== 'function') return false;
    unsubscribeStore = unsubscribe as () => void;
    observedStore = store;
    return true;
  };
  const capture = (): Owner | null => {
    try {
      if (disposed || !apiAlive()) return null;
      const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
      const queue = document.querySelector<QueueElement>('#queue');
      const store = queue?.queue?.store?.store;
      if (
        !app?.isConnected ||
        !queue?.isConnected ||
        !store ||
        !app.networkManager
      )
        return null;
      if (!Array.isArray(store.getState().queue?.items) || !bindStore(store))
        return null;
      return { app, queue, store, network: app.networkManager };
    } catch {
      return null;
    }
  };
  const valid = (job: Job) =>
    !disposed &&
    !job.finished &&
    job.generation === generation &&
    apiAlive() &&
    job.owner.app.isConnected &&
    job.owner.queue.isConnected &&
    document.querySelector('ytmusic-app') === job.owner.app &&
    document.querySelector('#queue') === job.owner.queue &&
    job.owner.queue.queue?.store?.store === job.owner.store &&
    job.owner.app.networkManager === job.owner.network;
  const process = async (job: Job) => {
    if (!valid(job)) {
      finish(job, { ok: false, reason: 'retired' });
      return;
    }
    const context = job.owner.store.getState().queue.queueContextParams;
    try {
      const data =
        'playlistId' in job.input
          ? { playlistId: job.input.playlistId }
          : {
              videoIds: [job.input.videoId],
              queueInsertPosition: job.input.insertPosition,
            };
      const response = await job.owner.network.fetch<
        unknown,
        Record<string, unknown>
      >('/music/get_queue', { queueContextParams: context, ...data });
      if (
        !valid(job) ||
        job.owner.store.getState().queue.queueContextParams !== context
      ) {
        finish(job, { ok: false, reason: 'retired' });
        return;
      }
      let datas = validatedPlaylistQueueDatas(response);
      if ('playlistId' in job.input && job.input.videoId)
        datas = sliceQueueDatasFromVideo(datas, job.input.videoId);
      const items = queueItemsFromDatas(datas);
      if (items.length) {
        const state = job.owner.store.getState().queue;
        const selected = state.items.findIndex(
          (item) => queueVideoRenderer(item)?.selected === true,
        );
        const fallback =
          Number.isInteger(state.selectedItemIndex) &&
          state.selectedItemIndex >= 0 &&
          state.selectedItemIndex < state.items.length
            ? state.selectedItemIndex
            : -1;
        const current = selected >= 0 ? selected : fallback;
        const index =
          job.input.insertPosition === 'INSERT_AFTER_CURRENT_VIDEO' &&
          current >= 0
            ? current + 1
            : state.items.length;
        committing = true;
        try {
          job.owner.queue.dispatch({
            type: 'ADD_ITEMS',
            payload: {
              nextQueueItemId: state.nextQueueItemId,
              index,
              items,
              shuffleEnabled: false,
              shouldAssignIds: true,
            },
          });
        } finally {
          committing = false;
        }
      }
      finish(job, { ok: true, count: items.length });
    } catch {
      finish(job, { ok: false, reason: 'service' });
    }
  };
  const drain = () => {
    if (active || disposed) return;
    const job = queued.shift();
    if (!job) return;
    active = job;
    process(job)
      .catch(() => finish(job, { ok: false, reason: 'retired' }))
      .finally(() => {
        active = undefined;
        drain();
      });
  };
  const add = (input: Job['input'], requestId?: string) => {
    if (queued.length + (active ? 1 : 0) >= MAX_QUEUE_REQUESTS) {
      if (requestId) send(requestId, { ok: false, reason: 'busy' });
      return;
    }
    if (requestId && requests.has(requestId)) return;
    const owner = capture();
    if (!owner) {
      if (requestId) send(requestId, { ok: false, reason: 'retired' });
      return;
    }
    (
      window as unknown as { blockerSceneGuard?: { cancelFromUser(): void } }
    ).blockerSceneGuard?.cancelFromUser();
    const job: Job = { input, requestId, owner, generation, finished: false };
    pending.add(job);
    if (requestId) requests.set(requestId, job);
    queued.push(job);
    drain();
  };
  const unsubscribers = [
    window.ipcRenderer.subscribe(
      'peard:playlist-queue-owner-query',
      (value) => {
        if (disposed || !isRecord(value) || !isRequestId(value.requestId))
          return;
        window.ipcRenderer.send('peard:playlist-queue-reply', {
          requestId: value.requestId,
          ownerId,
          type: 'owner',
        });
      },
    ),
    window.ipcRenderer.subscribe('peard:add-playlist-to-queue', (value) => {
      if (disposed || !isRecord(value) || !isRequestId(value.requestId)) return;
      if (value.ownerId !== ownerId) {
        send(value.requestId, { ok: false, reason: 'retired' });
        return;
      }
      const input = parsePlaylistInput(
        value.playlistId,
        value.videoId,
        value.insertPosition,
      );
      if (!input) {
        send(value.requestId, { ok: false, reason: 'invalid' });
        return;
      }
      add(input, value.requestId);
    }),
    window.ipcRenderer.subscribe('peard:add-to-queue', (videoId, position) => {
      if (!disposed && isVideoId(videoId) && isInsertPosition(position))
        add({ videoId, insertPosition: position });
    }),
    window.ipcRenderer.subscribe('peard:cancel-playlist-queue', (value) => {
      if (
        disposed ||
        !isRecord(value) ||
        value.ownerId !== ownerId ||
        !isRequestId(value.requestId)
      )
        return;
      const job = requests.get(value.requestId);
      if (!job) return;
      const index = queued.indexOf(job);
      if (index >= 0) queued.splice(index, 1);
      finish(job, { ok: false, reason: 'retired' });
    }),
    window.ipcRenderer.subscribe('peard:clear-queue', () => {
      if (!disposed) cancelAll();
    }),
  ];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAll();
    releaseStore();
    for (const unsubscribe of unsubscribers) unsubscribe();
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('pagehide', dispose);
  return { dispose };
}
