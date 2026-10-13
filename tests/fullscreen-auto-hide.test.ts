import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, present = true) {
  await page.setContent(
    present
      ? '<video></video><ytmusic-player-bar style="opacity:0.8;transition:none"><button>Play</button></ytmusic-player-bar>'
      : '<div>Waiting</div>',
  );
  await page.evaluate(() => {
    const w = window as any;
    let serial = 0;
    w.frames = new Map();
    w.playing = true;
    w.setTimeout = (fn: () => void, delay: number) => {
      w.frames.set(++serial, { fn, delay });
      return serial;
    };
    w.clearTimeout = (id: number) => w.frames.delete(id);
    w.tick = (delay: number) => {
      for (const [id, t] of [...w.frames] as any[])
        if (t.delay === delay) {
          w.frames.delete(id);
          t.fn();
        }
    };
    w.prepare = () => {
      const video = document.querySelector('video');
      if (video) {
        Object.defineProperty(video, 'paused', { get: () => !w.playing });
        Object.defineProperty(video, 'ended', { get: () => false });
      }
    };
    w.prepare();
  });
  let raw = 'export default createPlugin({renderer:{start(){},stop(){}}});';
  let css = '';
  try {
    raw = await readFile(
      new URL('../src/plugins/fullscreen-auto-hide/index.ts', import.meta.url),
      'utf8',
    );
    css = await readFile(
      new URL('../src/plugins/fullscreen-auto-hide/style.css', import.meta.url),
      'utf8',
    );
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const actual = stripTypeScriptTypes(raw)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/export default createPlugin\s*\(/, 'window.plugin=createPlugin(');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({
    content: `(()=>{const t=x=>x;const createPlugin=x=>x;const style='';${actual}})()`,
  });
  await page.evaluate(async () => {
    await (window as any).plugin.renderer.start();
  });
}

test('fullscreen idle hides controls, activity restores original style, stop leaves no timer', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page);
  await page.evaluate(() =>
    document
      .querySelector('ytmusic-player-bar')!
      .setAttribute('player-fullscreened', ''),
  );
  await page.evaluate(() => {
    (window as any).tick(2500);
  });
  expect(
    await page
      .locator('ytmusic-player-bar')
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('0');
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove')),
  );
  expect(
    await page
      .locator('ytmusic-player-bar')
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('0.8');
  await page.evaluate(() => {
    (window as any).plugin.renderer.stop();
    (window as any).tick(2500);
  });
  expect(await page.locator('ytmusic-player-bar').getAttribute('style')).toBe(
    'opacity:0.8;transition:none',
  );
  expect(await page.evaluate(() => (window as any).frames.size)).toBe(0);
});

test('focused controls and paused playback stay visible, reduced motion removes fade', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page);
  await page.evaluate(() =>
    document
      .querySelector('ytmusic-player-bar')!
      .setAttribute('player-fullscreened', ''),
  );
  await page.locator('button').focus();
  await page.evaluate(() => {
    (window as any).tick(2500);
  });
  expect(
    await page
      .locator('ytmusic-player-bar')
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('0.8');
  expect(
    await page
      .locator('ytmusic-player-bar')
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    (window as any).playing = false;
    document.querySelector('video')!.dispatchEvent(new Event('pause'));
    (window as any).tick(2500);
  });
  expect(
    await page
      .locator('ytmusic-player-bar')
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('0.8');
  await page.evaluate(() => {
    (window as any).plugin.renderer.stop();
  });
});

test('exit fullscreen and late DOM after stop cannot hide controls', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() =>
    document
      .querySelector('ytmusic-player-bar')!
      .setAttribute('player-fullscreened', ''),
  );
  await page.evaluate(() =>
    document
      .querySelector('ytmusic-player-bar')!
      .removeAttribute('player-fullscreened'),
  );
  await page.evaluate(() => {
    (window as any).tick(2500);
  });
  expect(
    await page
      .locator('ytmusic-player-bar')
      .evaluate((el) => getComputedStyle(el).opacity),
  ).toBe('0.8');
  await page.evaluate(() => {
    (window as any).plugin.renderer.stop();
  });
  await fixture(page, false);
  await page.evaluate(() => {
    (window as any).plugin.renderer.stop();
    document.body.innerHTML =
      '<video></video><ytmusic-player-bar player-fullscreened><button>Play</button></ytmusic-player-bar>';
    (window as any).prepare();
  });
  await page.evaluate(() => {
    (window as any).tick(2500);
  });
  expect(await page.evaluate(() => document.body.className)).toBe('');
});
