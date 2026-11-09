// Pure source controls only. Imports below are Node built-ins; every application
// filesystem, process, query, timer and event dependency is injected into a VM.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
// Synthetic fixture paths and Map keys use POSIX on every host. Source-file
// reads above/below keep the real host's resolve; no actual path is emulated.
const path = require('node:path').posix;
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');

const root = resolve(__dirname, '../..');
const fixtureSource = readFileSync(
  resolve(__dirname, 'scrobbler-auth-native.ts'),
  'utf8',
);
const querySource = readFileSync(
  resolve(__dirname, 'electron-startup.js'),
  'utf8',
);
const testSource = readFileSync(
  resolve(root, 'tests/scrobbler-auth-window-native.test.ts'),
  'utf8',
);
const forbidden =
  'https://private.invalid/?token=SECRET Authorization: Bearer SECRET';
function between(source, start, end) {
  assert.equal(source.split(start).length, 2, `unique start: ${start}`);
  assert.equal(source.split(end).length, 2, `unique end: ${end}`);
  return source.slice(source.indexOf(start), source.indexOf(end));
}
function child() {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
    pid: 123,
  });
}
async function failure(task) {
  try {
    await task();
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
}
function phases(error) {
  return error.diagnosticErrors.map((item) => item.phase);
}
function values(error) {
  return error.diagnosticErrors.map((item) => item.error);
}
function safe(packet) {
  const json = JSON.stringify(packet);
  assert.ok(Buffer.byteLength(json) <= 4096);
  assert.ok(!json.includes('SECRET'));
  assert.ok(!json.includes('private.invalid'));
  assert.ok(!json.includes('PRIMARY_BODY_ERROR'));
  return json;
}
function queryHarness({
  reject,
  result = { stdout: '[]', stderr: '' },
  die = false,
  waitError,
  postSuccess = false,
} = {}) {
  const launcher = child(),
    queryChild = child(),
    calls = [],
    waits = [],
    assertions = [];
  const code = between(
    querySource,
    'export async function runNativePidQuery(',
    '/** @typedef',
  );
  let execution;
  const context = vm.createContext({
    Error,
    AggregateError,
    performance: { now: () => 100 },
    AbortController,
    AbortSignal: {
      timeout: (ms) => {
        waits.push(ms);
        return {};
      },
    },
    assertRunning(value) {
      if (value.exitCode !== null || value.signalCode !== null) {
        const error = new assert.AssertionError({
          message: `Electron exited before startup validation (code ${value.exitCode}, signal ${value.signalCode})`,
        });
        assertions.push(error);
        throw error;
      }
    },
    executeFile(command, args, options) {
      calls.push({ command, args, options });
      execution = Promise.resolve().then(() => {
        if (die) {
          launcher.exitCode = 23;
          launcher.emit('exit', 23, null);
        }
        if (reject !== undefined) throw reject;
        if (postSuccess) launcher.exitCode = 23;
        return result;
      });
      execution.child = queryChild;
      return execution;
    },
    once: async (value, event, options) => {
      assert.equal(value, queryChild);
      assert.equal(event, 'exit');
      assert.ok(options.signal);
      if (waitError) throw waitError;
    },
  });
  vm.runInContext(
    code.replace('export ', '') + '\nthis.run = runNativePidQuery;',
    context,
  );
  return {
    launcher,
    calls,
    waits,
    assertions,
    run: () =>
      context.run('powershell.exe', ['-NoProfile', 'owned-query'], 10000, {
        launcher,
      }),
  };
}
function fixtureHarness(options = {}) {
  const launched = child(),
    writes = new Map(),
    operations = [],
    timers = [],
    timeouts = [],
    packets = [];
  const source = stripTypeScriptTypes(fixtureSource, { mode: 'transform' })
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '')
    .replaceAll('import.meta.dirname', JSON.stringify(__dirname))
    .replace('export async function', 'async function');
  let clock = 0;
  const cooperativeError = Error('MOCK_COOPERATIVE_WRITE_ERROR');
  let cooperativePacket;
  const cooperativeWrite = (name, value) => {
    if (!name.endsWith('/task.json.tmp')) return false;
    const packet = JSON.parse(value);
    if (!packet.source.includes('app.exit(0)')) return false;
    operations.push(['cooperative-write']);
    if (!options.cooperative || options.cooperative === 'write-error')
      throw cooperativeError;
    cooperativePacket = packet;
    writes.set(name, value);
    options.afterCooperativeWrite?.();
    return true;
  };
  const cooperativeRename = (from, to) => {
    if (!cooperativePacket || !from.endsWith('/task.json.tmp')) return false;
    operations.push(['cooperative-publish']);
    assert.equal(to, '/FAKE/owned/task.json');
    if (options.cooperative !== 'no-close') {
      const code = options.cooperative === 'nonzero' ? 1 : 0;
      const signal = options.cooperative === 'signal' ? 'SIGTERM' : null;
      launched.exitCode = signal ? null : code;
      launched.signalCode = signal;
      operations.push(['cooperative-physical-close', code, signal]);
      launched.emit('exit', code, signal);
      launched.emit('close', code, signal);
    }
    options.afterCooperativePublish?.();
    return true;
  };
  const cooperativeRead = (name) => {
    if (!cooperativePacket || !name.endsWith('/result.json')) return undefined;
    operations.push(['cooperative-reply']);
    if (options.cooperative === 'no-ack')
      throw Object.assign(Error('MOCK_NO_ACK'), { code: 'ENOENT' });
    if (options.rawCooperativeReply !== undefined)
      return options.rawCooperativeReply;
    const reply = JSON.stringify({
      id:
        options.cooperative === 'wrong-id'
          ? cooperativePacket.id + 1
          : cooperativePacket.id,
      ok: options.cooperative === 'not-ok' ? false : true,
      result: options.cooperative === 'false-result' ? false : true,
    });
    options.afterCooperativeRead?.();
    return reply;
  };
  let openedReply;
  const context = vm.createContext({
    Buffer,
    Error,
    AggregateError,
    Object,
    JSON,
    Map,
    Set,
    Number,
    String,
    performance: { now: () => ++clock },
    path,
    tmpdir: () => '/FAKE',
    createHash: (algorithm) => {
      if (algorithm !== 'sha256') assert.fail('unexpected hash');
      return {
        data: undefined,
        update(value) {
          this.data = value;
          return this;
        },
        digest() {
          return this.data === 'OBSERVER'
            ? '8581f0b3171f094830ba28970278585bcf34f7308538744c22c12fde0abf4f83'
            : createHash('sha256').update(this.data).digest('hex');
        },
      };
    },
    mkdtemp: async () => '/FAKE/owned',
    mkdir: async () => {},
    existsSync: () => true,
    build: async () => {},
    writeFile: async (name, value) => {
      if (cooperativeWrite(name, value)) return;
      writes.set(name, value);
    },
    rename: async (from, to) => {
      cooperativeRename(from, to);
    },
    writeFileSync: (name, value) => {
      assert.equal(cooperativeWrite(name, value), true);
    },
    renameSync: (from, to) => {
      assert.equal(cooperativeRename(from, to), true);
    },
    openSync: (name, mode) => {
      assert.equal(mode, 'r');
      openedReply = cooperativeRead(name);
      assert.notEqual(openedReply, undefined);
      return 17;
    },
    fstatSync: (fd) => {
      assert.equal(fd, 17);
      if (options.statError) throw options.statError;
      return { size: Buffer.byteLength(openedReply) };
    },
    readSync: (fd, target, offset, length, position) => {
      assert.equal(fd, 17);
      assert.equal(offset, 0);
      assert.equal(position, 0);
      if (options.readError) throw options.readError;
      const bytes = Buffer.from(openedReply);
      assert.equal(length, bytes.length);
      bytes.copy(target);
      return options.shortReplyRead ? length - 1 : length;
    },
    closeSync: (fd) => {
      assert.equal(fd, 17);
      operations.push(['cooperative-reply-handle-close']);
      if (options.descriptorCloseError) throw options.descriptorCloseError;
    },
    readFile: async (name) => {
      const reply = cooperativeRead(name);
      if (reply !== undefined) return reply;
      if (name.endsWith('electron-startup-observer.cjs')) return 'OBSERVER';
      if (name.endsWith('trace.log')) return 'existing trace';
      if (name.endsWith('result.json'))
        return JSON.stringify({
          id: 1,
          ok: false,
          error: {
            phase: 'task',
            name: 'TypeError',
            code: 'EACCES',
            site: [{ line: 1, column: 22 }],
          },
        });
      assert.fail(`unexpected fake read ${name}`);
    },
    rm: async (name, settings) => {
      operations.push(['rm', name, settings]);
      if (options.rmError) throw options.rmError;
    },
    process: {
      env: {},
      kill: (pid, signal) => {
        operations.push(['kill', pid, signal]);
        if (options.killError) throw options.killError;
      },
    },
    AbortSignal: {
      timeout: (ms) => {
        timeouts.push(ms);
        return {};
      },
    },
    once: async (value, event) => {
      assert.equal(value, launched);
      assert.equal(event, 'exit');
      operations.push(['exit-wait']);
      if (options.exitWaitError) throw options.exitWaitError;
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (id) => {
      operations.push(['clearTimer', id]);
    },
    console: { log: (packet) => packets.push(packet) },
    electron: {
      launch: async () => {
        if (options.launchError) throw options.launchError;
        if (options.beforeLaunchReturn) options.beforeLaunchReturn(launched);
        return { process: () => launched, on: () => {} };
      },
    },
    waitForStartupFacts: async () => {
      if (options.startupError) throw options.startupError;
      return {};
    },
    assertStartupFacts: async () => {},
    terminateStartupProcess: async () => {
      operations.push(['terminate']);
      if (options.terminateError) throw options.terminateError;
      launched.exitCode = 0;
      launched.emit('close', 0, null);
    },
    nativeStartupPid: async () => {
      operations.push(['query']);
      if (options.pidError) throw options.pidError;
      if (!options.noClose) {
        launched.exitCode = 0;
        launched.emit('close', 0, null);
      }
      return 456;
    },
  });
  vm.runInContext(source + '\nthis.create = scrobblerAuthNative;', context);
  return {
    launched,
    operations,
    timers,
    timeouts,
    writes,
    cooperativeError,
    advance: (ms) => {
      clock += ms;
    },
    packets,
    context,
    create: () => context.create(),
  };
}
function hostHarness({
  bodyError,
  throwBody = true,
  cleanupError,
  traceError,
  attachError,
} = {}) {
  // Exact first-test boundary; later tests/hooks are deliberately never evaluated.
  const source = between(
    testSource,
    "test('native auth windows use distinct",
    'for (const retire of',
  );
  let callback;
  const emitted = [],
    attached = [],
    order = [];
  const context = vm.createContext({
    Error,
    AggregateError,
    Buffer,
    test: (_name, fn) => {
      callback = fn;
    },
    scrobblerAuthNative: async () => ({
      evaluate: async () => ({}),
      trace: async () => {
        order.push('trace');
        if (traceError) throw traceError;
        return 'existing trace';
      },
      close: async () => {
        order.push('close');
        if (cleanupError) throw cleanupError;
      },
      diagnostics: () => ({ captureStopped: true, nativeAbsence: 'UNKNOWN' }),
    }),
    console: { log: (value) => emitted.push(value) },
    expect: () => ({
      toMatchObject: () => {
        if (throwBody) throw bodyError;
      },
    }),
  });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }), context);
  return {
    emitted,
    attached,
    order,
    run: () =>
      callback(
        {},
        {
          attach: async (name, settings) => {
            attached.push({ name, settings });
            if (attachError) throw attachError;
          },
        },
      ),
  };
}

