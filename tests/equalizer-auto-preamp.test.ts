import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import {
  defaultConfig,
  editedConfig,
  flatProfile,
  normalizeConfig,
} from '../src/plugins/equalizer/config';

test('a failed same-time replacement retains the incoming audible target', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller';",
    ),
  );
  const result = await page.evaluate(async () => {
    const { EqualizerController } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const tone = context.createOscillator();
    const quiet = context.createGain();
    tone.frequency.value = 440;
    quiet.gain.value = 0.01;
    tone.connect(quiet);
    const controller = new EqualizerController({
      audioContext: context,
      insertMaster: (input: AudioNode, output: AudioNode) => {
        quiet.connect(input);
        output.connect(context.destination);
        return () => {
          quiet.disconnect(input);
          output.disconnect(context.destination);
        };
      },
    });
    const profile = (gain: number) => ({
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain, Q: 1 }],
    });
    controller.apply(profile(0), false, true);
    controller.apply(profile(6), false, true);
    const original = controller.input.connect;
    let rejected = false;
    controller.input.connect = () => {
      throw new Error('Owned connection failure');
    };
    try {
      controller.apply(profile(9), false, true);
    } catch {
      rejected = true;
    } finally {
      controller.input.connect = original;
    }
    // Retrying the previous target must not deduplicate a disconnected chain.
    controller.apply(profile(6), false, true);
    const target = controller.getResponse();
    tone.start();
    const rendered = await context.startRendering();
    const tail = rendered.getChannelData(0).slice(3360, 4320);
    const rms = Math.sqrt(
      tail.reduce((sum, sample) => sum + sample * sample, 0) / tail.length,
    );
    controller.stop();
    tone.disconnect();
    quiet.disconnect();
    return { rejected, rms, preamp: target.effectivePreampDb };
  });
  expect(result.rejected).toBe(true);
  expect(result.rms).toBeGreaterThan(0.001);
  expect(result.preamp).toBeCloseTo(-6.1, 1);
});

test('auto preamp is opt-in across legacy schemas and persists only on explicit edits', () => {
  for (const schemaVersion of [0, 2]) {
    const raw = { ...defaultConfig, schemaVersion, autoPreamp: true };
    const before = structuredClone(raw);
    expect(normalizeConfig(raw).autoPreamp).toBe(false);
    expect(raw).toEqual(before);
    const edited = editedConfig(raw, flatProfile('graphic-8'), {
      autoPreamp: true,
    });
    expect(edited.schemaVersion).toBe(3);
    expect(normalizeConfig({ ...raw, ...edited }).autoPreamp).toBe(true);
    expect(edited.profile.preamp).toBe(0);
    expect(editedConfig({ ...raw, ...edited }, edited.profile).autoPreamp).toBe(
      true,
    );
  }
  const future = { ...defaultConfig, schemaVersion: 4, autoPreamp: true };
  const before = structuredClone(future);
  expect(normalizeConfig(future).editable).toBe(false);
  expect(() => editedConfig(future, flatProfile('graphic-8'))).toThrow();
  expect(future).toEqual(before);
  expect(
    normalizeConfig({
      ...defaultConfig,
      schemaVersion: 3,
      autoPreamp: 'true',
    } as any).editable,
  ).toBe(false);
});

