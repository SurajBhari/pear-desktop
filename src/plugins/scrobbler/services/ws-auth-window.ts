import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  session,
  type BrowserWindowConstructorOptions,
  type Session,
  type WebPreferences,
  type WebContents,
} from 'electron';

import type { AuthSurface } from './ws-auth';
import type { EventEmitter } from 'node:events';

const retiredError = () =>
  new Error('Scrobbling authentication window retired');
const safeHttps = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && !url.username && !url.password && !url.port
    );
  } catch {
    return false;
  }
};
interface OwnedWindow {
  window: BrowserWindow;
  dispose: (() => void)[];
  loaded: boolean;
  painted: boolean;
  shown: boolean;
  primary: boolean;
}

/** A disposable login surface only. API polling, never this page, decides success. */
export function openScrobblingAuthWindow(
  mainWindow: BrowserWindow,
  url: string,
  signal: AbortSignal,
): AuthSurface {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller may retire an unopened surface without waiting for readiness.
  ready.catch(() => {});
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let retired = false;
  let readySettled = false;
  let ownedSession: Session | null = null;
  const windows = new Set<OwnedWindow>();
  const lifetimeHooks: (() => void)[] = [];
  const current = () =>
    !retired && !signal.aborted && !mainWindow.isDestroyed();
  const listen = <Arguments extends unknown[]>(
    target: EventEmitter,
    event: string,
    listener: (...args: Arguments) => void,
    hooks: (() => void)[],
  ) => {
    target.on(event, listener);
    hooks.push(() => target.removeListener(event, listener));
  };
  const removeHooks = (hooks: (() => void)[]) => {
    for (const remove of hooks.splice(0)) {
      try {
        remove();
      } catch {
        /* Destroyed native objects are already retired. */
      }
    }
  };
  const destroyOwned = (entry: OwnedWindow) => {
    windows.delete(entry);
    removeHooks(entry.dispose);
    if (entry.window.isDestroyed()) return;
    // destroy skips page beforeunload cancellation and never touches the parent.
    try {
      entry.window.webContents.stop();
    } catch {
      /* Already stopping. */
    }
    entry.window.destroy();
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    if (!readySettled) {
      readySettled = true;
      rejectReady(retiredError());
    }
    removeHooks(lifetimeHooks);
    for (const entry of [...windows]) destroyOwned(entry);
    const cleanup = ownedSession;
    ownedSession = null;
    if (cleanup) {
      try {
        cleanup.setPermissionRequestHandler(null);
      } catch {
        /* Owned session only. */
      }
      try {
        cleanup.setPermissionCheckHandler(null);
      } catch {
        /* Owned session only. */
      }
      // Signal cancellation immediately; native cleanup must not delay API retirement.
      // This UUID session is never reused and no live window can write its storage.
      Promise.allSettled([
        Promise.resolve().then(() => cleanup.clearStorageData()),
        Promise.resolve().then(() => cleanup.clearCache()),
      ]);
    }
    resolveClosed();
  };
  const showWhenReady = (entry: OwnedWindow) => {
    if (
      !current() ||
      !windows.has(entry) ||
      entry.window.isDestroyed() ||
      entry.shown ||
      !entry.loaded ||
      !entry.painted
    )
      return;
    entry.shown = true;
    try {
      entry.window.show();
      // Native show listeners may synchronously abort or close the parent.
      if (!current() || !windows.has(entry) || entry.window.isDestroyed())
        return;
      if (entry.primary && !readySettled) {
        readySettled = true;
        resolveReady();
      }
    } catch {
      retire();
    }
  };
  const preferences = (
    targetSession: Session,
    inherited?: WebPreferences,
  ): WebPreferences => ({
    // Preserve framework opener metadata for ordinary HTTPS SSO, but lock
    // all execution/storage/security privileges independently of features.
    ...inherited,
    session: targetSession,
    partition: undefined,
    preload: undefined,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    enableWebSQL: false,
    additionalArguments: [],
    offscreen: false,
  });
  const createOwned = (
    parent: BrowserWindow,
    primary: boolean,
    inherited?: BrowserWindowConstructorOptions,
  ): OwnedWindow => {
    const windowSession = ownedSession;
    if (!current() || !windowSession || parent.isDestroyed() || !current())
      throw retiredError();
    const window = new BrowserWindow({
      // Preserve only Electron's supplied native guest, never renderer window privileges.
      ...((
        inherited as
          | (BrowserWindowConstructorOptions & { webContents?: WebContents })
          | undefined
      )?.webContents
        ? {
            webContents: (
              inherited as BrowserWindowConstructorOptions & {
                webContents: WebContents;
              }
            ).webContents,
          }
        : {}),
      parent,
      modal: primary,
      title: 'Scrobbling sign-in',
      width: 720,
      height: 700,
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: preferences(windowSession, inherited?.webPreferences),
    });
    const entry: OwnedWindow = {
      window,
      dispose: [],
      loaded: false,
      painted: false,
      shown: false,
      primary,
    };
    windows.add(entry);
    // browser-window-created may synchronously retire us during construction.
    if (!current() || parent.isDestroyed()) {
      destroyOwned(entry);
      throw retiredError();
    }
    const contents = window.webContents;
    const owns = () => current() && windows.has(entry) && !window.isDestroyed();
    listen(
      window,
      'ready-to-show',
      () => {
        entry.painted = true;
        showWhenReady(entry);
      },
      entry.dispose,
    );
    listen(
      contents,
      'did-finish-load',
      () => {
        entry.loaded = true;
        showWhenReady(entry);
      },
      entry.dispose,
    );
    listen(
      contents,
      'did-fail-load',
      (
        _event: Electron.Event,
        code: number,
        _description: string,
        _url: string,
        mainFrame: boolean,
      ) => {
        if (owns() && mainFrame && code !== -3) retire();
      },
      entry.dispose,
    );
    listen(
      contents,
      'render-process-gone',
      () => {
        if (owns()) retire();
      },
      entry.dispose,
    );
    for (const event of ['will-navigate', 'will-redirect'])
      listen(
        contents,
        event,
        (event: Electron.Event, target: string) => {
          if (!owns() || !safeHttps(target)) event.preventDefault();
        },
        entry.dispose,
      );
    listen(
      contents,
      'will-attach-webview',
      (event: Electron.Event) => event.preventDefault(),
      entry.dispose,
    );
    listen(
      contents,
      'will-prevent-unload',
      (event: Electron.Event) => event.preventDefault(),
      entry.dispose,
    );
    listen(
      window,
      'close',
      (event: Electron.Event) => {
        event.preventDefault();
        if (primary) retire();
        else destroyOwned(entry);
      },
      entry.dispose,
    );
    listen(
      window,
      'closed',
      () => {
        if (primary) retire();
        else destroyOwned(entry);
      },
      entry.dispose,
    );
    contents.setWindowOpenHandler((details) => {
      const childSession = ownedSession;
      if (!owns() || !childSession || !safeHttps(details.url) || !owns())
        return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: preferences(childSession),
        },
        createWindow(options) {
          // Never grant privileges or create a late child for a retired opener.
          if (!owns()) throw retiredError();
          const child = createOwned(window, false, options);
          // window.open carries a native guest; target=_blank links may not.
          if (
            !(
              options as BrowserWindowConstructorOptions & {
                webContents?: WebContents;
              }
            ).webContents
          )
            child.window
              .loadURL(details.url, {
                httpReferrer: details.referrer,
                ...(details.postBody
                  ? { postData: details.postBody.data }
                  : {}),
              })
              .catch(() => {
                // Closing an SSO child aborts its pending load. Only a still
                // owned, live child may retire the primary for a load failure.
                if (
                  current() &&
                  windows.has(child) &&
                  !child.window.isDestroyed()
                )
                  retire();
              });
          return child.window.webContents;
        },
      };
    });
    return entry;
  };
  const surface: AuthSurface = { ready, closed, close: retire };
  try {
    if (!safeHttps(url) || !current()) {
      retire();
      return surface;
    }
    const abort = () => retire();
    signal.addEventListener('abort', abort, { once: true });
    lifetimeHooks.push(() => signal.removeEventListener('abort', abort));
    listen(mainWindow, 'close', retire, lifetimeHooks);
    listen(mainWindow, 'closed', retire, lifetimeHooks);
    ownedSession = session.fromPartition(`scrobbler-auth-${randomUUID()}`, {
      cache: false,
    });
    ownedSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    ownedSession.setPermissionCheckHandler(() => false);
    listen(
      ownedSession,
      'will-download',
      (event: Electron.Event, item: Electron.DownloadItem) => {
        event.preventDefault();
        item.cancel();
      },
      lifetimeHooks,
    );
    const entry = createOwned(mainWindow, true);
    entry.window.loadURL(url).then(
      () => {
        if (current() && windows.has(entry)) {
          entry.loaded = true;
          showWhenReady(entry);
        }
      },
      () => retire(),
    );
  } catch {
    retire();
  }
  return surface;
}
