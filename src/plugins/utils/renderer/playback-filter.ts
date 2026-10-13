import { getSongInfo } from '@/providers/song-info-front';

import type { SongInfo } from '@/providers/song-info';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';
import type { VideoDataChangeValue } from '@/types/player-api-events';

export type FilterTrack = {
  videoId: string;
  title: string;
  artist: string;
  alternativeTitle?: string;
  artistUrl?: string;
  channelId?: string;
  artists: { name: string; channelId: string }[];
};

type ArtistQueueItem = {
  videoId?: string;
  longBylineText?: {
    runs?: {
      text?: string;
      navigationEndpoint?: { browseEndpoint?: { browseId?: string } };
    }[];
  };
};
function currentQueueItem(videoId: string) {
  const bar = document.querySelector<
    HTMLElement & {
      getState?: () => {
        queue?: {
          selectedItemIndex?: number;
          items?: {
            playlistPanelVideoRenderer?: ArtistQueueItem;
            playlistPanelVideoWrapperRenderer?: {
              primaryRenderer?: {
                playlistPanelVideoRenderer?: ArtistQueueItem;
              };
            };
          }[];
        };
      };
    }
  >('ytmusic-player-bar');
  const queue = bar?.getState?.()?.queue;
  const index = queue?.selectedItemIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
    return;
  const item = queue?.items?.[index];
  const renderer =
    item?.playlistPanelVideoRenderer ??
    item?.playlistPanelVideoWrapperRenderer?.primaryRenderer
      ?.playlistPanelVideoRenderer;
  if (renderer?.videoId !== videoId) return;
  return { renderer, index };
}
function currentArtists(videoId: string) {
  const renderer = currentQueueItem(videoId)?.renderer;
  if (!renderer) return [];
  return (renderer.longBylineText?.runs ?? []).flatMap((run) => {
    const id = run.navigationEndpoint?.browseEndpoint?.browseId;
    return typeof run.text === 'string' &&
      run.text.trim() &&
      typeof id === 'string' &&
      /^UC[\w-]+$/.test(id)
      ? [{ name: run.text.trim(), channelId: id }]
      : [];
  });
}

// One claim shared by the opt-in filters, so overlapping rules cannot advance twice.
const claims = new WeakMap<
  MusicPlayer,
  {
    videoId: string;
    skipped: boolean;
    owners: Set<symbol>;
    itemIndex?: number;
    pendingPlayback?: boolean;
  }
>();

