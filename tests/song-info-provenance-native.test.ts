import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
async function nativeFixture<T>(task: () => Promise<T>): Promise<T> {
  const owned = await mkdtemp(
    path.join(tmpdir(), 'pear-song-provenance-native-'),
  );
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const sourceEntry = path.join(owned, 'source.ts');
    await writeFile(
      sourceEntry,
      `export * from ${JSON.stringify(path.join(root, 'src/providers/song-info.ts'))}; export {state} from '@/config';`,
    );
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      ssr: { noExternal: true },
      resolve: {
        alias: [{ find: /^@\/config$/, replacement: '\0native-config' }],
      },
      plugins: [
        {
          name: 'native-song-config-only',
          enforce: 'pre',
          resolveId(id) {
            if (id === '\0native-config') return id;
            return null;
          },
          load(id) {
            if (id === '\0native-config')
              return `export const state={writes:[]}; export const get=()=>false; export const set=(key,value)=>state.writes.push({key,value});`;
            return null;
          },
        },
      ],
      build: {
        ssr: true,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          input: sourceEntry,
          external: ['electron'],
          output: { format: 'cjs', entryFileNames: 'source.cjs' },
        },
      },
    });
    const preload = path.join(owned, 'preload.cjs');
    await writeFile(
      preload,
      `const {contextBridge,ipcRenderer}=require('electron');const updates=[];ipcRenderer.on('peard:update-song-info',(_,info)=>updates.push({videoId:info.videoId,title:info.title,keys:Object.keys(info)}));contextBridge.exposeInMainWorld('songProof',{send:(event,data)=>ipcRenderer.send(event,data),updates:()=>updates});`,
    );
    await writeFile(
      path.join(owned, 'main.html'),
      '<html><body><iframe src="child.html"></iframe></body></html>',
    );
    await writeFile(
      path.join(owned, 'child.html'),
      '<html><body>Owned subframe</body></html>',
    );
    const entry = path.join(owned, 'entry.cjs');
    await writeFile(
      entry,
      `
const {app,BrowserWindow,ipcMain,net,nativeImage,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};
for(const key of ['userData','sessionData']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned native fixture profile');app.setPath(key,target);}
app.on('window-all-closed',()=>{});
(async()=>{await app.whenReady();globalThis.SongProofNative={source:require(path.join(owned,'source.cjs')),app,BrowserWindow,ipcMain,net,nativeImage,session,owned,preload:${JSON.stringify(preload)}};const result=await (${task.toString()})();console.log('SONG_PROVENANCE_NATIVE '+JSON.stringify(result));for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit();})().catch(error=>{console.error(error);app.exit(1)});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      requireRoot('electron') as string,
      [entry, '--no-sandbox', `--user-data-dir=${path.join(owned, 'profile')}`],
      {
        cwd: owned,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', (data) => {
      stdout += data;
    });
    child.stderr!.on('data', (data) => {
      stderr += data;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Native provenance fixture timed out')),
        25000,
      );
      child!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(
              Error(`Native provenance fixture exited ${code}: ${stderr}`),
            );
      });
    });
    const line = stdout
      .split('\n')
      .find((value) => value.startsWith('SONG_PROVENANCE_NATIVE '));
    if (!line) throw Error('Native provenance result missing');
    return JSON.parse(line.slice('SONG_PROVENANCE_NATIVE '.length)) as T;
  } finally {
    if (child?.pid)
      try {
        process.platform === 'win32'
          ? child.kill('SIGKILL')
          : process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    await rm(owned, { recursive: true, force: true });
  }
}

test('real Electron sender/main-frame ownership fences delayed same-ID metadata and preserves native image/live elapsed', async () => {
  const result = await nativeFixture(async () => {
    const f = (globalThis as any).SongProofNative;
    const wait = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end) throw Error('Owned native observation missing');
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
    const requests: any[] = [];
    let release: (() => void) | undefined;
    const png = f.nativeImage
      .createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 })
      .toPNG();
    f.session.defaultSession.protocol.handle(
      'http',
      async (request: Request) => {
        const url = new URL(request.url);
        if (url.hostname !== 'song-info.fixture.invalid')
          throw Error('Unexpected native fixture network');
        requests.push({ path: url.pathname, method: request.method });
        if (url.pathname === '/first.jpg' && request.method === 'HEAD')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      },
    );
    const raw: any[] = [];
    let times = 0;
    const observe = (event: any, data: any) =>
      raw.push({
        title: data?.videoDetails?.title,
        window: event.sender === main.webContents,
        frame: event.senderFrame === main.webContents.mainFrame,
      });
    f.ipcMain.on('peard:video-src-changed', observe);
    f.ipcMain.on('peard:time-changed', () => {
      times++;
    });
    const dispose = f.source.setupSongInfo(main);
    const seen: any[] = [];
    f.source.registerCallback((info: any, event: string) =>
      seen.push({
        info,
        event,
        elapsed: info.elapsedSeconds,
        token: f.source.getSongInfoProvenance(info),
      }),
    );
    const data = (id: string, title: string, art?: string) => ({
      microformat: {
        microformatDataRenderer: {
          urlCanonical: `https://music.youtube.com/watch?v=${id}`,
          linkAlternates: [],
          tags: [],
        },
      },
      videoDetails: {
        videoId: id,
        title,
        author: 'Artist - Topic',
        lengthSeconds: '120',
        viewCount: '1',
        elapsedSeconds: 0,
        isPaused: false,
        musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
        ...(art
          ? {
              thumbnail: {
                thumbnails: [
                  { url: `http://song-info.fixture.invalid/${art}.jpg` },
                ],
              },
            }
          : {}),
      },
    });
    const send = (win: any, event: string, value: unknown) =>
      win.webContents.executeJavaScript(
        `window.songProof.send(${JSON.stringify(event)},${JSON.stringify(value)})`,
      );
    await send(main, 'peard:video-src-changed', data('A', 'A first', 'first'));
    await wait(() => !!release);
    const first = f.source.getCurrentSongInfoProvenance(main);
    const subframe = main.webContents.mainFrame.frames[0];
    if (!subframe) throw Error('Owned native subframe missing');
    await subframe.executeJavaScript(
      `window.songProof.send('peard:video-src-changed',${JSON.stringify(data('F', 'subframe'))})`,
    );
    await wait(() => raw.some((entry) => entry.title === 'subframe'));
    await send(foreign, 'peard:video-src-changed', data('F', 'foreign'));
    await wait(() => raw.some((entry) => entry.title === 'foreign'));
    const foreignDidNotRetire =
      f.source.getCurrentSongInfoProvenance(main) === first;
    await send(main, 'peard:time-changed', 777);
    await wait(() => times === 1);
    await send(main, 'peard:video-src-changed', data('B', 'B queued', 'B'));
    await wait(() => raw.some((entry) => entry.title === 'B queued'));
    await send(
      main,
      'peard:video-src-changed',
      data('A', 'A latest (Official Audio)', 'latest'),
    );
    await wait(() =>
      raw.some((entry) => entry.title === 'A latest (Official Audio)'),
    );
    const latest = f.source.getCurrentSongInfoProvenance(main);
    await send(main, 'peard:time-changed', 64);
    await wait(() => times === 2);
    await send(main, 'peard:play-or-paused', {
      isPaused: true,
      elapsedSeconds: 65,
    });
    release!();
    await wait(() =>
      seen.some((entry) => entry.event === 'peard:play-or-paused'),
    );
    let info: any;
    const off = f.source.registerCallback(
      (value: any) => {
        info = value;
      },
      { replayCurrent: true },
    );
    off();
    await wait(() => seen.length === 3);
    const updates = await main.webContents.executeJavaScript(
      'window.songProof.updates()',
    );
    const output = {
      foreignDidNotRetire,
      distinctAdmission: first !== latest,
      foreignFrameObserved: raw.some(
        (entry) => entry.title === 'subframe' && entry.window && !entry.frame,
      ),
      foreignWindowObserved: raw.some(
        (entry) => entry.title === 'foreign' && !entry.window,
      ),
      events: seen.map((entry) => entry.event),
      currentObject: seen.every(
        (entry) => entry.info === info && entry.token === latest,
      ),
      final: {
        title: info.title,
        artist: info.artist,
        elapsed: info.elapsedSeconds,
        paused: info.isPaused,
        imageEmpty: info.image.isEmpty(),
        imageBytes: info.image.toPNG().length,
      },
      noPrivateFields: !updates.some((entry: any) =>
        entry.keys.some((key: string) =>
          /provenance|epoch|admission/i.test(key),
        ),
      ),
      updateTitles: updates.map((entry: any) => entry.title),
      writes: f.source.state.writes.map((entry: any) => entry.value),
      requests,
    };
    dispose();
    main.destroy();
    foreign.destroy();
    return {
      ...output,
      closedCurrent: f.source.getCurrentSongInfoProvenance(main),
    };
  });
  expect(result.foreignDidNotRetire).toBe(true);
  expect(result.distinctAdmission).toBe(true);
  expect(result.foreignFrameObserved).toBe(true);
  expect(result.foreignWindowObserved).toBe(true);
  expect(result.events).toEqual([
    'peard:video-src-changed',
    'peard:time-changed',
    'peard:play-or-paused',
  ]);
  expect(result.currentObject).toBe(true);
  expect(result.final).toMatchObject({
    title: 'A latest',
    artist: 'Artist',
    elapsed: 65,
    paused: true,
    imageEmpty: false,
  });
  expect(result.final.imageBytes).toBeGreaterThan(0);
  expect(result.noPrivateFields).toBe(true);
  expect(result.updateTitles).toEqual(['A latest']);
  expect(result.writes).toEqual(['https://music.youtube.com/watch?v=A']);
  expect(result.requests).toEqual([
    { path: '/first.jpg', method: 'HEAD' },
    { path: '/latest.jpg', method: 'HEAD' },
    { path: '/latest.jpg', method: 'GET' },
  ]);
  expect(result.closedCurrent).toBeNull();
});

