'use strict';

// SOURCE ONLY until root separately admits a disposable runner, exact input/pins,
// dependency setup and execution. Importing this module reads no runtime state.
const TEST_FILE = 'tests/api-music-remote-http.test.ts';
const TEST_TITLE =
  'runtime-admitted nonloopback HTTP and TLS require actual direct peers';
const CERT_SHA256 =
  '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3';
const LEAF_FINGERPRINT =
  'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1';
const CHECKPOINTS = Object.freeze([
  'actual_nonempty_socket_facts',
  'search100plus51_replay',
  'distinct_grants_default_disabled',
  'namespace_headers',
  'accepted_receipt_exact_replay',
  'terminal_owner_cursor_receipt',
  'two_client_logical_cancel_physical_hold',
  'bounded_cleanup',
]);
const ENVIRONMENTS = Object.freeze({
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
});
const MAX_OUTPUT = 2 * 1024 * 1024; // Combined stdout/stderr, including JSON report.
const WALL_MS = 145_000; // Plus 3s TERM and 2s KILL close grace: child bound 150s.
const TERM_MS = 3_000;
const KILL_MS = 2_000;
const fail = (code) => {
  throw Error(code);
};
const plain = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  plain(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function selectAssignedIPv4(interfaces) {
  if (!plain(interfaces) || Object.keys(interfaces).length > 256)
    fail('TOPOLOGY_UNAVAILABLE');
  const candidates = new Set();
  let rows = 0;
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const row of entries) {
      if (++rows > 1024) fail('TOPOLOGY_UNAVAILABLE');
      if (
        !plain(row) ||
        row.internal !== false ||
        !['IPv4', 4].includes(row.family)
      )
        continue;
      if (
        typeof row.address !== 'string' ||
        !/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(row.address)
      )
        continue;
      const octets = row.address.split('.').map(Number);
      if (
        octets.some((n) => n > 255) ||
        octets[0] === 0 ||
        octets[0] === 127 ||
        octets[0] >= 224 ||
        (octets[0] === 169 && octets[1] === 254)
      )
        continue;
      candidates.add(row.address);
    }
  }
  const selected = [...candidates].sort((a, b) => {
    const left = a.split('.').map(Number),
      right = b.split('.').map(Number);
    for (let i = 0; i < 4; i++)
      if (left[i] !== right[i]) return left[i] - right[i];
    return 0;
  })[0];
  if (!selected) fail('TOPOLOGY_UNAVAILABLE');
  return selected;
}

function validatePlan(plan) {
  const keys = [
    'schema',
    'disposableRunner',
    'platform',
    'arch',
    'image',
    'repository',
    'runId',
    'attempt',
    'jobId',
    'expectedHead',
    'expectedTree',
    'sourceManifestSHA256',
    'node',
    'cliSHA256',
    'lockSHA256',
  ];
  if (
    !exactKeys(plan, keys) ||
    plan.schema !== 1 ||
    plan.disposableRunner !== true ||
    !Object.hasOwn(ENVIRONMENTS, plan.platform) ||
    !['x64', 'arm64'].includes(plan.arch)
  )
    fail('INVALID_PLAN');
  if (
    typeof plan.image !== 'string' ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(plan.image) ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(
      plan.repository,
    )
  )
    fail('INVALID_PLAN');
  for (const field of ['runId', 'attempt', 'jobId'])
    if (
      typeof plan[field] !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(plan[field])
    )
      fail('INVALID_PLAN');
  for (const field of ['expectedHead', 'expectedTree'])
    if (typeof plan[field] !== 'string' || !/^[a-f0-9]{40}$/.test(plan[field]))
      fail('INVALID_PLAN');
  for (const field of ['sourceManifestSHA256', 'cliSHA256', 'lockSHA256'])
    if (!sha(plan[field])) fail('INVALID_PLAN');
  if (
    !exactKeys(plan.node, ['path', 'version', 'sha256']) ||
    typeof plan.node.path !== 'string' ||
    plan.node.path.length > 1024 ||
    /[\x00-\x1f]/.test(plan.node.path) ||
    !/^(\/|[A-Za-z]:[\\/])/.test(plan.node.path) ||
    !/^v24\.[0-9]+\.[0-9]+$/.test(plan.node.version) ||
    !sha(plan.node.sha256)
  )
    fail('INVALID_PLAN');
}

