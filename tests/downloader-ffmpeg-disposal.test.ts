import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

test.skip(
  process.env.PEAR_REAL_FFMPEG_TEST !== '1',
  'Explicit externally supervised real-core qualification',
);
test.setTimeout(30_000);
for (const mode of [
  'cancel',
  'sync-fault',
  'invalid-status',
  'superseded',
  'unsupported',
  'gc',
])
  test(`actual pinned core worker disposal: ${mode}`, async () => {
    const root =
      process.env.PEAR_REAL_FFMPEG_REPORT ??
      (await mkdtemp(path.join(tmpdir(), 'pear-disposal-')));
    const out = path.join(root, 'disposal-' + mode);
    try {
      const child = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, 'helpers/supervise-ffmpeg.cjs'),
          mode,
          out,
        ],
        { encoding: 'utf8', timeout: 25000, env: process.env },
      );
      expect(child.error).toBeUndefined();
      expect(
        child.status,
        child.stdout +
          '\n' +
          child.stderr +
          '\n' +
          (await readFile(path.join(out, 'execution.log'), 'utf8')),
      ).toBe(0);
      const report = JSON.parse(
        await readFile(path.join(out, 'result.json'), 'utf8'),
      ) as { passed: boolean };
      expect(report.passed).toBe(true);
    } finally {
      if (!process.env.PEAR_REAL_FFMPEG_REPORT)
        await rm(root, { recursive: true, force: true });
    }
  });

for (const mode of [
  'cancel',
  'sync-fault',
  'invalid-status',
  'superseded',
  'unsupported',
])
  test(`windowless Electron pinned-core worker disposal: ${mode}`, async () => {
    test.skip(
      !process.env.PEAR_FFMPEG_ELECTRON,
      'Explicit owned stock Electron runtime required',
    );
    const root =
      process.env.PEAR_REAL_FFMPEG_REPORT ??
      (await mkdtemp(path.join(tmpdir(), 'pear-disposal-electron-')));
    const out = path.join(root, 'disposal-electron-' + mode);
    try {
      const child = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, 'helpers/supervise-ffmpeg.cjs'),
          mode,
          out,
          'electron',
        ],
        { encoding: 'utf8', timeout: 25000, env: process.env },
      );
      expect(child.error).toBeUndefined();
      expect(
        child.status,
        child.stdout +
          '\n' +
          child.stderr +
          '\n' +
          (await readFile(path.join(out, 'execution.log'), 'utf8')),
      ).toBe(0);
      const report = JSON.parse(
        await readFile(path.join(out, 'result.json'), 'utf8'),
      ) as {
        passed: boolean;
        runtime: { electron: string };
        electronPaths: { userData: string };
      };
      expect(report.passed).toBe(true);
      expect(report.runtime.electron).toBe('42.10.0');
      expect(report.electronPaths.userData).toContain('pear-ffmpeg-runtime-');
    } finally {
      if (!process.env.PEAR_REAL_FFMPEG_REPORT)
        await rm(root, { recursive: true, force: true });
    }
  });
