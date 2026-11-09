import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { onConfigChange, onMainLoad, onMainStop } from './main';
import { onMenu } from './menu';
import { ratingFeedbackRenderer } from './rating-feedback-renderer';

export interface NotificationsPluginConfig {
  enabled: boolean;
  unpauseNotification: boolean;
  notifyOnLikeChange: boolean;
  /**
   * Has effect only on Linux
   */
  urgency: 'low' | 'normal' | 'critical';
  /**
   * the following has effect only on Windows
   */
  interactive: boolean;
  /**
   * See plugins/notifications/utils for more info
   */
  toastStyle: number;
  refreshOnPlayPause: boolean;
  trayControls: boolean;
  hideButtonText: boolean;
}

export const defaultConfig: NotificationsPluginConfig = {
  enabled: false,
  unpauseNotification: false,
  notifyOnLikeChange: false,
  urgency: 'normal',
  interactive: true,
  toastStyle: 1,
  refreshOnPlayPause: false,
  trayControls: true,
  hideButtonText: false,
};

export default createPlugin({
  name: () => t('plugins.notifications.name'),
  description: () => t('plugins.notifications.description'),
  restartNeeded: false,
  config: defaultConfig,
  menu: onMenu,
  renderer: ratingFeedbackRenderer,
  backend: {
    start: onMainLoad,
    onConfigChange,
    stop: onMainStop,
  },
});
