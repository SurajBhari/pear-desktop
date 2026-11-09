import { test, expect } from '@playwright/test';
import { taskbarFixture } from './helpers/taskbar-progress-source';

test('native document retirement clears stale progress and waits for owned player readiness', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.backend?.start).toBe('function');
    const v = f.windowFixture();
    f.source.backend.start(v.context);
    f.emit(f.song(v.window));
    const contents = v.window.webContents;
    contents.emit(
      'did-start-navigation',
      {},
      'https://music.youtube.com',
      false,
      true,
    );
    expect(v.window.effects.at(-1)[0]).toBe(-1);
    const count = v.window.effects.length;
    f.emit(f.song(v.window));
    expect(v.window.effects).toHaveLength(count);
    f.native.ipcMain.emit('peard:player-api-loaded', {
      sender: contents,
      senderFrame: {},
    });
    f.emit(f.song(v.window));
    expect(v.window.effects).toHaveLength(count);
    f.native.ipcMain.emit('peard:player-api-loaded', {
      sender: contents,
      senderFrame: contents.mainFrame,
    });
    f.emit(f.song(v.window));
    expect(v.window.effects.at(-1)[0]).toBe(0.25);
    contents.emit(
      'did-start-navigation',
      {},
      'https://music.youtube.com/watch?v=fixture',
      true,
      true,
    );
    expect(v.window.effects.at(-1)[0]).toBe(0.25);
    contents.emit('render-process-gone', {}, {});
    expect(v.window.effects.at(-1)[0]).toBe(-1);
    f.source.backend.stop(v.context);
    expect(contents.listenerCount('did-start-navigation')).toBe(0);
    expect(contents.listenerCount('render-process-gone')).toBe(0);
  } finally {
    await f.close();
  }
});

test('off-default native progress replays the current owned song and requests its existing time observer', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.backend?.start).toBe('function');
    expect(f.source.plugin.config.enabled).toBe(false);
    const v = f.windowFixture();
    f.native.current = f.song(v.window);
    f.source.backend.start(v.context);
    expect(v.window.effects.at(-1)).toEqual([0.25, { mode: 'normal' }]);
    expect(f.sends.at(-1)).toMatchObject({
      window: v.window,
      args: ['peard:setup-time-changed-listener'],
    });
  } finally {
    await f.close();
  }
});

test('paused seek/clamping and invalid metadata clear previous progress instead of leaving it stale', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.backend?.start).toBe('function');
    const v = f.windowFixture();
    f.source.backend.start(v.context);
    f.emit(f.song(v.window, { elapsedSeconds: 150, isPaused: true }));
    expect(v.window.effects.at(-1)).toEqual([1, { mode: 'paused' }]);
    f.emit(f.song(v.window, { elapsedSeconds: 4, isPaused: true }));
    expect(v.window.effects.at(-1)).toEqual([0.04, { mode: 'paused' }]);
    for (const values of [
      { songDuration: 0 },
      { songDuration: NaN },
      { elapsedSeconds: undefined },
      { elapsedSeconds: -1 },
      { title: '' },
    ]) {
      f.emit(f.song(v.window));
      f.emit(f.song(v.window, values));
      expect(v.window.effects.at(-1)[0]).toBe(-1);
    }
  } finally {
    await f.close();
  }
});

test('foreign and retired metadata cannot update the current window', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.backend?.start).toBe('function');
    const v = f.windowFixture(),
      foreign = f.windowFixture();
    f.source.backend.start(v.context);
    f.emit(f.song(v.window));
    const old = f.song(v.window),
      count = v.window.effects.length;
    f.emit(f.song(foreign.window));
    f.native.tokens.set(v.window, {});
    f.emit(old);
    expect(v.window.effects).toHaveLength(count);
    f.emit(f.song(v.window, { elapsedSeconds: 70 }));
    expect(v.window.effects.at(-1)[0]).toBe(0.7);
  } finally {
    await f.close();
  }
});