function parseProtocolTelemetry(value, protocol) {
  const integer = (v, min, max) =>
    Number.isSafeInteger(v) && v >= min && v <= max;
  const group = (v, keys) => {
    if (!exactKeys(v, keys)) fail('INVALID_REPORT');
  };
  group(value, [
    'version',
    'endpoint',
    'tls',
    'pages',
    'ownership',
    'counts',
    'cleanup',
  ]);
  if (value.version !== 1) fail('INVALID_REPORT');
  const {
    endpoint: e,
    tls: t,
    pages: p,
    ownership: o,
    counts: c,
    cleanup: k,
  } = value;
  group(e, [
    'label',
    'family',
    'observations',
    'port',
    'nonloopback',
    'peerMatchesAdmission',
    'localMatchesAdmission',
    'owned',
    'epochs',
  ]);
  if (
    e.label !== 'owned-v4' ||
    e.family !== 4 ||
    !integer(e.observations, 1, 256) ||
    !integer(e.port, 1, 65535) ||
    [
      e.nonloopback,
      e.peerMatchesAdmission,
      e.localMatchesAdmission,
      e.owned,
    ].some((v) => v !== true) ||
    !Array.isArray(e.epochs) ||
    e.epochs.length !== 4
  )
    fail('INVALID_REPORT');
  const labels = ['disabled', 'A', 'B', 'configured'];
  let observed = 0;
  for (let i = 0; i < labels.length; i++) {
    const epoch = e.epochs[i];
    group(epoch, ['label', 'observations']);
    if (epoch.label !== labels[i] || !integer(epoch.observations, 1, 256))
      fail('INVALID_REPORT');
    observed += epoch.observations;
  }
  if (observed !== e.observations) fail('INVALID_REPORT');
  group(t, [
    'encrypted',
    'versions',
    'verifiedResponses',
    'peerLeafFingerprint256',
  ]);
  if (
    !Array.isArray(t.versions) ||
    !integer(t.verifiedResponses, 0, e.observations)
  )
    fail('INVALID_REPORT');
  if (protocol === 'HTTP') {
    if (
      t.encrypted !== false ||
      t.versions.length ||
      t.verifiedResponses !== 0 ||
      t.peerLeafFingerprint256 !== null
    )
      fail('INVALID_REPORT');
  } else if (
    protocol !== 'TLS' ||
    t.encrypted !== true ||
    t.versions.length < 1 ||
    t.versions.length > 2 ||
    new Set(t.versions).size !== t.versions.length ||
    t.versions.some((v) => !['TLSv1.2', 'TLSv1.3'].includes(v)) ||
    t.verifiedResponses < 1 ||
    t.peerLeafFingerprint256 !== LEAF_FINGERPRINT
  )
    fail('INVALID_REPORT');
  group(p, [
    'firstItems',
    'secondItems',
    'nativeFetchesForPaging',
    'replayNativeDelta',
  ]);
  if (
    p.firstItems !== 100 ||
    p.secondItems !== 51 ||
    p.nativeFetchesForPaging !== 1 ||
    p.replayNativeDelta !== 0
  )
    fail('INVALID_REPORT');
  group(o, ['retiredA', 'distinctAB', 'oldCursorStatus', 'oldReceiptStatus']);
  if (
    o.retiredA !== true ||
    o.distinctAB !== true ||
    o.oldCursorStatus !== 404 ||
    o.oldReceiptStatus !== 409
  )
    fail('INVALID_REPORT');
  group(c, [
    'requests',
    'nativeReadPackets',
    'controlsAfterAccepted',
    'controlsAfterReplay',
    'controlsFinal',
    'cancelPackets',
    'holdsBeforeLoss',
    'holdsAfterLoss',
    'holdsAfterSettlement',
  ]);
  if (
    c.requests !== e.observations ||
    !integer(c.nativeReadPackets, 5, 128) ||
    c.nativeReadPackets > c.requests ||
    c.controlsAfterAccepted !== 1 ||
    c.controlsAfterReplay !== 1 ||
    c.controlsFinal !== 2 ||
    c.cancelPackets !== 1 ||
    c.holdsBeforeLoss !== 2 ||
    c.holdsAfterLoss !== 2 ||
    c.holdsAfterSettlement !== 0
  )
    fail('INVALID_REPORT');
  group(k, [
    'serverListening',
    'brokerDispatched',
    'brokerQueued',
    'openRequestClients',
    'openServerSockets',
    'held',
    'ownedStoreRemoval',
  ]);
  if (
    k.serverListening !== false ||
    [
      k.brokerDispatched,
      k.brokerQueued,
      k.openRequestClients,
      k.openServerSockets,
      k.held,
    ].some((v) => v !== 0) ||
    k.ownedStoreRemoval !== 'completed'
  )
    fail('INVALID_REPORT');
  return JSON.parse(JSON.stringify(value));
}

function parseEvidence(report) {
  try {
    if (
      !plain(report) ||
      !Array.isArray(report.errors) ||
      report.errors.length ||
      !plain(report.stats) ||
      report.stats.expected !== 1 ||
      ['unexpected', 'flaky', 'skipped'].some((key) => report.stats[key] !== 0)
    )
      fail('INVALID_REPORT');
    const specs = [];
    let count = 0;
    function walk(suites, depth = 0) {
      if (!Array.isArray(suites) || depth > 8) fail('INVALID_REPORT');
      for (const suite of suites) {
        if (++count > 64 || !plain(suite)) fail('INVALID_REPORT');
        if (suite.specs) {
          if (!Array.isArray(suite.specs)) fail('INVALID_REPORT');
          specs.push(...suite.specs);
        }
        if (suite.suites) walk(suite.suites, depth + 1);
      }
    }
    walk(report.suites);
    if (specs.length !== 1) fail('INVALID_REPORT');
    const spec = specs[0];
    if (
      spec.file !== TEST_FILE ||
      spec.title !== TEST_TITLE ||
      spec.ok !== true ||
      !Array.isArray(spec.tests) ||
      spec.tests.length !== 1
    )
      fail('INVALID_REPORT');
    const test = spec.tests[0];
    if (
      test.expectedStatus !== 'passed' ||
      test.status !== 'expected' ||
      !Array.isArray(test.results) ||
      test.results.length !== 1
    )
      fail('INVALID_REPORT');
    const result = test.results[0];
    if (
      result.status !== 'passed' ||
      result.retry !== 0 ||
      result.workerIndex !== 0 ||
      result.error ||
      result.errors?.length ||
      !Array.isArray(result.attachments) ||
      result.attachments.length !== 2
    )
      fail('INVALID_REPORT');
    return ['HTTP', 'TLS'].map((protocol) => {
      const attachments = result.attachments.filter(
        (a) => a.name === `runtime-${protocol}-checkpoints`,
      );
      if (attachments.length !== 1) fail('INVALID_REPORT');
      const attachment = attachments[0];
      if (
        attachment.contentType !== 'application/json' ||
        attachment.path !== undefined ||
        typeof attachment.body !== 'string' ||
        attachment.body.length > 5464 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          attachment.body,
        )
      )
        fail('INVALID_REPORT');
      const body = JSON.parse(
        Buffer.from(attachment.body, 'base64').toString('utf8'),
      );
      if (Buffer.from(attachment.body, 'base64').length > 4096)
        fail('INVALID_REPORT');
      if (
        !exactKeys(body, ['protocol', 'checkpoints', 'outcome', 'telemetry']) ||
        body.protocol !== protocol ||
        body.outcome !== 'PASS' ||
        !Array.isArray(body.checkpoints) ||
        body.checkpoints.length !== CHECKPOINTS.length ||
        !CHECKPOINTS.every(
          (checkpoint, index) => body.checkpoints[index] === checkpoint,
        )
      )
        fail('INVALID_REPORT');
      return {
        protocol,
        checkpoints: [...CHECKPOINTS],
        outcome: 'PASS',
        telemetry: parseProtocolTelemetry(body.telemetry, protocol),
      };
    });
  } catch {
    fail('INVALID_REPORT');
  }
}

function evidenceBase(plan) {
  // Only validated, bounded nonsecret provenance. HEAD/tree are root expectations;
  // the separate immutable manifest verifies on-disk bytes without a git child.
  return {
    schema: 1,
    status: 'UNPROVEN',
    reason: 'NOT_RUN',
    protocols: [],
    platform: plan.platform,
    arch: plan.arch,
    image: plan.image,
    expectedHead: plan.expectedHead,
    expectedTree: plan.expectedTree,
    sourceManifestSHA256: plan.sourceManifestSHA256,
    nodeVersion: plan.node.version,
    nodeSHA256: plan.node.sha256,
    cliSHA256: plan.cliSHA256,
    lockSHA256: plan.lockSHA256,
    certSHA256: CERT_SHA256,
    runURL: `https://github.com/${plan.repository}/actions/runs/${plan.runId}/attempts/${plan.attempt}`,
    jobId: plan.jobId,
    endpointLabel: 'runner-owned-v4',
  };
}

