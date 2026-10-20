import { t } from '@/i18n';
import { createPlaybackPitchOwner } from '@/plugins/utils/renderer/playback-pitch-owner';
import {
  claimPlaybackRate,
  getUnforcedPlaybackRate,
  PLAYBACK_RATE_OWNER_CHANGED,
  getPlaybackRateOwner,
  isPlaybackRateControlledByOther,
  releasePlaybackRate,
} from '@/plugins/utils/renderer/playback-rate-owner';
import {
  registerPlayerPanelSection,
  unregisterPlayerPanelSection,
} from '@/plugins/utils/renderer/player-panel';
import { graphFromAnnouncement } from '@/providers/renderer-audio';

import { getLatestAudioDetail, type AudioCanPlayDetail } from './audio-graph';
import {
  clampIntensity,
  clampSlow,
  clampWetHighpass,
  clampWetLowpass,
  WET_HIGHPASS_DEFAULT,
  WET_LOWPASS_DEFAULT,
  computeDattorroParams,
  isReverbEngaged,
  isSlowEngaged,
  normalize,
} from './engine';
import {
  createSlowedReverbSection,
  type SlowedReverbSectionHandle,
} from './panel';
import { DATTORRO_WORKLET_SOURCE } from './worklet';

export interface SlowedReverbConfig {
  slow: number;
  reverbIntensity: number;
  wetHighpass?: number;
  wetLowpass?: number;
  active: boolean;
}

/**
 * Minimal host surface this controller needs from the merged player-actions
 * entry; the entry adapts its aggregate config slices onto it.
 */
interface FeatureContext<Slice> {
  getConfig: () => Slice | Promise<Slice>;
  setConfig: (patch: Partial<Slice>) => void | Promise<void>;
}

const PLUGIN_ID = 'slowed-reverb';
// Native registration survives node teardown; weak keys do not retain old graphs.
const registeredWorklets = new WeakSet<AudioContext>();

const DEFAULT_CONFIG: SlowedReverbConfig = {
  slow: 1,
  reverbIntensity: 0,
  wetHighpass: WET_HIGHPASS_DEFAULT,
  wetLowpass: WET_LOWPASS_DEFAULT,
  active: true,
};

function retireWorklet(node: AudioWorkletNode): void {
  try {
    node.port.postMessage({ type: 'dispose' });
  } catch {
    /* Already gone. */
  }
  try {
    node.disconnect();
  } catch {
    /* Already detached. */
  }
  try {
    node.port.close();
  } catch {
    /* Already closed. */
  }
}

export interface SlowedReverbController {
  generation: number;
  ctx: FeatureContext<SlowedReverbConfig> | null;
  config: SlowedReverbConfig | null;
  audioContext: AudioContext | null;
  audioSource: MediaElementAudioSourceNode | null;
  wetGain: GainNode | null;
  wetHighpass: BiquadFilterNode | null;
  wetLowpass: BiquadFilterNode | null;
  reverbNode: AudioWorkletNode | null;
  workletReadyFor: AudioContext | null;
  workletFailed: boolean;
  workletLoad: Promise<void> | null;
  workletLoadFor: AudioContext | null;
  workletEpoch: number;
  wiredSource: MediaElementAudioSourceNode | null;
  video: HTMLVideoElement | null;
  originalRate: number;
  pitchOwner: ReturnType<typeof createPlaybackPitchOwner>;
  watchdog: ReturnType<typeof setInterval> | null;
  section: SlowedReverbSectionHandle | null;
  audioHandler: ((event: Event) => void) | null;
  videoChangeHandler: (() => void) | null;
  rateHandler: ((event: Event) => void) | null;
  rateVideo: HTMLVideoElement | null;
  pitchOverridden: boolean;
  lastWetGain: number;
  start: (ctx: FeatureContext<SlowedReverbConfig>) => Promise<void>;
  stop: () => void;
  onPlayerApiReady: () => void;
  onConfigChange: (newConfig: SlowedReverbConfig) => void;
  getCurrent: () => SlowedReverbConfig;
  claimRateIfEngaged: () => void;
  ensureSection: () => void;
  syncSection: () => void;
  wireAudio: (
    audioContext: AudioContext,
    audioSource: MediaElementAudioSourceNode,
  ) => void;
  handleAudioEvent: (event: Event) => void;
  ensureWorklet: () => Promise<void>;
  applyReverb: () => void;
  applySlow: () => void;
  releasePitchOverride: (video: HTMLVideoElement) => void;
  attachRateListeners: () => void;
  detachRateListeners: () => void;
  /** Internal: keeps the watchdog interval in step with engagement. */
  syncWatchdog: () => void;
  /** Internal: keeps the wet audio tap in step with engagement. */
  syncWetTap: () => void;
  teardownAudio: () => void;
  restoreVideo: () => void;
}

