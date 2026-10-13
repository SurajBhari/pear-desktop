import { test, expect } from '@playwright/test';
import { shortcutRatingSource } from './helpers/shortcut-rating-source';

test('supported saved like and dislike mappings dispatch existing provider values', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.global = { ...f.config.global, like: 'F8' };
    f.config.local = { ...f.config.local, dislike: 'F9' };
    await f.source.backend.start(f.context);
    expect(f.state.global.has('F8')).toBe(true);
    expect(f.state.local.has('F9')).toBe(true);
    f.state.global.get('F8')();
    f.state.local.get('F9')();
    expect(f.sent).toEqual([
      ['peard:update-like', 'LIKE'],
      ['peard:update-like', 'DISLIKE'],
    ]);
  } finally {
    await f.close();
  }
});

test('opt-in double callback focuses without a second playback toggle', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.focusWindowOnDoublePlayPause = true;
    f.config.global.playPause = 'F8';
    await f.source.backend.start(f.context);
    f.hidden();
    const action = f.state.global.get('F8');
    action();
    await new Promise((resolve) => setTimeout(resolve, 150));
    action();
    expect(f.sent).toEqual([['peard:toggle-play']]);
    expect(f.effects).toEqual(['restore', 'show', 'focus']);
  } finally {
    await f.close();
  }
});

test('invalid precise-volume registration leaves another valid binding usable', async () => {
  const f = await shortcutRatingSource();
  try {
    const config = {
      ...f.source.precise.config,
      enabled: true,
      globalShortcuts: { volumeUp: 'invalid', volumeDown: 'F9' },
    };
    const backend = f.source.precise.backend;
    const ctx = { ...f.context, getConfig: () => config };
    await expect(
      Promise.resolve().then(() =>
        typeof backend === 'function' ? backend(ctx) : backend.start(ctx),
      ),
    ).resolves.toBeUndefined();
    expect(f.state.global.has('F9')).toBe(true);
    f.state.global.get('F9')();
    expect(f.sent).toEqual([['changeVolume', false]]);
    expect(f.warnings).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('stop during pending native registration rolls back its confirmed binding', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.global.playPause = 'F8';
    f.state.registerHook = () => {
      f.state.registerHook = undefined;
      f.source.backend.stop();
    };
    await f.source.backend.start(f.context);
    expect([...f.state.global.keys()]).toEqual([]);
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

test('unregister reentry defers the latest same-key successor until old removal settles', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.global.playPause = 'F8';
    await f.source.backend.start(f.context);
    const latest = {
      ...f.config,
      global: { ...f.config.global, playPause: 'F8' },
    };
    f.state.unregisterHook = () => {
      f.state.unregisterHook = undefined;
      f.source.backend.onConfigChange(latest);
    };
    f.source.backend.onConfigChange({
      ...f.config,
      global: { ...f.config.global, playPause: 'F9' },
    });
    expect([...f.state.global.keys()]).toEqual(['F8']);
    f.state.global.get('F8')();
    expect(f.sent).toEqual([['peard:toggle-play']]);
  } finally {
    await f.close();
  }
});

test('confirmed global binding excludes its equivalent local duplicate', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.global.playPause = 'Control+P';
    f.config.local.playPause = 'Ctrl+P';
    await f.source.backend.start(f.context);
    expect([...f.state.local.keys()]).toEqual([]);
    f.state.global.get('Control+P')();
    expect(f.sent).toEqual([['peard:toggle-play']]);
  } finally {
    await f.close();
  }
});

for (const [gap, toggles, focuses] of [
  [99, 1, 0],
  [100, 1, 1],
  [250, 1, 1],
  [400, 1, 1],
  [401, 2, 0],
])
  test(`global command interval ${gap}ms has bounded toggle/focus effects`, async () => {
    const f = await shortcutRatingSource();
    try {
      let now = 0,
        played = 0,
        focused = 0;
      const gesture = f.source.createPlayPauseGesture({
        now: () => now,
        isCurrent: () => true,
        playPause: () => played++,
        focusWindow: () => focused++,
      });
      gesture.invoke({ scope: 'global', bindingId: 'one' });
      expect([played, focused]).toEqual([1, 0]);
      now = gap;
      gesture.invoke({ scope: 'global', bindingId: 'one' });
      expect([played, focused]).toEqual([toggles, focuses]);
    } finally {
      await f.close();
    }
  });

