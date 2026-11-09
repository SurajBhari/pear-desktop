/** Sample peaks only; this is not a DAC/oversampling true-peak limiter. */
export const OUTPUT_PEAK_CEILING = Math.fround(0.99);

export function outputPeakDelayFrames(sampleRate: number): number {
  return 3 * Math.max(8, 2 ** Math.round(Math.log2(sampleRate / 750)));
}

export const OUTPUT_PEAK_PROCESSOR = 'renderer-output-peak';

export const OUTPUT_PEAK_WORKLET_SOURCE = `
class OutputPeak extends AudioWorkletProcessor {
  constructor() {
    super();
    this.disposed = false;
    this.chunk = Math.max(8, 2 ** Math.round(Math.log2(sampleRate / 750)));
    this.lookahead = 2;
    this.slots = this.lookahead + 1;
    this.ceiling = Math.fround(.99);
    this.hold = Math.ceil(.024 * sampleRate / this.chunk);
    this.release = Math.exp(-this.chunk / (sampleRate * .08));
    this.audio = Array.from({length:this.slots}, () => [new Float32Array(this.chunk), new Float32Array(this.chunk)]);
    this.limits = new Float64Array(this.slots);
    this.output = [new Float32Array(this.chunk), new Float32Array(this.chunk)];
    this.queueSize = this.hold + 2;
    this.peakIds = new Float64Array(this.queueSize);
    this.peaks = new Float32Array(this.queueSize);
    this.frames = 0;
    this.flushToken = null;
    this.reset();
    this.port.onmessage = event => {
      const data = event.data;
      if (data?.type === 'dispose') this.disposed = true;
      else if (!this.disposed && data?.type === 'flush' && Number.isFinite(data.token)) {
        this.reset();
        this.flushToken = data.token;
      }
    };
  }

  reset() {
    for (const pair of this.audio) for (const channel of pair) channel.fill(0);
    for (const channel of this.output) channel.fill(0);
    this.limits.fill(1);
    this.block = 0;
    this.position = 0;
    this.outputPosition = this.chunk;
    this.peak = 0;
    this.queueHead = 0;
    this.queueCount = 0;
    this.gain = 1;
    this.first = true;
    this.sinceReset = 0;
  }

  finishChunk() {
    const size = this.queueSize;
    while (this.queueCount && this.peaks[(this.queueHead + this.queueCount - 1) % size] <= this.peak) this.queueCount--;
    const tail = (this.queueHead + this.queueCount) % size;
    this.peakIds[tail] = this.block;
    this.peaks[tail] = this.peak;
    this.queueCount++;
    while (this.peakIds[this.queueHead] < this.block - this.hold) {
      this.queueHead = (this.queueHead + 1) % size;
      this.queueCount--;
    }
    const heldPeak = this.peaks[this.queueHead];
    this.limits[this.block % this.slots] = heldPeak <= this.ceiling ? 1 : this.ceiling / heldPeak;
    if (this.block >= this.lookahead) {
      const current = this.block - this.lookahead;
      const limit = this.limits[current % this.slots];
      const start = Math.min(this.first ? 1 : this.gain, limit);
      this.first = false;
      let end = Math.min(limit, 1 - (1 - start) * this.release);
      for (let ahead = 1; ahead <= this.lookahead; ahead++) {
        const future = this.limits[(current + ahead) % this.slots];
        end = Math.min(end, start + (future - start) / ahead);
        if (ahead === 1) end = Math.min(end, future);
      }
      // Both endpoints obey the current block limit; the end also obeys the
      // next block limit. Induction bounds every interpolated output sample.
      const audio = this.audio[current % this.slots];
      for (let i = 0; i < this.chunk; i++) {
        const gain = start + (end - start) * (i + 1) / this.chunk;
        // Numerical guard only: the gain invariant already bounds finite PCM.
        this.output[0][i] = Math.max(-this.ceiling, Math.min(this.ceiling, audio[0][i] * gain));
        this.output[1][i] = Math.max(-this.ceiling, Math.min(this.ceiling, audio[1][i] * gain));
      }
      this.gain = end;
      this.outputPosition = 0;
    }
    this.block++;
    this.position = 0;
    this.peak = 0;
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0];
    const out = outputs[0];
    if (!out?.length) return true;
    const left = input?.[0];
    const right = input?.[1] ?? left;
    const baseFrame = typeof currentFrame === 'number' ? currentFrame : this.frames;
    for (let i = 0; i < out[0].length; i++) {
      const ready = this.outputPosition < this.chunk;
      out[0][i] = ready ? this.output[0][this.outputPosition] : 0;
      if (out[1]) out[1][i] = ready ? this.output[1][this.outputPosition] : 0;
      if (ready) this.outputPosition++;
      const l = Number.isFinite(left?.[i]) ? left[i] : 0;
      const r = Number.isFinite(right?.[i]) ? right[i] : 0;
      const audio = this.audio[this.block % this.slots];
      audio[0][this.position] = l;
      audio[1][this.position] = r;
      this.peak = Math.max(this.peak, Math.abs(l), Math.abs(r));
      this.position++;
      if (this.position === this.chunk) this.finishChunk();
      this.sinceReset++;
      if (this.flushToken !== null && this.sinceReset >= this.slots * this.chunk) {
        this.port.postMessage({type:'flush-ready',token:this.flushToken,readyAt:(baseFrame+i+1)/sampleRate});
        this.flushToken = null;
      }
    }
    this.frames += out[0].length;
    return true;
  }
}
registerProcessor('renderer-output-peak', OutputPeak);
`;
