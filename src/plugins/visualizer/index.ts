import { t } from '@/i18n';
import { getCurrentAudioGraph } from '@/providers/renderer-audio';
import { createPlugin } from '@/utils';

import emptyStyle from './empty-player.css?inline';
import {
  ButterchurnVisualizer as butterchurn,
  VudioVisualizer as vudio,
  WaveVisualizer as wave,
} from './visualizers';
import { type Visualizer } from './visualizers/visualizer';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

type WaveColor = {
  gradient: string[];
  rotate?: number;
};

export type VisualizerPluginConfig = {
  enabled: boolean;
  type: 'butterchurn' | 'vudio' | 'wave';
  butterchurn: {
    preset: string;
    blendTimeInSeconds: number;
  };
  vudio: {
    effect: string;
    accuracy: number;
    lighting: {
      maxHeight: number;
      maxSize: number;
      lineWidth: number;
      color: string;
      shadowBlur: number;
      shadowColor: string;
      fadeSide: boolean;
      prettify: boolean;
      horizontalAlign: string;
      verticalAlign: string;
      dottify: boolean;
    };
  };
  wave: {
    animations: {
      type: string;
      config: {
        bottom?: boolean;
        top?: boolean;
        count?: number;
        cubeHeight?: number;
        lineWidth?: number;
        diameter?: number;
        fillColor?: string | WaveColor;
        lineColor?: string | WaveColor;
        radius?: number;
        frequencyBand?: string;
      };
    }[];
  };
};

type VisualizerLifetime = {
  alive: boolean;
  revision: number;
  visualizerInstance: Visualizer | null;
  audioContext: AudioContext | null;
  audioSource: MediaElementAudioSourceNode | null;
  isCurrentAudio: (() => boolean) | null;
  observer: ResizeObserver | null;
  createdCanvas: HTMLCanvasElement | null;
  listener:
    | ((
        event: CustomEvent<{
          audioContext: AudioContext;
          audioSource: MediaElementAudioSourceNode;
        }>,
      ) => Promise<void>)
    | null;
};

