import {
  MusicServiceError,
  type MetadataBinding,
  type MusicControlCommand,
  type NativeControlValue,
} from '@/plugins/api-server/music-types';

import type { createPlaylistQueueController } from './queue-playlist-renderer';
import type { createRepeatPreference } from './repeat-preference';
import type { MusicPlayer } from '@/types/music-player';

type Bindings = {
  repeatPreference: ReturnType<typeof createRepeatPreference>;
  playlistQueue: ReturnType<typeof createPlaylistQueueController>;
  getApi(this: void): MusicPlayer | null;
};
type ActionsOwner = Readonly<Bindings> & {
  current(): boolean;
  nativeCurrent(): boolean;
};
const owners = new WeakMap<MusicPlayer, ActionsOwner>();
const retirees = new WeakMap<ActionsOwner, () => void>();
/** Import-safe bridge to the core's existing instances; publication has no native effect. */
export function publishMusicActionsOwner(api: MusicPlayer, bindings: Bindings) {
  const previous = owners.get(api);
  if (previous) retirees.get(previous)?.();
  const page = window,
    getApi = bindings.getApi,
    publishingDocument = typeof document === 'undefined' ? undefined : document;
  let rootQuery: ((...args: unknown[]) => unknown) | undefined;
  try {
    const realm = publishingDocument?.defaultView as
      | (Window & typeof globalThis)
      | null;
    const candidate: unknown =
      realm?.Node &&
      Object.getOwnPropertyDescriptor(realm.Node.prototype, 'getRootNode')
        ?.value;
    if (typeof candidate === 'function')
      rootQuery = candidate as (...args: unknown[]) => unknown;
  } catch {
    // An unsupported proof must not interrupt unrelated core startup.
  }
  let active = true;
  const owner: ActionsOwner = Object.freeze({
    ...bindings,
    nativeCurrent: () => {
      if (!rootQuery || !publishingDocument) return false;
      try {
        // Use the captured realm intrinsic, never an instance/provider getter.
        return (
          Reflect.apply(rootQuery, api, [{ composed: true }]) ===
          publishingDocument
        );
      } catch {
        // Only genuine nodes in this document qualify for owned C9 dispatch.
        return false;
      }
    },
    current: () => {
      if (!active || owners.get(api) !== owner) return false;
      const current = getApi();
      return (
        active &&
        owners.get(api) === owner &&
        current === api &&
        (api as MusicPlayer & Partial<HTMLElement>).isConnected !== false &&
        active
      );
    },
  });
  const dispose = () => {
    if (!active) return;
    active = false;
    if (owners.get(api) === owner) owners.delete(api);
    page.removeEventListener('pagehide', dispose);
    retirees.delete(owner);
  };
  owners.set(api, owner);
  retirees.set(owner, dispose);
  page.addEventListener('pagehide', dispose);
  return dispose;
}
export const getMusicActionsOwner = (api: MusicPlayer) => owners.get(api);

/** Controls contain only plain own scalar data; no coercion or property callouts. */
export function parseControlCommand(
  value: unknown,
): MusicControlCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  const data: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    if (typeof key !== 'string') return null;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) return null;
    data[key] = d.value;
  }
  if (!Object.hasOwn(data, 'action')) return null;
  const action = data.action;
  if (
    [
      'previous',
      'next',
      'play',
      'pause',
      'toggle_playback',
      'toggle_shuffle',
    ].includes(action as string)
  )
    return keys.length === 1 ? ({ action } as MusicControlCommand) : null;
  if (
    action === 'switch_repeat' &&
    keys.every((key) => key === 'action' || key === 'iterations')
  ) {
    const iterations = data.iterations === undefined ? 1 : data.iterations;
    return iterations === 1 || iterations === 2 ? { action, iterations } : null;
  }
  if (
    action === 'seek' &&
    keys.length === 3 &&
    Object.hasOwn(data, 'seconds') &&
    Object.hasOwn(data, 'playbackEpoch')
  ) {
    const seconds = data.seconds,
      playbackEpoch = data.playbackEpoch;
    return typeof seconds === 'number' &&
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      Number.isFinite(seconds * 1000) &&
      typeof playbackEpoch === 'string' &&
      /^[0-9a-f]{32}:[0-9a-f]{32}$/.test(playbackEpoch)
      ? { action, seconds, playbackEpoch }
      : null;
  }
  if (
    action === 'set_volume' &&
    keys.length === 2 &&
    Object.hasOwn(data, 'volume')
  ) {
    const volume = data.volume;
    return typeof volume === 'number' &&
      Number.isFinite(volume) &&
      volume >= 0 &&
      volume <= 100
      ? { action, volume }
      : null;
  }
  return null;
}

