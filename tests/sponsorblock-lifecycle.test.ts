import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import { Window } from 'happy-dom';
import { test, expect } from '@playwright/test';

async function fixture() {
  const dom = new Window();
  dom.document.body.innerHTML = '<video></video>';
  const video = dom.document.querySelector('video')!;
  Object.defineProperty(video, 'readyState', { get: () => 4 });
  const native = new EventEmitter();
  const responses = new Set<(...args: any[]) => void>();
  const requests: any[] = [];
  const sent: any[] = [];
  const api = {
    id: 'A',
    responseId: undefined as string | undefined,
    getVideoData: () => ({ video_id: api.id }),
    getPlayerResponse: () => ({
      videoDetails: { videoId: api.responseId ?? api.id },
    }),
  };
  const webContents = {};
  const key = `sponsor_${crypto.randomUUID()}`;
  const state = {
    native,
    dom,
    fetch: (url: string, options: any) =>
      new Promise((resolve) => requests.push({ url, options, resolve })),
    sortSegments: undefined as any,
  };
  (globalThis as any)[key] = state;
  const sortRaw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/sponsorblock/segments.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  state.sortSegments = (
    await import(
      `data:text/javascript;base64,${Buffer.from(sortRaw).toString('base64')}`
    )
  ).sortSegments;
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/sponsorblock/index.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const boundary = `const state=globalThis[${JSON.stringify(key)}];const ipcMain=state.native;const document=state.dom.document;const window=state.dom;window.electronIs={dev:()=>false};const HTMLVideoElement=window.HTMLVideoElement;const fetch=state.fetch;const sortSegments=state.sortSegments;const is={dev:()=>false};const t=x=>x;const createPlugin=x=>x;`;
  const plugin = (
    await import(
      `data:text/javascript;base64,${Buffer.from(boundary + raw).toString('base64')}`
    )
  ).default;
  const backendContext = {
    window: { webContents },
    getConfig: async () => plugin.config,
    ipc: {
      on: (id: string, fn: any) =>
        native.on(id, (_: any, ...args: any[]) => fn(...args)),
      send: (id: string, ...args: any[]) => {
        sent.push([id, ...args]);
        for (const fn of responses) fn(...args);
      },
    },
  };
  const ipc = {
    on: (_: string, fn: any) => responses.add(fn),
    subscribe: (_: string, fn: any) => {
      responses.add(fn);
      return () => responses.delete(fn);
    },
    removeAllListeners: () => responses.clear(),
    send: (id: string, ...args: any[]) =>
      native.emit(id, { sender: webContents }, ...args),
  };
  const backend = plugin.backend;
  const start = async () => {
    if (typeof backend === 'function') await backend(backendContext);
    else await backend.start(backendContext);
    plugin.renderer.start({ ipc });
    plugin.renderer.onPlayerApiReady(api, { ipc });
  };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return {
    video,
    api,
    native,
    requests,
    sent,
    responses,
    plugin,
    ipc,
    start,
    flush,
    request: (id: string) =>
      native.emit(
        'peard:video-src-changed',
        { sender: webContents },
        { videoDetails: { videoId: id } },
      ),
    resolve: async (index: number, segments: any) => {
      requests[index].resolve(
        new Response(
          JSON.stringify(segments.map((segment: any) => ({ segment }))),
          { status: 200 },
        ),
      );
      await flush();
    },
    stop: () => {
      plugin.renderer.stop({ ipc });
      backend.stop?.(backendContext);
    },
    close: async () => {
      plugin.renderer.stop({ ipc });
      backend.stop?.(backendContext);
      delete (globalThis as any)[key];
      await dom.happyDOM.close();
    },
  };
}

test('late enable requests current track and applies segments immediately at time zero', async () => {
  const f = await fixture();
  try {
    await f.start();
    expect(f.requests).toHaveLength(1);
    await f.resolve(0, [[0, 5]]);
    expect(f.video.currentTime).toBe(5);
  } finally {
    await f.close();
  }
});

test('stale network result cannot skip a newer track', async () => {
  const f = await fixture();
  try {
    await f.start();
    if (!f.requests.length) f.request('A');
    f.api.id = 'B';
    f.request('B');
    await f.resolve(1, [[0, 4]]);
    f.video.currentTime = 0;
    await f.resolve(0, [[0, 20]]);
    f.plugin.renderer.timeUpdateListener(
      new f.video.ownerDocument.defaultView!.Event('timeupdate'),
    );
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('timeupdate'),
    );
    expect(f.video.currentTime).toBe(4);
  } finally {
    await f.close();
  }
});

