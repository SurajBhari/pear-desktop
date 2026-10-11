import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { GRANT_MAX_BYTES } from './music-grants';

import { MusicServiceError, failMusic } from '../music-types';

export interface WindowsPrivatePath {
  read(
    directory: string,
  ): Promise<{ contents: string | null; binding: string | null }>;
  stage(
    directory: string,
    contents: string,
    expected: string | null,
  ): Promise<{
    commit(): Promise<string>;
    close(): Promise<void>;
  }>;
}
interface LaunchOptions {
  windowsHide: true;
  stdio: ['pipe', 'pipe', 'pipe'];
}
interface Runtime {
  systemRoot?: string;
  timeoutMs?: number;
  launch?: (
    file: string,
    args: string[],
    options: LaunchOptions,
  ) => ChildProcessWithoutNullStreams;
}
const FRAME_BYTES = 1024 * 1024;
const BINDING = /^[a-f0-9]{48}:[a-f0-9]{64}$/;
const unavailable = () => new MusicServiceError('unavailable');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
function directoryPath(value: string) {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^[A-Za-z]:\\/.test(value) ||
    value.includes('\0') ||
    /[<>"|?*]/.test(value) ||
    value.slice(2).includes(':')
  )
    throw unavailable();
  const parts = value.slice(3).split('\\');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw unavailable();
  return value;
}
function decodeRead(value: Record<string, unknown>) {
  if (!keys(value, ['version', 'type', 'contents64', 'binding']))
    throw unavailable();
  if (value.contents64 === null && value.binding === null)
    return { contents: null, binding: null };
  if (
    typeof value.contents64 !== 'string' ||
    typeof value.binding !== 'string' ||
    !BINDING.test(value.binding)
  )
    throw unavailable();
  const bytes = Buffer.from(value.contents64, 'base64');
  if (
    bytes.length > GRANT_MAX_BYTES ||
    bytes.toString('base64') !== value.contents64
  )
    throw unavailable();
  if (
    createHash('sha256').update(bytes).digest('hex') !== value.binding.slice(49)
  )
    throw unavailable();
  return {
    contents: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    binding: value.binding,
  };
}

