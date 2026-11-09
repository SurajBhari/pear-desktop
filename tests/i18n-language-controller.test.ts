import { expect, test } from '@playwright/test';
import { createInstance } from 'i18next';
import {
  createLanguageController,
  type TranslationResource,
} from '../src/i18n/language-controller';
const resources: Record<string, TranslationResource> = {
  en: { label: 'Language', fallback: 'English fallback' },
  fr: { label: 'Langue' },
  ru: { label: 'Язык' },
  'be-Latn': { label: 'Latin' },
  be: { fallback: 'Belarusian' },
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('English bootstrap coalesces and regional/script hierarchy uses actual i18next', async () => {
  const engine = createInstance();
  const loads: string[] = [];
  const controller = createLanguageController(
    engine,
    async (id) => {
      loads.push(id);
      return resources[id];
    },
    Object.keys(resources),
  );
  await Promise.all([controller.initialize(), controller.initialize()]);
  expect(loads).toEqual(['en']);
  expect(Object.keys(engine.store.data)).toEqual(['en']);
  await controller.setLanguage('fr-CA');
  expect(engine.resolvedLanguage).toBe('fr');
  expect(engine.t('label')).toBe('Langue');
  expect(engine.t('fallback')).toBe('English fallback');
  expect(loads).toEqual(['en', 'fr']);
  await controller.setLanguage('be-Latn');
  expect(engine.t('fallback')).toBe('Belarusian');
  expect(loads).toEqual(['en', 'fr', 'be-Latn', 'be']);
  await controller.setLanguage('__proto__');
  await controller.setLanguage('constructor');
  expect(loads).toHaveLength(4);
});

test('latest request and caller retirement prevent late activation while retaining resources', async () => {
  const engine = createInstance();
  let resolve!: (resource: TranslationResource) => void;
  let active = true;
  const controller = createLanguageController(
    engine,
    (id) =>
      id === 'ru'
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve(resources[id]),
    Object.keys(resources),
  );
  await controller.initialize();
  const old = controller.setLanguage('ru');
  await flush();
  await controller.setLanguage('fr');
  resolve(resources.ru);
  await old;
  expect(engine.language).toBe('fr');
  expect(engine.hasResourceBundle('ru', 'translation')).toBe(true);
  active = false;
  await controller.setLanguage('ru', () => active);
  expect(engine.language).toBe('fr');
  active = true;
  const retired = controller.setLanguage('ru');
  controller.retirePending();
  await retired;
  expect(engine.language).toBe('fr');
});

test('failed selected bundle falls back and retries; missing English bootstrap can be retried', async () => {
  const engine = createInstance();
  let failEn = true,
    failFr = true;
  const loads: string[] = [];
  const controller = createLanguageController(
    engine,
    async (id) => {
      loads.push(id);
      if ((id === 'en' && failEn) || (id === 'fr' && failFr))
        throw Error('owned missing');
      return resources[id];
    },
    ['en', 'fr'],
  );
  await expect(controller.initialize()).rejects.toThrow();
  failEn = false;
  await controller.initialize();
  await controller.setLanguage('fr');
  expect(engine.t('label')).toBe('Language');
  failFr = false;
  await controller.setLanguage('fr');
  expect(engine.t('label')).toBe('Langue');
  expect(loads).toEqual(['en', 'en', 'fr', 'fr']);
});

test('a reentrant final caller guard cannot activate after retiring its request', async () => {
  const engine = createInstance();
  const controller = createLanguageController(
    engine,
    async (id) => resources[id],
    Object.keys(resources),
  );
  await controller.initialize();
  const changed: string[] = [];
  engine.on('languageChanged', (language) => changed.push(language));
  let checks = 0;
  await controller.setLanguage('ru', () => {
    if (++checks === 2) controller.retirePending();
    return true;
  });
  expect(engine.language).toBe('en');
  expect(changed).toEqual([]);
  expect(engine.hasResourceBundle('ru', 'translation')).toBe(true);
});
