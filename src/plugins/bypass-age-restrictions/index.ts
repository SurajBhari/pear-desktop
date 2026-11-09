import { contextBridge } from 'electron';

import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { iife } from './vendor/bypass.js';

export default createPlugin({
  name: () => t('plugins.bypass-age-restrictions.name'),
  description: () =>
    `${t('plugins.bypass-age-restrictions.description')} ${t(
      'plugins.bypass-age-restrictions.proxy-notice',
      {
        defaultValue:
          'When needed, sends video identifiers and playback requests to youtube-proxy.zerody.one and ny.4everproxy.com. Google account credentials are excluded.',
      },
    )} ${t('plugins.bypass-age-restrictions.compatibility-notice', {
      defaultValue:
        'Experimental: current YouTube changes can prevent unlocking, and the legacy proxy may be unavailable. Sign-in may still be required.',
    })}`,
  authors: ['Zerody'],
  restartNeeded: true,
  config: { enabled: false },
  preload() {
    // The upstream function is self-contained; Electron serializes it into world 0.
    contextBridge.executeInMainWorld({ func: iife, args: [true] });
  },
});
