import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
  webFrame,
} from 'electron';
import is from 'electron-is';

import { loadI18n, retireLanguageRequests, setLanguage } from '@/i18n';
import { installBlockerSceneGuard } from '@/providers/blocker-scene-preload';

import * as config from './config';
import {
  forceLoadPreloadPlugin,
  forceUnloadPreloadPlugin,
  loadAllPreloadPlugins,
} from './loader/preload';

let languageDocumentActive = true;
const isLanguageDocumentCurrent = () => languageDocumentActive;
window.addEventListener(
  'pagehide',
  () => {
    languageDocumentActive = false;
    retireLanguageRequests();
  },
  { once: true },
);

// @ts-expect-error dummy
globalThis.customElements = { define() {} };
installBlockerSceneGuard();

new MutationObserver((mutations, observer) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      const elem = node as HTMLElement;
      if (elem.tagName !== 'SCRIPT') continue;

      const script = elem as HTMLScriptElement;
      if (
        !script.getAttribute('src')?.endsWith('custom-elements-es5-adapter.js')
      )
        continue;

      script.remove();

      observer.disconnect();
      return;
    }
  }
}).observe(document, { subtree: true, childList: true });

loadI18n().then(async () => {
  if (!isLanguageDocumentCurrent()) return;
  await setLanguage(
    config.get('options.language') ?? 'en',
    isLanguageDocumentCurrent,
  );
  if (!isLanguageDocumentCurrent()) return;
  await loadAllPreloadPlugins();
});

ipcRenderer.on('plugin:unload', async (_, id: string) => {
  await forceUnloadPreloadPlugin(id);
});
ipcRenderer.on('plugin:enable', async (_, id: string) => {
  await forceLoadPreloadPlugin(id);
});

contextBridge.exposeInMainWorld('mainConfig', config);
contextBridge.exposeInMainWorld('electronIs', is);
const pageIpcChannel = (channel: string): string => {
  if (typeof channel !== 'string' || channel.startsWith('peard:blocker-scene-'))
    throw new Error('Reserved internal IPC channel');
  return channel;
};
contextBridge.exposeInMainWorld('ipcRenderer', {
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => {
    const ownedChannel = pageIpcChannel(channel);
    const handler = (_event: IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(ownedChannel, handler);
    return () => {
      ipcRenderer.removeListener(ownedChannel, handler);
    };
  },
  on: (
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ) => ipcRenderer.on(pageIpcChannel(channel), listener),
  off: (channel: string, listener: (...args: unknown[]) => void) =>
    ipcRenderer.off(pageIpcChannel(channel), listener),
  once: (
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ) => ipcRenderer.once(pageIpcChannel(channel), listener),
  send: (channel: string, ...args: unknown[]) =>
    ipcRenderer.send(pageIpcChannel(channel), ...args),
  removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
    ipcRenderer.removeListener(pageIpcChannel(channel), listener),
  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(pageIpcChannel(channel)),
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(pageIpcChannel(channel), ...args),
  sendSync: (channel: string, ...args: unknown[]): unknown =>
    ipcRenderer.sendSync(pageIpcChannel(channel), ...args),
  sendToHost: (channel: string, ...args: unknown[]) =>
    ipcRenderer.sendToHost(pageIpcChannel(channel), ...args),
});
contextBridge.exposeInMainWorld('reload', () =>
  ipcRenderer.send('peard:reload'),
);
contextBridge.exposeInMainWorld(
  'ELECTRON_RENDERER_URL',
  process.env.ELECTRON_RENDERER_URL,
);

const [path, script] = ipcRenderer.sendSync('get-renderer-script') as [
  string | null,
  string,
];
let blocked = true;
if (path) {
  webFrame.executeJavaScriptInIsolatedWorld(
    0,
    [
      {
        code: script,
        url: path,
      },
    ],
    true,
    () => (blocked = false),
  );
} else {
  webFrame.executeJavaScript(script, true, () => (blocked = false));
}

// HACK: Wait for the script to be executed
while (blocked);
