import { join } from 'node:path';

import { BrowserWindow } from 'electron';

import { t } from '@/i18n';

import { createMcpNoticesController } from './mcp-notices-window';

const notices = createMcpNoticesController(
  () =>
    new BrowserWindow({
      title: t('main.menu.mcp-dependency-notices'),
      width: 860,
      height: 720,
      minWidth: 360,
      minHeight: 320,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'mcp-dependency-notices',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: false,
        webviewTag: false,
        devTools: false,
        spellcheck: false,
      },
    }),
  join(import.meta.dirname, 'assets/mcp-dependency-notices.html'),
);

export const openMcpDependencyNotices = () => notices.open();
