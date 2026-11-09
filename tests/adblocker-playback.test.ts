import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const scene = () => ({
  documentId: 'old',
  version: 0,
  url: 'https://music.youtube.com/watch?v=fixture',
  videoId: 'fixture',
  seconds: 18,
  paused: true,
  muted: false,
  queue: {
    items: [],
    ids: ['a', 'fixture', 'b'],
    index: 1,
    isInfinite: true,
    continuation: 'opaque',
    context: 'opaque',
    autoPlaying: true,
    shuffle: false,
    repeat: 'NONE',
    autoplay: true,
  },
});

test('automatic document apply leaves an unsupported active radio scene intact and exposes pending state', async () => {
  expect(
    existsSync(path.join(root, 'src/providers/blocker-scene-controller.ts')),
  ).toBe(true);
  const { createBlockerSceneController } =
    await import('../src/providers/blocker-scene-controller');
  let reloads = 0;
  const controller = createBlockerSceneController({
    capture: async () => ({ kind: 'active', scene: scene() }),
    verify: async () => true,
    valid: () => true,
    reload: async () => {
      reloads++;
    },
    restore: async () => ({ kind: 'verified' }),
    release: () => {},
  });
  const result = await controller.apply(false);
  expect(reloads).toBe(0);
  expect(result.kind).toBe('pending');
  expect(result.reason).toContain('queue');
});

test('explicit document apply captures, validates and restores before releasing its guard', async () => {
  expect(
    existsSync(path.join(root, 'src/providers/blocker-scene-controller.ts')),
  ).toBe(true);
  const { createBlockerSceneController } =
    await import('../src/providers/blocker-scene-controller');
  const events: string[] = [];
  const original = scene();
  const controller = createBlockerSceneController({
    capture: async () => ({ kind: 'active', scene: original }),
    verify: async (snapshot) => {
      expect(snapshot).toEqual(original);
      events.push('verify');
      return true;
    },
    valid: () => true,
    reload: async (snapshot) => {
      expect(snapshot).toEqual(original);
      events.push('reload');
    },
    restore: async (snapshot) => {
      expect(snapshot).toEqual(original);
      events.push('restore');
      return { kind: 'partial', reason: 'radio queue context refreshed' };
    },
    release: () => {
      events.push('release');
    },
  });
  const result = await controller.apply(true);
  expect(events).toEqual(['verify', 'reload', 'restore', 'release']);
  expect(result).toEqual({
    kind: 'partial',
    reason: 'radio queue context refreshed',
  });
});

test('a new generation cancels an older capture without reloading or restoring it', async () => {
  expect(
    existsSync(path.join(root, 'src/providers/blocker-scene-controller.ts')),
  ).toBe(true);
  const { createBlockerSceneController } =
    await import('../src/providers/blocker-scene-controller');
  let finish: ((value: unknown) => void) | undefined;
  let calls = 0;
  const controller = createBlockerSceneController({
    capture: async () =>
      ++calls === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : {
            kind: 'idle',
            documentId: 'new',
            version: 0,
            url: 'https://example.test',
          },
    verify: async () => true,
    valid: () => true,
    reload: async () => {},
    restore: async () => {
      throw new Error('must not restore old scene');
    },
    release: () => {},
  });
  const old = controller.apply(true);
  const next = controller.apply(false);
  finish!({ kind: 'active', scene: scene() });
  expect((await old).kind).toBe('cancelled');
  expect((await next).kind).toBe('verified');
});

test('failed restore and user cancellation always release the single-use guard', async () => {
  expect(
    existsSync(path.join(root, 'src/providers/blocker-scene-controller.ts')),
  ).toBe(true);
  const { createBlockerSceneController } =
    await import('../src/providers/blocker-scene-controller');
  let releases = 0;
  const controller = createBlockerSceneController({
    capture: async () => ({ kind: 'active', scene: scene() }),
    verify: async () => true,
    valid: () => true,
    reload: async () => {},
    restore: async () => {
      throw new Error('fixture restore failure');
    },
    release: () => {
      releases++;
    },
  });
  expect((await controller.apply(true)).kind).toBe('failed');
  expect(releases).toBe(1);
  controller.cancel();
  expect(releases).toBe(2);
});
