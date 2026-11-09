import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';
import Conf from 'conf';

import {
  defaultAPIServerConfig,
  type APIServerConfig,
} from '../src/plugins/api-server/config';

const fixtureWindow = () =>
  Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { send: () => {}, isDestroyed: () => false },
  });

const root = path.resolve('.');
const requireRoot = createRequire(path.join(root, 'package.json'));

type FixtureRolldown = {
  rolldown: (options: {
    input: string;
    platform: 'node';
    plugins?: {
      name: string;
      resolveId(id: string): { id: string; external: true } | undefined;
    }[];
  }) => Promise<{
    write(options: { file: string; format: 'cjs' | 'es' }): Promise<void>;
    close(): Promise<void>;
  }>;
};

async function loadRolldown() {
  const requireVite = createRequire(requireRoot.resolve('vite'));
  const rolldownUrl = pathToFileURL(requireVite.resolve('rolldown')).href;
  const loadedRolldown: unknown = await import(rolldownUrl);
  return loadedRolldown as FixtureRolldown;
}

async function makeTestDirectory(prefix: string) {
  return mkdtemp(path.join(root, 'tests', prefix));
}

async function buildActualInitHook(directory: string) {
  const indexSource = await readFile(path.join(root, 'src/index.ts'), 'utf8');
  const initHookStart = indexSource.indexOf('const initHook = async');
  const initHookEnd = indexSource.indexOf(
    '\n\nconst showNeedToRestartDialog',
    initHookStart,
  );
  const initHookSource = indexSource
    .slice(indexSource.indexOf('let configIpcRegistered'), initHookEnd)
    .replace('const initHook = async', 'export const initHook = async');
  const configSource = (
    await readFile(path.join(root, 'src/config/index.ts'), 'utf8')
  )
    .replace(
      "import { restart } from '@/providers/app-controls';",
      "import { restart } from './restart';",
    )
    .replace("export { defaultConfig } from './defaults';", '')
    .replace("export * as plugins from './plugins';", '');

  await writeFile(path.join(directory, 'config-actual.ts'), configSource);
  await writeFile(
    path.join(directory, 'restart.ts'),
    'export const restart = () => {};',
  );
  await writeFile(
    path.join(directory, 'store.ts'),
    `const fixture = globalThis.__pearApiServerConfigFixture;
export const fixtureEvents = fixture.events;
export const store = fixture.store;
`,
  );
  const apiConfigPath = path.join(root, 'src/plugins/api-server/config.ts');
  await writeFile(
    path.join(directory, 'entry.ts'),
    `import * as config from './config-actual.ts';
import {defaultAPIServerConfig} from ${JSON.stringify(apiConfigPath)};
import {deepmerge} from 'deepmerge-ts';
import {deepEqual} from 'fast-equals';
import {fixtureEvents} from './store.ts';
const handlers = {};
const ipcMain = {handle: (name, listener) => {handlers[name] = listener;}, emit: () => {}};
const allPlugins = async () => ({'api-server': {config: defaultAPIServerConfig}});
const forceLoadMainPlugin = () => {};
const forceUnloadMainPlugin = () => {};
const getAllLoadedMainPlugins = () => ({});
const showNeedToRestartDialog = () => {};
${initHookSource}
export { fixtureEvents, handlers, defaultAPIServerConfig };
export {store} from './store.ts';
`,
  );

  const rolldownModule = await loadRolldown();
  const bundle = await rolldownModule.rolldown({
    input: path.join(directory, 'entry.ts'),
    platform: 'node',
    plugins: [
      {
        name: 'fixture-package-resolver',
        resolveId(id: string) {
          if (
            !id.startsWith('.') &&
            !path.isAbsolute(id) &&
            !id.startsWith('\0')
          ) {
            return { id, external: true };
          }
        },
      },
    ],
  });
  const output = path.join(directory, 'actual-init-hook.cjs');
  await bundle.write({ file: output, format: 'cjs' });
  await bundle.close();
  const fixtureEvents: string[] = [];
  const store = new Conf({ cwd: directory, configName: 'config' });
  const originalSet = store.set.bind(store);
  Reflect.set(store, 'set', (...args: unknown[]) => {
    fixtureEvents.push('set');
    Reflect.apply(originalSet, store, args);
  });
  const originalWatch = store.onDidAnyChange.bind(store);
  Reflect.set(store, 'onDidAnyChange', (...args: unknown[]) => {
    fixtureEvents.push('watch');
    return Reflect.apply(originalWatch, store, args);
  });
  const globals = globalThis as typeof globalThis & {
    __pearApiServerConfigFixture?: { store: Conf; events: string[] };
  };
  const previousFixture = globals.__pearApiServerConfigFixture;
  globals.__pearApiServerConfigFixture = { store, events: fixtureEvents };
  try {
    return requireRoot(output) as {
      initHook: (win: unknown) => Promise<void>;
      fixtureEvents: string[];
      handlers: Record<string, (...args: unknown[]) => unknown>;
      defaultAPIServerConfig: APIServerConfig;
      store: Conf;
    };
  } finally {
    if (previousFixture === undefined)
      delete globals.__pearApiServerConfigFixture;
    else globals.__pearApiServerConfigFixture = previousFixture;
  }
}

