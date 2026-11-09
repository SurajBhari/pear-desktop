import { expect, test } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createMcpNoticesController } from '../src/providers/mcp-notices-window';

class FakeWindow extends EventEmitter {
  destroyed = false;
  minimized = false;
  showCount = 0;
  focusCount = 0;
  restored = 0;
  loadCount = 0;
  failLoad = false;
  request:
    | ((
        details: { url: string },
        done: (value: { cancel: boolean }) => void,
      ) => void)
    | null = null;
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: (handler: () => { action: string }) => {
      this.popup = handler;
    },
    session: Object.assign(new EventEmitter(), {
      webRequest: {
        onBeforeRequest: (_filter: unknown, handler: typeof this.request) => {
          this.request = handler;
        },
      },
      setPermissionRequestHandler: (handler: unknown) => {
        this.permission = handler;
      },
      setPermissionCheckHandler: (handler: () => boolean) => {
        this.permissionCheck = handler;
      },
    }),
  });
  popup?: () => { action: string };
  permission?: unknown;
  permissionCheck?: () => boolean;
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  show() {
    this.showCount++;
  }
  focus() {
    this.focusCount++;
  }
  restore() {
    this.restored++;
    this.minimized = false;
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  async loadFile(_file: string) {
    this.loadCount++;
    if (this.failLoad) throw Error('failed document');
    this.emit('ready-to-show');
  }
}

test('document window stays lazy, reuses current instance and reopens after close', async () => {
  const windows: FakeWindow[] = [];
  const controller = createMcpNoticesController(() => {
    const win = new FakeWindow();
    windows.push(win);
    return win;
  }, '/app/dist/main/assets/mcp-dependency-notices.html');
  expect(windows).toHaveLength(0);
  await controller.open();
  await controller.open();
  expect(windows).toHaveLength(1);
  expect(windows[0].loadCount).toBe(1);
  windows[0].minimized = true;
  await controller.open();
  expect(windows[0].restored).toBe(1);
  windows[0].destroy();
  expect(windows[0].request).toBeNull();
  await controller.open();
  expect(windows).toHaveLength(2);
});

test('offline window denies navigation, popups, downloads, permissions and other requests', async () => {
  const win = new FakeWindow();
  const file = '/app/dist/main/assets/mcp-dependency-notices.html';
  const controller = createMcpNoticesController(() => win, file);
  await controller.open();
  for (const event of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview',
  ]) {
    let denied = false;
    win.webContents.emit(event, {
      preventDefault() {
        denied = true;
      },
    });
    expect(denied).toBe(true);
  }
  expect(win.popup?.()).toEqual({ action: 'deny' });
  expect(win.permissionCheck?.()).toBe(false);
  for (const url of [
    'https://example.invalid/',
    'file:///etc/passwd',
    'data:text/html,hello',
    pathToFileURL(file).href,
  ]) {
    let cancel: boolean | undefined;
    win.request?.({ url }, (result) => {
      cancel = result.cancel;
    });
    expect(cancel).toBe(url !== pathToFileURL(file).href);
  }
  let downloadDenied = false;
  win.webContents.session.emit('will-download', {
    preventDefault() {
      downloadDenied = true;
    },
  });
  expect(downloadDenied).toBe(true);
});

test('failed loads dispose the window, release references and allow retry', async () => {
  const windows: FakeWindow[] = [];
  const controller = createMcpNoticesController(() => {
    const win = new FakeWindow();
    win.failLoad = windows.length === 0;
    windows.push(win);
    return win;
  }, '/app/notices.html');
  await expect(controller.open()).rejects.toThrow('failed document');
  expect(windows[0].destroyed).toBe(true);
  await controller.open();
  expect(windows).toHaveLength(2);
});

test('closing during pending load never shows or retains the old window', async () => {
  const win = new FakeWindow();
  let resolveLoad!: () => void;
  win.loadFile = () =>
    new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
  const controller = createMcpNoticesController(() => win, '/app/notices.html');
  const pending = controller.open();
  win.destroy();
  resolveLoad();
  await pending;
  win.emit('ready-to-show');
  expect(win.showCount).toBe(0);
});
