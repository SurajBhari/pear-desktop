import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

test('a repeated start releases the previous insert so a subsequent stop restores dry unity', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const sample = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 4800, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    fixture.initializeAudioGraph(context, source);
    const config = {
      ...fixture.plugin.config,
      enabled: true,
      schemaVersion: 2,
      profile: { mode: 'custom', preamp: -6, bands: [] },
    };
    const ctx = {
      getConfig: async () => config,
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    };
    await fixture.plugin.renderer.start(ctx);
    await fixture.plugin.renderer.start(ctx);
    fixture.plugin.renderer.stop();
    source.start();
    return (await context.startRendering()).getChannelData(0)[3000];
  });
  expect(sample).toBeCloseTo(0.2, 5);
});

test('an enabled zero-gain EQ preserves unity instead of summing a parallel dry copy', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const value = await page.evaluate(async () => {
    const plugin = (window as any).EqualizerFixture.plugin;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 4800, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    const graph = (window as any).EqualizerFixture.initializeAudioGraph(
      context,
      source,
    );
    await plugin.renderer.start({
      getConfig: async () => ({
        enabled: true,
        filters: [{ type: 'peaking', frequency: 1000, gain: 0, Q: 1 }],
        presets: { 'bass-booster': false },
      }),
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioContext: context,
          audioSource: source,
          audioGraph: graph,
        },
      }),
    );
    source.start();
    const output = await context.startRendering();
    plugin.renderer.stop();
    return output.getChannelData(0)[3000];
  });
  expect(value).toBeCloseTo(0.2, 5);
});

test('editor changes layouts, arbitrary bands and user presets without autosaving on open', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new AudioContext();
    fixture.initializeAudioGraph(
      context,
      context.createMediaElementSource(document.querySelector('video')),
    );
    (window as any).writes = [];
    await fixture.plugin.renderer.start({
      getConfig: async () => ({ ...fixture.plugin.config, enabled: true }),
      setConfig: async (value: unknown) => (window as any).writes.push(value),
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
  });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(0);
  await page
    .getByLabel('plugins.equalizer.editor.layout')
    .selectOption('graphic-20');
  await expect(page.locator('.eq-band')).toHaveCount(20);
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.use-custom' })
    .click();
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.add-band' })
    .click();
  await expect(page.locator('.eq-band')).toHaveCount(21);
  await page
    .getByLabel('plugins.equalizer.editor.preset-name')
    .fill('Owned test preset');
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.save' })
    .click();
  await expect(
    page.getByLabel('plugins.equalizer.editor.preset').locator('option'),
  ).toContainText(['Owned test preset']);
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.close' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.stop(),
  );
});

for (const gain of [-12, 12])
  test(`live peaking ${gain} dB has the measured serial response with headroom`, async ({
    page,
  }) => {
    await fixturePage(
      page,
      await equalizerBundle("export * from '@/providers/renderer-audio';"),
    );
    const amplitude = await page.evaluate(async (gain) => {
      const fixture = (window as any).EqualizerFixture;
      const context = new OfflineAudioContext(1, 48000, 48000);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 48000, 48000);
      source.buffer
        .getChannelData(0)
        .forEach(
          (_, i, samples) =>
            (samples[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000)),
        );
      fixture.initializeAudioGraph(context, source);
      const config = {
        enabled: true,
        schemaVersion: 2,
        bypass: false,
        profile: {
          mode: 'custom',
          preamp: -6,
          bands: [{ id: 'peak', type: 'peaking', frequency: 1000, gain, Q: 1 }],
        },
        userPresets: [],
        rememberedProfiles: {},
      };
      await fixture.plugin.renderer.start({
        getConfig: async () => config,
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      source.start();
      const output = await context.startRendering();
      fixture.plugin.renderer.stop();
      return Math.max(
        ...output.getChannelData(0).slice(30000, 40000).map(Math.abs),
      );
    }, gain);
    expect(amplitude).toBeCloseTo(0.1 * 10 ** ((gain - 6) / 20), 4);
  });

test('hot config edits and linear same-input replacement do not add a midpoint boost', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 48000, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 48000, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    fixture.initializeAudioGraph(context, source);
    const config = {
      enabled: true,
      schemaVersion: 2,
      bypass: false,
      profile: { mode: 'custom', preamp: 0, bands: [] },
      userPresets: [],
      rememberedProfiles: {},
    };
    await fixture.plugin.renderer.start({
      getConfig: async () => config,
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.onConfigChange({
      ...config,
      profile: {
        ...config.profile,
        bands: [
          { id: 'identity', type: 'peaking', frequency: 1000, gain: 0, Q: 1 },
        ],
      },
    });
    source.start();
    const samples = (await context.startRendering()).getChannelData(0);
    fixture.plugin.renderer.stop();
    return { min: Math.min(...samples), max: Math.max(...samples) };
  });
  expect(result.min).toBeCloseTo(0.2, 5);
  expect(result.max).toBeCloseTo(0.2, 5);
});

