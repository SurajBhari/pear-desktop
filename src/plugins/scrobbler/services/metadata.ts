import { app, net } from 'electron';

import { MusicBrainz, validMusicBrainzEmail } from './musicbrainz';
import { RegexFilters } from './regex-filters';

import type { ScrobblerPluginConfig } from '../config';
import type { ProjectedSong } from './base';

export interface MetadataPreparer {
  prepare(
    input: ProjectedSong,
    config: ScrobblerPluginConfig,
    signal: AbortSignal,
    budgetMs: number,
    fallback: (value: ProjectedSong) => void,
  ): Promise<ProjectedSong>;
  stop(): void;
}
export const metadataEnabled = (config: ScrobblerPluginConfig) =>
  config.regexFiltersEnabled === true ||
  (config.useMusicBrainz === true &&
    validMusicBrainzEmail(config.musicBrainzEmail));

export class Metadata implements MetadataPreparer {
  private readonly regex = new RegexFilters();
  private brainz?: MusicBrainz;
  async prepare(
    input: ProjectedSong,
    config: ScrobblerPluginConfig,
    signal: AbortSignal,
    budgetMs: number,
    fallback: (value: ProjectedSong) => void,
  ) {
    const start = Date.now();
    let result = input;
    if (config.regexFiltersEnabled === true)
      result = await this.regex.apply(
        config.customRegexFilters,
        result,
        signal,
      );
    if (signal.aborted) return input;
    fallback(result);
    if (
      config.useMusicBrainz === true &&
      validMusicBrainzEmail(config.musicBrainzEmail)
    ) {
      this.brainz ??= new MusicBrainz({
        fetcher: (url, init) =>
          net.fetch(url instanceof URL ? url.href : url, init),
        identity: `PearDesktop/${app.getVersion()}`,
      });
      result = await this.brainz.correct(
        result,
        config.musicBrainzEmail,
        signal,
        Math.max(0, budgetMs - (Date.now() - start)),
        { originalArtist: input.artist, durationSeconds: input.duration },
      );
    }
    return result;
  }
  stop() {
    this.regex.stop();
    this.brainz?.stop();
  }
}
