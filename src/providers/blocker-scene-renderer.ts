import type {
  BlockerPlaybackScene,
  BlockerQueueScene,
  BlockerSceneCapture,
  BlockerSceneOutcome,
} from '@/types/blocker-scene';
import type { QueueItem } from '@/types/datahost-get-state';
import type { MusicPlayer } from '@/types/music-player';
import type { QueueElement } from '@/types/queue';

/** Self-contained so the main process can serialize this into its owned frame. */
export async function blockerSceneRenderer(
  action: 'capture' | 'verify' | 'restore',
  scene?: BlockerPlaybackScene,
): Promise<BlockerSceneCapture | BlockerSceneOutcome | boolean> {
  const key = Symbol.for('pear.blocker.playback-scene');
  type State = { documentId: string; version: number };
  const host = window as unknown as Record<symbol, State | undefined> & {
    blockerSceneGuard?: {
      cancelled: () => boolean;
      userRevision?: () => number;
    };
  };
  let state = host[key];
  if (!state) {
    state = {
      documentId: `${performance.timeOrigin}:${Math.random()}`,
      version: 0,
    };
    host[key] = state;
    const current = state;
    const input = (event: Event) => {
      if (event.isTrusted) current.version++;
    };
    document.addEventListener('pointerdown', input, true);
    document.addEventListener('keydown', input, true);
  }
  const player = () =>
    document.querySelector<Element & MusicPlayer>('#movie_player');
  const version = () =>
    state.version + (host.blockerSceneGuard?.userRevision?.() ?? 0);
  const media = () =>
    player()?.querySelector<HTMLVideoElement>('video') ??
    document.querySelector<HTMLVideoElement>('video');
  const queue = () => document.querySelector<QueueElement>('#queue');
  const rows = (items: unknown[]) =>
    items.map((item) => {
      const value = item as QueueItem;
      return (
        value?.playlistPanelVideoRenderer ??
        value?.playlistPanelVideoWrapperRenderer?.primaryRenderer
          ?.playlistPanelVideoRenderer
      );
    });
  const identity = () => {
    try {
      return player()?.getVideoData?.().video_id ?? media()?.currentSrc ?? '';
    } catch {
      return '';
    }
  };
  const playlist = () => {
    try {
      return player()?.getVideoData?.().list ?? null;
    } catch {
      return null;
    }
  };
  const advertising = () =>
    !!(
      player()?.classList?.contains('ad-showing') ||
      player()?.classList?.contains('ad-interrupting')
    );
  const queueScene = (): BlockerQueueScene | null => {
    const element = queue();
    if (!element) return null;
    const items = element.queue.getItems();
    const text = JSON.stringify(items);
    if (
      items.length > 200 ||
      new TextEncoder().encode(text).byteLength > 2_000_000
    )
      throw new Error('The queue is too large to preserve safely');
    const normalized = rows(items);
    if (normalized.some((row) => !row?.videoId))
      throw new Error('Queue item format is unavailable');
    const selected = normalized.findIndex((row) => row?.selected);
    if (items.length && selected < 0)
      throw new Error('Queue selection is not ready');
    const value = element.queue.store.store.getState().queue;
    return {
      items: JSON.parse(text) as unknown[],
      ids: normalized.map((row) => row!.videoId),
      index: selected,
      isInfinite: !!value.isInfinite,
      continuation: element.queue.continuation ?? null,
      context: value.queueContextParams ?? null,
      autoPlaying: element.queue.autoPlaying ?? null,
      shuffle: value.shuffleEnabled ?? null,
      repeat: value.repeatMode ?? null,
      autoplay: value.autoplay ?? null,
    };
  };
  if (action === 'capture') {
    const video = media();
    const config = (
      window as unknown as { mainConfig?: { get: (key: string) => unknown } }
    ).mainConfig;
    if (config?.get('plugins.music-together.enabled') === true)
      return {
        kind: 'unavailable',
        reason:
          'Shared playback is enabled; document changes are pending until it is disconnected',
      };
    if (
      (
        queue()?.queue?.store?.store?.getState?.() as unknown as {
          castStatus?: { remoteWatchEndpoint?: unknown };
        }
      )?.castStatus?.remoteWatchEndpoint != null
    )
      return {
        kind: 'unavailable',
        reason: 'Remote casting owns playback; document changes are pending',
      };
    const idle = (): BlockerSceneCapture =>
      new URL(location.href).pathname === '/watch'
        ? {
            kind: 'unavailable',
            reason:
              'The playback document is still loading; document changes are pending',
          }
        : {
            kind: 'idle',
            documentId: state.documentId,
            version: version(),
            url: location.href,
          };
    if (!video && !queue()) return idle();
    if (
      !identity() &&
      (!video || (video.readyState === 0 && !video.currentSrc)) &&
      queue()?.queue?.getItems?.().length === 0
    )
      return idle();
    if (
      !video ||
      !identity() ||
      !Number.isFinite(video.currentTime) ||
      !Number.isFinite(video.duration) ||
      video.readyState < 2 ||
      video.seekable.length === 0
    )
      return {
        kind: 'unavailable',
        reason: 'Playback is not ready; document changes are pending',
      };
    if (
      player()?.classList.contains('ad-showing') ||
      player()?.classList.contains('ad-interrupting')
    )
      return {
        kind: 'unavailable',
        reason: 'An advertisement is active; document changes are pending',
      };
    try {
      const capturedQueue = queueScene();
      if (
        capturedQueue?.items.length &&
        capturedQueue.ids[capturedQueue.index] !== identity()
      )
        return {
          kind: 'unavailable',
          reason: 'The current track and queue selection are not synchronized',
        };
      return {
        kind: 'active',
        scene: {
          documentId: state.documentId,
          version: version(),
          url: location.href,
          videoId: identity(),
          playlistId: playlist(),
          seconds: video.currentTime,
          paused: video.paused,
          muted: video.muted,
          queue: capturedQueue,
        },
      };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: error instanceof Error ? error.message : 'Queue capture failed',
      };
    }
  }
  if (!scene) return false;
  if (action === 'verify') {
    try {
      const currentQueue = queueScene();
      const video = media();
      return (
        state.documentId === scene.documentId &&
        version() === scene.version &&
        location.href === scene.url &&
        identity() === scene.videoId &&
        playlist() === (scene.playlistId ?? null) &&
        !!video &&
        video.paused === scene.paused &&
        video.muted === scene.muted &&
        Math.abs(video.currentTime - scene.seconds) <
          (scene.paused ? 0.5 : 3) &&
        JSON.stringify(currentQueue?.ids ?? null) ===
          JSON.stringify(scene.queue?.ids ?? null) &&
        (currentQueue?.index ?? null) === (scene.queue?.index ?? null) &&
        ['isInfinite', 'autoPlaying', 'shuffle', 'repeat', 'autoplay'].every(
          (key) =>
            currentQueue?.[key as keyof BlockerQueueScene] ===
            scene.queue?.[key as keyof BlockerQueueScene],
        )
      );
    } catch {
      return false;
    }
  }
  const restoreVersion = state.version;
  const cancelled = () =>
    host.blockerSceneGuard?.cancelled() === true ||
    state.version !== restoreVersion ||
    location.href !== scene.url;
  const wait = async (predicate: () => boolean) => {
    for (let count = 0; count < 100; count++) {
      if (cancelled())
        throw new Error('The user changed the document during restoration');
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
    }
    throw new Error('Playback readiness timed out');
  };
  try {
    await wait(
      () =>
        !!media() &&
        (!!player() || !scene.queue) &&
        (!scene.queue || !!queue()?.queue?.store?.store),
    );
    if (scene.queue?.items.length) {
      const element = queue()!;
      const store = element.queue.store.store;
      element.dispatch({
        type: 'UPDATE_ITEMS',
        payload: {
          items: scene.queue.items,
          nextQueueItemId: store.getState().queue.nextQueueItemId,
          shouldAssignIds: true,
          currentIndex: -1,
        },
      });
      element.dispatch({ type: 'SET_INDEX', payload: scene.queue.index });
    }
    const video = media()!;
    video.muted = true;
    // UPDATE_ITEMS/SET_INDEX can leave the real player unstarted (state -1).
    // Warm the source while muted; playVideo is never used after seeking.
    if (video.readyState < 2) {
      if (player()?.playVideo) player()!.playVideo();
      else await video.play();
    }
    await wait(
      () =>
        identity() === scene.videoId &&
        !advertising() &&
        !!media() &&
        media()!.readyState >= 2 &&
        Number.isFinite(media()!.duration) &&
        media()!.seekable.length > 0,
    );
    if (cancelled()) throw new Error('Scene restore cancelled');
    await wait(() => !advertising());
    if (scene.queue) {
      // Music can briefly reset radio flags while raw items load. Read only
      // lightweight settings here; clone the final queue once after settling.
      const semanticsMatch = () => {
        const element = queue();
        const value = element?.queue.store.store.getState().queue;
        return (
          !!value &&
          (scene.playlistId ?? null) === playlist() &&
          scene.queue!.isInfinite === !!value.isInfinite &&
          scene.queue!.autoPlaying === (element?.queue.autoPlaying ?? null) &&
          scene.queue!.shuffle === (value.shuffleEnabled ?? null) &&
          scene.queue!.repeat === (value.repeatMode ?? null) &&
          scene.queue!.autoplay === (value.autoplay ?? null)
        );
      };
      for (let attempt = 0; attempt < 20; attempt++) {
        if (cancelled()) throw new Error('Scene restore cancelled');
        if (semanticsMatch()) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
      }
      if (cancelled()) throw new Error('Scene restore cancelled');
    }
    const target = Math.min(
      scene.seconds,
      Math.max(0, media()!.duration - 0.05),
    );
    // Stop autoplay's clock before the seek-settlement wait can advance it.
    media()!.pause();
    if (player()?.seekTo) player()!.seekTo(target);
    else media()!.currentTime = target;
    await wait(
      () => !media()!.seeking && Math.abs(media()!.currentTime - target) < 0.5,
    );
    media()!.pause();
    if (!scene.paused) await media()!.play();
    if (cancelled()) throw new Error('Scene restore cancelled');
    const restoredQueue = queueScene();
    if (!cancelled()) media()!.muted = scene.muted;
    if (
      advertising() ||
      identity() !== scene.videoId ||
      media()!.paused !== scene.paused ||
      Math.abs(media()!.currentTime - target) > 0.75
    )
      throw new Error('The restored playback state did not match');
    if (
      scene.queue &&
      (JSON.stringify(scene.queue.ids) !==
        JSON.stringify(restoredQueue?.ids.slice(0, scene.queue.ids.length)) ||
        scene.queue.index !== restoredQueue?.index)
    ) {
      media()!.pause();
      return {
        kind: 'partial',
        reason:
          'Pause/position restored, but the loaded queue could not be verified; playback is paused',
      };
    }
    if (
      scene.queue &&
      ((scene.playlistId ?? null) !== playlist() ||
        scene.queue.isInfinite !== restoredQueue?.isInfinite ||
        scene.queue.autoPlaying !== restoredQueue?.autoPlaying ||
        scene.queue.shuffle !== restoredQueue?.shuffle ||
        scene.queue.repeat !== restoredQueue?.repeat ||
        scene.queue.autoplay !== restoredQueue?.autoplay)
    )
      return {
        kind: 'partial',
        reason:
          'Pause/position and loaded queue restored; radio or playback settings could not be verified',
      };
    return { kind: 'verified' };
  } catch (error) {
    if (!cancelled()) media()?.pause();
    return {
      kind: cancelled() ? 'cancelled' : 'failed',
      reason:
        error instanceof Error ? error.message : 'Playback restoration failed',
    };
  }
}
