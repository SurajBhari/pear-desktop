import { deepEqual } from 'fast-equals';

import { t } from '@/i18n';
import {
  getCurrentAudioGraph,
  graphFromAnnouncement,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';
import { createPlugin } from '@/utils';

import {
  defaultConfig,
  normalizeConfig,
  type EqualizerPluginConfig,
} from './config';
import { EqualizerController } from './controller';
import { openEqualizerPanel } from './panel';

import type { RendererContext } from '@/types/contexts';

export type { EqualizerPluginConfig } from './config';
let generation = 0;
let runtime: {
  raw: EqualizerPluginConfig;
  graph: RendererAudioGraph | null;
  controller: EqualizerController | null;
  panel: ReturnType<typeof openEqualizerPanel> | null;
  context: RendererContext<EqualizerPluginConfig>;
  listener: (event: CustomEvent<Compressor>) => void;
  timer?: ReturnType<typeof setTimeout>;
  pending: Partial<EqualizerPluginConfig> | null;
  desired: Partial<EqualizerPluginConfig> | null;
  writeEpoch: number;
  audioError: boolean;
  saveError: boolean;
  writes: Promise<void>;
} | null = null;

function apply() {
  const state = runtime;
  if (!state?.graph) return;
  const normalized = normalizeConfig(state.raw);
  if (!normalized.profile || !normalized.editable) {
    state.controller?.stop();
    state.controller = null;
    state.audioError = false;
    return;
  }
  const controller = state.controller ?? new EqualizerController(state.graph);
  try {
    controller.apply(normalized.profile, state.raw.bypass);
    state.controller = controller;
    state.audioError = false;
    state.panel?.reportError(
      state.saveError ? t('plugins.equalizer.editor.save-error') : null,
    );
  } catch (error) {
    if (!state.controller) controller.stop();
    state.audioError = true;
    state.panel?.reportError(t('plugins.equalizer.editor.audio-error'));
    console.error('[equalizer] Could not apply the audio profile', error);
  }
}
function flush() {
  const state = runtime;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  if (!state.pending) return;
  const value = state.pending;
  const epoch = state.writeEpoch;
  state.pending = null;
  state.writes = state.writes
    .then(async () => {
      if (state.writeEpoch === epoch) await state.context.setConfig(value);
    })
    .catch((error) => {
      console.error('[equalizer] Could not save settings', error);
      if (state.writeEpoch !== epoch || runtime !== state) return;
      state.pending = { ...value, ...state.pending, ...state.desired };
      state.saveError = true;
      state.panel?.reportError(t('plugins.equalizer.editor.save-error'));
    });
}
function change(value: Partial<EqualizerPluginConfig>) {
  const state = runtime;
  if (!state) return;
  state.raw = { ...state.raw, ...value };
  state.pending = { ...state.pending, ...value };
  // Enqueueing a write must not expose later edits to delayed older echoes.
  state.desired = { ...state.desired, ...value };
  apply();
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(flush, 150);
}
function openEditor() {
  const state = runtime;
  if (!state) return;
  state.panel?.dispose();
  state.panel = openEqualizerPanel(
    () => state.raw,
    change,
    flush,
    () => state.graph?.audioContext.sampleRate,
  );
  state.panel.reportError(
    state.audioError
      ? t('plugins.equalizer.editor.audio-error')
      : state.saveError
        ? t('plugins.equalizer.editor.save-error')
        : null,
  );
}
function stopRuntime() {
  generation++;
  const state = runtime;
  if (!state) return;
  state.panel?.dispose();
  flush();
  document.removeEventListener('peard:audio-can-play', state.listener);
  state.context.ipc.removeAllListeners('equalizer:open');
  state.controller?.stop();
  runtime = null;
}
export default createPlugin({
  name: () => t('plugins.equalizer.name'),
  description: () => t('plugins.equalizer.description'),
  restartNeeded: false,
  addedVersion: '3.7.X',
  config: defaultConfig,
  menu: async ({ getConfig, setConfig, window }) => {
    const config = await getConfig();
    return [
      {
        label: t('plugins.equalizer.editor.title'),
        enabled: config.enabled,
        click: () => window.webContents.send('equalizer:open'),
      },
      {
        label: t('plugins.equalizer.editor.bypass'),
        type: 'checkbox',
        checked: config.bypass,
        click: () => setConfig({ bypass: !config.bypass }),
      },
    ];
  },
  renderer: {
    openEditor,
    async start(context) {
      stopRuntime();
      const id = ++generation;
      const raw = await context.getConfig();
      if (generation !== id) return;
      const listener = ({ detail }: CustomEvent<Compressor>) => {
        const state = runtime;
        if (!state) return;
        const graph = graphFromAnnouncement(detail);
        if (state.graph !== graph) {
          state.controller?.stop();
          state.controller = null;
          state.graph = graph;
        }
        apply();
      };
      runtime = {
        raw,
        graph: getCurrentAudioGraph(),
        controller: null,
        panel: null,
        context,
        listener,
        pending: null,
        desired: null,
        writeEpoch: 0,
        audioError: false,
        saveError: false,
        writes: Promise.resolve(),
      };
      document.addEventListener('peard:audio-can-play', listener);
      context.ipc.on('equalizer:open', openEditor);
      apply();
    },
    onConfigChange(raw) {
      if (!runtime) return;
      const previous = runtime.raw;
      if (!normalizeConfig(raw).editable) {
        runtime.desired = null;
        runtime.pending = null;
        runtime.writeEpoch++;
        if (runtime.timer) clearTimeout(runtime.timer);
      }
      const acknowledged =
        runtime.desired &&
        Object.entries(runtime.desired).every(([key, value]) =>
          deepEqual(raw[key as keyof EqualizerPluginConfig], value),
        );
      if (acknowledged) {
        runtime.desired = null;
        runtime.saveError = false;
        runtime.panel?.reportError(
          runtime.audioError ? t('plugins.equalizer.editor.audio-error') : null,
        );
      }
      runtime.raw = { ...raw, ...runtime.desired };
      apply();
      if (
        !acknowledged &&
        !runtime.desired &&
        !deepEqual(previous, runtime.raw)
      )
        runtime.panel?.refresh();
    },
    stop: stopRuntime,
  },
});
