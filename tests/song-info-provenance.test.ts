import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const response = (videoId: string, title = videoId, image?: string) => ({
  microformat: {
    microformatDataRenderer: {
      urlCanonical: `https://music.youtube.com/watch?v=${videoId}&list=PL_owned`,
      linkAlternates: [],
      tags: ['owned'],
    },
  },
  videoDetails: {
    videoId,
    title,
    author: 'Owned artist',
    viewCount: '1',
    lengthSeconds: '120',
    elapsedSeconds: 0,
    isPaused: false,
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    ...(image ? { thumbnail: { thumbnails: [{ url: image }] } } : {}),
  },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-song-provenance-'));
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `export * from ${JSON.stringify(path.join(root, 'src/providers/song-info.ts'))}; export {state,ipcMain,makeWindow} from 'electron';`,
  );
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^electron$/, replacement: '\0owned-electron' },
        { find: /^@\/config$/, replacement: '\0owned-config' },
      ],
    },
    plugins: [
      {
        name: 'owned-song-native-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('\0owned-')) return id;
          return null;
        },
        load(id) {
          if (id === '\0owned-config')
            return `import {state} from 'electron'; export const get=()=>false; export const set=(key,value)=>{state.writes.push({key,value});state.afterConfig?.(key,value);};`;
          if (id === '\0owned-electron')
            return `
import {EventEmitter} from 'node:events';
export const ipcMain=new EventEmitter();
export const state={writes:[],messages:[],requests:[],holds:new Map(),afterConfig:null,afterSend:null};
class OwnedWindow extends EventEmitter {
 destroyed=false;contentsDestroyed=false;mainFrame={};
 webContents=Object.assign(new EventEmitter(),{isDestroyed:()=>this.contentsDestroyed,owner:this,
 send:(channel,value)=>{state.messages.push({window:this,channel,value});state.afterSend?.(this,channel,value);}});
 constructor(){super();Object.defineProperty(this.webContents,'mainFrame',{get:()=>this.mainFrame});}
 isDestroyed(){return this.destroyed;} destroy(){this.destroyed=true;this.contentsDestroyed=true;this.emit('closed');}
}
export const makeWindow=()=>new OwnedWindow();
export const nativeImage={createFromBuffer:buffer=>({isEmpty:()=>false,marker:buffer.toString()})};
export const net={fetch:async(url,init)=>{state.requests.push({url,init});const held=state.holds.get((init?.method??'GET')+' '+url);return held?held.promise:new Response('image:'+url,{status:200});}};
`;
          return null;
        },
      },
    ],
    build: {
      ssr: true,
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'actual.mjs' } },
    },
  });
  const source: any = await import(
    pathToFileURL(path.join(directory, 'actual.mjs')).href
  );
  const win = source.makeWindow();
  const release = source.setupSongInfo(win);
  const event = (window = win, frame = window.webContents.mainFrame) => ({
    sender: window.webContents,
    senderFrame: frame,
  });
  const emit = (name: string, data: unknown, native = event()) =>
    Promise.all(
      source.ipcMain
        .listeners(name)
        .map((listener: any) => listener(native, data)),
    ).then(() => {});
  const replay = () => {
    let info: any = null;
    const off = source.registerCallback(
      (value: any) => {
        info = value;
      },
      { replayCurrent: true },
    );
    off();
    return info;
  };
  return {
    source,
    win,
    event,
    emit,
    replay,
    state: source.state,
    hold: (url: string, method = 'HEAD') => {
      const held = deferred<Response>();
      source.state.holds.set(`${method} ${url}`, held);
      return held;
    },
    stop: () => {
      if (typeof release === 'function') release();
      else win.destroy();
    },
    close: async () => {
      if (typeof release === 'function') release();
      win.destroy();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test('delayed A to B to same-ID A publishes only the latest metadata and resume URL', async () => {
  const f = await fixture();
  const held = f.hold('https://art.invalid/A-first');
  const jobs: Promise<void>[] = [];
  try {
    await f.emit('peard:video-src-changed', response('X'));
    const seen: string[] = [];
    f.source.registerCallback((info: any, event: string) => {
      if (event === 'peard:video-src-changed') seen.push(info.title);
    });
    f.state.writes.length = 0;
    f.state.messages.length = 0;
    jobs.push(
      f.emit(
        'peard:video-src-changed',
        response('A', 'A first', 'https://art.invalid/A-first'),
      ),
    );
    await flush();
    expect(f.state.requests).toHaveLength(1);
    jobs.push(
      f.emit(
        'peard:video-src-changed',
        response('B', 'B', 'https://art.invalid/B'),
      ),
    );
    jobs.push(
      f.emit(
        'peard:video-src-changed',
        response('A', 'A latest', 'https://art.invalid/A-latest'),
      ),
    );
    held.resolve(new Response('', { status: 200 }));
    await Promise.all(jobs);
    expect(seen).toEqual(['A latest']);
    expect(f.state.writes.map((write: any) => write.value)).toEqual([
      'https://music.youtube.com/watch?v=A&list=PL_owned',
    ]);
    expect(f.state.messages.map((message: any) => message.value.title)).toEqual(
      ['A latest'],
    );
    expect(
      f.state.requests.some(
        (request: any) => request.url === 'https://art.invalid/B',
      ),
    ).toBe(false);
    expect(
      f.state.requests.filter(
        (request: any) => request.url === 'https://art.invalid/A-first',
      ),
    ).toHaveLength(1);
    expect(f.replay().image.marker).toBe('image:https://art.invalid/A-latest');
  } finally {
    held.resolve(new Response());
    await Promise.allSettled(jobs);
    await f.close();
  }
});

test('owned raw admission invalidates replay synchronously including unknown metadata', async () => {
  const f = await fixture();
  try {
    await f.emit('peard:video-src-changed', response('A'));
    const old = f.replay();
    expect(old.videoId).toBe('A');
    const pending = f.emit('peard:video-src-changed', null);
    expect(f.replay()).toBeNull();
    await pending;
    expect(f.replay()).toBeNull();
    expect(f.state.messages).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const foreign of ['window', 'frame'])
  test(`foreign native ${foreign} cannot retire or publish current song`, async () => {
    const f = await fixture();
    try {
      await f.emit('peard:video-src-changed', response('A'));
      const current = f.replay();
      const seen: string[] = [];
      f.source.registerCallback((info: any) => seen.push(info.videoId));
      const native =
        foreign === 'window'
          ? f.event(f.source.makeWindow())
          : f.event(f.win, {});
      await f.emit('peard:video-src-changed', response('F'), native);
      await f.emit('peard:time-changed', 999, native);
      expect(f.replay()).toBe(current);
      expect(current.elapsedSeconds).toBe(0);
      expect(seen).toEqual([]);
      expect(f.state.messages).toHaveLength(1);
      expect(f.state.writes).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('arrival generation fences old time and pause while current updates retain one opaque token and object', async () => {
  const f = await fixture();
  const held = f.hold('https://art.invalid/old');
  const jobs: Promise<void>[] = [];
  try {
    expect(typeof f.source.getSongInfoProvenance).toBe('function');
    expect(typeof f.source.getCurrentSongInfoProvenance).toBe('function');
    const updates: any[] = [];
    f.source.registerCallback((info: any, event: string) =>
      updates.push({
        info,
        event,
        elapsed: info.elapsedSeconds,
        paused: info.isPaused,
        token: f.source.getSongInfoProvenance(info),
      }),
    );
    jobs.push(f.emit('peard:time-changed', 111));
    jobs.push(
      f.emit(
        'peard:video-src-changed',
        response('A', 'old', 'https://art.invalid/old'),
      ),
    );
    await flush();
    jobs.push(f.emit('peard:time-changed', 777));
    jobs.push(
      f.emit('peard:play-or-paused', { isPaused: true, elapsedSeconds: 778 }),
    );
    jobs.push(f.emit('peard:video-src-changed', response('B')));
    jobs.push(f.emit('peard:video-src-changed', response('A', 'latest')));
    jobs.push(f.emit('peard:time-changed', 64));
    jobs.push(
      f.emit('peard:play-or-paused', { isPaused: true, elapsedSeconds: 65 }),
    );
    held.resolve(new Response());
    await Promise.all(jobs);
    // Existing mutex publication exposes the live object: later current updates
    // can land before an earlier callback resumes. Do not freeze old elapsed.
    expect(updates.map((update) => update.event)).toEqual([
      'peard:video-src-changed',
      'peard:time-changed',
      'peard:play-or-paused',
    ]);
    expect(updates.every((update) => [64, 65].includes(update.elapsed))).toBe(
      true,
    );
    const info = f.replay(),
      token = f.source.getCurrentSongInfoProvenance(f.win);
    expect(
      updates.every((update) => update.info === info && update.token === token),
    ).toBe(true);
    expect(info.elapsedSeconds).toBe(65);
    expect(info.isPaused).toBe(true);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.keys(token)).toEqual([]);
    expect(f.source.getSongInfoProvenance({ ...info })).toBeNull();
    expect(
      Object.keys(info).some((key) => /provenance|epoch|admission/i.test(key)),
    ).toBe(false);
  } finally {
    held.resolve(new Response());
    await Promise.allSettled(jobs);
    await f.close();
  }
});

for (const retired of [
  'stop',
  'closed',
  'contents destroyed',
  'replacement',
  'frame replacement',
])
  test(`delayed metadata cannot commit after provider ${retired}`, async () => {
    const f = await fixture();
    const held = f.hold('https://art.invalid/held');
    let pending: Promise<void> | undefined;
    try {
      const seen: any[] = [];
      f.source.registerCallback((info: any) => seen.push(info));
      pending = f.emit(
        'peard:video-src-changed',
        response('A', 'old', 'https://art.invalid/held'),
      );
      await flush();
      f.state.writes.length = 0;
      if (retired === 'stop') f.stop();
      if (retired === 'closed') f.win.destroy();
      if (retired === 'contents destroyed') f.win.contentsDestroyed = true;
      if (retired === 'replacement')
        f.source.setupSongInfo(f.source.makeWindow());
      if (retired === 'frame replacement') f.win.mainFrame = {};
      held.resolve(new Response());
      await pending;
      expect(f.state.writes).toEqual([]);
      expect(f.state.messages).toEqual([]);
      expect(seen).toEqual([]);
      expect(f.replay()).toBeNull();
    } finally {
      held.resolve(new Response());
      await Promise.allSettled(pending ? [pending] : []);
      await f.close();
    }
  });

test('owned disposal preserves foreign IPC listeners and global callback registration across replacement', async () => {
  const f = await fixture();
  try {
    const foreign = () => {};
    f.source.ipcMain.on('peard:video-src-changed', foreign);
    const retained = f.source.ipcMain
      .listeners('peard:video-src-changed')
      .filter((listener: any) => listener !== foreign);
    const seen: string[] = [];
    f.source.registerCallback((info: any) => seen.push(info.videoId));
    const replacement = f.source.makeWindow();
    const release = f.source.setupSongInfo(replacement);
    await Promise.all(
      retained.map((listener: any) => listener(f.event(), response('old'))),
    );
    await f.emit(
      'peard:video-src-changed',
      response('new'),
      f.event(replacement),
    );
    expect(seen).toEqual(['new']);
    expect(f.replay().videoId).toBe('new');
    expect(typeof release).toBe('function');
    release();
    expect(f.source.ipcMain.listeners('peard:video-src-changed')).toEqual([
      foreign,
    ]);
    expect(f.source.ipcMain.listenerCount('peard:time-changed')).toBe(0);
    expect(f.source.ipcMain.listenerCount('peard:play-or-paused')).toBe(0);
  } finally {
    await f.close();
  }
});

test('reentrant callback retirement prevents remaining old publication but preserves subscribers for a new provider', async () => {
  const f = await fixture();
  try {
    const replacement = f.source.makeWindow();
    const seen: string[] = [];
    f.source.registerCallback((info: any) => {
      if (info.videoId === 'A') f.source.setupSongInfo(replacement);
    });
    f.source.registerCallback((info: any) => seen.push(info.videoId));
    await f.emit('peard:video-src-changed', response('A'));
    expect(seen).toEqual([]);
    await f.emit(
      'peard:video-src-changed',
      response('B'),
      f.event(replacement),
    );
    expect(seen).toEqual(['B']);
  } finally {
    await f.close();
  }
});

for (const effect of ['config', 'send'])
  test(`reentrant ${effect} retirement prevents downstream old cache and callbacks`, async () => {
    const f = await fixture();
    try {
      const replacement = f.source.makeWindow();
      const seen: string[] = [];
      f.source.registerCallback((info: any) => seen.push(info.videoId));
      const retire = () => f.source.setupSongInfo(replacement);
      if (effect === 'config') f.state.afterConfig = retire;
      else f.state.afterSend = retire;
      await f.emit('peard:video-src-changed', response('A'));
      expect(seen).toEqual([]);
      expect(f.replay()).toBeNull();
      if (effect === 'config') expect(f.state.messages).toEqual([]);
    } finally {
      await f.close();
    }
  });

test('resume URL belongs to the extracted admission snapshot while artwork is delayed', async () => {
  const f = await fixture();
  const held = f.hold('https://art.invalid/snapshot');
  let pending: Promise<void> | undefined;
  try {
    const data = response('A', 'snapshot', 'https://art.invalid/snapshot');
    pending = f.emit('peard:video-src-changed', data);
    await flush();
    data.microformat.microformatDataRenderer.urlCanonical =
      'https://music.youtube.com/watch?v=mutated';
    held.resolve(new Response());
    await pending;
    expect(f.state.writes.map((write: any) => write.value)).toEqual([
      'https://music.youtube.com/watch?v=A&list=PL_owned',
    ]);
    expect(f.replay().url).toBe('https://music.youtube.com/watch?v=A');
  } finally {
    held.resolve(new Response());
    await Promise.allSettled(pending ? [pending] : []);
    await f.close();
  }
});

for (const reentry of ['pause payload', 'native frame'])
  test(`a reentrant ${reentry} cannot move an old update into a newer admission`, async () => {
    const f = await fixture();
    let next: Promise<void> | undefined;
    try {
      await f.emit('peard:video-src-changed', response('A'));
      const changed: string[] = [];
      f.source.registerCallback((_info: any, event: string) =>
        changed.push(event),
      );
      if (reentry === 'pause payload') {
        const data = {
          get isPaused() {
            next = f.emit('peard:video-src-changed', response('B'));
            return true;
          },
          elapsedSeconds: 777,
        };
        await f.emit('peard:play-or-paused', data);
      } else {
        const native = {
          sender: f.win.webContents,
          get senderFrame() {
            next = f.emit('peard:video-src-changed', response('B'));
            return f.win.webContents.mainFrame;
          },
        };
        await f.emit('peard:time-changed', 777, native);
      }
      await next;
      expect(f.replay().videoId).toBe('B');
      expect(f.replay().elapsedSeconds).toBe(0);
      expect(f.replay().isPaused).toBe(false);
      expect(changed).toEqual(['peard:video-src-changed']);
    } finally {
      await Promise.allSettled(next ? [next] : []);
      await f.close();
    }
  });

test('a live provider waits for its native main frame without retiring before first metadata', async () => {
  const f = await fixture();
  try {
    const window = f.source.makeWindow();
    window.mainFrame = undefined;
    const release = f.source.setupSongInfo(window);
    expect(f.source.getCurrentSongInfoProvenance(window)).toBeNull();
    window.mainFrame = {};
    await f.emit('peard:video-src-changed', response('ready'), f.event(window));
    expect(f.replay()?.videoId).toBe('ready');
    expect(f.source.getCurrentSongInfoProvenance(window)).toBe(
      f.source.getSongInfoProvenance(f.replay()),
    );
    release();
  } finally {
    await f.close();
  }
});

test('an owned empty canonical resume URL retains the existing config-write behavior', async () => {
  const f = await fixture();
  try {
    const data = response('A');
    data.microformat.microformatDataRenderer.urlCanonical = '';
    await f.emit('peard:video-src-changed', data);
    expect(f.state.writes).toEqual([{ key: 'url', value: '' }]);
    expect(f.replay().videoId).toBe('A');
  } finally {
    await f.close();
  }
});

for (const retired of ['committed document', 'renderer lost'])
  test(`a stable main-frame object cannot retain a pending admission after ${retired}`, async () => {
    const f = await fixture();
    const held = f.hold('https://art.invalid/document');
    let pending: Promise<void> | undefined;
    try {
      const seen: string[] = [];
      f.source.registerCallback((info: any) => seen.push(info.videoId));
      const frame = f.win.webContents.mainFrame;
      pending = f.emit(
        'peard:video-src-changed',
        response('A', 'old document', 'https://art.invalid/document'),
      );
      await flush();
      f.win.webContents.emit(
        retired === 'committed document'
          ? 'did-navigate'
          : 'render-process-gone',
        {},
        'owned document',
      );
      expect(f.win.webContents.mainFrame).toBe(frame);
      expect(f.source.getCurrentSongInfoProvenance(f.win)).toBeNull();
      held.resolve(new Response());
      await pending;
      expect(f.state.writes).toEqual([]);
      expect(f.state.messages).toEqual([]);
      expect(seen).toEqual([]);
      await f.emit('peard:video-src-changed', response('A', 'new document'));
      expect(f.replay().title).toBe('new document');
      expect(seen).toEqual(['A']);
    } finally {
      held.resolve(new Response());
      await Promise.allSettled(pending ? [pending] : []);
      await f.close();
    }
  });
