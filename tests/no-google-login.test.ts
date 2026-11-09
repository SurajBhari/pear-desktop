import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
async function loadController() {
  return import('../src/plugins/no-google-login/dom.ts') as Promise<{
    createLoginControlHider(document: Document): {
      start(): void;
      stop(): void;
    };
  }>;
}

const isHidden = (dom: Window, element: Element) =>
  dom.getComputedStyle(element).display === 'none';

test('hides only login-dependent controls and restores them on stop', async () => {
  const dom = new Window();
  const { createLoginControlHider } = await loadController();
  const { document } = dom;
  document.body.innerHTML = `
    <a class="sign-in-link ytmusic-nav-bar" href="/signin">Sign in</a>
    <ytmusic-guide-signin-promo-renderer></ytmusic-guide-signin-promo-renderer>
    <ytmusic-pivot-bar-renderer class="ytmusic-pivot-bar-renderer" tab-id="FEmusic_liked">Liked music</ytmusic-pivot-bar-renderer>
    <a class="nav-link" href="/explore">Explore</a>
    <a href="/music_premium">Premium</a>
  `;
  const controller = createLoginControlHider(document);

  controller.start();
  controller.start();
  await dom.happyDOM.whenAsyncComplete();
  expect(
    document.querySelectorAll('style[data-pear-no-google-login]'),
  ).toHaveLength(1);

  expect(isHidden(dom, document.querySelector('.sign-in-link')!)).toBe(true);
  expect(
    isHidden(
      dom,
      document.querySelector('ytmusic-guide-signin-promo-renderer')!,
    ),
  ).toBe(true);
  expect(
    isHidden(dom, document.querySelector('[tab-id="FEmusic_liked"]')!),
  ).toBe(true);
  expect(isHidden(dom, document.querySelector('.nav-link')!)).toBe(false);
  expect(
    isHidden(dom, document.querySelector('a[href="/music_premium"]')!),
  ).toBe(true);
  expect(document.querySelector('.sign-in-link')?.className).toBe(
    'sign-in-link ytmusic-nav-bar',
  );
  expect(document.querySelector('[tab-id="FEmusic_liked"]')?.className).toBe(
    'ytmusic-pivot-bar-renderer',
  );

  controller.stop();
  controller.stop();
  expect(isHidden(dom, document.querySelector('.sign-in-link')!)).toBe(false);
  expect(
    isHidden(dom, document.querySelector('[tab-id="FEmusic_liked"]')!),
  ).toBe(false);
  expect(document.querySelector('style[data-pear-no-google-login]')).toBeNull();
  await dom.happyDOM.close();
});

test('hides login controls inserted by SPA navigation and stops observing on disable', async () => {
  const dom = new Window();
  const { createLoginControlHider } = await loadController();
  const { document } = dom;
  const controller = createLoginControlHider(document);

  controller.start();
  const lateControl = document.createElement('a');
  lateControl.className = 'sign-in-link';
  document.body.append(lateControl);
  await dom.happyDOM.whenAsyncComplete();
  expect(isHidden(dom, lateControl)).toBe(true);

  controller.stop();
  const afterStop = document.createElement('a');
  afterStop.className = 'sign-in-link';
  document.body.append(afterStop);
  await dom.happyDOM.whenAsyncComplete();
  expect(isHidden(dom, afterStop)).toBe(false);
  await dom.happyDOM.close();
});

test('updates owned hiding when an SPA reuses and retargets an existing link', async () => {
  const dom = new Window();
  const { createLoginControlHider } = await loadController();
  const { document } = dom;
  document.body.innerHTML = '<a id="reused" href="/explore">Explore</a>';
  const link = document.querySelector<HTMLAnchorElement>('#reused')!;
  const controller = createLoginControlHider(document);
  controller.start();

  link.setAttribute('href', 'https://accounts.google.com/ServiceLogin');
  await dom.happyDOM.whenAsyncComplete();
  expect(isHidden(dom, link)).toBe(true);

  link.setAttribute('href', '/explore');
  await dom.happyDOM.whenAsyncComplete();
  expect(isHidden(dom, link)).toBe(false);

  link.setAttribute('href', 'https://accounts.google.com/ServiceLogin');
  await dom.happyDOM.whenAsyncComplete();
  expect(isHidden(dom, link)).toBe(true);

  controller.stop();
  expect(isHidden(dom, link)).toBe(false);
  expect(link.className).toBe('');
  await dom.happyDOM.close();
});

test('hides existing controls after SPA class and tab-id changes without changing their attributes', async () => {
  const dom = new Window();
  const { createLoginControlHider } = await loadController();
  const { document } = dom;
  document.body.innerHTML = `
    <a id="reused-login">Explore</a>
    <ytmusic-pivot-bar-renderer id="reused-pivot" class="ytmusic-pivot-bar-renderer" tab-id="FEother">Other</ytmusic-pivot-bar-renderer>
  `;
  const login = document.querySelector<HTMLAnchorElement>('#reused-login')!;
  const pivot = document.querySelector<HTMLElement>('#reused-pivot')!;
  const controller = createLoginControlHider(document);
  controller.start();

  login.className = 'sign-in-link';
  pivot.setAttribute('tab-id', 'FEmusic_liked');
  await dom.happyDOM.whenAsyncComplete();

  expect(isHidden(dom, login)).toBe(true);
  expect(isHidden(dom, pivot)).toBe(true);
  expect(login.className).toBe('sign-in-link');
  expect(pivot.className).toBe('ytmusic-pivot-bar-renderer');

  controller.stop();
  expect(isHidden(dom, login)).toBe(false);
  expect(isHidden(dom, pivot)).toBe(false);
  await dom.happyDOM.close();
});