// Error-only, finite observations. These helpers perform no runtime I/O.
const CHILD_FAILURE_ENUMS = {
  origin: new Set([
    'CHILD_FAILED',
    'CHILD_NO_CLOSE',
    'CHILD_TIMEOUT',
    'CHILD_OUTPUT_LIMIT',
    'CHILD_CANCELLED',
    'CHILD_SPAWN_FAILED',
    'CHILD_LOG_FAILED',
  ]),
  disposition: new Set(['RETURNED', 'REJECTED', 'UNKNOWN']),
  signal: new Set([
    'SIGTERM',
    'SIGKILL',
    'SIGINT',
    'SIGHUP',
    'SIGQUIT',
    'SIGABRT',
    'SIGBUS',
    'SIGFPE',
    'SIGILL',
    'SIGPIPE',
    'SIGSEGV',
    'SIGUSR1',
    'SIGUSR2',
    'SIGBREAK',
    'SIGALRM',
    'SIGTRAP',
    'UNKNOWN',
  ]),
  reason: new Set([
    'TIMEOUT',
    'OUTPUT_LIMIT',
    'CANCELLED',
    'SPAWN_FAILED',
    'LOG_FAILED',
    'UNKNOWN',
  ]),
  reporter: new Set(['EMPTY', 'VALID', 'INVALID', 'UNAVAILABLE']),
  scan: new Set(['COMPLETE', 'LIMIT', 'UNKNOWN']),
  name: new Set([
    'Error',
    'TypeError',
    'SyntaxError',
    'RangeError',
    'ReferenceError',
    'AssertionError',
    'TimeoutError',
    'AggregateError',
    'UNKNOWN',
  ]),
  code: new Set([
    'ERR_MODULE_NOT_FOUND',
    'MODULE_NOT_FOUND',
    'ERR_PACKAGE_PATH_NOT_EXPORTED',
    'ERR_REQUIRE_ESM',
    'ERR_UNKNOWN_FILE_EXTENSION',
    'ERR_UNSUPPORTED_DIR_IMPORT',
    'ERR_ASSERTION',
    'ENOENT',
    'EACCES',
    'EPERM',
    'EADDRINUSE',
    'EADDRNOTAVAIL',
    'ETIMEDOUT',
    'UNKNOWN',
  ]),
  file: new Set([
    'TEST',
    'REMOTE_FIXTURE',
    'MODULE_HELPER',
    'REQUEST_HELPER',
    'UNKNOWN',
  ]),
};
const FAILURE_FILES = {
  TEST: TEST_FILE,
  REMOTE_FIXTURE: 'tests/helpers/api-music-remote-http.ts',
  MODULE_HELPER: 'tests/helpers/api-music-source.ts',
  REQUEST_HELPER: 'tests/helpers/api-music-request.ts',
};
const FAILURE_STATUSES = new Map([
  ['passed', 1],
  ['failed', 2],
  ['timedOut', 4],
  ['skipped', 8],
  ['interrupted', 16],
]);
const failureInteger = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

function failureReader() {
  const snapshots = new WeakMap();
  const snapshot = (value) => {
    if (value === null || typeof value !== 'object') return null;
    if (snapshots.has(value)) return snapshots.get(value);
    const state = {
      valid: false,
      array: false,
      fields: new Map(),
      keys: undefined,
    };
    snapshots.set(value, state);
    try {
      const prototype = Object.getPrototypeOf(value);
      state.array = Array.isArray(value);
      state.valid =
        prototype === null ||
        prototype === (state.array ? Array.prototype : Object.prototype);
    } catch {
      /* A proxy trap is not an observation. */
    }
    return state;
  };
  const data = (value, key) => {
    const state = snapshot(value);
    if (!state?.valid) return { state: 'INVALID' };
    if (state.fields.has(key)) return state.fields.get(key);
    let field = { state: 'INVALID' };
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) field = { state: 'ABSENT' };
      else if (Object.hasOwn(descriptor, 'value'))
        field = { state: 'DATA', value: descriptor.value };
    } catch {
      /* Cache invalid presence; never retry a stateful trap. */
    }
    state.fields.set(key, field);
    return field;
  };
  const record = (value) => {
    const state = snapshot(value);
    return state?.valid === true && !state.array;
  };
  const array = (value) => {
    const state = snapshot(value);
    return state?.valid === true && state.array;
  };
  const exact = (value, expected) => {
    const state = snapshot(value);
    if (!record(value)) return false;
    if (state.keys === undefined) {
      try {
        state.keys = Reflect.ownKeys(value);
      } catch {
        state.keys = null;
      }
    }
    return (
      Array.isArray(state.keys) &&
      state.keys.length === expected.length &&
      state.keys.every(
        (key) => typeof key === 'string' && expected.includes(key),
      ) &&
      expected.every((key) => data(value, key).state === 'DATA')
    );
  };
  return { data, record, array, exact };
}

function unknownChildFailure(origin, disposition) {
  return {
    version: 1,
    origin: CHILD_FAILURE_ENUMS.origin.has(origin) ? origin : 'CHILD_FAILED',
    disposition: CHILD_FAILURE_ENUMS.disposition.has(disposition)
      ? disposition
      : 'UNKNOWN',
    child: { closed: null, code: null, signal: 'UNKNOWN', reason: 'UNKNOWN' },
    reporter: 'UNAVAILABLE',
    scan: 'UNKNOWN',
    target: { specs: null, tests: null, results: null, statusMask: null },
    errors: { root: null, target: null },
    first: null,
  };
}

