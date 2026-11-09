import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import {
  assertStartupFacts,
  refreshStartupFacts,
  waitForStartupFacts,
} from './helpers/electron-startup.js';

const root = path.resolve(import.meta.dirname, '..');

test('native unpainted startup shows at fallback while hidden and closed peers remain hidden', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-window-visibility-'),
  );
  const profile = path.join(directory, 'profile');
  const facts = path.join(directory, 'startup.json');
  let app: import('@playwright/test').ElectronApplication | undefined;
  try {
    await mkdir(profile);
    await writeFile(
      path.join(directory, 'window-visibility.mjs'),
      stripTypeScriptTypes(
        await readFile(
          path.join(root, 'src/providers/window-visibility.ts'),
          'utf8',
        ),
      ),
    );
    const entry = path.join(directory, 'main.cjs');
    await writeFile(
      entry,
      `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const owned=${JSON.stringify(directory)};
for(const key of ['userData','sessionData']){const target=key==='userData'?${JSON.stringify(profile)}:path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned profile');app.setPath(key,target);}
(async()=>{
 await app.whenReady();const {setupInitialWindowVisibility}=await import('./window-visibility.mjs');
 const make=()=>new BrowserWindow({show:false,backgroundColor:'#111111',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const win=make(),hidden=make(),closed=make();let ready=0,shows=0,hiddenShows=0,closedShows=0;
 win.on('ready-to-show',()=>ready++);
 const start=performance.now();
 const show=win.show.bind(win);win.show=()=>{shows++;globalThis.shownAfter=performance.now()-start;show();};
 const hiddenShow=hidden.show.bind(hidden);hidden.show=()=>{hiddenShows++;hiddenShow();};
 const closedShow=closed.show.bind(closed);closed.show=()=>{closedShows++;closedShow();};
 setupInitialWindowVisibility(win,()=>true);setupInitialWindowVisibility(hidden,()=>false);setupInitialWindowVisibility(closed,()=>true);closed.destroy();
 await new Promise(resolve=>setTimeout(resolve,750));
 globalThis.visibilityResult={ready,shows,hiddenShows,closedShows,after:globalThis.shownAfter,visible:win.isVisible(),hidden:hidden.isVisible(),closed:closed.isDestroyed()};
})().catch(()=>app.exit(1));
`,
    );
    const env = { ...process.env, PEAR_TEST_STARTUP_FACTS: facts };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      cwd: directory,
      args: [
        '--require',
        path.join(root, 'tests/helpers/electron-startup-observer.cjs'),
        entry,
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
      env,
    });
    const child = app.process();
    await waitForStartupFacts(child, facts);
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).visibilityResult))
      .toBeTruthy();
    const result = await app.evaluate(
      () => (globalThis as any).visibilityResult,
    );
    // Native macOS visibility can settle without Electron emitting show.
    // Dispatch counts instrument the real methods; public native state/facts
    // independently prove visibility and exact PID/profile ownership.
    expect(result).toMatchObject({
      ready: 0,
      shows: 1,
      hiddenShows: 0,
      closedShows: 0,
      visible: true,
      hidden: false,
      closed: true,
    });
    expect(result.after).toBeGreaterThanOrEqual(450);
    expect(result.after).toBeLessThan(2000);
    const nativeFacts = await refreshStartupFacts(child, facts);
    await assertStartupFacts(child, nativeFacts, profile);
  } finally {
    if (
      app &&
      app.process().exitCode === null &&
      app.process().signalCode === null
    )
      await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('native external show followed by explicit hide retires fallback without native show events', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-window-retirement-'),
  );
  const profile = path.join(directory, 'profile');
  const facts = path.join(directory, 'startup.json');
  let app: import('@playwright/test').ElectronApplication | undefined;
  try {
    await mkdir(profile);
    await writeFile(
      path.join(directory, 'window-visibility.mjs'),
      stripTypeScriptTypes(
        await readFile(
          path.join(root, 'src/providers/window-visibility.ts'),
          'utf8',
        ),
      ),
    );
    const entry = path.join(directory, 'main.cjs');
    await writeFile(
      entry,
      `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(directory)};app.setPath('userData',${JSON.stringify(profile)});fs.mkdirSync(path.join(owned,'sessions'));app.setPath('sessionData',path.join(owned,'sessions'));app.on('window-all-closed',()=>{});
(async()=>{await app.whenReady();const {setupInitialWindowVisibility}=await import('./window-visibility.mjs');const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});let calls=0,events=0;const nativeShow=win.show.bind(win);win.show=()=>{calls++;return nativeShow()};win.on('show',()=>events++);setupInitialWindowVisibility(win,()=>true);await new Promise(r=>setTimeout(r,100));win.show();await new Promise(r=>setTimeout(r,100));const firstVisible=win.isVisible();win.hide();await new Promise(r=>setTimeout(r,500));globalThis.retirementResult={calls,events,firstVisible,finalVisible:win.isVisible()};})().catch(()=>app.exit(1));`,
    );
    const env = { ...process.env, PEAR_TEST_STARTUP_FACTS: facts };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      cwd: directory,
      args: [
        '--require',
        path.join(root, 'tests/helpers/electron-startup-observer.cjs'),
        entry,
        `--user-data-dir=${profile}`,
        '--disable-gpu',
        '--use-mock-keychain',
      ],
      env,
    });
    const child = app.process();
    const nativeFacts = await waitForStartupFacts(child, facts);
    await assertStartupFacts(child, nativeFacts, profile);
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).retirementResult))
      .toBeTruthy();
    const result = await app.evaluate(
      () => (globalThis as any).retirementResult,
    );
    expect(result.firstVisible).toBe(true);
    expect(result.calls).toBe(1);
    expect(result.finalVisible).toBe(false);
  } finally {
    if (
      app &&
      app.process().exitCode === null &&
      app.process().signalCode === null
    )
      await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
