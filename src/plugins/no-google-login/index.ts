import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { createLoginControlHider } from './dom';

export default createPlugin({
  name: () => t('plugins.no-google-login.name'),
  description: () => t('plugins.no-google-login.description'),
  restartNeeded: false,
  config: {
    enabled: false,
  },
  renderer: {
    hider: null as ReturnType<typeof createLoginControlHider> | null,
    start() {
      this.hider ??= createLoginControlHider(document);
      this.hider.start();
    },
    stop() {
      this.hider?.stop();
      this.hider = null;
    },
  },
});
