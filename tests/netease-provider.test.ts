import { createDecipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { test, expect } from '@playwright/test';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
let scratch: string;
let backend: any;
let NetEase: any;
test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(root, '.tmp-netease-test-'));
  const entry = path.join(scratch, 'entry.ts');
  await writeFile(
    entry,
    `export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/backend.ts'))};export {NetEase} from ${JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/providers/NetEase.ts'))};`,
  );
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    ssr: { noExternal: true },
    resolve: {
      alias: [
        { find: /^@\/utils$/, replacement: '\0fixture-utils' },
        { find: /^electron$/, replacement: '\0fixture-electron' },
        { find: '@', replacement: path.join(root, 'src') },
      ],
    },
    plugins: [
      {
        name: 'native-lyrics-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (id === '\0fixture-utils' || id === '\0fixture-electron')
            return id;
        },
        load(id) {
          if (id === '\0fixture-utils')
            return 'export const createBackend=value=>value;';
          if (id === '\0fixture-electron')
            return 'export const net={fetch:()=>{throw Error("Unexpected global fetch")}};';
        },
      },
    ],
    build: {
      ssr: true,
      outDir: scratch,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        input: entry,
        output: { entryFileNames: 'fixture.mjs' },
      },
    },
  });
  ({ backend, NetEase } = await import(
    pathToFileURL(path.join(scratch, 'fixture.mjs')).href
  ));
});
test.afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const song = { title: 'Owned Song', artist: 'Owned Artist', songDuration: 120 };
const songRow = (id: number, duration = 120000) => ({
  resourceId: id,
  baseInfo: {
    simpleSongData: {
      name: song.title,
      ar: [{ id: 1, name: song.artist }],
      dt: duration,
    },
  },
});
function wire(body: string) {
  const encrypted = Buffer.from(
    new URLSearchParams(body).get('params')!,
    'hex',
  );
  const decipher = createDecipheriv(
    'aes-128-ecb',
    Buffer.from('e82ckenh8dichen8'),
    null,
  );
  const payload = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
  const [endpoint, json, signature] = payload.split('-36cd479b6b5-');
  expect(signature).toBe(
    createHash('md5')
      .update(`nobody${endpoint}use${json}md5forencrypt`)
      .digest('hex'),
  );
  return { endpoint, data: JSON.parse(json) };
}
function fixture(
  fetcher?: (url: string, init: RequestInit) => Promise<Response>,
) {
  const requests: { endpoint: string; data: any; init: RequestInit }[] = [];
  const window = new EventEmitter() as any;
  window.isDestroyed = () => false;
  const session = {
    fetch: async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/interface\.music\.163\.com\/eapi\//);
      const request = wire(String(init.body));
      requests.push({ ...request, init });
      if (fetcher) return fetcher(url, init);
      if (request.endpoint === '/api/register/anonimous')
        return Response.json(
          { code: 200 },
          { headers: { 'set-cookie': 'anon=fixture==; Path=/; HttpOnly' } },
        );
      if (request.endpoint === '/api/search/song/list/page')
        return Response.json({
          code: 200,
          data: { resources: [songRow(1, 180000), songRow(2)] },
        });
      return Response.json({
        code: 200,
        lrc: {
          lyric:
            '{"metadata":"ignored"}\n[00:01.00]<00:01.00>Owned <00:01.50>words\n[00:03.00]Next',
        },
      });
    },
  };
  window.webContents = { session, isDestroyed: () => false };
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    handle: (key: string, fn: (...args: any[]) => any) => handlers.set(key, fn),
    removeHandler: (key: string) => handlers.delete(key),
    send() {},
  };
  const context = () => ({
    window,
    ipc,
    getConfig: () => ({ enabled: true }),
    setConfig() {},
  });
  return { requests, handlers, context, window, session };
}

test('actual backend registers NetEase, selects matching duration, preserves real LRC word times and uses owned native transport', async () => {
  const f = fixture();
  await backend.start(f.context());
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    const search = f.handlers.get('synced-lyrics:netease');
    expect(typeof search).toBe('function');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        ipcRenderer: {
          invoke: (name: string, value: unknown) => {
            expect(name).toBe('synced-lyrics:netease');
            expect(value).toEqual(song);
            return search!(value);
          },
        },
      },
    });
    const result = await new NetEase().search({
      ...song,
      title: 'Other title',
      alternativeTitle: song.title,
    });
    expect(result.title).toBe(song.title);
    expect(
      result.lines.find((line: { text: string }) => line.text),
    ).toMatchObject({
      text: 'Owned words',
      timeInMs: 1000,
      words: [
        { timeInMs: 1000, word: 'Owned ' },
        { timeInMs: 1500, word: 'words' },
      ],
    });
    expect(
      f.requests.find((r) => r.endpoint === '/api/song/lyric/v1')?.data.id,
    ).toBe(2);
    expect(
      f.requests.filter((r) => r.endpoint === '/api/register/anonimous'),
    ).toHaveLength(1);
    expect(
      f.requests
        .filter((r) => r.endpoint !== '/api/register/anonimous')
        .every(
          (r) => new Headers(r.init.headers).get('cookie') === 'anon=fixture==',
        ),
    ).toBe(true);
    expect(f.requests.every((r) => !!r.init.signal)).toBe(true);
    expect(f.requests.every((r) => r.init.credentials === 'omit')).toBe(true);
  } finally {
    if (previousWindow)
      Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    backend.stop(f.context());
  }
  expect(f.handlers.has('synced-lyrics:netease')).toBe(false);
});

