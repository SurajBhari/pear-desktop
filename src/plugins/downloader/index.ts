import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { onConfigChange, onMainLoad, onMainStop } from './main';
import { onMenu } from './menu';
import { onPlayerApiReady, onRendererLoad, onRendererStop } from './renderer';
import style from './style.css?inline';

import type { AudioPreference, DuplicatePolicy } from './audio';
import type { Preset } from './types';

export type DownloaderPluginConfig = {
  enabled: boolean;
  downloadFolder?: string;
  downloadOnFinish?: {
    enabled: boolean;
    seconds: number;
    percent: number;
    mode: 'percent' | 'seconds';
    folder?: string;
  };
  selectedPreset: string;
  customPresetSetting?: Preset;
  skipExisting: boolean;
  playlistMaxItems?: number;
  sourceAudio?: AudioPreference;
  sourceFallback?: boolean;
  duplicatePolicy?: DuplicatePolicy;
};

export const defaultConfig: DownloaderPluginConfig = {
  enabled: false,
  downloadFolder: undefined,
  downloadOnFinish: {
    enabled: false,
    seconds: 20,
    percent: 10,
    mode: 'seconds',
    folder: undefined,
  },
  selectedPreset: 'mp3 (256kbps)', // Selected preset
  // Merge defaults must not prepend arguments to a saved Custom recipe.
  customPresetSetting: undefined,
  skipExisting: false,
  playlistMaxItems: undefined,
  sourceAudio: { mode: 'best', language: 'original', drc: false },
  sourceFallback: false,
  duplicatePolicy: 'legacy',
};

export default createPlugin({
  name: () => t('plugins.downloader.name'),
  description: () => t('plugins.downloader.description'),
  restartNeeded: true,
  config: defaultConfig,
  stylesheets: [style],
  menu: onMenu,
  backend: {
    start: onMainLoad,
    stop: onMainStop,
    onConfigChange,
  },
  renderer: {
    start: onRendererLoad,
    stop: onRendererStop,
    onPlayerApiReady,
  },
});
