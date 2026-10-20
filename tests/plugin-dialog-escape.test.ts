import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { build } from 'vite';
import solid from 'vite-plugin-solid';

// Exercise the actual modal owners, replacing only app/IPC boundaries.
async function dialogBundle() {
  const root = path.resolve(import.meta.dirname, '..');
  const temp = await mkdtemp(path.join(root, '.tmp-dialog-escape-'));
  try {
    const entry = path.join(temp, 'entry.ts');
    await writeFile(
      entry,
      `
      import { openEqualizerPanel } from '@/plugins/equalizer/panel';
      import { defaultConfig, flatProfile } from '@/plugins/equalizer/config';
      import { onRendererLoad, onRendererStop } from '@/plugins/downloader/renderer';
      const listeners = new Map();
      let panel;
      const ipc = {
        subscribe: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
        invoke: async event => event === 'downloader-settings' ? {config: {enabled: true, selectedPreset: 'Source', customPresetSetting: {extension: 'flac', ffmpegArgs: []}, skipExisting: false}} : {},
      };
      export function start() { onRendererLoad({ipc}); }
      export function open(kind) {
        if (kind === 'equalizer') panel = openEqualizerPanel(() => ({...defaultConfig, schemaVersion: 2, profile: flatProfile('graphic-8')}), () => {}, () => {}, () => 48000);
        else return listeners.get('downloader-open-settings')();
      }
      export function stop() { panel?.dispose(); onRendererStop(); }
    `,
    );
    const mocks: Record<string, string> = {
      '@/i18n': 'export const t = key => key;',
      '@/config/defaults':
        'export const defaultConfig = {url: "https://music.youtube.com"};',
      '@/providers/dom-elements': 'export const getSongMenu = () => null;',
      '@/providers/song-info-front':
        'export const getSongInfo = () => ({url: ""});',
    };
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          ...Object.keys(mocks).map((find) => ({
            find,
            replacement: `\0${find}`,
          })),
          { find: '@', replacement: path.join(root, 'src') },
        ],
      },
      plugins: [
        {
          name: 'app-boundaries',
          enforce: 'pre',
          resolveId: (id) => (id in mocks ? `\0${id}` : undefined),
          load: (id) => mocks[id.slice(1)],
        },
        solid(),
      ],
      build: {
        write: false,
        lib: { entry, formats: ['iife'], name: 'DialogFixture' },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!('output' in output)) throw Error('No modal bundle');
    const chunk = output.output.find((item) => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw Error('No modal script');
    return chunk.code;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('https://dialog.fixture.invalid/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="outside">Outside</button>',
    }),
  );
  await page.goto('https://dialog.fixture.invalid/');
  await page.evaluate(() => {
    (window as any).siteKeys = [];
    // YouTube Music's document handler prevents native dialog cancellation.
    document.addEventListener('keydown', (event) => {
      (window as any).siteKeys.push(event.key);
      if (event.key === 'Escape') event.preventDefault();
    });
    document.querySelector<HTMLButtonElement>('#outside')!.focus();
  });
  await page.addScriptTag({ content: await dialogBundle() });
  await page.evaluate(() => (window as any).DialogFixture.start());
});

