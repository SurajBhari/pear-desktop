import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { ts } from 'ts-morph';

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

// Load the production lifecycle code with an isolated virtual plugin registry.
// No Electron process or real user profile is involved in these tests.
async function createLoader(plugins, registryOverride) {
  const key = `rendererLifecycle_${crypto.randomUUID()}`;
  globalThis[key] = plugins;
  const i18nUrl = moduleUrl('export const t = (key) => key;');
  const utilsSource = stripTypeScriptTypes(
    await readFile(new URL('../src/utils/index.ts', import.meta.url), 'utf8'),
  ).replace("'@/i18n'", JSON.stringify(i18nUrl));
  const registryUrl =
    registryOverride ??
    moduleUrl(
      `export const rendererPlugins = async () => globalThis[${JSON.stringify(key)}];`,
    );
  const loaderSource = stripTypeScriptTypes(
    await readFile(
      new URL('../src/loader/renderer.ts', import.meta.url),
      'utf8',
    ),
  )
    .replace(
      "'deepmerge-ts'",
      JSON.stringify(import.meta.resolve('deepmerge-ts')),
    )
    .replace("'virtual:plugins'", JSON.stringify(registryUrl))
    .replace("'@/i18n'", JSON.stringify(i18nUrl))
    .replace("'@/utils'", JSON.stringify(moduleUrl(utilsSource)));
  const loader = await import(moduleUrl(loaderSource));
  return { loader, dispose: () => delete globalThis[key] };
}

const deferred = () => Promise.withResolvers();

let dom;
let dispose;
test.beforeEach(() => {
  dom = new Window();
  globalThis.document = dom.document;
  globalThis.CSSStyleSheet = dom.CSSStyleSheet;
  globalThis.window = { mainConfig: { plugins: { getPlugins: () => ({}) } } };
});
test.afterEach(async () => {
  dispose?.();
  dispose = undefined;
  delete globalThis.document;
  delete globalThis.CSSStyleSheet;
  delete globalThis.window;
  await dom.happyDOM.close();
});

async function setup(renderer, stylesheets = ['.plugin { color: red; }']) {
  const result = await createLoader({
    example: { config: { enabled: true }, renderer, stylesheets },
  });
  dispose = result.dispose;
  return result.loader;
}

