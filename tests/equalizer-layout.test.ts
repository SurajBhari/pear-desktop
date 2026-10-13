import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

test('the actual translated 20-band editor fits desktop and narrow viewports with keyboard dismissal', async ({
  page,
}, testInfo) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {flatProfile} from '@/plugins/equalizer/config';",
      true,
    ),
  );
  await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new AudioContext();
    fixture.initializeAudioGraph(
      context,
      context.createMediaElementSource(document.querySelector('video')),
    );
    await fixture.plugin.renderer.start({
      getConfig: async () => ({
        ...fixture.plugin.config,
        enabled: true,
        schemaVersion: 2,
        profile: fixture.flatProfile('graphic-20'),
      }),
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
  });
  await expect(page.getByRole('dialog', { name: 'Equalizer' })).toBeVisible();
  await expect(page.locator('.eq-band')).toHaveCount(20);
  for (const [name, width, height] of [
    ['desktop', 1280, 800],
    ['narrow', 375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    const geometry = await page.locator('dialog').evaluate((node) => ({
      width: node.getBoundingClientRect().width,
      scroll: node.scrollWidth,
      client: node.clientWidth,
    }));
    expect(geometry.width).toBeLessThan(width);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    await page.screenshot({
      path: testInfo.outputPath(`EQ-20-${name}.png`),
    });
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.stop(),
  );
});
