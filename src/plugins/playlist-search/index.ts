import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { startPlaylistSearch } from './controller';
import style from './style.css?inline';

export default createPlugin<unknown, unknown, { release?: () => void }>({
  name: () => t('plugins.playlist-search.name'),
  description: () => t('plugins.playlist-search.description'),
  authors: ['donovan-yohan'],
  restartNeeded: false,
  config: { enabled: false },
  stylesheets: [style],
  renderer: {
    start() {
      this.release?.();
      this.release = startPlaylistSearch(document, {
        label: t('plugins.playlist-search.label'),
        placeholder: t('plugins.playlist-search.placeholder'),
        clear: t('plugins.playlist-search.clear'),
        results: (matches, total) =>
          t('plugins.playlist-search.results', { matches, total }),
      });
    },
    stop() {
      this.release?.();
      this.release = undefined;
    },
  },
});
