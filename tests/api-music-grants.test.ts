import { test, expect } from '@playwright/test';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
  readdir,
  link,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { musicModuleSource } from './helpers/api-music-source';
const resource = 'http://127.0.0.1:26538/api/v1/music';

const testBinding = (content: string) =>
  'a'.repeat(48) + ':' + createHash('sha256').update(content).digest('hex');

// Independent .NET ACL inspection. Only fixture paths are data; no SID/path/exception is emitted.
const ACL_FIXTURE = String.raw`
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 $r=[Console]::ReadLine()|ConvertFrom-Json;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if($r.operation -eq 'alias') {
  Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class FixturePathAlias{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetShortPathNameW(string input,StringBuilder output,uint size);}'
  $short=[Text.StringBuilder]::new(4096);$n=[FixturePathAlias]::GetShortPathNameW($r.path,$short,4096)
  if($n -eq 0 -or $n -ge 4096){throw 'fixture alias unavailable'}
  [Console]::WriteLine((@{longPath=[IO.Path]::GetFullPath($r.path);shortPath=$short.ToString()}|ConvertTo-Json -Compress));exit 0
 }
 if($r.operation -eq 'parent') {
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
  foreach($who in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($who,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
  [IO.Directory]::SetAccessControl($r.path,$acl);[Console]::WriteLine('{}');exit 0
 }
 $acl=if($r.directory){[IO.Directory]::GetAccessControl($r.path)}else{[IO.File]::GetAccessControl($r.path)}
 if($r.operation -eq 'outsider'){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));[IO.File]::SetAccessControl($r.path,$acl);$acl=[IO.File]::GetAccessControl($r.path)}
 $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);$allowed=$true;$full=$false
 foreach($rule in $rules){if($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544') -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){$allowed=$false};if($rule.IdentityReference.Equals($sid) -and $rule.AccessControlType -eq 'Allow' -and $rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl){$full=$true}}
 $sha=[Security.Cryptography.SHA256]::Create();$hash=[BitConverter]::ToString($sha.ComputeHash($acl.GetSecurityDescriptorBinaryForm())).Replace('-','').ToLowerInvariant();$sha.Dispose()
 [Console]::WriteLine((@{ownerCurrent=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid);protected=$acl.AreAccessRulesProtected;allowedOnly=$allowed;currentFull=$full;hash=$hash}|ConvertTo-Json -Compress))
}catch{[Console]::Error.WriteLine('fixture ACL unavailable');exit 1}
`;
function fixtureAcl(
  folder: string,
  file: string,
  operation = 'inspect',
  directory = false,
) {
  const system = process.env.SystemRoot;
  if (!system) throw new Error('fixture ACL unavailable');
  const output = execFileSync(
    path.win32.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(ACL_FIXTURE, 'utf16le').toString('base64'),
    ],
    {
      input: JSON.stringify({ operation, path: file, directory }) + '\n',
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 4096,
      windowsHide: true,
      env: { ...process.env, TEMP: folder, TMP: folder },
    },
  );
  return JSON.parse(output);
}
async function privateTestFolder() {
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-grant-'));
  if (process.platform === 'win32') fixtureAcl(folder, folder, 'parent', true);
  return folder;
}
async function nativeTestBridge(folder: string) {
  if (process.platform !== 'win32') return undefined;
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/windows-private-path.ts',
  );
  return m.createWindowsPrivatePath({
    launch: (file: string, args: string[], options: any) =>
      spawn(file, args, {
        ...options,
        env: { ...process.env, TEMP: folder, TMP: folder },
      }),
  });
}