for (const sampleRate of [8000, 44100, 48000, 96000])
  test(`native auto preamp covers overlapping, narrow, shelf and Nyquist responses at ${sampleRate} Hz`, async ({
    page,
  }) => {
    await fixturePage(
      page,
      await equalizerBundle(
        "export {EqualizerController} from '@/plugins/equalizer/controller';",
      ),
    );
    const results = await page.evaluate((sampleRate) => {
      const { EqualizerController } = (window as any).EqualizerFixture;
      const context = new OfflineAudioContext(1, sampleRate, sampleRate);
      const controller = new EqualizerController({
        audioContext: context,
        insertMaster: () => () => {},
      });
      const cases = [
        [
          { id: 'a', type: 'peaking', frequency: 1234.5, Q: 1000, gain: 24 },
          { id: 'b', type: 'peaking', frequency: 1235.1, Q: 1000, gain: 24 },
        ],
        [
          { id: 'a', type: 'peaking', frequency: 500, Q: 0.8, gain: 12 },
          { id: 'b', type: 'peaking', frequency: 800, Q: 1, gain: 12 },
          { id: 's', type: 'highshelf', frequency: 10000, Q: 1, gain: 8 },
        ],
        [{ id: 'edge', type: 'peaking', frequency: 19999, Q: 1000, gain: 24 }],
      ];
      const results = cases.map((bands) => {
        controller.apply({ mode: 'custom', bands, preamp: 12 }, false, true);
        const response = controller.getResponse();
        const probes = bands
          .filter((band) => band.frequency < sampleRate / 2)
          .map((band) => {
            const probe = context.createBiquadFilter();
            Object.assign(probe, { type: band.type });
            probe.frequency.value = band.frequency;
            probe.Q.value = band.Q;
            probe.gain.value = band.gain;
            return probe;
          });
        // A dense native reference plus sub-Hz samples around narrow centers.
        const values = [0, sampleRate / 2];
        for (let i = 1; i < 65536; i++) values.push((sampleRate * i) / 131072);
        for (const band of bands)
          for (let i = -1000; i <= 1000; i++)
            values.push(
              Math.max(0, Math.min(sampleRate / 2, band.frequency + i / 1000)),
            );
        const frequencies = new Float32Array(values);
        const magnitude = new Float32Array(values.length);
        const phase = new Float32Array(values.length);
        const sum = new Float64Array(values.length);
        for (const probe of probes) {
          probe.getFrequencyResponse(frequencies, magnitude, phase);
          for (let i = 0; i < values.length; i++)
            sum[i] += 20 * Math.log10(magnitude[i]);
          probe.disconnect();
        }
        let referencePeak = -Infinity;
        for (const gain of sum) referencePeak = Math.max(referencePeak, gain);
        return {
          compensatedPeak: referencePeak + response.effectivePreampDb,
          accuracy: Math.abs(referencePeak - response.peakGainDb),
          grid: response.frequencies.length,
          finite: response.gainsDb.every(Number.isFinite),
          bounds: response.frequencies.every(
            (value: number) => value >= 0 && value <= sampleRate / 2,
          ),
          sampleRate: response.sampleRate,
        };
      });
      controller.stop();
      return results;
    }, sampleRate);
    for (const result of results) {
      expect(result.compensatedPeak).toBeLessThanOrEqual(0.01);
      expect(result.accuracy).toBeLessThan(0.1);
      expect(result.grid).toBeLessThanOrEqual(4096);
      expect(result.finite).toBe(true);
      expect(result.bounds).toBe(true);
      expect(result.sampleRate).toBe(sampleRate);
    }
  });

test('manual closed-panel path stays lazy, auto flat/cuts stay unity, bypass ignores auto, and stop owns analysis cleanup', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller';",
    ),
  );
  const result = await page.evaluate(() => {
    const { EqualizerController } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    let probes = 0;
    let disconnected = 0;
    let responses = 0;
    const create = context.createBiquadFilter.bind(context);
    context.createBiquadFilter = () => {
      probes++;
      const node = create();
      const disconnect = node.disconnect.bind(node);
      node.disconnect = () => {
        disconnected++;
        disconnect();
      };
      const response = node.getFrequencyResponse.bind(node);
      node.getFrequencyResponse = (...args) => {
        responses++;
        response(...args);
      };
      return node;
    };
    const controller = new EqualizerController({
      audioContext: context,
      insertMaster: () => () => {},
    });
    const profile = {
      mode: 'custom',
      preamp: -6,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain: 0, Q: 1 }],
    };
    controller.apply(profile, false);
    const lazy = { probes, responses };
    const manual = controller.getResponse();
    controller.apply(profile, false, true);
    const flat = controller.getResponse();
    controller.apply(
      { ...profile, bands: [{ ...profile.bands[0], gain: -12 }] },
      false,
      true,
    );
    const cut = controller.getResponse();
    controller.apply(
      { ...profile, bands: [{ ...profile.bands[0], gain: 24 }] },
      true,
      true,
    );
    const bypass = controller.getResponse();
    controller.stop();
    return {
      lazy,
      manual: manual.effectivePreampDb,
      flat: flat.effectivePreampDb,
      cut: cut.effectivePreampDb,
      bypass,
      probes,
      disconnected,
      stopped: controller.getResponse(),
    };
  });
  expect(result.lazy).toEqual({ probes: 1, responses: 0 });
  expect(result.manual).toBe(-6);
  expect(result.flat).toBe(0);
  expect(result.cut).toBe(0);
  expect(result.bypass.effectivePreampDb).toBe(0);
  expect(result.bypass.gainsDb.every((gain: number) => gain === 0)).toBe(true);
  expect(result.disconnected).toBe(result.probes);
  expect(result.stopped).toBeNull();
});

