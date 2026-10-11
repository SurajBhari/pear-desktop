import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { startAutoAcknowledge } from './controller';

import type { MusicPlayer } from '@/types/music-player';

export type AutoAcknowledgeConfig = { enabled: boolean; debug: boolean };

// Adapted from upstream #4667; only the native suicide/self-harm warning CTA.
export default createPlugin<
  unknown,
  unknown,
  {
    controller?: ReturnType<typeof startAutoAcknowledge>;
    config?: AutoAcknowledgeConfig;
    playerApi?: MusicPlayer;
    generation: number;
    running: boolean;
    activate(): void;
  },
  AutoAcknowledgeConfig
>({
  name: () => t('plugins.auto-acknowledge.name'),
  description: () => t('plugins.auto-acknowledge.description'),
  authors: ['CorruptedKnowledge'],
  addedVersion: '3.13.0',
  restartNeeded: false,
  config: { enabled: false, debug: false },
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    return [
      {
        label: t('plugins.auto-acknowledge.menu.debug'),
        type: 'checkbox',
        checked: config.debug === true,
        click(item) {
          setConfig({ debug: item.checked === true });
        },
      },
    ];
  },
  renderer: {
    generation: 0,
    running: false,
    activate() {
      if (!this.running || this.config?.enabled !== true) return;
      this.controller ??= startAutoAcknowledge(document, {
        debug: () => this.config?.debug === true,
      });
      if (this.playerApi) this.controller.bindPlayerApi(this.playerApi);
    },
    async start({ getConfig }) {
      const generation = ++this.generation;
      this.running = true;
      this.controller?.dispose();
      this.controller = undefined;
      const config = await getConfig();
      if (!this.running || this.generation !== generation) return;
      this.config = config;
      this.activate();
    },
    onConfigChange(config) {
      this.generation++;
      this.config = config;
      if (config.enabled !== true) {
        this.controller?.dispose();
        this.controller = undefined;
      } else this.activate();
    },
    onPlayerApiReady(playerApi) {
      if (!this.running) return;
      this.playerApi = playerApi;
      this.controller?.bindPlayerApi(playerApi);
    },
    stop() {
      this.generation++;
      this.running = false;
      this.controller?.dispose();
      this.controller = undefined;
      this.playerApi = undefined;
    },
  },
});
