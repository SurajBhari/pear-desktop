import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  rename,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { build } from 'vite';
import { _electron as electron } from '@playwright/test';
import {
  waitForStartupFacts,
  assertStartupFacts,
  terminateStartupProcess,
  nativeStartupPid,
} from './electron-startup.js';

type PhaseError = { phase: string; error: unknown };
type ErrorFacts = {
  phase: 'task' | 'bootstrap';
  name: string;
  code: string;
  site: { line: number; column: number }[];
};

// Self-contained: also serialized into the generated entry.cjs. No messages,
// stacks, paths or arbitrary property values cross the diagnostic boundary.
function syntheticErrorFacts(
  error: unknown,
  phase: 'task' | 'bootstrap',
): ErrorFacts {
  try {
    const names = [
      'Error',
      'TypeError',
      'RangeError',
      'ReferenceError',
      'SyntaxError',
      'URIError',
      'EvalError',
      'AggregateError',
    ];
    const codes = [
      'ENOENT',
      'EACCES',
      'EPERM',
      'ESRCH',
      'ETIMEDOUT',
      'EPIPE',
      'ECONNRESET',
      'ABORT_ERR',
      'ERR_ASSERTION',
    ];
    const value = error as {
      name?: unknown;
      code?: unknown;
      stack?: unknown;
    } | null;
    const nameValue = value?.name;
    const codeValue = value?.code;
    const stackValue = value?.stack;
    const name =
      typeof nameValue === 'string' && names.includes(nameValue)
        ? nameValue
        : 'Other';
    const code =
      codeValue === undefined
        ? 'none'
        : typeof codeValue === 'string' && codes.includes(codeValue)
          ? codeValue
          : 'Other';
    const site: { line: number; column: number }[] = [];
    if (typeof stackValue === 'string') {
      const pattern = /(?:^|[\\/])entry\.cjs:(\d{1,7}):(\d{1,7})\b/g;
      for (const match of stackValue.matchAll(pattern)) {
        site.push({ line: Number(match[1]), column: Number(match[2]) });
        if (site.length === 3) break;
      }
    }
    return { phase, name, code, site };
  } catch {
    return { phase, name: 'Other', code: 'Other', site: [] };
  }
}

function safeStructuredError(value: unknown): ErrorFacts | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'code,name,phase,site') return;
  if (record.phase !== 'task' && record.phase !== 'bootstrap') return;
  if (!Array.isArray(record.site) || record.site.length > 3) return;
  const facts = syntheticErrorFacts(
    { name: record.name, code: record.code },
    record.phase,
  );
  if (
    facts.name !== record.name ||
    (facts.code !== record.code && record.code !== 'none')
  )
    return;
  if (
    !record.site.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        Object.keys(item).sort().join(',') === 'column,line' &&
        Number.isSafeInteger(item.line) &&
        item.line >= 0 &&
        item.line <= 9999999 &&
        Number.isSafeInteger(item.column) &&
        item.column >= 0 &&
        item.column <= 9999999,
    )
  )
    return;
  return {
    ...facts,
    code: record.code as string,
    site: record.site.map((item) => ({ line: item.line, column: item.column })),
  };
}

function phaseFailure(errors: PhaseError[], message: string) {
  const error =
    errors.length === 1
      ? errors[0].error
      : new AggregateError(
          errors.map((entry) => entry.error),
          message,
        );
  try {
    if (error instanceof Error) {
      const history = (error as Error & { diagnosticErrors?: PhaseError[] })
        .diagnosticErrors;
      Object.defineProperty(error, 'diagnosticErrors', {
        value: Object.freeze(
          [...(Array.isArray(history) ? history : []), ...errors].map((entry) =>
            Object.freeze({ ...entry }),
          ),
        ),
        configurable: true,
      });
    }
  } catch {}
  return error;
}

