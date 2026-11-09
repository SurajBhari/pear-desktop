const path = require('node:path');
const { createRequire } = require('node:module');

function loadDependencies() {
  // Resolve through electron-builder's graph, including pnpm's nested layout.
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const libraryRequire = createRequire(
    builderRequire.resolve('app-builder-lib/package.json'),
  );
  return {
    getConfig: libraryRequire('./out/util/config/config').getConfig,
    getAppImageTools: libraryRequire('./out/toolsets/linux').getAppImageTools,
    Arch: libraryRequire('builder-util').Arch,
  };
}

async function prepareLinuxTools({
  platform = process.platform,
  projectDir = process.cwd(),
  loadDependencies: load = loadDependencies,
} = {}) {
  if (platform !== 'linux') return;
  const { getConfig, getAppImageTools, Arch } = load();
  const config = await getConfig(projectDir, undefined, undefined);
  // Snap always uses the legacy toolset. AppImage may select another version.
  // Initialize shared extraction caches before parallel targets can clear them.
  // This preserves the helper's cache and APPIMAGE_TOOLS_PATH override behavior;
  // it does not rehash a complete cache or protect against external deletion.
  const versions = new Set(['0.0.0', config.toolsets?.appimage ?? '0.0.0']);
  for (const version of versions) {
    const tools = await getAppImageTools(version, Arch.x64);
    for (const name of [
      'mksquashfs',
      'desktopFileValidate',
      'runtime',
      'runtimeLibraries',
    ]) {
      if (
        !tools ||
        typeof tools[name] !== 'string' ||
        !path.isAbsolute(tools[name])
      ) {
        throw new Error(`Invalid Linux packaging tool: ${name}`);
      }
    }
  }
}

module.exports = { prepareLinuxTools };

if (require.main === module) {
  prepareLinuxTools().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
