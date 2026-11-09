import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const read = async (name: string) =>
  stripTypeScriptTypes(
    await readFile(path.join(root, 'src/providers', `${name}.ts`), 'utf8'),
  )
    .replace(/import[\s\S]*?from '[^']+';/g, '')
    .replace(/export /g, '');

for (const cancellation of [true, false]) {
  test(`actual controller/preload/renderer ${cancellation ? 'main cancellation forbids late commands' : 'successful release stays non-cancelled'}`, async () => {
    const commands: string[] = [];
    let advertising = !cancellation;
    let commandsWhileAdvertising: string[] = [];
    const video = {
      muted: false,
      paused: true,
      readyState: 0,
      duration: 30,
      currentTime: 0,
      seekable: { length: 0 },
      pause() {
        commands.push('pause');
        this.paused = true;
      },
      async play() {
        commands.push('play');
        this.paused = false;
      },
    };
    const player = {
      classList: {
        contains: (name: string) => advertising && name === 'ad-showing',
      },
      querySelector: () => video,
      getVideoData: () => ({ video_id: 'fixture' }),
      playVideo() {
        commands.push('warm');
      },
      seekTo(seconds: number) {
        commands.push('seek');
        video.currentTime = seconds;
      },
    };
    const ipc = new EventEmitter() as EventEmitter & {
      sendSync: () => unknown;
      send: () => void;
    };
    ipc.sendSync = () => ({ token: 'fixture-token', muted: false });
    ipc.send = () => {};
    const window: Record<string, any> = {};
    const context = {
      window,
      document: {
        querySelector: (selector: string) =>
          selector === '#movie_player'
            ? player
            : selector === 'video'
              ? video
              : null,
        querySelectorAll: () => [video],
        addEventListener() {},
        removeEventListener() {},
      },
      location: { href: 'https://music.youtube.com/watch?v=fixture' },
      performance: { timeOrigin: 1 },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      ipcRenderer: ipc,
      contextBridge: {
        exposeInMainWorld: (key: string, value: unknown) => {
          window[key] = value;
        },
      },
      setTimeout,
      clearTimeout,
      TextEncoder,
      console,
    };
    vm.createContext(context);
    vm.runInContext(await read('blocker-scene-preload'), context);
    vm.runInContext(
      (await read('blocker-scene-renderer')) +
        ';globalThis.renderer=blockerSceneRenderer;',
      context,
    );
    vm.runInContext(
      (await read('blocker-scene-controller')) +
        ';globalThis.factory=createBlockerSceneController;',
      context,
    );
    const runtime = context as typeof context & {
      factory: Function;
      renderer: Function;
    };
    const scene = {
      documentId: 'old',
      version: 7,
      url: context.location.href,
      videoId: 'fixture',
      seconds: 18,
      paused: false,
      muted: false,
      queue: null,
    };
    const controller = runtime.factory({
      capture: async () => ({ kind: 'active', scene }),
      verify: async () => true,
      valid: () => true,
      reload: async () => {
        vm.runInContext('installBlockerSceneGuard()', context);
      },
      restore: () => runtime.renderer('restore', scene),
      release: (_generation: number, reason: string) => {
        ipc.emit(
          'peard:blocker-scene-release',
          {},
          'fixture-token',
          false,
          reason,
        );
      },
    });
    const task = controller.apply(true);
    let cancelBoundary = -1;
    const cancelTimer = cancellation
      ? setTimeout(() => {
          controller.cancel();
          cancelBoundary = commands.length;
        }, 40)
      : undefined;
    const readyTimer = setTimeout(() => {
      video.readyState = 2;
      video.seekable.length = 1;
    }, 100);
    const adTimer = setTimeout(() => {
      commandsWhileAdvertising = [...commands];
      advertising = false;
    }, 180);
    try {
      const result = await task;
      expect(result.kind).toBe(cancellation ? 'cancelled' : 'verified');
      expect(window.blockerSceneGuard.pending()).toBe(false);
      expect(window.blockerSceneGuard.cancelled()).toBe(cancellation);
      if (cancellation) expect(commands.slice(cancelBoundary)).toEqual([]);
      else {
        expect(commandsWhileAdvertising).not.toContain('seek');
        expect(commandsWhileAdvertising).not.toContain('play');
        expect(commands).toContain('seek');
        expect(video.currentTime).toBe(18);
        expect(video.paused).toBe(false);
      }
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      clearTimeout(readyTimer);
      clearTimeout(adTimer);
    }
  });
}

