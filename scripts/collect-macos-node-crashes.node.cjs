const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createMarker,
  collectReports,
} = require('./collect-macos-node-crashes.cjs');

const secret = 'DO_NOT_UPLOAD_PRIVATE_CANARY';
function report(now, patch = {}) {
  return {
    procName: 'node',
    procPath: '/private/' + secret + '/node',
    captureTime: new Date(now).toISOString(),
    cpuType: 'ARM-64',
    osVersion: { train: 'macOS 26.6.2', build: '25G83', private: secret },
    exception: {
      type: 'EXC_BAD_ACCESS',
      signal: 'SIGSEGV',
      rawCodes: [secret],
    },
    faultingThread: 0,
    threads: [
      {
        triggered: true,
        threadState: { private: secret },
        frames: [
          {
            imageIndex: 0,
            imageOffset: 123,
            symbol: 'v8::internal::Heap::CollectGarbage()',
            symbolLocation: 7,
            private: secret,
          },
        ],
      },
    ],
    usedImages: [
      { name: 'node', path: '/private/' + secret + '/node', private: secret },
    ],
    environment: { TOKEN: secret },
    commandLine: secret,
    applicationSpecificInformation: secret,
    ...patch,
  };
}
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'pear-node-crash-test-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'DiagnosticReports');
  const outputDirectory = path.join(root, 'output', 'native-node-crashes');
  const markerPath = path.join(root, 'marker.json');
  const now = Date.now();
  await fs.mkdir(directory);
  await fs.writeFile(
    markerPath,
    JSON.stringify({ schemaVersion: 1, startedAtMs: now - 1000 }),
  );
  const write = async (
    name,
    contents = JSON.stringify(report(now)),
    mtime = now,
  ) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, contents);
    await fs.utimes(file, mtime / 1000, mtime / 1000);
    return file;
  };
  const collect = (patch = {}) =>
    collectReports({
      directory,
      outputDirectory,
      markerPath,
      now: now + 1000,
      ...patch,
    });
  const outputs = async () => {
    const files = (await fs.readdir(outputDirectory)).sort();
    return Object.fromEntries(
      await Promise.all(
        files.map(async (name) => [
          name,
          await fs.readFile(path.join(outputDirectory, name), 'utf8'),
        ]),
      ),
    );
  };
  return {
    root,
    directory,
    outputDirectory,
    markerPath,
    now,
    write,
    collect,
    outputs,
  };
}

test('new Node report emits only the bounded native allowlist, including two-object Apple format', async (t) => {
  const f = await fixture(t);
  const header = { app_name: 'node', name: 'node', private: secret };
  const value = report(f.now);
  value.captureTime = value.captureTime
    .replace('T', ' ')
    .replace(/\.(\d{3})Z$/, (_, digits) => `.${digits}0 +0000`);
  await f.write(
    'node-new.ips',
    JSON.stringify(header) + '\n' + JSON.stringify(value),
  );
  const index = await f.collect();
  assert.equal(index.status, 'collected');
  assert.equal(index.noReports, false);
  assert.deepEqual(index.reports, ['node-001.json']);
  const files = await f.outputs();
  assert.equal(JSON.stringify(files).includes(secret), false);
  const sanitized = JSON.parse(files['node-001.json']);
  assert.deepEqual(sanitized, {
    schemaVersion: 1,
    process: { name: 'node', architecture: 'ARM-64' },
    os: { version: 'macOS 26.6.2', build: '25G83' },
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' },
    frames: [
      {
        binary: 'node',
        imageOffset: 123,
        symbol: 'v8::internal::Heap::CollectGarbage()',
        symbolOffset: 7,
      },
    ],
  });
});

test('single-object reports are accepted and repeated collection is byte-idempotent', async (t) => {
  const f = await fixture(t);
  await f.write('node-one.ips');
  const first = await f.collect();
  assert.equal(first.reports.length, 1);
  const files = await f.outputs();
  assert.deepEqual(await f.collect(), first);
  assert.deepEqual(await f.outputs(), files);
});

for (const problem of [
  'missing',
  'malformed',
  'symlink',
  'future',
  'oversized',
])
  test(`invalid marker (${problem}) admits no reports and emits a coded index`, async (t) => {
    const f = await fixture(t);
    await f.write('node-new.ips');
    await fs.unlink(f.markerPath);
    if (problem === 'malformed') await fs.writeFile(f.markerPath, secret);
    if (problem === 'symlink')
      await fs.symlink(path.join(f.directory, 'node-new.ips'), f.markerPath);
    if (problem === 'future')
      await fs.writeFile(
        f.markerPath,
        JSON.stringify({ schemaVersion: 1, startedAtMs: f.now + 600000 }),
      );
    if (problem === 'oversized')
      await fs.writeFile(f.markerPath, 'x'.repeat(4096));
    const index = await f.collect();
    assert.equal(index.status, 'notAdmitted');
    assert.equal(index.noReports, true);
    assert.deepEqual(index.reports, []);
    assert.ok(['markerMissing', 'markerInvalid'].includes(index.reason));
    assert.deepEqual(Object.keys(await f.outputs()), ['index.json']);
  });

