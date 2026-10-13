import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

import { defaultConfig } from '@/config/defaults';
import { t } from '@/i18n';
import {
  isAlbumOrPlaylist,
  isMusicOrVideoTrack,
} from '@/plugins/utils/renderer/check';
import { getSongMenu } from '@/providers/dom-elements';
import { getSongInfo } from '@/providers/song-info-front';

import { DownloaderSettings } from './settings';
import { DownloadButton } from './templates/download';

import type { DownloaderPluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';

let download: () => void;

const [downloadButtonText, setDownloadButtonText] = createSignal<string>('');

let buttonContainer: HTMLDivElement | null = null;
let disposeButton: (() => void) | undefined;
let disposeSettings: (() => void) | undefined;
let settingsDialog: HTMLDialogElement | undefined;
let rendererLoaded = false;
let rendererGeneration = 0;
let subscriptions: (() => void)[] = [];

const menuObserver = new MutationObserver(() => {
  const menu = getSongMenu();

  if (
    !menu ||
    menu.contains(buttonContainer) ||
    !(isMusicOrVideoTrack() || isAlbumOrPlaylist()) ||
    !buttonContainer
  ) {
    return;
  }

  menu.prepend(buttonContainer);
});

export const onRendererLoad = ({
  ipc,
}: RendererContext<DownloaderPluginConfig>) => {
  if (rendererLoaded) onRendererStop();
  rendererLoaded = true;
  const generation = ++rendererGeneration;
  let opening = false;
  const subscribe = (event: string, listener: CallableFunction) => {
    if (ipc.subscribe) subscriptions.push(ipc.subscribe(event, listener));
    else {
      ipc.on(event, listener);
      subscriptions.push(() => ipc.removeAllListeners(event));
    }
  };
  subscribe('downloader-open-settings', async () => {
    if (opening) return;
    if (settingsDialog?.isConnected) {
      settingsDialog.focus();
      return;
    }
    const previousFocus = document.activeElement as HTMLElement | null;
    opening = true;
    try {
      const initial = (await ipc.invoke('downloader-settings')) as {
        config: DownloaderPluginConfig;
        library?: import('./library').LibraryReport;
        review?: { id: string; title: string; reason: string }[];
      };
      if (!rendererLoaded || generation !== rendererGeneration) return;
      const dialog = document.createElement('dialog');
      dialog.className = 'pear-downloader-settings';
      dialog.setAttribute('aria-labelledby', 'pear-downloader-heading');
      const close = () => {
        disposeSettings?.();
        disposeSettings = undefined;
        dialog.remove();
        if (settingsDialog === dialog) settingsDialog = undefined;
        previousFocus?.focus();
      };
      dialog.addEventListener('close', close, { once: true });
      disposeSettings = render(
        () => (
          <DownloaderSettings
            api={{
              invoke: (event, ...args) => ipc.invoke(event, ...args),
              currentUrl: () => getSongInfo().url || window.location.href,
              close: () => dialog.close(),
            }}
            initial={initial}
          />
        ),
        dialog,
      );
      document.body.append(dialog);
      settingsDialog = dialog;
      dialog.showModal();
    } catch (error) {
      console.error('Downloader settings unavailable', error);
    } finally {
      opening = false;
    }
  });
  download = () => {
    const songMenu = getSongMenu();

    let videoUrl = songMenu
      ?.querySelector(
        'ytmusic-menu-navigation-item-renderer[tabindex="0"] #navigation-endpoint',
      )
      ?.getAttribute('href');

    if (!videoUrl && songMenu) {
      for (const it of songMenu.querySelectorAll(
        'ytmusic-menu-navigation-item-renderer[tabindex="-1"] #navigation-endpoint',
      )) {
        if (it.getAttribute('href')?.includes('podcast/')) {
          videoUrl = it.getAttribute('href');
          break;
        }
      }
    }

    if (videoUrl) {
      if (videoUrl.startsWith('watch?')) {
        videoUrl = defaultConfig.url + '/' + videoUrl;
      }

      if (videoUrl.startsWith('podcast/')) {
        videoUrl =
          defaultConfig.url + '/watch?' + videoUrl.replace('podcast/', 'v=');
      }

      if (videoUrl.includes('?playlist=')) {
        ipc.invoke('download-playlist-request', videoUrl);
        return;
      }
    } else {
      videoUrl = getSongInfo().url || window.location.href;
    }

    ipc.invoke('download-song', videoUrl);
  };

  subscribe('downloader-feedback', (feedback: string) => {
    const targetHtml = feedback || t('plugins.downloader.templates.button');
    setDownloadButtonText(targetHtml);
  });
};

export const onPlayerApiReady = () => {
  buttonContainer?.remove();
  setDownloadButtonText(t('plugins.downloader.templates.button'));

  buttonContainer = document.createElement('div');
  buttonContainer.classList.add(
    'style-scope',
    'menu-item',
    'ytmusic-menu-popup-renderer',
  );
  buttonContainer.setAttribute('aria-disabled', 'false');
  buttonContainer.setAttribute('aria-selected', 'false');
  buttonContainer.setAttribute('role', 'option');
  buttonContainer.setAttribute('tabindex', '-1');

  disposeButton?.();
  disposeButton = render(
    () => <DownloadButton onClick={download} text={downloadButtonText()} />,
    buttonContainer,
  );

  menuObserver.observe(document.querySelector('ytmusic-popup-container')!, {
    childList: true,
    subtree: true,
  });
};
export const onRendererStop = () => {
  rendererGeneration++;
  rendererLoaded = false;
  menuObserver.disconnect();
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions = [];
  settingsDialog?.close();
  settingsDialog?.remove();
  settingsDialog = undefined;
  disposeSettings?.();
  disposeSettings = undefined;
  disposeButton?.();
  disposeButton = undefined;
  buttonContainer?.remove();
  buttonContainer = null;
};