export default createPlugin({
  name: () => t('plugins.visualizer.name'),
  description: () => t('plugins.visualizer.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    type: 'butterchurn',
    // Config per visualizer
    butterchurn: {
      preset: 'martin [shadow harlequins shape code] - fata morgana',
      blendTimeInSeconds: 2.7,
    },
    vudio: {
      effect: 'lighting',
      accuracy: 128,
      lighting: {
        maxHeight: 160,
        maxSize: 12,
        lineWidth: 1,
        color: '#49f3f7',
        shadowBlur: 2,
        shadowColor: 'rgba(244,244,244,.5)',
        fadeSide: true,
        prettify: false,
        horizontalAlign: 'center',
        verticalAlign: 'middle',
        dottify: true,
      },
    },
    wave: {
      animations: [
        {
          type: 'Cubes',
          config: {
            bottom: true,
            count: 30,
            cubeHeight: 5,
            fillColor: { gradient: ['#FAD961', '#F76B1C'] },
            lineColor: 'rgba(0,0,0,0)',
            radius: 20,
          },
        },
        {
          type: 'Cubes',
          config: {
            top: true,
            count: 12,
            cubeHeight: 5,
            fillColor: { gradient: ['#FAD961', '#F76B1C'] },
            lineColor: 'rgba(0,0,0,0)',
            radius: 10,
          },
        },
        {
          type: 'Circles',
          config: {
            lineColor: {
              gradient: ['#FAD961', '#FAD961', '#F76B1C'],
              rotate: 90,
            },
            lineWidth: 4,
            diameter: 20,
            count: 10,
            frequencyBand: 'base',
          },
        },
      ],
    },
  } as VisualizerPluginConfig,
  stylesheets: [emptyStyle],
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    const visualizerTypes = ['butterchurn', 'vudio', 'wave'] as const; // For bundling

    return [
      {
        label: t('plugins.visualizer.menu.visualizer-type'),
        submenu: visualizerTypes.map((visualizerType) => ({
          label: visualizerType,
          type: 'radio',
          checked: config.type === visualizerType,
          click() {
            setConfig({ type: visualizerType });
          },
        })),
      },
    ];
  },

  renderer: (function createVisualizerRenderer() {
    let current: VisualizerLifetime | null = null;
    const owns = (owner: VisualizerLifetime) =>
      current === owner && owner.alive;
    const retireInstance = (owner: VisualizerLifetime) => {
      const observer = owner.observer;
      owner.observer = null;
      observer?.disconnect();
      const instance = owner.visualizerInstance;
      owner.visualizerInstance = null;
      instance?.destroy();
    };
    const retire = (owner: VisualizerLifetime | null) => {
      if (!owner?.alive) return;
      owner.alive = false;
      owner.revision++;
      if (owner.listener)
        document.removeEventListener('peard:audio-can-play', owner.listener);
      owner.listener = null;
      retireInstance(owner);
      owner.audioContext = null;
      owner.audioSource = null;
      owner.isCurrentAudio = null;
      owner.createdCanvas?.remove();
      owner.createdCanvas = null;
    };
    const createVisualizer = (
      owner: VisualizerLifetime,
      config: VisualizerPluginConfig,
    ) => {
      if (!owns(owner)) return;
      retireInstance(owner);
      if (owner.isCurrentAudio && !owner.isCurrentAudio()) {
        // A rejected bootstrap admission must not remain reusable by later config.
        owner.audioContext = null;
        owner.audioSource = null;
        owner.isCurrentAudio = null;
      }
      if (!owner.audioContext || !owner.audioSource || !config.enabled) return;
      const video = document.querySelector<
        HTMLVideoElement & { captureStream(): MediaStream }
      >('video');
      if (!video) return;
      const container = document.querySelector<HTMLElement>('#player');
      if (!container) return;
      let canvas = document.querySelector<HTMLCanvasElement>('#visualizer');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'visualizer';
        owner.createdCanvas = canvas;
        container.prepend(canvas);
      }
      const gainNode = owner.audioContext.createGain();
      gainNode.gain.value = 1.25;
      owner.audioSource.connect(gainNode);
      let visualizerType: {
        new (...args: ConstructorParameters<typeof vudio>): Visualizer;
      } = vudio;
      if (config.type === 'wave') visualizerType = wave;
      else if (config.type === 'butterchurn') visualizerType = butterchurn;
      const instance = new visualizerType(
        owner.audioContext,
        owner.audioSource,
        canvas,
        gainNode,
        video.captureStream(),
        config,
      );
      owner.visualizerInstance = instance;
      const resizeVisualizer = () => {
        if (!owns(owner) || owner.visualizerInstance !== instance) return;
        const { width, height } = window.getComputedStyle(container);
        canvas.width = Math.ceil(parseFloat(width));
        canvas.height = Math.ceil(parseFloat(height));
        instance.resize(canvas.width, canvas.height);
      };
      resizeVisualizer();
      owner.observer = new ResizeObserver(resizeVisualizer);
      owner.observer.observe(container);
    };
    const applyAudioConfig = async (
      owner: VisualizerLifetime,
      audioContext: AudioContext,
      audioSource: MediaElementAudioSourceNode,
      getConfig: RendererContext<VisualizerPluginConfig>['getConfig'],
      isCurrentSnapshot?: () => boolean,
    ) => {
      if (!owns(owner)) return;
      // Admit synchronously so a newer explicit config can use these references.
      owner.audioContext = audioContext;
      owner.audioSource = audioSource;
      owner.isCurrentAudio = isCurrentSnapshot ?? null;
      const revision = ++owner.revision;
      const config = await getConfig();
      if (!owns(owner) || owner.revision !== revision) return;
      createVisualizer(owner, config);
    };
    return {
      onConfigChange(config: VisualizerPluginConfig) {
        if (!current || !owns(current)) return;
        current.revision++;
        createVisualizer(current, config);
      },
      onPlayerApiReady(
        _: MusicPlayer,
        { getConfig }: RendererContext<VisualizerPluginConfig>,
      ): void {
        const previous = current;
        const owner: VisualizerLifetime = {
          alive: true,
          revision: 0,
          visualizerInstance: null,
          audioContext: null,
          audioSource: null,
          isCurrentAudio: null,
          observer: null,
          createdCanvas: null,
          listener: null,
        };
        current = owner;
        retire(previous);
        const listener = (
          event: CustomEvent<{
            audioContext: AudioContext;
            audioSource: MediaElementAudioSourceNode;
          }>,
        ) =>
          applyAudioConfig(
            owner,
            event.detail.audioContext,
            event.detail.audioSource,
            getConfig,
          );
        owner.listener = listener;
        document.addEventListener('peard:audio-can-play', listener, {
          passive: true,
        });
        const graph = getCurrentAudioGraph();
        const video = document.querySelector<HTMLVideoElement>('video');
        if (!graph || !video || video.readyState < 2) return;
        const { audioContext, audioSource } = graph;
        if (
          audioSource.mediaElement !== video ||
          audioSource.context !== audioContext ||
          audioContext.state === 'closed'
        )
          return;
        const isCurrentSnapshot = () =>
          getCurrentAudioGraph() === graph &&
          graph.audioContext === audioContext &&
          graph.audioSource === audioSource &&
          document.querySelector('video') === video &&
          audioSource.mediaElement === video &&
          audioSource.context === audioContext &&
          audioContext.state !== 'closed';
        // Do not await startup or reapply readiness after admission: normal media
        // readiness changes need not produce another global audio announcement.
        applyAudioConfig(
          owner,
          audioContext,
          audioSource,
          getConfig,
          isCurrentSnapshot,
        ).catch(console.error);
      },
      stop(): void {
        const owner = current;
        current = null;
        retire(owner);
      },
    };
  })(),
});
