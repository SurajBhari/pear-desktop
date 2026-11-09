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
import { registerOwnedGlobalShortcut } from '@/utils/global-shortcut-owner';

import { registerMPRIS } from './mpris';
import { createPlayPauseGesture } from './play-pause-gesture';

import type { ShortcutMappingType, ShortcutsPluginConfig } from './index';

const mprisWindows = new WeakSet<BrowserWindow>();
type Release = () => void;
type ShortcutsBackend = {
  window?: BrowserWindow;
  config?: ShortcutsPluginConfig;
  active: boolean;
  generation: number;
  revision: number;
  documentRevision: number;
  isPodcast: boolean;
  reconciling: boolean;
  scope?: AbortController;
  unsubscribe?: Release;
  closeListener?: Release;
  releases: Release[];
  register(config: ShortcutsPluginConfig): void;
  onConfigChange(config: ShortcutsPluginConfig): void;
  reconcile(): void;
  unregister(): void;
  stop(): void;
};

export const backend = createBackend<ShortcutsBackend, ShortcutsPluginConfig>({
  active: false,
  generation: 0,
  revision: 0,
  documentRevision: 0,
  isPodcast: false,
  reconciling: false,
  releases: [],
  async start({ getConfig, window }) {
    this.stop();
    const generation = this.generation;
    this.window = window;
    const closed = () => {
      if (this.window === window && this.generation === generation) this.stop();
    };
    window.on?.('closed', closed);
    if (this.generation !== generation || this.window !== window) {
      window.off?.('closed', closed);
      return;
    }
    this.closeListener = () => window.off?.('closed', closed);
    let loaded: ShortcutsPluginConfig;
    try {
      loaded = await getConfig();
    } catch (error) {
      if (this.generation !== generation || this.window !== window) return;
      if (!this.config) {
        this.stop();
        throw error;
      }
      loaded = this.config;
    }
    if (this.generation !== generation || this.window !== window) return;
    const destroyed = window.isDestroyed();
    if (destroyed || this.generation !== generation || this.window !== window)
      return;
    const desired = this.config ?? loaded;
    if (desired.enabled !== true) {
      this.stop();
      return;
    }
    this.config = desired;
    this.active = true;
    const unsubscribe = registerCallback(
      (info) => {
        if (
          !this.active ||
          generation !== this.generation ||
          this.window !== window
        )
          return;
        const podcast = info.mediaType === MediaType.PodcastEpisode;
        if (
          this.active &&
          generation === this.generation &&
          this.window === window
        )
          this.isPodcast = podcast;
      },
      { replayCurrent: true },
    );
    if (
      !this.active ||
      generation !== this.generation ||
      this.window !== window
    ) {
      unsubscribe();
      return;
    }
    this.unsubscribe = unsubscribe;
    if (is.linux() && !mprisWindows.has(window)) {
      mprisWindows.add(window);
      registerMPRIS(window);
    }
    if (this.active && generation === this.generation && this.window === window)
      this.reconcile();
  },
  stop() {
    this.active = false;
    this.generation++;
    this.revision++;
    this.documentRevision++;
    const scope = this.scope,
      unsubscribe = this.unsubscribe,
      close = this.closeListener;
    const releases = this.releases.splice(0);
    this.scope = undefined;
    this.unsubscribe = undefined;
    this.closeListener = undefined;
    this.window = undefined;
    this.config = undefined;
    this.isPodcast = false;
    scope?.abort();
    for (const release of releases) release();
    unsubscribe?.();
    close?.();
  },
  onConfigChange(config) {
    if (config.enabled !== true) {
      this.stop();
      return;
    }
    this.revision++;
    this.config = config;
    this.scope?.abort();
    if (this.active) this.reconcile();
  },
  register(config) {
    this.onConfigChange(config);
  },
  unregister() {
    this.revision++;
    const scope = this.scope,
      releases = this.releases.splice(0);
    this.scope = undefined;
    scope?.abort();
    for (const release of releases) release();
  },
  reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (;;) {
        const oldScope = this.scope,
          releases = this.releases.splice(0);
        this.scope = undefined;
        oldScope?.abort();
        for (const release of releases) release();
        const window = this.window,
          config = this.config,
          revision = this.revision;
        if (!this.active || !window || !config || config.enabled !== true)
          return;
        const scope = new AbortController();
        this.scope = scope;
        const contents = window.webContents;
        const scalar = () =>
          this.active &&
          this.window === window &&
          this.config === config &&
          revision === this.revision &&
          this.scope === scope &&
          !scope.signal.aborted;
        const current = () => {
          if (!scalar()) return false;
          try {
            const unavailable =
              window.isDestroyed() ||
              window.webContents !== contents ||
              contents.isDestroyed?.();
            return !unavailable && scalar();
          } catch {
            return false;
          }
        };
        if (!current()) {
          if (!scalar()) continue;
          return;
        }
        const controls = getSongControls(window);
        const focusWindow = () => {
          if (!current()) return;
          const minimized = window.isMinimized();
          if (!scalar()) return;
          if (minimized) {
            window.restore();
            if (!scalar()) return;
          }
          if (!current()) return;
          const visible = window.isVisible();
          if (!scalar()) return;
          if (!visible) {
            window.show();
            if (!scalar()) return;
          }
          if (current() && scalar()) window.focus();
        };
        const gesture = createPlayPauseGesture({
          now: () => performance.now(),
          isCurrent: current,
          playPause: controls.playPause,
          focusWindow,
        });
        const pressed = new Set<string>();
        const acceptedLocalPresses = new Map<string, number>();
        let pressId = 0;
        let input: { pressId: number; repeat: boolean } | undefined;
        const reset = () => {
          gesture.reset();
          pressed.clear();
          acceptedLocalPresses.clear();
          input = undefined;
        };
        const beforeInput = (_event: Electron.Event, value: Electron.Input) => {
          if (!current()) return;
          const code = value.code || value.key;
          if (value.type === 'keyUp') {
            pressed.delete(code);
            input = undefined;
            return;
          }
          if (value.type !== 'keyDown') return;
          const repeat = value.isAutoRepeat || pressed.has(code);
          pressed.add(code);
          input = { pressId: ++pressId, repeat };
        };
        const navigation = (
          event: unknown,
          _url: unknown,
          _inPlace: unknown,
          main: unknown,
        ) => {
          const details =
            typeof event === 'object' && event
              ? (event as { isMainFrame?: boolean })
              : undefined;
          if (main === true || details?.isMainFrame === true) {
            this.documentRevision++;
            reset();
          }
        };
        const committed = () => {
          this.documentRevision++;
          reset();
        };
        contents.prependListener?.('before-input-event', beforeInput);
        contents.on?.('did-start-navigation', navigation);
        contents.on?.('did-navigate', committed);
        window.on?.('blur', reset);
        this.releases.push(() => {
          reset();
          contents.off?.('before-input-event', beforeInput);
          contents.off?.('did-start-navigation', navigation);
          contents.off?.('did-navigate', committed);
          window.off?.('blur', reset);
        });
        const seconds = (direction: 'Forward' | 'Backward') => {
          const fallback = this.isPodcast
            ? direction === 'Forward'
              ? 10
              : 30
            : 5;
          const key = this.isPodcast
            ? (`podcastSeek${direction}Seconds` as const)
            : (`seek${direction}Seconds` as const);
          const raw = config[key];
          const value =
            typeof raw === 'number' || typeof raw === 'string'
              ? Number(raw)
              : NaN;
          return Number.isFinite(value) && value > 0
            ? Math.min(600, value)
            : fallback;
        };
        const actions: Record<keyof ShortcutMappingType, () => void> = {
          previous: controls.previous,
          playPause: controls.playPause,
          next: controls.next,
          like: controls.like,
          dislike: controls.dislike,
          seekForward: () => {
            const amount = seconds('Forward');
            if (current()) controls.goForward(amount);
          },
          seekBackward: () => {
            const amount = seconds('Backward');
            if (current()) controls.goBack(amount);
          },
        };
        const action =
          (
            name: keyof ShortcutMappingType,
            kind: 'global' | 'local',
            accelerator: string,
          ) =>
          () => {
            if (!scalar()) return;
            if (
              kind === 'local' &&
              ['playPause', 'like', 'dislike'].includes(name) &&
              input?.repeat
            )
              return;
            if (kind === 'local' && input) {
              if (acceptedLocalPresses.get(accelerator) === input.pressId)
                return;
              // Claim this observed delivery before native owner predicates
              // can reenter its callback. New repeated-down events keep new IDs.
              acceptedLocalPresses.set(accelerator, input.pressId);
            }
            if (!current()) return;
            if (
              name === 'playPause' &&
              config.focusWindowOnDoublePlayPause === true
            ) {
              if (kind === 'local' && !input) return;
              gesture.invoke({
                scope: kind,
                bindingId: kind + ':' + accelerator,
                ...input,
              });
            } else if (current() && scalar()) actions[name]();
          };
        const global = (accelerator: string, invoke: () => void) => {
          const release = registerOwnedGlobalShortcut(
            { signal: scope.signal, isCurrent: current },
            accelerator,
            invoke,
          );
          if (release) this.releases.push(release);
        };
        if (config.overrideMediaKeys) {
          global(
            'MediaPlayPause',
            action('playPause', 'global', 'MediaPlayPause'),
          );
          global('MediaNextTrack', action('next', 'global', 'MediaNextTrack'));
          global(
            'MediaPreviousTrack',
            action('previous', 'global', 'MediaPreviousTrack'),
          );
        }
        for (const kind of ['global', 'local'] as const) {
          for (const name of Object.keys(
            actions,
          ) as (keyof ShortcutMappingType)[]) {
            if (!current()) break;
            const accelerator = config[kind]?.[name];
            if (typeof accelerator !== 'string' || !accelerator.trim())
              continue;
            const invoke = action(name, kind, accelerator);
            if (kind === 'global') global(accelerator, invoke);
            else {
              try {
                const occupiedGlobal = globalShortcut.isRegistered(accelerator);
                let occupiedLocal = false;
                try {
                  occupiedLocal = isRegisteredElectronLocalShortcut(
                    window,
                    accelerator,
                  );
                } catch (error) {
                  // electron-localshortcut 3.2.1 iterates an absent registry
                  // on the first binding (and after its last removal).
                  if (
                    !(error instanceof TypeError) ||
                    error.message !== 'shortcutsOfWindow is not iterable'
                  )
                    throw error;
                }
                if (!current()) break;
                if (occupiedGlobal || occupiedLocal) continue;
                registerElectronLocalShortcut(window, accelerator, invoke);
                this.releases.push(() => {
                  try {
                    if (!window.isDestroyed())
                      unregisterElectronLocalShortcut(window, accelerator);
                  } catch (error) {
                    console.warn(
                      'Unable to unregister local shortcut',
                      accelerator,
                      error,
                    );
                  }
                });
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
        if (scalar()) return;
      }
    } finally {
      this.reconciling = false;
    }
  },
});
