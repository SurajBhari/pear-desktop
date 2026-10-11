import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));
const playerResponse = (videoId = 'fixture-known-track') => ({
  videoDetails: {
    title: 'fixture title',
    author: 'fixture artist',
    viewCount: '1',
    lengthSeconds: '120',
    elapsedSeconds: 18,
    isPaused: true,
    videoId,
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
  },
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-api-song-test-'));
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `
export {setupSongInfo,registerCallback,SongInfoEvent} from ${JSON.stringify(path.join(root, 'src/providers/song-info.ts'))};
export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/main.ts'))};
export {ipcMain,fixtureWindow,createFixtureWindow,fixtureNetwork,app} from 'electron';
`,
  );
  const electron = `
import {EventEmitter} from 'node:events';
export const ipcMain=new EventEmitter(); export const app=new EventEmitter();
class FixtureWindow extends EventEmitter {
 destroyed=false; messages=[]; webContents=Object.assign(new EventEmitter(),{isDestroyed:()=>this.destroyed,mainFrame:{},send:(...args)=>this.messages.push(args),executeJavaScript:async()=>undefined});
 isDestroyed(){return this.destroyed;} destroy(){this.destroyed=true;this.emit('closed');}
}
export const createFixtureWindow=()=>new FixtureWindow();export const fixtureWindow=createFixtureWindow();
export const fixtureNetwork=[];
export const nativeImage={createFromBuffer:()=>({isEmpty:()=>false})};
export const net={fetch:async(...args)=>{fixtureNetwork.push(args);throw new Error('Fixture prohibits remote artwork/network');}};
export const dialog={showMessageBox:async()=>({response:1})};
`;
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const bundle = await rolldown({
    input: entry,
    platform: 'node',
    plugins: [
      {
        name: 'controlled-native-boundaries',
        async resolveId(id: string) {
          if (id === 'electron') return '\0fixture-electron';
          if (id === '@/config') return '\0fixture-config';
          if (id === '@/i18n') return '\0fixture-i18n';
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            const { access } = await import('node:fs/promises');
            for (const suffix of ['.ts', '/index.ts', '.tsx']) {
              try {
                await access(target + suffix);
                return target + suffix;
              } catch {
                /* try next source suffix */
              }
            }
          }
          if (
            !id.startsWith('.') &&
            !path.isAbsolute(id) &&
            !id.startsWith('\0')
          ) {
            return {
              id: id.startsWith('node:')
                ? id
                : requireRoot.resolve(id).replaceAll('\\', '/'),
              external: true,
            };
          }
        },
        load(id: string) {
          if (id === '\0fixture-electron') return electron;
          if (id === '\0fixture-config')
            return 'export const get=()=>false; export const set=()=>{};';
          if (id === '\0fixture-i18n')
            return "export const APPLICATION_NAME='Public Fixture'; export const t=(key)=>key;";
        },
      },
    ],
  });
  const output = path.join(directory, 'actual-source.cjs');
  await bundle.write({ file: output, format: 'cjs' });
  await bundle.close();
  // Only native/config/translation boundaries are supplied. Provider, mutex,
  // backend lifecycle, Hono middleware, route handlers and schemas are real.
  const source = requireRoot(output);
  const { backend, ipcMain, fixtureWindow } = source;
  source.setupSongInfo(fixtureWindow);
  let cached: unknown;
  let writes = 0;
  Object.defineProperty(backend, 'songInfo', {
    configurable: true,
    get: () => cached,
    set(value: unknown) {
      if (value) writes++;
      cached = value;
    },
  });
  const config = {
    enabled: true,
    hostname: '127.0.0.1',
    port: 0,
    authStrategy: 'NONE',
    secret: 'public-fixture-secret',
    authorizedClients: [],
    useHttps: false,
    certPath: '',
    keyPath: '',
  };
  const ctx = {
    getConfig: async () => config,
    setConfig: async () => {},
    window: fixtureWindow,
    ipc: {
      on: (event: string, handler: (...args: unknown[]) => void) =>
        ipcMain.on(event, (_: unknown, ...args: unknown[]) => handler(...args)),
      send: (...args: unknown[]) => fixtureWindow.webContents.send(...args),
    },
  };
  const waitListening = async () => {
    if (backend.server && !backend.server.listening)
      await once(backend.server, 'listening');
  };
  const stop = async () => {
    const server = backend.server;
    const closed = server ? once(server, 'close') : undefined;
    backend.stop();
    if (closed) await closed;
  };
  return {
    source,
    backend,
    ctx,
    config,
    writes: () => writes,
    emit: async (event: string, ...args: unknown[]) => {
      for (const listener of ipcMain.listeners(event))
        await listener(
          {
            sender: fixtureWindow.webContents,
            senderFrame: fixtureWindow.webContents.mainFrame,
          },
          ...args,
        );
    },
    start: async () => {
      await backend.start(ctx);
      await waitListening();
    },
    waitListening,
    stop,
    query: async (endpoint = 'song') =>
      fetch(
        `http://127.0.0.1:${backend.server.address().port}/api/v1/${endpoint}`,
      ),
    close: async () => {
      await stop();
      delete requireRoot.cache[output];
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('late API enable backfills known song and both aliases without another player event', async () => {
  const f = await fixture();
  try {
    await f.emit('peard:video-src-changed', playerResponse());
    await f.start();
    for (const endpoint of ['song', 'song-info']) {
      const response = await f.query(endpoint);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        videoId: 'fixture-known-track',
        elapsedSeconds: 18,
        isPaused: true,
      });
    }
    expect(f.source.fixtureNetwork).toEqual([]);
  } finally {
    await f.close();
  }
});

