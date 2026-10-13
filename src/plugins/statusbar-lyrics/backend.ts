// Adapted from upstream #4624 by evan20010126 (MIT).
import { randomUUID } from 'node:crypto';

import { nativeImage, Tray } from 'electron';
import is from 'electron-is';

import { createBackend } from '@/utils';

import {
  normalizeStatusText,
  type StatusbarLyricsPluginConfig,
} from './config';

import type { BackendContext } from '@/types/contexts';

type Context = BackendContext<StatusbarLyricsPluginConfig>;
let active: { window: Context['window']; dispose: () => void } | undefined;
export const backend = createBackend<unknown, StatusbarLyricsPluginConfig>({
  start(context) {
    active?.dispose();
    const window = context.window;
    const session = window.webContents.session;
    let token = randomUUID();
    let tray: Tray | undefined;
    let disposed = false;
    const channels = [
      'statusbar-lyrics:session',
      'statusbar-lyrics:set-text',
      'statusbar-lyrics:clear',
    ];
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.removeListener('closed', dispose);
      if (tray && !tray.isDestroyed()) tray.destroy();
      tray = undefined;
      if (active === owner) {
        channels.forEach((name) => context.ipc.removeHandler(name));
        active = undefined;
      }
    };
    const owner = { window, dispose };
    active = owner;
    window.once('closed', dispose);
    const current = () =>
      !disposed &&
      active === owner &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      window.webContents.session === session &&
      is.macOS();
    const clear = (received: unknown) => {
      if (!current() || received !== token) return false;
      if (tray && !tray.isDestroyed()) tray.setTitle('');
      return true;
    };
    try {
      context.ipc.handle('statusbar-lyrics:session', () => {
        if (!current()) return null;
        // Renderer sessions can restart while this backend stays alive.
        token = randomUUID();
        if (tray && !tray.isDestroyed()) tray.setTitle('');
        return token;
      });
      context.ipc.handle('statusbar-lyrics:clear', clear);
      context.ipc.handle(
        'statusbar-lyrics:set-text',
        (received: unknown, text: unknown, length: unknown) => {
          if (!current() || received !== token) return false;
          const title = normalizeStatusText(text, length);
          if (!title) return clear(received);
          if (!tray || tray.isDestroyed())
            tray = new Tray(nativeImage.createEmpty());
          tray.setTitle(title);
          return true;
        },
      );
    } catch (error) {
      dispose();
      throw error;
    }
  },
  stop(context) {
    // Loader start/stop contexts differ; their BrowserWindow remains stable.
    if (active?.window === context.window) active.dispose();
  },
});
