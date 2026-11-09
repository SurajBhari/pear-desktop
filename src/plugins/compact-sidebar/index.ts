import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { createCompactSidebarController } from './dom';

export default createPlugin({
  name: () => t('plugins.compact-sidebar.name'),
  description: () => t('plugins.compact-sidebar.description'),
  restartNeeded: false,
  config: {
    enabled: false,
  },
  renderer: {
    controller: null as ReturnType<
      typeof createCompactSidebarController
    > | null,
    start() {
      this.controller ??= createCompactSidebarController(document);
      this.controller.start();
    },
    stop() {
      this.controller?.stop();
      this.controller = null;
    },
    onConfigChange() {
      this.controller?.start();
    },
  },
});