/** Fixed worker: paths and digest-only bytes are data on private pipes, never executable text. */
export function createWindowsPrivatePath(
  runtime: Runtime = {},
): WindowsPrivatePath {
  const start = (
    operation: 'read' | 'prepare',
    directory: string,
    contents: string | null,
    expected: string | null,
  ) => {
    directoryPath(directory);
    if (expected !== null && !BINDING.test(expected)) throw unavailable();
    const root = runtime.systemRoot ?? process.env.SystemRoot;
    if (!root || root.length > 260) throw unavailable();
    directoryPath(root);
    const timeout = runtime.timeoutMs ?? 8000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 8000)
      throw unavailable();
    const packed = gzipSync(
      Buffer.from(WINDOWS_PRIVATE_WORKER, 'utf8'),
    ).toString('base64');
    // Packing only the fixed reviewed program keeps CreateProcess below its command-line limit.
    const bootstrap = `$ErrorActionPreference='Stop';try{$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}'));$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);$s=$r.ReadToEnd();$r.Dispose();&([ScriptBlock]::Create($s))}catch{[Console]::WriteLine('{"version":1,"type":"failure"}');[Console]::Error.WriteLine('unavailable');exit 1}`;
    const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
    if (encoded.length > 28000) throw unavailable();
    const request =
      JSON.stringify({
        version: 1,
        operation,
        directory,
        contents64:
          contents === null
            ? null
            : Buffer.from(contents, 'utf8').toString('base64'),
        expected,
      }) + '\n';
    if (Buffer.byteLength(request) > FRAME_BYTES) throw unavailable();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (
        runtime.launch ?? ((file, args, options) => spawn(file, args, options))
      )(
        path.win32.join(
          root,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encoded,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      throw unavailable();
    }
    let failure: MusicServiceError | undefined,
      buffer = Buffer.alloc(0),
      stdoutBytes = 0,
      stderrBytes = 0;
    let phase = operation === 'read' ? 'read' : 'ready',
      completed = false,
      aborting = false,
      challenge: string | undefined;
    let waiting:
      | {
          type: string;
          resolve(value: Record<string, unknown>): void;
          reject(error: MusicServiceError): void;
        }
      | undefined;
    let exitResolve!: () => void,
      exitReject!: (error: MusicServiceError) => void;
    const exited = new Promise<void>((resolve, reject) => {
      exitResolve = resolve;
      exitReject = reject;
    });
    exited.catch(() => {});
    const stop = () => {
      try {
        child.stdin.destroy();
        child.kill('SIGKILL');
      } catch {
        /* Caller remains failed closed. */
      }
    };
    const fail = () => {
      if (failure) return;
      failure = unavailable();
      waiting?.reject(failure);
      waiting = undefined;
      exitReject(failure);
      clearTimeout(timer);
      stop();
    };
    const timer = setTimeout(fail, timeout);
    timer.unref?.();
    const take = (type: string) => {
      if (failure || waiting) return Promise.reject(failure ?? unavailable());
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        waiting = { type, resolve, reject };
      });
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > FRAME_BYTES) {
        fail();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (!failure) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        try {
          const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(line),
          );
          if (
            !record(value) ||
            value.version !== 1 ||
            value.type === 'failure' ||
            !waiting ||
            value.type !== waiting.type ||
            value.type !== phase
          ) {
            fail();
            return;
          }
          if (value.type === 'ready' && !keys(value, ['version', 'type'])) {
            fail();
            return;
          }
          if (
            value.type === 'committed' &&
            (!keys(value, ['version', 'type', 'binding', 'challenge']) ||
              value.challenge !== challenge ||
              typeof value.binding !== 'string' ||
              !BINDING.test(value.binding))
          ) {
            fail();
            return;
          }
          const next = waiting;
          waiting = undefined;
          if (value.type !== 'ready') completed = true;
          phase = value.type === 'ready' ? 'prepared' : 'complete';
          next.resolve(value);
        } catch {
          fail();
          return;
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024) fail();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) return;
      if (code !== 0 || buffer.length || (!completed && !aborting)) {
        fail();
        return;
      }
      exitResolve();
    });
    const response = take(operation === 'read' ? 'read' : 'ready');
    child.stdin.write(request);
    return {
      response,
      exited,
      assert() {
        if (failure) throw failure;
      },
      fail,
      async commit() {
        if (failure) throw failure;
        if (phase !== 'prepared' || aborting) throw unavailable();
        phase = 'committed';
        challenge = randomUUID();
        const response = take('committed');
        child.stdin.write(
          JSON.stringify({ version: 1, action: 'commit', challenge }) + '\n',
        );
        const packet = await response;
        await exited;
        if (failure) throw unavailable();
        return packet.binding as string;
      },
      async close() {
        if (!completed && !failure && phase === 'prepared') {
          aborting = true;
          child.stdin.end('{"version":1,"action":"abort"}\n');
        }
        await exited.catch(() => {});
      },
    };
  };
  return {
    async read(directory) {
      let worker: ReturnType<typeof start> | undefined;
      try {
        worker = start('read', directory, null, null);
        const packet = await worker.response;
        const result = decodeRead(packet);
        await worker.exited;
        worker.assert();
        return result;
      } catch {
        worker?.fail();
        throw unavailable();
      }
    },
    async stage(directory, contents, expected) {
      if (
        typeof contents !== 'string' ||
        Buffer.byteLength(contents) > GRANT_MAX_BYTES
      )
        return failMusic('budget');
      let worker: ReturnType<typeof start> | undefined;
      try {
        worker = start('prepare', directory, contents, expected);
        await worker.response;
        worker.assert();
        const prepared = worker;
        return {
          async commit() {
            const binding = await prepared.commit();
            if (
              binding.slice(49) !==
              createHash('sha256').update(contents, 'utf8').digest('hex')
            )
              throw unavailable();
            return binding;
          },
          close: () => prepared.close(),
        };
      } catch {
        worker?.fail();
        throw unavailable();
      }
    },
  };
}

