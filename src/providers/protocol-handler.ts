import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import { getSongControls } from './song-controls';

export const APP_PROTOCOL =
  '\u0079\u006f\u0075\u0074\u0075\u0062\u0065\u006d\u0075\u0073\u0069\u0063';

type Handler = (cmd: string, ...args: string[]) => void;
type Owner = { isCurrent(): boolean; signal?: AbortSignal };
type Lease = {
  handler: Handler;
  owner?: Owner;
  live: boolean;
  previous?: Lease;
};
let current: Lease | undefined;
export function registerOwnedProtocolHandler(owner: Owner, handler: Handler) {
  const previous = current;
  if (!owner.isCurrent() || owner.signal?.aborted || current !== previous)
    return () => {};
  const lease: Lease = { handler, owner, live: true, previous };
  current = lease;
  const dispose = () => {
    if (!lease.live) return;
    lease.live = false;
    owner.signal?.removeEventListener('abort', dispose);
    if (current !== lease) return;
    let restore = lease.previous;
    while (restore) {
      const candidate = restore;
      const valid =
        candidate.live && (!candidate.owner || candidate.owner.isCurrent());
      const aborted = candidate.owner?.signal?.aborted;
      if (current !== lease) return;
      // A prior predicate can dispose that candidate while the upper slot stays current.
      if (valid && !aborted && candidate.live) break;
      restore = candidate.previous;
    }
    if (current === lease) current = restore;
  };
  owner.signal?.addEventListener('abort', dispose, { once: true });
  if (owner.signal?.aborted) dispose();
  return dispose;
}

export function setupProtocolHandler(win: BrowserWindow) {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL);
  }

  const songControls = getSongControls(win);

  changeProtocolHandler(((cmd: keyof typeof songControls, ...args) => {
    if (Object.keys(songControls).includes(cmd)) {
      // @ts-expect-error: cmd is a key of songControls
      songControls[cmd](...args);
    }
  }) as Handler);
}

export function handleProtocol(cmd: string, ...args: string[]) {
  const lease = current;
  if (!lease?.live) return;
  if (lease.owner && (!lease.owner.isCurrent() || lease.owner.signal?.aborted))
    return;
  if (current === lease && lease.live) lease.handler(cmd, ...args);
}

export function changeProtocolHandler(
  f: (cmd: string, ...args: string[]) => void,
) {
  current = { handler: f, live: true };
}
