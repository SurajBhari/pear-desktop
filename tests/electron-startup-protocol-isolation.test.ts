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

type LoginIsolationProof = {
  loginDelegated: { openAtLogin: boolean }[];
  protocolDelegated: string[];
  calls: { phase: string; openAtLogin: boolean; resultIsVoid: boolean }[];
  observerBeforeReady: boolean;
  refused: string | null;
  settersUnchangedAfterRefusal: boolean;
};

async function closeOwnedLoginFixture(
  application: import('@playwright/test').ElectronApplication,
) {
  const child = application.process();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Owned login fixture cleanup timed out')),
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

async function withLoginObserverFixture(
  mode: 'valid' | 'missing-facts' | 'wrong-process',
  check: (
    application: import('@playwright/test').ElectronApplication,
    profile: string,
    factsPath: string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-login-isolation-'));
  const profile = path.join(directory, 'profile');
  const factsPath = path.join(directory, 'startup.json');
  const bootstrap = path.join(directory, 'bootstrap.cjs');
  const entry = path.join(directory, 'main.cjs');
  let application: import('@playwright/test').ElectronApplication | undefined;
  try {
    await mkdir(profile);
    // Replace the native setters first; never retain or invoke the OS methods.
    await writeFile(
      bootstrap,
      `
const { app } = require('electron');
const proof = globalThis.loginIsolation = { loginDelegated: [], protocolDelegated: [], calls: [], observerBeforeReady: !app.isReady(), refused: null, settersUnchangedAfterRefusal: false };
const loginRecorder = app.setLoginItemSettings = options => { proof.loginDelegated.push({ openAtLogin: options.openAtLogin }); };
const setRecorder = app.setAsDefaultProtocolClient = () => { proof.protocolDelegated.push('set'); return true; };
const removeRecorder = app.removeAsDefaultProtocolClient = () => { proof.protocolDelegated.push('remove'); return true; };
const typeDescriptor = Object.getOwnPropertyDescriptor(process, 'type');
try {
  if (${JSON.stringify(mode)} === 'missing-facts') delete process.env.PEAR_TEST_STARTUP_FACTS;
  if (${JSON.stringify(mode)} === 'wrong-process') Object.defineProperty(process, 'type', { ...typeDescriptor, value: 'renderer' });
  require(${JSON.stringify(observer)});
} catch (error) {
  proof.refused = error.message;
} finally {
  if (${JSON.stringify(mode)} === 'wrong-process') Object.defineProperty(process, 'type', typeDescriptor);
}
proof.settersUnchangedAfterRefusal = app.setLoginItemSettings === loginRecorder && app.setAsDefaultProtocolClient === setRecorder && app.removeAsDefaultProtocolClient === removeRecorder;
proof.call = phase => {
  app.setAsDefaultProtocolClient('peard', process.execPath, ['owned-login-fixture']);
  app.removeAsDefaultProtocolClient('peard', process.execPath, ['owned-login-fixture']);
  for (const openAtLogin of [true, false]) proof.calls.push({ phase, openAtLogin, resultIsVoid: app.setLoginItemSettings({ openAtLogin }) === undefined });
};
if (${JSON.stringify(mode)} === 'valid') proof.call('before-entry');
`,
    );
    await writeFile(
      entry,
      `
const { app, BrowserWindow } = require('electron');
const proof = globalThis.loginIsolation;
if (${JSON.stringify(mode)} === 'valid') proof.call('entry');
app.whenReady().then(async () => {
  if (${JSON.stringify(mode)} === 'valid') proof.call('ready');
  const window = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { sandbox: true } });
  await window.loadURL('data:text/html,<title>Owned login isolation fixture</title>');
  window.showInactive();
  if (${JSON.stringify(mode)} === 'valid') proof.call('after-window');
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
    await application.firstWindow();
    await check(application, profile, factsPath);
  } finally {
    try {
      if (application) await closeOwnedLoginFixture(application);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}

test('startup observer sinks native login changes before entry through window readiness without delegation', async () => {
  test.setTimeout(25_000);
  await withLoginObserverFixture(
    'valid',
    async (application, profile, factsPath) => {
      const child = application.process();
      await assertStartupFacts(
        child,
        await waitForStartupFacts(child, factsPath, 2000),
        profile,
      );
      const facts = await refreshStartupFacts(child, factsPath, 2000);
      await assertStartupFacts(child, facts, profile);
      const proof = await application.evaluate(() => {
        const {
          loginDelegated,
          protocolDelegated,
          calls,
          observerBeforeReady,
          refused,
          settersUnchangedAfterRefusal,
        } = (
          globalThis as typeof globalThis & {
            loginIsolation: LoginIsolationProof;
          }
        ).loginIsolation;
        return {
          loginDelegated,
          protocolDelegated,
          calls,
          observerBeforeReady,
          refused,
          settersUnchangedAfterRefusal,
        };
      });
      console.log('LOGIN_ISOLATION', JSON.stringify({ ...proof, facts }));
      expect(proof.refused).toBeNull();
      expect(proof.observerBeforeReady).toBe(true);
      expect(proof.protocolDelegated).toEqual([]);
      expect(proof.calls).toEqual([
        { phase: 'before-entry', openAtLogin: true, resultIsVoid: true },
        { phase: 'before-entry', openAtLogin: false, resultIsVoid: true },
        { phase: 'entry', openAtLogin: true, resultIsVoid: true },
        { phase: 'entry', openAtLogin: false, resultIsVoid: true },
        { phase: 'ready', openAtLogin: true, resultIsVoid: true },
        { phase: 'ready', openAtLogin: false, resultIsVoid: true },
        { phase: 'after-window', openAtLogin: true, resultIsVoid: true },
        { phase: 'after-window', openAtLogin: false, resultIsVoid: true },
      ]);
      expect(proof.loginDelegated).toEqual([]);
    },
  );
});

for (const mode of ['missing-facts', 'wrong-process'] as const) {
  test(`startup observer refuses ${mode} before changing any native setter`, async () => {
    test.setTimeout(25_000);
    await withLoginObserverFixture(mode, async (application) => {
      const proof = await application.evaluate(() => {
        const {
          refused,
          settersUnchangedAfterRefusal,
          loginDelegated,
          protocolDelegated,
        } = (
          globalThis as typeof globalThis & {
            loginIsolation: LoginIsolationProof;
          }
        ).loginIsolation;
        return {
          refused,
          settersUnchangedAfterRefusal,
          loginDelegated,
          protocolDelegated,
        };
      });
      console.log('LOGIN_OBSERVER_REFUSAL', JSON.stringify({ mode, ...proof }));
      expect(proof.refused).toMatch(/test-owned main-process facts path/);
      expect(proof.settersUnchangedAfterRefusal).toBe(true);
      expect(proof.loginDelegated).toEqual([]);
      expect(proof.protocolDelegated).toEqual([]);
    });
  });
}
