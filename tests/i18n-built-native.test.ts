import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { nativeLocale } from './helpers/i18n-built-native';
import {
  assertStartupFacts,
  refreshStartupFacts,
  waitForStartupFacts,
} from './helpers/electron-startup.js';
for (const language of ['en', 'fr-CA'])
  for (const packaged of [false, true])
    test(`actual main ES/preload CJS/remote IIFE ${language} ${packaged ? 'asar' : 'built'}`, async () => {
      test.setTimeout(60000);
      const f = await nativeLocale(language, { packaged });
      try {
        const expected = language === 'en' ? ['en'] : ['en', 'fr'];
        await expect
          .poll(() =>
            f.app.evaluate(() => (globalThis as any).__localeSnapshot?.()),
          )
          .toMatchObject({
            ids: expected,
            resolved: language === 'en' ? 'en' : 'fr',
          });
        const page = await f.app.firstWindow();
        await expect
          .poll(() =>
            page.evaluate(() => ({
              renderer: (window as any).__localeSnapshot?.(),
              preload: (window as any).__preloadLocale?.snapshot(),
            })),
          )
          .toMatchObject({
            renderer: {
              ids: expected,
              resolved: language === 'en' ? 'en' : 'fr',
            },
            preload: {
              ids: expected,
              resolved: language === 'en' ? 'en' : 'fr',
            },
          });
        const proof = await f.app.evaluate(() => {
          const { Menu, BrowserWindow, requests } = (globalThis as any)
            .__nativeLocale;
          const flat = (items: any[]): any[] =>
            items.flatMap((item) => [item, ...flat(item.submenu?.items ?? [])]);
          const languages = flat(Menu.getApplicationMenu().items)
            .filter((item) => item.label?.endsWith('(Language)'))[0]
            .submenu.items.slice(1);
          return {
            labels: languages.map((item: any) => item.label),
            requests,
            visible: BrowserWindow.getAllWindows()[0].isVisible(),
          };
        });
        expect(proof.labels).toHaveLength(67);
        expect(
          proof.labels.filter((label: string) => label === 'Unknown (Unknown)'),
        ).toHaveLength(5);
        expect(
          proof.requests.some((url: string) => /\.json|locale|i18n/.test(url)),
        ).toBe(false);
        expect(proof.visible).toBe(false);
        await f.app.evaluate(() =>
          (
            globalThis as any
          ).__nativeLocale.BrowserWindow.getAllWindows()[0].show(),
        );
        const facts = await waitForStartupFacts(
          f.app.process(),
          `${f.owned}/startup.json`,
        );
        const current = await refreshStartupFacts(
          f.app.process(),
          `${f.owned}/startup.json`,
        );
        await assertStartupFacts(f.app.process(), current, f.profile);
        expect(facts).toBeTruthy();
      } finally {
        await f.close();
      }
    });

test('missing selected main/preload chunks keep English usable without source or network fallback', async () => {
  test.setTimeout(60000);
  const f = await nativeLocale('fr-CA', { missing: true });
  try {
    await expect
      .poll(() =>
        f.app.evaluate(() => (globalThis as any).__localeSnapshot?.()),
      )
      .toMatchObject({ ids: ['en'], resolved: 'en' });
    const page = await f.app.firstWindow();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          renderer: (window as any).__localeSnapshot?.(),
          preload: (window as any).__preloadLocale?.snapshot(),
        })),
      )
      .toMatchObject({
        renderer: { ids: ['en', 'fr'], resolved: 'fr' },
        preload: { ids: ['en'], resolved: 'en' },
      });
  } finally {
    await f.close();
  }
});

test('compiled slow selection from a closed owner cannot publish; replacement reads persisted preference', async () => {
  test.setTimeout(60000);
  const f = await nativeLocale('en');
  try {
    const old = await f.app.firstWindow();
    await expect
      .poll(() =>
        old.evaluate(() => (window as any).__preloadLocale?.snapshot()),
      )
      .toMatchObject({ resolved: 'en' });
    const oldId = await f.app.evaluate(() => {
      const g = globalThis as any;
      g.__holdLocale = true;
      const { Menu, BrowserWindow } = g.__nativeLocale;
      const flat = (items: any[]): any[] =>
        items.flatMap((item) => [item, ...flat(item.submenu?.items ?? [])]);
      const russian = flat(Menu.getApplicationMenu().items).find((item) =>
        item.label.startsWith('Russian ('),
      );
      void russian.click();
      return BrowserWindow.getAllWindows()[0].id;
    });
    await expect
      .poll(() =>
        f.app.evaluate(() => typeof (globalThis as any).__releaseLocale),
      )
      .toBe('function');
    // Closing the last app document can retire Playwright's inspector handles.
    // Schedule the real native close/reopen after this control call returns,
    // then read independent proof emitted by the owned main process.
    await f.app.evaluate(() => {
      setTimeout(() => {
        const { app, BrowserWindow } = (globalThis as any).__nativeLocale;
        BrowserWindow.getAllWindows()[0].destroy();
        app.emit('activate');
        setImmediate(() => (globalThis as any).__releaseLocale());
      }, 25);
    });
    let replacementProof: any;
    await expect
      .poll(async () => {
        replacementProof = await readFile(
          `${f.owned}/native-proof.json`,
          'utf8',
        )
          .then(JSON.parse)
          .catch(() => undefined);
        return replacementProof;
      })
      .toMatchObject({
        snapshot: { ids: ['en', 'ru'], resolved: 'ru' },
        windows: expect.arrayContaining([
          expect.objectContaining({
            url: expect.stringMatching(/^https:\/\/music\./),
            id: expect.any(Number),
          }),
        ]),
        labels: expect.arrayContaining(['Язык (Language)']),
        dialogs: 0,
      });
    const replacement = replacementProof.windows.find((win: any) =>
      win.url.startsWith('https://music.'),
    );
    expect(replacement?.id).toBeTruthy();
    expect(replacement.id).not.toBe(oldId);
    expect(replacementProof.pid).toBe(f.app.process().pid);
    expect(f.app.process().exitCode).toBeNull();
    expect(f.app.process().signalCode).toBeNull();
  } finally {
    await f.close();
  }
});

test('compiled preload and injected IIFE pagehide suppress pending selected-language startup', async () => {
  test.setTimeout(60000);
  const f = await nativeLocale('ru');
  try {
    const page = await f.app.firstWindow();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          renderer: typeof (window as any).__releaseLocale,
          preload: (window as any).__preloadLocale?.pending(),
        })),
      )
      .toEqual({ renderer: 'function', preload: 'function' });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      (window as any).__releaseLocale();
      (window as any).__preloadLocale.release();
    });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          renderer: (window as any).__localeSnapshot(),
          preload: (window as any).__preloadLocale.snapshot(),
        })),
      )
      .toMatchObject({
        renderer: { ids: ['en', 'ru'], language: 'en', events: [] },
        preload: { ids: ['en', 'ru'], language: 'en', events: [] },
      });
  } finally {
    await f.close();
  }
});
