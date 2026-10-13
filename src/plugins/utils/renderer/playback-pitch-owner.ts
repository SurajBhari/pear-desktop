import {
  getPlaybackRateOwner,
  subscribePlaybackRateOwner,
} from './playback-rate-owner';

const PITCH_KEYS = [
  'preservesPitch',
  'mozPreservesPitch',
  'webkitPreservesPitch',
] as const;

interface FlagLease {
  group: Set<FlagLease>;
  read: () => unknown;
  applyPreference: () => void;
  markForeign: () => void;
  release: (canRestore?: () => boolean) => void;
}

interface PitchLease {
  video: HTMLVideoElement;
  owner: string;
  readonly epoch: number;
  retired: boolean;
  preference: boolean;
  flags: FlagLease[];
}

interface Binding {
  owner: string;
  video: HTMLVideoElement | null;
  preference: boolean;
  lease: PitchLease | null;
}

const bindings = new Set<Binding>();
const leases = new WeakMap<HTMLVideoElement, PitchLease>();
const epochs = new WeakMap<HTMLVideoElement, number>();
let epoch = 0;
let unsubscribe: (() => void) | null = null;
let reconciling = false;
let pending = false;

function sameDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  return (
    left?.get === right?.get &&
    left?.set === right?.set &&
    left?.value === right?.value &&
    left?.writable === right?.writable &&
    left?.enumerable === right?.enumerable &&
    left?.configurable === right?.configurable
  );
}

/** Observe only this instance; native prototypes and unsupported flags stay intact. */
function leaseFlag(
  video: HTMLVideoElement,
  key: (typeof PITCH_KEYS)[number],
  preference: boolean,
  isCurrent: () => boolean,
): FlagLease | null {
  if (!isCurrent()) return null;
  const own = Object.getOwnPropertyDescriptor(video, key);
  if (own && !own.configurable) return null;
  let source: object | null = video;
  let descriptor: PropertyDescriptor | undefined;
  while (source && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) source = Object.getPrototypeOf(source) as object | null;
  }
  if (!descriptor) return null;
  const data = 'value' in descriptor;
  if (data ? !descriptor.writable : !descriptor.get || !descriptor.set)
    return null;
  let value: unknown = descriptor.value;
  let original: unknown;
  try {
    original = data ? value : descriptor.get!.call(video);
  } catch {
    return null;
  }
  if (
    !isCurrent() ||
    !sameDescriptor(Object.getOwnPropertyDescriptor(video, key), own) ||
    !sameDescriptor(
      Object.getOwnPropertyDescriptor(source!, key),
      descriptor,
    ) ||
    typeof original !== 'boolean'
  )
    return null;
  let internal = false;
  let foreign = false;
  let flag: FlagLease;
  const get = data
    ? () => value
    : function (this: HTMLVideoElement) {
        return descriptor.get!.call(this) as unknown;
      };
  const set = function (this: HTMLVideoElement, next: unknown) {
    const ownedWrite = this === video && internal;
    // Consume only this exact write. A normal nested assignment from the
    // original setter is foreign, even while its outer owned call is pending.
    if (ownedWrite) internal = false;
    if (this === video && !ownedWrite) {
      for (const linked of flag.group) linked.markForeign();
    }
    if (data) value = next;
    else descriptor.set!.call(this, next);
  };
  const enumerable = own?.enumerable ?? descriptor.enumerable ?? false;
  const intact = () => {
    const current = Object.getOwnPropertyDescriptor(video, key);
    return (
      current?.get === get &&
      current.set === set &&
      current.configurable === true &&
      current.enumerable === enumerable
    );
  };
  const write = (next: boolean): boolean => {
    if (!isCurrent() || !intact()) return false;
    internal = true;
    try {
      set.call(video, next);
    } finally {
      internal = false;
    }
    return isCurrent() && intact();
  };
  try {
    if (!isCurrent()) return null;
    Object.defineProperty(video, key, {
      configurable: true,
      enumerable,
      get,
      set,
    });
  } catch {
    // A descriptor that cannot be observed remains outside this lease.
    if (intact()) {
      if (own) Object.defineProperty(video, key, own);
      else Reflect.deleteProperty(video, key);
    }
    return null;
  }
  flag = {
    group: new Set(),
    read() {
      try {
        if (!isCurrent() || !intact()) return undefined;
        const current = get.call(video);
        return isCurrent() && intact() ? current : undefined;
      } catch {
        return undefined;
      }
    },
    applyPreference() {
      try {
        if (!isCurrent() || !intact()) return;
        const current = get.call(video);
        if (isCurrent() && intact() && current !== preference)
          write(preference);
      } catch {
        /* A rejecting setter leaves its current native value intact. */
      }
    },
    markForeign() {
      foreign = true;
    },
    release(canRestore = () => false) {
      if (!intact()) return; // A foreign defineProperty owns the descriptor now.
      try {
        // The lease is logically retired, but observation stays live through
        // original accessor callouts. Reconciliation defers successor capture
        // until this exact wrapper has been detached in guaranteed cleanup.
        if (foreign || !canRestore()) return;
        const current = Reflect.get(video, key) as unknown;
        if (!foreign && canRestore() && intact() && current === preference) {
          internal = true;
          try {
            set.call(video, original);
          } finally {
            internal = false;
          }
          if (foreign || !canRestore() || !intact()) return;
        }
      } catch {
        /* A native getter/setter may become unavailable during teardown. */
      } finally {
        if (intact()) {
          const restored = own
            ? data
              ? { ...own, value }
              : own
            : data && foreign
              ? { configurable: true, enumerable: true, writable: true, value }
              : undefined;
          if (restored) Object.defineProperty(video, key, restored);
          else Reflect.deleteProperty(video, key);
        }
      }
    },
  };
  flag.group.add(flag);
  if (!isCurrent()) {
    flag.release();
    return null;
  }
  return flag;
}