test('overlapping explicit apply requests share one reload and one native mute lifetime', async () => {
  const { createBlockerSceneController } =
    await import('../src/providers/blocker-scene-controller');
  const scene = {
    documentId: '1:fixture',
    version: 0,
    url: 'https://example.test',
    videoId: 'fixture',
    seconds: 18,
    paused: true,
    muted: false,
    queue: null,
  };
  let reloads = 0;
  let muted = false;
  let original: boolean | undefined;
  let releaseReload: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const controller = createBlockerSceneController({
    capture: async () => ({ kind: 'active', scene }),
    verify: async () => true,
    valid: () => true,
    reload: async () => {
      reloads++;
      original = muted;
      muted = true;
      await ready;
    },
    restore: async () => ({ kind: 'verified' }),
    release: () => {
      if (original !== undefined) {
        muted = original;
        original = undefined;
      }
    },
  });
  const first = controller.apply(true);
  await expect.poll(() => reloads).toBe(1);
  const second = controller.apply(true);
  releaseReload!();
  expect((await first).kind).toBe('verified');
  expect((await second).kind).toBe('verified');
  expect(reloads).toBe(1);
  expect(muted).toBe(false);
});

test('user cancellation also invalidates a queued automatic document apply', async () => {
  const { createBlockerSceneController } =
    await import('../src/providers/blocker-scene-controller');
  let reloads = 0;
  let finishReload!: () => void;
  const ready = new Promise<void>((resolve) => {
    finishReload = resolve;
  });
  const controller = createBlockerSceneController({
    capture: async () => ({
      kind: 'idle',
      documentId: 'old',
      version: 0,
      url: 'https://example.test',
    }),
    verify: async () => true,
    valid: () => true,
    reload: async () => {
      reloads++;
      await ready;
    },
    restore: async () => ({ kind: 'verified' }),
    release: () => {},
  });
  const first = controller.apply(false);
  await expect.poll(() => reloads).toBe(1);
  const queued = controller.apply(false);
  controller.cancel();
  finishReload();
  expect((await first).kind).toBe('cancelled');
  expect((await queued).kind).toBe('cancelled');
  expect(reloads).toBe(1);
});

test('ordinary-document IPC controls invalidate capture even after a mute round trip', async () => {
  const video = {
    muted: false,
    paused: true,
    readyState: 4,
    duration: 30,
    currentTime: 18,
    seekable: { length: 1 },
  };
  const player = {
    querySelector: () => video,
    getVideoData: () => ({ video_id: 'fixture' }),
    classList: { contains: () => false },
  };
  const window: Record<string, any> = {};
  const context = {
    window,
    document: {
      querySelector: (selector: string) =>
        selector === '#movie_player'
          ? player
          : selector === 'video'
            ? video
            : null,
      querySelectorAll: () => [video],
      addEventListener() {},
      removeEventListener() {},
    },
    location: { href: 'https://music.youtube.com/watch?v=fixture' },
    performance: { timeOrigin: 1 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ipcRenderer: { sendSync: () => null, send() {} },
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        window[key] = value;
      },
    },
    setTimeout,
    clearTimeout,
    TextEncoder,
  };
  vm.createContext(context);
  vm.runInContext(await read('blocker-scene-preload'), context);
  vm.runInContext('installBlockerSceneGuard()', context);
  vm.runInContext(
    (await read('blocker-scene-renderer')) +
      ';globalThis.renderer=blockerSceneRenderer;',
    context,
  );
  const runtime = context as typeof context & { renderer: Function };
  const captured = await runtime.renderer('capture');
  expect(captured.kind).toBe('active');
  expect(await runtime.renderer('verify', captured.scene)).toBe(true);
  window.blockerSceneGuard.cancelFromUser();
  video.muted = true;
  window.blockerSceneGuard.cancelFromUser();
  video.muted = false;
  expect(window.blockerSceneGuard.pending()).toBe(false);
  expect(await runtime.renderer('verify', captured.scene)).toBe(false);
  const fresh = await runtime.renderer('capture');
  expect(await runtime.renderer('verify', fresh.scene)).toBe(true);
  video.muted = true;
  expect(await runtime.renderer('verify', fresh.scene)).toBe(false);
});

