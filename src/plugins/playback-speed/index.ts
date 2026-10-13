import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { onConfigChange, onPlayerApiReady, onUnload } from './renderer';

export interface PlaybackSpeedConfig {
  enabled: boolean;
  preservesPitch: boolean;
}

export default createPlugin({
  name: () => t('plugins.playback-speed.name'),
  description: () => t('plugins.playback-speed.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    preservesPitch: true,
  },
  menu: async ({ getConfig, setConfig }) => [
    {
      label: t('plugins.playback-speed.menu.preserve-pitch'),
      type: 'checkbox',
      checked: (await getConfig()).preservesPitch !== false,
      click: (item) => setConfig({ preservesPitch: item.checked }),
    },
  ],
  renderer: {
    stop: onUnload,
    onPlayerApiReady,
    onConfigChange,
  },
});
