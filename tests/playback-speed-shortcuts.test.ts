import { test, expect } from '@playwright/test';
import { playerActionsFixture } from './helpers/player-actions-fixture';
import { shortcutRatingSource } from './helpers/shortcut-rating-source';

const channel = 'peard:playback-speed-step';
function rendererContext(f: any, config: any) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const history: any[] = [];
  const context: any = {
    getConfig: () => config,
    ipc: {
      subscribe: (name: string, invoke: (...args: any[]) => void) => {
        const current = listeners.get(name) ?? new Set();
        listeners.set(name, current);
        current.add(invoke);
        history.push(invoke);
        return () => current.delete(invoke);
      },
      removeAllListeners: () => {
        throw Error('Unowned listener removal');
      },
    },
  };
  return {
    context,
    listeners,
    history,
    emit: (name: string, ...args: any[]) => {
      for (const invoke of listeners.get(name) ?? []) invoke(...args);
    },
  };
}

const speedConfig = (f: any) => ({
  ...f.source.playbackSpeedPlugin.config,
  enabled: true,
  step: 0.1,
  globalShortcuts: { speedUp: 'F8', speedDown: 'F9' },
});

test('speed renderer command advances stored speed1 to1.1 through the real playback owner and slider', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    await f.source.playbackSpeed.onPlayerApiReady(f.api('owned'), ipc.context);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.1);
    expect(f.speedControls.at(-1).speed).toBe(1.1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
    expect(ipc.listeners.get(channel)?.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('speed actual saved global hotkey delivers1 to the real renderer rate claim', async () => {
  const f = await playerActionsFixture();
  const main = await shortcutRatingSource();
  try {
    const config = speedConfig(f);
    const ipc = rendererContext(f, config);
    await f.source.playbackSpeed.onPlayerApiReady(f.api('owned'), ipc.context);
    const send = main.contents.send;
    main.contents.send = (name: string, ...args: any[]) => {
      send(name, ...args);
      ipc.emit(name, ...args);
    };
    await main.source.playbackSpeed.backend?.start?.({
      ...main.context,
      getConfig: () => config,
    });
    expect(main.state.global.has('F8')).toBe(true);
    main.state.global.get('F8')();
    expect(main.sent).toEqual([[channel, 1]]);
    expect(f.media.playbackRate).toBe(1.1);
    expect(f.speedControls.at(-1).speed).toBe(1.1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
  } finally {
    await main.close();
    await f.close();
  }
});

const setSlider = (f: any, value: number) =>
  f.speedControls
    .at(-1)
    .onImmediateValueChanged(
      new f.dom.CustomEvent('change', { detail: { value } }),
    );

test('speed up/down keep Pitch, silence and pause state while taking one real owner handover', async () => {
  const f = await playerActionsFixture();
  try {
    f.media.muted = true;
    f.media.volume = 0;
    const config = { ...speedConfig(f), preservesPitch: false };
    const ipc = rendererContext(f, config);
    const owners: any[] = [];
    const release = f.source.subscribePlaybackRateOwner(() =>
      owners.push(f.source.getPlaybackRateOwner(f.media)),
    );
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    expect(owners).toEqual([]);
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.1);
    ipc.emit(channel, -1);
    expect(f.media.playbackRate).toBe(1);
    expect(owners).toEqual(['playback-speed']);
    expect(f.media.preservesPitch).toBe(false);
    expect(f.media.muted).toBe(true);
    expect(f.media.volume).toBe(0);
    expect(f.media.paused).toBe(true);
    release();
  } finally {
    await f.close();
  }
});

for (const [initial, direction, expected] of [
  [15.99, 1, 16],
  [0.08, -1, 0.07],
  [1, 1, 1.1],
] as const) {
  test(`speed ${initial} with direction ${direction} produces finite bounded${expected}`, async () => {
    const f = await playerActionsFixture();
    try {
      const ipc = rendererContext(f, speedConfig(f));
      await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
      setSlider(f, initial);
      ipc.emit(channel, direction);
      expect(f.media.playbackRate).toBe(expected);
      expect(f.speedControls.at(-1).speed).toBe(expected);
    } finally {
      await f.close();
    }
  });
}

for (const [value, expected] of [
  [0.01, 1.01],
  [15.93, 16],
  [0.009, 1.1],
  [15.94, 1.1],
  [NaN, 1.1],
  [Infinity, 1.1],
  ['0.5', 1.1],
  [null, 1.1],
  [{}, 1.1],
] as const) {
  test(`speed validates configured step${String(value)} through resulting rate${expected}`, async () => {
    const f = await playerActionsFixture();
    try {
      const ipc = rendererContext(f, { ...speedConfig(f), step: value });
      await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
      ipc.emit(channel, 1);
      expect(f.media.playbackRate).toBe(expected);
    } finally {
      await f.close();
    }
  });
}

test('speed malformed directions and extra arguments cannot claim an unowned video', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    for (const args of [
      [],
      [0],
      ['1'],
      [NaN],
      [Infinity],
      [null],
      [{}],
      [[1]],
      [1, -1],
    ])
      ipc.emit(channel, ...args);
    expect(f.media.playbackRate).toBe(1);
    expect(f.speedControls.at(-1).speed).toBe(1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
  } finally {
    await f.close();
  }
});

test('speed hotkey uses stored setpoint under a foreign owner and claims even at its clamp boundary', async () => {
  const f = await playerActionsFixture();
  try {
    f.source.claimPlaybackRate('foreign', 3);
    f.media.playbackRate = 3;
    const ipc = rendererContext(f, speedConfig(f));
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    f.source.playbackSpeed.onConfigChange({ ...speedConfig(f), step: 0.2 });
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('foreign');
    expect(f.media.playbackRate).toBe(3);
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.2);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
    setSlider(f, 16);
    f.source.claimPlaybackRate('foreign', 0.8);
    f.media.playbackRate = 0.8;
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(16);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
    for (let i = 0; i < 200; i++) ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(16);
    expect(Number.isFinite(f.media.playbackRate)).toBe(true);
  } finally {
    await f.close();
  }
});

