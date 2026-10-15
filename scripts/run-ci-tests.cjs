// Bound CI worker lifetime without changing discovery, assertions or local pnpm test.
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/** @typedef {{id: string, file: string, projectId: string, projectName: string, expectedStatus: string, outcome: string, resultCount: number, workers: number[]}} CompactTest */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(test) {
  return `${test.projectId}\0${test.id}`;
}

function assertIdentities(expected, actual) {
  const wanted = new Map();
  for (const row of expected) {
    const key = identity(row);
    if (wanted.has(key)) throw Error('Duplicate expected test identity');
    wanted.set(key, row);
  }
  const seen = new Set();
  for (const row of actual) {
    const key = identity(row);
    if (seen.has(key)) throw Error('Duplicate observed test identity');
    seen.add(key);
    const original = wanted.get(key);
    if (
      !original ||
      original.file !== row.file ||
      original.projectName !== row.projectName
    )
      throw Error('Unexpected test identity or file/project change');
  }
  if (seen.size !== wanted.size) throw Error('Missing test identities');
}

/** @param {unknown} report @returns {{tests: CompactTest[], errorCount: number}} */
function parseReport(report, { requireResults = false } = {}) {
  if (
    !isRecord(report) ||
    !Array.isArray(report.suites) ||
    !Array.isArray(report.errors)
  )
    throw Error('Invalid Playwright report');
  const tests = [];
  const statuses = new Set([
    'passed',
    'failed',
    'timedOut',
    'skipped',
    'interrupted',
  ]);
  function visit(suites) {
    for (const suite of suites) {
      if (
        !isRecord(suite) ||
        (suite.specs !== undefined && !Array.isArray(suite.specs)) ||
        (suite.suites !== undefined && !Array.isArray(suite.suites))
      )
        throw Error('Invalid report suite');
      for (const spec of suite.specs ?? []) {
        if (
          !isRecord(spec) ||
          typeof spec.id !== 'string' ||
          !spec.id ||
          typeof spec.file !== 'string' ||
          !spec.file ||
          !Array.isArray(spec.tests) ||
          !spec.tests.length
        )
          throw Error('Invalid report test identity');
        for (const test of spec.tests) {
          if (
            !isRecord(test) ||
            typeof test.projectId !== 'string' ||
            typeof test.projectName !== 'string' ||
            !['passed', 'failed', 'skipped'].includes(test.expectedStatus) ||
            !Array.isArray(test.results)
          )
            throw Error('Invalid report project/results');
          if (requireResults && !test.results.length)
            throw Error('Missing test results');
          if (
            test.results.some(
              (result) =>
                !isRecord(result) ||
                !statuses.has(result.status) ||
                !Number.isInteger(result.workerIndex) ||
                result.workerIndex < -1,
            )
          )
            throw Error('Invalid test result status');
          if (
            !['expected', 'unexpected', 'flaky', 'skipped'].includes(
              test.status,
            )
          )
            throw Error('Invalid test outcome');
          tests.push({
            id: spec.id,
            file: spec.file.replaceAll('\\', '/'),
            projectId: test.projectId,
            projectName: test.projectName,
            expectedStatus: test.expectedStatus,
            outcome: test.status,
            resultCount: test.results.length,
            workers: [
              ...new Set(
                test.results
                  .map((result) => result.workerIndex)
                  .filter((index) => Number.isInteger(index) && index >= 0),
              ),
            ],
          });
        }
      }
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites);
  if (!tests.length) throw Error('No discovered tests/results');
  assertIdentities(tests, tests);
  return { tests, errorCount: report.errors.length };
}

function planGroups(tests, { maxTests = 100, maxFiles = 8 } = {}) {
  if (
    !Number.isInteger(maxTests) ||
    maxTests < 1 ||
    !Number.isInteger(maxFiles) ||
    maxFiles < 1 ||
    !tests.length
  )
    throw Error('Invalid grouping limits or empty discovery');
  assertIdentities(tests, tests);
  const files = new Map();
  for (const row of tests) {
    if (!files.has(row.file)) files.set(row.file, []);
    files.get(row.file).push(row);
  }
  const groups = [];
  let group = { files: [], tests: [] };
  for (const [file, rows] of files) {
    if (
      group.files.length &&
      (group.files.length === maxFiles ||
        group.tests.length + rows.length > maxTests)
    ) {
      groups.push(group);
      group = { files: [], tests: [] };
    }
    group.files.push(file);
    group.tests.push(...rows);
    if (rows.length > maxTests) {
      groups.push(group);
      group = { files: [], tests: [] };
    }
  }
  if (group.files.length) groups.push(group);
  assertIdentities(
    tests,
    groups.flatMap((entry) => entry.tests),
  );
  return groups;
}

function fileFilter(root, file) {
  const normalized = file.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    /^[A-Za-z]:/.test(normalized)
  )
    throw Error('Test file must be relative to the discovery root');
  const absolute = `${root.replaceAll('\\', '/').replace(/\/$/, '')}/${normalized}`;
  return (
    '^' +
    absolute
      .split('/')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[/\\\\]') +
    '$'
  );
}

