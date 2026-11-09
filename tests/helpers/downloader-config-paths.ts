import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';

import { deepmerge, deepmergeCustom } from 'deepmerge-ts';
import { Project, ts, type SourceFile } from 'ts-morph';

import type { DownloaderPluginConfig } from '../../src/plugins/downloader';
import type { BackendContext, MenuContext } from '../../src/types/contexts';
import type { downloaderFixture } from './downloader-small-fixture';

type Fixture = Awaited<ReturnType<typeof downloaderFixture>>;
type Raw = Partial<DownloaderPluginConfig>;
type Watcher = (next: unknown, old: unknown) => void;
const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
async function syntax(file: string) {
  const source = await readFile(
    new URL(`../../${file}`, import.meta.url),
    'utf8',
  );
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(
    file,
    source,
  );
}
const compile = (source: string) =>
  stripTypeScriptTypes(source.replace(/^export /gm, ''));
const declaration = (source: SourceFile, name: string) =>
  source
    .getVariableDeclarationOrThrow(name)
    .getVariableStatementOrThrow()
    .getText();
// Only source extracted from this checkout is evaluated, with owned native/storage boundaries.
const evaluate = <T>(source: string, bindings: Record<string, unknown>): T =>
  runInNewContext(source, { ...bindings }) as T;

/** Actual contexts, store setter and watch/IPC handlers; getConfig itself is never replaced. */
export async function downloaderConfigPaths(fixture: Fixture, raw: Raw) {
  const plugin = await syntax('src/plugins/downloader/index.ts');
  const defaults = evaluate<DownloaderPluginConfig>(
    `${compile(declaration(plugin, 'defaultConfig'))};defaultConfig;`,
    { DefaultPresetList: fixture.source.DefaultPresetList },
  );
  const saved = {
    plugins: { downloader: clone(raw), other: { list: ['saved'] } },
  };
  let watcher: Watcher | undefined;
  const store = {
    get: (key: string) => {
      // Conf deserializes a fresh object on reads; callers never share its storage.
      if (key === 'plugins.downloader') return clone(saved.plugins.downloader);
      if (key === 'plugins.other') return clone(saved.plugins.other);
      throw new Error(`Unexpected store read ${key}`);
    },
    set: (key: string, value: Raw) => {
      if (key !== 'plugins.downloader')
        throw new Error(`Unexpected store write ${key}`);
      const old = clone(saved);
      saved.plugins.downloader = clone(value);
      watcher?.(clone(saved), old);
    },
  };
  const configSyntax = await syntax('src/config/index.ts');
  const setter = evaluate<{
    get: (key: string) => unknown;
    setPartial: (key: string, value: unknown, defaults: unknown) => void;
  }>(
    `${compile(['deepmerge', 'setPartial', 'get'].map((name) => declaration(configSyntax, name)).join('\n'))};({get,setPartial});`,
    { deepmergeCustom, store },
  );
  const config = {
    ...setter,
    watch: (callback: Watcher) => {
      watcher = callback;
    },
  };
  const window = fixture.createContext('config-roundtrip').window;
  const registry = {
    downloader: { config: defaults, restartNeeded: false },
    other: { config: { enabled: false, list: ['default'] } },
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      handlers.set(name, callback),
    removeHandler: (name: string) => handlers.delete(name),
    on() {},
    emit() {},
  };
  const contextBindings = {
    deepmerge,
    allPlugins: () => Promise.resolve(registry),
    config,
    ipcMain,
    win: window,
  };
  const main = await syntax('src/loader/main.ts');
  const menu = await syntax('src/loader/menu.ts');
  const backend = evaluate<BackendContext<DownloaderPluginConfig>>(
    `${compile(declaration(main, 'createContext'))};createContext('downloader',win);`,
    contextBindings,
  );
  const menuContext = evaluate<MenuContext<DownloaderPluginConfig>>(
    `${compile(declaration(menu, 'createContext'))};createContext('downloader',win);`,
    contextBindings,
  );
  const app = await syntax('src/index.ts');
  const calls = app.getDescendantsOfKind(ts.SyntaxKind.CallExpression);
  const ipc = calls.filter(
    (call) =>
      call.getExpression().getText() === 'ipcMain.handle' &&
      ['peard:get-config', 'peard:set-config'].includes(
        call.getArguments()[0]?.getText().slice(1, -1),
      ),
  );
  const watches = calls.filter(
    (call) =>
      call.getExpression().getText() === 'config.watch' &&
      call.getArguments()[0]?.getText().includes('newPluginConfigList'),
  );
  if (ipc.length !== 2 || watches.length !== 1)
    throw new Error('Actual config IPC/watch boundary not found');
  const unexpected = () => {
    throw new Error('Unexpected enable/restart during recipe-only write');
  };
  evaluate<void>(
    compile(
      [...ipc, ...watches].map((call) => call.getText() + ';').join('\n'),
    ),
    {
      config,
      ipcMain,
      allPluginStubs: registry,
      deepmerge,
      deepEqual: isDeepStrictEqual,
      configWindow: window,
      getAllLoadedMainPlugins: () => ({
        downloader: { backend: fixture.source.downloader },
      }),
      forceLoadMainPlugin: unexpected,
      forceUnloadMainPlugin: unexpected,
      showNeedToRestartDialog: unexpected,
    },
  );
  return {
    backend,
    menu: menuContext,
    ipcRead: () =>
      handlers.get('peard:get-config')!(
        null,
        'downloader',
      ) as DownloaderPluginConfig,
    ipcWrite: (value: Raw) =>
      handlers.get('peard:set-config')!(null, 'downloader', value),
    raw: () => clone(saved.plugins.downloader),
    unrelatedRead: () =>
      evaluate<BackendContext<{ enabled: boolean; list: string[] }>>(
        `${compile(declaration(main, 'createContext'))};createContext('other',win);`,
        contextBindings,
      ).getConfig(),
  };
}
