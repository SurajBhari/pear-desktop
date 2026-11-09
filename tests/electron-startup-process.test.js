import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';

import { test, expect } from '@playwright/test';

import * as startup from './helpers/electron-startup.js';

for (const exitCode of [0, 7]) {
  test(`query exit ${exitCode} removes its launcher hook while the launcher remains alive`, async () => {
    const launcher = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    const initialListeners = launcher.listenerCount('exit');
    try {
      const result = startup.runNativePidQuery(
        process.execPath,
        ['-e', `process.exit(${exitCode})`],
        1000,
        { launcher },
      );
      if (exitCode === 0) await result;
      else await expect(result).rejects.toThrow(/code=7.*killed=false/);
      expect(launcher.exitCode).toBeNull();
      expect(launcher.signalCode).toBeNull();
      const pid = launcher.pid;
      if (typeof pid !== 'number')
        throw new Error('Missing owned launcher PID');
      process.kill(pid, 0);
      expect(launcher.listenerCount('exit')).toBe(initialListeners);
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) {
        const exited = once(launcher, 'exit');
        launcher.kill();
        await exited;
      }
    }
  });
}

test('a native query completing after five seconds succeeds within its ten-second OS budget', async () => {
  const started = performance.now();
  const result = await startup.runNativePidQuery(process.execPath, [
    '-e',
    "setTimeout(() => process.stdout.write('[]'), 5500)",
  ]);
  expect(result.stdout).toBe('[]');
  expect(performance.now() - started).toBeGreaterThan(5000);
  expect(performance.now() - started).toBeLessThan(10_000);
});

test('the default OS query budget remains a hard ten-second timeout', async () => {
  const started = performance.now();
  await expect(
    startup.runNativePidQuery(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]),
  ).rejects.toThrow(/killed=true.*signal=SIGTERM.*timeoutMs=10000/);
  expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
});

test('launcher exit immediately aborts a pending query and preserves its actual exit code', async () => {
  const launcher = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.exit(23), 100)'],
    { stdio: 'ignore' },
  );
  const initialListeners = launcher.listenerCount('exit');
  const started = performance.now();
  try {
    await expect(
      startup.runNativePidQuery(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        10_000,
        { launcher },
      ),
    ).rejects.toThrow(/Electron exited.*code 23/);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(launcher.exitCode).toBe(23);
    expect(launcher.listenerCount('exit')).toBe(initialListeners);
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null)
      launcher.kill();
  }
});

test('quiet native query timeout retains killed, signal and deadline metadata in its message', async () => {
  expect(typeof startup.runNativePidQuery).toBe('function');
  await expect(
    startup.runNativePidQuery(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      100,
    ),
  ).rejects.toThrow(
    /code=null.*killed=true.*signal=SIGTERM.*elapsedMs=\d+.*timeoutMs=100/,
  );
});

test('quiet native query nonzero exit remains distinct from a timeout', async () => {
  expect(typeof startup.runNativePidQuery).toBe('function');
  await expect(
    startup.runNativePidQuery(
      process.execPath,
      ['-e', 'process.exit(7)'],
      1000,
    ),
  ).rejects.toThrow(/code=7.*killed=false.*signal=null.*timeoutMs=1000/);
});

test('successful native query preserves its exact output', async () => {
  expect(typeof startup.runNativePidQuery).toBe('function');
  const result = await startup.runNativePidQuery(
    process.execPath,
    ['-e', "process.stdout.write('[]')"],
    1000,
  );
  expect(result.stdout).toBe('[]');
});

test('native identity selects the actual executable from independently queried launcher children', async () => {
  expect(typeof startup.selectNativeStartupPid).toBe('function');
  expect(
    await startup.selectNativeStartupPid(
      [{ ProcessId: 123, ExecutablePath: process.execPath }],
      process.execPath,
    ),
  ).toBe(123);
});

/** @type {[string, { ProcessId: number, ExecutablePath: string | null }[]][]} */
const invalidProcesses = [
  ['missing child', []],
  ['nonpositive PID', [{ ProcessId: -1, ExecutablePath: process.execPath }]],
  ['fractional PID', [{ ProcessId: 1.5, ExecutablePath: process.execPath }]],
  ['missing executable', [{ ProcessId: 123, ExecutablePath: null }]],
  [
    'foreign executable',
    [{ ProcessId: 123, ExecutablePath: import.meta.filename }],
  ],
  [
    'ambiguous children',
    [
      { ProcessId: 123, ExecutablePath: process.execPath },
      { ProcessId: 124, ExecutablePath: process.execPath },
    ],
  ],
];
for (const [name, records] of invalidProcesses) {
  test(`native identity rejects ${name} instead of trusting startup facts`, async () => {
    expect(typeof startup.selectNativeStartupPid).toBe('function');
    await expect(
      startup.selectNativeStartupPid(records, process.execPath),
    ).rejects.toThrow(/native Electron process/);
  });
}
