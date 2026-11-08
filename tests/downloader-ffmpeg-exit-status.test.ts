import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const requireRoot = createRequire(
  path.join(import.meta.dirname, '../package.json'),
);
const wrapper = readFileSync(
  path.join(
    path.dirname(requireRoot.resolve('@ffmpeg.wasm/main')),
    'createFFmpeg.js',
  ),
  'utf8',
);

function fixture() {
  const cores: {
    options: Record<string, (...args: unknown[]) => void>;
    exits: number;
    failDispatch: boolean;
    dispatchThrowsUndefined: boolean;
    stops: number;
    PThread: Record<string, unknown>;
  }[] = [];
  const controls = { deferNextLoad: false, waiting: [] as (() => void)[] };
  const module = { exports: undefined as unknown };
  const load = vm.runInNewContext(
    `(function(require,module,exports){${wrapper}\n})`,
  );
  load(
    (name: string) => {
      if (name === './config')
        return requireRoot('@ffmpeg.wasm/main/src/config');
      if (name === './utils/parseArgs') return () => [0, 0];
      if (name === '../package.json') return { version: '0.12.0' };
      if (name === './node')
        return {
          defaultOptions: {},
          getCreateFFmpegCore: async () => ({
            createFFmpegCore: async (
              options: Record<string, (...args: unknown[]) => void>,
            ) => {
              const core = {
                options,
                exits: 0,
                failDispatch: false,
                dispatchThrowsUndefined: false,
                stops: 0,
                PThread: {
                  Rb: [],
                  Vb: [],
                  Gb: {},
                  pd: () => {
                    core.stops++;
                    options.onExit?.(0);
                    options.onExit?.(0);
                  },
                },
                cwrap: () => () => {
                  if (core.dispatchThrowsUndefined) throw undefined;
                  if (core.failDispatch)
                    throw new Error('Owned dispatch fault');
                  return 0;
                },
                exit: () => {
                  core.exits++;
                  options.onExit?.(0);
                  options.onExit?.(0);
                },
                FS: {},
              };
              cores.push(core);
              if (controls.deferNextLoad) {
                controls.deferNextLoad = false;
                await new Promise<void>((resolve) =>
                  controls.waiting.push(resolve),
                );
              }
              return core;
            },
          }),
        };
      throw new Error(`Unexpected wrapper dependency ${name}`);
    },
    module,
    {},
  );
  const engine = (
    module.exports as (options: object) => {
      load(): Promise<void>;
      run(...args: string[]): Promise<void>;
      exit(): void;
      isLoaded(): boolean;
    }
  )({ logger() {}, progress() {} });
  const start = () => {
    const p = engine.run('-version');
    return p.then(
      (value) => ({ kind: 'resolved', value }),
      (error) => ({ kind: 'rejected', error }),
    );
  };
  const outcome = (p: ReturnType<typeof start>) =>
    Promise.race([
      p,
      new Promise<{ kind: string }>((resolve) =>
        setTimeout(() => resolve({ kind: 'pending' }), 5),
      ),
    ]);
  return { engine, cores, start, outcome, controls };
}

test('FFMPEG_END and proxy return cannot complete a command before numeric exit', async () => {
  const f = fixture();
  await f.engine.load();
  try {
    const p = f.start();
    f.cores[0].options.print('FFMPEG_END');
    expect((await f.outcome(p)).kind).toBe('pending');
    f.cores[0].options.onExit?.(0);
    expect(await f.outcome(p)).toEqual({ kind: 'resolved', value: undefined });
  } finally {
    f.engine.exit();
  }
});

test('a primitive undefined dispatch exception still rejects rather than signaling success', async () => {
  const f = fixture();
  await f.engine.load();
  f.cores[0].dispatchThrowsUndefined = true;
  expect((await f.outcome(f.start())).kind).toBe('rejected');
  expect(f.engine.isLoaded()).toBe(false);
});

