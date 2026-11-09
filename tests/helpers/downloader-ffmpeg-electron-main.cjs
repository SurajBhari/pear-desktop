// Owned windowless Electron entry; never imports the product's main entry.
const fs = require('node:fs'),
  path = require('node:path');
const { app } = require('electron');
const owned = process.env.PEAR_FFMPEG_USER_DATA;
if (!owned || !path.isAbsolute(owned))
  throw Error('An absolute owned userData is required');
for (const [name, suffix] of [
  ['userData', ''],
  ['sessionData', '-session'],
  ['crashDumps', '-crash'],
  ['logs', '-logs'],
]) {
  const dir = owned + suffix;
  fs.mkdirSync(dir, { recursive: true });
  app.setPath(name, dir);
}
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const { qualify } = require('./downloader-ffmpeg-disposal.cjs');
    const report = await qualify(
      process.env.PEAR_FFMPEG_MODE,
      process.env.PEAR_FFMPEG_OUTPUT,
    );
    report.electronPaths = {
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    };
    fs.writeFileSync(
      path.join(process.env.PEAR_FFMPEG_OUTPUT, 'result.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    app.exit(report.passed ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
