import {
  MUSIC_LIMITS,
  MusicServiceError,
  failMusic,
  utf8Bytes,
  type ArtistReference,
  type CatalogOperation,
  type MusicItem,
  type MusicRecipe,
  type MusicShelf,
  type MusicContinuation,
  type NormalizedMusicSource,
} from '@/plugins/api-server/music-types';

import { isPlaylistId, isVideoId } from './queue-playlist';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return failMusic('source');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return failMusic('source');
  return value as Obj;
};
const field = (value: unknown, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(object(value), key);
  if (!descriptor) return;
  if (!('value' in descriptor)) return failMusic('source');
  return descriptor.value;
};
const path = (value: unknown, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (value === undefined || value === null) return;
    value = field(value, key);
  }
  return value;
};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : failMusic('source');
const label = (value: unknown, maximum = 512): string => {
  if (
    typeof value !== 'string' ||
    value.length > maximum * 2 ||
    Array.from(value).length > maximum ||
    !value.trim()
  )
    return failMusic('source');
  return value;
};
const text = (value: unknown, maximum = 512): string => {
  const simple = field(value, 'simpleText');
  if (simple !== undefined) return label(simple, maximum);
  const runs = array(field(value, 'runs'));
  if (runs.length > 64) return failMusic('budget');
  let units = 0;
  return label(
    runs
      .map((run) => {
        const value = field(run, 'text');
        if (typeof value !== 'string') return failMusic('source');
        units += value.length;
        if (units > maximum * 2) return failMusic('source');
        return value;
      })
      .join(''),
    maximum,
  );
};
const isArtist = (value: unknown): value is string =>
  typeof value === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(value);
const isAlbum = (value: unknown): value is string =>
  typeof value === 'string' && /^MPRE[A-Za-z0-9_-]{1,124}$/.test(value);
const endpointBrowseId = (value: unknown) =>
  path(value, 'browseEndpoint', 'browseId');
const endpointVideoId = (value: unknown) =>
  path(value, 'watchEndpoint', 'videoId');
function artistsFrom(value: unknown): ArtistReference[] {
  if (value === undefined) return [];
  const runs = field(value, 'runs');
  if (runs === undefined) return [];
  const result: ArtistReference[] = [];
  for (const run of array(runs)) {
    const id = endpointBrowseId(field(run, 'navigationEndpoint'));
    if (isArtist(id)) result.push({ id, name: label(field(run, 'text'), 256) });
  }
  if (result.length > 8) return failMusic('budget');
  return result;
}
function durationFrom(value: unknown): number | null {
  if (value === undefined) return null;
  const runs = field(value, 'runs'),
    simple = field(value, 'simpleText');
  const values =
    simple === undefined
      ? array(runs).map((run) => field(run, 'text'))
      : [simple];
  for (const candidate of values) {
    if (typeof candidate !== 'string') return failMusic('source');
    if (/^(?:\d{1,3}:)?\d{1,2}:\d{2}$/.test(candidate)) {
      const parts = candidate.split(':').map(Number);
      if (parts.at(-1)! > 59 || (parts.length === 3 && parts[1] > 59))
        return failMusic('source');
      let seconds = 0;
      for (const part of parts) {
        seconds *= 60;
        seconds += part;
      }
      return seconds;
    }
  }
  return null;
}
function thumbnail(value: unknown): string | undefined {
  if (value === undefined) return;
  const rows = field(value, 'thumbnails');
  if (rows === undefined) return;
  const values = array(rows);
  if (values.length > 32) return failMusic('budget');
  let result: string | undefined;
  for (const row of values) {
    const raw = field(row, 'url');
    if (
      typeof raw !== 'string' ||
      raw.length > 2048 ||
      utf8Bytes(raw) > 2048 ||
      Array.from(raw).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return failMusic('source');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return failMusic('source');
    }
    if (url.protocol === 'https:' && !url.username && !url.password)
      result = url.href;
    else return failMusic('source');
  }
  return result;
}
function assertWorkBudget(root: unknown) {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [
    { value: root, depth: 0 },
  ];
  const ancestors = new WeakSet<object>();
  let visits = 0,
    pending = 1;
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.exit) {
      ancestors.delete(entry.value as object);
      continue;
    }
    pending--;
    if (
      ++visits > MUSIC_LIMITS.sourceNodes ||
      entry.depth > MUSIC_LIMITS.sourceDepth
    )
      return failMusic('budget');
    const value = entry.value;
    if (value === null || ['string', 'boolean'].includes(typeof value))
      continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return failMusic('source');
      continue;
    }
    if (!value || typeof value !== 'object') return failMusic('source');
    if (!Array.isArray(value)) object(value);
    if (ancestors.has(value)) return failMusic('source');
    if (Object.getOwnPropertySymbols(value).length) return failMusic('source');
    const isArray = Array.isArray(value);
    if (isArray && value.length > MUSIC_LIMITS.sourceNodes)
      return failMusic('budget');
    const keys = Object.getOwnPropertyNames(value);
    const childCount = keys.length - (isArray ? 1 : 0);
    if (childCount > MUSIC_LIMITS.sourceNodes - visits - pending)
      return failMusic('budget');
    pending += childCount;
    ancestors.add(value);
    stack.push({ value, depth: entry.depth, exit: true });
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        return failMusic('source');
      stack.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }
}

