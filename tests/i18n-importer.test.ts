import { expect, test } from '@playwright/test';
import { i18nImporter } from '../vite-plugins/i18n-importer.mts';

function generated(load: (path: string) => Promise<unknown>) {
  const source = i18nImporter();
  return new Function(
    'load',
    `${source.replace(/export const /g, 'const ').replace(/import\(/g, 'load(')}\nreturn {availableLanguages:typeof availableLanguages==='undefined'?undefined:availableLanguages,languageLabels:typeof languageLabels==='undefined'?undefined:languageLabels,loadLanguageResource:typeof loadLanguageResource==='undefined'?undefined:loadLanguageResource,languageResources};`,
  )(load);
}

test('generated catalogue exposes all labels without creating translation objects', () => {
  const calls: string[] = [];
  const module = generated(async (path) => {
    calls.push(path);
    return { default: {} };
  });
  expect(module.availableLanguages).toHaveLength(67);
  expect(module.languageLabels.en).toEqual({
    name: 'English',
    localName: 'English',
  });
  for (const id of ['be-Latn', 'km', 'kmr', 'qu', 'sah'])
    expect(module.languageLabels[id]).toEqual({
      name: 'Unknown',
      localName: 'Unknown',
    });
  expect(calls).toEqual([]);
});

test('generated loader rejects foreign keys, coalesces supported loads and retries failures', async () => {
  const calls: string[] = [];
  let fail = true;
  const module = generated(async (path) => {
    calls.push(path);
    if (path.endsWith('/fr.json') && fail) throw Error('owned failure');
    return { default: { value: path } };
  });
  expect(typeof module.loadLanguageResource).toBe('function');
  for (const id of [
    '__proto__',
    'constructor',
    'toString',
    '../en',
    'fr-CA',
    '',
  ])
    expect(await module.loadLanguageResource(id)).toBeUndefined();
  expect(calls).toEqual([]);
  const a = module.loadLanguageResource('en');
  const b = module.loadLanguageResource('en');
  expect(a).toBe(b);
  expect(await a).toBe(await b);
  expect(calls).toHaveLength(1);
  await expect(module.loadLanguageResource('fr')).rejects.toThrow(
    'owned failure',
  );
  fail = false;
  expect(await module.loadLanguageResource('fr')).toEqual({
    value: expect.stringMatching(/\/fr.json$/),
  });
  expect(calls).toHaveLength(3);
});