test('host retains original body and cleanup values with stable phase labels', async () => {
  const bodyError = Error('PRIMARY_BODY_ERROR'),
    cleanupError = Error('CLEANUP_ERROR');
  const h = hostHarness({ bodyError, cleanupError });
  const error = await failure(h.run);
  assert.deepEqual([...error.errors], [bodyError, cleanupError]);
  assert.deepEqual(
    [...error.diagnosticErrors].map((item) => item.phase),
    ['body', 'cleanup'],
  );
  assert.deepEqual(h.order, ['trace', 'close']);
  assert.equal(h.attached.length, 1);
  safe(JSON.parse(h.attached[0].settings.body.toString()));
  safe(JSON.parse(h.emitted.at(-1)));
});
test('host preserves thrown undefined and original body when close succeeds', async () => {
  const h = hostHarness({ bodyError: undefined });
  assert.equal(await failure(h.run), undefined);
});
test('host body-pass cleanup-fail stays failure despite diagnostic emission failure', async () => {
  const cleanupError = Error('CLEANUP_ERROR');
  const h = hostHarness({
    throwBody: false,
    cleanupError,
    attachError: Error('ATTACH_ERROR'),
  });
  assert.equal(await failure(h.run), cleanupError);
});
test('cooperative shutdown publishes owned RPC, observes physical close and strict ack before removal', async () => {
  const h = fixtureHarness({ cooperative: 'success' });
  const f = await h.create();
  await f.close();
  const operations = h.operations.map((item) => item[0]);
  assert.ok(operations.includes('cooperative-write'));
  assert.ok(operations.includes('cooperative-publish'));
  assert.ok(operations.includes('cooperative-physical-close'));
  assert.ok(operations.includes('cooperative-reply'));
  assert.ok(
    operations.indexOf('cooperative-physical-close') <
      operations.indexOf('cooperative-reply'),
  );
  assert.ok(operations.indexOf('cooperative-reply') < operations.indexOf('rm'));
  assert.ok(
    !operations.some((name) => ['terminate', 'query', 'kill'].includes(name)),
  );
  assert.equal(
    f
      .diagnostics()
      .events.filter((event) => event.phase === 'cooperative-close').length,
    1,
  );
  assert.equal(f.diagnostics().nativeAbsence, 'UNKNOWN');
  assert.equal(f.diagnostics().captureStopped, true);
  safe(f.diagnostics());
});
for (const cooperative of [
  'wrong-id',
  'not-ok',
  'false-result',
  'nonzero',
  'signal',
  'no-ack',
]) {
  test(`cooperative ${cooperative} cannot claim success or signal an already closed launcher`, async () => {
    const h = fixtureHarness({ cooperative });
    const f = await h.create();
    const error = await failure(() => f.close());
    assert.ok(phases(error).includes('cooperative-shutdown'));
    assert.ok(
      !h.operations.some((item) =>
        ['terminate', 'query', 'kill'].includes(item[0]),
      ),
    );
    assert.ok(
      !f
        .diagnostics()
        .events.some((event) => event.phase === 'cooperative-close'),
    );
    assert.equal(h.operations.filter((item) => item[0] === 'rm').length, 1);
    safe(f.diagnostics());
  });
}
test('failed cooperative publish keeps strict forced fallback and cannot emit cooperative success', async () => {
  const h = fixtureHarness({ cooperative: 'write-error' });
  const f = await h.create();
  await f.close();
  assert.equal(
    h.operations.filter((item) => item[0] === 'terminate').length,
    1,
  );
  assert.ok(
    f
      .diagnostics()
      .events.some((event) => event.phase === 'cooperative-shutdown'),
  );
  assert.ok(
    !f
      .diagnostics()
      .events.some((event) => event.phase === 'cooperative-close'),
  );
  safe(f.diagnostics());
});
test('cooperative publication consumes the one deadline before the close wait', async () => {
  const h = fixtureHarness({
    cooperative: 'no-close',
    afterCooperativeWrite: () => h.advance(2500),
  });
  const f = await h.create();
  const pending = f.close();
  for (let i = 0; i < 20 && !h.timers.length; i++) await Promise.resolve();
  assert.ok(h.timers[0].ms > 0 && h.timers[0].ms <= 500);
  h.timers[0].fn();
  await pending;
  assert.equal(
    h.operations.filter((item) => item[0] === 'terminate').length,
    1,
  );
  assert.ok(!h.operations.some((item) => item[0] === 'cooperative-reply'));
  assert.ok(
    !f
      .diagnostics()
      .events.some((event) => event.phase === 'cooperative-close'),
  );
  assert.equal(h.timeouts.length, 0);
});
test('expired synchronous publication never renames a late shutdown request', async () => {
  const h = fixtureHarness({
    cooperative: 'success',
    afterCooperativeWrite: () => h.advance(3001),
  });
  const f = await h.create();
  await f.close();
  assert.ok(!h.operations.some((item) => item[0] === 'cooperative-publish'));
  assert.equal(
    h.operations.filter((item) => item[0] === 'terminate').length,
    1,
  );
  assert.ok(
    !f
      .diagnostics()
      .events.some((event) => event.phase === 'cooperative-close'),
  );
});
test('expired reply validation cannot qualify already observed zero-code close', async () => {
  const h = fixtureHarness({
    cooperative: 'success',
    afterCooperativeRead: () => h.advance(3001),
  });
  const f = await h.create();
  const error = await failure(() => f.close());
  assert.deepEqual([...phases(error)], ['cooperative-shutdown']);
  assert.ok(!h.operations.some((item) => item[0] === 'terminate'));
  assert.ok(
    !f
      .diagnostics()
      .events.some((event) => event.phase === 'cooperative-close'),
  );
  assert.equal(
    h.operations.filter((item) => item[0] === 'cooperative-reply-handle-close')
      .length,
    1,
  );
});
for (const rawCooperativeReply of [
  'null',
  '{broken',
  JSON.stringify({ id: '1', ok: true, result: true }),
  JSON.stringify({ id: 1, ok: 1, result: true }),
  JSON.stringify({ id: 1, ok: true, result: 1 }),
  'X'.repeat(4097) + forbidden,
]) {
  test(`bounded cooperative reply rejects ${rawCooperativeReply.length > 4096 ? 'oversized private payload' : rawCooperativeReply}`, async () => {
    const h = fixtureHarness({ cooperative: 'success', rawCooperativeReply });
    const f = await h.create();
    const error = await failure(() => f.close());
    assert.ok(error);
    assert.equal(
      f
        .diagnostics()
        .events.filter((event) => event.phase === 'cooperative-shutdown')
        .length,
      1,
    );
    assert.ok(
      !f
        .diagnostics()
        .events.some((event) => event.phase === 'cooperative-close'),
    );
    assert.equal(
      h.operations.filter(
        (item) => item[0] === 'cooperative-reply-handle-close',
      ).length,
      1,
    );
    safe(f.diagnostics());
  });
}
test('short bounded reply read fails and closes its owned descriptor', async () => {
  const h = fixtureHarness({ cooperative: 'success', shortReplyRead: true });
  const f = await h.create();
  await failure(() => f.close());
  assert.equal(
    h.operations.filter((item) => item[0] === 'cooperative-reply-handle-close')
      .length,
    1,
  );
  assert.ok(
    !f
      .diagnostics()
      .events.some((event) => event.phase === 'cooperative-close'),
  );
});
for (const operation of ['statError', 'readError']) {
  test(`cooperative ${operation} and descriptor close failure retain both original errors in order`, async () => {
    const primary = Error('ORIGINAL_DESCRIPTOR_READ_ERROR');
    const secondary = Error('ORIGINAL_DESCRIPTOR_CLOSE_ERROR');
    const h = fixtureHarness({
      cooperative: 'success',
      [operation]: primary,
      descriptorCloseError: secondary,
    });
    const f = await h.create();
    const error = await failure(() => f.close());
    assert.deepEqual([...error.errors], [primary, secondary]);
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors[1], secondary);
    assert.equal(
      h.operations.filter(
        (item) => item[0] === 'cooperative-reply-handle-close',
      ).length,
      1,
    );
    assert.equal(h.operations.filter((item) => item[0] === 'rm').length, 1);
    assert.ok(
      !h.operations.some((item) =>
        ['terminate', 'query', 'kill'].includes(item[0]),
      ),
    );
    assert.ok(
      !f
        .diagnostics()
        .events.some((event) => event.phase === 'cooperative-close'),
    );
    safe(f.diagnostics());
  });
}
test('cooperative descriptor close-only failure retains the original close error', async () => {
  const original = Error('ORIGINAL_DESCRIPTOR_CLOSE_ERROR');
  const h = fixtureHarness({
    cooperative: 'success',
    descriptorCloseError: original,
  });
  const f = await h.create();
  assert.equal(await failure(() => f.close()), original);
  assert.equal(
    h.operations.filter((item) => item[0] === 'cooperative-reply-handle-close')
      .length,
    1,
  );
  assert.ok(
    !f
      .diagnostics()
      .events.some((event) => event.phase === 'cooperative-close'),
  );
});
test('successful cooperative descriptor release happens once before qualification and removal', async () => {
  const h = fixtureHarness({ cooperative: 'success' });
  const f = await h.create();
  await f.close();
  const operations = h.operations.map((item) => item[0]);
  assert.equal(
    operations.filter((name) => name === 'cooperative-reply-handle-close')
      .length,
    1,
  );
  assert.ok(
    operations.indexOf('cooperative-reply-handle-close') <
      operations.indexOf('rm'),
  );
  assert.equal(
    f
      .diagnostics()
      .events.filter((event) => event.phase === 'cooperative-close').length,
    1,
  );
});
test('cooperative close is idempotent and its receipt follows the physical close event', async () => {
  const h = fixtureHarness({ cooperative: 'success' });
  const f = await h.create();
  await f.close();
  await f.close();
  assert.equal(
    h.operations.filter((item) => item[0] === 'cooperative-write').length,
    1,
  );
  const events = f.diagnostics().events;
  const close = events.findIndex((event) => event.phase === 'close');
  const receipt = events.findIndex(
    (event) => event.phase === 'cooperative-close',
  );
  assert.ok(close >= 0 && receipt > close);
  assert.ok(events[receipt].at >= events[close].at);
  assert.deepEqual(Object.keys(events[receipt]).sort(), ['at', 'phase']);
});
test('cooperative request advances the existing task identity after a body RPC', async () => {
  const h = fixtureHarness({ cooperative: 'success' });
  const f = await h.create();
  await failure(() => f.evaluate(() => true));
  await f.close();
  const packet = JSON.parse(h.writes.get('/FAKE/owned/task.json.tmp'));
  assert.equal(packet.id, 2);
  assert.equal(
    f
      .diagnostics()
      .events.filter((event) => event.phase === 'cooperative-close').length,
    1,
  );
});
test('cooperative receipt does not recover removal failure', async () => {
  const original = Error('REMOVE');
  const h = fixtureHarness({ cooperative: 'success', rmError: original });
  const f = await h.create();
  assert.equal(await failure(() => f.close()), original);
  assert.equal(
    f
      .diagnostics()
      .events.filter((event) => event.phase === 'cooperative-close').length,
    1,
  );
});
test('existing generated handler publishes exact reply before scheduled exit', async () => {
  const h = fixtureHarness({ cooperative: 'success' });
  const fixture = await h.create();
  await fixture.close();
  const actualRequest = JSON.parse(h.writes.get('/FAKE/owned/task.json.tmp'));
  const line = fixtureSource
    .split('\n')
    .find((value) => value.startsWith('fs.watchFile(taskPath'));
  assert.ok(line);
  const calls = [],
    callbacks = [];
  let observe;
  const context = vm.createContext({
    taskPath: '/FAKE/task.json',
    owned: '/FAKE',
    lastTask: 0,
    path,
    setImmediate: (fn) => callbacks.push(fn),
    require: (name) => {
      assert.equal(name, 'electron');
      return { app: { exit: (code) => calls.push(['exit', code]) } };
    },
    fs: {
      watchFile: (_target, _options, fn) => {
        observe = fn;
      },
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          id: 17,
          source: actualRequest.source,
        }),
      writeFileSync: (_name, body) => calls.push(['reply', JSON.parse(body)]),
      renameSync: () => calls.push(['publish']),
    },
  });
  vm.runInContext(line, context);
  await observe();
  assert.deepEqual(calls, [
    ['reply', { id: 17, ok: true, result: true }],
    ['publish'],
  ]);
  assert.equal(callbacks.length, 1);
  callbacks[0]();
  assert.deepEqual(calls.at(-1), ['exit', 0]);
});
test('close preserves initial termination and fallback PID errors without signaling', async () => {
  const initial = Error('INITIAL_TERMINATION_ERROR'),
    pidError = Error('PID_ERROR');
  const h = fixtureHarness({ terminateError: initial, pidError });
  const f = await h.create();
  h.launched.emit('close', null, null);
  const error = await failure(() => f.close());
  assert.deepEqual([...error.errors], [h.cooperativeError, initial, pidError]);
  assert.deepEqual(
    [...phases(error)],
    ['cooperative-shutdown', 'terminate', 'fallback-query'],
  );
  assert.ok(!h.operations.some((item) => item[0] === 'kill'));
  assert.equal(h.operations.filter((item) => item[0] === 'rm').length, 1);
  await f.close();
  assert.equal(
    h.operations.filter((item) => item[0] === 'terminate').length,
    1,
  );
});
test('recovered initial termination remains successful and diagnostic only', async () => {
  const h = fixtureHarness({ terminateError: Error('RECOVERED_ERROR') });
  const f = await h.create();
  await f.close();
  assert.deepEqual(
    h.operations.filter((item) =>
      ['terminate', 'query', 'kill', 'exit-wait'].includes(item[0]),
    ),
    [['terminate'], ['query'], ['exit-wait'], ['kill', 456, 'SIGKILL']],
  );
  assert.deepEqual(h.timeouts, [1000]);
  assert.equal(f.diagnostics().captureStopped, true);
  safe(f.diagnostics());
});
test('close signal/exit-wait and removal errors retain phase order', async () => {
  for (const kind of ['killError', 'exitWaitError']) {
    const initial = Error('INITIAL'),
      fallback = Error('FALLBACK'),
      removal = Error('REMOVE');
    const h = fixtureHarness({
      terminateError: initial,
      [kind]: fallback,
      rmError: removal,
    });
    const f = await h.create();
    const error = await failure(() => f.close());
    assert.deepEqual(
      [...error.errors],
      [h.cooperativeError, initial, fallback, removal],
    );
    assert.deepEqual(
      [...phases(error)],
      ['cooperative-shutdown', 'terminate', 'fallback-signal-wait', 'remove'],
    );
  }
});
test('close wait failure skips removal and retains prior errors at unchanged 3000ms', async () => {
  const initial = Error('INITIAL'),
    pidError = Error('PID');
  const h = fixtureHarness({ terminateError: initial, pidError });
  const f = await h.create();
  const pending = f.close();
  const rejected = failure(() => pending);
  for (let i = 0; i < 20 && !h.timers.length; i++) await Promise.resolve();
  assert.equal(h.timers.at(-1).ms, 3000);
  h.timers.at(-1).fn();
  const error = await rejected;
  assert.equal(error.errors[0], h.cooperativeError);
  assert.equal(error.errors[1], initial);
  assert.equal(error.errors[2], pidError);
  assert.deepEqual(
    [...phases(error)],
    ['cooperative-shutdown', 'terminate', 'fallback-query', 'close-wait'],
  );
  assert.ok(!h.operations.some((item) => item[0] === 'rm'));
});
test('startup primary error survives cleanup rejection and stops capture', async () => {
  const primary = Error('STARTUP'),
    cleanup = Error('TERMINATE');
  const h = fixtureHarness({ startupError: primary, terminateError: cleanup });
  const error = await failure(h.create);
  assert.deepEqual([...error.errors], [primary, cleanup]);
  assert.equal(h.launched.listenerCount('exit'), 0);
  assert.equal(h.launched.stderr.listenerCount('data'), 0);
  assert.ok(!h.operations.some((item) => item[0] === 'rm'));
  assert.ok(!h.operations.some((item) => item[0] === 'cooperative-write'));
  safe(error.nativeDiagnostics);
});
test('query launcher death keeps exact outer assertion and original query failure', async () => {
  const original = Object.assign(Error(forbidden), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
  });
  const h = queryHarness({ reject: original, die: true });
  const error = await failure(h.run);
  assert.equal(error, h.assertions[0]);
  assert.equal(error.name, 'AssertionError');
  assert.match(error.message, /Electron exited.*code 23/);
  assert.deepEqual([...values(error)], [original, error]);
  assert.deepEqual([...phases(error)], ['query', 'launcher-validation']);
  assert.equal(h.launcher.listenerCount('exit'), 0);
  assert.deepEqual(h.waits, [1000]);
});
test('query close-wait rejection cannot replace pending assertion or original query', async () => {
  const original = Error('QUERY_ERROR'),
    waitError = Error('OWNED_QUERY_CLOSE');
  const h = queryHarness({ reject: original, die: true, waitError });
  const error = await failure(h.run);
  assert.equal(error, h.assertions[0]);
  assert.deepEqual([...values(error)], [original, error, waitError]);
  assert.deepEqual(
    [...phases(error)],
    ['query', 'launcher-validation', 'owned-query-close'],
  );
});
test('ordinary live-launcher query wrapping retains cause and metadata', async () => {
  const original = Object.assign(Error('QUERY_ERROR'), {
    code: 7,
    killed: false,
    signal: null,
  });
  const h = queryHarness({ reject: original });
  const error = await failure(h.run);
  assert.equal(error.cause, original);
  assert.match(
    error.message,
    /code=7 killed=false signal=null elapsedMs=0 timeoutMs=10000/,
  );
  assert.deepEqual([...values(error)], [original]);
});
test('query success retains exact object, execution arguments and no exit wait', async () => {
  const result = { stdout: '[]', stderr: 'unchanged' },
    h = queryHarness({ result });
  assert.equal(await h.run(), result);
  assert.deepEqual(h.waits, []);
  const call = h.calls[0];
  assert.equal(call.command, 'powershell.exe');
  assert.deepEqual(call.args, ['-NoProfile', 'owned-query']);
  assert.equal(call.options.timeout, 10000);
  assert.equal(call.options.maxBuffer, 65536);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.signal.aborted, false);
  assert.equal(h.launcher.listenerCount('exit'), 0);
});
test('non-Error query throws stay original and post-success assertion is not duplicated', async () => {
  const h = queryHarness({ reject: 'ORIGINAL_STRING' });
  assert.equal(await failure(h.run), 'ORIGINAL_STRING');
  const dead = queryHarness({ postSuccess: true });
  const error = await failure(dead.run);
  assert.equal(error, dead.assertions[0]);
  assert.equal(dead.assertions.length, 1);
  assert.deepEqual([...values(error)], [error]);
  assert.deepEqual([...phases(error)], ['launcher-validation']);
});
test('collector bounds stderr, refuses arbitrary records, freezes and removes listeners', async () => {
  const h = fixtureHarness();
  const f = await h.create();
  h.launched.stderr.emit(
    'data',
    Buffer.from(forbidden + '\n' + 'x'.repeat(20000)),
  );
  for (let i = 0; i < 80; i++) h.launched.emit('exit', i, 'SIGKILL');
  h.launched.exitCode = 0;
  h.launched.emit('close', 0, null);
  await f.close();
  const snapshot = f.diagnostics(),
    before = safe(snapshot);
  assert.equal(snapshot.stderr.bytesRetained, 16384);
  assert.equal(snapshot.stderr.truncated, true);
  assert.equal(
    snapshot.stderr.sha256,
    createHash('sha256')
      .update(
        Buffer.from(forbidden + '\n' + 'x'.repeat(20000)).subarray(0, 16384),
      )
      .digest('hex'),
  );
  assert.ok(snapshot.events.length <= 32);
  assert.equal(snapshot.captureStopped, true);
  assert.equal(snapshot.nativeAbsence, 'UNKNOWN');
  assert.equal(snapshot.coverage, 'after-launch-return');
  assert.ok(snapshot.attachedAt >= 0);
  assert.equal(h.launched.listenerCount('exit'), 0);
  assert.equal(h.launched.stderr.listenerCount('data'), 0);
  h.launched.emit('exit', 98, 'SIGTERM');
  h.launched.emit('close', 98, 'SIGTERM');
  assert.equal(safe(f.diagnostics()), before);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.stderr));
});
test('collector records already-closed baseline without inventing observed events', async () => {
  const h = fixtureHarness({
    beforeLaunchReturn: (c) => {
      c.exitCode = 23;
      c.signalCode = null;
    },
  });
  const f = await h.create();
  const packet = f.diagnostics();
  assert.equal(packet.baseline.exitCode, 23);
  assert.equal(packet.exit.observed, false);
  assert.equal(packet.close.observed, false);
});
test('task IPC and bootstrap use safe structured error facts', async () => {
  const h = fixtureHarness();
  const f = await h.create();
  const script = h.writes.get('/FAKE/owned/entry.cjs');
  let watch;
  const results = new Map(),
    stderr = [],
    exits = [];
  const app = {
    setPath() {},
    on() {},
    whenReady: async () => {
      throw Object.assign(Error(forbidden), { code: 'EACCES' });
    },
    exit: (code) => exits.push(code),
  };
  const fakeFs = {
    mkdirSync() {},
    watchFile: (_name, _settings, fn) => {
      watch = fn;
    },
    existsSync: () => true,
    readFileSync: () =>
      JSON.stringify({
        id: 1,
        source:
          '()=>{const e=new TypeError("SECRET");e.code="EACCES";throw e;}',
      }),
    writeFileSync: (name, value) => results.set(name, value),
    renameSync() {},
  };
  const context = vm.createContext({
    require: (name) =>
      name === 'electron' ? { app } : name === 'node:fs' ? fakeFs : path,
    process: { stderr: { write: (value) => stderr.push(value) } },
    Error,
    TypeError,
    Map,
    WeakSet,
    URL,
    Response,
    queueMicrotask,
  });
  vm.runInContext(script, context, { filename: '/FAKE/owned/entry.cjs' });
  await Promise.resolve();
  await Promise.resolve();
  await watch();
  const packet = JSON.parse(results.get('/FAKE/owned/result.tmp'));
  assert.equal(packet.ok, false);
  assert.equal(packet.error.phase, 'task');
  assert.equal(packet.error.name, 'TypeError');
  assert.equal(packet.error.code, 'EACCES');
  assert.ok(packet.error.site.length > 0);
  safe(packet.error);
  assert.deepEqual(exits, [1]);
  assert.equal(stderr.length, 1);
  const record = JSON.parse(stderr[0]);
  assert.equal(record.phase, 'bootstrap');
  assert.equal(record.code, 'EACCES');
  safe(record);
  const error = await failure(() => f.evaluate(() => {}));
  assert.equal(error.nativeTaskError.code, 'EACCES');
  assert.equal(f.diagnostics().taskErrors[0].phase, 'task');
  assert.equal(f.diagnostics().taskErrors[0].site[0].column, 22);
});

