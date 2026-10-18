import { t } from '@/i18n';
import { createPlugin } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { menu } from './menu';
import style from './style.css?inline';
import { type AmbientModePluginConfig } from './types';

import type { RendererContext } from '@/types/contexts';

const defaultConfig: AmbientModePluginConfig = {
  enabled: false,
  quality: 50,
  buffer: 30,
  interpolationTime: 1500,
  blur: 100,
  size: 100,
  opacity: 1,
  fullscreen: false,
};

type AmbientAttachment = {
  alive: boolean;
  update: () => void;
  retire: () => void;
};
type AmbientSession = {
  ticket: number;
  alive: boolean;
  observer: MutationObserver | null;
  fallback: ReturnType<typeof setInterval> | null;
  attachment: AmbientAttachment | null;
  attachmentTicket: number;
};

function createAmbientRenderer() {
  let ticket = 0;
  let current: AmbientSession | null = null;
  const owns = (owner: AmbientSession) =>
    current === owner && owner.alive && owner.ticket === ticket;
  const retire = (owner: AmbientSession | null) => {
    if (!owner?.alive) return;
    owner.alive = false;
    const observer = owner.observer;
    owner.observer = null;
    observer?.disconnect();
    const fallback = owner.fallback;
    owner.fallback = null;
    if (fallback !== null) clearInterval(fallback);
    owner.attachment?.retire();
    owner.attachment = null;
  };
  const resetPointers = () => {
    renderer.unregister = null;
    renderer.update = null;
    renderer.interval = null;
    renderer.lastMediaType = null;
    renderer.lastVideoSource = null;
    renderer.lastImageSource = null;
  };
  const configure = (config: AmbientModePluginConfig) => {
    renderer.interpolationTime = config.interpolationTime;
    renderer.buffer = config.buffer;
    renderer.qualityRatio = config.quality;
    renderer.size = config.size;
    renderer.blur = config.blur;
    renderer.opacity = config.opacity;
    renderer.isFullscreen = config.fullscreen;
  };
  const renderer = {
    interpolationTime: defaultConfig.interpolationTime,
    buffer: defaultConfig.buffer,
    qualityRatio: defaultConfig.quality,
    size: defaultConfig.size,
    blur: defaultConfig.blur,
    opacity: defaultConfig.opacity,
    isFullscreen: defaultConfig.fullscreen,
    unregister: null as (() => void) | null,
    update: null as (() => void) | null,
    interval: null as ReturnType<typeof setInterval> | null,
    lastMediaType: null as 'video' | 'image' | null,
    lastVideoSource: null as string | null,
    lastImageSource: null as string | null,

    async start({
      getConfig,
    }: RendererContext<AmbientModePluginConfig>): Promise<void> {
      const previous = current;
      const owner: AmbientSession = {
        ticket: ++ticket,
        alive: true,
        observer: null,
        fallback: null,
        attachment: null,
        attachmentTicket: 0,
      };
      // Claim before retiring: an old cleanup cannot release a newer session.
      current = owner;
      resetPointers();
      retire(previous);
      if (!owns(owner)) return;
      const config = await getConfig();
      if (!owns(owner)) return;
      configure(config);

      const songImage = document.querySelector<HTMLImageElement>('#song-image');
      const songVideo = document.querySelector<HTMLDivElement>('#song-video');
      const image = songImage?.querySelector<HTMLImageElement>(
        'yt-img-shadow > img',
      );
      // This helper remains uncancellable. Gate its continuation, not its promise.
      const video = await waitForElement<HTMLVideoElement>(
        '.html5-video-container > video',
      );
      if (!owns(owner)) return;
      const videoWrapper = document.querySelector(
        '#song-video > .player-wrapper',
      );

      const injectBlurImage = () => {
        if (!owns(owner) || !songImage || !image) return;
        renderer.lastImageSource = image.src;
        const blurImage = document.createElement('img');
        blurImage.classList.add('html5-blur-image');
        blurImage.src = image.src;
        const attachment: AmbientAttachment = {
          alive: true,
          update() {
            if (
              !owns(owner) ||
              !attachment.alive ||
              owner.attachment !== attachment
            )
              return;
            if (renderer.isFullscreen) blurImage.classList.add('fullscreen');
            else blurImage.classList.remove('fullscreen');
            blurImage.style.setProperty('--width', `${renderer.size}%`);
            blurImage.style.setProperty('--height', `${renderer.size}%`);
            blurImage.style.setProperty('--blur', `${renderer.blur}px`);
            blurImage.style.setProperty('--opacity', `${renderer.opacity}`);
          },
          retire() {
            if (!attachment.alive) return;
            attachment.alive = false;
            if (blurImage.isConnected) blurImage.remove();
            if (owner.attachment === attachment) owner.attachment = null;
            if (owns(owner) && renderer.unregister === attachment.retire) {
              renderer.unregister = null;
              renderer.update = null;
            }
          },
        };
        owner.attachment = attachment;
        renderer.unregister = attachment.retire;
        renderer.update = attachment.update;
        attachment.update();
        if (owns(owner) && attachment.alive) songImage.prepend(blurImage);
        else attachment.retire();
      };

      const injectBlurVideo = () => {
        if (!owns(owner) || !songVideo || !video || !videoWrapper) return;
        renderer.lastVideoSource = video.src;
        const blurCanvas = document.createElement('canvas');
        blurCanvas.classList.add('html5-blur-canvas');
        const context = blurCanvas.getContext('2d');
        let frame: number | null = null;
        let paintInterval: ReturnType<typeof setInterval> | null = null;
        let paintPeriod: number | null = null;
        let hasDrawnOnce = false;
        let redrawRequested = false;
        const alive = () =>
          owns(owner) && attachment.alive && owner.attachment === attachment;
        const playing = () => !video.paused && !video.ended;
        const ready = () => video.readyState >= 2;
        const cancelFrame = () => {
          if (frame !== null) cancelAnimationFrame(frame);
          frame = null;
        };
        const stopPainting = () => {
          if (paintInterval !== null) clearInterval(paintInterval);
          paintInterval = null;
          paintPeriod = null;
        };
        const scheduleFrame = () => {
          if (
            !alive() ||
            !context ||
            frame !== null ||
            !ready() ||
            (!redrawRequested && !playing())
          )
            return;
          const handle = requestAnimationFrame(() => {
            if (frame !== handle) return;
            frame = null;
            if (!alive() || !ready() || (!redrawRequested && !playing()))
              return;
            const width = renderer.qualityRatio;
            let height = Math.max(
              Math.floor((blurCanvas.height / blurCanvas.width) * width),
              1,
            );
            if (!Number.isFinite(height)) height = width;
            if (!height) return;
            // Retain pixels: only the first frame after a real resize is opaque.
            const frameAlpha =
              renderer.interpolationTime > 0
                ? (1 / renderer.buffer) * (1000 / renderer.interpolationTime)
                : 1;
            context.globalAlpha = hasDrawnOnce ? Math.min(frameAlpha, 1) : 1;
            context.drawImage(video, 0, 0, width, height);
            hasDrawnOnce = true;
            redrawRequested = false;
          });
          frame = handle;
        };
        const reconcilePlayback = () => {
          if (!alive()) return;
          if (!playing()) {
            stopPainting();
            if (!redrawRequested) cancelFrame();
          } else {
            const period = Math.max(1, Math.ceil(1000 / renderer.buffer));
            if (paintInterval !== null && paintPeriod !== period)
              stopPainting();
            if (paintInterval === null) {
              const handle = setInterval(() => {
                if (!alive() || paintInterval !== handle) return;
                if (!playing()) reconcilePlayback();
                else scheduleFrame();
              }, period);
              paintInterval = handle;
              paintPeriod = period;
            }
          }
          if (redrawRequested) scheduleFrame();
        };
        const requestRedraw = () => {
          if (!alive()) return;
          redrawRequested = true;
          reconcilePlayback();
        };
        const onRedraw = () => attachment.update();
        const attachment: AmbientAttachment = {
          alive: true,
          update() {
            if (!alive()) return;
            const rect = video.getBoundingClientRect();
            const newWidth = Math.floor(video.width || rect.width);
            const newHeight = Math.floor(video.height || rect.height);
            if (newWidth === 0 || newHeight === 0) {
              requestRedraw();
              return;
            }
            const width = renderer.qualityRatio;
            const height = Math.floor(
              (newHeight / newWidth) * renderer.qualityRatio,
            );
            if (blurCanvas.width !== width || blurCanvas.height !== height) {
              blurCanvas.width = width;
              blurCanvas.height = height;
              hasDrawnOnce = false;
            }
            if (renderer.isFullscreen) blurCanvas.classList.add('fullscreen');
            else blurCanvas.classList.remove('fullscreen');
            blurCanvas.style.setProperty('--width', `${renderer.size}%`);
            blurCanvas.style.setProperty('--height', `${renderer.size}%`);
            blurCanvas.style.setProperty('--blur', `${renderer.blur}px`);
            blurCanvas.style.setProperty('--opacity', `${renderer.opacity}`);
            requestRedraw();
          },
          retire() {
            if (!attachment.alive) return;
            attachment.alive = false;
            stopPainting();
            cancelFrame();
            redrawRequested = false;
            video.removeEventListener('pause', reconcilePlayback);
            video.removeEventListener('play', reconcilePlayback);
            video.removeEventListener('ended', reconcilePlayback);
            video.removeEventListener('loadeddata', onRedraw);
            video.removeEventListener('seeked', onRedraw);
            video.removeEventListener('resize', onRedraw);
            if (blurCanvas.isConnected) blurCanvas.remove();
            if (owner.attachment === attachment) owner.attachment = null;
            if (owns(owner) && renderer.unregister === attachment.retire) {
              renderer.unregister = null;
              renderer.update = null;
            }
          },
        };
        owner.attachment = attachment;
        renderer.unregister = attachment.retire;
        renderer.update = attachment.update;
        video.addEventListener('pause', reconcilePlayback);
        video.addEventListener('play', reconcilePlayback);
        video.addEventListener('ended', reconcilePlayback);
        video.addEventListener('loadeddata', onRedraw);
        video.addEventListener('seeked', onRedraw);
        video.addEventListener('resize', onRedraw);
        attachment.update();
        if (alive()) videoWrapper.prepend(blurCanvas);
        else attachment.retire();
      };

      const isVideoMode = () => {
        const songVideo = document.querySelector<HTMLDivElement>('#song-video');
        if (!songVideo) {
          renderer.lastMediaType = 'image';
          return false;
        }
        const isVideo = getComputedStyle(songVideo).display !== 'none';
        renderer.lastMediaType = isVideo ? 'video' : 'image';
        return isVideo;
      };
      const playerPage = document.querySelector<HTMLElement>('#player-page');
      const ytmusicAppLayout = document.querySelector<HTMLElement>('#layout');
      const retireAttachment = () => {
        const claim = ++owner.attachmentTicket;
        const previous = owner.attachment;
        owner.attachment = null;
        renderer.unregister = null;
        renderer.update = null;
        previous?.retire();
        return claim;
      };
      const injectBlurElement = (force?: boolean): boolean | void => {
        if (!owns(owner)) return;
        const isPageOpen = ytmusicAppLayout?.hasAttribute('player-page-open');
        if (isPageOpen) {
          const isVideo = isVideoMode();
          if (!force && owner.attachment) {
            if (
              renderer.lastMediaType === 'video' &&
              renderer.lastVideoSource === video?.src
            )
              return false;
            if (
              renderer.lastMediaType === 'image' &&
              renderer.lastImageSource === image?.src
            )
              return false;
          }
          // Claim before cleanup: synchronous reentry may install a newer owner.
          const claim = retireAttachment();
          if (!owns(owner) || owner.attachmentTicket !== claim) return;
          if (isVideo) injectBlurVideo();
          else injectBlurImage();
        } else {
          retireAttachment();
        }
      };
      const observer = new MutationObserver((mutationsList) => {
        if (!owns(owner)) return;
        for (const mutation of mutationsList) {
          if (mutation.type === 'attributes') {
            injectBlurElement(true);
            break;
          }
        }
      });
      if (!owns(owner)) {
        observer.disconnect();
        return;
      }
      owner.observer = observer;
      if (playerPage) {
        observer.observe(playerPage, { attributes: true });
        const fallback = setInterval(() => {
          if (owns(owner) && owner.fallback === fallback) injectBlurElement();
        }, 1000);
        owner.fallback = fallback;
        renderer.interval = fallback;
      }
    },
    onConfigChange(newConfig: AmbientModePluginConfig): void {
      configure(newConfig);
      renderer.update?.();
    },
    stop(): void {
      const owner = current;
      current = null;
      ticket++;
      resetPointers();
      retire(owner);
    },
  };
  return renderer;
}

export default createPlugin({
  name: () => t('plugins.ambient-mode.name'),
  description: () => t('plugins.ambient-mode.description'),
  restartNeeded: false,
  config: defaultConfig,
  stylesheets: [style],
  menu: menu,

  renderer: createAmbientRenderer(),
});