for (const interrupted of [false, true])
  test(`flat playback-time handovers preserve unity${interrupted ? ' through interrupted suspended fades and bypass' : ''}`, async ({
    page,
  }) => {
    await fixturePage(
      page,
      await equalizerBundle(
        "export * from '@/providers/renderer-audio';export {flatProfile} from '@/plugins/equalizer/config';",
      ),
    );
    const result = await page.evaluate(async (interrupted) => {
      const fixture = (window as any).EqualizerFixture;
      const context = new OfflineAudioContext(1, 4800, 48000);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 4800, 48000);
      source.buffer.getChannelData(0).fill(0.2);
      fixture.initializeAudioGraph(context, source);
      const config = {
        ...fixture.plugin.config,
        enabled: true,
        schemaVersion: 2,
        bypass: false,
        profile: { mode: 'custom', preamp: 0, bands: [] },
      };
      await fixture.plugin.renderer.start({
        getConfig: async () => config,
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      const first = context.suspend(0.01);
      const second = interrupted ? context.suspend(0.021) : null;
      const third = interrupted ? context.suspend(0.032) : null;
      source.start();
      const rendering = context.startRendering();
      await first;
      fixture.plugin.renderer.onConfigChange({
        ...config,
        profile: fixture.flatProfile('graphic-20'),
      });
      if (interrupted) await new Promise((resolve) => setTimeout(resolve, 90));
      await context.resume();
      if (second && third) {
        await second;
        fixture.plugin.renderer.onConfigChange({
          ...config,
          profile: fixture.flatProfile('graphic-8'),
        });
        fixture.plugin.renderer.onConfigChange(config);
        await new Promise((resolve) => setTimeout(resolve, 90));
        await context.resume();
        await third;
        fixture.plugin.renderer.onConfigChange({
          ...config,
          profile: fixture.flatProfile('graphic-14'),
        });
        fixture.plugin.renderer.onConfigChange({ ...config, bypass: true });
        await context.resume();
      }
      const samples = (await rendering).getChannelData(0);
      fixture.plugin.renderer.stop();
      return {
        finite: [...samples].every(Number.isFinite),
        min: Math.min(...samples),
        max: Math.max(...samples),
      };
    }, interrupted);
    expect(result.finite).toBe(true);
    expect(result.min).toBeCloseTo(0.2, 5);
    expect(result.max).toBeCloseTo(0.2, 5);
  });

test('hot compressor enable inserts the dry route instead of leaving an uncompressed copy', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {default as compressor} from '@/plugins/audio-compressor';",
    ),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 48000, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 48000, 48000);
    source.buffer
      .getChannelData(0)
      .forEach(
        (_, i, values) =>
          (values[i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / 48000)),
      );
    let actualCompressor: DynamicsCompressorNode;
    const nativeCompressor = context.createDynamicsCompressor.bind(context);
    context.createDynamicsCompressor = () =>
      (actualCompressor = nativeCompressor());
    const detachArgs: number[] = [];
    const nativeDisconnect = source.disconnect.bind(source);
    source.disconnect = (...args: any[]) => {
      detachArgs.push(args.length);
      return (nativeDisconnect as any)(...args);
    };
    fixture.initializeAudioGraph(context, source);
    fixture.compressor.renderer.start();
    source.start();
    const samples = (await context.startRendering()).getChannelData(0);
    fixture.compressor.renderer.stop();
    const reference = new OfflineAudioContext(1, 48000, 48000);
    const tone = reference.createBufferSource();
    tone.buffer = source.buffer;
    const compressor = reference.createDynamicsCompressor();
    for (const key of [
      'threshold',
      'ratio',
      'knee',
      'attack',
      'release',
    ] as const)
      compressor[key].value = actualCompressor![key].value;
    tone.connect(compressor);
    compressor.connect(reference.destination);
    tone.start();
    const expected = (await reference.startRendering()).getChannelData(0);
    return {
      peak: Math.max(...samples.slice(30000).map(Math.abs)),
      reference: Math.max(...expected.slice(30000).map(Math.abs)),
      blanket: detachArgs.includes(0),
    };
  });
  expect(result.peak).toBeCloseTo(result.reference, 5);
  expect(result.peak).toBeGreaterThan(0);
  expect(result.blanket).toBe(false);
});