test('structured stderr accepts only exact safe records across chunk boundaries', async () => {
  const h = fixtureHarness();
  const f = await h.create();
  const record = {
    phase: 'bootstrap',
    name: 'Other',
    code: 'none',
    site: [{ line: 2, column: 3 }],
  };
  const line = JSON.stringify(record) + '\n';
  h.launched.stderr.emit('data', Buffer.from(line.slice(0, 11)));
  h.launched.stderr.emit('data', Buffer.from(line.slice(11)));
  for (const bad of [
    { ...record, message: forbidden },
    { ...record, code: 'SECRET' },
    { ...record, site: [{ line: 2, column: 3, path: forbidden }] },
    { ...record, name: forbidden },
    { ...record, phase: forbidden },
  ])
    h.launched.stderr.emit('data', Buffer.from(JSON.stringify(bad) + '\n'));
  h.launched.stderr.emit('data', Buffer.from('{bad json}\n'));
  await f.close();
  const snapshot = f.diagnostics();
  safe(snapshot);
  assert.equal(snapshot.stderr.records.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.stderr.records[0])),
    record,
  );
});
test('diagnostic getters and frozen thrown values cannot replace failures', async () => {
  const original = Object.freeze(Error('PRIMARY_BODY_ERROR'));
  const proxy = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'then') return undefined;
        throw Error('GETTER_FAILURE');
      },
      getPrototypeOf() {
        throw Error('PROTOTYPE_FAILURE');
      },
    },
  );
  const h = fixtureHarness({ startupError: proxy });
  assert.equal(await failure(h.create), proxy);
  const close = fixtureHarness({ terminateError: proxy, pidError: original });
  const f = await close.create();
  close.launched.emit('close', 0, null);
  const error = await failure(() => f.close());
  assert.deepEqual(
    [...error.errors],
    [close.cooperativeError, proxy, original],
  );
  safe(f.diagnostics());
  const host = hostHarness({ bodyError: proxy, cleanupError: original });
  assert.deepEqual([...(await failure(host.run)).errors], [proxy, original]);
});
test('startup failure emits a bounded safe not-started envelope', async () => {
  const original = Error(forbidden),
    h = fixtureHarness({ startupError: original });
  assert.equal(await failure(h.create), original);
  assert.equal(h.packets.length, 1);
  const packet = JSON.parse(h.packets[0]);
  safe(packet);
  assert.equal(packet.body, 'not-started');
  assert.equal(packet.cleanup, 'passed');
  assert.equal(packet.fixture.captureStopped, true);
});

