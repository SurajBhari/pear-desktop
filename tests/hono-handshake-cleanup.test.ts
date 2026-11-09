import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

test('aborted websocket upgrades release their IncomingMessage objects', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--expose-gc',
      path.join(import.meta.dirname, 'fixtures/hono-handshake-cleanup.cjs'),
    ],
    { timeout: 10000 },
  );
  const result = JSON.parse(stdout);
  expect(result.capturedRequests).toBe(12);
  expect(result.statuses).toEqual(Array(12).fill(400));
  expect(result.retainedRequests).toBe(0);
});
