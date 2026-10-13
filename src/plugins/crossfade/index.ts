import prompt from 'custom-electron-prompt';
import { Innertube } from '\u0079\u006f\u0075\u0074\u0075\u0062\u0065i.js';

import { t } from '@/i18n';
import { getNetFetchAsFetch } from '@/plugins/utils/main';
import promptOptions from '@/providers/prompt-options';
import { getCurrentAudioGraph } from '@/providers/renderer-audio';
import { createPlugin } from '@/utils';

import { VolumeFader } from './fader';
import { TransitionAudio } from './transition-audio';

import type { RendererContext } from '@/types/contexts';
import type { BrowserWindow } from 'electron';

export type CrossfadePluginConfig = {
  enabled: boolean;
  fadeInDuration: number;
  fadeOutDuration: number;
  secondsBeforeEnd: number;
  fadeScaling: 'linear' | 'logarithmic' | number;
};

export default createPlugin<
  unknown,
  unknown,
  {
    config?: CrossfadePluginConfig;
    ipc?: RendererContext<CrossfadePluginConfig>['ipc'];
    dispose?: () => void;
  },
  CrossfadePluginConfig
>({
  name: () => t('plugins.crossfade.name'),
  description: () => t('plugins.crossfade.description'),
  restartNeeded: true,
  config: {
    enabled: false,
    /**
     * The duration of the fade in and fade out in milliseconds.
     *
     * @default 1500ms
     */
    fadeInDuration: 1500,
    /**
     * The duration of the fade in and fade out in milliseconds.
     *
     * @default 5000ms
     */
    fadeOutDuration: 5000,
    /**
     * The duration of the fade in and fade out in seconds.
     *
     * @default 10s
     */
    secondsBeforeEnd: 10,
    /**
     * The scaling algorithm to use for the fade.
     * (or a positive number in dB)
     *
     * @default 'linear'
     */
    fadeScaling: 'linear',
  },
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

      let fadeScaling: 'linear' | 'logarithmic' | number;
      if (res[3] === 'linear' || res[3] === 'logarithmic') {
        fadeScaling = res[3];
      } else if (isFinite(Number(res[3]))) {
        fadeScaling = Number(res[3]);
      } else {
        fadeScaling = options.fadeScaling;
      }

      return {
        fadeInDuration: Number(res[0]),
        fadeOutDuration: Number(res[1]),
        secondsBeforeEnd: Number(res[2]),
        fadeScaling,
      };
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
      const info = await yt.getBasicInfo(videoID);
      return info.streaming_data?.formats[0].decipher(yt.session.player);
    });
  },

  renderer: {
    async start({ ipc, getConfig }) {
      this.config = await getConfig();
      this.ipc = ipc;
    },
    stop() {
      this.dispose?.();
      this.dispose = undefined;
    },
    onConfigChange(newConfig) {
      this.config = newConfig;
    },
    onPlayerApiReady() {
      this.dispose?.();
      let transitionAudio: TransitionAudio | null = null;
      let stopped = false;
      let request = 0;
      const navigationAbort = new AbortController();
      let mediaAbort = new AbortController();
      const faders = new Set<VolumeFader>();
      let settleTransition: (() => void) | null = null;
      const video = document.querySelector('video')!;
      const graph = getCurrentAudioGraph();
      if (!graph || graph.audioContext.state === 'closed') return;
      const mainGain = graph.audioContext.createGain();
      const releaseMain = graph.insertMain(mainGain, mainGain);
      let envelopeVolume = 1;
      const mainEnvelope = {
        get volume() {
          return envelopeVolume;
        },
        set volume(value: number) {
          envelopeVolume = value;
          mainGain.gain.value = value;
        },
      };
      const status = document.createElement('div');
      status.setAttribute('role', 'status');
      status.style.cssText =
        'padding:8px 16px;background:#282828;color:#fff;font:13px system-ui';
      const unavailable = (error: unknown) => {
        faders.forEach((fader) => fader.stop());
        faders.clear();
        settleTransition?.();
        console.warn(
          '[crossfade] Routed auxiliary playback unavailable',
          error,
        );
        status.textContent = t('plugins.crossfade.route-unavailable');
        if (!status.isConnected) document.body.append(status);
        transitionAudio?.unload();
        transitionAudio = null;
        mainEnvelope.volume = 1;
      };
      this.dispose = () => {
        stopped = true;
        request++;
        navigationAbort.abort();
        mediaAbort.abort();
        transitionAudio?.unload();
        transitionAudio = null;
        faders.forEach((fader) => fader.stop());
        faders.clear();
        settleTransition?.();
        status.remove();
        releaseMain();
        mainGain.disconnect();
        mainEnvelope.volume = 1;
      };
      let firstVideo = true;
      let waitForTransition: Promise<unknown>;

      const getStreamURL = async (videoID: string): Promise<string> =>
        this.ipc?.invoke('audio-url', videoID) as Promise<string>;

      const getVideoIDFromURL = (url: string) =>
        new URLSearchParams(url.split('?')?.at(-1)).get('v');

      const isReadyToCrossfade = () =>
        transitionAudio && transitionAudio.state() === 'loaded';

      const watchVideoIDChanges = (cb: (id: string) => void) => {
        window.navigation.addEventListener(
          'navigate',
          (event) => {
            const currentVideoID = getVideoIDFromURL(
              (event.currentTarget as Navigation).currentEntry?.url ?? '',
            );
            const nextVideoID = getVideoIDFromURL(event.destination.url ?? '');

            if (
              nextVideoID &&
              currentVideoID &&
              (firstVideo || nextVideoID !== currentVideoID)
            ) {
              if (isReadyToCrossfade()) {
                crossfade(() => {
                  cb(nextVideoID);
                });
              } else {
                cb(nextVideoID);
                firstVideo = false;
              }
            }
          },
          { signal: navigationAbort.signal },
        );
      };

      const createAudioForCrossfade = async (url: string) => {
        mediaAbort.abort();
        mediaAbort = new AbortController();
        transitionAudio?.unload();
        transitionAudio = null;
        const graph = getCurrentAudioGraph();
        if (!graph || graph.audioContext.state === 'closed') {
          unavailable(new Error('Music audio graph is not ready'));
          return;
        }
        let audio: TransitionAudio;
        try {
          audio = new TransitionAudio(url, graph);
          audio.bindUserVolume(video);
        } catch (error) {
          unavailable(error);
          return;
        }
        transitionAudio = audio;
        try {
          await audio.ready;
          if (stopped || transitionAudio !== audio) {
            audio.unload();
            return;
          }
          status.remove();
          syncVideoWithTransitionAudio(audio);
        } catch (error) {
          if (!stopped && transitionAudio === audio) unavailable(error);
        }
      };

      const syncVideoWithTransitionAudio = (audio: TransitionAudio) => {
        const video = document.querySelector('video')!;

        const videoFader = new VolumeFader(mainEnvelope, {
          fadeScaling: this.config?.fadeScaling,
          fadeDuration: this.config?.fadeInDuration,
        });

        audio.seek(video.currentTime);
        if (!video.paused)
          audio.play().catch((error) => {
            if (!stopped && transitionAudio === audio) unavailable(error);
          });

        video.addEventListener(
          'seeking',
          () => {
            audio.seek(video.currentTime);
          },
          { signal: mediaAbort.signal },
        );

        video.addEventListener(
          'pause',
          () => {
            audio.pause();
          },
          { signal: mediaAbort.signal },
        );

        faders.add(videoFader);
        mediaAbort.signal.addEventListener(
          'abort',
          () => {
            videoFader.stop();
            faders.delete(videoFader);
          },
          { once: true },
        );
        video.addEventListener(
          'play',
          () => {
            audio.seek(video.currentTime);
            audio
              .play()
              .then(() => {
                if (stopped || transitionAudio !== audio) return;
                if (video.paused) {
                  audio.pause();
                  return;
                }
                mainEnvelope.volume = 0;
                videoFader.fadeTo(1, () => faders.delete(videoFader));
              })
              .catch((error) => {
                if (!stopped && transitionAudio === audio) unavailable(error);
              });
          },
          { signal: mediaAbort.signal },
        );

        // Exit just before the end for the transition
        const transitionBeforeEnd = () => {
          if (
            video.currentTime >=
              video.duration - (this.config?.secondsBeforeEnd ?? 0) &&
            isReadyToCrossfade()
          ) {
            video.removeEventListener('timeupdate', transitionBeforeEnd);

            // Go to next video - XXX: does not support "repeat 1" mode
            document.querySelector<HTMLButtonElement>('.next-button')?.click();
          }
        };

        video.addEventListener('timeupdate', transitionBeforeEnd, {
          signal: mediaAbort.signal,
        });
      };

      const crossfade = (cb: () => void) => {
        if (!isReadyToCrossfade() || video.paused) {
          cb();
          return;
        }

        let resolveTransition: () => void;
        waitForTransition = new Promise<void>((resolve) => {
          resolveTransition = resolve;
          settleTransition = resolve;
        });

        const fader = new VolumeFader(transitionAudio!.element, {
          initialVolume: 1,
          fadeScaling: this.config?.fadeScaling,
          fadeDuration: this.config?.fadeOutDuration,
        });

        faders.add(fader);
        // Silence only our source envelope; preserve deliberate user volume/mute.
        mainEnvelope.volume = 0;
        fader.fadeOut(() => {
          faders.delete(fader);
          resolveTransition();
          if (!stopped) cb();
        });
      };

      watchVideoIDChanges(async (videoID) => {
        await waitForTransition;
        if (stopped) return;
        const id = ++request;
        let url: string;
        try {
          url = await getStreamURL(videoID);
        } catch (error) {
          if (!stopped && id === request) unavailable(error);
          return;
        }
        if (stopped || id !== request) return;
        if (!url) {
          unavailable(new Error('No routable stream URL is available'));
          return;
        }
        await createAudioForCrossfade(url);
      });
    },
  },
});