function validateChildFailure(value) {
  try {
    const reader = failureReader(),
      get = (record, key) => reader.data(record, key).value;
    const requireRecord = (record, keys) => {
      if (!reader.exact(record, keys)) throw Error();
    };
    requireRecord(value, [
      'version',
      'origin',
      'disposition',
      'child',
      'reporter',
      'scan',
      'target',
      'errors',
      'first',
    ]);
    const version = get(value, 'version'),
      origin = get(value, 'origin'),
      disposition = get(value, 'disposition'),
      child = get(value, 'child'),
      reporter = get(value, 'reporter'),
      scan = get(value, 'scan'),
      target = get(value, 'target'),
      errors = get(value, 'errors'),
      first = get(value, 'first');
    if (
      version !== 1 ||
      !CHILD_FAILURE_ENUMS.origin.has(origin) ||
      !CHILD_FAILURE_ENUMS.disposition.has(disposition) ||
      !CHILD_FAILURE_ENUMS.reporter.has(reporter) ||
      !CHILD_FAILURE_ENUMS.scan.has(scan)
    )
      throw Error();
    requireRecord(child, ['closed', 'code', 'signal', 'reason']);
    requireRecord(target, ['specs', 'tests', 'results', 'statusMask']);
    requireRecord(errors, ['root', 'target']);
    const c = {
      closed: get(child, 'closed'),
      code: get(child, 'code'),
      signal: get(child, 'signal'),
      reason: get(child, 'reason'),
    };
    if (
      ![true, false, null].includes(c.closed) ||
      !(c.code === null || failureInteger(c.code, -2147483648, 4294967295)) ||
      !(c.signal === null || CHILD_FAILURE_ENUMS.signal.has(c.signal)) ||
      !(c.reason === null || CHILD_FAILURE_ENUMS.reason.has(c.reason))
    )
      throw Error();
    const t = {
        specs: get(target, 'specs'),
        tests: get(target, 'tests'),
        results: get(target, 'results'),
        statusMask: get(target, 'statusMask'),
      },
      e = { root: get(errors, 'root'), target: get(errors, 'target') };
    for (const n of [t.specs, t.tests, t.results, e.root, e.target])
      if (!(n === null || failureInteger(n, 0, 64))) throw Error();
    if (!(t.statusMask === null || failureInteger(t.statusMask, 0, 31)))
      throw Error();
    let f = null;
    if (first !== null) {
      requireRecord(first, ['name', 'code', 'file', 'line', 'column']);
      f = {
        name: get(first, 'name'),
        code: get(first, 'code'),
        file: get(first, 'file'),
        line: get(first, 'line'),
        column: get(first, 'column'),
      };
      if (
        !CHILD_FAILURE_ENUMS.name.has(f.name) ||
        !CHILD_FAILURE_ENUMS.code.has(f.code) ||
        !CHILD_FAILURE_ENUMS.file.has(f.file)
      )
        throw Error();
      if (
        f.file === 'UNKNOWN'
          ? f.line !== null || f.column !== null
          : !failureInteger(f.line, 1, 1000000) ||
            !failureInteger(f.column, 1, 1000000)
      )
        throw Error();
    }
    const aggregates = [
      t.specs,
      t.tests,
      t.results,
      t.statusMask,
      e.root,
      e.target,
    ];
    if (scan === 'COMPLETE') {
      if (
        reporter !== 'VALID' ||
        aggregates.includes(null) ||
        e.root + e.target > 64
      )
        throw Error();
      if (
        (t.specs === 0 && (t.tests || t.results || t.statusMask || e.target)) ||
        (t.tests === 0 && (t.results || t.statusMask || e.target)) ||
        (t.results === 0 && (t.statusMask || e.target)) ||
        (t.results > 0 && t.statusMask === 0)
      )
        throw Error();
      let bits = t.statusMask,
        popcount = 0;
      while (bits) {
        popcount += bits & 1;
        bits >>>= 1;
      }
      if (popcount > t.results) throw Error();
      if (f !== null && e.root + e.target === 0) throw Error();
    } else if (aggregates.some((n) => n !== null) || f !== null) throw Error();
    if ((reporter === 'EMPTY' || reporter === 'INVALID') && scan !== 'UNKNOWN')
      throw Error();
    if (reporter === 'UNAVAILABLE' && scan === 'COMPLETE') throw Error();
    if (
      disposition !== 'RETURNED' &&
      (c.closed !== null ||
        c.code !== null ||
        c.signal !== 'UNKNOWN' ||
        c.reason !== 'UNKNOWN' ||
        reporter !== 'UNAVAILABLE' ||
        scan !== 'UNKNOWN')
    )
      throw Error();
    const canonical = {
      version,
      origin,
      disposition,
      child: c,
      reporter,
      scan,
      target: t,
      errors: e,
      first: f,
    };
    if (Buffer.byteLength(JSON.stringify(canonical)) > 1024) throw Error();
    return canonical;
  } catch {
    fail('INVALID_CHILD_FAILURE');
  }
}

function failureSites(sourceRoot) {
  const sites = new Map();
  for (const [label, relative] of Object.entries(FAILURE_FILES))
    sites.set(relative, label);
  if (
    typeof sourceRoot !== 'string' ||
    sourceRoot.length > 2048 ||
    /[\x00-\x1f]/.test(sourceRoot)
  )
    return sites;
  const backslash = String.fromCharCode(92),
    windows = /^[A-Za-z]:[\\/]/.test(sourceRoot);
  if (
    !windows &&
    (!sourceRoot.startsWith('/') || sourceRoot.includes(backslash))
  )
    return sites;
  const base = sourceRoot.replace(/[\\/]$/, '');
  for (const [label, relative] of Object.entries(FAILURE_FILES)) {
    const absolute = (base + '/' + relative).split(backslash).join('/');
    sites.set(absolute, label);
    if (windows) sites.set(absolute.split('/').join(backslash), label);
    try {
      const url = new URL('file://');
      url.pathname = (windows ? '/' : '') + absolute.replaceAll('%', '%25');
      sites.set(url.href, label);
    } catch {
      /* Unknown spelling remains unknown. */
    }
  }
  return sites;
}

