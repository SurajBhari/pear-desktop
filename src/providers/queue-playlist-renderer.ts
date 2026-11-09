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

import type { NativeQueueActionValue } from '@/plugins/api-server/music-types';
import type { MusicPlayer } from '@/types/music-player';
import type { MusicPlayerAppElement } from '@/types/music-player-app-element';
import type { QueueElement, Store } from '@/types/queue';

type Owner = {
  app: MusicPlayerAppElement;
  queue: QueueElement;
  store: Store;
  network: MusicPlayerAppElement['networkManager'];
};
type OwnedQueueContext = {
  current(this: void): boolean;
  scalarCurrent(this: void): boolean;
  nativeCurrent(this: void): boolean;
  enter(this: void): void;
  beforeEffect(this: void): void;
};
type OwnedJob = {
  ownership: OwnedQueueContext;
  entered: boolean;
  resolve(value: NativeQueueActionValue): void;
  reject(error: Error): void;
  settle(): void;
  dispatch(this: void, action: unknown): void;
  fetch(this: void, data: Record<string, unknown>): Promise<unknown>;
  fence(): boolean;
};
type Job = {
  owned?: OwnedJob;
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
    if (job.owned) {
      if (result.ok)
        job.owned.resolve({
          version: 1,
          phase: result.count ? 'owned_queue_dispatch' : 'owned_queue_noop',
          count: result.count,
        } as NativeQueueActionValue);
      else if (job.owned.entered)
        job.owned.reject(new Error('Queue outcome unknown'));
      else
        job.owned.resolve({
          version: 1,
          phase: 'pre_effect_denial',
          reason: result.reason === 'service' ? 'source' : result.reason,
        });
      if (active !== job) job.owned.settle();
    }
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
  // This private lifetime is independent of native/actor ownership. It must be
  // the last, non-calling proof before every shared lane effect.
  const canonicalCurrent = (job: Job) =>
    !disposed && !job.finished && job.generation === generation;
  const valid = (job: Job) =>
    canonicalCurrent(job) &&
    (!job.owned || (job.owned.ownership.current() && job.owned.fence())) &&
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
      const payload = { queueContextParams: context, ...data };
      const fetch = job.owned
        ? job.owned.fetch
        : (Reflect.get(job.owner.network, 'fetch') as unknown);
      const fetchReceiver = job.owned ? undefined : job.owner.network;
      const fetchArgs = job.owned ? [payload] : ['/music/get_queue', payload];
      if (typeof fetch !== 'function')
        throw new Error('Unavailable queue fetch');
      // Context, target capture and modern ownership may synchronously retire the
      // shared lane. No ordinary callout follows its final private scalar fence.
      if ((job.owned && !job.owned.fence()) || !canonicalCurrent(job)) {
        finish(job, { ok: false, reason: 'retired' });
        return;
      }
      const response: unknown = await Reflect.apply(
        fetch,
        fetchReceiver,
        fetchArgs,
      );
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
        const action = {
          type: 'ADD_ITEMS',
          payload: {
            nextQueueItemId: state.nextQueueItemId,
            index,
            items,
            shuffleEnabled: false,
            shouldAssignIds: true,
          },
        };
        const dispatch = job.owned
          ? job.owned.dispatch
          : (Reflect.get(job.owner.queue, 'dispatch') as unknown);
        const dispatchReceiver = job.owned ? undefined : job.owner.queue;
        const dispatchArgs = [action];
        if (typeof dispatch !== 'function')
          throw new Error('Unavailable queue dispatch');
        if (job.owned) {
          if (!valid(job) || !job.owned.fence()) {
            finish(job, { ok: false, reason: 'retired' });
            return;
          }
          job.owned.entered = true;
          job.owned.ownership.enter();
          if (!job.owned.fence()) {
            finish(job, { ok: false, reason: 'retired' });
            return;
          }
        }
        if (!canonicalCurrent(job)) {
          finish(job, { ok: false, reason: 'retired' });
          return;
        }
        committing = true;
        try {
          Reflect.apply(dispatch, dispatchReceiver, dispatchArgs);
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
        job.owned?.settle();
        active = undefined;
        drain();
      });
  };
  const add = (input: Job['input'], requestId?: string, owned?: OwnedJob) => {
    if (queued.length + (active ? 1 : 0) >= MAX_QUEUE_REQUESTS) {
      if (requestId) send(requestId, { ok: false, reason: 'busy' });
      if (owned) {
        owned.resolve({
          version: 1,
          phase: 'pre_effect_denial',
          reason: 'busy',
        });
        owned.settle();
      }
      return;
    }
    if (requestId && requests.has(requestId)) return;
    const owner = capture();
    if (!owner) {
      if (requestId) send(requestId, { ok: false, reason: 'retired' });
      if (owned) {
        owned.resolve({
          version: 1,
          phase: 'pre_effect_denial',
          reason: 'retired',
        });
        owned.settle();
      }
      return;
    }
    if (owned) {
      try {
        owned.entered = true;
        owned.ownership.enter();
        owned.ownership.beforeEffect();
      } catch {
        owned.reject(new Error('Queue outcome unknown'));
        owned.settle();
        return;
      }
    } else
      (
        window as unknown as { blockerSceneGuard?: { cancelFromUser(): void } }
      ).blockerSceneGuard?.cancelFromUser();
    const job: Job = {
      input,
      requestId,
      owner,
      generation,
      finished: false,
      owned,
    };
    pending.add(job);
    if (requestId) requests.set(requestId, job);
    queued.push(job);
    drain();
    return job;
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
  const enqueueOwned = (input: Job['input'], ownership: OwnedQueueContext) => {
    let resolve!: (value: NativeQueueActionValue) => void,
      reject!: (error: Error) => void,
      settle!: () => void;
    const result = new Promise<NativeQueueActionValue>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const physicalSettled = new Promise<void>((yes) => {
      settle = yes;
    });
    const links: {
      object: object;
      key: string;
      holder: object;
      descriptor: PropertyDescriptor;
    }[] = [];
    const data = (object: object, key: string): unknown => {
      let holder: object | null = object;
      for (
        let depth = 0;
        holder && depth < 16;
        depth++, holder = Object.getPrototypeOf(holder) as object | null
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(holder, key);
        if (descriptor) {
          if (!('value' in descriptor))
            throw new Error('Unsupported queue binding');
          links.push({ object, key, holder, descriptor });
          return descriptor.value as unknown;
        }
      }
      throw new Error('Missing queue binding');
    };
    let nativeFence = () => false;
    const owned: OwnedJob = {
      ownership,
      entered: false,
      resolve,
      reject,
      settle,
      dispatch: () => {},
      fetch: () => Promise.reject(new Error('Unavailable queue fetch')),
      fence: () => nativeFence(),
    };
    try {
      const doc = document,
        view = doc.defaultView!;
      const intrinsic = (prototype: object, key: string) => {
        let holder: object | null = prototype;
        for (
          let depth = 0;
          holder && depth < 16;
          depth++, holder = Object.getPrototypeOf(holder) as object | null
        ) {
          const d = Object.getOwnPropertyDescriptor(holder, key);
          if (d) return d;
        }
        return undefined;
      };
      const query = intrinsic(view.Document.prototype, 'querySelector')
        ?.value as (this: Document, selector: string) => Element | null;
      const connectedDescriptor = intrinsic(view.Node.prototype, 'isConnected');
      const connectedValue: unknown =
        connectedDescriptor && Reflect.get(connectedDescriptor, 'get');
      const connected = connectedValue as (this: Node) => boolean;
      if (typeof query !== 'function' || typeof connected !== 'function')
        throw new Error('Unsupported DOM proof');
      const app = Reflect.apply(query, doc, ['ytmusic-app'])!,
        element = Reflect.apply(query, doc, ['#queue'])!;
      let queue: unknown;
      let rootHolder: object | null = element;
      while (rootHolder && !Object.hasOwn(rootHolder, 'queue'))
        rootHolder = Object.getPrototypeOf(rootHolder) as object | null;
      const root =
        rootHolder && Object.getOwnPropertyDescriptor(rootHolder, 'queue');
      if (root && 'value' in root) queue = data(element, 'queue');
      else {
        if (!root || !rootHolder) throw new Error('Missing queue binding');
        links.push({
          object: element,
          key: 'queue',
          holder: rootHolder,
          descriptor: root,
        });
        const inst = data(element, 'inst') as object;
        queue = data(inst, 'queue');
        if (Reflect.get(element, 'queue') !== queue)
          throw new Error('Retired queue binding');
      }
      const holder = data(queue as object, 'store') as object;
      const store = data(holder, 'store') as object;
      data(store, 'getState');
      data(store, 'subscribe');
      const dispatch = data(element, 'dispatch');
      owned.dispatch = (action) => {
        Reflect.apply(dispatch as (...args: unknown[]) => unknown, element, [
          action,
        ]);
      };
      const network = data(app, 'networkManager') as object;
      const fetch = data(network, 'fetch');
      owned.fetch = (payload) =>
        Reflect.apply(fetch as (...args: unknown[]) => unknown, network, [
          '/music/get_queue',
          payload,
        ]) as Promise<unknown>;
      if (typeof dispatch !== 'function' || typeof fetch !== 'function')
        throw new Error('Missing queue method');
      nativeFence = () => {
        if (!ownership.current() || !apiAlive() || !ownership.current())
          return false;
        if (
          Reflect.apply(query, doc, ['ytmusic-app']) !== app ||
          Reflect.apply(query, doc, ['#queue']) !== element ||
          !Reflect.apply(connected, app, []) ||
          !Reflect.apply(connected, element, [])
        )
          return false;
        for (const link of links) {
          let holder: object | null = link.object;
          while (holder && !Object.hasOwn(holder, link.key))
            holder = Object.getPrototypeOf(holder) as object | null;
          const d = holder && Object.getOwnPropertyDescriptor(holder, link.key),
            old = link.descriptor;
          if (
            holder !== link.holder ||
            !d ||
            d.value !== old.value ||
            d.get !== old.get ||
            d.set !== old.set ||
            d.writable !== old.writable ||
            d.configurable !== old.configurable ||
            d.enumerable !== old.enumerable
          )
            return false;
        }
        // Descriptor reflection may itself reenter through a provider Proxy. End
        // with captured DOM intrinsics for every native receiver, then scalar state.
        if (
          Reflect.apply(query, doc, ['ytmusic-app']) !== app ||
          Reflect.apply(query, doc, ['#queue']) !== element ||
          !Reflect.apply(connected, app, []) ||
          !Reflect.apply(connected, element, [])
        )
          return false;
        return ownership.nativeCurrent() && ownership.scalarCurrent();
      };
      if (!nativeFence()) throw new Error('Retired queue');
      // The same add/process/drain engine owns all legacy and modern insertion work.
      const job = add(input, undefined, owned);
      return {
        result,
        physicalSettled,
        cancel(this: void) {
          if (!job || job.finished) return;
          const index = queued.indexOf(job);
          if (index >= 0) queued.splice(index, 1);
          finish(job, { ok: false, reason: 'retired' });
        },
      };
    } catch {
      resolve({
        version: 1,
        phase: 'pre_effect_denial',
        reason: 'unavailable',
      });
      settle();
      return { result, physicalSettled, cancel(this: void) {} };
    }
  };
  return { dispose, enqueueOwned, retireOwned: cancelAll };
}
