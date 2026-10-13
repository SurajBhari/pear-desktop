import '@total-typescript/ts-reset';

import type * as config from './config';
import type { t } from '@/i18n';
import type { RendererAudioGraph } from '@/providers/renderer-audio';
import type { VideoDataChanged } from '@/types/video-data-changed';
import type { ipcRenderer as electronIpcRenderer } from 'electron';
import type is from 'electron-is';
import type { trustedTypes } from 'trusted-types';

declare global {
  interface Compressor {
    audioSource: MediaElementAudioSourceNode;
    audioContext: AudioContext;
    audioGraph?: RendererAudioGraph;
  }

  interface DocumentEventMap {
    'peard:audio-can-play': CustomEvent<Compressor>;
    'videodatachange': CustomEvent<VideoDataChanged>;
  }

  interface Window {
    trustedTypes?: typeof trustedTypes;
    ipcRenderer: typeof electronIpcRenderer & {
      subscribe: (channel: string, listener: (...args: unknown[]) => void) => () => void;
    };
    mainConfig: typeof config;
    electronIs: typeof is;
    ELECTRON_RENDERER_URL: string | undefined;
    /**
     * Internal variable (Last interaction time)
     */
    _lact: number;
    navigation: Navigation;
    download: () => void;
    togglePictureInPicture: () => void;
    reload: () => void;
    i18n: {
      t: typeof t;
    };
  }
}
