import {
  MUSIC_LIMITS,
  failMusic,
  utf8Bytes,
  type MusicComment,
  type CommentsSource,
  type CommentsSort,
} from '@/plugins/api-server/music-types';

import { assertMetadataWorkBudget, parseWatchNextTabs } from './music-metadata';
import { isVideoId } from './queue-playlist';

/** Public #4744 @SurajBhari comment/WEB shapes; strict bounded adapters, no error fallback. */
export const COMMENTS_LIMITS = Object.freeze({
  commentBytes: 4096,
  metadataBytes: 512,
  maxRequests: 5,
});
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Obj)
    : failMusic('source');
const at = (v: unknown, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (v === undefined) return undefined;
    v = obj(v)[key];
  }
  return v;
};
const arr = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : failMusic('source');
function plain(v: unknown, budget: number): string {
  if (typeof v !== 'string') return failMusic('source');
  if (v.length > budget || utf8Bytes(v) > budget) return failMusic('budget');
  if (
    Array.from(v).some(
      (c) =>
        (c.length === 1 &&
          c.charCodeAt(0) >= 0xd800 &&
          c.charCodeAt(0) <= 0xdfff) ||
        (c.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(c)),
    )
  )
    return failMusic('source');
  return v;
}
function text(
  v: unknown,
  budget: number = COMMENTS_LIMITS.metadataBytes,
): string {
  if (typeof v === 'string') return plain(v, budget);
  const value = obj(v),
    keys = ['simpleText', 'runs', 'content'].filter(
      (key) => value[key] !== undefined,
    );
  if (keys.length !== 1) return failMusic('source');
  if (keys[0] !== 'runs') return plain(value[keys[0]], budget);
  let bytes = 0;
  const parts = arr(value.runs).map((run) => {
    const part = plain(obj(run).text, budget);
    bytes += utf8Bytes(part);
    if (bytes > budget) return failMusic('budget');
    return part;
  });
  return parts.join('');
}
const optionalText = (v: unknown) =>
  v === undefined || v === null ? null : text(v);
const flag = (v: unknown) =>
  v === undefined ? false : typeof v === 'boolean' ? v : failMusic('source');
