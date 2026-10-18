import type { PreciseVolumePluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

// Adapted from pear-devs/pear-desktop#4746 by @WoWfff.
const popupSelector =
  'ytmusic-miniplayer .ytMusicMiniPlayerVolumePopup input[type="range"]';
const hostSelector = 'ytmusic-player-bar, ytmusic-miniplayer';
const discoverySelector = `${hostSelector}, .ytMusicMiniPlayerVolumePopup, #volume-slider, #expand-volume-slider`;
const legacySelectors = ['#volume-slider', '#expand-volume-slider'];
type Timer = ReturnType<typeof setTimeout>;
type Slider = HTMLElement & { value: string | number };
type VolumeApi = Pick<
  MusicPlayer,
  'getVolume' | 'setVolume' | 'getPlayerResponse'
> &
  Partial<Pick<HTMLElement, 'isConnected' | 'contains'>>;
export type VolumeSessionDependencies = {
  api: VolumeApi;
  document: Document;
  window: EventTarget;
  subscribe?: (event: string, listener: (value: unknown) => void) => () => void;
  setConfig: RendererContext<PreciseVolumePluginConfig>['setConfig'];
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
  createObserver(
    callback: MutationCallback,
  ): Pick<MutationObserver, 'observe' | 'disconnect'>;
  videoToggleEnabled(): boolean | Promise<boolean>;
  isCurrent(): boolean;
};

function canonical(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}
function nativeValue(value: unknown) {
  if (typeof value === 'number') return canonical(value);
  if (
    typeof value !== 'string' ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return undefined;
  return canonical(Number(value));
}

/** One disposable renderer owner; these boundaries never load the app renderer. */
export function createVolumeSession(deps: VolumeSessionDependencies) {
  const doc = deps.document,
    releases = new Set<() => void>();
  const timers = new Map<'save' | 'hud' | 'slider' | 'move', Timer>();
  const hover = new Set<HTMLElement>();
  let generation = 0,
    running = false;
  let config: PreciseVolumePluginConfig | undefined;
  let observer: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  let hud: HTMLSpanElement | undefined,
    noVideo = false,
    ownVideoMovement = false;
  let lastSaved: number | undefined, pendingSave: number | undefined;
  let busy: number | undefined, projecting: number | undefined;
  let expectedLegacy = new WeakMap<Element, string>();
  const alive = (ticket: number) => {
    if (!running || ticket !== generation || config?.enabled !== true)
      return false;
    const connected = deps.api.isConnected !== false;
    if (!connected || !running || ticket !== generation) return false;
    return (
      connected &&
      deps.isCurrent() &&
      running &&
      ticket === generation &&
      config?.enabled === true
    );
  };
  function own(release: () => void, ticket: number) {
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      releases.delete(dispose);
      release();
    };
    if (alive(ticket)) releases.add(dispose);
    else dispose();
    return dispose;
  }
  function listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    ticket: number,
    options?: AddEventListenerOptions | boolean,
  ) {
    if (!alive(ticket)) return;
    target.addEventListener(type, handler, options);
    own(() => target.removeEventListener(type, handler, options), ticket);
  }
  function later(
    slot: 'save' | 'hud' | 'slider' | 'move',
    delay: number,
    ticket: number,
    action: () => void,
  ) {
    if (!alive(ticket)) return;
    const old = timers.get(slot);
    if (old !== undefined) deps.clearTimeout(old);
    const timer = deps.setTimeout(() => {
      if (timers.get(slot) !== timer) return;
      timers.delete(slot);
      if (alive(ticket)) action();
    }, delay);
    if (alive(ticket)) timers.set(slot, timer);
    else deps.clearTimeout(timer);
  }
  function stop() {
    running = false;
    generation++;
    const oldObserver = observer,
      oldHud = hud,
      oldTimers = [...timers.values()],
      oldReleases = [...releases],
      oldHover = [...hover];
    observer = undefined;
    hud = undefined;
    timers.clear();
    releases.clear();
    hover.clear();
    pendingSave = undefined;
    busy = undefined;
    projecting = undefined;
    expectedLegacy = new WeakMap();
    ownVideoMovement = false;
    for (const timer of oldTimers) deps.clearTimeout(timer);
    oldObserver?.disconnect();
    for (const element of oldHover) element.classList.remove('on-hover');
    oldHud?.remove();
    for (const release of oldReleases) release();
  }
  function styleProperty(
    node: HTMLElement,
    property: 'cssText' | 'opacity' | 'top',
    value: string,
    ticket: number,
  ) {
    if (!alive(ticket)) return;
    const style = node.style;
    if (alive(ticket)) style[property] = value;
  }
  function project(value: number, ticket: number) {
    if (!alive(ticket)) return;
    projecting = ticket;
    try {
      for (const selector of legacySelectors) {
        const slider = doc.querySelector<Slider>(selector);
        if (!alive(ticket)) return;
        if (!slider) continue;
        const text = String(value > 0 && value < 5 ? 5 : value);
        expectedLegacy.set(slider, text);
        const previous = slider.value;
        if (!alive(ticket)) return;
        if (previous !== text && previous !== Number(text)) slider.value = text;
        if (!alive(ticket)) return;
      }
      const popups = doc.querySelectorAll<HTMLInputElement>(popupSelector);
      if (!alive(ticket)) return;
      for (const input of popups) {
        const previous = input.value;
        if (!alive(ticket)) return;
        if (previous !== String(value)) input.value = String(value);
        if (!alive(ticket)) return;
        const style = input.style;
        if (!alive(ticket)) return;
        const getGradient: unknown = Reflect.get(style, 'getPropertyValue');
        if (!alive(ticket) || typeof getGradient !== 'function') return;
        const gradient: unknown = Reflect.apply(getGradient, style, [
          '--yt-slider-shape-gradient-percent',
        ]);
        if (!alive(ticket)) return;
        if (gradient !== `${value}%`) {
          const currentStyle = input.style;
          if (!alive(ticket)) return;
          const setGradient: unknown = Reflect.get(currentStyle, 'setProperty');
          if (!alive(ticket) || typeof setGradient !== 'function') return;
          Reflect.apply(setGradient, currentStyle, [
            '--yt-slider-shape-gradient-percent',
            `${value}%`,
          ]);
        }
        if (!alive(ticket)) return;
      }
      for (const selector of [
        ...legacySelectors,
        'tp-yt-paper-icon-button.volume',
        '#expand-volume',
      ]) {
        const element = doc.querySelector<HTMLElement>(selector);
        if (!alive(ticket)) return;
        const title = element?.title;
        if (!alive(ticket)) return;
        if (element && title !== `${value}%`) element.title = `${value}%`;
        if (!alive(ticket)) return;
      }
    } finally {
      if (projecting === ticket) projecting = undefined;
    }
  }
  function readback(ticket: number) {
    if (!alive(ticket)) return undefined;
    const getter: unknown = Reflect.get(deps.api, 'getVolume');
    if (!alive(ticket) || typeof getter !== 'function') return undefined;
    const value: unknown = Reflect.apply(getter, deps.api, []);
    return alive(ticket) ? canonical(value) : undefined;
  }
  function refresh(ticket: number) {
    if (!alive(ticket) || busy === ticket || projecting === ticket) return;
    const value = readback(ticket);
    if (value === undefined || !alive(ticket)) return;
    project(value, ticket);
  }
  function save(value: number, ticket: number) {
    if (!alive(ticket)) return;
    pendingSave = value;
    later('save', 1000, ticket, () => {
      const next = pendingSave;
      pendingSave = undefined;
      if (next === undefined || next === lastSaved || !alive(ticket)) return;
      lastSaved = next;
      // Keep config callbacks/rejections outside the volume command lane.
      try {
        Promise.resolve(deps.setConfig({ savedVolume: next })).catch(() => {});
      } catch {
        /* No recursive retry. */
      }
    });
  }
  function markHover(element: HTMLElement, ticket: number) {
    if (!alive(ticket)) return;
    const classes = element.classList;
    if (!alive(ticket)) return;
    const present = classes.contains('on-hover');
    if (!alive(ticket)) return;
    if (!present) {
      hover.add(element);
      classes.add('on-hover');
    }
  }
  function feedback(value: number, ticket: number) {
    if (!alive(ticket)) return;
    const slider = doc.querySelector<HTMLElement>('#volume-slider');
    if (!alive(ticket)) return;
    if (slider) {
      markHover(slider, ticket);
      later('slider', 2500, ticket, () => {
        if (hover.delete(slider)) slider.classList.remove('on-hover');
      });
    }
    const node = hud;
    if (!node || !alive(ticket)) return;
    node.textContent = `${value}%`;
    if (!alive(ticket)) return;
    styleProperty(node, 'opacity', '1', ticket);
    later('hud', 2000, ticket, () => {
      if (hud === node) styleProperty(node, 'opacity', '0', ticket);
    });
  }
  function command(value: unknown, ticket: number) {
    const next = canonical(value);
    if (next === undefined || !alive(ticket) || busy === ticket) return false;
    busy = ticket;
    try {
      const setter: unknown = Reflect.get(deps.api, 'setVolume');
      if (!alive(ticket) || typeof setter !== 'function') return false;
      Reflect.apply(setter, deps.api, [next]);
      if (!alive(ticket)) return false;
      const actual = readback(ticket);
      if (actual === undefined || !alive(ticket)) return false;
      project(actual, ticket);
      if (!alive(ticket)) return false;
      save(actual, ticket);
      feedback(actual, ticket);
      return true;
    } finally {
      if (busy === ticket) busy = undefined;
    }
  }
  function requested(direction: unknown, ticket: number) {
    if (typeof direction !== 'boolean' || !alive(ticket) || busy === ticket)
      return undefined;
    const step = config?.steps;
    if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0)
      return undefined;
    const current = readback(ticket);
    const delta = (direction ? 1 : -1) * Math.min(step, 100);
    return current === undefined || !alive(ticket)
      ? undefined
      : canonical(current + delta);
  }
  function sliderTarget(event: Event, ticket: number) {
    const target = event.target as Slider | null;
    if (
      !target ||
      target.nodeType !== 1 ||
      !target.isConnected ||
      target.ownerDocument !== doc ||
      !alive(ticket)
    )
      return undefined;
    const matches =
      target.matches(popupSelector) ||
      legacySelectors.some(
        (selector) => doc.querySelector(selector) === target,
      );
    return matches && alive(ticket) ? target : undefined;
  }
  function nativeCommit(event: Event, ticket: number) {
    if (!alive(ticket) || busy === ticket || projecting === ticket) return;
    const target = sliderTarget(event, ticket);
    if (!target) return;
    const value = nativeValue(target.value);
    if (value === undefined || !alive(ticket)) return;
    project(value, ticket);
    if (alive(ticket)) save(value, ticket);
  }
  function media(target: EventTarget | null, ticket: number) {
    const node = target as Element | null;
    if (!node || !['VIDEO', 'AUDIO'].includes(node.nodeName) || !alive(ticket))
      return false;
    const contains: unknown = Reflect.get(deps.api, 'contains');
    if (!alive(ticket) || typeof contains !== 'function') return false;
    const contained = Reflect.apply(contains, deps.api, [node]) === true;
    return contained && alive(ticket);
  }
  function host(event: Event, ticket: number) {
    const target = event.target as Element | null;
    if (!target || target.nodeType !== 1 || !alive(ticket)) return null;
    const result = target.closest<HTMLElement>(hostSelector);
    return result?.isConnected && result.ownerDocument === doc && alive(ticket)
      ? result
      : null;
  }
  function relevant(node: Node, ticket: number) {
    if (node.nodeType !== 1 || !alive(ticket)) return false;
    const element = node as Element;
    return (
      element.matches(discoverySelector) ||
      element.querySelector(discoverySelector) !== null ||
      media(element, ticket)
    );
  }
  function discovered(records: MutationRecord[], ticket: number) {
    if (!alive(ticket) || busy === ticket || projecting === ticket) return;
    let update = false;
    for (const record of records) {
      if (!alive(ticket)) return;
      if (record.type === 'attributes') {
        const target = record.target as Slider;
        if (
          record.attributeName === 'value' &&
          legacySelectors.some(
            (selector) => doc.querySelector(selector) === target,
          )
        ) {
          const raw = target.value;
          if (!alive(ticket)) return;
          if (
            nativeValue(raw) !== undefined &&
            String(raw) !== expectedLegacy.get(target)
          )
            update = true;
        } else if (
          ['hidden', 'aria-hidden'].includes(record.attributeName ?? '') &&
          target.matches('ytmusic-miniplayer, .ytMusicMiniPlayerVolumePopup')
        )
          update = true;
      } else if (
        [...record.addedNodes, ...record.removedNodes].some((node) =>
          relevant(node, ticket),
        )
      )
        update = true;
    }
    if (update && alive(ticket)) {
      for (const element of hover) {
        const connected = element.isConnected;
        if (!alive(ticket)) return;
        if (!connected) {
          hover.delete(element);
          element.classList.remove('on-hover');
        }
      }
      refresh(ticket);
    }
  }
  function injectHud(ticket: number) {
    const panel = doc.querySelector<HTMLElement>('#main-panel');
    if (!alive(ticket)) return;
    const withoutVideo =
      (
        panel?.computedStyleMap?.().get('display') as
          | CSSKeywordValue
          | undefined
      )?.value === 'none';
    if (!alive(ticket)) return;
    noVideo = withoutVideo;
    const existing = doc.querySelector('#volumeHud');
    if (!alive(ticket) || existing) return;
    const anchor = doc.querySelector<HTMLElement>(
      noVideo ? '.center-content.ytmusic-nav-bar' : '#song-video',
    );
    if (!anchor || !alive(ticket)) return;
    const node = doc.createElement('span');
    if (!alive(ticket)) return;
    node.id = 'volumeHud';
    if (!alive(ticket)) return;
    styleProperty(
      node,
      'cssText',
      withoutVideo
        ? 'top:18px;right:60px;font-size:xx-large;'
        : 'top:10px;left:10px;font-size:xxx-large;-webkit-text-stroke:1px black;font-weight:600;',
      ticket,
    );
    if (!alive(ticket)) return;
    const attach: unknown = Reflect.get(
      anchor,
      withoutVideo ? 'append' : 'insertAdjacentElement',
    );
    if (!alive(ticket) || typeof attach !== 'function') return;
    hud = node;
    Reflect.apply(attach, anchor, withoutVideo ? [node] : ['afterend', node]);
    if (!alive(ticket)) node.remove();
  }
  function moveHud(showVideo: boolean) {
    const ticket = generation;
    if (typeof showVideo !== 'boolean' || !alive(ticket)) return;
    later('move', 250, ticket, () => {
      const node = hud;
      if (!node || !alive(ticket)) return;
      let top = '0';
      if (showVideo) {
        const player = doc.querySelector<HTMLElement>('ytmusic-player');
        if (!alive(ticket) || !player) return;
        const video = doc.querySelector<HTMLVideoElement>(
          'ytmusic-player video',
        );
        if (!alive(ticket) || !video) return;
        const playerHeight = player.clientHeight;
        if (!alive(ticket)) return;
        const videoHeight = video.clientHeight;
        if (!alive(ticket)) return;
        top = `${(playerHeight - videoHeight) / 2}px`;
      }
      if (alive(ticket) && hud === node)
        styleProperty(node, 'top', top, ticket);
    });
  }
  async function start(next: PreciseVolumePluginConfig) {
    // Reserve this invocation before old disposers can synchronously start another.
    const ticket = generation + 1;
    stop();
    if (ticket !== generation || next.enabled !== true) return;
    config = { ...next };
    running = true;
    lastSaved =
      canonical(next.savedVolume) === next.savedVolume
        ? next.savedVolume
        : undefined;
    if (!alive(ticket)) {
      if (ticket === generation) stop();
      return;
    }
    listen(doc, 'change', (event) => nativeCommit(event, ticket), ticket, true);
    listen(
      doc,
      'volumechange',
      (event) => {
        if (media(event.target, ticket)) refresh(ticket);
      },
      ticket,
      true,
    );
    listen(
      doc,
      'focusin',
      (event) => {
        if (sliderTarget(event, ticket)) refresh(ticket);
      },
      ticket,
      true,
    );
    listen(
      doc,
      'mouseenter',
      (event) => {
        const target = host(event, ticket);
        if (target && event.target === target) {
          markHover(target, ticket);
          refresh(ticket);
        }
      },
      ticket,
      true,
    );
    listen(
      doc,
      'mouseleave',
      (event) => {
        const target = host(event, ticket);
        if (target && event.target === target && hover.delete(target))
          target.classList.remove('on-hover');
      },
      ticket,
      true,
    );
    listen(
      doc,
      'wheel',
      (event) => {
        const delta = (event as WheelEvent).deltaY;
        if (!Number.isFinite(delta) || delta === 0 || !alive(ticket)) return;
        const target = event.target as Element | null;
        if (
          !host(event, ticket) &&
          (noVideo || !target?.closest?.('#main-panel'))
        )
          return;
        const value = requested(delta < 0, ticket);
        if (value === undefined || !alive(ticket)) return;
        event.preventDefault();
        if (alive(ticket)) command(value, ticket);
      },
      ticket,
      { capture: true, passive: false },
    );
    listen(
      deps.window,
      'keydown',
      (event) => {
        if (!alive(ticket) || config?.arrowsShortcut !== true) return;
        const key = (event as KeyboardEvent).code;
        if (!['ArrowUp', 'ArrowDown'].includes(key)) return;
        const search = doc.querySelector<HTMLElement & { opened?: boolean }>(
          'ytmusic-search-box',
        );
        const target = event.target as Element | null;
        if (
          !alive(ticket) ||
          search?.opened ||
          target?.matches?.(
            'input, textarea, select, [contenteditable="true"]',
          ) ||
          doc.activeElement?.matches(
            'input, textarea, select, [contenteditable="true"]',
          )
        )
          return;
        const value = requested(key === 'ArrowUp', ticket);
        if (value === undefined || !alive(ticket)) return;
        event.preventDefault();
        if (alive(ticket)) command(value, ticket);
      },
      ticket,
    );
    listen(
      doc,
      'peard:src-changed',
      (event) => {
        if (!ownVideoMovement || !media(event.target, ticket)) return;
        const getter: unknown = Reflect.get(deps.api, 'getPlayerResponse');
        if (!alive(ticket) || typeof getter !== 'function') return;
        const response = Reflect.apply(getter, deps.api, []) as ReturnType<
          MusicPlayer['getPlayerResponse']
        >;
        if (alive(ticket))
          moveHud(
            response?.videoDetails?.musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV',
          );
      },
      ticket,
      true,
    );
    for (const [channel, handler] of [
      [
        'setVolume',
        (value: unknown) => {
          if (alive(ticket)) command(value, ticket);
        },
      ],
      [
        'changeVolume',
        (direction: unknown) => {
          const value = requested(direction, ticket);
          if (value !== undefined && alive(ticket)) command(value, ticket);
        },
      ],
    ] as const) {
      if (!alive(ticket)) return;
      const release = deps.subscribe?.(channel, handler);
      if (release) own(release, ticket);
    }
    if (!alive(ticket)) return;
    const created = deps.createObserver((records) =>
      discovered(records, ticket),
    );
    if (!alive(ticket)) {
      created.disconnect();
      return;
    }
    observer = created;
    created.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['value', 'hidden', 'aria-hidden'],
      attributeOldValue: true,
    });
    if (!alive(ticket)) return;
    injectHud(ticket);
    if (!alive(ticket)) return;
    const saved = canonical(next.savedVolume);
    if (saved !== undefined) {
      const getter: unknown = Reflect.get(deps.api, 'getVolume');
      if (!alive(ticket) || typeof getter !== 'function') return;
      const before: unknown = Reflect.apply(getter, deps.api, []);
      if (!alive(ticket)) return;
      if (before !== saved) command(saved, ticket);
      else {
        project(saved, ticket);
        if (lastSaved !== saved) save(saved, ticket);
      }
    } else if (next.savedVolume === undefined) refresh(ticket);
    if (!alive(ticket) || noVideo) return;
    const videoToggle = await deps.videoToggleEnabled();
    if (alive(ticket)) ownVideoMovement = !videoToggle;
  }
  function updateConfig(next: PreciseVolumePluginConfig) {
    if (next.enabled !== true) {
      stop();
      return;
    }
    if (running) config = { ...next };
  }
  return { start, updateConfig, stop, moveHud };
}

