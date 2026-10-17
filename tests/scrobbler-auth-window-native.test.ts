import { test, expect } from '@playwright/test';
import { scrobblerAuthNative as createFixture } from './helpers/scrobbler-auth-native';

const fixtures = new Set<Awaited<ReturnType<typeof createFixture>>>();
async function scrobblerAuthNative() {
  const fixture = await createFixture();
  fixtures.add(fixture);
  return fixture;
}
test.afterEach(async () => {
  for (const fixture of fixtures) {
    console.log(await fixture.trace());
    await fixture.close();
    fixtures.delete(fixture);
  }
});

test('native auth windows use distinct ephemeral sessions and secure child flags, then clear only owned state', async ({}, testInfo) => {
  const fixture = await scrobblerAuthNative();
  let hasBodyFailure = false;
  let bodyFailure: unknown;
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture;
      f.trace('task entered');
      for (const [session, name] of [
        [f.defaultSession, 'default'],
        [f.parentSession, 'parent'],
      ]) {
        f.trace('cookie ' + name);
        await session.cookies.set({
          url: 'https://www.last.fm',
          name,
          value: 'owned-sentinel',
        });
        f.trace('cookie done ' + name);
      }
      f.trace('starting');
      const before = f.main.listenerCount('closed');
      const scope = new AbortController();
      const surface = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/?api_key=fixture&token=owned',
        scope.signal,
      );
      try {
        await Promise.race([
          surface.ready,
          new Promise((_, no) =>
            setTimeout(() => no(Error('fixture readiness budget')), 3000),
          ),
        ]);
      } catch {
        return { available: false, stage: 'first-ready' };
      }
      const auth = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === f.main,
      )!;
      if (!auth) return { available: false };
      f.trace('first ready');
      const session = auth.webContents.session;
      const preferences = auth.webContents.getLastWebPreferences();
      f.trace('preferences');
      const renderer = await auth.webContents.executeJavaScript(
        '({require:typeof require,process:typeof process})',
      );
      f.trace('renderer');
      await session.cookies.set({
        url: 'https://www.last.fm',
        name: 'auth',
        value: 'owned-token',
      });
      await auth.webContents.executeJavaScript(
        "localStorage.setItem('owned','token');sessionStorage.setItem('owned','token')",
      );
      f.trace('storage');
      await auth.webContents.executeJavaScript(
        "window.open('https://sso.fixture.invalid/login','sso','nodeIntegration=yes,contextIsolation=no');void 0",
        true,
      );
      f.trace('popup requested');
      let child: Electron.BrowserWindow | undefined;
      for (let i = 0; i < 100 && !child; i++) {
        child = BrowserWindow.getAllWindows().find(
          (win) => win.getParentWindow() === auth,
        );
        if (!child) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const childPreferences = child?.webContents.getLastWebPreferences();
      const childSameSession = child?.webContents.session === session;
      f.trace('closing first');
      surface.close();
      f.trace('first closed called');
      await surface.closed;
      f.trace('first closed settled');
      await Promise.all(f.clears.map((item: any) => item.promise));
      for (let i = 0; i < 100 && (await session.cookies.get({})).length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const probe = new BrowserWindow({
        show: false,
        webPreferences: {
          session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await probe.loadURL('https://www.last.fm/fixture-probe');
      const storageEmpty = await probe.webContents.executeJavaScript(
        "localStorage.getItem('owned')===null",
      );
      probe.destroy();
      const ownedClearOnly = f.clears.every(
        (item: any) => item.session === session,
      );
      const authGone = auth.isDestroyed(),
        childGone = child?.isDestroyed(),
        parentAlive = !f.main.isDestroyed();
      const defaultCookies = (await f.defaultSession.cookies.get({})).map(
        (cookie: any) => cookie.name,
      );
      const parentCookies = (await f.parentSession.cookies.get({})).map(
        (cookie: any) => cookie.name,
      );
      const ownedCookieCount = (await session.cookies.get({})).length;
      f.trace('second opening');
      const surface2 = f.openScrobblingAuthWindow(
        f.main,
        'https://libre.fm/api/auth/?api_key=fixture&token=owned',
        new AbortController().signal,
      );
      await Promise.race([
        surface2.ready,
        new Promise((_, no) =>
          setTimeout(() => no(Error('fixture second readiness budget')), 3000),
        ),
      ]);
      f.trace('second ready');
      const auth2 = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === f.main,
      )!;
      const distinct = auth2.webContents.session !== session;
      surface2.close();
      await surface2.closed;
      return {
        available: true,
        sandbox: preferences.sandbox,
        isolation: preferences.contextIsolation,
        node: preferences.nodeIntegration,
        preload: preferences.preload ?? '',
        renderer,
        childSandbox: childPreferences?.sandbox,
        childIsolation: childPreferences?.contextIsolation,
        childNode: childPreferences?.nodeIntegration,
        childPreload: childPreferences?.preload ?? '',
        childSameSession,
        separate: session !== f.defaultSession && session !== f.parentSession,
        memory: session.getStoragePath() === null,
        distinct,
        authGone,
        childGone,
        parentAlive,
        defaultCookies,
        parentCookies,
        ownedCookieCount,
        storageEmpty,
        ownedClearOnly,
        parentHooks: f.main.listenerCount('closed') === before,
      };
    });
    expect(result).toMatchObject({
      available: true,
      sandbox: true,
      isolation: true,
      node: false,
      preload: '',
      renderer: { require: 'undefined', process: 'undefined' },
      childSandbox: true,
      childIsolation: true,
      childNode: false,
      childPreload: '',
      childSameSession: true,
      separate: true,
      memory: true,
      distinct: true,
      authGone: true,
      childGone: true,
      parentAlive: true,
      defaultCookies: ['default'],
      parentCookies: ['parent'],
      ownedCookieCount: 0,
      storageEmpty: true,
      ownedClearOnly: true,
      parentHooks: true,
    });
  } catch (error) {
    hasBodyFailure = true;
    bodyFailure = error;
    throw error;
  } finally {
    let hasCleanupFailure = false;
    let cleanupFailure: unknown;
    try {
      console.log(await fixture.trace());
      await fixture.close();
    } catch (error) {
      hasCleanupFailure = true;
      cleanupFailure = error;
    }
    try {
      const packet = {
        schema: 1,
        body: hasBodyFailure ? 'failed' : 'passed',
        cleanup: hasCleanupFailure ? 'failed' : 'passed',
        fixture: fixture.diagnostics(),
      };
      const body = Buffer.from(JSON.stringify(packet));
      if (body.length <= 4096) {
        console.log(body.toString());
        await testInfo.attach('scrobbler-native-diagnostics', {
          body,
          contentType: 'application/json',
        });
      }
    } catch {
      // Diagnostic emission must not replace the body or cleanup outcome.
    }
    if (hasCleanupFailure) {
      if (!hasBodyFailure) throw cleanupFailure;
      const error = new AggregateError(
        [bodyFailure, cleanupFailure],
        'Native auth test body and cleanup failed',
      );
      Object.defineProperty(error, 'diagnosticErrors', {
        value: Object.freeze([
          Object.freeze({ phase: 'body', error: bodyFailure }),
          Object.freeze({ phase: 'cleanup', error: cleanupFailure }),
        ]),
      });
      throw error;
    }
  }
});