type Link = {
  object: object;
  key: string;
  holder: object;
  descriptor: PropertyDescriptor;
  value?: unknown;
  resolve: boolean;
};
function descriptor(object: object, key: string) {
  let holder: object | null = object;
  for (
    let depth = 0;
    holder && depth < 16;
    depth++, holder = Object.getPrototypeOf(holder) as object | null
  ) {
    const d = Object.getOwnPropertyDescriptor(holder, key);
    if (d) return { holder, descriptor: d };
  }
  return undefined;
}
function capture(object: object, key: string, resolve = true): Link {
  const link = descriptor(object, key);
  if (!link) throw new MusicServiceError('unavailable');
  return {
    object,
    key,
    ...link,
    resolve,
    ...(resolve ? { value: Reflect.get(object, key) as unknown } : {}),
  };
}
function unchanged(link: Link, resolve = true) {
  const next = descriptor(link.object, link.key),
    old = link.descriptor,
    d = next?.descriptor;
  return (
    next?.holder === link.holder &&
    !!d &&
    d.value === old.value &&
    d.get === old.get &&
    d.set === old.set &&
    d.writable === old.writable &&
    d.configurable === old.configurable &&
    d.enumerable === old.enumerable &&
    (!resolve ||
      !link.resolve ||
      Reflect.get(link.object, link.key) === link.value)
  );
}
function method(object: object, key: string) {
  const link = capture(object, key);
  if (typeof link.value !== 'function')
    throw new MusicServiceError('unavailable');
  return link;
}
export function dispatchMusicControl(
  api: MusicPlayer,
  command: MusicControlCommand,
  context: {
    valid(): boolean;
    current(): boolean;
    probe(): MetadataBinding;
    enter(): void;
  },
): NativeControlValue {
  const owner = getMusicActionsOwner(api),
    page = window,
    doc = document;
  if (!owner) throw new MusicServiceError('unavailable');
  const links: Link[] = [],
    absent: { object: object; key: string }[] = [],
    nodes: { selector: string; node: Element | null }[] = [];
  let expected: MetadataBinding | undefined;
  let guardStart = -1;
  const scalar = () => getMusicActionsOwner(api) === owner && context.current();
  const fence = (playback = true, beforeGuard = false) => {
    if (
      !scalar() ||
      !owner.current() ||
      !scalar() ||
      !context.valid() ||
      !scalar()
    )
      throw new MusicServiceError('retired');
    for (const { selector, node } of nodes)
      if (doc.querySelector(selector) !== node || (node && !node.isConnected))
        throw new MusicServiceError('retired');
    for (const link of links)
      if (!unchanged(link)) throw new MusicServiceError('retired');
    if (playback && expected) {
      const fresh = context.probe();
      if (
        fresh.videoId !== expected.videoId ||
        fresh.playbackEpoch !== expected.playbackEpoch
      )
        throw new MusicServiceError('retired');
    }
    if (
      !scalar() ||
      !owner.current() ||
      !scalar() ||
      !context.valid() ||
      !scalar()
    )
      throw new MusicServiceError('retired');
    // Lifetime callouts can replace backing values without changing descriptors.
    // Revalidate children/newer links before their earlier captured receivers, so
    // a method getter cannot replace a queue after that queue's final value check.
    const resolveRange = (from: number, to: number) => {
      for (let index = from; index >= to; index--)
        if (!scalar() || !unchanged(links[index]) || !scalar())
          throw new MusicServiceError('retired');
    };
    if (beforeGuard && guardStart >= 0) {
      // A target getter can replace the guard. Validate that receiver last before
      // cancellation; after cancellation, the target dependencies go last again.
      resolveRange(guardStart - 1, 0);
      resolveRange(links.length - 1, guardStart);
    } else resolveRange(links.length - 1, 0);
    for (const { selector, node } of nodes)
      if (doc.querySelector(selector) !== node || (node && !node.isConnected))
        throw new MusicServiceError('retired');
    for (const { object, key } of absent)
      if (descriptor(object, key)) throw new MusicServiceError('retired');
    // Reentrant later getters may replace a previously checked method. Finish
    // with descriptor-only fences, with no user getter callout after them.
    for (const link of links)
      if (!unchanged(link, false)) throw new MusicServiceError('retired');
    // This standard DOM intrinsic is non-reentrant. Nothing after it calls a
    // provider getter; private scalar checks cover synchronous owner retirement.
    if (!scalar() || !owner.nativeCurrent() || !scalar())
      throw new MusicServiceError('retired');
  };
  const node = (selector: string, optional = false) => {
    const found = doc.querySelector(selector);
    nodes.push({ selector, node: found });
    if (!optional && (!found || !found.isConnected))
      throw new MusicServiceError('unavailable');
    return found;
  };
  const bound = (object: object, key: string) => {
    const link = method(object, key);
    links.push(link);
    return () =>
      Reflect.apply(link.value as (...args: unknown[]) => unknown, object, []);
  };
  fence();
  if (
    ['previous', 'next', 'play', 'pause', 'toggle_playback', 'seek'].includes(
      command.action,
    )
  ) {
    expected = context.probe();
    if (
      command.action === 'seek' &&
      command.playbackEpoch !== expected.playbackEpoch
    )
      throw new MusicServiceError('retired');
  }
  let target: () => unknown;
  let after: (() => void) | undefined;
  if (command.action === 'previous' || command.action === 'next')
    target = bound(
      node(`.${command.action}-button.ytmusic-player-bar`)!,
      'click',
    );
  else if (command.action === 'play' || command.action === 'pause')
    target = bound(api, command.action === 'play' ? 'playVideo' : 'pauseVideo');
  else if (command.action === 'toggle_playback') {
    const state = bound(api, 'getPlayerState')();
    target = bound(api, state === 2 ? 'playVideo' : 'pauseVideo');
  } else if (command.action === 'toggle_shuffle') {
    const bar = node('ytmusic-player-bar')!,
      link = capture(bar, 'queue');
    links.push(link);
    if (!link.value || typeof link.value !== 'object')
      throw new MusicServiceError('unavailable');
    target = bound(link.value, 'shuffle');
  } else if (command.action === 'switch_repeat') {
    const click = bound(node('ytmusic-player-bar')!, 'onRepeatButtonClick'),
      remember = bound(owner.repeatPreference, 'rememberUserChange');
    target = click;
    after = () => {
      if (command.iterations === 2) {
        fence(false);
        click();
      }
      fence(false);
      remember();
    };
  } else if (command.action === 'seek') {
    const link = method(api, 'seekTo');
    links.push(link);
    target = () =>
      Reflect.apply(link.value as (...args: unknown[]) => unknown, api, [
        command.seconds,
      ]);
  } else if (command.action === 'set_volume') {
    const link = method(api, 'setVolume');
    links.push(link);
    const sliders = ['#volume-slider', '#expand-volume-slider'].map(
      (selector) => node(selector, true),
    );
    for (const slider of sliders)
      if (slider) links.push(capture(slider, 'value', false));
    target = () =>
      Reflect.apply(link.value as (...args: unknown[]) => unknown, api, [
        command.volume,
      ]);
    after = () => {
      for (const slider of sliders)
        if (slider) {
          fence(false);
          if (!Reflect.set(slider, 'value', String(command.volume)))
            throw new MusicServiceError('source');
        }
    };
  } else throw new MusicServiceError('invalid');
  guardStart = links.length;
  const guardLink = descriptor(page, 'blockerSceneGuard')
    ? capture(page, 'blockerSceneGuard')
    : undefined;
  if (guardLink) links.push(guardLink);
  else absent.push({ object: page, key: 'blockerSceneGuard' });
  const guard = guardLink?.value;
  let cancel: (() => unknown) | undefined;
  if (guard !== undefined && guard !== null) {
    if (typeof guard !== 'object') throw new MusicServiceError('unavailable');
    cancel = bound(guard, 'cancelFromUser');
  }
  fence(true, !!cancel);
  if (cancel) {
    context.enter();
    cancel();
    fence();
  }
  // No playback fence after invocation: the delivered command may itself change tracks.
  context.enter();
  target();
  after?.();
  return { version: 1, phase: 'owned_control_dispatch' };
}
