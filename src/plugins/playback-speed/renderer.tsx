import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

import { t } from '@/i18n';
import {
  isMusicOrVideoTrack,
  isPlayerMenu,
} from '@/plugins/utils/renderer/check';
import { createPlaybackPitchOwner } from '@/plugins/utils/renderer/playback-pitch-owner';
import {
  claimPlaybackRate,
  getPlaybackRateOwner,
  PLAYBACK_RATE_OWNER_CHANGED,
  releasePlaybackRate,
} from '@/plugins/utils/renderer/playback-rate-owner';
import { getSongMenu } from '@/providers/dom-elements';

import { PlaybackSpeedSlider } from './components/slider';

import type { PlaybackSpeedConfig, PlaybackSpeedPluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

const MIN_PLAYBACK_SPEED = 0.07;
const MAX_PLAYBACK_SPEED = 16;
const PLUGIN_ID = 'playback-speed';
const roundToTwo = (n: number) => Math.round(n * 1e2) / 1e2;
const [speed, setSpeed] = createSignal(1);
const sliderContainer = document.createElement('div');
let active = false;
let generation = 0;
let dispose: (() => void) | null = null;
let popupObserver: MutationObserver | null = null;
let replacementObserver: MutationObserver | null = null;
let popup: Element | null = null;
let video: HTMLVideoElement | null = null;
let dataHandler: (() => void) | null = null;
let preservesPitch = true;
let configRevision = 0;
let step = 0.1;
let stepEnabled = false;
type StepScope = {
  api?: MusicPlayer;
  context?: RendererContext<PlaybackSpeedPluginConfig>;
  document: Document;
  generation: number;
  configReady: boolean;
  subscriptionRevision: number;
  unsubscribe: (() => void) | null;
};
let stepScope: StepScope | null = null;
let pagehideHandler: (() => void) | null = null;
let retiring = false;
let pendingReady: {
  api?: MusicPlayer;
  context?: RendererContext<PlaybackSpeedPluginConfig>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} | null = null;
const pitchOwner = createPlaybackPitchOwner(PLUGIN_ID);

function stepCurrent(scope: StepScope): boolean {
  return (
    active &&
    stepScope === scope &&
    generation === scope.generation &&
    document === scope.document &&
    scope.configReady &&
    stepEnabled
  );
}
function releaseStep(scope: StepScope | null): (() => void) | null {
  if (!scope) return null;
  scope.subscriptionRevision++;
  const unsubscribe = scope.unsubscribe;
  scope.unsubscribe = null;
  return unsubscribe;
}
function updatePlaybackSpeed(isCurrent: () => boolean = () => active): void {
  const currentGeneration = generation;
  const current = () =>
    active && generation === currentGeneration && isCurrent();
  if (!current()) return;
  claimPlaybackRate(PLUGIN_ID, speed());
  if (!current()) return;
  const target = document.querySelector<HTMLVideoElement>('video');
  if (
    !target ||
    !current() ||
    getPlaybackRateOwner(target) !== PLUGIN_ID ||
    !current()
  )
    return;
  const rate = target.playbackRate;
  if (current() && rate !== speed()) target.playbackRate = speed();
}
function applySpeedStep(direction: unknown, isCurrent: () => boolean): void {
  if ((direction !== 1 && direction !== -1) || !isCurrent()) return;
  const revision = configRevision;
  const targetVideo = document.querySelector<HTMLVideoElement>('video');
  if (
    !targetVideo ||
    targetVideo !== video ||
    !isCurrent() ||
    revision !== configRevision
  )
    return;
  const connected = targetVideo.isConnected;
  if (!connected || !isCurrent() || revision !== configRevision) return;
  const previous = speed();
  if (
    !Number.isFinite(previous) ||
    previous < MIN_PLAYBACK_SPEED ||
    previous > MAX_PLAYBACK_SPEED
  )
    return;
  const delta = direction * step;
  const target = Math.max(
    MIN_PLAYBACK_SPEED,
    Math.min(MAX_PLAYBACK_SPEED, roundToTwo(previous + delta)),
  );
  if (!isCurrent() || revision !== configRevision) return;
  setSpeed(target);
  // A hotkey is an explicit user claim, even when its stored setpoint clamps.
  updatePlaybackSpeed(() => isCurrent() && revision === configRevision);
}
function subscribeStep(scope: StepScope): void {
  if (!stepCurrent(scope) || scope.unsubscribe) return;
  const ipc = scope.context?.ipc;
  if (!ipc || !stepCurrent(scope)) return;
  const subscribe = ipc.subscribe;
  if (typeof subscribe !== 'function' || !stepCurrent(scope)) return;
  const revision = ++scope.subscriptionRevision;
  try {
    const unsubscribe = subscribe.call(
      ipc,
      'peard:playback-speed-step',
      (...args: unknown[]) => {
        if (args.length !== 1) return;
        const current = () =>
          stepCurrent(scope) &&
          scope.subscriptionRevision === revision &&
          scope.unsubscribe !== null;
        applySpeedStep(args[0], current);
      },
    );
    if (typeof unsubscribe !== 'function') return;
    if (stepCurrent(scope) && scope.subscriptionRevision === revision)
      scope.unsubscribe = unsubscribe;
    else unsubscribe();
  } catch (error) {
    console.warn('Unable to subscribe to playback speed shortcuts', error);
  }
}
function configureStep(
  api?: MusicPlayer,
  context?: RendererContext<PlaybackSpeedPluginConfig>,
): void | Promise<void> {
  const previous = stepScope;
  const scope: StepScope = {
    api,
    context,
    document,
    generation,
    configReady: false,
    subscriptionRevision: 0,
    unsubscribe: null,
  };
  stepScope = scope;
  releaseStep(previous)?.();
  if (!active || stepScope !== scope || generation !== scope.generation) return;
  const revision = configRevision;
  if (context)
    return Promise.resolve(context.getConfig()).then((config) => {
      if (
        active &&
        stepScope === scope &&
        generation === scope.generation &&
        document === scope.document &&
        revision === configRevision
      )
        onConfigChange(config);
    });
}

const forcePlaybackRate = (event: Event) => {
  if (
    !active ||
    event.target !== video ||
    !video ||
    getPlaybackRateOwner(video) !== PLUGIN_ID
  )
    return;
  if (video.playbackRate !== speed()) video.playbackRate = speed();
};

function detachVideo(): void {
  pitchOwner.release();
  video?.removeEventListener('ratechange', forcePlaybackRate);
  video?.removeEventListener('peard:src-changed', forcePlaybackRate);
  video?.removeEventListener(PLAYBACK_RATE_OWNER_CHANGED, forcePlaybackRate);
  video = null;
}

function refreshVideo(): void {
  const current = document.querySelector<HTMLVideoElement>('video');
  if (current === video) return;
  detachVideo();
  video = current;
  if (video) pitchOwner.set(video, preservesPitch);
  video?.addEventListener('ratechange', forcePlaybackRate);
  video?.addEventListener('peard:src-changed', forcePlaybackRate);
  video?.addEventListener(PLAYBACK_RATE_OWNER_CHANGED, forcePlaybackRate);
  if (
    video &&
    getPlaybackRateOwner(video) === PLUGIN_ID &&
    video.playbackRate !== speed()
  )
    video.playbackRate = speed();
}

function placeSlider(): void {
  if (!active) return;
  const menu = getSongMenu();
  if (
    menu &&
    !menu.contains(sliderContainer) &&
    isMusicOrVideoTrack() &&
    isPlayerMenu(menu)
  )
    menu.prepend(sliderContainer);
}

function observePopup(): void {
  const current = document.querySelector('ytmusic-popup-container');
  if (current !== popup) {
    popupObserver?.disconnect();
    popup = current;
    if (popup)
      popupObserver?.observe(popup, { childList: true, subtree: true });
  }
  placeSlider();
}

export const onConfigChange = (
  config: PlaybackSpeedConfig &
    Partial<Pick<PlaybackSpeedPluginConfig, 'step' | 'globalShortcuts'>>,
) => {
  configRevision += 1;
  step =
    typeof config.step === 'number' &&
    Number.isFinite(config.step) &&
    config.step >= 0.01 &&
    config.step <= 15.93
      ? config.step
      : 0.1;
  stepEnabled = config.enabled === true;
  preservesPitch = config.preservesPitch !== false;
  if (active && video) pitchOwner.set(video, preservesPitch);
  const scope = stepScope;
  if (scope) {
    scope.configReady = true;
    if (!stepEnabled) releaseStep(scope)?.();
    else subscribeStep(scope);
  }
};

export const onPlayerApiReady = (
  api?: MusicPlayer,
  context?: RendererContext<PlaybackSpeedPluginConfig>,
): void | Promise<void> => {
  if (retiring)
    return new Promise<void>((resolve, reject) => {
      pendingReady?.resolve();
      pendingReady = { api, context, resolve, reject };
    });
  if (active) {
    if (
      (!api && !context) ||
      (stepScope?.api === api && stepScope?.context === context)
    )
      return;
    return configureStep(api, context);
  }
  active = true;
  const currentGeneration = ++generation;
  dispose = render(
    () => (
      <PlaybackSpeedSlider
        onImmediateValueChanged={(event) => {
          if (!active || currentGeneration !== generation) return;
          let target = Number(event.detail.value ?? MIN_PLAYBACK_SPEED);
          if (isNaN(target)) target = 1;
          target = Math.min(
            Math.max(MIN_PLAYBACK_SPEED, target),
            MAX_PLAYBACK_SPEED,
          );
          // Native range value echoes are not explicit ownership changes.
          if (target === speed()) return;
          setSpeed(target);
          updatePlaybackSpeed();
        }}
        onWheel={(event) => {
          if (!active || currentGeneration !== generation) return;
          event.preventDefault();
          if (isNaN(speed())) setSpeed(1);
          const previous = speed();
          const target = roundToTwo(
            event.deltaY < 0
              ? Math.min(previous + 0.01, MAX_PLAYBACK_SPEED)
              : Math.max(previous - 0.01, MIN_PLAYBACK_SPEED),
          );
          if (target === previous) return;
          setSpeed(target);
          updatePlaybackSpeed();
        }}
        speed={speed()}
        title={t('plugins.playback-speed.templates.button')}
      />
    ),
    sliderContainer,
  );
  popupObserver = new MutationObserver(placeSlider);
  replacementObserver = new MutationObserver(() => {
    observePopup();
    refreshVideo();
  });
  // Direct child lists detect popup replacement; the movie subtree detects
  // media/container replacement without watching the whole document subtree.
  if (document.body)
    replacementObserver.observe(document.body, { childList: true });
  const player = document.querySelector('#movie_player');
  if (player)
    replacementObserver.observe(player, { childList: true, subtree: true });
  // oxlint-disable-next-line solid/reactivity -- Used as a native event callback below.
  dataHandler = () => {
    if (active) {
      refreshVideo();
      observePopup();
    }
  };
  document.addEventListener('videodatachange', dataHandler);
  observePopup();
  refreshVideo();
  pagehideHandler = () => {
    if (active && currentGeneration === generation) onUnload();
  };
  window.addEventListener('pagehide', pagehideHandler);
  return configureStep(api, context);
};

export const onUnload = (
  _context?: RendererContext<PlaybackSpeedPluginConfig>,
) => {
  if (retiring) {
    pendingReady?.resolve();
    pendingReady = null;
    return;
  }
  if (!active) return;
  retiring = true;
  try {
    active = false;
    generation += 1;
    const unsubscribe = releaseStep(stepScope);
    stepScope = null;
    stepEnabled = false;
    step = 0.1;
    if (pagehideHandler)
      window.removeEventListener('pagehide', pagehideHandler);
    pagehideHandler = null;
    releasePlaybackRate(PLUGIN_ID);
    detachVideo();
    popupObserver?.disconnect();
    replacementObserver?.disconnect();
    popupObserver = null;
    replacementObserver = null;
    popup = null;
    if (dataHandler)
      document.removeEventListener('videodatachange', dataHandler);
    dataHandler = null;
    dispose?.();
    dispose = null;
    sliderContainer.replaceChildren();
    sliderContainer.remove();
    preservesPitch = true;
    unsubscribe?.();
  } finally {
    retiring = false;
    const next = pendingReady;
    pendingReady = null;
    if (next) {
      try {
        Promise.resolve(onPlayerApiReady(next.api, next.context)).then(
          next.resolve,
          next.reject,
        );
      } catch (error) {
        next.reject(error);
      }
    }
  }
};
