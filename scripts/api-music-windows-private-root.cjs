'use strict';

// Inert fixed adapter, selected only by the admitted runner's closure-private main.
// The carrier must separately admit the trusted Windows image/SystemRoot identity.
const PREFIX = 'pear-music-nonloopback-';
const unavailable = () => Error('WINDOWS_PRIVATE_ROOT_UNPROVEN');
function localPath(value, path) {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^[A-Za-z]:\\/.test(value) ||
    /[\x00-\x1f<>"|?*/]/.test(value) ||
    value.slice(2).includes(':') ||
    path.normalize(value) !== value ||
    /[\\. ]$/.test(value)
  )
    throw unavailable();
  if (
    value
      .slice(3)
      .split('\\')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw unavailable();
  return value;
}
async function canonical(value, io, file = false) {
  localPath(value, io.path);
  const stat = await io.fsp.lstat(value);
  if (
    stat.isSymbolicLink() ||
    !(file ? stat.isFile() : stat.isDirectory()) ||
    (await io.fsp.realpath(value)).toLowerCase() !== value.toLowerCase()
  )
    throw unavailable();
  return value;
}
async function resolveWindowsPowerShell(io) {
  const root = await canonical(io.systemRoot, io);
  let current = root;
  for (const part of ['System32', 'WindowsPowerShell', 'v1.0'])
    current = await canonical(io.path.join(current, part), io);
  const powerShell = await canonical(
    io.path.join(current, 'powershell.exe'),
    io,
    true,
  );
  return { systemRoot: root, powerShell };
}

// Exact owned-directory ACL recipe from the separately reviewed Windows carrier.
// Stdin is path data. No caller may supply program text, command, SID or ACL rules.
const PROGRAM = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue'
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  if (@($request.PSObject.Properties.Name).Count -ne 2 -or -not $request.directory -or -not $request.parent) { throw 'unavailable' }
  $directory = [IO.Path]::GetFullPath([string]$request.directory)
  $parent = [IO.Path]::GetFullPath([string]$request.parent)
  if ($directory -cne [string]$request.directory -or $parent -cne [string]$request.parent -or [IO.Path]::GetDirectoryName($directory) -ine $parent -or -not [IO.Path]::GetFileName($directory).StartsWith('pear-music-nonloopback-')) { throw 'unavailable' }
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unavailable' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $directory -AclObject $acl
  $actual = Get-Acl -LiteralPath $directory
  $rules = @($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'unavailable' }
  $r = $rules[0]
  if ($r.IdentityReference.Value -ne $sid.Value -or $r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne 'FullControl' -or $r.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $r.PropagationFlags -ne 'None') { throw 'unavailable' }
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unavailable' }
  [Console]::Write('{"version":1,"private":true}')
} catch { [Console]::Write('{"version":1,"private":false}'); exit 1 }
`;

function runAcl(directory, parent, tools, io) {
  return new Promise((resolve) => {
    let child,
      done = false,
      failed = false,
      stdout = Buffer.alloc(0),
      stdoutBytes = 0,
      stderrBytes = 0;
    const timers = new Set(),
      handlers = new Map();
    const later = (fn, ms) => {
      const id = io.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };
    const finish = (closed, code = null, signal = null) => {
      if (done) return;
      done = true;
      for (const timer of timers) io.clearTimeout(timer);
      timers.clear();
      for (const [name, handler] of handlers)
        io.signalSource.removeListener(name, handler);
      if (!closed) {
        child?.stdin?.destroy?.();
        child?.stdout?.destroy?.();
        child?.stderr?.destroy?.();
        child?.unref?.();
      }
      let pass = false;
      try {
        const body = JSON.parse(stdout.toString('utf8'));
        pass =
          !failed &&
          closed &&
          code === 0 &&
          !signal &&
          Object.keys(body).sort().join('|') === 'private|version' &&
          body.version === 1 &&
          body.private === true;
      } catch {
        /* No raw diagnostics escape. */
      }
      resolve({ closed, pass });
    };
    const stop = () => {
      if (done || failed) return;
      failed = true;
      for (const timer of timers) io.clearTimeout(timer);
      timers.clear();
      try {
        child.stdin.destroy();
        child.kill('SIGKILL');
      } catch {
        /* Physical close still required. */
      }
      if (!done) later(() => finish(false), 2000);
    };
    try {
      const input = JSON.stringify({ directory, parent }) + '\n';
      if (Buffer.byteLength(input) > 16 * 1024) throw unavailable();
      child = io.spawn(
        tools.powerShell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(PROGRAM, 'utf16le').toString('base64'),
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            CI: '1',
            SystemRoot: tools.systemRoot,
            PATH: io.env.PATH,
            TEMP: parent,
            TMP: parent,
          },
        },
      );
      child.once('error', stop);
      child.stdin.on('error', stop);
      child.stdout.on('error', stop);
      child.stderr.on('error', stop);
      child.stdout.on('data', (chunk) => {
        if (done || failed) return;
        const bytes = Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > 256) {
          stop();
          return;
        }
        stdout = Buffer.concat([stdout, bytes]);
      });
      child.stderr.on('data', (chunk) => {
        if (done || failed) return;
        stderrBytes += Buffer.byteLength(chunk);
        // Nothing from this setup helper is accepted on stderr, even below cap.
        if (stderrBytes > 0 || stderrBytes > 1024) stop();
      });
      child.once('close', (code, signal) => finish(true, code, signal));
      for (const name of ['SIGINT', 'SIGTERM']) {
        const handler = () => stop();
        handlers.set(name, handler);
        io.signalSource.on(name, handler);
      }
      later(stop, 5000);
      if (io.isCancelled?.()) stop();
      else child.stdin.end(input);
    } catch {
      if (child) stop();
      else {
        failed = true;
        finish(true);
      }
    }
  });
}

async function createWindowsPrivateDirectory(runnerTemp, io) {
  let directory,
    owned = false,
    helperClosed = true;
  try {
    if (typeof io.env?.PATH !== 'string' || io.env.PATH.includes(';'))
      throw unavailable();
    localPath(io.env.PATH, io.path);
    const tools = await resolveWindowsPowerShell(io);
    await canonical(runnerTemp, io);
    if (io.isCancelled?.()) throw unavailable();
    directory = await io.fsp.mkdtemp(io.path.join(runnerTemp, PREFIX));
    localPath(directory, io.path);
    if (
      io.path.dirname(directory).toLowerCase() !== runnerTemp.toLowerCase() ||
      !io.path.basename(directory).startsWith(PREFIX)
    )
      throw unavailable();
    owned = true;
    await canonical(directory, io);
    const result = await runAcl(directory, runnerTemp, tools, io);
    helperClosed = result.closed;
    if (!result.pass || io.isCancelled?.()) throw unavailable();
    await canonical(directory, io);
    return directory;
  } catch {
    if (!helperClosed) {
      const error = unavailable();
      error.code = 'WINDOWS_HELPER_NO_CLOSE';
      error.cleanup = 'UNPROVEN';
      error.outerReapRequired = true;
      throw error;
    }
    if (owned) {
      try {
        await io.removeOwnedTemp(directory, {
          remove: (value) =>
            io.fsp.rm(value, {
              recursive: true,
              force: true,
              maxRetries: 2,
              retryDelay: 100,
            }),
          setTimeout: io.setTimeout,
          clearTimeout: io.clearTimeout,
        });
      } catch {
        throw Error('CLEANUP_FAILED');
      }
    }
    throw unavailable();
  }
}

module.exports = { createWindowsPrivateDirectory, resolveWindowsPowerShell };