function rowItem(
  row: unknown,
  index: number,
): { item: MusicItem; recipe?: MusicRecipe } {
  const responsive = field(row, 'musicResponsiveListItemRenderer');
  const two = field(row, 'musicTwoRowItemRenderer');
  const multi = field(row, 'musicMultiRowListItemRenderer');
  const card = field(row, 'musicCardShelfRenderer');
  const button = field(row, 'musicNavigationButtonRenderer');
  if (
    [responsive, two, multi, button, card].filter((v) => v !== undefined)
      .length !== 1
  )
    return failMusic('unsupported');
  if (button !== undefined) {
    const endpoint = field(button, 'clickCommand'),
      id = endpointBrowseId(endpoint),
      params = path(endpoint, 'browseEndpoint', 'params');
    const categories: Record<string, string> = {
      FEmusic_explore: 'explore',
      FEmusic_charts: 'charts',
      FEmusic_moods_and_genres: 'genres',
      FEmusic_moods_and_genres_category: 'genres',
      FEmusic_new_releases: 'new-releases',
      FEmusic_new_releases_albums: 'new-releases',
    };
    if (
      typeof id !== 'string' ||
      !Object.hasOwn(categories, id) ||
      (params !== undefined &&
        (typeof params !== 'string' ||
          params.length > MUSIC_LIMITS.recipeBytes ||
          !params ||
          utf8Bytes(params) > MUSIC_LIMITS.recipeBytes))
    )
      return failMusic('unsupported');
    const title = text(field(button, 'buttonText'));
    return {
      item: {
        kind: 'category',
        id: categories[id],
        title,
        artists: [],
        durationSeconds: null,
      },
      recipe: {
        itemIndex: index,
        browseId: id,
        ...(params === undefined ? {} : { params: params }),
      },
    };
  }
  const data = responsive ?? two ?? multi ?? card;
  const rowEndpoint = field(
    data,
    multi === undefined && card === undefined ? 'navigationEndpoint' : 'onTap',
  );
  let titleValue = field(data, 'title'),
    subtitle = field(data, 'subtitle'),
    durationValue: unknown;
  if (responsive !== undefined) {
    const columns = array(field(data, 'flexColumns'));
    if (!columns.length || columns.length > 16) return failMusic('source');
    titleValue = path(
      columns[0],
      'musicResponsiveListItemFlexColumnRenderer',
      'text',
    );
    subtitle =
      columns.length > 1
        ? path(columns[1], 'musicResponsiveListItemFlexColumnRenderer', 'text')
        : undefined;
    const fixed = field(data, 'fixedColumns');
    durationValue =
      fixed === undefined
        ? subtitle
        : path(
            array(fixed)[0],
            'musicResponsiveListItemFixedColumnRenderer',
            'text',
          );
  }
  const title = text(titleValue),
    artists = artistsFrom(subtitle);
  const titleRuns = field(titleValue, 'runs');
  const titleEndpoint =
    titleRuns === undefined
      ? undefined
      : field(array(titleRuns)[0], 'navigationEndpoint');
  const rowBrowse = endpointBrowseId(rowEndpoint),
    titleBrowse = endpointBrowseId(titleEndpoint),
    rowVideo = endpointVideoId(rowEndpoint),
    titleVideo = endpointVideoId(titleEndpoint);
  if (
    (rowBrowse !== undefined &&
      titleBrowse !== undefined &&
      rowBrowse !== titleBrowse) ||
    (rowVideo !== undefined &&
      titleVideo !== undefined &&
      rowVideo !== titleVideo) ||
    (rowBrowse !== undefined && titleVideo !== undefined) ||
    (rowVideo !== undefined && titleBrowse !== undefined)
  )
    return failMusic('source');
  const endpoint = rowEndpoint ?? titleEndpoint;
  const browseId = endpointBrowseId(endpoint),
    watchId = endpointVideoId(endpoint),
    playlistVideo = path(data, 'playlistItemData', 'videoId');
  const image = thumbnail(
    path(data, 'thumbnail', 'musicThumbnailRenderer', 'thumbnail') ??
      path(data, 'thumbnailRenderer', 'musicThumbnailRenderer', 'thumbnail'),
  );
  const common = {
    title,
    artists,
    durationSeconds: durationFrom(durationValue ?? subtitle),
    ...(image === undefined ? {} : { thumbnailUrl: image }),
  };
  if (browseId !== undefined) {
    if (isArtist(browseId))
      return { item: { kind: 'artist', id: browseId, ...common } };
    if (isAlbum(browseId))
      return { item: { kind: 'album', id: browseId, ...common } };
    if (
      typeof browseId === 'string' &&
      browseId.startsWith('VL') &&
      isPlaylistId(browseId.slice(2))
    )
      return { item: { kind: 'playlist', id: browseId.slice(2), ...common } };
    return failMusic('unsupported');
  }
  const id = playlistVideo ?? watchId;
  if (
    !isVideoId(id) ||
    (playlistVideo !== undefined &&
      (!isVideoId(playlistVideo) ||
        (watchId !== undefined && watchId !== playlistVideo)))
  )
    return failMusic('source');
  let album: MusicItem['album'];
  const runs = subtitle === undefined ? undefined : field(subtitle, 'runs');
  if (runs !== undefined)
    for (const run of array(runs)) {
      const id = endpointBrowseId(field(run, 'navigationEndpoint'));
      if (isAlbum(id)) {
        if (album) return failMusic('source');
        album = { id, title: label(field(run, 'text')) };
      }
    }
  const videoType =
    path(
      endpoint,
      'watchEndpoint',
      'watchEndpointMusicSupportedConfigs',
      'watchEndpointMusicConfig',
      'musicVideoType',
    ) ??
    path(
      titleEndpoint,
      'watchEndpoint',
      'watchEndpointMusicSupportedConfigs',
      'watchEndpointMusicConfig',
      'musicVideoType',
    );
  const kind =
    multi !== undefined ||
    [
      'MUSIC_VIDEO_TYPE_UGC',
      'MUSIC_VIDEO_TYPE_OMV',
      'MUSIC_VIDEO_TYPE_PODCAST_EPISODE',
    ].includes(videoType as string)
      ? 'video'
      : 'song';
  return { item: { kind, id, ...common, ...(album ? { album } : {}) } };
}
function selectedContent(tabs: unknown): unknown {
  const values = array(tabs);
  if (values.length > 32) return failMusic('budget');
  const selected = values.filter(
    (tab) => path(tab, 'tabRenderer', 'selected') === true,
  );
  const withContent = values.filter(
    (tab) => path(tab, 'tabRenderer', 'content') !== undefined,
  );
  if (selected.length > 1 || (!selected.length && withContent.length !== 1))
    return failMusic('unsupported');
  return path(
    (selected.length ? selected : withContent)[0],
    'tabRenderer',
    'content',
  );
}

