import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { windowsLaunchEvidence } from './helpers/windows-launch-evidence';

const options = {
  windowsHide: true as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
};
const secret = 'PRIVATE_PATH_TOKEN_AND_ERROR';

test('launch observation preserves actual process options streams and response bytes', async () => {
  let forwarded = false;
  const evidence = windowsLaunchEvidence((file, args, received) => {
    forwarded = received === options && file === process.execPath;
    return spawn(file, args, received);
  });
  const packet = JSON.stringify({
    version: 1,
    type: 'read',
    contents64: secret,
  });
  const child = evidence.launch(
    process.execPath,
    [
      '-e',
      `process.stdout.write(${JSON.stringify(packet + '\n')});process.stderr.write(${JSON.stringify(secret)})`,
    ],
    options,
  );
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stdin.end();
  await closed;
  expect(forwarded).toBe(true);
  expect(output).toBe(packet + '\n');
  expect(evidence.snapshot()).toEqual([
    expect.objectContaining({
      spawned: true,
      frame: 'read',
      stdoutBytes: Buffer.byteLength(packet + '\n'),
      stderrBytes: secret.length,
      close: 'zero',
    }),
  ]);
  expect(JSON.stringify(evidence.snapshot())).not.toContain(secret);
});

test('launch errors preserve original exception without retaining exception details', () => {
  const original = new Error(secret);
  const evidence = windowsLaunchEvidence(() => {
    throw original;
  });
  expect(() => evidence.launch(secret, [secret], options)).toThrow(original);
  expect(evidence.snapshot()).toEqual([
    expect.objectContaining({
      launchError: true,
      spawned: false,
      close: 'not-closed',
    }),
  ]);
  expect(JSON.stringify(evidence.snapshot())).not.toContain(secret);
});

test('malformed oversized output is bounded and never copied into evidence', async () => {
  const evidence = windowsLaunchEvidence();
  const child = evidence.launch(
    process.execPath,
    [
      '-e',
      `process.stdout.write('x'.repeat(1048576)+${JSON.stringify(secret)}+'\\n');process.stderr.write('y'.repeat(2048))`,
    ],
    options,
  );
  const closed = once(child, 'close');
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end();
  await closed;
  expect(evidence.snapshot()).toEqual([
    expect.objectContaining({
      frame: 'oversize',
      stdoutBytes: 1048577,
      stderrBytes: 1025,
      close: 'zero',
    }),
  ]);
  expect(JSON.stringify(evidence.snapshot()).length).toBeLessThan(512);
  expect(JSON.stringify(evidence.snapshot())).not.toContain(secret);
});

test('observing failure packets and signalled exit does not interfere with termination', async () => {
  const evidence = windowsLaunchEvidence();
  const child = evidence.launch(
    process.execPath,
    [
      '-e',
      `process.stdout.write('{"version":1,"type":"failure"}\\n');setInterval(()=>{},1000)`,
    ],
    options,
  );
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  expect(evidence.snapshot()).toEqual([
    expect.objectContaining({
      spawned: true,
      frame: 'failure',
      close: 'signal',
    }),
  ]);
  const row = evidence.snapshot()[0] as { elapsedMs: number };
  expect(Number.isFinite(row.elapsedMs)).toBe(true);
  expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
});
