import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { createShuffleActionOwner } from '../../utils/shuffle-action-owner';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';
import type { VideoDataChanged } from '@/types/video-data-changed';

const CHECK_DELAY_MS = 1500;
export type ForceShufflePluginConfig = {
  enabled: boolean;
  mode: 'always' | 'preserve';
};
type ForceRenderer = {
  generation: number;
  latestConfig: ForceShufflePluginConfig | undefined;
  dispose: (() => void) | undefined;
  cancelCheck: (() => void) | undefined;
  onPlayerApiReady(
    api: MusicPlayer,
    context: RendererContext<ForceShufflePluginConfig>,
  ): Promise<void>;
  onConfigChange(config: ForceShufflePluginConfig): void;
  stop(): void;
};
type NativeStore = {
  getState: () => { queue?: { items?: unknown[]; selectedItemIndex?: number } };
  subscribe: (callback: () => void) => unknown;
};
type NativeQueue = { shuffle?: () => void; store?: { store?: NativeStore } };
type QueueHolder = HTMLElement & { queue?: NativeQueue };
type Binding = {
  element: QueueHolder;
  queue: NativeQueue;
  store: NativeStore;
  action: NativeQueue;
  shuffle: () => void;
  getState: NativeStore['getState'];
  subscribe: NativeStore['subscribe'];
};
type Episode = {
  revision: number;
  href: string;
  id?: string;
  binding?: Binding;
  observed?: Partial<Binding>;
  timer?: ReturnType<typeof setTimeout>;
  observer?: MutationObserver;
  unsubscribe?: () => void;
};

function currentVideo(
  api: MusicPlayer,
  owned: () => boolean,
): string | undefined {
  try {
    if (!owned()) return;
    const data = api.getVideoData()?.video_id;
    if (!owned()) return;
    const response = api.getPlayerResponse()?.videoDetails?.videoId;
    if (
      owned() &&
      typeof data === 'string' &&
      /^[\w-]{11}$/.test(data) &&
      data === response
    )
      return data;
  } catch {
    /* Native metadata can be unavailable during a replacement. */
  }
  return;
}

function selectedVideo(store: Binding): unknown {
  const state = Reflect.apply(store.getState, store.store, []).queue;
  const items = state?.items;
  if (!Array.isArray(items) || !items.length) return;
  const renderer = (item: unknown) =>
    item && typeof item === 'object'
      ? (
          item as {
            playlistPanelVideoRenderer?: {
              videoId?: unknown;
              selected?: unknown;
            };
          }
        ).playlistPanelVideoRenderer
      : undefined;
  const index = state?.selectedItemIndex;
  const selected =
    index === undefined
      ? items.filter((item) => renderer(item)?.selected === true)
      : Number.isInteger(index) && index >= 0
        ? [items[index]]
        : [];
  return selected.length === 1 ? renderer(selected[0])?.videoId : undefined;
}

export default createPlugin<
  unknown,
  unknown,
  ForceRenderer,
  ForceShufflePluginConfig
