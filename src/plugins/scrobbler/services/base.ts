import type { ScrobblerPluginConfig, ScrobblerConfigPatch } from '../config';
import type { SongInfo } from '@/providers/song-info';
import type { BrowserWindow } from 'electron';
export interface ServiceRuntime {
  window: BrowserWindow;
  readConfig: () => ScrobblerPluginConfig | undefined;
  isCurrent: () => boolean;
  writeConfig: (
    patch: ScrobblerConfigPatch,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
}
export interface SubmissionOwner {
  signal: AbortSignal;
  isCurrent: () => boolean;
  metadata?: ProjectedSong;
}
export type ProjectedSong = {
  title: string;
  artist: string;
  duration: number;
  album?: string;
};
export const hasControls = (value: string) =>
  Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
export function readProjectedSong(value: unknown): ProjectedSong | undefined {
  if (!value || typeof value !== 'object') return;
  const fields = value as Record<string, unknown>;
  if (
    typeof fields.title !== 'string' ||
    typeof fields.artist !== 'string' ||
    !fields.artist.trim() ||
    fields.artist.length > 4096 ||
    hasControls(fields.artist) ||
    typeof fields.duration !== 'number' ||
    !Number.isFinite(fields.duration) ||
    fields.duration < 0 ||
    (fields.album !== undefined && typeof fields.album !== 'string')
  )
    return;
  return value as ProjectedSong;
}
export abstract class ScrobblerBase {
  abstract readonly fingerprint: string;
  abstract isSessionCreated(): boolean;
  abstract createSession(force?: boolean): Promise<boolean>;
  abstract configurationChanged(): void;
  abstract stop(): void;
  abstract setNowPlaying(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
  ): Promise<boolean>;
  abstract addScrobble(
    info: SongInfo,
    config: ScrobblerPluginConfig,
    owner: SubmissionOwner,
  ): Promise<boolean>;
}
export function projectSong(
  info: SongInfo,
  config: ScrobblerPluginConfig,
): ProjectedSong | undefined {
  if (info.tags !== undefined && !Array.isArray(info.tags)) return;
  const title =
    config.alternativeTitles && info.alternativeTitle !== undefined
      ? info.alternativeTitle
      : info.title;
  // Tags are arbitrary text, so preferring them requires a fresh explicit opt-in.
  // Old alternativeArtist defaults must not override the actual artist.
  const missingArtist =
    info.artist === undefined ||
    (typeof info.artist === 'string' && !info.artist.trim());
  const artist =
    (config.artistSource === 'first-tag' || missingArtist) &&
    info.tags?.at(0) !== undefined
      ? info.tags.at(0)
      : info.artist;
  if (
    typeof title !== 'string' ||
    typeof artist !== 'string' ||
    !artist.trim() ||
    artist.length > 4096 ||
    Array.from(artist).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !Number.isFinite(info.songDuration) ||
    info.songDuration < 0
  )
    return;
  return {
    title,
    artist,
    duration: info.songDuration,
    album:
      typeof info.album === 'string' && info.album ? info.album : undefined,
  };
}
