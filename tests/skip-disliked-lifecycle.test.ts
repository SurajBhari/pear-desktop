import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';

async function fixture() {
  const dom = new Window();
  dom.document.body.innerHTML =
    '<div id="like-button-renderer"></div><yt-icon-button class="next-button"></yt-icon-button>';
  const button = dom.document.querySelector('#like-button-renderer')!;
  const state = {
    videoId: 'A',
    skips: 0,
    ready: undefined as any,
    observers: [] as any[],
    timers: new Map<number, () => void>(),
    events: new Map<string, Set<() => void>>(),
  };
  const api = {
    getVideoData: () => ({ video_id: state.videoId }),
    nextVideo: () => {
      state.skips++;
      state.videoId = 'B';
    },
    addEventListener: (e: string, fn: () => void) => {
      if (!state.events.has(e)) state.events.set(e, new Set());
      state.events.get(e)!.add(fn);
    },
    removeEventListener: (e: string, fn: () => void) =>
      state.events.get(e)?.delete(fn),
  };
  dom.document
    .querySelector('yt-icon-button')!
    .addEventListener('click', api.nextVideo);
  let timer = 0;
  const key = `disliked_${crypto.randomUUID()}`;
  (globalThis as any)[key] = {
    document: dom.document,
    waitForElement: () =>
      new Promise((resolve) => {
        state.ready = resolve;
      }),
    MutationObserver: class {
      connected = false;
      constructor(public fn: () => void) {
        state.observers.push(this);
      }
      observe(target: any) {
        this.connected = true;
        this.target = target;
      }
      disconnect() {
        this.connected = false;
      }
    },
    setTimeout: (fn: () => void) => {
      state.timers.set(++timer, fn);
      return timer;
    },
    clearTimeout: (id: number) => state.timers.delete(id),
  };
  const raw = await readFile(
    new URL('../src/plugins/skip-disliked-songs/index.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw).replace(/^import[\s\S]*?;\n/gm, '');
  const boundaries = `const {document,waitForElement,MutationObserver,setTimeout,clearTimeout}=globalThis[${JSON.stringify(key)}];const t=x=>x;const createPlugin=x=>x;`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundaries + actual).toString('base64')}`
  );
  const renderer = source.default.renderer;
  return {
    state,
    renderer,
    api,
    button,
    attach: async () => {
      if (state.ready) state.ready(button);
      else dom.document.body.append(button);
      await Promise.resolve();
    },
    mutate: () => {
      for (const o of state.observers)
        if (o.connected) o.fn([{ attributeName: 'like-status' }]);
    },
    tick: () => {
      const q = [...state.timers.values()];
      state.timers.clear();
      for (const fn of q) fn();
    },
    event: () => {
      for (const fn of state.events.get('videodatachange') ?? []) fn();
    },
    close: async () => {
      renderer.stop();
      delete (globalThis as any)[key];
      await dom.happyDOM.close();
    },
  };
}

test('stale dislike DOM from the preceding track cannot skip the next track', async () => {
  const f = await fixture();
  try {
    f.renderer.start();
    f.renderer.onPlayerApiReady?.(f.api);
    await f.attach();
    f.button.setAttribute('like-status', 'DISLIKE');
    f.mutate();
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(1);
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(1);
    f.button.setAttribute('like-status', 'INDIFFERENT');
    f.mutate();
    f.button.setAttribute('like-status', 'DISLIKE');
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(2);
  } finally {
    await f.close();
  }
});

test('changed track or neutral status cancels a pending skip', async () => {
  const f = await fixture();
  try {
    f.renderer.start();
    f.renderer.onPlayerApiReady?.(f.api);
    await f.attach();
    f.button.setAttribute('like-status', 'DISLIKE');
    f.mutate();
    f.state.videoId = 'B';
    f.event();
    f.tick();
    expect(f.state.skips).toBe(0);
    f.button.setAttribute('like-status', 'INDIFFERENT');
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(0);
  } finally {
    await f.close();
  }
});

test('stop fences a late DOM wait and removes player listeners and timers', async () => {
  const f = await fixture();
  try {
    f.button.remove();
    f.renderer.start();
    f.renderer.onPlayerApiReady?.(f.api);
    f.renderer.stop();
    await f.attach();
    f.button.setAttribute('like-status', 'DISLIKE');
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(0);
    expect(f.state.events.get('videodatachange')?.size ?? 0).toBe(0);
  } finally {
    await f.close();
  }
});

test('replaying a previously skipped track may skip again after a new neutral-to-dislike confirmation', async () => {
  const f = await fixture();
  try {
    f.renderer.start();
    f.renderer.onPlayerApiReady(f.api);
    await f.attach();
    f.button.setAttribute('like-status', 'DISLIKE');
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(1);
    f.event();
    f.state.videoId = 'A';
    f.event();
    f.button.setAttribute('like-status', 'INDIFFERENT');
    f.mutate();
    f.button.setAttribute('like-status', 'DISLIKE');
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(2);
  } finally {
    await f.close();
  }
});

test('track-keyed player status allows consecutive disliked songs without trusting stale DOM', async () => {
  const f = await fixture();
  try {
    const bar = f.button.ownerDocument.createElement('ytmusic-player-bar');
    const videos: any = { A: 'DISLIKE', B: 'INDIFFERENT' };
    (bar as any).getState = () => ({ likeStatus: { videos } });
    f.button.ownerDocument.body.append(bar);
    f.button.setAttribute('like-status', 'DISLIKE');
    f.renderer.start();
    f.renderer.onPlayerApiReady(f.api);
    await f.attach();
    f.tick();
    expect(f.state.skips).toBe(1);
    f.event();
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(1);
    videos.B = 'DISLIKE';
    f.button.setAttribute('like-status', 'DISLIKE');
    f.mutate();
    f.tick();
    expect(f.state.skips).toBe(2);
  } finally {
    await f.close();
  }
});

test('loss of a track-keyed dislike cannot downgrade confirmation to stale DOM', async () => {
  const f = await fixture();
  try {
    const bar = f.button.ownerDocument.createElement('ytmusic-player-bar');
    const videos: any = { A: 'INDIFFERENT', B: 'DISLIKE' };
    (bar as any).getState = () => ({ likeStatus: { videos } });
    f.button.ownerDocument.body.append(bar);
    f.button.setAttribute('like-status', 'DISLIKE');
    f.renderer.start();
    f.renderer.onPlayerApiReady(f.api);
    await f.attach();
    f.state.videoId = 'B';
    f.event();
    delete videos.B;
    f.tick();
    expect(f.state.skips).toBe(0);
  } finally {
    await f.close();
  }
});
