import { net } from 'electron';

import {
  ScrobblerBase,
  projectSong,
  type ServiceRuntime,
  type SubmissionOwner,
} from './base';
import { WsAuthController, type OpenAuthSurface } from './ws-auth';
import { openScrobblingAuthWindow } from './ws-auth-window';
import { requestWs, WsError } from './ws-client';

import {
  authRootFor,
  readWsAccount,
  sessionPatch,
  type WsServiceName,
  type ScrobblerPluginConfig,
} from '../config';

import type { SongInfo } from '@/providers/song-info';

export interface CompatibleDependencies {
  fetcher?: typeof fetch;
  openAuthSurface?: OpenAuthSurface;
  authTiming?: { pollMs?: number; deadlineMs?: number };
}
export class CompatibleScrobbler extends ScrobblerBase {
  readonly fingerprint: string;
  private readonly fetcher: typeof fetch;
  private readonly openSurface: OpenAuthSurface;
  private auth: WsAuthController;
  private readonly requests = new Set<AbortController>();
  private readonly invalidations = new Set<string>();
  private retired = false;
  private observedKey: string | null;
  private pendingAuthKey?: string;
  private automaticReauthUsed = false;
  constructor(
    private readonly name: WsServiceName,
    private readonly runtime: ServiceRuntime,
    private readonly dependencies: CompatibleDependencies = {},
  ) {
    super();
    const captured = readWsAccount(runtime.readConfig(), name);
    this.fingerprint = captured?.fingerprint ?? '';
    this.observedKey = captured?.key ?? null;
    this.fetcher =
      dependencies.fetcher ??
      ((input, init) =>
        net.fetch(input instanceof URL ? input.href : input, init));
    this.openSurface =
      dependencies.openAuthSurface ??
      ((url, signal) => openScrobblingAuthWindow(runtime.window, url, signal));
    this.auth = this.newAuth();
  }
  private newAuth() {
    return new WsAuthController(
      this.fetcher,
      this.openSurface,
      this.dependencies.authTiming,
    );
  }
  private capture() {
    try {
      if (this.retired || !this.runtime.isCurrent() || this.retired) return;
      const current = readWsAccount(this.runtime.readConfig(), this.name);
      return !this.retired && current?.fingerprint === this.fingerprint
        ? current
        : undefined;
    } catch {
      return;
    }
  }
  isSessionCreated() {
    return !!this.capture()?.key;
  }
  createSession(force = false): Promise<boolean> {
    const captured = this.capture();
    if (!captured) return Promise.resolve(false);
    if (!force && captured.key) return Promise.resolve(true);
    if (force) this.automaticReauthUsed = false;
    const auth = this.auth;
    const current = () => {
      const now = this.capture();
      return (
        !!now && (now.key === captured.key || now.key === this.pendingAuthKey)
      );
    };
    const pending = auth.login(
      { ...captured.account, authRoot: authRootFor(this.name) },
      async (key) => {
        if (!current()) throw Error('Scrobbling account retired');
        this.pendingAuthKey = key;
        if (
          !(await this.runtime.writeConfig(
            sessionPatch(this.name, key),
            current,
          ))
        )
          throw Error('Scrobbling account retired');
      },
      current,
    );
    pending.then(
      () => {
        if (this.auth === auth) this.pendingAuthKey = undefined;
      },
      () => {},
    );
    return pending;
  }
  configurationChanged() {
    const now = this.capture();
    if (!now) {
      this.stop();
      return;
    }
    if (now.key !== this.observedKey) {
      for (const request of this.requests) request.abort();
      if (now.key !== this.pendingAuthKey) {
        this.auth.stop();
        this.auth = this.newAuth();
        this.pendingAuthKey = undefined;
        if (now.key) this.automaticReauthUsed = false;
      }
      this.observedKey = now.key;
    }
  }
  stop() {
    if (this.retired) return;
    this.retired = true;
    this.auth.stop();
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }
  setNowPlaying(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
  ) {
    return this.post(info, config, owner, 'track.updateNowPlaying');
  }
  addScrobble(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
  ) {
    return this.post(info, config, owner, 'track.scrobble');
  }
  private async post(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
    method: string,
  ): Promise<boolean> {
    const elapsed = info.elapsedSeconds ?? 0;
    const elapsedMilliseconds = elapsed * 1000;
    if (
      method === 'track.scrobble' &&
      (!Number.isFinite(elapsed) || elapsed < 0)
    )
      return false;
    const account = this.capture(),
      song = projectSong(info, config);
    if (!account?.key || !song || owner.signal.aborted) return false;
    const scope = new AbortController();
    this.requests.add(scope);
    const signal = AbortSignal.any([scope.signal, owner.signal]);
    const current = () => {
      try {
        if (signal.aborted || this.retired) return false;
        const accepted = owner.isCurrent();
        const latest = this.capture();
        return (
          accepted &&
          !signal.aborted &&
          !this.retired &&
          latest?.key === account.key
        );
      } catch {
        return false;
      }
    };
    try {
      if (!current()) return false;
      await requestWs(
        this.fetcher,
        account.account,
        {
          method,
          track: song.title,
          artist: song.artist,
          duration: song.duration,
          sk: account.key,
          ...(song.album === undefined ? {} : { album: song.album }),
          ...(method === 'track.scrobble'
            ? {
                timestamp: Math.trunc(
                  (Date.now() - elapsedMilliseconds) / 1000,
                ),
              }
            : {}),
        },
        signal,
      );
      return current();
    } catch (error) {
      if (
        error instanceof WsError &&
        error.code === 9 &&
        current() &&
        !this.invalidations.has(account.key)
      ) {
        this.invalidations.add(account.key);
        try {
          const cleared = await this.runtime
            .writeConfig(sessionPatch(this.name, null), current)
            .catch(() => false);
          if (
            cleared &&
            !this.retired &&
            this.capture()?.key === null &&
            !this.automaticReauthUsed
          ) {
            this.automaticReauthUsed = true;
            this.createSession().catch(() => {});
          }
        } finally {
          this.invalidations.delete(account.key);
        }
      }
      return false;
    } finally {
      this.requests.delete(scope);
      scope.abort();
    }
  }
}