async function windowsProtocol(
  mode = 'normal',
  timeoutMs = 8000,
  delayKillMs = 0,
) {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/windows-private-path.ts',
  );
  expect(typeof m.createWindowsPrivatePath).toBe('function');
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-grant-protocol-'));
  const entry = path.join(folder, 'worker.cjs');
  const calls = path.join(folder, 'calls.json');
  await writeFile(
    entry,
    `
    const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
    const mode=process.argv[2],calls=process.argv[3],seen=[];let content='{"version":1,"records":[]}';
    const binding=()=> 'a'.repeat(48)+':'+crypto.createHash('sha256').update(content).digest('hex');
    const reply=data=>process.stdout.write(JSON.stringify({version:1,...data})+'\\n');
    const input=readline.createInterface({input:process.stdin});let terminal;input.on('close',()=>{if(terminal)terminal()});input.on('line',line=>{
      const data=JSON.parse(line);seen.push(data.operation??data.action);fs.writeFileSync(calls,JSON.stringify(seen));
      if(mode==='held-failure'){reply({type:'failure'});setInterval(()=>{},1000);return;}
      if(mode==='hang')return;
      if(mode==='oversize'){process.stdout.write('x'.repeat(1024*1024+1));return;}
      if(mode==='early-exit'){process.exit(0);return;}
      if(mode==='detail'){reply({type:'failure',detail:'PRIVATE_DETAIL'});return;}
      if(mode==='require-eof'&&data.operation==='read'){terminal=()=>{reply({type:'read',contents64:Buffer.from(content).toString('base64'),binding:binding()});process.exit(0)};return;}
    if(mode==='require-eof'&&data.action==='commit'){terminal=()=>{reply({type:'committed',binding:binding(),challenge:data.challenge});process.exit(0)};return;}
    if(data.operation==='read'){reply({type:'read',contents64:mode==='bad-base64'?'%%%%':Buffer.from(content).toString('base64'),binding:mode==='wrong-binding'?'a'.repeat(48)+':'+ '0'.repeat(64):binding()});process.exit(0);}
      if(data.operation==='prepare'){content=Buffer.from(data.contents64,'base64').toString('utf8');reply({type:'ready'});if(mode==='premature')reply({type:'committed',binding:binding()});}
      if(data.action==='commit'){reply({type:'committed',binding:binding(),challenge:mode==='wrong-challenge'?'00000000-0000-0000-0000-000000000000':data.challenge});process.exit(0);}
      if(data.action==='abort')process.exit(0);
    });
  `,
  );
  let launches = 0,
    physicallyClosed = false;
  const commands: { file: string; args: string[] }[] = [];
  const bridge = m.createWindowsPrivatePath({
    systemRoot: 'C:\\Windows',
    timeoutMs,
    launch(_file: string, _args: string[], options: any) {
      launches++;
      commands.push({ file: _file, args: [..._args] });
      const child = spawn(process.execPath, [entry, mode, calls], options);
      child.once('close', () => {
        physicallyClosed = true;
      });
      if (delayKillMs) {
        const kill = child.kill.bind(child);
        child.kill = (signal) => {
          setTimeout(() => kill(signal), delayKillMs);
          return true;
        };
      }
      return child;
    },
  });
  return {
    bridge,
    calls,
    launches: () => launches,
    physicallyClosed: () => physicallyClosed,
    commands,
    close: () => rm(folder, { recursive: true, force: true }),
  };
}
async function fixture() {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grants.ts',
  );
  expect(typeof m.createMusicGrant).toBe('function');
  return m;
}
test('256-bit canonical native credentials persist only digests and default to zero permissions', async () => {
  const m = await fixture(),
    a = m.createMusicGrant('Fixture', 'rest', resource, []),
    b = m.createMusicGrant('Fixture', 'rest', resource, []);
  expect(a.token).toMatch(/^pdm_[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(a.token.slice(4), 'base64url')).toHaveLength(32);
  expect(a.token).not.toBe(b.token);
  expect(a.record.expiresAt - a.record.createdAt).toBe(86400000);
  expect(a.record.scopes).toEqual([]);
  expect(JSON.stringify(a.record)).not.toContain(a.token);
  expect(
    m.grantAllows(
      a.record,
      a.token,
      'rest',
      resource,
      'playback.read',
      a.record.createdAt,
    ),
  ).toBe(false);
});
test('credential scope transport exact resource expiry and canonical bits are independent guards', async () => {
  const m = await fixture(),
    a = m.createMusicGrant('Fixture', 'rest', resource, ['playback.read']);
  expect(
    m.grantAllows(
      a.record,
      a.token,
      'rest',
      resource,
      'playback.read',
      a.record.createdAt,
    ),
  ).toBe(true);
  for (const [token, transport, target, scope, now] of [
    [a.token, 'mcp', resource, 'playback.read', a.record.createdAt],
    [a.token, 'rest', resource + '/', 'playback.read', a.record.createdAt],
    [a.token, 'rest', resource, 'catalog.read', a.record.createdAt],
    [a.token, 'rest', resource, 'playback.read', a.record.expiresAt],
    ['legacy-id', 'rest', resource, 'playback.read', a.record.createdAt],
    [
      'eyJ.synthetic.jwt',
      'rest',
      resource,
      'playback.read',
      a.record.createdAt,
    ],
    [a.token + '=', 'rest', resource, 'playback.read', a.record.createdAt],
  ])
    expect(m.grantAllows(a.record, token, transport, target, scope, now)).toBe(
      false,
    );
  expect(m.parseMusicBearer('Bearer ' + a.token)).toBe(a.token);
  for (const raw of [
    a.token,
    'bearer ' + a.token,
    'Bearer  ' + a.token,
    'Bearer ' + a.token + ', Bearer ' + a.token,
    'Bearer ' + a.token + '\n',
  ])
    expect(m.parseMusicBearer(raw)).toBeNull();
});
test('grant record validation rejects unknown scopes duplicate scopes unbound resources and excessive lifetime', async () => {
  const m = await fixture();
  for (const scopes of [['unknown'], ['playback.read', 'playback.read']])
    expect(() =>
      m.createMusicGrant('Fixture', 'rest', resource, scopes),
    ).toThrow();
  for (const url of [
    'https://u:p@localhost:1/api/v1/music',
    'http://localhost:1/api/v1/music#token',
    'http://localhost:1/api/v1/music?token',
  ])
    expect(() => m.createMusicGrant('Fixture', 'rest', url, [])).toThrow();
  const a = m.createMusicGrant('Fixture', 'rest', resource, []);
  expect(m.parseMusicGrantRecord({ ...a.record, token: a.token })).toBeNull();
  expect(
    m.parseMusicGrantRecord({
      ...a.record,
      expiresAt: a.record.createdAt + 86400001,
    }),
  ).toBeNull();
});
test('private atomic ledger has owner permissions digest-only readback and revoke survives reload', async () => {
  test.setTimeout(60000);
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  expect(typeof m.MusicGrantStore).toBe('function');
  const folder = await privateTestFolder();
  const native = await nativeTestBridge(folder);
  try {
    const store = new m.MusicGrantStore(
      path.join(folder, 'owned'),
      Date.now,
      native,
    );
    const issueStarted = performance.now();
    const grant = await store.issue(
      'Fixture',
      'rest',
      resource,
      ['playback.read'],
      () => true,
    );
    const coldIssueMs = performance.now() - issueStarted;
    const file = path.join(folder, 'owned', 'grants.json'),
      content = await readFile(file, 'utf8');
    expect(content).not.toContain(grant.token);
    expect(content).not.toContain('Bearer');
    if (process.platform === 'win32') {
      for (const [target, directory] of [
        [file, false],
        [path.dirname(file), true],
      ] as const)
        expect(fixtureAcl(folder, target, 'inspect', directory)).toMatchObject({
          ownerCurrent: true,
          protected: true,
          allowedOnly: true,
          currentFull: true,
        });
    } else {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    const reload = new m.MusicGrantStore(
      path.join(folder, 'owned'),
      Date.now,
      native,
    );
    const readStarted = performance.now();
    expect(
      (await reload.authorize(grant.token, 'rest', resource, 'playback.read'))
        .id,
    ).toBe(grant.record.id);
    const coldReadMs = performance.now() - readStarted;
    const warmStarted = performance.now();
    for (let index = 0; index < 3; index++)
      await reload.authorize(grant.token, 'rest', resource, 'playback.read');
    const warmAuthorizeAverageMs = (performance.now() - warmStarted) / 3;
    const writeStarted = performance.now();
    await reload.revoke(grant.record.id, () => true);
    const revokeWriteMs = performance.now() - writeStarted;
    await expect(
      reload.authorize(grant.token, 'rest', resource, 'playback.read'),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    if (process.platform === 'win32')
      console.info(
        'WINDOWS_GRANT_IO_TIMINGS',
        JSON.stringify({
          coldIssueMs: Math.round(coldIssueMs),
          coldReadMs: Math.round(coldReadMs),
          warmAuthorizeAverageMs:
            Math.round(warmAuthorizeAverageMs * 1000) / 1000,
          revokeWriteMs: Math.round(revokeWriteMs),
        }),
      );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('stale native issue and concurrent revocation transactions do not mint or resurrect grants', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  expect(typeof m.MusicGrantStore).toBe('function');
  const folder = await privateTestFolder();
  const native = await nativeTestBridge(folder);
  try {
    const store = new m.MusicGrantStore(
      path.join(folder, 'owned'),
      Date.now,
      native,
    );
    await expect(
      store.issue('Stale', 'rest', resource, [], () => false),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(await store.list()).toEqual([]);
    const a = await store.issue(
      'Fixture',
      'rest',
      resource,
      ['catalog.read'],
      () => true,
    );
    const b = store.issue(
      'Concurrent',
      'rest',
      resource,
      ['playback.read'],
      () => true,
    );
    const revoke = store.revoke(a.record.id, () => true);
    await Promise.all([b, revoke]);
    expect((await store.list()).map((r: any) => r.name)).toEqual([
      'Concurrent',
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('malformed oversized ledger and non-private file fail closed without replacing it', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  expect(typeof m.MusicGrantStore).toBe('function');
  const folder = await privateTestFolder();
  const native = await nativeTestBridge(folder);
  try {
    for (const [content, mode] of [
      ['{', 0o600],
      ['x'.repeat(512 * 1024 + 1), 0o600],
      ['{"version":1,"records":[]}', 0o644],
    ] as const) {
      const dir = path.join(folder, String(mode) + '-' + content.length);
      const file = path.join(dir, 'grants.json');
      if (process.platform === 'win32') {
        const setup = new m.MusicGrantStore(dir, Date.now, native);
        await setup.issue('Setup', 'rest', resource, [], () => true);
        await writeFile(file, content);
        if (mode === 0o644) fixtureAcl(folder, file, 'outsider');
      } else {
        await mkdir(dir, { mode: 0o700 });
        await writeFile(file, content, { mode });
      }
      const store = new m.MusicGrantStore(dir, Date.now, native);
      await expect(store.list()).rejects.toMatchObject({ code: 'unavailable' });
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('Windows native protocol binds readback and stages publication until explicit commit', async () => {
  const f = await windowsProtocol();
  try {
    const loaded = await f.bridge.read('C:\\Owned\\grants');
    expect(loaded).toEqual({
      contents: '{"version":1,"records":[]}',
      binding: testBinding('{"version":1,"records":[]}'),
    });
    const lease = await f.bridge.stage(
      'C:\\Owned\\grants',
      loaded.contents,
      loaded.binding,
    );
    expect(JSON.parse(await readFile(f.calls, 'utf8'))).toEqual(['prepare']);
    expect(await lease.commit()).toBe(loaded.binding);
    await lease.close();
    expect(JSON.parse(await readFile(f.calls, 'utf8'))).toEqual([
      'prepare',
      'commit',
    ]);
  } finally {
    await f.close();
  }
});

test('Windows native protocol aborts prepared writes and enforces the ledger input limit before launch', async () => {
  const f = await windowsProtocol();
  try {
    const lease = await f.bridge.stage(
      'C:\\Owned\\grants',
      '{"version":1,"records":[]}',
      null,
    );
    await lease.close();
    expect(JSON.parse(await readFile(f.calls, 'utf8'))).toEqual([
      'prepare',
      'abort',
    ]);
    const count = f.launches();
    await expect(
      f.bridge.stage('C:\\Owned\\grants', 'x'.repeat(512 * 1024 + 1), null),
    ).rejects.toMatchObject({ code: 'budget' });
    expect(f.launches()).toBe(count);
  } finally {
    await f.close();
  }
});

for (const mode of [
  'bad-base64',
  'wrong-binding',
  'oversize',
  'detail',
  'early-exit',
  'hang',
]) {
  test(`Windows native protocol fails closed for ${mode} without forwarding native details`, async () => {
    const f = await windowsProtocol(mode, mode === 'hang' ? 80 : 8000);
    try {
      const error = await f.bridge
        .read('C:\\Owned\\grants')
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'unavailable' });
      expect(String(error)).not.toContain('PRIVATE_DETAIL');
    } finally {
      await f.close();
    }
  });
}

test('Windows native protocol rejects an unsolicited commit before main authorization', async () => {
  const f = await windowsProtocol('premature');
  try {
    await expect(
      (async () => {
        const lease = await f.bridge.stage(
          'C:\\Owned\\grants',
          '{"version":1,"records":[]}',
          null,
        );
        try {
          await lease.commit();
        } finally {
          await lease.close();
        }
      })(),
    ).rejects.toMatchObject({ code: 'unavailable' });
  } finally {
    await f.close();
  }
});

for (const scenario of ['retired-after-prepare', 'cached-unsafe-destination']) {
  test(`Windows store preserves publication ownership for ${scenario}`, async () => {
    const m = await musicModuleSource(
      'src/plugins/api-server/backend/music-grant-store.ts',
    );
    const folder = await mkdtemp(path.join(tmpdir(), 'pear-grant-binding-'));
    let contents: string | null = null,
      binding: string | null = null,
      alive = true,
      unsafe = false,
      commits = 0,
      stages = 0,
      closed = 0;
    const bridge = {
      read: async () => ({ contents, binding }),
      stage: async (
        _directory: string,
        next: string,
        expected: string | null,
      ) => {
        stages++;
        expect(expected).toBe(binding);
        if (unsafe)
          throw Object.assign(new Error('unavailable'), {
            code: 'unavailable',
          });
        if (scenario === 'retired-after-prepare') alive = false;
        return {
          commit: async () => {
            commits++;
            contents = next;
            binding = testBinding(next);
            return binding;
          },
          close: async () => {
            closed++;
          },
        };
      },
    };
    try {
      const store = new m.MusicGrantStore(
        path.join(folder, 'owned'),
        Date.now,
        bridge,
      );
      if (scenario === 'retired-after-prepare') {
        await expect(
          store.issue('Fixture', 'rest', resource, [], () => alive),
        ).rejects.toMatchObject({ code: 'retired' });
        expect(commits).toBe(0);
        expect(closed).toBe(1);
        expect(await store.list()).toEqual([]);
      } else {
        await store.issue('Fixture', 'rest', resource, [], () => true);
        const before = contents;
        unsafe = true;
        await expect(
          store.issue('Late', 'rest', resource, [], () => true),
        ).rejects.toMatchObject({ code: 'unavailable' });
        expect(contents).toBe(before);
        expect(commits).toBe(1);
        expect(stages).toBe(2);
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
}

test('Windows actual ACL rejects outsider-readable cached and fresh ledgers without repairing bytes or ACL', async () => {
  test.skip(
    process.platform !== 'win32',
    'Windows native ACL proof runs on the consolidated Windows job',
  );
  test.setTimeout(60000);
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  const folder = await privateTestFolder(),
    native = await nativeTestBridge(folder),
    dir = path.join(folder, 'owned'),
    file = path.join(dir, 'grants.json');
  try {
    const cached = new m.MusicGrantStore(dir, Date.now, native);
    const grant = await cached.issue(
      'Fixture',
      'rest',
      resource,
      [],
      () => true,
    );
    const bytes = await readFile(file, 'utf8');
    expect(bytes).not.toContain(grant.token);
    const unsafe = fixtureAcl(folder, file, 'outsider');
    expect(unsafe.allowedOnly).toBe(false);
    await expect(
      cached.issue('Late', 'rest', resource, [], () => true),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      new m.MusicGrantStore(dir, Date.now, native).list(),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(fixtureAcl(folder, file).hash).toBe(unsafe.hash);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('Windows actual prepared temporary ACL is private and parent replacement is pinned until abort', async () => {
  test.skip(
    process.platform !== 'win32',
    'Windows native ACL proof runs on the consolidated Windows job',
  );
  test.setTimeout(60000);
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  const folder = await privateTestFolder(),
    native = await nativeTestBridge(folder),
    dir = path.join(folder, 'owned'),
    file = path.join(dir, 'grants.json');
  try {
    await new m.MusicGrantStore(dir, Date.now, native).issue(
      'Fixture',
      'rest',
      resource,
      [],
      () => true,
    );
    const before = await readFile(file, 'utf8'),
      acl = fixtureAcl(folder, file).hash,
      snapshot = await native!.read(dir);
    const lease = await native!.stage(dir, before, snapshot.binding);
    try {
      const temporaries = (await readdir(dir)).filter((name) =>
        /^\.grants-[a-f0-9]{32}\.tmp$/.test(name),
      );
      expect(temporaries).toHaveLength(1);
      expect(fixtureAcl(folder, path.join(dir, temporaries[0]))).toMatchObject({
        ownerCurrent: true,
        protected: true,
        allowedOnly: true,
        currentFull: true,
      });
      expect(
        await rename(dir, dir + '-moved').then(
          () => 'moved',
          () => 'blocked',
        ),
      ).toBe('blocked');
    } finally {
      await lease.close();
    }
    expect(
      (await readdir(dir)).filter((name) => name.startsWith('.grants-')),
    ).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(fixtureAcl(folder, file).hash).toBe(acl);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('Windows actual private ledger rejects hardlinks without changing its original bytes', async () => {
  test.skip(
    process.platform !== 'win32',
    'Windows native ACL proof runs on the consolidated Windows job',
  );
  test.setTimeout(60000);
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  const folder = await privateTestFolder(),
    native = await nativeTestBridge(folder),
    dir = path.join(folder, 'owned'),
    file = path.join(dir, 'grants.json');
  try {
    await new m.MusicGrantStore(dir, Date.now, native).issue(
      'Fixture',
      'rest',
      resource,
      [],
      () => true,
    );
    const before = await readFile(file, 'utf8');
    await link(file, path.join(folder, 'linked.json'));
    await expect(
      new m.MusicGrantStore(dir, Date.now, native).list(),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readFile(file, 'utf8')).toBe(before);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('Windows native protocol binds commit acknowledgment to the fresh main challenge', async () => {
  const f = await windowsProtocol('wrong-challenge');
  try {
    const lease = await f.bridge.stage(
      'C:\\Owned\\grants',
      '{"version":1,"records":[]}',
      null,
    );
    try {
      await expect(lease.commit()).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      await lease.close();
    }
  } finally {
    await f.close();
  }
});

test('Windows store rolls back an unpublished issue when the current lease retires after commit', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-grant-rollback-'));
  let contents: string | null = null,
    binding: string | null = null,
    alive = true,
    commits = 0;
  const bridge = {
    read: async () => ({ contents, binding }),
    stage: async (
      _directory: string,
      next: string,
      expected: string | null,
    ) => {
      expect(expected).toBe(binding);
      return {
        commit: async () => {
          contents = next;
          binding = testBinding(next);
          commits++;
          alive = false;
          return binding;
        },
        close: async () => {},
      };
    },
  };
  try {
    const store = new m.MusicGrantStore(
      path.join(folder, 'owned'),
      Date.now,
      bridge,
    );
    await expect(
      store.issue('Unpublished', 'rest', resource, [], () => alive),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(commits).toBe(2);
    expect(await store.list()).toEqual([]);
    expect(JSON.parse(contents!).records).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('Windows actual junction ledger is rejected without changing its target', async () => {
  test.skip(
    process.platform !== 'win32',
    'Windows native ACL proof runs on the consolidated Windows job',
  );
  test.setTimeout(60000);
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  const folder = await privateTestFolder(),
    native = await nativeTestBridge(folder),
    dir = path.join(folder, 'owned'),
    file = path.join(dir, 'grants.json');
  try {
    await new m.MusicGrantStore(dir, Date.now, native).issue(
      'Fixture',
      'rest',
      resource,
      [],
      () => true,
    );
    const before = await readFile(file, 'utf8'),
      acl = fixtureAcl(folder, file).hash,
      alias = path.join(folder, 'junction');
    await symlink(dir, alias, 'junction');
    await expect(
      new m.MusicGrantStore(alias, Date.now, native).list(),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(fixtureAcl(folder, file).hash).toBe(acl);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('Windows native command is fixed while literal path data never becomes executable text', async () => {
  const f = await windowsProtocol();
  try {
    await f.bridge.read('C:\\Owned\\grants');
    await f.bridge.read("C:\\Owned\\literal;$x's-folder\\grants");
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0]).toEqual(f.commands[1]);
    const command = Buffer.from(f.commands[0].args.at(-1)!, 'base64').toString(
      'utf16le',
    );
    expect(command).not.toContain("literal;$x's-folder");
    expect(f.commands[0].args).not.toContain('-ExecutionPolicy');
    const before = f.launches();
    for (const value of [
      '\\\\server\\share\\grants',
      'C:\\Owned\\grants:stream',
      'C:\\Owned\\..\\grants',
    ])
      await expect(f.bridge.read(value)).rejects.toMatchObject({
        code: 'unavailable',
      });
    expect(f.launches()).toBe(before);
  } finally {
    await f.close();
  }
});

for (const operation of ['read', 'stage'] as const)
  test(`Windows adapter rejects mixed forward-slash paths before ${operation} worker launch`, async () => {
    const f = await windowsProtocol();
    const contents = '{"version":1,"records":[]}';
    try {
      const before = f.launches();
      const rejected: boolean[] = [];
      for (const value of [
        'C:\\private/../escape',
        'C:\\private/./grants',
        'C:\\private//grants',
        'C:\\private/CON/grants',
        'C:\\private/grants',
      ]) {
        try {
          if (operation === 'read') await f.bridge.read(value);
          else {
            const lease = await f.bridge.stage(
              value,
              contents,
              testBinding(contents),
            );
            await lease.close();
          }
          rejected.push(false);
        } catch (error) {
          rejected.push((error as { code?: string }).code === 'unavailable');
        }
      }
      expect(f.launches()).toBe(before);
      expect(rejected).toEqual([true, true, true, true, true]);
    } finally {
      await f.close();
    }
  });

test('Windows terminal read and commit requests send EOF while prepare remains open', async () => {
  const f = await windowsProtocol('require-eof', 1000);
  try {
    const read = await f.bridge.read('C:\\Owned\\grants');
    expect(read.contents).toBe('{"version":1,"records":[]}');
    const lease = await f.bridge.stage(
      'C:\\Owned\\grants',
      read.contents!,
      read.binding,
    );
    expect(JSON.parse(await readFile(f.calls, 'utf8'))).toEqual(['prepare']);
    expect(await lease.commit()).toBe(read.binding);
    await lease.close();
    expect(JSON.parse(await readFile(f.calls, 'utf8'))).toEqual([
      'prepare',
      'commit',
    ]);
  } finally {
    await f.close();
  }
});

test('Windows actual short and long aliases share owned ledger identity across reload and revoke', async () => {
  test.skip(
    process.platform !== 'win32',
    'Mandatory native alias ownership proof runs on Windows',
  );
  test.setTimeout(60000);
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  const folder = await privateTestFolder(),
    native = await nativeTestBridge(folder),
    dir = path.join(folder, 'owned');
  try {
    const grant = await new m.MusicGrantStore(dir, Date.now, native).issue(
      'Alias fixture',
      'rest',
      resource,
      ['playback.read'],
      () => true,
    );
    const aliases = fixtureAcl(folder, dir, 'alias', true);
    expect(
      typeof aliases.longPath === 'string' &&
        typeof aliases.shortPath === 'string',
    ).toBe(true);
    expect(aliases.longPath !== aliases.shortPath).toBe(true);
    const longRead = await native.read(aliases.longPath),
      shortRead = await native.read(aliases.shortPath);
    expect(
      longRead.binding !== null && longRead.binding === shortRead.binding,
    ).toBe(true);
    expect(longRead.contents === shortRead.contents).toBe(true);
    const reloaded = new m.MusicGrantStore(aliases.shortPath, Date.now, native);
    const authorized = await reloaded.authorize(
      grant.token,
      'rest',
      resource,
      'playback.read',
    );
    expect(authorized.id === grant.record.id).toBe(true);
    await new m.MusicGrantStore(aliases.longPath, Date.now, native).revoke(
      grant.record.id,
      () => true,
    );
    await expect(
      new m.MusicGrantStore(aliases.shortPath, Date.now, native).authorize(
        grant.token,
        'rest',
        resource,
        'playback.read',
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const longRevoked = await native.read(aliases.longPath),
      shortRevoked = await native.read(aliases.shortPath);
    expect(
      longRevoked.binding !== null &&
        longRevoked.binding === shortRevoked.binding,
    ).toBe(true);
    expect(longRevoked.contents === shortRevoked.contents).toBe(true);
    for (const invalid of [
      dir + '\\..\\owned',
      dir + ':stream',
      '\\\\?\\' + dir,
      dir + '/../escape',
      dir + '/./owned',
      dir + '//owned',
      dir + '/CON/owned',
      dir + '/owned',
      ...[9, 10, 11, 12, 13, 133, 160].map(
        (code) => dir + String.fromCharCode(code),
      ),
    ])
      await expect(native.read(invalid)).rejects.toMatchObject({
        code: 'unavailable',
      });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('Windows failed native caller waits for physical worker close before returning cleanup ownership', async () => {
  const f = await windowsProtocol('held-failure', 500, 150);
  try {
    await expect(f.bridge.read('C:\\Owned\\grants')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(f.physicallyClosed()).toBe(true);
  } finally {
    await f.close();
  }
});

for (const operation of ['read', 'stage'] as const)
  test(`Windows adapter rejects C0 and trimmed terminal whitespace before ${operation} launch`, async () => {
    const f = await windowsProtocol();
    const contents = '{"version":1,"records":[]}';
    const invalid = [
      ...Array.from(
        { length: 32 },
        (_, code) => 'C:\\Owned\\grants' + String.fromCharCode(code),
      ),
      'C:\\Owned\\grants\u0085',
      'C:\\Owned\\grants\u00a0',
      'C:\\Ow\tner\\grants',
      'C:\\Ow\nner\\grants',
    ];
    try {
      const before = f.launches();
      const rejected: boolean[] = [];
      for (const value of invalid) {
        try {
          if (operation === 'read') await f.bridge.read(value);
          else {
            const lease = await f.bridge.stage(
              value,
              contents,
              testBinding(contents),
            );
            await lease.close();
          }
          rejected.push(false);
        } catch (error) {
          rejected.push((error as { code?: string }).code === 'unavailable');
        }
      }
      expect(f.launches()).toBe(before);
      expect(rejected).toEqual(invalid.map(() => true));
    } finally {
      await f.close();
    }
  });

for (const operation of ['read', 'stage'] as const)
  test(`Windows adapter preserves healthy Unicode and aliases for ${operation}`, async () => {
    const f = await windowsProtocol();
    const contents = '{"version":1,"records":[]}';
    try {
      const before = f.launches();
      for (const value of [
        'C:\\Owned\\Музыка\u2003',
        'C:\\Owned\\Audio\u0085Name',
        'C:\\Owned\\Audio\u00a0Name',
        'C:\\OWNED~1\\Audio',
      ]) {
        if (operation === 'read')
          expect((await f.bridge.read(value)).contents).toBe(contents);
        else {
          const lease = await f.bridge.stage(
            value,
            contents,
            testBinding(contents),
          );
          expect(await lease.commit()).toBe(testBinding(contents));
          await lease.close();
        }
      }
      expect(f.launches() - before).toBe(4);
    } finally {
      await f.close();
    }
  });

test('Windows actual private ledgers retain healthy Unicode directory namespaces', async () => {
  test.skip(
    process.platform !== 'win32',
    'Mandatory native Unicode namespace proof runs on Windows',
  );
  test.setTimeout(60000);
  const folder = await privateTestFolder(),
    native = await nativeTestBridge(folder);
  const contents = '{"version":1,"records":[]}';
  try {
    for (const name of ['Музыка\u2003', 'Audio\u0085Name', 'Audio\u00a0Name']) {
      const dir = path.join(folder, name);
      const lease = await native.stage(dir, contents, null);
      const committed = await lease.commit();
      await lease.close();
      const read = await native.read(dir);
      expect(read.contents).toBe(contents);
      expect(read.binding).toBe(committed);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
