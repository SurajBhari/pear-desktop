import { registerOwnedGlobalShortcut } from '@/utils/global-shortcut-owner';

import type { PlaybackSpeedPluginConfig } from './index';
import type { BackendContext } from '@/types/contexts';
import type { BrowserWindow } from 'electron';

type Release = () => void;
type SpeedBackend = {
  window?: BrowserWindow;
  config?: PlaybackSpeedPluginConfig;
  send?: (direction: 1 | -1) => void;
  active: boolean;
  generation: number;
  revision: number;
  documentRevision: number;
  reconciling: boolean;
  scope?: AbortController;
  closeListener?: Release;
  releases: Release[];
  start(context: BackendContext<PlaybackSpeedPluginConfig>): Promise<void>;
  stop(): void;
  onConfigChange(config: PlaybackSpeedPluginConfig): void;
  reconcile(): void;
};

export const backend: SpeedBackend = {
  active: false,
  generation: 0,
  revision: 0,
  documentRevision: 0,
  reconciling: false,
  releases: [],
  async start({ window, getConfig, ipc }) {
    this.stop();
    const generation = this.generation;
    this.window = window;
    this.send = (direction) => ipc.send('peard:playback-speed-step', direction);
    const closed = () => {
      if (this.generation === generation && this.window === window) this.stop();
    };
    window.on?.('closed', closed);
    if (this.generation !== generation || this.window !== window) {
      window.off?.('closed', closed);
      return;
    }
    this.closeListener = () => window.off?.('closed', closed);
    let loaded: PlaybackSpeedPluginConfig;
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
    this.reconcile();
  },
  stop() {
    this.active = false;
    this.generation++;
    this.revision++;
    this.documentRevision++;
    const scope = this.scope,
      close = this.closeListener,
      releases = this.releases.splice(0);
    this.scope = undefined;
    this.closeListener = undefined;
    this.window = undefined;
    this.config = undefined;
    this.send = undefined;
    scope?.abort();
    for (const release of releases) release();
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
          send = this.send,
          revision = this.revision;
        if (!this.active || !window || !config || !send) return;
        const scope = new AbortController();
        this.scope = scope;
        const contents = window.webContents;
        const scalar = () =>
          this.active &&
          this.window === window &&
          this.config === config &&
          this.send === send &&
          this.revision === revision &&
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
        const navigate = (
          event: unknown,
          _url: unknown,
          _inPlace: unknown,
          main: unknown,
        ) => {
          if (!scalar()) return;
          const details =
            typeof event === 'object' && event
              ? (event as { isMainFrame?: boolean })
              : undefined;
          if (main === true || details?.isMainFrame === true)
            this.documentRevision++;
        };
        const committed = () => {
          if (scalar()) this.documentRevision++;
        };
        contents.on?.('did-start-navigation', navigate);
        contents.on?.('did-navigate', committed);
        this.releases.push(() => {
          contents.off?.('did-start-navigation', navigate);
          contents.off?.('did-navigate', committed);
        });
        for (const [name, direction] of [
          ['speedUp', 1],
          ['speedDown', -1],
        ] as const) {
          if (!current()) break;
          const accelerator = config.globalShortcuts?.[name];
          if (typeof accelerator !== 'string' || !accelerator.trim()) continue;
          const release = registerOwnedGlobalShortcut(
            { signal: scope.signal, isCurrent: current },
            accelerator,
            () => {
              if (current() && scalar()) send(direction);
            },
          );
          if (release) this.releases.push(release);
        }
        if (scalar()) return;
      }
    } finally {
      this.reconciling = false;
    }
  },
};
