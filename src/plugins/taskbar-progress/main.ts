import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import {
  getCurrentSongInfoProvenance,
  getSongInfoProvenance,
  registerCallback,
  type SongInfo,
} from '@/providers/song-info';
import { createBackend } from '@/utils';

import { createLinuxProgress } from './linux';

import { desktopName } from '../../../package.json';

import type { BackendContext } from '@/types/contexts';

interface Owner {
  window: BrowserWindow;
  dispose(this: void): void;
}
let active: Owner | undefined;
let generation = 0;

/** Uses authoritative song/time events; no synthetic clock or polling loop. */
export const backend = createBackend({
  start(context: BackendContext<{ enabled: boolean }>) {
    const revision = ++generation;
    const window = context.window;
    let contents: BrowserWindow['webContents'];
    try {
      if (window.isDestroyed()) return;
      contents = window.webContents;
      if (contents.isDestroyed()) return;
    } catch {
      return;
    }
    if (revision !== generation) return;
    active?.dispose();
    if (revision !== generation) return;
    const linux =
      process.platform === 'linux'
        ? createLinuxProgress(desktopName)
        : undefined;
    let disposed = false,
      unsubscribe: (() => void) | undefined;
    let playerReady = true;
    let last: string | undefined;
    let latestProvenance: ReturnType<typeof getSongInfoProvenance> | undefined;
    let metadataQueued = false;
    let metadataFrame: BrowserWindow['webContents']['mainFrame'] | undefined;
    const alive = () => {
      try {
        return (
          !disposed &&
          active === owner &&
          !window.isDestroyed() &&
          window.webContents === contents &&
          !contents.isDestroyed()
        );
      } catch {
        return false;
      }
    };
    const progress = (value: number, mode: 'normal' | 'paused' = 'normal') => {
      if (!alive()) return;
      const key = `${value}/${mode}`;
      if (last === key) return;
      try {
        window.setProgressBar(value, { mode });
        if (alive()) {
          last = key;
          linux?.update(value);
        }
      } catch {
        /* A destroyed or unsupported native window has no indicator. */
      }
    };
    const update = (info: SongInfo) => {
      if (!alive() || !playerReady) return;
      const token = getSongInfoProvenance(info);
      if (!token || token !== getCurrentSongInfoProvenance(window)) return;
      const elapsed = info.elapsedSeconds,
        title = info.title,
        duration = info.songDuration;
      if (!alive() || token !== getCurrentSongInfoProvenance(window)) return;
      latestProvenance = token;
      if (
        typeof title !== 'string' ||
        !title.trim() ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        typeof elapsed !== 'number' ||
        !Number.isFinite(elapsed) ||
        elapsed < 0
      ) {
        progress(-1);
        return;
      }
      progress(
        Math.min(1, elapsed / duration),
        info.isPaused ? 'paused' : 'normal',
      );
    };
    const setupTime = () => {
      if (!alive()) return;
      try {
        context.ipc.send('peard:setup-time-changed-listener');
      } catch {
        /* Retired renderer. */
      }
    };
    const ready = (event: IpcMainEvent) => {
      try {
        if (
          alive() &&
          event.sender === contents &&
          event.senderFrame === contents.mainFrame
        ) {
          playerReady = true;
          setupTime();
        }
      } catch {
        /* Destroyed native frame. */
      }
    };
    const reconcileMetadata = (
      frame: BrowserWindow['webContents']['mainFrame'],
    ) => {
      if (!alive() || contents.mainFrame !== frame) return;
      const next = getCurrentSongInfoProvenance(window);
      if (!alive() || contents.mainFrame !== frame) return;
      if (next !== latestProvenance) {
        latestProvenance = next;
        progress(-1);
      }
    };
    const metadataChanged = (event: IpcMainEvent) => {
      try {
        if (
          !alive() ||
          event.sender !== contents ||
          event.senderFrame !== contents.mainFrame
        )
          return;
        metadataFrame = event.senderFrame;
        // Preserve immediate retirement when the provider has already processed this event.
        reconcileMetadata(event.senderFrame);
        if (!alive() || metadataQueued) return;
        metadataQueued = true;
        // Startup installs plugin backends before the provider: check again after every IPC handler.
        queueMicrotask(() => {
          metadataQueued = false;
          const frame = metadataFrame;
          metadataFrame = undefined;
          try {
            if (frame) reconcileMetadata(frame);
          } catch {
            /* Retired native frame. */
          }
        });
      } catch {
        /* A retired native frame has no current metadata admission. */
      }
    };
    const retireDocument = () => {
      playerReady = false;
      progress(-1);
    };
    const navigating = (
      _event: Electron.Event,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
    ) => {
      if (mainFrame && !inPlace) retireDocument();
    };
    const owner: Owner = {
      window,
      dispose() {
        if (disposed) return;
        const owned = active === owner;
        disposed = true;
        metadataFrame = undefined;
        if (owned) active = undefined;
        unsubscribe?.();
        ipcMain.removeListener('peard:player-api-loaded', ready);
        ipcMain.removeListener('peard:video-src-changed', metadataChanged);
        window.removeListener('closed', owner.dispose);
        contents.removeListener('did-start-navigation', navigating);
        contents.removeListener('render-process-gone', retireDocument);
        contents.removeListener('destroyed', owner.dispose);
        try {
          if (owned && !active && !window.isDestroyed())
            window.setProgressBar(-1);
        } catch {
          /* Retired native window. */
        }
        linux?.dispose(owned && !active);
      },
    };
    active = owner;
    ipcMain.on('peard:player-api-loaded', ready);
    ipcMain.on('peard:video-src-changed', metadataChanged);
    window.on('closed', owner.dispose);
    contents.on('did-start-navigation', navigating);
    contents.on('render-process-gone', retireDocument);
    contents.on('destroyed', owner.dispose);
    const detach = registerCallback(update, { replayCurrent: true });
    if (alive()) unsubscribe = detach;
    else {
      detach();
      owner.dispose();
    }
    setupTime();
  },
  stop({ window }: BackendContext<{ enabled: boolean }>) {
    if (active?.window === window) active.dispose();
  },
});
