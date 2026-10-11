import { randomBytes, randomUUID } from 'node:crypto';

import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type WebFrameMain,
} from 'electron';

import {
  failMusic,
  MusicServiceError,
  type MusicReadInput,
  type NativeMusicValue,
  type NativeMusicResult,
  type MusicFailure,
} from '@/plugins/api-server/music-types';

import { isOwnerId, isRecord, isRequestId } from './queue-playlist';

export interface MusicAdmission {
  readonly frame: WebFrameMain;
  readonly generation: number;
}
interface Pending {
  id: string;
  nonce: string;
  admission: MusicAdmission;
  principal: string;
  input: MusicReadInput;
  phase: 'queued' | 'owner' | 'read';
  documentId?: string;
  sourceId?: string;
  done: boolean;
  resolve(value: NativeMusicValue): void;
  reject(error: MusicServiceError): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  abort?: () => void;
}
const failures: MusicFailure[] = [
  'invalid',
  'source',
  'unsupported',
  'budget',
  'retired',
  'busy',
  'unavailable',
  'timeout',
];
/** Main-only scheduler. Cancellation completes the caller; physical reads retain their slot until authenticated settlement. */
const brokers = new WeakMap<
  BrowserWindow,
  ReturnType<typeof buildMusicRequestBroker>
