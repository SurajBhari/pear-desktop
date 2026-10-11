import { readFile } from 'node:fs/promises';
import { Project, ts } from 'ts-morph';
import { isDeepStrictEqual } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
import { deepmerge, deepmergeCustom } from 'deepmerge-ts';
import { defaultConfig } from '../../src/plugins/equalizer/config';

async function statements(file: string, name: string) {
  const source = await readFile(
    new URL(`../../${file}`, import.meta.url),
    'utf8',
  );
  let found: string | undefined;
  if (name === 'deepmerge')
    found = source.match(
      /const deepmerge = deepmergeCustom\([\s\S]*?\n\}\);/,
    )?.[0];
  else if (name === 'setPartial')
    found = source.match(/export const setPartial = \([\s\S]*?\n\};/)?.[0];
  else if (name === 'createContext')
    found = source.match(/const createContext = \([\s\S]*?\n\}\);/)?.[0];
  else if (name === 'ipc' || name === 'watch') {
    const syntax = new Project({
      useInMemoryFileSystem: true,
    }).createSourceFile(file, source);
    const calls = syntax.getDescendantsOfKind(ts.SyntaxKind.CallExpression);
    const wanted = calls.filter((call) =>
      name === 'watch'
        ? call.getExpression().getText() === 'config.watch'
        : call.getExpression().getText() === 'ipcMain.handle' &&
          ['peard:get-config', 'peard:set-config'].includes(
            call.getArguments()[0]?.getText().slice(1, -1),
          ),
    );
    if (wanted.length === (name === 'watch' ? 1 : 2))
      found = wanted.map((call) => call.getText() + ';').join('\n');
  }
  if (!found) throw new Error(`Actual ${file} ${name} statement not found`);
  return [found];
}
function compile(source: string) {
  return stripTypeScriptTypes(source.replace(/export\s+/g, ''));
}

/** Extracts actual app handler/setter/context bodies, replacing only the Electron/store boundary. */
export async function configPaths() {
  let saved: any = {};
  let watcher: (next: unknown, old: unknown) => void;
  const reads: any[] = [];
  const store = {
    get: () => saved,
    set: (_key: string, value: unknown) => {
      const old = saved;
      saved = value;
      watcher?.(
        { plugins: { equalizer: saved } },
        { plugins: { equalizer: old } },
      );
    },
  };
  const mergeDeclaration = await statements('src/config/index.ts', 'deepmerge');
  const setterDeclaration = await statements(
    'src/config/index.ts',
    'setPartial',
  );
  const setter = new Function(
    'deepmergeCustom',
    'store',
    `${compile([...mergeDeclaration, ...setterDeclaration].join('\n'))};return setPartial;`,
  )(deepmergeCustom, store);
  const config = {
    get: store.get,
    setPartial: setter,
    watch: (callback: typeof watcher) => {
      watcher = callback;
    },
  };
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args: unknown[]) => {
        if (args[0] === 'config-changed') reads.push(args[2]);
      },
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipcMain = {
    handle: (name: string, callback: (...args: any[]) => any) =>
      handlers.set(name, callback),
    emit: () => {},
  };
  const ipc = await statements('src/index.ts', 'ipc');
  const watch = await statements('src/index.ts', 'watch');
  const stubs = { equalizer: { config: defaultConfig, restartNeeded: false } };
  const noop = () => {};
  new Function(
    'config',
    'ipcMain',
    'allPluginStubs',
    'deepmerge',
    'deepEqual',
    'win',
    'forceLoadMainPlugin',
    'forceUnloadMainPlugin',
    'showNeedToRestartDialog',
    'getAllLoadedMainPlugins',
    compile(['const configWindow=win;', ...ipc, ...watch].join(';\n')),
  )(
    config,
    ipcMain,
    stubs,
    deepmerge,
    isDeepStrictEqual,
    win,
    noop,
    noop,
    noop,
    () => ({}),
  );
  const menuCode = (
    await statements('src/loader/menu.ts', 'createContext')
  ).join('\n');
  const menu = new Function(
    'config',
    'allPlugins',
    'deepmerge',
    'setApplicationMenu',
    `${compile(menuCode)};return createContext('equalizer', arguments[4]);`,
  )(config, async () => stubs, deepmerge, noop, win);
  return {
    ipcRead: () => handlers.get('peard:get-config')!(null, 'equalizer'),
    ipcWrite: (value: unknown) =>
      handlers.get('peard:set-config')!(null, 'equalizer', value),
    menu,
    reads,
    raw: () => saved,
  };
}
