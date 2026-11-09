const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { writeSync, ftruncateSync } = require('node:fs');

const {
  parseReport,
  planGroups,
  fileFilter,
  assertIdentities,
  runGroups,
  createOwnedChildRunner,
  captureDiscoveryStdout,
} = require('./run-ci-tests.cjs');

const record = (id, file = 'tests/a.test.ts') => ({
  id,
  file,
  projectId: '',
  projectName: '',
  expectedStatus: 'passed',
});
const report = (records, results = true) => ({
  errors: [],
  suites: [
    {
      specs: records.map((row) => ({
        id: row.id,
        file: row.file,
        tests: [
          {
            projectId: row.projectId,
            projectName: row.projectName,
            expectedStatus: row.expectedStatus,
            status: 'expected',
            results: results
              ? [
                  {
                    status:
                      row.expectedStatus === 'skipped' ? 'skipped' : 'passed',
                    workerIndex: 0,
                  },
                ]
              : [],
          },
        ],
      })),
    },
  ],
});

test('complete files remain atomic and both group limits hold, with an oversized file alone', () => {
  const rows = [];
  for (let i = 0; i < 101; i++)
    rows.push(record(`large-${i}`, 'tests/large.test.ts'));
  for (let i = 0; i < 19; i++)
    for (let n = 0; n < 13; n++)
      rows.push(record(`${i}-${n}`, `tests/${i}.test.ts`));
  const groups = planGroups(rows);
  assert.equal(groups[0].tests.length, 101);
  assert.deepEqual(groups[0].files, ['tests/large.test.ts']);
  for (const group of groups.slice(1)) {
    assert.ok(group.tests.length <= 100);
    assert.ok(group.files.length <= 8);
  }
  assertIdentities(
    rows,
    groups.flatMap((group) => group.tests),
  );
  assert.equal(new Set(groups.flatMap((group) => group.files)).size, 20);
});

test('eight-file bound applies even when the test-count budget is available', () => {
  const rows = Array.from({ length: 17 }, (_, i) =>
    record(String(i), `tests/${i}.test.ts`),
  );
  assert.deepEqual(
    planGroups(rows).map((group) => group.files.length),
    [8, 8, 1],
  );
});

test('file filters match only the literal complete path on POSIX and Windows', () => {
  for (const root of ['/work/a+[b](c).repo', 'C:\\work\\a+[b](c).repo']) {
    const re = new RegExp(fileFilter(root, 'tests/a+[1](v).test.ts'));
    const file = `${root}/tests/a+[1](v).test.ts`;
    assert.ok(re.test(file));
    assert.ok(re.test(file.replaceAll('\\', '/')));
    assert.ok(re.test(file.replaceAll('/', '\\')));
    for (const wrong of [
      file + '.extra',
      file.replace('a+[1]', 'a111'),
      '/prefix' + file,
      file.replace('/tests/', '/other/'),
    ])
      assert.equal(re.test(wrong), false);
  }
  assert.throws(() => fileFilter('/work', '../elsewhere.test.ts'));
});

test('nested reports preserve empty projects and required skips without retaining output payloads', () => {
  const row = { ...record('skip'), expectedStatus: 'skipped' };
  const input = report([row]);
  input.suites = [{ suites: input.suites }];
  input.suites[0].suites[0].specs[0].tests[0].results[0].stdout = [
    { text: 'not retained' },
  ];
  const parsed = parseReport(input, { requireResults: true });
  assert.equal(parsed.tests[0].projectName, '');
  assert.equal(parsed.tests[0].expectedStatus, 'skipped');
  assert.equal(parsed.tests[0].resultCount, 1);
  assert.equal(JSON.stringify(parsed).includes('not retained'), false);
  assertIdentities([row], parsed.tests);
});

test('malformed, empty, duplicate and missing-result reports fail closed', () => {
  for (const bad of [
    {},
    { suites: [], errors: [] },
    report([record('same'), record('same')]),
  ])
    assert.throws(() => parseReport(bad));
  assert.throws(() =>
    parseReport(report([record('a')], false), { requireResults: true }),
  );
  assert.equal(parseReport(report([record('a')], false)).tests.length, 1);
  const badResult = report([record('a')]);
  badResult.suites[0].specs[0].tests[0].results[0].status = 'invented';
  assert.throws(() => parseReport(badResult, { requireResults: true }));
});