test('missing new-frame claim retains mute until navigation, and retry restores the original ledger', async () => {
  const ipcMain = new EventEmitter();
  let adapter!: { apply: Function; cancel: Function };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    randomUUID: () => Math.random().toString(),
    ipcMain,
    installBlockerDocumentSceneAdapter: (apply: Function, cancel: Function) => {
      adapter = { apply, cancel };
    },
    blockerSceneRenderer: () => {},
  };
  vm.createContext(context);
  vm.runInContext(await read('blocker-scene-controller'), context);
  vm.runInContext(
    (await read('blocker-scene-main')) +
      ';globalThis.bridge={installBlockerSceneBridge,applyPendingBlockerDocument,getBlockerDocumentStatus};',
    context,
  );
  const runtime = context as typeof context & {
    bridge: Record<string, Function>;
  };
  const url = 'https://music.youtube.com/watch?v=fixture';
  const scene = {
    documentId: '1:old',
    version: 0,
    url,
    videoId: 'fixture',
    seconds: 18,
    paused: true,
    muted: false,
    queue: null,
  };
  class Contents extends EventEmitter {
    id = 44;
    mainFrame = { url, processId: 10, routingId: 20 };
    currentUrl = url;
    muted = false;
    claimNext = false;
    restoreCalls = 0;
    loads = 0;
    sent: unknown[][] = [];
    isDestroyed() {
      return false;
    }
    getURL() {
      return this.currentUrl;
    }
    isAudioMuted() {
      return this.muted;
    }
    setAudioMuted(value: boolean) {
      this.muted = value;
    }
    send(...args: unknown[]) {
      this.sent.push(args);
    }
    async executeJavaScript(code: string) {
      if (code.includes('"capture"')) return { kind: 'active', scene };
      if (code.includes('"verify"')) return true;
      if (code.includes('"restore"')) {
        this.restoreCalls++;
        return { kind: 'verified' };
      }
      throw new Error('Unscoped document command');
    }
    reload() {
      this.loads++;
      this.emit('did-start-navigation', {}, url, false, true);
      this.mainFrame = { url, processId: 10, routingId: 20 + this.loads };
      this.emit(
        'did-frame-navigate',
        {},
        url,
        200,
        'OK',
        true,
        this.mainFrame.processId,
        this.mainFrame.routingId,
      );
      if (this.claimNext) {
        const event = {
          sender: this,
          senderFrame: this.mainFrame,
          returnValue: null,
        };
        ipcMain.emit('peard:blocker-scene-claim', event, url, 2 + this.loads);
        expect(event.returnValue).not.toBeNull();
      }
      setTimeout(() => this.emit('did-finish-load'), 0);
    }
  }
  runtime.bridge.installBlockerSceneBridge();
  const contents = new Contents();
  adapter.apply(contents, () => true);
  await expect
    .poll(() => runtime.bridge.getBlockerDocumentStatus(contents).kind)
    .toBe('failed');
  expect(contents.muted).toBe(true);
  expect(contents.restoreCalls).toBe(0);
  contents.emit('did-start-navigation', {}, `${url}&user=1`, false, true);
  expect(contents.muted).toBe(false);
  adapter.apply(contents, () => true);
  await expect
    .poll(() => runtime.bridge.getBlockerDocumentStatus(contents).kind)
    .toBe('failed');
  expect(contents.muted).toBe(true);
  contents.claimNext = true;
  const result = await runtime.bridge.applyPendingBlockerDocument(contents);
  expect(result.kind).toBe('verified');
  expect(contents.muted).toBe(false);
  expect(contents.restoreCalls).toBe(1);
  expect(contents.sent.map((packet) => packet[3])).toEqual([
    'cancelled',
    'complete',
  ]);
});

