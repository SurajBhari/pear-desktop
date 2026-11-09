import { Script } from 'node:vm';

import { test, expect } from '@playwright/test';

import { blockerSceneRenderer } from '../src/providers/blocker-scene-renderer';

import type {
  BlockerPlaybackScene,
  BlockerSceneOutcome,
} from '../src/types/blocker-scene';

function controlledMedia(initiallyReady: boolean) {
  let clock = 0;
  let position = 0;
  let anchoredAt = 0;
  let seekStarted: number | undefined;
  const trace: Array<{ event: string; time: number; paused: boolean }> = [];
  const media = {
    paused: false,
    muted: true,
    seeking: false,
    readyState: initiallyReady ? 2 : 0,
    duration: 30,
    seekable: { length: 1 },
    currentSrc: 'https://fixture.test/silent.wav',
    get currentTime() {
      return position + (this.paused ? 0 : (clock - anchoredAt) / 1000);
    },
    set currentTime(value: number) {
      position = value;
      anchoredAt = clock;
      seekStarted = clock;
      this.seeking = true;
      trace.push({ event: 'seek', time: value, paused: this.paused });
    },
    pause() {
      position = this.currentTime;
      anchoredAt = clock;
      this.paused = true;
      trace.push({ event: 'pause', time: position, paused: true });
    },
    play() {
      anchoredAt = clock;
      this.paused = false;
      this.readyState = 2;
      trace.push({ event: 'play', time: position, paused: false });
      return Promise.resolve();
    },
  };
  const render = new Script(
    `(${blockerSceneRenderer.toString()})`,
  ).runInNewContext({
    window: { blockerSceneGuard: { cancelled: () => false } },
    document: {
      addEventListener() {},
      querySelector(selector: string) {
        return selector === 'video' ? media : null;
      },
    },
    location: { href: 'https://fixture.test/player' },
    performance: { timeOrigin: 1 },
    setTimeout(callback: () => void, milliseconds: number) {
      clock += milliseconds;
      if (seekStarted !== undefined && clock - seekStarted >= 10)
        media.seeking = false;
      callback();
    },
  }) as (
    action: 'restore',
    scene: BlockerPlaybackScene,
  ) => Promise<BlockerSceneOutcome>;
  return { media, render, trace };
}

for (const initiallyReady of [false, true]) {
  for (const paused of [false, true]) {
    test(`actual renderer preserves position during asynchronous seek (${initiallyReady ? 'ready' : 'warmup'}, ${paused ? 'paused' : 'playing'} scene)`, async () => {
      const fixture = controlledMedia(initiallyReady);
      const scene: BlockerPlaybackScene = {
        documentId: 'old-document',
        version: 0,
        url: 'https://fixture.test/player',
        videoId: 'https://fixture.test/silent.wav',
        seconds: 18,
        paused,
        muted: false,
        queue: null,
      };
      const result = await fixture.render('restore', scene);
      expect(result).toEqual({ kind: 'verified' });
      expect(fixture.media.seeking).toBe(false);
      expect(fixture.media.currentTime).toBeCloseTo(18, 1);
      expect(fixture.media.paused).toBe(paused);
      expect(fixture.media.muted).toBe(false);
      if (!paused) expect(fixture.trace.at(-1)?.event).toBe('play');
    });
  }
}
