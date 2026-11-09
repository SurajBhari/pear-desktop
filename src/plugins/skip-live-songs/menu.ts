import { t } from '@/i18n';

import {
  recordingCategoryNames,
  resolveRecordingCategories,
  type SkipLiveSongsConfig,
} from './config';

import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

// Refresh creates new menus; writes from every generation of a window share one order.
const pendingWrites = new WeakMap<object, Promise<void>>();
const unsupported = (): MenuTemplate => [
  { label: t('plugins.skip-live-songs.menu.unsupported'), enabled: false },
];

export const onMenu = async (
  context: MenuContext<SkipLiveSongsConfig>,
): Promise<MenuTemplate> => {
  const { window } = context;
  if (window.isDestroyed()) return [];
  let categories;
  try {
    categories = resolveRecordingCategories(
      (await context.getConfig()).categories,
    );
  } catch {
    return window.isDestroyed() ? [] : unsupported();
  }
  if (window.isDestroyed()) return [];
  if (!categories) return unsupported();

  return recordingCategoryNames.map((category) => ({
    label: t(`plugins.skip-live-songs.menu.${category}`),
    type: 'checkbox',
    enabled: true,
    checked: categories[category],
    click(item) {
      // Electron mutates the MenuItem before this call; capture its desired value now.
      const checked = item.checked;
      if (typeof checked !== 'boolean' || window.isDestroyed()) return;
      const write = (pendingWrites.get(window) ?? Promise.resolve()).then(
        async () => {
          if (window.isDestroyed()) return;
          const latest = await context.getConfig();
          if (window.isDestroyed()) return;
          if (!resolveRecordingCategories(latest.categories)) {
            await context.refresh();
            return;
          }
          await context.setConfig({
            // setPartial merges this key without replaying stale sibling preferences.
            categories: { [category]: checked },
          });
          if (window.isDestroyed()) return;
          const stored = resolveRecordingCategories(
            (await context.getConfig()).categories,
          );
          if (window.isDestroyed()) return;
          if (!stored || stored[category] !== checked)
            throw new Error('Category preference was not persisted');
          await context.refresh();
        },
      );
      const settled = write.catch(async () => {
        console.error('[skip-live-songs] Could not save recording categories');
        if (window.isDestroyed()) return;
        try {
          await context.refresh();
        } catch {
          console.error(
            '[skip-live-songs] Could not refresh recording categories menu',
          );
        }
      });
      pendingWrites.set(window, settled);
      return settled;
    },
  }));
};
