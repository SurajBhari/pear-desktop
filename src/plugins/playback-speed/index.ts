import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend } from './main';
import { onMenu } from './menu';
import { onConfigChange, onPlayerApiReady, onUnload } from './renderer';

export interface PlaybackSpeedConfig {
  enabled: boolean;
  preservesPitch: boolean;
}

export interface PlaybackSpeedPluginConfig extends PlaybackSpeedConfig {
  step: number;
  globalShortcuts: { speedUp: string; speedDown: string };
}

export default createPlugin({
  name: () => t('plugins.playback-speed.name'),
  description: () => t('plugins.playback-speed.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    preservesPitch: true,
    step: 0.1,
    globalShortcuts: { speedUp: '', speedDown: '' },
  },
  menu: onMenu,
  backend,
  renderer: {
    stop: onUnload,
    onPlayerApiReady,
    onConfigChange,
  },
});
