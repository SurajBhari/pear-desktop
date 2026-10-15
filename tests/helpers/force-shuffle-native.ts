import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const requireRoot = createRequire(import.meta.url);

/** Real DOM/timers and actual plugin source; owned custom protocol, no HTTP(S). */
export async function forceShuffleNative<T>(
  source: string,
  task: () => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-force-native-'));
  let child: ReturnType<typeof spawn> | undefined;
  let taskFailed = false;
  let taskFailure: unknown;
  const witness = (
    kind: string,
    fields: Record<string, boolean | string | null>,
  ) => {
    try {
      process.stdout.write(kind + ' ' + JSON.stringify(fields) + '\n');
    } catch {
      // Diagnostic output must never replace a task or cleanup outcome.
    }
  };
  const kill = () => {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  try {
    const entry = path.join(directory, 'entry.cjs');
    await writeFile(
      entry,
      `
const {app,BrowserWindow,protocol,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const owned=${JSON.stringify(directory)};
for(const key of ['userData','sessionData']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned native fixture profile');app.setPath(key,target);}
protocol.registerSchemesAsPrivileged([{scheme:'pear-shuffle-fixture',privileges:{standard:true,secure:true}}]);
app.commandLine.appendSwitch('disable-background-networking');
(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));protocol.handle('pear-shuffle-fixture',()=>new Response('<html><body></body></html>',{headers:{'content-type':'text/html'}}));const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});await win.loadURL('pear-shuffle-fixture://owned/watch');await win.webContents.executeJavaScript(${JSON.stringify(source)});const result=await win.webContents.executeJavaScript(${JSON.stringify(`(${task.toString()})()`)});console.log('FORCE_SHUFFLE_NATIVE '+JSON.stringify(result));win.destroy();app.quit()})().catch(error=>{console.error(error);app.exit(1)});
`,
    );
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(
      requireRoot('electron') as string,
      [
        entry,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--no-sandbox',
      ],
      {
        cwd: directory,
        env: environment,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          kill();
          reject(new Error('Native Force Shuffle fixture timed out'));
        }, 25000);
        child!.on('error', reject);
        child!.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `Native Force Shuffle fixture exit ${code}: ${stderr}`,
                ),
              ),
        );
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      kill();
    }
    const line = stdout
      .split('\n')
      .find((line) => line.startsWith('FORCE_SHUFFLE_NATIVE '));
    if (!line) throw new Error(`Native shuffle result missing: ${stdout}`);
    const result = JSON.parse(line.slice('FORCE_SHUFFLE_NATIVE '.length)) as T;
    const value = result as {
      oldValues?: unknown;
      calls?: unknown;
      on?: unknown;
    } | null;
    const oldValuesMatch =
      Array.isArray(value?.oldValues) &&
      value.oldValues.length === 2 &&
      value.oldValues[0] === null &&
      value.oldValues[1] === '';
    const callsOne = value?.calls === 1;
    const onTrue = value?.on === true;
    witness('FORCE_SHUFFLE_OWNED_TASK', {
      taskCompleted: true,
      historicalShapeMatches:
        value !== null &&
        typeof value === 'object' &&
        Object.keys(value).sort().join(',') === 'calls,oldValues,on' &&
        oldValuesMatch &&
        callsOne &&
        onTrue,
      oldValuesMatch,
      callsOne,
      onTrue,
    });
    return result;
  } catch (error) {
    taskFailed = true;
    taskFailure = error;
    witness('FORCE_SHUFFLE_OWNED_TASK', {
      taskCompleted: false,
      historicalShapeMatches: false,
      oldValuesMatch: false,
      callsOne: false,
      onTrue: false,
    });
    throw error;
  } finally {
    let killAttempted = false,
      killReturnedWithoutError = false,
      rmAttempted = false,
      rmSucceeded = false;
    let code: string | null = null;
    try {
      killAttempted = !!child?.pid;
      kill();
      killReturnedWithoutError = true;
      rmAttempted = true;
      await rm(directory, { recursive: true, force: true });
      rmSucceeded = true;
    } catch (error) {
      const rawCode = (error as NodeJS.ErrnoException | null)?.code;
      code =
        rawCode == null
          ? null
          : [
                'EBUSY',
                'ENOTEMPTY',
                'EPERM',
                'EACCES',
                'ENOENT',
                'ESRCH',
              ].includes(rawCode)
            ? rawCode
            : 'other';
      if (taskFailed) {
        throw new AggregateError(
          [taskFailure, error],
          'Native Force Shuffle task and cleanup both failed',
        );
      }
      throw error;
    } finally {
      witness('FORCE_SHUFFLE_OWNED_CLEANUP', {
        killAttempted,
        killReturnedWithoutError,
        rmAttempted,
        rmSucceeded,
        code,
      });
    }
  }
}
