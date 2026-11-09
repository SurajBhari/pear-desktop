// The watchdog lives in a separate parent process, never in the WASM process.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawn } = require('node:child_process');
const [mode, outArg, kind = 'node'] = process.argv.slice(2),
  out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-ffmpeg-runtime-'));
const env = {
  ...process.env,
  PEAR_FFMPEG_MODE: mode,
  PEAR_FFMPEG_OUTPUT: out,
  PEAR_FFMPEG_USER_DATA: path.join(owned, 'userdata'),
};
delete env.ELECTRON_RUN_AS_NODE;
const runtime =
  kind === 'electron' ? process.env.PEAR_FFMPEG_ELECTRON : process.execPath;
if (!runtime) throw Error('Electron runtime path is required');
const args =
  kind === 'electron'
    ? [
        path.join(__dirname, 'downloader-ffmpeg-electron-main.cjs'),
        '--user-data-dir=' + env.PEAR_FFMPEG_USER_DATA,
      ]
    : [
        ...(mode === 'gc' ? ['--expose-gc'] : []),
        path.join(__dirname, 'downloader-ffmpeg-disposal.cjs'),
        mode,
        out,
      ];
const log = fs.openSync(path.join(out, 'execution.log'), 'w'),
  started = Date.now();
const child = spawn(runtime, args, {
  env,
  detached: process.platform !== 'win32',
  stdio: ['ignore', log, log],
});
let timeout = false;
const timer = setTimeout(() => {
  timeout = true;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {}
}, 15000);
child.on('error', (e) => {
  clearTimeout(timer);
  fs.closeSync(log);
  fs.writeFileSync(
    path.join(out, 'supervisor.json'),
    JSON.stringify({ spawnError: String(e) }, null, 2),
  );
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  clearTimeout(timer);
  fs.closeSync(log);
  fs.writeFileSync(
    path.join(out, 'supervisor.json'),
    JSON.stringify(
      {
        pid: child.pid,
        code,
        signal,
        timeout,
        elapsedMilliseconds: Date.now() - started,
        runtime,
        kind,
        ownedUserData: env.PEAR_FFMPEG_USER_DATA,
      },
      null,
      2,
    ) + '\n',
  );
  fs.rmSync(owned, { recursive: true, force: true });
  process.exitCode = code === 0 && !timeout ? 0 : 1;
});