test('stop and replacement dispose only owned subscriptions and late old-window close cannot clear new progress', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.backend?.start).toBe('function');
    const old = f.windowFixture(),
      current = f.windowFixture();
    const foreign = () => {};
    f.native.callbacks.add(foreign);
    f.native.ipcMain.on('peard:player-api-loaded', foreign);
    f.source.backend.start(old.context);
    f.source.backend.start(current.context);
    f.emit(f.song(current.window));
    const count = current.window.effects.length;
    old.window.emit('closed');
    f.source.backend.stop(old.context);
    expect(current.window.effects).toHaveLength(count);
    f.source.backend.stop(current.context);
    expect(current.window.effects.at(-1)[0]).toBe(-1);
    expect([...f.native.callbacks]).toEqual([foreign]);
    expect(f.native.ipcMain.listeners('peard:player-api-loaded')).toEqual([
      foreign,
    ]);
    f.emit(f.song(current.window));
    expect(current.window.effects).toHaveLength(count + 1);
  } finally {
    await f.close();
  }
});

test('only owned main-frame readiness requests time tracking and duplicate values do no additional native work', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.backend?.start).toBe('function');
    const v = f.windowFixture();
    f.source.backend.start(v.context);
    const before = f.sends.length;
    f.native.ipcMain.emit('peard:player-api-loaded', {
      sender: v.window.webContents,
      senderFrame: {},
    });
    expect(f.sends).toHaveLength(before);
    f.native.ipcMain.emit('peard:player-api-loaded', {
      sender: v.window.webContents,
      senderFrame: v.window.webContents.mainFrame,
    });
    expect(f.sends).toHaveLength(before + 1);
    f.emit(f.song(v.window));
    const count = v.window.effects.length;
    for (let i = 0; i < 100; i++) f.emit(f.song(v.window));
    expect(v.window.effects).toHaveLength(count);
    v.window.destroyed = true;
    v.window.emit('closed');
    expect(f.native.callbacks.size).toBe(0);
    expect(f.native.ipcMain.listenerCount('peard:player-api-loaded')).toBe(0);
  } finally {
    await f.close();
  }
});

test('Linux compatibility sends a real signal with zero progress visible and closes its owned bus', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.createLinuxProgress).toBe('function');
    const sink = f.source.createLinuxProgress('com.github.th-ch.youtube-music');
    expect(f.buses).toHaveLength(0);
    sink.update(0);
    const bus = f.buses[0],
      signal = bus.signals.at(-1);
    expect(signal.type).toBe(4);
    expect(signal.interface).toBe('com.canonical.Unity.LauncherEntry');
    expect(signal.body[0]).toBe(
      'application://com.github.th-ch.youtube-music.desktop',
    );
    expect(signal.body[1]['progress-visible'].value).toBe(true);
    const foreign = () => {};
    bus.on('error', foreign);
    sink.dispose();
    expect(bus.signals.at(-1).body[1]['progress-visible'].value).toBe(false);
    expect(bus.disconnected).toBe(true);
    expect(bus.listeners('error')).toEqual([foreign]);
    sink.update(0.9);
    expect(f.buses).toHaveLength(1);
    expect(bus.signals).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('Linux transport error stops work without reconnect polling and disposal may skip a stale global clear', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.createLinuxProgress).toBe('function');
    const sink = f.source.createLinuxProgress('fixture');
    sink.update(0.5);
    const bus = f.buses[0];
    bus.emit('error', new Error('synthetic transport loss'));
    for (let i = 0; i < 100; i++) sink.update(0.8);
    expect(f.buses).toHaveLength(1);
    expect(bus.signals).toHaveLength(1);
    sink.dispose(false);
    expect(bus.disconnected).toBe(true);
    const replacement = f.source.createLinuxProgress('fixture');
    replacement.update(0.7);
    const before = f.buses[1].signals.length;
    replacement.dispose(false);
    expect(f.buses[1].signals).toHaveLength(before);
    expect(f.buses[1].disconnected).toBe(true);
  } finally {
    await f.close();
  }
});

