import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture() {
  const raw = await readFile(
    new URL('../src/providers/window-visibility.ts', import.meta.url),
    'utf8',
  );
  const source = stripTypeScriptTypes(raw).replace(/^import[\s\S]*?;\n/gm, '');
  const actual = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const win = Object.assign(new EventEmitter(), {
    visible: false,
    destroyed: false,
    shows: 0,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    show() {
      this.shows++;
      this.visible = true;
      this.emit('show');
    },
  });
  return { win, actual };
}

test('unpainted visible startup is revealed by the 500ms fallback', async () => {
  const { win, actual } = await fixture();
  const started = performance.now();
  const shown = new Promise<number>((resolve) =>
    win.once('show', () => resolve(performance.now() - started)),
  );
  const stop = actual.setupInitialWindowVisibility(win, () => true);
  try {
    expect(win.shows).toBe(0);
    expect(await shown).toBeGreaterThanOrEqual(450);
    expect(win.shows).toBe(1);
    expect(win.listenerCount('ready-to-show')).toBe(0);
    expect(win.listenerCount('closed')).toBe(0);
  } finally {
    stop();
  }
});

test('ready-to-show shows immediately once and disposes fallback listeners', async () => {
  const { win, actual } = await fixture();
  const foreign = () => {};
  win.on('closed', foreign);
  const stop = actual.setupInitialWindowVisibility(win, () => true, 30);
  win.emit('ready-to-show');
  expect(win.shows).toBe(1);
  expect(win.listeners('closed')).toEqual([foreign]);
  await pause(55);
  expect(win.shows).toBe(1);
  stop();
});

test('current hidden preference and window closure both prevent delayed visibility', async () => {
  for (const close of [false, true]) {
    const { win, actual } = await fixture();
    let visible = true;
    const stop = actual.setupInitialWindowVisibility(win, () => visible, 20);
    visible = false;
    if (close) {
      win.destroyed = true;
      win.emit('closed');
    }
    await pause(40);
    expect(win.shows).toBe(0);
    expect(win.listenerCount('ready-to-show')).toBe(0);
    expect(win.listenerCount('closed')).toBe(0);
    stop();
  }
});

test('already-visible and destroyed windows install no new startup work', async () => {
  for (const destroyed of [false, true]) {
    const { win, actual } = await fixture();
    win.destroyed = destroyed;
    win.visible = !destroyed;
    const stop = actual.setupInitialWindowVisibility(win, () => true, 10);
    expect(win.eventNames()).toEqual([]);
    await pause(20);
    expect(win.shows).toBe(0);
    stop();
  }
});

test('external show, explicit stop and closure inside config lookup retire the fallback', async () => {
  for (const mode of ['show', 'stop', 'reentrant-close']) {
    const { win, actual } = await fixture();
    const stop = actual.setupInitialWindowVisibility(
      win,
      () => {
        if (mode === 'reentrant-close') {
          win.destroyed = true;
          win.emit('closed');
        }
        return true;
      },
      20,
    );
    if (mode === 'show') win.show();
    if (mode === 'stop') stop();
    await pause(40);
    expect(win.shows).toBe(mode === 'show' ? 1 : 0);
    expect(win.eventNames()).toEqual([]);
    stop();
  }
});

