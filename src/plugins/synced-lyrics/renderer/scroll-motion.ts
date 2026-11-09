type ScrollHandle = {
  scrollOffset: number;
  scrollSize: number;
  viewportSize: number;
  getItemOffset(index: number): number;
  getItemSize(index: number): number;
  scrollTo(offset: number): void;
};
type Scheduler = {
  now(): number;
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
};

// CSS --lyrics-ease-out: cubic-bezier(.23, 1, .32, 1), evaluated for scroll offsets.
const easeOut = (progress: number) => {
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    const remaining = 1 - t;
    const first = 3 * remaining * remaining * t * 0.23;
    const second = 3 * remaining * t * t * 0.32;
    const third = t * t * t;
    const x = first + second + third;
    if (x < progress) lo = t;
    else hi = t;
  }
  const middle = (lo + hi) / 2;
  const remaining = 1 - middle;
  const complement = remaining * remaining * remaining;
  return 1 - complement;
};

export function createLyricsScrollController(
  getHandle: () => ScrollHandle | undefined,
  scheduler: Scheduler = {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  },
) {
  let frame: number | undefined;
  let epoch = 0;
  const cancel = () => {
    epoch++;
    if (frame !== undefined) scheduler.cancel(frame);
    frame = undefined;
  };
  const move = (index: number, immediate = false) => {
    cancel();
    const handle = getHandle();
    if (!handle) return;
    const measuredTarget = () => {
      const halfItem = handle.getItemSize(index) / 2;
      const halfViewport = handle.viewportSize / 2;
      const offset = handle.getItemOffset(index) + halfItem - halfViewport;
      return Math.max(
        0,
        Math.min(handle.scrollSize - handle.viewportSize, offset),
      );
    };
    const target = measuredTarget();
    const from = handle.scrollOffset;
    if (![target, from].every(Number.isFinite)) return;
    if (handle.viewportSize > 0 && immediate) {
      handle.scrollTo(target);
      return;
    }
    const started = scheduler.now();
    const owner = epoch;
    const tick: FrameRequestCallback = (now) => {
      if (owner !== epoch || getHandle() !== handle) return;
      frame = undefined;
      const progress = Math.min(1, Math.max(0, (now - started) / 240));
      // A remounted virtual list initially reports viewport=0 and estimated rows.
      // Defer until laid out, and retain current measurements as rows are mounted.
      if (handle.viewportSize <= 0) {
        if (progress < 1) frame = scheduler.request(tick);
        return;
      }
      const target = measuredTarget();
      if (!Number.isFinite(target)) return;
      const distance = target - from;
      const change = distance * easeOut(progress);
      handle.scrollTo(immediate || progress === 1 ? target : from + change);
      if (immediate) return;
      if (progress < 1) frame = scheduler.request(tick);
    };
    frame = scheduler.request(tick);
  };
  return { move, cancel };
}
