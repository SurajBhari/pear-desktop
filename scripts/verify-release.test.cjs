const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

// The public release contract, independent of the verifier's implementation.
function releaseFixture(directory) {
  const version = require('../package.json').version;
  const templates = [
    'YouTube-Music-V-arm64.AppImage',
    'YouTube-Music-V-arm64.dmg',
    'YouTube-Music-V-arm64.dmg.blockmap',
    'youtube-music-V-arm64.freebsd',
    'youtube-music-V-arm64.nsis.7z',
    'youtube-music-V-arm64.tar.gz',
    'YouTube-Music-V-armv7l.AppImage',
    'youtube-music-V-armv7l.freebsd',
    'youtube-music-V-armv7l.tar.gz',
    'youtube-music-V-ia32.nsis.7z',
    'youtube-music-V-x64.nsis.7z',
    'YouTube-Music-V-x86_64.flatpak',
    'youtube-music-V.aarch64.rpm',
    'YouTube-Music-V.AppImage',
    'YouTube-Music-V.dmg',
    'YouTube-Music-V.dmg.blockmap',
    'YouTube-Music-V.exe',
    'youtube-music-V.freebsd',
    'youtube-music-V.tar.gz',
    'youtube-music-V.x86_64.rpm',
    'YouTube-Music-Web-Setup-V.exe',
    'youtube-music_V_amd64.deb',
    'youtube-music_V_amd64.snap',
    'youtube-music_V_arm64.deb',
    'youtube-music_V_armv7l.deb',
    'YouTube-Music-V-mac.zip',
    'YouTube-Music-V-arm64-mac.zip',
    'YouTube-Music-V-mac.zip.blockmap',
    'YouTube-Music-V-arm64-mac.zip.blockmap',
    'YouTube-Music-Setup-V.exe',
    'YouTube-Music-Setup-V.exe.blockmap',
    'YouTube-Music-V-aarch64.flatpak',
  ];
  for (const template of templates)
    fs.writeFileSync(
      path.join(directory, template.replace('V', version)),
      template,
    );
  const installer = `YouTube-Music-Web-Setup-${version}.exe`;
  const record = (name) => {
    const body = fs.readFileSync(path.join(directory, name));
    return {
      url: name,
      path: name,
      size: body.length,
      sha512: crypto.createHash('sha512').update(body).digest('base64'),
    };
  };
  // Public v3.13.0 updater roles; DMG/deb/rpm metadata entries are optional.
  const roles = {
    'latest-linux-arm.yml': [`YouTube-Music-${version}-armv7l.AppImage`],
    'latest-linux-arm64.yml': [`YouTube-Music-${version}-arm64.AppImage`],
    'latest-linux.yml': [`YouTube-Music-${version}.AppImage`],
    'latest-mac.yml': [
      `YouTube-Music-${version}-mac.zip`,
      `YouTube-Music-${version}-arm64-mac.zip`,
    ],
    'latest.yml': [installer],
  };
  for (const [name, targets] of Object.entries(roles)) {
    const files = targets.map(record);
    const metadata = {
      version,
      files,
      path: files[0].url,
      sha512: files[0].sha512,
    };
    if (name === 'latest.yml')
      metadata.packages = Object.fromEntries(
        ['x64', 'ia32', 'arm64'].map((arch) => [
          arch,
          record(`youtube-music-${version}-${arch}.nsis.7z`),
        ]),
      );
    fs.writeFileSync(path.join(directory, name), JSON.stringify(metadata));
  }
  return { version, installer };
}

