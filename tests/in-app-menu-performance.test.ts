import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
let directory: string;
let bundle: string;
test.use({
  launchOptions: process.env.PEAR_TEST_CHROMIUM
    ? { executablePath: process.env.PEAR_TEST_CHROMIUM }
    : {},
});
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'pear-menu-'));
  const entry = path.join(directory, 'entry.tsx');
  await writeFile(
    entry,
    `import {render} from 'solid-js/web';
import {TitleBar} from ${JSON.stringify(path.join(root, 'src/plugins/in-app-menu/renderer/TitleBar.tsx'))};
import {PanelItem} from ${JSON.stringify(path.join(root, 'src/plugins/in-app-menu/renderer/PanelItem.tsx'))};
window.mount=()=>{const a=render(()=> <TitleBar ipc={{on(){},invoke:async()=>null}}/>,document.querySelector('#title'));
const b=render(()=> <PanelItem type="normal" name="Fixture" toolTip="Tooltip"/>,document.querySelector('#item'));window.dispose=()=>{a();b()}};`,
  );
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [solid()],
    resolve: {
      alias: [
        {
          find: /^solid-js\/web$/,
          replacement: requireRoot.resolve('solid-js/web/dist/web.js'),
        },
        {
          find: /^solid-js$/,
          replacement: requireRoot.resolve('solid-js/dist/solid.js'),
        },
        { find: '@', replacement: path.join(root, 'src') },
      ],
    },
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry,
        formats: ['iife'],
        name: 'Fixture',
        fileName: () => 'fixture.js',
      },
    },
  });
  bundle = await readFile(path.join(directory, 'fixture.js'), 'utf8');
});
test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function mount(page: any) {
  await page.setContent(
    '<div id="layout" style="height:80px;overflow:auto"><div style="height:1000px"></div></div><div id="title"></div><ul id="item"></ul>',
  );
  await page.evaluate(() => {
    const w = window as any;
    let serial = 0;
    w.frames = new Map();
    w.observations = new Set();
    w.writes = [];
    w.requestAnimationFrame = (fn: any) => {
      w.frames.set(++serial, fn);
      return serial;
    };
    w.cancelAnimationFrame = (id: number) => w.frames.delete(id);
    const Native = ResizeObserver;
    w.ResizeObserver = class extends Native {
      targets = new Set();
      observe(target: any, options: any) {
        this.targets.add(target);
        w.observations.add(target);
        super.observe(target, options);
      }
      unobserve(target: any) {
        this.targets.delete(target);
        w.observations.delete(target);
        super.unobserve(target);
      }
      disconnect() {
        for (const target of this.targets) w.observations.delete(target);
        this.targets.clear();
        super.disconnect();
      }
    };
    const layout = document.querySelector('#layout')!;
    for (const method of ['toggle', 'add', 'remove']) {
      const original = (layout.classList as any)[method].bind(layout.classList);
      (layout.classList as any)[method] = (...args: any[]) => {
        w.writes.push(args);
        return original(...args);
      };
    }
    w.tick = () => {
      const batch = [...w.frames];
      w.frames.clear();
      for (const [, fn] of batch) fn();
    };
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    (window as any).mount();
  });
}

test('hidden tooltip has no active floating ResizeObserver and releases it after hover', async ({
  page,
}) => {
  await mount(page);
  expect(await page.evaluate(() => (window as any).observations.size)).toBe(0);
  await page.locator('#item li').dispatchEvent('mouseenter');
  await expect
    .poll(() => page.evaluate(() => (window as any).observations.size))
    .toBeGreaterThan(0);
  await page.locator('#item li').dispatchEvent('mouseleave');
  await expect
    .poll(() => page.evaluate(() => (window as any).observations.size))
    .toBe(0);
  await page.evaluate(() => {
    (window as any).dispose();
  });
});

test('scroll writes are coalesced and disposal cancels frames and listeners', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const node = document.querySelector('#layout')!;
    node.scrollTop = 50;
    for (let i = 0; i < 10; i++) node.dispatchEvent(new Event('scroll'));
  });
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(0);
  await page.evaluate(() => {
    (window as any).tick();
  });
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(1);
  await page.evaluate(() => {
    const node = document.querySelector('#layout')!;
    for (let i = 0; i < 10; i++) node.dispatchEvent(new Event('scroll'));
    (window as any).tick();
  });
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(1);
  await page.evaluate(() => {
    document.querySelector('#layout')!.scrollTop = 0;
    document.querySelector('#layout')!.dispatchEvent(new Event('scroll'));
    (window as any).dispose();
    (window as any).tick();
    document.querySelector('#layout')!.dispatchEvent(new Event('scroll'));
    (window as any).tick();
  });
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).frames.size)).toBe(0);
});

test('long playlist rows avoid permanent compositor layers and keep child geometry', async ({
  page,
}) => {
  await page.setContent(
    '<ytmusic-browse-response style="display:block;width:320px">' +
      Array.from(
        { length: 100 },
        (_, i) =>
          `<ytmusic-responsive-list-item-renderer style="display:block;min-height:48px"><span class="ytmusic-responsive-list-item-renderer">${i === 0 ? 'A long title '.repeat(20) : 'Title ' + i}</span></ytmusic-responsive-list-item-renderer>`,
      ).join('') +
      '</ytmusic-browse-response>',
  );
  const baseline = await page
    .locator('ytmusic-responsive-list-item-renderer')
    .first()
    .boundingBox();
  await page.addStyleTag({
    content: await readFile(
      path.join(root, 'src/plugins/in-app-menu/titlebar.css'),
      'utf8',
    ),
  });
  const first = page.locator('ytmusic-responsive-list-item-renderer').first();
  expect(
    await first
      .locator('span')
      .evaluate((el) => getComputedStyle(el).willChange),
  ).toBe('auto');
  expect(
    await first
      .locator('span')
      .evaluate((el) => getComputedStyle(el).contentVisibility),
  ).toBe('visible');
  expect((await first.boundingBox())!.height).toBe(baseline!.height);
  await page
    .locator('ytmusic-responsive-list-item-renderer')
    .last()
    .scrollIntoViewIfNeeded();
  await first.scrollIntoViewIfNeeded();
  expect((await first.boundingBox())!.height).toBe(baseline!.height);
});
