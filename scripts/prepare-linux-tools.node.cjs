// Explicit Node contracts; keep out of Playwright's cross-platform discovery.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareLinuxTools } = require('./prepare-linux-tools.cjs');

const tools = Object.fromEntries(
  ['mksquashfs', 'desktopFileValidate', 'runtime', 'runtimeLibraries'].map(
    (k) => [k, path.resolve('/owned-tools', k)],
  ),
);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('non-Linux packaging does not resolve or initialize Linux dependencies', async () => {
  for (const platform of ['darwin', 'win32']) {
    await prepareLinuxTools({
      platform,
      loadDependencies() {
        throw Error('must not load');
      },
    });
  }
});

test('Linux preparation awaits the same graph helper using the current project and real Arch value', async () => {
  const pending = deferred(),
    calls = [];
  let finished = false;
  const work = prepareLinuxTools({
    platform: 'linux',
    projectDir: '/owned-project',
    loadDependencies: () => ({
      getConfig: async (...args) => {
        assert.equal(args[0], '/owned-project');
        return {};
      },
      getAppImageTools: (...args) => {
        calls.push(args);
        return pending.promise;
      },
      Arch: { x64: 'fixture-X64' },
    }),
  }).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['0.0.0', 'fixture-X64']]);
  assert.equal(finished, false);
  pending.resolve(tools);
  await work;
  assert.equal(finished, true);
});

test('Snap and a configured static AppImage toolset are initialized sequentially', async () => {
  const pending = deferred(),
    calls = [];
  const work = prepareLinuxTools({
    platform: 'linux',
    loadDependencies: () => ({
      getConfig: async () => ({ toolsets: { appimage: '1.0.0' } }),
      getAppImageTools: async (version) => {
        calls.push(version);
        return version === '0.0.0' ? pending.promise : tools;
      },
      Arch: { x64: 'fixture-X64' },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['0.0.0']);
  pending.resolve(tools);
  await work;
  assert.deepEqual(calls, ['0.0.0', '1.0.0']);
});

test('rejected or invalid preparation is fatal and never starts another toolset', async () => {
  for (const invalid of [null, {}, { ...tools, runtime: 'relative/runtime' }]) {
    const calls = [];
    await assert.rejects(
      prepareLinuxTools({
        platform: 'linux',
        loadDependencies: () => ({
          getConfig: async () => ({ toolsets: { appimage: '1.0.0' } }),
          getAppImageTools: async (version) => {
            calls.push(version);
            return invalid;
          },
          Arch: { x64: 'fixture-X64' },
        }),
      }),
      /invalid/i,
    );
    assert.deepEqual(calls, ['0.0.0']);
  }
  const failure = Error('owned warm failure');
  await assert.rejects(
    prepareLinuxTools({
      platform: 'linux',
      loadDependencies: () => ({
        getConfig: async () => ({}),
        getAppImageTools: async () => {
          throw failure;
        },
        Arch: { x64: 'fixture-X64' },
      }),
    }),
    (error) => error === failure,
  );
});

for (const fail of [false, true])
  test(`actual CLI and shell chain ${fail ? 'stop packaging on warm failure' : 'start packaging only after warm succeeds'}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pear-tool-warm-'));
    try {
      const record = path.join(directory, 'record.json'),
        marker = path.join(directory, 'builder-started');
      const preload = path.join(directory, 'ports.cjs');
      writeFileSync(
        preload,
        `
      // Select the Linux branch in this owned Node-only fixture on any host.
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const Module = require('node:module'), fs = require('node:fs');
      const original = Module._load;
      Module._load = function(id, ...args) {
        if (id === './out/util/config/config') return { getConfig: async () => ({}) };
        if (id === 'builder-util') return { Arch: { x64: 'owned-X64' } };
        if (id === './out/toolsets/linux') return { getAppImageTools: async (version, arch) => {
          await new Promise(r => setImmediate(r));
          fs.writeFileSync(process.env.PEAR_TEST_RECORD, JSON.stringify({ version, arch, cache: process.env.ELECTRON_BUILDER_CACHE, override: process.env.APPIMAGE_TOOLS_PATH }));
          if (process.env.PEAR_TEST_FAIL === 'yes') throw Error('owned CLI warm failure');
          return ${JSON.stringify(tools)};
        } };
        return original.call(this, id, ...args);
      };
    `,
      );
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          '"$PEAR_TEST_NODE" "$PEAR_TEST_PREPARE" && "$PEAR_TEST_NODE" -e \'require("node:fs").writeFileSync(process.env.PEAR_TEST_MARKER,"started")\'',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: `--require=${preload}`,
            PEAR_TEST_NODE: process.execPath,
            PEAR_TEST_PREPARE: path.join(__dirname, 'prepare-linux-tools.cjs'),
            PEAR_TEST_RECORD: record,
            PEAR_TEST_MARKER: marker,
            PEAR_TEST_FAIL: fail ? 'yes' : 'no',
            ELECTRON_BUILDER_CACHE: path.join(directory, 'same-cache'),
            APPIMAGE_TOOLS_PATH: path.join(directory, 'same-override'),
          },
        },
      );
      assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), {
        version: '0.0.0',
        arch: 'owned-X64',
        cache: path.join(directory, 'same-cache'),
        override: path.join(directory, 'same-override'),
      });
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      assert.equal(existsSync(marker), !fail);
      if (fail) assert.match(result.stderr, /owned CLI warm failure/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
