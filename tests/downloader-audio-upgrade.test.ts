import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import NodeID3 from 'node-id3';

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

for (const kind of ['contained', 'external'] as const) {
  test(`skip-any reuses the ${kind} destination index before SDK initialization`, async () => {
    const f = await downloaderFixture();
    try {
      const { mkdir } = await import('node:fs/promises');
      f.state.infoMode = 'resolve';
      f.config.duplicatePolicy = 'skip-any';
      const folder = path.join(
        kind === 'contained' ? f.downloads : f.directory,
        'Playlist',
      );
      await mkdir(folder);
      const first = f.createContext('first-' + kind);
      await f.source.downloader.onMainLoad(first);
      await f.source.downloader.downloadSongFromId('one', folder);
      f.source.downloader.onMainStop?.(first);
      const second = f.createContext('second-' + kind);
      await f.source.downloader.onMainLoad(second);
      const before = {
        init: f.state.creates.length,
        info: f.state.infoCalls.length,
        media: f.state.network.length,
        runs: f.state.runs.length,
      };
      const files = await readdir(folder);
      await f.source.downloader.downloadSongFromId('one', folder);
      expect({
        init: f.state.creates.length,
        info: f.state.infoCalls.length,
        media: f.state.network.length,
        runs: f.state.runs.length,
      }).toEqual(before);
      expect(await readdir(folder)).toEqual(files);
    } finally {
      await f.close();
    }
  });
}

test('lexical library scope preserves nested, sibling and parent ownership', async () => {
  const f = await downloaderFixture();
  try {
    const root = path.join(f.directory, 'library');
    for (const [destination, expected] of [
      [root, root],
      [path.join(root, 'Playlist'), root],
      [path.join(root, '..mix', 'nested'), root],
      [root + '-sibling', root + '-sibling'],
      [f.directory, f.directory],
    ])
      expect(f.source.getLibraryRoot(root, destination)).toBe(expected);
  } finally {
    await f.close();
  }
});

