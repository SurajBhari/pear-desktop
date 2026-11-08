import { isAbsolute, relative, resolve, sep } from 'node:path';

import { app, type BrowserWindow } from 'electron';
import is from 'electron-is';

const pendingErrors = new WeakMap<BrowserWindow, string>();

export const getFolder = (customFolder?: string) =>
  customFolder || app.getPath('downloads');

/** Logical index ownership only; library operations still validate canonical paths. */
export const getLibraryRoot = (configuredRoot: string, destination: string) => {
  const within = relative(resolve(configuredRoot), resolve(destination));
  return within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)
    ? destination
    : configuredRoot;
};

export const sendFeedback = (win: BrowserWindow, message?: unknown) => {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(
    'downloader-feedback',
    pendingErrors.get(win) ?? message,
  );
};

export const sendErrorFeedback = (win: BrowserWindow, message: string) => {
  pendingErrors.set(win, message);
  sendFeedback(win);
};

/** Only a deliberate new operation releases the previous error status. */
export const clearErrorFeedback = (win: BrowserWindow) => {
  pendingErrors.delete(win);
  sendFeedback(win);
};

export const cropMaxWidth = (image: Electron.NativeImage) => {
  const imageSize = image.getSize();
  // Standard artwork width with margins from both sides is 280 + 720 + 280
  if (imageSize.width === 1280 && imageSize.height === 720) {
    return image.crop({
      x: 280,
      y: 0,
      width: 720,
      height: 720,
    });
  }

  return image;
};

export const setBadge = (n: number) => {
  if (is.linux() || is.macOS()) {
    app.setBadgeCount(n);
  }
};
