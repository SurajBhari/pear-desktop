type Dialog = HTMLElement & { opened?: boolean; close?: () => void };

export function startMultideviceDismissal(doc: Document): () => void {
  const app = doc.querySelector('ytmusic-app');
  const view = doc.defaultView;
  if (!app || !view) return () => {};
  let stopped = false;
  const attempted = new WeakSet<Element>();
  const current = () =>
    !stopped && app.isConnected && doc.querySelector('ytmusic-app') === app;
  const opened = (dialog: Dialog): boolean => {
    try {
      return (
        dialog.opened === true ||
        dialog.hasAttribute('opened') ||
        dialog.hasAttribute('open')
      );
    } catch {
      // Unknown site state is ineligible; preserve the dialog and our disposer.
      return false;
    }
  };
  const scan = () => {
    if (!current()) {
      stop();
      return;
    }
    for (const renderer of app.querySelectorAll('ytmusic-you-there-renderer')) {
      if (!current()) break;
      const dialog = renderer.closest<Dialog>('tp-yt-paper-dialog');
      if (!dialog || !app.contains(dialog)) continue;
      const wasOpen = opened(dialog);
      if (!current()) break;
      if (!wasOpen) {
        attempted.delete(dialog);
        continue;
      }
      if (attempted.has(dialog)) continue;
      // Capture once: site accessors may retire the owner or replace the method.
      try {
        const close = dialog.close;
        if (
          !opened(dialog) ||
          !current() ||
          !app.contains(renderer) ||
          renderer.closest('tp-yt-paper-dialog') !== dialog ||
          typeof close !== 'function'
        )
          continue;
        attempted.add(dialog);
        Reflect.apply(close, dialog, []);
      } catch {
        /* Wait for a later closed/open transition. */
      }
    }
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
    let related = false;
    for (const record of records) {
      const element =
        record.target instanceof view.Element
          ? record.target
          : record.target.parentElement;
      if (element?.closest('tp-yt-paper-dialog, ytmusic-you-there-renderer'))
        related = true;
      if (
        record.type === 'childList' &&
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof view.Element &&
            (node.matches('ytmusic-you-there-renderer, tp-yt-paper-dialog') ||
              node.querySelector('ytmusic-you-there-renderer')),
        )
      )
        related = true;
      if (
        record.type === 'attributes' &&
        record.target instanceof view.HTMLElement &&
        record.target.matches('tp-yt-paper-dialog')
      ) {
        if (
          (record.attributeName === 'opened' ||
            record.attributeName === 'open') &&
          record.oldValue === null
        )
          attempted.delete(record.target);
      }
    }
    if (related) scan();
  });
  const onOpen = (event: Event) => {
    if (
      event.target instanceof view.HTMLElement &&
      app.contains(event.target) &&
      event.target.matches('tp-yt-paper-dialog')
    )
      attempted.delete(event.target);
    scan();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    ownerObserver.disconnect();
    app.removeEventListener('iron-overlay-opened', onOpen);
    view.removeEventListener('pagehide', stop);
  };
  observeAncestors();
  observer.observe(app, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['opened', 'open', 'class', 'hidden'],
  });
  app.addEventListener('iron-overlay-opened', onOpen);
  view.addEventListener('pagehide', stop);
  scan();
  return stop;
}
