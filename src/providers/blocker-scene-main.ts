import { randomUUID } from 'node:crypto';

import { ipcMain } from 'electron';

import { installBlockerDocumentSceneAdapter } from './blocker-documents';
import {
  createBlockerSceneController,
  type SceneReleaseReason,
} from './blocker-scene-controller';
import { blockerSceneRenderer } from './blocker-scene-renderer';

import type {
  BlockerPlaybackScene,
  BlockerSceneCapture,
  BlockerSceneOutcome,
} from '@/types/blocker-scene';

interface PendingScene {
  token: string;
  generation: number;
  scene: BlockerPlaybackScene;
  originalMuted: boolean;
  claimed: boolean;
  navigationStarted: boolean;
}
interface SceneEntry {
  contents: Electron.WebContents;
  valid: () => boolean;
  controller: ReturnType<typeof createBlockerSceneController>;
  pending?: PendingScene;
  documentPending: boolean;
  reloadCleanup?: { generation: number; cleanup: () => void };
  reloadNavigation?: {
    generation: number;
    url: string;
    started: boolean;
    committed?: { processId: number; routingId: number };
  };
}
const entries = new Map<number, SceneEntry>();
const refreshers = new Map<number, Map<string, () => void | Promise<void>>>();
let installed = false;

const run = (
  contents: Electron.WebContents,
  action: 'capture' | 'verify' | 'restore',
  scene?: BlockerPlaybackScene,
): Promise<unknown> =>
  contents.executeJavaScript(
    `(${blockerSceneRenderer.toString()})(${JSON.stringify(action)}, ${JSON.stringify(scene)});`,
    true,
  );

const release = (
  entry: SceneEntry,
  generation: number,
  reason: SceneReleaseReason = 'cancelled',
): void => {
  if (entry.reloadCleanup?.generation === generation)
    entry.reloadCleanup.cleanup();
  const pending = entry.pending;
  if (!pending || pending.generation !== generation) return;
  if (
    (reason === 'failed' || reason === 'timeout') &&
    !pending.claimed &&
    entry.reloadNavigation?.committed &&
    entry.valid() &&
    !entry.contents.isDestroyed() &&
    entry.contents.getURL() === pending.scene.url
  ) {
    // No trusted new-document guard: retain output protection and its original
    // mute ledger. Navigation/retry can release it; never queue an unscoped
    // pause script that may execute against a later user document.
    return;
  }
  if (entry.pending !== pending) return;
  entry.pending = undefined;
  if (!entry.contents.isDestroyed()) {
    entry.contents.send(
      'peard:blocker-scene-release',
      pending.token,
      pending.scene.muted,
      reason,
    );
    entry.contents.setAudioMuted(pending.originalMuted);
    if (entry.reloadNavigation?.generation === generation)
      entry.reloadNavigation = undefined;
  }
};

const cancelEntry = (entry: SceneEntry) => {
  entry.controller.cancel();
  const held = entry.pending;
  if (held) release(entry, held.generation, 'cancelled');
};

const getEntry = (contents: Electron.WebContents): SceneEntry => {
  const existing = entries.get(contents.id);
  if (existing) return existing;
  const entry = {
    contents,
    valid: () => !contents.isDestroyed(),
    documentPending: false,
  } as SceneEntry;
  const reload = async (
    scene: BlockerPlaybackScene | null,
    generation: number,
  ) => {
    if (!entry.valid()) throw new Error('The document lease changed');
    entry.reloadNavigation = {
      generation,
      url: contents.getURL(),
      started: false,
    };
    if (scene) {
      entry.pending = {
        token: randomUUID(),
        generation,
        scene,
        originalMuted: entry.pending?.originalMuted ?? contents.isAudioMuted(),
        claimed: false,
        navigationStarted: false,
      };
      contents.setAudioMuted(true);
    }
    await new Promise<void>((resolve, reject) => {
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = (
        _: Electron.Event,
        code: number,
        description: string,
        _url: string,
        main: boolean,
      ) => {
        if (main) {
          cleanup();
          reject(new Error(`Player reload failed (${code}: ${description})`));
        }
      };
      const cleanup = () => {
        contents.removeListener('did-finish-load', loaded);
        contents.removeListener('did-fail-load', failed);
        if (entry.reloadCleanup?.generation === generation)
          entry.reloadCleanup = undefined;
      };
      contents.once('did-finish-load', loaded);
      contents.on('did-fail-load', failed);
      entry.reloadCleanup = { generation, cleanup };
      contents.reload();
    });
  };
  entry.controller = createBlockerSceneController({
    capture: () => run(contents, 'capture') as Promise<BlockerSceneCapture>,
    verify: (scene) => run(contents, 'verify', scene) as Promise<boolean>,
    valid: () => entry.valid() && !contents.isDestroyed(),
    reload,
    restore: async (scene) => {
      if (!entry.pending?.claimed)
        throw new Error('The new main frame did not claim its restore guard');
      return (await run(contents, 'restore', scene)) as BlockerSceneOutcome;
    },
    release: (generation, reason) => release(entry, generation, reason),
  });
  contents.on(
    'did-start-navigation',
    (_event, url: string, inPlace: boolean, main: boolean) => {
      if (!main) return;
      const pending = entry.pending;
      const navigation = entry.reloadNavigation;
      if (
        navigation &&
        !inPlace &&
        !navigation.started &&
        url === navigation.url
      ) {
        navigation.started = true;
        return;
      }
      if (pending?.claimed && inPlace && url === pending.scene.url) return;
      cancelEntry(entry);
    },
  );
  contents.on(
    'did-frame-navigate',
    (_event, url, _code, _description, main, processId, routingId) => {
      const navigation = entry.reloadNavigation;
      if (main && navigation?.started && url === navigation.url)
        navigation.committed = { processId, routingId };
    },
  );
  contents.once('destroyed', () => {
    cancelEntry(entry);
    entries.delete(contents.id);
    refreshers.delete(contents.id);
  });
  entries.set(contents.id, entry);
  return entry;
};

