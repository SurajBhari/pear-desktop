import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { downloaderFixture } from './helpers/downloader-small-fixture';

test('unsigned actual downloader selects audio-only independently of output preset', async () => {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    await f.source.downloader.onMainLoad(f.createContext('unsigned-audio'));
    await f.source.downloader.downloadSongFromId('one');
    expect(f.state.lastFormat?.type).toBe('audio');
    expect(f.state.runs[0]).toContain('copy');
  } finally {
    await f.close();
  }
});

for (const bytes of [2, 4])
  test(`actual ${bytes} byte media body cannot convert or index a declared3 track`, async () => {
    const f = await downloaderFixture();
    try {
      f.state.infoMode = 'resolve';
      f.state.mediaBytes = bytes;
      await f.source.downloader.onMainLoad(f.createContext('incomplete'));
      await f.source.downloader.downloadSongFromId('one');
      expect(f.state.runs).toEqual([]);
      expect(await readdir(f.downloads)).toEqual([]);
      expect(
        f.state.logs.some(
          (s) => s.includes('Incomplete') || s.includes('Excess'),
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

for (const length of [null, 0])
  test(`actual missing/invalid length ${length} never starts media or commits receipt`, async () => {
    const f = await downloaderFixture();
    try {
      f.state.infoMode = 'resolve';
      f.state.sourceLength = length;
      await f.source.downloader.onMainLoad(f.createContext('no-length'));
      await f.source.downloader.downloadSongFromId('one');
      expect(f.state.network).toEqual([]);
      expect(f.state.runs).toEqual([]);
      expect(await readdir(f.downloads)).toEqual([]);
    } finally {
      await f.close();
    }
  });

test('actual TV_EMBEDDED fallback preserves session transport and extracts audio without claiming video bitrate as audio quality', async () => {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    f.state.loginRequired = true;
    await f.source.downloader.onMainLoad(f.createContext('tv'));
    await f.source.downloader.downloadSongFromId('one');
    expect(f.state.basicInfoCalls).toEqual([
      { id: 'one', client: 'TV_EMBEDDED' },
    ]);
    expect(f.state.runs[0]).toContain('-vn');
    const receipt = JSON.parse(
      await readFile(
        path.join(f.downloads, '.pear-desktop-library.json'),
        'utf8',
      ),
    ) as {
      records: {
        source: {
          codec: string;
          client: string;
          muxed: boolean;
          bitrate?: number;
        };
        output: { extension: string };
      }[];
    };
    expect(receipt.records[0].source).toMatchObject({
      codec: 'mp4a.40.2',
      client: 'TV_EMBEDDED',
      muxed: true,
    });
    expect(receipt.records[0].source.bitrate).toBeUndefined();
    expect(receipt.records[0].output.extension).toBe('m4a');
    expect(f.state.creates[0].cookie).toBe('SID=fixture-tv');
    expect(
      f.state.network.some(
        (row) => row.url.includes('/media?') && !!row.init?.signal,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('actual owned settings IPC persists source/output/policy, scan stays offline and handlers retire', async () => {
  const f = await downloaderFixture();
  try {
    const context = f.createContext('settings');
    await f.source.downloader.onMainLoad(context);
    await f.invoke(context, 'downloader-save-settings', {
      sourceAudio: { mode: 'opus', language: 'original' },
      sourceFallback: true,
      selectedPreset: 'Custom',
      duplicatePolicy: 'keep-better',
    });
    expect(f.config.selectedPreset).toBe('Custom');
    expect(f.config.customPresetSetting.extension).toBe('flac');
    expect(f.config.sourceAudio?.mode).toBe('opus');
    const report = (await f.invoke(context, 'downloader-scan')) as {
      visited: number;
    };
    expect(report.visited).toBe(0);
    expect(f.state.creates).toEqual([]);
    expect(f.state.network).toEqual([]);
    await expect(
      f.invoke(context, 'downloader-save-settings', {
        sourceAudio: { mode: 'bitrate', bitrate: NaN },
        sourceFallback: false,
        duplicatePolicy: 'ask',
      }),
    ).rejects.toThrow(/bitrate/);
    await expect(
      f.invoke(context, 'downloader-save-settings', {
        sourceAudio: { mode: 'best', bitrate: NaN },
        sourceFallback: false,
        duplicatePolicy: 'ask',
      }),
    ).rejects.toThrow(/bitrate/);
    f.source.downloader.onMainStop?.(context);
    await expect(f.invoke(context, 'downloader-scan')).rejects.toThrow(
      'Handler unavailable',
    );
  } finally {
    await f.close();
  }
});

test('actual completed Source receipt contains ID/quality and skip-any avoids another media transfer', async () => {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    f.config.duplicatePolicy = 'skip-any';
    await f.source.downloader.onMainLoad(f.createContext('receipt'));
    await f.source.downloader.downloadSongFromId('one');
    await access(path.join(f.downloads, '.pear-desktop-library.json'));
    const receipt = JSON.parse(
      await readFile(
        path.join(f.downloads, '.pear-desktop-library.json'),
        'utf8',
      ),
    ) as {
      records: {
        videoId: string;
        source: { codec: string };
        output: { extension: string };
      }[];
    };
    expect(receipt.records[0].videoId).toBe('one');
    expect(receipt.records[0].source.codec).toBe('mp4a.40.2');
    expect(receipt.records[0].output.extension).toBe('m4a');
    const transfers = f.state.network.filter((r) =>
      r.url.includes('/media?'),
    ).length;
    await f.source.downloader.downloadSongFromId('one');
    expect(
      f.state.network.filter((r) => r.url.includes('/media?')),
    ).toHaveLength(transfers);
  } finally {
    await f.close();
  }
});

test('explicit library variant policy can revisit a playlist folder without enabling legacy filename skips', async () => {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    f.config.duplicatePolicy = 'save-variant';
    f.config.skipExisting = false;
    await f.source.downloader.onMainLoad(f.createContext('playlist-policy'));
    await f.source.downloader.downloadPlaylist(
      'https://fixture.test/playlist?list=owned',
    );
    expect(f.state.infoCalls).toHaveLength(2);
    await f.source.downloader.downloadPlaylist(
      'https://fixture.test/playlist?list=owned',
    );
    expect(f.state.infoCalls).toHaveLength(4);
    expect(f.state.runs).toHaveLength(2);
  } finally {
    await f.close();
  }
});
