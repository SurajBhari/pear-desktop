import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { app, net } from 'electron';

import { reloadBlockerDocuments } from './blocker-documents';
import { createOwnedBlocker } from './blocker-ownership';
import { installBlockerSceneBridge } from './blocker-scene-main';
import { scopeBlockingSession } from './blocker-scoped-session';

const sessions = new WeakMap<
  Electron.Session,
  ReturnType<typeof createOwnedBlocker>
>();
const cachePreferences = new WeakMap<Electron.Session, Map<string, boolean>>();
installBlockerSceneBridge();

export const setSessionBlockLists = async (
  session: Electron.Session,
  owner: string,
  lists: string[] | null,
  cache = true,
): Promise<void> => {
  let preferences = cachePreferences.get(session);
  if (!preferences) {
    preferences = new Map();
    cachePreferences.set(session, preferences);
  }
  if (lists === null) preferences.delete(owner);
  else preferences.set(owner, cache);
  let controller = sessions.get(session);
  if (!controller) {
    controller = createOwnedBlocker(async (merged, signal) => {
      const useCache = [
        ...(cachePreferences.get(session)?.values() ?? []),
      ].every(Boolean);
      const directory = path.join(app.getPath('userData'), 'blocking-cache');
      if (useCache) await fs.mkdir(directory, { recursive: true });
      const digest = createHash('sha256')
        .update(JSON.stringify(merged))
        .digest('hex');
      const engine = await ElectronBlocker.fromLists(
        async (url: string) => {
          const response = await net.fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          });
          if (!response.ok)
            throw new Error(`Blocklist returned ${response.status}`);
          return response;
        },
        merged,
        { enableCompression: true, loadNetworkFilters: true },
        useCache
          ? {
              path: path.join(directory, `${digest}.bin`),
              read: fs.readFile,
              write: fs.writeFile,
            }
          : undefined,
      );
      const scopedSession = scopeBlockingSession(session);
      return {
        enable: () => {
          engine.enableBlockingInSession(scopedSession);
          reloadBlockerDocuments(session);
        },
        disable: () => {
          if (engine.isBlockingEnabled(scopedSession)) {
            engine.disableBlockingInSession(scopedSession);
            reloadBlockerDocuments(session);
          }
        },
      };
    });
    sessions.set(session, controller);
  }
  await controller.set(owner, lists, cache ? 'cached' : 'uncached');
};
