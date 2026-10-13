import { type BrowserWindow, globalShortcut } from 'electron';
import is from 'electron-is';
import {
  register as registerElectronLocalShortcut,
  unregister as unregisterElectronLocalShortcut,
  isRegistered as isRegisteredElectronLocalShortcut,
} from 'electron-localshortcut';

import { getSongControls } from '@/providers/song-controls';
import { MediaType, registerCallback } from '@/providers/song-info';
import { createBackend } from '@/utils';

import { registerMPRIS } from './mpris';

import type { ShortcutMappingType, ShortcutsPluginConfig } from './index';

const mprisWindows = new WeakSet<BrowserWindow>();
type ShortcutsBackend = {
  window?: BrowserWindow;
  config?: ShortcutsPluginConfig;
  active: boolean;
  generation: number;
  revision: number;
  isPodcast: boolean;
  unsubscribe?: () => void;
  registeredGlobal: string[];
  registeredLocal: string[];
  register(config: ShortcutsPluginConfig): void;
  unregister(): void;
  stop(): void;
};

export const backend = createBackend<ShortcutsBackend, ShortcutsPluginConfig>({
  active: false,
  generation: 0,
  revision: 0,
  isPodcast: false,
  registeredGlobal: [],
  registeredLocal: [],
  async start({ getConfig, window }) {
    this.stop();
    const generation = this.generation;
    const config = await getConfig();
    if (generation !== this.generation || window.isDestroyed()) return;
    this.window = window;
    this.active = true;
    this.unsubscribe = registerCallback(
      (info) => {
        if (this.active && generation === this.generation)
          this.isPodcast = info.mediaType === MediaType.PodcastEpisode;
      },
      { replayCurrent: true },
    );
    // MPRIS retains the existing app/window-lifetime behavior on Linux.
    if (is.linux() && !mprisWindows.has(window)) {
      registerMPRIS(window);
      mprisWindows.add(window);
    }
    this.register(config);
  },
  stop() {
    this.active = false;
    this.generation++;
    this.unregister();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.window = undefined;
    this.config = undefined;
    this.isPodcast = false;
  },
  onConfigChange(config) {
    if (this.active) this.register(config);
  },
  register(config) {
    this.unregister();
    const window = this.window;
    if (!this.active || !window || window.isDestroyed()) return;
    this.config = config;
    const revision = this.revision;
    const controls = getSongControls(window);
    const seconds = (direction: 'Forward' | 'Backward') => {
      const fallback = this.isPodcast ? (direction === 'Forward' ? 10 : 30) : 5;
      const key = this.isPodcast
        ? (`podcastSeek${direction}Seconds` as const)
        : (`seek${direction}Seconds` as const);
      const value = Number(this.config?.[key]);
      return Number.isFinite(value) && value > 0
        ? Math.min(600, value)
        : fallback;
    };
    const actions: Record<keyof ShortcutMappingType, () => void> = {
      previous: controls.previous,
      playPause: controls.playPause,
      next: controls.next,
      seekForward: () => controls.goForward(seconds('Forward')),
      seekBackward: () => controls.goBack(seconds('Backward')),
    };
    const guard = (action: () => void) => () => {
      if (
        !this.active ||
        revision !== this.revision ||
        this.window !== window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed?.()
      )
        return;
      action();
    };
    const registerGlobal = (accelerator: string, action: () => void) => {
      try {
        if (globalShortcut.isRegistered(accelerator)) return;
        if (globalShortcut.register(accelerator, guard(action)))
          this.registeredGlobal.push(accelerator);
      } catch (error) {
        console.warn('Unable to register global shortcut', accelerator, error);
      }
    };
    if (config.overrideMediaKeys) {
      registerGlobal('MediaPlayPause', controls.playPause);
      registerGlobal('MediaNextTrack', controls.next);
      registerGlobal('MediaPreviousTrack', controls.previous);
    }
    for (const scope of ['global', 'local'] as const) {
      for (const action of Object.keys(
        actions,
      ) as (keyof ShortcutMappingType)[]) {
        const accelerator = config[scope]?.[action];
        if (typeof accelerator !== 'string' || !accelerator.trim()) continue;
        if (scope === 'global') registerGlobal(accelerator, actions[action]);
        else {
          try {
            if (isRegisteredElectronLocalShortcut(window, accelerator))
              continue;
            registerElectronLocalShortcut(
              window,
              accelerator,
              guard(actions[action]),
            );
            this.registeredLocal.push(accelerator);
          } catch (error) {
            console.warn(
              'Unable to register local shortcut',
              accelerator,
              error,
            );
          }
        }
      }
    }
  },
  unregister() {
    this.revision++;
    for (const accelerator of this.registeredGlobal)
      globalShortcut.unregister(accelerator);
    this.registeredGlobal = [];
    if (this.window && !this.window.isDestroyed()) {
      for (const accelerator of this.registeredLocal)
        unregisterElectronLocalShortcut(this.window, accelerator);
    }
    this.registeredLocal = [];
  },
});
