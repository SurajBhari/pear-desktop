/** Upstream #4715 (@aashish254): ordered playlist slice; bounded validation added by the fork. */
export const MAX_PLAYLIST_ITEMS = 1000;
export const MAX_QUEUE_REQUESTS = 32;
export const PLAYLIST_REQUEST_TIMEOUT_MS = 10000;
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const PLAYLIST_ID_PATTERN =
  /^(?:(?:PL|UU|FL|RD|OLAK5uy_)[A-Za-z0-9_-]+|WL|LL|LM)$/;
export type QueueInsertPosition =
  | 'INSERT_AT_END'
  | 'INSERT_AFTER_CURRENT_VIDEO';
export type PlaylistInput = {
  playlistId: string;
  videoId?: string;
  insertPosition: QueueInsertPosition;
};
export type PlaylistResult =
  | { ok: true; count: number }
  | {
      ok: false;
      reason: 'invalid' | 'retired' | 'busy' | 'service' | 'timeout';
    };
export interface QueueDataLike {
  content?: Record<string, unknown>;
}

export const isVideoId = (value: unknown): value is string =>
  typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
export const isPlaylistId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 128 &&
  PLAYLIST_ID_PATTERN.test(value);
export const isInsertPosition = (
  value: unknown,
): value is QueueInsertPosition =>
  value === 'INSERT_AT_END' || value === 'INSERT_AFTER_CURRENT_VIDEO';
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const isRequestId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export const isOwnerId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
export function parsePlaylistInput(
  playlistId: unknown,
  videoId: unknown,
  position: unknown,
): PlaylistInput | null {
  const insertPosition = position === undefined ? 'INSERT_AT_END' : position;
  if (
    !isPlaylistId(playlistId) ||
    (videoId !== undefined && !isVideoId(videoId)) ||
    !isInsertPosition(insertPosition)
  )
    return null;
  return { playlistId, videoId, insertPosition };
}

export function queueVideoRenderer(
  content: unknown,
): Record<string, unknown> | null {
  if (!isRecord(content)) return null;
  const direct = content.playlistPanelVideoRenderer;
  const wrapper = content.playlistPanelVideoWrapperRenderer;
  if (direct !== undefined && wrapper !== undefined) return null;
  const primary = isRecord(wrapper) ? wrapper.primaryRenderer : undefined;
  const video =
    direct ??
    (isRecord(primary) ? primary.playlistPanelVideoRenderer : undefined);
  return isRecord(video) && isVideoId(video.videoId) ? video : null;
}

export function sliceQueueDatasFromVideo<T extends QueueDataLike>(
  queueDatas: T[],
  videoId: string,
): T[] {
  const index = queueDatas.findIndex(
    (item) => queueVideoRenderer(item.content)?.videoId === videoId,
  );
  return index > 0 ? queueDatas.slice(index) : queueDatas;
}

export function validatedPlaylistQueueDatas(
  response: unknown,
): QueueDataLike[] {
  if (
    !isRecord(response) ||
    !Array.isArray(response.queueDatas) ||
    response.queueDatas.length > MAX_PLAYLIST_ITEMS
  )
    throw new Error('Unsupported playlist queue response');
  // No guessed paging protocol: a declared continuation cannot be silently treated as the full playlist.
  if (
    Object.entries(response).some(
      ([key, value]) =>
        /continuation/i.test(key) &&
        value !== undefined &&
        value !== null &&
        value !== '' &&
        value !== false &&
        (!Array.isArray(value) || value.length > 0),
    )
  )
    throw new Error('Playlist continuation is unsupported');
  if (
    !response.queueDatas.every(
      (item) => isRecord(item) && queueVideoRenderer(item.content),
    )
  )
    throw new Error('Playlist contains unsupported queue rows');
  return response.queueDatas as QueueDataLike[];
}

export function queueItemsFromDatas(
  queueDatas: QueueDataLike[],
): Record<string, unknown>[] {
  return queueDatas.map((item) => {
    const content = item.content;
    const video = queueVideoRenderer(content);
    if (!content || !video) throw new Error('Unsupported queue content');
    if (content.playlistPanelVideoRenderer)
      return {
        ...content,
        playlistPanelVideoRenderer: { ...video, selected: false },
      };
    const wrapper = content.playlistPanelVideoWrapperRenderer as Record<
      string,
      unknown
    >;
    const primary = wrapper.primaryRenderer as Record<string, unknown>;
    return {
      ...content,
      playlistPanelVideoWrapperRenderer: {
        ...wrapper,
        primaryRenderer: {
          ...primary,
          playlistPanelVideoRenderer: { ...video, selected: false },
        },
      },
    };
  });
}
