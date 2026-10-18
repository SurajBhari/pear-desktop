import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import { test, expect, _electron as electron } from '@playwright/test';

import {
  assertStartupFacts,
  nativeStartupPid,
  refreshStartupFacts,
  terminateStartupProcess,
  waitForStartupFacts,
} from './helpers/electron-startup.js';

const observer = path.resolve(
  import.meta.dirname,
  'helpers/electron-startup-observer.cjs',
);

// BEGIN OWNED FIXTURE EXIT
function fixtureExitReady(token) {
  return JSON.stringify({ version: 1, token, phase: 'READY' });
}

async function requestFixtureExit(
  { child, actionPath, actionDone, token },
  io = {
    readFile,
    writeFile,
    now: () => performance.now(),
    sleep: (delay, signal) => pause(delay, undefined, { signal }),
    setTimeout,
    clearTimeout,
  },
) {
  const deadline = io.now() + 2000;
  const controller = new AbortController();
  const timeoutError = new Error('Owned fixture exit phase timed out');
  let expired = false,
    active = true,
    publishing = false,
    onExit,
    timer;
  const timeout = new Promise((_, reject) => {
    timer = io.setTimeout(() => {
      expired = true;
      reject(timeoutError);
      controller.abort();
    }, 2000);
  });
  // Observe rejection even if synchronous setup/I/O fails before a race is armed.
  timeout.catch(() => {});
  const withinDeadline = () => {
    if (expired || io.now() >= deadline) throw timeoutError;
  };
  const running = () => {
    assert(
      child.exitCode === null && child.signalCode === null,
      'Fixture exited before the owned exit request',
    );
  };
  const bounded = (operation) => Promise.race([operation, timeout]);
  try {
    for (;;) {
      withinDeadline();
      running();
      let marker;
      try {
        marker = await bounded(
          io.readFile(actionDone, {
            encoding: 'utf8',
            signal: controller.signal,
          }),
        );
      } catch (error) {
        withinDeadline();
        if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
      }
      withinDeadline();
      running();
      if (marker !== undefined) {
        assert.equal(marker, fixtureExitReady(token), 'Wrong fixture READY');
        break;
      }
      await bounded(
        io.sleep(Math.min(20, deadline - io.now()), controller.signal),
      );
    }
    let observedExit;
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    exited.catch(() => {});
    onExit = (code, signal) => {
      if (!active) return;
      observedExit = { code, signal, requested: publishing };
      resolveExit(observedExit);
    };
    child.once('exit', onExit);
    withinDeadline();
    running();
    assert(!observedExit, 'Fixture exited before action publication');
    publishing = true;
    await bounded(
      io.writeFile(actionPath, 'exit:' + token, {
        flag: 'wx',
        signal: controller.signal,
      }),
    );
    withinDeadline();
    const result = await bounded(exited);
    withinDeadline();
    assert.equal(result.requested, true);
    assert.equal(result.code, 23);
    assert.equal(result.signal, null);
    assert.equal(child.exitCode, 23);
    assert.equal(child.signalCode, null);
  } catch (error) {
    throw expired ? timeoutError : error;
  } finally {
    active = false;
    controller.abort();
    try {
      if (onExit) child.off('exit', onExit);
    } finally {
      if (timer !== undefined) io.clearTimeout(timer);
    }
  }
}
// END OWNED FIXTURE EXIT