test('speed actual ad override preserves its16 rate and resumes the hotkey stored preference', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  try {
    const ipc = rendererContext(f, {
      ...speedConfig(f),
      preservesPitch: false,
    });
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    ipc.emit(channel, 1);
    f.dom.document.querySelector('#movie_player')!.classList.add('ad-showing');
    ad = f.source.createAdSpeedup(f.dom.document);
    ad.start();
    await f.settle();
    ipc.emit(channel, 1);
    expect(f.speedControls.at(-1).speed).toBe(1.2);
    expect(f.media.playbackRate).toBe(16);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('ad-speedup');
    expect(f.media.preservesPitch).toBe(true);
    f.dom.document
      .querySelector('#movie_player')!
      .classList.remove('ad-showing');
    await f.settle();
    expect(f.media.playbackRate).toBe(1.2);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
    expect(f.media.preservesPitch).toBe(false);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('speed context/API replacement retires old callback and does not multiply current subscription', async () => {
  const f = await playerActionsFixture();
  try {
    const first = rendererContext(f, speedConfig(f));
    const api = f.api('A');
    await f.source.playbackSpeed.onPlayerApiReady(api, first.context);
    await f.source.playbackSpeed.onPlayerApiReady(api, first.context);
    expect(first.history).toHaveLength(1);
    const next = rendererContext(f, { ...speedConfig(f), step: 0.2 });
    await f.source.playbackSpeed.onPlayerApiReady(f.api('B'), next.context);
    first.history[0](1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    expect(first.listeners.get(channel)?.size).toBe(0);
    next.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.2);
    expect(next.listeners.get(channel)?.size).toBe(1);
    f.source.playbackSpeed.onUnload({ ...next.context });
    next.history[0](1);
    expect(f.media.playbackRate).toBe(1.2);
    expect(next.listeners.get(channel)?.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('speed disable/reenable invalidates old subscription while latest config changes never claim', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    const old = ipc.history[0];
    f.source.playbackSpeed.onConfigChange({
      ...speedConfig(f),
      enabled: false,
    });
    old(1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    expect(ipc.listeners.get(channel)?.size).toBe(0);
    f.source.playbackSpeed.onConfigChange({ ...speedConfig(f), step: 0.3 });
    old(1);
    expect(f.media.playbackRate).toBe(1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.3);
    expect(ipc.listeners.get(channel)?.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('speed held initial config cannot overwrite a later live step or a new stopped generation', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    let resolve!: (value: any) => void;
    ipc.context.getConfig = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = f.source.playbackSpeed.onPlayerApiReady(
      f.api('A'),
      ipc.context,
    );
    f.source.playbackSpeed.onConfigChange({ ...speedConfig(f), step: 0.2 });
    resolve({ ...speedConfig(f), step: 0.5 });
    await pending;
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.2);
    f.source.playbackSpeed.onUnload();
    const stale = f.source.playbackSpeed.onPlayerApiReady(
      f.api('A'),
      ipc.context,
    );
    f.source.playbackSpeed.onUnload();
    const next = rendererContext(f, { ...speedConfig(f), step: 0.3 });
    await f.source.playbackSpeed.onPlayerApiReady(f.api('B'), next.context);
    resolve({ ...speedConfig(f), step: 0.5 });
    await stale;
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.2);
    next.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.5);
  } finally {
    await f.close();
  }
});

test('speed current video replacement updates only the current element and pagehide retires IPC', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    ipc.emit(channel, 1);
    const old = f.media,
      next = f.dom.document.createElement('video');
    old.replaceWith(next);
    f.video();
    await f.settle();
    ipc.emit(channel, 1);
    expect(next.playbackRate).toBe(1.2);
    expect(old.playbackRate).toBe(1.1);
    f.dom.dispatchEvent(new f.dom.Event('pagehide'));
    ipc.history[0](1);
    expect(next.playbackRate).toBe(1.2);
    expect(ipc.listeners.get(channel)?.size).toBe(0);
    expect(f.activeObservers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('speed native connected getter retirement prevents stored speed, claim and video write', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    Object.defineProperty(f.media, 'isConnected', {
      configurable: true,
      get: () => {
        f.source.playbackSpeed.onUnload();
        return true;
      },
    });
    ipc.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    expect(ipc.listeners.get(channel)?.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('speed synchronous subscription stimulus on mount cannot claim; stop during subscribe releases its result', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    const subscribe = ipc.context.ipc.subscribe;
    ipc.context.ipc.subscribe = (name: string, invoke: any) => {
      invoke(1);
      return subscribe(name, invoke);
    };
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    expect(f.media.playbackRate).toBe(1);
    f.source.playbackSpeed.onUnload();
    ipc.context.ipc.subscribe = (name: string, invoke: any) => {
      const release = subscribe(name, invoke);
      f.source.playbackSpeed.onUnload();
      return release;
    };
    await f.source.playbackSpeed.onPlayerApiReady(f.api('B'), ipc.context);
    expect(ipc.listeners.get(channel)?.size).toBe(0);
    expect(f.activeObservers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('speed minimal/no-argument lifecycle keeps the existing slider without adding IPC ownership', async () => {
  const f = await playerActionsFixture();
  try {
    await f.source.playbackSpeed.onPlayerApiReady(undefined, {
      getConfig: () => ({ ...speedConfig(f) }),
      ipc: {},
    });
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    setSlider(f, 1.4);
    expect(f.media.playbackRate).toBe(1.4);
    f.source.playbackSpeed.onUnload();
    f.source.playbackSpeed.onPlayerApiReady();
    setSlider(f, 1.5);
    expect(f.media.playbackRate).toBe(1.5);
    f.source.playbackSpeed.onUnload();
  } finally {
    await f.close();
  }
});

test('speed defaults add only two empty bindings and step0.1 while existing Pitch default remains true', async () => {
  const f = await shortcutRatingSource();
  try {
    expect(f.source.playbackSpeed.config).toEqual({
      enabled: false,
      preservesPitch: true,
      step: 0.1,
      globalShortcuts: { speedUp: '', speedDown: '' },
    });
    await f.source.playbackSpeed.backend.start({
      ...f.context,
      getConfig: () => ({ ...f.source.playbackSpeed.config, enabled: true }),
    });
    expect(f.state.global.size).toBe(0);
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

test('speed invalid registration and unknown saved action do not stop its valid down command', async () => {
  const f = await shortcutRatingSource();
  try {
    const cfg = {
      ...f.source.playbackSpeed.config,
      enabled: true,
      globalShortcuts: { speedUp: 'invalid', speedDown: 'F9', like: 'F10' },
    };
    await f.source.playbackSpeed.backend.start({
      ...f.context,
      getConfig: () => cfg,
    });
    expect([...f.state.global.keys()]).toEqual(['F9']);
    f.state.global.get('F9')();
    expect(f.sent).toEqual([[channel, -1]]);
    expect(f.warnings).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('speed shared adapter cannot steal a Shortcut binding or remove it during speed stop', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.global.like = 'Control+J';
    await f.source.backend.start(f.context);
    const cfg = {
      ...f.source.playbackSpeed.config,
      enabled: true,
      globalShortcuts: { speedUp: 'Ctrl+J', speedDown: 'F9' },
    };
    await f.source.playbackSpeed.backend.start({
      ...f.context,
      getConfig: () => cfg,
    });
    expect([...f.state.global.keys()]).toEqual(['Control+J', 'F9']);
    const down = f.state.global.get('F9');
    f.source.playbackSpeed.backend.stop();
    expect([...f.state.global.keys()]).toEqual(['Control+J']);
    down();
    f.state.global.get('Control+J')();
    expect(f.sent).toEqual([['peard:update-like', 'LIKE']]);
  } finally {
    await f.close();
  }
});

for (const retire of ['stop', 'latest']) {
  test(`speed native pending registration ${retire} reentry retires stale callback`, async () => {
    const f = await shortcutRatingSource();
    try {
      const cfg = {
        ...f.source.playbackSpeed.config,
        enabled: true,
        globalShortcuts: { speedUp: 'F8', speedDown: '' },
      };
      f.state.registerHook = () => {
        f.state.registerHook = undefined;
        if (retire === 'stop') f.source.playbackSpeed.backend.stop();
        else
          f.source.playbackSpeed.backend.onConfigChange({
            ...cfg,
            globalShortcuts: { speedUp: 'F9', speedDown: '' },
          });
      };
      await f.source.playbackSpeed.backend.start({
        ...f.context,
        getConfig: () => cfg,
      });
      expect([...f.state.global.keys()]).toEqual(
        retire === 'stop' ? [] : ['F9'],
      );
      if (retire === 'latest') {
        f.state.global.get('F9')();
        expect(f.sent).toEqual([[channel, 1]]);
      }
    } finally {
      await f.close();
    }
  });
}

for (const resolution of ['latest', 'stop', 'disable']) {
  test(`speed held backend getConfig honors ${resolution}`, async () => {
    const f = await shortcutRatingSource();
    try {
      const cfg = {
        ...f.source.playbackSpeed.config,
        enabled: true,
        globalShortcuts: { speedUp: 'F8', speedDown: '' },
      };
      let resolve!: (value: any) => void;
      const pending = f.source.playbackSpeed.backend.start({
        ...f.context,
        getConfig: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      if (resolution === 'latest')
        f.source.playbackSpeed.backend.onConfigChange({
          ...cfg,
          globalShortcuts: { speedUp: 'F9', speedDown: '' },
        });
      else if (resolution === 'stop') f.source.playbackSpeed.backend.stop();
      else
        f.source.playbackSpeed.backend.onConfigChange({
          ...cfg,
          enabled: false,
        });
      resolve(cfg);
      await pending;
      expect([...f.state.global.keys()]).toEqual(
        resolution === 'latest' ? ['F9'] : [],
      );
    } finally {
      await f.close();
    }
  });
}

test('speed native window predicate retirement after registration never sends IPC', async () => {
  const f = await shortcutRatingSource();
  try {
    const cfg = {
      ...f.source.playbackSpeed.config,
      enabled: true,
      globalShortcuts: { speedUp: 'F8', speedDown: '' },
    };
    await f.source.playbackSpeed.backend.start({
      ...f.context,
      getConfig: () => cfg,
    });
    const invoke = f.state.global.get('F8');
    f.window.isDestroyed = () => {
      f.source.playbackSpeed.backend.stop();
      return false;
    };
    invoke();
    expect(f.sent).toEqual([]);
    expect(f.state.global.size).toBe(0);
  } finally {
    await f.close();
  }
});

async function speedMenuFixture() {
  const f = await shortcutRatingSource();
  let config: any = {
    ...f.source.playbackSpeed.config,
    enabled: true,
    globalShortcuts: { speedUp: 'F8', speedDown: 'F9', savedUnknown: 'F10' },
  };
  const writes: any[] = [];
  const calls: any[] = [];
  let readConfig: () => any = () => config;
  const context: any = {
    ...f.context,
    getConfig: () => readConfig(),
    setConfig: (patch: any) => {
      writes.push(patch);
      config = { ...config, ...patch };
    },
  };
  f.state.prompt = async (options: any) => {
    calls.push(options);
    return null;
  };
  const menu = await f.source.playbackSpeed.menu(context);
  return {
    f,
    context,
    menu,
    writes,
    calls,
    setReader: (read: () => any) => {
      readConfig = read;
    },
    get config() {
      return config;
    },
    set config(value: any) {
      config = value;
    },
  };
}

test('speed keybind prompt exposes exactly up/down and merges only changed own fields with latest saved values', async () => {
  const x = await speedMenuFixture();
  try {
    x.f.state.prompt = async (options: any) => {
      x.calls.push(options);
      x.config.globalShortcuts.speedUp = 'F11';
      x.config = {
        ...x.config,
        preservesPitch: false,
        globalShortcuts: { ...x.config.globalShortcuts, speedDown: 'F12' },
      };
      return [
        { value: 'speedUp', accelerator: 'F7' },
        { value: 'speedDown', accelerator: 'F6' },
        { value: 'like', accelerator: 'F5' },
      ];
    };
    await x.menu[1].click();
    expect(x.calls[0].keybindOptions.map((row: any) => row.value)).toEqual([
      'speedUp',
      'speedDown',
    ]);
    expect(x.writes).toEqual([]);
    x.f.state.prompt = async () => [{ value: 'speedDown', accelerator: 'F6' }];
    await x.menu[1].click();
    expect(x.writes).toEqual([
      {
        globalShortcuts: {
          speedUp: 'F11',
          speedDown: 'F6',
          savedUnknown: 'F10',
        },
      },
    ]);
    expect(x.config.preservesPitch).toBe(false);
  } finally {
    await x.f.close();
  }
});

test('speed step prompt bounds valid values and leaves unrelated settings intact', async () => {
  const x = await speedMenuFixture();
  try {
    for (const output of [
      '0.01',
      '15.93',
      '0.009',
      '15.94',
      'Infinity',
      null,
      {},
      '',
    ]) {
      x.f.state.prompt = async (options: any) => {
        x.calls.push(options);
        return output;
      };
      await x.menu[2].click();
    }
    expect(x.calls[0].counterOptions).toEqual({
      minimum: 0.01,
      maximum: 15.93,
      multiFire: true,
    });
    expect(x.writes).toEqual([{ step: 0.01 }, { step: 15.93 }]);
    expect(x.config.preservesPitch).toBe(true);
    expect(x.config.globalShortcuts).toEqual({
      speedUp: 'F8',
      speedDown: 'F9',
      savedUnknown: 'F10',
    });
  } finally {
    await x.f.close();
  }
});

for (const stage of ['prompt', 'latestConfig']) {
  for (const retire of ['stop', 'navigation', 'frame']) {
    test(`speed held ${stage} after ${retire} cannot save bindings`, async () => {
      const x = await speedMenuFixture();
      try {
        // Regenerate after backend owns the navigation epoch.
        await x.f.source.playbackSpeed.backend.start({ ...x.context });
        const menu = await x.f.source.playbackSpeed.menu(x.context);
        let resolve!: (value: any) => void;
        if (stage === 'prompt')
          x.f.state.prompt = () =>
            new Promise((done) => {
              resolve = done;
            });
        else
          x.f.state.prompt = async () => {
            x.setReader(
              () =>
                new Promise((done) => {
                  resolve = done;
                }),
            );
            return [{ value: 'speedUp', accelerator: 'F7' }];
          };
        const pending = menu[1].click();
        for (let i = 0; i < 100 && !resolve; i++)
          await new Promise((done) => setTimeout(done, 1));
        expect(typeof resolve).toBe('function');
        if (retire === 'stop') x.f.source.playbackSpeed.backend.stop();
        else if (retire === 'navigation')
          x.f.contents.emit('did-start-navigation', {}, '', false, true);
        else x.f.contents.mainFrame = {};
        resolve(
          stage === 'prompt'
            ? [{ value: 'speedUp', accelerator: 'F7' }]
            : x.config,
        );
        await pending;
        expect(x.writes).toEqual([]);
      } finally {
        await x.f.close();
      }
    });
  }
}

test('speed held step prompt cannot overwrite a concurrent same-field edit', async () => {
  const x = await speedMenuFixture();
  try {
    let resolve!: (value: any) => void;
    x.f.state.prompt = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = x.menu[2].click();
    for (let i = 0; i < 100 && !resolve; i++)
      await new Promise((done) => setTimeout(done, 1));
    expect(typeof resolve).toBe('function');
    x.config.step = 0.3;
    resolve('0.2');
    await pending;
    expect(x.writes).toEqual([]);
    expect(x.config.step).toBe(0.3);
  } finally {
    await x.f.close();
  }
});

test('speed a new API lifetime requested by real rate-owner retirement notification survives old unload cleanup', async () => {
  const f = await playerActionsFixture();
  try {
    const first = rendererContext(f, speedConfig(f));
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), first.context);
    first.emit(channel, 1);
    const next = rendererContext(f, { ...speedConfig(f), step: 0.2 });
    let pending: any;
    let entered = false;
    const release = f.source.subscribePlaybackRateOwner(() => {
      if (!entered && f.source.getPlaybackRateOwner(f.media) === null) {
        entered = true;
        pending = f.source.playbackSpeed.onPlayerApiReady(
          f.api('B'),
          next.context,
        );
      }
    });
    f.source.playbackSpeed.onUnload();
    await pending;
    release();
    next.emit(channel, 1);
    expect(f.media.playbackRate).toBe(1.3);
    expect(next.listeners.get(channel)?.size).toBe(1);
    expect(first.listeners.get(channel)?.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('speed subscriber without an owned disposer cannot admit a step and preserves the manual slider', async () => {
  const f = await playerActionsFixture();
  try {
    const ipc = rendererContext(f, speedConfig(f));
    const subscribe = ipc.context.ipc.subscribe;
    ipc.context.ipc.subscribe = (name: string, invoke: any) => {
      subscribe(name, invoke);
      return undefined;
    };
    await f.source.playbackSpeed.onPlayerApiReady(f.api('A'), ipc.context);
    ipc.emit(channel, 1);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    expect(f.media.playbackRate).toBe(1);
    setSlider(f, 1.4);
    expect(f.media.playbackRate).toBe(1.4);
    f.source.playbackSpeed.onUnload();
    ipc.history[0](1);
    expect(f.media.playbackRate).toBe(1.4);
  } finally {
    await f.close();
  }
});