test('auto parameter changes use bounded linear handovers during playback and suspended edits', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller';",
    ),
  );
  const result = await page.evaluate(async () => {
    const { EqualizerController } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 9600, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 9600, 48000);
    source.buffer.getChannelData(0).forEach((_, i, values) => {
      values[i] = 0.05 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    });
    let input: GainNode;
    const routes = new Map<GainNode, Set<AudioNode>>();
    const createGain = context.createGain.bind(context);
    context.createGain = () => {
      const gain = createGain();
      const connected = new Set<AudioNode>();
      routes.set(gain, connected);
      const connect = gain.connect.bind(gain);
      const disconnect = gain.disconnect.bind(gain);
      gain.connect = ((node: AudioNode) => {
        connected.add(node);
        return connect(node);
      }) as typeof gain.connect;
      gain.disconnect = ((node?: AudioNode) => {
        if (node) {
          connected.delete(node);
          disconnect(node);
        } else {
          connected.clear();
          disconnect();
        }
      }) as typeof gain.disconnect;
      return gain;
    };
    const controller = new EqualizerController({
      audioContext: context,
      insertMaster: (ownedInput: GainNode, output: GainNode) => {
        input = ownedInput;
        source.connect(input);
        output.connect(context.destination);
        return () => {
          source.disconnect(input);
          output.disconnect(context.destination);
        };
      },
    });
    const profile = {
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain: 0, Q: 1 }],
    };
    controller.apply(profile, false, true);
    const first = context.suspend(0.03);
    const second = context.suspend(0.041);
    const third = context.suspend(0.052);
    source.start();
    const rendering = context.startRendering();
    await first;
    controller.apply(
      { ...profile, bands: [{ ...profile.bands[0], gain: 24 }] },
      false,
      true,
    );
    const afterBoost = routes.get(input!)!.size;
    await context.resume();
    await second;
    let maximumChains = routes.get(input!)!.size;
    for (let i = 0; i < 200; i++) {
      controller.apply(
        { ...profile, bands: [{ ...profile.bands[0], gain: i % 2 ? 12 : 6 }] },
        false,
        true,
      );
      maximumChains = Math.max(maximumChains, routes.get(input!)!.size);
    }
    await context.resume();
    await third;
    for (let i = 0; i < 100; i++) {
      controller.apply(
        { ...profile, bands: [{ ...profile.bands[0], gain: i % 2 ? 24 : 0 }] },
        false,
        true,
      );
      maximumChains = Math.max(maximumChains, routes.get(input!)!.size);
    }
    controller.apply(profile, true, true);
    await context.resume();
    const samples = (await rendering).getChannelData(0);
    controller.stop();
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return {
      afterBoost,
      maximumChains,
      peak,
      finite: [...samples].every(Number.isFinite),
      remaining: routes.get(input!)!.size,
    };
  });
  expect(result.afterBoost).toBe(2); // Same topology must create a new chain in auto mode.
  expect(result.maximumChains).toBeLessThanOrEqual(4);
  expect(result.peak).toBeLessThan(0.051);
  expect(result.finite).toBe(true);
  expect(result.remaining).toBe(0);
});

