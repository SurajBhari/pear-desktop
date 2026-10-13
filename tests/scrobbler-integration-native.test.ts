import { test, expect } from '@playwright/test';
import { scrobblerIntegrationNative } from './helpers/scrobbler-integration-native';

test('real provider IPC retires an old same-ID timer before delayed metadata and preserves live elapsed', async () => {
  const result = await scrobblerIntegrationNative(async () => {
    const f = (globalThis as any).ScrobbleIntegrationProof;
    const wait = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end) throw Error('Missing owned native observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const make = () =>
      new f.BrowserWindow({
        show: false,
        webPreferences: {
          preload: f.preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: true,
        },
      });
    const main = make(),
      foreign = make();
    await main.loadFile(f.owned + '/main.html');
    await foreign.loadFile(f.owned + '/child.html');
    const posts: any[] = [],
      delivered: any[] = [];
    let release: (() => void) | undefined;
    const png = f.nativeImage
      .createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 })
      .toPNG();
    f.net.fetch = async (url: string, options: any = {}) => {
      if (url.includes('thumbnail.fixture.invalid')) {
        if (!release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
      posts.push(Object.fromEntries(new URLSearchParams(options.body)));
      return new Response('{}');
    };
    const disposeProvider = f.source.setupSongInfo(main);
    const disposeObserver = f.source.registerCallback(
      (info: any, event: string) => delivered.push({ info, event }),
      { replayCurrent: false },
    );
    let config = {
      ...f.source.defaultConfig,
      enabled: true,
      alternativeTitles: false,
      alternativeArtist: false,
      scrobblers: {
        ...f.source.defaultConfig.scrobblers,
        lastfm: {
          ...f.source.defaultConfig.scrobblers.lastfm,
          enabled: true,
          sessionKey: 'owned-session',
        },
      },
    };
    const manager = f.source.createScrobblerManager({
      window: main,
      getConfig: () => config,
      setConfig() {
        throw Error('Unexpected native account mutation');
      },
      ipc: {},
    });
    await manager.start();
    const data = (title: string, art = false) => ({
      microformat: {
        microformatDataRenderer: {
          urlCanonical: 'https://music.youtube.com/watch?v=A',
          linkAlternates: [],
          tags: [],
        },
      },
      videoDetails: {
        videoId: 'A',
        title,
        author: 'Owned Artist',
        lengthSeconds: '4',
        viewCount: '1',
        elapsedSeconds: 0,
        isPaused: false,
        musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
        ...(art
          ? {
              thumbnail: {
                thumbnails: [
                  { url: 'https://thumbnail.fixture.invalid/held.jpg' },
                ],
              },
            }
          : {}),
      },
    });
    const send = (win: any, channel: string, value: unknown) =>
      win.webContents.executeJavaScript(
        `window.scrobbleProof.send(${JSON.stringify(channel)},${JSON.stringify(value)})`,
      );
    await send(main, 'peard:video-src-changed', data('First'));
    await wait(() => posts.length === 1);
    await send(foreign, 'peard:video-src-changed', data('Foreign'));
    const child = main.webContents.mainFrame.frames[0];
    if (!child) throw Error('Missing owned subframe');
    await child.executeJavaScript(
      `window.scrobbleProof.send('peard:video-src-changed',${JSON.stringify(data('Subframe'))})`,
    );
    await send(main, 'peard:video-src-changed', data('Held old same-ID', true));
    await wait(() => !!release);
    await send(main, 'peard:video-src-changed', data('Newest same-ID'));
    release!();
    await wait(() => posts.some((post) => post.track === 'Newest same-ID'));
    await send(main, 'peard:time-changed', 2);
    await wait(() =>
      delivered.some(
        (value) =>
          value.event === 'peard:time-changed' &&
          value.info.elapsedSeconds === 2,
      ),
    );
    await wait(() => posts.some((post) => post.method === 'track.scrobble'));
    const now = Math.trunc(Date.now() / 1000),
      submitted = posts.filter((post) => post.method === 'track.scrobble');
    manager.stop();
    disposeObserver();
    disposeProvider();
    return {
      tracks: posts.map((post) => post.track),
      submitted: submitted.map((post) => ({
        track: post.track,
        age: now - Number(post.timestamp),
      })),
      retiredCallbacks: delivered.filter((value) =>
        ['Foreign', 'Subframe', 'Held old same-ID'].includes(value.info.title),
      ).length,
    };
  });
  expect(result.tracks).toEqual(['First', 'Newest same-ID', 'Newest same-ID']);
  expect(result.submitted).toHaveLength(1);
  expect(result.submitted[0].track).toBe('Newest same-ID');
  expect(result.submitted[0].age).toBeGreaterThanOrEqual(2);
  expect(result.submitted[0].age).toBeLessThanOrEqual(3);
  expect(result.retiredCallbacks).toBe(0);
});

test('real initial navigation restores background auth with actual secure native surface before any song', async () => {
  const result = await scrobblerIntegrationNative(async () => {
    const f = (globalThis as any).ScrobbleIntegrationProof;
    const wait = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end)
          throw Error('Missing owned auth lifecycle observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const main = new f.BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    let tokens = 0,
      releaseFirstSession: (() => void) | undefined;
    const surfaces: any[] = [],
      writes: any[] = [];
    f.app.on('browser-window-created', (_event: unknown, win: any) => {
      if (win !== main) {
        const prefs = win.webContents.getLastWebPreferences();
        surfaces.push({
          secure:
            !!prefs.contextIsolation &&
            !!prefs.sandbox &&
            !prefs.nodeIntegration &&
            win.webContents.session !== main.webContents.session,
        });
      }
    });
    f.net.fetch = async (url: string) => {
      const request = new URL(url),
        method = request.searchParams.get('method');
      if (method === 'auth.getToken') {
        tokens++;
        return new Response(JSON.stringify({ token: 'owned-token-' + tokens }));
      }
      if (method === 'auth.getSession') {
        if (request.searchParams.get('token') === 'owned-token-1')
          await new Promise<void>((resolve) => {
            releaseFirstSession = resolve;
          });
        return new Response('{"session":{"key":"owned-auth-session"}}');
      }
      throw Error('Unexpected native integration request');
    };
    let config = {
      ...f.source.defaultConfig,
      enabled: true,
      scrobblers: {
        ...f.source.defaultConfig.scrobblers,
        lastfm: {
          ...f.source.defaultConfig.scrobblers.lastfm,
          enabled: true,
          sessionKey: null,
        },
      },
    };
    const manager = f.source.createScrobblerManager({
      window: main,
      getConfig: () => config,
      setConfig: (patch: any) => {
        writes.push(patch);
        config = {
          ...config,
          scrobblers: {
            ...config.scrobblers,
            lastfm: { ...config.scrobblers.lastfm, ...patch.scrobblers.lastfm },
          },
        };
      },
      ipc: {},
    });
    await manager.start();
    await wait(() => surfaces.length === 1);
    await main.loadFile(f.owned + '/main.html');
    await wait(() => writes.length === 1);
    const live = manager.services.size;
    const secure = surfaces.every((surface) => surface.secure);
    manager.stop();
    releaseFirstSession?.();
    return { tokens, surfaces: surfaces.length, writes, live, secure };
  });
  expect(result.tokens).toBeGreaterThanOrEqual(2);
  expect(result.surfaces).toBeGreaterThanOrEqual(2);
  expect(result.writes).toEqual([
    {
      scrobblers: { lastfm: { sessionKey: 'owned-auth-session', token: null } },
    },
  ]);
  expect(result.live).toBe(1);
  expect(result.secure).toBe(true);
});
