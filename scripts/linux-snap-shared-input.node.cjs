// Snap shares linux-unpacked with the parallel AppImage, Flatpak and archives.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');

const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(
  builderRequire.resolve('app-builder-lib'),
);
const { SnapCoreLegacy } = appBuilderRequire('./targets/snap/coreLegacy');
const builderUtil = appBuilderRequire('builder-util');
const electronGet = appBuilderRequire('./util/electronGet');
const linuxTools = appBuilderRequire('./toolsets/linux');

test('template Snap excludes chrome-sandbox without deleting parallel targets input', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pear-snap-shared-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appOutDir = path.join(root, 'linux-unpacked');
  const stageDir = path.join(root, 'snap-stage');
  const templateDir = path.join(root, 'template');
  await Promise.all(
    [appOutDir, stageDir, templateDir].map((dir) => fs.mkdir(dir)),
  );
  const sandbox = path.join(appOutDir, 'chrome-sandbox');
  await fs.writeFile(sandbox, 'sandbox needed by the other targets', {
    mode: 0o4755,
  });
  await fs.writeFile(path.join(appOutDir, 'pear-desktop'), 'app');
  await fs.writeFile(path.join(templateDir, 'desktop-init.sh'), 'template');

  // Only tool acquisition and external compression are replaced. The actual
  // builder stages command.sh, enumerates inputs, and operates on real files.
  t.mock.method(electronGet, 'downloadBuilderToolset', async () => templateDir);
  t.mock.method(linuxTools, 'getAppImageTools', async () => ({
    mksquashfs: 'test-mksquashfs',
  }));
  const realExec = builderUtil.exec;
  let squashfsInputs;
  let parallelSandboxStat;
  t.mock.method(builderUtil, 'exec', async (file, args, options) => {
    if (file === 'chmod') return realExec(file, args, options);
    assert.equal(file, process.env.MKSQUASHFS_PATH || 'test-mksquashfs');
    squashfsInputs = args.slice(0, args.indexOf(path.join(root, 'app.snap')));
    // A concurrent target can read the common Electron tree at this boundary.
    parallelSandboxStat = await fs.stat(sandbox).then(
      () => 'present',
      (error) => error.code,
    );
    return '';
  });
  const snap = Object.create(SnapCoreLegacy.prototype);
  snap.helper = { maxIconPath: null };
  snap.packager = { executableName: 'pear-desktop' };
  await snap.buildWithTemplate({
    appOutDir,
    stageDir,
    snapArch: builderUtil.Arch.x64,
    artifactPath: path.join(root, 'app.snap'),
    compression: 'xz',
    hooksDir: null,
    extraAppArgs: ['--no-sandbox'],
  });

  assert.equal(parallelSandboxStat, 'present');
  assert.ok(squashfsInputs.includes(path.join(appOutDir, 'pear-desktop')));
  assert.ok(squashfsInputs.includes(path.join(stageDir, 'command.sh')));
  assert.ok(
    !squashfsInputs.includes(sandbox),
    'sandbox remains excluded from Snap',
  );
  assert.match(
    await fs.readFile(path.join(stageDir, 'command.sh'), 'utf8'),
    /--no-sandbox/,
  );
  assert.equal(
    await fs.readFile(sandbox, 'utf8'),
    'sandbox needed by the other targets',
  );
});