function releaseLease(binding: Binding): void {
  const lease = binding.lease;
  binding.lease = null;
  if (
    !lease ||
    leases.get(lease.video) !== lease ||
    lease.owner !== binding.owner
  )
    return;
  leases.delete(lease.video);
  lease.retired = true;
  const owner = getPlaybackRateOwner(lease.video);
  const canRestore = () =>
    epochs.get(lease.video) === lease.epoch &&
    !leases.has(lease.video) &&
    getPlaybackRateOwner(lease.video) === owner;
  for (const flag of lease.flags) flag.release(canRestore);
}

function reconcile(): void {
  pending = true;
  if (reconciling) return;
  reconciling = true;
  try {
    while (pending) {
      pending = false;
      reconcileBindings();
    }
  } finally {
    reconciling = false;
  }
}

function ownerChanged(): void {
  for (const binding of bindings) {
    if (
      binding.lease &&
      getPlaybackRateOwner(binding.lease.video) !== binding.owner
    )
      binding.lease.retired = true;
  }
  reconcile();
}

function reconcileBindings(): void {
  // Finish the old exact lease before snapshotting the next owner's baseline.
  for (const binding of bindings) {
    if (
      binding.lease &&
      (binding.lease.retired ||
        binding.video !== binding.lease.video ||
        binding.preference !== binding.lease.preference ||
        getPlaybackRateOwner(binding.lease.video) !== binding.owner)
    )
      releaseLease(binding);
  }
  for (const binding of bindings) {
    const { video, owner, preference } = binding;
    if (
      !video ||
      binding.lease ||
      leases.has(video) ||
      getPlaybackRateOwner(video) !== owner
    )
      continue;
    const lease: PitchLease = {
      video,
      owner,
      epoch: ++epoch,
      retired: false,
      preference,
      flags: [],
    };
    leases.set(video, lease);
    epochs.set(video, lease.epoch);
    binding.lease = lease;
    const isCurrent = () =>
      !lease.retired &&
      binding.lease === lease &&
      leases.get(video)?.epoch === lease.epoch &&
      binding.video === video &&
      binding.preference === preference &&
      getPlaybackRateOwner(video) === owner;
    for (const key of PITCH_KEYS) {
      if (!isCurrent()) break;
      const flag = leaseFlag(video, key, preference, isCurrent);
      if (flag) lease.flags.push(flag);
    }
    // Snapshot all flags before any write. Some engines expose native aliases
    // backed by the same state; a foreign setter through either owns that state.
    for (const flag of lease.flags) {
      if (!isCurrent()) break;
      const before = lease.flags.map((candidate) => candidate.read());
      if (!isCurrent()) break;
      flag.applyPreference();
      if (!isCurrent()) break;
      const group = new Set(flag.group);
      for (const [index, candidate] of lease.flags.entries()) {
        const current = candidate.read();
        if (!isCurrent()) break;
        if (before[index] !== current) {
          for (const linked of candidate.group) group.add(linked);
        }
      }
      if (!isCurrent()) break;
      for (const linked of group) linked.group = group;
    }
  }
  for (const binding of bindings)
    if (!binding.video && !binding.lease) bindings.delete(binding);
  if (!bindings.size) {
    unsubscribe?.();
    unsubscribe = null;
  }
}

/** A pitch preference follows rate ownership; it never claims or writes a rate. */
export function createPlaybackPitchOwner(owner: string) {
  const binding: Binding = {
    owner,
    video: null,
    preference: true,
    lease: null,
  };
  return {
    set(video: HTMLVideoElement, preference: boolean): void {
      bindings.add(binding);
      unsubscribe ??= subscribePlaybackRateOwner(ownerChanged);
      if (
        binding.lease &&
        (binding.video !== video || binding.preference !== preference)
      )
        binding.lease.retired = true;
      binding.video = video;
      binding.preference = preference;
      reconcile();
    },
    release(): void {
      if (binding.lease) binding.lease.retired = true;
      binding.video = null;
      reconcile();
    },
  };
}
