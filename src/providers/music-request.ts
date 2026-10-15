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

import {
  samePlaybackBinding,
  type PlaybackBinding,
  type LegacyClockValue,
} from './playback-owner';
import { isOwnerId, isRecord, isRequestId } from './queue-playlist';

export interface MusicAdmission {
  readonly frame: WebFrameMain;
  readonly generation: number;
}
export type MusicPhysicalSettlementReason =
  | 'owned_settled'
  | 'authenticated_ack'
  | 'not_admitted'
  | 'authoritative_termination';
interface Pending {
  id: string;
  nonce: string;
  readonly admission: MusicAdmission;
  principal: string;
  input?: MusicReadInput;
  execute?: (context: {
    signal: AbortSignal;
    deadline: number;
    current(): boolean;
  }) => Promise<NativeMusicValue>;
  mainController?: AbortController;
  deadlineAt: number;
  binding?: PlaybackBinding;
  phase: 'queued' | 'owner' | 'read' | 'main';
  documentId?: string;
  sourceId?: string;
  done: boolean;
  resolve(value: NativeMusicValue): void;
  reject(error: MusicServiceError): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  abort?: () => void;
  onPhysicalSettled?: (reason: MusicPhysicalSettlementReason) => void;
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
  const clockSourceOwners = new Map<string, { retired: boolean }>();
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
  // Separate factory: cursor ownership must not retain a completed Pending,
  // its resolved value or its request callbacks through a closure environment.
  const resultOwnerFor = (
    state: { retired: boolean },
    epoch: string,
    admission: MusicAdmission,
  ) => ({
    epoch,
    current: () => !state.retired && current(admission),
  });
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
      if (r.execute) {
        r.resolve(result.value);
        return;
      }
      const owners = r.binding ? clockSourceOwners : sourceOwners;
      const epoch = `${r.documentId}:${r.sourceId}`;
      let owner = owners.get(epoch);
      if (!owner) {
        owner = { retired: false };
        owners.set(epoch, owner);
        if (owners.size > 128) {
          const oldest = owners.entries().next().value;
          if (oldest) {
            oldest[1].retired = true;
            owners.delete(oldest[0]);
          }
        }
      }
      resultOwners.set(result.value, resultOwnerFor(owner, epoch, r.admission));
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
  const notify = (
    callback: Pending['onPhysicalSettled'],
    reason: MusicPhysicalSettlementReason,
  ) => {
    try {
      callback?.(reason);
    } catch {
      /* Physical accounting is already complete; observers cannot undo it. */
    }
  };
  const release = (r: Pending, reason: MusicPhysicalSettlementReason) => {
    if (records.get(r.id) !== r) return;
    const callback = r.onPhysicalSettled;
    r.onPhysicalSettled = undefined;
    records.delete(r.id);
    cleanupCaller(r);
    if (!cleanupUnused()) pump();
    notify(callback, reason);
  };
  const retire = (r: Pending, reason: MusicFailure = 'retired') => {
    complete(r, { ok: false, reason });
    r.mainController?.abort(new MusicServiceError(reason));
    if (r.phase === 'queued') {
      release(r, 'not_admitted');
      return;
    }
    if (r.phase === 'main') return;
    try {
      send(r.binding ? 'peard:legacy-clock-cancel' : 'peard:music-cancel', r, {
        phase: r.phase,
      });
    } catch {
      /* Physical work remains owned until settlement or process destruction. */
    }
    // Owner queries have no dispatched read. Retire their native challenge
    // before releasing/pumping; read-phase work keeps its physical tombstone.
    if (r.phase === 'owner') release(r, 'not_admitted');
  };
  const executeMain = async (r: Pending) => {
    let entered = false;
    try {
      if (!owned(r) || r.done || records.get(r.id) !== r) return;
      const execute = r.execute!;
      const context = {
        signal: r.mainController!.signal,
        deadline: r.deadlineAt,
        current: () => owned(r) && !r.done && records.get(r.id) === r,
      };
      if (!context.current() || r.done || records.get(r.id) !== r) return;
      entered = true;
      const value = await execute(context);
      if (!r.done)
        complete(
          r,
          owned(r) ? { ok: true, value } : { ok: false, reason: 'retired' },
        );
    } catch (error) {
      complete(r, {
        ok: false,
        reason: error instanceof MusicServiceError ? error.code : 'source',
      });
    } finally {
      if (!r.done) complete(r, { ok: false, reason: 'retired' });
      release(r, entered ? 'owned_settled' : 'not_admitted');
    }
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
      if (r.execute) {
        r.phase = 'main';
        executeMain(r).catch(() => {});
        continue;
      }
      r.phase = 'owner';
      try {
        send(
          r.binding
            ? 'peard:legacy-clock-owner-query'
            : 'peard:music-owner-query',
          r,
          r.binding ? { binding: r.binding } : {},
        );
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
    const callbacks = [...records.values()]
      .filter((r) => r.phase !== 'main')
      .map((r) => {
        cleanupCaller(r);
        const callback = r.onPhysicalSettled;
        r.onPhysicalSettled = undefined;
        records.delete(r.id);
        return callback;
      });
    disposed = true;
    if (!records.size) brokers.delete(window);
    detach();
    for (const callback of callbacks)
      notify(callback, 'authoritative_termination');
  };
  const committed = () => {
    navigating = false;
    // Electron did-navigate is a committed main-document replacement, not an in-page navigation.
    // The old document's JS context has terminated; only its exact old-generation entries are released.
    for (const r of [...records.values()])
      if (r.phase !== 'main' && r.admission.generation !== generation) {
        complete(r, { ok: false, reason: 'retired' });
        release(r, 'authoritative_termination');
      }
  };
  const processGone = () => {
    // Native renderer-process termination proves every dispatched JS context has ended.
    navigating = true;
    retireAll();
    for (const r of [...records.values()])
      if (r.phase !== 'main') release(r, 'authoritative_termination');
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
  const onReply = (event: IpcMainEvent, packet: unknown, clock = false) => {
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
          const owner = (clock ? clockSourceOwners : sourceOwners).get(
            `${packet.documentId}:${packet.sourceId}`,
          );
          if (owner) owner.retired = true;
        }
      } catch {
        return;
      }
      for (const r of [...records.values()])
        if (r.execute && !owned(r)) retire(r);
        else if (
          !!r.binding === clock &&
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
      !!r.binding !== clock ||
      packet.nonce !== r.nonce ||
      !rawSender(event, r.admission.frame, packet.type !== 'settled')
    )
      return;
    if (r.phase === 'owner' && packet.type === 'unavailable') {
      complete(r, { ok: false, reason: 'unavailable' });
      release(r, 'not_admitted');
      return;
    }
    if (
      r.phase === 'owner' &&
      packet.type === 'ready' &&
      isOwnerId(packet.documentId) &&
      isOwnerId(packet.sourceId)
    ) {
      if (
        !owned(r) ||
        r.done ||
        (r.binding &&
          (packet.documentId !== r.binding.documentId ||
            packet.sourceId !== r.binding.episodeId))
      ) {
        retire(r);
        return;
      }
      r.documentId = packet.documentId;
      r.sourceId = packet.sourceId;
      r.phase = 'read';
      try {
        send(
          r.binding ? 'peard:legacy-clock-read' : 'peard:music-read',
          r,
          r.binding ? { binding: r.binding } : { input: r.input },
        );
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
          isRecord(result.value) &&
          (!r.binding ||
            (Object.keys(result.value).length === 4 &&
              samePlaybackBinding(
                result.value as unknown as PlaybackBinding,
                r.binding,
              ) &&
              typeof result.value.elapsedMilliseconds === 'number' &&
              Number.isFinite(result.value.elapsedMilliseconds) &&
              result.value.elapsedMilliseconds >= 0))
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
      release(r, 'authenticated_ack');
    }
  };
  const onClockReply = (event: IpcMainEvent, packet: unknown) =>
    onReply(event, packet, true);
  const onMusicReply = (event: IpcMainEvent, packet: unknown) =>
    onReply(event, packet, false);
  const detach = () => {
    ipcMain.removeListener('peard:music-reply', onMusicReply);
    ipcMain.removeListener('peard:legacy-clock-reply', onClockReply);
    window.removeListener('closed', destroyed);
    contents.removeListener('destroyed', destroyed);
    contents.removeListener('render-process-gone', processGone);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('did-navigate', committed);
    contents.removeListener('did-fail-load', navigationFailed);
  };
  ipcMain.on('peard:music-reply', onMusicReply);
  ipcMain.on('peard:legacy-clock-reply', onClockReply);
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
  const read = (
    admission: MusicAdmission,
    input: MusicReadInput | undefined,
    principal: string,
    options: {
      signal?: AbortSignal;
      deadline?: number;
      isCurrent?: () => boolean;
      onPhysicalSettled?: (reason: MusicPhysicalSettlementReason) => void;
    } = {},
    binding?: PlaybackBinding,
    execute?: Pending['execute'],
  ): Promise<NativeMusicValue> => {
    const refused = (reason: MusicFailure) => {
      notify(options.onPhysicalSettled, 'not_admitted');
      return Promise.reject(new MusicServiceError(reason));
    };
    if (
      !current(admission) ||
      options.signal?.aborted ||
      !guardCurrent(options.isCurrent)
    )
      return refused('retired');
    // A server-owned guard can retire this coordinator synchronously. Main work
    // must not allocate an orphan waiter after that pre-admission callout.
    if (
      execute &&
      (!current(admission) ||
        options.signal?.aborted ||
        disposed ||
        navigating ||
        admission.generation !== generation)
    )
      return refused('retired');
    if (
      records.size >= 12 ||
      [...records.values()].filter((r) => r.phase === 'queued').length >= 8
    )
      return refused('busy');
    const lifetime = Math.min(
      input?.operation === 'current' ? 5000 : 15000,
      (options.deadline ?? Infinity) - Date.now(),
    );
    if (lifetime <= 0) return refused('timeout');
    return new Promise((resolve, reject) => {
      const r: Pending = {
        id: randomUUID(),
        nonce: randomBytes(16).toString('hex'),
        admission,
        principal,
        input,
        binding,
        execute,
        ...(execute ? { mainController: new AbortController() } : {}),
        deadlineAt: Date.now() + lifetime,
        phase: 'queued',
        done: false,
        resolve,
        reject,
        signal: options.signal,
        isCurrent: options.isCurrent,
        onPhysicalSettled: options.onPhysicalSettled,
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
    clockResultOwner: (value: LegacyClockValue) =>
      resultOwners.get(value as unknown as NativeMusicValue),
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
      options: Parameters<typeof read>[3] = {},
    ) {
      return read(admission, input, principal, options);
    },
    /** Server-only execution on the exact native scheduler, not an IPC callback. */
    runOwned<T extends NativeMusicValue>(
      admission: MusicAdmission,
      principal: string,
      execute: (context: {
        signal: AbortSignal;
        deadline: number;
        current(): boolean;
      }) => Promise<T>,
      options: Parameters<typeof read>[3] = {},
    ): Promise<T> {
      return read(
        admission,
        undefined,
        principal,
        options,
        undefined,
        execute,
      ) as Promise<T>;
    },
    readClock(
      admission: MusicAdmission,
      binding: PlaybackBinding,
      principal: string,
      options: Parameters<typeof read>[3] = {},
    ): Promise<LegacyClockValue> {
      return read(
        admission,
        { operation: 'current' },
        principal,
        options,
        binding,
      ) as unknown as Promise<LegacyClockValue>;
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
