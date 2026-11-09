import { getPlaybackOwner, nativePlaybackIdentity } from './playback-owner';
import { isVideoId } from './queue-playlist';

import type { MusicPlayer } from '@/types/music-player';

type Slot = { row: object; renderer: object; videoId: string };
type Facts = {
  bar: Element;
  queue: Element;
  store: object;
  context: unknown;
  slots: Slot[];
  index: number;
  videoId: string;
  media: HTMLVideoElement;
  mediaGeneration: number;
  mediaReady: boolean;
  metadataReady: boolean;
};
type Ticket = Readonly<{ arm(): void; cancel(): void }>;
export type PlaybackNavigation = ReturnType<typeof createPlaybackNavigation>;
const WAIT_MS = 2000;
const MAX_ITEMS = 1000;
const object = (value: unknown): value is object =>
  !!value && typeof value === 'object';

/** #4567 (@h0tp-ftw): explicit intent replaces inferred index direction.
 * Passive core capability: never adopts a player or dispatches playback.
 */
export function createPlaybackNavigation(
  api: MusicPlayer,
  current: () => boolean,
  doc: Document = document,
) {
  const view = doc.defaultView!;
  const root = Object.getOwnPropertyDescriptor(
    view.Node.prototype,
    'getRootNode',
  )!.value as (this: Node, options?: GetRootNodeOptions) => Node;
  const attribute = Object.getOwnPropertyDescriptor(
    view.Element.prototype,
    'getAttribute',
  )!.value as (this: Element, name: string) => string | null;
  const now = view.performance.now.bind(view.performance);
  let disposed = false,
    sampling = false,
    revision = 0,
    serial = 0,
    mediaGeneration = 0;
  let pending:
    | {
        source: Facts;
        target?: Slot;
        command: number;
        deadline: number;
        awaitingReady?: boolean;
        provisional?: { stage: 'provisional'; facts: Facts; policy?: symbol };
      }
    | undefined;
  let arrival:
    | { stage: 'settled'; facts: Facts; command: number; policy?: symbol }
    | undefined;
  const cancel = () => {
    revision++;
    pending = undefined;
    arrival = undefined;
  };
  const interrupt = () => {
    revision++;
    pending = undefined;
  };
  const alive = () =>
    !disposed &&
    current() &&
    !disposed &&
    Reflect.apply(root, api, [{ composed: true }]) === doc;
  const sameOrder = (a: Facts, b: Facts) =>
    a.bar === b.bar &&
    a.queue === b.queue &&
    a.store === b.store &&
    a.context === b.context &&
    a.slots.length === b.slots.length &&
    a.slots.every(
      (slot, index) =>
        slot.row === b.slots[index].row &&
        slot.renderer === b.slots[index].renderer &&
        slot.videoId === b.slots[index].videoId,
    );
  const sameOccurrence = (a: Facts, b: Facts) =>
    sameOrder(a, b) &&
    a.index === b.index &&
    a.videoId === b.videoId &&
    a.media === b.media &&
    a.mediaGeneration === b.mediaGeneration;
  const sameSlot = (a: Facts, b: Facts) =>
    sameOrder(a, b) &&
    a.index === b.index &&
    a.videoId === b.videoId &&
    a.media === b.media;

  const sample = (): Facts | null => {
    if (sampling) {
      cancel();
      return null;
    }
    sampling = true;
    const captured = revision;
    const fences: (() => boolean)[] = [];
    const check = () => {
      if (!alive() || captured !== revision) throw Error('Retired navigation');
    };
    // Data-only fields and native methods may live on a provider prototype.
    const data = (target: unknown, key: string, optional = false): unknown => {
      if (!object(target)) throw Error('Unsupported navigation source');
      let holder: object | null = target;
      const absent: object[] = [];
      const links: { node: object; prototype: object | null }[] = [];
      const sameLinks = () =>
        links.every(
          ({ node, prototype }) => Object.getPrototypeOf(node) === prototype,
        );
      for (let depth = 0; holder && depth < 16; depth++) {
        const descriptor = Object.getOwnPropertyDescriptor(holder, key);
        check();
        if (descriptor) {
          if (!('value' in descriptor)) throw Error('Navigation accessor');
          const receiver = holder;
          fences.push(() => {
            const fresh = Object.getOwnPropertyDescriptor(receiver, key);
            return (
              !!fresh &&
              'value' in fresh &&
              fresh.value === descriptor.value &&
              absent.every(
                (node) => !Object.getOwnPropertyDescriptor(node, key),
              ) &&
              sameLinks()
            );
          });
          return descriptor.value as unknown;
        }
        absent.push(holder);
        const prototype = Object.getPrototypeOf(holder) as object | null;
        check();
        links.push({ node: holder, prototype });
        holder = prototype;
      }
      if (holder) throw Error('Unsupported navigation depth');
      if (!optional) throw Error('Missing navigation field');
      fences.push(
        () =>
          absent.every((node) => !Object.getOwnPropertyDescriptor(node, key)) &&
          sameLinks(),
      );
      return undefined;
    };
    const call = (target: unknown, key: string) => {
      const method = data(target, key);
      if (typeof method !== 'function')
        throw Error('Missing navigation method');
      const result: unknown = Reflect.apply(method, target, []);
      check();
      return result;
    };
    const configRecord = (value: unknown): value is object => {
      if (!object(value) || Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value) as object | null;
      check();
      if (prototype !== null && prototype !== Object.prototype) return false;
      fences.push(() => Object.getPrototypeOf(value) === prototype);
      return true;
    };
    let confirmQueueAccessor: (() => void) | undefined;
    const nativeQueueFor = (element: Element): unknown => {
      const links: {
        target: object;
        descriptor?: PropertyDescriptor;
        prototype: object | null;
      }[] = [];
      let holder: object | null = element,
        descriptor: PropertyDescriptor | undefined;
      for (let depth = 0; holder && depth < 16; depth++) {
        descriptor = Object.getOwnPropertyDescriptor(holder, 'queue');
        check();
        const prototype = Object.getPrototypeOf(holder) as object | null;
        check();
        links.push({ target: holder, descriptor, prototype });
        if (descriptor) break;
        holder = prototype;
      }
      if (!descriptor || 'value' in descriptor) return data(element, 'queue');
      // Match the public YTM queue accessor already supported by music-queue:
      // only own data-valued element.inst -> inst.queue, ref-equal to its getter.
      const instDescriptor = Object.getOwnPropertyDescriptor(element, 'inst');
      check();
      if (
        !instDescriptor ||
        !('value' in instDescriptor) ||
        !object(instDescriptor.value) ||
        Array.isArray(instDescriptor.value)
      )
        throw Error('Unsupported queue accessor backing');
      const inst = instDescriptor.value;
      const queueDescriptor = Object.getOwnPropertyDescriptor(inst, 'queue');
      check();
      if (
        !queueDescriptor ||
        !('value' in queueDescriptor) ||
        !object(queueDescriptor.value) ||
        Array.isArray(queueDescriptor.value) ||
        typeof descriptor.get !== 'function'
      )
        throw Error('Unsupported queue accessor backing');
      const nativeQueue = queueDescriptor.value;
      const equal = (
        a: PropertyDescriptor | undefined,
        b: PropertyDescriptor | undefined,
      ) =>
        !!a === !!b &&
        (!a ||
          !b ||
          (a.value === b.value &&
            a.get === b.get &&
            a.set === b.set &&
            a.writable === b.writable &&
            a.enumerable === b.enumerable &&
            a.configurable === b.configurable));
      const fence = () => {
        check();
        if (
          !equal(
            Object.getOwnPropertyDescriptor(inst, 'queue'),
            queueDescriptor,
          )
        )
          throw Error('Retired queue backing');
        check();
        if (
          !equal(
            Object.getOwnPropertyDescriptor(element, 'inst'),
            instDescriptor,
          )
        )
          throw Error('Retired queue instance');
        check();
        for (const link of [...links].reverse()) {
          if (
            !equal(
              Object.getOwnPropertyDescriptor(link.target, 'queue'),
              link.descriptor,
            )
          )
            throw Error('Retired queue accessor');
          check();
          if (Object.getPrototypeOf(link.target) !== link.prototype)
            throw Error('Retired queue prototype');
          check();
        }
        if (
          doc.querySelector('#queue') !== element ||
          Reflect.apply(root, element, [{ composed: true }]) !== doc
        )
          throw Error('Retired queue element');
        check();
      };
      confirmQueueAccessor = () => {
        fence();
        const value: unknown = Reflect.get(element, 'queue');
        check();
        fence();
        if (value !== nativeQueue) throw Error('Inconsistent queue accessor');
      };
      fences.push(() => {
        fence();
        return true;
      });
      confirmQueueAccessor();
      return nativeQueue;
    };
    const rows = (value: unknown): Slot[] => {
      if (!Array.isArray(value)) throw Error('Unsupported navigation queue');
      const length = data(value, 'length');
      if (
        typeof length !== 'number' ||
        !Number.isInteger(length) ||
        length < 0 ||
        length > MAX_ITEMS
      )
        throw Error('Unsupported navigation queue length');
      const slots: Slot[] = [];
      for (let index = 0; index < length; index++) {
        const row = data(value, String(index));
        const direct = data(row, 'playlistPanelVideoRenderer', true);
        const wrapper = direct
          ? undefined
          : data(row, 'playlistPanelVideoWrapperRenderer');
        const renderer =
          direct ??
          data(data(wrapper, 'primaryRenderer'), 'playlistPanelVideoRenderer');
        const videoId = data(renderer, 'videoId');
        if (!object(row) || !object(renderer) || !isVideoId(videoId))
          throw Error('Unsupported navigation slot');
        slots.push({ row, renderer, videoId });
      }
      return slots;
    };
    try {
      check();
      const bar = doc.querySelector('ytmusic-player-bar');
      const queue = doc.querySelector('#queue');
      const media = doc.querySelector('video');
      if (!bar || !queue || !media) throw Error('Missing navigation surface');
      const nativeQueue = nativeQueueFor(queue);
      const store = data(data(nativeQueue, 'store'), 'store');
      const state = call(store, 'getState');
      const stateQueue = data(state, 'queue');
      const barState = call(bar, 'getState');
      const barQueue = data(barState, 'queue');
      const index = data(stateQueue, 'selectedItemIndex');
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        data(barQueue, 'selectedItemIndex') !== index
      )
        throw Error('Unknown navigation selection');
      const slots = rows(data(stateQueue, 'items'));
      const barSlots = rows(data(barQueue, 'items'));
      const nativeSlots = rows(call(nativeQueue, 'getItems'));
      if (
        index >= slots.length ||
        [barSlots, nativeSlots].some(
          (other) =>
            other.length !== slots.length ||
            other.some(
              (slot, i) =>
                slot.row !== slots[i].row ||
                slot.renderer !== slots[i].renderer ||
                slot.videoId !== slots[i].videoId,
            ),
        )
      )
        throw Error('Inconsistent navigation queue');
      const cast = data(state, 'castStatus');
      if (!object(cast) || data(cast, 'remoteWatchEndpoint', true) != null)
        throw Error('Remote navigation');
      // Raw config omits disabled entries (config/defaults.ts: plugins: {}).
      // Music Together's declared default is enabled:false; missing source or a
      // malformed stored entry is different from this verified default.
      const requireLocalPlayback = () => {
        const plugins: unknown = view.mainConfig?.get('plugins');
        if (!configRecord(plugins))
          throw Error('Unknown shared-playback configuration');
        const shared = data(plugins, 'music-together', true);
        if (shared !== undefined && !configRecord(shared))
          throw Error('Unknown shared-playback entry');
        const sharedEnabled =
          shared === undefined ? false : data(shared, 'enabled', true);
        if (sharedEnabled !== undefined && sharedEnabled !== false)
          throw Error('Unowned navigation playback');
      };
      const requireNoAd = () => {
        const classes: unknown = Reflect.apply(attribute, api, ['class']);
        if (classes !== null && typeof classes !== 'string')
          throw Error('Unknown player class');
        if (/(?:^|\s)ad-(?:showing|interrupting)(?:\s|$)/.test(classes ?? ''))
          throw Error('Unowned navigation playback');
      };
      requireLocalPlayback();
      requireNoAd();
      check();
      const videoId = nativePlaybackIdentity(api);
      check();
      // Transitional identity/readiness can settle during the bounded wait.
      if (!videoId) return null;
      if (videoId !== slots[index].videoId || api.getPlaylistIndex() !== index)
        return null;
      check();
      const owner = getPlaybackOwner(api);
      const binding = owner?.binding(videoId);
      check();
      if (!binding || !owner?.binding(videoId, binding)) return null;
      const context = data(stateQueue, 'queueContextParams', true);
      if (
        context !== undefined &&
        (typeof context !== 'string' || context.length > 4096)
      )
        throw Error('Unknown queue context');
      // Refence callouts against source identity and all captured data/methods.
      const trailingSlots = rows(call(nativeQueue, 'getItems'));
      confirmQueueAccessor?.();
      if (
        doc.querySelector('ytmusic-player-bar') !== bar ||
        doc.querySelector('#queue') !== queue ||
        doc.querySelector('video') !== media ||
        data(call(bar, 'getState'), 'queue') !== barQueue ||
        trailingSlots.length !== slots.length ||
        trailingSlots.some(
          (slot, i) =>
            slot.row !== slots[i].row ||
            slot.renderer !== slots[i].renderer ||
            slot.videoId !== slots[i].videoId,
        ) ||
        api.getPlaylistIndex() !== index ||
        !owner.binding(videoId, binding)
      )
        throw Error('Retired navigation sample');
      // The final identity binding invokes provider getters too. Resolve the
      // current store after it, before the trusted config/data-only checks.
      const trailingState = call(store, 'getState');
      if (data(trailingState, 'queue') !== stateQueue)
        throw Error('Retired navigation sample');
      // The config bridge may return copies. Validate current policy values,
      // then captured data paths, after the last native provider callback.
      requireLocalPlayback();
      const trailingCast = data(trailingState, 'castStatus');
      if (
        !object(trailingCast) ||
        data(trailingCast, 'remoteWatchEndpoint', true) != null
      )
        throw Error('Remote navigation');
      if (fences.some((fence) => !fence()))
        throw Error('Retired navigation sample');
      requireNoAd();
      // Provider callbacks can change readiness without a media notification.
      // Observe settled/provisional readiness only after those callbacks finish.
      const metadataReady = media.readyState >= 1;
      const result: Facts = {
        bar,
        queue,
        store: store as object,
        context,
        slots,
        index,
        videoId,
        media,
        mediaGeneration,
        mediaReady: metadataReady && !media.seeking,
        metadataReady,
      };
      check();
      return result;
    } catch {
      cancel();
      return null;
    } finally {
      sampling = false;
    }
  };

  const observe = (): Facts | null => {
    const facts = sample();
    if (!facts) {
      arrival = undefined;
      return null;
    }
    if (arrival && (!sameOccurrence(arrival.facts, facts) || !facts.mediaReady))
      arrival = undefined;
    if (pending) {
      const intent = pending;
      if (
        now() > intent.deadline ||
        !sameOrder(intent.source, facts) ||
        facts.media !== intent.source.media
      ) {
        cancel();
      } else if (
        facts.index !== intent.source.index ||
        facts.videoId !== intent.source.videoId
      ) {
        if (
          (intent.target &&
            !(
              facts.slots[facts.index].row === intent.target.row &&
              facts.slots[facts.index].renderer === intent.target.renderer &&
              facts.videoId === intent.target.videoId
            )) ||
          (intent.provisional && !sameSlot(intent.provisional.facts, facts))
        )
          cancel();
        else {
          intent.provisional = {
            stage: 'provisional',
            facts,
            policy: intent.provisional?.policy,
          };
          if (facts.mediaReady && !intent.awaitingReady) {
            pending = undefined;
            arrival = {
              stage: 'settled',
              facts,
              command: intent.command,
              policy: intent.provisional.policy,
            };
          }
        }
      } else if (facts.mediaGeneration !== intent.source.mediaGeneration) {
        cancel();
      }
    }
    return facts;
  };
  const prepare = (target?: Slot): Ticket | undefined => {
    cancel();
    const source = sample();
    // A fresh explicit second Previous can supersede a known source restart
    // while its native seek is still finishing; its metadata/queue must agree.
    if (!source?.metadataReady) return;
    const captured = revision;
    const command = ++serial;
    const deadline = now() + WAIT_MS;
    let used = false;
    return Object.freeze({
      // Deliberately scalar-only: brokers call this after their final native fence.
      arm() {
        if (used || disposed || captured !== revision) return;
        used = true;
        pending = { source, target, command, deadline };
      },
      cancel() {
        used = true;
        if (pending?.command === command || arrival?.command === command)
          cancel();
      },
    });
  };
  const onData = (name: string) => {
    if (!pending && !arrival) return;
    const source = pending?.source;
    const facts = observe();
    if (
      name === 'dataloaded' &&
      pending &&
      source &&
      facts &&
      sameOccurrence(source, facts)
    )
      cancel();
  };
  const onMedia = (event: Event) => {
    if (event.target !== doc.querySelector('video')) return;
    if (event.type === 'emptied') {
      mediaGeneration++;
      // A pending command can legitimately empty the same media before arrival.
      arrival = undefined;
      if (pending) pending.awaitingReady = true;
    } else if (event.type === 'ended') cancel();
    else if (event.type === 'seeking') {
      if (arrival) {
        cancel();
        return;
      }
      // Previous may restart the current song instead of selecting another item.
      if (pending) {
        pending.awaitingReady = true;
        const facts = sample();
        if (pending && facts && sameSlot(pending.source, facts)) cancel();
        else if (pending) observe();
      }
    } else if (pending || arrival) {
      if (pending) pending.awaitingReady = false;
      observe();
    }
  };
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const path = event.composedPath();
    const previous = path.find(
      (node) =>
        node instanceof view.Element &&
        node.matches('.previous-button.ytmusic-player-bar'),
    );
    if (previous) {
      interrupt();
      if (
        doc.querySelector('.previous-button.ytmusic-player-bar') === previous &&
        !(previous as Element).matches(':disabled,[aria-disabled="true"]')
      )
        prepare()?.arm();
      return;
    }
    const row = path.find(
      (node) =>
        node instanceof view.Element &&
        node.matches('ytmusic-playlist-panel-video-renderer'),
    );
    if (
      row instanceof view.Element &&
      doc.querySelector('#queue')?.contains(row)
    ) {
      // Menus/remove/rating controls are not a queue selection gesture.
      if (
        path.some(
          (node) =>
            node instanceof view.Element &&
            node !== row &&
            node.matches(
              'button,ytmusic-menu-renderer,[role="button"],input,a,[role="link"]',
            ),
        )
      ) {
        interrupt();
        return;
      }
      const facts = sample();
      const value = Object.getOwnPropertyDescriptor(row, 'data');
      if (!facts || !value || !('value' in value)) {
        interrupt();
        return;
      }
      const index = facts.slots.findIndex(
        (slot) => slot.renderer === value.value,
      );
      if (index >= 0 && index < facts.index) prepare(facts.slots[index])?.arm();
      else interrupt();
      return;
    }
    // Other trusted control/navigation gestures cannot donate a pending Previous.
    interrupt();
  };
  const onKey = (event: KeyboardEvent) => {
    if (
      !event.isTrusted ||
      ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)
    )
      return;
    interrupt();
    if (
      event.repeat ||
      event.defaultPrevented ||
      doc.querySelector('dialog[open],[role="dialog"][aria-modal="true"]') ||
      event
        .composedPath()
        .some(
          (node) =>
            node instanceof view.Element &&
            node.matches(
              'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]',
            ),
        )
    )
      return;
    try {
      if (doc.hasFocus() !== true || doc.visibilityState !== 'visible') return;
    } catch {
      return;
    }
    // Current native help verified by the UI-only operator receipt advertises
    // Previous k/Shift+P and Next j/Shift+N. Observe their effect; never dispatch
    // another command or require an unobserved legacy control/aria attribute.
    const key = event.key.toLowerCase();
    const unmodified = !event.ctrlKey && !event.altKey && !event.metaKey;
    if (
      unmodified &&
      ((!event.shiftKey && key === 'j') || (event.shiftKey && key === 'n'))
    ) {
      cancel();
      return;
    }
    if (
      unmodified &&
      ((!event.shiftKey && key === 'k') || (event.shiftKey && key === 'p'))
    ) {
      prepare()?.arm();
      return;
    }
    // Additional literal current advertisements remain usable. Enter/Space
    // activation of a real Previous control shares the trusted click adapter.
    const button = doc.querySelector('.previous-button.ytmusic-player-bar');
    if (!button || button.matches(':disabled,[aria-disabled="true"]')) return;
    const shortcuts = button.getAttribute('aria-keyshortcuts');
    if (!shortcuts || shortcuts.length > 128) return;
    const advertised = shortcuts.trim().split(/\s+/);
    if (advertised.length > 8) return;
    const matches = advertised.some((shortcut) => {
      const parts = shortcut.toLowerCase().split('+');
      const key = parts.pop();
      const modifiers = new Set(parts);
      if (
        !key ||
        modifiers.size !== parts.length ||
        parts.some(
          (part) => !['shift', 'control', 'alt', 'meta'].includes(part),
        )
      )
        return false;
      return (
        (key === 'space' ? ' ' : key) === event.key.toLowerCase() &&
        event.shiftKey === modifiers.has('shift') &&
        event.ctrlKey === modifiers.has('control') &&
        event.altKey === modifiers.has('alt') &&
        event.metaKey === modifiers.has('meta')
      );
    });
    if (matches) prepare()?.arm();
  };
  const removeNativeListener = api.removeEventListener.bind(api);
  try {
    api.addEventListener('videodatachange', onData);
    for (const name of [
      'emptied',
      'loadedmetadata',
      'canplay',
      'playing',
      'seeked',
      'ended',
      'seeking',
    ])
      doc.addEventListener(name, onMedia, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('yt-navigate-start', cancel);
    view.addEventListener('pagehide', dispose);
  } catch (error) {
    dispose();
    throw error;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
    try {
      removeNativeListener('videodatachange', onData);
    } catch {
      // Optional observer cleanup cannot disable unrelated core playback.
    }
    for (const name of [
      'emptied',
      'loadedmetadata',
      'canplay',
      'playing',
      'seeked',
      'ended',
      'seeking',
    ])
      doc.removeEventListener(name, onMedia, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('yt-navigate-start', cancel);
    view.removeEventListener('pagehide', dispose);
  }
  return Object.freeze({
    preparePrevious: () => prepare(),
    cancel,
    interrupt,
    dispose,
    retireArtist: (_policy: symbol) => cancel(),
    allowsArtist(videoId: string, policy: symbol) {
      if (!pending && !arrival) return false;
      const facts = observe();
      if (!facts || facts.videoId !== videoId) return false;
      const permission = arrival ?? pending?.provisional;
      if (!permission || (permission.policy && permission.policy !== policy))
        return false;
      // A coherent provisional target defers artist advance while initial load
      // seeking completes. Only native readiness can settle its one occurrence.
      permission.policy = policy;
      return true;
    },
  });
}