test('missing or unsafe diagnostic directories produce explicit absence/readFailure without paths', async (t) => {
  const f = await fixture(t);
  await fs.rmdir(f.directory);
  let index = await f.collect();
  assert.equal(index.noReports, true);
  assert.equal(index.readFailure.directoryMissing, 1);
  await fs.symlink(f.root, f.directory);
  index = await f.collect();
  assert.equal(index.readFailure.directoryUnsafe, 1);
  assert.equal(JSON.stringify(index).includes(f.root), false);
});

test('old timestamps and unrelated process identities cannot be admitted under a Node filename', async (t) => {
  const f = await fixture(t);
  await f.write(
    'node-old-file.ips',
    JSON.stringify(report(f.now)),
    f.now - 10000,
  );
  await f.write('node-old-capture.ips', JSON.stringify(report(f.now - 10000)));
  await f.write(
    'node-other.ips',
    JSON.stringify(report(f.now, { procName: 'Electron' })),
  );
  await f.write('Electron-new.ips');
  const index = await f.collect();
  assert.equal(index.noReports, true);
  assert.deepEqual(index.reports, []);
  assert.deepEqual(Object.keys(await f.outputs()), ['index.json']);
});

test('malformed, oversized and input symlink reports are rejected without following or leaking them', async (t) => {
  const f = await fixture(t);
  await f.write('node-malformed.ips', '{' + secret);
  await f.write('node-large.ips', secret + 'x'.repeat(1024 * 1024));
  const target = path.join(f.root, 'private.txt');
  await fs.writeFile(target, secret);
  await fs.symlink(target, path.join(f.directory, 'node-linked.ips'));
  const index = await f.collect();
  assert.equal(index.noReports, true);
  assert.equal(index.readFailure.reportMalformed, 1);
  assert.equal(index.readFailure.reportOversized, 1);
  assert.equal(index.readFailure.reportUnsafe, 1);
  assert.equal(JSON.stringify(await f.outputs()).includes(secret), false);
  assert.equal(await fs.readFile(target, 'utf8'), secret);
});

test('schema validation rejects header disagreement, malformed thread/image data and invalid exception types', async (t) => {
  const f = await fixture(t);
  await f.write(
    'node-header.ips',
    JSON.stringify({ app_name: 'Electron' }) +
      '\n' +
      JSON.stringify(report(f.now)),
  );
  await f.write(
    'node-thread.ips',
    JSON.stringify(report(f.now, { faultingThread: 2 })),
  );
  await f.write(
    'node-image.ips',
    JSON.stringify(report(f.now, { usedImages: 'not-an-array' })),
  );
  await f.write(
    'node-exception.ips',
    JSON.stringify(
      report(f.now, { exception: { type: secret, signal: secret } }),
    ),
  );
  const index = await f.collect();
  assert.equal(index.noReports, true);
  assert.equal(index.readFailure.reportSchema, 4);
  assert.equal(JSON.stringify(await f.outputs()).includes(secret), false);
});

test('frames cannot carry paths, arbitrary objects or data from non-triggered threads', async (t) => {
  const f = await fixture(t);
  const value = report(f.now);
  value.threads.push({
    triggered: false,
    frames: [{ symbol: secret, imageIndex: 0 }],
  });
  value.threads[0].frames.push({
    imageIndex: 0,
    imageOffset: { secret },
    symbol: '/private/' + secret,
  });
  value.usedImages[0].name = '/private/' + secret;
  await f.write('node-frames.ips', JSON.stringify(value));
  const index = await f.collect();
  assert.equal(index.reports.length, 1);
  const files = await f.outputs();
  assert.equal(JSON.stringify(files).includes(secret), false);
  for (const frame of JSON.parse(files['node-001.json']).frames)
    assert.ok(!frame.binary || !/[\\/]/.test(frame.binary));
});

test('files, frames, strings, scanning and total output have hard bounds', async (t) => {
  const f = await fixture(t);
  const value = report(f.now);
  value.threads[0].frames = Array.from({ length: 1000 }, () => ({
    imageIndex: 0,
    imageOffset: 1,
    symbol: 'A'.repeat(200),
  }));
  for (let i = 0; i < 12; i++)
    await f.write(
      `node-${String(i).padStart(3, '0')}.ips`,
      JSON.stringify(value),
    );
  const index = await f.collect();
  assert.ok(index.reports.length > 0 && index.reports.length <= 4);
  assert.equal(index.truncated, true);
  const files = await f.outputs();
  assert.ok(
    Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0) <= 65536,
  );
  for (const [name, contents] of Object.entries(files)) {
    if (name === 'index.json') continue;
    const saved = JSON.parse(contents);
    assert.ok(saved.frames.length <= 32);
    for (const frame of saved.frames)
      assert.ok(!frame.symbol || frame.symbol.length <= 160);
  }
});

