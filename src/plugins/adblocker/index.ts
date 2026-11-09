import { t } from '@/i18n';
import { createBlockerBackend } from '@/providers/blocker-backend';
import { createBlockerPreload } from '@/providers/blocker-preload';
import {
  applyPendingBlockerDocument,
  getBlockerDocumentStatus,
  isBlockerDocumentApplying,
  setBlockerDocumentMenuRefresh,
} from '@/providers/blocker-scene-main';
import { createPlugin } from '@/utils';

import { createAdblockerRenderer } from './renderer';
import { blockers, type AdblockerConfig } from './types';

const sources = [
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/filters.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/quick-fixes.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/unbreak.txt',
];

const reloadNotice = () =>
  t('plugins.adblocker.apply-notice', {
    defaultValue:
      'Network filters apply immediately. Supported playback is preserved automatically; unsupported scenes show pending document changes.',
  });

export default createPlugin({
  name: () => t('plugins.adblocker.name', { defaultValue: 'Ad Blocker' }),
  description: () =>
    `${t('plugins.adblocker.description', {
      defaultValue:
        'Block advertisements using player responses, filter lists, or ad speedup.',
    })} ${reloadNotice()}`,
  restartNeeded: false,
  config: {
    enabled: true,
    cache: true,
    blocker: blockers.InPlayer,
    additionalBlockLists: [],
    disableDefaultLists: false,
  } as AdblockerConfig,
  menu: async ({ getConfig, setConfig, window, refresh }) => {
    const config = await getConfig();
    setBlockerDocumentMenuRefresh(window.webContents, 'adblocker', refresh);
    const status = getBlockerDocumentStatus(window.webContents);
    return [
      {
        label: t('plugins.adblocker.menu.blocker', { defaultValue: 'Blocker' }),
        submenu: [
          ...Object.values(blockers).map((blocker) => ({
            label: blocker,
            type: 'radio' as const,
            checked: config.blocker === blocker,
            click: async () => {
              await setConfig({ blocker });
            },
          })),
          { type: 'separator' as const },
          { label: reloadNotice(), enabled: false },
          {
            label:
              status.reason ??
              t('plugins.adblocker.applied', {
                defaultValue: 'Document effects are applied',
              }),
            enabled: false,
          },
          {
            label: t('plugins.adblocker.apply-document', {
              defaultValue:
                'Apply document changes — reload; generated recommendations can refresh',
            }),
            enabled:
              !isBlockerDocumentApplying(window.webContents) &&
              (status.kind === 'pending' ||
                status.kind === 'failed' ||
                status.kind === 'cancelled'),
            click: async () => {
              await applyPendingBlockerDocument(window.webContents);
              await refresh();
            },
          },
        ],
      },
    ];
  },
  backend: createBlockerBackend('adblocker', () => Promise.resolve(sources)),
  preload: createBlockerPreload('adblocker'),
  renderer: createAdblockerRenderer(),
});