const WINDOWS_PRIVATE_WORKER = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ctx=$null
try {
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Security.AccessControl;using System.Security.Principal;using System.Security.Cryptography;using Microsoft.Win32.SafeHandles;
public sealed class GrantData {public string Contents64;public string Binding;}
public sealed class GrantPath:IDisposable {
const int Max=524288;const uint RC=0x20000,RA=0x80,SY=0x100000,DEL=0x10000;
static readonly string User=WindowsIdentity.GetCurrent().User.Value;
List<SafeFileHandle> chain=new List<SafeFileHandle>();SafeFileHandle dir,old,tmp;string folder,expected;bool published;
[StructLayout(LayoutKind.Sequential)]struct SA {public int Size;public IntPtr SD;public int Inherit;}
[StructLayout(LayoutKind.Sequential)]struct Info {public uint Attr;public System.Runtime.InteropServices.ComTypes.FILETIME C,A,W;public uint Vol,Hi,Lo,Links,IndexHi,IndexLo;}
[StructLayout(LayoutKind.Sequential)]struct ID {public ulong Vol;[MarshalAs(UnmanagedType.ByValArray,SizeConst=16)]public byte[] Bytes;}
[StructLayout(LayoutKind.Sequential)]struct Ren {public byte Replace;public IntPtr Root;public uint Length;public ushort First;}
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFileW(string p,uint a,uint share,IntPtr sa,uint mode,uint flags,IntPtr template);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFileW(string p,uint a,uint share,ref SA sa,uint mode,uint flags,IntPtr template);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateDirectoryW(string p,ref SA sa);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s,uint r,out IntPtr p,out uint n);
[DllImport("advapi32.dll")]static extern uint GetSecurityInfo(SafeFileHandle h,int t,uint f,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr a,out IntPtr sd);
[DllImport("advapi32.dll")]static extern uint GetSecurityDescriptorLength(IntPtr sd);
[DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);
[DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
[DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out ID i,uint size);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetVolumeInformationByHandleW(SafeFileHandle h,StringBuilder v,uint vs,out uint serial,out uint max,out uint flags,StringBuilder fs,uint fss);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern uint GetDriveTypeW(string root);
[DllImport("kernel32.dll",SetLastError=true)]static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,IntPtr data,uint size);
static Exception Bad(){return new IOException("unavailable");}
static string Native(string p){return @"\\?\"+p;}
static bool Trusted(string s){return s==User||s=="S-1-5-18"||s=="S-1-5-32-544";}
static Info Stat(SafeFileHandle h,bool directory){Info i;if(h.IsInvalid||!GetFileInformationByHandle(h,out i))throw Bad();if((i.Attr&0x400)!=0||((i.Attr&0x10)!=0)!=directory)throw Bad();if(!directory&&(i.Links!=1||i.Hi!=0||i.Lo>Max))throw Bad();return i;}
static string Identity(SafeFileHandle h){ID i;if(!GetFileInformationByHandleEx(h,18,out i,24)||i.Bytes==null)throw Bad();bool valid=false;foreach(byte b in i.Bytes)if(b!=0)valid=true;if(!valid)throw Bad();return i.Vol.ToString("x16")+BitConverter.ToString(i.Bytes).Replace("-","").ToLowerInvariant();}
static RawSecurityDescriptor Security(SafeFileHandle h){IntPtr o,g,d,a,p;uint e=GetSecurityInfo(h,1,5,out o,out g,out d,out a,out p);if(e!=0||p==IntPtr.Zero)throw Bad();try{uint n=GetSecurityDescriptorLength(p);if(n==0||n>65536)throw Bad();byte[] b=new byte[n];Marshal.Copy(p,b,0,(int)n);return new RawSecurityDescriptor(b,0);}finally{LocalFree(p);}}
static void Private(SafeFileHandle h,bool directory){Stat(h,directory);RawSecurityDescriptor sd=Security(h);if(sd.Owner==null||sd.Owner.Value!=User||sd.DiscretionaryAcl==null||(sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)throw Bad();bool self=false;HashSet<string> seen=new HashSet<string>();foreach(GenericAce raw in sd.DiscretionaryAcl){CommonAce ace=raw as CommonAce;if(ace==null||ace.IsCallback||ace.AceQualifier!=AceQualifier.AccessAllowed||ace.AccessMask!=0x1f01ff||!Trusted(ace.SecurityIdentifier.Value)||!seen.Add(ace.SecurityIdentifier.Value)||ace.AceFlags!=(directory?(AceFlags.ObjectInherit|AceFlags.ContainerInherit):AceFlags.None))throw Bad();if(ace.SecurityIdentifier.Value==User)self=true;}if(!self)throw Bad();}
static void Parent(SafeFileHandle h){RawSecurityDescriptor sd=Security(h);if(sd.Owner==null||!Trusted(sd.Owner.Value)||sd.DiscretionaryAcl==null)throw Bad();foreach(GenericAce raw in sd.DiscretionaryAcl){CommonAce ace=raw as CommonAce;if(ace==null||ace.IsCallback)throw Bad();if(ace.AceQualifier==AceQualifier.AccessAllowed&&(ace.AceFlags&AceFlags.InheritOnly)==0&&!Trusted(ace.SecurityIdentifier.Value)&&(ace.AccessMask&0xd0156)!=0)throw Bad();}}
static string Sddl(bool directory){string flags=directory?"OICI":"";return "O:"+User+"D:P(A;"+flags+";FA;;;"+User+")"+(User=="S-1-5-18"?"":"(A;"+flags+";FA;;;SY)")+"(A;"+flags+";FA;;;BA)";}
static IntPtr Descriptor(bool directory){IntPtr p;uint n;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(Sddl(directory),1,out p,out n))throw Bad();return p;}
static SafeFileHandle OpenDir(string p,bool write){SafeFileHandle h=CreateFileW(Native(p),RC|RA|SY|(write?0x46u:0u),3,IntPtr.Zero,3,0x2200000,IntPtr.Zero);if(h.IsInvalid){h.Dispose();return null;}try{Stat(h,true);return h;}catch{h.Dispose();throw;}}
public GrantPath(string value,bool create){try{folder=Path.GetFullPath(value);if(folder!=value||folder.Length>4096)throw Bad();string root=Path.GetPathRoot(folder),parent=Path.GetDirectoryName(folder);if(parent==null||(GetDriveTypeW(root)!=2&&GetDriveTypeW(root)!=3))throw Bad();string current=root;SafeFileHandle h=OpenDir(current,false);if(h==null)throw Bad();chain.Add(h);uint serial,max,flags;StringBuilder fs=new StringBuilder(32);if(!GetVolumeInformationByHandleW(h,null,0,out serial,out max,out flags,fs,32)||(flags&8)==0||(fs.ToString()!="NTFS"&&fs.ToString()!="ReFS"))throw Bad();string rest=parent.Substring(root.Length);string[] names=rest.Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries);if(names.Length>64)throw Bad();foreach(string name in names){current=Path.Combine(current,name);h=OpenDir(current,false);if(h==null)throw Bad();chain.Add(h);}Parent(chain[chain.Count-1]);if(create){IntPtr sd=Descriptor(true);try{SA sa=new SA{Size=Marshal.SizeOf(typeof(SA)),SD=sd};if(!CreateDirectoryW(Native(folder),ref sa)&&Marshal.GetLastWin32Error()!=183)throw Bad();}finally{LocalFree(sd);}}dir=OpenDir(folder,create);if(dir==null){int error=Marshal.GetLastWin32Error();if(!create&&(error==2||error==3))return;throw Bad();}Private(dir,true);}catch{Dispose();throw;}}
SafeFileHandle Ledger(uint share){SafeFileHandle h=CreateFileW(Native(Path.Combine(folder,"grants.json")),0x80000000|RC|RA,share,IntPtr.Zero,3,0x200000,IntPtr.Zero);if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();if(e==2||e==3)return null;throw Bad();}try{Private(h,false);return h;}catch{h.Dispose();throw;}}
static byte[] Bytes(SafeFileHandle h){Stat(h,false);using(SafeFileHandle borrowed=new SafeFileHandle(h.DangerousGetHandle(),false))using(FileStream stream=new FileStream(borrowed,FileAccess.Read,8192,false))using(MemoryStream data=new MemoryStream()){stream.Position=0;byte[] b=new byte[8192];int n;while((n=stream.Read(b,0,b.Length))>0){if(data.Length+n>Max)throw Bad();data.Write(b,0,n);}Private(h,false);return data.ToArray();}}
static string Bind(SafeFileHandle h,byte[] bytes){using(SHA256 sha=SHA256.Create())return Identity(h)+":"+BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
public GrantData Read(){if(dir==null)return new GrantData();using(SafeFileHandle h=Ledger(1)){if(h==null)return new GrantData();byte[] bytes=Bytes(h);return new GrantData{Contents64=Convert.ToBase64String(bytes),Binding=Bind(h,bytes)};}}
void Destination(){if(dir==null)throw Bad();Parent(chain[chain.Count-1]);Private(dir,true);using(SafeFileHandle h=Ledger(7)){string actual=h==null?null:Bind(h,Bytes(h));if(actual!=expected)throw Bad();}}
public void Prepare(string data,string wanted){expected=String.IsNullOrEmpty(wanted)?null:wanted;Destination();byte[] bytes=Convert.FromBase64String(data);if(bytes.Length>Max)throw Bad();old=Ledger(7);string name=".grants-"+Guid.NewGuid().ToString("N")+".tmp";IntPtr sd=Descriptor(false);try{SA sa=new SA{Size=Marshal.SizeOf(typeof(SA)),SD=sd};tmp=CreateFileW(Native(Path.Combine(folder,name)),0xc0000000|RC|RA|DEL,0,ref sa,1,0x80200080,IntPtr.Zero);}finally{LocalFree(sd);}if(tmp==null||tmp.IsInvalid)throw Bad();Private(tmp,false);using(SafeFileHandle borrowed=new SafeFileHandle(tmp.DangerousGetHandle(),false))using(FileStream stream=new FileStream(borrowed,FileAccess.Write,8192,false)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}Private(tmp,false);}
public string Commit(){if(tmp==null||published)throw Bad();Destination();Private(tmp,false);byte[] name=Encoding.Unicode.GetBytes("grants.json");int offset=(int)Marshal.OffsetOf(typeof(Ren),"First");IntPtr buffer=Marshal.AllocHGlobal(offset+name.Length);try{for(int i=0;i<offset+name.Length;i++)Marshal.WriteByte(buffer,i,0);Marshal.WriteByte(buffer,0,1);Marshal.WriteIntPtr(buffer,(int)Marshal.OffsetOf(typeof(Ren),"Root"),dir.DangerousGetHandle());Marshal.WriteInt32(buffer,(int)Marshal.OffsetOf(typeof(Ren),"Length"),name.Length);Marshal.Copy(name,0,IntPtr.Add(buffer,offset),name.Length);if(!SetFileInformationByHandle(tmp,3,buffer,(uint)(offset+name.Length)))throw Bad();published=true;}finally{Marshal.FreeHGlobal(buffer);}Private(tmp,false);return Bind(tmp,Bytes(tmp));}
public void Dispose(){if(tmp!=null){if(!tmp.IsInvalid&&!published){IntPtr p=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(p,1);SetFileInformationByHandle(tmp,4,p,1);}finally{Marshal.FreeHGlobal(p);}}tmp.Dispose();tmp=null;}if(old!=null){old.Dispose();old=null;}if(dir!=null){dir.Dispose();dir=null;}for(int i=chain.Count-1;i>=0;i--)chain[i].Dispose();chain.Clear();}
}
'@
$line=[Console]::ReadLine()
if ($null -eq $line -or $line.Length -gt 1048576) {throw 'unavailable'}
$r=$line | ConvertFrom-Json
$names=@($r.PSObject.Properties.Name)
if ($names.Count -ne 5 -or @($names | Where-Object {$_ -notin @('version','operation','directory','contents64','expected')}).Count -ne 0 -or $r.version -ne 1 -or $r.directory -isnot [string]) {throw 'unavailable'}
if ($r.operation -eq 'read') {
 if ($null -ne $r.contents64 -or $null -ne $r.expected) {throw 'unavailable'}
 $ctx=New-Object -TypeName GrantPath -ArgumentList @($r.directory,$false)
 $v=$ctx.Read()
 [Console]::WriteLine((@{version=1;type='read';contents64=$v.Contents64;binding=$v.Binding} | ConvertTo-Json -Compress))
} elseif ($r.operation -eq 'prepare') {
 if ($r.contents64 -isnot [string] -or ($null -ne $r.expected -and ($r.expected -isnot [string] -or $r.expected -notmatch '^[a-f0-9]{48}:[a-f0-9]{64}$'))) {throw 'unavailable'}
 $ctx=New-Object -TypeName GrantPath -ArgumentList @($r.directory,$true)
 $ctx.Prepare($r.contents64,[string]$r.expected)
 [Console]::WriteLine('{"version":1,"type":"ready"}')
 $line=[Console]::ReadLine()
 if ($null -eq $line -or $line.Length -gt 128) {throw 'unavailable'}
 $r=$line | ConvertFrom-Json
 if ($r.version -ne 1) {throw 'unavailable'}
 if ($r.action -eq 'commit') {
  if (@($r.PSObject.Properties).Count -ne 3 -or $r.challenge -isnot [string] -or $r.challenge -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {throw 'unavailable'}
  $binding=$ctx.Commit()
  [Console]::WriteLine((@{version=1;type='committed';binding=$binding;challenge=$r.challenge} | ConvertTo-Json -Compress))
 } elseif ($r.action -ne 'abort' -or @($r.PSObject.Properties).Count -ne 2) {throw 'unavailable'}
} else {throw 'unavailable'}
} catch {[Console]::WriteLine('{"version":1,"type":"failure"}');[Console]::Error.WriteLine('unavailable');exit 1}
finally {if ($null -ne $ctx) {$ctx.Dispose()}}
`.trim();
