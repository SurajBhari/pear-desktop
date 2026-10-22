type Direction = 'back' | 'forward';

const quietPeriod = 600;
const threshold = 180;
const reversalQuietPeriod = 40;
const meaningfulReversalDelta = 12;
type HistoryEntry = { key: string; index: number };
type Traversal = {
  from: HistoryEntry;
  to: HistoryEntry;
  sign: number;
  requested: number;
};
const protectedControls =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="textbox"],[role="spinbutton"],[role="combobox"],[role="listbox"],ytmusic-player-bar,[data-no-history-swipe]';
const overlaySelector =
  'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],tp-yt-iron-dropdown[opened],tp-yt-paper-dialog[opened]';

function protectedElement(element: Element | null) {
  return Boolean(element?.matches(protectedControls));
}

function visibleOverlay(element: Element) {
  if (!element.matches(overlaySelector) || !element.getClientRects().length)
    return false;
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function* composedAncestors(element: Element) {
  let current: Element | null = element;
  while (current) {
    yield current;
    const root = current.getRootNode();
    current =
      current.assignedSlot ??
      current.parentElement ??
      (root instanceof element.ownerDocument.defaultView!.ShadowRoot
        ? root.host
        : null);
  }
}

function hasVisibleShadowOverlay(doc: Document) {
  const roots: (Document | ShadowRoot)[] = [doc];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (Array.from(root.querySelectorAll(overlaySelector)).some(visibleOverlay))
      return true;
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return false;
}

function documentAvailable(doc: Document, inspectShadowOverlays = false) {
  if (doc.hidden || !doc.hasFocus()) return false;
  let active = doc.activeElement;
  while (active) {
    for (const element of composedAncestors(active)) {
      if (protectedElement(element) || visibleOverlay(element)) return false;
    }
    active = active.shadowRoot?.activeElement ?? null;
  }
  // YouTube uses custom dialogs as well as native HTML dialogs. Only a visible
  // overlay blocks navigation; many closed popup roots stay in the document.
  return inspectShadowOverlays
    ? !hasVisibleShadowOverlay(doc)
    : !Array.from(doc.querySelectorAll(overlaySelector)).some(visibleOverlay);
}

function allowsSwipe(event: WheelEvent, doc: Document) {
  if (!documentAvailable(doc) || event.defaultPrevented) return false;
  for (const node of event.composedPath()) {
    if (!(node instanceof doc.defaultView!.Element)) continue;
    if (protectedElement(node) || visibleOverlay(node)) return false;
    const style = doc.defaultView!.getComputedStyle(node);
    if (['contain', 'none'].includes(style.overscrollBehaviorX)) return false;
    // Preserve the entire interaction with a carousel, including its edges.
    // A wheel stream must not become Back just because its target reaches an end.
    if (
      node.scrollWidth > node.clientWidth + 1 &&
      ['auto', 'scroll', 'hidden'].includes(style.overflowX)
    )
      return false;
  }
  return true;
}

/**
 * Electron has no Safari-style two-finger history API. DOM pixel-wheel streams
 * provide app-level navigation, not physical finger/phase identification. Quiet
 * grouping suppresses ordinary momentum; real trackpad qualification is separate.
 * No polling, DOM observers, or wheel cancellation is needed.
 */
export function attachHistoryGestures(win: Window, initialEnabled: boolean) {
  const doc = win.document;
  const navigation = (
    win as Window & {
      navigation?: {
        currentEntry: HistoryEntry | null;
        entries(): HistoryEntry[];
      };
    }
  ).navigation;
  let enabled = initialEnabled;
  let last = -Infinity;
  let x = 0;
  let y = 0;
  let samples = 0;
  let opposite = 0;
  let sign = 0;
  let locked = false;
  let expectedTraversal: Traversal | undefined;
  let confirmedTraversal: (Traversal & { confirmed: number }) | undefined;
  let reversal: typeof confirmedTraversal;
  let reversalSamples = 0;
  let lockedVertical = 0;
  let disposed = false;
  let pending: number | undefined;
  let queue: { event: WheelEvent; time: number; allowed: boolean }[] = [];
  const clearPending = () => {
    if (pending !== undefined) win.clearTimeout(pending);
    pending = undefined;
    queue = [];
  };
  const reset = () => {
    last = -Infinity;
    x = y = samples = opposite = sign = 0;
    locked = false;
    expectedTraversal = confirmedTraversal = reversal = undefined;
    reversalSamples = 0;
    lockedVertical = 0;
  };
  const interrupt = () => {
    clearPending();
    expectedTraversal = confirmedTraversal = reversal = undefined;
    reversalSamples = 0;
    lockedVertical = 0;
    locked = true;
    last = win.performance.now();
  };
  const sameEntry = (
    entry: HistoryEntry | null | undefined,
    other: HistoryEntry,
  ) => entry?.key === other.key && entry.index === other.index;
  const canReverse = (traversal: Traversal) =>
    sameEntry(navigation?.currentEntry, traversal.to) &&
    navigation?.entries().some((entry) => sameEntry(entry, traversal.from));
  const navigate = (direction: Direction, wheelSign = 0) => {
    interrupt();
    const from = navigation?.currentEntry;
    const to =
      from &&
      navigation
        ?.entries()
        .find(
          (entry) =>
            entry.index === from.index + (direction === 'back' ? -1 : 1),
        );
    // Only a wheel request with a known adjacent destination can grant the
    // narrow reversal escape. A native command or a no-op cannot grant it.
    if (wheelSign && from && to)
      expectedTraversal = {
        from: { key: from.key, index: from.index },
        to: { key: to.key, index: to.index },
        sign: wheelSign,
        requested: win.performance.now(),
      };
    if (direction === 'back') win.history.back();
    else win.history.forward();
  };
  const popstate = () => {
    const traversal = expectedTraversal;
    const time = win.performance.now();
    interrupt();
    // A fixed receipt deadline is never renewed by momentum. Matching the
    // destination bounds the heuristic; DOM history has no causal request ID.
    if (
      traversal &&
      time - traversal.requested <= quietPeriod &&
      canReverse(traversal)
    )
      confirmedTraversal = { ...traversal, confirmed: time };
  };
  const consume = ({ event, time, allowed }: (typeof queue)[number]) => {
    if (disposed || !enabled) return;
    const gap = time - last;
    const fresh = gap > quietPeriod;
    if (fresh) reset();
    last = time;
    if (!allowed || event.defaultPrevented || !documentAvailable(doc, fresh)) {
      locked = true;
      expectedTraversal = confirmedTraversal = reversal = undefined;
      return;
    }
    if (locked) {
      // Small vertical/diagonal samples also own their interaction. A genuine
      // horizontal tail breaks this run instead of accumulating its minor y.
      if (
        Math.abs(event.deltaX) >= 2 &&
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) * 1.8
      )
        lockedVertical = 0;
      else lockedVertical += Math.abs(event.deltaY);
      if (lockedVertical >= 12) {
        expectedTraversal = confirmedTraversal = reversal = undefined;
        return;
      }
      const traversal = confirmedTraversal;
      if (!traversal || time < traversal.confirmed) {
        confirmedTraversal = undefined;
        return;
      }
      if (
        gap <= reversalQuietPeriod ||
        !event.deltaX ||
        Math.sign(event.deltaX) === traversal.sign
      )
        return;
      if (!canReverse(traversal) || !documentAvailable(doc, true)) {
        confirmedTraversal = undefined;
        return;
      }
      // Preserve a tiny opposite prefix as part of the candidate, then require
      // sustained meaningful input. Same-direction momentum never starts one.
      reset();
      last = time;
      reversal = traversal;
    }
    if (reversal && !canReverse(reversal)) {
      interrupt();
      return;
    }
    x += event.deltaX;
    y += Math.abs(event.deltaY);
    if (
      reversal &&
      Math.sign(event.deltaX) !== reversal.sign &&
      Math.abs(event.deltaX) >= meaningfulReversalDelta
    )
      reversalSamples++;
    if (Math.abs(event.deltaX) >= 2) {
      samples++;
      sign ||= Math.sign(event.deltaX);
      if (Math.sign(event.deltaX) !== sign) opposite += Math.abs(event.deltaX);
    }
    // Lock a vertical/diagonal stream early and reject an intentional reversal.
    if ((y >= 12 && Math.abs(x) < y * 1.8) || opposite > 32) {
      locked = true;
      expectedTraversal = confirmedTraversal = reversal = undefined;
      return;
    }
    if (
      samples >= 2 &&
      (!reversal || reversalSamples >= 2) &&
      Math.abs(x) >= threshold &&
      Math.abs(x) > y * 1.8
    ) {
      // Open roots are inspected at stream start and before committing, not on
      // every scroll sample. Overlays need not have moved focus yet.
      if (documentAvailable(doc, true))
        navigate(x < 0 ? 'back' : 'forward', Math.sign(x));
      else {
        locked = true;
        expectedTraversal = confirmedTraversal = reversal = undefined;
      }
    }
  };
  const wheel = (event: WheelEvent) => {
    if (disposed || !enabled || !event.isTrusted) return;
    if (queue.length >= 32) {
      interrupt();
      return;
    }
    queue.push({
      event,
      time: win.performance.now(),
      allowed:
        event.deltaMode === 0 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        Number.isFinite(event.deltaX) &&
        Number.isFinite(event.deltaY) &&
        allowsSwipe(event, doc),
    });
    // Every sample waits until the site has finished dispatching it. A canceled
    // initial sample owns the whole stream, not just the final threshold sample.
    if (pending === undefined)
      pending = win.setTimeout(() => {
        pending = undefined;
        const batch = queue;
        queue = [];
        for (const sample of batch) consume(sample);
      }, 0);
  };
  const interruptions = [
    'blur',
    'pagehide',
    'hashchange',
    'pointerdown',
  ] as const;
  win.addEventListener('wheel', wheel, { passive: true });
  win.addEventListener('popstate', popstate);
  for (const event of interruptions) win.addEventListener(event, interrupt);
  doc.addEventListener('visibilitychange', interrupt);
  return {
    setEnabled(value: boolean) {
      if (enabled !== value) {
        clearPending();
        reset();
      }
      enabled = value;
    },
    command(value: unknown) {
      if (!disposed && enabled && (value === 'back' || value === 'forward')) {
        interrupt();
        if (documentAvailable(doc, true)) navigate(value);
      }
    },
    dispose() {
      disposed = true;
      clearPending();
      win.removeEventListener('wheel', wheel);
      win.removeEventListener('popstate', popstate);
      for (const event of interruptions)
        win.removeEventListener(event, interrupt);
      doc.removeEventListener('visibilitychange', interrupt);
      reset();
    },
  };
}
