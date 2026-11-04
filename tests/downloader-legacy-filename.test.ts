import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { downloaderFixture } from './helpers/downloader-small-fixture';

const videoId = 'ownedtrack1';
const index = '.pear-desktop-library.json';
const audioFiles = async (folder: string) =>
  (await readdir(folder)).filter((name) => !name.startsWith('.pear-')).sort();
async function withTitle(
  title: string,
  fn: (f: Awaited<ReturnType<typeof downloaderFixture>>) => Promise<void>,
  options: {
    skipExisting?: boolean;
    duplicatePolicy?: 'legacy' | 'save-variant';
  } = {},
) {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    f.state.trackTitle = title;
    f.state.trackArtist = '';
    f.config.duplicatePolicy = 'legacy';
    f.config.skipExisting = true;
    Object.assign(f.config, options);
    await f.source.downloader.onMainLoad(f.createContext('long-filename'));
    await fn(f);
  } finally {
    await f.close();
  }
}

for (const { title, savedStem } of [
  { title: 'A'.repeat(205), savedStem: 'A'.repeat(200) },
  { title: '界'.repeat(70), savedStem: '界'.repeat(66) },
  { title: '😀'.repeat(52), savedStem: '😀'.repeat(50) },
  { title: 'A'.repeat(197) + '😀', savedStem: 'A'.repeat(197) },
]) {
  test(`legacy skipExisting recognizes its saved long title (${Buffer.byteLength(title)} bytes, ${title.codePointAt(0)})`, async () => {
    await withTitle(title, async (f) => {
      await f.source.downloader.downloadSongFromId(videoId);
      const filename = savedStem + '.m4a';
      expect(await audioFiles(f.downloads)).toEqual([filename]);
      const original = await readFile(path.join(f.downloads, filename));
      const before = {
        runs: f.state.runs.length,
        network: f.state.network.length,
      };
      await f.source.downloader.downloadSongFromId(videoId);
      expect({
        runs: f.state.runs.length,
        network: f.state.network.length,
      }).toEqual(before);
      expect(await audioFiles(f.downloads)).toEqual([filename]);
      expect(await readFile(path.join(f.downloads, filename))).toEqual(
        original,
      );
      const receipt = JSON.parse(
        await readFile(path.join(f.downloads, index), 'utf8'),
      );
      expect(receipt.records).toHaveLength(1);
      expect(receipt.records[0].videoId).toBe(videoId);
      expect(f.state.dialogs).toEqual([]);
    });
  });
}

for (const length of [200, 205]) {
  test(`legacy skipExisting preserves an unindexed pre-existing ${length}-byte title`, async () => {
    await withTitle('A'.repeat(205), async (f) => {
      const filename = 'A'.repeat(length) + '.m4a';
      await writeFile(path.join(f.downloads, filename), 'prior owner bytes');
      await f.source.downloader.downloadSongFromId(videoId);
      expect(f.state.runs).toEqual([]);
      expect(f.state.network).toEqual([]);
      expect(await readdir(f.downloads)).toEqual([filename]);
      expect(await readFile(path.join(f.downloads, filename), 'utf8')).toBe(
        'prior owner bytes',
      );
      expect(f.state.dialogs).toEqual([]);
    });
  });
}

test('legacy filename skip does not confuse a different output format with the selected format', async () => {
  await withTitle('A'.repeat(205), async (f) => {
    const prior = 'A'.repeat(200) + '.flac';
    await writeFile(path.join(f.downloads, prior), 'different format');
    await f.source.downloader.downloadSongFromId(videoId);
    expect(f.state.runs).toHaveLength(1);
    expect(await audioFiles(f.downloads)).toEqual([
      prior,
      'A'.repeat(200) + '.m4a',
    ]);
    expect(await readFile(path.join(f.downloads, prior), 'utf8')).toBe(
      'different format',
    );
    expect(f.state.dialogs).toEqual([]);
  });
});

test('legacy skipExisting=false preserves collision suffix publication for long filenames', async () => {
  await withTitle(
    'A'.repeat(205),
    async (f) => {
      await f.source.downloader.downloadSongFromId(videoId);
      const first = 'A'.repeat(200) + '.m4a';
      const original = await readFile(path.join(f.downloads, first));
      await f.source.downloader.downloadSongFromId(videoId);
      const names = await audioFiles(f.downloads);
      expect(f.state.runs).toHaveLength(2);
      expect(names).toHaveLength(2);
      expect(names).toContain(first);
      const suffixed = names.find((name) => name !== first)!;
      expect(suffixed).toMatch(/^A{100} \[ownedtrack1-[a-f0-9]{8}\]\.m4a$/);
      expect(Buffer.byteLength(suffixed)).toBeLessThanOrEqual(255);
      expect(await readFile(path.join(f.downloads, first))).toEqual(original);
      expect(f.state.dialogs).toEqual([]);
    },
    { skipExisting: false },
  );
});

test('explicit variant policy is not replaced by the legacy canonical filename skip', async () => {
  await withTitle(
    'A'.repeat(205),
    async (f) => {
      const prior = 'A'.repeat(200) + '.m4a';
      await writeFile(path.join(f.downloads, prior), 'unrelated source');
      await f.source.downloader.downloadSongFromId(videoId);
      expect(f.state.runs).toHaveLength(1);
      expect(await audioFiles(f.downloads)).toHaveLength(2);
      expect(await readFile(path.join(f.downloads, prior), 'utf8')).toBe(
        'unrelated source',
      );
      const receipt = JSON.parse(
        await readFile(path.join(f.downloads, index), 'utf8'),
      );
      expect(receipt.records).toHaveLength(1);
      expect(receipt.records[0].videoId).toBe(videoId);
      expect(receipt.records[0].path).not.toBe(prior);
      expect(f.state.dialogs).toEqual([]);
    },
    { duplicatePolicy: 'save-variant' },
  );
});