export function createSlowedReverbController(): SlowedReverbController {
  return {
    generation: 0,
    ctx: null,
    config: null,
    audioContext: null,
    audioSource: null,
    wetGain: null,
    wetHighpass: null,
    wetLowpass: null,
    reverbNode: null,
    workletReadyFor: null,
    workletFailed: false,
    workletLoad: null,
    workletLoadFor: null,
    workletEpoch: 0,
    wiredSource: null,
    video: null,
    originalRate: 1,
    pitchOwner: createPlaybackPitchOwner(PLUGIN_ID),
    watchdog: null,
    section: null,
    audioHandler: null,
    videoChangeHandler: null,
    rateHandler: null,
    rateVideo: null,
    pitchOverridden: false,
    lastWetGain: 0,

    async start(ctx) {
      const generation = ++this.generation;
      this.ctx = ctx;
      const raw = await ctx.getConfig();
      if (generation !== this.generation || this.ctx !== ctx) return;
      const normalized = normalize(raw);
      this.config = {
        ...raw,
        ...normalized,
      };
      this.audioHandler = (event: Event) => {
        if (generation !== this.generation) return;
        this.handleAudioEvent(event);
      };
      this.videoChangeHandler = () => {
        if (generation !== this.generation) return;
        this.applySlow();
        this.syncWetTap();
      };
      document.addEventListener('videodatachange', this.videoChangeHandler);
      // Capture the unforced baseline before a mid-ad enable claims a new
      // user preference; the temporary override must not become our baseline.
      this.applySlow();
      this.claimRateIfEngaged();
      document.addEventListener('peard:audio-can-play', this.audioHandler, {
        passive: true,
      });
      // Re-wire cached graph when re-enabled mid-song (nodes were torn down).
      // On the first enable mid-song the announcement already fired while the
      // plugin was unloaded: fall back to the graph cached at module scope so
      // the wet path engages for the current song instead of the next one.
      // A worklet load failure is also retried on every (re)enable instead of
      // disabling reverb for the rest of the app session.
      this.workletFailed = false;
      // Lazy wet path: the GainNode and the worklet are only built while the
      // reverb is audible, not at the default intensity 0.
      this.syncWetTap();
      this.ensureSection();
      this.applySlow();
      this.attachRateListeners();
      this.syncWatchdog();
    },

    stop() {
      if (this.videoChangeHandler) {
        document.removeEventListener(
          'videodatachange',
          this.videoChangeHandler,
        );
        this.videoChangeHandler = null;
      }
      if (this.audioHandler) {
        document.removeEventListener('peard:audio-can-play', this.audioHandler);
        this.audioHandler = null;
      }
      unregisterPlayerPanelSection(PLUGIN_ID);
      this.generation += 1;
      // Cleared after the unregister, and directly rather than via
      // syncWatchdog(), for two reasons: the section's destroy flushes a
      // pending wheel debounce, whose onSlowCommit -> syncWatchdog() would
      // otherwise re-arm the interval this clears; and the config still reads
      // as engaged after teardown, which would restart it too.
      if (this.watchdog !== null) {
        clearInterval(this.watchdog);
        this.watchdog = null;
      }
      // The panel flush's applySlow() can re-attach: detach, then release.
      this.detachRateListeners();
      releasePlaybackRate(PLUGIN_ID, this.originalRate);
      this.section = null;
      this.teardownAudio();
      this.restoreVideo();
      this.audioContext = null;
      this.audioSource = null;
      this.workletReadyFor = null;
      this.ctx = null;
    },

    onPlayerApiReady() {
      if (!this.ctx) return;
      this.ensureSection();
      // applySlow() tail already attaches rate listeners; no extra call.
      this.applySlow();
    },

    onConfigChange(newConfig) {
      if (!this.ctx) return;
      const normalized = normalize(newConfig);
      const previous = this.config;
      this.config = {
        ...newConfig,
        ...normalized,
      };
      // An external speed/activation change is an explicit intent: take the
      // rate back (reverb-only changes must not steal it from playback-speed).
      if (
        !previous ||
        previous.active !== this.config.active ||
        clampSlow(previous.slow) !== normalized.slow
      ) {
        this.claimRateIfEngaged();
      }
      this.applySlow();
      this.syncWetTap();
      this.applyReverb();
      this.syncWatchdog();
      this.syncSection();
    },

    getCurrent() {
      return this.config ?? { ...DEFAULT_CONFIG };
    },

    claimRateIfEngaged() {
      const current = this.getCurrent();
      if (current.active && clampSlow(current.slow) !== 1) {
        claimPlaybackRate(PLUGIN_ID, clampSlow(current.slow));
      } else {
        releasePlaybackRate(PLUGIN_ID, this.originalRate);
      }
    },

    ensureSection() {
      if (!this.ctx) return;
      if (this.section) return;
      const current = this.getCurrent();
      const generation = this.generation;
      const handle = createSlowedReverbSection(
        {
          slow: clampSlow(current.slow),
          reverbIntensity: clampIntensity(current.reverbIntensity),
          wetHighpass: clampWetHighpass(current.wetHighpass),
          wetLowpass: clampWetLowpass(current.wetLowpass),
          active: current.active,
        },
        {
          onActiveChange: (active: boolean) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), active };
            this.ctx?.setConfig({ active });
            this.claimRateIfEngaged();
            this.applySlow();
            this.syncWatchdog();
            this.syncWetTap();
            this.applyReverb();
            this.syncSection();
          },
          onSlowLive: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), slow: value };
            this.claimRateIfEngaged();
            this.applySlow();
            this.syncWatchdog();
          },
          onSlowCommit: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), slow: value };
            this.ctx?.setConfig({ slow: value });
            this.claimRateIfEngaged();
            this.applySlow();
            this.syncWatchdog();
            this.syncSection();
          },
          onReverbLive: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), reverbIntensity: value };
            this.syncWetTap();
            this.applyReverb();
          },
          onReverbCommit: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), reverbIntensity: value };
            this.ctx?.setConfig({ reverbIntensity: value });
            this.syncWetTap();
            this.applyReverb();
            this.syncSection();
          },
          onWetHighpassLive: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), wetHighpass: value };
            this.applyReverb();
          },
          onWetHighpassCommit: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), wetHighpass: value };
            this.ctx?.setConfig({ wetHighpass: value });
            this.applyReverb();
            this.syncSection();
          },
          onWetLowpassLive: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), wetLowpass: value };
            this.applyReverb();
          },
          onWetLowpassCommit: (value: number) => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = { ...this.getCurrent(), wetLowpass: value };
            this.ctx?.setConfig({ wetLowpass: value });
            this.applyReverb();
            this.syncSection();
          },
          onReset: () => {
            if (generation !== this.generation || !this.ctx) return;
            this.config = {
              ...this.getCurrent(),
              slow: 1,
              reverbIntensity: 0,
              wetHighpass: WET_HIGHPASS_DEFAULT,
              wetLowpass: WET_LOWPASS_DEFAULT,
              active: true,
            };
            this.ctx?.setConfig({
              slow: 1,
              reverbIntensity: 0,
              wetHighpass: WET_HIGHPASS_DEFAULT,
              wetLowpass: WET_LOWPASS_DEFAULT,
              active: true,
            });
            this.claimRateIfEngaged();
            this.applySlow();
            this.syncWatchdog();
            this.syncWetTap();
            this.applyReverb();
            this.syncSection();
          },
        },
      );
      this.section = handle;
      registerPlayerPanelSection({
        id: PLUGIN_ID,
        title: t('plugins.slowed-reverb.panel.title'),
        root: handle.root,
        onDestroy: () => handle.destroy(),
      });
    },

    syncSection() {
      const handle = this.section;
      if (!handle) return;
      const current = this.getCurrent();
      handle.sync({
        slow: clampSlow(current.slow),
        reverbIntensity: clampIntensity(current.reverbIntensity),
        wetHighpass: clampWetHighpass(current.wetHighpass),
        wetLowpass: clampWetLowpass(current.wetLowpass),
        active: current.active,
      });
    },

    wireAudio(audioContext, audioSource) {
      if (!this.ctx) return;
      this.audioContext = audioContext;
      this.audioSource = audioSource;
      if (this.workletFailed) return;
      if (this.wiredSource === audioSource && this.wetGain) {
        this.applyReverb();
        return;
      }
      this.teardownAudio();
      try {
        this.wetGain = audioContext.createGain();
        this.wetHighpass = audioContext.createBiquadFilter();
        this.wetHighpass.type = 'highpass';
        this.wetHighpass.Q.value = Math.SQRT1_2;
        this.wetLowpass = audioContext.createBiquadFilter();
        this.wetLowpass.type = 'lowpass';
        this.wetLowpass.Q.value = Math.SQRT1_2;
        this.wetHighpass.connect(this.wetLowpass);
        this.wetLowpass.connect(this.wetGain);
        // Wet reverb joins the renderer master mix so EQ/output sink cover it.
        // Raw analyser taps and the compressor's dry insert remain untouched.
        this.wetGain.gain.value = 1;
        this.wetGain.connect(
          graphFromAnnouncement({ audioContext, audioSource }).masterInput,
        );
        this.wiredSource = audioSource;
      } catch (error) {
        console.error('[slowed-reverb] wiring failed', error);
        this.teardownAudio();
        return;
      }
      this.applyReverb();
      if (this.workletFailed) return;
      this.ensureWorklet();
    },

    /**
     * Keeps the wet audio tap in step with engagement: the GainNode and the
     * worklet are built only while the reverb has audio to produce, and are
     * torn down when it goes silent (intensity 0 or inactive) so the audio
     * thread stops running the worklet for silence. The cached graph is kept
     * (teardownAudio() does not drop it) so a rise from 0 rebuilds in place.
     */
    syncWetTap() {
      const announced = getLatestAudioDetail();
      const audioContext = this.audioContext ?? announced?.audioContext;
      const audioSource = this.audioSource ?? announced?.audioSource;
      const currentVideo = document.querySelector<HTMLVideoElement>('video');
      const currentGraph =
        audioSource?.mediaElement === currentVideo &&
        audioContext?.state !== 'closed';
      if (
        isReverbEngaged(this.getCurrent()) &&
        audioContext &&
        audioSource &&
        currentGraph
      ) {
        this.wireAudio(audioContext, audioSource);
        return;
      }
      // The retry belongs to the next engagement, not just to a plugin
      // restart: leaving a failed addModule() latched here would keep
      // wireAudio() bailing out for the rest of the session.
      this.workletFailed = false;
      this.teardownAudio();
      if (!currentGraph) {
        this.audioContext = null;
        this.audioSource = null;
        this.workletReadyFor = null;
      }
    },

    handleAudioEvent(event: Event) {
      if (!this.ctx) return;
      const detail = (event as CustomEvent<AudioCanPlayDetail>).detail;
      if (!detail?.audioContext || !detail?.audioSource) return;
      // Record the announced graph even while the reverb is silent: the lazy
      // tap wires it as soon as the intensity rises above 0.
      if (this.audioContext !== detail.audioContext) this.workletFailed = false;
      this.audioContext = detail.audioContext;
      this.audioSource = detail.audioSource;
      this.syncWetTap();
    },

    async ensureWorklet() {
      const audioContext = this.audioContext;
      const audioSource = this.audioSource;
      if (
        !audioContext ||
        !audioSource ||
        this.reverbNode ||
        this.workletFailed
      ) {
        return;
      }
      const epoch = this.workletEpoch;
      try {
        if (!registeredWorklets.has(audioContext)) {
          // Share the in-flight module load so a re-wire mid-load awaits
          // the same promise instead of dropping reverb until next song.
          let load =
            this.workletLoadFor === audioContext ? this.workletLoad : null;
          if (!load) {
            const blob = new Blob([DATTORRO_WORKLET_SOURCE], {
              type: 'application/javascript',
            });
            const url = URL.createObjectURL(blob);
            load = (async () => {
              try {
                await audioContext.audioWorklet.addModule(url);
              } finally {
                URL.revokeObjectURL(url);
              }
            })();
            this.workletLoad = load;
            this.workletLoadFor = audioContext;
          }
          try {
            await load;
            registeredWorklets.add(audioContext);
          } finally {
            if (this.workletLoad === load) {
              this.workletLoad = null;
              this.workletLoadFor = null;
            }
          }
          // Bail if stop()/teardownAudio() ran mid-flight: never connect
          // post-teardown.
          if (epoch !== this.workletEpoch) return;
          if (
            this.audioContext !== audioContext ||
            this.audioSource !== audioSource ||
            this.wetGain === null ||
            this.wiredSource !== audioSource
          ) {
            return;
          }
          this.workletReadyFor = audioContext;
        } else if (
          epoch !== this.workletEpoch ||
          this.audioContext !== audioContext ||
          this.audioSource !== audioSource ||
          this.wetGain === null ||
          this.wiredSource !== audioSource
        ) {
          // Drop stale loads: a newer graph was wired, or teardown ran,
          // while awaiting (or while skipping) the module load.
          return;
        }
        // A concurrent caller for this generation may have created the node
        // while we awaited the shared load: single node per generation.
        if (this.reverbNode) return;
        const node = new AudioWorkletNode(audioContext, 'dattorro-reverb', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        // Re-check after node creation, before any connect.
        if (
          epoch !== this.workletEpoch ||
          this.audioContext !== audioContext ||
          this.audioSource !== audioSource ||
          this.wetGain === null ||
          this.wiredSource !== audioSource ||
          this.reverbNode
        ) {
          retireWorklet(node);
          return;
        }
        // Own the local node before either connect can throw, so rollback
        // can remove a partially attached source edge as well as its port.
        this.reverbNode = node;
        audioSource.connect(node);
        node.connect(this.wetHighpass!);
        this.applyReverb();
      } catch (error) {
        // Slow-only fallback: rate/pitch keeps working without reverb.
        console.error(
          '[slowed-reverb] worklet load failed, slow-only fallback',
          error,
        );
        // Only poison the generation that actually failed: a teardown or
        // re-wire while the load was in flight means this graph is gone, and
        // a stale flag would disable reverb for the rest of the session.
        if (epoch === this.workletEpoch) {
          this.workletFailed = true;
          this.teardownAudio();
        }
      }
    },

    applyReverb() {
      const current = this.getCurrent();
      const intensity = current.active
        ? clampIntensity(current.reverbIntensity)
        : 0;
      const params = computeDattorroParams(intensity);
      if (this.wetHighpass)
        this.wetHighpass.frequency.value = clampWetHighpass(
          current.wetHighpass,
        );
      if (this.wetLowpass) {
        // Stay below Nyquist on low-rate contexts; normal renderer contexts retain the full control range.
        this.wetLowpass.frequency.value = Math.min(
          clampWetLowpass(current.wetLowpass),
          this.wetLowpass.context.sampleRate / 2,
        );
      }
      // No dry tap: the base path carries dry at unity. The wet tail is
      // silent at intensity 0 (params.wetGain 0 inside the worklet), so
      // enabling at defaults changes no loudness. Worklet failure just
      // skips the wet path and slow keeps working.
      if (this.wetGain) {
        this.wetGain.gain.value = 1;
      }
      const prevWet = this.lastWetGain;
      this.lastWetGain = params.wetGain;
      try {
        if (prevWet === 0 && params.wetGain > 0) {
          this.reverbNode?.port.postMessage({ type: 'reset' });
        }
        this.reverbNode?.port.postMessage({ type: 'setParams', params });
      } catch {}
    },

    applySlow() {
      if (!this.ctx) return;
      const current = this.getCurrent();
      const slow = current.active ? clampSlow(current.slow) : 1;
      const video = document.querySelector<HTMLVideoElement>('video');
      if (!video) return;
      if (slow !== 1) {
        // Engaged but unowned: take the rate. Taking it back from another
        // plugin is reserved for explicit user actions (panel callbacks), so
        // a reverb-only change cannot steal playback-speed's rate.
        if (getPlaybackRateOwner(video) === null) {
          claimPlaybackRate(PLUGIN_ID, slow);
        }
      } else {
        releasePlaybackRate(PLUGIN_ID, this.originalRate);
      }
      if (this.video !== video) {
        this.restoreVideo();
        this.video = video;
        this.originalRate = getUnforcedPlaybackRate(
          video,
          Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
        );
        // pitchOverridden described the previous element; a replacement
        // element carries its own default pitch flags.
        this.pitchOverridden = false;
      }
      if (isPlaybackRateControlledByOther(PLUGIN_ID, video)) {
        // Another plugin owns the rate: yield instead of fighting, but undo
        // our pitch lease so the current owner's preference can apply.
        this.releasePitchOverride(video);
        this.attachRateListeners();
        return;
      }
      const target = slow !== 1 ? slow : this.originalRate;
      // No-op writes fire no ratechange: never write when already at target.
      if (Math.abs(video.playbackRate - target) <= 0.001) {
        // Same-rate playback still needs the current owner's pitch preference.
        if (slow !== 1) {
          try {
            if (!this.pitchOverridden) {
              this.pitchOwner.set(video, false);
              this.pitchOverridden = true;
            }
          } catch {}
        } else {
          this.releasePitchOverride(video);
        }
        // Track <video> replacement (YouTube swaps the element on song
        // change): idempotent, moves listeners when the element changes.
        this.attachRateListeners();
        return;
      }
      try {
        if (slow !== 1) {
          this.pitchOwner.set(video, false);
          this.pitchOverridden = true;
          video.playbackRate = slow;
        } else {
          this.releasePitchOverride(video);
          video.playbackRate = this.originalRate;
        }
      } catch {}
      // Track <video> replacement (YouTube swaps the element on song
      // change): idempotent, moves listeners when the element changes.
      this.attachRateListeners();
    },

    releasePitchOverride(video) {
      if (!this.pitchOverridden) return;
      // Only restore flags we set on this element; after a <video> swap the
      // new element carries its own defaults.
      if (video === this.video) this.pitchOwner.release();
      this.pitchOverridden = false;
    },

    attachRateListeners() {
      // Re-query every time: the <video> element may have been replaced.
      const video = document.querySelector<HTMLVideoElement>('video');
      if (!video) return;
      if (this.rateVideo === video) return;
      this.detachRateListeners();
      if (!this.rateHandler) {
        // YouTube resets playbackRate to 1x on every song change;
        // re-apply immediately instead of waiting for the watchdog tick.
        // Mirrors src/plugins/playback-speed/renderer.tsx convention.
        // Guarded: no-op while inactive, nothing to do at slow 1x, and
        // drift-checked so an already-correct rate never re-writes (a
        // write that changes nothing fires no ratechange). While another
        // plugin owns the rate we never touch playbackRate (answering it
        // would queue a ratechange per write for both plugins, forever),
        // but we still release our pitch override so the other plugin's
        // speed is not left with pitch-shifted timbre.
        this.rateHandler = (event: Event) => {
          const current = this.getCurrent();
          if (!current.active) return;
          const slow = clampSlow(current.slow);
          if (slow === 1) return;
          const video =
            event.target instanceof HTMLVideoElement
              ? event.target
              : document.querySelector<HTMLVideoElement>('video');
          if (!video) return;
          if (isPlaybackRateControlledByOther(PLUGIN_ID, video)) {
            // Ownership moved to playback-speed: its write emitted this
            // ratechange, so drop our pitch override or its speed keeps our
            // pitch-shifted timbre.
            this.releasePitchOverride(video);
            return;
          }
          if (Math.abs(video.playbackRate - slow) <= 0.001) return;
          if (
            event.type === 'peard:src-changed' ||
            event.type === PLAYBACK_RATE_OWNER_CHANGED ||
            Math.abs(video.playbackRate - 1) <= 0.001
          ) {
            this.applySlow();
          }
        };
      }
      video.addEventListener(PLAYBACK_RATE_OWNER_CHANGED, this.rateHandler);
      video.addEventListener('ratechange', this.rateHandler);
      video.addEventListener('peard:src-changed', this.rateHandler);
      this.rateVideo = video;
    },

    detachRateListeners() {
      if (this.rateVideo && this.rateHandler) {
        this.rateVideo.removeEventListener(
          PLAYBACK_RATE_OWNER_CHANGED,
          this.rateHandler,
        );
        this.rateVideo.removeEventListener('ratechange', this.rateHandler);
        this.rateVideo.removeEventListener(
          'peard:src-changed',
          this.rateHandler,
        );
      }
      this.rateVideo = null;
    },

    /**
     * Keeps the 2 s rate watchdog in step with engagement: the interval only
     * exists while the slow feature has work to do (active and not at 1x).
     * stop() clears the interval directly because the config still reads as
     * engaged after teardown, which would restart it here.
     */
    syncWatchdog() {
      if (!isSlowEngaged(this.getCurrent())) {
        if (this.watchdog !== null) {
          clearInterval(this.watchdog);
          this.watchdog = null;
        }
        return;
      }
      if (this.watchdog !== null) return;
      this.watchdog = setInterval(() => {
        // Re-track <video> replacement even when no rate drift is seen.
        this.attachRateListeners();
        const current = this.getCurrent();
        if (!current.active) return;
        const slow = clampSlow(current.slow);
        if (slow === 1) return;
        const video = document.querySelector<HTMLVideoElement>('video');
        if (isPlaybackRateControlledByOther(PLUGIN_ID, video ?? undefined)) {
          if (video) this.releasePitchOverride(video);
          return;
        }
        if (video && Math.abs(video.playbackRate - slow) > 0.001) {
          this.applySlow();
        }
      }, 2000);
    },

    teardownAudio() {
      // Invalidate any in-flight ensureWorklet() so it never connects
      // post-teardown.
      this.workletEpoch += 1;
      // Never touch the renderer dry route; only detach our own wet tap.
      const source = this.wiredSource ?? this.audioSource;
      try {
        if (source && this.reverbNode) source.disconnect(this.reverbNode);
      } catch {}
      if (this.reverbNode) retireWorklet(this.reverbNode);
      try {
        this.wetGain?.disconnect();
      } catch {}
      try {
        this.wetHighpass?.disconnect();
      } catch {}
      try {
        this.wetLowpass?.disconnect();
      } catch {}
      this.wetHighpass = null;
      this.wetLowpass = null;
      this.wetGain = null;
      this.reverbNode = null;
      this.wiredSource = null;
    },

    restoreVideo() {
      const video = this.video;
      if (!video) {
        this.video = null;
        return;
      }
      try {
        this.pitchOwner.release();
        // Don't stomp a rate another plugin took over while we were loaded
        // (only relevant when we never held the rate in the first place).
        if (!isPlaybackRateControlledByOther(PLUGIN_ID, video)) {
          video.playbackRate = this.originalRate;
        }
      } catch {}
      this.pitchOverridden = false;
      this.video = null;
    },
  };
}
