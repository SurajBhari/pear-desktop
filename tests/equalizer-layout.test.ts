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
    ['short', 900, 320],
    ['small', 375, 280],
  ] as const) {
    await page.setViewportSize({ width, height });
    const geometry = await page.locator('dialog').evaluate((node) => {
      const children = node.querySelectorAll<HTMLElement>(
        '.eq-content, .eq-response, .eq-graphic-scroll, .eq-bands',
      );
      return {
        width: node.getBoundingClientRect().width,
        scroll: node.scrollWidth,
        client: node.clientWidth,
        children: Array.from(children, (child) => ({
          name: child.className,
          width: child.getBoundingClientRect().width,
          scroll: child.scrollWidth,
          client: child.clientWidth,
        })),
      };
    });
    await page.screenshot({
      path: testInfo.outputPath(`EQ-20-${name}-initial.png`),
    });
    expect(geometry.width).toBeLessThan(width);
    expect(geometry.scroll, JSON.stringify(geometry)).toBeLessThanOrEqual(
      geometry.client + 1,
    );
    const ticks = await page
      .locator('.eq-response [data-frequency]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const bounds = node.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            height: bounds.height,
          };
        }),
      );
    for (const [i, tick] of ticks.entries()) {
      expect(tick.height).toBeGreaterThanOrEqual(11);
      if (i > 0)
        expect(tick.left - ticks[i - 1].right).toBeGreaterThanOrEqual(4);
    }
    await page.getByRole('dialog').evaluate((node) => {
      const scrollport =
        node.querySelector<HTMLElement>('[data-panel-scroll]') ?? node;
      scrollport.scrollTop = scrollport.scrollHeight;
    });
    const close = page.getByRole('dialog').locator('header button').first();
    const bounds = await close.boundingBox();
    expect(
      bounds,
      `${name}: close button must have a rendered box`,
    ).not.toBeNull();
    if (!bounds) throw new Error('Close button is not rendered');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    expect(
      await close.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return (
          document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest('button') === button
        );
      }),
      `${name}: close button must be hit-testable after scrolling`,
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`EQ-20-${name}.png`),
    });
  }
  // A real pointer click must work without Playwright auto-scrolling the button.
  const closeBounds = await page
    .getByRole('dialog')
    .locator('header button')
    .first()
    .boundingBox();
  if (!closeBounds) throw new Error('Close button is not rendered');
  await page.mouse.click(
    closeBounds.x + closeBounds.width / 2,
    closeBounds.y + closeBounds.height / 2,
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.openEditor(),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(
    page.getByRole('img', { name: 'Target frequency response' }),
  ).toBeVisible();
  const automatic = page.getByLabel('Automatic preamp', { exact: true });
  await expect(automatic).not.toBeChecked();
  await automatic.check();
  const firstGain = page
    .locator('.eq-band')
    .first()
    .locator('input[type="number"]');
  await firstGain.fill('8');
  await expect(automatic).toBeChecked();
  await expect(page.locator('.eq-response output')).toContainText(
    'Applied preamp: -8.1 dB',
  );
  await page.getByLabel('Preamp (dB)', { exact: true }).fill('-4');
  await expect(automatic).not.toBeChecked();
  await expect(page.locator('.eq-response output')).toContainText(
    'Applied preamp: -4.0 dB',
  );
  await automatic.check();
  await page
    .getByRole('combobox', { name: 'Preset', exact: true })
    .selectOption('flat');
  await expect(automatic).toBeChecked();
  await expect(page.locator('.eq-response output')).toContainText(
    'Applied preamp: 0.0 dB',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.stop(),
  );
});
