import type { BackendContext } from '@/types/contexts';

export const backend = {
  release: undefined as (() => void) | undefined,
  start({ window, ipc }: BackendContext<{ enabled: boolean }>) {
    this.release?.();
    const command = (_event: Electron.Event, value: string) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      if (value === 'browser-backward' || value === 'browser-forward') {
        // The renderer owns the active-document/modal guard. These are native
        // Windows/Linux browser commands, not evidence of a physical touchpad.
        ipc.send(
          'navigation-history-command',
          value === 'browser-backward' ? 'back' : 'forward',
        );
      }
    };
    const release = () => {
      window.off('app-command', command);
      window.off('closed', release);
      if (this.release === release) this.release = undefined;
    };
    window.on('app-command', command);
    window.on('closed', release);
    this.release = release;
  },
  stop() {
    this.release?.();
  },
};