test('external show, inactive show and hide preserve delegated receiver args and return without native events', async () => {
  for (const key of ['show', 'showInactive', 'hide'] as const) {
    const { win, actual } = await fixture();
    const calls: unknown[] = [];
    const native = function (this: unknown, ...args: unknown[]) {
      calls.push({ receiver: this === win, args });
      return 'native-result';
    };
    Object.defineProperty(win, key, {
      value: native,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    const prior = Object.getOwnPropertyDescriptor(win, key);
    const stop = actual.setupInitialWindowVisibility(win, () => true, 20);
    const leased = (win as any)[key];
    expect(leased).not.toBe(native);
    expect(Reflect.apply(leased, win, ['owned', 7])).toBe('native-result');
    expect(calls).toEqual([{ receiver: true, args: ['owned', 7] }]);
    expect(Object.getOwnPropertyDescriptor(win, key)).toEqual(prior);
    await pause(40);
    expect(win.shows).toBe(0);
    expect(win.eventNames()).toEqual([]);
    stop();
  }
});

test('teardown restores own previous accessor and preserves foreign method replacement and callbacks', async () => {
  const { win, actual } = await fixture();
  const native = win.show;
  const getter = () => native;
  Object.defineProperty(win, 'show', {
    get: getter,
    configurable: true,
    enumerable: false,
  });
  const prior = Object.getOwnPropertyDescriptor(win, 'show');
  const foreign = () => {};
  win.on('closed', foreign);
  Object.defineProperty(win, 'hide', {
    value: () => {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(win, 'showInactive', {
    value: () => {},
    configurable: true,
    writable: true,
  });
  const stop = actual.setupInitialWindowVisibility(win, () => true, 20);
  const retained = win.show;
  const later = () => 'foreign';
  Object.defineProperty(win, 'hide', {
    value: () => {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(win, 'showInactive', {
    value: later,
    configurable: true,
    writable: true,
  });
  stop();
  expect(Object.getOwnPropertyDescriptor(win, 'show')).toEqual(prior);
  expect((win as any).showInactive).toBe(later);
  expect(win.listeners('closed')).toEqual([foreign]);
  expect(Reflect.apply(retained, win, [])).toBeUndefined();
  expect(win.shows).toBe(1);
  expect(win.listeners('closed')).toEqual([foreign]);
  await pause(40);
  expect(win.shows).toBe(1);
});

test('reentrant explicit hide during current config lookup prevents the fallback reveal', async () => {
  const { win, actual } = await fixture();
  let hides = 0;
  (win as any).hide = () => {
    hides++;
  };
  const stop = actual.setupInitialWindowVisibility(
    win,
    () => {
      (win as any).hide();
      return true;
    },
    20,
  );
  await pause(40);
  expect(hides).toBe(1);
  expect(win.shows).toBe(0);
  expect(win.eventNames()).toEqual([]);
  stop();
});

test('later foreign visibility methods remain owned after explicit retirement and retained callbacks', async () => {
  const { win, actual } = await fixture();
  const native = function (this: unknown, ...args: unknown[]) {
    return { receiver: this, args };
  };
  Object.defineProperty(win, 'hide', {
    value: native,
    configurable: true,
    writable: true,
  });
  const stop = actual.setupInitialWindowVisibility(win, () => true, 20);
  const retained = (win as any).hide;
  const foreign = () => 'later';
  Object.defineProperty(win, 'hide', {
    value: foreign,
    configurable: true,
    writable: false,
    enumerable: true,
  });
  const newer = Object.getOwnPropertyDescriptor(win, 'hide');
  const receiver = { owned: false };
  expect(Reflect.apply(retained, receiver, [1, 2])).toEqual({
    receiver,
    args: [1, 2],
  });
  expect(Object.getOwnPropertyDescriptor(win, 'hide')).toEqual(newer);
  await pause(40);
  expect(win.shows).toBe(0);
  expect(win.eventNames()).toEqual([]);
  stop();
});

test('an unreplaceable foreign visibility method preserves readiness while disabling unsafe fallback', async () => {
  const { win, actual } = await fixture();
  const native = () => 'unreplaceable';
  Object.defineProperty(win, 'hide', {
    value: native,
    configurable: false,
    writable: false,
    enumerable: false,
  });
  const prior = Object.getOwnPropertyDescriptor(win, 'hide');
  const show = Object.getOwnPropertyDescriptor(win, 'show');
  const stop = actual.setupInitialWindowVisibility(win, () => true, 20);
  expect(Object.getOwnPropertyDescriptor(win, 'hide')).toEqual(prior);
  await pause(40);
  expect(win.shows).toBe(0);
  win.emit('ready-to-show');
  expect(win.shows).toBe(1);
  expect(Object.getOwnPropertyDescriptor(win, 'hide')).toEqual(prior);
  expect(Object.getOwnPropertyDescriptor(win, 'show')).toEqual(show);
  expect(win.eventNames()).toEqual([]);
  stop();
});

test('a foreign method takeover before fallback retires without invoking or replacing it', async () => {
  const { win, actual } = await fixture();
  let foreignCalls = 0;
  const stop = actual.setupInitialWindowVisibility(win, () => true, 20);
  const foreign = () => {
    foreignCalls++;
  };
  Object.defineProperty(win, 'show', {
    value: foreign,
    configurable: true,
    writable: true,
  });
  const replacement = Object.getOwnPropertyDescriptor(win, 'show');
  await pause(40);
  expect(foreignCalls).toBe(0);
  expect(win.shows).toBe(0);
  expect(Object.getOwnPropertyDescriptor(win, 'show')).toEqual(replacement);
  expect(win.eventNames()).toEqual([]);
  stop();
});
