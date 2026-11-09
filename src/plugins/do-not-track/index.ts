import { net } from 'electron';
import * as z from 'zod';

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

import { blockers } from './types';

import type { AdblockerConfig } from '@/plugins/adblocker/types';

export type TrackerBlockerConfig = AdblockerConfig;

const reloadNotice = () =>
  t('plugins.adblocker.apply-notice', {
    defaultValue:
      'Network filters apply immediately. Supported playback is preserved automatically; unsupported scenes show pending document changes.',
  });

const defaultLists = async (): Promise<string[]> => {
  const response = await net.fetch(
    'https://raw.githubusercontent.com/organization/tb-list/refs/heads/main/tb.json',
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok)
    throw new Error(`Tracker list manifest returned ${response.status}`);
  return z.object({ tb: z.array(z.string()) }).parse(await response.json()).tb;
};

export default createPlugin({
  name: () => t('plugins.do-not-track.name'),
  description: () =>
    `${t('plugins.do-not-track.description')} ${reloadNotice()}`,
  restartNeeded: false,
  config: {
    enabled: false,
    cache: true,
    blocker: blockers.InPlayer,
    additionalBlockLists: [],
    disableDefaultLists: false,
  } as TrackerBlockerConfig,
  menu: async ({ getConfig, setConfig, window, refresh }) => {
    const config = await getConfig();
    setBlockerDocumentMenuRefresh(window.webContents, 'do-not-track', refresh);
    const status = getBlockerDocumentStatus(window.webContents);
    return [
      {
        label: t('plugins.do-not-track.menu.blocker'),
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
  backend: createBlockerBackend('do-not-track', defaultLists),
  preload: createBlockerPreload('do-not-track'),
});