function firstFailureFacts(error, reader, sites) {
  const result = {
    name: 'UNKNOWN',
    code: 'UNKNOWN',
    file: 'UNKNOWN',
    line: null,
    column: null,
  };
  if (!reader.record(error)) return result;
  const named = reader.data(error, 'name'),
    coded = reader.data(error, 'code'),
    stacked = reader.data(error, 'stack'),
    location = reader.data(error, 'location');
  if (named.state === 'DATA' && CHILD_FAILURE_ENUMS.name.has(named.value))
    result.name = named.value;
  if (coded.state === 'DATA' && CHILD_FAILURE_ENUMS.code.has(coded.value))
    result.code = coded.value;
  const stack =
    stacked.state === 'DATA' && typeof stacked.value === 'string'
      ? Buffer.from(stacked.value, 'utf8')
      : null;
  if (stack && named.state === 'ABSENT' && coded.state === 'ABSENT') {
    const newline = stack.indexOf(10),
      length = newline < 0 ? stack.length : newline;
    if (length <= 256) {
      let header = stack.subarray(0, length).toString('utf8');
      if (header.endsWith('\r')) header = header.slice(0, -1);
      const match =
        /^(Error|TypeError|SyntaxError|RangeError|ReferenceError|AssertionError|TimeoutError|AggregateError)(?: \[([A-Z_]+)\])?:(?:[ \t]|$)/.exec(
          header,
        );
      if (
        match &&
        (!match[2] ||
          (match[2] !== 'UNKNOWN' && CHILD_FAILURE_ENUMS.code.has(match[2])))
      ) {
        result.name = match[1];
        result.code = match[2] || 'UNKNOWN';
      }
    }
  }
  const accept = (file, line, column) => {
    if (
      typeof file === 'string' &&
      sites.has(file) &&
      failureInteger(line, 1, 1000000) &&
      failureInteger(column, 1, 1000000)
    ) {
      result.file = sites.get(file);
      result.line = line;
      result.column = column;
      return true;
    }
    return false;
  };
  if (location.state !== 'ABSENT') {
    if (location.state === 'DATA' && reader.record(location.value))
      accept(
        reader.data(location.value, 'file').value,
        reader.data(location.value, 'line').value,
        reader.data(location.value, 'column').value,
      );
    return result;
  }
  if (!stack) return result;
  const bounded = stack.subarray(0, 8192),
    firstNewline = bounded.indexOf(10);
  if (firstNewline < 0) return result;
  let start = firstNewline + 1,
    scanned = 0;
  while (start < bounded.length && scanned < 32) {
    const newline = bounded.indexOf(10, start);
    if (newline < 0 && stack.length > bounded.length) break;
    const end = newline < 0 ? bounded.length : newline;
    const bytes = bounded.subarray(start, end);
    scanned++;
    start = end + 1;
    if (bytes.length > 512) continue;
    let line = bytes.toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.startsWith('    at ')) continue;
    let body = line.slice(7);
    if (body.endsWith(')')) {
      const open = body.lastIndexOf(' (');
      if (open < 1 || open > 128 || /[()\x00-\x1f]/.test(body.slice(0, open)))
        continue;
      body = body.slice(open + 2, -1);
    } else if (/[()\x00-\x1f]/.test(body)) continue;
    const match = /^(.*):([0-9]{1,7}):([0-9]{1,7})$/.exec(body);
    if (match && accept(match[1], Number(match[2]), Number(match[3]))) break;
  }
  return result;
}

function summarizeChildFailure(origin, disposition, child, sourceRoot) {
  const summary = unknownChildFailure(origin, disposition);
  try {
    if (summary.disposition !== 'RETURNED') return summary;
    const reader = failureReader(),
      data = (value, key) => reader.data(value, key);
    const closed = data(child, 'closed'),
      code = data(child, 'code'),
      signal = data(child, 'signal'),
      reason = data(child, 'reason');
    summary.child = {
      closed:
        closed.state === 'DATA' && typeof closed.value === 'boolean'
          ? closed.value
          : null,
      code:
        code.state === 'DATA' &&
        failureInteger(code.value, -2147483648, 4294967295)
          ? code.value
          : null,
      signal:
        signal.state === 'DATA' &&
        (signal.value === null || CHILD_FAILURE_ENUMS.signal.has(signal.value))
          ? signal.value
          : 'UNKNOWN',
      reason:
        reason.state === 'DATA' &&
        (reason.value === null || CHILD_FAILURE_ENUMS.reason.has(reason.value))
          ? reason.value
          : 'UNKNOWN',
    };
    // Owned close is required before inspecting any captured reporter bytes.
    if (summary.child.closed !== true) return summary;
    const stdout = data(child, 'stdout');
    if (stdout.state !== 'DATA' || typeof stdout.value !== 'string')
      return summary;
    if (Buffer.byteLength(stdout.value) > MAX_OUTPUT) {
      summary.scan = 'LIMIT';
      return summary;
    }
    if (/^[ \t\r\n]*$/.test(stdout.value)) {
      summary.reporter = 'EMPTY';
      return summary;
    }
    let report;
    try {
      report = JSON.parse(stdout.value);
    } catch {
      summary.reporter = 'INVALID';
      return summary;
    }
    summary.reporter = 'VALID';
    const limit = Symbol('LIMIT'),
      invalid = Symbol('UNKNOWN');
    const arrayValues = (value) => {
      if (!reader.array(value)) throw invalid;
      const length = data(value, 'length');
      if (length.state !== 'DATA' || !failureInteger(length.value, 0, 64)) {
        if (
          length.state === 'DATA' &&
          failureInteger(length.value, 65, Number.MAX_SAFE_INTEGER)
        )
          throw limit;
        throw invalid;
      }
      const values = [];
      for (let i = 0; i < length.value; i++) {
        const field = data(value, String(i));
        if (field.state !== 'DATA') throw invalid;
        values.push(field.value);
      }
      return values;
    };
    const arrayField = (value, key, optional = false) => {
      const field = data(value, key);
      if (optional && field.state === 'ABSENT') return [];
      if (field.state !== 'DATA') throw invalid;
      return arrayValues(field.value);
    };
    const record = (value) => {
      if (!reader.record(value)) throw invalid;
    };
    const counters = { suites: 0, specs: 0, tests: 0, results: 0, errors: 0 },
      increment = (key, n = 1) => {
        counters[key] += n;
        if (counters[key] > 64) throw limit;
      };
    try {
      record(report);
      const rootErrors = arrayField(report, 'errors');
      for (const error of rootErrors) record(error);
      increment('errors', rootErrors.length);
      const target = { specs: 0, tests: 0, results: 0, statusMask: 0 },
        errors = { root: rootErrors.length, target: 0 };
      let firstTarget = null;
      let firstTargetSelected = false;
      const stack = arrayField(report, 'suites')
        .map((suite) => ({ suite, depth: 0 }))
        .reverse();
      while (stack.length) {
        const { suite, depth } = stack.pop();
        if (depth > 8) throw limit;
        increment('suites');
        record(suite);
        for (const spec of arrayField(suite, 'specs', true)) {
          increment('specs');
          record(spec);
          const file = data(spec, 'file'),
            title = data(spec, 'title');
          if (
            file.state !== 'DATA' ||
            typeof file.value !== 'string' ||
            title.state !== 'DATA' ||
            typeof title.value !== 'string'
          )
            throw invalid;
          const matches =
            file.value === TEST_FILE && title.value === TEST_TITLE;
          if (matches) target.specs++;
          for (const test of arrayField(spec, 'tests')) {
            increment('tests');
            record(test);
            if (matches) target.tests++;
            for (const result of arrayField(test, 'results')) {
              increment('results');
              record(result);
              const status = data(result, 'status');
              if (
                status.state !== 'DATA' ||
                !FAILURE_STATUSES.has(status.value)
              )
                throw invalid;
              const formattedPresence = data(result, 'errors');
              const formatted = arrayField(result, 'errors', true);
              for (const error of formatted) record(error);
              const raw = data(result, 'error');
              if (raw.state === 'INVALID') throw invalid;
              const hasRaw =
                raw.state === 'DATA' &&
                raw.value !== null &&
                raw.value !== undefined;
              if (hasRaw) record(raw.value);
              const count =
                formattedPresence.state === 'ABSENT'
                  ? hasRaw
                    ? 1
                    : 0
                  : formatted.length;
              increment('errors', count);
              if (matches) {
                target.results++;
                target.statusMask |= FAILURE_STATUSES.get(status.value);
                errors.target += count;
                if (
                  !firstTargetSelected &&
                  ['failed', 'timedOut', 'interrupted'].includes(status.value)
                ) {
                  firstTargetSelected = true;
                  firstTarget = hasRaw ? raw.value : formatted[0] || null;
                }
              }
            }
          }
        }
        const children = arrayField(suite, 'suites', true);
        for (let i = children.length - 1; i >= 0; i--)
          stack.push({ suite: children[i], depth: depth + 1 });
      }
      summary.scan = 'COMPLETE';
      summary.target = target;
      summary.errors = errors;
      const first = firstTarget || rootErrors[0];
      summary.first =
        first && errors.root + errors.target > 0
          ? firstFailureFacts(first, reader, failureSites(sourceRoot))
          : null;
    } catch (error) {
      summary.scan = error === limit ? 'LIMIT' : 'UNKNOWN';
      summary.target = {
        specs: null,
        tests: null,
        results: null,
        statusMask: null,
      };
      summary.errors = { root: null, target: null };
      summary.first = null;
    }
    if (Buffer.byteLength(JSON.stringify(summary)) > 1024)
      return unknownChildFailure(origin, disposition);
    return summary;
  } catch {
    return unknownChildFailure(origin, disposition);
  }
}