test('real Electron close retires owned IPC/cache while a native thumbnail request is unresolved', async () => {
  const result = await nativeFixture(async () => {
    const f = (globalThis as any).SongProofNative;
    const win = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(f.owned + '/child.html');
    let release: (() => void) | undefined;
    f.session.defaultSession.protocol.handle('http', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response('', { status: 200 });
    });
    const callbacks: any[] = [];
    f.source.registerCallback((info: any) => callbacks.push(info.videoId));
    const dispose = f.source.setupSongInfo(win);
    const contents = win.webContents,
      original = contents.send.bind(contents);
    let sends = 0;
    contents.send = (...args: any[]) => {
      sends++;
      return original(...args);
    };
    await contents.executeJavaScript(
      `window.songProof.send('peard:video-src-changed',{microformat:{microformatDataRenderer:{urlCanonical:'https://music.youtube.com/watch?v=A',linkAlternates:[],tags:[]}},videoDetails:{videoId:'A',title:'Owned',author:'Owned',musicVideoType:'MUSIC_VIDEO_TYPE_ATV',thumbnail:{thumbnails:[{url:'http://song-info.fixture.invalid/held.jpg'}]}}})`,
    );
    const end = Date.now() + 5000;
    while (!release) {
      if (Date.now() > end) throw Error('Owned artwork never admitted');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    win.destroy();
    release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    let replay: any = null;
    const off = f.source.registerCallback(
      (info: any) => {
        replay = info;
      },
      { replayCurrent: true },
    );
    off();
    dispose();
    return {
      sends,
      callbacks,
      writes: f.source.state.writes,
      current: f.source.getCurrentSongInfoProvenance(win),
      replay,
      listeners: [
        'peard:video-src-changed',
        'peard:time-changed',
        'peard:play-or-paused',
      ].map((event) => f.ipcMain.listenerCount(event)),
    };
  });
  expect(result).toEqual({
    sends: 0,
    callbacks: [],
    writes: [],
    current: null,
    replay: null,
    listeners: [0, 0, 0],
  });
});