>();
export function createMusicRequestBroker(window: BrowserWindow) {
  const existing = brokers.get(window);
  if (existing) return existing;
  const broker = buildMusicRequestBroker(window);
  brokers.set(window, broker);
  return broker;
}
function buildMusicRequestBroker(window: BrowserWindow) {
  const contents = window.webContents,
    records = new Map<string, Pending>();
  let generation = 0,
    disposed = false,
    navigating = false;
  let managed = false,
    retainers = 0;
  const guardCurrent = (guard?: () => boolean) => {
    try {
      return guard?.() !== false;
    } catch {
      return false;
    }
  };
  const retirementObservers = new Set<() => void>();
  const resultOwners = new WeakMap<
    object,
    { epoch: string; current(): boolean }
  >();
  const sourceOwners = new Map<string, { retired: boolean }>();
  const alive = () => {
    try {
      return (
        !disposed &&
        !window.isDestroyed() &&
        window.webContents === contents &&
        !contents.isDestroyed()
      );
    } catch {
      return false;
    }
  };
  const current = (admission: MusicAdmission) => {
    try {
      return (
        alive() &&
        !navigating &&
        admission.generation === generation &&
        admission.frame === contents.mainFrame
      );
    } catch {
      return false;
    }
  };
  const active = () =>
    [...records.values()].filter((r) => r.phase !== 'queued');
  const owned = (r: Pending) =>
    current(r.admission) && !r.signal?.aborted && guardCurrent(r.isCurrent);
  const cleanupUnused = () => {
    const noOwner = managed && retainers === 0;
    if ((noOwner || disposed) && !records.size) {
      disposed = true;
      brokers.delete(window);
      detach();
      return true;
    }
    return false;
  };
  const cleanupCaller = (r: Pending) => {
    clearTimeout(r.timer);
    if (r.abort) r.signal?.removeEventListener('abort', r.abort);
  };
  const complete = (r: Pending, result: NativeMusicResult) => {
    if (r.done) return;
    r.done = true;
    cleanupCaller(r);
    if (result.ok) {
      const epoch = `${r.documentId}:${r.sourceId}`;
      let owner = sourceOwners.get(epoch);
      if (!owner) {
        owner = { retired: false };
        sourceOwners.set(epoch, owner);
        if (sourceOwners.size > 128) {
          const oldest = sourceOwners.entries().next().value;
          if (oldest) {
            oldest[1].retired = true;
            sourceOwners.delete(oldest[0]);
          }
        }
      }
      const captured = owner;
      resultOwners.set(result.value, {
        epoch,
        current: () => !captured.retired && current(r.admission),
      });
      r.resolve(result.value);
    } else r.reject(new MusicServiceError(result.reason));
  };
  const send = (channel: string, r: Pending, more: object = {}) =>
    contents.send(channel, {
      requestId: r.id,
      nonce: r.nonce,
      documentId: r.documentId,
      sourceId: r.sourceId,
      ...more,
    });
  const release = (r: Pending) => {
    records.delete(r.id);
    cleanupCaller(r);
    if (!cleanupUnused()) pump();
  };
  const retire = (r: Pending, reason: MusicFailure = 'retired') => {
    complete(r, { ok: false, reason });
    if (r.phase === 'queued') {
      release(r);
      return;
    }
    try {
      send('peard:music-cancel', r, { phase: r.phase });
    } catch {
      /* Physical work remains owned until settlement or process destruction. */
    }
    // Owner queries have no dispatched read. Retire their native challenge
    // before releasing/pumping; read-phase work keeps its physical tombstone.
    if (r.phase === 'owner') release(r);
  };
  const pump = () => {
    if (!alive()) return;
    for (const r of records.values()) {
      if (r.phase !== 'queued') continue;
      if (r.done || !owned(r)) {
        retire(r);
        continue;
      }
      const slots = active();
      if (slots.length >= 4) break;
      // Strict FIFO: a blocked principal cannot be bypassed by later callers.
      if (slots.filter((x) => x.principal === r.principal).length >= 2) break;
      r.phase = 'owner';
      try {
        send('peard:music-owner-query', r);
      } catch {
        retire(r);
      }
    }
  };
  const retireAll = () => {
    generation++;
    for (const observer of retirementObservers) observer();
    for (const r of [...records.values()]) retire(r);
  };
  const navigation = (
    _event: Electron.Event,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame && !inPlace) {
      navigating = true;
      retireAll();
    }
  };
  const destroyed = () => {
    retireAll();
    for (const r of records.values()) cleanupCaller(r);
    records.clear();
    disposed = true;
    brokers.delete(window);
    detach();
  };
  const committed = () => {
    navigating = false;
    // Electron did-navigate is a committed main-document replacement, not an in-page navigation.
    // The old document's JS context has terminated; only its exact old-generation entries are released.
    for (const r of [...records.values()])
      if (r.admission.generation !== generation) {
        complete(r, { ok: false, reason: 'retired' });
        release(r);
      }
  };
  const processGone = () => {
    // Native renderer-process termination proves every dispatched JS context has ended.
    navigating = true;
    retireAll();
    for (const r of [...records.values()]) release(r);
  };
  const navigationFailed = (
    _event: Electron.Event,
    _code: number,
    _description: string,
    _url: string,
    mainFrame: boolean,
  ) => {
    if (mainFrame) navigating = false;
  };
  const rawSender = (
    event: IpcMainEvent,
    frame: WebFrameMain,
    requireCurrent = true,
  ) => {
    try {
      return (
        event.sender === contents &&
        event.senderFrame === frame &&
        (!requireCurrent || contents.mainFrame === frame)
      );
    } catch {
      return false;
    }
  };
  const onReply = (event: IpcMainEvent, packet: unknown) => {
    if (!isRecord(packet)) return;
    if (
      packet.type === 'retire' &&
      isOwnerId(packet.documentId) &&
      isOwnerId(packet.sourceId)
    ) {
      try {
        if (
          event.sender === contents &&
          event.senderFrame === contents.mainFrame
        ) {
          const owner = sourceOwners.get(
            `${packet.documentId}:${packet.sourceId}`,
          );
          if (owner) owner.retired = true;
        }
      } catch {
        return;
      }
      for (const r of [...records.values()])
        if (
          rawSender(event, r.admission.frame) &&
          r.documentId === packet.documentId &&
          r.sourceId === packet.sourceId
        )
          retire(r);
      return;
    }
    if (!isRequestId(packet.requestId)) return;
    const r = records.get(packet.requestId);
    if (
      !r ||
      packet.nonce !== r.nonce ||
      !rawSender(event, r.admission.frame, packet.type !== 'settled')
    )
      return;
    if (r.phase === 'owner' && packet.type === 'unavailable') {
      complete(r, { ok: false, reason: 'unavailable' });
      release(r);
      return;
    }
    if (
      r.phase === 'owner' &&
      packet.type === 'ready' &&
      isOwnerId(packet.documentId) &&
      isOwnerId(packet.sourceId)
    ) {
      if (!owned(r) || r.done) {
        retire(r);
        return;
      }
      r.documentId = packet.documentId;
      r.sourceId = packet.sourceId;
      r.phase = 'read';
      try {
        send('peard:music-read', r, { input: r.input });
      } catch {
        retire(r);
      }
    } else if (
      r.phase === 'read' &&
      packet.type === 'settled' &&
      packet.documentId === r.documentId &&
      packet.sourceId === r.sourceId
    ) {
      const result = packet.result;
      if (!r.done) {
        if (!owned(r)) complete(r, { ok: false, reason: 'retired' });
        else if (
          isRecord(result) &&
          result.ok === true &&
          isRecord(result.value)
        )
          complete(r, {
            ok: true,
            value: result.value as unknown as NativeMusicValue,
          });
        else if (
          isRecord(result) &&
          result.ok === false &&
          failures.includes(result.reason as MusicFailure)
        )
          complete(r, { ok: false, reason: result.reason as MusicFailure });
        else complete(r, { ok: false, reason: 'source' });
      }
      release(r);
    }
  };
  const detach = () => {
    ipcMain.removeListener('peard:music-reply', onReply);
    window.removeListener('closed', destroyed);
    contents.removeListener('destroyed', destroyed);
    contents.removeListener('render-process-gone', processGone);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('did-navigate', committed);
    contents.removeListener('did-fail-load', navigationFailed);
  };
  ipcMain.on('peard:music-reply', onReply);
  window.on('closed', destroyed);
  contents.on('destroyed', destroyed);
  contents.on('render-process-gone', processGone);
  contents.on('did-start-navigation', navigation);
  contents.on('did-navigate', committed);
  contents.on('did-fail-load', navigationFailed);
  const capture = (): MusicAdmission => {
    if (!alive() || navigating) return failMusic('retired');
    return Object.freeze({ frame: contents.mainFrame, generation });
  };
  const stop = () => {
    if (disposed) return;
    retireAll();
    disposed = true;
    cleanupUnused();
  };
  return {
    capture,
    captureWindowOwner() {
      const admission = capture();
      return { isCurrent: () => current(admission) };
    },
    isCurrent: current,
    subscribeRetirement: (observer: () => void) => {
      retirementObservers.add(observer);
      return () => retirementObservers.delete(observer);
    },
    resultOwner: (value: NativeMusicValue) => resultOwners.get(value),
    retain() {
      // A restarted service shares every still-live physical tombstone, never a fresh capacity counter.
      if (disposed && records.size) disposed = false;
      if (!alive()) return failMusic('retired');
      managed = true;
      retainers++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retainers--;
        cleanupUnused();
      };
    },
    read(
      admission: MusicAdmission,
      input: MusicReadInput,
      principal: string,
      options: {
        signal?: AbortSignal;
        deadline?: number;
        isCurrent?: () => boolean;
      } = {},
    ): Promise<NativeMusicValue> {
      if (
        !current(admission) ||
        options.signal?.aborted ||
        !guardCurrent(options.isCurrent)
      )
        return Promise.reject(new MusicServiceError('retired'));
      if (
        records.size >= 12 ||
        [...records.values()].filter((r) => r.phase === 'queued').length >= 8
      )
        return Promise.reject(new MusicServiceError('busy'));
      const lifetime = Math.min(
        input.operation === 'current' ? 5000 : 15000,
        (options.deadline ?? Infinity) - Date.now(),
      );
      if (lifetime <= 0)
        return Promise.reject(new MusicServiceError('timeout'));
      return new Promise((resolve, reject) => {
        const r: Pending = {
          id: randomUUID(),
          nonce: randomBytes(16).toString('hex'),
          admission,
          principal,
          input,
          phase: 'queued',
          done: false,
          resolve,
          reject,
          signal: options.signal,
          isCurrent: options.isCurrent,
        };
        records.set(r.id, r);
        r.timer = setTimeout(() => retire(r, 'timeout'), lifetime);
        r.timer.unref?.();
        if (r.signal) {
          r.abort = () =>
            retire(
              r,
              r.signal?.reason instanceof MusicServiceError &&
                r.signal.reason.code === 'timeout'
                ? 'timeout'
                : 'retired',
            );
          r.signal.addEventListener('abort', r.abort, { once: true });
        }
        pump();
      });
    },
    stats: () => ({
      dispatched: active().length,
      queued: [...records.values()].filter((r) => r.phase === 'queued').length,
    }),
    dispose: stop,
    stop,
  };
}
export type MusicRequestBroker = ReturnType<typeof createMusicRequestBroker>;