function nativeDiagnostics(child?: ChildProcess) {
  const attached = performance.now();
  const elapsed = () =>
    Math.max(0, Math.min(999999999, Math.round(performance.now() - attached)));
  const code = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  const signal = (value: unknown) =>
    typeof value === 'string' &&
    [
      'SIGABRT',
      'SIGFPE',
      'SIGHUP',
      'SIGILL',
      'SIGINT',
      'SIGKILL',
      'SIGPIPE',
      'SIGQUIT',
      'SIGSEGV',
      'SIGTERM',
      'SIGTRAP',
      'SIGUSR1',
      'SIGUSR2',
      'SIGBREAK',
    ].includes(value)
      ? value
      : null;
  const baseline = {
    exitCode: code(child?.exitCode),
    signalCode: signal(child?.signalCode),
  };
  const events: {
    phase: string;
    at: number;
    code?: number | null;
    signal?: string | null;
    name?: string;
    errorCode?: string;
    killed?: boolean;
  }[] = [];
  const taskRecords: ErrorFacts[] = [];
  let bytesSeen = 0;
  let retained = Buffer.alloc(0);
  let stopped = false;
  let finalSnapshot: ReturnType<typeof snapshot> | undefined;
  const exit = {
    observed: false,
    code: null as number | null,
    signal: null as string | null,
  };
  const close = { ...exit };
  const record = (entry: (typeof events)[number]) => {
    if (!stopped && events.length < 32) events.push(entry);
  };
  const onStderr = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesSeen = Math.min(Number.MAX_SAFE_INTEGER, bytesSeen + bytes.length);
    if (retained.length < 16384)
      retained = Buffer.concat([
        retained,
        bytes.subarray(0, 16384 - retained.length),
      ]);
  };
  const onExit = (value: unknown, sig: unknown) => {
    Object.assign(exit, {
      observed: true,
      code: code(value),
      signal: signal(sig),
    });
    record({
      phase: 'exit',
      at: elapsed(),
      code: exit.code,
      signal: exit.signal,
    });
  };
  const onClose = (value: unknown, sig: unknown) => {
    Object.assign(close, {
      observed: true,
      code: code(value),
      signal: signal(sig),
    });
    record({
      phase: 'close',
      at: elapsed(),
      code: close.code,
      signal: close.signal,
    });
  };
  child?.stderr?.on('data', onStderr);
  child?.on('exit', onExit);
  child?.on('close', onClose);
  function snapshot() {
    const taskErrors = taskRecords.map((entry) => ({
      ...entry,
      site: entry.site.map((site) => ({ ...site })),
    }));
    const records: ErrorFacts[] = [];
    for (const line of retained.toString('utf8').split('\n')) {
      try {
        const facts = safeStructuredError(JSON.parse(line));
        if (facts && records.length < 32) records.push(facts);
      } catch {}
    }
    const packet = {
      schema: 1,
      coverage: child ? 'after-launch-return' : 'launch-not-returned',
      attachedAt: 0,
      captureStopped: stopped,
      nativeAbsence: 'UNKNOWN',
      baseline: { ...baseline },
      exit: { ...exit },
      close: { ...close },
      stderr: {
        bytesSeen,
        bytesRetained: retained.length,
        truncated: bytesSeen > retained.length,
        sha256: createHash('sha256').update(retained).digest('hex'),
        content: 'UNKNOWN',
        records,
      },
      taskErrors,
      events: events.map((entry) => ({ ...entry })),
    };
    // One shared entry budget and one byte budget for every emitted snapshot.
    while (
      packet.events.length + records.length + taskErrors.length > 32 ||
      Buffer.byteLength(JSON.stringify(packet)) > 3800
    ) {
      if (records.length) records.pop();
      else if (packet.events.length) packet.events.pop();
      else taskErrors.pop();
    }
    Object.freeze(packet.baseline);
    Object.freeze(packet.exit);
    Object.freeze(packet.close);
    records.forEach((entry) => {
      entry.site.forEach(Object.freeze);
      Object.freeze(entry.site);
      Object.freeze(entry);
    });
    taskErrors.forEach((entry) => {
      entry.site.forEach(Object.freeze);
      Object.freeze(entry.site);
      Object.freeze(entry);
    });
    Object.freeze(taskErrors);
    Object.freeze(records);
    Object.freeze(packet.stderr);
    packet.events.forEach(Object.freeze);
    Object.freeze(packet.events);
    return Object.freeze(packet);
  }
  return {
    error(phase: string, error: unknown) {
      const add = (label: string, value: unknown) => {
        if (
          ![
            'startup',
            'startup-terminate',
            'terminate',
            'fallback-query',
            'fallback-signal-wait',
            'close-wait',
            'remove',
            'query',
            'launcher-validation',
            'owned-query-close',
          ].includes(label)
        )
          return;
        const entry: (typeof events)[number] = {
          phase: label,
          at: elapsed(),
          name: 'Other',
          errorCode: 'Other',
        };
        try {
          const details = value as {
            name?: unknown;
            stack?: unknown;
            code?: unknown;
            killed?: unknown;
            signal?: unknown;
          } | null;
          const nameValue = details?.name;
          const codeValue = details?.code;
          const stackValue = details?.stack;
          const killedValue = details?.killed;
          const signalValue = details?.signal;
          const facts = syntheticErrorFacts(
            { name: nameValue, code: codeValue, stack: stackValue },
            'task',
          );
          entry.name = facts.name;
          entry.errorCode = facts.code;
          if (codeValue === null || typeof codeValue === 'number')
            entry.code = code(codeValue);
          if (typeof killedValue === 'boolean') entry.killed = killedValue;
          const signalFact = signal(signalValue);
          if (signalValue === null || signalFact) entry.signal = signalFact;
        } catch {}
        record(entry);
      };
      add(phase, error);
      try {
        const history = (error as { diagnosticErrors?: unknown } | null)
          ?.diagnosticErrors;
        if (Array.isArray(history))
          for (const entry of history.slice(0, 32)) {
            const phaseValue = entry?.phase;
            const errorValue = entry?.error;
            if (typeof phaseValue === 'string') add(phaseValue, errorValue);
          }
      } catch {}
    },
    task(facts: ErrorFacts | undefined) {
      if (!stopped && facts && taskRecords.length < 32) taskRecords.push(facts);
    },
    snapshot: () => finalSnapshot ?? snapshot(),
    stop() {
      if (stopped) return;
      child?.stderr?.off('data', onStderr);
      child?.off('exit', onExit);
      child?.off('close', onClose);
      stopped = true;
      finalSnapshot = snapshot();
      // Raw stderr is volatile, bounded and never part of the returned packet.
      retained = Buffer.alloc(0);
    },
  };
}

