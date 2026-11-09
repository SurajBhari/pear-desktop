import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const source = async (name: string) =>
  stripTypeScriptTypes(
    await readFile(path.join(root, 'src/providers', `${name}.ts`), 'utf8'),
  );
const moduleURL = (text: string) =>
  `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;

for (const replacement of ['same document', 'new document']) {
  test(`an older stop cannot remove restarted ${replacement} binding while tracker rebuild is pending`, async () => {
    const documentsURL = moduleURL(await source('blocker-documents'));
    const { reloadBlockerDocuments } = await import(documentsURL);
    const { createOwnedBlocker } = await import(
      moduleURL(await source('blocker-ownership'))
    );
    const session = {};
    const reloaded: string[] = [];
    let releaseStarted: (() => void) | undefined;
    const stopReady = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let pauseTrackerRebuild = false;
    const controller = createOwnedBlocker(
      async (lists: string[], signal: AbortSignal) => {
        if (
          pauseTrackerRebuild &&
          lists.length === 1 &&
          lists[0] === 'https://fixture.invalid/tracker'
        ) {
          pauseTrackerRebuild = false;
          releaseStarted!();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return {
          enable: () => reloadBlockerDocuments(session),
          disable: () => reloadBlockerDocuments(session),
        };
      },
    );
    const boundaryKey = Symbol.for(`pear-test.document-race.${replacement}`);
    const globals = globalThis as unknown as Record<symbol, unknown>;
    globals[boundaryKey] = (
      _session: unknown,
      owner: string,
      lists: string[] | null,
    ) => controller.set(owner, lists);
    try {
      // Only the Electron/list-fetch boundary is supplied. Backend lifecycle,
      // async owner arbitration and document registration are production code.
      const backendSource = (await source('blocker-backend'))
        .replace("'./blocker-documents'", JSON.stringify(documentsURL))
        .replace(
          "import { setSessionBlockLists } from './blocker-session';",
          `const setSessionBlockLists = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(boundaryKey))})];`,
        );
      const { createBlockerBackend } = await import(moduleURL(backendSource));
      const contents = (identity: string) => ({
        session,
        isDestroyed: () => false,
        getURL: () => 'https://music.youtube.com/watch?v=fixture',
        reload: () => {
          reloaded.push(identity);
        },
      });
      const original = contents('original');
      const restarted =
        replacement === 'same document' ? original : contents('restarted');
      const config = {
        enabled: true,
        blocker: 'With blocklists',
        cache: false,
        additionalBlockLists: [],
        disableDefaultLists: false,
      };
      const context = (document: typeof original) => ({
        window: { webContents: document },
        getConfig: () => config,
      });
      const backend = createBlockerBackend('adblocker', async () => [
        'https://fixture.invalid/ads',
      ]);
      await controller.set('tracker', ['https://fixture.invalid/tracker']);
      await backend.start(context(original));
      pauseTrackerRebuild = true;
      const oldStop = backend.stop();
      await stopReady;
      const newStart = backend.start(context(restarted));
      await Promise.all([oldStop, newStart]);
      await Promise.resolve();
      reloaded.length = 0;
      reloadBlockerDocuments(session);
      await Promise.resolve();
      expect(reloaded).toEqual([
        replacement === 'same document' ? 'original' : 'restarted',
      ]);
      await backend.stop();
      await Promise.resolve();
      reloaded.length = 0;
      reloadBlockerDocuments(session);
      await Promise.resolve();
      expect(reloaded).toEqual([]);
    } finally {
      delete globals[boundaryKey];
    }
  });
}

for (const action of ['stop', 'session transition']) {
  test(`offline remaining-owner rebuild still releases prior document lease during ${action}`, async () => {
    const documentsURL = moduleURL(await source('blocker-documents'));
    const { reloadBlockerDocuments } = await import(documentsURL);
    const { createOwnedBlocker } = await import(
      moduleURL(await source('blocker-ownership'))
    );
    const previous = {};
    const next = {};
    const reloaded: string[] = [];
    let offline = false;
    const controller = createOwnedBlocker(async () => {
      if (offline) throw new Error('offline remaining tracker rebuild');
      return {
        enable: () => reloadBlockerDocuments(previous),
        disable: () => reloadBlockerDocuments(previous),
      };
    });
    const nextController = createOwnedBlocker(async () => ({
      enable: () => {},
      disable: () => {},
    }));
    const boundaryKey = Symbol.for(`pear-test.document-finalization.${action}`);
    const globals = globalThis as unknown as Record<symbol, unknown>;
    globals[boundaryKey] = (
      session: unknown,
      owner: string,
      lists: string[] | null,
    ) => (session === previous ? controller : nextController).set(owner, lists);
    try {
      const backendSource = (await source('blocker-backend'))
        .replace("'./blocker-documents'", JSON.stringify(documentsURL))
        .replace(
          "import { setSessionBlockLists } from './blocker-session';",
          `const setSessionBlockLists = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(boundaryKey))})];`,
        );
      const { createBlockerBackend } = await import(moduleURL(backendSource));
      const context = (session: unknown, identity: string) => ({
        window: {
          webContents: {
            session,
            isDestroyed: () => false,
            getURL: () => 'https://music.youtube.com/watch?v=fixture',
            reload: () => {
              reloaded.push(identity);
            },
          },
        },
        getConfig: () => ({
          enabled: true,
          blocker: 'With blocklists',
          cache: false,
          additionalBlockLists: [],
          disableDefaultLists: false,
        }),
      });
      const backend = createBlockerBackend('adblocker', async () => [
        'https://fixture.invalid/ads',
      ]);
      await controller.set('tracker', ['https://fixture.invalid/tracker']);
      await backend.start(context(previous, 'prior document'));
      offline = true;
      const operation =
        action === 'stop'
          ? backend.stop()
          : backend.start(context(next, 'new document'));
      await expect(operation).rejects.toThrow(
        'offline remaining tracker rebuild',
      );
      await Promise.resolve();
      reloaded.length = 0;
      reloadBlockerDocuments(previous);
      await Promise.resolve();
      expect(reloaded).toEqual([]);
      await backend.stop();
    } finally {
      delete globals[boundaryKey];
    }
  });
}
