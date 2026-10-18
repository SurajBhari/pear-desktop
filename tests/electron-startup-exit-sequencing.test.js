import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { test } from '@playwright/test';

const source = readFileSync(
  new URL('./electron-startup-observer.test.js', import.meta.url),
  'utf8',
);
const token = 'fixture-current';
const ready = '{"version":1,"token":"fixture-current","phase":"READY"}';
const actionPath = '/owned/action.txt';
const actionDone = '/owned/action-done.json';
const blocked = () =>
  assert.fail('Pure controls cannot import or use native I/O');

function protocol() {
  const start = source.indexOf('// BEGIN OWNED FIXTURE EXIT');
  const end = source.indexOf('// END OWNED FIXTURE EXIT', start);
  if (start < 0 || end < start) return {};
  return vm.runInThisContext(
    '(function(assert,readFile,writeFile,pause){' +
      source.slice(start, end) +
      '\nreturn {fixtureExitReady,requestFixtureExit};})',
  )(assert, blocked, blocked, blocked);
}

async function settle() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}
function pending() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function clock() {
  let now = 0,
    serial = 0;
  const timers = new Map();
  return {
    timers,
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++serial;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setNow: (value) => {
      now = value;
    },
    async tick(ms) {
      const until = now + ms;
      for (let n = 0; n < 1000; n++) {
        const next = [...timers]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}
function observed(promise) {
  return promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

async function entry(options = { visible: false, exit: true }) {
  const match = source.match(/await writeFile\(\s*entry,\s*(`[^]*?`),\s*\);/);
  assert(match, 'Missing actual generated entry expression');
  const make = vm.runInThisContext(
    '(function(options,wrongProfile,actionPath,actionDone,token,fixtureExitReady){return ' +
      match[1] +
      ';})',
  );
  const text = make(
    options,
    '/owned/wrong-profile',
    actionPath,
    actionDone,
    token,
    protocol().fixtureExitReady,
  );
  const files = new Map(),
    watches = new Map(),
    trace = [],
    exits = [],
    windows = [],
    time = clock();
  const app = new EventEmitter();
  Object.assign(app, {
    whenReady: () => Promise.resolve(),
    setPath: (...args) => trace.push(['setPath', ...args]),
    exit: (code) => exits.push(code),
  });
  class BrowserWindow extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.destroyed = false;
      this.visible = config.show;
      windows.push(this);
      app.emit('browser-window-created', undefined, this);
    }
    loadURL(url) {
      trace.push(['loadURL', url]);
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    hide() {
      this.visible = false;
    }
    show() {
      this.visible = true;
    }
    close() {
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }
  const fakeFs = {
    watchFile(path, config, callback) {
      trace.push(['watch', path, config.interval]);
      watches.set(path, callback);
    },
    unwatchFile(path) {
      trace.push(['unwatch', path]);
      watches.delete(path);
    },
    readFileSync(path) {
      assert(files.has(path));
      return files.get(path);
    },
    writeFileSync(path, value, options) {
      if (options?.flag === 'wx') assert(!files.has(path));
      files.set(path, value);
      trace.push(['write', path, value]);
    },
    renameSync(from, to) {
      assert(files.has(from));
      files.set(to, files.get(from));
      files.delete(from);
      trace.push(['rename', from, to]);
    },
  };
  vm.runInNewContext(text, {
    require(name) {
      if (name === 'electron') return { app, BrowserWindow };
      if (name === 'node:fs') return fakeFs;
      return blocked();
    },
    setTimeout: time.setTimeout,
    Error,
  });
  await settle();
  const handler = watches.get(actionPath);
  return {
    files,
    trace,
    exits,
    windows,
    time,
    watches,
    action(value) {
      files.set(actionPath, value);
      let error;
      try {
        handler({ nlink: 1 });
      } catch (e) {
        error = e;
      }
      return error;
    },
    handler,
  };
}

function parent() {
  const request = protocol().requestFixtureExit;
  assert.equal(
    typeof request,
    'function',
    'Missing source-owned exit coordinator',
  );
  const time = clock(),
    child = new EventEmitter(),
    files = new Map([[actionDone, ready]]),
    trace = [];
  child.exitCode = null;
  child.signalCode = null;
  const h = {
    time,
    child,
    files,
    trace,
    onRead: undefined,
    onWrite: undefined,
    onArm: undefined,
  };
  const once = child.once.bind(child);
  child.once = (name, callback) => {
    trace.push(['arm', name]);
    const value = once(name, callback);
    h.onArm?.();
    return value;
  };
  h.exit = (code = 23, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  h.io = {
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    async readFile(path) {
      trace.push(['read', path]);
      if (h.onRead) return h.onRead(path);
      if (!files.has(path))
        throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return files.get(path);
    },
    async writeFile(path, value, options) {
      trace.push([
        'publish',
        path,
        value,
        options.flag,
        options.signal.aborted,
      ]);
      if (files.has(path))
        throw Object.assign(Error('exists'), { code: 'EEXIST' });
      if (h.onWrite) return h.onWrite(path, value, options);
      files.set(path, value);
      h.exit();
    },
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const id = time.setTimeout(done, ms);
        const abort = () => {
          time.clearTimeout(id);
          signal.removeEventListener('abort', abort);
          reject(Error('sleep aborted'));
        };
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  h.run = () =>
    observed(request({ child, actionPath, actionDone, token }, h.io));
  h.clean = () => {
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(time.timers.size, 0);
  };
  return h;
}

test('exit entry publishes current READY only after installing its action watcher', async () => {
  const h = await entry();
  assert.equal(h.files.get(actionDone), ready);
  assert(
    h.trace.findIndex((t) => t[0] === 'watch') <
      h.trace.findIndex((t) => t[0] === 'write'),
  );
});
test('exit fixture never exits on a startup-relative timer', async () => {
  const h = await entry();
  await h.time.tick(10000);
  assert.deepEqual(h.exits, []);
});
test('only the exact current action causes one fixed exit23', async () => {
  const h = await entry();
  assert.equal(h.action('exit:fixture-current'), undefined);
  h.handler({ nlink: 1 });
  assert.deepEqual(h.exits, [23]);
  assert.equal(h.watches.size, 0);
});
test('a stale exit action cannot cause exit23 even after startup time passes', async () => {
  const h = await entry();
  h.action('exit:fixture-stale');
  await h.time.tick(10000);
  assert.deepEqual(h.exits, []);
});
test('hide and close fixture acknowledgements keep their existing shapes', async () => {
  for (const [action, expected] of [
    ['hide', '{"closed":false,"visible":false}'],
    ['close', '{"closed":true,"visible":false}'],
  ]) {
    const h = await entry({ visible: true });
    assert.equal(h.files.has(actionDone), false);
    assert.equal(h.action(action), undefined);
    assert.equal(h.files.get(actionDone), expected);
    assert.deepEqual(h.exits, []);
  }
});
test('a non-exit fixture does not gain the new exit action', async () => {
  const h = await entry({ visible: false, exit: false });
  assert(h.action('exit:fixture-current'));
  assert.deepEqual(h.exits, []);
});
test('parent arms observation before exclusive action and validates actual code23', async () => {
  const h = parent(),
    result = await h.run();
  assert.equal(result.error, undefined);
  assert.equal(h.child.exitCode, 23);
  assert(
    h.trace.findIndex((t) => t[0] === 'arm') <
      h.trace.findIndex((t) => t[0] === 'publish'),
  );
  assert.deepEqual(h.trace.find((t) => t[0] === 'publish').slice(1), [
    actionPath,
    'exit:fixture-current',
    'wx',
    false,
  ]);
  h.clean();
});
test('missing READY uses the same bounded phase and never publishes', async () => {
  const h = parent();
  h.files.clear();
  const result = h.run();
  await settle();
  await h.time.tick(2000);
  assert((await result).error);
  assert(!h.trace.some((t) => t[0] === 'publish'));
  h.clean();
});
test('stale or malformed READY never authorizes an action', async () => {
  for (const marker of [
    '{"version":1,"token":"stale","phase":"READY"}',
    '{',
    '{"version":1,"token":"fixture-current","phase":"READY","extra":true}',
  ]) {
    const h = parent();
    h.files.set(actionDone, marker);
    assert((await h.run()).error);
    assert(!h.trace.some((t) => t[0] === 'publish'));
    h.clean();
  }
});
test('exit before READY or during arming cannot become an owned request', async () => {
  for (const early of ['before', 'arm']) {
    const h = parent();
    if (early === 'before') h.exit();
    else h.onArm = () => h.exit();
    assert((await h.run()).error);
    assert(!h.trace.some((t) => t[0] === 'publish'));
    h.clean();
  }
});
test('wrong exit code or signal fails rather than accepting any exit', async () => {
  for (const [code, signal] of [
    [0, null],
    [7, null],
    [123, null],
    [null, 'SIGKILL'],
  ]) {
    const h = parent();
    h.onWrite = () => h.exit(code, signal);
    assert((await h.run()).error);
    h.clean();
  }
});
test('event code23 cannot substitute for different child state', async () => {
  const h = parent();
  h.onWrite = () => {
    h.child.exitCode = 7;
    h.child.emit('exit', 23, null);
  };
  assert((await h.run()).error);
  h.clean();
});
test('no exit after an action is a phase failure with all resources retired', async () => {
  const h = parent();
  h.onWrite = () => {};
  const result = h.run();
  await settle();
  await h.time.tick(2000);
  assert((await result).error);
  h.clean();
});
test('exclusive write failure preserves failure and retires a pending exit waiter', async () => {
  for (const kind of ['exists', 'reject', 'throw']) {
    const h = parent(),
      failure = Object.assign(Error('owned write failed'), { code: 'EACCES' });
    if (kind === 'exists') h.files.set(actionPath, 'stale');
    else
      h.onWrite = () => {
        if (kind === 'throw') throw failure;
        return Promise.reject(failure);
      };
    const result = await h.run();
    assert(result.error);
    if (kind !== 'exists') assert.equal(result.error, failure);
    h.clean();
  }
});
test('pending reads and writes cannot extend the two-second phase or leak late rejection', async () => {
  for (const stage of ['read', 'write']) {
    const h = parent(),
      deferred = pending();
    if (stage === 'read') h.onRead = () => deferred.promise;
    else h.onWrite = () => deferred.promise;
    const result = h.run();
    await settle();
    await h.time.tick(2000);
    assert((await result).error);
    deferred.reject(Error('late owned I/O rejection'));
    await settle();
    h.clean();
  }
});
test('ready time and exit time share one deadline rather than two budgets', async () => {
  const h = parent();
  let reads = 0;
  h.onRead = () => {
    if (++reads === 1)
      throw Object.assign(Error('missing'), { code: 'ENOENT' });
    return ready;
  };
  h.onWrite = () => {};
  const result = h.run();
  await settle();
  await h.time.tick(20);
  assert(h.trace.some((t) => t[0] === 'publish'));
  await h.time.tick(1980);
  assert((await result).error);
  h.clean();
});
test('an exit observed after the ceiling is still a deadline failure', async () => {
  const h = parent();
  h.onWrite = () => {
    h.time.setNow(2001);
    h.exit();
  };
  assert((await h.run()).error);
  h.clean();
});

test('exit action stays pending across create-empty, partial write and completed publication', async () => {
  const h = await entry();
  for (const content of ['', 'exit:fixture-cur']) {
    assert.equal(h.action(content), undefined);
    assert.equal(h.watches.size, 1);
    assert.deepEqual(h.exits, []);
    await h.time.tick(20);
  }
  assert.equal(h.action('exit:fixture-current'), undefined);
  assert.deepEqual(h.exits, [23]);
  assert.equal(h.watches.size, 0);
  h.handler({ nlink: 1 });
  await h.time.tick(10000);
  assert.deepEqual(h.exits, [23]);
});
test('every proper current-action prefix remains pending until the exact action arrives', async () => {
  const action = 'exit:' + token;
  for (let length = 1; length < action.length; length++) {
    const h = await entry();
    assert.equal(h.action(action.slice(0, length)), undefined);
    assert.equal(h.watches.size, 1);
    assert.deepEqual(h.exits, []);
    assert.equal(h.action(action), undefined);
    h.handler({ nlink: 1 });
    assert.deepEqual(h.exits, [23]);
    assert.equal(h.watches.size, 0);
  }
});
test('wrong or stale content after a valid prefix never authorizes an exit', async () => {
  for (const content of [
    'exit:fixture-stale',
    'exit:23',
    'exit:fixture-current\n',
    'unsupported',
  ]) {
    const h = await entry();
    assert.equal(h.action('ex'), undefined);
    assert(h.action(content));
    assert.deepEqual(h.exits, []);
    await h.time.tick(10000);
    assert.deepEqual(h.exits, []);
  }
});
test('non-exit fixtures still reject empty and partial exit actions without pending', async () => {
  for (const content of ['', 'ex', 'exit:fixture-cur']) {
    const h = await entry({ visible: true, exit: false });
    assert(h.action(content));
    assert.equal(h.watches.size, 0);
    assert.equal(h.files.has(actionDone), false);
    assert.deepEqual(h.exits, []);
  }
});
