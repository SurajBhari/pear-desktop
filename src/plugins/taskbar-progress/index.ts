import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend } from './main';

export default createPlugin({
  name: () => t('plugins.taskbar-progress.name'),
  description: () => t('plugins.taskbar-progress.description'),
  restartNeeded: false,
  config: { enabled: false },
  backend,
});
