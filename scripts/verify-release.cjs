// Check the complete fork desktop matrix before uploading a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const yaml = appBuilderRequire('js-yaml');
const { version } = require('../package.json');
const [mode, directory, destination] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const extensions = /\.(AppImage|dmg|blockmap|freebsd|7z|gz|flatpak|rpm|exe|deb|snap|zip|yml)$/;

if (mode === 'stage') {
  fs.mkdirSync(destination, { recursive: true });
  // Newer electron-builder versions place NSIS web output in its own folder.
  // Never recurse into unpacked app directories.
  const folders = [directory, path.join(directory, 'nsis-web')].filter(folder => fs.existsSync(folder));
  for (const folder of folders) for (const file of fs.readdirSync(folder)) {
    if (extensions.test(file) && !file.startsWith('builder-') && fs.lstatSync(path.join(folder, file)).isFile()) {
      // GitHub update metadata uses electron-builder's safeArtifactName.
      const safeName = file.replace(/ /g, '-');
      const target = path.join(destination, safeName);
      if (fs.existsSync(target)) fail(`Asset name collision: ${safeName}`);
      fs.copyFileSync(path.join(folder, file), target);
    }
  }
} else if (mode === 'verify') {
  const expected = [
    'latest-linux-arm.yml', 'latest-linux-arm64.yml', 'latest-linux.yml', 'latest-mac.yml', 'latest.yml',
    `YouTube-Music-${version}-arm64.AppImage`, `YouTube-Music-${version}-arm64.dmg`,
    `YouTube-Music-${version}-arm64.dmg.blockmap`, `youtube-music-${version}-arm64.freebsd`,
    `youtube-music-${version}-arm64.nsis.7z`, `youtube-music-${version}-arm64.tar.gz`,
    `YouTube-Music-${version}-armv7l.AppImage`, `youtube-music-${version}-armv7l.freebsd`,
    `youtube-music-${version}-armv7l.tar.gz`, `youtube-music-${version}-ia32.nsis.7z`,
    `youtube-music-${version}-x64.nsis.7z`, `YouTube-Music-${version}-x86_64.flatpak`,
    `youtube-music-${version}.aarch64.rpm`, `YouTube-Music-${version}.AppImage`,
    `YouTube-Music-${version}.dmg`, `YouTube-Music-${version}.dmg.blockmap`,
    `YouTube-Music-${version}.exe`, `youtube-music-${version}.freebsd`,
    `youtube-music-${version}.tar.gz`, `youtube-music-${version}.x86_64.rpm`,
    `YouTube-Music-Web-Setup-${version}.exe`, `youtube-music_${version}_amd64.deb`,
    `YouTube-Music-Setup-${version}.exe`, `YouTube-Music-Setup-${version}.exe.blockmap`,
    `YouTube-Music-${version}-aarch64.flatpak`,
    `youtube-music_${version}_amd64.snap`, `youtube-music_${version}_arm64.deb`,
    `youtube-music_${version}_armv7l.deb`,
    `YouTube-Music-${version}-mac.zip`, `YouTube-Music-${version}-arm64-mac.zip`,
    `YouTube-Music-${version}-mac.zip.blockmap`, `YouTube-Music-${version}-arm64-mac.zip.blockmap`,
  ];
  for (const file of expected) {
    const full = path.join(directory, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size === 0) fail(`Missing/empty asset: ${file}`);
  }
  const webInstaller = `YouTube-Music-Web-Setup-${version}.exe`;
  const macArchives = [`YouTube-Music-${version}-mac.zip`, `YouTube-Music-${version}-arm64-mac.zip`];
  const linuxRole = (suffix, debArch, rpmArch) => {
    const image = `YouTube-Music-${version}${suffix ? '-' + suffix : ''}.AppImage`;
    return {
      required: [image], primary: [image],
      allowed: [image, `youtube-music_${version}_${debArch}.deb`, ...(rpmArch ? [`youtube-music-${version}.${rpmArch}.rpm`] : [])],
    };
  };
  const roles = {
    'latest.yml': { required: [webInstaller], primary: [webInstaller], allowed: [webInstaller] },
    'latest-mac.yml': {
      required: macArchives, primary: macArchives,
      allowed: [...macArchives, `YouTube-Music-${version}.dmg`, `YouTube-Music-${version}-arm64.dmg`],
    },
    'latest-linux.yml': linuxRole('', 'amd64', 'x86_64'),
    'latest-linux-arm64.yml': linuxRole('arm64', 'arm64', 'aarch64'),
    'latest-linux-arm.yml': linuxRole('armv7l', 'armv7l'),
  };
  const checkRole = (name, metadata) => {
    const role = roles[name];
    if (!Array.isArray(metadata.files)) fail(`Invalid updater role: ${name}`);
    const names = metadata.files.map(file => file?.url);
    if (new Set(names).size !== names.length ||
      names.some(file => !role.allowed.includes(file)) ||
      role.required.some(file => !names.includes(file)) ||
      !role.primary.includes(metadata.path)) fail(`Invalid updater role: ${name}`);
    if (name === 'latest.yml') {
      const packages = metadata.packages;
      const arches = ['x64', 'ia32', 'arm64'];
      if (!packages || typeof packages !== 'object' || Array.isArray(packages) ||
        Object.keys(packages).length !== arches.length ||
        arches.some(arch => !Object.hasOwn(packages, arch) ||
          packages[arch]?.path !== `youtube-music-${version}-${arch}.nsis.7z`)) {
        fail(`Invalid updater role: ${name}`);
      }
    } else if (metadata.packages !== undefined) fail(`Invalid updater role: ${name}`);
  };
  const hash = (file, algorithm, encoding) => new Promise((resolve, reject) => {
    const digest = crypto.createHash(algorithm);
    fs.createReadStream(file).on('error', reject).on('data', chunk => digest.update(chunk))
      .on('end', () => resolve(digest.digest(encoding)));
  });
  const checkFile = async (name, metadata) => {
    if (typeof name !== 'string' || path.basename(name) !== name) fail(`Unsafe updater path: ${name}`);
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) fail(`Updater asset missing: ${name}`);
    if (metadata.size !== undefined && fs.statSync(file).size !== metadata.size) fail(`Size mismatch: ${name}`);
    if (!metadata.sha512 || await hash(file, 'sha512', 'base64') !== metadata.sha512) fail(`SHA512 mismatch: ${name}`);
  };
  (async () => {
    for (const name of expected.filter(file => file.endsWith('.yml'))) {
      const metadata = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (metadata.version !== version || !metadata.files?.length) fail(`Invalid updater metadata: ${name}`);
      checkRole(name, metadata);
      for (const file of metadata.files) await checkFile(file.url, file);
      if (metadata.path) await checkFile(metadata.path, metadata);
      for (const info of Object.values(metadata.packages || {})) await checkFile(info.path, info);
    }
    const files = fs.readdirSync(directory).filter(file => extensions.test(file)).sort();
    const sums = [];
    for (const file of files) sums.push(`${await hash(path.join(directory, file), 'sha256', 'hex')}  ${file}`);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');
    console.log(`Validated ${files.length} release files for v${version}`);
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  fail('Usage: verify-release.cjs stage SOURCE DEST | verify DIRECTORY');
}
