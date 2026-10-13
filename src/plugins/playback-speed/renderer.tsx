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
  isPlaybackRateOwner,
  PLAYBACK_RATE_OWNER_CHANGED,
  releasePlaybackRate,
} from '@/plugins/utils/renderer/playback-rate-owner';
import { getSongMenu } from '@/providers/dom-elements';

import { PlaybackSpeedSlider } from './components/slider';

import type { PlaybackSpeedConfig } from './index';
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
const pitchOwner = createPlaybackPitchOwner(PLUGIN_ID);

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

export const onConfigChange = (config: PlaybackSpeedConfig) => {
  configRevision += 1;
  preservesPitch = config.preservesPitch !== false;
  if (active && video) pitchOwner.set(video, preservesPitch);
};

export const onPlayerApiReady = (
  _player?: MusicPlayer,
  context?: RendererContext<PlaybackSpeedConfig>,
) => {
  if (active) return;
  active = true;
  const currentGeneration = ++generation;
  const updatePlaybackSpeed = () => {
    claimPlaybackRate(PLUGIN_ID, speed());
    const current = document.querySelector<HTMLVideoElement>('video');
    if (
      current &&
      isPlaybackRateOwner(PLUGIN_ID, current) &&
      current.playbackRate !== speed()
    )
      current.playbackRate = speed();
  };
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
  const revision = configRevision;
  if (context)
    return Promise.resolve(context.getConfig()).then((config) => {
      if (
        active &&
        currentGeneration === generation &&
        revision === configRevision
      )
        onConfigChange(config);
    });
  return;
};

export const onUnload = () => {
  if (!active) return;
  active = false;
  generation += 1;
  releasePlaybackRate(PLUGIN_ID);
  detachVideo();
  popupObserver?.disconnect();
  replacementObserver?.disconnect();
  popupObserver = null;
  replacementObserver = null;
  popup = null;
  if (dataHandler) document.removeEventListener('videodatachange', dataHandler);
  dataHandler = null;
  dispose?.();
  dispose = null;
  sliderContainer.replaceChildren();
  sliderContainer.remove();
  preservesPitch = true;
};
