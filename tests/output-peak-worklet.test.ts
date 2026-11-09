import { test, expect } from '@playwright/test';
import vm from 'node:vm';

import {
  OUTPUT_PEAK_CEILING,
  OUTPUT_PEAK_WORKLET_SOURCE,
  outputPeakDelayFrames,
} from '../src/providers/output-peak-worklet';

function processor(rate = 48000) {
  let Constructor: any;
  vm.runInNewContext(OUTPUT_PEAK_WORKLET_SOURCE, {
    sampleRate: rate,
    AudioWorkletProcessor: class {
      port = {
        onmessage: null,
        messages: [] as unknown[],
        postMessage(value: unknown) {
          this.messages.push(value);
        },
      };
    },
    registerProcessor: (_name: string, value: any) => {
      Constructor = value;
    },
  });
  return new Constructor();
}
function render(dsp: any, input: Float32Array[], sizes = [128]) {
  const channels = [[] as number[], [] as number[]];
  let offset = 0,
    block = 0;
  while (offset < input[0].length) {
    const n = Math.min(sizes[block++ % sizes.length], input[0].length - offset),
      output = [new Float32Array(n), new Float32Array(n)];
    if (
      dsp.process(
        [input.map((c) => c.subarray(offset, offset + n))],
        [output],
      ) !== true
    )
      throw Error('processor retired unexpectedly');
    channels[0].push(...output[0]);
    channels[1].push(...output[1]);
    offset += n;
  }
  return channels;
}
for (const rate of [8000, 44100, 48000, 96000])
  for (const sizes of [[1], [17], [128], [511], [1, 17, 64, 128, 256, 511]])
    test(`output peak stage preserves delayed quiet PCM and stereo at ${rate}Hz quantum ${sizes}`, () => {
      const input = [new Float32Array(5000), new Float32Array(5000)];
      let seed = 7;
      for (let i = 0; i < 4000; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        input[0][i] = (0.2 * seed) / 2147483648;
        input[1][i] = input[0][i] * 0.25;
      }
      const output = render(processor(rate), input, sizes),
        delay = outputPeakDelayFrames(rate);
      for (let c = 0; c < 2; c++)
        expect(output[c]).toEqual(
          Array.from({ length: output[c].length }, (_, i) =>
            i < delay ? 0 : input[c][i - delay],
          ),
        );
    });

test('output stage bounds overload, invalid PCM and stereo with fixed memory and recovers unity', () => {
  const dsp = processor(),
    input = [new Float32Array(48000), new Float32Array(48000)];
  for (let i = 0; i < 48000; i++) {
    let value = i < 5000 ? 4 * Math.sin(i * 0.1) : 0.2 * Math.sin(i * 0.1);
    if (i < 3) value = [NaN, Infinity, -Infinity][i];
    input[0][i] = value;
    input[1][i] = value * 0.25;
  }
  const bytes = () =>
    dsp.audio
      .flat()
      .reduce((n: number, a: Float32Array) => n + a.byteLength, 0) +
    dsp.output.reduce((n: number, a: Float32Array) => n + a.byteLength, 0) +
    dsp.limits.byteLength +
    dsp.peakIds.byteLength +
    dsp.peaks.byteLength;
  const memory = bytes(),
    output = render(dsp, input, [1, 17, 64, 128, 256, 511]);
  expect(memory).toBeLessThan(4096);
  expect(bytes()).toBe(memory);
  expect(dsp.queueCount).toBeLessThanOrEqual(dsp.queueSize);
  let recovery = 0,
    peak = 0,
    stereoError = 0;
  for (let i = 0; i < output[0].length; i++) {
    peak = Math.max(peak, Math.abs(output[0][i]));
    stereoError = Math.max(
      stereoError,
      Math.abs(output[1][i] - output[0][i] * 0.25),
    );
    if (i > 40000 && Math.abs(input[0][i - 192]) > 0.1)
      recovery = Math.max(recovery, output[0][i] / input[0][i - 192]);
  }
  expect(output[0].every(Number.isFinite)).toBe(true);
  expect(peak).toBeLessThanOrEqual(OUTPUT_PEAK_CEILING);
  expect(stereoError).toBe(0);
  expect(recovery).toBeGreaterThan(0.999);
});

test('steady bass peak hold avoids cycle gain ripple instead of waveshaping ordinary PCM', () => {
  const rate = 48000,
    input = new Float32Array(rate * 3);
  for (let i = 0; i < input.length; i++)
    input[i] = 2 * Math.sin((2 * Math.PI * 27 * i) / rate);
  const output = render(processor(), [input, input])[0];
  let fundamental = 0,
    harmonics = 0;
  for (let h = 1; h <= 8; h++) {
    let re = 0,
      im = 0;
    for (let i = rate * 2; i < rate * 3; i++) {
      re += output[i] * Math.cos((2 * Math.PI * 27 * h * i) / rate);
      im += output[i] * Math.sin((2 * Math.PI * 27 * h * i) / rate);
    }
    const power = re * re + im * im;
    if (h === 1) fundamental = power;
    else harmonics += power;
  }
  expect(Math.sqrt(harmonics / fundamental)).toBeLessThan(0.001);
});

test('flush removes pre-mute PCM, acknowledges only fresh audio frames and disposal stops processing', () => {
  const dsp = processor();
  render(dsp, [
    new Float32Array(1000).fill(2),
    new Float32Array(1000).fill(0.5),
  ]);
  dsp.port.onmessage({ data: { type: 'flush', token: 7 } });
  render(dsp, [
    new Float32Array(64).fill(0.01),
    new Float32Array(64).fill(0.0025),
  ]);
  expect(dsp.port.messages).toEqual([]);
  dsp.port.onmessage({ data: { type: 'flush', token: 8 } });
  const output = render(
    dsp,
    [new Float32Array(600).fill(0.02), new Float32Array(600).fill(0.005)],
    [17, 128],
  );
  expect(output[0].slice(0, 192).every((x) => x === 0)).toBe(true);
  expect(output[0].slice(192).every((x) => x === Math.fround(0.02))).toBe(true);
  expect(dsp.port.messages).toEqual([
    { type: 'flush-ready', token: 8, readyAt: (1000 + 64 + 192) / 48000 },
  ]);
  dsp.port.onmessage({ data: { type: 'dispose' } });
  expect(
    dsp.process(
      [[new Float32Array(128)]],
      [[new Float32Array(128), new Float32Array(128)]],
    ),
  ).toBe(false);
});

test('lookahead gain joins continuously across chunks with bounded attack and release slopes', () => {
  const input = new Float32Array(15000).fill(0.2);
  input.fill(4, 5000, 10000);
  const output = render(processor(), [input, input])[0];
  let attack = 0,
    release = 0;
  for (let i = 193; i < output.length; i++) {
    const current = output[i] / input[i - 192],
      previous = output[i - 1] / input[i - 193];
    attack = Math.max(attack, previous - current);
    release = Math.max(release, current - previous);
  }
  expect(attack).toBeLessThanOrEqual(1 / (2 * 64) + 1e-6);
  expect(release).toBeLessThanOrEqual(1 / (48000 * 0.08) + 1e-6);
});
