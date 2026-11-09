import {
  getPlaybackOwner,
  parsePlaybackBinding,
  samePlaybackBinding,
  type PlaybackBinding,
} from '@/providers/playback-owner';

import type { NotificationsPluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';
const ARM = 'peard:rating-feedback-arm',
  STATE = 'peard:rating-feedback-state';
// One namespace per document module, including soft controller restarts.
let sourceGeneration = 0;
type Arm = { nonce: string; binding: PlaybackBinding };
const validState = (v: unknown): v is 'LIKE' | 'DISLIKE' | 'INDIFFERENT' =>
  v === 'LIKE' || v === 'DISLIKE' || v === 'INDIFFERENT';
export function createRatingFeedbackRenderer(
  context: RendererContext<NotificationsPluginConfig>,
) {
  let live = false,
    enabled = false,
    revision = 0,
    api: MusicPlayer | undefined,
    arm: Arm | undefined;
  let release: (() => void) | undefined,
    retirement: (() => void) | undefined,
    observer: MutationObserver | undefined,
    domObserver: MutationObserver | undefined,
    button: HTMLElement | null = null;
  let generation = 0,
    snapshot = false,
    last: string | undefined,
    observation = 0,
    rearmQueued = false;
  const scalar = (a?: Arm) => live && enabled && (!a || arm === a);
  const current = (a: Arm, target?: HTMLElement) => {
    if (!scalar(a) || !api) return false;
    const captured = api,
      owner = getPlaybackOwner(captured);
    if (!owner || !scalar(a) || api !== captured) return false;
    const binding = owner.binding(a.binding.videoId, a.binding);
    return (
      scalar(a) &&
      api === captured &&
      !!binding &&
      (!target || (button === target && target.isConnected))
    );
  };
  const send = (a: Arm, type: 'snapshot' | 'change', state: string) => {
    if (current(a, button ?? undefined))
      context.ipc.send(STATE, {
        type,
        nonce: a.nonce,
        binding: a.binding,
        sourceGeneration: generation,
        state,
      });
  };
  const clearObservation = () => {
    observation++;
    observer?.disconnect();
    domObserver?.disconnect();
    retirement?.();
    observer = domObserver = undefined;
    retirement = undefined;
    button = null;
    snapshot = false;
    last = undefined;
    generation = 0;
  };
  const read = (a: Arm, target: HTMLElement) => {
    if (!current(a, target)) return;
    const state = target.getAttribute('like-status');
    return current(a, target) && validState(state) ? state : undefined;
  };
  const attach = () => {
    const a = arm;
    if (!a || !current(a)) return;
    const target = document.querySelector<HTMLElement>('#like-button-renderer');
    if (!current(a) || target === button) return;
    observer?.disconnect();
    observer = undefined;
    button = target;
    snapshot = false;
    last = undefined;
    const token = ++observation;
    if (
      !target ||
      !target.isConnected ||
      sourceGeneration === Number.MAX_SAFE_INTEGER
    ) {
      generation = 0;
      return;
    }
    generation = ++sourceGeneration;
    const update = () => {
      if (observation !== token || !current(a, target)) return;
      const state = read(a, target);
      if (state === undefined) return;
      if (!snapshot) {
        snapshot = true;
        last = state;
        send(a, 'snapshot', state);
      } else if (last !== state) {
        last = state;
        send(a, 'change', state);
      }
    };
    observer = new MutationObserver(update);
    observer.observe(target, {
      attributes: true,
      attributeFilter: ['like-status'],
    });
    queueMicrotask(update);
  };
  const observe = () => {
    const a = arm;
    if (!a || !api || !current(a)) return;
    const owner = getPlaybackOwner(api);
    if (!owner) return;
    retirement = owner.subscribeRetirement((previous) => {
      if (
        !scalar(a) ||
        previous.documentId !== a.binding.documentId ||
        previous.episodeId !== a.binding.episodeId
      )
        return;
      // Physical owner retirement only; ordinary observer/controller stop is local.
      arm = undefined;
      clearObservation();
      if (live && enabled)
        context.ipc.send(STATE, {
          type: 'retire',
          nonce: a.nonce,
          binding: a.binding,
        });
    });
    domObserver = new MutationObserver(attach);
    const container = document.querySelector('ytmusic-app');
    if (container)
      domObserver.observe(container, { childList: true, subtree: true });
    attach();
  };
  const receive = (value: unknown) => {
    if (
      !scalar() ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return;
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).length !== 2 ||
      typeof v.nonce !== 'string' ||
      !/^[0-9a-f]{64}$/.test(v.nonce)
    )
      return;
    const binding = parsePlaybackBinding(v.binding);
    if (!binding) return;
    if (arm?.nonce === v.nonce && samePlaybackBinding(arm.binding, binding))
      return;
    clearObservation();
    arm = { nonce: v.nonce, binding };
    observe();
  };
  const ready = () => {
    if (scalar()) context.ipc.send(STATE, { type: 'ready' });
  };
  const nativeChange = () => {
    if (!scalar() || rearmQueued) return;
    rearmQueued = true;
    const token = revision;
    queueMicrotask(() => {
      rearmQueued = false;
      if (token === revision) ready();
    });
  };
  const configure = (config: NotificationsPluginConfig) => {
    enabled =
      live &&
      config.enabled &&
      config.notifyOnLikeChange &&
      !!context.ipc.subscribe;
    if (!enabled) {
      release?.();
      release = undefined;
      arm = undefined;
      clearObservation();
      return;
    }
    if (!release) release = context.ipc.subscribe!(ARM, receive);
    ready();
  };
  return {
    async start() {
      this.stop();
      live = true;
      const token = ++revision;
      const config = await context.getConfig();
      if (live && revision === token) configure(config);
    },
    onConfigChange(config: NotificationsPluginConfig) {
      revision++;
      configure(config);
    },
    onPlayerApiReady(player: MusicPlayer) {
      if (api === player) return;
      api?.removeEventListener('videodatachange', nativeChange);
      clearObservation();
      api = player;
      api.addEventListener('videodatachange', nativeChange);
      if (arm) observe();
      ready();
    },
    stop() {
      live = false;
      enabled = false;
      revision++;
      release?.();
      release = undefined;
      api?.removeEventListener('videodatachange', nativeChange);
      api = undefined;
      arm = undefined;
      clearObservation();
      rearmQueued = false;
    },
  };
}
let controller: ReturnType<typeof createRatingFeedbackRenderer> | undefined;
export const ratingFeedbackRenderer = {
  start(context: RendererContext<NotificationsPluginConfig>) {
    controller?.stop();
    controller = createRatingFeedbackRenderer(context);
    return controller.start();
  },
  onConfigChange(config: NotificationsPluginConfig) {
    controller?.onConfigChange(config);
  },
  onPlayerApiReady(api: MusicPlayer) {
    controller?.onPlayerApiReady(api);
  },
  stop() {
    controller?.stop();
    controller = undefined;
  },
};
