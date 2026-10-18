import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect, type Page } from '@playwright/test';

test.use({
  launchOptions: process.env.PEAR_TEST_CHROMIUM
    ? { executablePath: process.env.PEAR_TEST_CHROMIUM }
    : {},
});

async function fixture(page: Page, interpolationTime = 1000, buffer = 2) {
  await page.setContent(
    '<div id="layout" player-page-open></div><div id="player-page"></div><div id="song-video"><div class="player-wrapper"><div class="html5-video-container"><video width="4" height="4"></video></div></div></div>',
  );
  await page.evaluate(async () => {
    const w = window as any;
    const video = document.querySelector('video')!;
    w.mediaState = { paused: false, ended: false, readyState: 4 };
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => w.mediaState.paused },
      ended: { configurable: true, get: () => w.mediaState.ended },
      readyState: { configurable: true, get: () => w.mediaState.readyState },
    });
    let serial = 0;
    w.timers = new Map();
    w.frames = new Map();
    w.alphas = [];
    w.readbacks = 0;
    w.uploads = 0;
    w.contextOptions = [];
    w.setInterval = (fn: () => void, delay: number) => {
      const id = ++serial;
      w.timers.set(id, { fn, delay });
      return id;
    };
    w.clearInterval = (id: number) => w.timers.delete(id);
    w.requestAnimationFrame = (fn: () => void) => {
      const id = ++serial;
      w.frames.set(id, fn);
      return id;
    };
    w.cancelAnimationFrame = (id: number) => w.frames.delete(id);
    w.nativeRead = CanvasRenderingContext2D.prototype.getImageData;
    // Immutable raster inputs avoid startup context loss in an off-DOM source
    // canvas. The production target still blends through its native 2D context.
    w.sourceFrames = new Map<string, ImageBitmap>();
    for (const [color, rgba] of [
      ['rgb(255,0,0)', [255, 0, 0, 255]],
      ['rgb(0,0,255)', [0, 0, 255, 255]],
      ['rgb(0,255,0)', [0, 255, 0, 255]],
    ] as const) {
      const pixels = new Uint8ClampedArray(
        Array.from({ length: 16 }, () => [...rgba]).flat(),
      );
      w.sourceFrames.set(
        color,
        await createImageBitmap(new ImageData(pixels, 4, 4)),
      );
    }
    w.color = (color: string) => {
      w.source = w.sourceFrames.get(color);
      if (!w.source) throw new Error(`Unknown fixture frame: ${color}`);
    };
    w.color('rgb(255,0,0)');
    const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
    const nativeGet = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function (
      this: HTMLCanvasElement,
      ...args: any[]
    ) {
      w.contextOptions.push(args);
      return Reflect.apply(nativeGet, this, args);
    };
    CanvasRenderingContext2D.prototype.drawImage = function (
      source: any,
      ...args: any[]
    ) {
      w.alphas.push(this.globalAlpha);
      return Reflect.apply(nativeDraw, this, [
        source instanceof HTMLVideoElement ? w.source : source,
        ...args,
      ]);
    };
    // A cross-origin video taints its canvas: production must never read pixels.
    CanvasRenderingContext2D.prototype.getImageData = function () {
      w.readbacks++;
      throw new DOMException(
        'Cross-origin readback prohibited',
        'SecurityError',
      );
    };
    CanvasRenderingContext2D.prototype.putImageData = function () {
      w.uploads++;
      throw new Error('Pixel upload prohibited');
    };
    w.tick = (delay: number) => {
      for (const timer of [...w.timers.values()])
        if (timer.delay === delay) timer.fn();
      for (const [id, fn] of [...w.frames]) {
        w.frames.delete(id);
        fn();
      }
    };
    w.pixel = () =>
      Array.from(
        w.nativeRead.call(
          document
            .querySelector<HTMLCanvasElement>('.html5-blur-canvas')!
            .getContext('2d'),
          0,
          0,
          1,
          1,
        ).data,
      );
  });
  const raw = await readFile(
    new URL('../src/plugins/ambient-mode/index.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default createPlugin(', 'window.plugin=createPlugin(');
  await page.addScriptTag({
    content: `const t=key=>key;const createPlugin=value=>value;const menu={};const style='';const waitForElement=async selector=>document.querySelector(selector);\n${actual}`,
  });
  await page.evaluate(
    async ({ interpolationTime, buffer }) => {
      const w = window as any;
      await w.plugin.renderer.start({
        getConfig: async () => ({
          ...w.plugin.config,
          quality: 4,
          interpolationTime,
          buffer,
        }),
      });
      w.tick(1000);
    },
    { interpolationTime, buffer },
  );
}

