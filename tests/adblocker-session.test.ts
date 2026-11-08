import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));

test('installed Ghostery teardown preserves BetterWebRequest app handlers, native preload and IPC lifecycle', async () => {
  test.setTimeout(30_000);
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-blocker-session-test-'),
  );
  let primaryFailed = false;
  try {
    const adapterPath = path.join(
      root,
      'src/providers/blocker-scoped-session.ts',
    );
    let adapterImport = 'const scopeBlockingSession = (session) => session;';
    try {
      const source = await readFile(adapterPath, 'utf8');
      await writeFile(
        path.join(directory, 'adapter.mjs'),
        stripTypeScriptTypes(source),
      );
      adapterImport =
        "const { scopeBlockingSession } = await import('./adapter.mjs');";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const ownership = await readFile(
      path.join(root, 'src/providers/blocker-ownership.ts'),
      'utf8',
    );
    await writeFile(
      path.join(directory, 'ownership.mjs'),
      stripTypeScriptTypes(ownership),
    );
    const script = `
const { app, session, ipcMain } = require('electron');
const { createRequire } = require('node:module');
const requireRoot = createRequire(${JSON.stringify(path.join(root, 'package.json'))});
const { enhanceWebRequest } = requireRoot('@jellybrick/electron-better-web-request');
const { ElectronBlocker } = requireRoot('@ghostery/adblocker-electron');
(async () => {
  await app.whenReady();
  ${adapterImport}
  const { createOwnedBlocker } = await import('./ownership.mjs');
  const nativeSession = session.fromPartition('pear-blocker-integration');
  const enhanced = enhanceWebRequest(nativeSession);
  const appHeader = enhanced.webRequest.addListener('onHeadersReceived', {urls:['<all_urls>']}, (details, callback) => callback({responseHeaders:details.responseHeaders}));
  const unrelated = enhanced.webRequest.addListener('onBeforeRequest', {urls:['<all_urls>']}, (details, callback) => callback({}));
  const baselinePreloads = nativeSession.getPreloadScripts().map(x=>x.id);
  const results = { phases: [], errors: [] };
  let offline = false;
  let current;
  const inspect = (phase) => results.phases.push({phase, headers:[...enhanced.webRequest.getListenersFor('onHeadersReceived').keys()], requests:[...enhanced.webRequest.getListenersFor('onBeforeRequest').keys()], preloads:nativeSession.getPreloadScripts().map(x=>x.id)});
  const controller = createOwnedBlocker(async lists => {
    if (offline) throw new Error('offline');
    const engine = ElectronBlocker.parse(lists.map(host=>'||'+host+'^').join('\\n'), {loadNetworkFilters:true, loadCosmeticFilters:true});
    const scoped = scopeBlockingSession(nativeSession);
    current = {engine, scoped};
    return {enable:()=>engine.enableBlockingInSession(scoped),disable:()=>engine.disableBlockingInSession(scoped)};
  });
  const action = async (label, fn) => {try {await fn();} catch(error) {results.errors.push({label,message:error.message});} inspect(label);};
  await action('ads enabled',()=>controller.set('ads',['ads.example']));
  await action('tracker coexists',()=>controller.set('tracker',['track.example']));
  await action('ads stopped',()=>controller.set('ads',null));
  offline=true;
  await action('offline rebuild',()=>controller.set('tracker',['offline.example']));
  offline=false;
  await action('retry',()=>controller.set('tracker',['track.example']));
  await action('last stop',()=>controller.set('tracker',null));
  await action('repeated stop',()=>controller.set('tracker',null));
  // Re-registering these IPC handlers proves Ghostery removed only its handlers.
  for (const key of ['@ghostery/adblocker/inject-cosmetic-filters','@ghostery/adblocker/is-mutation-observer-enabled']) {try {ipcMain.handle(key,()=>{});ipcMain.removeHandler(key);} catch(error) {results.errors.push({label:'IPC cleanup',message:error.message});}}
  console.log('PEAR_RESULT '+JSON.stringify({...results,appHeader:appHeader.id,unrelated:unrelated.id,baselinePreloads}));
  app.quit();
})().catch(error=>{console.error(error);app.exit(1);});`;
    const entry = path.join(directory, 'entry.cjs');
    await writeFile(entry, script);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(
      require('electron') as string,
      [
        entry,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--no-sandbox',
      ],
      { cwd: directory, env, timeout: 25_000 },
    );
    const result = JSON.parse(
      stdout
        .split('\n')
        .find((line) => line.startsWith('PEAR_RESULT '))!
        .slice(12),
    );
    expect(result.errors).toEqual([
      { label: 'offline rebuild', message: 'offline' },
    ]);
    for (const phase of result.phases) {
      expect(phase.headers).toContain(result.appHeader);
      expect(phase.requests).toContain(result.unrelated);
    }
    const first = result.phases.find((x) => x.phase === 'ads enabled');
    expect(first.headers).toHaveLength(2);
    expect(first.requests).toHaveLength(2);
    expect(first.preloads.length).toBe(result.baselinePreloads.length + 1);
    for (const phase of result.phases.filter((x) =>
      ['last stop', 'repeated stop'].includes(x.phase),
    )) {
      expect(phase.headers).toEqual([result.appHeader]);
      expect(phase.requests).toEqual([result.unrelated]);
      expect(phase.preloads).toEqual(result.baselinePreloads);
    }
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (error) {
      if (!primaryFailed) throw error;
      console.warn(
        'Ghostery fixture cleanup also failed; the primary failure is preserved',
      );
    }
  }
});