test('stop before config resolves and repeated hot enable preserve raw analyser taps', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 4800, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    const analyser = context.createAnalyser();
    const silent = context.createGain();
    silent.gain.value = 0;
    analyser.connect(silent);
    silent.connect(context.destination);
    source.connect(analyser);
    fixture.initializeAudioGraph(context, source);
    let resolve!: (value: unknown) => void;
    const pending = fixture.plugin.renderer.start({
      getConfig: () => new Promise((done) => (resolve = done)),
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.stop();
    resolve(fixture.plugin.config);
    await pending;
    const raw = {
      ...fixture.plugin.config,
      enabled: true,
      schemaVersion: 2,
      profile: { mode: 'custom', preamp: 0, bands: [] },
    };
    for (let i = 0; i < 20; i++) {
      await fixture.plugin.renderer.start({
        getConfig: async () => raw,
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      document.dispatchEvent(
        new CustomEvent('peard:audio-can-play', {
          detail: { audioContext: context, audioSource: source },
        }),
      );
      fixture.plugin.renderer.stop();
    }
    source.start();
    const suspended = context.suspend(0.05);
    const rendering = context.startRendering();
    await suspended;
    const tap = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(tap);
    await context.resume();
    const output = (await rendering).getChannelData(0);
    return { main: output[3000], tap: tap[tap.length - 1] };
  });
  expect(result.main).toBeCloseTo(0.2, 5);
  expect(result.tap).toBeCloseTo(0.2, 5);
});

test('a delayed settings echo cannot erase a later band edit before saving a preset', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new AudioContext();
    fixture.initializeAudioGraph(
      context,
      context.createMediaElementSource(document.querySelector('video')),
    );
    const raw = {
      ...fixture.plugin.config,
      enabled: true,
      schemaVersion: 2,
      profile: {
        mode: 'custom',
        preamp: 0,
        bands: [0, 1].map((i) => ({
          id: `band-${i}`,
          type: 'peaking',
          frequency: 500 + i * 500,
          gain: 0,
          Q: 1,
        })),
      },
    };
    (window as any).savedWrites = [];
    (window as any).initialConfig = raw;
    await fixture.plugin.renderer.start({
      getConfig: async () => raw,
      setConfig: (value: unknown) => {
        (window as any).savedWrites.push(value);
        if ((window as any).savedWrites.length === 1)
          return new Promise(
            (resolve) => ((window as any).resolveSave = resolve),
          );
      },
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
  });
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(0)
    .fill('5');
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(0)
    .press('Tab');
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(1)
    .fill('6');
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(1)
    .press('Tab');
  await page.evaluate(() => {
    const fixture = (window as any).EqualizerFixture;
    fixture.plugin.renderer.onConfigChange({
      ...(window as any).initialConfig,
      ...(window as any).savedWrites[0],
    });
    (window as any).resolveSave();
  });
  await page
    .getByLabel('plugins.equalizer.editor.preset-name')
    .fill('Preserve both edits');
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.save' })
    .click();
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.close' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).savedWrites.at(-1)?.userPresets?.[0]?.profile.bands[1]
            .gain,
      ),
    )
    .toBe(6);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.stop(),
  );
});
