export type PlayPauseInput = {
  scope: 'global' | 'local';
  bindingId: string;
  pressId?: number;
  repeat?: boolean;
};
export function createPlayPauseGesture(options: {
  now(): number;
  isCurrent(): boolean;
  playPause(): void;
  focusWindow(): void;
}) {
  let arm: { bindingId: string; time: number } | undefined;
  let lastGlobal: number | undefined;
  let quietUntil: number | undefined;
  const localPresses = new Map<string, number>();
  return {
    reset() {
      arm = undefined;
      lastGlobal = undefined;
      quietUntil = undefined;
      localPresses.clear();
    },
    invoke(input: PlayPauseInput) {
      if (!options.isCurrent()) return;
      if (input.scope === 'local') {
        if (
          input.repeat ||
          input.pressId === undefined ||
          localPresses.get(input.bindingId) === input.pressId
        )
          return;
        localPresses.set(input.bindingId, input.pressId);
      }
      const now = options.now();
      if (!Number.isFinite(now)) return;
      if (quietUntil !== undefined && now < quietUntil) {
        quietUntil = now + 400;
        if (input.scope === 'global') lastGlobal = now;
        return;
      }
      quietUntil = undefined;
      if (input.scope === 'global') {
        const elapsed = lastGlobal === undefined ? Infinity : now - lastGlobal;
        lastGlobal = now;
        if (elapsed >= 0 && elapsed < 100) {
          arm = undefined;
          quietUntil = now + 400;
          return;
        }
      }
      if (
        arm?.bindingId === input.bindingId &&
        now - arm.time >= 0 &&
        now - arm.time <= 400
      ) {
        arm = undefined;
        quietUntil = now + 400;
        if (options.isCurrent()) options.focusWindow();
      } else {
        arm = { bindingId: input.bindingId, time: now };
        if (options.isCurrent()) options.playPause();
      }
    },
  };
}