const root = path.resolve(import.meta.dirname, '../..');

/** Actual isolated BrowserWindow/Session fixture; every HTTP(S) request is intercepted. */
export async function scrobblerAuthNative() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-scrobbler-window-'),
  );
  const profile = path.join(directory, 'profile');
  await mkdir(profile);
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
  const production = path.join(
    root,
    'src/plugins/scrobbler/services/ws-auth-window.ts',
  );
  const entry = path.join(directory, 'bundle.ts');
  await writeFile(
    entry,
    (existsSync(production)
      ? `export {openScrobblingAuthWindow} from ${JSON.stringify(production)};`
      : `export function openScrobblingAuthWindow(){const ready=Promise.reject(new Error('Missing native auth window'));ready.catch(()=>{});return {ready,closed:Promise.resolve(),close(){}}}`) +
      `export {WsAuthController} from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/services/ws-auth.ts'))};`,
  );
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['cjs'], fileName: () => 'adapter.cjs' },
      rollupOptions: { external: ['electron', 'node:crypto'] },
    },
  });
  await writeFile(
    path.join(directory, 'parent.html'),
    '<html><body>Owned parent fixture</body></html>',
  );
  const script = `
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path');const syntheticErrorFacts=${syntheticErrorFacts.toString()};
const owned=${JSON.stringify(directory)};app.setPath('userData',${JSON.stringify(profile)});fs.mkdirSync(path.join(owned,'downloads'));app.setPath('downloads',path.join(owned,'downloads'));fs.mkdirSync(path.join(owned,'sessionData'));app.setPath('sessionData',path.join(owned,'sessionData'));
const pages={mode:'normal',pending:[],requests:0};const created=[],handlers=new Map(),readyHandlers=new Map(),shows=new Map(),partitions=[];
const intercept=async request=>{pages.requests++;globalThis.AuthWindowFixture?.trace('HTTPS request');if(pages.mode==='hold')await new Promise(yes=>pages.pending.push(yes));if(pages.mode==='failure')throw Error('Owned load failure');if(new URL(request.url).pathname==='/download')return new Response('owned download fixture',{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=owned.bin'}});return new Response('<html><body>Owned HTTPS login fixture<script>window.onbeforeunload=()=>"hold";<\/script></body></html>',{headers:{'Content-Type':'text/html'}})};
const permissions=new Map();const permissionChecks=new Map();const clears=[];const configured=new WeakSet();const configure=ses=>{if(configured.has(ses))return;configured.add(ses);const request=ses.setPermissionRequestHandler.bind(ses),check=ses.setPermissionCheckHandler.bind(ses);ses.setPermissionRequestHandler=handler=>{permissions.set(ses,handler);request(handler)};ses.setPermissionCheckHandler=handler=>{permissionChecks.set(ses,handler);check(handler)};for(const method of ['clearStorageData','clearCache']){const native=ses[method].bind(ses);ses[method]=(...args)=>{const promise=native(...args);clears.push({session:ses,method,promise});return promise;};}ses.protocol.handle('https',intercept);ses.protocol.handle('http',intercept);};
const taskPath=path.join(owned,'task.json');let lastTask=0;
fs.watchFile(taskPath,{interval:5},async()=>{if(!fs.existsSync(taskPath))return;const task=JSON.parse(fs.readFileSync(taskPath,'utf8'));if(task.id<=lastTask)return;lastTask=task.id;try{const fn=eval('('+task.source+')');const result=await fn(require('electron'),task.arg);fs.writeFileSync(path.join(owned,'result.tmp'),JSON.stringify({id:task.id,ok:true,result}));fs.renameSync(path.join(owned,'result.tmp'),path.join(owned,'result.json'));}catch(error){fs.writeFileSync(path.join(owned,'result.tmp'),JSON.stringify({id:task.id,ok:false,error:syntheticErrorFacts(error,'task')}));fs.renameSync(path.join(owned,'result.tmp'),path.join(owned,'result.json'));}});
app.on('session-created',configure);app.on('window-all-closed',()=>{});
app.on('browser-window-created',(_event,win)=>{created.push(win);globalThis.AuthWindowFixture?.trace('window-created '+win.id);const contents=win.webContents;contents.on('will-navigate',(event,url)=>globalThis.AuthWindowFixture?.trace('navigate args '+typeof url+' '+typeof event.url));contents.on('did-finish-load',()=>globalThis.AuthWindowFixture?.trace('finished window '+win.id));const native=contents.setWindowOpenHandler.bind(contents);contents.setWindowOpenHandler=handler=>{handlers.set(contents.id,handler);native(details=>{globalThis.AuthWindowFixture?.trace('popup-handler begin');const answer=handler(details);globalThis.AuthWindowFixture?.trace('popup-handler '+answer.action);if(answer.createWindow){const creator=answer.createWindow;answer.createWindow=options=>{globalThis.AuthWindowFixture?.trace('popup-create begin '+Object.keys(options).join(',')+' prefs '+Object.keys(options.webPreferences||{}).join(','));const child=creator(options);globalThis.AuthWindowFixture?.trace('popup-create finish');return child;};}return answer;})};const on=win.on.bind(win);win.on=(event,handler)=>{if(event==='ready-to-show')readyHandlers.set(win.id,handler);return on(event,handler)};const show=win.show.bind(win);win.show=()=>{shows.set(win.id,(shows.get(win.id)||0)+1);return show()};if(globalThis.AuthWindowFixture?.abortOnCreate)globalThis.AuthWindowFixture.abortOnCreate.abort();});
(async()=>{await app.whenReady();configure(session.defaultSession);const parentSession=session.fromPartition('scrobble-owned-parent',{cache:false});configure(parentSession);const createParent=()=>{const win=new BrowserWindow({show:true,width:300,height:200,webPreferences:{session:parentSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(owned,'parent.html'));return win};
 const watchCancelledDownload=ses=>{let proof;const observe=(event,item)=>{const guardCount=ses.listenerCount('will-download');queueMicrotask(()=>{let state,removed=false;try{state=item.getState();}catch(error){removed=String(error).includes('Object has been destroyed');}proof={guardCount,prevented:event.defaultPrevented===true,cancelledOrRemoved:state==='cancelled'||removed};});};ses.prependOnceListener('will-download',observe);return{read:()=>proof,dispose:()=>ses.removeListener('will-download',observe)};};
 const adapter=require('./adapter.cjs');globalThis.AuthWindowFixture={trace:phase=>fs.appendFileSync(path.join(owned,'trace.log'),phase+String.fromCharCode(10)),...adapter,main:createParent(),parentSession,defaultSession:session.defaultSession,pages,created,handlers,readyHandlers,shows,partitions,clears,permissions,permissionChecks,downloadFiles:()=>fs.readdirSync(path.join(owned,'downloads')),watchCancelledDownload,createParent};
})().catch(error=>{try{process.stderr.write(JSON.stringify(syntheticErrorFacts(error,'bootstrap'))+String.fromCharCode(10));}catch{}app.exit(1);});
`;
  await writeFile(path.join(directory, 'entry.cjs'), script);
  const facts = path.join(directory, 'startup.json');
  const env = { ...process.env, PEAR_TEST_STARTUP_FACTS: facts };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let processClosed: Promise<void> | undefined;
  let diagnostics: ReturnType<typeof nativeDiagnostics> | undefined;
  const waitForProcessClose = async () => {
    if (!processClosed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        processClosed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(Error('Owned auth fixture process close budget expired')),
            3000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    app = await electron.launch({
      cwd: directory,
      args: [
        '--require',
        observer,
        path.join(directory, 'entry.cjs'),
        `--user-data-dir=${profile}`,
        '--disable-gpu',
        '--use-mock-keychain',
      ],
      env,
    });
    const child = app.process();
    diagnostics = nativeDiagnostics(child);
    app.on('window', (page) =>
      page.on('dialog', (dialog) => {
        dialog.accept().catch(() => {});
      }),
    );
    processClosed = new Promise((resolve) =>
      child.once('close', () => resolve()),
    );
    const startup = await waitForStartupFacts(child, facts);
    await assertStartupFacts(child, startup, profile);
    let closed = false;
    let nextTask = 0;
    return {
      app,
      diagnostics: diagnostics.snapshot,
      async evaluate<T, A = undefined>(
        task: (electron: typeof import('electron'), arg: A) => T | Promise<T>,
        arg?: A,
      ): Promise<T> {
        const id = ++nextTask;
        const target = path.join(directory, 'task.json');
        await writeFile(
          target + '.tmp',
          JSON.stringify({ id, source: task.toString(), arg }),
        );
        await rename(target + '.tmp', target);
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          try {
            const packet = JSON.parse(
              await readFile(path.join(directory, 'result.json'), 'utf8'),
            );
            if (packet.id === id) {
              if (!packet.ok) {
                const facts = safeStructuredError(packet.error);
                diagnostics?.task(facts);
                const error = new Error(
                  `Native fixture task failed (${facts?.name ?? 'Other'})`,
                );
                Object.defineProperty(error, 'nativeTaskError', {
                  value: facts,
                });
                throw error;
              }
              return packet.result as T;
            }
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'ENOENT'
            )
              throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Native fixture task budget expired');
      },
      async trace() {
        try {
          return await readFile(path.join(directory, 'trace.log'), 'utf8');
        } catch {
          return '';
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        const errors: PhaseError[] = [];
        const retain = (phase: string, error: unknown) => {
          errors.push({ phase, error });
          diagnostics?.error(phase, error);
        };
        try {
          try {
            if (child.exitCode === null && child.signalCode === null) {
              try {
                await terminateStartupProcess(child);
              } catch (error) {
                retain('terminate', error);
                if (child.exitCode === null && child.signalCode === null) {
                  let pid: number;
                  try {
                    pid = await nativeStartupPid(child);
                  } catch (error) {
                    retain('fallback-query', error);
                    throw error;
                  }
                  try {
                    const exited = once(child, 'exit', {
                      signal: AbortSignal.timeout(1000),
                    });
                    process.kill(pid, 'SIGKILL');
                    await exited;
                  } catch (error) {
                    retain('fallback-signal-wait', error);
                    throw error;
                  }
                }
              }
            }
          } finally {
            try {
              await waitForProcessClose();
            } catch (error) {
              retain('close-wait', error);
              throw error;
            }
            try {
              await rm(directory, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 100,
              });
            } catch (error) {
              retain('remove', error);
              throw error;
            }
          }
        } catch {
          throw phaseFailure(errors, 'Owned auth fixture cleanup failed');
        } finally {
          diagnostics?.stop();
        }
      },
    };
  } catch (error) {
    const errors: PhaseError[] = [{ phase: 'startup', error }];
    diagnostics ??= nativeDiagnostics();
    diagnostics?.error('startup', error);
    let cleanupCompleted = false;
    try {
      if (
        app &&
        app.process().exitCode === null &&
        app.process().signalCode === null
      ) {
        try {
          await terminateStartupProcess(app.process());
        } catch (cleanupError) {
          errors.push({ phase: 'startup-terminate', error: cleanupError });
          diagnostics?.error('startup-terminate', cleanupError);
          throw cleanupError;
        }
      }
      try {
        await waitForProcessClose();
      } catch (cleanupError) {
        errors.push({ phase: 'close-wait', error: cleanupError });
        diagnostics?.error('close-wait', cleanupError);
        throw cleanupError;
      }
      try {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
        cleanupCompleted = true;
      } catch (cleanupError) {
        errors.push({ phase: 'remove', error: cleanupError });
        diagnostics?.error('remove', cleanupError);
        throw cleanupError;
      }
    } catch {
      // Preserve the original startup value and the cleanup actually attempted.
    } finally {
      diagnostics?.stop();
    }
    try {
      const packet = {
        schema: 1,
        body: 'not-started',
        cleanup: cleanupCompleted ? 'passed' : 'failed',
        fixture: diagnostics?.snapshot(),
      };
      const json = JSON.stringify(packet);
      if (Buffer.byteLength(json) <= 4096) console.log(json);
    } catch {
      // Startup diagnostics must never replace original startup/cleanup errors.
    }
    const failure = phaseFailure(
      errors,
      'Owned auth fixture startup and cleanup failed',
    );
    try {
      if (failure instanceof Error) {
        Object.defineProperty(failure, 'nativeDiagnostics', {
          value: diagnostics?.snapshot(),
        });
      }
    } catch {}
    throw failure;
  }
}
