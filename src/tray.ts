import PausedTrayIconWhite from '@assets/tray-paused-white.png?asset&asarUnpack';
import PausedTrayIcon from '@assets/tray-paused.png?asset&asarUnpack';
import TrayIconWhite from '@assets/tray-white.png?asset&asarUnpack';
import TrayIcon from '@assets/tray.png?asset&asarUnpack';
import { Menu, nativeImage, screen, Tray } from 'electron';
import is from 'electron-is';

import { APPLICATION_NAME, t } from '@/i18n';

import * as config from './config';
import { restart } from './providers/app-controls';
import { getSongControls } from './providers/song-controls';
import { registerCallback, SongInfoEvent } from './providers/song-info';

import type { MenuTemplate } from './menu';

// Prevent tray being garbage collected
let tray: Electron.Tray | undefined;

type TrayEvent = (
  event: Electron.KeyboardEvent,
  bounds: Electron.Rectangle,
) => void;

type CallbackOwner = { isCurrent(): boolean; signal?: AbortSignal };
type TrayLease = {
  handler: TrayEvent;
  owner?: CallbackOwner;
  live: boolean;
  previous?: TrayLease;
};
const slots = new WeakMap<Electron.Tray, Map<string, TrayLease>>();
function registerTray(
  event: 'click' | 'double-click',
  fn: TrayEvent,
  owner?: CallbackOwner,
) {
  const physical = tray;
  if (!physical) return () => {};
  let map = slots.get(physical);
  if (!map) {
    map = new Map();
    slots.set(physical, map);
  }
  const previous = map.get(event);
  const add = (handler: TrayEvent) => {
    if (event === 'click') physical.on('click', handler);
    else physical.on('double-click', handler);
  };
  const remove = (handler: TrayEvent) => {
    if (event === 'click') physical.removeListener('click', handler);
    else physical.removeListener('double-click', handler);
  };
  const lease: TrayLease = {
    live: true,
    owner,
    previous,
    handler: (...args) => {
      if (!lease.live || tray !== physical || map.get(event) !== lease) return;
      if (owner && (!owner.isCurrent() || owner.signal?.aborted)) return;
      if (lease.live && tray === physical && map.get(event) === lease)
        fn(...args);
    },
  };
  if (owner && (!owner.isCurrent() || owner.signal?.aborted)) return () => {};
  if (tray !== physical || map.get(event) !== previous) return () => {};
  if (previous) remove(previous.handler);
  if (tray !== physical || map.get(event) !== previous) return () => {};
  map.set(event, lease);
  add(lease.handler);
  if (tray !== physical || map.get(event) !== lease) remove(lease.handler);
  const dispose = () => {
    if (!lease.live) return;
    lease.live = false;
    owner?.signal?.removeEventListener('abort', dispose);
    remove(lease.handler);
    if (tray !== physical || map.get(event) !== lease) return;
    let restore = lease.previous;
    while (restore) {
      const candidate = restore;
      const valid =
        candidate.live && (!candidate.owner || candidate.owner.isCurrent());
      const aborted = candidate.owner?.signal?.aborted;
      if (tray !== physical || map.get(event) !== lease) return;
      // A prior predicate can dispose that candidate while the upper slot stays current.
      if (valid && !aborted && candidate.live) break;
      restore = candidate.previous;
    }
    if (restore) {
      map.set(event, restore);
      add(restore.handler);
      if (tray !== physical || map.get(event) !== restore)
        remove(restore.handler);
    } else map.delete(event);
  };
  owner?.signal?.addEventListener('abort', dispose, { once: true });
  if (owner?.signal?.aborted) dispose();
  return dispose;
}
export const registerOwnedTrayOnClick = (owner: CallbackOwner, fn: TrayEvent) =>
  registerTray('click', fn, owner);
export const registerOwnedTrayOnDoubleClick = (
  owner: CallbackOwner,
  fn: TrayEvent,
) => registerTray('double-click', fn, owner);
export const setTrayOnClick = (fn: TrayEvent): void => {
  registerTray('click', fn);
};
// Electron ignores double click on macOS.
export const setTrayOnDoubleClick = (fn: TrayEvent): void => {
  registerTray('double-click', fn);
};

export const setUpTray = (app: Electron.App, win: Electron.BrowserWindow) => {
  if (!config.get('options.tray')) {
    tray = undefined;
    return;
  }

  const { playPause, next, previous } = getSongControls(win);

  const pixelRatio = is.windows()
    ? screen.getPrimaryDisplay().scaleFactor || 1
    : 1;

  const defaultTrayIcon = nativeImage
    .createFromPath(is.macOS() ? TrayIconWhite : TrayIcon)
    .resize({
      width: 16 * pixelRatio,
      height: 16 * pixelRatio,
    });
  const pausedTrayIcon = nativeImage
    .createFromPath(is.macOS() ? PausedTrayIconWhite : PausedTrayIcon)
    .resize({
      width: 16 * pixelRatio,
      height: 16 * pixelRatio,
    });

  tray = new Tray(defaultTrayIcon);

  tray.setToolTip(
    t('main.tray.tooltip.default', {
      applicationName: APPLICATION_NAME,
    }),
  );

  // MacOS only
  tray.setIgnoreDoubleClickEvents(true);

  setTrayOnClick(() => {
    if (config.get('options.trayClickPlayPause')) {
      playPause();
    } else if (win.isVisible()) {
      win.hide();
      app.dock?.hide();
    } else {
      win.show();
      app.dock?.show();
    }
  });

  const template: MenuTemplate = [
    {
      label: t('main.tray.play-pause'),
      click() {
        playPause();
      },
    },
    {
      label: t('main.tray.next'),
      click() {
        next();
      },
    },
    {
      label: t('main.tray.previous'),
      click() {
        previous();
      },
    },
    {
      label: t('main.tray.show'),
      click() {
        win.show();
        app.dock?.show();
      },
    },
    { type: 'separator' },
    {
      label: t('main.tray.restart'),
      click: restart,
    },
    { type: 'separator' },
    {
      label: t('main.tray.quit'),
      role: 'quit',
    },
  ];

  const trayMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(trayMenu);

  registerCallback((songInfo, event) => {
    if (event === SongInfoEvent.TimeChanged) return;

    if (tray) {
      if (typeof songInfo.isPaused === 'undefined') {
        tray.setImage(defaultTrayIcon);
        return;
      }

      tray.setToolTip(
        t('main.tray.tooltip.with-song-info', {
          artist: songInfo.artist,
          title: songInfo.title,
          applicationName: APPLICATION_NAME,
        }),
      );

      tray.setImage(songInfo.isPaused ? pausedTrayIcon : defaultTrayIcon);
    }
  });
};
