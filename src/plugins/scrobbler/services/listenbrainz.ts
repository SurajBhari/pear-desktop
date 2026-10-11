import { net } from 'electron';

import { APPLICATION_NAME } from '@/i18n';

import {
  ScrobblerBase,
  projectSong,
  type ServiceRuntime,
  type SubmissionOwner,
} from './base';

import { readListenbrainzAccount, type ScrobblerPluginConfig } from '../config';

import type { SongInfo } from '@/providers/song-info';

export class ListenbrainzScrobbler extends ScrobblerBase {
  readonly fingerprint: string;
  private retired = false;
  private requests = new Set<AbortController>();
  constructor(
    private runtime: ServiceRuntime,
    private fetcher: typeof fetch = (input, init) =>
      net.fetch(input instanceof URL ? input.href : input, init),
  ) {
    super();
    this.fingerprint =
      readListenbrainzAccount(runtime.readConfig())?.fingerprint ?? '';
  }
  private capture() {
    try {
      if (this.retired || !this.runtime.isCurrent() || this.retired) return;
      const account = readListenbrainzAccount(this.runtime.readConfig());
      return !this.retired && account?.fingerprint === this.fingerprint
        ? account
        : undefined;
    } catch {
      return;
    }
  }
  isSessionCreated() {
    return !!this.capture();
  }
  createSession() {
    return Promise.resolve(this.isSessionCreated());
  }
  configurationChanged() {
    if (!this.capture()) this.stop();
  }
  stop() {
    if (this.retired) return;
    this.retired = true;
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }
  setNowPlaying(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
  ) {
    return this.submit(info, config, owner, 'playing_now');
  }
  addScrobble(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
  ) {
    return this.submit(info, config, owner, 'single');
  }
  private async submit(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
    kind: string,
  ): Promise<boolean> {
    const account = this.capture(),
      song = projectSong(info, config);
    if (!account || !song || owner.signal.aborted) return false;
    const scope = new AbortController();
    this.requests.add(scope);
    const signal = AbortSignal.any([scope.signal, owner.signal]);
    const current = () => {
      try {
        if (this.retired || signal.aborted) return false;
        const allowed = owner.isCurrent();
        return allowed && !this.retired && !signal.aborted && !!this.capture();
      } catch {
        return false;
      }
    };
    const deadline = setTimeout(() => scope.abort(), 15000);
    try {
      if (!current()) return false;
      const response = await new Promise<Response>((resolve, reject) => {
        const abort = () => reject(Error('Scrobbling request retired'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        this.fetcher(account.apiRoot + 'submit-listens', {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          signal,
          headers: {
            'Authorization': 'Token ' + account.token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listen_type: kind,
            payload: [
              {
                track_metadata: {
                  artist_name: song.artist,
                  track_name: song.title,
                  release_name: song.album,
                  additional_info: {
                    media_player: APPLICATION_NAME + ' Desktop App',
                    submission_client:
                      APPLICATION_NAME + ' Desktop App - Scrobbler Plugin',
                    origin_url: info.url,
                    duration: song.duration,
                  },
                },
                ...(kind === 'single'
                  ? { listened_at: Math.trunc(Date.now() / 1000) }
                  : {}),
              },
            ],
          }),
        })
          .then((reply) => {
            if (signal.aborted) {
              reply.body?.cancel().catch(() => {});
              reject(Error('Scrobbling request retired'));
            } else resolve(reply);
          }, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      response.body?.cancel().catch(() => {});
      return response.ok && current();
    } catch {
      return false;
    } finally {
      clearTimeout(deadline);
      scope.abort();
      this.requests.delete(scope);
    }
  }
}
export const createListenbrainzService = (
  runtime: ServiceRuntime,
  dependencies: { fetcher?: typeof fetch } = {},
) => new ListenbrainzScrobbler(runtime, dependencies.fetcher);