for (const retire of ['abort', 'close', 'parent', 'failure'])
  test(`native auth ${retire} settles before late ready and never shows a retired window`, async () => {
    const fixture = await scrobblerAuthNative();
    try {
      const result = await fixture.evaluate(
        async ({ BrowserWindow }, retire) => {
          const f = (globalThis as any).AuthWindowFixture;
          f.pages.mode = retire === 'failure' ? 'failure' : 'hold';
          const scope = new AbortController();
          const surface = f.openScrobblingAuthWindow(
            f.main,
            'https://www.last.fm/api/auth/?api_key=fixture&token=owned',
            scope.signal,
          );
          let ready = 'pending';
          surface.ready.then(
            () => (ready = 'fulfilled'),
            () => (ready = 'rejected'),
          );
          const auth = BrowserWindow.getAllWindows().find(
            (win) => win.getParentWindow() === f.main,
          );
          if (!auth) return { available: false };
          const id = auth.id,
            retained = f.readyHandlers.get(id);
          if (retire === 'abort') scope.abort();
          else if (retire === 'close') surface.close();
          else if (retire === 'parent') f.main.destroy();
          await surface.closed;
          const before = f.shows.get(id) || 0;
          for (const release of f.pages.pending) release();
          retained?.();
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            available: true,
            ready,
            gone: auth.isDestroyed(),
            showBefore: before,
            showAfter: f.shows.get(id) || 0,
          };
        },
        retire,
      );
      expect(result).toEqual({
        available: true,
        ready: 'rejected',
        gone: true,
        showBefore: 0,
        showAfter: 0,
      });
    } finally {
      console.log(await fixture.trace());
      await fixture.close();
    }
  });