test('contained symlink never adopts the external index or publishes through the link', async () => {
  const f = await downloaderFixture();
  try {
    const { mkdir, symlink } = await import('node:fs/promises');
    const external = path.join(f.directory, 'External');
    await mkdir(external);
    f.state.infoMode = 'resolve';
    f.config.duplicatePolicy = 'skip-any';
    const first = f.createContext('outside-first');
    await f.source.downloader.onMainLoad(first);
    await f.source.downloader.downloadSongFromId('one', external);
    f.source.downloader.onMainStop?.(first);
    const beforeFiles = await readdir(external);
    const beforeIndex = await readFile(
      path.join(external, '.pear-desktop-library.json'),
    );
    const link = path.join(f.downloads, 'Linked');
    await symlink(external, link, 'junction');
    await f.source.downloader.onMainLoad(f.createContext('inside-link'));
    const beforeInfo = f.state.infoCalls.length;
    await f.source.downloader.downloadSongFromId('one', link);
    // Outside completion is not adopted by a lexical-inside destination.
    expect(f.state.infoCalls.length).toBe(beforeInfo + 1);
    expect(await readdir(external)).toEqual(beforeFiles);
    expect(
      await readFile(path.join(external, '.pear-desktop-library.json')),
    ).toEqual(beforeIndex);
    expect(await readdir(f.downloads)).toEqual(['Linked']);
    expect(f.state.logs.some((line) => /symlink|outside/i.test(line))).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

test('skip-any still downloads when a contained completed file no longer matches its receipt', async () => {
  const f = await downloaderFixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const folder = path.join(f.downloads, 'Playlist');
    await mkdir(folder);
    f.state.infoMode = 'resolve';
    f.config.duplicatePolicy = 'skip-any';
    const first = f.createContext('unchanged');
    await f.source.downloader.onMainLoad(first);
    await f.source.downloader.downloadSongFromId('one', folder);
    f.source.downloader.onMainStop?.(first);
    const audio = (await readdir(folder))[0];
    await writeFile(path.join(folder, audio), new Uint8Array([3, 2, 1]));
    await f.source.downloader.onMainLoad(f.createContext('changed'));
    const before = f.state.runs.length;
    await f.source.downloader.downloadSongFromId('one', folder);
    expect(f.state.runs.length).toBe(before + 1);
    expect(await readFile(path.join(folder, audio))).toEqual(
      Buffer.from([3, 2, 1]),
    );
    expect(await readdir(folder)).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const failRange of [undefined, 1]) {
  test(`actual handler ${failRange === undefined ? 'publishes only after complete' : 'never converts or publishes a failed'} 21MiB+37 SDK transfer`, async () => {
    const f = await downloaderFixture();
    try {
      f.state.infoMode = 'resolve';
      f.state.sourceLength = 22_020_133;
      f.state.rangedMedia = true;
      f.state.rangeFailureAt = failRange;
      await f.source.downloader.onMainLoad(f.createContext('multi-range'));
      await f.source.downloader.downloadSongFromId('one');
      if (failRange !== undefined) {
        expect(f.state.runs).toEqual([]);
        expect(f.state.ffmpegInputs).toEqual([]);
        expect(await readdir(f.downloads)).toEqual([]);
        expect(
          f.state.logs.some((line) =>
            line.includes('Audio transfer failed (stage: transfer)'),
          ),
        ).toBe(true);
      } else {
        const { createHash } = await import('node:crypto');
        const bytes = Buffer.alloc(22_020_133);
        for (let index = 0; index < bytes.length; index++)
          bytes[index] = index % 251;
        expect(f.state.ffmpegInputs).toEqual([
          {
            size: 22_020_133,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ]);
        expect(f.state.runs).toHaveLength(1);
        const receipt = JSON.parse(
          await readFile(
            path.join(f.downloads, '.pear-desktop-library.json'),
            'utf8',
          ),
        ) as {
          records: {
            source: { length: number };
            sha256: string;
            path: string;
          }[];
        };
        expect(receipt.records).toHaveLength(1);
        expect(receipt.records[0].source.length).toBe(22_020_133);
        expect(receipt.records[0].sha256).toBe(
          createHash('sha256')
            .update(Buffer.from([1, 2, 3]))
            .digest('hex'),
        );
        expect(
          await readFile(path.join(f.downloads, receipt.records[0].path)),
        ).toEqual(Buffer.from([1, 2, 3]));
        expect(
          f.state.network.filter((row) => row.url.includes('/media?')),
        ).toHaveLength(3);
        expect(f.state.ffmpegFiles).toEqual([]);
      }
    } finally {
      await f.close();
    }
  });
}

for (const cleanupError of [false, true]) {
  test(`partial converter rejection cleans both owned names independently (cleanup error ${cleanupError})`, async () => {
    const f = await downloaderFixture();
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(f.downloads, 'prior.webm'), 'owned-prior');
      f.state.infoMode = 'resolve';
      f.state.ffmpegPartialFailure = true;
      f.state.ffmpegSeedForeignFile = true;
      f.state.ffmpegUnlinkInputError = cleanupError;
      await f.source.downloader.onMainLoad(
        f.createContext('partial-converter'),
      );
      await f.source.downloader.downloadSongFromId('one');
      const input = f.state.runs[0][1];
      const output = f.state.runs[0].at(-1)!;
      expect(f.state.ffmpegUnlinks).toEqual([input, output]);
      expect(f.state.ffmpegFiles).toEqual(
        cleanupError
          ? ['unrelated-wasm-resource', input]
          : ['unrelated-wasm-resource'],
      );
      expect(await readdir(f.downloads)).toEqual(['prior.webm']);
      expect(await readFile(path.join(f.downloads, 'prior.webm'), 'utf8')).toBe(
        'owned-prior',
      );
      expect(
        f.state.logs.some((line) =>
          line.includes('Owned partial-output converter failure'),
        ),
      ).toBe(true);
      if (cleanupError)
        expect(
          f.state.logs.some((line) =>
            line.includes('Owned input cleanup failure'),
          ),
        ).toBe(true);
    } finally {
      await f.close();
    }
  });
}

test('tagging rejection retains prior audio and leaves no owned processing files or receipt', async () => {
  const f = await downloaderFixture();
  const original = NodeID3.write;
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(f.downloads, 'prior.webm'), 'owned-prior');
    f.state.infoMode = 'resolve';
    f.config.selectedPreset = 'mp3 (256kbps)';
    f.state.ffmpegSeedForeignFile = true;
    NodeID3.write = () => {
      throw new Error('Owned tagging fault');
    };
    await f.source.downloader.onMainLoad(f.createContext('tagging-failure'));
    await f.source.downloader.downloadSongFromId('one');
    expect(f.state.ffmpegFiles).toEqual(['unrelated-wasm-resource']);
    expect(await readdir(f.downloads)).toEqual(['prior.webm']);
    expect(await readFile(path.join(f.downloads, 'prior.webm'), 'utf8')).toBe(
      'owned-prior',
    );
    expect(
      f.state.logs.some((line) => line.includes('Owned tagging fault')),
    ).toBe(true);
  } finally {
    NodeID3.write = original;
    await f.close();
  }
});