for (const template of [
  'YouTube-Music-Setup-V.exe',
  'YouTube-Music-Setup-V.exe.blockmap',
  'YouTube-Music-V-aarch64.flatpak',
]) {
  test(`verify requires ${template}`, () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pear-release-required-'),
    );
    try {
      const { version } = releaseFixture(directory);
      const missing = template.replace('V', version);
      fs.unlinkSync(path.join(directory, missing));
      const result = spawnSync(process.execPath, [
        path.join(__dirname, 'verify-release.cjs'),
        'verify',
        directory,
      ]);
      assert.notEqual(result.status, 0, 'Incomplete release must be rejected');
      assert.ok(
        result.stderr.toString().includes(`Missing/empty asset: ${missing}`),
        result.stderr.toString(),
      );
      assert.equal(fs.existsSync(path.join(directory, 'SHA256SUMS')), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('verify covers offline and ARM64 assets while retaining web updater metadata', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-release-complete-'),
  );
  try {
    const { version, installer } = releaseFixture(directory);
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'verify-release.cjs'),
      'verify',
      directory,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8');
    for (const name of [
      `YouTube-Music-Setup-${version}.exe`,
      `YouTube-Music-Setup-${version}.exe.blockmap`,
      `YouTube-Music-${version}-aarch64.flatpak`,
    ]) {
      const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(directory, name)))
        .digest('hex');
      assert.ok(sums.includes(`${digest}  ${name}\n`));
    }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'))
        .path,
      installer,
    );
    fs.appendFileSync(path.join(directory, installer), 'corruption');
    const corrupt = spawnSync(process.execPath, [
      path.join(__dirname, 'verify-release.cjs'),
      'verify',
      directory,
    ]);
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr.toString(), /Size mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stage includes NSIS web outputs while excluding unpacked app files', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-release-stage-'),
  );
  try {
    const source = path.join(directory, 'pack');
    const destination = path.join(directory, 'assets');
    fs.mkdirSync(path.join(source, 'nsis-web'), { recursive: true });
    fs.mkdirSync(path.join(source, 'win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(source, 'YouTube Music 3.12.1.exe'), 'portable');
    fs.writeFileSync(
      path.join(source, 'nsis-web', 'YouTube Music Web Setup 3.12.1.exe'),
      'installer',
    );
    fs.writeFileSync(path.join(source, 'nsis-web', 'latest.yml'), 'metadata');
    fs.writeFileSync(
      path.join(source, 'nsis-web', 'youtube-music-3.12.1-x64.nsis.7z'),
      'payload',
    );
    fs.writeFileSync(
      path.join(source, 'win-unpacked', 'YouTube Music.exe'),
      'application',
    );
    fs.writeFileSync(
      path.join(source, 'builder-effective-config.yaml'),
      'config',
    );
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'verify-release.cjs'),
      'stage',
      source,
      destination,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(
      fs.readdirSync(destination).sort(),
      [
        'YouTube-Music-3.12.1.exe',
        'YouTube-Music-Web-Setup-3.12.1.exe',
        'latest.yml',
        'youtube-music-3.12.1-x64.nsis.7z',
      ].sort(),
    );
    assert.equal(
      fs.readFileSync(
        path.join(destination, 'YouTube-Music-Web-Setup-3.12.1.exe'),
        'utf8',
      ),
      'installer',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stage rejects colliding names across root and NSIS outputs', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-release-collision-'),
  );
  try {
    const source = path.join(directory, 'pack');
    fs.mkdirSync(path.join(source, 'nsis-web'), { recursive: true });
    fs.writeFileSync(path.join(source, 'latest.yml'), 'one');
    fs.writeFileSync(path.join(source, 'nsis-web', 'latest.yml'), 'two');
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'verify-release.cjs'),
      'stage',
      source,
      path.join(directory, 'assets'),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /Asset name collision/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const [metadataName, target] of [
  ['latest-mac.yml', 'YouTube-Music-Web-Setup-V.exe'],
  ['latest-linux-arm64.yml', 'YouTube-Music-V.AppImage'],
  ['latest.yml', 'YouTube-Music-Setup-V.exe'],
]) {
  test(`verify rejects a hash-valid wrong updater role for ${metadataName}`, () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pear-release-role-'),
    );
    try {
      const { version } = releaseFixture(directory);
      const file = target.replace('V', version);
      const body = fs.readFileSync(path.join(directory, file));
      const sha512 = crypto.createHash('sha512').update(body).digest('base64');
      const metadata = JSON.parse(
        fs.readFileSync(path.join(directory, metadataName), 'utf8'),
      );
      metadata.files = [{ url: file, size: body.length, sha512 }];
      metadata.path = file;
      metadata.sha512 = sha512;
      fs.writeFileSync(
        path.join(directory, metadataName),
        JSON.stringify(metadata),
      );
      const result = spawnSync(process.execPath, [
        path.join(__dirname, 'verify-release.cjs'),
        'verify',
        directory,
      ]);
      assert.notEqual(
        result.status,
        0,
        'Hash validity cannot authorize a different updater role',
      );
      assert.match(result.stderr.toString(), /Invalid updater role/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  'wrong-windows-arm64-payload',
  'missing-windows-arm64-payload',
  'missing-mac-arm64-archive',
  'wrong-linux-primary',
]) {
  test(`verify rejects hash-valid incomplete or incompatible updater contract: ${scenario}`, () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pear-release-contract-'),
    );
    try {
      const { version } = releaseFixture(directory);
      const name = scenario.includes('windows')
        ? 'latest.yml'
        : scenario.includes('mac')
          ? 'latest-mac.yml'
          : 'latest-linux.yml';
      const metadata = JSON.parse(
        fs.readFileSync(path.join(directory, name), 'utf8'),
      );
      if (scenario === 'wrong-windows-arm64-payload')
        metadata.packages.arm64 = { ...metadata.packages.x64 };
      else if (scenario === 'missing-windows-arm64-payload')
        delete metadata.packages.arm64;
      else if (scenario === 'missing-mac-arm64-archive')
        metadata.files = metadata.files.filter(
          (file) => !file.url.includes('arm64'),
        );
      else {
        metadata.path = `youtube-music_${version}_amd64.deb`;
        metadata.sha512 = crypto
          .createHash('sha512')
          .update(fs.readFileSync(path.join(directory, metadata.path)))
          .digest('base64');
      }
      fs.writeFileSync(path.join(directory, name), JSON.stringify(metadata));
      const result = spawnSync(process.execPath, [
        path.join(__dirname, 'verify-release.cjs'),
        'verify',
        directory,
      ]);
      assert.notEqual(
        result.status,
        0,
        'A valid hash does not make this updater contract usable',
      );
      assert.match(result.stderr.toString(), /Invalid updater role/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
