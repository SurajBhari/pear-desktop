import { MAX_BANDS, type EqualizerBand } from './config';

export type EqualizerResponse = {
  sampleRate: number;
  autoPreamp: boolean;
  peakGainDb: number;
  effectivePreampDb: number;
  frequencies: readonly number[];
  gainsDb: readonly number[];
};

type FilterResponse = {
  frequencies: number[];
  gainsDb: number[];
  peakGainDb: number;
};

const MAX_POINTS = 4096;
const GRAPH_FLOOR_DB = -300;
const DSP_LIMIT_DB = 240;

/** Native responses avoid a second implementation of the browser's biquad coefficients. */
export class EqualizerResponseSampler {
  private probes: BiquadFilterNode[] = [];
  private frequencies = new Float32Array(MAX_POINTS);
  private magnitude = new Float32Array(MAX_POINTS);
  private phase = new Float32Array(MAX_POINTS);
  private sum = new Float64Array(MAX_POINTS);

  constructor(private context: BaseAudioContext) {}

  sample(
    bands: readonly EqualizerBand[],
    manualPreamp: number,
  ): FilterResponse {
    const nyquist = this.context.sampleRate / 2;
    if (
      !Number.isFinite(nyquist) ||
      nyquist <= 0 ||
      !Number.isFinite(manualPreamp) ||
      bands.length > MAX_BANDS
    )
      throw new Error('Invalid equalizer response input');
    const points = new Set<number>([0, Math.fround(nyquist)]);
    const add = (frequency: number) => {
      if (points.size < MAX_POINTS && Number.isFinite(frequency))
        points.add(Math.fround(Math.max(0, Math.min(nyquist, frequency))));
    };
    // Both scales cover shelf/pass transitions and peaks outside the audible graph range.
    const lower = Math.min(1, nyquist / 1000);
    for (let i = 0; i < 384; i++) {
      const scale = (nyquist / lower) ** (i / 383);
      add(lower * scale);
    }
    for (let i = 1; i < 128; i++) add((nyquist * i) / 128);
    for (const [i, band] of bands.entries()) {
      if (
        !Number.isFinite(band.frequency) ||
        band.frequency < 0 ||
        band.frequency >= nyquist ||
        !Number.isFinite(band.Q) ||
        band.Q <= 0 ||
        !Number.isFinite(band.gain)
      )
        throw new Error('Invalid equalizer response band');
      const probe = this.probes[i] ?? this.context.createBiquadFilter();
      this.probes[i] = probe;
      probe.type = band.type;
      probe.frequency.value = band.frequency;
      probe.Q.value = band.Q;
      probe.gain.value = band.gain;
      add(band.frequency);
      // Narrow centers need local samples even when two peaks share one coarse interval.
      const width = Math.min(band.frequency, nyquist - band.frequency) / band.Q;
      for (const offset of [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8]) {
        const distance = width * offset;
        add(band.frequency - distance);
        add(band.frequency + distance);
      }
    }
    let frequencies: number[] = [];
    let gainsDb: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      frequencies = [...points].sort((a, b) => a - b);
      const count = frequencies.length;
      this.frequencies.fill(frequencies[count - 1]);
      this.frequencies.set(frequencies);
      this.sum.fill(0);
      for (let i = 0; i < bands.length; i++) {
        this.probes[i].getFrequencyResponse(
          this.frequencies,
          this.magnitude,
          this.phase,
        );
        for (let j = 0; j < count; j++) {
          const magnitude = this.magnitude[j];
          if (!Number.isFinite(magnitude) || magnitude < 0)
            throw new Error('Equalizer response is not finite');
          // Native exact zeros at DC/Nyquist are valid, and remain zero in a serial chain.
          this.sum[j] += 20 * Math.log10(magnitude);
          if (this.sum[j] + manualPreamp > DSP_LIMIT_DB)
            throw new Error('Overlapping gain exceeds the DSP response range');
        }
      }
      gainsDb = Array.from(this.sum.subarray(0, count));
      if (pass === 2 || points.size === MAX_POINTS) break;
      const peaks = gainsDb
        .map((gain, index) => ({ gain, index }))
        .filter(
          ({ gain, index }) =>
            index > 0 &&
            index < count - 1 &&
            gain >= gainsDb[index - 1] &&
            gain >= gainsDb[index + 1] &&
            (gain > gainsDb[index - 1] || gain > gainsDb[index + 1]),
        )
        .sort((a, b) => b.gain - a.gain)
        .slice(0, MAX_BANDS);
      const before = points.size;
      for (const { index } of peaks) {
        const left = frequencies[index - 1];
        const right = frequencies[index + 1];
        for (let step = 1; step < 16; step++) {
          const distance = ((right - left) * step) / 16;
          add(left + distance);
        }
      }
      if (points.size === before) break;
    }
    return {
      frequencies,
      // Keep native zeros internally until the effective preamp has been applied.
      // Only the controller's public snapshot substitutes a finite graph floor.
      gainsDb,
      peakGainDb: Math.max(GRAPH_FLOOR_DB, ...gainsDb),
    };
  }

  stop() {
    this.probes.forEach((probe) => probe.disconnect());
    this.probes = [];
    this.frequencies = new Float32Array(0);
    this.magnitude = new Float32Array(0);
    this.phase = new Float32Array(0);
    this.sum = new Float64Array(0);
  }
}
