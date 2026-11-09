import { test, expect } from '@playwright/test';
import { deepmergeCustom } from 'deepmerge-ts';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

let bundle: string;
test.beforeAll(async () => {
  bundle = await equalizerBundle(
    "export * from '@/providers/renderer-audio';export {default as compressor} from '@/plugins/audio-compressor';",
  );
});

test('quiet-track makeup is applied after the unchanged native compressor and serial EQ', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    async function render(autoTrackGain: boolean) {
      const context = new OfflineAudioContext(1, 48000, 48000);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 48000, 48000);
      source.buffer.getChannelData(0).forEach((_, i, data) => {
        data[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
      });
      f.initializeAudioGraph(context, source);
      let node: DynamicsCompressorNode;
      const create = context.createDynamicsCompressor.bind(context);
      context.createDynamicsCompressor = () => (node = create());
      const events = new EventTarget();
      const api = {
        getVideoData: () => ({ video_id: 'quiet' }),
        getPlayerResponse: () => ({
          videoDetails: { videoId: 'quiet' },
          playerConfig: { audioConfig: { loudnessDb: -9 } },
        }),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      };
      await f.compressor.renderer.start({
        getConfig: async () => ({
          enabled: true,
          autoTrackGain,
          maxTrackGainDb: 6,
        }),
      });
      await f.compressor.renderer.onPlayerApiReady(api);
      await f.plugin.renderer.start({
        getConfig: async () => ({
          ...f.plugin.config,
          enabled: true,
          schemaVersion: 2,
          bypass: false,
          profile: {
            mode: 'custom',
            preamp: -6,
            bands: [
              { id: 'eq', type: 'peaking', frequency: 1000, gain: 3, Q: 1 },
            ],
          },
        }),
        setConfig() {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      source.start();
      const data = (await context.startRendering()).getChannelData(0);
      f.compressor.renderer.stop();
      f.plugin.renderer.stop();
      return {
        peak: Math.max(...data.slice(30000).map(Math.abs)),
        parameters: [
          node!.threshold.value,
          node!.ratio.value,
          node!.knee.value,
          node!.attack.value,
          node!.release.value,
        ],
      };
    }
    const baseline = await render(false);
    const boosted = await render(true);
    return { baseline, boosted };
  });
  expect(result.boosted.parameters).toEqual([-50, 12, 40, 0, 0.25]);
  expect(result.boosted.peak / result.baseline.peak).toBeCloseTo(
    10 ** (6 / 20),
    4,
  );
});

test('native menu actions write only their leaf and preserve concurrent future settings through installed deepmerge semantics', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const plugin = (window as any).EqualizerFixture.compressor;
    if (typeof plugin.menu !== 'function') return { menu: false };
    let current = {
      ...plugin.config,
      enabled: true,
      future: { retain: 'latest' },
    };
    const writes: unknown[] = [];
    const menu = await plugin.menu({
      getConfig: () => current,
      setConfig: (value: unknown) => writes.push(value),
    });
    current = { ...current, future: { retain: 'concurrent' } };
    await menu
      .find((item: any) => item.type === 'checkbox')
      .click({ checked: true });
    await menu
      .find((item: any) => item.submenu)
      .submenu.find((item: any) => item.label.includes('12'))
      .click();
    return { menu: true, defaults: plugin.config, writes, current };
  });
  expect(result.menu).toBe(true);
  expect(result.defaults).toMatchObject({
    autoTrackGain: false,
    maxTrackGainDb: 6,
  });
  expect(result.writes).toEqual([
    { autoTrackGain: true },
    { maxTrackGainDb: 12 },
  ]);
  const merge = deepmergeCustom({ mergeArrays: false });
  const saved = merge(result.defaults, result.current, ...result.writes!);
  expect(saved).toMatchObject({
    enabled: true,
    future: { retain: 'concurrent' },
    autoTrackGain: true,
    maxTrackGainDb: 12,
  });
});