function createOwnedChildRunner({
  spawn = childProcess.spawn,
  signalSource = process,
} = {}) {
  let active = null;
  let cancelled = null;
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (cancelled) return;
      cancelled = signal;
      // Only the currently owned ChildProcess handle is ever signalled.
      if (active) {
        try {
          active.kill(signal);
        } catch {
          /* Cancellation remains active; still wait for this owned child's close. */
        }
      }
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }
  return {
    get cancelled() {
      return cancelled;
    },
    async run(command, args, options) {
      if (cancelled || active)
        throw Error('Cancelled or already running an owned child');
      return await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(command, args, { ...options, stdio: 'inherit' });
        } catch {
          reject(Error('Cannot start test CLI'));
          return;
        }
        active = child;
        let spawnError = false;
        child.once('error', () => {
          spawnError = true;
        });
        child.once('close', (code, signal) => {
          active = null;
          resolve({
            closed: true,
            code,
            signal,
            pid: child.pid ?? null,
            spawnError,
          });
        });
      });
    },
    dispose() {
      if (active) throw Error('Cannot release a live owned child');
      for (const [signal, handler] of handlers)
        signalSource.removeListener(signal, handler);
    },
  };
}

async function runGroups(
  groups,
  { invoke, list = false, isCancelled = () => false, onSummary = () => {} },
) {
  const summaries = [];
  const observed = [];
  let ok = true;
  for (let index = 0; index < groups.length; index++) {
    if (isCancelled()) {
      ok = false;
      break;
    }
    const group = groups[index];
    let child;
    try {
      child = await invoke(group, index);
    } catch {
      ok = false;
      break;
    } // No close witness: never start another child.
    const summary = {
      group: index + 1,
      files: group.files.length,
      planned: group.tests.length,
      observed: 0,
      code: child.code,
      signal: child.signal ?? null,
      pid: child.pid ?? null,
      closed: child.closed === true,
      workers: 0,
      failed: false,
    };
    if (!child.closed) {
      summary.failed = true;
      summaries.push(summary);
      onSummary(summary);
      ok = false;
      break;
    }
    try {
      if (child.reportError) throw Error('Missing or invalid JSON report');
      const compact =
        child.parsed ?? parseReport(child.report, { requireResults: !list });
      observed.push(...compact.tests);
      summary.observed = compact.tests.length;
      summary.workers = new Set(
        compact.tests.flatMap((row) => row.workers),
      ).size;
      assertIdentities(group.tests, compact.tests);
      if (
        compact.errorCount ||
        (!list && compact.tests.some((row) => row.outcome === 'unexpected')) ||
        child.code !== 0 ||
        child.signal ||
        child.spawnError
      )
        throw Error('Group failed');
    } catch {
      summary.failed = true;
      ok = false;
    }
    summaries.push(summary);
    onSummary(summary);
  }
  try {
    assertIdentities(
      groups.flatMap((group) => group.tests),
      observed,
    );
  } catch {
    ok = false;
  }
  if (isCancelled()) ok = false;
  return { ok, testCount: observed.length, summaries };
}

async function readCompact(file, requireResults) {
  return parseReport(JSON.parse(await fs.readFile(file, 'utf8')), {
    requireResults,
  });
}

async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 1 || args[0] !== '--list'))
    throw Error('Usage: node scripts/run-ci-tests.cjs [--list]');
  const list = args[0] === '--list';
  const root = path.resolve(__dirname, '..');
  const cli = require.resolve('@playwright/test/cli');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pear-ci-tests-'));
  const runner = createOwnedChildRunner();
  async function invoke(files, index, discoveryOnly) {
    const reportFile = path.join(directory, `${index}.json`);
    const cliArgs = [
      cli,
      'test',
      ...files.map((file) => fileFilter(root, file)),
      ...(discoveryOnly ? ['--list'] : []),
      '--reporter=json',
    ];
    const child = await runner.run(process.execPath, cliArgs, {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
    });
    try {
      return {
        ...child,
        parsed: await readCompact(reportFile, !discoveryOnly),
      };
    } catch {
      return { ...child, reportError: true };
    } finally {
      await fs.rm(reportFile, { force: true });
    }
  }
  try {
    // JSON goes to an owned file: discovery may also run Node-only release tests.
    const discovery = await invoke([], 'discovery', true);
    if (
      runner.cancelled ||
      discovery.code !== 0 ||
      discovery.signal ||
      discovery.spawnError ||
      discovery.reportError ||
      discovery.parsed.errorCount
    )
      throw Error('Original test discovery failed');
    const groups = planGroups(discovery.parsed.tests);
    console.log(
      'CI_TEST_PLAN ' +
        JSON.stringify({
          tests: discovery.parsed.tests.length,
          files: new Set(discovery.parsed.tests.map((row) => row.file)).size,
          groups: groups.length,
          maxTests: 100,
          maxFiles: 8,
          list,
        }),
    );
    const outcome = await runGroups(groups, {
      list,
      isCancelled: () => !!runner.cancelled,
      invoke: (group, index) => invoke(group.files, index, list),
      onSummary: (summary) =>
        console.log('CI_TEST_GROUP ' + JSON.stringify(summary)),
    });
    console.log(
      'CI_TEST_TOTAL ' +
        JSON.stringify({
          ok: outcome.ok,
          tests: outcome.testCount,
          groups: outcome.summaries.length,
          cancelled: !!runner.cancelled,
        }),
    );
    return runner.cancelled === 'SIGINT'
      ? 130
      : runner.cancelled
        ? 143
        : outcome.ok
          ? 0
          : 1;
  } finally {
    runner.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = {
  parseReport,
  planGroups,
  fileFilter,
  assertIdentities,
  runGroups,
  createOwnedChildRunner,
  main,
};
if (require.main === module)
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('CI test orchestration failed');
      process.exitCode = 1;
    },
  );
