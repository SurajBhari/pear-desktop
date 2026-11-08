import { test, expect } from '@playwright/test';

import { downloaderConfigPaths } from './helpers/downloader-config-paths';
import { downloaderFixture } from './helpers/downloader-small-fixture';

import type { Preset } from '../src/plugins/downloader/types';

const cases: [string, Preset | undefined, string[]][] = [
  [
    'explicit FLAC',
    { extension: 'flac', ffmpegArgs: ['-c:a', 'flac'] },
    ['-c:a', 'flac', '-vn'],
  ],
  ['intentional empty', { extension: 'flac', ffmpegArgs: [] }, ['-vn']],
  ['legacy source extension', { extension: null, ffmpegArgs: [] }, ['-vn']],
  [
    'intentional repeated flags',
    { extension: 'mp3', ffmpegArgs: ['-b:a', '64k', '-b:a', '80k'] },
    ['-b:a', '64k', '-b:a', '80k', '-vn'],
  ],
  ['first-use fallback', undefined, ['-b:a', '256k', '-vn']],
];
for (const [name, custom, expected] of cases) {
  test(`actual read/write/watch/restart preserves Custom ${name} converter recipe`, async () => {
    const f = await downloaderFixture();
    let paths: Awaited<ReturnType<typeof downloaderConfigPaths>> | undefined;
    try {
      f.state.infoMode = 'resolve';
      paths = await downloaderConfigPaths(f, {
        enabled: true,
        downloadFolder: f.downloads,
        selectedPreset: 'Custom',
        ...(custom === undefined ? {} : { customPresetSetting: custom }),
      });
      await f.source.downloader.onMainLoad(paths.backend);
      expect((await paths.unrelatedRead()).list).toEqual(['default', 'saved']);
      const original = f.source.downloader.resolvePreset('Custom');
      const originalArgs = [...original.ffmpegArgs];
      original.ffmpegArgs.push('resolver-mutation');
      expect(f.source.downloader.resolvePreset('Custom').ffmpegArgs).toEqual(
        originalArgs,
      );
      expect(f.source.DefaultPresetList['mp3 (256kbps)'].ffmpegArgs).toEqual([
        '-b:a',
        '256k',
      ]);
      const activePaths = paths;
      const verify = async (id: string) => {
        if (custom !== undefined) {
          for (const read of [
            await activePaths.backend.getConfig(),
            await activePaths.menu.getConfig(),
            activePaths.ipcRead(),
          ])
            expect.soft(read.customPresetSetting).toEqual(custom);
        }
        f.state.runs.length = 0;
        await f.source.downloader.downloadSongFromId(id);
        const argv = f.state.runs[0];
        expect(argv).toBeDefined();
        expect.soft(argv.slice(2, argv.indexOf('-metadata'))).toEqual(expected);
      };
      await verify('one');
      // Actual backend setter -> JSON store -> actual watcher -> actual onConfigChange.
      await paths.backend.setConfig({ sourceFallback: true });
      expect.soft(paths.raw().customPresetSetting).toEqual(custom);
      await verify('two');
      // Renderer IPC and menu share the actual setter and must retain explicit recipes.
      paths.ipcWrite({ duplicatePolicy: 'save-variant' });
      await paths.menu.setConfig({ sourceFallback: false });
      await verify('three');
      f.source.downloader.onMainStop?.(paths.backend);
      await f.source.downloader.onMainLoad(paths.backend);
      await verify('four');
      if (custom !== undefined) {
        const read = await activePaths.backend.getConfig();
        read.customPresetSetting!.ffmpegArgs.push('consumer-mutation');
        expect(
          (await activePaths.backend.getConfig()).customPresetSetting,
        ).toEqual(custom);
      }
    } finally {
      if (paths) f.source.downloader.onMainStop?.(paths.backend);
      await f.close();
    }
  });
}
