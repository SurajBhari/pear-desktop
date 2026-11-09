import { setTimeout, clearTimeout } from 'node:timers';

import { deepmergeCustom } from 'deepmerge-ts';
import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents,
  type WebFrameMain,
} from 'electron';

import {
  registerCallback,
  MediaType,
  SongInfoEvent,
  getSongInfoProvenance,
  getCurrentSongInfoProvenance,
  type SongInfo,
  type SongInfoProvenance,
} from '@/providers/song-info';
import { createBackend } from '@/utils';

import {
  readWsAccount,
  applyScrobblerPatch,
  readListenbrainzAccount,
  type ScrobblerPluginConfig,
  type ScrobblerConfigPatch,
  type WsServiceName,
} from './config';
import {
  projectSong,
  readProjectedSong,
  type ProjectedSong,
  type ScrobblerBase,
  type ServiceRuntime,
} from './services/base';
import { createLastFmService } from './services/lastfm';
import { createLibreFmService } from './services/librefm';
import { createListenbrainzService } from './services/listenbrainz';
import {
  Metadata,
  metadataEnabled,
  type MetadataPreparer,
} from './services/metadata';

import type { BackendContext } from '@/types/contexts';

export type SetConfType = (conf: ScrobblerConfigPatch) => void | Promise<void>;
type ServiceName = WsServiceName | 'listenbrainz';
type Track = {
  info: SongInfo;
  token: SongInfoProvenance;
  scope: AbortController;
  submitted: boolean;
  preparation?: {
    revision: number;
    promise: Promise<ProjectedSong>;
    freeze: () => ProjectedSong;
    cancel: () => void;
  };
};
const merge = deepmergeCustom({ mergeArrays: false });
export class ScrobblerManager {
  readonly services = new Map<ServiceName, ScrobblerBase>();
  private active = true;
  private config?: ScrobblerPluginConfig;
  private configRevision = 0;
  private viewEpoch = 0;
  private contents: WebContents;
  private frame?: WebFrameMain;
  private track?: Track;
  private latest?: SongInfo;
  private timer?: NodeJS.Timeout;
  private cleanup: (() => void)[] = [];
  private readonly metadata: MetadataPreparer;
  constructor(
    private readonly context: BackendContext<ScrobblerPluginConfig>,
    dependencies: { metadata?: MetadataPreparer } = {},
  ) {
    this.metadata = dependencies.metadata ?? new Metadata();
    this.contents = context.window.webContents;
    try {
      this.frame = this.contents.mainFrame;
    } catch {
      this.frame = undefined;
    }
    const raw = (event: IpcMainEvent) => {
      let frame: WebFrameMain;
      try {
        frame = this.contents.mainFrame;
      } catch {
        return;
      }
      if (
        !this.active ||
        event.sender !== this.contents ||
        event.senderFrame !== frame
      )
        return;
      this.retireTrack();
      this.latest = undefined;
      if (this.frame !== frame) {
        this.retireServices();
        this.frame = frame;
        this.reconcileServices();
      }
    };
    ipcMain.on('peard:video-src-changed', raw);
    this.cleanup.push(() =>
      ipcMain.removeListener('peard:video-src-changed', raw),
    );
    const closed = () => this.stop();
    context.window.on('closed', closed);
    this.contents.on('destroyed', closed);
    this.cleanup.push(
      () => context.window.removeListener('closed', closed),
      () => this.contents.removeListener('destroyed', closed),
    );
    const unavailable = () => {
      if (!this.active) return;
      this.retireTrack();
      this.retireServices();
      this.frame = undefined;
      this.latest = undefined;
    };
    const navigation = (...args: unknown[]) => {
      const detail =
        typeof args[0] === 'object' && args[0]
          ? (args[0] as Record<string, unknown>)
          : undefined;
      const main =
        typeof args[3] === 'boolean' ? args[3] : detail?.isMainFrame === true;
      const inPlace =
        typeof args[2] === 'boolean' ? args[2] : detail?.isInPlace === true;
      if (main && !inPlace) unavailable();
    };
    this.contents.on('render-process-gone', unavailable);
    this.contents.on('did-start-navigation', navigation);
    const ready = () => {
      try {
        if (
          !this.active ||
          this.context.window.isDestroyed() ||
          this.contents.isDestroyed() ||
          this.context.window.webContents !== this.contents
        )
          return;
        const frame = this.contents.mainFrame;
        if (this.frame === frame) return;
        this.retireTrack();
        this.latest = undefined;
        this.retireServices();
        this.frame = frame;
        this.reconcileServices();
      } catch {
        return;
      }
    };
    this.contents.on('did-finish-load', ready);
    this.cleanup.push(
      () => this.contents.removeListener('render-process-gone', unavailable),
      () => this.contents.removeListener('did-start-navigation', navigation),
      () => this.contents.removeListener('did-finish-load', ready),
    );
    this.cleanup.push(
      registerCallback((info, event) => this.onInfo(info, event), {
        replayCurrent: true,
      }),
    );
  }
  private ownsWindow() {
    try {
      if (!this.active || !this.frame) return false;
      const closed =
        this.context.window.isDestroyed() || this.contents.isDestroyed();
      const frame = this.contents.mainFrame;
      return (
        !closed &&
        this.active &&
        this.context.window.webContents === this.contents &&
        frame === this.frame
      );
    } catch {
      return false;
    }
  }
  private current(info: SongInfo, token: SongInfoProvenance) {
    if (!this.ownsWindow()) return false;
    const owned = getSongInfoProvenance(info),
      current = getCurrentSongInfoProvenance(this.context.window);
    return (
      !!owned &&
      owned === token &&
      current === token &&
      this.active &&
      this.ownsWindow()
    );
  }
  async start() {
    const revision = this.configRevision;
    try {
      const config = await this.context.getConfig();
      if (!this.active) return;
      if (this.configRevision === revision) this.configurationChanged(config);
      else this.reconcileServices();
    } catch {
      if (this.active && revision === this.configRevision) this.stop();
    }
  }
  configurationChanged(config: ScrobblerPluginConfig) {
    if (!this.active) return;
    this.configRevision++;
    this.config = config;
    this.retireTrack(false);
    this.reconcileServices();
    this.reconsider();
  }
  private retireServices() {
    this.viewEpoch++;
    for (const service of this.services.values()) service.stop();
    this.services.clear();
  }
  private retireTrack(clear = true) {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.track?.scope.abort();
    this.track?.preparation?.cancel();
    if (this.track) this.track.preparation = undefined;
    if (clear) this.track = undefined;
    else if (this.track) this.track.scope = new AbortController();
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    this.retireTrack();
    this.retireServices();
    this.metadata.stop();
    this.latest = undefined;
    for (const dispose of this.cleanup.splice(0)) dispose();
  }
  authenticate(
    name: WsServiceName,
    window: BrowserWindow = this.context.window,
  ) {
    const service = this.services.get(name);
    return window === this.context.window && this.ownsWindow() && service
      ? service.createSession(true)
      : Promise.resolve(false);
  }
  private reconcileServices() {
    if (!this.ownsWindow() || this.config?.enabled !== true) {
      this.retireServices();
      return;
    }
    for (const name of ['lastfm', 'librefm', 'listenbrainz'] as const) {
      const fingerprint =
        name === 'listenbrainz'
          ? readListenbrainzAccount(this.config)?.fingerprint
          : readWsAccount(this.config, name)?.fingerprint;
      let service = this.services.get(name);
      if (service && service.fingerprint !== fingerprint) {
        service.stop();
        this.services.delete(name);
        service = undefined;
      }
      if (!fingerprint) continue;
      if (service) {
        service.configurationChanged();
        continue;
      }
      const epoch = this.viewEpoch;
      let created: ScrobblerBase;
      const runtime: ServiceRuntime = {
        window: this.context.window,
        readConfig: () => this.config,
        isCurrent: () =>
          this.active &&
          this.viewEpoch === epoch &&
          this.services.get(name) === created &&
          this.ownsWindow(),
        writeConfig: (patch, guard) => this.writeConfig(patch, guard),
      };
      created =
        name === 'lastfm'
          ? createLastFmService(runtime)
          : name === 'librefm'
            ? createLibreFmService(runtime)
            : createListenbrainzService(runtime);
      this.services.set(name, created);
      const revision = this.configRevision;
      if (!created.isSessionCreated())
        created.createSession().then(
          (success) => {
            if (
              success &&
              revision === this.configRevision &&
              runtime.isCurrent()
            )
              this.reconsider();
          },
          () => {},
        );
    }
  }
  private async writeConfig(
    patch: ScrobblerConfigPatch,
    guard: () => boolean,
  ): Promise<boolean> {
    const epoch = this.viewEpoch,
      revision = this.configRevision;
    try {
      if (
        !this.ownsWindow() ||
        !guard() ||
        !this.active ||
        epoch !== this.viewEpoch
      )
        return false;
      await applyScrobblerPatch(this.context.setConfig, patch);
      if (!this.active || epoch !== this.viewEpoch || !this.ownsWindow())
        return false;
      if (revision === this.configRevision && this.config)
        this.configurationChanged(
          merge(this.config, patch) as ScrobblerPluginConfig,
        );
      return true;
    } catch {
      return false;
    }
  }
  private onInfo(info: SongInfo, event: SongInfoEvent) {
    const token = getSongInfoProvenance(info);
    if (!token || !this.current(info, token)) return;
    this.latest = info;
    if (event === SongInfoEvent.TimeChanged) return;
    if (!this.track || this.track.token !== token) {
      this.retireTrack();
      this.track = {
        info,
        token,
        scope: new AbortController(),
        submitted: false,
      };
    } else this.track.info = info;
    this.reconsider();
  }
  private reconsider() {
    const config = this.config,
      info = this.latest;
    const token = info && getSongInfoProvenance(info);
    if (
      !config ||
      config.enabled !== true ||
      !info ||
      !token ||
      !this.current(info, token)
    ) {
      return;
    }
    if (!this.track || this.track.token !== token) {
      this.retireTrack();
      this.track = {
        info,
        token,
        scope: new AbortController(),
        submitted: false,
      };
    }
    const track = this.track;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (
      info.isPaused ||
      (!config.scrobbleOtherMedia &&
        info.mediaType !== MediaType.Audio &&
        info.mediaType !== MediaType.OriginalMusicVideo)
    ) {
      track.preparation?.freeze();
      return;
    }
    const revision = this.configRevision,
      epoch = this.viewEpoch;
    const owner = {
      signal: track.scope.signal,
      isCurrent: () =>
        this.active &&
        revision === this.configRevision &&
        epoch === this.viewEpoch &&
        this.track === track &&
        !track.scope.signal.aborted &&
        this.current(track.info, track.token),
    };
    const elapsed = info.elapsedSeconds ?? 0,
      duration = info.songDuration;
    const validTiming =
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      Number.isFinite(duration) &&
      duration >= 0;
    const threshold = Math.min(Math.ceil(duration / 2), 4 * 60);
    const delay =
      validTiming && threshold > elapsed
        ? (threshold - elapsed) * 1000
        : undefined;
    const input = projectSong(info, config);
    if (!input) return;
    if (!track.preparation || track.preparation.revision !== revision) {
      const scope = new AbortController();
      const signal = AbortSignal.any([owner.signal, scope.signal]);
      let best = input,
        frozen = false;
      let settle!: (value: ProjectedSong) => void;
      let deadline: NodeJS.Timeout | undefined;
      const promise = new Promise<ProjectedSong>((resolve) => {
        settle = resolve;
      });
      const freeze = () => {
        if (!frozen) {
          frozen = true;
          clearTimeout(deadline);
          scope.abort();
          settle(Object.freeze(best));
        }
        return best;
      };
      track.preparation = {
        revision,
        promise,
        freeze,
        cancel: () => {
          freeze();
        },
      };
      if (metadataEnabled(config)) {
        const budget = Math.min(2500, delay ?? 2500);
        if (delay === undefined || budget < delay)
          deadline = setTimeout(freeze, budget);
        const snapshot = {
          ...config,
          customRegexFilters: Array.isArray(config.customRegexFilters)
            ? [...config.customRegexFilters]
            : config.customRegexFilters,
        };
        this.metadata
          .prepare(input, snapshot, signal, budget, (fallback) => {
            const accepted = readProjectedSong(fallback);
            if (!frozen && owner.isCurrent() && accepted) best = accepted;
          })
          .then((result) => {
            const accepted = readProjectedSong(result);
            if (!frozen && owner.isCurrent() && accepted) best = accepted;
            freeze();
          }, freeze);
      } else freeze();
    }
    const preparation = track.preparation;
    let announced = false;
    const announce = (metadata: ProjectedSong) => {
      if (
        announced ||
        !owner.isCurrent() ||
        track.info.isPaused ||
        track.preparation !== preparation
      )
        return;
      announced = true;
      for (const service of this.services.values())
        service
          .setNowPlaying(info, config, { ...owner, metadata })
          .catch(() => {});
    };
    preparation.promise.then(announce);
    if (
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      track.submitted
    )
      return;
    // Preserve the existing threshold/elapsed branch; TimeChanged mutates info.
    if (threshold > elapsed)
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          if (!owner.isCurrent() || track.info.isPaused || track.submitted)
            return;
          const metadata = preparation.freeze();
          announce(metadata);
          track.submitted = true;
          for (const service of this.services.values())
            service
              .addScrobble(track.info, this.config!, { ...owner, metadata })
              .catch(() => {});
        },
        (threshold - elapsed) * 1000,
      );
  }
}
export const createScrobblerManager = (
  context: BackendContext<ScrobblerPluginConfig>,
  dependencies?: { metadata?: MetadataPreparer },
) => new ScrobblerManager(context, dependencies);
export const backend = createBackend<
  {
    manager?: ScrobblerManager;
    enabledScrobblers: Map<ServiceName, ScrobblerBase>;
    lifecycleRevision: number;
    authenticate: (
      name: WsServiceName,
      window: BrowserWindow,
    ) => Promise<boolean>;
  },
  ScrobblerPluginConfig
>({
  enabledScrobblers: new Map(),
  lifecycleRevision: 0,
  async start(context) {
    this.manager?.stop();
    this.lifecycleRevision++;
    this.manager = createScrobblerManager(context);
    this.enabledScrobblers = this.manager.services;
    await this.manager.start();
  },
  stop() {
    this.lifecycleRevision++;
    this.manager?.stop();
    this.manager = undefined;
    this.enabledScrobblers = new Map();
  },
  onConfigChange(config) {
    this.manager?.configurationChanged(config);
  },
  authenticate(name, window) {
    return this.manager
      ? this.manager.authenticate(name, window)
      : Promise.resolve(false);
  },
});