for (const target of ['output-parent', 'output-directory', 'output-index'])
  test(`output symlink (${target}) cannot redirect writes outside the owned directory`, async (t) => {
    const f = await fixture(t);
    await f.write('node-new.ips');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    if (target === 'output-parent')
      await fs.symlink(outside, path.dirname(f.outputDirectory));
    else {
      await fs.mkdir(path.dirname(f.outputDirectory));
      if (target === 'output-directory')
        await fs.symlink(outside, f.outputDirectory);
      else {
        await fs.mkdir(f.outputDirectory);
        await fs.symlink(
          path.join(outside, 'private.txt'),
          path.join(f.outputDirectory, 'index.json'),
        );
      }
    }
    const index = await f.collect();
    assert.equal(index.status, 'outputUnavailable');
    assert.deepEqual(await fs.readdir(outside), []);
  });

test('marker creation is exclusive and cannot follow or overwrite another file', async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.markerPath, 'utf8');
  const result = await createMarker(f.markerPath, f.now);
  assert.equal(result.code, 'markerUnavailable');
  assert.equal(await fs.readFile(f.markerPath, 'utf8'), original);
});

test('marker creation records only its bounded timestamp and schema', async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.markerPath);
  assert.equal((await createMarker(f.markerPath, f.now)).code, 'markerCreated');
  assert.deepEqual(JSON.parse(await fs.readFile(f.markerPath, 'utf8')), {
    schemaVersion: 1,
    startedAtMs: f.now,
  });
});

test('directory scanning terminates at its entry bound even with unrelated files', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 300; i++) await f.write(`unrelated-${i}.ips`, secret);
  const index = await f.collect();
  assert.equal(index.noReports, true);
  assert.equal(index.truncated, true);
});

test('hard links and malformed UTF-8 cannot expose a different file or raw decoding errors', async (t) => {
  const f = await fixture(t);
  const privateFile = path.join(f.root, 'private.txt');
  await fs.writeFile(privateFile, secret);
  await fs.link(privateFile, path.join(f.directory, 'node-hardlink.ips'));
  await f.write('node-utf8.ips', Buffer.from([0xff, 0xfe, 0xff]));
  const index = await f.collect();
  assert.equal(index.noReports, true);
  assert.equal(index.readFailure.reportUnsafe, 1);
  assert.equal(index.readFailure.reportReadFailure, 1);
  assert.equal(JSON.stringify(await f.outputs()).includes(secret), false);
});

test('a valid exception without usable native frames records explicit stack absence', async (t) => {
  const f = await fixture(t);
  const value = report(f.now);
  value.threads[0].frames = [];
  await f.write('node-without-stack.ips', JSON.stringify(value));
  const index = await f.collect();
  assert.equal(index.reports.length, 1);
  const saved = JSON.parse((await f.outputs())['node-001.json']);
  assert.equal(saved.stackUnavailable, true);
  assert.deepEqual(saved.frames, []);
});

test('workflow diagnostics remain Mac-only, failure-only and best-effort without masking normal test status', async () => {
  const workflow = await fs.readFile(
    path.join(__dirname, '../.github/workflows/tests.yml'),
    'utf8',
  );
  const step = (name) =>
    workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  const mark = step('Record macOS crash evidence boundary');
  const collect = step('Collect sanitized macOS Node crash evidence');
  const regression = step('Run macOS and Windows tests');
  assert.match(mark, /if: runner\.os == 'macOS'/);
  assert.match(mark, /continue-on-error: true/);
  assert.match(mark, /runner\.temp/);
  assert.match(
    collect,
    /always\(\).*runner\.os == 'macOS'.*steps\.regression\.outcome == 'failure'/,
  );
  assert.match(collect, /continue-on-error: true/);
  assert.match(collect, /test-results\/native-node-crashes/);
  assert.match(regression, /id: regression/);
  assert.match(regression, /run: node scripts\/run-ci-tests\.cjs/);
  assert.doesNotMatch(
    regression,
    /continue-on-error|retry|NODE_OPTIONS|--report/,
  );
  assert.ok(
    workflow.indexOf('Collect sanitized macOS Node crash evidence') <
      workflow.indexOf('Upload browser test evidence'),
  );
});

test('absence on a subsequent invocation retires only previously owned sanitized files', async (t) => {
  const f = await fixture(t);
  const source = await f.write('node-once.ips');
  assert.equal((await f.collect()).reports.length, 1);
  await fs.unlink(source);
  assert.equal((await f.collect()).noReports, true);
  assert.deepEqual(Object.keys(await f.outputs()), ['index.json']);
});

test('an expired marker and a nonabsolute or missing Node executable identity cannot admit reports', async (t) => {
  const f = await fixture(t);
  await f.write(
    'node-relative.ips',
    JSON.stringify(report(f.now, { procPath: 'node' })),
  );
  await f.write(
    'node-missing-path.ips',
    JSON.stringify(report(f.now, { procPath: undefined })),
  );
  assert.equal((await f.collect()).noReports, true);
  await f.write('node-valid.ips');
  await fs.writeFile(
    f.markerPath,
    JSON.stringify({
      schemaVersion: 1,
      startedAtMs: f.now - 7 * 60 * 60 * 1000,
    }),
  );
  const index = await f.collect();
  assert.equal(index.status, 'notAdmitted');
  assert.equal(index.reason, 'markerInvalid');
  assert.deepEqual(index.reports, []);
});
