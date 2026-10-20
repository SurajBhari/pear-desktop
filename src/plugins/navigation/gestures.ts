type Direction = 'back' | 'forward';

const quietPeriod = 600;
const threshold = 180;
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
  let enabled = initialEnabled;
  let last = -Infinity;
  let x = 0;
  let y = 0;
  let samples = 0;
  let opposite = 0;
  let sign = 0;
  let locked = false;
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
  };
  const interrupt = () => {
    clearPending();
    locked = true;
    last = win.performance.now();
  };
  const navigate = (direction: Direction) => {
    interrupt();
    if (direction === 'back') win.history.back();
    else win.history.forward();
  };
  const consume = ({ event, time, allowed }: (typeof queue)[number]) => {
    if (disposed || !enabled) return;
    const fresh = time - last > quietPeriod;
    if (fresh) reset();
    last = time;
    if (locked) return;
    if (!allowed || event.defaultPrevented || !documentAvailable(doc, fresh)) {
      locked = true;
      return;
    }
    x += event.deltaX;
    y += Math.abs(event.deltaY);
    if (Math.abs(event.deltaX) >= 2) {
      samples++;
      sign ||= Math.sign(event.deltaX);
      if (Math.sign(event.deltaX) !== sign) opposite += Math.abs(event.deltaX);
    }
    // Lock a vertical/diagonal stream early and reject an intentional reversal.
    if ((y >= 12 && Math.abs(x) < y * 1.8) || opposite > 32) {
      locked = true;
      return;
    }
    if (samples >= 2 && Math.abs(x) >= threshold && Math.abs(x) > y * 1.8) {
      // Open roots are inspected at stream start and before committing, not on
      // every scroll sample. Overlays need not have moved focus yet.
      if (documentAvailable(doc, true)) navigate(x < 0 ? 'back' : 'forward');
      else locked = true;
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
    'popstate',
    'hashchange',
    'pointerdown',
  ] as const;
  win.addEventListener('wheel', wheel, { passive: true });
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
      if (
        !disposed &&
        enabled &&
        (value === 'back' || value === 'forward') &&
        documentAvailable(doc, true)
      )
        navigate(value);
    },
    dispose() {
      disposed = true;
      clearPending();
      win.removeEventListener('wheel', wheel);
      for (const event of interruptions)
        win.removeEventListener(event, interrupt);
      doc.removeEventListener('visibilitychange', interrupt);
      reset();
    },
  };
}