test('actual idle adapter revalidates media, user revision, URL and document before a null reload', async () => {
  for (const change of ['stable', 'user', 'active', 'url', 'document']) {
    let hasMedia = false;
    const video = {
      muted: false,
      paused: false,
      currentTime: 1,
      duration: 30,
      readyState: 4,
      seekable: { length: 1 },
    };
    const player = {
      querySelector: () => video,
      getVideoData: () => ({ video_id: 'fixture' }),
      classList: { contains: () => false },
    };
    const window: Record<PropertyKey, any> = {};
    const context = {
      window,
      document: {
        querySelector: (selector: string) =>
          !hasMedia
            ? null
            : selector === '#movie_player'
              ? player
              : selector === 'video'
                ? video
                : null,
        querySelectorAll: () => (hasMedia ? [video] : []),
        addEventListener() {},
        removeEventListener() {},
      },
      location: { href: 'https://music.youtube.com/' },
      performance: { timeOrigin: 1 },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      ipcRenderer: { sendSync: () => null, send() {} },
      contextBridge: {
        exposeInMainWorld: (key: string, value: unknown) => {
          window[key] = value;
        },
      },
      setTimeout,
      clearTimeout,
      TextEncoder,
      URL,
    };
    vm.createContext(context);
    vm.runInContext(await read('blocker-scene-preload'), context);
    vm.runInContext('installBlockerSceneGuard()', context);
    vm.runInContext(
      (await read('blocker-scene-renderer')) +
        ';globalThis.renderer=blockerSceneRenderer;',
      context,
    );
    const runtime = context as typeof context & { renderer: Function };
    const idle = await runtime.renderer('capture');
    expect(idle.kind).toBe('idle');
    expect(idle.version).toBe(0);
    let deliver!: (value: typeof idle) => void;
    let captures = 0;
    let reloads = 0;
    const { createBlockerSceneController } =
      await import('../src/providers/blocker-scene-controller');
    const controller = createBlockerSceneController({
      capture: () =>
        ++captures === 1
          ? new Promise((resolve) => {
              deliver = resolve;
            })
          : runtime.renderer('capture'),
      verify: async () => {
        throw new Error('Idle uses a second actual capture');
      },
      valid: () => true,
      reload: async (scene) => {
        expect(scene).toBeNull();
        reloads++;
      },
      restore: async () => {
        throw new Error('Idle must not restore media');
      },
      release: () => {},
    });
    const pending = controller.apply(false);
    if (change === 'user' || change === 'active')
      window.blockerSceneGuard.cancelFromUser();
    if (change === 'active') hasMedia = true;
    if (change === 'url')
      context.location.href = 'https://music.youtube.com/browse/fixture';
    if (change === 'document') {
      delete window[Symbol.for('pear.blocker.playback-scene')];
      context.performance.timeOrigin = 2;
    }
    deliver(idle);
    expect((await pending).kind).toBe(
      change === 'stable' ? 'verified' : 'cancelled',
    );
    expect(reloads).toBe(change === 'stable' ? 1 : 0);
    context.location.href = 'https://music.youtube.com/watch?v=loading';
    hasMedia = false;
    expect((await runtime.renderer('capture')).kind).toBe('unavailable');
  }
});