async function runQualification(plan, deps) {
  try {
    validatePlan(plan);
  } catch {
    return {
      schema: 1,
      status: 'UNPROVEN',
      reason: 'INVALID_PLAN',
      protocols: [],
    };
  }
  const evidence = evidenceBase(plan);
  let directory, child;
  let childDisposition = 'UNKNOWN';
  let stage = 'PIN_MISMATCH';
  const checkCancellation = () => {
    if (deps.isCancelled?.()) {
      stage = 'CANCELLED';
      fail('CANCELLED');
    }
  };
  try {
    checkCancellation();
    await deps.verifyPins(plan);
    checkCancellation();
    stage = 'TOPOLOGY_UNAVAILABLE';
    // Exactly one runner inventory read. No fallback probes, DNS or other peers.
    const address = selectAssignedIPv4(deps.readInterfaces());
    checkCancellation();
    stage =
      plan.platform === 'win32'
        ? 'WINDOWS_PRIVATE_TEMP_UNPROVEN'
        : 'PRIVATE_TEMP_FAILED';
    directory = await deps.createPrivateTemp();
    checkCancellation();
    stage = 'ADMISSION_WRITE_FAILED';
    await deps.writeAdmission(directory, {
      environment: ENVIRONMENTS[plan.platform],
      bindAddress: address,
      clientAddress: address,
      certSHA256: CERT_SHA256,
    });
    checkCancellation();
    stage = 'CHILD_FAILED';
    childDisposition = 'REJECTED';
    child = await deps.execute({
      command: plan.node.path,
      args: [
        'node_modules/@playwright/test/cli.js',
        'test',
        TEST_FILE,
        '--grep',
        `(?:^| )${TEST_TITLE}$`,
        '--workers=1',
        '--retries=0',
        '--reporter=json',
        '--timeout=120000',
        '--global-timeout=120000',
        `--output=${directory}/playwright`,
      ],
      directory,
    });
    childDisposition = 'RETURNED';
    checkCancellation();
    if (!child.closed) {
      stage = 'CHILD_NO_CLOSE';
      fail('CHILD_FAILED');
    }
    if (
      child.reason &&
      [
        'TIMEOUT',
        'OUTPUT_LIMIT',
        'CANCELLED',
        'SPAWN_FAILED',
        'LOG_FAILED',
      ].includes(child.reason)
    )
      stage = 'CHILD_' + child.reason;
    if (child.code !== 0 || child.signal || child.reason) fail('CHILD_FAILED');
    stage = 'INVALID_REPORT';
    if (
      typeof child.stdout !== 'string' ||
      Buffer.byteLength(child.stdout) > MAX_OUTPUT
    )
      fail('INVALID_REPORT');
    evidence.protocols = parseEvidence(JSON.parse(child.stdout));
    evidence.status = 'PASS';
    evidence.reason = 'CHECKPOINTS_COMPLETE';
  } catch (error) {
    if (CHILD_FAILURE_ENUMS.origin.has(stage)) {
      try {
        const root = failureReader().data(deps, 'sourceRoot');
        evidence.childFailure = validateChildFailure(
          summarizeChildFailure(
            stage,
            childDisposition,
            child,
            root.state === 'DATA' ? root.value : undefined,
          ),
        );
      } catch {
        evidence.childFailure = unknownChildFailure(stage, childDisposition);
      }
    }
    // Only this fixed internal cleanup result may refine the stage. Never emit
    // filesystem error text, paths or diagnostics from an initialization fault.
    evidence.reason =
      ['PRIVATE_TEMP_FAILED', 'WINDOWS_PRIVATE_TEMP_UNPROVEN'].includes(
        stage,
      ) && error?.message === 'CLEANUP_FAILED'
        ? 'CLEANUP_FAILED'
        : stage;
    if (
      stage === 'WINDOWS_PRIVATE_TEMP_UNPROVEN' &&
      error?.code === 'WINDOWS_HELPER_NO_CLOSE'
    ) {
      evidence.reason = 'WINDOWS_HELPER_NO_CLOSE';
      evidence.cleanup = 'UNPROVEN';
      evidence.outerReapRequired = true;
    }
  } finally {
    if (directory) {
      try {
        await deps.removeTemp(directory);
      } catch {
        evidence.status = 'UNPROVEN';
        evidence.reason = 'CLEANUP_FAILED';
      }
    }
  }
  if (deps.isCancelled?.() && evidence.reason !== 'CLEANUP_FAILED') {
    evidence.status = 'UNPROVEN';
    evidence.reason = 'CANCELLED';
  }
  if (evidence.status !== 'PASS') evidence.protocols = [];
  return evidence;
}

