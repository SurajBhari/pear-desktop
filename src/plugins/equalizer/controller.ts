import type { EqualizerBand, EqualizerProfile } from './config';
import type { RendererAudioGraph } from '@/providers/renderer-audio';

type Chain = {
  preamp: GainNode;
  filters: BiquadFilterNode[];
  bands: EqualizerBand[];
  level: GainNode;
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
  private safetyFilters: BiquadFilterNode[] = [];
  private stopped = false;

  constructor(private graph: RendererAudioGraph) {
    this.input = graph.audioContext.createGain();
    this.output = graph.audioContext.createGain();
  }

  apply(profile: EqualizerProfile, bypass: boolean) {
    if (this.stopped) return;
    const context = this.graph.audioContext;
    const bands = bypass
      ? []
      : profile.bands.filter((b) => b.frequency < context.sampleRate / 2);
    const preamp = bypass ? 1 : 10 ** (profile.preamp / 20);
    const smoothAllowed = this.validateResponse(
      bands,
      bypass ? 0 : profile.preamp,
    );
    const current = this.current;
    const now = context.currentTime;
    if (
      current &&
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
      return;
    }
    const chain: Chain = {
      preamp: context.createGain(),
      filters: [],
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
        const envelope = old.envelope;
        const elapsed = now - envelope.start;
        const duration = envelope.end - envelope.start;
        const progress =
          duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;
        const change = (envelope.to - envelope.from) * progress;
        const level = envelope.from + change;
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
    const context = this.graph.audioContext;
    const nyquist = context.sampleRate / 2;
    const upper = nyquist - 0.01;
    const frequencies = new Float32Array([
      ...Array.from(
        { length: 256 },
        (_, i) => 20 * Math.pow(upper / 20, i / 255),
      ),
      ...bands.map((b) => b.frequency),
    ]);
    const response = new Float64Array(frequencies.length).fill(preamp);
    const magnitude = new Float32Array(frequencies.length);
    const phase = new Float32Array(frequencies.length);
    bands.forEach((band, i) => {
      const probe = this.safetyFilters[i] ?? context.createBiquadFilter();
      this.safetyFilters[i] = probe;
      probe.type = band.type;
      probe.frequency.value = band.frequency;
      probe.Q.value = band.Q;
      probe.gain.value = band.gain;
      probe.getFrequencyResponse(frequencies, magnitude, phase);
      for (let j = 0; j < magnitude.length; j++) {
        if (!Number.isFinite(magnitude[j]))
          throw new Error('Equalizer response is not finite');
        response[j] += 20 * Math.log10(magnitude[j]);
        if (response[j] > limit)
          throw new Error('Overlapping gain exceeds the DSP response range');
      }
    });
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
    this.safetyFilters.forEach((filter) => filter.disconnect());
    this.safetyFilters = [];
  }
}