test('default registrations receive only live events; opt-in replay and unsubscribe are scoped', async () => {
  const f = await fixture();
  try {
    await f.emit('peard:video-src-changed', playerResponse());
    const live: string[] = [];
    const replay: string[] = [];
    f.source.registerCallback((info: { videoId: string }) =>
      live.push(info.videoId),
    );
    const off = f.source.registerCallback(
      (info: { videoId: string }) => replay.push(info.videoId),
      { replayCurrent: true },
    );
    expect(live).toEqual([]);
    expect(replay).toEqual(['fixture-known-track']);
    off();
    off();
    await f.emit(
      'peard:video-src-changed',
      playerResponse('fixture-next-track'),
    );
    expect(live).toEqual(['fixture-next-track']);
    expect(replay).toEqual(['fixture-known-track']);
  } finally {
    await f.close();
  }
});

for (const empty of ['null data', 'replacement provider', 'closed provider']) {
  test(`backfill does not resurrect a song after ${empty}`, async () => {
    const f = await fixture();
    try {
      await f.start();
      await f.emit('peard:video-src-changed', playerResponse());
      await f.stop();
      if (empty === 'null data') await f.emit('peard:video-src-changed', null);
      if (empty === 'replacement provider')
        f.source.setupSongInfo(f.source.createFixtureWindow());
      if (empty === 'closed provider') f.source.fixtureWindow.destroy();
      await f.start();
      expect((await f.query()).status).toBe(204);
    } finally {
      await f.close();
    }
  });
}

test('stopped assignment subscriber is removed and restart delivers once', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.emit('peard:video-src-changed', playerResponse());
    await f.stop();
    const stopped = f.writes();
    await f.emit('peard:time-changed', 19);
    expect(f.writes() - stopped).toBe(0);
    await f.start();
    const started = f.writes();
    await f.emit('peard:time-changed', 20);
    expect(f.writes() - started).toBe(1);
    expect((await (await f.query()).json()).elapsedSeconds).toBe(20);
  } finally {
    await f.close();
  }
});

test('disposal during pending provider publication keeps other subscribers active', async () => {
  const f = await fixture();
  try {
    let other = 0;
    f.source.registerCallback(() => other++);
    await f.start();
    const stopped = f.writes();
    const pending = f.emit('peard:video-src-changed', playerResponse());
    await f.stop();
    await pending;
    expect(f.writes() - stopped).toBe(0);
    expect(other).toBe(1);
  } finally {
    await f.close();
  }
});

test('a delayed start cannot create a server or subscription after stop', async () => {
  const f = await fixture();
  try {
    let release: ((config: typeof f.config) => void) | undefined;
    const config = new Promise<typeof f.config>((resolve) => {
      release = resolve;
    });
    const pending = f.backend.start({ ...f.ctx, getConfig: () => config });
    f.backend.stop();
    release!(f.config);
    await pending;
    await f.waitListening();
    expect(Boolean(f.backend.server)).toBe(false);
    const stopped = f.writes();
    await f.emit('peard:video-src-changed', playerResponse());
    expect(f.writes() - stopped).toBe(0);
  } finally {
    await f.close();
  }
});

test('failed opt-in replay releases its new registration before future publication', async () => {
  const f = await fixture();
  try {
    await f.emit('peard:video-src-changed', playerResponse());
    let attempts = 0;
    expect(() =>
      f.source.registerCallback(
        () => {
          attempts++;
          throw new Error('fixture replay rejected');
        },
        { replayCurrent: true },
      ),
    ).toThrow('fixture replay rejected');
    let other = 0;
    f.source.registerCallback(() => other++);
    await expect(
      f.emit('peard:video-src-changed', playerResponse('fixture-next-track')),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    expect(other).toBe(1);
  } finally {
    await f.close();
  }
});

test('a failed repeat replay preserves an already registered callback', async () => {
  const f = await fixture();
  try {
    await f.emit('peard:video-src-changed', playerResponse());
    let reject = true;
    let delivered = 0;
    const subscriber = () => {
      if (reject) throw new Error('fixture repeat replay rejected');
      delivered++;
    };
    f.source.registerCallback(subscriber);
    expect(() =>
      f.source.registerCallback(subscriber, { replayCurrent: true }),
    ).toThrow('fixture repeat replay rejected');
    reject = false;
    await f.emit(
      'peard:video-src-changed',
      playerResponse('fixture-next-track'),
    );
    expect(delivered).toBe(1);
  } finally {
    await f.close();
  }
});
