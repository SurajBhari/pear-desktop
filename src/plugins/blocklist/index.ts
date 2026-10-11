import { t } from '@/i18n';
import { createPlaybackFilter } from '@/plugins/utils/renderer/playback-filter';
import { createPlugin } from '@/utils';

import {
  matchesArtist,
  sameArtist,
  validArtistList,
  type BlockedArtist,
} from './matching';
import { onMenu } from './menu';
import { createBlocklistUI } from './renderer';
import style from './style.css?inline';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export type BlocklistPluginConfig = {
  enabled: boolean;
  blockedArtists: BlockedArtist[];
};
let generation = 0;
let configRevision = 0;
let writeEpoch = 0;
let active = false;
let ready = false;
let config: BlocklistPluginConfig = { enabled: false, blockedArtists: [] };
let persistedArtists = config.blockedArtists;
let filter: ReturnType<typeof createPlaybackFilter> | undefined;
let ui: ReturnType<typeof createBlocklistUI> | undefined;
let api: MusicPlayer | undefined;
type PendingAddition = {
  artist: BlockedArtist;
  generation: number;
  write: number;
  isOwned: () => boolean;
  admitted: boolean;
  revision?: number;
};
const additions = new Set<PendingAddition>();
const ownsQueuedAddition = (job: PendingAddition) => {
  try {
    const current = () =>
      active &&
      generation === job.generation &&
      writeEpoch === job.write &&
      additions.has(job) &&
      config.enabled &&
      validArtistList(persistedArtists);
    // Ownership reads may synchronously retire the writer; validate again
    // without invoking the callback a second time.
    return current() && job.isOwned() && current();
  } catch {
    return false;
  }
};
const withArtist = (artists: BlockedArtist[], artist: BlockedArtist) =>
  artists.some((item) => sameArtist(item, artist))
    ? artists.map((item) => ({ ...item }))
    : [...artists.map((item) => ({ ...item })), { ...artist }];
const refreshOptimisticArtists = () => {
  let artists = persistedArtists;
  if (validArtistList(artists)) {
    for (const job of additions) {
      if (
        active &&
        generation === job.generation &&
        writeEpoch === job.write &&
        (job.admitted
          ? job.revision === configRevision
          : ownsQueuedAddition(job))
      )
        artists = withArtist(artists, job.artist);
    }
  }
  config = { ...config, blockedArtists: artists };
};
const stop = () => {
  active = false;
  ready = false;
  generation++;
  configRevision++;
  writeEpoch++;
  ui?.stop();
  ui = undefined;
  filter?.stop();
  filter = undefined;
  api = undefined;
  additions.clear();
};

// Adapted from upstream #4567, @h0tp-ftw; current-native ownership and hot lifecycle added.
export default createPlugin({
  name: () => t('plugins.blocklist.name'),
  description: () => t('plugins.blocklist.description'),
  restartNeeded: false,
  config: { enabled: false, blockedArtists: [] } as BlocklistPluginConfig,
  menu: onMenu,
  stylesheets: [style],
  renderer: {
    async start(context: RendererContext<BlocklistPluginConfig>) {
      stop();
      active = true;
      const epoch = generation;
      const revision = configRevision;
      try {
        filter = createPlaybackFilter(
          context,
          (track) =>
            config.enabled &&
            validArtistList(config.blockedArtists) &&
            matchesArtist(config.blockedArtists, track),
        );
        const raw = await context.getConfig();
        if (!active || generation !== epoch) return;
        if (configRevision === revision) {
          config = raw;
          persistedArtists = raw.blockedArtists;
        }
        ready = true;
        let writes = Promise.resolve(true);
        ui = createBlocklistUI(
          () => config,
          () => api,
          (artist, isOwned) => {
            if (!config.enabled || !validArtistList([artist]) || !isOwned())
              return Promise.resolve(false);
            const job: PendingAddition = {
              artist: { ...artist },
              generation: epoch,
              write: writeEpoch,
              isOwned,
              admitted: false,
            };
            additions.add(job);
            refreshOptimisticArtists();
            filter?.refresh();
            const result = writes
              .then(async () => {
                if (!ownsQueuedAddition(job)) return false;
                // Admission is a single addition over the latest confirmed list,
                // never a captured optimistic prefix from another queued job.
                const artists = withArtist(persistedArtists, job.artist);
                if (!validArtistList(artists)) return false;
                const revision = configRevision;
                job.admitted = true;
                job.revision = revision;
                await context.setConfig({ blockedArtists: artists });
                const current =
                  active && generation === epoch && writeEpoch === job.write;
                // A later authoritative watch owns the base, even if an older
                // admitted write's promise completes afterward.
                if (current && configRevision === revision)
                  persistedArtists = artists;
                return current;
              })
              .catch((error) => {
                console.error('[blocklist] Could not save artist list', error);
                return false;
              })
              .finally(() => {
                additions.delete(job);
                if (active && generation === epoch) refreshOptimisticArtists();
              });
            writes = result;
            return result;
          },
        );
      } catch (error) {
        if (generation === epoch) stop();
        throw error;
      }
    },
    onPlayerApiReady(player: MusicPlayer) {
      if (!filter || !ready) return;
      api = player;
      filter.attach(player);
      ui?.refresh();
    },
    onConfigChange(raw: BlocklistPluginConfig) {
      configRevision++;
      persistedArtists = raw.blockedArtists;
      if (!raw.enabled || !validArtistList(raw.blockedArtists)) {
        additions.clear();
        writeEpoch++;
      }
      config = raw;
      refreshOptimisticArtists();
      filter?.refresh();
      ui?.refresh();
    },
    stop,
  },
});
