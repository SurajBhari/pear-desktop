const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  parseReport,
  planGroups,
  fileFilter,
  assertIdentities,
  runGroups,
  createOwnedChildRunner,
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
