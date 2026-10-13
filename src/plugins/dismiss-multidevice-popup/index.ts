import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { startMultideviceDismissal } from './controller';

export default createPlugin<unknown, unknown, { release?: () => void }>({
  name: () => t('plugins.dismiss-multidevice-popup.name'),
  description: () => t('plugins.dismiss-multidevice-popup.description'),
  authors: ['aashish254'],
  restartNeeded: false,
  config: { enabled: false },
  renderer: {
    start() {
      this.release?.();
      this.release = startMultideviceDismissal(document);
    },
    stop() {
      this.release?.();
      this.release = undefined;
    },
  },
});
