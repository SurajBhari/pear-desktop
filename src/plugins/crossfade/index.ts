// Crossfade originated in upstream #4701 by sivoleck (Clovis), head 762f98abcd8fc9174b09d4cdb1ef29502a5c8856.
import prompt from 'custom-electron-prompt';
import { Innertube } from '\u0079\u006f\u0075\u0074\u0075\u0062\u0065i.js';

import { t } from '@/i18n';
import { getNetFetchAsFetch } from '@/plugins/utils/main';
import promptOptions from '@/providers/prompt-options';
import { getCurrentAudioGraph } from '@/providers/renderer-audio';
import { createPlugin } from '@/utils';

import {
  crossfadeDefaults,
  parseCrossfadeMenu,
  type CrossfadePluginConfig,
} from './config';
import { createCrossfadeController } from './controller';
import { selectCrossfadeAudioFormat, type StreamResult } from './stream';

import type { RendererContext } from '@/types/contexts';
import type { BrowserWindow } from 'electron';
export type { CrossfadePluginConfig } from './config';

export default createPlugin<
  unknown,
  unknown,
  {
    config?: CrossfadePluginConfig;
    ipc?: RendererContext<CrossfadePluginConfig>['ipc'];
    dispose?: () => void;
    controller?: ReturnType<typeof createCrossfadeController>;
  },
  CrossfadePluginConfig
>({
  name: () => t('plugins.crossfade.name'),
  description: () => t('plugins.crossfade.description'),
  restartNeeded: true,
  config: crossfadeDefaults,
  menu({ window, getConfig, setConfig }) {
    const promptCrossfadeValues = async (
      win: BrowserWindow,
      options: CrossfadePluginConfig,
    ): Promise<Omit<CrossfadePluginConfig, 'enabled'> | undefined> => {
      const res = await prompt(
        {
          title: t('plugins.crossfade.prompt.options'),
          type: 'multiInput',
          multiInputOptions: [
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.fade-in-duration',
              ),
              value: options.fadeInDuration,
              inputAttrs: {
                type: 'number',
                required: true,
                min: '0',
                step: '100',
              },
            },
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.fade-out-duration',
              ),
              value: options.fadeOutDuration,
              inputAttrs: {
                type: 'number',
                required: true,
                min: '0',
                step: '100',
              },
            },
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.seconds-before-end',
              ),
              value: options.secondsBeforeEnd,
              inputAttrs: {
                type: 'number',
                required: true,
                min: '0',
              },
            },
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.fade-scaling.label',
              ),
              selectOptions: {
                linear: t(
                  'plugins.crossfade.prompt.options.multi-input.fade-scaling.linear',
                ),
                equalPower: t(
                  'plugins.crossfade.prompt.options.multi-input.fade-scaling.equalPower',
                ),
                logarithmic: t(
                  'plugins.crossfade.prompt.options.multi-input.fade-scaling.logarithmic',
                ),
              },
              value: options.fadeScaling,
            },
          ],
          resizable: true,
          height: 360,
          ...promptOptions(),
        },
        win,
      ).catch(console.error);

      if (!res) {
        return undefined;
      }

      return parseCrossfadeMenu(res);
    };

    return [
      {
        label: t('plugins.crossfade.menu.advanced'),
        async click() {
          const newOptions = await promptCrossfadeValues(
            window,
            await getConfig(),
          );
          if (newOptions) {
            setConfig(newOptions);
          }
        },
      },
    ];
  },

  async backend({ ipc }) {
    const yt = await Innertube.create({
      fetch: getNetFetchAsFetch(),
    });

    ipc.handle('audio-url', async (videoID: string) => {
      try {
        if (!/^[\w-]{11}$/.test(videoID)) return null;
        const info = await yt.getBasicInfo(videoID);
        if (
          info.basic_info.id !== videoID ||
          info.basic_info.is_live === true ||
          info.basic_info.is_live_content === true
        )
          return null;
        const format = selectCrossfadeAudioFormat(
          info.streaming_data?.adaptive_formats ?? [],
        );
        if (!format) return null;
        try {
          const url = await format.decipher(yt.session.player);
          return {
            url,
            mimeType: format.mime_type,
            contentLength: format.content_length!,
          } satisfies StreamResult;
        } catch {
          return null;
        }
      } catch {
        return null;
      }
    });
  },

  renderer: {
    async start({ ipc, getConfig }) {
      this.config = await getConfig();
      this.ipc = ipc;
    },
    stop() {
      const dispose = this.dispose;
      this.dispose = undefined;
      this.controller = undefined;
      dispose?.();
    },
    onConfigChange(newConfig) {
      this.config = newConfig;
      this.controller?.configure(newConfig);
    },
    onPlayerApiReady(api) {
      const previousDispose = this.dispose;
      let stopped = false;
      let controller: ReturnType<typeof createCrossfadeController> | undefined;
      let releaseSpeed: (() => void) | undefined;
      const status = document.createElement('div');
      status.setAttribute('role', 'status');
      status.style.cssText =
        'padding:8px 16px;background:#282828;color:#fff;font:13px system-ui';
      const dispose = () => {
        if (stopped) return;
        stopped = true;
        controller?.dispose();
        status.remove();
        const release = releaseSpeed;
        releaseSpeed = undefined;
        release?.();
      };
      this.dispose = dispose;
      previousDispose?.();
      if (stopped || this.dispose !== dispose) return;
      const main = document.querySelector('video');
      const graph = getCurrentAudioGraph();
      if (!api || !main || !graph || !this.config) return;
      controller = createCrossfadeController({
        api,
        main,
        graph,
        config: this.config,
        requestAudio: (videoId) =>
          this.ipc!.invoke(
            'audio-url',
            videoId,
          ) as Promise<StreamResult | null>,
        onUnavailable: () => {
          if (stopped) return;
          status.textContent = t('plugins.crossfade.route-unavailable');
          if (!status.isConnected) document.body.append(status);
        },
      });
      this.controller = controller;
      try {
        const release = this.ipc?.subscribe?.(
          'peard:playback-speed-step',
          (...args: unknown[]) => {
            if (
              !stopped &&
              releaseSpeed &&
              args.length === 1 &&
              (args[0] === 1 || args[0] === -1)
            )
              controller?.cancel();
          },
        );
        if (typeof release === 'function') {
          if (stopped) release();
          else releaseSpeed = release;
        }
      } catch {
        /* Unsupported subscriptions never grant ownership. */
      }
    },
  },
});