>({
  name: () => t('plugins.force-shuffle.name'),
  description: () => t('plugins.force-shuffle.description'),
  restartNeeded: false,
  config: { enabled: false, mode: 'always' },
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    return [
      {
        label: t('plugins.force-shuffle.menu.always'),
        type: 'radio',
        checked: config.mode !== 'preserve',
        click: () => setConfig({ mode: 'always' }),
      },
      {
        label: t('plugins.force-shuffle.menu.preserve'),
        type: 'radio',
        checked: config.mode === 'preserve',
        click: () => setConfig({ mode: 'preserve' }),
      },
    ];
  },
  renderer: {
    generation: 0,
    latestConfig: undefined,
    dispose: undefined,
    cancelCheck: undefined,
    async onPlayerApiReady(api, context) {
      const generation = ++this.generation;
      const previous = this.dispose;
      this.dispose = undefined;
      this.cancelCheck = undefined;
      this.latestConfig = undefined;
      previous?.();
      if (generation !== this.generation) return;
      const saved = await context.getConfig();
      if (generation !== this.generation) return;
      const config = this.latestConfig ?? saved;
      if (config.enabled !== true) return;
      const doc = document;
      const view = doc.defaultView;
      const bar = doc.querySelector<QueueHolder>('ytmusic-player-bar');
      if (!bar || !view) return;
      const actionOwner = createShuffleActionOwner(doc, 'force');
      let alive = true;
      let revision = 0;
      let current: Episode | undefined;
      let choice: boolean | undefined = bar.hasAttribute('shuffle-on')
        ? true
        : undefined;
      let userOffVideo: string | undefined;
      let lastVideo: string | undefined;
      let offNeedsIdentity = false;
      const owned = () =>
        alive &&
        generation === this.generation &&
        document === doc &&
        window === view &&
        view.document === doc &&
        bar.isConnected &&
        doc.querySelector('ytmusic-player-bar') === bar &&
        actionOwner.isCurrent();
      const episodeOwned = (episode: Episode) =>
        owned() &&
        current === episode &&
        revision === episode.revision &&
        view.location.href === episode.href;
      const snapshot = (episode?: Episode): Binding | undefined => {
        const element = doc.querySelector<QueueHolder>('#queue');
        const queue = element?.queue;
        const store = queue?.store?.store;
        const facade = bar.queue;
        const facadeShuffle = facade?.shuffle;
        const action = typeof facadeShuffle === 'function' ? facade : queue;
        const shuffle =
          typeof facadeShuffle === 'function' ? facadeShuffle : queue?.shuffle;
        const getState = store?.getState;
        const subscribe = store?.subscribe;
        if (episode) {
          if (!episodeOwned(episode)) return;
          const observed = {
            element: element ?? undefined,
            queue,
            store,
            action: typeof shuffle === 'function' ? action : undefined,
            shuffle,
            getState,
            subscribe,
          };
          const previous = (episode.observed ??= {});
          for (const key of Object.keys(observed) as (keyof Binding)[]) {
            if (previous[key] !== undefined && previous[key] !== observed[key])
              throw new Error('Captured native queue changed');
            if (observed[key] !== undefined)
              Object.assign(previous, { [key]: observed[key] });
          }
        }
        if (
          !element ||
          !queue ||
          !store ||
          !action ||
          typeof shuffle !== 'function' ||
          typeof getState !== 'function' ||
          typeof subscribe !== 'function'
        )
          return;
        return { element, queue, store, action, shuffle, getState, subscribe };
      };
      const sameBinding = (binding: Binding) => {
        const found = snapshot();
        return (
          found &&
          Object.keys(binding).every(
            (key) =>
              found[key as keyof Binding] === binding[key as keyof Binding],
          )
        );
      };
      const cancelEpisode = (episode = current) => {
        if (!episode || current !== episode) return;
        current = undefined;
        if (episode.timer !== undefined) clearTimeout(episode.timer);
        episode.timer = undefined;
        episode.observer?.disconnect();
        episode.observer = undefined;
        const release = episode.unsubscribe;
        episode.unsubscribe = undefined;
        release?.();
      };
      const cancelCheck = () => {
        revision++;
        cancelEpisode();
      };
      const bind = (episode: Episode) => {
        if (!episodeOwned(episode) || episode.binding) return;
        let binding: Binding | undefined;
        try {
          binding = snapshot(episode);
        } catch {
          cancelEpisode(episode);
          return;
        }
        if (!episodeOwned(episode) || !binding) return;
        episode.binding = binding;
        let admitted = false;
        const inspect = () => {
          if (!episodeOwned(episode)) {
            cancelEpisode(episode);
            return;
          }
          try {
            const validBinding = sameBinding(binding);
            if (!episodeOwned(episode)) return;
            if (!validBinding) {
              cancelEpisode(episode);
              return;
            }
            const selected = selectedVideo(binding);
            if (
              episodeOwned(episode) &&
              selected !== undefined &&
              selected !== episode.id
            )
              cancelEpisode(episode);
          } catch {
            cancelEpisode(episode);
          }
        };
        try {
          const release = Reflect.apply(binding.subscribe, binding.store, [
            () => {
              if (admitted) inspect();
            },
          ]);
          if (typeof release !== 'function') {
            cancelEpisode(episode);
            return;
          }
          admitted = true;
          if (episodeOwned(episode))
            episode.unsubscribe = release as () => void;
          else (release as () => void)();
        } catch {
          cancelEpisode(episode);
        }
      };
      const check = (episode: Episode) => {
        episode.timer = undefined;
        if (!owned()) {
          dispose();
          return;
        }
        if (!episodeOwned(episode)) {
          cancelEpisode(episode);
          return;
        }
        bind(episode);
        const binding = episode.binding;
        if (!binding || !episodeOwned(episode)) {
          cancelEpisode(episode);
          return;
        }
        // Release readiness work first; its native keeper can reenter lifecycle.
        cancelEpisode(episode);
        const committed = () =>
          owned() &&
          revision === episode.revision &&
          view.location.href === episode.href;
        try {
          if (!committed() || !sameBinding(binding) || !committed()) return;
          if (currentVideo(api, committed) !== episode.id || !committed())
            return;
          if (selectedVideo(binding) !== episode.id || !committed()) return;
          if (!sameBinding(binding) || !committed()) return;
          if (bar.hasAttribute('shuffle-on')) return;
          if (
            (this.latestConfig ?? config).mode === 'preserve' &&
            choice !== true
          )
            return;
          const now = Date.now();
          if (!committed() || !actionOwner.begin(now)) return;
          Reflect.apply(binding.shuffle, binding.action, []);
        } catch {
          /* Unknown/retired native queue fails closed. */
        }
      };
      let admissions = 0;
      const observeChoice = (records: MutationRecord[]) => {
        if (!owned()) {
          dispose();
          return;
        }
        if (
          choice === undefined &&
          (bar.hasAttribute('shuffle-on') ||
            records.some(
              (record) =>
                record.target === bar &&
                record.attributeName === 'shuffle-on' &&
                record.oldValue !== null,
            ))
        )
          choice = true;
      };
      const dataLoaded = (event: Event) => {
        if (!owned()) {
          dispose();
          return;
        }
        const admission = ++admissions;
        const detail = (event as CustomEvent<VideoDataChanged>).detail;
        if (
          detail?.name !== 'dataloaded' ||
          admission !== admissions ||
          !owned()
        )
          return;
        const nextRevision = ++revision;
        cancelEpisode();
        if (!owned() || nextRevision !== revision) return;
        const episode: Episode = { revision, href: view.location.href };
        current = episode;
        const id = currentVideo(api, () => episodeOwned(episode));
        const eventId = detail.videoData?.videoId;
        if (!episodeOwned(episode) || !id || eventId !== id) {
          cancelEpisode(episode);
          return;
        }
        episode.id = id;
        lastVideo = id;
        if (offNeedsIdentity) {
          userOffVideo = id;
          offNeedsIdentity = false;
        }
        observeChoice(intentObserver.takeRecords());
        if (!episodeOwned(episode)) return;
        if (userOffVideo !== id) userOffVideo = undefined;
        if (
          userOffVideo === id ||
          ((this.latestConfig ?? config).mode === 'preserve' && choice !== true)
        ) {
          cancelEpisode(episode);
          return;
        }
        bind(episode);
        if (!episodeOwned(episode)) return;
        episode.observer = new MutationObserver((records) => {
          if (!owned()) {
            dispose();
            return;
          }
          if (!episodeOwned(episode)) {
            cancelEpisode(episode);
            return;
          }
          const element = episode.binding?.element ?? episode.observed?.element;
          const removed = records.some((record) =>
            [...record.removedNodes].some(
              (node) =>
                node === bar ||
                node.contains(bar) ||
                (element && (node === element || node.contains(element))),
            ),
          );
          if (removed) {
            cancelEpisode(episode);
            return;
          }
          try {
            if (episode.binding && !sameBinding(episode.binding))
              cancelEpisode(episode);
            else bind(episode);
          } catch {
            cancelEpisode(episode);
          }
        });
        // Only while this one bounded check is pending; no idle discovery work.
        episode.observer.observe(doc.documentElement, {
          childList: true,
          subtree: true,
        });
        episode.timer = setTimeout(() => check(episode), CHECK_DELAY_MS);
      };
      const intentObserver = new MutationObserver(observeChoice);
      const userClick = (event: Event) => {
        if (
          !owned() ||
          !(event.target instanceof Element) ||
          !event.target.closest('.shuffle')
        )
          return;
        cancelCheck();
        choice = !bar.hasAttribute('shuffle-on');
        userOffVideo = choice
          ? undefined
          : (currentVideo(api, owned) ?? lastVideo);
        offNeedsIdentity = !choice && userOffVideo === undefined;
        if (owned()) cancelCheck();
      };
      const dispose = () => {
        alive = false;
        cancelEpisode();
        intentObserver.disconnect();
        doc.removeEventListener('videodatachange', dataLoaded);
        bar.removeEventListener('click', userClick, true);
        view.removeEventListener('popstate', cancelCheck);
        view.removeEventListener('pagehide', dispose);
        actionOwner.release();
        if (this.cancelCheck === cancelCheck) this.cancelCheck = undefined;
      };
      this.dispose = dispose;
      this.cancelCheck = cancelCheck;
      intentObserver.observe(bar, {
        attributes: true,
        attributeFilter: ['shuffle-on'],
        attributeOldValue: true,
      });
      if (bar.parentElement)
        intentObserver.observe(bar.parentElement, { childList: true });
      bar.addEventListener('click', userClick, true);
      doc.addEventListener('videodatachange', dataLoaded);
      view.addEventListener('popstate', cancelCheck);
      view.addEventListener('pagehide', dispose);
    },
    onConfigChange(config) {
      this.latestConfig = config;
      if (config.enabled !== true) this.stop();
      else this.cancelCheck?.();
    },
    stop() {
      this.generation++;
      const dispose = this.dispose;
      this.dispose = undefined;
      this.cancelCheck = undefined;
      dispose?.();
    },
  },
});