const id = (v: unknown) => {
  const value = plain(v, 256);
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : failMusic('source');
};
export function commentsToken(v: unknown) {
  const value = plain(v, MUSIC_LIMITS.recipeBytes);
  if (
    !value ||
    /\s/.test(value) ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    return failMusic('source');
  return value;
}
function bounded(raw: unknown) {
  assertMetadataWorkBudget(raw);
  if (utf8Bytes(JSON.stringify(raw)) > MUSIC_LIMITS.nativeBytes)
    return failMusic('budget');
}
function nodes(raw: unknown, key: string): unknown[] {
  const found: unknown[] = [],
    pending = [raw];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [name, child] of Object.entries(value)) {
      if (name === key) found.push(child);
      else pending.push(child);
    }
  }
  return found.reverse();
}
function tokens(raw: unknown) {
  const values = [
    ...nodes(raw, 'continuationCommand').map((v) => obj(v).token),
    ...nodes(raw, 'nextContinuationData').map((v) => obj(v).continuation),
    ...nodes(raw, 'reloadContinuationData').map((v) => obj(v).continuation),
  ];
  return [...new Set(values.map(commentsToken))];
}
export function parseCommentsStart(
  raw: unknown,
  videoId: string,
  source: 'music' | 'public-web',
): string | null {
  bounded(raw);
  // A generic/localized message is not a comments absence discriminator.
  if (obj(raw).error !== undefined || nodes(raw, 'messageRenderer').length)
    return failMusic('source');
  if (!isVideoId(videoId)) return failMusic('invalid');
  const actual = at(raw, 'currentVideoEndpoint', 'watchEndpoint', 'videoId');
  if (actual !== undefined && actual !== videoId) return failMusic('source');
  const pending = [raw],
    sections: unknown[] = [];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const row = obj(value);
    if (
      ['sectionIdentifier', 'panelIdentifier'].some(
        (key) => typeof row[key] === 'string' && /comment/i.test(row[key]),
      )
    )
      sections.push(row);
    else pending.push(...Object.values(row));
  }
  if (sections.length) {
    const issued = [...new Set(sections.flatMap(tokens))];
    if (issued.length === 1) return issued[0];
    if (issued.length) return failMusic('unsupported');
    return failMusic('unsupported');
  }
  if (source === 'music') {
    parseWatchNextTabs(raw, videoId);
    return null;
  }
  const contents = arr(
    at(
      raw,
      'contents',
      'twoColumnWatchNextResults',
      'results',
      'results',
      'contents',
    ),
  );
  if (
    !contents.length ||
    !contents.every((row) => {
      const value = obj(row);
      return ['videoPrimaryInfoRenderer', 'videoSecondaryInfoRenderer'].some(
        (key) => value[key] !== undefined && !!obj(value[key]),
      );
    })
  )
    return failMusic('unsupported');
  return null;
}
function legacyComment(raw: unknown): MusicComment {
  const row = obj(raw),
    reply = row.replyCount;
  if (
    reply !== undefined &&
    (typeof reply !== 'number' || !Number.isSafeInteger(reply) || reply < 0)
  )
    return failMusic('source');
  return {
    id: id(row.commentId),
    author: optionalText(row.authorText),
    text: text(row.contentText, COMMENTS_LIMITS.commentBytes),
    publishedTime: optionalText(row.publishedTimeText),
    likeCount: optionalText(row.voteCount),
    replyCount: reply === undefined ? null : String(reply),
    pinned:
      row.pinnedCommentBadge !== undefined && !!obj(row.pinnedCommentBadge),
    verified:
      row.authorCommentBadge !== undefined && !!obj(row.authorCommentBadge),
    creator: flag(row.authorIsChannelOwner),
  };
}
function entityComment(raw: unknown, view: Obj): MusicComment {
  const row = obj(raw),
    properties = obj(row.properties),
    author = row.author === undefined ? {} : obj(row.author),
    toolbar = row.toolbar === undefined ? {} : obj(row.toolbar),
    commentId = id(properties.commentId);
  if (view.commentId !== undefined && view.commentId !== commentId)
    return failMusic('source');
  return {
    id: commentId,
    author: optionalText(author.displayName),
    text: text(properties.content, COMMENTS_LIMITS.commentBytes),
    publishedTime: optionalText(properties.publishedTime),
    likeCount:
      toolbar.likeCountNotliked === undefined
        ? null
        : plain(toolbar.likeCountNotliked, 512).trim(),
    replyCount:
      toolbar.replyCount === undefined
        ? null
        : plain(toolbar.replyCount, 512).trim(),
    pinned: view.pinnedText !== undefined && !!text(view.pinnedText),
    verified: flag(author.isVerified),
    creator: flag(author.isCreator),
  };
}
export function parseCommentsPage(raw: unknown, expectedVideoId?: string) {
  bounded(raw);
  // Messages may report provider errors, including beside otherwise useful rows.
  if (obj(raw).error !== undefined || nodes(raw, 'messageRenderer').length)
    return failMusic('source');
  const actualVideo = at(
    raw,
    'currentVideoEndpoint',
    'watchEndpoint',
    'videoId',
  );
  if (
    expectedVideoId !== undefined &&
    actualVideo !== undefined &&
    actualVideo !== expectedVideoId
  )
    return failMusic('source');
  const endpoints = arr(obj(raw).onResponseReceivedEndpoints);
  if (!endpoints.length) return failMusic('unsupported');
  const items: unknown[] = [];
  let recognized = false;
  for (const endpoint of endpoints) {
    const row = obj(endpoint),
      choices = [
        'reloadContinuationItemsCommand',
        'appendContinuationItemsAction',
      ].filter((key) => row[key] !== undefined);
    if (choices.length !== 1) return failMusic('unsupported');
    const command = obj(row[choices[0]]);
    if (
      command.targetId !== undefined &&
      (typeof command.targetId !== 'string' ||
        !/comment/i.test(command.targetId))
    )
      return failMusic('unsupported');
    if (
      typeof command.targetId === 'string' &&
      /comment/i.test(command.targetId)
    )
      recognized = true;
    items.push(...arr(command.continuationItems));
  }
  if (items.length > MUSIC_LIMITS.sourceItems + 32) return failMusic('budget');
  const entities = new Map<string, unknown>();
  for (const value of nodes(
    obj(raw).frameworkUpdates,
    'commentEntityPayload',
  )) {
    const key = commentsToken(obj(value).key);
    if (entities.has(key)) return failMusic('source');
    entities.set(key, value);
  }
  const usedEntities = new Set<string>();
  const comments: MusicComment[] = [];
  let continuation: string | null = null,
    commentCount: string | null = null;
  let sortTokens: string[] = [],
    selectedSort: CommentsSort | null = null;
  for (const [index, rawItem] of items.entries()) {
    const item = obj(rawItem);
    if (
      [
        'commentThreadRenderer',
        'commentsHeaderRenderer',
        'continuationItemRenderer',
        'commentSimpleboxRenderer',
      ].some((key) => item[key] !== undefined)
    )
      recognized = true;
    if (item.commentThreadRenderer !== undefined) {
      const thread = obj(item.commentThreadRenderer),
        view = at(thread, 'commentViewModel', 'commentViewModel'),
        legacy = at(thread, 'comment', 'commentRenderer');
      if (view !== undefined && legacy !== undefined)
        return failMusic('source');
      if (view !== undefined) {
        const model = obj(view),
          key = commentsToken(model.commentKey),
          entity = entities.get(key);
        usedEntities.add(key);
        if (!entity) return failMusic('source');
        comments.push(entityComment(entity, model));
      } else if (legacy !== undefined) comments.push(legacyComment(legacy));
      else return failMusic('unsupported');
    } else if (item.commentsHeaderRenderer !== undefined) {
      const head = obj(item.commentsHeaderRenderer);
      if (head.countText !== undefined || head.commentsCount !== undefined)
        commentCount = text(head.countText ?? head.commentsCount);
      const menus = nodes(head, 'sortFilterSubMenuRenderer');
      if (
        !menus.length &&
        head.countText === undefined &&
        head.commentsCount === undefined
      )
        return failMusic('unsupported');
      if (menus.length > 1) return failMusic('unsupported');
      if (menus.length) {
        const choices = arr(obj(menus[0]).subMenuItems);
        if (choices.length < 2 || choices.length > 8)
          return failMusic('unsupported');
        sortTokens = choices.slice(0, 2).map((choice) => {
          const issued = tokens(choice);
          return issued.length === 1 ? issued[0] : failMusic('source');
        });
        if (sortTokens[0] === sortTokens[1]) return failMusic('source');
        if (
          choices.some(
            (choice) =>
              obj(choice).selected !== undefined &&
              typeof obj(choice).selected !== 'boolean',
          )
        )
          return failMusic('source');
        const selected = choices.flatMap((choice, slot) =>
          obj(choice).selected === true ? [slot] : [],
        );
        if (selected.length > 1 || (selected.length && selected[0] > 1))
          return failMusic('unsupported');
        selectedSort = selected.length
          ? selected[0] === 0
            ? 'top'
            : 'newest'
          : null;
      }
    } else if (item.continuationItemRenderer !== undefined) {
      if (index !== items.length - 1 || continuation !== null)
        return failMusic('source');
      const issued = tokens(item.continuationItemRenderer);
      if (issued.length !== 1) return failMusic('source');
      continuation = issued[0];
    } else if (item.commentSimpleboxRenderer === undefined)
      return failMusic('unsupported');
  }
  if (!recognized || usedEntities.size !== entities.size)
    return failMusic('unsupported');
  if (comments.length > MUSIC_LIMITS.sourceItems) return failMusic('budget');
  return { comments, commentCount, continuation, sortTokens, selectedSort };
}
export async function loadComments(
  request: (
    body: { videoId: string } | { continuation: string },
  ) => Promise<unknown>,
  input: {
    videoId: string;
    sort: CommentsSort;
    source: 'music' | 'public-web';
    continuation?: string;
    maxRequests?: number;
    check?: () => void;
  },
): Promise<CommentsSource & { requests: number }> {
  let requests = 0;
  const fetch = async (
    body: { videoId: string } | { continuation: string },
  ) => {
    input.check?.();
    if (
      ++requests >
      Math.min(
        COMMENTS_LIMITS.maxRequests,
        input.maxRequests ?? COMMENTS_LIMITS.maxRequests,
      )
    )
      return failMusic('budget');
    const raw = await request(body);
    input.check?.();
    return raw;
  };
  let token = input.continuation;
  if (!token)
    token =
      parseCommentsStart(
        await fetch({ videoId: input.videoId }),
        input.videoId,
        input.source,
      ) ?? undefined;
  if (!token)
    return {
      available: false,
      comments: [],
      commentCount: null,
      continuation: null,
      requests,
    };
  let page = parseCommentsPage(
    await fetch({ continuation: commentsToken(token) }),
    input.videoId,
  );
  if (
    !input.continuation &&
    ((input.sort === 'newest' && page.selectedSort !== 'newest') ||
      (input.sort === 'top' && page.selectedSort === 'newest'))
  ) {
    const sort = page.sortTokens[input.sort === 'newest' ? 1 : 0];
    if (!sort) return failMusic('unsupported');
    page = parseCommentsPage(
      await fetch({ continuation: sort }),
      input.videoId,
    );
  }
  if (page.selectedSort !== null && page.selectedSort !== input.sort)
    return failMusic('source');
  return {
    available: true,
    comments: page.comments,
    commentCount: page.commentCount,
    continuation: page.continuation,
    requests,
  };
}
