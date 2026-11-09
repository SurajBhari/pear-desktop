const MINI_GUIDE_SELECTOR = '#mini-guide';
const APP_LAYOUT_SELECTOR = 'ytmusic-app-layout';

const getCompactState = (document: Document): boolean | null => {
  const nativeCollapsed =
    document.querySelector('ytmusic-app')?.hasAttribute('guide-collapsed') ??
    false;
  const miniGuide = document.querySelector<HTMLElement>(MINI_GUIDE_SELECTOR);
  if (!miniGuide) return nativeCollapsed ? true : null;

  const style = document.defaultView?.getComputedStyle(miniGuide);
  return (
    nativeCollapsed ||
    !(
      miniGuide.hidden ||
      miniGuide.getAttribute('aria-hidden') === 'true' ||
      miniGuide.style.display === 'none' ||
      style?.display === 'none'
    )
  );
};

const findNativeToggle = (document: Document, compact: boolean) => {
  const layout = document.querySelector(APP_LAYOUT_SELECTOR);
  if (!layout) return null;

  const controlledToggle = layout.querySelector<HTMLElement>(
    'button[aria-controls~="guide"], [role="button"][aria-controls~="guide"], yt-icon-button[aria-controls~="guide"], button[aria-controls~="mini-guide"], [role="button"][aria-controls~="mini-guide"], yt-icon-button[aria-controls~="mini-guide"]',
  );
  if (controlledToggle) return controlledToggle;

  const actionPattern = compact ? /collapse|hide|mini guide/ : /expand|show/;
  const targetPattern = /navigation|sidebar|guide|menu/;

  const labelledToggle =
    Array.from(
      layout.querySelectorAll<HTMLElement>(
        'button[aria-label], [role="button"][aria-label], button[title]',
      ),
    ).find((button) => {
      const label =
        `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
          .trim()
          .toLowerCase();
      return actionPattern.test(label) && targetPattern.test(label);
    }) ?? null;
  if (labelledToggle) return labelledToggle;

  // Music's native nav control uses an inner "Guide" label without
  // aria-controls. The guide panel has a duplicate ID for its Close button.
  return (
    Array.from(
      layout.querySelectorAll<HTMLElement>(
        'ytmusic-nav-bar yt-icon-button#guide-button',
      ),
    ).find((button) => {
      for (
        let current: HTMLElement | null = button;
        current;
        current = current.parentElement
      ) {
        const style = document.defaultView?.getComputedStyle(current);
        if (
          current.hidden ||
          current.getAttribute('aria-hidden') === 'true' ||
          style?.display === 'none' ||
          style?.visibility === 'hidden' ||
          style?.visibility === 'collapse'
        )
          return false;
      }
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) ?? null
  );
};

export const createCompactSidebarController = (document: Document) => {
  let observer: MutationObserver | undefined;
  let started = false;
  let initialCompact: boolean | undefined;
  let attemptedToggles = new WeakSet<HTMLElement>();
  let lastCompact: boolean | undefined;

  const enforceCompact = () => {
    if (!started) return;
    const compact = getCompactState(document);
    if (compact === null) return;

    if (initialCompact === undefined) initialCompact = compact;
    if (compact !== lastCompact) {
      attemptedToggles = new WeakSet();
      lastCompact = compact;
    }
    if (compact) return;

    const toggle = findNativeToggle(document, true);
    if (toggle && !attemptedToggles.has(toggle)) {
      attemptedToggles.add(toggle);
      toggle.click();
    }
  };

  return {
    start() {
      if (started) {
        enforceCompact();
        return;
      }
      started = true;
      const state = getCompactState(document);
      if (state !== null) initialCompact = state;

      const Observer = document.defaultView?.MutationObserver;
      if (Observer && document.documentElement) {
        observer = new Observer(enforceCompact);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: [
            'aria-hidden',
            'aria-label',
            'class',
            'guide-collapsed',
            'hidden',
            'mini-guide-visible',
            'style',
            'title',
          ],
          childList: true,
          subtree: true,
        });
      }

      enforceCompact();
    },

    stop() {
      if (!started) return;
      observer?.disconnect();
      observer = undefined;
      started = false;

      const compact = getCompactState(document);
      if (initialCompact === false && compact === true) {
        findNativeToggle(document, false)?.click();
      }

      initialCompact = undefined;
      attemptedToggles = new WeakSet();
      lastCompact = undefined;
    },
  };
};
