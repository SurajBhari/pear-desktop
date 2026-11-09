export const normalizeCollectionText = (value: string) =>
  value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const termsFor = (query: string) =>
  normalizeCollectionText(query.slice(0, 256))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export const matchesCollectionText = (text: string, query: string) => {
  const normalized = normalizeCollectionText(text);
  return termsFor(query).every((term) => normalized.includes(term));
};
export const isCollectionLocation = (location: string) => {
  try {
    const url = new URL(location);
    return (
      url.hostname === 'music.youtube.com' &&
      (url.pathname === '/playlist' ||
        (url.pathname === '/watch' && !!url.searchParams.get('list')) ||
        url.pathname.startsWith('/library') ||
        /^\/browse\/(?:MPRE|VL|FEmusic_library)/.test(url.pathname))
    );
  } catch {
    return false;
  }
};

const isWatchLocation = (location: string) => {
  try {
    const url = new URL(location);
    return url.hostname === 'music.youtube.com' && url.pathname === '/watch';
  } catch {
    return false;
  }
};

const collectionKey = (location: string) => {
  try {
    const url = new URL(location);
    return url.pathname === '/playlist' || url.pathname === '/watch'
      ? `${url.origin}/playlist?list=${url.searchParams.get('list') ?? ''}`
      : `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
};

type Labels = {
  label: string;
  placeholder: string;
  clear: string;
  results: (matches: number, total: number) => string;
};
const ROW = 'ytmusic-responsive-list-item-renderer';
const SHELVES =
  '#browse-page ytmusic-playlist-shelf-renderer, #browse-page ytmusic-shelf-renderer, ytmusic-browse-response ytmusic-playlist-shelf-renderer, ytmusic-browse-response ytmusic-shelf-renderer';

/** Filter only already-loaded collection rows. No pagination, account access or polling. */
export const startPlaylistSearch = (
  doc: Document,
  labels: Labels,
): (() => void) => {
  const view = doc.defaultView;
  if (!view) return () => {};
  let stopped = false;
  let eligible = isCollectionLocation(view.location.href);
  let ownerKey = collectionKey(view.location.href);
  let frame: number | undefined;
  let shelf: HTMLElement | undefined;
  let box: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let status: HTMLParagraphElement | undefined;
  let clear: HTMLButtonElement | undefined;
  let query = '';
  let widgetEpoch = 0;
  const cache = new WeakMap<HTMLElement, string>();
  const hidden = new Map<HTMLElement, { value: string; priority: string }>();
  const restore = (row: HTMLElement) => {
    const original = hidden.get(row);
    if (!original) return;
    // A later external display change belongs to its author, not this filter.
    if (
      row.style.getPropertyValue('display') === 'none' &&
      row.style.getPropertyPriority('display') === 'important'
    ) {
      if (original.value)
        row.style.setProperty('display', original.value, original.priority);
      else row.style.removeProperty('display');
    }
    hidden.delete(row);
  };
  const detach = (preserveQuery = false) => {
    widgetEpoch++;
    rowsObserver.disconnect();
    for (const row of hidden.keys()) restore(row);
    box?.remove();
    shelf = undefined;
    box = undefined;
    input = undefined;
    status = undefined;
    clear = undefined;
    if (!preserveQuery) query = '';
  };
  const apply = () => {
    if (!shelf?.isConnected || stopped) return;
    const rows = [...shelf.querySelectorAll<HTMLElement>(ROW)];
    for (const row of hidden.keys()) if (!shelf.contains(row)) restore(row);
    const terms = termsFor(query);
    let matches = 0;
    for (const row of rows) {
      let text = cache.get(row);
      if (text === undefined) {
        text = normalizeCollectionText(row.textContent ?? '');
        cache.set(row, text);
      }
      const match = terms.every((term) => text.includes(term));
      if (match) {
        matches++;
        restore(row);
      } else {
        if (
          !hidden.has(row) ||
          row.style.getPropertyValue('display') !== 'none' ||
          row.style.getPropertyPriority('display') !== 'important'
        )
          hidden.set(row, {
            value: row.style.getPropertyValue('display'),
            priority: row.style.getPropertyPriority('display'),
          });
        row.style.setProperty('display', 'none', 'important');
      }
    }
    const message = labels.results(matches, rows.length);
    if (status && status.textContent !== message) status.textContent = message;
    if (clear) clear.disabled = !query;
  };
  const visible = (candidate: HTMLElement) => {
    for (
      let node: HTMLElement | null = candidate;
      node;
      node = node.parentElement
    ) {
      if (
        node.hidden ||
        node.getAttribute('aria-hidden') === 'true' ||
        view.getComputedStyle(node).display === 'none'
      )
        return false;
    }
    return true;
  };
  const effectiveKey = () =>
    isWatchLocation(view.location.href) && shelf?.isConnected && visible(shelf)
      ? ownerKey
      : collectionKey(view.location.href);
  const mount = (knownShelf?: HTMLElement) => {
    if (stopped || !eligible) return;
    const candidate = (
      knownShelf
        ? [knownShelf]
        : [...doc.querySelectorAll<HTMLElement>(SHELVES)]
    ).find(
      (node) =>
        visible(node) &&
        node.querySelector(ROW) &&
        (!isWatchLocation(view.location.href) ||
          node === knownShelf ||
          node.localName === 'ytmusic-playlist-shelf-renderer'),
    );
    if (!candidate) return;
    shelf = candidate;
    box = doc.createElement('div');
    box.className = 'pear-playlist-search';
    box.setAttribute('role', 'search');
    const label = doc.createElement('label');
    const title = doc.createElement('span');
    title.textContent = labels.label;
    input = doc.createElement('input');
    input.type = 'search';
    input.maxLength = 256;
    input.autocomplete = 'off';
    input.value = query;
    input.placeholder = labels.placeholder;
    label.append(title, input);
    clear = doc.createElement('button');
    clear.type = 'button';
    clear.textContent = labels.clear;
    clear.disabled = !query;
    status = doc.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    box.append(label, clear, status);
    shelf.prepend(box);
    const epoch = ++widgetEpoch;
    const ownedInput = input;
    const ownedBox = box;
    const active = () =>
      !stopped &&
      widgetEpoch === epoch &&
      input === ownedInput &&
      box === ownedBox &&
      ownedBox.isConnected;
    const reset = () => {
      if (!input || !active()) return;
      input.value = '';
      query = '';
      schedule();
      input.focus();
    };
    input.addEventListener('input', () => {
      if (!active()) return;
      query = input?.value.slice(0, 256) ?? '';
      schedule();
    });
    input.addEventListener('keydown', (event) => {
      if (active() && event.key === 'Escape' && query) {
        event.preventDefault();
        event.stopPropagation();
        reset();
      }
    });
    clear.addEventListener('click', reset);
    rowsObserver.observe(shelf, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };
  const schedule = () => {
    if (stopped || frame !== undefined) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (stopped) return;
      if (effectiveKey() !== ownerKey) {
        route();
        return;
      }
      if (shelf && (!shelf.isConnected || !visible(shelf))) detach(true);
      else if (shelf && !box?.isConnected) {
        const known = shelf;
        detach(true);
        mount(known);
      }
      if (!shelf) mount();
      apply();
    });
  };
  const rowsObserver = new view.MutationObserver((records) => {
    let changed = false;
    for (const record of records) {
      if (box?.contains(record.target)) continue;
      const element =
        record.target.nodeType === 1
          ? (record.target as Element)
          : record.target.parentElement;
      const row = element?.closest<HTMLElement>(ROW);
      if (row) cache.delete(row);
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== 1) continue;
        const element = node as HTMLElement;
        if (element.matches(ROW)) cache.delete(element);
        for (const nested of element.querySelectorAll<HTMLElement>(ROW))
          cache.delete(nested);
      }
      changed = true;
    }
    if (changed) schedule();
  });
  const pageObserver = new view.MutationObserver((records) => {
    // Playback/menus elsewhere do not rescan an already-owned connected shelf.
    if (
      !shelf?.isConnected ||
      records.some(
        (record) =>
          record.type === 'attributes' &&
          (record.target === shelf || record.target.contains(shelf!)),
      )
    )
      schedule();
  });
  const route = () => {
    if (stopped) return;
    const knownVisible = !!shelf?.isConnected && visible(shelf);
    const nextKey = effectiveKey();
    const sameCollection = nextKey === ownerKey;
    ownerKey = nextKey;
    eligible =
      isCollectionLocation(view.location.href) ||
      (isWatchLocation(view.location.href) && knownVisible);
    if (!eligible || !sameCollection || !knownVisible)
      detach(eligible && sameCollection);
    pageObserver.disconnect();
    if (eligible) {
      pageObserver.observe(doc.body ?? doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden'],
      });
      schedule();
    }
  };
  const navigation = (view as Window & { navigation?: EventTarget }).navigation;
  doc.addEventListener('yt-navigate-finish', route);
  view.addEventListener('yt-navigate-finish', route);
  navigation?.addEventListener('currententrychange', route);
  view.addEventListener('popstate', route);
  route();
  return () => {
    if (stopped) return;
    stopped = true;
    pageObserver.disconnect();
    rowsObserver.disconnect();
    doc.removeEventListener('yt-navigate-finish', route);
    view.removeEventListener('yt-navigate-finish', route);
    navigation?.removeEventListener('currententrychange', route);
    view.removeEventListener('popstate', route);
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    detach();
  };
};