for (const during of ['constructor', 'show'])
  test(`reentrant ${during} retirement cannot show or fulfill a late native surface`, async () => {
    const fixture = await scrobblerAuthNative();
    try {
      const result = await fixture.evaluate(
        async ({ BrowserWindow, app }, during) => {
          const f = (globalThis as any).AuthWindowFixture,
            scope = new AbortController();
          const before = new Set(BrowserWindow.getAllWindows());
          if (during === 'constructor') f.abortOnCreate = scope;
          const showAbort = (_event: unknown, win: Electron.BrowserWindow) => {
            if (win !== f.main) {
              const show = win.show.bind(win);
              win.show = () => {
                show();
                scope.abort();
              };
            }
          };
          if (during === 'show') app.on('browser-window-created', showAbort);
          const surface = f.openScrobblingAuthWindow(
            f.main,
            'https://www.last.fm/api/auth/?token=owned',
            scope.signal,
          );
          let ready = 'pending';
          surface.ready.then(
            () => (ready = 'fulfilled'),
            () => (ready = 'rejected'),
          );
          await surface.closed;
          await new Promise((resolve) => setTimeout(resolve, 20));
          f.abortOnCreate = null;
          app.removeListener('browser-window-created', showAbort);
          return {
            ready,
            parentAlive: !f.main.isDestroyed(),
            extra: BrowserWindow.getAllWindows().filter(
              (win) => !before.has(win),
            ).length,
          };
        },
        during,
      );
      expect(result).toEqual({
        ready: 'rejected',
        parentAlive: true,
        extra: 0,
      });
    } finally {
      await fixture.close();
    }
  });

test('retained popup callbacks deny retired windows and unsafe URI schemes while HTTPS child close preserves login', async () => {
  const fixture = await scrobblerAuthNative();
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture,
        scope = new AbortController();
      const surface = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/?token=owned',
        scope.signal,
      );
      await surface.ready;
      const auth = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === f.main,
      )!;
      const handler = f.handlers.get(auth.webContents.id);
      const denied = [
        'http://fixture.invalid/',
        'file:///owned-fixture-only',
        'javascript:void(0)',
        'data:text/plain,owned',
        'custom-fixture://owned',
        'https://user:pass@fixture.invalid/',
      ].map((url) => handler({ url }).action);
      await auth.webContents.executeJavaScript(
        "window.open('https://sso.fixture.invalid/close','owned');void 0",
        true,
      );
      const child = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === auth,
      )!;
      child.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const primaryAlive = !auth.isDestroyed(),
        childGone = child.isDestroyed();
      await auth.webContents.executeJavaScript(
        "location.href='http://fixture.invalid/blocked';void 0",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const keptHttps =
        new URL(auth.webContents.getURL()).protocol === 'https:';
      surface.close();
      await surface.closed;
      const retiredAction = handler({
        url: 'https://sso.fixture.invalid/late',
      }).action;
      return {
        denied,
        primaryAlive,
        childGone,
        keptHttps,
        retiredAction,
        parentAlive: !f.main.isDestroyed(),
      };
    });
    expect(result).toEqual({
      denied: Array(6).fill('deny'),
      primaryAlive: true,
      childGone: true,
      keptHttps: true,
      retiredAction: 'deny',
      parentAlive: true,
    });
  } finally {
    await fixture.close();
  }
});

