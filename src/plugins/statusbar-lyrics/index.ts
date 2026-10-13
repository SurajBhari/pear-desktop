import { t } from '@/i18n';
import { Platform } from '@/types/plugins';
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { defaultConfig } from './config';
import { menu } from './menu';
import { renderer } from './renderer';

export type { StatusbarLyricsPluginConfig } from './config';
export default createPlugin({
  name: () => t('plugins.statusbar-lyrics.name'),
  description: () => t('plugins.statusbar-lyrics.description'),
  authors: ['evan20010126'],
  restartNeeded: false,
  platform: Platform.macOS,
  config: defaultConfig,
  menu,
  backend,
  renderer,
});