// This adapter is also tested entirely with fake fs/clock/child/signal inputs.
// A no-close/abnormal result never qualifies cleanup of a CLI's descendants;
// the disposable job remains responsible for its final process/container reap.
function runOwnedChild(spec, io) {
  return new Promise((resolve) => {
    let child,
      done = false,
      reason = null,
      bytes = 0;
    const output = [];
    const fds = [],
      timers = new Set(),
      handlers = new Map();
    const later = (fn, ms) => {
      const id = io.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    };
    const finish = (closed, code = null, signal = null) => {
      if (done) return;
      done = true;
      for (const id of timers) io.clearTimeout(id);
      timers.clear();
      for (const [signalName, handler] of handlers)
        io.signalSource.removeListener(signalName, handler);
      for (const fd of fds) {
        try {
          io.fs.closeSync(fd);
        } catch {
          reason = 'LOG_FAILED';
        }
      }
      if (!closed) {
        child?.stdout?.destroy?.();
        child?.stderr?.destroy?.();
        child?.unref?.();
      }
      resolve({
        closed,
        code,
        signal,
        reason,
        stdout: Buffer.concat(output).toString('utf8'),
      });
    };
    const terminate = (why) => {
      if (done || reason) return;
      reason = why;
      for (const id of timers) io.clearTimeout(id);
      timers.clear();
      try {
        child?.kill('SIGTERM');
      } catch {
        /* Still bound the close wait. */
      }
      later(() => {
        if (done) return;
        try {
          child?.kill('SIGKILL');
        } catch {
          /* No cleanup claim without close. */
        }
        later(() => finish(false), KILL_MS);
      }, TERM_MS);
    };
    try {
      fds.push(io.fs.openSync(`${spec.directory}/stdout.raw`, 'wx', 0o600));
      fds.push(io.fs.openSync(`${spec.directory}/stderr.raw`, 'wx', 0o600));
      child = io.spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reason = 'SPAWN_FAILED';
      finish(true);
      return;
    }
    const consume = (index, chunk) => {
      if (done || reason) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + buffer.length > MAX_OUTPUT) {
        terminate('OUTPUT_LIMIT');
        return;
      }
      bytes += buffer.length;
      try {
        io.fs.writeSync(fds[index], buffer);
      } catch {
        terminate('LOG_FAILED');
        return;
      }
      if (index === 0) output.push(buffer);
    };
    child.stdout.on('data', (chunk) => consume(0, chunk));
    child.stderr.on('data', (chunk) => consume(1, chunk));
    child.stdout.on('error', () => terminate('LOG_FAILED'));
    child.stderr.on('error', () => terminate('LOG_FAILED'));
    child.once('error', () => terminate('SPAWN_FAILED'));
    child.once('close', (code, signal) => finish(true, code, signal));
    for (const signalName of ['SIGINT', 'SIGTERM']) {
      const handler = () => terminate('CANCELLED');
      handlers.set(signalName, handler);
      io.signalSource.on(signalName, handler);
    }
    later(() => terminate('TIMEOUT'), WALL_MS);
  });
}

async function verifyRuntimePins(plan, io) {
  const { path, cwd, readBounded, digest, realpath } = io;
  if (
    io.version !== plan.node.version ||
    io.platform !== plan.platform ||
    io.arch !== plan.arch ||
    (await realpath(io.execPath)) !== (await realpath(plan.node.path)) ||
    digest(await readBounded(plan.node.path, 256 * 1024 * 1024)) !==
      plan.node.sha256
  )
    fail('PIN_MISMATCH');
  const manifestBytes = await readBounded(
    path.join(cwd, 'api-music-runtime-manifest.json'),
  );
  if (digest(manifestBytes) !== plan.sourceManifestSHA256) fail('PIN_MISMATCH');
  const manifest = JSON.parse(manifestBytes);
  if (
    !plain(manifest) ||
    Object.keys(manifest).length < 7 ||
    Object.keys(manifest).length > 10_000
  )
    fail('PIN_MISMATCH');
  for (const [file, expected] of Object.entries(manifest)) {
    if (
      !/^[A-Za-z0-9_.@/-]+$/.test(file) ||
      path.isAbsolute(file) ||
      file.split('/').some((part) => !part || part === '..' || part === '.') ||
      !sha(expected)
    )
      fail('PIN_MISMATCH');
    const target = path.join(cwd, file);
    if (
      (await realpath(target)) !== target ||
      digest(await readBounded(target, 16 * 1024 * 1024)) !== expected
    )
      fail('PIN_MISMATCH');
  }
  for (const file of [
    TEST_FILE,
    'tests/helpers/api-music-remote-http.ts',
    'scripts/qualify-api-music-nonloopback.cjs',
    'scripts/api-music-windows-private-root.cjs',
    'pnpm-lock.yaml',
    'tests/fixtures/api-music-http-tls/cert.pem',
    'tests/fixtures/api-music-http-tls/key.pem',
  ])
    if (!Object.hasOwn(manifest, file)) fail('PIN_MISMATCH');
  if (
    digest(await readBounded(path.join(cwd, 'pnpm-lock.yaml'))) !==
      plan.lockSHA256 ||
    digest(
      await readBounded(path.join(cwd, 'node_modules/@playwright/test/cli.js')),
    ) !== plan.cliSHA256 ||
    digest(
      await readBounded(
        path.join(cwd, 'tests/fixtures/api-music-http-tls/cert.pem'),
      ),
    ) !== CERT_SHA256
  )
    fail('PIN_MISMATCH');
  const cliPackage = JSON.parse(
    await readBounded(
      path.join(cwd, 'node_modules/@playwright/test/package.json'),
    ),
  );
  if (cliPackage.version !== '1.61.1') fail('PIN_MISMATCH');
}