test('native exact zeros remain finite for the graph and auto cannot hide a rejected massive profile', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller';",
    ),
  );
  const result = await page.evaluate(() => {
    const { EqualizerController } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const controller = new EqualizerController({
      audioContext: context,
      insertMaster: () => () => {},
    });
    const profile = {
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'pass', type: 'bandpass', frequency: 1000, gain: 0, Q: 1 }],
    };
    controller.apply(profile, false, true);
    const initial = controller.getResponse();
    let rejected = 0;
    for (const invalid of [
      { ...profile, preamp: NaN },
      { ...profile, bands: [{ ...profile.bands[0], frequency: NaN }] },
      {
        ...profile,
        bands: Array.from({ length: 64 }, (_, i) => ({
          id: `${i}`,
          type: 'peaking',
          frequency: 1000,
          gain: 24,
          Q: 1,
        })),
      },
    ]) {
      try {
        controller.apply(invalid, false, true);
      } catch {
        rejected++;
      }
    }
    const retained = controller.getResponse();
    controller.stop();
    return {
      rejected,
      finite: initial.gainsDb.every(Number.isFinite),
      floor: Math.min(...initial.gainsDb),
      retained: JSON.stringify(initial) === JSON.stringify(retained),
    };
  });
  expect(result.rejected).toBe(3);
  expect(result.finite).toBe(true);
  expect(result.floor).toBe(-300);
  expect(result.retained).toBe(true);
});

test('initial auto analysis and identical echoes schedule no idle work and reuse their probe buffers', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller';",
    ),
  );
  const result = await page.evaluate(() => {
    const { EqualizerController } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    let created = 0;
    let calls = 0;
    const buffers = new Set<Float32Array>();
    const create = context.createBiquadFilter.bind(context);
    context.createBiquadFilter = () => {
      created++;
      const node = create();
      const response = node.getFrequencyResponse.bind(node);
      node.getFrequencyResponse = (frequencies, magnitude, phase) => {
        calls++;
        buffers.add(frequencies);
        response(frequencies, magnitude, phase);
      };
      return node;
    };
    let timers = 0;
    let frames = 0;
    const timeout = window.setTimeout;
    const frame = window.requestAnimationFrame;
    window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => {
      timers++;
      return timeout.apply(window, args);
    }) as typeof window.setTimeout;
    window.requestAnimationFrame = (callback) => {
      frames++;
      return frame.call(window, callback);
    };
    const controller = new EqualizerController({
      audioContext: context,
      insertMaster: () => () => {},
    });
    const profile = {
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain: 12, Q: 1000 }],
    };
    controller.apply(profile, false, true);
    const initial = created;
    const snapshot = controller.getResponse();
    const callsBeforeRead = calls;
    for (let i = 0; i < 50; i++) controller.getResponse();
    const cached = calls === callsBeforeRead;
    for (let i = 0; i < 10; i++) controller.apply(profile, false, true);
    const result = {
      timers,
      frames,
      initial,
      created,
      buffers: buffers.size,
      cached,
      finite: snapshot.gainsDb.every(Number.isFinite),
    };
    controller.stop();
    window.setTimeout = timeout;
    window.requestAnimationFrame = frame;
    return result;
  });
  expect(result.timers).toBe(0);
  expect(result.frames).toBe(0);
  expect(result.created).toBe(result.initial);
  expect(result.buffers).toBe(1);
  expect(result.cached).toBe(true);
  expect(result.finite).toBe(true);
});

test('an invalid native magnitude rejects an auto update without replacing the live chain', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller';",
    ),
  );
  const result = await page.evaluate(() => {
    const { EqualizerController } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const controller = new EqualizerController({
      audioContext: context,
      insertMaster: () => () => {},
    });
    const profile = { mode: 'custom', preamp: -6, bands: [] };
    controller.apply(profile, false);
    const before = controller.getResponse();
    const create = context.createBiquadFilter.bind(context);
    context.createBiquadFilter = () => {
      const node = create();
      node.getFrequencyResponse = (_frequencies, magnitude) =>
        magnitude.fill(NaN);
      return node;
    };
    let rejected = false;
    try {
      controller.apply(
        {
          ...profile,
          bands: [
            { id: 'a', type: 'peaking', frequency: 1000, gain: 12, Q: 1 },
          ],
        },
        false,
        true,
      );
    } catch {
      rejected = true;
    }
    const retained = controller.getResponse() === before;
    controller.stop();
    return { rejected, retained };
  });
  expect(result).toEqual({ rejected: true, retained: true });
});
