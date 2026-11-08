import { pathToFileURL } from 'node:url';

type Preventable = { preventDefault(): void };
type RequestHandler = (
  details: { url: string },
  done: (response: { cancel: boolean }) => void,
) => void;
type NoticesSession = {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: RequestHandler | null,
    ): void;
  };
  setPermissionRequestHandler(
    listener: (
      contents: unknown,
      permission: string,
      done: (allowed: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(listener: () => boolean): void;
  on(event: 'will-download', listener: (event: Preventable) => void): unknown;
  removeListener(
    event: 'will-download',
    listener: (event: Preventable) => void,
  ): unknown;
};
type NoticesWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  destroy(): void;
  loadFile(file: string): Promise<void>;
  once(event: 'ready-to-show', listener: () => void): unknown;
  on(event: 'closed', listener: () => void): unknown;
  webContents: {
    session: NoticesSession;
    setWindowOpenHandler(listener: () => { action: 'deny' }): void;
    on(event: string, listener: (event: Preventable) => void): unknown;
  };
};

// No Electron import or allocation at module initialization. The injected factory
// also lets lifecycle checks run without starting an Electron/native process.
export function createMcpNoticesController(
  createWindow: () => NoticesWindow,
  documentPath: string,
) {
  let current: NoticesWindow | undefined;
  let loading: Promise<void> | undefined;
  const documentUrl = pathToFileURL(documentPath).href;
  const reveal = (win: NoticesWindow) => {
    if (current !== win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  return {
    async open() {
      if (current && !current.isDestroyed()) {
        if (loading) await loading;
        if (current) reveal(current);
        return;
      }
      const win = createWindow();
      current = win;
      const session = win.webContents.session;
      const deny = (event: Preventable) => event.preventDefault();
      session.webRequest.onBeforeRequest(
        { urls: ['<all_urls>'] },
        (details, done) => done({ cancel: details.url !== documentUrl }),
      );
      session.setPermissionRequestHandler((_contents, _permission, done) =>
        done(false),
      );
      session.setPermissionCheckHandler(() => false);
      session.on('will-download', deny);
      for (const event of [
        'will-navigate',
        'will-frame-navigate',
        'will-redirect',
        'will-attach-webview',
      ])
        win.webContents.on(event, deny);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.once('ready-to-show', () => reveal(win));
      win.on('closed', () => {
        session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, null);
        session.removeListener('will-download', deny);
        if (current === win) {
          current = undefined;
          loading = undefined;
        }
      });
      const pending = win.loadFile(documentPath);
      loading = pending;
      try {
        await pending;
      } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
      } finally {
        if (loading === pending) loading = undefined;
      }
    },
  };
}