test.describe('test-only Electron startup observer', () => {
  /**
   * @param {{ wrongProfile?: boolean, visible?: boolean, preload?: boolean, exit?: boolean, delayedShow?: boolean, missingWatchFilename?: boolean }} options
   * @param {(fixture: { application: import('@playwright/test').ElectronApplication, child: import('node:child_process').ChildProcess, profile: string, factsPath: string, actionPath: string, actionDone: string, token: string }) => Promise<void>} check
   */
  async function withFixture(options, check) {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pear-startup-observer-'),
    );
    const profile = path.join(directory, 'profile');
    const wrongProfile = path.join(directory, 'wrong-profile');
    const factsPath = path.join(directory, 'facts.json');
    const actionPath = path.join(directory, 'action.txt');
    const actionDone = path.join(directory, 'action-done.json');
    const token = path.basename(directory);
    let application;
    let child;
    try {
      await mkdir(profile);
      await mkdir(wrongProfile);
      const entry = path.join(directory, 'main.cjs');
      const watcherPreload = path.join(directory, 'watcher.cjs');
      await writeFile(
        watcherPreload,
        "const fs = require('node:fs'); const watch = fs.watch; fs.watch = (directory, callback) => watch(directory, (event) => callback(event, null));",
      );
      await writeFile(
        entry,
        `
        const { app, BrowserWindow } = require('electron');
        const fs = require('node:fs');
        const ownedWindows = [];
        app.on('browser-window-created', (_event, nativeWindow) => ownedWindows.push(nativeWindow));
        if (${Boolean(options.wrongProfile)}) app.setPath('userData', ${JSON.stringify(wrongProfile)});
        app.whenReady().then(() => {
          const window = new BrowserWindow({ show: ${options.visible !== false && !options.delayedShow}, width: 320, height: 240 });
          window.loadURL('data:text/html,<title>Owned startup fixture</title>');
          let actionHandled = false;
          fs.watchFile(${JSON.stringify(actionPath)}, { interval: 20 }, (current) => {
            if (actionHandled || !current.nlink) return;
            let action;
            if (${Boolean(options.exit)}) {
              action = fs.readFileSync(${JSON.stringify(actionPath)}, 'utf8');
              const expected = ${JSON.stringify('exit:' + token)};
              if (action !== expected && expected.startsWith(action)) return;
            }
            actionHandled = true;
            fs.unwatchFile(${JSON.stringify(actionPath)});
            if (!${Boolean(options.exit)}) action = fs.readFileSync(${JSON.stringify(actionPath)}, 'utf8');
            const publishState = () => {
              const state = { closed: window.isDestroyed(), visible: !window.isDestroyed() && window.isVisible() };
              fs.writeFileSync(${JSON.stringify(actionDone)} + '.tmp', JSON.stringify(state));
              fs.renameSync(${JSON.stringify(actionDone)} + '.tmp', ${JSON.stringify(actionDone)});
            };
            if (action === 'hide') { window.hide(); publishState(); }
            else if (action === 'close') {
              new BrowserWindow({ show: false, width: 160, height: 120 });
              window.once('closed', publishState);
              window.close();
            }
            else if (${Boolean(options.exit)} && action === ${JSON.stringify('exit:' + token)}) app.exit(23);
            else throw new Error('Unknown owned fixture action');
          });
          if (${Boolean(options.exit)}) {
            const temporary = ${JSON.stringify(actionDone)} + '.ready.tmp';
            fs.writeFileSync(temporary, ${JSON.stringify(fixtureExitReady(token))}, { flag: 'wx' });
            fs.renameSync(temporary, ${JSON.stringify(actionDone)});
          }
          ${options.delayedShow ? 'setTimeout(() => window.show(), 50);' : ''}
        });
      `,
      );
      application = await electron.launch({
        args: [
          ...(options.missingWatchFilename
            ? ['--require', watcherPreload]
            : []),
          ...(options.preload === false ? [] : ['--require', observer]),
          entry,
          `--user-data-dir=${profile}`,
          '--no-sandbox',
          '--disable-gpu',
        ],
        env: { ...process.env, PEAR_TEST_STARTUP_FACTS: factsPath },
      });
      child = application.process();
      await application.firstWindow();
      await check({
        application,
        child,
        profile,
        factsPath,
        actionPath,
        actionDone,
        token,
      });
    } finally {
      try {
        if (
          application &&
          child?.exitCode === null &&
          child.signalCode === null
        )
          await application.close();
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  }

  test('captures the actual isolated profile and native visible window', async () => {
    await withFixture({}, async ({ child, profile, factsPath }) => {
      const facts = await waitForStartupFacts(child, factsPath, 2000);
      await assertStartupFacts(child, facts, profile);
      expect(facts.pid).toBe(await nativeStartupPid(child));
      expect(facts.visibleWindow).toBe(true);
    });
  });

  test('missing preload facts remain a failure despite a real visible window', async () => {
    await withFixture({ preload: false }, async ({ child, factsPath }) => {
      await expect(waitForStartupFacts(child, factsPath, 200)).rejects.toThrow(
        /No startup facts/,
      );
    });
  });

  test('observes a window shown after app ready and window creation', async () => {
    await withFixture(
      { delayedShow: true },
      async ({ child, profile, factsPath }) => {
        const facts = await waitForStartupFacts(child, factsPath, 2000);
        await assertStartupFacts(child, facts, profile);
      },
    );
  });

  test('foreign process and false visibility facts remain failures', async () => {
    await withFixture({}, async ({ child, profile, factsPath }) => {
      const facts = await waitForStartupFacts(child, factsPath, 2000);
      await expect(
        assertStartupFacts(child, { ...facts, pid: -1 }, profile),
      ).rejects.toThrow(/different process/);
      await expect(
        assertStartupFacts(child, { ...facts, visibleWindow: false }, profile),
      ).rejects.toThrow(/visible window/);
    });
  });

  test('a hidden native window cannot satisfy startup visibility', async () => {
    await withFixture({ visible: false }, async ({ child, factsPath }) => {
      await expect(waitForStartupFacts(child, factsPath, 200)).rejects.toThrow(
        /No startup facts/,
      );
    });
  });

  test('the wrong real userData path remains a failure', async () => {
    await withFixture(
      { wrongProfile: true },
      async ({ child, profile, factsPath }) => {
        const facts = await waitForStartupFacts(child, factsPath, 2000);
        await expect(assertStartupFacts(child, facts, profile)).rejects.toThrow(
          /userData/,
        );
      },
    );
  });

  test('a genuine main-process exit remains a failure with its actual code', async () => {
    await withFixture(
      { visible: false, exit: true },
      async ({ child, factsPath, actionPath, actionDone, token }) => {
        await requestFixtureExit({ child, actionPath, actionDone, token });
        await expect(
          waitForStartupFacts(child, factsPath, 2000),
        ).rejects.toThrow(/exited.*23/);
        expect(child.exitCode).toBe(23);
      },
    );
  });

  test('abrupt process termination remains a failure and permits owned cleanup', async () => {
    await withFixture({ visible: false }, async ({ child, factsPath }) => {
      await terminateStartupProcess(child);
      await expect(waitForStartupFacts(child, factsPath, 2000)).rejects.toThrow(
        /exited/,
      );
    });
  });

  test('malformed facts fail immediately instead of being retried as readiness', async () => {
    await withFixture({ preload: false }, async ({ child, factsPath }) => {
      await writeFile(factsPath, '{');
      await expect(waitForStartupFacts(child, factsPath, 2000)).rejects.toThrow(
        SyntaxError,
      );
    });
  });

  test('stale facts cannot satisfy refresh when the observer is absent', async () => {
    await withFixture(
      { preload: false },
      async ({ child, profile, factsPath }) => {
        await writeFile(
          factsPath,
          JSON.stringify({
            pid: child.pid,
            userData: profile,
            visibleWindow: true,
          }),
        );
        await expect(
          refreshStartupFacts(child, factsPath, 200),
        ).rejects.toThrow(/No refreshed startup facts acknowledgement/);
      },
    );
  });

  test('refresh acknowledges the exact owned request when directory events omit filenames', async () => {
    await withFixture(
      { missingWatchFilename: true },
      async ({ child, profile, factsPath }) => {
        await waitForStartupFacts(child, factsPath, 2000);
        const facts = await refreshStartupFacts(child, factsPath, 500);
        await assertStartupFacts(child, facts, profile);
      },
    );
  });

  for (const action of ['close', 'hide']) {
    test(`a window that ${action}s after initial facts cannot retain valid visibility`, async () => {
      await withFixture(
        {},
        async ({
          application,
          child,
          profile,
          factsPath,
          actionPath,
          actionDone,
        }) => {
          const page = await application.firstWindow();
          const initial = await waitForStartupFacts(child, factsPath, 2000);
          await assertStartupFacts(child, initial, profile);
          await writeFile(actionPath, action);
          await expect
            .poll(async () => {
              try {
                return await readFile(actionDone, 'utf8');
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  !('code' in error) ||
                  error.code !== 'ENOENT'
                )
                  throw error;
                return '';
              }
            })
            .toBe(
              action === 'close'
                ? '{"closed":true,"visible":false}'
                : '{"closed":false,"visible":false}',
            );
          await expect.poll(() => page.isClosed()).toBe(action === 'close');
          expect(child.exitCode).toBeNull();
          const current = await refreshStartupFacts(child, factsPath, 2000);
          await expect(
            assertStartupFacts(child, current, profile),
          ).rejects.toThrow(/visible window/);
        },
      );
    });
  }
});