test('global bursts and post-focus triples remain suppressed until quiet', async () => {
  const f = await shortcutRatingSource();
  try {
    let now = 0,
      played = 0,
      focused = 0;
    const gesture = f.source.createPlayPauseGesture({
      now: () => now,
      isCurrent: () => true,
      playPause: () => played++,
      focusWindow: () => focused++,
    });
    const press = (time: number) => {
      now = time;
      gesture.invoke({ scope: 'global', bindingId: 'one' });
    };
    press(0);
    press(50);
    press(90);
    press(130);
    press(520);
    expect([played, focused]).toEqual([1, 0]);
    press(921);
    press(1171);
    press(1200);
    press(1500);
    expect([played, focused]).toEqual([2, 1]);
    press(1901);
    expect([played, focused]).toEqual([3, 1]);
  } finally {
    await f.close();
  }
});

test('local distinct press releases can pair quickly while held and duplicate input cannot', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.focusWindowOnDoublePlayPause = true;
    f.config.local.playPause = 'Control+P';
    await f.source.backend.start(f.context);
    const press = f.state.local.get('Control+P');
    f.input('keyDown');
    press();
    press();
    f.input('keyDown', { isAutoRepeat: true });
    press();
    f.input('keyDown');
    press();
    expect(f.sent).toEqual([['peard:toggle-play']]);
    expect(f.effects).toEqual([]);
    f.input('keyUp');
    f.input('keyDown');
    press();
    expect(f.sent).toEqual([['peard:toggle-play']]);
    expect(f.effects).toEqual(['focus']);
  } finally {
    await f.close();
  }
});

test('default double command preserves two ordinary toggles and no focus', async () => {
  const f = await shortcutRatingSource();
  try {
    expect(f.config.focusWindowOnDoublePlayPause).toBe(false);
    f.config.global.playPause = 'F8';
    await f.source.backend.start(f.context);
    f.state.global.get('F8')();
    f.state.global.get('F8')();
    expect(f.sent).toEqual([['peard:toggle-play'], ['peard:toggle-play']]);
    expect(f.effects).toEqual([]);
  } finally {
    await f.close();
  }
});

test('shared pending registration defers precise-volume alias successor and stale cleanup', async () => {
  const f = await shortcutRatingSource();
  try {
    const volume = f.source.precise.backend;
    const empty = {
      ...f.source.precise.config,
      enabled: true,
      globalShortcuts: { volumeUp: '', volumeDown: '' },
    };
    await volume.start({ ...f.context, getConfig: () => empty });
    f.config.global.playPause = 'Control+J';
    let old: any;
    const register = f.state.nativeRegister;
    f.state.nativeRegister = (key: string, invoke: any) => {
      if (key === 'Control+J') old = invoke;
      return register(key, invoke);
    };
    f.state.registerHook = () => {
      f.state.registerHook = undefined;
      f.source.backend.stop();
      volume.onConfigChange({
        ...empty,
        globalShortcuts: { volumeUp: 'Ctrl+J', volumeDown: '' },
      });
    };
    await f.source.backend.start(f.context);
    expect([...f.state.global.keys()]).toEqual(['Ctrl+J']);
    old();
    expect(f.sent).toEqual([]);
    f.source.backend.stop();
    expect([...f.state.global.keys()]).toEqual(['Ctrl+J']);
    f.state.global.get('Ctrl+J')();
    expect(f.sent).toEqual([['changeVolume', true]]);
    volume.stop();
    expect([...f.state.global.keys()]).toEqual([]);
  } finally {
    await f.close();
  }
});