test('only matching native/response identity and unambiguous finite relative metadata may boost', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const results = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const cases = [
      {
        label: 'reference',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: -6 },
        autoTrackGain: false,
      },
      {
        label: 'quiet',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: -6 },
        boost: true,
      },
      {
        label: 'positive',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: 1, perceptualLoudnessDb: -13 },
      },
      {
        label: 'perceptual-only',
        native: 'A',
        response: 'A',
        audio: { perceptualLoudnessDb: -14 },
      },
      { label: 'zero', native: 'A', response: 'A', audio: { loudnessDb: 0 } },
      {
        label: 'string',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: '-6' },
      },
      { label: 'nan', native: 'A', response: 'A', audio: { loudnessDb: NaN } },
      {
        label: 'infinite',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: -Infinity },
      },
      {
        label: 'lost-id',
        native: '',
        response: 'A',
        audio: { loudnessDb: -6 },
      },
      {
        label: 'stale-response',
        native: 'B',
        response: 'A',
        audio: { loudnessDb: -6 },
      },
      {
        label: 'per-format',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: -6, enablePerFormatLoudness: true },
      },
      {
        label: 'absolute',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: -6, trackAbsoluteLoudnessLkfs: -21 },
      },
      {
        label: 'stateful',
        native: 'A',
        response: 'A',
        audio: {
          loudnessDb: -6,
          loudnessNormalizationConfig: { applyStatefulNormalization: true },
        },
      },
      {
        label: 'format-conflict',
        native: 'A',
        response: 'A',
        audio: { loudnessDb: -6 },
        formats: [{ mimeType: 'audio/webm', loudnessDb: 2 }],
      },
    ];
    const values = [];
    for (const item of cases) {
      const context = new OfflineAudioContext(1, 24000, 48000);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 24000, 48000);
      source.buffer.getChannelData(0).fill(0.0001);
      f.initializeAudioGraph(context, source);
      const events = new EventTarget();
      const api = {
        getVideoData: () => ({ video_id: item.native }),
        getPlayerResponse: () => ({
          videoDetails: { videoId: item.response },
          playerConfig: { audioConfig: item.audio },
          streamingData: { adaptiveFormats: item.formats },
        }),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      };
      await f.compressor.renderer.start({
        getConfig: () => ({
          enabled: true,
          autoTrackGain: item.autoTrackGain !== false,
          maxTrackGainDb: 6,
        }),
      });
      f.compressor.renderer.onPlayerApiReady(api);
      source.start();
      const samples = (await context.startRendering()).getChannelData(0);
      f.compressor.renderer.stop();
      values.push({
        label: item.label,
        value: samples[20000],
        boost: item.boost,
      });
    }
    return values;
  });
  for (const item of results)
    expect(item.value / results[0].value, item.label).toBeCloseTo(
      item.boost ? 10 ** (6 / 20) : 1,
      5,
    );
});

test('nonzero-time interrupted gain ramps anchor to rendered time even while offline clocks are suspended', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 24000, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 24000, 48000);
    source.buffer.getChannelData(0).fill(0.0001);
    f.initializeAudioGraph(context, source);
    const events = new EventTarget();
    const api = {
      getVideoData: () => ({ video_id: 'A' }),
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'A' },
        playerConfig: { audioConfig: { loudnessDb: -12 } },
      }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    };
    const config = { enabled: true, autoTrackGain: false, maxTrackGainDb: 6 };
    await f.compressor.renderer.start({ getConfig: () => config });
    f.compressor.renderer.onPlayerApiReady(api);
    const first = context.suspend(0.1),
      second = context.suspend(0.15),
      third = context.suspend(0.24);
    source.start();
    const rendering = context.startRendering();
    await first;
    const start = context.currentTime;
    f.compressor.renderer.onConfigChange({ ...config, autoTrackGain: true });
    await new Promise((resolve) => setTimeout(resolve, 130));
    await context.resume();
    await second;
    const interrupted = context.currentTime;
    f.compressor.renderer.onConfigChange({
      ...config,
      autoTrackGain: true,
      maxTrackGainDb: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 130));
    await context.resume();
    await third;
    const disabled = context.currentTime;
    f.compressor.renderer.onConfigChange(config);
    await context.resume();
    const data = (await rendering).getChannelData(0);
    f.compressor.renderer.stop();
    const reference = new OfflineAudioContext(1, 24000, 48000);
    const referenceSource = reference.createBufferSource();
    referenceSource.buffer = source.buffer;
    f.initializeAudioGraph(reference, referenceSource);
    await f.compressor.renderer.start({ getConfig: () => config });
    f.compressor.renderer.onPlayerApiReady(api);
    referenceSource.start();
    const baseline = (await reference.startRendering()).getChannelData(0);
    f.compressor.renderer.stop();
    return {
      start,
      interrupted,
      disabled,
      atStart:
        data[Math.round(start * 48000)] / baseline[Math.round(start * 48000)],
      atMid:
        data[Math.round(interrupted * 48000)] /
        baseline[Math.round(interrupted * 48000)],
      settled: data[10500] / baseline[10500],
      afterDisable: data[15000] / baseline[15000],
      finite: [...data].every(Number.isFinite),
    };
  });
  expect(result.atStart).toBeCloseTo(1, 4);
  expect(result.atMid).toBeCloseTo(
    1 + ((10 ** (6 / 20) - 1) * (result.interrupted - result.start)) / 0.1,
    4,
  );
  expect(result.settled).toBeCloseTo(10 ** (3 / 20), 4);
  expect(result.afterDisable).toBeCloseTo(1, 5);
  expect(result.finite).toBe(true);
});

