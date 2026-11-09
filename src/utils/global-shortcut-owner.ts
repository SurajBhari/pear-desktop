import { globalShortcut } from 'electron';

export type GlobalShortcutOwner = {
  isCurrent(): boolean;
  signal?: AbortSignal;
};
type Lease = {
  owner: GlobalShortcutOwner;
  accelerator: string;
  invoke(): void;
  live: boolean;
  registered: boolean;
  rejected: boolean;
  signal?: AbortSignal;
  detachAbort?: () => void;
};
type Slot = { busy: boolean; current?: Lease; waiting: Lease[] };
const slots = new Map<string, Slot>();

// Reserve equivalent spellings before entering a native call. Native
// isRegistered remains authoritative for already confirmed registrations.
const reservationKey = (accelerator: string) => {
  const parts = accelerator
    .trim()
    .toLowerCase()
    .replace(/\+\+$/, '+plus')
    .split('+')
    .map((part) => part.trim());
  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    if (['cmdorctrl', 'commandorcontrol'].includes(part))
      modifiers.push(process.platform === 'darwin' ? 'meta' : 'control');
    else if (['command', 'cmd', 'super', 'meta'].includes(part))
      modifiers.push('meta');
    else if (['ctrl', 'control'].includes(part)) modifiers.push('control');
    else if (['alt', 'option'].includes(part)) modifiers.push('alt');
    else if (['shift', 'altgr'].includes(part)) modifiers.push(part);
    else
      keys.push(part === 'esc' ? 'escape' : part === 'return' ? 'enter' : part);
  }
  return [...new Set(modifiers)].sort().concat(keys).join('+');
};
const scalarCurrent = (slot: Slot, lease: Lease) =>
  slot.current === lease && lease.live && !lease.signal?.aborted;
const current = (slot: Slot, lease: Lease) => {
  if (!scalarCurrent(slot, lease)) return false;
  try {
    const allowed = lease.owner.isCurrent();
    return allowed && scalarCurrent(slot, lease);
  } catch {
    return false;
  }
};

function drain(key: string, slot: Slot) {
  if (slot.busy) return;
  slot.busy = true;
  try {
    for (;;) {
      const previous = slot.current;
      if (previous) {
        if (previous.registered && current(slot, previous)) {
          for (const waiting of slot.waiting.splice(0)) {
            waiting.rejected = true;
            waiting.detachAbort?.();
            console.warn(
              'Global shortcut is already owned',
              waiting.accelerator,
            );
          }
          return;
        }
        if (previous.registered) {
          // Keep the reservation through unregister. A reentrant successor
          // cannot become native until this physical removal returns.
          try {
            globalShortcut.unregister(previous.accelerator);
          } catch (error) {
            console.warn(
              'Unable to unregister global shortcut',
              previous.accelerator,
              error,
            );
            return;
          }
          previous.registered = false;
        }
        previous.detachAbort?.();
        slot.current = undefined;
      }
      const lease = slot.waiting.shift();
      if (!lease) return;
      slot.current = lease;
      if (!current(slot, lease)) {
        lease.rejected = true;
        continue;
      }
      try {
        const occupied = globalShortcut.isRegistered(lease.accelerator);
        if (!current(slot, lease)) {
          lease.rejected = true;
          continue;
        }
        if (occupied) {
          lease.rejected = true;
          console.warn(
            'Global shortcut is already registered',
            lease.accelerator,
          );
          continue;
        }
        lease.registered = globalShortcut.register(lease.accelerator, () => {
          if (
            lease.registered &&
            current(slot, lease) &&
            slots.get(key) === slot &&
            scalarCurrent(slot, lease)
          )
            lease.invoke();
        });
        if (!lease.registered) {
          lease.rejected = true;
          console.warn('Unable to register global shortcut', lease.accelerator);
        }
      } catch (error) {
        lease.rejected = true;
        console.warn(
          'Unable to register global shortcut',
          lease.accelerator,
          error,
        );
      }
      // A canceled pending registration can have succeeded physically. The
      // next iteration rolls back only that confirmed owned registration.
    }
  } finally {
    slot.busy = false;
    if (!slot.current && !slot.waiting.length && slots.get(key) === slot)
      slots.delete(key);
  }
}

/** A returned disposer can own a deferred intent; it never removes an unconfirmed or foreign binding. */
export function registerOwnedGlobalShortcut(
  owner: GlobalShortcutOwner,
  accelerator: string,
  invoke: () => void,
): (() => void) | undefined {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return;
  const key = reservationKey(accelerator);
  let slot = slots.get(key);
  if (!slot) {
    slot = { busy: false, waiting: [] };
    slots.set(key, slot);
  }
  const lease: Lease = {
    owner,
    accelerator,
    invoke,
    live: true,
    registered: false,
    rejected: false,
    signal: owner.signal,
  };
  slot.waiting.push(lease);
  const release = () => {
    lease.live = false;
    if (slot.current === lease || slot.waiting.includes(lease))
      drain(key, slot);
  };
  lease.signal?.addEventListener('abort', release, { once: true });
  lease.detachAbort = () => lease.signal?.removeEventListener('abort', release);
  if (lease.signal?.aborted) lease.live = false;
  drain(key, slot);
  return lease.rejected ? undefined : release;
}