test('real committed same-origin reload retires pending metadata without disposing the provider', async () => {
  const result = await nativeFixture(async () => {
    const f = (globalThis as any).SongProofNative;
    const win = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const contents = win.webContents;
    const dispose = f.source.setupSongInfo(win);
    await win.loadFile(f.owned + '/child.html');
    const png = f.nativeImage
      .createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 })
      .toPNG();
    let release: (() => void) | undefined;
    const requests: string[] = [];
    f.session.defaultSession.protocol.handle(
      'http',
      async (request: Request) => {
        requests.push(request.method);
        if (request.method === 'HEAD')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return new Response(png, { status: 200 });
      },
    );
    // Observe completion by forwarding the real handler, never a no-op/copy.
    const jobs: Promise<void>[] = [],
      channel = 'peard:video-src-changed';
    const actual = f.ipcMain.listeners(channel)[0];
    f.ipcMain.removeListener(channel, actual);
    const forwarding = (...args: any[]) => {
      const job = actual(...args);
      jobs.push(job);
      return job;
    };
    f.ipcMain.on(channel, forwarding);
    const seen: string[] = [];
    f.source.registerCallback((info: any) => seen.push(info.title));
    const data = (title: string, art = false) => ({
      microformat: {
        microformatDataRenderer: {
          urlCanonical: `https://music.youtube.com/watch?v=A&title=${title}`,
          linkAlternates: [],
          tags: [],
        },
      },
      videoDetails: {
        videoId: 'A',
        title,
        author: 'Owned',
        musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
        ...(art
          ? {
              thumbnail: {
                thumbnails: [
                  { url: 'http://song-info.fixture.invalid/held.jpg' },
                ],
              },
            }
          : {}),
      },
    });
    const send = (value: unknown) =>
      contents.executeJavaScript(
        `window.songProof.send(${JSON.stringify(channel)},${JSON.stringify(value)})`,
      );
    await send(data('old document', true));
    const end = Date.now() + 5000;
    while (!release) {
      if (Date.now() > end)
        throw Error('Native navigation artwork not admitted');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const frame = contents.mainFrame;
    await new Promise<void>((resolve) => {
      contents.once('did-finish-load', resolve);
      win.reload();
    });
    const sameFrame = frame === contents.mainFrame;
    const retiredAfterCommit =
      f.source.getCurrentSongInfoProvenance(win) === null;
    release();
    await jobs[0];
    const stale = {
      callbacks: seen.slice(),
      writes: f.source.state.writes.slice(),
      requests: requests.slice(),
    };
    await send(data('new document'));
    while (jobs.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await jobs[1];
    const output = {
      sameFrame,
      retiredAfterCommit,
      stale,
      callbacks: seen,
      writes: f.source.state.writes.map((write: any) => write.value),
      current: f.source.getCurrentSongInfoProvenance(win) !== null,
    };
    f.ipcMain.removeListener(channel, forwarding);
    dispose();
    win.destroy();
    return output;
  });
  console.log(
    JSON.stringify({
      nativeReloadSameFrame: result.sameFrame,
      retiredAfterCommit: result.retiredAfterCommit,
    }),
  );
  expect(result.retiredAfterCommit).toBe(true);
  expect(result.stale).toEqual({
    callbacks: [],
    writes: [],
    requests: ['HEAD'],
  });
  expect(result.callbacks).toEqual(['new document']);
  expect(result.writes).toEqual([
    'https://music.youtube.com/watch?v=A&title=new document',
  ]);
  expect(result.current).toBe(true);
});