test('API server defaults bind locally and use a persistent strong secret', async () => {
  expect(defaultAPIServerConfig.hostname).toBe('127.0.0.1');
  expect(defaultAPIServerConfig.secret).toMatch(/^[a-f0-9]{64}$/);

  const directory = await makeTestDirectory('.pear-api-config-');
  try {
    const source = await buildActualInitHook(directory);
    await source.initHook(fixtureWindow());
    const reopened = new Conf({ cwd: directory, configName: 'config' });
    const persisted = reopened.get('plugins.api-server') as APIServerConfig;

    expect(source.fixtureEvents).toEqual(['set', 'watch', 'watch']);
    expect(persisted.hostname).toBe('127.0.0.1');
    expect(persisted.secret).toBe(source.defaultAPIServerConfig.secret);
    expect(reopened.get('plugins.api-server')).toEqual(persisted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved API server settings survive default materialization and reopen', async () => {
  const directory = await makeTestDirectory('.pear-api-saved-');
  const saved = {
    hostname: '192.0.2.44',
    secret: 'existing-secret',
    authorizedClients: ['client-one'],
    authStrategy: 'NONE',
  };
  try {
    const options = { cwd: directory, configName: 'config' };
    const firstStore = new Conf(options);
    firstStore.set('plugins.api-server', saved);
    const source = await buildActualInitHook(directory);
    await source.initHook(fixtureWindow());

    const reopened = new Conf(options);
    const result = reopened.get('plugins.api-server') as APIServerConfig;
    expect(source.fixtureEvents).toEqual(['watch', 'watch']);
    expect(result.hostname).toBe(saved.hostname);
    expect(result.secret).toBe(saved.secret);
    expect(result.authorizedClients).toEqual(saved.authorizedClients);
    expect(result.authStrategy).toBe(saved.authStrategy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing secret materialization preserves every saved API setting', async () => {
  const directory = await makeTestDirectory('.pear-api-partial-');
  const saved = {
    enabled: true,
    hostname: '192.0.2.44',
    port: 26539,
    authStrategy: 'NONE',
    authorizedClients: ['client-one'],
  };
  try {
    const store = new Conf({ cwd: directory, configName: 'config' });
    store.set('plugins.api-server', saved);
    const source = await buildActualInitHook(directory);
    await source.initHook(fixtureWindow());
    const reopened = new Conf({ cwd: directory, configName: 'config' });
    const merged = reopened.get('plugins.api-server') as APIServerConfig;

    expect(source.fixtureEvents).toEqual(['set', 'watch', 'watch']);
    expect(merged.secret).toBe(source.defaultAPIServerConfig.secret);
    expect(merged.enabled).toBe(saved.enabled);
    expect(merged.hostname).toBe(saved.hostname);
    expect(merged.port).toBe(saved.port);
    expect(merged.authStrategy).toBe(saved.authStrategy);
    expect(merged.authorizedClients).toEqual(saved.authorizedClients);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new profiles receive distinct API server secrets', async () => {
  const directory = await makeTestDirectory('.pear-api-module-');
  try {
    const compiled = path.join(directory, 'config.mjs');
    const bundle = await (
      await loadRolldown()
    ).rolldown({
      input: path.join(root, 'src/plugins/api-server/config.ts'),
      platform: 'node',
    });
    await bundle.write({ file: compiled, format: 'es' });
    await bundle.close();
    const moduleUrl = pathToFileURL(compiled).href;
    const originalNow = Date.now;
    try {
      Date.now = () => 0;
      const first = (await import(`${moduleUrl}?profile=one`)) as {
        defaultAPIServerConfig: APIServerConfig;
        store: Conf;
      };
      const second = (await import(`${moduleUrl}?profile=two`)) as {
        defaultAPIServerConfig: APIServerConfig;
        store: Conf;
      };

      expect(first.defaultAPIServerConfig.secret).not.toBe(
        second.defaultAPIServerConfig.secret,
      );
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared-link option updates the current window only and releases its config subscription on close', async () => {
  const directory = await makeTestDirectory('.pear-share-option-');
  try {
    const source = await buildActualInitHook(directory);
    const win = fixtureWindow();
    const sent: unknown[][] = [];
    win.webContents.send = (...args: unknown[]) => {
      sent.push(args);
    };
    await source.initHook(win);
    const store = source.store;
    store.set('options.stripMusicFromSharedLinks', true);
    await expect
      .poll(() => sent)
      .toEqual([['peard:strip-music-from-shared-links', true]]);
    store.set('options.unrelatedFixtureOption', true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    store.set('options.stripMusicFromSharedLinks', false);
    await expect
      .poll(() => sent)
      .toEqual([
        ['peard:strip-music-from-shared-links', true],
        ['peard:strip-music-from-shared-links', false],
      ]);
    win.emit('closed');
    store.set('options.stripMusicFromSharedLinks', true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('window retirement during async plugin discovery never installs a shared-link watcher', async () => {
  const directory = await makeTestDirectory('.pear-share-retired-');
  try {
    const source = await buildActualInitHook(directory);
    const win = fixtureWindow();
    const starting = source.initHook(win);
    win.isDestroyed = () => true;
    win.webContents.isDestroyed = () => true;
    win.emit('closed');
    await starting;
    expect(win.listenerCount('closed')).toBe(0);
    // The parent locale lifecycle retires before persisting config or installing watchers.
    expect(source.fixtureEvents).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote fields default off without an audience and saved explicit resource survives actual config initialization', async () => {
  expect(defaultAPIServerConfig.musicApiRemoteEnabled).toBe(false);
  expect(Object.hasOwn(defaultAPIServerConfig, 'musicApiRemoteResource')).toBe(
    false,
  );
  const directory = await makeTestDirectory('.pear-api-remote-config-');
  const saved = {
    hostname: '127.0.0.1',
    port: 26538,
    secret: 'public-fixture-existing-secret',
    authorizedClients: ['legacy-owned-client'],
    authStrategy: 'NONE',
    musicApiEnabled: true,
    musicApiRemoteEnabled: true,
    musicApiRemoteResource:
      'http://music-http.fixture.invalid:26538/api/v1/music',
  };
  try {
    const options = { cwd: directory, configName: 'config' };
    new Conf(options).set('plugins.api-server', saved);
    const source = await buildActualInitHook(directory);
    await source.initHook(fixtureWindow());
    const reopened = new Conf(options);
    expect(reopened.get('plugins.api-server')).toEqual(saved);
    expect(source.fixtureEvents).toEqual(['watch', 'watch']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