test('identity union rejects missing, duplicated, unexpected and moved tests', () => {
  const expected = [record('a'), record('b')];
  for (const actual of [
    [record('a')],
    [...expected, record('b')],
    [...expected, record('extra')],
    [record('a', 'tests/other.ts'), record('b')],
  ])
    assert.throws(() => assertIdentities(expected, actual));
  assert.throws(() => planGroups([record('a'), record('a')]));
});

test('ordinary failures and malformed reports do not rerun or omit later groups', async () => {
  const groups = planGroups(
    [
      record('a'),
      record('b', 'tests/b.test.ts'),
      record('c', 'tests/c.test.ts'),
    ],
    { maxFiles: 1 },
  );
  const calls = [];
  const outcome = await runGroups(groups, {
    invoke: async (group, index) => {
      calls.push(index);
      return {
        closed: true,
        code: index === 0 ? 1 : 0,
        report: index === 1 ? {} : report(group.tests),
      };
    },
  });
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.summaries.length, 3);
});

test('all passing and expected skipped results form the exact original union', async () => {
  const rows = [
    record('a'),
    { ...record('skip', 'tests/b.test.ts'), expectedStatus: 'skipped' },
  ];
  const outcome = await runGroups(planGroups(rows, { maxFiles: 1 }), {
    invoke: async (group) => ({
      closed: true,
      code: 0,
      report: report(group.tests),
    }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.testCount, 2);
});

test('an unclosed child prevents starting another group', async () => {
  let calls = 0;
  const groups = planGroups([record('a'), record('b', 'tests/b.test.ts')], {
    maxFiles: 1,
  });
  const result = await runGroups(groups, {
    invoke: async () => {
      calls++;
      return { closed: false, code: 0, report: report([record('a')]) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
});

test('owned child completion waits for close, forwards cancellation once and never signals closed children', async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  const kills = [];
  child.pid = 123;
  child.kill = (signal) => {
    kills.push(signal);
    return true;
  };
  let spawnCount = 0;
  const runner = createOwnedChildRunner({
    signalSource: signals,
    spawn: () => {
      spawnCount++;
      return child;
    },
  });
  let settled = false;
  const pending = runner.run('node', ['cli']).then((value) => {
    settled = true;
    return value;
  });
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(settled, false);
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  assert.deepEqual(kills, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  const result = await pending;
  assert.equal(result.closed, true);
  signals.emit('SIGTERM');
  assert.deepEqual(kills, ['SIGTERM']);
  await assert.rejects(runner.run('node', ['cli']));
  assert.equal(spawnCount, 1);
  runner.dispose();
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('cancellation stops future groups after the owned child closes', async () => {
  let cancelled = false,
    calls = 0;
  const groups = planGroups([record('a'), record('b', 'tests/b.test.ts')], {
    maxFiles: 1,
  });
  const outcome = await runGroups(groups, {
    isCancelled: () => cancelled,
    invoke: async (group) => {
      calls++;
      cancelled = true;
      return {
        closed: true,
        code: null,
        signal: 'SIGINT',
        report: report(group.tests),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
});

test('a failed owned cancellation signal does not abandon the close boundary', async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.kill = () => {
    throw Error('owned signal failed');
  };
  const runner = createOwnedChildRunner({
    signalSource: signals,
    spawn: () => child,
  });
  const pending = runner.run('node', ['cli']);
  assert.doesNotThrow(() => signals.emit('SIGTERM'));
  child.emit('close', 1, null);
  assert.equal((await pending).closed, true);
  assert.equal(runner.cancelled, 'SIGTERM');
  runner.dispose();
});

test('unknown JSON entries and invalid worker metadata fail closed', () => {
  const invalidWorker = report([record('a')]);
  invalidWorker.suites[0].specs[0].tests[0].results[0].workerIndex = 'unknown';
  assert.throws(() => parseReport(invalidWorker, { requireResults: true }));
  for (const bad of [
    { suites: [null], errors: [] },
    { suites: [{ specs: [null] }], errors: [] },
  ])
    assert.throws(() => parseReport(bad));
});

test('an owned stdout file receives the child bytes before immediate exit', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pear-ci-stdout-test-'),
  );
  const file = path.join(directory, 'output');
  const handle = await fs.open(file, 'wx+', 0o600);
  const runner = createOwnedChildRunner();
  try {
    const child = await runner.run(
      process.execPath,
      ['-e', "process.stdout.write('owned stdout\\n'); process.exit(0)"],
      { stdoutFd: handle.fd },
    );
    assert.equal(child.closed, true);
    assert.equal(child.code, 0);
    assert.equal(await fs.readFile(file, 'utf8'), 'owned stdout\n');
  } finally {
    runner.dispose();
    await handle.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('group output stays inherited and invalid stdout descriptors never spawn', async () => {
  let calls = 0;
  const runner = createOwnedChildRunner({
    spawn: (_command, _args, options) => {
      calls++;
      assert.equal(options.stdio, 'inherit');
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  try {
    await runner.run('node', []);
    for (const stdoutFd of [null, -1, 1, 3.5])
      await assert.rejects(runner.run('node', [], { stdoutFd }));
    assert.equal(calls, 1);
  } finally {
    runner.dispose();
  }
});

test('discovery replays every actual child byte and Total before its awaited continuation', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pear-ci-replay-test-'),
  );
  const runner = createOwnedChildRunner();
  const row = 'synthetic \u03bb ' + 'x'.repeat(180) + '\n';
  const expected = Buffer.from(row.repeat(3514) + 'Total: 3514 tests\n');
  const chunks = [];
  let releaseFirst,
    firstStarted,
    childClosed = false,
    continued = false;
  const first = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const stdout = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      assert.equal(childClosed, true);
      chunks.push(Buffer.from(chunk));
      if (!releaseFirst) {
        releaseFirst = callback;
        firstStarted();
      } else setImmediate(callback);
    },
  });
  try {
    const pending = captureDiscoveryStdout(
      directory,
      async (stdoutFd) => {
        const child = await runner.run(
          process.execPath,
          [
            '-e',
            "if (!require('node:fs').fstatSync(1).isFile()) process.exit(9);" +
              `for(let i=0;i<3514;i++)process.stdout.write(${JSON.stringify(row)});` +
              "process.stdout.write('Total: 3514 tests\\n');process.exit(0);",
          ],
          { stdoutFd },
        );
        childClosed = child.closed;
        assert.equal(child.code, 0);
        return child;
      },
      { stdout },
    ).then(() => {
      continued = true;
    });
    await first;
    assert.equal(continued, false);
    releaseFirst();
    await pending;
    assert.equal(continued, true);
    assert.deepEqual(Buffer.concat(chunks), expected);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    runner.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cancelled discovery keeps capture owned until child close and prevents replay', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pear-ci-cancel-test-'),
  );
  let release,
    started,
    cancelled = false,
    settled = false,
    writes = 0;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      writes++;
      callback();
    },
  });
  try {
    const pending = captureDiscoveryStdout(
      directory,
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ closed: true, code: null, signal: 'SIGTERM' });
          started();
        }),
      { stdout, isCancelled: () => cancelled },
    ).finally(() => {
      settled = true;
    });
    await entered;
    cancelled = true;
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal((await fs.readdir(directory)).length, 1);
    release();
    await assert.rejects(pending);
    assert.equal(writes, 0);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a replay write error gates continuation and removes its owned capture', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pear-ci-write-test-'),
  );
  let continued = false;
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Error('sink failed'));
    },
  });
  try {
    await assert.rejects(
      captureDiscoveryStdout(
        directory,
        async (fd) => {
          writeSync(fd, 'actual child bytes\n');
          return { closed: true, code: 0 };
        },
        { stdout },
      ).then(() => {
        continued = true;
      }),
      /sink failed/,
    );
    assert.equal(continued, false);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('oversized discovery output fails before replay without truncating it into a success', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pear-ci-bound-test-'),
  );
  let writes = 0;
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      writes++;
      callback();
    },
  });
  try {
    await assert.rejects(
      captureDiscoveryStdout(
        directory,
        async (fd) => {
          ftruncateSync(fd, 8 * 1024 * 1024 + 1);
          return { closed: true, code: 0 };
        },
        { stdout },
      ),
      /bound/i,
    );
    assert.equal(writes, 0);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a shortened capture read fails orchestration and cleans up instead of emitting a partial success', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pear-ci-read-test-'),
  );
  let continued = false;
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      fs.readdir(directory)
        .then(([file]) => fs.truncate(path.join(directory, file), 0))
        .then(() => callback(), callback);
    },
  });
  try {
    await assert.rejects(
      captureDiscoveryStdout(
        directory,
        async (fd) => {
          writeSync(fd, Buffer.alloc(128 * 1024, 65));
          return { closed: true, code: 0 };
        },
        { stdout },
      ).then(() => {
        continued = true;
      }),
      /read|changed/i,
    );
    assert.equal(continued, false);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