type Session = ReturnType<typeof createVolumeSession>;
type Owner = {
  active: boolean;
  desired?: PreciseVolumePluginConfig;
  session?: Session;
};
let current: Owner | undefined;
export function stop() {
  const previous = current;
  current = undefined;
  if (previous) {
    previous.active = false;
    previous.session?.stop();
  }
}
// Preserve video-toggle's callable/debounced HUD integration, owned by the session.
export const moveVolumeHud = (showVideo: boolean) =>
  current?.session?.moveHud(showVideo);
export const onConfigChange = (config: PreciseVolumePluginConfig) => {
  const owner = current;
  if (!owner) return;
  owner.desired = config;
  if (config.enabled !== true) stop();
  else owner.session?.updateConfig(config);
};
export const onPlayerApiReady = async (
  api: MusicPlayer,
  context: RendererContext<PreciseVolumePluginConfig>,
) => {
  const previous = current;
  const owner: Owner = { active: true };
  current = owner;
  const owned = () => current === owner && owner.active;
  if (previous) {
    previous.active = false;
    previous.session?.stop();
  }
  if (!owned()) return;
  try {
    const loaded = await context.getConfig();
    if (!owned()) return;
    const config = owner.desired ?? loaded;
    if (config.enabled !== true) {
      stop();
      return;
    }
    const session = createVolumeSession({
      api,
      document,
      window,
      subscribe: context.ipc.subscribe?.bind(context.ipc),
      setConfig: (value) => context.setConfig(value),
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
      createObserver: (callback) => new MutationObserver(callback),
      videoToggleEnabled: () =>
        window.mainConfig.plugins.isEnabled('video-toggle'),
      isCurrent: owned,
    });
    if (!owned()) return;
    owner.session = session;
    await session.start(config);
  } catch (error) {
    if (!owned()) return;
    stop();
    throw error;
  }
};
