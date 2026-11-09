import { test, expect } from '@playwright/test';

import {
  downloaderFixturePolicy,
  normalizeDownloaderFixtureId,
} from './helpers/downloader-fixture-policy';
import { downloaderFixture } from './helpers/downloader-small-fixture';

const main = String.raw`D:\a\pear-desktop\pear-desktop\src\plugins\downloader\main\index.ts`;
const songInfo = String.raw`D:\a\pear-desktop\pear-desktop\src\providers\song-info.ts`;
const policy = downloaderFixturePolicy(main, songInfo);

test('actual compiler policy excludes Windows config while retaining other modules', () => {
  expect(
    policy.moduleSideEffects(
      String.raw`D:\a\pear-desktop\pear-desktop\src\config\store.ts`,
    ),
  ).toBe(false);
  expect(
    policy.moduleSideEffects(
      'D:/a/pear-desktop/pear-desktop/src/config/store.ts',
    ),
  ).toBe(false);
  expect(
    policy.moduleSideEffects(
      'D:/a/pear-desktop/pear-desktop/src/configuration.ts',
    ),
  ).toBe(true);
});

test('actual main and song-info transforms match native and Rolldown module IDs', () => {
  expect(policy.isMain(main)).toBe(true);
  expect(normalizeDownloaderFixtureId(main)).toBe(
    'D:/a/pear-desktop/pear-desktop/src/plugins/downloader/main/index.ts',
  );
  expect(
    policy.isMain(
      'D:/a/pear-desktop/pear-desktop/src/plugins/downloader/main/index.ts',
    ),
  ).toBe(true);
  expect(policy.isSongInfo(songInfo)).toBe(true);
  expect(
    policy.isSongInfo(
      'D:/a/pear-desktop/pear-desktop/src/providers/song-info.ts',
    ),
  ).toBe(true);
  expect(
    policy.isMain(
      'D:/a/pear-desktop/pear-desktop/src/plugins/downloader/main/other.ts',
    ),
  ).toBe(false);
});

for (const moduleId of [
  'electron-store',
  '/repo/node_modules/.pnpm/electron-store@11.0.2/node_modules/electron-store/index.js',
  String.raw`D:\a\repo\node_modules\.pnpm\electron-store@11.0.2\node_modules\electron-store\index.js`,
]) {
  test(`store guard rejects ${moduleId} before evaluation`, () => {
    let evaluated = false;
    const code = `require(${JSON.stringify(moduleId)});`;
    expect(() =>
      policy.evaluate(code, () => {
        evaluated = true;
      }),
    ).toThrow(/profile configuration store/);
    expect(evaluated).toBe(false);
  });
}

test('safe actual source fixture retains callback export and real downloader operations', async () => {
  const f = await downloaderFixture();
  try {
    expect(f.source.fixtureCallbacks).toBeInstanceOf(Set);
    await f.source.downloader.onMainLoad(f.createContext('portable-positive'));
    expect(f.source.fixtureCallbacks.size).toBe(1);
    expect(f.state.creates).toHaveLength(0);
    await f.source.downloader.downloadSongFromId('portable-real-operation');
    expect(f.state.infoCalls.map((entry) => entry.id)).toEqual([
      'portable-real-operation',
    ]);
  } finally {
    await f.close();
  }
});

test('actual compiler direct and alias imports share the same song-info callback Set', async () => {
  const f = await downloaderFixture();
  try {
    const graphDiagnostic = `Actual Rolldown module graph on ${process.platform}: ${JSON.stringify(
      {
        modules: f.moduleGraph,
        aliasResolutions: f.aliasResolutions,
      },
    )}`;
    expect(f.source.aliasFixtureCallbacks, graphDiagnostic).toBe(
      f.source.fixtureCallbacks,
    );
    for (const suffix of [
      '/src/providers/song-info.ts',
      '/src/plugins/downloader/types.ts',
    ])
      expect(
        f.moduleGraph.filter((module) =>
          normalizeDownloaderFixtureId(module.id).endsWith(suffix),
        ),
        graphDiagnostic,
      ).toHaveLength(1);
    expect(
      f.moduleGraph.some((module) =>
        module.exports.includes('fixtureCallbacks'),
      ),
    ).toBe(true);
    expect(
      f.aliasResolutions.some(
        (resolution) => resolution.source === '@/providers/song-info',
      ),
    ).toBe(true);
    const context = f.createContext('single-module-identity');
    await f.source.downloader.onMainLoad(context);
    expect(f.source.aliasFixtureCallbacks.size).toBe(1);
    expect(f.source.fixtureCallbacks.size).toBe(1);
    f.source.downloader.onMainStop?.(context);
    expect(f.source.aliasFixtureCallbacks.size).toBe(0);
    expect(f.source.fixtureCallbacks.size).toBe(0);
  } finally {
    await f.close();
  }
});