test('invalid video metadata makes no network request and clears stale state', async () => {
  const f = await fixture();
  try {
    await f.start();
    const before = f.requests.length;
    f.native.emit('peard:video-src-changed', {}, {});
    await f.flush();
    expect(f.requests.length).toBe(before);
  } finally {
    await f.close();
  }
});

test('stop aborts transfer, removes owned listeners and rejects late delivery', async () => {
  const f = await fixture();
  try {
    await f.start();
    if (!f.requests.length) f.request('A');
    f.stop();
    expect(f.requests[0].options.signal?.aborted).toBe(true);
    await f.resolve(0, [[0, 30]]);
    expect(f.video.currentTime).toBe(0);
    expect(f.responses.size).toBe(0);
    expect(f.native.listenerCount('peard:video-src-changed')).toBe(0);
  } finally {
    await f.close();
  }
});

test('foreign window requests are ignored and stopping preserves unrelated subscribers', async () => {
  const f = await fixture();
  try {
    let external = 0;
    f.native.on('peard:video-src-changed', () => external++);
    const unrelated = () => {};
    f.responses.add(unrelated);
    await f.start();
    const before = f.requests.length;
    f.native.emit(
      'peard:video-src-changed',
      { sender: {} },
      { videoDetails: { videoId: 'foreign' } },
    );
    await f.flush();
    expect(f.requests.length).toBe(before);
    f.stop();
    expect(f.responses.has(unrelated)).toBe(true);
    expect(f.native.listenerCount('peard:video-src-changed')).toBe(1);
    expect(external).toBe(2);
  } finally {
    await f.close();
  }
});

test('malformed segments are ignored while overlapping valid segments merge', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.resolve(0, [[0, 3], [2, 5], [-1, 100], [5, 2], ['0', 300], null]);
    expect(f.video.currentTime).toBe(5);
    f.video.currentTime = 9;
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('timeupdate'),
    );
    expect(f.video.currentTime).toBe(9);
  } finally {
    await f.close();
  }
});

test('retained packets and API-ready hooks cannot reactivate a stopped renderer', async () => {
  const f = await fixture();
  try {
    await f.start();
    const receive = [...f.responses][0];
    f.stop();
    receive({ videoId: 'A', segments: [[0, 10]] });
    f.plugin.renderer.onPlayerApiReady(f.api, { ipc: f.ipc });
    expect(f.video.currentTime).toBe(0);
    expect(f.requests.length).toBe(1);
    await f.start();
    receive({ videoId: 'A', segments: [[0, 10]] });
    expect(f.video.currentTime).toBe(0);
  } finally {
    await f.close();
  }
});

test('observed B metadata fences retained A segments while video-data getter lags', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.resolve(0, [[0, 5]]);
    f.video.currentTime = 0;
    f.api.responseId = 'B';
    f.request('B');
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('timeupdate'),
    );
    expect(f.video.currentTime).toBe(0);
  } finally {
    await f.close();
  }
});

test('B segments arriving before getter agreement remain available after it catches up', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.api.responseId = 'B';
    f.request('B');
    await f.resolve(1, [[0, 4]]);
    expect(f.video.currentTime).toBe(0);
    f.api.id = 'B';
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('timeupdate'),
    );
    expect(f.video.currentTime).toBe(4);
  } finally {
    await f.close();
  }
});

test('missing owned subscription fails closed without installing fallback listeners', async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.plugin.renderer.start({ ipc: { ...f.ipc, subscribe: undefined } }),
    ).toThrow(/subscription/i);
    expect(f.responses.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('owned invalid metadata aborts the current request and clears populated segments', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.resolve(0, [[0, 5]]);
    const old = f.sent.find((entry: any[]) => entry[1].phase === 'result')![1];
    f.video.currentTime = 0;
    f.request('');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].options.signal.aborted).toBe(true);
    for (const receive of f.responses) receive(old);
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('timeupdate'),
    );
    expect(f.video.currentTime).toBe(0);
  } finally {
    await f.close();
  }
});

test('pending current segments survive emptied but wait for loaded metadata', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.api.responseId = 'B';
    f.request('B');
    await f.resolve(1, [[0, 4]]);
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('emptied'),
    );
    f.api.id = 'B';
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('timeupdate'),
    );
    expect(f.video.currentTime).toBe(0);
    f.video.dispatchEvent(
      new f.video.ownerDocument.defaultView!.Event('loadedmetadata'),
    );
    expect(f.video.currentTime).toBe(4);
  } finally {
    await f.close();
  }
});