test('launch rejection records unavailable coverage without claiming native absence', async () => {
  const original = Error('LAUNCH'),
    h = fixtureHarness({ launchError: original });
  assert.equal(await failure(h.create), original);
  const packet = JSON.parse(h.packets[0]);
  safe(packet);
  assert.equal(packet.fixture.coverage, 'launch-not-returned');
  assert.equal(packet.fixture.nativeAbsence, 'UNKNOWN');
  assert.equal(packet.fixture.exit.observed, false);
  assert.equal(packet.fixture.close.observed, false);
  assert.equal(packet.cleanup, 'passed');
  assert.equal(h.launched.listenerCount('exit'), 0);
  assert.equal(h.launched.stderr.listenerCount('data'), 0);
});
test('host success emits immutable lifecycle evidence without changing outcome', async () => {
  const h = hostHarness({ throwBody: false });
  await h.run();
  const packet = JSON.parse(h.emitted.at(-1));
  safe(packet);
  assert.equal(packet.body, 'passed');
  assert.equal(packet.cleanup, 'passed');
  assert.equal(h.attached.length, 1);
});

test('collector preserves only safe nested query facts in failure phase order', async () => {
  const original = Object.assign(Error(forbidden), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
  });
  const query = queryHarness({
    reject: original,
    die: true,
    waitError: Error(forbidden),
  });
  const queryError = await failure(query.run);
  const h = fixtureHarness({
    terminateError: Error('INITIAL'),
    pidError: queryError,
  });
  const f = await h.create();
  h.launched.emit('close', 0, null);
  await failure(() => f.close());
  const packet = f.diagnostics();
  safe(packet);
  const events = packet.events.filter((entry) =>
    [
      'fallback-query',
      'query',
      'launcher-validation',
      'owned-query-close',
    ].includes(entry.phase),
  );
  assert.deepEqual(
    [...events].map((entry) => entry.phase),
    ['fallback-query', 'query', 'launcher-validation', 'owned-query-close'],
  );
  assert.equal(events[1].killed, true);
  assert.equal(events[1].signal, 'SIGTERM');
});