test('gain cap bounds makeup but the dry insert cannot limit peaks in the downstream wet and EQ mix', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 24000, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 24000, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    const graph = f.initializeAudioGraph(context, source);
    // Reverb owns a raw wet tap joining after compressor. A bounded synthetic
    // wet branch witnesses the same canonical downstream headroom contract.
    const wet = context.createGain();
    wet.gain.value = 0.8;
    source.connect(wet);
    wet.connect(graph.masterInput);
    const events = new EventTarget();
    const api = {
      getVideoData: () => ({ video_id: 'A' }),
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'A' },
        playerConfig: { audioConfig: { loudnessDb: -40 } },
      }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    };
    await f.compressor.renderer.start({
      getConfig: () => ({
        enabled: true,
        autoTrackGain: true,
        maxTrackGainDb: 24,
      }),
    });
    f.compressor.renderer.onPlayerApiReady(api);
    await f.plugin.renderer.start({
      getConfig: () => ({
        ...f.plugin.config,
        enabled: true,
        schemaVersion: 2,
        bypass: false,
        profile: { mode: 'custom', preamp: 12, bands: [] },
      }),
      setConfig() {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    source.start();
    const samples = (await context.startRendering()).getChannelData(0);
    f.compressor.renderer.stop();
    f.plugin.renderer.stop();
    return {
      peak: Math.max(...samples.map(Math.abs)),
      finite: [...samples].every(Number.isFinite),
    };
  });
  console.log(JSON.stringify(result));
  expect(result.finite).toBe(true);
  expect(result.peak).toBeGreaterThan(1);
});

test('persisted gain caps are finite, bounded and never coerced from strings', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const values = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const result: number[] = [];
    for (const cap of [0, -4, 3, 12, 24, '12', NaN, Infinity, null]) {
      const context = new OfflineAudioContext(1, 24000, 48000);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 24000, 48000);
      source.buffer.getChannelData(0).fill(0.0001);
      f.initializeAudioGraph(context, source);
      const events = new EventTarget();
      const api = {
        getVideoData: () => ({ video_id: 'A' }),
        getPlayerResponse: () => ({
          videoDetails: { videoId: 'A' },
          playerConfig: { audioConfig: { loudnessDb: -40 } },
        }),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      };
      await f.compressor.renderer.start({
        getConfig: () => ({
          enabled: true,
          autoTrackGain: true,
          maxTrackGainDb: cap,
        }),
      });
      f.compressor.renderer.onPlayerApiReady(api);
      source.start();
      result.push((await context.startRendering()).getChannelData(0)[20000]);
      f.compressor.renderer.stop();
    }
    return result.map((value) => value / result[0]);
  });
  for (const [index, db] of [0, 0, 3, 12, 12, 6, 6, 6, 6].entries())
    expect(values[index]).toBeCloseTo(10 ** (db / 20), 5);
});

test('stopping before configuration resolves never installs a delayed compressor insert', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const value = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 4800, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    f.initializeAudioGraph(context, source);
    let resolve: (value: unknown) => void;
    const pending = f.compressor.renderer.start({
      getConfig: () => new Promise((done) => (resolve = done)),
    });
    f.compressor.renderer.stop();
    resolve!({ enabled: true, autoTrackGain: true, maxTrackGainDb: 6 });
    await pending;
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: { audioContext: context, audioSource: source },
      }),
    );
    source.start();
    return (await context.startRendering()).getChannelData(0)[3000];
  });
  expect(value).toBeCloseTo(0.2, 5);
});

for (const field of [
  'enablePerFormatLoudness',
  'applyStatefulNormalization',
  'preserveStatefulLoudnessTarget',
])
  test(`normalization flag ${field} permits makeup only for absence or primitive false`, async ({
    page,
  }) => {
    await fixturePage(page, bundle);
    const ratios = await page.evaluate(async (field) => {
      const f = (window as any).EqualizerFixture;
      const cases = [
        { present: false },
        { present: true, value: false },
        { present: true, value: true },
        { present: true, value: 'true' },
        { present: true, value: 1 },
        { present: true, value: 'false' },
        { present: true, value: 0 },
        { present: true, value: null },
        { present: true, value: undefined },
        { present: true, value: [] },
        { present: true, value: {} },
      ];
      const values: number[] = [];
      for (const item of [null, ...cases]) {
        const context = new OfflineAudioContext(1, 24000, 48000);
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 24000, 48000);
        source.buffer.getChannelData(0).fill(0.0001);
        f.initializeAudioGraph(context, source);
        const audio: Record<string, unknown> = { loudnessDb: -6 };
        const target: Record<string, unknown> =
          field === 'enablePerFormatLoudness' ? audio : {};
        if (field !== 'enablePerFormatLoudness')
          audio.loudnessNormalizationConfig = target;
        if (item?.present) target[field] = item.value;
        const events = new EventTarget();
        const api = {
          getVideoData: () => ({ video_id: 'A' }),
          getPlayerResponse: () => ({
            videoDetails: { videoId: 'A' },
            playerConfig: { audioConfig: audio },
          }),
          addEventListener: events.addEventListener.bind(events),
          removeEventListener: events.removeEventListener.bind(events),
        };
        await f.compressor.renderer.start({
          getConfig: () => ({
            enabled: true,
            autoTrackGain: item !== null,
            maxTrackGainDb: 6,
          }),
        });
        f.compressor.renderer.onPlayerApiReady(api);
        source.start();
        values.push((await context.startRendering()).getChannelData(0)[20000]);
        f.compressor.renderer.stop();
      }
      return values.slice(1).map((value) => value / values[0]);
    }, field);
    for (const [index, ratio] of ratios.entries())
      expect(ratio, `${field} case${index}`).toBeCloseTo(
        index < 2 ? 10 ** (6 / 20) : 1,
        5,
      );
  });
