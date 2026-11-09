import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { test, expect, _electron as electron } from '@playwright/test';

import {
  assertStartupFacts,
  refreshStartupFacts,
  waitForStartupFacts,
} from './helpers/electron-startup.js';

process.env.NODE_ENV = 'test';

const appPath = path.resolve(import.meta.dirname, '..');
const observer = path.resolve(
  import.meta.dirname,
  'helpers/electron-startup-observer.cjs',
);

test('Pear Desktop App - With default settings, app is launched and visible', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-desktop-test-'));
  const profile = path.join(directory, 'profile');
  const factsPath = path.join(directory, 'startup.json');
  let app;
  let child;
  try {
    await mkdir(profile);
    app = await electron.launch({
      cwd: appPath,
      args: [
        '--require',
        observer,
        appPath,
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-gpu',
        '--whitelisted-ips=',
        '--disable-dev-shm-usage',
      ],
      env: { ...process.env, PEAR_TEST_STARTUP_FACTS: factsPath },
    });
    child = app.process();
    await waitForStartupFacts(child, factsPath);
    const window = await app.firstWindow();

    // First launch can show Google's regional consent page before Music.
    await expect
      .poll(() => window.url())
      .toMatch(/^https:\/\/(music|consent)\.youtube\.com(?:\/|$)/);
    const facts = await refreshStartupFacts(child, factsPath);
    await assertStartupFacts(child, facts, profile);
    expect(window.isClosed()).toBe(false);
  } finally {
    try {
      if (app && child?.exitCode === null && child.signalCode === null)
        await app.close();
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});
