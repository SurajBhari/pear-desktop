import {
  MUSIC_LIMITS,
  failMusic,
  utf8Bytes,
  type MusicPrepareInput,
} from '@/plugins/api-server/music-types';

import { assertMetadataWorkBudget } from './music-metadata';
import { isPlaylistId, isVideoId } from './queue-playlist';

type Obj = Record<string, unknown>;
export type MusicNavigationEndpoint =
  | { watchEndpoint: { videoId: string; playlistId?: string; params?: string } }
  | { watchPlaylistEndpoint: { playlistId: string; params?: string } };
const object = (value: unknown): Obj | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : undefined;
const at = (value: unknown, ...keys: string[]): unknown => {
  for (const key of keys) {
    const o = object(value);
    if (!o) return;
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d) return;
    if (!('value' in d)) return failMusic('source');
    value = d.value;
  }
  return value;
};
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : failMusic('source');
export function parseNavigationCommand(
  value: unknown,
): MusicPrepareInput | null {
  try {
    assertMetadataWorkBudget(value);
  } catch {
    return null;
  }
  const v = object(value);
  if (!v) return null;
  const keys = Object.keys(v);
  if (
    v.action === 'play_song' &&
    keys.every((k) => ['action', 'videoId', 'playlistId'].includes(k)) &&
    isVideoId(v.videoId) &&
    (v.playlistId === undefined || isPlaylistId(v.playlistId))
  )
    return {
      action: 'play_song',
      videoId: v.videoId,
      ...(v.playlistId === undefined ? {} : { playlistId: v.playlistId }),
    };
  if (
    v.action === 'play_playlist' &&
    keys.every((k) =>
      ['action', 'playlistId', 'videoId', 'shuffle'].includes(k),
    ) &&
    isPlaylistId(v.playlistId) &&
    (v.videoId === undefined || isVideoId(v.videoId)) &&
    (v.shuffle === undefined || typeof v.shuffle === 'boolean')
  )
    return {
      action: 'play_playlist',
      playlistId: v.playlistId,
      shuffle: v.shuffle === true,
      ...(v.videoId === undefined ? {} : { videoId: v.videoId }),
    };
  const seed = object(v.seed);
  if (v.action !== 'radio' || keys.length !== 2 || !seed) return null;
  if (seed.kind === 'current' && Object.keys(seed).length === 1)
    return { action: 'radio', seed: { kind: 'current' } };
  if (
    seed.kind === 'video' &&
    Object.keys(seed).length === 2 &&
    isVideoId(seed.videoId)
  )
    return { action: 'radio', seed: { kind: 'video', videoId: seed.videoId } };
  if (
    seed.kind === 'playlist' &&
    Object.keys(seed).length === 2 &&
    isPlaylistId(seed.playlistId)
  )
    return {
      action: 'radio',
      seed: { kind: 'playlist', playlistId: seed.playlistId },
    };
  return null;
}
function endpoint(value: unknown): MusicNavigationEndpoint {
  const watch = at(value, 'watchEndpoint'),
    playlist = at(value, 'watchPlaylistEndpoint');
  if (!!watch === !!playlist) return failMusic('unsupported');
  const raw = object(watch ?? playlist);
  if (!raw) return failMusic('source');
  const params = at(raw, 'params');
  if (
    params !== undefined &&
    (typeof params !== 'string' ||
      !params ||
      utf8Bytes(params) > MUSIC_LIMITS.recipeBytes ||
      Array.from(params).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    return failMusic('source');
  if (watch) {
    if (
      !isVideoId(raw.videoId) ||
      (raw.playlistId !== undefined && !isPlaylistId(raw.playlistId))
    )
      return failMusic('source');
    return {
      watchEndpoint: {
        videoId: raw.videoId,
        ...(raw.playlistId === undefined ? {} : { playlistId: raw.playlistId }),
        ...(params === undefined ? {} : { params }),
      },
    };
  }
  if (!isPlaylistId(raw.playlistId)) return failMusic('source');
  return {
    watchPlaylistEndpoint: {
      playlistId: raw.playlistId,
      ...(params === undefined ? {} : { params }),
    },
  };
}
function candidates(node: unknown, role: string): unknown[] {
  const result: unknown[] = [];
  const take = (item: unknown) => {
    const button =
      at(item, 'buttonRenderer') ?? at(item, 'menuNavigationItemRenderer');
    if (at(button, 'icon', 'iconType') === role)
      result.push(at(button, 'navigationEndpoint'));
    const play = at(item, 'musicPlayButtonRenderer');
    if (at(play, 'playIcon', 'iconType') === role)
      result.push(at(play, 'playNavigationEndpoint'));
    for (const entry of list(at(item, 'menuRenderer', 'items'))) take(entry);
  };
  for (const button of list(at(node, 'buttons'))) take(button);
  for (const item of list(at(node, 'menu', 'menuRenderer', 'items')))
    take(item);
  return result;
}
export function directNavigation(
  command: MusicPrepareInput,
): MusicNavigationEndpoint | undefined {
  if (command.action === 'play_song')
    return {
      watchEndpoint: {
        videoId: command.videoId,
        ...(command.playlistId === undefined
          ? {}
          : { playlistId: command.playlistId }),
      },
    };
  if (command.action === 'play_playlist' && !command.shuffle)
    return command.videoId
      ? {
          watchEndpoint: {
            videoId: command.videoId,
            playlistId: command.playlistId,
          },
        }
      : { watchPlaylistEndpoint: { playlistId: command.playlistId } };
  return undefined;
}
export function projectNavigationRecipe(
  raw: unknown,
  command: MusicPrepareInput,
): MusicNavigationEndpoint {
  assertMetadataWorkBudget(raw);
  let bytes = 0;
  const pending: unknown[] = [raw];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (value.length > MUSIC_LIMITS.nativeBytes) return failMusic('budget');
      bytes += utf8Bytes(value);
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (key.length > MUSIC_LIMITS.nativeBytes) return failMusic('budget');
        bytes += utf8Bytes(key);
        pending.push(Object.getOwnPropertyDescriptor(value, key)!.value);
      }
    }
    if (bytes > MUSIC_LIMITS.nativeBytes) return failMusic('budget');
  }
  if (utf8Bytes(JSON.stringify(raw)) > MUSIC_LIMITS.nativeBytes)
    return failMusic('budget');
  // Known public wrappers only. The bounded traversal above never invokes provider getters.
  let found: unknown[] = [];
  if (
    command.action === 'play_playlist' ||
    (command.action === 'radio' && command.seed.kind === 'playlist')
  ) {
    const role = command.action === 'play_playlist' ? 'MUSIC_SHUFFLE' : 'MIX';
    const headers: unknown[] = [
      at(raw, 'header', 'musicResponsiveHeaderRenderer'),
      at(raw, 'header', 'musicDetailHeaderRenderer'),
    ];
    const tabs = list(
      at(raw, 'contents', 'singleColumnBrowseResultsRenderer', 'tabs'),
    );
    for (const tab of tabs) {
      for (const section of list(
        at(tab, 'tabRenderer', 'content', 'sectionListRenderer', 'contents'),
      )) {
        headers.push(
          at(section, 'musicResponsiveHeaderRenderer'),
          at(section, 'musicDetailHeaderRenderer'),
        );
      }
    }
    for (const header of headers)
      if (header) found.push(...candidates(header, role));
  } else if (command.action === 'radio' && command.seed.kind === 'video') {
    const tabs = list(
      at(
        raw,
        'contents',
        'singleColumnMusicWatchNextResultsRenderer',
        'tabbedRenderer',
        'watchNextTabbedResultsRenderer',
        'tabs',
      ),
    );
    for (const tab of tabs) {
      const panel = at(
        tab,
        'tabRenderer',
        'content',
        'musicQueueRenderer',
        'content',
        'playlistPanelRenderer',
      );
      for (const row of list(at(panel, 'contents'))) {
        const video = at(row, 'playlistPanelVideoRenderer');
        if (at(video, 'videoId') === command.seed.videoId)
          found.push(...candidates(video, 'MIX'));
      }
    }
  } else return failMusic('invalid');
  if (found.length !== 1) return failMusic('unsupported');
  const projected = endpoint(found[0]);
  if (
    command.action === 'radio' &&
    command.seed.kind === 'video' &&
    'watchEndpoint' in projected &&
    projected.watchEndpoint.videoId !== command.seed.videoId
  )
    return failMusic('unsupported');
  if (command.action === 'play_playlist') {
    const recipe =
      'watchEndpoint' in projected
        ? projected.watchEndpoint
        : projected.watchPlaylistEndpoint;
    if (
      recipe.playlistId !== command.playlistId ||
      (command.videoId !== undefined &&
        (!('watchEndpoint' in projected) ||
          projected.watchEndpoint.videoId !== command.videoId))
    )
      return failMusic('unsupported');
  }
  if (utf8Bytes(JSON.stringify(projected)) > MUSIC_LIMITS.recipeBytes)
    return failMusic('budget');
  return projected;
}
