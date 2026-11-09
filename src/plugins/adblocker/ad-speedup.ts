import {
  beginAdSpeedupOverride,
  endAdSpeedupOverride,
  getUnforcedPlaybackRate,
} from '@/plugins/utils/renderer/playback-rate-owner';

export const createAdSpeedup = (doc: Document = document) => {
  let observer: MutationObserver | undefined;
  let current: HTMLVideoElement | null = null;
  let previous: { playbackRate: number; muted: boolean } | undefined;
  const restore = () => {
    if (current && previous) {
      // A later explicit user/plugin change takes precedence over our override.
      const restoring = current.playbackRate === 16;
      if (restoring)
        current.playbackRate = getUnforcedPlaybackRate(
          current,
          previous.playbackRate,
        );
      if (current.muted) current.muted = previous.muted;
      endAdSpeedupOverride(current, restoring);
    }
    current = null;
    previous = undefined;
  };
  const update = () => {
    const player = doc.querySelector('#movie_player');
    const video = player?.querySelector('video') ?? null;
    const showing =
      !!player &&
      (player.classList.contains('ad-showing') ||
        player.classList.contains('ad-interrupting'));
    if (current && (current !== video || !showing)) restore();
    if (!showing || !video) return;
    if (!previous) {
      current = video;
      previous = { playbackRate: video.playbackRate, muted: video.muted };
      beginAdSpeedupOverride(video, previous.playbackRate);
      video.playbackRate = 16;
      video.muted = true;
    }
    player
      .querySelector<HTMLButtonElement>(
        'button.ytp-ad-skip-button-modern, button.ytp-skip-ad-button',
      )
      ?.click();
  };
  const stop = () => {
    observer?.disconnect();
    observer = undefined;
    restore();
  };
  const start = () => {
    if (observer) return;
    const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
    observer = new Observer(update);
    observer.observe(doc, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    update();
  };
  return { start, stop };
};
