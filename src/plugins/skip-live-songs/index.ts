import { t } from '@/i18n';
import { createPlaybackFilter } from '@/plugins/utils/renderer/playback-filter';
import { createPlugin } from '@/utils';

import {
  resolveRecordingCategories,
  type RecordingCategories,
  type SkipLiveSongsConfig,
} from './config';
import { onMenu } from './menu';
import { isNonStudioTitle } from './patterns';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

let active = false;
let ready = false;
let enabled = false;
let categories: RecordingCategories | null = null;
const applyConfig = (config: SkipLiveSongsConfig) => {
  enabled = config.enabled === true;
  categories = resolveRecordingCategories(config.categories);
};
let generation = 0;
let configRevision = 0;
let filter: ReturnType<typeof createPlaybackFilter> | undefined;
const stop = () => {
  active = false;
  ready = false;
  enabled = false;
  categories = null;
  generation++;
  configRevision++;
  filter?.stop();
  filter = undefined;
};

// Upstream #4093, @amontariol; native API skip and shared playback claim replace DOM clicking.
export default createPlugin({
  name: () => t('plugins.skip-live-songs.name'),
  description: () => t('plugins.skip-live-songs.description'),
  restartNeeded: false,
  config: { enabled: false } as SkipLiveSongsConfig,
  menu: onMenu,
  menuWhenDisabled: true,
  renderer: {
    async start(context: RendererContext<SkipLiveSongsConfig>) {
      stop();
      active = true;
      const epoch = generation;
      const revision = configRevision;
      try {
        filter = createPlaybackFilter(
          context,
          (track) =>
            enabled &&
            categories !== null &&
            (isNonStudioTitle(track.title, categories) ||
              isNonStudioTitle(track.alternativeTitle, categories)),
          { kind: 'live' },
        );
        const config = await context.getConfig();
        if (!active || generation !== epoch) return;
        if (configRevision === revision) applyConfig(config);
        ready = true;
      } catch (error) {
        if (generation === epoch) stop();
        throw error;
      }
    },
    onPlayerApiReady(api: MusicPlayer) {
      if (!ready) return;
      filter?.attach(api);
    },
    onConfigChange(config: SkipLiveSongsConfig) {
      configRevision++;
      applyConfig(config);
      filter?.refresh();
    },
    stop,
  },
});
