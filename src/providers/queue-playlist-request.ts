import { randomUUID } from 'node:crypto';

import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type WebFrameMain,
} from 'electron';

import {
  isOwnerId,
  isRecord,
  isRequestId,
  MAX_PLAYLIST_ITEMS,
  MAX_QUEUE_REQUESTS,
  parsePlaylistInput,
  PLAYLIST_REQUEST_TIMEOUT_MS,
  type PlaylistInput,
  type PlaylistResult,
} from './queue-playlist';

type Pending = {
  id: string;
  input: PlaylistInput;
  frame: WebFrameMain;
  phase: 'owner' | 'enqueue';
  ownerId?: string;
  resolve(result: PlaylistResult): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};
type Coordinator = {
  pending: Map<string, Pending>;
  add(input: PlaylistInput, signal?: AbortSignal): Promise<PlaylistResult>;
};
const coordinators = new WeakMap<BrowserWindow, Coordinator>();
const alive = (window: BrowserWindow) => {
  try {
    return !window.isDestroyed() && !window.webContents.isDestroyed();
  } catch {
    return false;
  }
};

function replyResult(value: unknown): PlaylistResult | null {
  if (!isRecord(value)) return null;
  if (
    value.ok === true &&
    typeof value.count === 'number' &&
    Number.isInteger(value.count) &&
    value.count >= 0 &&
    value.count <= MAX_PLAYLIST_ITEMS
  )
    return { ok: true, count: value.count };
  if (
    value.ok === false &&
    typeof value.reason === 'string' &&
    ['invalid', 'retired', 'busy', 'service', 'timeout'].includes(value.reason)
  )
    return {
      ok: false,
      reason: value.reason as Extract<PlaylistResult, { ok: false }>['reason'],
    };
  return null;
}

function coordinatorFor(window: BrowserWindow): Coordinator {
  const existing = coordinators.get(window);
  if (existing) return existing;
  const pending = new Map<string, Pending>();
  const cleanup = () => {
    if (pending.size) return;
    ipcMain.removeListener('peard:playlist-queue-reply', onReply);
    window.removeListener('closed', retire);
    window.webContents.removeListener('destroyed', retire);
    window.webContents.removeListener('render-process-gone', retire);
    window.webContents.removeListener('did-start-navigation', navigate);
    coordinators.delete(window);
  };
  const finish = (record: Pending, result: PlaylistResult, cancel = false) => {
    if (pending.get(record.id) !== record) return;
    pending.delete(record.id);
    clearTimeout(record.timer);
    if (record.abort) record.signal?.removeEventListener('abort', record.abort);
    if (cancel && record.ownerId && alive(window))
      try {
        window.webContents.send('peard:cancel-playlist-queue', {
          requestId: record.id,
          ownerId: record.ownerId,
        });
      } catch {
        /* retired frame */
      }
    cleanup();
    record.resolve(result);
  };
  const retire = () => {
    for (const record of [...pending.values()])
      finish(record, { ok: false, reason: 'retired' }, true);
  };
  const navigate = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) retire();
  };
  const onReply = (event: IpcMainEvent, value: unknown) => {
    if (!isRecord(value) || !isRequestId(value.requestId)) return;
    const record = pending.get(value.requestId);
    if (!record || !alive(window)) return;
    try {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== record.frame ||
        window.webContents.mainFrame !== record.frame
      )
        return;
    } catch {
      return;
    }
    if (
      record.phase === 'owner' &&
      value.type === 'owner' &&
      isOwnerId(value.ownerId)
    ) {
      record.ownerId = value.ownerId;
      record.phase = 'enqueue';
      try {
        window.webContents.send('peard:add-playlist-to-queue', {
          requestId: record.id,
          ownerId: record.ownerId,
          ...record.input,
        });
      } catch {
        finish(record, { ok: false, reason: 'retired' }, true);
      }
    } else if (
      record.phase === 'enqueue' &&
      value.type === 'result' &&
      value.ownerId === record.ownerId
    ) {
      const result = replyResult(value.result);
      if (result) finish(record, result);
    }
  };
  const coordinator: Coordinator = {
    pending,
    add(input, signal) {
      if (pending.size >= MAX_QUEUE_REQUESTS)
        return Promise.resolve({ ok: false, reason: 'busy' });
      return new Promise((resolve) => {
        let frame: WebFrameMain;
        try {
          frame = window.webContents.mainFrame;
          if (!frame || typeof frame !== 'object')
            throw new Error('Retired frame');
        } catch {
          cleanup();
          resolve({ ok: false, reason: 'retired' });
          return;
        }
        const id = randomUUID();
        const record: Pending = {
          id,
          input,
          frame,
          phase: 'owner',
          resolve,
          signal,
        };
        pending.set(id, record);
        record.timer = setTimeout(
          () => finish(record, { ok: false, reason: 'timeout' }, true),
          PLAYLIST_REQUEST_TIMEOUT_MS,
        );
        if (signal) {
          record.abort = () =>
            finish(record, { ok: false, reason: 'retired' }, true);
          signal.addEventListener('abort', record.abort, { once: true });
        }
        try {
          window.webContents.send('peard:playlist-queue-owner-query', {
            requestId: id,
          });
        } catch {
          finish(record, { ok: false, reason: 'retired' }, true);
        }
      });
    },
  };
  coordinators.set(window, coordinator);
  ipcMain.on('peard:playlist-queue-reply', onReply);
  window.on('closed', retire);
  window.webContents.on('destroyed', retire);
  window.webContents.on('render-process-gone', retire);
  window.webContents.on('did-start-navigation', navigate);
  return coordinator;
}

/** New playlist operation only: raw sender/frame correlation and bounded lifecycle ownership. */
export function requestPlaylistQueue(
  window: BrowserWindow,
  input: unknown,
  signal?: AbortSignal,
): Promise<PlaylistResult> {
  const parsed = isRecord(input)
    ? parsePlaylistInput(input.playlistId, input.videoId, input.insertPosition)
    : null;
  if (!parsed) return Promise.resolve({ ok: false, reason: 'invalid' });
  if (
    signal &&
    (typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    return Promise.resolve({ ok: false, reason: 'invalid' });
  if (!alive(window) || signal?.aborted)
    return Promise.resolve({ ok: false, reason: 'retired' });
  return coordinatorFor(window).add(parsed, signal);
}