for (const kind of ['equalizer', 'downloader']) {
  test(`${kind} dismisses with Escape despite the site's document shortcut and restores focus`, async ({
    page,
  }) => {
    await page.evaluate(
      (kind) => (window as any).DialogFixture.open(kind),
      kind,
    );
    await expect(page.locator('dialog')).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog')).toHaveCount(0);
    await expect(page.locator('#outside')).toBeFocused();
    expect(await page.evaluate(() => (window as any).siteKeys)).toEqual([
      'Tab',
    ]);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).siteKeys)).toEqual([
      'Tab',
      'Escape',
    ]);
  });

  test(`${kind} keeps IME and local control Escape handling intact`, async ({
    page,
  }) => {
    await page.evaluate(
      (kind) => (window as any).DialogFixture.open(kind),
      kind,
    );
    const dialog = page.locator('dialog');
    await dialog.dispatchEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      isComposing: true,
    });
    expect(await page.evaluate(() => (window as any).siteKeys)).toEqual([
      'Escape',
    ]);
    await dialog.evaluate((node) => {
      const input = document.createElement('input');
      input.id = 'local-control';
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') event.preventDefault();
      });
      node.append(input);
      input.focus();
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => (window as any).siteKeys)).toEqual([
      'Escape',
    ]);
    await page.locator('#local-control').evaluate((node) => node.remove());
    await dialog.locator('button').first().focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test(`${kind} preserves native select popup cancellation behavior`, async ({
    page,
    context,
  }, testInfo) => {
    // Chromium versions/platforms differ: this installed headless browser also
    // cancels a bare native dialog on the first Escape from an open select.
    // Compare against a native reference with neither plugin nor site handler.
    const reference = await context.newPage();
    let nativeDialogOpen: boolean;
    try {
      await reference.setContent(
        '<dialog><select><option>A</option><option>B</option></select></dialog>',
      );
      await reference
        .locator('dialog')
        .evaluate((node) => (node as HTMLDialogElement).showModal());
      await reference.locator('select').click();
      await expect(reference.locator('select:open')).toHaveCount(1);
      await reference.keyboard.press('Escape');
      nativeDialogOpen = await reference
        .locator('dialog')
        .evaluate((node) => (node as HTMLDialogElement).open);
      await testInfo.attach('native-select-reference.json', {
        body: JSON.stringify({ nativeDialogOpen }),
        contentType: 'application/json',
      });
    } finally {
      await reference.close();
    }
    await page.evaluate(
      (kind) => (window as any).DialogFixture.open(kind),
      kind,
    );
    await page.locator('dialog select').first().click();
    await expect(page.locator('select:open')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(
      nativeDialogOpen ? 1 : 0,
    );
    if (nativeDialogOpen) await page.keyboard.press('Escape');
    await expect(page.locator('dialog')).toHaveCount(0);
  });

  test(`${kind} preserves a nested native dialog and only dismisses the top modal`, async ({
    page,
  }) => {
    await page.evaluate(
      (kind) => (window as any).DialogFixture.open(kind),
      kind,
    );
    await page.locator('dialog').evaluate((node) => {
      const child = document.createElement('dialog');
      child.id = 'child';
      child.innerHTML = '<button>Nested action</button>';
      node.append(child);
      child.showModal();
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('#child')).not.toBeVisible();
    await expect(page.locator('dialog').first()).toBeVisible();
    await page.locator('#child').evaluate((node) => node.remove());
    await page.evaluate(
      (kind) =>
        (window as any).DialogFixture.open(
          kind === 'equalizer' ? 'downloader' : 'equalizer',
        ),
      kind,
    );
    await expect(page.locator('dialog[open]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(
      page.locator(
        kind === 'equalizer' ? '.eq-panel' : '.pear-downloader-settings',
      ),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog')).toHaveCount(0);
  });

  test(`${kind} releases Escape isolation when stopped`, async ({ page }) => {
    await page.evaluate(
      (kind) => (window as any).DialogFixture.open(kind),
      kind,
    );
    await page.evaluate(() => {
      (window as any).oldDialog = document.querySelector('dialog');
      (window as any).DialogFixture.stop();
    });
    await expect(page.locator('dialog')).toHaveCount(0);
    await expect(page.locator('#outside')).toBeFocused();
    // A retained/reused old node must not retain the plugin's key listener.
    await page.evaluate(() => {
      const old = (window as any).oldDialog as HTMLDialogElement;
      document.body.append(old);
      old.showModal();
    });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).siteKeys)).toEqual([
      'Escape',
    ]);
  });
}

test('downloader stop disposes its owner before an immediate restart opens a new modal', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const fixture = (window as any).DialogFixture;
    await fixture.open('downloader');
    fixture.stop();
    fixture.start();
    await fixture.open('downloader');
  });
  await expect(page.locator('dialog header')).toBeVisible();
  // Allow the old dialog's queued native close event to run.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator('dialog header')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
});