test('nonzero numeric exit rejects and releases the same engine for another command', async () => {
  const f = fixture();
  await f.engine.load();
  try {
    const p = f.start();
    f.cores[0].options.print('FFMPEG_END');
    f.cores[0].options.onExit?.(1);
    const failed = await f.outcome(p);
    expect(failed.kind).toBe('rejected');
    expect((failed as { error: { exitCode: number } }).error.exitCode).toBe(1);
    const next = f.start();
    f.cores[0].options.onExit?.(0);
    expect(await f.outcome(next)).toEqual({
      kind: 'resolved',
      value: undefined,
    });
    expect(f.cores).toHaveLength(1);
  } finally {
    f.engine.exit();
  }
});

test('one command remains active until numeric exit and idle duplicate exits are ignored', async () => {
  const f = fixture();
  await f.engine.load();
  try {
    const p = f.start();
    expect(() => f.engine.run('-version')).toThrow('one command at a time');
    f.cores[0].options.onExit?.(0);
    expect((await f.outcome(p)).kind).toBe('resolved');
    f.cores[0].options.onExit?.(1);
    f.cores[0].options.onExit?.(0);
    const next = f.start();
    expect((await f.outcome(next)).kind).toBe('pending');
    f.cores[0].options.onExit?.(0);
    expect((await f.outcome(next)).kind).toBe('resolved');
  } finally {
    f.engine.exit();
  }
});

test('forced exit cancels before duplicate callbacks and old core cannot settle a reloaded job', async () => {
  const f = fixture();
  await f.engine.load();
  const old = f.cores[0],
    cancelled = f.start();
  f.engine.exit();
  expect((await f.outcome(cancelled)).kind).toBe('rejected');
  expect(f.engine.isLoaded()).toBe(false);
  await f.engine.load();
  try {
    const next = f.start();
    old.options.onExit?.(0);
    old.options.onExit?.(1);
    old.options.print('FFMPEG_END');
    expect((await f.outcome(next)).kind).toBe('pending');
    f.cores[1].options.onExit?.(0);
    expect((await f.outcome(next)).kind).toBe('resolved');
  } finally {
    f.engine.exit();
  }
});

for (const status of [undefined, '0', NaN, 0.5])
  test(`invalid numeric status ${String(status)} tears down and cannot affect a new generation`, async () => {
    const f = fixture();
    await f.engine.load();
    const old = f.cores[0];
    const p = f.start();
    old.options.onExit?.(status);
    old.options.print('FFMPEG_END');
    expect((await f.outcome(p)).kind).toBe('rejected');
    expect(f.engine.isLoaded()).toBe(false);
    await f.engine.load();
    try {
      const next = f.start();
      old.options.onExit?.(0);
      expect((await f.outcome(next)).kind).toBe('pending');
      f.cores[1].options.onExit?.(0);
      expect((await f.outcome(next)).kind).toBe('resolved');
    } finally {
      f.engine.exit();
    }
  });

test('synchronous dispatch error tears down stale state and a fresh generation can execute', async () => {
  const f = fixture();
  await f.engine.load();
  const old = f.cores[0];
  old.failDispatch = true;
  const failed = await f.outcome(f.start());
  expect(failed.kind).toBe('rejected');
  expect(f.engine.isLoaded()).toBe(false);
  expect(old.exits).toBe(0);
  expect(old.stops).toBe(1);
  await f.engine.load();
  try {
    const next = f.start();
    old.options.onExit?.(0);
    expect((await f.outcome(next)).kind).toBe('pending');
    f.cores[1].options.onExit?.(0);
    expect((await f.outcome(next)).kind).toBe('resolved');
  } finally {
    f.engine.exit();
  }
});

test('private worker-stop ABI is bound to the approved core version and three assets', () => {
  expect(requireRoot('@ffmpeg.wasm/core-mt/package.json').version).toBe(
    '0.12.0',
  );
  const expected = {
    'ffmpeg-core.js':
      'c91d79f301e773d62c0aa3f88f27e8dd3ae707593b9df5a48cf34d8f98af41a3',
    'ffmpeg-core.wasm':
      '53a0867b66993154b2ad437e082fa8959ac09dca0316259ec051b3565f09484d',
    'ffmpeg-core.worker.js':
      '694b8f738e0dd27719a77525353f925db5566b3dd468b9d623c17a55810bd97e',
  };
  for (const [name, hash] of Object.entries(expected))
    expect(
      createHash('sha256')
        .update(
          readFileSync(
            path.join(
              path.dirname(requireRoot.resolve('@ffmpeg.wasm/core-mt')),
              name,
            ),
          ),
        )
        .digest('hex'),
    ).toBe(hash);
});

