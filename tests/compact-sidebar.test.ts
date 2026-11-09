import { test, expect } from '@playwright/test';
import { Window, DOMRect, PropertySymbol } from 'happy-dom';
async function loadController() {
  return import('../src/plugins/compact-sidebar/dom.ts') as Promise<{
    createCompactSidebarController(document: Document): {
      start(): void;
      stop(): void;
    };
  }>;
}

function retainHappyDOMMutationDelivery(dom: Window) {
  const NativeObserver = dom.MutationObserver;
  dom.MutationObserver = class extends NativeObserver {
    private readonly reportCallbacks = new Set<unknown>();

    observe(
      target: Parameters<typeof NativeObserver.prototype.observe>[0],
      options: Parameters<typeof NativeObserver.prototype.observe>[1],
    ) {
      super.observe(target, options);
      // Happy DOM strongly retains the user callback, but its separate report
      // closure is held only by WeakRef. Keep actual delivery alive until stop.
      for (const listener of target[PropertySymbol.mutationListeners]) {
        const callback = listener.callback.deref();
        if (callback) this.reportCallbacks.add(callback);
      }
    }

    disconnect() {
      super.disconnect();
      this.reportCallbacks.clear();
    }
  };
}

function installNativeSidebarFixture(
  document: Document,
  initiallyCompact: boolean,
) {
  document.body.innerHTML = `
    <ytmusic-app-layout>
      <button id="button">Unrelated button</button>
      <div aria-controls="guide">Unrelated non-control</div>
      <button id="native-navigation-toggle" aria-controls="guide" aria-label="Navigation menu">Toggle navigation</button>
      <div id="mini-guide" ${initiallyCompact ? '' : 'hidden'}>Compact navigation</div>
      <div id="guide" ${initiallyCompact ? 'hidden' : ''}>Expanded navigation</div>
    </ytmusic-app-layout>
  `;
  const toggle = document.querySelector<HTMLButtonElement>(
    '#native-navigation-toggle',
  )!;
  const compact = document.querySelector<HTMLElement>('#mini-guide')!;
  const expanded = document.querySelector<HTMLElement>('#guide')!;
  const setCompact = (value: boolean) => {
    compact.hidden = !value;
    expanded.hidden = value;
  };
  toggle.addEventListener('click', () => setCompact(compact.hidden));
}

test('enforces the native compact state through the explicit navigation control and restores prior state', async () => {
  const dom = new Window();
  const { createCompactSidebarController } = await loadController();
  const { document } = dom;
  installNativeSidebarFixture(document, false);
  const unrelatedButton = document.querySelector<HTMLButtonElement>('#button')!;
  let unrelatedClicks = 0;
  unrelatedButton.addEventListener('click', () => unrelatedClicks++);
  const controller = createCompactSidebarController(document);

  controller.start();
  await dom.happyDOM.whenAsyncComplete();
  expect(document.querySelector<HTMLElement>('#mini-guide')?.hidden).toBe(
    false,
  );
  expect(unrelatedClicks).toBe(0);

  controller.stop();
  expect(document.querySelector<HTMLElement>('#mini-guide')?.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>('#guide')?.hidden).toBe(false);
  await dom.happyDOM.close();
});

test('keeps a sidebar that was already compact when the plugin stops', async () => {
  const dom = new Window();
  const { createCompactSidebarController } = await loadController();
  const { document } = dom;
  installNativeSidebarFixture(document, true);
  const controller = createCompactSidebarController(document);

  controller.start();
  controller.start();
  controller.stop();
  controller.stop();

  expect(document.querySelector<HTMLElement>('#mini-guide')?.hidden).toBe(
    false,
  );
  expect(document.querySelector<HTMLElement>('#guide')?.hidden).toBe(true);
  await dom.happyDOM.close();
});