test('shared unregister reserves the native key until precise-volume successor can register', async () => {
  const f = await shortcutRatingSource();
  try {
    const volume = f.source.precise.backend;
    const empty = {
      ...f.source.precise.config,
      enabled: true,
      globalShortcuts: { volumeUp: '', volumeDown: '' },
    };
    await volume.start({ ...f.context, getConfig: () => empty });
    f.config.global.playPause = 'Control+J';
    await f.source.backend.start(f.context);
    f.state.unregisterHook = () => {
      f.state.unregisterHook = undefined;
      volume.onConfigChange({
        ...empty,
        globalShortcuts: { volumeUp: 'Ctrl+J', volumeDown: '' },
      });
    };
    f.source.backend.stop();
    expect([...f.state.global.keys()]).toEqual(['Ctrl+J']);
    f.state.global.get('Ctrl+J')();
    expect(f.sent).toEqual([['changeVolume', true]]);
  } finally {
    await f.close();
  }
});

test('external ownership predicate reentry cannot admit an obsolete native binding', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.global.playPause = 'F8';
    f.state.isRegisteredHook = () => {
      f.state.isRegisteredHook = undefined;
      f.source.backend.onConfigChange({
        ...f.config,
        global: { ...f.config.global, playPause: 'F9' },
      });
    };
    await f.source.backend.start(f.context);
    expect([...f.state.global.keys()]).toEqual(['F9']);
    f.state.global.get('F9')();
    expect(f.sent).toEqual([['peard:toggle-play']]);
  } finally {
    await f.close();
  }
});

