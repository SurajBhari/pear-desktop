import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron } from '@playwright/test';
import { build, normalizePath } from 'vite';

// @ts-expect-error The existing JavaScript startup API has no declaration file.
import * as startup from './electron-startup.js';

type Launcher = ReturnType<
  Awaited<ReturnType<typeof electron.launch>>['process']
>;
type StartupFacts = { pid: number; userData: string; visibleWindow: boolean };
const { waitForStartupFacts, assertStartupFacts, terminateStartupProcess } =
  startup as {
    waitForStartupFacts: (
      child: Launcher,
      factsPath: string,
      timeout?: number,
    ) => Promise<StartupFacts>;
    assertStartupFacts: (
      child: Launcher,
      facts: StartupFacts,
      profile: string,
    ) => Promise<void>;
    terminateStartupProcess: (child: Launcher) => Promise<void>;
  };

const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));

/** Real app modules and Electron; only app config/wrappers and network are fixtures. */
export async function scrobblerIntegrationNative<T>(
  task: () => Promise<T>,
): Promise<T> {
  const owned = await mkdtemp(
    path.join(tmpdir(), 'pear-scrobbler-integration-native-'),
  );
  const profile = path.join(owned, 'profile');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let child: Launcher | undefined;
  let processClosed: Promise<number | null> | undefined;
  let closed = false;
  let primaryError: unknown;
  let failed = false;
  let result: T | undefined;
  const waitForClose = async (budget: number) => {
    if (!processClosed) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        processClosed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error('Owned native integration process close budget expired'),
              ),
            budget,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const observer = path.join(
      root,
      'tests/helpers/electron-startup-observer.cjs',
    );
    if (
      createHash('sha256')
        .update(await readFile(observer))
        .digest('hex') !==
      '8581f0b3171f094830ba28970278585bcf34f7308538744c22c12fde0abf4f83'
    )
      throw Error('Unexpected native PID observer');
    const playwrightRequire = createRequire(
      createRequire(
        requireRoot.resolve('@playwright/test/package.json'),
      ).resolve('playwright/package.json'),
    );
    const corePackage = playwrightRequire.resolve(
      'playwright-core/package.json',
    );
    const core = JSON.parse(await readFile(corePackage, 'utf8')) as {
      version?: unknown;
    };
    const playwrightLoader = path.join(
      path.dirname(corePackage),
      'lib/server/electron/loader.js',
    );
    if (
      core.version !== '1.61.1' ||
      createHash('sha256')
        .update(await readFile(playwrightLoader))
        .digest('hex') !==
        '8c99c632a9fcef9d691160954d01acdf374ba15566e153bef7fb61b0d3796e6d'
    )
      throw Error('Unexpected Playwright Electron bootstrap');
    const electronPackage = path.dirname(
      requireRoot.resolve('electron/package.json'),
    );
    const relativeExecutable =
      process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : process.platform === 'win32'
          ? 'electron.exe'
          : process.platform === 'linux'
            ? 'electron'
            : undefined;
    if (
      !relativeExecutable ||
      (
        await readFile(path.join(electronPackage, 'path.txt'), 'utf8')
      ).trim() !== relativeExecutable
    )
      throw Error('Unexpected installed fixture Electron path');
    const executablePath = await realpath(
      path.join(electronPackage, 'dist', relativeExecutable),
    );
    if (
      !executablePath.startsWith(
        (await realpath(path.join(electronPackage, 'dist'))) + path.sep,
      )
    )
      throw Error('Fixture Electron escaped its installed distribution');
    const entry = path.join(owned, 'source.ts');
    await writeFile(
      entry,
      [
        `export {createScrobblerManager} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/scrobbler/main.ts')))};`,
        `export {defaultConfig} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/scrobbler/config.ts')))};`,
        `export {RegexFilters} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/scrobbler/services/regex-filters.ts')))};`,
        `export {setupSongInfo,registerCallback,getSongInfoProvenance,getCurrentSongInfoProvenance} from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/song-info.ts')))};`,
      ].join('\n'),
    );
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      ssr: { noExternal: true },
      plugins: [
        {
          name: 'scrobbler-native-app-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (['@/config', '@/utils', '@/i18n'].includes(id))
              return '\0owned:' + id;
            if (id.startsWith('@/'))
              return normalizePath(path.join(root, 'src', id.slice(2)) + '.ts');
            return undefined;
          },
          generateBundle() {
            const fullMain = normalizePath(path.join(root, 'src/index.ts'));
            if (
              [...this.getModuleIds()].some(
                (id) => id.replaceAll('\\', '/').split('?')[0] === fullMain,
              )
            )
              this.error(
                'Full application main entry is outside the component fixture',
              );
            const expected = normalizePath(
              path.join(root, 'src/providers/song-info.ts'),
            );
            const ids = [...this.getModuleIds()].filter(
              (id) => id.replaceAll('\\', '/').split('?')[0] === expected,
            );
            if (ids.length !== 1 || ids[0] !== expected)
              this.error(
                `Owned native provenance identity: ${JSON.stringify(ids)}`,
              );
          },
          load(id) {
            if (id === '\0owned:@/config')
              return 'export const get=()=>false;export const set=()=>{};';
            if (id === '\0owned:@/utils')
              return 'export const createBackend=value=>value;';
            if (id === '\0owned:@/i18n')
              return 'export const APPLICATION_NAME="Pear";';
            return undefined;
          },
        },
      ],
      build: {
        ssr: true,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          input: normalizePath(entry),
          external: ['electron'],
          output: { format: 'cjs', entryFileNames: 'source.cjs' },
        },
      },
    });
    const preload = path.join(owned, 'preload.cjs');
    await writeFile(
      preload,
      'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("scrobbleProof",{send:(event,data)=>ipcRenderer.send(event,data)});',
    );
    await writeFile(
      path.join(owned, 'main.html'),
      '<html><body>Owned main<iframe src="child.html"></iframe></body></html>',
    );
    await writeFile(
      path.join(owned, 'child.html'),
      '<html><body>Owned child</body></html>',
    );
    const main = path.join(owned, 'entry.cjs');
    await writeFile(
      main,
      `
require(${JSON.stringify(observer)});
if(process.execArgv.some(value=>value==='-r'||value==='--require'||value.startsWith('--require=')))throw Error('Unexpected inherited fixture preload');
if(typeof globalThis.__playwright_run!=='undefined')throw Error('Unexpected prior Playwright bootstrap');
require(${JSON.stringify(playwrightLoader)});
if(typeof globalThis.__playwright_run!=='function')throw Error('Missing owned Playwright readiness hook');
const {app,BrowserWindow,ipcMain,net,nativeImage,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};
for(const key of ['userData','sessionData','downloads']){const target=key==='userData'?${JSON.stringify(profile)}:path.join(owned,key);fs.mkdirSync(target,{recursive:true,mode:0o700});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned native profile');app.setPath(key,target);}
app.on('window-all-closed',()=>{});
let stage='ready';(async()=>{await app.whenReady();const configured=new WeakSet();const configure=ses=>{if(configured.has(ses))return;configured.add(ses);for(const scheme of ['https','http'])ses.protocol.handle(scheme,()=>new Response('<html><body>Owned intercepted auth</body></html>',{headers:{'Content-Type':'text/html'}}));};configure(session.defaultSession);app.on('session-created',configure);
const witness=new BrowserWindow({show:true,width:200,height:120,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await witness.loadFile(path.join(owned,'child.html'));
globalThis.ScrobbleIntegrationProof={source:require(path.join(owned,'source.cjs')),app,BrowserWindow,ipcMain,net,nativeImage,session,owned,preload:${JSON.stringify(preload)}};
stage='admission';await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(path.join(owned,'admit-task'))){clearInterval(timer);resolve();}},5)});
stage='task';const result=await (${task.toString()})();stage='shutdown';console.log('SCROBBLER_INTEGRATION_NATIVE '+JSON.stringify(result));for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit();})().catch(error=>{console.error('Owned native scrobbler witness failed at '+stage+': '+String(error?.stack??error).slice(-8000));app.exit(1)});
`,
    );
    const facts = path.join(owned, 'startup.json');
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    env.PEAR_TEST_STARTUP_FACTS = facts;
    delete env.ELECTRON_RUN_AS_NODE;
    const deadline = Date.now() + 25000;
    // Playwright's launcher matches the existing startup identity/termination API;
    // a raw Electron PID must never be sent to its Windows CMD-child discovery.
    app = await electron.launch({
      executablePath,
      cwd: owned,
      args: [
        main,
        '--no-sandbox',
        `--user-data-dir=${profile}`,
        '--disable-gpu',
        '--use-mock-keychain',
      ],
      env,
      timeout: 25000,
    });
    child = app.process();
    processClosed = new Promise((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', (code) => {
        closed = true;
        resolve(code);
      });
    });
    processClosed.catch(() => {});
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', (value) => {
      stdout = (stdout + value).slice(-16000);
    });
    child.stderr!.on('data', (value) => {
      stderr = (stderr + value).slice(-16000);
    });
    const startup = await waitForStartupFacts(
      child,
      facts,
      Math.max(1, Math.min(10000, deadline - Date.now())),
    );
    await assertStartupFacts(child, startup, profile);
    if (Date.now() >= deadline)
      throw Error('Owned native integration admission budget expired');
    await writeFile(path.join(owned, 'admit-task'), '', {
      flag: 'wx',
      mode: 0o600,
    });
    const code = await waitForClose(Math.max(1, deadline - Date.now()));
    if (code !== 0)
      throw Error(
        `Native integration exited ${code}; stdout: ${stdout}; stderr: ${stderr}`,
      );
    const line = stdout
      .split('\n')
      .find((value) => value.startsWith('SCROBBLER_INTEGRATION_NATIVE '));
    if (!line) throw Error('Missing native integration result');
    result = JSON.parse(
      line.slice('SCROBBLER_INTEGRATION_NATIVE '.length),
    ) as T;
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  {
    const cleanupErrors: unknown[] = [];
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await terminateStartupProcess(child);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (child) {
      try {
        await waitForClose(3000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!child || closed) {
      try {
        await rm(owned, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else
      cleanupErrors.push(
        Error(
          'Owned fixture directory retained because native process close was not verified',
        ),
      );
    if (cleanupErrors.length)
      throw new AggregateError(
        failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
        'Owned native integration cleanup failed',
        { cause: primaryError },
      );
  }
  if (failed) throw primaryError;
  return result as T;
}
