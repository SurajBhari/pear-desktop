import { deepmerge } from 'deepmerge-ts';
import { allPlugins } from 'virtual:plugins';

import * as config from '@/config';
import { t } from '@/i18n';
import { refreshMenu } from '@/menu';
import { LoggerPrefix } from '@/utils';

import type { MenuContext } from '@/types/contexts';
import type { PluginConfig } from '@/types/plugins';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

const menuTemplateMap: Record<string, MenuItemConstructorOptions[]> = {};
const createContext = (
  id: string,
  win: BrowserWindow,
): MenuContext<PluginConfig> => ({
  getConfig: async () =>
    deepmerge(
      (await allPlugins())[id].config ?? { enabled: false },
      config.get(`plugins.${id}`) ?? {},
    ) as PluginConfig,
  setConfig: async (newConfig) => {
    const plugin = (await allPlugins())[id];
    if (
      plugin.menuWhenDisabled === true &&
      (win.isDestroyed() || win.webContents.isDestroyed())
    )
      return;
    config.setPartial(`plugins.${id}`, newConfig, plugin.config);
  },
  window: win,
  // in-app-menu requires restart, so the shared refresh notifies the renderer
  // loaded at launch and fences that send to the current full menu publication.
  refresh: () => refreshMenu(win),
});

export const forceLoadMenuPlugin = async (id: string, win: BrowserWindow) => {
  try {
    const plugin = (await allPlugins())[id];
    if (!plugin) return;

    const menu = plugin.menu?.(createContext(id, win));
    if (menu) {
      const result = await menu;
      if (result.length > 0) {
        menuTemplateMap[id] = result;
      } else {
        if (plugin.menuWhenDisabled === true) delete menuTemplateMap[id];
        return;
      }
    } else {
      if (plugin.menuWhenDisabled === true) delete menuTemplateMap[id];
      return;
    }

    console.log(
      LoggerPrefix,
      t('common.console.plugins.loaded', { pluginName: `${id}::menu` }),
    );
  } catch (err) {
    console.error(
      LoggerPrefix,
      t('common.console.plugins.initialize-failed', {
        pluginName: `${id}::menu`,
      }),
    );
    console.trace(err);
  }
};

export const loadAllMenuPlugins = async (win: BrowserWindow) => {
  const pluginConfigs = config.plugins.getPlugins();

  for (const [pluginId, pluginDef] of Object.entries(await allPlugins())) {
    const config = deepmerge(
      pluginDef.config ?? { enabled: false },
      pluginConfigs[pluginId] ?? {},
    );

    if (config.enabled || pluginDef.menuWhenDisabled === true) {
      await forceLoadMenuPlugin(pluginId, win);
    }
  }
};

export const getMenuTemplate = (
  id: string,
): MenuItemConstructorOptions[] | undefined => {
  return menuTemplateMap[id];
};

export const getAllMenuTemplate = () => {
  return menuTemplateMap;
};
