import { expect, test } from '@playwright/test';
import {
  deferred,
  flush,
  javascript,
  parsed,
  source,
} from './helpers/i18n-source-fragments';

test('first-launch OS discovery uses exact catalogue membership without loading translations', async () => {
  const declaration = parsed('index.ts')
    .getVariableDeclarationOrThrow('getDefaultLocale')
    .getInitializerOrThrow()
    .getText();
  let loads = 0;
  const fn = new Function(
    'availableLanguages',
    'languageResources',
    ` ${javascript(`const f=${declaration};`)} return f;`,
  )(['en', 'fr'], async () => {
    loads++;
    return { en: {}, fr: {} };
  });
  expect(await fn('fr')).toBe('fr');
  expect(await fn('fr-CA')).toBeNull();
  expect(await fn('constructor')).toBeNull();
  expect(loads).toBe(0);
});

for (const name of ['preload.ts', 'renderer.ts'])
  for (const phase of ['english', 'selected'])
    test(`${name} retirement during ${phase} prevents translated/plugin startup`, async () => {
      const text = source(name);
      const start = text.indexOf('let languageDocumentActive');
      const lifetime =
        start < 0 ? '' : text.slice(start, text.indexOf('\n\n', start));
      const gate = deferred();
      let plugins = 0,
        elements = 0,
        activation = 0;
      const listeners = new Map<string, () => void>();
      const window = {
        addEventListener: (event: string, fn: () => void) =>
          listeners.set(event, fn),
        mainConfig: { get: () => 'fr' },
      };
      const init =
        name === 'preload.ts'
          ? text.slice(
              text.indexOf('loadI18n().then'),
              text.indexOf("\nipcRenderer.on('plugin:unload'"),
            )
          : `const preload=${parsed(name).getVariableDeclarationOrThrow('preload').getInitializerOrThrow().getText()};\n${text.slice(text.lastIndexOf('initObserver()'))}`;
      const run = new Function(
        'window',
        'document',
        'navigator',
        'config',
        'loadI18n',
        'setLanguage',
        'retireLanguageRequests',
        'loadAllPreloadPlugins',
        'definePearTransElements',
        'i18t',
        'i18next',
        'initObserver',
        'main',
        javascript(`${lifetime}\n${init}`),
      );
      run(
        window,
        { body: {} },
        { userAgent: 'fixture' },
        { get: () => 'fr' },
        () => (phase === 'english' ? gate.promise : Promise.resolve()),
        async (_lang: string, current?: () => boolean) => {
          if (phase === 'selected') await gate.promise;
          if (!current || current()) activation++;
        },
        () => {},
        () => {
          plugins++;
        },
        () => {
          elements++;
        },
        () => {},
        {},
        () => Promise.resolve(),
        () => {
          plugins++;
        },
      );
      await flush();
      listeners.get('pagehide')?.();
      gate.resolve();
      await flush();
      expect(plugins).toBe(0);
      expect(elements).toBe(0);
      expect(activation).toBe(0);
    });

test('replacement window reconciles persisted language before translated hooks', () => {
  const text = parsed('index.ts')
    .getFunctionOrThrow('createMainWindow')
    .getBodyText()!;
  expect(text.indexOf('await setLanguage(')).toBeGreaterThan(
    text.indexOf('new BrowserWindow('),
  );
  expect(text.indexOf('await setLanguage(')).toBeLessThan(
    text.indexOf('await initHook(win)'),
  );
});

for (const name of ['preload.ts', 'renderer.ts'])
  test(`${name} valid hidden document completes translated/plugin startup`, async () => {
    const text = source(name);
    const start = text.indexOf('let languageDocumentActive');
    const lifetime = text.slice(start, text.indexOf('\n\n', start));
    let plugins = 0,
      elements = 0;
    const window = { addEventListener() {}, mainConfig: { get: () => 'fr' } };
    const init =
      name === 'preload.ts'
        ? text.slice(
            text.indexOf('loadI18n().then'),
            text.indexOf("\nipcRenderer.on('plugin:unload'"),
          )
        : `const preload=${parsed(name).getVariableDeclarationOrThrow('preload').getInitializerOrThrow().getText()};\n${text.slice(text.lastIndexOf('initObserver()'))}`;
    new Function(
      'window',
      'document',
      'navigator',
      'config',
      'loadI18n',
      'setLanguage',
      'retireLanguageRequests',
      'loadAllPreloadPlugins',
      'definePearTransElements',
      'i18t',
      'i18next',
      'initObserver',
      'main',
      javascript(`${lifetime}\n${init}`),
    )(
      window,
      { body: {}, hidden: true },
      { userAgent: 'fixture' },
      { get: () => 'fr' },
      () => Promise.resolve(),
      () => Promise.resolve(),
      () => {},
      () => {
        plugins++;
      },
      () => {
        elements++;
      },
      () => {},
      {},
      () => Promise.resolve(),
      () => {
        plugins++;
      },
    );
    await flush();
    expect(plugins).toBe(1);
    expect(elements).toBe(name === 'renderer.ts' ? 1 : 0);
  });

test('replacement activation publishes a newly owned menu and discards closed creation results', () => {
  const activation =
    parsed('index.ts')
      .getDescendantsOfKind(213)
      .find((node) => node.getText().startsWith("app.on('activate'"))
      ?.getText() ??
    source('index.ts').slice(
      source('index.ts').indexOf("app.on('activate'"),
      source('index.ts').indexOf('const getDefaultLocale'),
    );
  expect(activation).toContain('refreshMenu(');
  expect(activation).toContain('isDestroyed()');
});
