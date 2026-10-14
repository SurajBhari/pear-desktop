import { test, expect } from '@playwright/test';
import { ratingFeedbackSource } from './helpers/rating-feedback-source';

test('Notifications repeated start owns one track callback and producer', async () => {
  const f = await ratingFeedbackSource();
  try {
    await f.source.onMainLoad(f.context);
    await f.source.onMainLoad(f.context);
    f.emit();
    await f.drain();
    expect(f.state.callbacks.size).toBe(1);
    expect(f.state.shown).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('Notifications same-track metadata is silent; only an actual paused to playing transition unpauses', async () => {
  const f = await ratingFeedbackSource();
  try {
    await f.source.onMainLoad(f.context);
    f.emit();
    await f.drain();
    f.emit();
    await f.drain();
    expect(f.state.shown).toHaveLength(1);
    f.info.isPaused = true;
    f.emit('peard:play-or-paused');
    f.info.isPaused = false;
    f.emit('peard:play-or-paused');
    await f.drain();
    expect(f.state.shown).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test('Notifications disable retires a pending delayed show', async () => {
  const f = await ratingFeedbackSource();
  try {
    await f.source.onMainLoad(f.context);
    f.emit();
    f.source.onConfigChange({ ...f.config, enabled: false });
    await f.drain();
    expect(f.state.shown).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('Notifications newer disabled config wins over a held initial getConfig', async () => {
  const f = await ratingFeedbackSource();
  try {
    let release: any;
    const start = f.source.onMainLoad({
      ...f.context,
      getConfig: () => new Promise((r) => (release = r)),
    });
    f.source.onConfigChange({ ...f.config, enabled: false });
    release(f.config);
    await start;
    f.emit();
    await f.drain();
    expect(f.state.callbacks.size).toBe(0);
    expect(f.state.shown).toHaveLength(0);
  } finally {
    await f.close();
  }
});

const arm = (f: any) =>
  f.state.sent
    .filter((p: any) => p[0] === 'peard:rating-feedback-arm')
    .at(-1)?.[1];
const send = (f: any, value: any, extra: any[] = []) =>
  f.state.ipcMain.emit(
    'peard:rating-feedback-state',
    { sender: f.state.contents, senderFrame: f.state.contents.mainFrame },
    value,
    ...extra,
  );
const packet = (
  f: any,
  type = 'snapshot',
  state = 'INDIFFERENT',
  sourceGeneration = 1,
) => ({ type, ...arm(f), state, sourceGeneration });
async function admitted() {
  const f = await ratingFeedbackSource();
  f.config.notifyOnLikeChange = true;
  await f.source.onMainLoad(f.context);
  f.emit();
  await f.drain();
  f.state.shown.length = 0;
  return f;
}

test('rating source snapshots are silent and late duplicates cannot rebase; a replacement generation can', async () => {
  const f = await admitted();
  try {
    send(f, packet(f));
    send(f, packet(f, 'change', 'LIKE'));
    expect(f.state.shown).toHaveLength(1);
    send(f, packet(f));
    send(f, packet(f, 'change', 'LIKE'));
    expect(f.state.shown).toHaveLength(1);
    send(f, packet(f, 'snapshot', 'INDIFFERENT', 2));
    expect(f.state.shown).toHaveLength(1);
    send(f, packet(f, 'change', 'LIKE', 1));
    expect(f.state.shown).toHaveLength(1);
    send(f, packet(f, 'change', 'LIKE', 2));
    expect(f.state.shown).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test('rating source ready and unchanged TimeChanged preserve nonce and baseline; passive binding-only refresh rotates it', async () => {
  const f = await admitted();
  try {
    const first = arm(f);
    send(f, packet(f));
    send(f, packet(f, 'change', 'LIKE'));
    send(f, { type: 'ready' });
    f.emit('peard:time-changed');
    expect(arm(f)).toEqual(first);
    send(f, packet(f));
    send(f, packet(f, 'change', 'LIKE'));
    expect(f.state.shown).toHaveLength(1);
    f.state.binding = { ...f.state.binding, episodeId: 'c'.repeat(32) };
    send(f, { type: 'ready' });
    expect(arm(f).nonce).not.toBe(first.nonce);
    send(f, {
      type: 'change',
      ...first,
      state: 'DISLIKE',
      sourceGeneration: 1,
    });
    expect(f.state.shown).toHaveLength(1);
    send(f, packet(f));
    send(f, packet(f, 'change', 'LIKE'));
    expect(f.state.shown).toHaveLength(2);
  } finally {
    await f.close();
  }
});
const badPackets: Record<string, (v: any) => any> = {
  extra: (v) => ({ ...v, extra: true }),
  missing: (v) => {
    delete v.state;
    return v;
  },
  case: (v) => ({ ...v, state: 'like' }),
  unknown: (v) => ({ ...v, state: 'UNKNOWN' }),
  generationZero: (v) => ({ ...v, sourceGeneration: 0 }),
  generationFraction: (v) => ({ ...v, sourceGeneration: 1.5 }),
  generationUnsafe: (v) => ({
    ...v,
    sourceGeneration: Number.MAX_SAFE_INTEGER + 1,
  }),
  generationString: (v) => ({ ...v, sourceGeneration: '1' }),
  type: (v) => ({ ...v, type: 'like' }),
  nonce: (v) => ({ ...v, nonce: 'bad' }),
  document: (v) => ({
    ...v,
    binding: { ...v.binding, documentId: 'd'.repeat(32) },
  }),
  episode: (v) => ({
    ...v,
    binding: { ...v.binding, episodeId: 'd'.repeat(32) },
  }),
  video: (v) => ({ ...v, binding: { ...v.binding, videoId: 'seeded00002' } }),
  bindingExtra: (v) => ({ ...v, binding: { ...v.binding, extra: true } }),
};
for (const [name, mutate] of Object.entries(badPackets))
  test(
    'rating source rejects malformed ' +
      name +
      ' then healthy current transition works',
    async () => {
      const f = await admitted();
      try {
        send(f, packet(f));
        send(f, mutate(packet(f, 'change', 'LIKE')));
        expect(f.state.shown).toHaveLength(0);
        send(f, packet(f, 'change', 'LIKE'));
        expect(f.state.shown).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
for (const stage of ['image', 'constructor'])
  test('rating source fences synchronous retirement at ' + stage, async () => {
    const f = await admitted();
    try {
      send(f, packet(f));
      f.state.hook = (s: string) => {
        if (s === stage)
          f.source.onConfigChange({ ...f.config, enabled: false });
      };
      send(f, packet(f, 'change', 'LIKE'));
      expect(f.state.shown).toHaveLength(0);
      expect(f.state.callbacks.size).toBe(0);
      expect(f.state.ipcMain.listenerCount('peard:rating-feedback-state')).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  });
test('rating source current-generation changes need a validated snapshot and extra args are rejected', async () => {
  const f = await admitted();
  try {
    send(f, packet(f, 'change', 'LIKE'));
    expect(f.state.shown).toHaveLength(0);
    send(f, packet(f));
    send(f, packet(f, 'change', 'LIKE'), ['extra']);
    expect(f.state.shown).toHaveLength(0);
    send(f, packet(f, 'change', 'LIKE'));
    expect(f.state.shown).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('managed tray leases preserve unrelated listeners and conditionally restore defaults/new owners', async () => {
  const f = await ratingFeedbackSource();
  try {
    f.source.setUpTray(
      { dock: {} },
      Object.assign(f.state.window, {
        isVisible: () => true,
        hide: () => f.state.effects.push('hide'),
      }),
    );
    const physical = f.state.trays[0];
    let unrelated = 0;
    physical.on('click', () => unrelated++);
    let a = 0,
      b = 0;
    const owner = { isCurrent: () => true };
    const offA = f.source.registerOwnedTrayOnClick(owner, () => a++);
    physical.emit('click', {}, {});
    expect([a, unrelated]).toEqual([1, 1]);
    const offB = f.source.registerOwnedTrayOnClick(owner, () => b++);
    offA();
    physical.emit('click', {}, {});
    expect([a, b, unrelated]).toEqual([1, 1, 2]);
    offB();
    physical.emit('click', {}, {});
    expect(f.state.effects).toEqual(['playPause']);
    expect(unrelated).toBe(3);
    const off = f.source.registerOwnedTrayOnClick(owner, () => a++);
    f.source.setTrayOnClick(() => b++);
    off();
    physical.emit('click', {}, {});
    expect(b).toBe(2);
    expect(unrelated).toBe(4);
  } finally {
    await f.close();
  }
});
test('managed protocol leases skip retired previous owners and never replace a newer legacy handler', async () => {
  const f = await ratingFeedbackSource();
  try {
    const effects: string[] = [];
    f.source.changeProtocolHandler(() => effects.push('default'));
    let live = true;
    const offA = f.source.registerOwnedProtocolHandler(
      { isCurrent: () => live },
      () => effects.push('A'),
    );
    const offB = f.source.registerOwnedProtocolHandler(
      { isCurrent: () => true },
      () => effects.push('B'),
    );
    live = false;
    offB();
    f.source.handleProtocol('play');
    expect(effects).toEqual(['default']);
    f.source.changeProtocolHandler(() => effects.push('new'));
    offA();
    f.source.handleProtocol('play');
    expect(effects).toEqual(['default', 'new']);
    const off = f.source.registerOwnedProtocolHandler(
      { isCurrent: () => true },
      () => effects.push('C'),
    );
    off();
    f.source.handleProtocol('play');
    expect(effects).toEqual(['default', 'new', 'new']);
  } finally {
    await f.close();
  }
});

test('interactive owner captures its toast/timer/close listener and releases raw IPC, before-quit and protocol handlers', async () => {
  const f = await ratingFeedbackSource({
    interactive: true,
    manualTimers: true,
  });
  try {
    f.state.windows = true;
    f.config.interactive = true;
    const effects: string[] = [];
    f.source.changeProtocolHandler(() => effects.push('default'));
    await f.source.onMainLoad(f.context);
    f.emit();
    const first = f.state.constructed[0],
      oldClose = first.listeners('close')[0],
      oldTimer = f.state.scheduled.find((t: any) => t.delay === 5000);
    expect(f.state.shown).toHaveLength(1);
    expect(f.state.app.listenerCount('before-quit')).toBe(1);
    expect(f.state.ipcMain.listenerCount('peard:player-api-loaded')).toBe(1);
    await f.source.onMainLoad(f.context);
    f.emit();
    const second = f.state.constructed.at(-1);
    expect(second).not.toBe(first);
    const closedBefore = f.state.closed.filter((x: any) => x === second).length;
    oldTimer.fn();
    oldClose();
    expect(f.state.closed.filter((x: any) => x === second)).toHaveLength(
      closedBefore,
    );
    f.emit('peard:time-changed');
    f.emit();
    expect(f.state.shown).toHaveLength(2);
    f.source.onMainStop();
    expect(f.state.app.listenerCount('before-quit')).toBe(0);
    expect(f.state.ipcMain.listenerCount('peard:player-api-loaded')).toBe(0);
    expect(f.state.callbacks.size).toBe(0);
    expect(f.state.scheduled.every((t: any) => t.canceled)).toBe(true);
    expect(first.listenerCount('close')).toBe(0);
    expect(second.listenerCount('close')).toBe(0);
    f.source.handleProtocol('play');
    expect(effects).toEqual(['default']);
  } finally {
    await f.close();
  }
});
test('managed protocol owner predicate reentry cannot overwrite or invoke a newer lease', async () => {
  const f = await ratingFeedbackSource();
  try {
    const seen: string[] = [];
    f.source.changeProtocolHandler(() => seen.push('base'));
    let check = 0;
    const off = f.source.registerOwnedProtocolHandler(
      {
        isCurrent() {
          check++;
          if (check === 2)
            f.source.changeProtocolHandler(() => seen.push('new'));
          return true;
        },
      },
      () => seen.push('old'),
    );
    f.source.handleProtocol('play');
    off();
    f.source.handleProtocol('play');
    expect(seen).toEqual(['new']);
  } finally {
    await f.close();
  }
});
test('managed tray owner predicate reentry leaves a newer setter and unrelated physical listener', async () => {
  const f = await ratingFeedbackSource();
  try {
    f.source.setUpTray({}, f.state.window);
    const physical = f.state.trays[0];
    const seen: string[] = [];
    physical.on('click', () => seen.push('unrelated'));
    let check = 0;
    const off = f.source.registerOwnedTrayOnClick(
      {
        isCurrent() {
          check++;
          if (check === 2) f.source.setTrayOnClick(() => seen.push('new'));
          return true;
        },
      },
      () => seen.push('old'),
    );
    physical.emit('click', {}, {});
    off();
    physical.emit('click', {}, {});
    expect(seen).toEqual(['unrelated', 'unrelated', 'new']);
  } finally {
    await f.close();
  }
});

for (const retirement of ['dispose', 'abort'])
  test(
    'F2 prior self-' +
      retirement +
      ' in restoration skips to live protocol/tray defaults',
    async () => {
      const f = await ratingFeedbackSource();
      try {
        const events: string[] = [];
        let armed = false;
        const signal = new AbortController();
        let offA: () => void = () => {};
        f.source.changeProtocolHandler(() => events.push('protocol-default'));
        offA = f.source.registerOwnedProtocolHandler(
          {
            signal: signal.signal,
            isCurrent() {
              if (armed) {
                armed = false;
                if (retirement === 'abort') signal.abort();
                else offA();
              }
              return true;
            },
          },
          () => events.push('protocol-A'),
        );
        const offB = f.source.registerOwnedProtocolHandler(
          { isCurrent: () => true },
          () => events.push('protocol-B'),
        );
        f.source.handleProtocol('noop');
        armed = true;
        offB();
        f.source.handleProtocol('noop');
        expect(events).toEqual(['protocol-B', 'protocol-default']);
        f.source.setUpTray({}, f.state.window);
        const physical = f.state.trays[0];
        f.source.setTrayOnClick(() => events.push('tray-default'));
        const defaultHandler = physical.listeners('click')[0];
        const foreign = () => events.push('foreign');
        physical.on('click', foreign);
        let armedTray = false;
        const traySignal = new AbortController();
        let offTrayA: () => void = () => {};
        offTrayA = f.source.registerOwnedTrayOnClick(
          {
            signal: traySignal.signal,
            isCurrent() {
              if (armedTray) {
                armedTray = false;
                if (retirement === 'abort') traySignal.abort();
                else offTrayA();
              }
              return true;
            },
          },
          () => events.push('tray-A'),
        );
        const aHandler = physical
          .listeners('click')
          .find((h: any) => h !== foreign);
        const offTrayB = f.source.registerOwnedTrayOnClick(
          { isCurrent: () => true },
          () => events.push('tray-B'),
        );
        const bHandler = physical
          .listeners('click')
          .find((h: any) => h !== foreign);
        armedTray = true;
        offTrayB();
        physical.emit('click', {}, {});
        expect(events.slice(-2)).toEqual(['foreign', 'tray-default']);
        expect(physical.listeners('click')).toContain(defaultHandler);
        expect(physical.listeners('click')).not.toContain(aHandler);
        expect(physical.listeners('click')).not.toContain(bHandler);
        expect(
          physical.listeners('click').filter((h: any) => h === foreign),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
for (const registration of ['closed', 'destroyed', 'did-start-navigation'])
  test(
    'F2 source retirement during native add ' +
      registration +
      ' compensates its exact late listener',
    async () => {
      const f = await ratingFeedbackSource();
      try {
        const win = f.state.window,
          contents = f.state.contents,
          unrelated = () => {};
        win.on('closed', unrelated);
        contents.on('destroyed', unrelated);
        contents.on('did-start-navigation', unrelated);
        const counts = () => ({
          closed: win.listenerCount('closed'),
          destroyed: contents.listenerCount('destroyed'),
          navigation: contents.listenerCount('did-start-navigation'),
          rating: f.state.ipcMain.listenerCount('peard:rating-feedback-state'),
          callbacks: f.state.callbacks.size,
        });
        const baseline = counts();
        const target = registration === 'closed' ? win : contents;
        let armed = true,
          stale: any;
        const hook = (event: string, fn: any) => {
          if (armed && event === registration) {
            armed = false;
            stale = fn;
            f.source.onMainStop();
          }
        };
        target.on('newListener', hook);
        await f.source.onMainLoad(f.context);
        target.removeListener('newListener', hook);
        f.source.onMainStop();
        f.source.onMainStop();
        expect(counts()).toEqual(baseline);
        await f.source.onMainLoad(f.context);
        const healthy = counts();
        stale();
        expect(counts()).toEqual(healthy);
        expect(healthy.rating).toBe(1);
        expect(healthy.callbacks).toBe(1);
        f.source.onMainStop();
        expect(counts()).toEqual(baseline);
        expect(win.listeners('closed')).toContain(unrelated);
        expect(contents.listeners('destroyed')).toContain(unrelated);
        expect(contents.listeners('did-start-navigation')).toContain(unrelated);
      } finally {
        await f.close();
      }
    },
  );
for (const getter of ['on', 'webContents'])
  test(
    'F2 source getter ' +
      getter +
      ' retirement cannot revive setup or leave listeners',
    async () => {
      const f = await ratingFeedbackSource();
      try {
        const win = f.state.window,
          contents = f.state.contents;
        let armed = true;
        const original = win[getter];
        Object.defineProperty(win, getter, {
          configurable: true,
          get() {
            if (armed) {
              armed = false;
              f.source.onMainStop();
            }
            return original;
          },
        });
        await f.source.onMainLoad(f.context);
        expect(win.listenerCount('closed')).toBe(0);
        expect(contents.listenerCount('destroyed')).toBe(0);
        expect(contents.listenerCount('did-start-navigation')).toBe(0);
        expect(
          f.state.ipcMain.listenerCount('peard:rating-feedback-state'),
        ).toBe(0);
        expect(f.state.callbacks.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

test('F2 successor created during native add keeps only its own callbacks and ignores the retired closure', async () => {
  const f = await ratingFeedbackSource();
  try {
    const win = f.state.window,
      contents = f.state.contents,
      foreign = () => {};
    win.on('closed', foreign);
    contents.on('destroyed', foreign);
    contents.on('did-start-navigation', foreign);
    let armed = true,
      successor: Promise<void> | undefined,
      retired: any;
    const hook = (event: string, fn: any) => {
      if (armed && event === 'closed') {
        armed = false;
        retired = fn;
        successor = f.source.onMainLoad(f.context);
      }
    };
    win.on('newListener', hook);
    await f.source.onMainLoad(f.context);
    await successor;
    win.removeListener('newListener', hook);
    const counts = () => [
      win.listenerCount('closed'),
      contents.listenerCount('destroyed'),
      contents.listenerCount('did-start-navigation'),
      f.state.ipcMain.listenerCount('peard:rating-feedback-state'),
      f.state.callbacks.size,
    ];
    expect(counts()).toEqual([2, 2, 3, 1, 1]);
    retired();
    expect(counts()).toEqual([2, 2, 3, 1, 1]);
    f.source.onMainStop();
    expect(counts()).toEqual([1, 1, 1, 0, 0]);
  } finally {
    await f.close();
  }
});
test('F2 successor created during native removal survives old cleanup with unrelated callbacks intact', async () => {
  const f = await ratingFeedbackSource();
  try {
    const win = f.state.window,
      contents = f.state.contents,
      foreign = () => {};
    win.on('closed', foreign);
    contents.on('destroyed', foreign);
    contents.on('did-start-navigation', foreign);
    await f.source.onMainLoad(f.context);
    const retired = win.listeners('closed').find((x: any) => x !== foreign);
    let armed = true,
      successor: Promise<void> | undefined;
    const hook = (event: string) => {
      if (armed && event === 'closed') {
        armed = false;
        successor = f.source.onMainLoad(f.context);
      }
    };
    win.on('removeListener', hook);
    f.source.onMainStop();
    await successor;
    win.removeListener('removeListener', hook);
    const counts = () => [
      win.listenerCount('closed'),
      contents.listenerCount('destroyed'),
      contents.listenerCount('did-start-navigation'),
      f.state.ipcMain.listenerCount('peard:rating-feedback-state'),
      f.state.callbacks.size,
    ];
    expect(counts()).toEqual([2, 2, 3, 1, 1]);
    retired();
    expect(counts()).toEqual([2, 2, 3, 1, 1]);
    f.source.onMainStop();
    expect(counts()).toEqual([1, 1, 1, 0, 0]);
  } finally {
    await f.close();
  }
});
