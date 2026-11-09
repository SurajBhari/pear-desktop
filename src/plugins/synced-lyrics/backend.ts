import { writeFile } from 'node:fs/promises';

import { dialog, ipcMain, net } from 'electron';

import { t } from '@/i18n';
import { registerCallback } from '@/providers/song-info';
import { createBackend } from '@/utils';

import {
  startNetEaseProvider,
  stopNetEaseProvider,
} from './providers/netease-backend';
import { serializeLyricsExport } from './tools';

import type { SyncedLyricsPluginConfig } from './types';
import type { BackendContext } from '@/types/contexts';

const handlers = {
  // Note: This will only be used for Forbidden headers, e.g. User-Agent, Authority, Cookie, etc.
  // See: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
  async fetch(
    url: string,
    init: RequestInit,
  ): Promise<[number, string, Record<string, string>]> {
    const res = await net.fetch(url, init);
    return [
      res.status,
      await res.text(),
      Object.fromEntries(res.headers.entries()),
    ];
  },
};

type ExportSession = {
  active: boolean;
  revision: number;
  videoId: string | null;
  nativeVideoId?: string | null;
  releaseNative?: () => void;
  busy: boolean;
  unsubscribe?: () => void;
};
const sessions = new WeakMap<
  BackendContext<SyncedLyricsPluginConfig>['window'],
  ExportSession
>();

let currentSession: ExportSession | undefined;
const pendingDialogs = new WeakSet<
  BackendContext<SyncedLyricsPluginConfig>['window']
>();

export const backend = createBackend<unknown, SyncedLyricsPluginConfig>({
  start(ctx) {
    startNetEaseProvider(ctx);
    const previous = currentSession;
    if (previous) {
      previous.active = false;
      previous.unsubscribe?.();
      previous.releaseNative?.();
    }
    const session: ExportSession = {
      active: true,
      revision: 0,
      videoId: null,
      busy: false,
    };
    sessions.set(ctx.window, session);
    currentSession = session;
    ctx.ipc.removeHandler('synced-lyrics:export');
    ctx.ipc.removeHandler('synced-lyrics:fetch');
    session.unsubscribe = registerCallback(
      (info) => {
        if (!session.active) return;
        const id =
          typeof info.videoId === 'string' && info.videoId
            ? info.videoId
            : null;
        if (id !== session.videoId) {
          session.videoId = id;
          session.revision++;
        }
      },
      { replayCurrent: true },
    );
    const nativeChanged = (event: Electron.IpcMainEvent, payload: unknown) => {
      if (
        !session.active ||
        currentSession !== session ||
        event.sender !== ctx.window.webContents
      )
        return;
      const details =
        payload && typeof payload === 'object' && 'videoDetails' in payload
          ? payload.videoDetails
          : null;
      const id =
        details &&
        typeof details === 'object' &&
        'videoId' in details &&
        typeof details.videoId === 'string' &&
        details.videoId
          ? details.videoId
          : null;
      // This raw IPC precedes the metadata provider's asynchronous thumbnail fetch.
      // Later old time/metadata callbacks cannot undo the native observation.
      session.nativeVideoId = id;
      session.revision++;
    };
    ipcMain.on('peard:video-src-changed', nativeChanged);
    session.releaseNative = () =>
      ipcMain.removeListener('peard:video-src-changed', nativeChanged);
    ipcMain.handle('synced-lyrics:export', async (event, request: unknown) => {
      const revision = session.revision;
      const current = () =>
        session.active &&
        sessions.get(ctx.window) === session &&
        currentSession === session &&
        session.revision === revision &&
        !ctx.window.isDestroyed() &&
        !ctx.window.webContents.isDestroyed();
      if (
        !current() ||
        session.busy ||
        pendingDialogs.has(ctx.window) ||
        event.sender !== ctx.window.webContents
      )
        return 'cancelled';
      if (
        !request ||
        typeof request !== 'object' ||
        !('videoId' in request) ||
        !('result' in request)
      )
        return 'invalid';
      if (
        typeof request.videoId !== 'string' ||
        !session.videoId ||
        request.videoId !== session.videoId ||
        (session.nativeVideoId !== undefined &&
          session.nativeVideoId !== request.videoId)
      )
        return 'cancelled';
      let output: ReturnType<typeof serializeLyricsExport>;
      try {
        output = serializeLyricsExport(request.result, {
          offsetMs: 'offsetMs' in request ? request.offsetMs : 0,
          enhanced: 'enhanced' in request && request.enhanced === true,
        });
      } catch {
        return 'invalid';
      }
      session.busy = true;
      pendingDialogs.add(ctx.window);
      try {
        const choice = await dialog.showSaveDialog(ctx.window, {
          title: t('plugins.synced-lyrics.tools.export'),
          defaultPath: output.filename,
          filters: [
            {
              name:
                output.extension === 'lrc'
                  ? 'LRC'
                  : t('plugins.synced-lyrics.tools.plain-text'),
              extensions: [output.extension],
            },
          ],
          properties: ['showOverwriteConfirmation'],
        });
        if (!current() || choice.canceled || !choice.filePath)
          return 'cancelled';
        await writeFile(choice.filePath, output.content, 'utf8');
        return 'saved';
      } catch {
        return 'error';
      } finally {
        session.busy = false;
        pendingDialogs.delete(ctx.window);
      }
    });
    ctx.ipc.handle('synced-lyrics:fetch', (url: string, init: RequestInit) =>
      handlers.fetch(url, init),
    );
  },
  stop(ctx) {
    stopNetEaseProvider(ctx);
    const session = sessions.get(ctx.window);
    if (!session || currentSession !== session) return;
    if (session) {
      session.active = false;
      session.unsubscribe?.();
      session.releaseNative?.();
      sessions.delete(ctx.window);
      currentSession = undefined;
    }
    ctx.ipc.removeHandler('synced-lyrics:export');
    ctx.ipc.removeHandler('synced-lyrics:fetch');
  },
});
