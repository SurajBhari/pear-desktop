import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

import {
  assertStartupFacts,
  refreshStartupFacts,
  terminateStartupProcess,
  waitForStartupFacts,
} from './helpers/electron-startup.js';

const observer = path.resolve(
  import.meta.dirname,
  'helpers/electron-startup-observer.cjs',
);

test('startup observer sinks native protocol registration before entry and after ready without delegation', async () => {
  test.setTimeout(25_000);
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-protocol-isolation-'),
  );
  const profile = path.join(directory, 'profile');
  const factsPath = path.join(directory, 'startup.json');
  const bootstrap = path.join(directory, 'bootstrap.cjs');
  const entry = path.join(directory, 'main.cjs');
  let application: import('@playwright/test').ElectronApplication | undefined;
  try {
    await mkdir(profile);
    // These recording delegates replace the actual native methods FIRST. The
    // baseline observer can therefore fail without touching an OS association.
    await writeFile(
      bootstrap,
      `
const { app } = require('electron');
const proof = globalThis.protocolIsolation = { delegated: [], calls: [], entryStarted: false, observerBeforeReady: !app.isReady() };
app.setAsDefaultProtocolClient = (...args) => { proof.delegated.push({ method: 'set', args }); return true; };
app.removeAsDefaultProtocolClient = (...args) => { proof.delegated.push({ method: 'remove', args }); return true; };
require(${JSON.stringify(observer)});
proof.call = phase => {
  proof.calls.push({ phase, entryStarted: proof.entryStarted, ready: app.isReady(),
    set: app.setAsDefaultProtocolClient('peard', process.execPath, ['owned-fixture']),
    remove: app.removeAsDefaultProtocolClient('peard', process.execPath, ['owned-fixture']) });
};
proof.call('before-entry');
`,
    );
    await writeFile(
      entry,
      `
const { app, BrowserWindow } = require('electron');
const proof = globalThis.protocolIsolation;
proof.entryStarted = true;
proof.call('entry');
app.whenReady().then(async () => {
  proof.call('ready');
  const window = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { sandbox: true } });
  await window.loadURL('data:text/html,<title>Owned protocol isolation fixture</title>');
  window.showInactive();
});
`,
    );
    const env = { ...process.env, PEAR_TEST_STARTUP_FACTS: factsPath };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      cwd: directory,
      args: [
        '--require',
        bootstrap,
        entry,
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
      env,
      timeout: 10_000,
    });
    const child = application.process();
    await application.firstWindow();
    const initial = await waitForStartupFacts(child, factsPath, 2000);
    await assertStartupFacts(child, initial, profile);
    const facts = await refreshStartupFacts(child, factsPath, 2000);
    await assertStartupFacts(child, facts, profile);
    const proof = await application.evaluate(() => {
      const value = (
        globalThis as typeof globalThis & {
          protocolIsolation: {
            delegated: { method: string; args: unknown[] }[];
            calls: {
              phase: string;
              entryStarted: boolean;
              ready: boolean;
              set: boolean;
              remove: boolean;
            }[];
            observerBeforeReady: boolean;
          };
        }
      ).protocolIsolation;
      return {
        delegated: value.delegated,
        calls: value.calls,
        observerBeforeReady: value.observerBeforeReady,
      };
    });
    console.log('PROTOCOL_ISOLATION', JSON.stringify({ ...proof, facts }));
    expect(proof.observerBeforeReady).toBe(true);
    expect(proof.calls).toEqual([
      {
        phase: 'before-entry',
        entryStarted: false,
        ready: false,
        set: true,
        remove: true,
      },
      {
        phase: 'entry',
        entryStarted: true,
        ready: false,
        set: true,
        remove: true,
      },
      {
        phase: 'ready',
        entryStarted: true,
        ready: true,
        set: true,
        remove: true,
      },
    ]);
    expect(proof.delegated).toEqual([]);
  } finally {
    try {
      if (application) {
        const child = application.process();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            application.close(),
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error('Owned Electron cleanup timed out')),
                5000,
              );
            }),
          ]);
        } finally {
          if (deadline) clearTimeout(deadline);
          if (child.exitCode === null && child.signalCode === null)
            await terminateStartupProcess(child);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});
