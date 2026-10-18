import { test, expect } from '@playwright/test';
import { musicModuleSource } from './helpers/api-music-source';

const videoId = 'abcdefghijk';
const tokenItem = (token: string) => ({
  continuationItemRenderer: {
    continuationEndpoint: { continuationCommand: { token } },
  },
});
const musicStart = (token = 'native-start') => ({
  contents: {
    itemSectionRenderer: {
      sectionIdentifier: 'comment-item-section',
      contents: [tokenItem(token)],
    },
  },
});
const absentMusic = () => ({
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: [
            { tabRenderer: { content: { musicQueueRenderer: {} } } },
            {
              tabRenderer: {
                endpoint: {
                  browseEndpoint: {
                    browseId: 'MPLYknown',
                    browseEndpointContextSupportedConfigs: {
                      browseEndpointContextMusicConfig: {
                        pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS',
                      },
                    },
                  },
                },
              },
            },
            {
              tabRenderer: {
                endpoint: {
                  browseEndpoint: {
                    browseId: 'MPTRknown',
                    browseEndpointContextSupportedConfigs: {
                      browseEndpointContextMusicConfig: {
                        pageType: 'MUSIC_PAGE_TYPE_TRACK_RELATED',
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
});
const legacyThread = (id: string, text = 'Grüezi 🌍\nمرحبا <literal>') => ({
  commentThreadRenderer: {
    comment: {
      commentRenderer: {
        commentId: id,
        authorText: { simpleText: '公開 author' },
        contentText: { runs: [{ text }] },
        publishedTimeText: { simpleText: 'vor 2 Tagen' },
        voteCount: { simpleText: '12' },
        replyCount: 2,
        authorIsChannelOwner: true,
      },
    },
  },
});
const commentPage = (items: any[], token?: string) => ({
  onResponseReceivedEndpoints: [
    {
      reloadContinuationItemsCommand: {
        targetId: 'comments-section',
        continuationItems: [...items, ...(token ? [tokenItem(token)] : [])],
      },
    },
  ],
});
const entityPage = () => ({
  ...commentPage([
    {
      commentThreadRenderer: {
        commentViewModel: {
          commentViewModel: {
            commentKey: 'entity-key',
            commentId: 'entity-1',
            pinnedText: { content: 'Angeheftet' },
          },
        },
      },
    },
  ]),
  frameworkUpdates: {
    entityBatchUpdate: {
      mutations: [
        {
          payload: {
            commentEntityPayload: {
              key: 'entity-key',
              properties: {
                commentId: 'entity-1',
                content: { content: '最新のコメント\nBonjour' },
                publishedTime: 'à l’instant',
              },
              author: {
                displayName: '作者',
                isVerified: true,
                isCreator: false,
              },
              toolbar: { likeCountNotliked: ' 7 ', replyCount: '0' },
            },
          },
        },
      ],
    },
  },
});
const header = {
  commentsHeaderRenderer: {
    countText: { simpleText: '151 commentaires' },
    sortMenu: {
      sortFilterSubMenuRenderer: {
        subMenuItems: [
          {
            title: 'Top-Kommentare',
            selected: true,
            serviceEndpoint: { continuationCommand: { token: 'sort-top' } },
          },
          {
            title: 'Neueste zuerst',
            serviceEndpoint: { continuationCommand: { token: 'sort-newest' } },
          },
        ],
      },
    },
  },
};
let comments: any;
test.beforeAll(async () => {
  comments = await musicModuleSource('src/providers/music-comments.ts');
});

test('COM useful legacy 151 comments preserve localized plaintext and opaque continuation', async () => {
  expect(typeof comments.parseCommentsPage).toBe('function');
  const result = comments.parseCommentsPage(
    commentPage(
      [
        header,
        ...Array.from({ length: 151 }, (_, i) => legacyThread('comment-' + i)),
      ],
      'next-private',
    ),
  );
  expect(result.comments).toHaveLength(151);
  expect(result.comments[0]).toEqual({
    id: 'comment-0',
    author: '公開 author',
    text: 'Grüezi 🌍\nمرحبا <literal>',
    publishedTime: 'vor 2 Tagen',
    likeCount: '12',
    replyCount: '2',
    pinned: false,
    verified: false,
    creator: true,
  });
  expect(result.comments[150].id).toBe('comment-150');
  expect(result.continuation).toBe('next-private');
  expect(result.commentCount).toBe('151 commentaires');
});
test('COM useful entity comments resolve exact keys and retain pinned/verified semantics', () => {
  expect(typeof comments.parseCommentsPage).toBe('function');
  expect(comments.parseCommentsPage(entityPage()).comments).toEqual([
    {
      id: 'entity-1',
      author: '作者',
      text: '最新のコメント\nBonjour',
      publishedTime: 'à l’instant',
      likeCount: '7',
      replyCount: '0',
      pinned: true,
      verified: true,
      creator: false,
    },
  ]);
});
test('COM known native absence differs from malformed, unknown and network failures', async () => {
  expect(typeof comments.loadComments).toBe('function');
  expect(
    await comments.loadComments(async () => absentMusic(), {
      videoId,
      sort: 'top',
      source: 'music',
    }),
  ).toMatchObject({
    available: false,
    comments: [],
    continuation: null,
    requests: 1,
  });
  for (const raw of [{}, { contents: {} }, { error: { code: 500 } }])
    await expect(
      comments.loadComments(async () => raw, {
        videoId,
        sort: 'top',
        source: 'music',
      }),
    ).rejects.toThrow();
  await expect(
    comments.loadComments(
      async () => {
        throw Error('network');
      },
      { videoId, sort: 'top', source: 'music' },
    ),
  ).rejects.toThrow('network');
});
test('COM newest uses bound sort continuation without localized-title matching', async () => {
  expect(typeof comments.loadComments).toBe('function');
  const calls: any[] = [],
    responses = [
      musicStart(),
      commentPage([header, legacyThread('older')]),
      entityPage(),
    ];
  const result = await comments.loadComments(
    async (body: any) => {
      calls.push(body);
      return responses.shift();
    },
    { videoId, sort: 'newest', source: 'music' },
  );
  expect(calls).toEqual([
    { videoId },
    { continuation: 'native-start' },
    { continuation: 'sort-newest' },
  ]);
  expect(result.comments.map((row: any) => row.id)).toEqual(['entity-1']);
  expect(result.available).toBe(true);
  expect(result.requests).toBe(3);
});

import { musicRequestFixture } from './helpers/api-music-request';

test('COM main-owned public work shares physical four/window two/principal FIFO and cancellation tombstones', async () => {
  const f = await musicRequestFixture();
  try {
    expect(typeof f.broker.runOwned).toBe('function');
    const pending: { resolve(value: any): void }[] = [],
      starts: string[] = [];
    const run = (principal: string, signal?: AbortSignal) =>
      f.broker.runOwned(
        f.broker.capture(),
        principal,
        async () => {
          starts.push(principal);
          return new Promise((resolve) => pending.push({ resolve }));
        },
        { signal },
      );
    const abort = new AbortController();
    const a = run('a', abort.signal),
      b = run('a'),
      c = run('a'),
      d = run('b');
    await Promise.resolve();
    expect(starts).toEqual(['a', 'a']);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 2 });
    const canceled = expect(a).rejects.toMatchObject({ code: 'retired' });
    abort.abort();
    await canceled;
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 2 });
    pending[0].resolve({
      version: 1,
      binding: { videoId, playbackEpoch: null },
      comments: {
        available: true,
        comments: [],
        commentCount: null,
        continuation: null,
      },
      requests: 1,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(starts).toEqual(['a', 'a', 'a', 'b']);
    expect(f.broker.stats()).toEqual({ dispatched: 3, queued: 0 });
    for (const item of pending.slice(1))
      item.resolve({
        version: 1,
        binding: { videoId, playbackEpoch: null },
        comments: {
          available: true,
          comments: [],
          commentCount: null,
          continuation: null,
        },
        requests: 1,
      });
    await Promise.all([b, c, d]);
    expect(f.sent).toHaveLength(0);
  } finally {
    f.broker.dispose();
  }
});

test('COM main-owned unabortable work stays physically held through renderer termination', async () => {
  const f = await musicRequestFixture();
  try {
    expect(typeof f.broker.runOwned).toBe('function');
    let resolve!: (value: any) => void,
      settled = 0;
    const run = f.broker.runOwned(
      f.broker.capture(),
      'a',
      () => new Promise((yes) => (resolve = yes)),
      { onPhysicalSettled: () => settled++ },
    );
    const denied = expect(run).rejects.toMatchObject({ code: 'retired' });
    f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await denied;
    expect(f.broker.stats().dispatched).toBe(1);
    expect(settled).toBe(0);
    resolve({
      version: 1,
      binding: { videoId, playbackEpoch: null },
      comments: {
        available: false,
        comments: [],
        commentCount: null,
        continuation: null,
      },
      requests: 1,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(f.broker.stats().dispatched).toBe(0);
    expect(settled).toBe(1);
  } finally {
    f.broker.dispose();
  }
});

test('COM bounded parser rejects unproven empty, dangling entities, getter execution and comment byte overflow', () => {
  let calls = 0;
  const getter = commentPage([legacyThread('safe')]);
  Object.defineProperty(
    (getter as any).onResponseReceivedEndpoints[0],
    'hidden',
    {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    },
  );
  for (const bad of [
    {
      onResponseReceivedEndpoints: [
        { reloadContinuationItemsCommand: { continuationItems: [] } },
      ],
    },
    commentPage([
      {
        commentThreadRenderer: {
          commentViewModel: { commentViewModel: { commentKey: 'missing' } },
        },
      },
    ]),
    getter,
    commentPage([legacyThread('long', '€'.repeat(1366))]),
  ])
    expect(() => comments.parseCommentsPage(bad)).toThrow();
  expect(calls).toBe(0);
});

test('COM authenticated source retirement logically cancels main work without physical release', async () => {
  const f = await musicRequestFixture();
  let resolve!: (value: any) => void;
  try {
    const native = f.read();
    f.ready();
    f.settled();
    const value = await native;
    const owner = f.broker.resultOwner(value);
    let retired = false;
    const main = f.broker.runOwned(
      f.broker.capture(),
      'a',
      () => new Promise((yes) => (resolve = yes)),
      { isCurrent: () => owner.current() },
    );
    main.catch(() => (retired = true));
    f.emit({
      type: 'retire',
      documentId: '1'.repeat(32),
      sourceId: '2'.repeat(32),
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(retired).toBe(true);
    expect(f.broker.stats().dispatched).toBe(1);
    resolve(value);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(f.broker.stats().dispatched).toBe(0);
  } finally {
    resolve?.({});
    f.broker.dispose();
  }
});

import { createServer } from 'node:http';
test('COM public WEB transport uses owned socket with literal context and no credentials', async () => {
  const transport = await musicModuleSource(
    'src/plugins/api-server/backend/music-comments-web.ts',
  );
  expect(typeof transport.createPublicCommentsWeb).toBe('function');
  const calls: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(musicStart('web-private')));
    });
  });
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  try {
    const client = transport.createPublicCommentsWeb({
      testPort: (server.address() as any).port,
    });
    expect(
      await client.request(
        { videoId },
        { signal: new AbortController().signal, deadline: Date.now() + 15000 },
      ),
    ).toEqual(musicStart('web-private'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/youtubei/v1/next?prettyPrint=false',
      method: 'POST',
      body: {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250925.01.00',
            hl: 'en',
          },
        },
        videoId,
      },
    });
    expect(calls[0].headers.cookie).toBeUndefined();
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers['proxy-authorization']).toBeUndefined();
  } finally {
    await new Promise<void>((yes) => server.close(() => yes()));
  }
});

import { musicRendererFixture } from './helpers/api-music-renderer';
import { musicHttpFixture } from './helpers/api-music-http';
test('COM actual renderer performs native next/start/newest recipe and returns useful entities', async () => {
  const f = await musicRendererFixture();
  try {
    const packet = f.read(f.query(), {
      operation: 'comments',
      target: { videoId },
      sort: 'newest',
      deadlineAt: Date.now() + 15000,
    });
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0]).toMatchObject({ url: '/next', data: { videoId } });
    f.fetches[0].resolve(musicStart());
    for (let i = 0; i < 8; i++) await f.flush();
    expect(f.fetches[1]).toMatchObject({
      url: '/next',
      data: { continuation: 'native-start' },
    });
    f.fetches[1].resolve(commentPage([header, legacyThread('older')]));
    for (let i = 0; i < 8; i++) await f.flush();
    expect(f.fetches[2]).toMatchObject({
      url: '/next',
      data: { continuation: 'sort-newest' },
    });
    f.fetches[2].resolve(entityPage());
    for (let i = 0; i < 8; i++) await f.flush();
    expect(f.result(packet)).toMatchObject({
      ok: true,
      value: {
        version: 1,
        binding: { videoId, playbackEpoch: null },
        requests: 3,
        comments: {
          available: true,
          comments: [{ id: 'entity-1', text: '最新のコメント\nBonjour' }],
        },
      },
    });
  } finally {
    f.close();
  }
});
test('COM HTTP comments.read returns 100+51 local remainder without prefetch', async () => {
  const f = await musicHttpFixture();
  try {
    const grant = await f.store.issue(
      'Comments',
      'rest',
      f.service.resource,
      ['comments.read'],
      () => true,
    );
    const headers = { authorization: 'Bearer ' + grant.token },
      frame = {};
    (f.service as any).broker.capture = () => ({ frame, generation: 0 });
    f.setHold();
    const pending = f.http(
      '/api/v1/music/song/comments?videoId=abcdefghijk&limit=100',
      'GET',
      undefined,
      headers,
    );
    await expect.poll(() => f.calls.length).toBe(1);
    expect(f.calls[0].input).toMatchObject({
      operation: 'comments',
      target: { videoId },
      sort: 'top',
    });
    f.calls[0].resolve({
      version: 1,
      binding: { videoId, playbackEpoch: null },
      requests: 2,
      comments: {
        available: true,
        comments: Array.from({ length: 151 }, (_, i) => ({
          id: 'c-' + i,
          author: '作者',
          text: 'Literal ' + i,
          publishedTime: null,
          likeCount: null,
          replyCount: null,
          pinned: false,
          verified: false,
          creator: false,
        })),
        commentCount: '151',
        continuation: null,
      },
    });
    const first = await pending;
    expect(first.status).toBe(200);
    expect(first.body.comments).toHaveLength(100);
    expect(first.body.source).toBe('music');
    expect(first.body.nextCursor).toMatch(/^mcur_/);
    const next = await f.http(
      '/api/v1/music/song/comments?cursor=' +
        first.body.nextCursor +
        '&limit=100',
      'GET',
      undefined,
      headers,
    );
    expect(next.status).toBe(200);
    expect(next.body.comments).toHaveLength(51);
    expect(next.body.comments[0].id).toBe('c-100');
    expect(next.body.nextCursor).toBeNull();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

import { EventEmitter } from 'node:events';
import { Window } from 'happy-dom';
import { build } from 'vite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { request as nodeRequest } from 'node:http';
let combined: any, commentsIpc: EventEmitter;
async function combinedCommentsSource() {
  if (combined) return combined;
  const root = path.resolve(import.meta.dirname, '..'),
    owned = await mkdtemp(path.join(tmpdir(), 'pear-com-source-'));
  commentsIpc = new EventEmitter();
  (globalThis as any).__comElectron = { ipcMain: commentsIpc };
  try {
    const entry = path.join(owned, 'entry.ts'),
      electron = path.join(owned, 'electron.ts');
    await writeFile(
      electron,
      'export const ipcMain=globalThis.__comElectron.ipcMain;',
    );
    await writeFile(
      entry,
      [
        'src/plugins/api-server/backend/music-service.ts',
        'src/plugins/api-server/backend/music-grant-store.ts',
        'src/plugins/api-server/backend/music-comments-web.ts',
        'src/plugins/api-server/backend/routes/music.ts',
        'src/providers/music-renderer.ts',
        'src/providers/music-request.ts',
      ]
        .map(
          (file) => `export * from ${JSON.stringify(path.join(root, file))};`,
        )
        .join('\n'),
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: { '@': path.join(root, 'src'), electron } },
      ssr: { noExternal: true },
      build: {
        ssr: entry,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'actual.mjs' } },
      },
    });
    combined = await import(pathToFileURL(path.join(owned, 'actual.mjs')).href);
    return combined;
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}
async function commentsSocketFixture(
  nativeReplies: any[],
  webReplies: any[] = [],
) {
  const source = await combinedCommentsSource(),
    dom = new Window(),
    w = dom as any;
  const saved = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
  };
  Object.assign(globalThis, { window: w, document: dom.document });
  dom.document.body.innerHTML =
    '<ytmusic-app></ytmusic-app><div id="movie_player"></div>';
  const app = dom.document.querySelector('ytmusic-app') as any,
    api = dom.document.querySelector('#movie_player') as any;
  let video = 'current0001';
  const nativeEvents = new Map<string, any>(),
    nativeCalls: any[] = [],
    webCalls: any[] = [];
  api.getVideoData = () => ({ video_id: video });
  api.getPlayerResponse = () => ({ videoDetails: { videoId: video } });
  api.addEventListener = (name: string, callback: any) =>
    nativeEvents.set(name, callback);
  api.removeEventListener = (name: string) => nativeEvents.delete(name);
  app.networkManager = {
    fetch: async function (url: string, data: any) {
      nativeCalls.push({ url, data, receiver: this === app.networkManager });
      if (!nativeReplies.length) throw Error('Unexpected native request');
      const reply = nativeReplies.shift();
      return typeof reply === 'function' ? reply() : reply;
    },
  };
  const provider = createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      const call = {
        url: req.url,
        headers: req.headers,
        body: JSON.parse(text),
      };
      webCalls.push(call);
      const next = webReplies.shift();
      if (typeof next === 'function') next(req, res);
      else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(next));
      }
    });
  });
  await new Promise<void>((yes) => provider.listen(0, '127.0.0.1', yes));
  const listeners = new Map<string, any>(),
    contents = new EventEmitter() as any,
    window = new EventEmitter() as any,
    frame = {};
  contents.mainFrame = frame;
  contents.isDestroyed = () => false;
  window.webContents = contents;
  window.isDestroyed = () => false;
  contents.send = (name: string, packet: any) => listeners.get(name)?.(packet);
  const renderer = source.createMusicRendererController(api, () => api, {
    send: (name: string, packet: any) =>
      commentsIpc.emit(name, { sender: contents, senderFrame: frame }, packet),
    subscribe: (name: string, callback: any) => {
      listeners.set(name, callback);
      return () => listeners.delete(name);
    },
  });
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-com-socket-')),
    store = new source.MusicGrantStore(path.join(folder, 'grants'));
  const config = {
    enabled: true,
    musicApiEnabled: true,
    hostname: '127.0.0.1',
    port: 26538,
    useHttps: false,
  };
  const service = source.createMusicService({
    window,
    config,
    grants: store,
    commentsWeb: source.createPublicCommentsWeb({
      testPort: (provider.address() as any).port,
    }),
  });
  const appHttp = new Hono();
  const httpLifetime = new AbortController();
  const httpSockets = new WeakSet<object>();
  let httpOwner: any;
  source.registerMusicRoutes(
    appHttp,
    () => service,
    () => httpOwner,
  );
  const server = serve({
    fetch: appHttp.fetch,
    hostname: '127.0.0.1',
    port: 0,
  });
  server.on('connection', (socket: object) => httpSockets.add(socket));
  server.once('close', () => httpLifetime.abort());
  server.on('error', () => httpLifetime.abort());
  await new Promise<void>((yes) => server.once('listening', yes));
  const port = (server.address() as any).port;
  service.configure({ ...config, port });
  httpOwner = {
    identity: {},
    address: (server.address() as { address: string }).address,
    port,
    tls: false,
    resources: Object.freeze({ local: service.resource }),
    signal: httpLifetime.signal,
    current: () => true && !httpLifetime.signal.aborted && server.listening,
    ownsSocket: (socket: object) => httpSockets.has(socket),
  };
  const grant = await store.issue(
    'COM socket',
    'rest',
    service.resource,
    ['comments.read'],
    () => true,
  );
  const http = (query: string, token = grant.token) =>
    new Promise<any>((resolve, reject) => {
      const req = nodeRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/music/song/comments?' + query,
          headers: { authorization: 'Bearer ' + token },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(text) }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  return {
    source,
    service,
    store,
    grant,
    contents,
    window,
    renderer,
    nativeCalls,
    webCalls,
    http,
    setVideo(value: string) {
      video = value;
      nativeEvents.get('videodatachange')?.();
    },
    async close() {
      service.stop();
      renderer.dispose();
      await new Promise<void>((yes) => server.close(() => yes()));
      provider.closeAllConnections();
      await new Promise<void>((yes) => provider.close(() => yes()));
      Object.assign(globalThis, saved);
      dom.happyDOM.abort();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test('COM actual REST/native absence switches only after explicit WEB consent and retains WEB cursor issuer', async () => {
  const first = commentPage([header, legacyThread('web-first')], 'web-next'),
    next = commentPage([legacyThread('web-second')]);
  const f = await commentsSocketFixture(
    [absentMusic(), absentMusic()],
    [musicStart('web-start'), first, next],
  );
  try {
    const none = await f.http('videoId=abcdefghijk');
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({
      source: 'music',
      available: false,
      comments: [],
      nextCursor: null,
    });
    expect(f.webCalls).toHaveLength(0);
    const page = await f.http(
      'videoId=abcdefghijk&allowPublicWebFallback=true',
    );
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      source: 'public-web',
      available: true,
      comments: [{ id: 'web-first' }],
    });
    expect(f.webCalls.map((c) => c.body)).toEqual([
      {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250925.01.00',
            hl: 'en',
          },
        },
        videoId,
      },
      {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250925.01.00',
            hl: 'en',
          },
        },
        continuation: 'web-start',
      },
    ]);
    const more = await f.http('cursor=' + page.body.nextCursor);
    expect(more.status).toBe(200);
    expect(more.body).toMatchObject({
      source: 'public-web',
      comments: [{ id: 'web-second' }],
      nextCursor: null,
    });
    expect(f.webCalls[2].body.continuation).toBe('web-next');
    expect(f.nativeCalls).toHaveLength(2);
    expect(
      f.webCalls.every(
        (call) =>
          call.headers.cookie === undefined &&
          call.headers.authorization === undefined,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
for (const failure of ['malformed', 'network'] as const)
  test(`COM native ${failure} never falls back or becomes empty success`, async () => {
    const f = await commentsSocketFixture([
      failure === 'network'
        ? () => {
            throw Error('private network error');
          }
        : {},
    ]);
    try {
      const result = await f.http(
        'videoId=abcdefghijk&allowPublicWebFallback=true',
      );
      expect(result.status).toBe(502);
      expect(result.body.error.code).toMatch(/source|unsupported/);
      expect(f.webCalls).toHaveLength(0);
      expect(JSON.stringify(result.body)).not.toContain(
        'private network error',
      );
    } finally {
      await f.close();
    }
  });

test('COM one bounded thousand-comment native source yields every local remainder without duplicated cache saturation', async () => {
  const f = await commentsSocketFixture([
    musicStart(),
    commentPage(
      Array.from({ length: 1000 }, (_, i) =>
        legacyThread('large-' + i, 'x'.repeat(500)),
      ),
    ),
  ]);
  try {
    let result = await f.http('videoId=abcdefghijk&limit=100'),
      ids: string[] = [];
    for (let page = 0; page < 10; page++) {
      expect(
        result.status,
        'page ' +
          page +
          ': ' +
          (result.status === 200 ? 'supported' : JSON.stringify(result.body)),
      ).toBe(200);
      expect(result.body.comments).toHaveLength(100);
      ids.push(...result.body.comments.map((row: any) => row.id));
      if (result.body.nextCursor)
        result = await f.http(
          'cursor=' + result.body.nextCursor + '&limit=100',
        );
      else break;
    }
    expect(ids).toEqual(Array.from({ length: 1000 }, (_, i) => 'large-' + i));
    expect(result.body.nextCursor).toBeNull();
    expect(f.nativeCalls).toHaveLength(2);
    expect(f.webCalls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

// Synthetic public test key/certificate: loopback fixture only; no account credential.
const TLS_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCIBRKKMXYX711k\nIXvzk9KbIEhZ3owFREfg70CSvfncFbmkb1lfvfTQ3Ui+ve9XD+GDEO4GyHnkerFH\nhXI/+ATJ8dpVVklpBUiHcUDympz7PongDvOdY2ni7ilSKYZkUsdqu3STcyMFPAym\nPOxKt9rvLeReDi4Mex4pdnAC/HEbh+ldjCX5FdojGikZTDuuHZqJC2sqbGRy+Tag\npSJuO7viwJ3C6ppGVpXDiQelDnR5yjHX6P898ZYMiqZqXwKNvUUxgCeD8h39Pfp/\nj+14rTt3BUbBVsQ1lx/u+GITrhkFPulpZFUugG0rPQLuelpMIMn+QrTK2jkWw9TH\nhLrfkt1/AgMBAAECggEAJrYq3KHPFmjNj53oBR7hJb0+WjV4bFdOjboKCrl+zyBv\nwVjfetw5POh9t6ue3oxqhj7fP5b2+gvhQJW+Om6ADmmC1h7ErdsPFV0qOuG+I9Nc\nsiQPOY/9ptRZdkTTNuJIVxwaxYxTPz4j63wTVACXktLg19P5TxwLLYnDv1XRayAN\nE/m6U553bIGErpOqp2LuVtP02KRhPAWOzBpLuslpI0h20MdYbYE7i1Crpr7QeoNT\njznHMPsuaJXHwAHbOPgIuDI2haIaklkWkiZlNBG7d7RuerueqwRRh1HktX1iquBV\nbbdxroI8+IxJ1XjDwBaPVZDsoKN1ogx44Ex6rGyRQQKBgQC9dCAqSHR1FP7daoiH\ntSzvpLJZC3zOHpvb3in0M9nI16Y+QMlelgR+fF04FtezQZ3ZPP26/oYTd1X8tslD\nC4/gv/5/aB+evk8Isy2xOmGcL7ctZk1WR8e1zwYIxmtlZ1YkgaNOy3lCvhWqNwyd\n5MumwYg5Xv1p3cxriDYMIYYVRwKBgQC3zB8XV1oJmvfCRBaj9FyT62YIHutHfLui\nb8lOVHHRDPKYsoWvIeL1V5VX4YTHWZw0VgA0kDNbAMC1ewP/l9+FRUWA6XhZFX0D\niqejXfzKr1etNqn+Vdwy5mtLM229xREd3tkiagBdgBO25rePX6ty5VLa7SbIqy9e\nh/oKW8nyCQKBgADg+QU5MNEaN9RvGhMHFB5IdUtUck/CdJaggTFQzEHSPkMrqcN2\njq7HhOcts/Jw63qGfebQJ28PrqZtcqGM/C3eth+BLCRgXZ18t0mLK8i9r+vV/aXY\nz2RYgX6o7PabdBrXPxqudvGIUDFp7/ULiqZLX4ZkmmhTTw9wok+MGEMhAoGBAKuI\niYvTLmjAhHJ98VNa//vdOgBiOtshAkz7XzkHfqHIH7F7C2EDkzm+X9cA1lbmvu3p\nRY/I9OT9stysznKAX0+V8uP5ASTC9UWU5heF5COVuZIi7kw7/aJTgddRTB5MCUmD\nbcq8e1LH8Z5FfRMGCpDUjZtcsVGe0jq7VRTNzY9hAoGAbnbCD3nkgcKPoa2HkOVV\n/Q359IZhiJqByzPeOFkxkeHhab55EROzORZ/1RCYU0PLwtAVNgrQANOzQ4IEc+hh\nPYMXzamO2qvS8adGU7w0KN1wrNVb36wyFqgxmW7UPUybM4zREW+YGOmnbHvRnrF6\nyJPwMfeg7r0Wcpa3CQ3Wuo8=\n-----END PRIVATE KEY-----\n';
const TLS_CERT =
  '-----BEGIN CERTIFICATE-----\nMIIDJzCCAg+gAwIBAgIUHQbhmZaI+CkUdt69QzwPKN1ODugwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxNTE2MTczNloYDzIxMjYw\nOTIxMTYxNzM2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB\nAQUAA4IBDwAwggEKAoIBAQCIBRKKMXYX711kIXvzk9KbIEhZ3owFREfg70CSvfnc\nFbmkb1lfvfTQ3Ui+ve9XD+GDEO4GyHnkerFHhXI/+ATJ8dpVVklpBUiHcUDympz7\nPongDvOdY2ni7ilSKYZkUsdqu3STcyMFPAymPOxKt9rvLeReDi4Mex4pdnAC/HEb\nh+ldjCX5FdojGikZTDuuHZqJC2sqbGRy+TagpSJuO7viwJ3C6ppGVpXDiQelDnR5\nyjHX6P898ZYMiqZqXwKNvUUxgCeD8h39Pfp/j+14rTt3BUbBVsQ1lx/u+GITrhkF\nPulpZFUugG0rPQLuelpMIMn+QrTK2jkWw9THhLrfkt1/AgMBAAGjbzBtMB0GA1Ud\nDgQWBBS0M2M9dgJLC5UyaHUsSLJzSN6sAzAfBgNVHSMEGDAWgBS0M2M9dgJLC5Uy\naHUsSLJzSN6sAzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z\ndIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAB6I4iHJS+qd40n6XZScJ/v77ZTe/\nnORYjl0pUuXK9b0qgEjYCXmba3mReiWjmNe5vp8m4XqhL6drVbtNFG1W45WuKiP/\n5L6VUmfNDztsazSBILEruX0yMFq6GhrK4dllulOnU5XaNcx6BBr3TouVARpBDBLO\nkiGzJiyniw0JBneyLvHoa3UkYjXWNqsLQzme+1dtM5IhXbX1xSXc+0UC8DyP9GDy\nKkswNntSs98JlFZbdig6n/fllaJzWgOraw5lnM72ETj45vO0Gv8NObH/8GgSUx1+\n3WrrJcEuItf4dDojjJFYWEJ6KiajGfnL5afdNCo4C2fx2ngb8WGwYqaxZQ==\n-----END CERTIFICATE-----\n';

import { createServer as createTlsServer } from 'node:https';
test('COM owned TLS transport preserves split UTF8 and omits credentials', async () => {
  const source = await combinedCommentsSource(),
    calls: any[] = [];
  const server = createTlsServer(
    { key: TLS_KEY, cert: TLS_CERT },
    (req, res) => {
      calls.push({
        headers: req.headers,
        encrypted: (req.socket as any).encrypted,
      });
      req.resume();
      req.on('end', () => {
        const bytes = Buffer.from(JSON.stringify({ text: '€ 🌍 日本語' }));
        const euro = bytes.indexOf(Buffer.from('€'));
        res.write(bytes.subarray(0, euro + 1));
        setImmediate(() => res.end(bytes.subarray(euro + 1)));
      });
    },
  );
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  try {
    const client = source.createPublicCommentsWeb({
      testPort: (server.address() as any).port,
      testCa: TLS_CERT,
    });
    expect(
      await client.request(
        { videoId },
        { signal: new AbortController().signal, deadline: Date.now() + 15000 },
      ),
    ).toEqual({ text: '€ 🌍 日本語' });
    expect(calls).toEqual([
      {
        encrypted: true,
        headers: expect.not.objectContaining({
          cookie: expect.anything(),
          authorization: expect.anything(),
        }),
      },
    ]);
    expect(calls[0].headers.cookie).toBeUndefined();
    expect(calls[0].headers.authorization).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
  }
});
for (const mode of [
  'redirect',
  'overflow',
  'invalid UTF8',
  'network',
  'deadline',
] as const)
  test(`COM owned WEB ${mode} fails closed without retry or empty success`, async () => {
    const source = await combinedCommentsSource();
    let calls = 0,
      closed = false;
    const server = createServer((req, res) => {
      calls++;
      req.resume();
      res.on('close', () => (closed = true));
      req.on('end', () => {
        if (mode === 'redirect') {
          res.writeHead(302, { Location: '/must-not-follow' });
          res.end('{}');
        }
        if (mode === 'overflow') {
          res.write('{"padding":"');
          res.write(Buffer.alloc(600 * 1024, 120));
          setImmediate(() => res.end(Buffer.alloc(500 * 1024, 120)));
        }
        if (mode === 'invalid UTF8')
          res.end(Buffer.from([123, 34, 120, 34, 58, 34, 195, 40, 34, 125]));
        if (mode === 'network') res.destroy();
        if (mode === 'deadline') res.write('{"waiting":');
      });
    });
    await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
    try {
      const client = source.createPublicCommentsWeb({
        testPort: (server.address() as any).port,
      });
      await expect(
        client.request(
          { videoId },
          {
            signal: new AbortController().signal,
            deadline: Date.now() + (mode === 'deadline' ? 40 : 15000),
          },
        ),
      ).rejects.toMatchObject({
        code:
          mode === 'overflow'
            ? 'budget'
            : mode === 'deadline'
              ? 'timeout'
              : 'source',
      });
      await expect.poll(() => closed).toBe(true);
      expect(calls).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((yes) => server.close(() => yes()));
    }
  });
test('COM owned WEB cancellation waits request close and releases its socket', async () => {
  const source = await combinedCommentsSource(),
    controller = new AbortController();
  let start!: () => void,
    closed = false;
  const started = new Promise<void>((yes) => (start = yes));
  const server = createServer((req, res) => {
    req.resume();
    res.on('close', () => (closed = true));
    req.on('end', () => {
      res.write('{"waiting":');
      start();
    });
  });
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  try {
    const client = source.createPublicCommentsWeb({
      testPort: (server.address() as any).port,
    });
    const running = client.request(
      { videoId },
      { signal: controller.signal, deadline: Date.now() + 15000 },
    );
    const check = expect(running).rejects.toMatchObject({ code: 'retired' });
    await started;
    controller.abort();
    await check;
    await expect.poll(() => closed).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
  }
});
test('COM WEB only accepts one owned video/token body and bounded test port', async () => {
  const source = await combinedCommentsSource();
  expect(() => source.createPublicCommentsWeb({ testPort: 0 })).toThrow();
  const client = source.createPublicCommentsWeb({ testPort: 65534 });
  for (const body of [
    { videoId, url: 'https://invalid.test' },
    { endpoint: '/browse' },
    { continuation: 99 },
    { videoId: 'https://invalid.test' },
  ])
    await expect(
      client.request(body, {
        signal: new AbortController().signal,
        deadline: Date.now() + 15000,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
});

test('COM malformed sort/header, orphan entity and conflicting continuation video do not become supported empty/wrong data', async () => {
  const malformedSort = commentPage([
    {
      commentsHeaderRenderer: {
        ...header.commentsHeaderRenderer,
        sortMenu: {
          sortFilterSubMenuRenderer: {
            subMenuItems: [
              {
                selected: 'true',
                serviceEndpoint: { continuationCommand: { token: 'top' } },
              },
              { serviceEndpoint: { continuationCommand: { token: 'newest' } } },
            ],
          },
        },
      },
    },
    legacyThread('one'),
  ]);
  const orphan = entityPage();
  (orphan as any).onResponseReceivedEndpoints = commentPage([
    header,
  ]).onResponseReceivedEndpoints;
  for (const raw of [
    malformedSort,
    orphan,
    commentPage([{ commentsHeaderRenderer: {} }]),
  ])
    expect(() => comments.parseCommentsPage(raw)).toThrow();
  const foreign = {
      ...commentPage([legacyThread('wrong')]),
      currentVideoEndpoint: { watchEndpoint: { videoId: 'bbbbbbbbbbb' } },
    },
    responses = [musicStart(), foreign];
  await expect(
    comments.loadComments(async () => responses.shift(), {
      videoId,
      sort: 'top',
      source: 'music',
    }),
  ).rejects.toThrow();
});

test('COM actual native continuation remains music even when initial caller allowed WEB', async () => {
  const f = await commentsSocketFixture([
    musicStart(),
    commentPage([legacyThread('native-first')], 'native-next'),
    entityPage(),
  ]);
  try {
    const first = await f.http(
      'videoId=abcdefghijk&allowPublicWebFallback=true',
    );
    expect(first.status).toBe(200);
    expect(first.body.source).toBe('music');
    expect(JSON.stringify(first.body)).not.toContain('native-next');
    const second = await f.http('cursor=' + first.body.nextCursor);
    expect(second.status).toBe(200);
    expect(second.body.comments[0].id).toBe('entity-1');
    expect(second.body.source).toBe('music');
    expect(f.nativeCalls.map((call) => call.data)).toEqual([
      { videoId },
      { continuation: 'native-start' },
      { continuation: 'native-next' },
    ]);
    expect(f.webCalls).toHaveLength(0);
    const replay = await f.http('cursor=' + first.body.nextCursor);
    expect(replay).toEqual(second);
    expect(f.nativeCalls).toHaveLength(3);
  } finally {
    await f.close();
  }
});
for (const mode of ['current ABA', 'explicit playback change'] as const)
  test(`COM ${mode} preserves target ownership across deferred native fetch`, async () => {
    let resolve!: (value: any) => void;
    const f = await commentsSocketFixture([
      () => new Promise((yes) => (resolve = yes)),
      commentPage([legacyThread('bound')]),
    ]);
    try {
      const running = f.http(
        mode === 'current ABA'
          ? 'current=true&allowPublicWebFallback=true'
          : 'videoId=abcdefghijk',
      );
      await expect.poll(() => f.nativeCalls.length).toBe(1);
      f.setVideo('bbbbbbbbbbb');
      f.setVideo('current0001');
      resolve(musicStart());
      const result = await running;
      if (mode === 'current ABA') {
        expect(result.status).toBe(409);
        expect(f.nativeCalls).toHaveLength(1);
        expect(f.webCalls).toHaveLength(0);
      } else {
        expect(result.status).toBe(200);
        expect(result.body.videoId).toBe(videoId);
        expect(result.body.comments[0].id).toBe('bound');
      }
    } finally {
      resolve?.(absentMusic());
      await f.close();
    }
  });
test('COM real comments cursors bind grant, frame, sort/source, limit and current episode', async () => {
  const f = await commentsSocketFixture([
    musicStart(),
    commentPage([legacyThread('one'), legacyThread('two')]),
  ]);
  try {
    const first = await f.http('current=true&limit=1');
    expect(first.status).toBe(200);
    const foreign = await f.store.issue(
      'Foreign comments',
      'rest',
      f.service.resource,
      ['comments.read'],
      () => true,
    );
    const other = await f.http(
      'cursor=' + first.body.nextCursor + '&limit=1',
      foreign.token,
    );
    expect(other.status).toBe(404);
    expect(
      (await f.http('cursor=' + first.body.nextCursor + '&limit=2')).status,
    ).toBe(400);
    expect(
      (await f.http('cursor=' + first.body.nextCursor + '&limit=1&sort=newest'))
        .status,
    ).toBe(400);
    f.setVideo('bbbbbbbbbbb');
    f.setVideo('current0001');
    const stale = await f.http('cursor=' + first.body.nextCursor + '&limit=1');
    expect(stale.status).toBe(409);
    expect(f.nativeCalls).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test('COM unauthorized/legacy grants and malformed selectors never read provider state', async () => {
  const f = await commentsSocketFixture([]);
  try {
    const readOnly = await f.store.issue(
      'Catalog only',
      'rest',
      f.service.resource,
      ['catalog.read'],
      () => true,
    );
    expect((await f.http('videoId=abcdefghijk', readOnly.token)).status).toBe(
      403,
    );
    expect((await f.http('videoId=abcdefghijk', 'NONE')).status).toBe(401);
    expect(
      (await f.http('videoId=abcdefghijk', 'legacy.jwt.token')).status,
    ).toBe(401);
    for (const query of [
      'videoId=abcdefghijk&current=true',
      'videoId=abcdefghijk&sort=oldest',
      'videoId=abcdefghijk&limit=101',
      'videoId=abcdefghijk&limit=01',
      'videoId=abcdefghijk&allowPublicWebFallback=1',
      'cursor=web:unissued',
      'videoId=abcdefghijk&url=https://invalid.test',
      'videoId=abcdefghijk&videoId=bbbbbbbbbbb',
      'videoId=%61bcdefghijk',
    ])
      expect((await f.http(query)).status, query).toBe(400);
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.webCalls).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('COM native grant editor independently selects comments.read and no fallback setting', async () => {
  const source = await musicModuleSource(
    'src/plugins/api-server/music-menu.ts',
  );
  const calls: any[] = [],
    choices = [8, 2, 0];
  const service = {
    resource: 'http://127.0.0.1:26538/api/v1/music',
    captureNativeOwner: () => ({ current: () => true }),
    grants: {
      issue: async (...args: any[]) => {
        calls.push(args);
        return { token: 'synthetic', record: { id: 'owned' } };
      },
      revoke: async () => {},
    },
  };
  const menu = await source.createMusicGrantMenu(
    {
      getConfig: async () => ({ enabled: true, musicApiEnabled: true }),
      setConfig() {
        throw Error('No settings write');
      },
    },
    () => service,
    {
      prompt: async () => 'Comments',
      show: async () => ({ response: choices.shift() }),
      copy() {},
    },
  );
  await menu.find((item: any) => item.label === 'Create client grant…').click();
  expect(calls[0].slice(0, 4)).toEqual([
    'Comments',
    'rest',
    service.resource,
    ['comments.read'],
  ]);
});
test('COM current WEB fallback rechecks playback episode after owned HTTP completion', async () => {
  let send!: () => void;
  const f = await commentsSocketFixture(
    [absentMusic()],
    [
      (_req: any, res: any) => {
        send = () => res.end(JSON.stringify(musicStart('web-first')));
      },
      commentPage([legacyThread('web')]),
    ],
  );
  try {
    const running = f.http('current=true&allowPublicWebFallback=true');
    await expect.poll(() => f.webCalls.length).toBe(1);
    expect(f.source.createMusicRequestBroker(f.window).stats().dispatched).toBe(
      1,
    );
    f.setVideo('bbbbbbbbbbb');
    f.setVideo('current0001');
    expect(f.source.createMusicRequestBroker(f.window).stats().dispatched).toBe(
      1,
    );
    send();
    const result = await running;
    expect(result.status).toBe(409);
    expect(f.webCalls).toHaveLength(2);
    expect(f.source.createMusicRequestBroker(f.window).stats().dispatched).toBe(
      0,
    );
  } finally {
    send?.();
    await f.close();
  }
});
test('COM WEB source failure never changes issuer, retries or becomes empty', async () => {
  const f = await commentsSocketFixture(
    [absentMusic()],
    [
      musicStart('web-start'),
      (_req: any, res: any) => {
        res.writeHead(500);
        res.end('{}');
      },
    ],
  );
  try {
    const result = await f.http(
      'videoId=abcdefghijk&allowPublicWebFallback=true',
    );
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('source');
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.webCalls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('COM main admission reentrant retirement refuses before allocating or executing', async () => {
  const f = await musicRequestFixture();
  try {
    let called = 0,
      settled = 0;
    const result = f.broker.runOwned(
      f.broker.capture(),
      'a',
      async () => {
        called++;
        return {};
      },
      {
        isCurrent: () => {
          f.broker.stop();
          return true;
        },
        onPhysicalSettled: () => settled++,
      },
    );
    result.catch(() => {});
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    expect(called).toBe(0);
    expect(settled).toBe(1);
    await expect(result).rejects.toMatchObject({ code: 'retired' });
  } finally {
    f.broker.dispose();
  }
});

const ownedCommentsValue = {
  version: 1,
  binding: { videoId, playbackEpoch: null },
  comments: {
    available: false,
    comments: [],
    commentCount: null,
    continuation: null,
  },
  requests: 1,
};
test('COM mixed native/main pool enforces four slots, FIFO8, queued cancellation and busy refusal', async () => {
  const f = await musicRequestFixture(),
    starts: string[] = [],
    pending: (() => void)[] = [],
    abortA = new AbortController(),
    abortQueued = new AbortController();
  const run = (principal: string, signal?: AbortSignal) => {
    const promise = f.broker.runOwned(
      f.broker.capture(),
      principal,
      () => {
        starts.push(principal);
        return new Promise((yes) =>
          pending.push(() => yes(ownedCommentsValue)),
        );
      },
      { signal },
    );
    promise.catch(() => {});
    return promise;
  };
  let nativeA: any, nativeB: any;
  try {
    run('a', abortA.signal);
    run('a');
    nativeA = f.read('b');
    nativeB = f.read('b');
    nativeA.catch(() => {});
    nativeB.catch(() => {});
    f.ready(f.challenge(0));
    f.ready(f.challenge(1));
    for (let i = 0; i < 8; i++)
      run('q' + i, i === 1 ? abortQueued.signal : undefined);
    expect(f.broker.stats()).toEqual({ dispatched: 4, queued: 8 });
    expect(starts).toEqual(['a', 'a']);
    await expect(run('overflow')).rejects.toMatchObject({ code: 'busy' });
    abortQueued.abort();
    abortA.abort();
    expect(f.broker.stats()).toEqual({ dispatched: 4, queued: 7 });
    f.settled(f.challenge(0));
    await nativeA;
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(starts).toEqual(['a', 'a', 'q0']);
    pending[0]();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(starts).toEqual(['a', 'a', 'q0', 'q2']);
    expect(f.broker.stats().dispatched).toBe(4);
  } finally {
    f.broker.dispose();
    for (const resolve of pending) resolve();
    if (nativeB) f.settled(f.challenge(1));
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
});
test('COM service restart retains the same main-owned tombstone and per-principal capacity', async () => {
  const f = await musicRequestFixture(),
    pending: (() => void)[] = [],
    started: string[] = [];
  const originalRelease = f.broker.retain();
  let nextRelease: (() => void) | undefined;
  const run = (name: string) => {
    const promise = f.broker.runOwned(f.broker.capture(), 'same-grant', () => {
      started.push(name);
      return new Promise((yes) => pending.push(() => yes(ownedCommentsValue)));
    });
    promise.catch(() => {});
    return promise;
  };
  try {
    const old = run('old');
    f.broker.stop();
    originalRelease();
    await expect(old).rejects.toMatchObject({ code: 'retired' });
    expect(f.again()).toBe(f.broker);
    nextRelease = f.broker.retain();
    run('new');
    run('queued');
    expect(started).toEqual(['old', 'new']);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 1 });
    pending[0]();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(started).toEqual(['old', 'new', 'queued']);
  } finally {
    f.broker.stop();
    nextRelease?.();
    for (const resolve of pending) resolve();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
});
test('COM explicit request budget stops before an extra continuation call', async () => {
  const seen: any[] = [],
    responses = [musicStart(), commentPage([header])];
  await expect(
    comments.loadComments(
      async (body: any) => {
        seen.push(body);
        return responses.shift();
      },
      { videoId, sort: 'newest', source: 'music', maxRequests: 2 },
    ),
  ).rejects.toMatchObject({ code: 'budget' });
  expect(seen).toEqual([{ videoId }, { continuation: 'native-start' }]);
});
test('COM current WEB final409 keeps physical slot until actual owned pipeline finishes', async () => {
  let send!: () => void;
  const f = await commentsSocketFixture(
    [absentMusic()],
    [
      (_req: any, res: any) => {
        send = () => res.end(JSON.stringify(musicStart('public-start')));
      },
      commentPage([legacyThread('not-current')]),
    ],
  );
  try {
    const running = f.http('current=true&allowPublicWebFallback=true');
    await expect.poll(() => f.webCalls.length).toBe(1);
    const broker = f.source.createMusicRequestBroker(f.window);
    expect(broker.stats().dispatched).toBe(1);
    f.setVideo('bbbbbbbbbbb');
    f.setVideo('current0001');
    expect(broker.stats().dispatched).toBe(1);
    send();
    const result = await running;
    expect(result.status).toBe(409);
    expect(result.body.comments).toBeUndefined();
    expect(broker.stats().dispatched).toBe(0);
  } finally {
    send?.();
    await f.close();
  }
});
test('COM revoked grant during owned WEB fetch cannot start a continuation', async () => {
  let send!: () => void;
  const f = await commentsSocketFixture(
    [absentMusic()],
    [
      (_req: any, res: any) => {
        send = () => {
          if (!res.destroyed && !res.writableEnded)
            res.end(JSON.stringify(musicStart('must-not-follow')));
        };
      },
    ],
  );
  try {
    const running = f.http('videoId=abcdefghijk&allowPublicWebFallback=true');
    await expect.poll(() => f.webCalls.length).toBe(1);
    await f.store.revoke(f.grant.record.id, () => true);
    const result = await running;
    expect(result.status).toBe(409);
    send();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(f.webCalls).toHaveLength(1);
    expect(f.nativeCalls).toHaveLength(1);
  } finally {
    send?.();
    await f.close();
  }
});

import { PassThrough } from 'node:stream';
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
test('COM native fixture collector preserves useful 151-row proof and split UTF8', async () => {
  const source = await readFile(
    path.join(import.meta.dirname, 'api-music-comments-native.test.ts'),
    'utf8',
  );
  const start = source.indexOf("    let stdout = ''"),
    end = source.indexOf('    const completion =', start);
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 101,
  };
  const collector = new Function(
    'child',
    'path',
    'let quiescentSeen=false;const owned="/owned",runId="run";const resolveQuiescent=()=>{},rejectQuiescent=()=>{};' +
      stripTypeScriptTypes(source.slice(start, end)) +
      ';return()=>stdout;',
  )(child, path);
  const proof = {
    first: {
      comments: Array.from({ length: 100 }, (_, i) => ({
        id: 'native-' + i,
        text: 'Grüezi 🌍\nمرحبا ' + '€'.repeat(100),
      })),
    },
    local: {
      comments: Array.from({ length: 51 }, (_, i) => ({
        id: 'native-' + (i + 100),
        text: '最新のコメント ' + '€'.repeat(100),
      })),
    },
  };
  const bytes = Buffer.from('MUSIC_NATIVE ' + JSON.stringify(proof) + '\n'),
    euro = bytes.indexOf(Buffer.from('€'));
  child.stdout.write(bytes.subarray(0, euro + 1));
  child.stdout.write(bytes.subarray(euro + 1, euro + 2));
  child.stdout.end(bytes.subarray(euro + 2));
  child.stderr.end();
  await new Promise<void>((yes) => setImmediate(yes));
  const line = collector()
    .split('\n')
    .find((value: string) => value.startsWith('MUSIC_NATIVE '));
  expect(line).toBeDefined();
  expect(JSON.parse(line.slice('MUSIC_NATIVE '.length))).toEqual(proof);
});

test('COM exact4096-byte plaintext and known WEB absence have useful positives', async () => {
  const text = '€'.repeat(1365) + 'a';
  expect(Buffer.byteLength(text)).toBe(4096);
  expect(
    comments.parseCommentsPage(commentPage([legacyThread('edge', text)]))
      .comments[0].text,
  ).toBe(text);
  const known = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              {
                videoPrimaryInfoRenderer: {
                  title: { simpleText: 'Public video' },
                },
              },
              { videoSecondaryInfoRenderer: { owner: {} } },
            ],
          },
        },
      },
    },
  };
  expect(
    await comments.loadComments(async () => known, {
      videoId,
      sort: 'top',
      source: 'public-web',
    }),
  ).toMatchObject({ available: false, comments: [], requests: 1 });
  await expect(
    comments.loadComments(async () => ({ contents: {} }), {
      videoId,
      sort: 'top',
      source: 'public-web',
    }),
  ).rejects.toThrow();
});
test('COM main native DTO validator rejects raw fields, controls, false absence and invalid counts', async () => {
  const source = await musicModuleSource(
    'src/plugins/api-server/backend/scheme/music.ts',
  );
  const value = {
    version: 1,
    binding: { videoId, playbackEpoch: null },
    requests: 2,
    comments: {
      available: true,
      comments: [
        {
          id: 'one',
          author: null,
          text: 'Plain text',
          publishedTime: null,
          likeCount: null,
          replyCount: null,
          pinned: false,
          verified: false,
          creator: false,
        },
      ],
      commentCount: null,
      continuation: null,
    },
  };
  expect(source.parseNativeCommentsMetadata(value)).toEqual(value);
  for (const defect of [
    'control',
    'raw field',
    'false absence',
    'requests',
    'overflow',
  ]) {
    const bad = structuredClone(value) as any;
    if (defect === 'control')
      bad.comments.comments[0].text = 'hidden\u0000control';
    if (defect === 'raw field')
      bad.comments.comments[0].navigationEndpoint = {
        url: 'https://invalid.test',
      };
    if (defect === 'false absence') bad.comments.available = false;
    if (defect === 'requests') bad.requests = 6;
    if (defect === 'overflow') bad.comments.comments[0].text = 'x'.repeat(4097);
    expect(() => source.parseNativeCommentsMetadata(bad), defect).toThrow();
  }
});

const sourceMessages = [
  'Something went wrong. Please try again.',
  'Ein Fehler ist aufgetreten. Bitte versuche es erneut.',
  'コメントを読み込めませんでした。',
  'Arbitrary localized message without semantic evidence',
];
const messageItem = (value: string) => ({
  messageRenderer: { text: { simpleText: value } },
});
const messageStart = (value: string, token?: string) => ({
  contents: {
    itemSectionRenderer: {
      sectionIdentifier: 'comment-item-section',
      contents: [messageItem(value), ...(token ? [tokenItem(token)] : [])],
    },
  },
});

test('COM-MAIN-01 initial localized messages never prove absence or authorize a token', async () => {
  for (const source of ['music', 'public-web'] as const)
    for (const value of sourceMessages)
      for (const raw of [
        messageStart(value),
        messageStart(value, 'issued-but-error-bearing'),
        { ...absentMusic(), diagnostic: messageItem(value) },
        { ...absentMusic(), error: { code: 500, message: value } },
      ]) {
        let calls = 0;
        await expect(
          comments.loadComments(
            async () => {
              calls++;
              return raw;
            },
            { videoId, sort: 'top', source },
          ),
        ).rejects.toThrow();
        expect(calls).toBe(1);
      }
});

test('COM-MAIN-01 issued continuation messages fail with initial and explicit recipes', async () => {
  for (const source of ['music', 'public-web'] as const)
    for (const value of sourceMessages)
      for (const direct of [false, true])
        for (const rows of [
          [messageItem(value)],
          [legacyThread('valid-row'), messageItem(value)],
        ]) {
          const replies = [
            ...(direct ? [] : [musicStart()]),
            commentPage(rows),
          ];
          const calls: any[] = [];
          await expect(
            comments.loadComments(
              async (body: any) => {
                calls.push(body);
                return replies.shift();
              },
              {
                videoId,
                sort: 'top',
                source,
                ...(direct ? { continuation: 'native-next' } : {}),
              },
            ),
          ).rejects.toThrow();
          expect(calls).toHaveLength(direct ? 1 : 2);
          expect(calls.at(-1)).toEqual({
            continuation: direct ? 'native-next' : 'native-start',
          });
        }
});

test('COM-MAIN-01 structurally empty issued continuation remains useful success', async () => {
  for (const source of ['music', 'public-web'] as const) {
    const result = await comments.loadComments(async () => commentPage([]), {
      videoId,
      sort: 'top',
      source,
      continuation: 'issued-empty',
    });
    expect(result).toEqual({
      available: true,
      comments: [],
      commentCount: null,
      continuation: null,
      requests: 1,
    });
  }
  const f = await commentsSocketFixture([
    musicStart(),
    commentPage([legacyThread('before-empty')], 'issued-empty'),
    commentPage([]),
  ]);
  try {
    const first = await f.http(
      'videoId=abcdefghijk&allowPublicWebFallback=true',
    );
    expect(first.status).toBe(200);
    expect(first.body.comments).toHaveLength(1);
    expect(typeof first.body.nextCursor).toBe('string');
    const empty = await f.http('cursor=' + first.body.nextCursor);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      source: 'music',
      available: true,
      comments: [],
      nextCursor: null,
    });
    expect(f.webCalls).toHaveLength(0);
    expect(f.nativeCalls.map((call) => call.data)).toEqual([
      { videoId },
      { continuation: 'native-start' },
      { continuation: 'issued-empty' },
    ]);
  } finally {
    await f.close();
  }
});

test('COM-MAIN-01 actual REST localized initial errors never invoke WEB even with consent', async () => {
  const replies = sourceMessages.flatMap((value) => [
    messageStart(value),
    messageStart(value),
  ]);
  const f = await commentsSocketFixture(replies);
  try {
    for (const _message of sourceMessages)
      for (const optIn of [false, true]) {
        const result = await f.http(
          'videoId=abcdefghijk' + (optIn ? '&allowPublicWebFallback=true' : ''),
        );
        expect(result.status).toBe(502);
        expect(result.body.comments).toBeUndefined();
        expect(result.body.available).toBeUndefined();
        expect(f.webCalls).toHaveLength(0);
      }
    expect(f.nativeCalls).toHaveLength(sourceMessages.length * 2);
  } finally {
    await f.close();
  }
});

test('COM-MAIN-01 actual REST issued native cursor rejects message page without source switch', async () => {
  const f = await commentsSocketFixture([
    musicStart(),
    commentPage([legacyThread('native-first')], 'issued-next'),
    commentPage([messageItem(sourceMessages[1])]),
  ]);
  try {
    const first = await f.http(
      'videoId=abcdefghijk&allowPublicWebFallback=true',
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      source: 'music',
      comments: [{ id: 'native-first' }],
    });
    const next = await f.http('cursor=' + first.body.nextCursor);
    expect(next.status).toBe(502);
    expect(next.body.comments).toBeUndefined();
    expect(f.webCalls).toHaveLength(0);
    expect(f.nativeCalls.map((call) => call.data)).toEqual([
      { videoId },
      { continuation: 'native-start' },
      { continuation: 'issued-next' },
    ]);
  } finally {
    await f.close();
  }
});

test('COM-MAIN-01 actual REST issued WEB cursor rejects message page with its original issuer', async () => {
  const f = await commentsSocketFixture(
    [absentMusic()],
    [
      musicStart('web-start'),
      commentPage([legacyThread('web-first')], 'web-next'),
      commentPage([messageItem(sourceMessages[2])]),
    ],
  );
  try {
    const first = await f.http(
      'videoId=abcdefghijk&allowPublicWebFallback=true',
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      source: 'public-web',
      comments: [{ id: 'web-first' }],
    });
    const next = await f.http('cursor=' + first.body.nextCursor);
    expect(next.status).toBe(502);
    expect(next.body.comments).toBeUndefined();
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.webCalls.map((call) => call.body.continuation)).toEqual([
      undefined,
      'web-start',
      'web-next',
    ]);
  } finally {
    await f.close();
  }
});
