import {
  MUSIC_LIMITS,
  failMusic,
  utf8Bytes,
  type MusicItem,
  type NativeQueueSnapshot,
} from '@/plugins/api-server/music-types';

import { isVideoId } from './queue-playlist';

import type { MusicPlayer } from '@/types/music-player';

const revision = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
type Data = Record<string, unknown>;
const record = (v: unknown): Data | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : undefined;
const field = (v: unknown, key: string) => record(v)?.[key];
const list = (v: unknown): unknown[] | undefined =>
  Array.isArray(v) ? v : undefined;
const renderer = (raw: unknown) =>
  record(
    field(raw, 'playlistPanelVideoRenderer') ??
      field(
        field(
          field(raw, 'playlistPanelVideoWrapperRenderer'),
          'primaryRenderer',
        ),
        'playlistPanelVideoRenderer',
      ),
  );
type PropertyFence = {
  target: object;
  key: string;
  owner?: object;
  descriptor?: PropertyDescriptor;
};
type StructuralSlot = {
  row: unknown;
  renderer: Data;
  videoId: unknown;
  selected: unknown;
};
type Structure = { selected: unknown; slots: StructuralSlot[] };
type Binding = {
  element: Element;
  apiNode?: Node;
  queue: Data;
  holder: Data;
  store: Data;
  getItems: () => unknown;
  getState: () => unknown;
  subscribe: (callback: () => void) => unknown;
  fences: PropertyFence[];
};
/** Copy bounded native data without invoking row getters or serializing provider objects. */
function copyRows(value: unknown): unknown[] {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > MUSIC_LIMITS.sourceNodes || depth > MUSIC_LIMITS.sourceDepth)
      return failMusic('budget');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return failMusic('source');
      return v;
    }
    if (typeof v === 'string') {
      bytes += utf8Bytes(v);
      if (bytes > MUSIC_LIMITS.nativeBytes) return failMusic('budget');
      return v;
    }
    if (!v || typeof v !== 'object' || ancestors.has(v))
      return failMusic('source');
    const array = Array.isArray(v);
    if (array && v.length > MUSIC_LIMITS.sourceNodes - nodes)
      return failMusic('budget');
    if (
      !array &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      return failMusic('source');
    ancestors.add(v);
    const out: Data = Object.create(null) as Data,
      arrayOut: unknown[] = [];
    for (const key of Object.keys(v)) {
      bytes += utf8Bytes(key) + 4;
      if (bytes > MUSIC_LIMITS.nativeBytes) return failMusic('budget');
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (
        !descriptor ||
        !('value' in descriptor) ||
        descriptor.value === undefined
      )
        return failMusic('source');
      const copied = copy(descriptor.value as unknown, depth + 1);
      if (array) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) !== arrayOut.length)
          return failMusic('source');
        arrayOut.push(copied);
      } else out[key] = copied;
    }
    if (array && arrayOut.length !== v.length) return failMusic('source');
    ancestors.delete(v);
    return array ? arrayOut : out;
  };
  if (!Array.isArray(value)) return failMusic('source');
  if (value.length > MUSIC_LIMITS.sourceItems) return failMusic('budget');
  return copy(value, 0) as unknown[];
}
function text(value: unknown, maximum: number): string {
  const simple = field(value, 'simpleText'),
    runs = list(field(value, 'runs'));
  const result =
    typeof simple === 'string'
      ? simple
      : runs?.every((r) => typeof field(r, 'text') === 'string')
        ? runs.map((r) => field(r, 'text') as string).join('')
        : undefined;
  if (
    typeof result !== 'string' ||
    !result.trim() ||
    Array.from(result).length > maximum ||
    Array.from(result).some(
      (c) =>
        c.charCodeAt(0) < 32 ||
        c.charCodeAt(0) === 127 ||
        (c.length === 1 &&
          c.charCodeAt(0) >= 0xd800 &&
          c.charCodeAt(0) <= 0xdfff),
    )
  )
    return failMusic('source');
  return result;
}
function normalize(rows: unknown[]): MusicItem[] {
  return rows.map((raw) => {
    const row = renderer(raw);
    if (!row) return failMusic('unsupported');
    if (!isVideoId(row.videoId)) return failMusic('source');
    const title = text(row.title, 512),
      byline = row.shortBylineText ?? row.longBylineText;
    const artists: MusicItem['artists'] = [];
    if (byline !== undefined) {
      text(byline, 256);
      for (const run of list(field(byline, 'runs')) ?? []) {
        const id = field(
          field(field(run, 'navigationEndpoint'), 'browseEndpoint'),
          'browseId',
        );
        if (typeof id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(id))
          artists.push({
            name: text({ simpleText: field(run, 'text') }, 256),
            id,
          });
      }
      if (!artists.length) artists.push({ name: text(byline, 256) });
      if (artists.length > 8) return failMusic('source');
    }
    let durationSeconds: number | null = null;
    if (row.lengthText !== undefined) {
      const duration = text(row.lengthText, 32);
      if (!/^\d{1,6}:[0-5]\d(?::[0-5]\d)?$/.test(duration))
        return failMusic('source');
      durationSeconds = duration.split(':').reduce((n, part) => {
        const minutes = n * 60;
        return minutes + Number(part);
      }, 0);
    }
    const nativeType =
      row.musicVideoType ??
      field(
        field(
          field(
            field(row.navigationEndpoint, 'watchEndpoint'),
            'watchEndpointMusicSupportedConfigs',
          ),
          'watchEndpointMusicConfig',
        ),
        'musicVideoType',
      );
    const item: MusicItem = {
      kind: nativeType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : 'video',
      id: row.videoId,
      title,
      artists,
      durationSeconds,
    };
    const rawThumbnails = field(row.thumbnail, 'thumbnails');
    if (rawThumbnails !== undefined) {
      const thumbnails = list(rawThumbnails);
      if (!thumbnails?.length) return failMusic('source');
      const value = field(thumbnails[thumbnails.length - 1], 'url');
      if (typeof value !== 'string' || utf8Bytes(value) > 2048)
        return failMusic('source');
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password)
          return failMusic('source');
      } catch {
        return failMusic('source');
      }
      item.thumbnailUrl = value;
    }
    return item;
  });
}
/** One document/API/store owner; every callout has a trailing scalar/data-link fence. */
export function createMusicQueueOwner(
  api: MusicPlayer,
  getApi: () => MusicPlayer | null,
  document: Document,
) {
  let disposed = false,
    reading = false,
    observing = false,
    binding: Binding | undefined,
    release: (() => void) | undefined,
    fingerprint: string | undefined,
    observed: Structure | undefined,
    queueRevision = revision(),
    changedDuringRead = false;
  const scalarFence = () => {
    if (disposed || changedDuringRead) return failMusic('retired');
  };
  const callout = <T>(action: () => T): T => {
    scalarFence();
    let value: T;
    try {
      value = action();
    } catch (error) {
      scalarFence();
      throw error;
    }
    scalarFence();
    return value;
  };
  // Captured DOM intrinsics bypass page-owned property overrides in the final fence.
  const view = document.defaultView;
  if (!view) return failMusic('unavailable');
  const intrinsicDescriptor = (prototype: object, key: string) => {
    let owner: object | null = prototype;
    for (let depth = 0; owner && depth < MUSIC_LIMITS.sourceDepth; depth++) {
      const descriptor = callout(() =>
        Object.getOwnPropertyDescriptor(owner!, key),
      );
      if (descriptor) return descriptor;
      owner = callout(() => Object.getPrototypeOf(owner!) as object | null);
    }
    if (owner) return failMusic('budget');
    return undefined;
  };
  const queryValue = intrinsicDescriptor(
    view.Document.prototype,
    'querySelector',
  )?.value as unknown;
  const containsValue = intrinsicDescriptor(view.Node.prototype, 'contains')
    ?.value as unknown;
  const connectedDescriptor = intrinsicDescriptor(
    view.Node.prototype,
    'isConnected',
  );
  const connectedValue =
    connectedDescriptor &&
    callout(() => Reflect.get(connectedDescriptor, 'get') as unknown);
  const recordsValue = intrinsicDescriptor(
    view.MutationObserver.prototype,
    'takeRecords',
  )?.value as unknown;
  if (
    typeof queryValue !== 'function' ||
    typeof containsValue !== 'function' ||
    typeof connectedValue !== 'function' ||
    typeof recordsValue !== 'function'
  )
    return failMusic('unavailable');
  const query = queryValue as (
    this: Document,
    selector: string,
  ) => Element | null;
  const contains = containsValue as (this: Node, node: Node) => boolean;
  const connected = connectedValue as (this: Node) => boolean;
  const takeRecords = recordsValue as (
    this: MutationObserver,
  ) => MutationRecord[];
  const rotate = () => {
    queueRevision = revision();
    fingerprint = undefined;
    observed = undefined;
  };
  const lookup = (target: object, key: string): PropertyFence => {
    let owner: object | null = target;
    for (let depth = 0; owner && depth < MUSIC_LIMITS.sourceDepth; depth++) {
      const descriptor = callout(() =>
        Object.getOwnPropertyDescriptor(owner!, key),
      );
      if (descriptor) return { target, key, owner, descriptor };
      owner = callout(() => Object.getPrototypeOf(owner!) as object | null);
    }
    if (owner) return failMusic('budget');
    return { target, key };
  };
  const equalDescriptor = (a: PropertyFence, b: PropertyFence) =>
    a.target === b.target &&
    a.key === b.key &&
    a.owner === b.owner &&
    a.descriptor?.get === b.descriptor?.get &&
    a.descriptor?.set === b.descriptor?.set &&
    (a.descriptor?.value as unknown) === (b.descriptor?.value as unknown) &&
    a.descriptor?.writable === b.descriptor?.writable &&
    a.descriptor?.enumerable === b.descriptor?.enumerable &&
    a.descriptor?.configurable === b.descriptor?.configurable;
  const dataValue = (target: object, key: string): unknown => {
    const fence = lookup(target, key);
    if (!fence.descriptor || !('value' in fence.descriptor))
      return failMusic('unsupported');
    return fence.descriptor.value as unknown;
  };
  const readProperty = (target: object, key: string) => {
    const fence = lookup(target, key);
    const value = callout(() => Reflect.get(target, key) as unknown);
    return { fence, value };
  };
  const inspect = (records: MutationRecord[]) => {
    const element = binding?.element;
    if (!element) return;
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node === element || callout(() => contains.call(node, element))) {
          rotate();
          if (reading) changedDuringRead = true;
          return;
        }
      }
    }
  };
  const observer = new view.MutationObserver((records) => {
    try {
      inspect(records);
    } catch {
      if (!disposed) rotate();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  const nonCallingFence = (b: Binding) => {
    // Leaf-to-root descriptor checks invoke no ordinary getters. Proxy reflection
    // remains a callout: scalarFence runs after each trap. Hidden Proxy/accessor
    // state is not claimed to be an atomic observable native layout.
    for (const fence of b.fences)
      if (!equalDescriptor(fence, lookup(fence.target, fence.key)))
        return failMusic('retired');
    const element = callout(() => query.call(document, '#queue'));
    if (b.apiNode && !callout(() => connected.call(b.apiNode!)))
      return failMusic('retired');
    const live = callout(() => connected.call(b.element));
    inspect(callout(() => takeRecords.call(observer)));
    if (element !== b.element || !live) return failMusic('retired');
    scalarFence();
  };
  const capture = (): Binding => {
    if (callout(getApi) !== api) return failMusic('retired');
    const apiConnection = readProperty(api, 'isConnected');
    if (apiConnection.value === false) return failMusic('retired');
    // A real Node has native connectivity independent of its stable getter
    // descriptor. Recheck that intrinsic in the final fence as well.
    let apiNode: Node | undefined;
    try {
      const live: unknown = callout(() =>
        connected.call(api as unknown as Node),
      );
      if (typeof live === 'boolean') {
        if (!live) return failMusic('retired');
        apiNode = api as unknown as Node;
      }
    } catch (error) {
      scalarFence();
      // Plain native API interfaces have no Node brand; their optional data
      // connection flag remains covered by the descriptor fence.
      if (!(error instanceof TypeError)) throw error;
    }
    const element = callout(() => query.call(document, '#queue'));
    if (!element || !callout(() => connected.call(element)))
      return failMusic('unavailable');
    const root = readProperty(element, 'queue'),
      queue = record(root.value);
    if (!queue) return failMusic('unavailable');
    const rootFences: PropertyFence[] = [];
    if (root.fence.descriptor && !('value' in root.fence.descriptor)) {
      // Real public YTMUSIC-PLAYER-QUEUE exposes queue through an accessor,
      // backed by own data-valued element.inst -> inst.queue (verified ref-equal).
      const instFence = lookup(element, 'inst');
      if (!instFence.descriptor || !('value' in instFence.descriptor))
        return failMusic('unsupported');
      const inst = record(instFence.descriptor.value as unknown);
      if (!inst) return failMusic('unsupported');
      const queueFence = lookup(inst, 'queue');
      if (!queueFence.descriptor || !('value' in queueFence.descriptor))
        return failMusic('unsupported');
      if ((queueFence.descriptor.value as unknown) !== queue)
        return failMusic('retired');
      rootFences.push(queueFence, instFence);
    }
    const holderSlot = readProperty(queue, 'store'),
      holder = record(holderSlot.value);
    if (
      !holder ||
      !holderSlot.fence.descriptor ||
      !('value' in holderSlot.fence.descriptor)
    )
      return failMusic('unavailable');
    const storeSlot = readProperty(holder, 'store'),
      store = record(storeSlot.value);
    if (
      !store ||
      !storeSlot.fence.descriptor ||
      !('value' in storeSlot.fence.descriptor)
    )
      return failMusic('unavailable');
    const itemsSlot = readProperty(queue, 'getItems'),
      stateSlot = readProperty(store, 'getState'),
      subscribeSlot = readProperty(store, 'subscribe');
    if (
      typeof itemsSlot.value !== 'function' ||
      typeof stateSlot.value !== 'function' ||
      typeof subscribeSlot.value !== 'function'
    )
      return failMusic('unavailable');
    const next: Binding = {
      element,
      ...(apiNode ? { apiNode } : {}),
      queue,
      holder,
      store,
      getItems: itemsSlot.value as Binding['getItems'],
      getState: stateSlot.value as Binding['getState'],
      subscribe: subscribeSlot.value as Binding['subscribe'],
      fences: [
        apiConnection.fence,
        itemsSlot.fence,
        stateSlot.fence,
        subscribeSlot.fence,
        storeSlot.fence,
        holderSlot.fence,
        ...rootFences,
        root.fence,
      ],
    };
    nonCallingFence(next);
    return next;
  };
  const sameCore = (a: Binding, b: Binding) =>
    a.element === b.element &&
    a.apiNode === b.apiNode &&
    a.queue === b.queue &&
    a.holder === b.holder &&
    a.store === b.store &&
    a.getItems === b.getItems &&
    a.getState === b.getState &&
    a.subscribe === b.subscribe;
  const same = (a: Binding, b: Binding) =>
    sameCore(a, b) &&
    a.fences.length === b.fences.length &&
    a.fences.every((fence, index) => equalDescriptor(fence, b.fences[index]));
  const check = (b: Binding) => {
    inspect(callout(() => takeRecords.call(observer)));
    if (!same(b, capture())) return failMusic('retired');
    nonCallingFence(b);
    scalarFence();
  };
  // Structural observation never calls getItems, copies payloads, normalizes,
  // or serializes a projection. Ordered identities are necessary for notified
  // in-place reordering of duplicates in the same native items array.
  const structure = (stateQueue: Data): Structure => {
    const rows = dataValue(stateQueue, 'items');
    if (!Array.isArray(rows)) return failMusic('unsupported');
    const length = dataValue(rows, 'length');
    if (typeof length !== 'number' || length > MUSIC_LIMITS.sourceItems)
      return failMusic('budget');
    const selectedFence = lookup(stateQueue, 'selectedItemIndex');
    if (selectedFence.descriptor && !('value' in selectedFence.descriptor))
      return failMusic('unsupported');
    const selected = selectedFence.descriptor?.value as unknown;
    const slots: StructuralSlot[] = [];
    for (let index = 0; index < length; index++) {
      const row = dataValue(rows, String(index)),
        direct = record(row);
      if (!direct) return failMusic('unsupported');
      const directFence = lookup(direct, 'playlistPanelVideoRenderer');
      let panel: Data | undefined;
      if (directFence.descriptor) {
        if (!('value' in directFence.descriptor))
          return failMusic('unsupported');
        panel = record(directFence.descriptor.value as unknown);
      } else {
        const wrapper = record(
          dataValue(direct, 'playlistPanelVideoWrapperRenderer'),
        );
        const primary =
          wrapper && record(dataValue(wrapper, 'primaryRenderer'));
        panel =
          primary && record(dataValue(primary, 'playlistPanelVideoRenderer'));
      }
      if (!panel) return failMusic('unsupported');
      const selectedSlot = lookup(panel, 'selected');
      if (selectedSlot.descriptor && !('value' in selectedSlot.descriptor))
        return failMusic('unsupported');
      slots.push({
        row,
        renderer: panel,
        videoId: dataValue(panel, 'videoId'),
        selected: selectedSlot.descriptor?.value as unknown,
      });
    }
    return { selected, slots };
  };
  const sameStructure = (a: Structure | undefined, b: Structure) =>
    !!a &&
    a.selected === b.selected &&
    a.slots.length === b.slots.length &&
    a.slots.every(
      (slot, index) =>
        slot.row === b.slots[index].row &&
        slot.renderer === b.slots[index].renderer &&
        slot.videoId === b.slots[index].videoId &&
        slot.selected === b.slots[index].selected,
    );
  const observeStructure = (b: Binding): Structure => {
    nonCallingFence(b);
    const state = callout(() => b.getState.call(b.store));
    const stateRecord = record(state),
      stateQueue = stateRecord && record(dataValue(stateRecord, 'queue'));
    if (!stateQueue) return failMusic('unsupported');
    const next = structure(stateQueue);
    nonCallingFence(b);
    return next;
  };
  const read = (b: Binding) => {
    const state = callout(() => b.getState.call(b.store));
    check(b);
    const stateQueue = record(callout(() => field(state, 'queue')));
    check(b);
    if (!stateQueue) return failMusic('source');
    const selected = callout(() => stateQueue.selectedItemIndex);
    check(b);
    const stateRows = callout(() => stateQueue.items);
    check(b);
    const rows = callout(() => b.getItems.call(b.queue));
    check(b);
    const copied = callout(() => copyRows(rows));
    check(b);
    const items = normalize(copied);
    check(b);
    if (
      stateRows !== undefined &&
      JSON.stringify(normalize(callout(() => copyRows(stateRows)))) !==
        JSON.stringify(items)
    )
      return failMusic('retired');
    check(b);
    const finalState = callout(() => b.getState.call(b.store));
    check(b);
    const finalQueue = record(callout(() => field(finalState, 'queue')));
    check(b);
    if (
      !finalQueue ||
      callout(() => finalQueue.selectedItemIndex) !== selected ||
      (callout(() => finalQueue.items) !== undefined &&
        JSON.stringify(normalize(callout(() => copyRows(finalQueue.items)))) !==
          JSON.stringify(items))
    )
      return failMusic('retired');
    check(b);
    let selectedIndex: number | null = null;
    if (selected !== undefined && selected !== null && selected !== -1) {
      if (
        typeof selected !== 'number' ||
        !Number.isInteger(selected) ||
        selected < 0 ||
        selected >= items.length
      )
        return failMusic('source');
      selectedIndex = selected;
    } else if (selected === undefined) {
      const selections = copied.flatMap((raw, index) =>
        renderer(raw)?.selected === true ? [index] : [],
      );
      if (selections.length > 1) return failMusic('source');
      selectedIndex = selections[0] ?? null;
    }
    return {
      value: { items, selectedIndex },
      structure: structure(finalQueue),
    };
  };
  const snapshot = (): NativeQueueSnapshot => {
    if (reading || observing) {
      changedDuringRead = true;
      rotate();
      return failMusic('retired');
    }
    reading = true;
    changedDuringRead = false;
    try {
      inspect(callout(() => takeRecords.call(observer)));
      let next = capture();
      if (binding && sameCore(binding, next)) {
        if (!same(binding, next)) {
          // A validated descriptor-only change retires the revision, but the
          // same native store/method lifetime keeps its existing subscription.
          rotate();
          binding.fences = next.fences;
        }
        next = binding;
      }
      if (!binding || !sameCore(binding, next)) {
        const oldRelease = release;
        release = undefined;
        binding = next;
        rotate();
        if (oldRelease) callout(oldRelease);
        check(next);
        const subscribed = next;
        const unsub = subscribed.subscribe.call(subscribed.store, () => {
          if (disposed || binding !== subscribed) return;
          if (reading || observing) {
            changedDuringRead = true;
            rotate();
            return;
          }
          observing = true;
          changedDuringRead = false;
          try {
            const current = observeStructure(subscribed);
            if (!sameStructure(observed, current)) rotate();
            scalarFence();
            observed = current;
          } catch {
            if (!disposed && binding === subscribed) rotate();
          } finally {
            observing = false;
          }
        });
        if (typeof unsub !== 'function') return failMusic('unavailable');
        if (disposed || binding !== subscribed) {
          try {
            (unsub as () => void)();
          } catch {
            /* Retired registration. */
          }
          return failMusic('retired');
        }
        // Record the release before the trailing fence, including a synchronous
        // callback that invalidated this read; the catch path then owns cleanup.
        release = unsub as () => void;
        scalarFence();
        check(next);
      }
      const sampled = read(next),
        nextFingerprint = JSON.stringify(sampled.value);
      if (fingerprint !== undefined && fingerprint !== nextFingerprint)
        queueRevision = revision();
      const result: NativeQueueSnapshot = {
        version: 1,
        queueRevision,
        ...sampled.value,
      };
      if (utf8Bytes(JSON.stringify(result)) > MUSIC_LIMITS.nativeBytes)
        return failMusic('budget');
      check(next);
      // No ordinary getter/native callout follows this final scalar/data fence.
      scalarFence();
      fingerprint = nextFingerprint;
      observed = sampled.structure;
      return result;
    } catch (error) {
      rotate();
      const unsub = release;
      release = undefined;
      binding = undefined;
      try {
        unsub?.();
      } catch {
        /* The retired store owns no further reads. */
      }
      throw error;
    } finally {
      reading = false;
    }
  };
  return {
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      rotate();
      observer.disconnect();
      const unsub = release;
      release = undefined;
      binding = undefined;
      unsub?.();
    },
  };
}
