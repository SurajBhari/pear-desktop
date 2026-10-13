import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import {
  defaultConfig,
  flatProfile,
  normalizeConfig,
} from '../src/plugins/equalizer/config';

test('low sample rate keeps the configured 20 bands while excluding frequencies beyond Nyquist', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {flatProfile} from '@/plugins/equalizer/config';",
    ),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 8000, 8000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 8000, 8000);
    source.buffer.getChannelData(0).fill(0.2);
    fixture.initializeAudioGraph(context, source);
    const filters: BiquadFilterNode[] = [];
    const create = context.createBiquadFilter.bind(context);
    context.createBiquadFilter = () => {
      const node = create();
      filters.push(node);
      return node;
    };
    const config = {
      ...fixture.plugin.config,
      enabled: true,
      schemaVersion: 2,
      profile: fixture.flatProfile('graphic-20'),
    };
    let writes = 0;
    await fixture.plugin.renderer.start({
      getConfig: async () => config,
      setConfig: async () => writes++,
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
    const notice = document.querySelector('[role="status"]')?.textContent;
    source.start();
    const sample = (await context.startRendering()).getChannelData(0)[6000];
    fixture.plugin.renderer.stop();
    return {
      count: filters.length,
      highest: Math.max(...filters.map((node) => node.frequency.value)),
      retained: config.profile.bands.length,
      sample,
      writes,
      notice,
    };
  });
  expect(result.count).toBe(15);
  expect(result.highest).toBeLessThan(4000);
  expect(result.retained).toBe(20);
  expect(result.sample).toBeCloseTo(0.2, 5);
  expect(result.writes).toBe(0);
  expect(result.notice).toBe('plugins.equalizer.editor.nyquist');
});

for (const initialCount of [0, 64])
  test(`pathological boosts preserve finite sound through ${initialCount}-band topology/parameter updates`, async ({
    page,
  }) => {
    await fixturePage(
      page,
      await equalizerBundle("export * from '@/providers/renderer-audio';"),
    );
    const result = await page.evaluate(async (initialCount) => {
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
        profile: {
          mode: 'custom',
          preamp: 0,
          bands: Array.from({ length: initialCount }, (_, i) => ({
            id: `extreme-${i}`,
            type: 'peaking',
            frequency: 1000,
            gain: 0,
            Q: 1,
          })),
        },
      };
      await fixture.plugin.renderer.start({
        getConfig: async () => config,
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      fixture.plugin.renderer.openEditor();
      fixture.plugin.renderer.onConfigChange({
        ...config,
        profile: {
          ...config.profile,
          bands: Array.from({ length: 64 }, (_, i) => ({
            id: `extreme-${i}`,
            type: 'peaking',
            frequency: 1000,
            gain: 24,
            Q: 1,
          })),
        },
      });
      source.start();
      const output = (await context.startRendering()).getChannelData(0);
      const error = document.querySelector('[role="alert"]')?.textContent;
      fixture.plugin.renderer.stop();
      return {
        finite: [...output].every(Number.isFinite),
        sample: output[3000],
        error,
      };
    }, initialCount);
    expect(result.finite).toBe(true);
    expect(result.sample).toBeCloseTo(0.2, 5);
    expect(result.error).toBe('plugins.equalizer.editor.audio-error');
  });

test('unknown schema and nonstandard graphic profiles are preserved as unsupported instead of editable migration', () => {
  const profile = flatProfile('graphic-8');
  for (const raw of [
    { ...defaultConfig, schemaVersion: 1, profile },
    {
      ...defaultConfig,
      schemaVersion: 2,
      profile: {
        ...profile,
        bands: profile.bands.map((band, i) =>
          i === 0 ? { ...band, frequency: 1000 } : band,
        ),
      },
    },
  ]) {
    const snapshot = structuredClone(raw);
    expect(normalizeConfig(raw).editable).toBe(false);
    expect(raw).toEqual(snapshot);
  }
});