test('a newer start during native retirement remains authoritative over the outer replacement attempt', async () => {
  const f = await taskbarFixture();
  try {
    expect(typeof f.source.backend?.start).toBe('function');
    const old = f.windowFixture(),
      outer = f.windowFixture(),
      newest = f.windowFixture();
    f.source.backend.start(old.context);
    f.emit(f.song(old.window));
    old.window.sideEffect = () => {
      old.window.sideEffect = undefined;
      f.source.backend.start(newest.context);
    };
    f.source.backend.start(outer.context);
    f.emit(f.song(newest.window));
    expect(newest.window.effects.at(-1)[0]).toBe(0.25);
    expect(f.native.callbacks.size).toBe(1);
    expect(f.native.ipcMain.listenerCount('peard:player-api-loaded')).toBe(1);
    expect(outer.window.effects).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('owned admission invalidation clears progress even when the provider emits no metadata callback', async () => {
  const f = await taskbarFixture();
  try {
    const v = f.windowFixture();
    f.source.backend.start(v.context);
    f.emit(f.song(v.window));
    const count = v.window.effects.length;
    f.native.tokens.delete(v.window);
    f.native.ipcMain.emit(
      'peard:video-src-changed',
      { sender: v.window.webContents, senderFrame: {} },
      null,
    );
    expect(v.window.effects).toHaveLength(count);
    f.native.ipcMain.emit(
      'peard:video-src-changed',
      {
        sender: v.window.webContents,
        senderFrame: v.window.webContents.mainFrame,
      },
      null,
    );
    expect(v.window.effects.at(-1)[0]).toBe(-1);
    f.source.backend.stop(v.context);
    expect(f.native.ipcMain.listenerCount('peard:video-src-changed')).toBe(0);
  } finally {
    await f.close();
  }
});

test('numeric-zero and malformed title metadata with native provenance clear old progress without throwing', async () => {
  const f = await taskbarFixture();
  try {
    const v = f.windowFixture();
    f.source.backend.start(v.context);
    for (const title of [0, null, {}, []]) {
      f.emit(f.song(v.window));
      expect(() => f.emit(f.song(v.window, { title }))).not.toThrow();
      expect(v.window.effects.at(-1)[0]).toBe(-1);
    }
  } finally {
    await f.close();
  }
});

test('start on a destroyed native window registers no owned hooks or song callback', async () => {
  const f = await taskbarFixture();
  try {
    const v = f.windowFixture();
    v.window.destroyed = true;
    f.source.backend.start(v.context);
    expect(v.window.eventNames()).toHaveLength(0);
    expect(v.window.webContents.eventNames()).toHaveLength(0);
    expect(f.native.ipcMain.eventNames()).toHaveLength(0);
    expect(f.native.callbacks.size).toBe(0);
    expect(f.sends).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('metadata invalidation waits for the authoritative provider registered after the backend', async () => {
  const f = await taskbarFixture();
  try {
    const v = f.windowFixture();
    f.source.backend.start(v.context);
    f.emit(f.song(v.window));
    const provider = () => {
      f.native.tokens.set(v.window, {});
    };
    f.native.ipcMain.on('peard:video-src-changed', provider);
    f.native.ipcMain.emit(
      'peard:video-src-changed',
      {
        sender: v.window.webContents,
        senderFrame: v.window.webContents.mainFrame,
      },
      null,
    );
    await Promise.resolve();
    expect(v.window.effects.at(-1)[0]).toBe(-1);
    f.native.ipcMain.removeListener('peard:video-src-changed', provider);
  } finally {
    await f.close();
  }
});

test('same-turn provider publication wins over deferred invalidation and a retired owner cannot clear its replacement', async () => {
  const f = await taskbarFixture();
  try {
    const v = f.windowFixture();
    f.source.backend.start(v.context);
    f.emit(f.song(v.window));
    const provider = () => {
      f.native.tokens.set(v.window, {});
      f.emit(f.song(v.window, { elapsedSeconds: 70 }));
    };
    f.native.ipcMain.on('peard:video-src-changed', provider);
    f.native.ipcMain.emit(
      'peard:video-src-changed',
      {
        sender: v.window.webContents,
        senderFrame: v.window.webContents.mainFrame,
      },
      {},
    );
    await Promise.resolve();
    expect(v.window.effects.at(-1)[0]).toBe(0.7);
    f.native.ipcMain.removeListener('peard:video-src-changed', provider);
    f.native.ipcMain.emit(
      'peard:video-src-changed',
      {
        sender: v.window.webContents,
        senderFrame: v.window.webContents.mainFrame,
      },
      null,
    );
    const newer = f.windowFixture();
    f.source.backend.start(newer.context);
    f.emit(f.song(newer.window));
    const before = newer.window.effects.length;
    await Promise.resolve();
    expect(newer.window.effects).toHaveLength(before);
    expect(newer.window.effects.at(-1)[0]).toBe(0.25);
  } finally {
    await f.close();
  }
});