function installActualGuideFixture(
  document: Document,
  initiallyCompact = false,
  withApp = false,
) {
  document.body.innerHTML = `
    ${withApp ? '<ytmusic-app>' : ''}
    <ytmusic-app-layout>
      <button id="unrelated" aria-label="Guide">Unrelated</button>
      <ytmusic-nav-bar>
        <div style="display:none"><yt-icon-button id="guide-button" data-hidden>
          <button id="button" aria-label="Guide"></button>
        </yt-icon-button></div>
        <div><yt-icon-button id="guide-button" data-navigation>
          <button id="button" aria-label="Guide"></button>
        </yt-icon-button></div>
      </ytmusic-nav-bar>
      <ytmusic-guide-renderer><div><yt-icon-button id="guide-button" data-close>
        <button id="button" aria-label="Close"></button>
      </yt-icon-button></div></ytmusic-guide-renderer>
      <div id="mini-guide" ${initiallyCompact ? '' : 'hidden'}>Compact</div>
      <div id="guide" ${initiallyCompact ? 'hidden' : ''}>Expanded</div>
    </ytmusic-app-layout>
    ${withApp ? '</ytmusic-app>' : ''}`;
  const native = document.querySelector<HTMLElement>('[data-navigation]')!;
  const mini = document.querySelector<HTMLElement>('#mini-guide')!;
  const expanded = document.querySelector<HTMLElement>('#guide')!;
  const clicks = { navigation: 0, hidden: 0, close: 0, unrelated: 0 };
  for (const element of document.querySelectorAll<HTMLElement>(
    'yt-icon-button',
  )) {
    element.getBoundingClientRect = () => new DOMRect(0, 0, 40, 40);
  }
  native.addEventListener('click', () => {
    clicks.navigation++;
    mini.hidden = !mini.hidden;
    expanded.hidden = !mini.hidden;
  });
  document
    .querySelector('[data-hidden]')!
    .addEventListener('click', () => clicks.hidden++);
  document
    .querySelector('[data-close]')!
    .addEventListener('click', () => clicks.close++);
  document
    .querySelector('#unrelated')!
    .addEventListener('click', () => clicks.unrelated++);
  return { native, mini, expanded, clicks };
}

test('actual Music Guide markup selects the visible nav-bar native toggle and restores initial state', async () => {
  const dom = new Window();
  const { createCompactSidebarController } = await loadController();
  const fixture = installActualGuideFixture(dom.document);
  const controller = createCompactSidebarController(dom.document);
  try {
    controller.start();
    await dom.happyDOM.whenAsyncComplete();
    expect(fixture.mini.hidden).toBe(false);
    expect(fixture.expanded.hidden).toBe(true);
    expect(fixture.clicks).toEqual({
      navigation: 1,
      hidden: 0,
      close: 0,
      unrelated: 0,
    });
    controller.stop();
    expect(fixture.mini.hidden).toBe(true);
    expect(fixture.expanded.hidden).toBe(false);
    expect(fixture.clicks).toEqual({
      navigation: 2,
      hidden: 0,
      close: 0,
      unrelated: 0,
    });
  } finally {
    controller.stop();
    await dom.happyDOM.close();
  }
});

test('native fallback keeps an initially compact sidebar and does not click invisible navigation', async () => {
  const dom = new Window();
  const { createCompactSidebarController } = await loadController();
  const fixture = installActualGuideFixture(dom.document, true);
  const controller = createCompactSidebarController(dom.document);
  try {
    controller.start();
    controller.stop();
    expect(fixture.clicks.navigation).toBe(0);
    expect(fixture.mini.hidden).toBe(false);
    fixture.mini.hidden = true;
    fixture.native.style.visibility = 'hidden';
    controller.start();
    await dom.happyDOM.whenAsyncComplete();
    expect(fixture.clicks.navigation).toBe(0);
    fixture.native.style.visibility = '';
    fixture.native.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    fixture.native.setAttribute('class', 'zero-area');
    await dom.happyDOM.whenAsyncComplete();
    expect(fixture.clicks.navigation).toBe(0);
  } finally {
    controller.stop();
    await dom.happyDOM.close();
  }
});

test('late native navigation is observed with one attempt when its click cannot compact the layout', async () => {
  const dom = new Window();
  const { createCompactSidebarController } = await loadController();
  const fixture = installActualGuideFixture(dom.document);
  fixture.native.remove();
  const controller = createCompactSidebarController(dom.document);
  try {
    controller.start();
    const late = dom.document.createElement('yt-icon-button');
    late.id = 'guide-button';
    late.getBoundingClientRect = () => new DOMRect(0, 0, 40, 40);
    late.innerHTML = '<button id="button" aria-label="Guide"></button>';
    let clicks = 0;
    late.addEventListener('click', () => clicks++);
    dom.document.querySelector('ytmusic-nav-bar')!.append(late);
    await dom.happyDOM.whenAsyncComplete();
    expect(clicks).toBe(1);
    for (let index = 0; index < 20; index++)
      late.setAttribute('class', `change-${index}`);
    controller.start();
    await dom.happyDOM.whenAsyncComplete();
    expect(clicks).toBe(1);
    controller.stop();
    late.setAttribute('class', 'after-stop');
    await dom.happyDOM.whenAsyncComplete();
    expect(clicks).toBe(1);
    expect(fixture.clicks.close).toBe(0);
  } finally {
    controller.stop();
    await dom.happyDOM.close();
  }
});

