import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';
import type { VideoDataChanged } from '@/types/video-data-changed';

const RESTORE_TIMEOUT_MS = 10_000;
export type ResumeShufflePluginConfig = { enabled: boolean; shuffled: boolean };
type ResumeRenderer = {
  generation: number;
  dispose: (() => void) | undefined;
  latestConfig: ResumeShufflePluginConfig | undefined;
  onPlayerApiReady(
    api: MusicPlayer,
    context: RendererContext<ResumeShufflePluginConfig>,
  ): Promise<void>;
  onConfigChange(config: ResumeShufflePluginConfig): void;
  stop(): void;
};

type NativeQueue = {
  shuffle?: () => void;
  store?: {
    store?: {
      getState: () => {
        queue?: { items?: unknown[]; selectedItemIndex?: number };
      };
      subscribe: (callback: () => void) => unknown;
    };
  };
};
type QueueHolder = HTMLElement & { queue?: NativeQueue };

function videoId(api: MusicPlayer) {
  try {
    const data = api.getVideoData()?.video_id;
    const response = api.getPlayerResponse()?.videoDetails?.videoId;
    return typeof data === 'string' &&
      /^[\w-]{11}$/.test(data) &&
      data === response
      ? data
      : undefined;
  } catch {
    return undefined;
  }
}

function selectedVideo(item: unknown) {
  if (!item || typeof item !== 'object') return undefined;
  return (
    item as {
      playlistPanelVideoRenderer?: { videoId?: unknown; selected?: unknown };
    }
  ).playlistPanelVideoRenderer;
}

export default createPlugin<
  unknown,
  unknown,
  ResumeRenderer,
  ResumeShufflePluginConfig
