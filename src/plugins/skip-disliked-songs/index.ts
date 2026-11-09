import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import type { GetState } from '@/types/datahost-get-state';
import type { MusicPlayer } from '@/types/music-player';

const CONFIRM_DELAY_MS = 1000;
let active = false;
let button: HTMLElement | null = null;
let api: MusicPlayer | undefined;
let observer: MutationObserver | undefined;
let domObserver: MutationObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let statusVideoId = '';
let lastStatus: string | null = null;
let skippedVideoId = '';
let observedVideoId = '';

const trackStatus = (videoId: string) => {
  const bar = document.querySelector<
    HTMLElement & { getState?: () => GetState }
  >('ytmusic-player-bar');
  try {
    return bar?.getState?.()?.likeStatus?.videos?.[videoId];
  } catch {
    return undefined;
  }
};

const cancel = () => {
  clearTimeout(timer);
  timer = undefined;
};

// Confirmation from #4618 (@jirafey); additionally fence stale track DOM.
const proposeSkip = () => {
  cancel();
  const videoId = api?.getVideoData?.()?.video_id;
  if (!active || !videoId || !button) return;
  if (videoId !== observedVideoId) {
    observedVideoId = videoId;
    skippedVideoId = '';
  }
  const domStatus = button.getAttribute('like-status');
  if (domStatus !== lastStatus) {
    lastStatus = domStatus;
    statusVideoId = videoId;
  }
  const keyedStatus = trackStatus(videoId);
  const status = keyedStatus ?? domStatus;
  if (status !== 'DISLIKE') skippedVideoId = '';
  if (
    status !== 'DISLIKE' ||
    (keyedStatus === undefined && statusVideoId !== videoId) ||
    skippedVideoId === videoId
  )
    return;
  const player = api;
  const target = button;
  const usesKeyedStatus = keyedStatus !== undefined;
  timer = setTimeout(() => {
    timer = undefined;
    if (
      !active ||
      api !== player ||
      button !== target ||
      player?.getVideoData?.()?.video_id !== videoId ||
      (usesKeyedStatus
        ? String(trackStatus(videoId)) !== 'DISLIKE'
        : statusVideoId !== videoId ||
          target.getAttribute('like-status') !== 'DISLIKE') ||
      !target.isConnected ||
      skippedVideoId === videoId
    )
      return;
    skippedVideoId = videoId;
    player.nextVideo();
  }, CONFIRM_DELAY_MS);
};

const attachButton = () => {
  if (!active) return;
  const current = document.querySelector<HTMLElement>('#like-button-renderer');
  if (current === button) return;
  cancel();
  observer?.disconnect();
  button = current;
  if (!current) return;
  lastStatus = current.getAttribute('like-status');
  statusVideoId = api?.getVideoData?.()?.video_id ?? '';
  observer = new MutationObserver(proposeSkip);
  observer.observe(current, {
    attributes: true,
    attributeFilter: ['like-status'],
  });
  proposeSkip();
};

export default createPlugin({
  name: () => t('plugins.skip-disliked-songs.name'),
  description: () => t('plugins.skip-disliked-songs.description'),
  restartNeeded: false,
  renderer: {
    start() {
      this.stop();
      active = true;
      domObserver = new MutationObserver(attachButton);
      domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      attachButton();
    },
    onPlayerApiReady(playerApi: MusicPlayer) {
      if (!active) return;
      api?.removeEventListener('videodatachange', proposeSkip);
      api = playerApi;
      api.addEventListener('videodatachange', proposeSkip);
      if (!statusVideoId) statusVideoId = api.getVideoData?.()?.video_id ?? '';
      proposeSkip();
    },
    stop() {
      active = false;
      cancel();
      observer?.disconnect();
      domObserver?.disconnect();
      api?.removeEventListener('videodatachange', proposeSkip);
      api = undefined;
      observer = domObserver = undefined;
      button = null;
      statusVideoId = '';
      lastStatus = null;
      skippedVideoId = observedVideoId = '';
    },
  },
});
