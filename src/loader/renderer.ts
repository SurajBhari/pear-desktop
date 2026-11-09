import { deepmerge } from 'deepmerge-ts';
import { rendererPlugins } from 'virtual:plugins';

import { t } from '@/i18n';
import { LoggerPrefix, startPlugin, stopPlugin } from '@/utils';

import type { RendererContext } from '@/types/contexts';
import type { PluginConfig, PluginDef } from '@/types/plugins';

const pluginStyleMap: Record<string, CSSStyleSheet[]> = {};
const pendingOperations = new Map<string, Promise<void>>();
let pendingRegistration: Promise<void> = Promise.resolve();
const loadedPluginMap: Record<
  string,
  PluginDef<unknown, unknown, unknown>
> = {};

export const createContext = <Config extends PluginConfig>(
  id: string,
): RendererContext<Config> => ({
  getConfig: () =>
    window.ipcRenderer.invoke('peard:get-config', id) as Promise<Config>,
  setConfig: async (newConfig) => {
    await window.ipcRenderer.invoke('peard:set-config', id, newConfig);
  },
  ipc: {
    send: (event: string, ...args: unknown[]) => {
      window.ipcRenderer.send(event, ...args);
    },
    invoke: (event: string, ...args: unknown[]) =>
      window.ipcRenderer.invoke(event, ...args),
    on: (event: string, listener: CallableFunction) => {
      window.ipcRenderer.on(event, (_, ...args: unknown[]) => {
        // oxlint-disable-next-line typescript/no-unsafe-call
        listener(...args);
      });
    },
    subscribe: (event: string, listener: CallableFunction) =>
      window.ipcRenderer.subscribe(event, (...args: unknown[]) => {
        // oxlint-disable-next-line typescript/no-unsafe-call
        listener(...args);
      }),
    removeAllListeners: (event: string) => {
      window.ipcRenderer.removeAllListeners(event);
    },
  },
});

// Keep enable/disable operations in request order, even when lifecycle hooks await.
const queuePluginOperation = (id: string, operation: () => Promise<void>) => {
  const pending = (pendingOperations.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  pendingOperations.set(id, pending);
  return pending.finally(() => {
    if (pendingOperations.get(id) === pending) pendingOperations.delete(id);
  });
};

const unloadRendererPlugin = async (id: string) => {
  const plugin = loadedPluginMap[id];
  if (!plugin) return;

  const hasStopped = await stopPlugin(id, plugin, {
    ctx: 'renderer',
    context: createContext(id),
  });
  // Function renderers have no stop hook; retain their existing unload behavior.
  if (
    hasStopped !== false ||
    typeof plugin.renderer === 'function' ||
    !plugin.renderer
  ) {
    const stylesheets = pluginStyleMap[id];
    if (stylesheets) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (style) => !stylesheets.includes(style),
      );
    }
    delete pluginStyleMap[id];
    delete loadedPluginMap[id];
    console.log(
      LoggerPrefix,
      t('common.console.plugins.unloaded', { pluginName: id }),
    );
  } else {
    console.error(
      LoggerPrefix,
      t('common.console.plugins.unload-failed', { pluginName: id }),
    );
  }
};

const loadRendererPlugin = async (id: string) => {
  if (loadedPluginMap[id]) return;
  const plugin = (await rendererPlugins())[id];
  if (!plugin) return;

  const hasEvaled = await startPlugin(id, plugin, {
    ctx: 'renderer',
    context: createContext(id),
  });

  if (
    hasEvaled !== false &&
    (hasEvaled ||
      plugin?.stylesheets ||
      (hasEvaled === null &&
        typeof plugin?.renderer !== 'function' &&
        plugin?.renderer))
  ) {
    loadedPluginMap[id] = plugin;

    if (plugin?.stylesheets) {
      const styleSheetList = plugin.stylesheets.map((style) => {
        const styleSheet = new CSSStyleSheet();
        styleSheet.replaceSync(style);

        return styleSheet;
      });

      document.adoptedStyleSheets = [
        ...document.adoptedStyleSheets,
        ...styleSheetList,
      ];
      pluginStyleMap[id] = styleSheetList;
    }

    console.log(
      LoggerPrefix,
      t('common.console.plugins.loaded', { pluginName: id }),
    );
  } else {
    console.log(
      LoggerPrefix,
      t('common.console.plugins.initialize-failed', { pluginName: id }),
    );
  }
};

// Register requests in call order, including bulk requests awaiting the registry.
// Only registration is serialized globally; lifecycle hooks keep their per-ID queue.
const registerOperations = (
  register: () => Promise<void>[] | Promise<Promise<void>[]>,
) => {
  const registered = pendingRegistration.then(register);
  pendingRegistration = registered.then(
    () => {},
    () => {},
  );
  return registered
    .then((operations) => Promise.all(operations))
    .then(() => {});
};

export const forceUnloadRendererPlugin = (id: string) =>
  registerOperations(() => [
    queuePluginOperation(id, () => unloadRendererPlugin(id)),
  ]);

export const forceLoadRendererPlugin = (id: string) =>
  registerOperations(() => [
    queuePluginOperation(id, () => loadRendererPlugin(id)),
  ]);

export const loadAllRendererPlugins = () =>
  registerOperations(async () => {
    const pluginConfigs = window.mainConfig.plugins.getPlugins();
    const operations: Promise<void>[] = [];
    let previous: Promise<void> = Promise.resolve();

    for (const [pluginId, pluginDef] of Object.entries(
      await rendererPlugins(),
    )) {
      const config = deepmerge(pluginDef.config, pluginConfigs[pluginId] ?? {});

      const preceding = previous;
      const operation = queuePluginOperation(pluginId, async () => {
        await preceding;
        if (config.enabled) await loadRendererPlugin(pluginId);
        else await unloadRendererPlugin(pluginId);
      });
      operations.push(operation);
      previous = operation;
    }
    return operations;
  });

export const unloadAllRendererPlugins = () =>
  registerOperations(() => {
    const ids = new Set([
      ...Object.keys(loadedPluginMap),
      ...pendingOperations.keys(),
    ]);
    return [...ids].map((id) =>
      queuePluginOperation(id, () => unloadRendererPlugin(id)),
    );
  });

export const getLoadedRendererPlugin = (
  id: string,
): PluginDef<unknown, unknown, unknown> | undefined => {
  return loadedPluginMap[id];
};

export const getAllLoadedRendererPlugins = () => {
  return loadedPluginMap;
};
