type Toast = HTMLElement & { close?: () => void };
const AUTO_CLOSE_MS = 3000;

export function startToastAutoclose(doc: Document): () => void {
  const app = doc.querySelector('ytmusic-app');
  const view = doc.defaultView;
  if (!app || !view) return () => {};
  let stopped = false;
  const timers = new Map<Toast, number>();
  const current = () =>
    !stopped && app.isConnected && doc.querySelector('ytmusic-app') === app;
  const isOpen = (toast: Toast) =>
    app.contains(toast) && toast.classList.contains('paper-toast-open');
  const cancel = (toast: Toast) => {
    const timer = timers.get(toast);
    if (timer !== undefined) view.clearTimeout(timer);
    timers.delete(toast);
  };
  const arm = (toast: Toast) => {
    if (timers.has(toast) || !isOpen(toast)) return;
    const timer = view.setTimeout(() => {
      if (timers.get(toast) !== timer) return;
      timers.delete(toast);
      if (!current()) {
        stop();
        return;
      }
      if (!isOpen(toast)) return;
      // Keep keyboard users' actions available while they have focus.
      if (doc.activeElement && toast.contains(doc.activeElement)) {
        arm(toast);
        return;
      }
      const button =
        toast.querySelector<HTMLElement>('#close-button button') ??
        toast.querySelector<HTMLElement>('#close-button');
      try {
        if (
          button &&
          !button.hasAttribute('disabled') &&
          button.getAttribute('aria-disabled') !== 'true'
        ) {
          const click: unknown = Reflect.get(button, 'click');
          if (
            current() &&
            isOpen(toast) &&
            toast.contains(button) &&
            typeof click === 'function'
          )
            Reflect.apply(click, button, []);
        } else {
          const close = toast.close;
          if (current() && isOpen(toast) && typeof close === 'function')
            Reflect.apply(close, toast, []);
        }
      } catch {
        /* No DOM removal or repeated retry for unsupported site controls. */
      }
    }, AUTO_CLOSE_MS);
    timers.set(toast, timer);
  };
  const scan = () => {
    if (!current()) {
      stop();
      return;
    }
    for (const toast of timers.keys()) if (!isOpen(toast)) cancel(toast);
    for (const toast of app.querySelectorAll<Toast>(
      'tp-yt-paper-toast.paper-toast-open',
    ))
      arm(toast);
  };
  const observeAncestors = (): void => {
    ownerObserver.disconnect();
    // Direct lists cover removal of any wrapper without observing its subtree.
    for (let node = app.parentNode; node; node = node.parentNode)
      ownerObserver.observe(node, { childList: true });
  };
  const ownerObserver = new view.MutationObserver(() => {
    if (!current()) stop();
    else observeAncestors();
  });
  const observer = new view.MutationObserver((records) => {
    if (!current()) {
      stop();
      return;
    }
    const reset = new Set<Toast>();
    let related = false;
    for (const record of records) {
      const element =
        record.target instanceof view.Element
          ? record.target
          : record.target.parentElement;
      const toast = element?.closest<Toast>('tp-yt-paper-toast');
      if (
        record.type === 'childList' &&
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof view.Element &&
            (node.matches('tp-yt-paper-toast') ||
              node.querySelector('tp-yt-paper-toast')),
        )
      )
        related = true;
      if (!toast || !app.contains(toast)) continue;
      related = true;
      if (
        record.type !== 'attributes' ||
        (record.target === toast &&
          !(record.oldValue ?? '').split(/\s+/).includes('paper-toast-open'))
      )
        reset.add(toast);
    }
    if (!related) return;
    for (const toast of reset) cancel(toast);
    scan();
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    ownerObserver.disconnect();
    for (const toast of timers.keys()) cancel(toast);
    view.removeEventListener('pagehide', stop);
  };
  observeAncestors();
  observer.observe(app, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['class'],
  });
  view.addEventListener('pagehide', stop);
  scan();
  return stop;
}
