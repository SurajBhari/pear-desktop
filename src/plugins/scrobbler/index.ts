import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { defaultConfig } from './config';
import { backend } from './main';
import { onMenu } from './menu';
export { defaultConfig } from './config';
export type { ScrobblerPluginConfig } from './config';
export default createPlugin({
  name: () => t('plugins.scrobbler.name'),
  description: () => t('plugins.scrobbler.description'),
  restartNeeded: false,
  config: defaultConfig,
  menu: onMenu,
  backend,
});
