import {
  MUSIC_LIMITS,
  failMusic,
  utf8Bytes,
} from '@/plugins/api-server/music-types';

import { normalizeRelatedMusicSource } from './music-catalog';
import { isVideoId } from './queue-playlist';

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
    if (value === undefined) return;
    value = field(value, key);
  }
  return value;
};
const array = (value: unknown) =>
  Array.isArray(value) ? value : failMusic('source');
/** Inspect original data before any adapter; never invoke getters or coerce provider values. */
export function assertMetadataWorkBudget(root: unknown) {
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
    else {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        return failMusic('source');
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      const size: unknown = length?.value;
      if (
        !length ||
        !('value' in length) ||
        typeof size !== 'number' ||
        !Number.isInteger(size) ||
        size < 0
      )
        return failMusic('source');
      if (size > MUSIC_LIMITS.sourceNodes) return failMusic('budget');
      // Iterators and forEach can read holes through Array.prototype. Validate
      // every index as owned data before reading any element or iterating.
      for (let index = 0; index < size; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !('value' in descriptor))
          return failMusic('source');
      }
    }
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length)
      return failMusic('source');
    const keys = Object.getOwnPropertyNames(value),
      count = keys.length - (Array.isArray(value) ? 1 : 0);
    if (count > MUSIC_LIMITS.sourceNodes - visits - pending)
      return failMusic('budget');
    pending += count;
    ancestors.add(value);
    stack.push({ value, depth: entry.depth, exit: true });
    for (const key of keys) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor))
        return failMusic('source');
      stack.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }
  if (field(root, 'error') !== undefined) return failMusic('source');
}
function plain(value: unknown, bytes: number, chars?: number): string {
  if (typeof value !== 'string') return failMusic('source');
  if (value.length > bytes) return failMusic('budget');
  if (
    Array.from(value).some(
      (c) =>
        c.length === 1 &&
        c.charCodeAt(0) >= 0xd800 &&
        c.charCodeAt(0) <= 0xdfff,
    )
  )
    return failMusic('source');
  if (
    utf8Bytes(value) > bytes ||
    (chars !== undefined && Array.from(value).length > chars)
  )
    return failMusic('budget');
  return value;
}
/** Bound aggregate text before joining fragments, including timed-line separators. */
function joinText(rows: unknown[], key: string, bytes: number, separator = '') {
  let size = 0;
  const parts: string[] = [];
  for (const row of rows) {
    const value = plain(field(row, key), bytes);
    size += utf8Bytes(value) + (parts.length ? utf8Bytes(separator) : 0);
    if (size > bytes) return failMusic('budget');
    parts.push(value);
  }
  return parts.join(separator);
}
function text(value: unknown, bytes: number, chars?: number) {
  const v = object(value),
    forms = ['runs', 'simpleText', 'content'].filter(
      (k) => field(v, k) !== undefined,
    );
  if (forms.length !== 1) return failMusic('source');
  const result =
    forms[0] === 'runs'
      ? joinText(array(field(v, 'runs')), 'text', bytes)
      : field(v, forms[0]);
  return plain(result, bytes, chars);
}
const recipe = (value: unknown, prefix: string) => {
  const v = plain(value, MUSIC_LIMITS.recipeBytes);
  if (
    !v.startsWith(prefix) ||
    v.length <= prefix.length ||
    Array.from(v).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    return failMusic('source');
  return v;
};
/** #4744 @SurajBhari native next → semantic browse recipe, with pinned MPLY/MPTR fallback. */
export function parseWatchNextTabs(
  raw: unknown,
  expectedVideoId: string,
): { lyrics: string | null; related: string | null } {
  assertMetadataWorkBudget(raw);
  if (!isVideoId(expectedVideoId)) return failMusic('source');
  const actual = path(raw, 'currentVideoEndpoint', 'watchEndpoint', 'videoId');
  if (actual !== undefined && actual !== expectedVideoId)
    return failMusic('source');
  const tabs = array(
    path(
      raw,
      'contents',
      'singleColumnMusicWatchNextResultsRenderer',
      'tabbedRenderer',
      'watchNextTabbedResultsRenderer',
      'tabs',
    ),
  );
  if (tabs.length > 32) return failMusic('budget');
  const found: Partial<{ lyrics: string | null; related: string | null }> = {};
  tabs.forEach((row, index) => {
    const tab = field(row, 'tabRenderer'),
      endpoint = path(tab, 'endpoint', 'browseEndpoint');
    if (endpoint === undefined) {
      if (
        index === 0 &&
        path(tab, 'content', 'musicQueueRenderer') !== undefined
      )
        return;
      return failMusic('unsupported');
    }
    const id = field(endpoint, 'browseId'),
      type = path(
        endpoint,
        'browseEndpointContextSupportedConfigs',
        'browseEndpointContextMusicConfig',
        'pageType',
      );
    let key: 'lyrics' | 'related';
    if (type === 'MUSIC_PAGE_TYPE_TRACK_LYRICS') key = 'lyrics';
    else if (type === 'MUSIC_PAGE_TYPE_TRACK_RELATED') key = 'related';
    else if (
      type === undefined &&
      index === 1 &&
      typeof id === 'string' &&
      id.startsWith('MPLY')
    )
      key = 'lyrics';
    else if (
      type === undefined &&
      index === 2 &&
      typeof id === 'string' &&
      id.startsWith('MPTR')
    )
      key = 'related';
    else return failMusic('unsupported');
    if (Object.hasOwn(found, key)) return failMusic('unsupported');
    if (
      field(tab, 'disabled') === true &&
      type !== undefined &&
      id === undefined
    ) {
      found[key] = null;
      return;
    }
    found[key] = recipe(id, key === 'lyrics' ? 'MPLY' : 'MPTR');
    if (field(tab, 'disabled') === true) found[key] = null;
  });
  if (!Object.hasOwn(found, 'lyrics') || !Object.hasOwn(found, 'related'))
    return failMusic('unsupported');
  return found as { lyrics: string | null; related: string | null };
}
const absent = () => ({
  available: false as const,
  lyrics: null,
  source: null,
});
function message(raw: unknown) {
  const contents = field(raw, 'contents'),
    value =
      contents === undefined ? undefined : field(contents, 'messageRenderer');
  if (value === undefined) return false;
  if (
    Object.keys(object(contents)).length !== 1 ||
    field(raw, 'continuationContents') !== undefined
  )
    return failMusic('unsupported');
  text(field(value, 'text'), 65536);
  return true;
}
export function parseLyrics(raw: unknown): {
  available: boolean;
  lyrics: string | null;
  source: string | null;
} {
  assertMetadataWorkBudget(raw);
  if (message(raw)) return absent();
  const contents = field(raw, 'contents'),
    section = path(contents, 'sectionListRenderer'),
    timed =
      path(
        contents,
        'elementRenderer',
        'newElement',
        'type',
        'componentType',
        'model',
        'timedLyricsModel',
      ) ?? path(contents, 'timedLyricsModel');
  if (
    (section !== undefined ? 1 : 0) + (timed !== undefined ? 1 : 0) !== 1 ||
    Object.keys(object(contents)).length !== 1 ||
    field(raw, 'continuationContents') !== undefined
  )
    return failMusic('unsupported');
  if (timed !== undefined) {
    const rows = array(path(timed, 'lyricsData', 'timedLyricsData'));
    const lyrics = plain(joinText(rows, 'lyricLine', 65536, '\n'), 65536);
    return lyrics.length ? { available: true, lyrics, source: null } : absent();
  }
  const rows = array(field(section, 'contents'));
  if (rows.length !== 1 || Object.keys(object(rows[0])).length !== 1)
    return failMusic('unsupported');
  const shelf = field(rows[0], 'musicDescriptionShelfRenderer');
  if (shelf === undefined) return failMusic('unsupported');
  const lyrics = text(field(shelf, 'description'), 65536),
    footer = field(shelf, 'footer');
  const source = footer === undefined ? null : text(footer, 2048, 512);
  return lyrics.length ? { available: true, lyrics, source } : absent();
}
/** Adapt only known metadata section envelopes; catalog row parser and budgets remain authoritative. */
export function parseRelated(raw: unknown) {
  assertMetadataWorkBudget(raw);
  if (message(raw))
    return {
      version: 1 as const,
      items: [],
      shelves: [],
      continuation: null,
      targetRecipes: [],
    };
  return normalizeRelatedMusicSource(raw);
}
