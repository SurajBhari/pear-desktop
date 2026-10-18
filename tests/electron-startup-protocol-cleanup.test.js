import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

import { test } from '@playwright/test';

const source = readFileSync(
  new URL('./electron-startup-protocol-isolation.test.ts', import.meta.url),
  'utf8',
);
const helper = readFileSync(
  new URL('./helpers/electron-startup.js', import.meta.url),
  'utf8',
);
const helperStart = helper.indexOf('export async function runNativePidQuery(');
const helperEnd = helper.indexOf('export async function waitForStartupFacts(');
assert(helperStart >= 0 && helperEnd > helperStart);
const helperSource = helper
  .slice(helperStart, helperEnd)
  .replaceAll('export async function', 'async function');
const testStart = source.indexOf(
  "test('startup observer sinks native protocol registration",
);
const testEnd = source.indexOf('\ntype LoginIsolationProof', testStart);
assert(testStart >= 0 && testEnd > testStart);
const wiringSource = stripTypeScriptTypes(source.slice(testStart, testEnd));
const ownedStart = source.indexOf('// BEGIN OWNED PROTOCOL CLEANUP');
const ownedEnd = source.indexOf('// END OWNED PROTOCOL CLEANUP', ownedStart);
const ownedSource =
  ownedStart >= 0 && ownedEnd > ownedStart
    ? stripTypeScriptTypes(source.slice(ownedStart, ownedEnd))
    : '';
const blocked = () =>
  assert.fail(
    'Pure cleanup controls cannot import native modules or use real I/O',
  );