// Changing getters must never pass a validated first value then publish an
// unvalidated later value. Execute the real startup and generated-script paths.
const changingSentinel = 'CHANGING_GETTER_PRIVATE_SENTINEL';
function changingError(property, initial) {
  const original = Error('PRIVATE_MESSAGE');
  Object.defineProperty(original, 'stack', {
    value: '/FAKE/owned/entry.cjs:2:3',
    configurable: true,
  });
  let reads = 0;
  Object.defineProperty(original, property, {
    get() {
      reads++;
      return reads === 1 ? initial : changingSentinel;
    },
  });
  return { original, reads: () => reads };
}
for (const [property, initial, field] of [
  ['name', 'Error', 'name'],
  ['code', 'EACCES', 'errorCode'],
  ['killed', true, 'killed'],
  ['signal', 'SIGTERM', 'signal'],
  ['stack', '/FAKE/owned/entry.cjs:2:3', null],
]) {
  test(`startup emission captures changing ${property} getter once`, async () => {
    const { original, reads } = changingError(property, initial);
    const h = fixtureHarness({ startupError: original });
    assert.equal(await failure(h.create), original);
    const json = h.packets[0];
    assert.equal(typeof json, 'string');
    assert.ok(!json.includes(changingSentinel));
    const packet = JSON.parse(json);
    safe(packet);
    if (field) assert.equal(packet.fixture.events[0][field], initial);
    assert.equal(reads(), 1);
  });
}
async function generatedChangingPackets(property, initial) {
  const h = fixtureHarness();
  await h.create();
  const script = h.writes.get('/FAKE/owned/entry.cjs');
  const bootstrap = changingError(property, initial),
    task = changingError(property, initial);
  let watch;
  const results = new Map(),
    stderr = [],
    exits = [];
  const app = {
    setPath() {},
    on() {},
    whenReady: async () => {
      throw bootstrap.original;
    },
    exit: (code) => exits.push(code),
  };
  const fakeFs = {
    mkdirSync() {},
    watchFile: (_name, _settings, fn) => {
      watch = fn;
    },
    existsSync: () => true,
    readFileSync: () =>
      JSON.stringify({ id: 1, source: '()=>{throw globalThis.taskThrown}' }),
    writeFileSync: (name, value) => results.set(name, value),
    renameSync() {},
  };
  const context = vm.createContext({
    require: (name) =>
      name === 'electron' ? { app } : name === 'node:fs' ? fakeFs : path,
    process: { stderr: { write: (value) => stderr.push(value) } },
    taskThrown: task.original,
    Error,
    Map,
    WeakSet,
    URL,
    Response,
    queueMicrotask,
  });
  vm.runInContext(script, context, { filename: '/FAKE/owned/entry.cjs' });
  await Promise.resolve();
  await Promise.resolve();
  await watch();
  assert.deepEqual(exits, [1]);
  assert.equal(stderr.length, 1);
  const taskPacket = JSON.parse(results.get('/FAKE/owned/result.tmp'));
  assert.equal(taskPacket.ok, false);
  return {
    bootstrap: JSON.parse(stderr[0]),
    task: taskPacket.error,
    reads: [bootstrap.reads(), task.reads()],
  };
}
for (const [property, initial] of [
  ['name', 'TypeError'],
  ['code', 'EACCES'],
  ['stack', '/FAKE/owned/entry.cjs:2:3'],
]) {
  test(`generated task/bootstrap packets capture changing ${property} getter once`, async () => {
    const observed = await generatedChangingPackets(property, initial);
    for (const phase of ['task', 'bootstrap']) {
      const facts = observed[phase];
      assert.equal(facts.phase, phase);
      assert.ok(!JSON.stringify(facts).includes(changingSentinel));
      safe(facts);
      if (property === 'stack')
        assert.deepEqual(facts.site, [{ line: 2, column: 3 }]);
      else assert.equal(facts[property], initial);
    }
    assert.deepEqual(observed.reads, [1, 1]);
  });
}