test('foreign native registration survives collisions and stopped cleanup', async () => {
  const f = await shortcutRatingSource();
  try {
    const foreign = () => {};
    f.state.global.set('Control+J', foreign);
    f.config.global.playPause = 'Ctrl+J';
    await f.source.backend.start(f.context);
    f.source.backend.stop();
    expect(f.state.global.get('Control+J')).toBe(foreign);
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const method of ['isMinimized', 'restore', 'isVisible', 'show']) {
  test(`focus ${method} reentry retires all later native effects`, async () => {
    const f = await shortcutRatingSource();
    try {
      f.config.focusWindowOnDoublePlayPause = true;
      f.config.local.playPause = 'Control+P';
      await f.source.backend.start(f.context);
      f.hidden();
      const action = f.state.local.get('Control+P');
      f.input('keyDown');
      action();
      f.input('keyUp');
      const original = (f.window as any)[method];
      (f.window as any)[method] = () => {
        const result = original();
        f.source.backend.stop();
        return result;
      };
      f.input('keyDown');
      action();
      expect(f.sent).toEqual([['peard:toggle-play']]);
      expect(f.effects).toEqual(
        method === 'isMinimized'
          ? []
          : method === 'show'
            ? ['restore', 'show']
            : ['restore'],
      );
      expect(f.state.local.size).toBe(0);
      expect(f.contents.listenerCount('before-input-event')).toBe(0);
    } finally {
      await f.close();
    }
  });
}

for (const reset of ['blur', 'navigation', 'config']) {
  test(`${reset} resets a pending local pair`, async () => {
    const f = await shortcutRatingSource();
    try {
      f.config.focusWindowOnDoublePlayPause = true;
      f.config.local.playPause = 'Control+P';
      await f.source.backend.start(f.context);
      f.input('keyDown');
      f.state.local.get('Control+P')();
      f.input('keyUp');
      if (reset === 'blur') f.window.emit('blur');
      else if (reset === 'navigation')
        f.contents.emit('did-start-navigation', {}, '', false, true);
      else f.source.backend.onConfigChange({ ...f.config });
      f.input('keyDown');
      f.state.local.get('Control+P')();
      expect(f.sent).toEqual([['peard:toggle-play'], ['peard:toggle-play']]);
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const kind of ['shortcuts', 'precise']) {
  for (const resolution of ['latest', 'stop', 'disable']) {
    test(`${kind} held startup accepts only ${resolution} ownership`, async () => {
      const f = await shortcutRatingSource();
      try {
        const backend =
          kind === 'shortcuts' ? f.source.backend : f.source.precise.backend;
        const initial =
          kind === 'shortcuts'
            ? { ...f.config, global: { ...f.config.global, playPause: 'F8' } }
            : {
                ...f.source.precise.config,
                enabled: true,
                globalShortcuts: { volumeUp: 'F8', volumeDown: '' },
              };
        const latest =
          kind === 'shortcuts'
            ? { ...initial, global: { ...initial.global, playPause: 'F9' } }
            : {
                ...initial,
                globalShortcuts: { volumeUp: 'F9', volumeDown: '' },
              };
        let resolve!: (value: any) => void;
        const pending = backend.start({
          ...f.context,
          getConfig: () =>
            new Promise((done) => {
              resolve = done;
            }),
        });
        if (resolution === 'latest') backend.onConfigChange(latest);
        else if (resolution === 'stop') backend.stop();
        else backend.onConfigChange({ ...initial, enabled: false });
        resolve(initial);
        await pending;
        expect([...f.state.global.keys()]).toEqual(
          resolution === 'latest' ? ['F9'] : [],
        );
        backend.stop();
        expect(f.window.listenerCount('closed')).toBe(0);
      } finally {
        await f.close();
      }
    });
  }
}

for (const boundary of ['localRegisterHook', 'localUnregisterHook']) {
  test(`${boundary} config reentry retains one latest local handler`, async () => {
    const f = await shortcutRatingSource();
    try {
      f.config.local.playPause = 'Control+P';
      const latest = {
        ...f.config,
        local: { ...f.config.local, playPause: 'Control+J' },
      };
      if (boundary === 'localUnregisterHook')
        await f.source.backend.start(f.context);
      f.state[boundary] = () => {
        f.state[boundary] = undefined;
        f.source.backend.onConfigChange(latest);
      };
      if (boundary === 'localRegisterHook')
        await f.source.backend.start(f.context);
      else f.source.backend.onConfigChange({ ...f.config });
      expect([...f.state.local.keys()]).toEqual(['Control+J']);
      f.state.local.get('Control+J')();
      expect(f.sent).toEqual([['peard:toggle-play']]);
      expect(f.contents.listenerCount('before-input-event')).toBe(1);
      expect(f.window.listenerCount('blur')).toBe(1);
    } finally {
      await f.close();
    }
  });
}

for (const kind of ['shortcuts', 'precise']) {
  test(`${kind} closed listener newListener reentry cannot leak after stop`, async () => {
    const f = await shortcutRatingSource();
    try {
      const backend =
        kind === 'shortcuts' ? f.source.backend : f.source.precise.backend;
      f.window.once('newListener', (event: string) => {
        if (event === 'closed') backend.stop();
      });
      await backend.start(f.context);
      expect(f.window.listenerCount('closed')).toBe(0);
      expect(f.state.global.size).toBe(0);
      expect(f.state.local.size).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test('old owned disposer cannot remove its new successor', async () => {
  const f = await shortcutRatingSource();
  try {
    const oldScope = new AbortController(),
      nextScope = new AbortController();
    const old = f.source.registerOwnedGlobalShortcut(
      { signal: oldScope.signal, isCurrent: () => true },
      'Control+J',
      () => f.sent.push('old'),
    );
    oldScope.abort();
    const next = f.source.registerOwnedGlobalShortcut(
      { signal: nextScope.signal, isCurrent: () => true },
      'Ctrl+J',
      () => f.sent.push('next'),
    );
    old();
    old();
    expect([...f.state.global.keys()]).toEqual(['Ctrl+J']);
    f.state.global.get('Ctrl+J')();
    expect(f.sent).toEqual(['next']);
    next();
    expect(f.state.global.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('false native registration is never cleaned up as an owned foreign binding', async () => {
  const f = await shortcutRatingSource();
  try {
    const foreign = () => {};
    f.config.global.playPause = 'F8';
    f.state.nativeRegister = (key: string) => {
      f.state.global.set(key, foreign);
      return false;
    };
    await f.source.backend.start(f.context);
    f.source.backend.stop();
    expect(f.state.global.get('F8')).toBe(foreign);
    expect(f.warnings).toHaveLength(1);
    expect(f.sent).toEqual([]);
  } finally {
    await f.close();
  }
});

test('media override duplicates and unknown actions cannot multiply app commands', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.overrideMediaKeys = true;
    f.config.global = {
      ...f.config.global,
      playPause: 'MediaPlayPause',
      constructor: 'F8',
      goForward: 'F9',
    };
    f.config.local.playPause = 'MediaPlayPause';
    await f.source.backend.start(f.context);
    expect([...f.state.global.keys()]).toEqual([
      'MediaPlayPause',
      'MediaNextTrack',
      'MediaPreviousTrack',
    ]);
    expect(f.state.local.size).toBe(0);
    f.state.global.get('MediaPlayPause')();
    expect(f.sent).toEqual([['peard:toggle-play']]);
  } finally {
    await f.close();
  }
});

test('foreign local binding survives collision and stop', async () => {
  const f = await shortcutRatingSource();
  try {
    const foreign = () => {};
    f.state.local.set('Control+P', foreign);
    f.config.local.playPause = 'Control+P';
    await f.source.backend.start(f.context);
    f.source.backend.stop();
    expect(f.state.local.get('Control+P')).toBe(foreign);
    expect(f.contents.listenerCount('before-input-event')).toBe(0);
  } finally {
    await f.close();
  }
});

for (const retire of ['stop', 'navigation', 'frame']) {
  test(`held mapping prompt ignores ${retire} retirement`, async () => {
    const f = await shortcutRatingSource();
    try {
      await f.source.backend.start(f.context);
      const menu = await f.source.onMenu(f.context);
      let resolve!: (value: any) => void;
      f.state.prompt = () =>
        new Promise((done) => {
          resolve = done;
        });
      const click = menu[0].click();
      while (!resolve) await Promise.resolve();
      if (retire === 'stop') f.source.backend.stop();
      else if (retire === 'navigation')
        f.contents.emit('did-start-navigation', {}, '', false, true);
      else f.contents.mainFrame = {};
      resolve([{ value: 'like', accelerator: 'F8' }]);
      await click;
      expect(f.writes).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test('mapping prompt merges latest fields and rejects concurrent same-field edits', async () => {
  const f = await shortcutRatingSource();
  try {
    const menu = await f.source.onMenu(f.context);
    let resolve!: (value: any) => void;
    f.state.prompt = () =>
      new Promise((done) => {
        resolve = done;
      });
    const click = menu[0].click();
    while (!resolve) await Promise.resolve();
    f.config.global.like = 'F9'; // in-place edits must still be detected
    f.config = {
      ...f.config,
      global: { ...f.config.global, next: 'F10', foreign: 'F11' },
    };
    resolve([
      { value: 'like', accelerator: 'F8' },
      { value: 'dislike', accelerator: 'F7' },
      { value: 'constructor', accelerator: 'F6' },
    ]);
    await click;
    expect(f.writes).toEqual([
      { global: { ...f.config.global, dislike: 'F7' } },
    ]);
    expect(f.config.global.like).toBe('F9');
    expect(f.config.global.next).toBe('F10');
    expect(f.config.global.foreign).toBe('F11');
  } finally {
    await f.close();
  }
});

test('different binding identities cannot form a focus pair', async () => {
  const f = await shortcutRatingSource();
  try {
    let now = 0,
      played = 0,
      focused = 0;
    const gesture = f.source.createPlayPauseGesture({
      now: () => now,
      isCurrent: () => true,
      playPause: () => played++,
      focusWindow: () => focused++,
    });
    gesture.invoke({ scope: 'global', bindingId: 'one' });
    now = 250;
    gesture.invoke({ scope: 'global', bindingId: 'two' });
    expect([played, focused]).toEqual([2, 0]);
    gesture.reset();
    now = 300;
    gesture.invoke({ scope: 'global', bindingId: 'two' });
    expect([played, focused]).toEqual([3, 0]);
  } finally {
    await f.close();
  }
});

test('held seek duration prompt does not overwrite a concurrent edit of the same setting', async () => {
  const f = await shortcutRatingSource();
  try {
    const menu = await f.source.onMenu(f.context);
    let resolve!: (value: any) => void;
    f.state.prompt = () =>
      new Promise((done) => {
        resolve = done;
      });
    const click = menu[2].submenu[0].click();
    while (!resolve) await Promise.resolve();
    f.config.seekForwardSeconds = 41;
    resolve('27');
    await click;
    expect(f.writes).toEqual([]);
    expect(f.config.seekForwardSeconds).toBe(41);
  } finally {
    await f.close();
  }
});

for (const [name, command] of [
  ['playPause', ['peard:toggle-play']],
  ['like', ['peard:update-like', 'LIKE']],
  ['dislike', ['peard:update-like', 'DISLIKE']],
] as const) {
  test(`F2 default local ${name} admits each observed press once despite duplicate callbacks`, async () => {
    const f = await shortcutRatingSource();
    try {
      expect(f.config.focusWindowOnDoublePlayPause).toBe(false);
      f.config.local[name] = 'F8';
      await f.source.backend.start(f.context);
      const invoke = f.state.local.get('F8');
      f.input('keyDown', { code: 'F8', key: 'F8' });
      invoke();
      invoke();
      expect(f.sent).toEqual([command]);
      f.input('keyDown', { code: 'F8', key: 'F8', isAutoRepeat: true });
      invoke();
      invoke();
      expect(f.sent).toEqual([command]);
      f.input('keyUp', { code: 'F8', key: 'F8' });
      f.input('keyDown', { code: 'F8', key: 'F8' });
      invoke();
      invoke();
      expect(f.sent).toEqual([command, command]);
      f.source.backend.stop();
      invoke();
      expect(f.sent).toEqual([command, command]);
    } finally {
      await f.close();
    }
  });
}

for (const [name, command] of [
  ['previous', ['peard:previous-video']],
  ['next', ['peard:next-video']],
  ['seekForward', ['peard:seek-by', 5]],
  ['seekBackward', ['peard:seek-by', -5]],
] as const) {
  test(`F2 local ${name} retains held repeats while duplicate delivery of each event is dropped`, async () => {
    const f = await shortcutRatingSource();
    try {
      f.config.local[name] = 'F8';
      await f.source.backend.start(f.context);
      const invoke = f.state.local.get('F8');
      f.input('keyDown');
      invoke();
      invoke();
      expect(f.sent).toEqual([command]);
      f.input('keyDown', { isAutoRepeat: true });
      invoke();
      invoke();
      expect(f.sent).toEqual([command, command]);
      f.input('keyDown');
      invoke();
      invoke();
      expect(f.sent).toEqual([command, command, command]);
    } finally {
      await f.close();
    }
  });
}

test('F2 observed local press is claimed before a native owner predicate reenters its callback', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.local.playPause = 'F8';
    await f.source.backend.start(f.context);
    const invoke = f.state.local.get('F8');
    f.input('keyDown');
    let entered = 0,
      duplicateNativeReads = 0;
    f.window.isDestroyed = () => {
      if (++entered === 1) {
        const before = entered;
        invoke();
        duplicateNativeReads += entered - before;
      }
      return false;
    };
    invoke();
    expect(f.sent).toEqual([['peard:toggle-play']]);
    expect(entered).toBeGreaterThan(0);
    expect(duplicateNativeReads).toBe(0);
  } finally {
    await f.close();
  }
});

test('F2 local delivery dedup stays per binding and preserves no-input manual callbacks', async () => {
  const f = await shortcutRatingSource();
  try {
    f.config.local = { ...f.config.local, like: 'F8', dislike: 'F9' };
    await f.source.backend.start(f.context);
    const like = f.state.local.get('F8'),
      dislike = f.state.local.get('F9');
    like();
    like();
    expect(f.sent).toEqual([
      ['peard:update-like', 'LIKE'],
      ['peard:update-like', 'LIKE'],
    ]);
    f.sent.length = 0;
    f.input('keyDown');
    like();
    like();
    dislike();
    dislike();
    expect(f.sent).toEqual([
      ['peard:update-like', 'LIKE'],
      ['peard:update-like', 'DISLIKE'],
    ]);
    f.window.emit('blur');
    like();
    expect(f.sent).toHaveLength(3);
    expect(f.sent[2]).toEqual(['peard:update-like', 'LIKE']);
  } finally {
    await f.close();
  }
});
