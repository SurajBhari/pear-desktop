import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { build, normalizePath } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const actual = (file: string) => normalizePath(path.join(root, 'src', file));
let scratch: string, code: string, css: string;
test.use({
  launchOptions: process.env.PEAR_TEST_CHROMIUM
    ? { executablePath: process.env.PEAR_TEST_CHROMIUM }
    : {},
});
test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'pear-picker-browser-'));
  const entry = path.join(scratch, 'entry.tsx');
  await writeFile(
    entry,
    `import{render}from'solid-js/web';import 'mdui/components/button-icon.js';import{LyricsRenderer,setIsVisible,setConfig}from ${JSON.stringify(actual('plugins/synced-lyrics/renderer/renderer.tsx'))};import{setLyricsStore,lyricsStore}from ${JSON.stringify(actual('plugins/synced-lyrics/renderer/store.ts'))};import{providerNames}from ${JSON.stringify(actual('plugins/synced-lyrics/providers/index.ts'))};window.mount=(download=true)=>{setConfig({enabled:true,enableDownload:download});for(const name of providerNames)setLyricsStore('lyrics',name,{state:'done',error:null,data:{lyrics:Array.from({length:50},(_,i)=>'Fixture lyric '+i).join('\\n')}});setIsVisible(true);window.fixture={dispose:render(()=> <LyricsRenderer/>,document.querySelector('#lyrics-tab')),provider:()=>lyricsStore.provider,setConfig};};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: [{ find: '@', replacement: actual('') }],
      conditions: ['browser'],
    },
    plugins: [
      solidPlugin(),
      {
        name: 'owned-picker-browser-boundaries',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === 'electron' || id === 'electron-store')
            throw Error('Native/profile runtime prohibited');
          if (['solid-js', 'solid-js/web', 'solid-js/store'].includes(id))
            return normalizePath(
              requireRoot.resolve(
                id
                  .replace('solid-js/web', 'solid-js/web/dist/web.js')
                  .replace('solid-js/store', 'solid-js/store/dist/store.js')
                  .replace(/^solid-js$/, 'solid-js/dist/solid.js'),
              ),
            );
          if (id.startsWith('mdui/'))
            return normalizePath(requireRoot.resolve(id));
          if (id === '@/i18n' || id === actual('i18n')) return '\0fixture:i18n';
          if (
            id === '@/providers/song-info-front' ||
            id === actual('providers/song-info-front')
          )
            return '\0fixture:song';
          const name = importer && normalizePath(importer);
          if (name?.includes('/synced-lyrics/')) {
            if (id === './utils' || id === '../utils') return '\0fixture:utils';
            if (
              (name.endsWith('/components/LyricsPicker.tsx') &&
                id === '../index') ||
              (name.endsWith('/components/SyncedLine.tsx') && id === '..')
            )
              return '\0fixture:ipc';
            if (
              name.endsWith('/renderer/store.ts') &&
              id === '../providers/renderer'
            )
              return '\0fixture:providers';
          }
          return null;
        },
        load(id) {
          if (id === '\0fixture:i18n')
            return "export const t=key=>key.endsWith('.export')?'Export lyrics…':key;";
          if (id === '\0fixture:song')
            return "export const getSongInfo=()=>({videoId:'fixture-track'});";
          if (id === '\0fixture:ipc')
            return "export const _ytAPI=undefined;export const exportCurrentLyrics=async()=>{window.exportCalls=(window.exportCalls??0)+1;return 'cancelled'};";
          if (id === '\0fixture:providers') return 'export const providers={};';
          if (id === '\0fixture:utils')
            return "export const selectors={body:{tabRenderer:'#lyrics-tab'}},canonicalize=s=>s,simplifyUnicode=s=>s,convertChineseCharacter=s=>s,romanize=async s=>s;";
          return null;
        },
        generateBundle() {
          const ids = [...this.getModuleIds()];
          for (const suffix of [
            '/renderer/renderer.tsx',
            '/components/LyricsPicker.tsx',
            '/renderer/store.ts',
          ])
            if (ids.filter((id) => id.endsWith(suffix)).length !== 1)
              throw Error('Missing real module ' + suffix);
          if (
            ids.some(
              (id) =>
                id.includes('/src/config/') || id.includes('electron-store'),
            )
          )
            throw Error('Profile runtime imported');
        },
      },
    ],
    build: {
      lib: { entry, formats: ['iife'], name: 'pickerFixture' },
      write: false,
      minify: false,
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  if (!('output' in bundle)) throw Error('One-shot bundle required');
  code = bundle.output.find((item) => item.type === 'chunk')!.code;
  css = await readFile(
    path.join(root, 'src/plugins/synced-lyrics/style.css'),
    'utf8',
  );
});
test.afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
test.afterEach(async ({ page }, info) => {
  if (!process.env.PEAR_PICKER_EVIDENCE_DIR || info.status !== 'passed') return;
  const names: Record<string, string> = {
    'black surface and layout at 1040px with export true': 'wide-panel.png',
    'scrolled provider panel hides on down leave': 'hidden-panel.png',
    'black surface and layout at 320px with export true': 'narrow-panel.png',
  };
  if (names[info.title]) {
    await page
      .locator('.lyrics-picker-item')
      .evaluateAll((nodes) =>
        Promise.all(
          nodes
            .flatMap((node) => node.getAnimations())
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
    await page.screenshot({
      path: path.join(process.env.PEAR_PICKER_EVIDENCE_DIR, names[info.title]),
    });
  }
});

async function mount(page: Page, width = 600, download = true) {
  await page.setContent(
    `<style>html{font-size:16px;background:#000;color:#ededed}body{margin:0}#lyrics-tab{position:absolute;left:100px;top:100px;width:${width}px;height:440px;--ytmusic-general-background-a:#181818;--ytmusic-general-background-b:#232323;--ytmusic-body-line-height:1.4}mdui-button-icon{color:inherit}</style><button id="outside">Outside</button><div id="lyrics-tab"></div>`,
  );
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    customElements.define(
      'yt-formatted-string',
      class extends HTMLElement {
        set text(value: any) {
          this.textContent = value.runs.map((r: any) => r.text).join('');
        }
      },
    );
  });
  await page.addScriptTag({ content: code });
  await page.evaluate((download) => (window as any).mount(download), download);
  await expect(page.locator('.lyrics-picker')).toBeVisible();
  await page
    .locator('.synced-lyrics-vlist')
    .evaluate((el) => (el.scrollTop = 650));
  await expect
    .poll(() =>
      page.locator('.synced-lyrics-vlist').evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(300);
  await page.mouse.move(400, 400);
}
async function reveal(page: Page) {
  await page.mouse.move(400, 120);
  await expect.poll(() => top(page)).toBe(100);
}
async function top(page: Page) {
  return Math.round((await page.locator('.lyrics-picker').boundingBox())!.y);
}
async function hidden(page: Page) {
  await expect.poll(() => top(page)).toBeLessThan(50);
}
async function pointerClick(page: Page, control: Locator) {
  // The real virtualizer temporarily disables pointer hits while scrolling.
  // Wait for its actual hit target, without locator.click's scrollIntoView.
  await expect
    .poll(() =>
      control.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return (node.closest('mdui-button-icon') ?? node).contains(hit);
      }),
    )
    .toBe(true);
  const box = (await control.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(
    await page.locator('.synced-lyrics-vlist').evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(300);
}

for (const [name, x, y] of [
  ['left', 50, 120],
  ['right', 750, 120],
  ['up', 400, 70],
  ['down', 400, 400],
] as const) {
  test(`scrolled provider panel hides on ${name} leave`, async ({ page }) => {
    await mount(page);
    await reveal(page);
    await page.mouse.move(x, y);
    await hidden(page);
  });
}
test('scrolled panel hides when pointer leaves the browser viewport', async ({
  page,
}) => {
  await mount(page);
  await reveal(page);
  await page.mouse.move(-10, 120);
  await hidden(page);
});
test('panel hides on window blur and does not restore stale pointer on focus', async ({
  page,
}) => {
  await mount(page);
  await reveal(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await hidden(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await hidden(page);
});
test('internal controls stay usable, provider changes and export dispatch survive', async ({
  page,
}) => {
  await mount(page);
  await reveal(page);
  await pointerClick(page, page.locator('mdui-icon-chevron-right'));
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.provider()))
    .toBe('LRCLib');
  await expect.poll(() => top(page)).toBe(100);
  await pointerClick(page, page.locator('mdui-icon-chevron-left'));
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.provider()))
    .toBe('YTMusic');
  await pointerClick(page, page.locator('.lyrics-picker-dot').nth(2));
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.provider()))
    .toBe('MusixMatch');
  await pointerClick(
    page,
    page.getByRole('button', { name: 'Export lyrics…' }),
  );
  expect(await page.evaluate(() => (window as any).exportCalls)).toBe(1);
  await expect.poll(() => top(page)).toBe(100);
  await expect(page.locator('.text-lyrics').first()).toBeVisible();
});
for (const control of [
  'mdui-icon-chevron-right',
  '.lyrics-picker-dot',
  '.lyrics-export',
]) {
  for (const [direction, x, y] of [
    ['left', 50, 120],
    ['right', 750, 120],
    ['up', 400, 70],
    ['down', 400, 400],
  ] as const)
    test(`pointer focus on ${control} does not latch the panel after ${direction} leave`, async ({
      page,
    }) => {
      await mount(page);
      await reveal(page);
      await pointerClick(page, page.locator(control).first());
      await page.mouse.move(x, y);
      await hidden(page);
    });
}
test('keyboard focus reveals the panel and retains it across pointer and internal focus transitions', async ({
  page,
}) => {
  await mount(page);
  await page.locator('.lyrics-export').focus();
  await expect.poll(() => top(page)).toBe(100);
  await page.mouse.move(50, 120);
  await expect.poll(() => top(page)).toBe(100);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).exportCalls)).toBe(1);
  await page.locator('mdui-button-icon').first().focus();
  await expect.poll(() => top(page)).toBe(100);
  await page.locator('#outside').focus();
  await hidden(page);
});
test('blur restores keyboard-focused controls on refocus without restoring pointer hover', async ({
  page,
}) => {
  await mount(page);
  await page.locator('.lyrics-export').focus();
  await page.keyboard.press('Enter');
  await page.mouse.move(50, 120);
  await expect.poll(() => top(page)).toBe(100);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await hidden(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.lyrics-export')).toBeFocused();
  await expect.poll(() => top(page)).toBe(100);
  await page.locator('#outside').focus();
  await hidden(page);
});
test('mouse-clicked focus stays hidden after blur and refocus until keyboard interaction', async ({
  page,
}) => {
  await mount(page);
  await reveal(page);
  await pointerClick(page, page.locator('.lyrics-export'));
  await page.mouse.move(50, 120);
  await hidden(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await hidden(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.lyrics-export')).toBeFocused();
  await hidden(page);
  await page.keyboard.press('Enter');
  await expect.poll(() => top(page)).toBe(100);
});
test('Tab reveals actionable controls and Shift-Tab out hides the scrolled panel', async ({
  page,
}) => {
  await mount(page);
  await page.locator('#outside').focus();
  await page.keyboard.press('Tab');
  await page
    .locator('.synced-lyrics-vlist')
    .evaluate((el) => (el.scrollTop = 650));
  await page.mouse.move(50, 120);
  await expect.poll(() => top(page)).toBe(100);
  expect(
    await page
      .locator('.lyrics-picker')
      .evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#outside')).toBeFocused();
  await hidden(page);
});
for (const [width, download] of [
  [320, true],
  [320, false],
  [1040, true],
] as const)
  test(`black surface and layout at ${width}px with export ${download}`, async ({
    page,
  }) => {
    await mount(page, width, download);
    await page.mouse.move(250, 120);
    await expect(page.locator('.lyrics-picker')).toHaveCSS(
      'background-color',
      'rgb(0, 0, 0)',
    );
    await expect(page.locator('.lyrics-export')).toHaveCount(download ? 1 : 0);
    expect(
      await page
        .locator('.lyrics-picker')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.lyrics-picker-item').first()).toHaveCSS(
      'transition-duration',
      '0s',
    );
  });
test.describe('touch input', () => {
  test.use({ hasTouch: true });
  test('touch scrolling does not latch hover; scrolling back exposes working controls', async ({
    page,
  }) => {
    await mount(page);
    await page
      .locator('.synced-lyrics-vlist')
      .evaluate((el) => (el.scrollTop = 0));
    await expect.poll(() => top(page)).toBe(100);
    const control = page.locator('.lyrics-export');
    await expect
      .poll(() =>
        control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      )
      .toBe(true);
    const box = (await control.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    expect(await page.evaluate(() => (window as any).exportCalls)).toBe(1);
    await page.locator('.synced-lyrics-vlist').evaluate((el) => {
      el.scrollTop = 900;
      el.dispatchEvent(new Event('scroll'));
    });
    await hidden(page);
    await page
      .locator('.synced-lyrics-vlist')
      .evaluate((el) => (el.scrollTop = 0));
    await expect.poll(() => top(page)).toBe(100);
  });
});
