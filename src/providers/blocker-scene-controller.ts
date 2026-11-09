import type {
  BlockerPlaybackScene,
  BlockerSceneCapture,
  BlockerSceneOutcome,
} from '@/types/blocker-scene';

export type SceneReleaseReason =
  | 'complete'
  | 'cancelled'
  | 'failed'
  | 'timeout';
interface SceneTransport {
  capture: () => Promise<BlockerSceneCapture>;
  verify: (scene: BlockerPlaybackScene) => Promise<boolean>;
  valid: () => boolean;
  reload: (
    scene: BlockerPlaybackScene | null,
    generation: number,
  ) => Promise<void>;
  restore: (
    scene: BlockerPlaybackScene,
    generation: number,
  ) => Promise<BlockerSceneOutcome>;
  release: (
    generation: number,
    reason: SceneReleaseReason,
  ) => void | Promise<void>;
}
const bounded = async <T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Scene operation timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** One document transaction owns its mute/guard. Identical Apply clicks coalesce. */
export const createBlockerSceneController = (transport: SceneTransport) => {
  let revision = 0;
  let cancellationRevision = 0;
  let status: BlockerSceneOutcome = { kind: 'verified' };
  let running: Promise<BlockerSceneOutcome> | undefined;
  let queued: Promise<BlockerSceneOutcome> | undefined;
  let phase: 'capture' | 'reload' | 'restore' | 'idle' = 'idle';
  const execute = async (
    explicit: boolean,
    generation: number,
  ): Promise<BlockerSceneOutcome> => {
    let releaseReason: SceneReleaseReason = 'cancelled';
    const current = () => generation === revision && transport.valid();
    const finish = (result: BlockerSceneOutcome) => {
      if (generation === revision) status = result;
      if (
        current() &&
        (result.kind === 'verified' || result.kind === 'partial')
      )
        releaseReason = 'complete';
      return result;
    };
    try {
      if (!current()) return finish({ kind: 'cancelled' });
      phase = 'capture';
      const captured = await bounded(transport.capture(), 1_500);
      if (!current()) return finish({ kind: 'cancelled' });
      if (captured.kind === 'unavailable')
        return finish({ kind: 'pending', reason: captured.reason });
      if (captured.kind === 'idle') {
        const confirmed = await bounded(transport.capture(), 1_500);
        if (
          !current() ||
          confirmed.kind !== 'idle' ||
          confirmed.documentId !== captured.documentId ||
          confirmed.url !== captured.url ||
          confirmed.version !== captured.version
        )
          return finish({
            kind: 'cancelled',
            reason: 'The user changed the idle document before reload',
          });
        phase = 'reload';
        await bounded(transport.reload(null, generation), 12_000);
        return finish(current() ? { kind: 'verified' } : { kind: 'cancelled' });
      }
      if (
        !explicit &&
        captured.scene.queue &&
        (captured.scene.queue.items.length !==
          captured.scene.queue.ids.length ||
          captured.scene.queue.ids[captured.scene.queue.index] !==
            captured.scene.videoId)
      )
        return finish({
          kind: 'pending',
          reason:
            'Active queue data cannot be restored safely; document changes are pending.',
        });
      if (
        !(await bounded(transport.verify(captured.scene), 1_500)) ||
        !current()
      )
        return finish({
          kind: 'cancelled',
          reason: 'The user changed the playback scene',
        });
      phase = 'reload';
      await bounded(transport.reload(captured.scene, generation), 12_000);
      if (!current()) return finish({ kind: 'cancelled' });
      phase = 'restore';
      const result = await bounded(
        transport.restore(captured.scene, generation),
        12_000,
      );
      return finish(current() ? result : { kind: 'cancelled' });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Scene restoration failed';
      releaseReason = reason.includes('timed out') ? 'timeout' : 'failed';
      return finish(
        current() ? { kind: 'failed', reason } : { kind: 'cancelled' },
      );
    } finally {
      await transport.release(generation, releaseReason);
    }
  };
  const apply = (explicit: boolean): Promise<BlockerSceneOutcome> => {
    if (running) {
      if (explicit) return running;
      // New effective changes supersede an uncommitted capture. Once reloading,
      // finish restoring the original scene before applying the latest change.
      if (phase === 'capture') {
        const old = revision++;
        Promise.resolve(transport.release(old, 'cancelled')).catch(() => {});
      }
      if (!queued) {
        const queuedAt = cancellationRevision;
        queued = running.then(() => {
          queued = undefined;
          if (queuedAt !== cancellationRevision)
            return { kind: 'cancelled' } as BlockerSceneOutcome;
          return apply(false);
        });
      }
      return queued;
    }
    const operation = execute(explicit, ++revision);
    running = operation;
    operation
      .finally(() => {
        if (running === operation) {
          running = undefined;
          phase = 'idle';
        }
      })
      .catch(() => {});
    return operation;
  };
  const cancel = () => {
    cancellationRevision++;
    const old = revision++;
    Promise.resolve(transport.release(old, 'cancelled')).catch(() => {});
    status = { kind: 'cancelled' };
  };
  return {
    apply,
    cancel,
    getStatus: () => status,
    isApplying: () => !!running,
  };
};