async function createPrivateTempDirectory(io) {
  const { fsp, path, runnerTemp, platform } = io;
  // chmod does not attest Windows DACLs. Only the admitted main selects the
  // fixed internal callback; direct users without it remain failed closed.
  // The callback verifies exactly its newly created owned root before return.
  if (
    platform === 'win32' &&
    typeof io.makeWindowsPrivateDirectory !== 'function'
  )
    fail('WINDOWS_PRIVATE_TEMP_UNPROVEN');
  const directory =
    platform === 'win32'
      ? await io.makeWindowsPrivateDirectory(runnerTemp)
      : await fsp.mkdtemp(path.join(runnerTemp, 'pear-music-nonloopback-'));
  if (
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    path.dirname(directory) !== path.resolve(runnerTemp) ||
    !path.basename(directory).startsWith('pear-music-nonloopback-')
  )
    fail('PRIVATE_TEMP_FAILED');
  try {
    if (platform !== 'win32') await fsp.chmod(directory, 0o700);
    await fsp.mkdir(path.join(directory, 'tmp'), { mode: 0o700 });
    return directory;
  } catch {
    await removeOwnedTemp(directory, {
      remove: (owned) =>
        fsp.rm(owned, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 100,
        }),
      setTimeout: io.setTimeout,
      clearTimeout: io.clearTimeout,
    });
    fail('PRIVATE_TEMP_FAILED');
  }
}

async function removeOwnedTemp(directory, io) {
  let timer;
  try {
    await Promise.race([
      io.remove(directory),
      new Promise((_, reject) => {
        timer = io.setTimeout(() => reject(Error('CLEANUP_FAILED')), 5000);
      }),
    ]);
  } finally {
    io.clearTimeout(timer);
  }
}

module.exports = {
  selectAssignedIPv4,
  validatePlan,
  parseEvidence,
  runQualification,
  runOwnedChild,
  verifyRuntimePins,
  createPrivateTempDirectory,
  removeOwnedTemp,
  summarizeChildFailure,
  validateChildFailure,
};

// Deliberate executable entry point. No action, including builtin imports, occurs
// at source import. Future root execution is distinct from source fake tests.
if (typeof require !== 'undefined' && require.main === module) {
  main().then(
    (evidence) => {
      process.stdout.write(JSON.stringify(evidence) + '\n');
      process.exitCode = evidence.status === 'PASS' ? 0 : 1;
    },
    () => {
      process.stdout.write(
        '{"schema":1,"status":"UNPROVEN","reason":"BOOTSTRAP_FAILED","protocols":[]}\n',
      );
      process.exitCode = 1;
    },
  );
}

async function main() {
  // Root must create a reviewed plan and immutable file manifest, not pass a
  // command, address, environment override, install action or output path.
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== '--execute-admitted-runner' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    fail('RUNNER_NOT_ADMITTED');
  const fs = require('node:fs');
  const fsp = fs.promises;
  const path = require('node:path');
  const crypto = require('node:crypto');
  const os = require('node:os');
  const childProcess = require('node:child_process');
  const cwd = path.resolve(__dirname, '..');
  const digest = (buffer) =>
    crypto.createHash('sha256').update(buffer).digest('hex');
  const readBounded = async (file, max = 2 * 1024 * 1024) => {
    const handle = await fsp.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > max) fail('PIN_MISMATCH');
      const buffer = await handle.readFile();
      if (buffer.length > max) fail('PIN_MISMATCH');
      return buffer;
    } finally {
      await handle.close();
    }
  };
  const plan = JSON.parse(await readBounded(process.argv[3], 16 * 1024));
  validatePlan(plan);
  const runnerTemp = process.env.RUNNER_TEMP;
  const systemRoot = process.env.SystemRoot;
  if (
    !runnerTemp ||
    !path.isAbsolute(runnerTemp) ||
    process.platform !== plan.platform ||
    process.arch !== plan.arch ||
    process.env.GITHUB_REPOSITORY !== plan.repository ||
    process.env.GITHUB_RUN_ID !== plan.runId ||
    process.env.GITHUB_RUN_ATTEMPT !== plan.attempt ||
    process.env.ImageVersion !== plan.image
  )
    fail('RUNNER_NOT_ADMITTED');
  const deps = {
    sourceRoot: cwd,
    verifyPins: () =>
      verifyRuntimePins(plan, {
        path,
        cwd,
        readBounded,
        digest,
        realpath: (file) => fsp.realpath(file),
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
      }),
    readInterfaces: () => os.networkInterfaces(),
    createPrivateTemp: () =>
      createPrivateTempDirectory({
        fsp,
        path,
        runnerTemp,
        platform: process.platform,
        setTimeout,
        clearTimeout,
        makeWindowsPrivateDirectory:
          process.platform === 'win32'
            ? (parent) => {
                // Lazy, fixed source import after pin/topology checks. No command or
                // executable program comes from the plan, environment or caller.
                const {
                  createWindowsPrivateDirectory,
                } = require('./api-music-windows-private-root.cjs');
                return createWindowsPrivateDirectory(parent, {
                  fsp,
                  path,
                  systemRoot,
                  spawn: childProcess.spawn,
                  env: { PATH: path.dirname(plan.node.path) },
                  setTimeout,
                  clearTimeout,
                  signalSource: process,
                  removeOwnedTemp,
                  isCancelled: () => deps.isCancelled?.() === true,
                });
              }
            : undefined,
      }),
    writeAdmission: (directory, input) =>
      fsp.writeFile(
        path.join(directory, 'admission.json'),
        JSON.stringify(input),
        { flag: 'wx', mode: 0o600 },
      ),
    execute: (spec) => {
      // Do not inherit credentials, NODE_OPTIONS, report redirection or TLS trust
      // overrides. The public fixture CA/servername remains the sole TLS input.
      const env = {
        CI: '1',
        PATH: path.dirname(plan.node.path),
        TMPDIR: path.join(spec.directory, 'tmp'),
        TMP: path.join(spec.directory, 'tmp'),
        TEMP: path.join(spec.directory, 'tmp'),
        HOME: spec.directory,
        USERPROFILE: spec.directory,
        PEAR_MUSIC_RUNTIME_ADMISSION: path.join(
          spec.directory,
          'admission.json',
        ),
      };
      if (process.platform === 'win32') env.SystemRoot = systemRoot;
      return runOwnedChild(
        { ...spec, cwd, env },
        {
          spawn: childProcess.spawn,
          fs,
          setTimeout,
          clearTimeout,
          signalSource: process,
        },
      );
    },
    removeTemp: (directory) =>
      removeOwnedTemp(directory, {
        remove: (owned) =>
          fsp.rm(owned, {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 100,
          }),
        setTimeout,
        clearTimeout,
      }),
  };
  let cancelled = false;
  const markCancelled = () => {
    cancelled = true;
  };
  deps.isCancelled = () => cancelled;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, markCancelled);
  try {
    return await runQualification(plan, deps);
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.removeListener(signal, markCancelled);
  }
}
