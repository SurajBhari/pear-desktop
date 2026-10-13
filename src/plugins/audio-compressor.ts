import { t } from '@/i18n';
import {
  getCurrentAudioGraph,
  graphFromAnnouncement,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';
import { createPlugin } from '@/utils';

import {
  defaultConfig,
  TrackGain,
  type CompressorConfig,
} from './audio-compressor/track-gain';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

let generation = 0;
let runtime: {
  config: CompressorConfig;
  api: MusicPlayer | null;
  graph: RendererAudioGraph | null;
  compressor: DynamicsCompressorNode | null;
  track: TrackGain | null;
  release: (() => void) | null;
  unsubscribe: (() => void) | null;
  contextChanged: (() => void) | null;
} | null = null;

function detach() {
  const state = runtime;
  if (!state) return;
  state.unsubscribe?.();
  state.unsubscribe = null;
  if (state.contextChanged)
    state.graph?.audioContext.removeEventListener(
      'statechange',
      state.contextChanged,
    );
  state.contextChanged = null;
  state.track?.stop();
  state.release?.();
  state.release = null;
  state.compressor?.disconnect();
  state.track?.node.disconnect();
  state.compressor = null;
  state.track = null;
  state.graph = null;
}
function attach(next: RendererAudioGraph | null) {
  const state = runtime;
  if (
    !state ||
    !next ||
    next === state.graph ||
    next.audioContext.state === 'closed'
  )
    return;
  detach();
  const node = next.audioContext.createDynamicsCompressor();
  node.threshold.value = -50;
  node.ratio.value = 12;
  node.knee.value = 40;
  node.attack.value = 0;
  node.release.value = 0.25;
  const track = new TrackGain(next.audioContext.createGain());
  try {
    node.connect(track.node);
    state.release = next.insertDry(node, track.node);
    state.graph = next;
    state.compressor = node;
    state.track = track;
    track.configure(state.config);
    state.unsubscribe = next.observeAuxiliaryMedia((count) =>
      track.auxiliary(count),
    );
    track.setApi(state.api);
    state.contextChanged = () => {
      if (
        next.audioContext.state === 'closed' &&
        runtime === state &&
        state.graph === next
      )
        detach();
    };
    next.audioContext.addEventListener('statechange', state.contextChanged);
  } catch (error) {
    if (state.graph === next) detach();
    else {
      track.stop();
      node.disconnect();
      track.node.disconnect();
    }
    console.error('[audio-compressor] Could not attach dry insert', error);
  }
}
const handler = ({ detail }: CustomEvent<Compressor>) =>
  attach(graphFromAnnouncement(detail));
function stop() {
  generation++;
  document.removeEventListener('peard:audio-can-play', handler);
  detach();
  runtime = null;
}

export default createPlugin({
  name: () => t('plugins.audio-compressor.name'),
  description: () => t('plugins.audio-compressor.description'),
  authors: ['atrupb'],
  restartNeeded: false,
  config: defaultConfig,
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    return [
      {
        label: t('plugins.audio-compressor.auto-track-gain'),
        type: 'checkbox',
        checked: config.autoTrackGain === true,
        click: (item) => setConfig({ autoTrackGain: item.checked }),
      },
      {
        label: t('plugins.audio-compressor.maximum-gain'),
        submenu: [3, 6, 9, 12].map((value) => ({
          label: `${value} dB`,
          type: 'radio' as const,
          checked: config.maxTrackGainDb === value,
          click: () => setConfig({ maxTrackGainDb: value }),
        })),
      },
      { label: t('plugins.audio-compressor.gain-headroom'), enabled: false },
      { label: t('plugins.audio-compressor.gain-crossfade'), enabled: false },
    ];
  },
  renderer: {
    onPlayerApiReady(api: MusicPlayer) {
      if (!runtime) return;
      runtime.api = api;
      attach(getCurrentAudioGraph());
      runtime.track?.setApi(api);
    },
    async start(context?: RendererContext<CompressorConfig>) {
      stop();
      const epoch = ++generation;
      const config = context ? await context.getConfig() : defaultConfig;
      if (epoch !== generation) return;
      runtime = {
        config,
        api: null,
        graph: null,
        compressor: null,
        track: null,
        release: null,
        unsubscribe: null,
        contextChanged: null,
      };
      document.addEventListener('peard:audio-can-play', handler, {
        passive: true,
      });
      attach(getCurrentAudioGraph());
    },
    onConfigChange(config: CompressorConfig) {
      if (!runtime) return;
      runtime.config = config;
      runtime.track?.configure(config);
    },
    stop,
  },
});
