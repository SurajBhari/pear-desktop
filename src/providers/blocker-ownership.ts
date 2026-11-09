interface BlockingEngine {
  enable: () => void;
  disable: () => void;
}

/** A session has one webRequest blocking engine, shared by independent owners. */
export const createOwnedBlocker = (
  build: (lists: string[], signal: AbortSignal) => Promise<BlockingEngine>,
) => {
  const owners = new Map<string, string[]>();
  const signatures = new Map<string, string>();
  let pending: AbortController | undefined;
  let generation = 0;
  let active: BlockingEngine | undefined;
  let activeOwners = new Set<string>();
  let activeKey: string | undefined;
  let queue = Promise.resolve();

  const set = (
    owner: string,
    lists: string[] | null,
    signature = '',
  ): Promise<void> => {
    pending?.abort();
    if (lists === null) {
      const existed = owners.delete(owner);
      signatures.delete(owner);
      // The current engine may contain this owner's filters. Never leave them
      // enabled after stop if fetching the remaining lists later fails.
      if (existed && activeOwners.has(owner)) {
        active?.disable();
        active = undefined;
        activeKey = undefined;
        activeOwners.clear();
      }
    } else {
      owners.set(owner, [...lists]);
      signatures.set(owner, signature);
    }
    const revision = ++generation;
    // Release immediately on last stop, even while a fetch is pending.
    if (owners.size === 0) {
      active?.disable();
      active = undefined;
      activeKey = undefined;
      activeOwners.clear();
    }
    const update = async () => {
      if (revision !== generation || owners.size === 0) return;
      const merged = [...new Set([...owners.values()].flat())].sort();
      const key = JSON.stringify([
        merged,
        [...signatures].sort(([a], [b]) => a.localeCompare(b)),
      ]);
      if (key === activeKey) return;
      const abort = new AbortController();
      pending = abort;
      let next: BlockingEngine;
      try {
        next = await build(merged, abort.signal);
      } catch (error) {
        if (revision !== generation) return;
        throw error;
      } finally {
        if (pending === abort) pending = undefined;
      }
      if (revision !== generation || owners.size === 0) return;
      active?.disable();
      active = undefined;
      activeKey = undefined;
      activeOwners.clear();
      next.enable();
      active = next;
      activeOwners = new Set(owners.keys());
      activeKey = key;
    };
    const result = queue.then(update);
    // An offline list must not poison subsequent start/stop operations.
    queue = result.catch(() => {});
    return result;
  };
  return { set };
};
