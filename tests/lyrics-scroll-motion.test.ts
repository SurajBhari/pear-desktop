import { test, expect } from '@playwright/test';
import { createLyricsScrollController } from '../src/plugins/synced-lyrics/renderer/scroll-motion';

test('centering retargets from presentation offset, reduced motion snaps, and retired frames cannot scroll', () => {
  let now = 0,
    serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const writes: number[] = [];
  const handle = {
    scrollOffset: 0,
    scrollSize: 3000,
    viewportSize: 400,
    getItemOffset: (index: number) => index * 200,
    getItemSize: () => 100,
    scrollTo: (value: number) => {
      handle.scrollOffset = value;
      writes.push(value);
    },
  };
  const controller = createLyricsScrollController(() => handle, {
    now: () => now,
    request: (cb) => {
      frames.set(++serial, cb);
      return serial;
    },
    cancel: (id) => {
      frames.delete(id);
    },
  });
  const tick = (time: number) => {
    now = time;
    for (const [id, cb] of [...frames]) {
      frames.delete(id);
      cb(time);
    }
  };
  controller.move(5);
  tick(60);
  const visible = handle.scrollOffset;
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(850);
  controller.move(1);
  expect(handle.scrollOffset).toBe(visible);
  tick(120);
  expect(handle.scrollOffset).toBeLessThan(visible);
  const oldFrame = [...frames.values()][0];
  controller.cancel();
  const count = writes.length;
  oldFrame(300);
  expect(writes.length).toBe(count);
  controller.move(5, true);
  expect(handle.scrollOffset).toBe(850);
  expect(frames.size).toBe(0);
});
