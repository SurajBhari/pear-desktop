import { MAX_BANDS, type EqualizerBand, type EqualizerProfile } from './config';
import { EqualizerResponseSampler, type EqualizerResponse } from './response';

import type { RendererAudioGraph } from '@/providers/renderer-audio';

export type { EqualizerResponse } from './response';

type Chain = {
  preamp: GainNode;
  filters: BiquadFilterNode[];
  bands: EqualizerBand[];
  level: GainNode;
  key: string;
  autoPreamp: boolean;
  envelope: { from: number; to: number; start: number; end: number };
  retire?: ReturnType<typeof setTimeout>;
};

/** Owns a serial master insert; the renderer owns dry/wet/source routes. */
export class EqualizerController {
  private input: GainNode;
  private output: GainNode;
  private release: (() => void) | null = null;
  private chains = new Set<Chain>();
  private current: Chain | null = null;
  private sampler: EqualizerResponseSampler | null = null;
  private response: EqualizerResponse | null = null;
  private target: {
    bands: EqualizerBand[];
    preamp: number;
    autoPreamp: boolean;
    bypass: boolean;
  } | null = null;
  private pending: {
    profile: EqualizerProfile;
    bypass: boolean;
    autoPreamp: boolean;
  } | null = null;
  private requestKey: string | null = null;
  private stopped = false;

  constructor(private graph: RendererAudioGraph) {
    this.input = graph.audioContext.createGain();
    this.output = graph.audioContext.createGain();
  }

  apply(profile: EqualizerProfile, bypass: boolean, autoPreamp = false) {
    if (this.stopped) return;
    const context = this.graph.audioContext;
    if (
      !Number.isFinite(profile.preamp) ||
      profile.preamp < -24 ||
      profile.preamp > 12 ||
      !Array.isArray(profile.bands) ||
      profile.bands.length > MAX_BANDS ||
      profile.bands.some(
        (band) =>
          !Number.isFinite(band.frequency) ||
          band.frequency < 0 ||
          band.frequency > 20000 ||
          !Number.isFinite(band.gain) ||
          Math.abs(band.gain) > 48 ||
          !Number.isFinite(band.Q) ||
          band.Q <= 0 ||
          band.Q > 1000 ||
          ![
            'peaking',
            'lowshelf',
            'highshelf',
            'lowpass',
            'highpass',
            'bandpass',
            'notch',
            'allpass',
          ].includes(band.type),
      )
    )
      throw new Error('Invalid equalizer response input');
    const bands = bypass
      ? []
      : profile.bands.filter((b) => b.frequency < context.sampleRate / 2);
    const requestKey = JSON.stringify([
      bands,
      profile.preamp,
      bypass,
      autoPreamp,
    ]);
    if (this.requestKey === requestKey) return;
    const enabledAuto = autoPreamp && !bypass;
    // Validate the original manual profile before deriving attenuation. Auto must not
    // expand the supported DSP range or hide a massive gain behind underflow.
    const smoothAllowed = this.validateResponse(
      bands,
      bypass ? 0 : profile.preamp,
    );
    const sampled = enabledAuto ? this.sample(bands, profile.preamp) : null;
    // A sampled response is not a continuum peak limiter. The small margin covers
    // native Float32 response rounding and residual error between refined samples.
    const peak = sampled?.peakGainDb ?? 0;
    const effectivePreamp = bypass
      ? 0
      : enabledAuto
        ? peak > 0.0001
          ? -peak - 0.1
          : 0
        : profile.preamp;
    const preamp = 10 ** (effectivePreamp / 20);
    const key = JSON.stringify([bands, effectivePreamp, enabledAuto]);
    const commitTarget = () => {
      this.requestKey = requestKey;
      this.target = {
        bands: structuredClone(bands),
        preamp: effectivePreamp,
        autoPreamp,
        bypass,
      };
      this.response = sampled
        ? this.responseSnapshot(sampled, effectivePreamp, autoPreamp)
        : null;
    };
    const current = this.current;
    const now = context.currentTime;
    if (current?.key === key) {
      this.pending = null;
      commitTarget();
      return;
    }
    if (
      current &&
      !enabledAuto &&
      !current.autoPreamp &&
      smoothAllowed &&
      current.bands.length === bands.length &&
      current.bands.every(
        (b, i) => b.id === bands[i].id && b.type === bands[i].type,
      )
    ) {
      const smooth = (parameter: AudioParam, value: number) => {
        parameter.cancelAndHoldAtTime(now);
        parameter.setTargetAtTime(value, now, 0.01);
      };
      smooth(current.preamp.gain, preamp);
      current.filters.forEach((filter, i) => {
        smooth(filter.frequency, bands[i].frequency);
        smooth(filter.gain, bands[i].gain);
        smooth(filter.Q, bands[i].Q);
      });
      current.bands = structuredClone(bands);
      current.key = key;
      this.pending = null;
      commitTarget();
      return;
    }
    // Same-time edits often replace an inaudible incoming chain. Prune those first.
    for (const old of this.chains)
      if (this.levelAt(old, now) === 0) {
        this.chains.delete(old);
        this.destroy(old);
      }
    // A busy or suspended context must not accumulate an unbounded number of
    // correlated fading chains. The existing retirement owner drains the latest edit.
    if (this.chains.size >= 4) {
      this.pending = { profile: structuredClone(profile), bypass, autoPreamp };
      commitTarget();
      return;
    }
    const chain: Chain = {
      preamp: context.createGain(),
      filters: [],
      key,
      autoPreamp: enabledAuto,
      bands: structuredClone(bands),
      level: context.createGain(),
      envelope: { from: current ? 0 : 1, to: 1, start: now, end: now },
    };
    chain.preamp.gain.value = preamp;
    chain.level.gain.value = current ? 0 : 1;
    try {
      let previous: AudioNode = chain.preamp;
      for (const band of bands) {
        const filter = context.createBiquadFilter();
        chain.filters.push(filter);
        filter.type = band.type;
        filter.frequency.value = band.frequency;
        filter.gain.value = band.gain;
        filter.Q.value = band.Q;
        previous.connect(filter);
        previous = filter;
      }
      previous.connect(chain.level);
      chain.level.connect(this.output);
      this.input.connect(chain.preamp);
      if (!this.release)
        this.release = this.graph.insertMaster(this.input, this.output);
    } catch (error) {
      this.destroy(chain);
      throw error;
    }
    if (current) {
      const end = now + 0.02;
      for (const old of this.chains) {
        if (old.retire) clearTimeout(old.retire);
        const level = this.levelAt(old, now);
        if (level === 0) {
          this.chains.delete(old);
          this.destroy(old);
          continue;
        }
        old.level.gain.cancelAndHoldAtTime(now);
        // A ramp without an explicit anchor can start at time zero in native Web Audio.
        // Own the linear timeline so interruptions never depend on AudioParam.value.
        old.level.gain.setValueAtTime(level, now);
        old.level.gain.linearRampToValueAtTime(0, end);
        old.envelope = { from: level, to: 0, start: now, end };
        // AudioContext time can pause. Never retire a chain before its audible ramp ends.
        const retire = () => {
          if (this.stopped || !this.chains.has(old)) return;
          if (context.currentTime < end && context.state !== 'closed')
            old.retire = setTimeout(retire, 30);
          else {
            this.chains.delete(old);
            this.destroy(old);
            const pending = this.pending;
            if (context.state === 'closed') this.pending = null;
            else if (pending && this.chains.size < 4) {
              this.pending = null;
              this.requestKey = null;
              this.apply(pending.profile, pending.bypass, pending.autoPreamp);
            }
          }
        };
        old.retire = setTimeout(retire, 30);
      }
      chain.level.gain.setValueAtTime(0, now);
      // Same correlated input: equal-power would add +3dB at the midpoint.
      chain.level.gain.linearRampToValueAtTime(1, end);
      chain.envelope = { from: 0, to: 1, start: now, end };
    }
    this.chains.add(chain);
    this.current = chain;
    this.pending = null;
    commitTarget();
  }

