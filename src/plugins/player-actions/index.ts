import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { ConfigWrites } from './config-writes';
import {
  createSectionRepeatController,
  type SectionRepeatController,
} from './section-repeat/controller';
import { sanitizeSaved, type SavedSongs } from './section-repeat/saved';
import {
  createSlowedReverbController,
  type SlowedReverbController,
  type SlowedReverbConfig,
} from './slowed-reverb/controller';
import { normalize as normalizeSlowedReverb } from './slowed-reverb/engine';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export interface PlayerActionsConfig {
  enabled: boolean;
  slowedReverb: SlowedReverbConfig;
  sectionRepeat: { active: boolean; saved: SavedSongs };
}

const DEFAULT_CONFIG: PlayerActionsConfig = {
  enabled: false,
  slowedReverb: {
    slow: 1,
    reverbIntensity: 0,
    wetHighpass: 180,
    wetLowpass: 6500,
    active: true,
  },
  sectionRepeat: { active: true, saved: [] },
};

interface PlayerActionsRenderer {
  ctx: RendererContext<PlayerActionsConfig> | null;
  current: PlayerActionsConfig | null;
  lifecycle: number;
  running: boolean;
  writes: ConfigWrites | null;
  stopping: boolean;
  slowedReverb: SlowedReverbController;
  sectionRepeat: SectionRepeatController;
  start: (ctx: RendererContext<PlayerActionsConfig>) => Promise<void>;
  stop: () => void;
  onPlayerApiReady: (api: MusicPlayer) => void;
  onConfigChange: (newConfig: PlayerActionsConfig) => void;
  getCurrent: () => PlayerActionsConfig;
}

function normalize(raw: Partial<PlayerActionsConfig>): PlayerActionsConfig {
  const slowed = raw.slowedReverb ?? DEFAULT_CONFIG.slowedReverb;
  const repeat = raw.sectionRepeat ?? DEFAULT_CONFIG.sectionRepeat;
  return {
    enabled: raw.enabled === true,
    slowedReverb: {
      ...normalizeSlowedReverb(slowed),
      active: slowed.active !== false,
    },
    sectionRepeat: {
      active: repeat.active !== false,
      saved: sanitizeSaved(repeat.saved),
    },
  };
}

export default createPlugin<
  unknown,
  unknown,
  PlayerActionsRenderer,
  PlayerActionsConfig
>({
  name: () => t('plugins.player-actions.name'),
  description: () => t('plugins.player-actions.description'),
  authors: ['nathwn12'],
  restartNeeded: false,
  config: { ...DEFAULT_CONFIG },
  renderer: {
    ctx: null,
    current: null,
    lifecycle: 0,
    running: false,
    writes: null,
    stopping: false,
    slowedReverb: createSlowedReverbController(),
    sectionRepeat: createSectionRepeatController(),

    async start(ctx) {
      const generation = ++this.lifecycle;
      this.ctx = ctx;
      try {
        await this.writes?.idle();
        const raw = await ctx.getConfig();
        if (generation !== this.lifecycle) return;
        this.running = true;
        this.current = normalize(raw);
        this.writes = new ConfigWrites(
          async (patch) => {
            await ctx.setConfig(patch);
          },
          () => this.getCurrent(),
        );
        await this.slowedReverb.start({
          getConfig: () => this.getCurrent().slowedReverb,
          setConfig: (patch) => {
            if (generation !== this.lifecycle && !this.stopping)
              return Promise.resolve();
            const next = { ...this.getCurrent().slowedReverb, ...patch };
            this.current = { ...this.getCurrent(), slowedReverb: next };
            return this.writes!.enqueue('slowedReverb', Object.keys(patch));
          },
        });
        if (generation !== this.lifecycle) return;
        await this.sectionRepeat.start({
          getConfig: () => this.getCurrent().sectionRepeat,
          setConfig: (patch) => {
            if (generation !== this.lifecycle && !this.stopping)
              return Promise.resolve();
            const next = { ...this.getCurrent().sectionRepeat, ...patch };
            this.current = { ...this.getCurrent(), sectionRepeat: next };
            return this.writes!.enqueue('sectionRepeat', Object.keys(patch));
          },
        });
      } catch (error) {
        if (generation === this.lifecycle) this.stop();
        throw error;
      }
    },

    stop() {
      this.lifecycle += 1;
      this.running = false;
      this.stopping = true;
      try {
        this.slowedReverb.stop();
        this.sectionRepeat.stop();
      } finally {
        this.stopping = false;
        this.ctx = null;
      }
    },

    onPlayerApiReady(api: MusicPlayer) {
      if (!this.running) return;
      this.slowedReverb.onPlayerApiReady();
      this.sectionRepeat.onPlayerApiReady(api);
    },

    onConfigChange(newConfig) {
      if (!this.running) return;
      this.current =
        this.writes?.accept(normalize(newConfig)) ?? normalize(newConfig);
      this.slowedReverb.onConfigChange(this.current.slowedReverb);
      this.sectionRepeat.onConfigChange(this.current.sectionRepeat);
    },

    getCurrent() {
      return this.current ?? { ...DEFAULT_CONFIG };
    },
  },
});