test('independent native surfaces and parent replacement keep delayed cleanup confined to its original session', async () => {
  const fixture = await scrobblerAuthNative();
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture;
      const first = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/?token=first',
        new AbortController().signal,
      );
      await first.ready;
      const auth1 = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === f.main,
      )!;
      const session1 = auth1.webContents.session;
      await session1.cookies.set({
        url: 'https://www.last.fm',
        name: 'old',
        value: 'owned',
      });
      let release!: () => void;
      const gate = new Promise<void>((yes) => (release = yes));
      const clear = session1.clearStorageData.bind(session1);
      session1.clearStorageData = async (options) => {
        await gate;
        await clear(options);
      };
      first.close();
      await first.closed;
      const oldParent = f.main;
      f.main = f.createParent();
      const second = f.openScrobblingAuthWindow(
        f.main,
        'https://libre.fm/api/auth/?token=second',
        new AbortController().signal,
      );
      await second.ready;
      const auth2 = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === f.main,
      )!;
      const session2 = auth2.webContents.session;
      await session2.cookies.set({
        url: 'https://libre.fm',
        name: 'new',
        value: 'owned',
      });
      oldParent.destroy();
      release();
      await Promise.all(f.clears.map((item: any) => item.promise));
      const independent = !auth2.isDestroyed() && !f.main.isDestroyed();
      const oldEmpty = (await session1.cookies.get({})).length === 0,
        newRetained = (await session2.cookies.get({})).some(
          (cookie) => cookie.name === 'new',
        );
      second.close();
      await second.closed;
      return {
        independent,
        oldEmpty,
        newRetained,
        distinct: session1 !== session2,
        primaryGone: auth1.isDestroyed(),
      };
    });
    expect(result).toEqual({
      independent: true,
      oldEmpty: true,
      newRetained: true,
      distinct: true,
      primaryGone: true,
    });
  } finally {
    await fixture.close();
  }
});

test('invalid input and an already aborted scope allocate no auth window or session', async () => {
  const fixture = await scrobblerAuthNative();
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture,
        before = BrowserWindow.getAllWindows().length;
      const inputs = [
        'http://fixture.invalid',
        'file:///owned-fixture-only',
        'data:text/plain,owned',
        'https://user:pass@fixture.invalid',
        'https://fixture.invalid:444/',
      ];
      const outcomes: string[] = [];
      for (const url of inputs) {
        const surface = f.openScrobblingAuthWindow(
          f.main,
          url,
          new AbortController().signal,
        );
        try {
          await surface.ready;
          outcomes.push('fulfilled');
        } catch {
          outcomes.push('rejected');
        }
        await surface.closed;
      }
      const scope = new AbortController();
      scope.abort();
      const retired = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/',
        scope.signal,
      );
      try {
        await retired.ready;
        outcomes.push('fulfilled');
      } catch {
        outcomes.push('rejected');
      }
      await retired.closed;
      return {
        outcomes,
        extra: BrowserWindow.getAllWindows().length - before,
        cleanupCalls: f.clears.length,
      };
    });
    expect(result).toEqual({
      outcomes: Array(6).fill('rejected'),
      extra: 0,
      cleanupCalls: 0,
    });
  } finally {
    await fixture.close();
  }
});