test('superseded load stops only its own workers and cannot settle the newer active job', async () => {
  const f = fixture();
  f.controls.deferNextLoad = true;
  const oldLoad = f.engine.load().then(
    () => ({ resolved: true }),
    (error) => ({ resolved: false, error }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.controls.waiting).toHaveLength(1);
  await f.engine.load();
  const current = f.start();
  f.controls.waiting[0]();
  expect((await oldLoad).resolved).toBe(false);
  expect(f.cores[0].stops).toBe(1);
  expect(f.cores[0].exits).toBe(0);
  f.cores[0].options.onExit?.(0);
  expect((await f.outcome(current)).kind).toBe('pending');
  f.cores[1].options.onExit?.(0);
  expect((await f.outcome(current)).kind).toBe('resolved');
  f.engine.exit();
});

for (const field of ['pd', 'Rb', 'Vb', 'Gb'])
  test(`unsupported worker pool ${field} reports disposal failure without native exit`, async () => {
    const f = fixture();
    await f.engine.load();
    f.cores[0].PThread[field] = undefined;
    const job = f.start();
    expect(() => f.engine.exit()).toThrow(/unsupported.*core/i);
    const failed = await f.outcome(job);
    expect(failed.kind).toBe('rejected');
    expect((failed as { error: { code: string } }).error.code).toBe(
      'FFMPEG_UNSUPPORTED_CORE_DISPOSAL',
    );
    expect(f.cores[0].exits).toBe(0);
    expect(f.cores[0].stops).toBe(0);
    expect(f.engine.isLoaded()).toBe(false);
    await f.engine.load();
    const next = f.start();
    f.cores[0].options.onExit?.(0);
    expect((await f.outcome(next)).kind).toBe('pending');
    f.cores[1].options.onExit?.(0);
    expect((await f.outcome(next)).kind).toBe('resolved');
    f.engine.exit();
  });

test('invalid worker objects are unsupported and never trigger native destructor exit', async () => {
  const f = fixture();
  await f.engine.load();
  f.cores[0].PThread.Rb = [{}];
  const job = f.start();
  expect(() => f.engine.exit()).toThrow(/unsupported.*core/i);
  const failed = await f.outcome(job);
  expect(failed.kind).toBe('rejected');
  expect((failed as { error: { code: string } }).error.code).toBe(
    'FFMPEG_UNSUPPORTED_CORE_DISPOSAL',
  );
  expect(f.cores[0].exits).toBe(0);
  expect(f.cores[0].stops).toBe(0);
});

test('worker-stop failure rejects explicitly without claiming cleanup or using native exit', async () => {
  const f = fixture();
  await f.engine.load();
  f.cores[0].PThread.pd = () => {
    throw Error('Owned worker termination fault');
  };
  const job = f.start();
  expect(() => f.engine.exit()).toThrow('Could not stop ffmpeg core workers');
  const failed = await f.outcome(job);
  expect(failed.kind).toBe('rejected');
  expect((failed as { error: { code: string } }).error.code).toBe(
    'FFMPEG_CORE_DISPOSAL_FAILED',
  );
  expect(f.cores[0].exits).toBe(0);
  expect(f.engine.isLoaded()).toBe(false);
});

test('unsupported superseded core reports disposal failure without affecting the newer job', async () => {
  const f = fixture();
  f.controls.deferNextLoad = true;
  const oldLoad = f.engine.load().then(
    () => ({ resolved: true }),
    (error) => ({ resolved: false, error }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  f.cores[0].PThread.pd = undefined;
  await f.engine.load();
  const current = f.start();
  f.controls.waiting[0]();
  const old = await oldLoad;
  expect(old.resolved).toBe(false);
  expect((old as { error: { code: string } }).error.code).toBe(
    'FFMPEG_UNSUPPORTED_CORE_DISPOSAL',
  );
  expect(f.cores[0].exits).toBe(0);
  f.cores[0].options.onExit?.(0);
  expect((await f.outcome(current)).kind).toBe('pending');
  f.cores[1].options.onExit?.(0);
  expect((await f.outcome(current)).kind).toBe('resolved');
  f.engine.exit();
});