>({
  name: () => t('plugins.resume-shuffle.name'),
  description: () => t('plugins.resume-shuffle.description'),
  restartNeeded: false,
  config: { enabled: false, shuffled: false } as ResumeShufflePluginConfig,
  renderer: {
    generation: 0,
    dispose: undefined as (() => void) | undefined,
    latestConfig: undefined as ResumeShufflePluginConfig | undefined,
    async onPlayerApiReady(api, { getConfig, setConfig }) {
      const generation = ++this.generation;
      const previous = this.dispose;
      this.dispose = undefined;
      this.latestConfig = undefined;
      previous?.();
      if (generation !== this.generation) return;
      const saved = await getConfig();
      if (generation !== this.generation) return;
      const config = this.latestConfig ?? saved;
      if (config.enabled !== true) return;
      const bar = document.querySelector<QueueHolder>('ytmusic-player-bar');
      if (!bar) return;
      let alive = true;
      let pending = false;
      let preserveSavedChoice = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let discovery: MutationObserver | undefined;
      let unsubscribe: (() => void) | undefined;
      let stopTrackWatch: (() => void) | undefined;
      let lastSaved: boolean | undefined;
      let queued: boolean | undefined;
      let writing = false;
      const owned = () =>
        alive &&
        generation === this.generation &&
        bar.isConnected &&
        document.querySelector('ytmusic-player-bar') === bar;
      // Coalesce state bursts while a previous config IPC is still in flight.
      const persist = (value: boolean) => {
        if (!owned() || value === lastSaved) return;
        lastSaved = value;
        queued = value;
        if (writing) return;
        writing = true;
        (async () => {
          try {
            while (owned() && queued !== undefined) {
              const shuffled = queued;
              queued = undefined;
              await setConfig({ shuffled });
            }
          } catch (error) {
            if (owned())
              console.warn(
                '[resume-shuffle] Unable to save shuffle state',
                error,
              );
          } finally {
            writing = false;
          }
        })().catch(() => {});
      };
      const finishRestore = () => {
        pending = false;
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
        discovery?.disconnect();
        discovery = undefined;
        const release = unsubscribe;
        unsubscribe = undefined;
        release?.();
        stopTrackWatch?.();
        stopTrackWatch = undefined;
      };
      const observer = new MutationObserver(() => {
        const shuffled = bar.hasAttribute('shuffle-on');
        if (owned() && (!preserveSavedChoice || shuffled)) persist(shuffled);
      });
      observer.observe(bar, {
        attributes: true,
        attributeFilter: ['shuffle-on'],
      });
      const cancelOnUserClick = (event: Event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('.shuffle')
        ) {
          preserveSavedChoice = false;
          finishRestore();
        }
      };
      bar.addEventListener('click', cancelOnUserClick, true);
      this.dispose = () => {
        alive = false;
        queued = undefined;
        finishRestore();
        observer.disconnect();
        bar.removeEventListener('click', cancelOnUserClick, true);
      };
      const shouldRestore =
        location.pathname === '/watch' &&
        config.shuffled === true &&
        window.mainConfig.get('options.resumeOnStart') === true;
      if (!shouldRestore) {
        persist(bar.hasAttribute('shuffle-on'));
        return;
      }
      preserveSavedChoice = true;
      pending = true;
      timeout = setTimeout(finishRestore, RESTORE_TIMEOUT_MS);
      const initialId = videoId(api);
      // Never erase a saved shuffled queue because its native player is not ready.
      if (!initialId) return;
      const trackChanged = (event: Event) => {
        const detail = (event as CustomEvent<VideoDataChanged>).detail;
        if (detail?.name !== 'dataloaded') return;
        const current = videoId(api);
        if (!current || current !== initialId) finishRestore();
      };
      document.addEventListener('videodatachange', trackChanged);
      stopTrackWatch = () =>
        document.removeEventListener('videodatachange', trackChanged);
      const discoverQueue = () => {
        if (!pending || !owned() || videoId(api) !== initialId) {
          finishRestore();
          return;
        }
        const element = document.querySelector<QueueHolder>('#queue');
        const queue = element?.queue;
        const store = queue?.store?.store;
        const actionQueue =
          typeof bar.queue?.shuffle === 'function' ? bar.queue : queue;
        if (
          !element ||
          !queue ||
          !store ||
          typeof store.getState !== 'function' ||
          typeof store.subscribe !== 'function' ||
          typeof actionQueue?.shuffle !== 'function'
        )
          return;
        discovery?.disconnect();
        discovery = undefined;
        const attempt = () => {
          if (!pending) return;
          if (
            !owned() ||
            videoId(api) !== initialId ||
            document.querySelector('#queue') !== element ||
            element.queue !== queue ||
            queue.store?.store !== store ||
            (actionQueue !== queue && bar.queue !== actionQueue)
          ) {
            finishRestore();
            return;
          }
          try {
            const state = store.getState().queue;
            const items = state?.items;
            if (!Array.isArray(items) || !items.length) return;
            const index = state?.selectedItemIndex;
            const current =
              index === undefined
                ? items.find((item) => selectedVideo(item)?.selected === true)
                : Number.isInteger(index) && index >= 0
                  ? items[index]
                  : undefined;
            if (selectedVideo(current)?.videoId !== initialId) return;
            preserveSavedChoice = false;
            finishRestore();
            if (owned() && !bar.hasAttribute('shuffle-on'))
              actionQueue.shuffle?.();
          } catch {
            finishRestore();
          }
        };
        try {
          let admitted = false;
          const release = store.subscribe(() => {
            if (admitted) attempt();
          });
          if (typeof release !== 'function') {
            finishRestore();
            return;
          }
          admitted = true;
          // Native stores may invoke the callback synchronously during subscribe.
          if (pending) unsubscribe = release as () => void;
          else (release as () => void)();
          attempt();
        } catch {
          finishRestore();
        }
      };
      discovery = new MutationObserver(discoverQueue);
      discovery.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      discoverQueue();
    },
    onConfigChange(config) {
      this.latestConfig = config;
      if (config.enabled !== true) this.stop();
    },
    stop() {
      this.generation++;
      const dispose = this.dispose;
      this.dispose = undefined;
      dispose?.();
    },
  },
});
