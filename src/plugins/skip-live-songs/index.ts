import { t } from '@/i18n';
import { createPlaybackFilter } from '@/plugins/utils/renderer/playback-filter';
import { createPlugin } from '@/utils';

import { isLiveTitle } from './patterns';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

let active = false;
let ready = false;
let enabled = false;
let generation = 0;
let configRevision = 0;
let filter: ReturnType<typeof createPlaybackFilter> | undefined;
const stop = () => {
  active = false;
  ready = false;
  enabled = false;
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
  config: { enabled: false },
  renderer: {
    async start(context: RendererContext<{ enabled: boolean }>) {
      stop();
      active = true;
      const epoch = generation;
      const revision = configRevision;
      try {
        filter = createPlaybackFilter(
          context,
          (track) =>
            enabled &&
            (isLiveTitle(track.title) ||
              isLiveTitle(track.alternativeTitle || '')),
        );
        const config = await context.getConfig();
        if (!active || generation !== epoch) return;
        if (configRevision === revision) enabled = config.enabled;
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
    onConfigChange(config: { enabled: boolean }) {
      configRevision++;
      enabled = config.enabled;
      filter?.refresh();
    },
    stop,
  },
});
