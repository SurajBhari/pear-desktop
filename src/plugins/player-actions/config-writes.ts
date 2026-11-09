import type { PlayerActionsConfig } from './index';

type Slice = 'slowedReverb' | 'sectionRepeat';
type Patch = Partial<Pick<PlayerActionsConfig, Slice>>;

/** Ordered writes retain newer local intent while an older IPC echo arrives. */
export class ConfigWrites {
  private serial = 0;
  private dirty = new Map<Slice, Map<string, number>>();
  private waiters = new Map<
    number,
    { resolve: () => void; reject: (error: unknown) => void }
  >();
  private inFlight: Patch | null = null;
  private draining = false;
  private completion: Promise<void> = Promise.resolve();

  constructor(
    private write: (patch: Patch) => Promise<void>,
    private read: () => PlayerActionsConfig,
  ) {}

  enqueue(slice: Slice, fields: string[]): Promise<void> {
    const serial = ++this.serial;
    const dirty = this.dirty.get(slice) ?? new Map<string, number>();
    for (const field of fields) dirty.set(field, serial);
    this.dirty.set(slice, dirty);
    const result = new Promise<void>((resolve, reject) => {
      this.waiters.set(serial, { resolve, reject });
    });
    // Every caller can await the rejection; fire-and-forget panel commits are
    // also handled, so a failed IPC write cannot escape as an unhandled promise.
    result.catch((error) =>
      console.error('[player-actions] settings write failed', error),
    );
    if (!this.draining) {
      this.draining = true;
      this.completion = this.drain();
    }
    return result;
  }

  accept(incoming: PlayerActionsConfig): PlayerActionsConfig {
    const next = { ...incoming };
    const current = this.read();
    for (const [slice, fields] of this.dirty) {
      const ownEcho = this.inFlight?.[slice];
      if (
        ownEcho &&
        JSON.stringify(ownEcho) === JSON.stringify(incoming[slice])
      ) {
        next[slice] = { ...current[slice] } as never;
        continue;
      }
      const merged = { ...incoming[slice] } as Record<string, unknown>;
      for (const field of fields.keys())
        merged[field] = (current[slice] as unknown as Record<string, unknown>)[
          field
        ];
      next[slice] = merged as never;
    }
    return next;
  }

  idle(): Promise<void> {
    return this.completion;
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty.size) {
        const covered = this.serial;
        const patch: Patch = {};
        const current = this.read();
        for (const slice of this.dirty.keys())
          patch[slice] = { ...current[slice] } as never;
        this.inFlight = patch;
        let failed = false;
        let failure: unknown;
        try {
          await this.write(patch);
        } catch (error) {
          failed = true;
          failure = error;
        }
        for (const [slice, fields] of this.dirty) {
          for (const [field, serial] of fields)
            if (serial <= covered) fields.delete(field);
          if (!fields.size) this.dirty.delete(slice);
        }
        for (const [serial, waiter] of this.waiters) {
          if (serial > covered) continue;
          this.waiters.delete(serial);
          if (failed) waiter.reject(failure);
          else waiter.resolve();
        }
        this.inFlight = null;
      }
    } finally {
      this.draining = false;
      this.inFlight = null;
    }
  }
}