  getResponse(): EqualizerResponse | null {
    if (this.stopped || !this.target) return null;
    if (!this.response) {
      const target = this.target;
      this.response = this.responseSnapshot(
        this.sample(target.bands, target.bypass ? 0 : target.preamp),
        target.preamp,
        target.autoPreamp,
      );
    }
    return this.response;
  }

  private sample(bands: EqualizerBand[], preamp: number) {
    this.sampler ??= new EqualizerResponseSampler(this.graph.audioContext);
    return this.sampler.sample(bands, preamp);
  }

  private responseSnapshot(
    sampled: ReturnType<EqualizerResponseSampler['sample']>,
    preamp: number,
    autoPreamp: boolean,
  ): EqualizerResponse {
    return Object.freeze({
      sampleRate: this.graph.audioContext.sampleRate,
      autoPreamp,
      peakGainDb: sampled.peakGainDb,
      effectivePreampDb: preamp,
      frequencies: Object.freeze(sampled.frequencies),
      gainsDb: Object.freeze(
        sampled.gainsDb.map((gain) => Math.max(-300, gain + preamp)),
      ),
    });
  }

  private levelAt(chain: Chain, now: number) {
    const { from, to, start, end } = chain.envelope;
    const progress =
      end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
    const change = (to - from) * progress;
    return from + change;
  }

  private validateResponse(bands: EqualizerBand[], preamp: number) {
    // Ordinary parametric/shelf edits have a simple response bound and allocate no probes.
    // 240 dB leaves over 500 dB below Float32 overflow; this is not a clipping limiter.
    const limit = 240;
    const sum = bands.reduce(
      (total, band) => total + Math.max(0, band.gain),
      preamp,
    );
    if (
      sum <= limit &&
      bands.every(
        (b) =>
          b.type === 'peaking' ||
          b.type === 'lowshelf' ||
          b.type === 'highshelf',
      )
    )
      return true;
    this.sample(bands, preamp);
    // Large aggregate gains use a linear chain handover instead of coefficient morphing.
    return false;
  }

  private destroy(chain: Chain) {
    if (chain.retire) clearTimeout(chain.retire);
    try {
      this.input.disconnect(chain.preamp);
    } catch {
      /* failed/unconnected owned chain */
    }
    chain.preamp.disconnect();
    chain.filters.forEach((filter) => filter.disconnect());
    chain.level.disconnect();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.release?.();
    this.release = null;
    for (const chain of this.chains) this.destroy(chain);
    this.chains.clear();
    this.input.disconnect();
    this.output.disconnect();
    this.current = null;
    this.sampler?.stop();
    this.sampler = null;
    this.response = null;
    this.target = null;
    this.pending = null;
    this.requestKey = null;
  }
}
