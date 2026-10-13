import prompt from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';
import { createPlugin } from '@/utils';

import { renderer } from './renderer';

export interface CustomOutputPluginConfig {
  enabled: boolean;
  output: string;
  devices: Record<string, string> | null;
  deviceStatus?: DeviceStatus | null;
}
export type DeviceStatus =
  | 'unsupported'
  | 'permission'
  | 'limited'
  | 'unavailable'
  | 'failed';

export default createPlugin({
  name: () => t('plugins.custom-output-device.name'),
  description: () => t('plugins.custom-output-device.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    output: 'default',
    devices: {},
  } as CustomOutputPluginConfig,
  menu: ({ setConfig, getConfig, window }) => {
    const promptDeviceSelector = async () => {
      const options = await getConfig();

      const response = await prompt(
        {
          title: t('plugins.custom-output-device.prompt.device-selector.title'),
          label: [
            t('plugins.custom-output-device.prompt.device-selector.label'),
            options.deviceStatus
              ? t(`plugins.custom-output-device.status.${options.deviceStatus}`)
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          value: Object.hasOwn(options.devices ?? {}, options.output)
            ? options.output
            : 'default',
          type: 'select',
          selectOptions: {
            default: t('plugins.custom-output-device.system-default'),
            ...options.devices,
          },
          width: 500,
          ...promptOptions(),
        },
        window,
      ).catch(console.error);

      if (!response) return;
      await setConfig({ output: response });
    };

    return [
      {
        label: t('plugins.custom-output-device.menu.device-selector'),
        click: promptDeviceSelector,
      },
    ];
  },

  renderer,
});
