import prompt from 'custom-electron-prompt';
import { clipboard, dialog } from 'electron';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';

import { getMcpGrantTarget } from './backend/mcp-owner';
import { getMusicService } from './backend/music-service';
import {
  type APIServerConfig,
  AuthStrategy,
  defaultAPIServerConfig,
} from './config';
import { createMusicGrantMenu, createRemoteMusicGrantMenu } from './music-menu';

import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

export const onMenu = async ({
  getConfig,
  setConfig,
  window,
  refresh,
}: MenuContext<APIServerConfig>): Promise<MenuTemplate> => {
  const config = await getConfig();

  const native = {
    prompt: async () =>
      (await prompt(
        {
          title: 'Music API client name',
          label: 'Client name',
          type: 'input',
          width: 380,
          ...promptOptions(),
        },
        window,
      )) ?? null,
    show: (options: import('electron').MessageBoxOptions) =>
      dialog.showMessageBox(window, options),
    copy: (token: string) => clipboard.writeText(token),
    promptResource: async (value: string) =>
      (await prompt(
        {
          title: 'Remote REST resource',
          label: 'Exact remote REST resource URL',
          value,
          type: 'input',
          width: 380,
          ...promptOptions(),
        },
        window,
      )) ?? null,
  };
  const context = { getConfig, setConfig, window, refresh };
  const musicMenu = await createMusicGrantMenu(
    context,
    () => getMusicService(window),
    native,
  );
  const mcpMenu = await createMusicGrantMenu(
    context,
    () => getMcpGrantTarget(window),
    native,
    'mcp',
  );
  const remoteMenu = await createRemoteMusicGrantMenu(
    context,
    (resource) => getMusicService(window, resource),
    native,
  );
  return [
    {
      label: 'Expanded music API',
      type: 'submenu',
      submenu: [
        ...musicMenu.map((entry) =>
          entry.label === 'Create client grant…'
            ? { ...entry, label: 'Create local REST grant…' }
            : entry,
        ),
        { label: 'Remote REST access', type: 'submenu', submenu: remoteMenu },
      ],
    },
    { label: 'MCP music access', type: 'submenu', submenu: mcpMenu },
    {
      label: t('plugins.api-server.menu.hostname.label'),
      type: 'normal',
      async click() {
        const config = await getConfig();

        const newHostname =
          (await prompt(
            {
              title: t('plugins.api-server.prompt.hostname.title'),
              label: t('plugins.api-server.prompt.hostname.label'),
              value: config.hostname,
              type: 'input',
              width: 380,
              ...promptOptions(),
            },
            window,
          )) ??
          config.hostname ??
          defaultAPIServerConfig.hostname;

        setConfig({ ...config, hostname: newHostname });
      },
    },
    {
      label: t('plugins.api-server.menu.port.label'),
      type: 'normal',
      async click() {
        const config = await getConfig();

        const newPort =
          (await prompt(
            {
              title: t('plugins.api-server.prompt.port.title'),
              label: t('plugins.api-server.prompt.port.label'),
              value: config.port,
              type: 'counter',
              counterOptions: { minimum: 0, maximum: 65565 },
              width: 380,
              ...promptOptions(),
            },
            window,
          )) ??
          config.port ??
          defaultAPIServerConfig.port;

        setConfig({ ...config, port: newPort });
      },
    },
    {
      label: t('plugins.api-server.menu.auth-strategy.label'),
      type: 'submenu',
      submenu: [
        {
          label: t(
            'plugins.api-server.menu.auth-strategy.submenu.auth-at-first.label',
          ),
          type: 'radio',
          checked: config.authStrategy === AuthStrategy.AUTH_AT_FIRST,
          click() {
            setConfig({ ...config, authStrategy: AuthStrategy.AUTH_AT_FIRST });
          },
        },
        {
          label: t('plugins.api-server.menu.auth-strategy.submenu.none.label'),
          type: 'radio',
          checked: config.authStrategy === AuthStrategy.NONE,
          click() {
            setConfig({ ...config, authStrategy: AuthStrategy.NONE });
          },
        },
      ],
    },
    {
      label: t('plugins.api-server.menu.https.label'),
      type: 'submenu',
      submenu: [
        {
          label: t('plugins.api-server.menu.https.submenu.enable-https.label'),
          type: 'checkbox',
          checked: config.useHttps,
          click(menuItem) {
            setConfig({ ...config, useHttps: menuItem.checked });
          },
        },
        {
          label: t('plugins.api-server.menu.https.submenu.cert.label'),
          type: 'normal',
          async click() {
            const config = await getConfig();
            const result = await dialog.showOpenDialog(window, {
              title: t(
                'plugins.api-server.menu.https.submenu.cert.dialogTitle',
              ),
              filters: [{ name: 'Certificate', extensions: ['crt', 'pem'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              setConfig({ ...config, certPath: result.filePaths[0] });
            }
          },
        },
        {
          label: t('plugins.api-server.menu.https.submenu.key.label'),
          type: 'normal',
          async click() {
            const config = await getConfig();
            const result = await dialog.showOpenDialog(window, {
              title: t('plugins.api-server.menu.https.submenu.key.dialogTitle'),
              filters: [{ name: 'Private Key', extensions: ['key', 'pem'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              setConfig({ ...config, keyPath: result.filePaths[0] });
            }
          },
        },
      ],
    },
  ];
};
