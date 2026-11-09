import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { test, expect } from '@playwright/test';

for (const mode of ['transient', 'persistent', 'cancelled'] as const) {
  test(`actual renderer semantic settling ${mode}`, async () => {
    const commands: string[] = [];
    let cancelled = false;
    let itemReads = 0;
    let stateReads = 0;
    const items = [
      { playlistPanelVideoRenderer: { videoId: 'fixture', selected: true } },
    ];
    const value = {
      isInfinite: false,
      shuffleEnabled: false,
      repeatMode: 'NONE',
      autoplay: true,
    };
    const video = {
      muted: true,
      paused: false,
      readyState: 4,
      duration: 30,
      currentTime: 0,
      seekable: { length: 1 },
      seeking: false,
      pause() {
        commands.push('pause');
        this.paused = true;
      },
      async play() {
        commands.push('play');
        this.paused = false;
      },
    };
    const player = {
      querySelector: () => video,
      getVideoData: () => ({ video_id: 'fixture', list: 'radio' }),
      classList: { contains: () => false },
      seekTo(time: number) {
        commands.push('seek');
        video.currentTime = time;
      },
    };
    const queue = {
      dispatch() {},
      queue: {
        autoPlaying: false,
        getItems: () => {
          itemReads++;
          return items;
        },
        store: {
          store: {
            getState: () => {
              stateReads++;
              return { queue: value };
            },
          },
        },
      },
    };
    const context = {
      window: { blockerSceneGuard: { cancelled: () => cancelled } },
      document: {
        querySelector: (selector: string) =>
          selector === '#movie_player'
            ? player
            : selector === 'video'
              ? video
              : selector === '#queue'
                ? queue
                : null,
        addEventListener() {},
      },
      location: {
        href: 'https://music.youtube.com/watch?v=fixture&list=radio',
      },
      performance: { timeOrigin: 2 },
      setTimeout,
      TextEncoder,
    };
    vm.createContext(context);
    const source = stripTypeScriptTypes(
      await readFile(
        path.resolve(
          import.meta.dirname,
          '../src/providers/blocker-scene-renderer.ts',
        ),
        'utf8',
      ),
    );
    vm.runInContext(
      source.replace('export async function', 'async function') +
        ';globalThis.restore=blockerSceneRenderer;',
      context,
    );
    const runtime = context as typeof context & { restore: Function };
    const scene = {
      documentId: '1:old',
      version: 7,
      url: context.location.href,
      videoId: 'fixture',
      playlistId: 'radio',
      seconds: 18,
      paused: true,
      muted: false,
      queue: {
        items,
        ids: ['fixture'],
        index: 0,
        isInfinite: true,
        autoPlaying: false,
        shuffle: false,
        repeat: 'NONE',
        autoplay: true,
        continuation: null,
        context: null,
      },
    };
    let cancelBoundary = -1;
    const ready =
      mode !== 'persistent'
        ? setTimeout(() => {
            commands.push('semantic-ready');
            value.isInfinite = true;
          }, 180)
        : undefined;
    const user =
      mode === 'cancelled'
        ? setTimeout(() => {
            cancelled = true;
            cancelBoundary = commands.length;
          }, 40)
        : undefined;
    try {
      const result = await runtime.restore('restore', scene);
      expect(result.kind).toBe(
        mode === 'transient'
          ? 'verified'
          : mode === 'persistent'
            ? 'partial'
            : 'cancelled',
      );
      if (mode === 'cancelled') {
        expect(commands.slice(cancelBoundary)).toEqual([]);
        expect(itemReads).toBe(0);
      } else {
        expect(video.currentTime).toBe(18);
        expect(video.paused).toBe(true);
        expect(video.muted).toBe(false);
        expect(itemReads).toBe(1);
        expect(stateReads).toBeGreaterThan(1);
        if (mode === 'transient')
          expect(commands.indexOf('seek')).toBeGreaterThan(
            commands.indexOf('semantic-ready'),
          );
        else
          expect(result.reason).toContain(
            'radio or playback settings could not be verified',
          );
      }
    } finally {
      if (ready) clearTimeout(ready);
      if (user) clearTimeout(user);
    }
  });
}