test('native page success markers never authorize a session; only the frozen API poll can persist', async () => {
  const fixture = await scrobblerAuthNative();
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture;
      let authorized = false,
        polls = 0;
      const persisted: string[] = [];
      const fetcher = async (url: string) => {
        const method = new URL(url).searchParams.get('method');
        if (method === 'auth.getToken')
          return new Response(JSON.stringify({ token: 'owned-token' }));
        polls++;
        return new Response(
          JSON.stringify(
            authorized ? { session: { key: 'owned-session' } } : { error: 14 },
          ),
        );
      };
      const controller = new f.WsAuthController(
        fetcher,
        (url: string, signal: AbortSignal) =>
          f.openScrobblingAuthWindow(f.main, url, signal),
        { pollMs: 10, deadlineMs: 2000 },
      );
      const login = controller.login(
        {
          apiRoot: 'https://ws.audioscrobbler.com/2.0/',
          authRoot: 'https://www.last.fm/api/auth/',
          apiKey: 'public-fixture',
          secret: 'owned-fixture',
        },
        (key: string) => persisted.push(key),
        () => true,
      );
      let auth: Electron.BrowserWindow | undefined;
      for (let i = 0; i < 100 && !auth; i++) {
        auth = BrowserWindow.getAllWindows().find(
          (win) => win.getParentWindow() === f.main,
        );
        if (!auth) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!auth) {
        controller.stop();
        await login;
        return { available: false };
      }
      for (let i = 0; i < 100 && polls < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await auth.webContents.executeJavaScript(
        "document.body.textContent='AUTHENTICATED';history.pushState({},'', '/approved?session=fake');void 0",
      );
      const premature = persisted.length;
      authorized = true;
      const succeeded = await login;
      await Promise.all(f.clears.map((item: any) => item.promise));
      return {
        available: true,
        premature,
        succeeded,
        persisted,
        gone: auth.isDestroyed(),
        pollsAtLeastTwo: polls >= 2,
      };
    });
    expect(result).toEqual({
      available: true,
      premature: 0,
      succeeded: true,
      persisted: ['owned-session'],
      gone: true,
      pollsAtLeastTwo: true,
    });
  } finally {
    await fixture.close();
  }
});

test('native link popups cannot inherit desktop privileges, owned session denies permission callbacks and cancels downloads', async () => {
  const fixture = await scrobblerAuthNative();
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture;
      const surface = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/?token=owned',
        new AbortController().signal,
      );
      await surface.ready;
      const auth = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === f.main,
      )!;
      const ownedSession = auth.webContents.session;
      const answer = f.handlers.get(auth.webContents.id)({
        url: 'https://sso.fixture.invalid/link',
        referrer: { url: 'https://www.last.fm', policy: 'default' },
      });
      const contents = answer.createWindow({
        show: true,
        alwaysOnTop: true,
        kiosk: true,
        fullscreen: true,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          preload: '/owned-unused-fixture',
        },
      });
      const child = BrowserWindow.fromWebContents(contents)!;
      for (let i = 0; i < 100 && contents.isLoading(); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const preferences = contents.getLastWebPreferences();
      const desktop = {
        top: child.isAlwaysOnTop(),
        kiosk: child.isKiosk(),
        fullscreen: child.isFullScreen(),
      };
      let permission: boolean | undefined;
      f.permissions.get(ownedSession)(
        auth.webContents,
        'media',
        (value: boolean) => (permission = value),
        {},
      );
      const permissionCheck = f.permissionChecks.get(ownedSession)(
        auth.webContents,
        'openExternal',
        'https://www.last.fm',
        {},
      );
      const cancellation = f.watchCancelledDownload(ownedSession);
      await auth.webContents.executeJavaScript(
        "location.href='https://www.last.fm/download';void 0",
      );
      // Native cancellation and file removal run on different Chromium tasks.
      // Observe the real guard before waiting for all owned files to disappear.
      for (let i = 0; i < 100 && !cancellation.read(); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const downloadCancellation = cancellation.read() ?? {
        guardCount: 0,
        prevented: false,
        cancelledOrRemoved: false,
      };
      if (
        downloadCancellation.guardCount === 1 &&
        downloadCancellation.prevented &&
        downloadCancellation.cancelledOrRemoved
      ) {
        for (let i = 0; i < 100 && f.downloadFiles().length; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const downloads = f.downloadFiles();
      cancellation.dispose();
      surface.close();
      await surface.closed;
      return {
        desktop,
        node: preferences.nodeIntegration,
        isolation: preferences.contextIsolation,
        sandbox: preferences.sandbox,
        preload: preferences.preload ?? '',
        permission,
        permissionCheck,
        downloads,
        downloadCancellation,
        permissionsRemoved:
          f.permissions.get(ownedSession) === null &&
          f.permissionChecks.get(ownedSession) === null,
      };
    });
    expect(result).toEqual({
      desktop: { top: false, kiosk: false, fullscreen: false },
      node: false,
      isolation: true,
      sandbox: true,
      preload: '',
      permission: false,
      permissionCheck: false,
      downloads: [],
      downloadCancellation: {
        guardCount: 1,
        prevented: true,
        cancelledOrRemoved: true,
      },
      permissionsRemoved: true,
    });
  } finally {
    await fixture.close();
  }
});