const flush = async () => {
  for (let n = 0; n < 40; n++) await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const observed = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
function clock() {
  let now = 0,
    serial = 0;
  const timers = new Map();
  return {
    timers,
    now: () => now,
    setNow(value) {
      now = value;
    },
    setTimeout(fn, delay) {
      const id = ++serial;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async tick(delay) {
      const end = now + delay;
      for (let n = 0; n < 1000; n++) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
function errors(error) {
  return error instanceof AggregateError
    ? error.errors.flatMap(errors)
    : [error];
}

function harness() {
  const child = new EventEmitter(),
    time = clock(),
    trace = [];
  child.pid = 4100;
  child.exitCode = null;
  child.signalCode = null;
  const h = {
    child,
    time,
    trace,
    closeHook: undefined,
    queryHook: undefined,
    killHook: undefined,
    records: undefined,
    bodyError: undefined,
    launchError: undefined,
    removeError: undefined,
    removals: 0,
    closeCalls: 0,
  };
  h.exit = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  const executable = 'C:\\owned\\electron.exe';
  const executeFile = (command, args, options) => {
    trace.push({ command, args });
    const d = deferred(),
      queryChild = new EventEmitter();
    queryChild.exitCode = 0;
    queryChild.signalCode = null;
    d.promise.child = queryChild;
    if (command === 'powershell.exe') {
      assert(args.at(-1).includes('ParentProcessId = 4100'));
      if (h.queryHook) h.queryHook(d, options);
      else
        d.resolve({
          stdout: JSON.stringify(
            h.records ?? [{ ProcessId: 5200, ExecutablePath: executable }],
          ),
        });
    } else if (command === 'taskkill.exe') {
      assert.deepEqual(args, ['/pid', '5200', '/T', '/F']);
      if (h.killHook) h.killHook(d);
      else {
        h.exit();
        d.resolve({ stdout: '' });
      }
    } else blocked();
    return d.promise;
  };
  const native = vm.runInThisContext(
    '(function(assert,executeFile,once,realpath,require,process,performance,AbortSignal){' +
      helperSource +
      '\nreturn {terminateStartupProcess};})',
  )(
    assert,
    executeFile,
    once,
    async (value) => value,
    (name) => {
      assert.equal(name, 'electron');
      return executable;
    },
    {
      platform: 'win32',
      kill(pid, signal) {
        trace.push({ probe: pid, signal });
        assert.equal(pid, 5200);
        assert.equal(signal, 0);
      },
    },
    { now: time.now },
    { timeout: () => new AbortController().signal },
  );
  h.application = {
    process: () => child,
    firstWindow: async () => {},
    evaluate: async () => ({
      delegated: [],
      observerBeforeReady: true,
      calls: [
        {
          phase: 'before-entry',
          entryStarted: false,
          ready: false,
          set: true,
          remove: true,
        },
        {
          phase: 'entry',
          entryStarted: true,
          ready: false,
          set: true,
          remove: true,
        },
        {
          phase: 'ready',
          entryStarted: true,
          ready: true,
          set: true,
          remove: true,
        },
      ],
    }),
    close() {
      h.closeCalls++;
      trace.push({ close: true, listeners: child.listenerCount('exit') });
      return h.closeHook ? h.closeHook() : Promise.resolve();
    },
  };
  let callback;
  const register = (_name, fn) => {
    callback = fn;
  };
  register.setTimeout = (budget) => {
    h.testBudget = budget;
  };
  const context = {
    Error,
    AggregateError,
    Promise,
    performance: { now: time.now },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    terminateStartupProcess: native.terminateStartupProcess,
    rm: async (directory, options) => {
      h.removals++;
      assert.equal(directory, '/owned/protocol');
      assert.equal(
        JSON.stringify(options),
        '{"recursive":true,"force":true,"maxRetries":5}',
      );
      if (h.removeError) throw h.removeError;
    },
    test: register,
    mkdtemp: async () => '/owned/protocol',
    tmpdir: () => '/owned',
    mkdir: async () => {},
    writeFile: async () => {},
    path: { join: (...parts) => parts.join('/') },
    observer: '/owned/observer.cjs',
    process: { env: { ELECTRON_RUN_AS_NODE: '1' } },
    electron: {
      launch: async () => {
        if (h.launchError) throw h.launchError;
        return h.application;
      },
    },
    assertStartupFacts: async () => {
      if (h.bodyError) throw h.bodyError;
    },
    waitForStartupFacts: async () => ({}),
    refreshStartupFacts: async () => ({}),
    console: { log() {} },
    expect: (value) => ({
      toBe: (expected) => assert.equal(value, expected),
      toEqual: (expected) =>
        assert.equal(JSON.stringify(value), JSON.stringify(expected)),
    }),
  };
  const api = vm.runInNewContext(
    ownedSource +
      '\n' +
      wiringSource +
      '\n({ close: typeof closeOwnedProtocolFixture === "function" ? closeOwnedProtocolFixture : undefined });',
    context,
  );
  h.run = () => observed(callback());
  h.phase = () => {
    assert.equal(
      typeof api.close,
      'function',
      'Missing actual fixture cleanup phase',
    );
    return observed(api.close(h.application));
  };
  h.clean = () => {
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(time.timers.size, 0);
  };
  h.noQuery = () =>
    assert(!trace.some((event) => event.command || 'probe' in event));
  h.noKill = () =>
    assert(
      !trace.some(
        (event) => event.command === 'taskkill.exe' || 'probe' in event,
      ),
    );
  return h;
}

test('actual protocol parent waits close-return/launcher-exit lag without starting an owner query', async () => {
  const h = harness();
  h.queryHook = (query) => {
    query.resolve({ stdout: '[]' });
    h.exit();
  };
  h.closeHook = () => {
    h.time.setTimeout(() => h.exit(), 20);
    return Promise.resolve();
  };
  const result = h.run();
  await flush();
  assert.equal(h.closeCalls, 1);
  h.noQuery();
  await h.time.tick(20);
  assert.equal((await result).error, undefined);
  h.noQuery();
  assert.equal(h.testBudget, 25000);
  assert.equal(h.removals, 1);
  h.clean();
});
test('actual protocol parent retains both a primary body failure and strict fallback failure', async () => {
  const h = harness(),
    body = Error('primary body assertion');
  h.bodyError = body;
  h.closeHook = () => Promise.reject(Error('cooperative close failed'));
  h.queryHook = (query) => {
    query.resolve({ stdout: '[]' });
    h.exit();
  };
  const result = await h.run();
  assert(errors(result.error).includes(body));
  assert(
    errors(result.error).some((error) =>
      /Electron exited/.test(error?.message),
    ),
  );
  assert.equal(result.error.cause, body);
  assert.equal(h.removals, 1);
  h.noKill();
  h.clean();
});
test('actual close phase is armed before synchronous close exit', async () => {
  const h = harness();
  h.closeHook = () => {
    assert.equal(h.child.listenerCount('exit'), 1);
    h.exit();
    return Promise.resolve();
  };
  assert.equal((await h.phase()).error, undefined);
  h.noQuery();
  h.clean();
});
test('asynchronous close and exit must both finish within the one phase', async () => {
  const h = harness(),
    close = deferred();
  h.closeHook = () => close.promise;
  let done = false;
  const result = h.phase().then((value) => {
    done = true;
    return value;
  });
  await flush();
  h.exit();
  await flush();
  assert.equal(done, false);
  await h.time.tick(4999);
  close.resolve();
  await flush();
  assert.equal((await result).error, undefined);
  h.noQuery();
  h.clean();
});
test('close rejection despite owned exit retains the exact close error and never falls back', async () => {
  for (const sync of [false, true]) {
    const h = harness(),
      failure = Error('close refused');
    h.closeHook = () => {
      h.exit();
      if (sync) throw failure;
      return Promise.reject(failure);
    };
    assert.equal((await h.phase()).error, failure);
    h.noQuery();
    h.clean();
  }
});
test('close success alone times out at five seconds and strict fallback cannot erase timeout', async () => {
  const h = harness(),
    result = h.phase();
  await flush();
  await h.time.tick(4999);
  h.noQuery();
  await h.time.tick(1);
  assert.match((await result).error.message, /timed out/);
  assert.equal(
    h.trace.filter((event) => event.command === 'taskkill.exe').length,
    1,
  );
  h.clean();
});
test('exit alone with incomplete close remains timeout and late rejection stays handled', async () => {
  const h = harness(),
    close = deferred();
  h.closeHook = () => {
    h.exit();
    return close.promise;
  };
  const result = h.phase();
  await flush();
  await h.time.tick(5000);
  assert.match((await result).error.message, /timed out/);
  close.reject(Error('late close rejection'));
  await new Promise(setImmediate);
  h.noQuery();
  h.clean();
});
test('the monotonic deadline rejects exact 5000 and late completion even before timer callback', async () => {
  for (const at of [4999, 5000, 5001]) {
    const h = harness();
    h.closeHook = () => {
      h.time.setNow(at);
      h.exit();
      return Promise.resolve();
    };
    const result = await h.phase();
    if (at < 5000) assert.equal(result.error, undefined);
    else assert.match(result.error.message, /timed out/);
    h.noQuery();
    h.clean();
  }
});
test('strict fallback only targets its independently verified native PID and retains close failure', async () => {
  const h = harness(),
    failure = Error('close failed while live');
  h.closeHook = () => Promise.reject(failure);
  assert.equal((await h.phase()).error, failure);
  assert.equal(
    h.trace.find((event) => event.command === 'taskkill.exe').args[1],
    '5200',
  );
  assert.notEqual(h.child.pid, 5200);
  h.clean();
});
test('owner query failures remain cleanup diagnostics and never reach target signals', async () => {
  const h = harness(),
    closeError = Error('close failed'),
    queryError = Object.assign(Error('query denied'), { code: 'EACCES' });
  h.closeHook = () => Promise.reject(closeError);
  h.queryHook = (query) => query.reject(queryError);
  const result = await h.phase(),
    failures = errors(result.error);
  assert.equal(failures[0], closeError);
  assert(failures.some((error) => error?.cause === queryError));
  h.noKill();
  h.clean();
});
test('foreign missing and ambiguous native selections remain failures without target signals', async () => {
  for (const records of [
    [],
    [{ ProcessId: 5200, ExecutablePath: 'C:\\foreign\\electron.exe' }],
    [
      { ProcessId: 5200, ExecutablePath: 'C:\\owned\\electron.exe' },
      { ProcessId: 5300, ExecutablePath: 'C:\\owned\\electron.exe' },
    ],
  ]) {
    const h = harness(),
      failure = Error('close failed');
    h.records = records;
    h.closeHook = () => Promise.reject(failure);
    const result = await h.phase();
    assert.equal(errors(result.error)[0], failure);
    assert(
      errors(result.error).some((error) =>
        /exactly one owned/.test(error?.message),
      ),
    );
    h.noKill();
    h.clean();
  }
});
test('launcher capability lost during fallback preserves post-query validation diagnostics', async () => {
  const h = harness(),
    failure = Error('close failed');
  h.closeHook = () => Promise.reject(failure);
  h.queryHook = (query) => {
    query.resolve({ stdout: '[]' });
    h.exit();
  };
  const result = await h.phase(),
    failures = errors(result.error);
  assert.equal(failures[0], failure);
  assert(
    failures.some((error) =>
      error?.diagnosticErrors?.some(
        (entry) => entry.phase === 'launcher-validation',
      ),
    ),
  );
  h.noKill();
  h.clean();
});
test('qualified native kill failure remains a failure alongside close error', async () => {
  const h = harness(),
    closeError = Error('close failed'),
    killError = Error('kill failed');
  h.closeHook = () => Promise.reject(closeError);
  h.killHook = (kill) => {
    h.exit();
    kill.reject(killError);
  };
  const result = await h.phase();
  assert.deepEqual(errors(result.error), [closeError, killError]);
  h.clean();
});
test('already exited launcher is not treated as proven cooperative close or native absence', async () => {
  const h = harness();
  h.exit();
  assert((await h.phase()).error);
  h.noQuery();
  h.clean();
});
test('primary body failure is thrown unchanged after successful cooperative cleanup', async () => {
  const h = harness(),
    failure = Error('primary proof assertion');
  h.bodyError = failure;
  h.closeHook = () => {
    h.exit();
    return Promise.resolve();
  };
  assert.equal((await h.run()).error, failure);
  assert.equal(h.removals, 1);
  h.noQuery();
  h.clean();
});
test('actual parent always attempts owned removal and retains body close and removal failures', async () => {
  for (const mode of [
    'success',
    'body',
    'close',
    'timeout',
    'launch',
    'remove',
    'all',
  ]) {
    const h = harness(),
      body = Error('body failed'),
      close = Error('close failed'),
      remove = Error('remove failed');
    if (mode === 'body' || mode === 'all') h.bodyError = body;
    if (mode === 'launch') h.launchError = body;
    if (mode === 'remove' || mode === 'all') h.removeError = remove;
    h.closeHook = () => {
      if (mode === 'timeout') return new Promise(() => {});
      h.exit();
      if (mode === 'close' || mode === 'all') return Promise.reject(close);
      return Promise.resolve();
    };
    const result = h.run();
    await flush();
    if (mode === 'timeout') await h.time.tick(5000);
    const outcome = await result;
    assert.equal(h.removals, 1);
    if (mode === 'success') assert.equal(outcome.error, undefined);
    else assert(outcome.error);
    if (mode === 'all') {
      assert.deepEqual(errors(outcome.error), [body, close, remove]);
      assert.equal(outcome.error.cause, body);
    }
    h.clean();
  }
});
