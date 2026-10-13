import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import style from './style.css?inline';

const IDLE_MS = 2500;
const ACTIVE = 'fullscreen-auto-hide--active';
const IDLE = 'fullscreen-auto-hide--idle';

// Adapt #4664 with owned cancellation, style preservation and focus handling.
function setup() {
  let disposed = false;
  let playerBar: HTMLElement | null = null;
  let video: HTMLVideoElement | null = null;
  let timer: number | undefined;
  let focused = document.hasFocus();
  let barObserver: MutationObserver | undefined;
  const clearTimer = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const fullscreen = () => !!playerBar?.hasAttribute('player-fullscreened');
  const mayHide = () =>
    !disposed &&
    fullscreen() &&
    focused &&
    !!video &&
    !video.paused &&
    !video.ended &&
    !playerBar?.contains(document.activeElement);
  const wake = () => {
    if (disposed) return;
    clearTimer();
    document.body.classList.remove(IDLE);
    document.body.classList.toggle(ACTIVE, fullscreen());
    if (mayHide())
      timer = window.setTimeout(() => {
        timer = undefined;
        if (mayHide()) document.body.classList.add(IDLE);
      }, IDLE_MS);
  };
  const mediaEvents = ['play', 'pause', 'ended', 'seeking', 'emptied'] as const;
  const syncNodes = () => {
    if (disposed) return;
    const nextBar = playerBar?.isConnected
      ? playerBar
      : document.querySelector<HTMLElement>('ytmusic-player-bar');
    const nextVideo = video?.isConnected
      ? video
      : document.querySelector<HTMLVideoElement>('video');
    if (nextBar === playerBar && nextVideo === video) return;
    clearTimer();
    barObserver?.disconnect();
    for (const event of mediaEvents) video?.removeEventListener(event, wake);
    playerBar = nextBar;
    video = nextVideo;
    if (playerBar) {
      barObserver = new MutationObserver(wake);
      barObserver.observe(playerBar, {
        attributes: true,
        attributeFilter: ['player-fullscreened'],
      });
    }
    for (const event of mediaEvents) video?.addEventListener(event, wake);
    wake();
  };
  const activity = [
    'mousemove',
    'mousedown',
    'keydown',
    'touchstart',
    'focusin',
    'focusout',
  ] as const;
  for (const event of activity)
    document.addEventListener(event, wake, { passive: true });
  const blur = () => {
    focused = false;
    wake();
  };
  const focus = () => {
    focused = true;
    wake();
  };
  window.addEventListener('blur', blur);
  window.addEventListener('focus', focus);
  // Connected nodes need only an O(1) ownership check on child mutations.
  const documentObserver = new MutationObserver(syncNodes);
  documentObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  syncNodes();
  return () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    documentObserver.disconnect();
    barObserver?.disconnect();
    for (const event of mediaEvents) video?.removeEventListener(event, wake);
    for (const event of activity) document.removeEventListener(event, wake);
    window.removeEventListener('blur', blur);
    window.removeEventListener('focus', focus);
    document.body.classList.remove(ACTIVE, IDLE);
    playerBar = null;
    video = null;
  };
}

export default createPlugin<
  unknown,
  unknown,
  { cleanup: (() => void) | null },
  { enabled: boolean }
>({
  name: () => t('plugins.fullscreen-auto-hide.name'),
  description: () => t('plugins.fullscreen-auto-hide.description'),
  config: { enabled: false },
  restartNeeded: false,
  stylesheets: [style],
  renderer: {
    cleanup: null,
    start() {
      this.cleanup?.();
      this.cleanup = setup();
    },
    stop() {
      this.cleanup?.();
      this.cleanup = null;
    },
  },
});