test('closing a guestless SSO child during its pending load preserves the primary authentication', async () => {
  const fixture = await scrobblerAuthNative();
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture;
      const surface = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/?token=owned',
        new AbortController().signal,
      );
      await surface.ready;
      const auth = BrowserWindow.getAllWindows().find(
        (w) => w.getParentWindow() === f.main,
      )!;
      let closed = false;
      surface.closed.then(() => (closed = true));
      f.pages.mode = 'hold';
      const answer = f.handlers.get(auth.webContents.id)({
        url: 'https://sso.fixture.invalid/pending',
        referrer: { url: 'https://www.last.fm', policy: 'default' },
      });
      const contents = answer.createWindow({ webPreferences: {} });
      const child = BrowserWindow.fromWebContents(contents)!;
      for (let i = 0; i < 100 && !f.pages.pending.length; i++)
        await new Promise((r) => setTimeout(r, 10));
      const wasLoading = contents.isLoading(),
        held = f.pages.pending.length;
      child.close();
      await new Promise((r) => setTimeout(r, 60));
      const result = {
        wasLoading,
        held,
        childGone: child.isDestroyed(),
        primaryAlive: !auth.isDestroyed(),
        surfaceClosed: closed,
        parentAlive: !f.main.isDestroyed(),
      };
      f.pages.mode = 'normal';
      for (const done of f.pages.pending.splice(0)) done();
      surface.close();
      await surface.closed;
      return result;
    });
    expect(result.wasLoading).toBe(true);
    expect(result.held).toBeGreaterThan(0);
    expect(result.childGone).toBe(true);
    expect(result.primaryAlive).toBe(true);
    expect(result.surfaceClosed).toBe(false);
    expect(result.parentAlive).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('a guestless SSO child load failure while still owned retires authentication', async () => {
  const fixture = await scrobblerAuthNative();
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture;
      const surface = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/?token=owned',
        new AbortController().signal,
      );
      await surface.ready;
      const auth = BrowserWindow.getAllWindows().find(
        (w) => w.getParentWindow() === f.main,
      )!;
      let closed = false;
      surface.closed.then(() => (closed = true));
      f.pages.mode = 'failure';
      const answer = f.handlers.get(auth.webContents.id)({
        url: 'https://sso.fixture.invalid/failure',
        referrer: { url: 'https://www.last.fm', policy: 'default' },
      });
      const contents = answer.createWindow({ webPreferences: {} });
      const child = BrowserWindow.fromWebContents(contents)!;
      for (let i = 0; i < 100 && !closed; i++)
        await new Promise((r) => setTimeout(r, 10));
      const result = {
        closed,
        primaryGone: auth.isDestroyed(),
        childGone: child.isDestroyed(),
        parentAlive: !f.main.isDestroyed(),
      };
      f.pages.mode = 'normal';
      surface.close();
      await surface.closed;
      return result;
    });
    expect(result).toEqual({
      closed: true,
      primaryGone: true,
      childGone: true,
      parentAlive: true,
    });
  } finally {
    await fixture.close();
  }
});