/** Owns only its subscriptions; event identity must agree with both native getters. */
export function createPlaybackFilter(
  context: Pick<RendererContext<{ enabled: boolean }>, 'ipc'>,
  matches: (track: FilterTrack) => boolean,
) {
  let disposed = false;
  const owner = Symbol('playback-filter');
  let api: MusicPlayer | undefined;
  let apiHandler:
    | ((name: 'dataloaded' | 'dataupdated', data: VideoDataChangeValue) => void)
    | undefined;
  let apiEpoch = 0;
  let videoId = '';
  let seenBegin = false;
  let beginVideoId = '';
  let eventData: Partial<VideoDataChangeValue> = {};
  let metadata: SongInfo | undefined;
  let mediaReady = true;
  let video: HTMLVideoElement | null = null;
  const releaseClaim = () => {
    if (!api) return;
    const claim = claims.get(api);
    claim?.owners.delete(owner);
    if (claim?.owners.size === 0) claims.delete(api);
  };

  const refresh = () => {
    const currentVideo = document.querySelector('video');
    if (video !== currentVideo) {
      video = currentVideo;
      mediaReady = false;
      const claim = api && claims.get(api);
      if (claim) claim.pendingPlayback = true;
    }
    if (disposed || !api || !mediaReady || !videoId) return;
    try {
      const native = api.getVideoData();
      const details = api.getPlayerResponse()?.videoDetails;
      if (native?.video_id !== videoId || details?.videoId !== videoId) return;
      // Only unresolved begins survive a ready hook; a settled owner can hand over.
      seenBegin = false;
      let claim = claims.get(api);
      if (!claim) {
        claim = { videoId, skipped: false, owners: new Set([owner]) };
        claims.set(api, claim);
      } else if (claim.videoId !== videoId) {
        claim.videoId = videoId;
        claim.skipped = false;
        claim.itemIndex = undefined;
        claim.pendingPlayback = false;
      }
      // A same-video replay needs a keyed begin and native/queue agreement.
      // Shared claim mutation makes duplicate hooks from both filters harmless.
      const item = currentQueueItem(videoId);
      const index =
        item && api.getPlaylistIndex() === item.index ? item.index : undefined;
      if (index !== undefined && beginVideoId === videoId) {
        if (
          claim.pendingPlayback ||
          (claim.itemIndex !== undefined && claim.itemIndex !== index)
        )
          claim.skipped = false;
        claim.itemIndex = index;
        claim.pendingPlayback = false;
        beginVideoId = '';
      } else if (!claim.skipped && index !== undefined) {
        claim.itemIndex = index;
      }
      if (claim.skipped) return;
      const cached = metadata?.videoId === videoId ? metadata : undefined;
      const text = (...values: unknown[]) =>
        values.find(
          (value): value is string =>
            typeof value === 'string' && !!value.trim(),
        ) ?? '';
      const track: FilterTrack = {
        videoId,
        title: text(eventData.title, native.title, details.title),
        artist: text(
          cached?.artist,
          eventData.author,
          native.author,
          details.author,
        ),
        alternativeTitle: text(cached?.alternativeTitle),
        artistUrl: text(cached?.artistUrl),
        channelId: text(details.channelId),
        artists: currentArtists(videoId),
      };
      if (!matches(track)) return;
      claim.skipped = true;
      api.nextVideo();
    } catch (error) {
      console.warn(
        '[playback-filter] Current playback could not be confirmed',
        error,
      );
    }
  };
  const onData = (
    name: 'dataloaded' | 'dataupdated',
    data: VideoDataChangeValue,
  ) => {
    if (disposed || (name !== 'dataloaded' && name !== 'dataupdated')) return;
    if (name === 'dataloaded') {
      seenBegin = true;
      beginVideoId = typeof data?.videoId === 'string' ? data.videoId : '';
    }
    if (!data?.videoId) {
      if (name === 'dataloaded') {
        videoId = '';
        eventData = {};
        metadata = undefined;
      }
      return;
    }
    if (videoId !== data.videoId) {
      videoId = data.videoId;
      eventData = {};
      metadata = undefined;
    }
    eventData = { ...eventData, ...data };
    refresh();
  };
  const onMetadata = (value: SongInfo) => {
    if (disposed || value?.videoId !== videoId) return;
    metadata = value;
    refresh();
  };
  const onDocumentData = (event: Event) => {
    if (
      !(event instanceof CustomEvent) ||
      !event.detail ||
      typeof event.detail !== 'object'
    )
      return;
    const detail = event.detail as {
      name: 'dataloaded' | 'dataupdated';
      videoData?: VideoDataChangeValue;
    };
    onData(detail.name, detail.videoData ?? ({} as VideoDataChangeValue));
  };
  const onMedia = (event: Event) => {
    if (disposed || event.target !== document.querySelector('video')) return;
    video = event.target as HTMLVideoElement;
    mediaReady = event.type !== 'emptied';
    if (!mediaReady) {
      beginVideoId = '';
      const claim = api && claims.get(api);
      if (claim) claim.pendingPlayback = true;
    }
    refresh();
  };
  const unsubscribe = context.ipc.subscribe?.(
    'peard:update-song-info',
    onMetadata,
  );
  document.addEventListener('loadedmetadata', onMedia, true);
  document.addEventListener('emptied', onMedia, true);
  document.addEventListener('videodatachange', onDocumentData);
  return {
    refresh,
    attach(player: MusicPlayer) {
      if (disposed) return;
      if (api === player) {
        refresh();
        return;
      }
      if (apiHandler) api?.removeEventListener('videodatachange', apiHandler);
      releaseClaim();
      api = player;
      const claim = claims.get(player);
      if (claim) claim.owners.add(owner);
      else
        claims.set(player, {
          videoId: '',
          skipped: false,
          owners: new Set([owner]),
        });
      const epoch = ++apiEpoch;
      apiHandler = (name, data) => {
        if (!disposed && api === player && apiEpoch === epoch)
          onData(name, data);
      };
      video = document.querySelector('video');
      mediaReady = true;
      if (!seenBegin) {
        eventData = {};
        try {
          videoId = player.getVideoData()?.video_id || '';
        } catch {
          videoId = '';
        }
      }
      const cached = getSongInfo();
      metadata = cached?.videoId === videoId ? cached : undefined;
      api.addEventListener('videodatachange', apiHandler);
      refresh();
    },
    stop() {
      if (disposed) return;
      disposed = true;
      apiEpoch++;
      if (apiHandler) api?.removeEventListener('videodatachange', apiHandler);
      apiHandler = undefined;
      releaseClaim();
      unsubscribe?.();
      document.removeEventListener('loadedmetadata', onMedia, true);
      document.removeEventListener('emptied', onMedia, true);
      document.removeEventListener('videodatachange', onDocumentData);
      api = undefined;
      metadata = undefined;
      video = null;
      videoId = '';
    },
  };
}