test('observed native collapse avoids narrow startup clicks and re-enforces only actual state changes', async () => {
  const dom = new Window();
  retainHappyDOMMutationDelivery(dom);
  const { createCompactSidebarController } = await loadController();
  const fixture = installActualGuideFixture(dom.document, false, true);
  const app = dom.document.querySelector('ytmusic-app')!;
  app.setAttribute('guide-collapsed', '');
  fixture.mini.style.display = 'none';
  fixture.native.addEventListener('click', () =>
    app.setAttribute('guide-collapsed', ''),
  );
  const expandNativeGuide = () => {
    fixture.mini.hidden = true;
    fixture.mini.style.display = 'none';
    fixture.expanded.hidden = false;
    app.removeAttribute('mini-guide-visible');
    app.removeAttribute('guide-collapsed');
  };
  const controller = createCompactSidebarController(dom.document);
  try {
    controller.start();
    await dom.happyDOM.whenAsyncComplete();
    expect(fixture.clicks.navigation).toBe(0);
    for (let index = 0; index < 20; index++)
      app.setAttribute('class', `narrow-${index}`);
    await dom.happyDOM.whenAsyncComplete();
    expect(fixture.clicks.navigation).toBe(0);
    expandNativeGuide();
    await dom.happyDOM.whenAsyncComplete();
    await expect.poll(() => fixture.clicks.navigation).toBe(1);
    for (let index = 0; index < 20; index++) {
      app.setAttribute('guide-collapsed', '');
      app.setAttribute('mini-guide-visible', '');
      app.setAttribute('class', `unchanged-${index}`);
    }
    await dom.happyDOM.whenAsyncComplete();
    controller.start();
    await expect.poll(() => fixture.clicks.navigation).toBe(1);
    expandNativeGuide();
    await dom.happyDOM.whenAsyncComplete();
    await expect.poll(() => fixture.clicks.navigation).toBe(2);
    controller.stop();
    await expect.poll(() => fixture.clicks.navigation).toBe(2);
  } finally {
    controller.stop();
    await dom.happyDOM.close();
  }
});

test('mini-guide-visible attribute alone observes a native CSS compact-state change', async () => {
  const dom = new Window();
  retainHappyDOMMutationDelivery(dom);
  const { createCompactSidebarController } = await loadController();
  const fixture = installActualGuideFixture(dom.document, false, true);
  const app = dom.document.querySelector('ytmusic-app')!;
  const style = dom.document.createElement('style');
  style.textContent =
    '#mini-guide{display:none} ytmusic-app[mini-guide-visible] #mini-guide{display:block}';
  dom.document.head.append(style);
  fixture.mini.hidden = false;
  app.setAttribute('mini-guide-visible', '');
  // Keep this CSS read boundary explicit: Happy DOM caches this ancestor
  // attribute rule even when mutation delivery is retained. DOM attributes,
  // observer filtering/delivery and native clicks still execute normally.
  const computedStyle = dom.getComputedStyle.bind(dom);
  dom.getComputedStyle = (element, pseudoElement) => {
    const value = computedStyle(element, pseudoElement);
    if (element !== fixture.mini) return value;
    return new Proxy(value, {
      get(target, property) {
        if (property === 'display')
          return app.hasAttribute('mini-guide-visible') ? 'block' : 'none';
        return Reflect.get(target, property, target);
      },
    });
  };
  fixture.native.addEventListener('click', () =>
    app.setAttribute('guide-collapsed', ''),
  );
  const controller = createCompactSidebarController(dom.document);
  try {
    controller.start();
    await dom.happyDOM.whenAsyncComplete();
    expect(fixture.clicks.navigation).toBe(0);
    app.removeAttribute('mini-guide-visible');
    await dom.happyDOM.whenAsyncComplete();
    await expect.poll(() => fixture.clicks.navigation).toBe(1);
  } finally {
    controller.stop();
    await dom.happyDOM.close();
  }
});
