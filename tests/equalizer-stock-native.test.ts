import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import {
  stockPresets,
  stockProfile,
} from '../src/plugins/equalizer/stock-presets';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

test('stock catalogue cannot be edited and materialized profiles remain independent', () => {
  const rock = stockPresets.find((preset) => preset.id === 'rock')!;
  expect(Reflect.set(rock.gains, '0', -9)).toBe(false);
  expect(Reflect.set(rock, 'id', 'changed')).toBe(false);
  expect(Reflect.set(stockPresets, '0', rock)).toBe(false);
  const first = stockProfile('rock')!;
  first.bands[0].gain = -9;
  first.bands.splice(1);
  first.preamp = 4;
  const next = stockProfile('rock')!;
  expect(next.bands).toHaveLength(10);
  expect(next.bands[0].gain).toBe(5.9);
  expect(next.preamp).toBe(-7);
  expect(stockProfile('missing')).toBeNull();
});

for (const frequency of [1000, 8000])
  test(`Rock stock profile has the actual serial native response at ${frequency} Hz`, async ({
    page,
  }) => {
    const expected = (
      JSON.parse(
        await readFile(
          new URL('./fixtures/equalizer-stock-presets.json', import.meta.url),
          'utf8',
        ),
      ) as Array<{
        id: string;
        preamp: number;
        bands: {
          type: BiquadFilterType;
          frequency: number;
          Q: number;
          gain: number;
        }[];
      }>
    ).find((p) => p.id === 'rock')!;
    await fixturePage(
      page,
      await equalizerBundle(
        "export * from '@/providers/renderer-audio';export {stockProfile} from '@/plugins/equalizer/stock-presets';",
      ),
    );
    const response = await page.evaluate(
      async ({ frequency, expected }) => {
        const fixture = (window as any).EqualizerFixture;
        const context = new OfflineAudioContext(1, 48000, 48000);
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 48000, 48000);
        source.buffer.getChannelData(0).forEach((_, i, samples) => {
          samples[i] = 0.01 * Math.sin((2 * Math.PI * frequency * i) / 48000);
        });
        fixture.initializeAudioGraph(context, source);
        let expectedAmplitude = 0.01 * 10 ** (expected.preamp / 20);
        for (const band of expected.bands) {
          const filter = context.createBiquadFilter();
          filter.type = band.type;
          filter.frequency.value = band.frequency;
          filter.Q.value = band.Q;
          filter.gain.value = band.gain;
          const magnitude = new Float32Array(1),
            phase = new Float32Array(1);
          filter.getFrequencyResponse(
            new Float32Array([frequency]),
            magnitude,
            phase,
          );
          expectedAmplitude *= magnitude[0];
        }
        await fixture.plugin.renderer.start({
          getConfig: async () => ({
            ...fixture.plugin.config,
            enabled: true,
            schemaVersion: 2,
            profile: fixture.stockProfile('rock'),
          }),
          setConfig: async () => {},
          ipc: { on() {}, removeAllListeners() {} },
        });
        source.start();
        const output = (await context.startRendering()).getChannelData(0);
        fixture.plugin.renderer.stop();
        let energy = 0;
        for (const sample of output.slice(30000, 42000))
          energy += sample * sample;
        return {
          actualAmplitude: Math.sqrt((energy / 12000) * 2),
          expectedAmplitude,
        };
      },
      { frequency, expected },
    );
    expect(response.actualAmplitude / response.expectedAmplitude).toBeCloseTo(
      1,
      4,
    );
    if (frequency === 8000)
      expect(response.actualAmplitude).toBeGreaterThan(0.01);
  });

test('translated stock selector retains native keyboard interaction and fits a narrow custom editor', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixturePage(page, await equalizerBundle('', true));
  await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    await fixture.plugin.renderer.start({
      getConfig: async () => ({ ...fixture.plugin.config, enabled: true }),
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
  });
  const select = page.getByLabel('Preset').and(page.locator('select'));
  await expect(
    select.locator('optgroup[label="Stock curves (10 bands)"]'),
  ).toHaveCount(1);
  await expect(select.locator('option[value="stock:rock"]')).toHaveText('Rock');
  await select.selectOption('stock:rock');
  await expect(page.locator('.eq-band')).toHaveCount(10);
  await select.focus();
  await expect(select).toBeFocused();
  const geometry = await page.getByRole('dialog').evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scroll: node.scrollWidth,
    client: node.clientWidth,
  }));
  expect(geometry.width).toBeLessThan(375);
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
  await page.screenshot({
    path: testInfo.outputPath('EQ-STOCK-NARROW.png'),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.stop(),
  );
});
