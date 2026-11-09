import { t } from '@/i18n';

import type { StatusbarLyricsPluginConfig } from './config';
import type { MenuContext } from '@/types/contexts';
import type { MenuItemConstructorOptions } from 'electron';

export const menu = async ({
  getConfig,
  setConfig,
}: MenuContext<StatusbarLyricsPluginConfig>): Promise<
  MenuItemConstructorOptions[]
> => {
  const config = await getConfig();
  return [
    {
      label: t('plugins.statusbar-lyrics.pronunciation'),
      type: 'checkbox',
      checked: config.includePronunciation,
      click: (item) => setConfig({ includePronunciation: item.checked }),
    },
    {
      label: t('plugins.statusbar-lyrics.max-length'),
      submenu: [30, 55, 80].map((length) => ({
        label: String(length),
        type: 'radio',
        checked: config.maxLength === length,
        click: () => setConfig({ maxLength: length }),
      })),
    },
  ];
};
