import { test, expect } from '@playwright/test';
import { shortcutRatingNative } from './helpers/shortcut-rating-native';

test('actual Electron provider delivers supported like/dislike and owned double-command focus', async () => {
  const result = await shortcutRatingNative(async () => {
    const f = (globalThis as any).ShortcutNativeProof;
    const window = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    await window.webContents.executeJavaScript(
      `window.ipcRenderer=window.shortcutProof;window.received=[];window.nativeLikes=[];document.querySelector('video').playbackRate=1.37;document.querySelector('#like-button-renderer').updateLikeStatus=status=>{window.nativeLikes.push(status);document.querySelector('#like-button-renderer').setAttribute('like-status',status)};for(const channel of ['peard:toggle-play','peard:seek-by'])window.shortcutProof.on(channel,(_e,...args)=>window.received.push([channel,...args]));undefined;`,
    );
    await window.webContents.executeJavaScript(f.client);
    const config = {
      ...f.source.shortcuts.config,
      enabled: true,
      focusWindowOnDoublePlayPause: true,
      global: {
        ...f.source.shortcuts.config.global,
        like: 'CommandOrControl+Shift+Alt+F6',
        dislike: 'CommandOrControl+Shift+Alt+F7',
        playPause: 'CommandOrControl+Shift+Alt+F8',
      },
    };
    await f.source.backend.start({ window, getConfig: () => config });
    const registered = [
      config.global.like,
      config.global.dislike,
      config.global.playPause,
    ].map((key) => f.globalShortcut.isRegistered(key));
    if (registered.every(Boolean)) {
      f.callbacks.get(config.global.like)();
      f.callbacks.get(config.global.dislike)();
      f.callbacks.get(config.global.playPause)();
      await new Promise((resolve) => setTimeout(resolve, 150));
      f.callbacks.get(config.global.playPause)();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const facts = await window.webContents.executeJavaScript(
      `({likes:window.nativeLikes,received:window.received,rate:document.querySelector('video').playbackRate})`,
    );
    const visible = window.isVisible();
    f.source.backend.stop();
    return {
      registered,
      ...facts,
      visible,
      released: Object.values(config.global)
        .filter(Boolean)
        .every((key) => !f.globalShortcut.isRegistered(key)),
    };
  });
  console.log(
    'NATIVE_SHORTCUT_FACTS ' +
      JSON.stringify({
        platform: process.platform,
        case: 'provider-double',
        ...result,
      }),
  );
  expect(result.registered).toEqual([true, true, true]);
  expect(result.likes).toEqual(['LIKE', 'DISLIKE']);
  expect(result.received).toEqual([['peard:toggle-play']]);
  expect(result.visible).toBe(true);
  expect(result.rate).toBe(1.37);
  expect(result.released).toBe(true);
});

test('actual before-input down/up and repeat flags distinguish local releases from held callbacks', async () => {
  const result = await shortcutRatingNative(async () => {
    const f = (globalThis as any).ShortcutNativeProof;
    const window = new f.BrowserWindow({
      show: true,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    await window.webContents.executeJavaScript(
      `window.received=[];window.shortcutProof.on('peard:toggle-play',()=>window.received.push('toggle'));document.querySelector('video').playbackRate=1.37;undefined;`,
    );
    const config = {
      ...f.source.shortcuts.config,
      enabled: true,
      focusWindowOnDoublePlayPause: true,
      local: {
        ...f.source.shortcuts.config.local,
        playPause: 'Control+Shift+P',
      },
    };
    const inputs: any[] = [];
    window.webContents.on('before-input-event', (_event: any, input: any) =>
      inputs.push({ type: input.type, repeat: input.isAutoRepeat }),
    );
    await f.source.backend.start({ window, getConfig: () => config });
    f.app.focus({ steal: true });
    window.focus();
    const end = Date.now() + 5000;
    while (!window.isFocused()) {
      if (Date.now() >= end) throw Error('Native input owner did not focus');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const input = (type: string, repeat = false) =>
      window.webContents.sendInputEvent({
        type,
        keyCode: 'P',
        modifiers: ['control', 'shift', ...(repeat ? ['isautorepeat'] : [])],
      });
    input('keyDown');
    input('keyDown', true);
    input('keyDown');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const held = await window.webContents.executeJavaScript(
      'window.received.length',
    );
    input('keyUp');
    input('keyDown');
    input('keyUp');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const released = await window.webContents.executeJavaScript(
      'window.received.length',
    );
    const rate = await window.webContents.executeJavaScript(
      'document.querySelector("video").playbackRate',
    );
    f.source.backend.stop();
    return { held, released, inputs, rate, focused: window.isFocused() };
  });
  console.log(
    'NATIVE_SHORTCUT_FACTS ' +
      JSON.stringify({
        platform: process.platform,
        case: 'local-repeat',
        ...result,
      }),
  );
  expect(
    result.inputs.some(
      (event: any) => event.type === 'keyDown' && event.repeat,
    ),
  ).toBe(true);
  expect(
    result.inputs.filter((event: any) => event.type === 'keyUp'),
  ).toHaveLength(2);
  expect(result.held).toBe(1);
  expect(result.released).toBe(1);
  expect(result.focused).toBe(true);
  expect(result.rate).toBe(1.37);
});

test('actual native foreign global and local registrations survive shared shortcut and volume collisions', async () => {
  const result = await shortcutRatingNative(async () => {
    const f = (globalThis as any).ShortcutNativeProof;
    const window = new f.BrowserWindow({ show: true });
    await window.loadFile(f.owned + '/main.html');
    const foreignKey = 'CommandOrControl+Shift+Alt+F12',
      volumeKey = 'CommandOrControl+Shift+Alt+F11';
    let foreignLocal = 0;
    const foreignGlobal = () => {};
    const nativeForeign = f.globalShortcut.register(foreignKey, foreignGlobal);
    f.localShortcut.register(window, 'Control+Shift+K', () => foreignLocal++);
    const config = {
      ...f.source.shortcuts.config,
      enabled: true,
      global: { ...f.source.shortcuts.config.global, playPause: foreignKey },
      local: {
        ...f.source.shortcuts.config.local,
        playPause: 'Control+Shift+K',
      },
    };
    await f.source.backend.start({ window, getConfig: () => config });
    const sent: any[] = [];
    await f.source.precise.backend.start({
      window,
      getConfig: () => ({
        ...f.source.precise.config,
        enabled: true,
        globalShortcuts: { volumeUp: foreignKey, volumeDown: volumeKey },
      }),
      ipc: { send: (...args: any[]) => sent.push(args) },
    });
    const volumeRegistered = f.globalShortcut.isRegistered(volumeKey);
    if (volumeRegistered) f.callbacks.get(volumeKey)();
    f.source.backend.stop();
    f.source.precise.backend.stop();
    const globalSurvived =
      f.globalShortcut.isRegistered(foreignKey) &&
      f.callbacks.get(foreignKey) === foreignGlobal;
    const localSurvived = f.localShortcut.isRegistered(
      window,
      'Control+Shift+K',
    );
    f.app.focus({ steal: true });
    window.focus();
    const end = Date.now() + 5000;
    while (!window.isFocused()) {
      if (Date.now() >= end)
        throw Error('Native foreign input owner did not focus');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'K',
      modifiers: ['control', 'shift'],
    });
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'K',
      modifiers: ['control', 'shift'],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const volumeReleased = !f.globalShortcut.isRegistered(volumeKey);
    f.globalShortcut.unregister(foreignKey);
    f.localShortcut.unregister(window, 'Control+Shift+K');
    return {
      nativeForeign,
      volumeRegistered,
      globalSurvived,
      localSurvived,
      foreignLocal,
      volumeReleased,
      sent,
      electron: f.versions.electron,
    };
  });
  console.log(
    'NATIVE_SHORTCUT_FACTS ' +
      JSON.stringify({
        platform: process.platform,
        case: 'foreign-collisions',
        ...result,
      }),
  );
  expect(result).toMatchObject({
    nativeForeign: true,
    volumeRegistered: true,
    globalSurvived: true,
    localSurvived: true,
    foreignLocal: 1,
    volumeReleased: true,
    sent: [['changeVolume', false]],
  });
});

test('F2 same actual local registry admits only the foreign callback before and after app stop', async () => {
  const result = await shortcutRatingNative(async () => {
    const f = (globalThis as any).ShortcutNativeProof;
    const window = new f.BrowserWindow({
      show: true,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    await window.webContents.executeJavaScript(
      "window.commands=[];window.shortcutProof.on('peard:toggle-play',()=>window.commands.push('toggle'));undefined;",
    );
    let foreignCalls = 0;
    const key = 'Control+Shift+K';
    f.localShortcut.register(window, key, () => foreignCalls++);
    const config = {
      ...f.source.shortcuts.config,
      enabled: true,
      local: { ...f.source.shortcuts.config.local, playPause: key },
    };
    await f.source.backend.start({ window, getConfig: () => config });
    f.app.focus({ steal: true });
    window.focus();
    const deadline = Date.now() + 5000;
    while (!window.isFocused()) {
      if (Date.now() >= deadline)
        throw Error('Native collision input owner did not focus');
      await new Promise((done) => setTimeout(done, 5));
    }
    const press = async () => {
      window.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'K',
        modifiers: ['control', 'shift'],
      });
      window.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: 'K',
        modifiers: ['control', 'shift'],
      });
      await new Promise((done) => setTimeout(done, 20));
    };
    await press();
    const active = {
      appCommands: await window.webContents.executeJavaScript(
        'window.commands.length',
      ),
      foreignCalls,
    };
    f.source.backend.stop();
    const foreignSurvived = f.localShortcut.isRegistered(window, key);
    await press();
    const stopped = {
      appCommands: await window.webContents.executeJavaScript(
        'window.commands.length',
      ),
      foreignCalls,
    };
    f.localShortcut.unregister(window, key);
    return {
      shared: f.localShortcut === f.source.localShortcut,
      active,
      stopped,
      foreignSurvived,
    };
  });
  console.log('NATIVE_SHORTCUT_F2_FACTS ' + JSON.stringify(result));
  expect(result).toEqual({
    shared: true,
    active: { appCommands: 0, foreignCalls: 1 },
    stopped: { appCommands: 0, foreignCalls: 2 },
    foreignSurvived: true,
  });
});

for (const duplicateLocalCallbacks of [false, true]) {
  test(`F2 native default playback accepts normal=${!duplicateLocalCallbacks} duplicate=${duplicateLocalCallbacks} callback delivery once per released press`, async () => {
    const result = await shortcutRatingNative(
      async () => {
        const f = (globalThis as any).ShortcutNativeProof;
        const window = new f.BrowserWindow({
          show: true,
          webPreferences: {
            preload: f.preload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        });
        await window.loadFile(f.owned + '/main.html');
        await window.webContents.executeJavaScript(
          "window.commands=[];window.shortcutProof.on('peard:toggle-play',()=>window.commands.push('toggle'));document.querySelector('video').playbackRate=1.37;undefined;",
        );
        const config = {
          ...f.source.shortcuts.config,
          enabled: true,
          local: {
            ...f.source.shortcuts.config.local,
            playPause: 'Control+Shift+P',
          },
        };
        const inputs: any[] = [];
        window.webContents.on('before-input-event', (_event: any, input: any) =>
          inputs.push({ type: input.type, repeat: input.isAutoRepeat }),
        );
        await f.source.backend.start({ window, getConfig: () => config });
        f.app.focus({ steal: true });
        window.focus();
        const deadline = Date.now() + 5000;
        while (!window.isFocused()) {
          if (Date.now() >= deadline)
            throw Error('Native duplicate input owner did not focus');
          await new Promise((done) => setTimeout(done, 5));
        }
        const input = (type: string, repeat = false) =>
          window.webContents.sendInputEvent({
            type,
            keyCode: 'P',
            modifiers: [
              'control',
              'shift',
              ...(repeat ? ['isautorepeat'] : []),
            ],
          });
        const count = () =>
          window.webContents.executeJavaScript('window.commands.length');
        input('keyDown');
        input('keyDown', true);
        input('keyDown');
        await new Promise((done) => setTimeout(done, 20));
        const held = await count();
        input('keyUp');
        input('keyDown');
        input('keyUp');
        await new Promise((done) => setTimeout(done, 20));
        const distinct = await count();
        f.source.backend.stop();
        input('keyDown');
        input('keyUp');
        await new Promise((done) => setTimeout(done, 20));
        return {
          held,
          distinct,
          stopped: await count(),
          rate: await window.webContents.executeJavaScript(
            'document.querySelector("video").playbackRate',
          ),
          inputs,
          focusPreference: config.focusWindowOnDoublePlayPause,
        };
      },
      { duplicateLocalCallbacks },
    );
    console.log(
      'NATIVE_SHORTCUT_F2_DUPLICATE_FACTS ' +
        JSON.stringify({ duplicateLocalCallbacks, ...result }),
    );
    expect(result).toMatchObject({
      held: 1,
      distinct: 2,
      stopped: 2,
      rate: 1.37,
      focusPreference: false,
    });
    expect(
      result.inputs.some(
        (input: any) => input.type === 'keyDown' && input.repeat,
      ),
    ).toBe(true);
    expect(
      result.inputs.filter((input: any) => input.type === 'keyUp'),
    ).toHaveLength(3);
  });
}

test('speed nonfocus native registry and owned IPC advance actual video through the real renderer owner', async () => {
  const result = await shortcutRatingNative(
    async () => {
      const f = (globalThis as any).ShortcutNativeProof;
      const window = new f.BrowserWindow({
        show: false,
        webPreferences: {
          preload: f.preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      await window.loadFile(f.owned + '/main.html');
      await window.webContents.executeJavaScript(f.speedClient);
      const config = {
        ...f.source.playbackSpeed.config,
        enabled: true,
        preservesPitch: false,
        step: 0.1,
        globalShortcuts: {
          speedUp: 'CommandOrControl+Shift+Alt+F5',
          speedDown: 'CommandOrControl+Shift+Alt+F6',
        },
      };
      await window.webContents.executeJavaScript(
        `window.speedApi={};window.speedConfig=${JSON.stringify(config)};document.querySelector('video').playbackRate=1;document.querySelector('video').volume=0;document.querySelector('video').muted=true;window.speedContext={getConfig:()=>window.speedConfig,ipc:{subscribe:(channel,listener)=>window.shortcutProof.on(channel,(_event,...args)=>listener(...args))}};NativeSpeedFixture.renderer.onPlayerApiReady(window.speedApi,window.speedContext);`,
      );
      const initial = await window.webContents.executeJavaScript(
        `({owner:NativeSpeedFixture.getPlaybackRateOwner(document.querySelector('video')),rate:document.querySelector('video').playbackRate})`,
      );
      await f.source.playbackSpeed.backend?.start?.({
        window,
        getConfig: () => config,
        ipc: { send: (...args: any[]) => window.webContents.send(...args) },
      });
      const registered = Object.values(config.globalShortcuts).map((key: any) =>
        f.globalShortcut.isRegistered(key),
      );
      const up = f.callbacks.get(config.globalShortcuts.speedUp),
        down = f.callbacks.get(config.globalShortcuts.speedDown);
      if (registered.every(Boolean)) {
        up();
      }
      let upRate = 1;
      for (let i = 0; i < 100; i++) {
        upRate = await window.webContents.executeJavaScript(
          'document.querySelector("video").playbackRate',
        );
        if (upRate === 1.1) break;
        await new Promise((done) => setTimeout(done, 5));
      }
      const upLabel = await window.webContents.executeJavaScript(
        'document.querySelector("#ytmcustom-playback-speed")?.textContent',
      );
      if (registered.every(Boolean)) down();
      let downRate = upRate;
      for (let i = 0; i < 100; i++) {
        downRate = await window.webContents.executeJavaScript(
          'document.querySelector("video").playbackRate',
        );
        if (downRate === 1) break;
        await new Promise((done) => setTimeout(done, 5));
      }
      const downLabel = await window.webContents.executeJavaScript(
        'document.querySelector("#ytmcustom-playback-speed")?.textContent',
      );
      const facts = await window.webContents.executeJavaScript(
        `({owner:NativeSpeedFixture.getPlaybackRateOwner(document.querySelector('video')),pitch:document.querySelector('video').preservesPitch,muted:document.querySelector('video').muted,volume:document.querySelector('video').volume,paused:document.querySelector('video').paused})`,
      );
      f.source.playbackSpeed.backend?.stop?.();
      if (up) up();
      await window.webContents.executeJavaScript(
        'NativeSpeedFixture.renderer.onUnload();',
      );
      const released = Object.values(config.globalShortcuts).every(
        (key: any) => !f.globalShortcut.isRegistered(key),
      );
      return {
        initial,
        registered,
        upRate,
        downRate,
        released,
        upLabel,
        downLabel,
        ...facts,
      };
    },
    { speedRenderer: true },
  );
  console.log('NATIVE_SPEED_NONFOCUS ' + JSON.stringify(result));
  expect(result).toEqual({
    initial: { owner: null, rate: 1 },
    registered: [true, true],
    upRate: 1.1,
    downRate: 1,
    released: true,
    upLabel: 'plugins.playback-speed.templates.button (1.1)',
    downLabel: 'plugins.playback-speed.templates.button (1)',
    owner: 'playback-speed',
    pitch: false,
    muted: true,
    volume: 0,
    paused: true,
  });
});