test('concurrent native requests share anonymous registration and retry a rejected initialization', async () => {
  let reject = true;
  const f = fixture(async (url) => {
    if (url.includes('/register/')) {
      if (reject) return new Response('', { status: 503 });
      return Response.json({ code: 200 });
    }
    if (url.includes('/search/'))
      return Response.json({ code: 200, data: { resources: [] } });
    throw Error('No unmatched lyric fetch');
  });
  await backend.start(f.context());
  try {
    const search = f.handlers.get('synced-lyrics:netease')!;
    expect(typeof search).toBe('function');
    const failures = await Promise.allSettled([search(song), search(song)]);
    expect(failures.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      f.requests.filter((r) => r.endpoint.includes('/register/')),
    ).toHaveLength(1);
    reject = false;
    expect(await Promise.all([search(song), search(song)])).toEqual([
      null,
      null,
    ]);
    expect(
      f.requests.filter((r) => r.endpoint.includes('/register/')),
    ).toHaveLength(2);
  } finally {
    backend.stop(f.context());
  }
});

test('actual provider matches a quoted song title without video decorations obscuring it', async () => {
  const f = fixture();
  await backend.start(f.context());
  try {
    const result = await f.handlers.get('synced-lyrics:netease')!({
      ...song,
      title: 'Owned Artist「Owned Song」(Official MV)',
    });
    expect(result?.title).toBe('Owned Song');
    expect(
      f.requests.some(
        (request) =>
          request.endpoint.includes('/search/') &&
          request.data.keyword === 'Owned Song',
      ),
    ).toBe(true);
  } finally {
    backend.stop(f.context());
  }
});

test('untimed provider lyrics retain the existing plain-text fallback without invented word timing', async () => {
  const f = fixture(async (url) => {
    if (url.includes('/register/')) return Response.json({ code: 200 });
    if (url.includes('/search/'))
      return Response.json({ code: 200, data: { resources: [songRow(2)] } });
    return Response.json({ code: 200, lrc: { lyric: 'Plain owned lyrics' } });
  });
  await backend.start(f.context());
  try {
    const result = await f.handlers.get('synced-lyrics:netease')!(song);
    expect(result?.lyrics).toBe('Plain owned lyrics');
    expect(result?.lines).toBeUndefined();
  } finally {
    backend.stop(f.context());
  }
});

test('an artist prefix cannot make a same-artist self-titled track outrank the actual quoted song', async () => {
  const wrong = songRow(1);
  wrong.baseInfo.simpleSongData.name = song.artist;
  const f = fixture(async (url) => {
    if (url.includes('/register/')) return Response.json({ code: 200 });
    if (url.includes('/search/'))
      return Response.json({
        code: 200,
        data: { resources: [wrong, songRow(2)] },
      });
    return Response.json({
      code: 200,
      lrc: { lyric: '[00:01.00]Owned words' },
    });
  });
  await backend.start(f.context());
  try {
    const result = await f.handlers.get('synced-lyrics:netease')!({
      ...song,
      title: 'Owned Artist「Owned Song」(Official MV)',
    });
    expect(result?.title).toBe(song.title);
  } finally {
    backend.stop(f.context());
  }
});

test('a joint band name remains an exact artist match instead of requiring its split fragments to match alone', async () => {
  const artist = 'Owned & Band';
  const row = songRow(2);
  row.baseInfo.simpleSongData.ar[0].name = artist;
  const f = fixture(async (url) => {
    if (url.includes('/register/')) return Response.json({ code: 200 });
    if (url.includes('/search/'))
      return Response.json({ code: 200, data: { resources: [row] } });
    return Response.json({
      code: 200,
      lrc: { lyric: '[00:01.00]Owned words' },
    });
  });
  await backend.start(f.context());
  try {
    expect(
      (await f.handlers.get('synced-lyrics:netease')!({ ...song, artist }))
        ?.artists,
    ).toEqual([artist]);
  } finally {
    backend.stop(f.context());
  }
});

test('fresh loader stop context retires an in-flight provider and retained handler without publishing or leaking registration into replacement session', async () => {
  let release!: (response: Response) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await backend.start(f.context());
  const search = f.handlers.get('synced-lyrics:netease')!;
  expect(typeof search).toBe('function');
  const pending = search(song).then(
    () => 'published',
    () => 'retired',
  );
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  backend.stop(f.context());
  expect(f.handlers.has('synced-lyrics:netease')).toBe(false);
  expect(f.requests[0].init.signal?.aborted).toBe(true);
  release(
    Response.json(
      { code: 200 },
      { headers: { 'set-cookie': 'obsolete=fixture' } },
    ),
  );
  expect(await pending).toBe('retired');
  await expect(search(song)).rejects.toThrow(/stopped|active|retired/i);
  const replacement = fixture();
  await backend.start(replacement.context());
  try {
    await replacement.handlers.get('synced-lyrics:netease')!(song);
    expect(
      new Headers(replacement.requests[0].init.headers).get('cookie'),
    ).toBeFalsy();
  } finally {
    backend.stop(replacement.context());
  }
});
