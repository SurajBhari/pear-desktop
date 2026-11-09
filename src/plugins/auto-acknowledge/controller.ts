import {
  ATTEMPT_DEBOUNCE_MS,
  CLICK_THROTTLE_MS,
  ERROR_RENDERER_SELECTOR,
  PLAYER_ROOT_SELECTOR,
  findWarningAction,
} from './matcher';

import type { MusicPlayer } from '@/types/music-player';

export function startAutoAcknowledge(
  doc: Document,
  options: { debug?: () => boolean } = {},
): { dispose(): void; bindPlayerApi(playerApi: MusicPlayer): void } {
  const view = doc.defaultView;
  if (!view) return { dispose() {}, bindPlayerApi() {} };
  let stopped = false;
  let app: Element | null = null;
  let root: Element | null = null;
  let scopeRoot: Node | null = null;
  let generation = 0;
  let frame: number | undefined;
  let timer: number | undefined;
  let lastAttempt = -Infinity;
  let lastClick = -Infinity;
  let videoId = '';
  let handled:
    | { renderer: HTMLElement; reason: string; videoId: string }
    | undefined;
  let attempts = 0;
  let clicks = 0;
  let ancestorTargets: Node[] = [];
  let apiToken = 0;
  let apiBinding:
    | {
        api: MusicPlayer;
        add: CallableFunction;
        remove: CallableFunction;
        get: CallableFunction | undefined;
        callback: () => void;
      }
    | undefined;
  const log = (event: 'acknowledged' | 'ineligible' | 'unsupported') => {
    try {
      if (options.debug?.())
        view.console.debug('[auto-acknowledge]', event, { attempts, clicks });
    } catch {
      /* Debug output never changes native behavior. */
    }
  };
  const current = () =>
    !stopped &&
    app?.isConnected &&
    doc.querySelector('ytmusic-app') === app &&
    root?.isConnected &&
    app.querySelector(PLAYER_ROOT_SELECTOR) === root;
  const apiElement = () =>
    root?.matches('#movie_player')
      ? root
      : root?.querySelector('#movie_player');
  const cancelWork = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    if (timer !== undefined) view.clearTimeout(timer);
    frame = timer = undefined;
  };
  const retireApi = () => {
    apiToken++;
    const previous = apiBinding;
    apiBinding = undefined;
    if (!previous) return;
    for (const event of ['videodatachange', 'onStateChange']) {
      try {
        Reflect.apply(previous.remove, previous.api, [
          event,
          previous.callback,
        ]);
      } catch {
        /* Stale callbacks remain fenced if a site remover is unsupported. */
      }
    }
  };
  const readVideoId = () => {
    const binding = apiBinding;
    if (
      !binding?.get ||
      !current() ||
      apiElement() !== (binding.api as unknown)
    )
      return '';
    try {
      const data: unknown = Reflect.apply(binding.get, binding.api, []);
      if (!data || typeof data !== 'object') return '';
      const identity: unknown = Reflect.get(data, 'video_id');
      return current() && apiBinding === binding && typeof identity === 'string'
        ? identity
        : '';
    } catch {
      return '';
    }
  };
  const updateIdentity = (seed = false) => {
    const next = readVideoId();
    if (!next) return;
    if (seed && !videoId && handled) handled.videoId = next;
    videoId = next;
  };
  // Captured native methods always receive the target via Reflect.apply.
  // oxlint-disable-next-line typescript/unbound-method
  const nativeAdd = view.EventTarget.prototype.addEventListener;
  // oxlint-disable-next-line typescript/unbound-method
  const nativeRemove = view.EventTarget.prototype.removeEventListener;
  const onVisibility = () => schedule();
  const rootSignals = ['transitionend', 'animationend'];
  const retireRoot = () => {
    if (root)
      for (const event of rootSignals)
        Reflect.apply(nativeRemove, root, [event, onVisibility]);
    retireApi();
    root = null;
    videoId = '';
    handled = undefined;
    generation++;
    cancelWork();
  };
  const refreshRoot = () => {
    const next = app?.querySelector(PLAYER_ROOT_SELECTOR) ?? null;
    if (next !== root) {
      retireRoot();
      root = next;
      if (root)
        for (const event of rootSignals)
          Reflect.apply(nativeAdd, root, [event, onVisibility]);
    } else if (apiBinding && apiElement() !== (apiBinding.api as unknown))
      retireApi();
  };
  const observeAncestors = () => {
    const next: Node[] = [];
    for (let node = app?.parentNode; node; node = node.parentNode)
      next.push(node);
    if (!app) next.push(doc);
    const changed =
      next.length !== ancestorTargets.length ||
      next.some((node, i) => node !== ancestorTargets[i]);
    if (!changed) return false;
    ownerObserver.disconnect();
    ancestorTargets = next;
    for (const node of next)
      ownerObserver.observe(node, {
        childList: true,
        attributes: true,
        attributeFilter: [
          'class',
          'style',
          'hidden',
          'inert',
          'aria-hidden',
          ...(node instanceof view.HTMLFieldSetElement ? ['disabled'] : []),
        ],
      });
    return true;
  };
  const refreshOwner = () => {
    const next = doc.querySelector('ytmusic-app');
    if (next !== app) {
      retireRoot();
      app = next;
    }
    const nextScope = app ?? doc.documentElement;
    if (scopeRoot !== nextScope) {
      scopeObserver.disconnect();
      scopeRoot = nextScope;
      if (app)
        scopeObserver.observe(app, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: [
            'class',
            'style',
            'hidden',
            'inert',
            'aria-hidden',
            'disabled',
            'aria-disabled',
            'id',
          ],
        });
      else if (nextScope)
        scopeObserver.observe(nextScope, { childList: true, subtree: true });
    }
    observeAncestors();
    refreshRoot();
  };
  const defer = (delay: number) => {
    if (timer !== undefined) return;
    const epoch = generation;
    timer = view.setTimeout(() => {
      timer = undefined;
      if (!stopped && generation === epoch) attempt();
    }, delay);
  };
  const attempt = () => {
    if (stopped) return;
    if (!current()) {
      refreshOwner();
      if (!current()) return;
    }
    const now = view.performance.now();
    const remaining = lastAttempt + ATTEMPT_DEBOUNCE_MS - now;
    if (remaining > 0) {
      defer(remaining);
      return;
    }
    lastAttempt = now;
    attempts++;
    updateIdentity();
    if (!current()) return;
    try {
      const action = findWarningAction(root!, doc);
      if (!current()) return;
      if (!action) {
        handled = undefined;
        log('ineligible');
        return;
      }
      if (
        handled?.renderer === action.renderer &&
        handled.reason === action.reason &&
        handled.videoId === videoId
      )
        return;
      const throttle = lastClick + CLICK_THROTTLE_MS - now;
      if (throttle > 0) {
        defer(throttle);
        return;
      }
      const click: unknown = Reflect.get(action.button, 'click');
      if (!current() || typeof click !== 'function') return;
      const final = findWarningAction(root!, doc);
      if (
        !current() ||
        final?.renderer !== action.renderer ||
        final.button !== action.button ||
        final.reason !== action.reason ||
        final.subreason !== action.subreason
      )
        return;
      // Fence reentrant native callouts and unsupported controls before invoking.
      handled = { renderer: action.renderer, reason: action.reason, videoId };
      lastClick = now;
      Reflect.apply(click, action.button, []);
      clicks++;
      log('acknowledged');
    } catch {
      log('unsupported');
    }
  };
  function schedule() {
    if (stopped || frame !== undefined || timer !== undefined) return;
    const epoch = generation;
    frame = view!.requestAnimationFrame(() => {
      frame = undefined;
      if (!stopped && generation === epoch) attempt();
    });
  }
  const isPlayerNode = (node: Node) =>
    node instanceof view.Element &&
    (node.matches(PLAYER_ROOT_SELECTOR) ||
      Boolean(
        node.firstElementChild && node.querySelector(PLAYER_ROOT_SELECTOR),
      ));
  const isWarningNode = (node: Node) =>
    node instanceof view.Element &&
    (node.matches(
      'yt-playability-error-supported-renderers, yt-player-error-message-renderer, #reason, #subreason, #button',
    ) ||
      Boolean(
        node.firstElementChild && node.querySelector(ERROR_RENDERER_SELECTOR),
      ));
  const ownerObserver = new view.MutationObserver((records) => {
    if (stopped) return;
    const next = doc.querySelector('ytmusic-app');
    if (next !== app || !app?.isConnected) {
      refreshOwner();
      schedule();
      return;
    }
    if (
      observeAncestors() ||
      records.some((record) => record.type === 'attributes')
    )
      schedule();
  });
  const scopeObserver = new view.MutationObserver((records) => {
    if (stopped) return;
    if (!app || !app.isConnected || doc.querySelector('ytmusic-app') !== app) {
      refreshOwner();
      schedule();
      return;
    }
    let related = false;
    let playerChange = false;
    for (const record of records) {
      const target =
        record.target instanceof view.Element
          ? record.target
          : record.target.parentElement;
      if (record.type === 'childList') {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (
          nodes.some(
            (node) =>
              isPlayerNode(node) ||
              (root && node instanceof view.Element && node.contains(root)),
          )
        )
          playerChange = true;
        if (root?.contains(record.target) && nodes.some(isWarningNode))
          related = true;
      }
      if (!target) continue;
      if (
        record.type === 'attributes' &&
        (target === root || target.matches(PLAYER_ROOT_SELECTOR))
      )
        playerChange = true;
      if (root && (target === root || target.contains(root))) related = true;
      if (
        root?.contains(target) &&
        target.closest('yt-player-error-message-renderer')
      )
        related = true;
      if (
        record.type === 'attributes' &&
        record.attributeName === 'disabled' &&
        target instanceof view.HTMLFieldSetElement &&
        root?.contains(target) &&
        isWarningNode(target)
      )
        related = true;
    }
    if (playerChange) {
      refreshRoot();
      related = true;
    }
    if (related) schedule();
  });
  const bindPlayerApi = (playerApi: MusicPlayer) => {
    if (!current() || (playerApi as unknown) !== apiElement()) return;
    const epoch = generation;
    try {
      const add: unknown = Reflect.get(playerApi, 'addEventListener');
      const remove: unknown = Reflect.get(playerApi, 'removeEventListener');
      const get: unknown = Reflect.get(playerApi, 'getVideoData');
      if (
        !current() ||
        epoch !== generation ||
        (playerApi as unknown) !== apiElement() ||
        typeof add !== 'function' ||
        typeof remove !== 'function'
      )
        return;
      if (
        apiBinding?.api === playerApi &&
        apiBinding.add === add &&
        apiBinding.remove === remove &&
        apiBinding.get === get
      )
        return;
      retireApi();
      const token = apiToken;
      const callback = () => {
        if (
          stopped ||
          token !== apiToken ||
          !current() ||
          apiElement() !== (playerApi as unknown)
        )
          return;
        updateIdentity();
        schedule();
      };
      apiBinding = {
        api: playerApi,
        add,
        remove,
        get: typeof get === 'function' ? get : undefined,
        callback,
      };
      for (const event of ['videodatachange', 'onStateChange']) {
        if (!current() || token !== apiToken) {
          retireApi();
          return;
        }
        Reflect.apply(add, playerApi, [event, callback]);
      }
      updateIdentity(true);
      schedule();
    } catch {
      retireApi();
      log('unsupported');
    }
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    retireRoot();
    scopeObserver.disconnect();
    ownerObserver.disconnect();
    Reflect.apply(nativeRemove, doc, ['visibilitychange', onVisibility]);
    Reflect.apply(nativeRemove, view, ['resize', onVisibility]);
    Reflect.apply(nativeRemove, view, ['pagehide', dispose]);
  };
  Reflect.apply(nativeAdd, doc, ['visibilitychange', onVisibility]);
  Reflect.apply(nativeAdd, view, ['resize', onVisibility]);
  Reflect.apply(nativeAdd, view, ['pagehide', dispose]);
  refreshOwner();
  attempt();
  return { dispose, bindPlayerApi };
}
