import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { test, expect } from '@playwright/test';

async function engine() {
  expect(
    existsSync(
      new URL(
        '../src/plugins/scrobbler/services/regex-filters.ts',
        import.meta.url,
      ),
    ),
  ).toBe(true);
  return import('../src/plugins/scrobbler/services/regex-filters');
}
test('isolated editor validates original lines and rejects bounded input', async () => {
  const { RegexFilters } = await engine();
  const filters = new RegexFilters();
  try {
    expect(await filters.validate('\\s+foo\n\n[')).toEqual({
      ok: false,
      line: 3,
    });
    expect(await filters.validate('a'.repeat(257))).toEqual({
      ok: false,
      line: 1,
    });
    expect(await filters.validate(Array(33).fill('a').join('\n'))).toEqual({
      ok: false,
      line: 33,
    });
    expect(await filters.validate('foo\n\nbar')).toEqual({
      ok: true,
      patterns: ['foo', 'bar'],
    });
  } finally {
    filters.stop();
  }
});
test('ordered cleanup preserves fallback if output empties or configuration is malformed', async () => {
  const { RegexFilters } = await engine();
  const filters = new RegexFilters();
  const original = { title: 'Track (Live) feat. Singer', artist: 'Artist [A]' };
  try {
    expect(await filters.apply([], original)).toEqual(original);
    expect(await filters.apply(['\\s\\(Live\\)'], original)).toEqual({
      ...original,
      title: 'Track feat. Singer',
    });
    expect(await filters.apply(['.*'], original)).toEqual(original);
    expect(await filters.apply(['['], original)).toEqual(original);
    expect(
      await filters.apply(['a'], { title: 'a'.repeat(4097), artist: 'Artist' }),
    ).toEqual({ title: 'a'.repeat(4097), artist: 'Artist' });
  } finally {
    filters.stop();
  }
});
test('catastrophic regex has a responsive main loop and terminates its actual worker', async () => {
  const { RegexFilters } = await engine();
  const workers: Worker[] = [];
  let exited = 0,
    beats = 0;
  const filters = new RegexFilters({
    createWorker: (source: string) => {
      const worker = new Worker(source, { eval: true });
      workers.push(worker);
      worker.once('exit', () => exited++);
      return worker;
    },
  });
  const heartbeat = setInterval(() => beats++, 5);
  const original = { title: 'a'.repeat(128) + '!', artist: 'Artist' };
  try {
    expect(await filters.apply(['(a+)+$'], original)).toEqual(original);
    await expect.poll(() => exited).toBe(1);
    expect(beats).toBeGreaterThan(3);
    expect(workers).toHaveLength(1);
  } finally {
    clearInterval(heartbeat);
    filters.stop();
  }
});
test('owner cancellation and replacement settle every queued job without late output', async () => {
  const { RegexFilters } = await engine();
  const filters = new RegexFilters();
  const controller = new AbortController();
  const original = { title: 'a'.repeat(128) + '!', artist: 'Artist' };
  const first = filters.apply(['(a+)+$'], original, controller.signal);
  const replaced = filters.apply(['a'], original);
  const last = filters.apply(['!'], original);
  controller.abort();
  expect(await first).toEqual(original);
  expect(await replaced).toEqual(original);
  expect(await last).toEqual({ ...original, title: 'a'.repeat(128) });
  filters.stop();
  expect(await filters.apply(['a'], original)).toEqual(original);
});
