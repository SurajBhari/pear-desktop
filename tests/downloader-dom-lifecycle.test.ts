import { test, expect } from '@playwright/test';

import { downloaderFixture } from './helpers/downloader-small-fixture';

const globals = globalThis as typeof globalThis & {
  fixtureBotguard?: { ticks: number };
};
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

for (const outcome of ['success', 'failure', 'retirement', 'close-reject']) {
  test(`actual initializer stops owned DOM timers after ${outcome}`, async () => {
    const f = await downloaderFixture({ domLifecycle: true });
    const previous = Object.fromEntries(
      ['window', 'document', 'fixtureBotguard'].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    );
    const oldWindow = { marker: 'prior window' };
    const oldDocument = { marker: 'prior document' };
    let setterCalls = 0;
    const descriptors = {
      window: {
        configurable: true,
        enumerable: false,
        get: () => oldWindow,
        set: () => setterCalls++,
      },
      document: {
        configurable: true,
        enumerable: true,
        get: () => oldDocument,
        set: () => setterCalls++,
      },
    };
    let pending: Promise<void> | undefined;
    try {
      Object.defineProperties(globalThis, descriptors);
      f.state.visitor = true;
      f.state.tokenMode = 'defer';
      if (outcome === 'close-reject')
        f.state.onDomWindow = (window) => {
          const close = window.happyDOM.close.bind(window.happyDOM);
          window.happyDOM.close = async () => {
            await close();
            throw new Error('private-dom-close-sentinel');
          };
        };
      const context = f.createContext(outcome);
      await f.source.downloader.onMainLoad(context);
      pending = f.source.downloader.downloadSongFromId('one');
      await expect.poll(() => f.state.tokens.length).toBe(1);
      // Prove a real callback is running before ending the attempt, so a
      // no-op close or descriptor-only restoration cannot satisfy the test.
      await expect
        .poll(() => globals.fixtureBotguard?.ticks ?? 0)
        .toBeGreaterThan(0);
      const vm = globals.fixtureBotguard!;
      if (outcome === 'retirement') f.source.downloader.onMainStop?.(context);
      if (outcome === 'failure')
        f.state.tokens[0].reject(new Error('Owned token failure'));
      else f.state.tokens[0].resolve();
      await pending;
      expect(f.state.domWindows).toHaveLength(1);
      expect(f.state.domWindows![0].closed).toBe(true);
      const settledTicks = vm.ticks;
      await delay();
      expect(vm.ticks).toBe(settledTicks);
      for (const name of ['window', 'document'] as const)
        expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(
          descriptors[name],
        );
      expect(setterCalls).toBe(0);
      if (outcome === 'close-reject') {
        expect(f.state.logs).toContain(
          'Could not close downloader temporary DOM',
        );
        expect(f.state.logs.join('\n')).not.toContain(
          'private-dom-close-sentinel',
        );
      }
      expect(f.state.clients[0].session.po_token).toBe(
        outcome === 'success' || outcome === 'close-reject'
          ? 'fixture-token'
          : undefined,
      );
    } finally {
      await f.close();
      await pending;
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}

test('retirement immediately after DOM construction closes the owned window', async () => {
  const f = await downloaderFixture({ domLifecycle: true });
  let ticks = 0;
  try {
    f.state.visitor = true;
    const context = f.createContext('constructor-retirement');
    f.state.onDomWindow = (window) => {
      window.setInterval(() => ticks++, 5);
      f.source.downloader.onMainStop?.(context);
    };
    await f.source.downloader.onMainLoad(context);
    await f.source.downloader.downloadSongFromId('one');
    expect(f.state.domWindows).toHaveLength(1);
    expect(f.state.domWindows![0].closed).toBe(true);
    await delay();
    expect(ticks).toBe(0);
    expect(f.state.clients[0].session.po_token).toBeUndefined();
    expect(f.state.tokens).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('replacement waits for old DOM cleanup and late old completion stays retired', async () => {
  const f = await downloaderFixture({ domLifecycle: true });
  const previous = Object.fromEntries(
    ['window', 'document', 'fixtureBotguard'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let closing = false;
  let oldPending: Promise<void> | undefined;
  let newPending: Promise<void> | undefined;
  try {
    f.state.visitor = true;
    f.state.tokenMode = 'defer';
    f.state.onDomWindow = (window) => {
      if (f.state.domWindows!.length !== 1) return;
      const close = window.happyDOM.close.bind(window.happyDOM);
      window.happyDOM.close = async () => {
        closing = true;
        await closeGate;
        await close();
      };
    };
    await f.source.downloader.onMainLoad(f.createContext('old'));
    oldPending = f.source.downloader.downloadSongFromId('one');
    await expect.poll(() => f.state.tokens.length).toBe(1);
    f.state.tokens[0].resolve();
    await expect.poll(() => closing).toBe(true);
    await f.source.downloader.onMainLoad(f.createContext('new'));
    newPending = f.source.downloader.downloadSongFromId('two');
    await f.flush();
    expect(f.state.domWindows).toHaveLength(1);
    expect(f.state.tokens).toHaveLength(1);
    releaseClose();
    await oldPending;
    await expect.poll(() => f.state.tokens.length).toBe(2);
    f.state.tokens[1].resolve();
    await newPending;
    expect(f.state.domWindows).toHaveLength(2);
    expect(f.state.domWindows!.every((window) => window.closed)).toBe(true);
    expect(f.state.infoCalls.map((call) => call.id)).toEqual(['two']);
    expect(f.state.clients[1].session.po_token).toBe('fixture-token');
    for (const name of ['window', 'document'])
      expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(
        previous[name],
      );
  } finally {
    releaseClose();
    await f.close();
    await Promise.all([oldPending, newPending]);
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