// Keep the real virtual registry's context filter in the path: a CSS-only
// definition without renderer: {} otherwise appears in menus but never loads.
async function createVolumeSliderRegistry() {
  const i18nUrl = moduleUrl('export const t = (key) => key;');
  const utilsSource = stripTypeScriptTypes(
    await readFile(new URL('../src/utils/index.ts', import.meta.url), 'utf8'),
  ).replace("'@/i18n'", JSON.stringify(i18nUrl));
  const css = await readFile(
    new URL(
      '../src/plugins/always-show-volume-slider/style.css',
      import.meta.url,
    ),
    'utf8',
  );
  const pluginSource = stripTypeScriptTypes(
    await readFile(
      new URL(
        '../src/plugins/always-show-volume-slider/index.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  )
    .replace("'@/i18n'", JSON.stringify(i18nUrl))
    .replace("'@/utils'", JSON.stringify(moduleUrl(utilsSource)))
    .replace(
      "'./style.css?inline'",
      JSON.stringify(moduleUrl(`export default ${JSON.stringify(css)};`)),
    );
  const actualPluginUrl = moduleUrl(
    pluginSource + '\nexport const pluginStub = {};',
  );
  const platformSource = ts.transpileModule(
    await readFile(new URL('../src/types/plugins.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext } },
  ).outputText;
  const generatorSource = stripTypeScriptTypes(
    await readFile(
      new URL('../vite-plugins/plugin-importer.mts', import.meta.url),
      'utf8',
    ),
  )
    .replace("'glob'", JSON.stringify(import.meta.resolve('glob')))
    .replace("'ts-morph'", JSON.stringify(import.meta.resolve('ts-morph')))
    .replace(
      "'../src/types/plugins'",
      JSON.stringify(moduleUrl(platformSource)),
    )
    .replace(
      'dirname(fileURLToPath(import.meta.url))',
      JSON.stringify(
        fileURLToPath(new URL('../vite-plugins', import.meta.url)),
      ),
    );
  const { pluginVirtualModuleGenerator } = await import(
    moduleUrl(generatorSource)
  );
  const emptyPluginUrl = moduleUrl(
    'export default {}; export const pluginStub = {};',
  );
  const registrySource = pluginVirtualModuleGenerator('renderer').replace(
    /from "([^"]+)";/g,
    (_match, path) =>
      `from ${JSON.stringify(
        path.endsWith('/always-show-volume-slider/index.ts')
          ? actualPluginUrl
          : emptyPluginUrl,
      )};`,
  );
  return moduleUrl(registrySource);
}

test('volume slider reaches the actual renderer registry and styles cleanly unload', async () => {
  const registryUrl = await createVolumeSliderRegistry();
  const result = await createLoader({}, registryUrl);
  dispose = result.dispose;
  const unrelated = new CSSStyleSheet();
  unrelated.replaceSync('.unrelated { color: blue; }');
  document.adoptedStyleSheets = [unrelated];
  for (let i = 0; i < 3; i++) {
    await result.loader.forceLoadRendererPlugin('always-show-volume-slider');
    expect(document.adoptedStyleSheets).toHaveLength(2);
    expect(document.adoptedStyleSheets[0]).toBe(unrelated);
    await result.loader.forceUnloadRendererPlugin('always-show-volume-slider');
    expect(document.adoptedStyleSheets).toEqual([unrelated]);
  }
});

test('50 enable/disable cycles keep plugin styles bounded and preserve unrelated sheets', async () => {
  const loader = await setup({ start() {}, stop() {} });
  const unrelated = new CSSStyleSheet();
  unrelated.replaceSync('.unrelated { color: blue; }');
  document.adoptedStyleSheets = [unrelated];

  let peak = 0;
  for (let i = 0; i < 50; i++) {
    await loader.forceLoadRendererPlugin('example');
    peak = Math.max(peak, document.adoptedStyleSheets.length);
    await loader.forceUnloadRendererPlugin('example');
    expect(loader.getLoadedRendererPlugin('example')).toBeUndefined();
  }
  console.log(
    `50 cycles: peak=${peak}, disabled=${document.adoptedStyleSheets.length}, unrelated=1`,
  );
  expect(document.adoptedStyleSheets).toHaveLength(1);
  expect(document.adoptedStyleSheets[0]).toBe(unrelated);
  expect(peak).toBe(2);
});

test('duplicate enables start the plugin once', async () => {
  let starts = 0;
  const loader = await setup({
    start() {
      starts++;
    },
    stop() {},
  });
  await Promise.all([
    loader.forceLoadRendererPlugin('example'),
    loader.forceLoadRendererPlugin('example'),
  ]);
  await loader.forceLoadRendererPlugin('example');
  expect(starts).toBe(1);
  expect(document.adoptedStyleSheets).toHaveLength(1);
});

test('duplicate disables stop the plugin once', async () => {
  let stops = 0;
  const loader = await setup({
    start() {},
    stop() {
      stops++;
    },
  });
  await loader.forceLoadRendererPlugin('example');
  await Promise.all([
    loader.forceUnloadRendererPlugin('example'),
    loader.forceUnloadRendererPlugin('example'),
  ]);
  await loader.forceUnloadRendererPlugin('example');
  expect(stops).toBe(1);
});

test('disable during asynchronous start waits and leaves the plugin disabled', async () => {
  const started = deferred();
  const finishStart = deferred();
  const events = [];
  const loader = await setup({
    async start() {
      events.push('start');
      started.resolve();
      await finishStart.promise;
      events.push('started');
    },
    stop() {
      events.push('stop');
    },
  });
  const load = loader.forceLoadRendererPlugin('example');
  await started.promise;
  const unload = loader.forceUnloadRendererPlugin('example');
  finishStart.resolve();
  await Promise.all([load, unload]);
  expect(events).toEqual(['start', 'started', 'stop']);
  expect(document.adoptedStyleSheets).toHaveLength(0);
  expect(loader.getLoadedRendererPlugin('example')).toBeUndefined();
});

test('enable during asynchronous stop waits and leaves exactly one active instance', async () => {
  const stopping = deferred();
  const finishStop = deferred();
  const events = [];
  const loader = await setup({
    start() {
      events.push('start');
    },
    async stop() {
      events.push('stop');
      stopping.resolve();
      await finishStop.promise;
      events.push('stopped');
    },
  });
  await loader.forceLoadRendererPlugin('example');
  const unload = loader.forceUnloadRendererPlugin('example');
  await stopping.promise;
  const load = loader.forceLoadRendererPlugin('example');
  finishStop.resolve();
  await Promise.all([unload, load]);
  expect(events).toEqual(['start', 'stop', 'stopped', 'start']);
  expect(document.adoptedStyleSheets).toHaveLength(1);
  expect(loader.getLoadedRendererPlugin('example')).toBeDefined();
});

test('a failed stop retains ownership until a successful retry', async () => {
  let fail = true;
  const loader = await setup({
    start() {},
    stop() {
      if (fail) throw new Error('cannot stop');
    },
  });
  await loader.forceLoadRendererPlugin('example');
  await loader.forceUnloadRendererPlugin('example');
  expect(loader.getLoadedRendererPlugin('example')).toBeDefined();
  expect(document.adoptedStyleSheets).toHaveLength(1);
  fail = false;
  await loader.forceUnloadRendererPlugin('example');
  expect(loader.getLoadedRendererPlugin('example')).toBeUndefined();
  expect(document.adoptedStyleSheets).toHaveLength(0);
});

test('failed starts do not adopt plugin styles and can retry', async () => {
  let fail = true;
  const loader = await setup({
    start() {
      if (fail) throw new Error('cannot start');
    },
    stop() {},
  });
  await loader.forceLoadRendererPlugin('example');
  expect(loader.getLoadedRendererPlugin('example')).toBeUndefined();
  expect(document.adoptedStyleSheets).toHaveLength(0);
  fail = false;
  await loader.forceLoadRendererPlugin('example');
  expect(document.adoptedStyleSheets).toHaveLength(1);
});

test('unloading all plugins waits for an in-flight start', async () => {
  const started = deferred();
  const finishStart = deferred();
  let stops = 0;
  const loader = await setup({
    async start() {
      started.resolve();
      await finishStart.promise;
    },
    stop() {
      stops++;
    },
  });
  const load = loader.forceLoadRendererPlugin('example');
  await started.promise;
  const unload = loader.unloadAllRendererPlugins();
  finishStart.resolve();
  await Promise.all([load, unload]);
  expect(stops).toBe(1);
  expect(document.adoptedStyleSheets).toHaveLength(0);
});

test('unload preserves sheets adopted by other code after plugin startup', async () => {
  const loader = await setup({ start() {}, stop() {} });
  await loader.forceLoadRendererPlugin('example');
  const unrelated = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, unrelated];
  await loader.forceUnloadRendererPlugin('example');
  expect(document.adoptedStyleSheets).toHaveLength(1);
  expect(document.adoptedStyleSheets[0]).toBe(unrelated);
});

test('styles-only plugins can be enabled and disabled', async () => {
  const loader = await setup(undefined);
  await loader.forceLoadRendererPlugin('example');
  expect(document.adoptedStyleSheets).toHaveLength(1);
  await loader.forceUnloadRendererPlugin('example');
  expect(document.adoptedStyleSheets).toHaveLength(0);
});

test('bulk unload waits for all starts from an already requested bulk load', async () => {
  let finishStart;
  let notifyStart;
  const startGate = new Promise((resolve) => {
    finishStart = resolve;
  });
  const started = new Promise((resolve) => {
    notifyStart = resolve;
  });
  const result = await createLoader({
    a: {
      config: { enabled: true },
      stylesheets: ['.a {}'],
      renderer: {
        async start() {
          notifyStart();
          await startGate;
        },
        stop() {},
      },
    },
    b: {
      config: { enabled: true },
      stylesheets: ['.b {}'],
      renderer: { start() {}, stop() {} },
    },
  });
  dispose = result.dispose;
  const loading = result.loader.loadAllRendererPlugins();
  await started;
  const unloading = result.loader.unloadAllRendererPlugins();
  finishStart();
  await Promise.all([loading, unloading]);
  expect(Object.keys(result.loader.getAllLoadedRendererPlugins())).toEqual([]);
  expect(document.adoptedStyleSheets).toHaveLength(0);
});

test('an enable after bulk unload remains enabled while another plugin stop waits', async () => {
  let finishStop;
  let notifyStop;
  const stopGate = new Promise((resolve) => {
    finishStop = resolve;
  });
  const stopping = new Promise((resolve) => {
    notifyStop = resolve;
  });
  const result = await createLoader({
    a: {
      config: { enabled: true },
      renderer: {
        start() {},
        async stop() {
          notifyStop();
          await stopGate;
        },
      },
    },
    b: {
      config: { enabled: true },
      stylesheets: ['.b {}'],
      renderer: { start() {}, stop() {} },
    },
  });
  dispose = result.dispose;
  await result.loader.loadAllRendererPlugins();
  const unloading = result.loader.unloadAllRendererPlugins();
  await stopping;
  const enabling = result.loader.forceLoadRendererPlugin('b');
  finishStop();
  await Promise.all([unloading, enabling]);
  expect(result.loader.getLoadedRendererPlugin('b')).toBeDefined();
  expect(document.adoptedStyleSheets).toHaveLength(1);
});

test('bulk unload requested before registry resolution drains the earlier bulk load', async () => {
  const result = await createLoader({
    a: {
      config: { enabled: true },
      stylesheets: ['.a {}'],
      renderer: { start() {}, stop() {} },
    },
    b: {
      config: { enabled: true },
      stylesheets: ['.b {}'],
      renderer: { start() {}, stop() {} },
    },
  });
  dispose = result.dispose;
  await Promise.all([
    result.loader.loadAllRendererPlugins(),
    result.loader.unloadAllRendererPlugins(),
  ]);
  expect(Object.keys(result.loader.getAllLoadedRendererPlugins())).toEqual([]);
  expect(document.adoptedStyleSheets).toHaveLength(0);
});
