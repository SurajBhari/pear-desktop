import { test, expect, type Page } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

async function open(page: Page, count = 0, autoPreamp = false) {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';", true),
  );
  await page.evaluate(
    async ({ count, autoPreamp }) => {
      const fixture = (window as any).EqualizerFixture;
      const context = new AudioContext();
      fixture.initializeAudioGraph(
        context,
        context.createMediaElementSource(document.querySelector('video')),
      );
      (window as any).eqWrites = [];
      await fixture.plugin.renderer.start({
        getConfig: async () => ({
          ...fixture.plugin.config,
          enabled: true,
          schemaVersion: 3,
          autoPreamp,
          profile: {
            mode: 'custom',
            preamp: -6,
            bands: Array.from({ length: count }, (_, i) => ({
              id: `band-${i}`,
              type: 'peaking',
              frequency: 1000 + i * 100,
              gain: 3,
              Q: 1,
            })),
          },
        }),
        setConfig: async (value: unknown) => {
          (window as any).eqWrites.push(value);
        },
        ipc: { on() {}, removeAllListeners() {} },
      });
      fixture.plugin.renderer.openEditor();
    },
    { count, autoPreamp },
  );
  await expect(page.getByRole('dialog', { name: 'Equalizer' })).toBeVisible();
}

test('Custom graph click adds a peaking band with logarithmic frequency and applied preamp compensation', async ({
  page,
}) => {
  await open(page);
  const graph = page.locator('.eq-response svg');
  const box = (await graph.boundingBox())!;
  await page.mouse.click(
    box.x + 56 + (box.width - 68) / 2,
    box.y + 12 + 140 / 3,
  );
  await expect(page.locator('.eq-band')).toHaveCount(1);
  const row = page.locator('.eq-band').first();
  await expect(row.getByLabel('Frequency (Hz)')).toHaveValue('632.5');
  await expect(row.getByLabel('Gain (dB)', { exact: true })).toHaveValue('6');
  await expect(row.getByLabel('Q / bandwidth', { exact: true })).toHaveValue(
    '1',
  );
  const point = graph.getByRole('button', { name: /Band 1/ });
  await expect(point).toHaveAttribute('aria-label', /632.5 Hz.*6.0 dB/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).eqWrites.at(-1)?.profile.bands[0].type,
      ),
    )
    .toBe('peaking');
});

test('point drag survives leaving the graph, clamps values, flushes and never adds a duplicate', async ({
  page,
}) => {
  await open(page, 1);
  const point = page.locator('.eq-response [data-band-id]').first();
  await expect(point).toBeVisible();
  const p = (await point.boundingBox())!;
  const box = (await page.locator('.eq-response svg').boundingBox())!;
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 100, box.y - 300, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.eq-band')).toHaveCount(1);
  const row = page.locator('.eq-band').first();
  await expect(row.getByLabel('Frequency (Hz)')).toHaveValue('20000');
  await expect(row.getByLabel('Gain (dB)', { exact: true })).toHaveValue('48');
  await expect(row.locator('input[type=range]')).toHaveValue('48');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).eqWrites.at(-1)?.profile.bands[0].gain,
      ),
    )
    .toBe(48);
  await page.mouse.move(box.x + 100, box.y + 100);
  await expect(row.getByLabel('Gain (dB)', { exact: true })).toHaveValue('48');
});

test('keyboard and numeric edits synchronize points; cancellation ends a captured gesture', async ({
  page,
}) => {
  await open(page, 1, true);
  let point = page.locator('.eq-response [data-band-id]').first();
  await expect(point).toBeVisible();
  await point.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  const row = page.locator('.eq-band').first();
  await expect(row.getByLabel('Gain (dB)', { exact: true })).toHaveValue('3.1');
  await expect(row.getByLabel('Frequency (Hz)')).toHaveValue('1059.5');
  await row.getByLabel('Frequency (Hz)').fill('500');
  await expect(point).toHaveAttribute('aria-label', /500 Hz/);
  const p = (await point.boundingBox())!;
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y + 5);
  await point.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  const saved = await row.getByLabel('Frequency (Hz)').inputValue();
  await page.mouse.move(p.x + 100, p.y + 10);
  await page.mouse.up();
  await expect(row.getByLabel('Frequency (Hz)')).toHaveValue(saved);
  await expect(page.locator('.eq-band')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.mouse.move(50, 50);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.openEditor(),
  );
  point = page.locator('.eq-response [data-band-id]').first();
  await expect(point).toHaveAttribute('aria-label', new RegExp(`${saved} Hz`));
});

test('keyboard Add band focuses its point and keeps Q editable', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Add band', exact: true }).focus();
  await page.keyboard.press('Enter');
  const point = page.locator('.eq-response [data-band-id]').first();
  await expect(point).toBeFocused();
  await page.keyboard.press('ArrowUp');
  const row = page.locator('.eq-band').first();
  await expect(row.getByLabel('Gain (dB)', { exact: true })).toHaveValue('0.1');
  await row.getByLabel('Q / bandwidth').fill('2');
  await point.focus();
  await page.keyboard.press('ArrowRight');
  await expect(row.getByLabel('Q / bandwidth')).toHaveValue('2');
});

test('automatic headroom stays stable during a drag and Escape disposes pointer capture', async ({
  page,
}) => {
  await open(page, 1, true);
  const point = page.locator('.eq-response [data-band-id]').first();
  const p = (await point.boundingBox())!;
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2 - 20);
  const row = page.locator('.eq-band').first();
  await expect(row.getByLabel('Gain (dB)', { exact: true })).toHaveValue('8.1');
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2 - 20);
  await expect(row.getByLabel('Gain (dB)', { exact: true })).toHaveValue('8.1');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.mouse.move(50, 50);
  await page.mouse.up();
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.openEditor(),
  );
  await expect(page.locator('.eq-band')).toHaveCount(1);
  await expect(
    page.locator('.eq-band').first().getByLabel('Gain (dB)', { exact: true }),
  ).toHaveValue('8.1');
});

test('graph respects MAX_BANDS and graphic layouts remain read only', async ({
  page,
}) => {
  await open(page, 64);
  const graph = page.locator('.eq-response svg');
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + 80, box.y + 140);
  await expect(page.locator('.eq-band')).toHaveCount(64);
  await expect(
    page.getByRole('button', { name: 'Add band', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Bands', exact: true })
    .selectOption('graphic-8');
  await expect(page.locator('.eq-response [data-band-id]')).toHaveCount(0);
  await expect(
    page.getByRole('img', { name: 'Target frequency response' }),
  ).toBeVisible();
});

test('unchanged response refreshes leave the SVG untouched and resize work settles', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {createResponseView} from '@/plugins/equalizer/response-view';",
      true,
    ),
  );
  const counts = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const response = {
      frequencies: [20, 1000, 20000],
      gainsDb: [0, 0, 0],
      effectivePreampDb: 0,
      sampleRate: 48000,
      autoPreamp: false,
      peakGainDb: 0,
    };
    const view = fixture.createResponseView(() => response);
    document.body.append(view.element);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const observer = new MutationObserver(() => {});
    observer.observe(view.element, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    view.refresh();
    view.refresh();
    view.refresh();
    const unchanged = observer.takeRecords().length;
    view.dispose();
    view.refresh();
    const disposed = observer.takeRecords().length;
    observer.disconnect();
    return { unchanged, disposed };
  });
  expect(counts).toEqual({ unchanged: 0, disposed: 0 });
});