test('ambient drawing uses retained native canvas pixels with opaque first frame and fractional blending, without readback', async ({
  page,
}) => {
  await fixture(page);
  expect(await page.evaluate(() => (window as any).pixel())).toEqual([
    255, 0, 0, 255,
  ]);
  await page.evaluate(() => {
    const w = window as any;
    w.color('rgb(0,0,255)');
    w.tick(500);
  });
  const blended = await page.evaluate(() => (window as any).pixel());
  // Native canvas quantizes source-over alpha and channels; tolerate two byte levels.
  expect(blended[0]).toBeGreaterThanOrEqual(126);
  expect(blended[0]).toBeLessThanOrEqual(129);
  expect(blended[1]).toBe(0);
  expect(blended[2]).toBeGreaterThanOrEqual(126);
  expect(blended[2]).toBeLessThanOrEqual(129);
  expect(blended[3]).toBe(255);
  expect(await page.evaluate(() => (window as any).alphas)).toEqual([1, 0.5]);
  expect(
    await page.evaluate(() => [
      (window as any).readbacks,
      (window as any).uploads,
    ]),
  ).toEqual([0, 0]);
  expect(
    await page.evaluate(() =>
      (window as any).contextOptions.some(
        (args: any[]) => args[1]?.willReadFrequently,
      ),
    ),
  ).toBe(false);
});

test('ambient resize resets history, instant interpolation stays opaque and pause/stop clean up intervals', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.plugin.renderer.onConfigChange({
      ...w.plugin.config,
      quality: 2,
      buffer: 2,
      interpolationTime: 1000,
    });
    w.color('rgb(0,255,0)');
    w.tick(500);
  });
  expect(await page.evaluate(() => (window as any).pixel())).toEqual([
    0, 255, 0, 255,
  ]);
  await page.evaluate(() => {
    const w = window as any;
    w.plugin.renderer.onConfigChange({
      ...w.plugin.config,
      quality: 2,
      buffer: 2,
      interpolationTime: 0,
    });
    w.color('rgb(0,0,255)');
    w.tick(500);
    w.color('rgb(255,0,0)');
    w.tick(500);
  });
  expect(await page.evaluate(() => (window as any).pixel())).toEqual([
    255, 0, 0, 255,
  ]);
  expect(
    await page.evaluate(() =>
      (window as any).alphas.every(
        (alpha: number) => Number.isFinite(alpha) && alpha >= 0 && alpha <= 1,
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).mediaState.paused = true;
    document.querySelector('video')!.dispatchEvent(new Event('pause'));
  });
  expect(
    await page.evaluate(() =>
      [...(window as any).timers.values()].map((timer: any) => timer.delay),
    ),
  ).toEqual([1000]);
  await page.evaluate(() => {
    const w = window as any;
    w.mediaState.paused = false;
    w.mediaState.ended = false;
    document.querySelector('video')!.dispatchEvent(new Event('play'));
  });
  expect(await page.evaluate(() => (window as any).timers.size)).toBe(2);
  await page.evaluate(() => (window as any).plugin.renderer.stop());
  expect(await page.evaluate(() => (window as any).timers.size)).toBe(0);
  await expect(page.locator('.html5-blur-canvas')).toHaveCount(0);
});
