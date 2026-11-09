import i18next, { t as i18t } from 'i18next';
import { availableLanguages, loadLanguageResource } from 'virtual:i18n';

import { createLanguageController } from './language-controller';

export const APPLICATION_NAME =
  '\u0059\u006f\u0075\u0054\u0075\u0062\u0065\u0020\u004d\u0075\u0073\u0069\u0063';

const controller = createLanguageController(
  i18next,
  loadLanguageResource,
  availableLanguages,
);
export const loadI18n = controller.initialize;
export const setLanguage = controller.setLanguage;
export const retireLanguageRequests = controller.retirePending;

export const t = i18t.bind(i18next);