const apply = async (
  entry: SceneEntry,
  explicit: boolean,
): Promise<BlockerSceneOutcome> => {
  entry.documentPending = true;
  const result = await entry.controller.apply(explicit);
  if (
    entry.controller.getStatus() === result &&
    (result.kind === 'verified' || result.kind === 'partial')
  )
    entry.documentPending = false;
  for (const refresh of refreshers.get(entry.contents.id)?.values() ?? []) {
    Promise.resolve(refresh()).catch((error: unknown) =>
      console.error('Blocker menu refresh failed', error),
    );
  }
  return result;
};

export const installBlockerSceneBridge = (): void => {
  if (installed) return;
  installed = true;
  ipcMain.on(
    'peard:blocker-scene-claim',
    (event, url: unknown, origin: unknown) => {
      event.returnValue = null;
      const entry = entries.get(event.sender.id);
      const pending = entry?.pending;
      const target = entry?.reloadNavigation?.committed;
      if (
        !entry ||
        !pending ||
        !target ||
        event.senderFrame?.processId !== target.processId ||
        event.senderFrame?.routingId !== target.routingId ||
        !Number.isFinite(Number(pending.scene.documentId.split(':')[0])) ||
        typeof origin !== 'number' ||
        !Number.isFinite(origin) ||
        origin <= Number(pending.scene.documentId.split(':')[0]) ||
        pending.claimed ||
        event.senderFrame !== entry.contents.mainFrame ||
        typeof url !== 'string' ||
        url !== pending.scene.url ||
        event.senderFrame.url !== url ||
        !entry.valid()
      )
        return;
      pending.claimed = true;
      event.returnValue = { token: pending.token, muted: pending.scene.muted };
    },
  );
  ipcMain.on('peard:blocker-scene-cancel', (event, token: unknown) => {
    const entry = entries.get(event.sender.id);
    if (
      entry?.pending &&
      entry.pending.token === token &&
      event.senderFrame === entry.contents.mainFrame
    )
      cancelEntry(entry);
  });
  installBlockerDocumentSceneAdapter(
    (contents, valid) => {
      const entry = getEntry(contents);
      entry.valid = valid;
      apply(entry, false).catch((error: unknown) =>
        console.error('Blocker scene apply failed', error),
      );
    },
    (contents) => {
      const entry = entries.get(contents.id);
      if (entry) cancelEntry(entry);
    },
  );
};

export const getBlockerDocumentStatus = (
  contents: Electron.WebContents,
): BlockerSceneOutcome => {
  const entry = entries.get(contents.id);
  if (!entry) return { kind: 'verified' };
  if (entry.controller.isApplying())
    return {
      kind: 'pending',
      reason: 'Preserving playback; document apply is in progress',
    };
  const status = entry.controller.getStatus();
  if (!entry.documentPending && status.kind === 'cancelled')
    return { kind: 'verified' };
  return entry.documentPending && status.kind === 'cancelled'
    ? {
        kind: 'pending',
        reason: 'Playback changed; document changes are still pending',
      }
    : status;
};

export const isBlockerDocumentApplying = (
  contents: Electron.WebContents,
): boolean => entries.get(contents.id)?.controller.isApplying() ?? false;

export const applyPendingBlockerDocument = async (
  contents: Electron.WebContents,
): Promise<BlockerSceneOutcome> => {
  const entry = entries.get(contents.id);
  if (!entry || !entry.documentPending) return { kind: 'verified' };
  return await apply(entry, true);
};

export const setBlockerDocumentMenuRefresh = (
  contents: Electron.WebContents,
  owner: string,
  refresh: () => void | Promise<void>,
): void => {
  let callbacks = refreshers.get(contents.id);
  if (!callbacks) {
    callbacks = new Map();
    refreshers.set(contents.id, callbacks);
    contents.once('destroyed', () => {
      refreshers.delete(contents.id);
    });
  }
  callbacks.set(owner, refresh);
};
