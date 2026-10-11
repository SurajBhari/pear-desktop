import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

/** Actual Electron renderer, owned temporary profiles, synthetic metadata, silent sink. */
export async function compressorNative<T>(
  bundle: string,
  task: () => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-compressor-native-'),
  );
  try {
    const entry = path.join(directory, 'entry.cjs');
    await writeFile(
      path.join(directory, 'fixture.html'),
      '<html><body><video></video></body></html>',
    );
    await writeFile(
      entry,
      `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const owned=${JSON.stringify(directory)};
for(const key of ['userData','sessionData']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned fixture profile');app.setPath(key,target);}
(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});await win.loadFile(path.join(owned,'fixture.html'));await win.webContents.executeJavaScript(${JSON.stringify(bundle)});const result=await win.webContents.executeJavaScript(${JSON.stringify(`(${task.toString()})()`)});console.log('COMPRESSOR_NATIVE '+JSON.stringify(result));win.destroy();app.quit()})().catch(error=>{console.error(error);app.exit(1)});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      require('electron') as string,
      [
        entry,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--no-sandbox',
      ],
      {
        cwd: directory,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    let timer: ReturnType<typeof setTimeout>;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          kill();
          reject(new Error('Native compressor fixture timed out'));
        }, 25000);
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `Native compressor fixture exited ${code}: ${stderr}`,
                ),
              ),
        );
      });
    } finally {
      clearTimeout(timer!);
      kill();
    }
    const line = stdout
      .split('\n')
      .find((line) => line.startsWith('COMPRESSOR_NATIVE '));
    if (!line) throw new Error(`Native result missing: ${stdout}`);
    return JSON.parse(line.slice('COMPRESSOR_NATIVE '.length)) as T;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