// Portability facade controls: replay every preceding pure case with host-native
// source resolution and either default path flavour. Never load real app tools.
async function runPathFacade(defaultPath) {
  const actualPath = require('node:path');
  const source = readFileSync(
    resolve(__dirname, 'scrobbler-auth-native-diagnostics.node.cjs'),
    'utf8',
  );
  const marker = '// Portability ' + 'facade controls:';
  assert.equal(source.split(marker).length, 2, 'unique facade boundary');
  const cases = [];
  const allowed = new Set([
    'node:assert/strict',
    'node:fs',
    'node:crypto',
    'node:events',
    'node:module',
    'node:vm',
  ]);
  const context = vm.createContext({
    require(name) {
      if (name === 'node:test')
        return { test: (title, callback) => cases.push({ title, callback }) };
      if (name === 'node:path')
        return {
          ...defaultPath,
          // Source reads must use real host paths, even in the Win32 facade.
          resolve: actualPath.resolve,
          posix: actualPath.posix,
          win32: actualPath.win32,
        };
      assert.ok(allowed.has(name), 'unexpected portability dependency');
      return require(name);
    },
    __dirname,
    Buffer,
    Error,
    AggregateError,
    AbortController,
    URL,
    Response,
    queueMicrotask,
  });
  vm.runInContext(source.slice(0, source.indexOf(marker)), context);
  assert.equal(
    cases.length,
    56,
    'complete original and cooperative pure-control pipeline',
  );
  const failed = [];
  for (const entry of cases) {
    try {
      await entry.callback();
    } catch {
      failed.push(entry.title);
    }
  }
  assert.deepEqual(failed, [], 'all pure fake pipelines must pass');
}
for (const flavour of ['posix', 'win32']) {
  test(`full pure pipeline passes with ${flavour} default path facade`, async () => {
    await runPathFacade(require('node:path')[flavour]);
  });
}
