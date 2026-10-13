import {
  createMusicRequestBroker,
  type MusicRequestBroker,
} from '@/providers/music-request';
import { samePlaybackBinding } from '@/providers/playback-owner';
import {
  getSongInfoPlaybackBinding,
  getSongInfoProvenance,
  isSongInfoCurrent,
  type SongInfo,
} from '@/providers/song-info';

import type { APIServerConfig } from '../config';
import type { BrowserWindow } from 'electron';

type Lease = {
  broker: MusicRequestBroker;
  scope: AbortController;
  release(): void;
};
export type LegacyClockCapture = {
  elapsedMilliseconds: number;
  isCurrent(): boolean;
};
const leases = new WeakMap<BrowserWindow, Lease>();
const requestScopes = new WeakMap<Request, AbortSignal>();
export function stopLegacyClock(window: BrowserWindow) {
  const lease = leases.get(window);
  if (!lease) return;
  leases.delete(window);
  lease.scope.abort();
  lease.release();
}
export function configureLegacyClock(
  window: BrowserWindow,
  config: APIServerConfig,
) {
  stopLegacyClock(window);
  if (!config.enabled) return;
  let broker: MusicRequestBroker | undefined;
  try {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    broker = createMusicRequestBroker(window);
    leases.set(window, {
      broker,
      scope: new AbortController(),
      release: broker.retain(),
    });
  } catch {
    // Missing or retired native context must not disable compatible legacy metadata.
    broker?.stop();
  }
}
/** Capture before asynchronous auth; reconfiguration cannot admit old requests later. */
export function captureLegacyRequestScope(
  request: Request,
  window: BrowserWindow,
) {
  requestScopes.set(
    request,
    leases.get(window)?.scope.signal ?? AbortSignal.abort(),
  );
}
export async function captureLegacyClock(
  window: BrowserWindow,
  info: SongInfo,
  principal: string,
  request: Request,
  current: () => boolean,
): Promise<LegacyClockCapture | undefined> {
  const lease = leases.get(window),
    token = getSongInfoProvenance(info),
    binding = getSongInfoPlaybackBinding(info),
    admittedScope = requestScopes.get(request);
  if (!lease || !token || !binding || admittedScope !== lease.scope.signal)
    return;
  const controller = new AbortController(),
    signals = [request.signal, lease.scope.signal];
  const abort = () => controller.abort();
  for (const signal of signals) {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }
  const owned = () =>
    !controller.signal.aborted &&
    signals.every((signal) => !signal.aborted) &&
    leases.get(window) === lease &&
    current() &&
    isSongInfoCurrent(info, window) &&
    getSongInfoProvenance(info) === token &&
    getSongInfoPlaybackBinding(info) === binding;
  try {
    if (!owned()) return;
    const admission = lease.broker.capture();
    const value = await lease.broker.readClock(admission, binding, principal, {
      signal: controller.signal,
      deadline: Date.now() + 1000,
      isCurrent: owned,
    });
    const resultOwner = lease.broker.clockResultOwner(value);
    const isCurrent = () =>
      owned() &&
      lease.broker.isCurrent(admission) &&
      samePlaybackBinding(value, binding) &&
      resultOwner?.current() === true &&
      // Native owner checks can synchronously retire this request's lease.
      !controller.signal.aborted &&
      signals.every((signal) => !signal.aborted) &&
      leases.get(window) === lease;
    if (isCurrent())
      return { elapsedMilliseconds: value.elapsedMilliseconds, isCurrent };
  } catch {
    // Precision is optional; compatible metadata is still returned.
  } finally {
    for (const signal of signals) signal.removeEventListener('abort', abort);
  }
  return undefined;
}