export function normalizeMusicSource(
  root: unknown,
  operation: CatalogOperation,
): NormalizedMusicSource {
  try {
    assertWorkBudget(root);
    const items: MusicItem[] = [],
      shelves: MusicShelf[] = [],
      targetRecipes: MusicRecipe[] = [];
    let continuation: MusicContinuation | null = null;
    const sourceContinuation = (value: unknown) => {
      if (value === undefined) return;
      const rows = array(value);
      if (rows.length > 4) return failMusic('budget');
      for (const row of rows) {
        const token =
          path(row, 'nextContinuationData', 'continuation') ??
          path(row, 'reloadContinuationData', 'continuation');
        if (
          typeof token !== 'string' ||
          token.length > MUSIC_LIMITS.recipeBytes ||
          !token ||
          utf8Bytes(token) > MUSIC_LIMITS.recipeBytes
        )
          return failMusic('source');
        if (continuation && continuation.token !== token)
          return failMusic('unsupported');
        continuation = {
          endpoint: operation === 'search' ? 'search' : 'browse',
          token,
        };
      }
    };
    const addRows = (rows: unknown, title?: string) => {
      const values = array(rows),
        start = items.length;
      if (values.length + items.length > MUSIC_LIMITS.sourceItems)
        return failMusic('budget');
      for (const row of values) {
        const parsed = rowItem(row, items.length);
        items.push(parsed.item);
        if (parsed.recipe) targetRecipes.push(parsed.recipe);
      }
      if (title !== undefined) {
        if (shelves.length >= MUSIC_LIMITS.sourceShelves)
          return failMusic('budget');
        shelves.push({ title, start, count: items.length - start });
      }
    };
    const section = (value: unknown) => {
      const data = field(value, 'sectionListRenderer');
      if (data === undefined) return failMusic('unsupported');
      sourceContinuation(field(data, 'continuations'));
      const rows = array(field(data, 'contents'));
      if (rows.length > MUSIC_LIMITS.sourceShelves) return failMusic('budget');
      for (const row of rows) {
        const carousel = field(row, 'musicCarouselShelfRenderer'),
          shelf = field(row, 'musicShelfRenderer'),
          playlist = field(row, 'musicPlaylistShelfRenderer'),
          grid = field(row, 'gridRenderer'),
          card = field(row, 'musicCardShelfRenderer');
        if (
          [carousel, shelf, playlist, grid, card].filter((v) => v !== undefined)
            .length !== 1
        )
          return failMusic('unsupported');
        if (card !== undefined) {
          addRows([row]);
          const contents = field(card, 'contents');
          if (contents !== undefined) addRows(contents);
          sourceContinuation(field(card, 'continuations'));
          continue;
        }
        const body = carousel ?? shelf ?? playlist ?? grid;
        const title =
          carousel !== undefined
            ? text(
                path(
                  carousel,
                  'header',
                  'musicCarouselShelfBasicHeaderRenderer',
                  'title',
                ),
              )
            : shelf !== undefined
              ? text(field(shelf, 'title'))
              : undefined;
        addRows(field(body, grid === undefined ? 'contents' : 'items'), title);
        sourceContinuation(field(body, 'continuations'));
      }
    };
    const continuationContents = field(root, 'continuationContents');
    if (continuationContents !== undefined) {
      const data =
        field(continuationContents, 'musicShelfContinuation') ??
        field(continuationContents, 'musicPlaylistShelfContinuation');
      if (data === undefined) return failMusic('unsupported');
      addRows(field(data, 'contents'));
      sourceContinuation(field(data, 'continuations'));
    } else {
      const contents = field(root, 'contents');
      if (contents === undefined) return failMusic('unsupported');
      const single = field(contents, 'singleColumnBrowseResultsRenderer'),
        two = field(contents, 'twoColumnBrowseResultsRenderer'),
        search = field(contents, 'tabbedSearchResultsRenderer');
      if ([single, two, search].filter((v) => v !== undefined).length !== 1)
        return failMusic('unsupported');
      const body = single ?? two ?? search;
      section(selectedContent(field(body, 'tabs')));
      if (two !== undefined) {
        const secondary = field(two, 'secondaryContents');
        if (secondary !== undefined) section(secondary);
      }
    }
    const result: NormalizedMusicSource = {
      version: 1,
      items,
      shelves,
      continuation,
      targetRecipes,
    };
    if (utf8Bytes(JSON.stringify(result)) > MUSIC_LIMITS.nativeBytes)
      return failMusic('budget');
    return result;
  } catch (error) {
    if (error instanceof MusicServiceError) throw error;
    return failMusic('source');
  }
}

export function sliceMusicSource(
  source: NormalizedMusicSource,
  offset: number,
  limit = 50,
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > source.items.length ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MUSIC_LIMITS.pageItems
  )
    return failMusic('invalid');
  const items: MusicItem[] = [];
  const page = () => {
    const end = offset + items.length;
    return {
      items,
      shelves: source.shelves
        .filter(
          (shelf) => shelf.start < end && shelf.start + shelf.count > offset,
        )
        .map((shelf) => ({
          title: shelf.title,
          start: Math.max(0, shelf.start - offset),
          count:
            Math.min(end, shelf.start + shelf.count) -
            Math.max(offset, shelf.start),
        })),
      nextOffset: end < source.items.length ? end : null,
    };
  };
  for (const item of source.items.slice(offset, offset + limit)) {
    items.push(item);
    // Leave room for the service-owned cursor and category reference envelope.
    if (utf8Bytes(JSON.stringify(page())) + 4096 > MUSIC_LIMITS.pageBytes) {
      items.pop();
      break;
    }
  }
  if (!items.length && offset < source.items.length) return failMusic('budget');
  return page();
}
