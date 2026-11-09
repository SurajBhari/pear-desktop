import { ipcRenderer, webFrame } from 'electron';

import { playerAdBlockingScript } from './blocker-player';

import type { AdblockerConfig } from '@/plugins/adblocker/types';
import type { PreloadContext } from '@/types/contexts';

export const createBlockerPreload = (owner: string) => {
  let revision = 0;
  let listening = false;
  let queue = Promise.resolve();
  const configure = (enabled: boolean): Promise<void> => {
    const apply = async () => {
      await webFrame.executeJavaScript(playerAdBlockingScript(owner, enabled));
    };
    const result = queue.then(apply);
    queue = result.catch(() => {});
    return result;
  };
  const change = (
    _: Electron.IpcRendererEvent,
    id: string,
    config: AdblockerConfig,
  ) => {
    if (id !== owner) return;
    revision++;
    configure(config.enabled && config.blocker === 'In player').catch(
      (error: unknown) => {
        console.error(`[${owner}] Could not update player blocking`, error);
      },
    );
  };
  return {
    async start({ getConfig }: PreloadContext<AdblockerConfig>) {
      const expected = ++revision;
      if (!listening) {
        ipcRenderer.on('config-changed', change);
        listening = true;
      }
      const config = await getConfig();
      if (expected === revision)
        await configure(config.enabled && config.blocker === 'In player');
    },
    async stop() {
      revision++;
      if (listening) ipcRenderer.removeListener('config-changed', change);
      listening = false;
      await configure(false);
    },
    async onConfigChange(config: AdblockerConfig) {
      revision++;
      await configure(config.enabled && config.blocker === 'In player');
    },
  };
};
