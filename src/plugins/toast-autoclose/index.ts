import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { startToastAutoclose } from './controller';

export default createPlugin<unknown, unknown, { release?: () => void }>({
  name: () => t('plugins.toast-autoclose.name'),
  description: () => t('plugins.toast-autoclose.description'),
  authors: ['kvn1351'],
  restartNeeded: false,
  config: { enabled: false },
  renderer: {
    start() {
      this.release?.();
      this.release = startToastAutoclose(document);
    },
    stop() {
      this.release?.();
      this.release = undefined;
    },
  },
});
