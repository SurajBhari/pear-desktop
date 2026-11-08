import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
  mkdir,
  copyFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import NodeID3 from 'node-id3';
import { downloaderFixture } from './helpers/downloader-small-fixture';

const requireRoot = createRequire(
  path.join(import.meta.dirname, '../package.json'),
);
const { ownWav, probe } = requireRoot(
  './tests/helpers/downloader-real-ffmpeg.cjs',
) as {
  ownWav: () => Buffer;
  probe: (file: string) => { codec: string; samples: number };
};
test.skip(
  process.env.PEAR_REAL_FFMPEG_TEST !== '1',
  'Explicit offline real-WASM/native-decoder qualification',
);
test.setTimeout(120_000);

test('real packaged-compatible engine rejects failures and exact processor recovers without media heuristics', async () => {
  const out =
    process.env.PEAR_REAL_FFMPEG_REPORT ??
    (await mkdtemp(path.join(tmpdir(), 'pear-real-ffmpeg-')));
  try {
    const run = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, 'helpers/downloader-real-ffmpeg.cjs'),
        out,
      ],
      { encoding: 'utf8', timeout: 100_000, env: process.env },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + '\n' + run.stderr).toBe(0);
  } finally {
    if (!process.env.PEAR_REAL_FFMPEG_REPORT)
      await rm(out, { recursive: true, force: true });
  }
});

test('real handler blocks failed partial conversion before tagging/publication, then saves one valid recovery', async () => {
  const f = await downloaderFixture({ realFFmpeg: true });
  const original = NodeID3.write;
  let tags = 0;
  NodeID3.write = ((...args: Parameters<typeof original>) => {
    tags++;
    return original(...args);
  }) as typeof original;
  try {
    await writeFile(path.join(f.downloads, 'prior.webm'), 'owned-prior');
    f.state.infoMode = 'resolve';
    f.state.ffmpegSeedForeignFile = true;
    const wav = ownWav();
    f.state.mediaData = wav.subarray(0, 44145);
    f.state.sourceLength = f.state.mediaData.length;
    f.config.selectedPreset = 'Custom';
    f.config.customPresetSetting = {
      extension: 'mp3',
      ffmpegArgs: ['-xerror', '-b:a', '256k'],
    };
    await f.source.downloader.onMainLoad(f.createContext('real-wasm-owned'));
    await f.source.downloader.downloadSongFromId('owned-partial');
    expect(f.state.ffmpegErrors?.at(-1)?.exitCode).toBe(1);
    expect(tags).toBe(0);
    expect(f.state.publishCalls ?? 0).toBe(0);
    expect(await readdir(f.downloads)).toEqual(['prior.webm']);
    expect(await readFile(path.join(f.downloads, 'prior.webm'), 'utf8')).toBe(
      'owned-prior',
    );
    expect(f.state.ffmpegFiles).toEqual(['unrelated-wasm-resource']);
    const failure = {
      tagCalls: tags,
      publishCalls: f.state.publishCalls ?? 0,
      files: await readdir(f.downloads),
      memfs: [...(f.state.ffmpegFiles ?? [])],
      errors: [...(f.state.ffmpegErrors ?? [])],
    };
    f.state.mediaData = wav;
    f.state.sourceLength = wav.length;
    await f.source.downloader.downloadSongFromId('owned-valid');
    expect(f.state.realEngines).toHaveLength(1);
    expect(tags).toBe(1);
    expect(f.state.publishCalls).toBe(1);
    const names = await readdir(f.downloads);
    expect(names.filter((n) => n.endsWith('.mp3'))).toHaveLength(1);
    expect(names.sort()).toEqual(
      [
        '.pear-desktop-library.json',
        names.find((n) => n.endsWith('.mp3'))!,
        'prior.webm',
      ].sort(),
    );
    const receipt = JSON.parse(
      await readFile(
        path.join(f.downloads, '.pear-desktop-library.json'),
        'utf8',
      ),
    ) as { records: { videoId: string; path: string }[] };
    expect(receipt.records).toHaveLength(1);
    expect(receipt.records[0].videoId).toBe('owned-valid');
    expect(
      probe(path.join(f.downloads, receipt.records[0].path)),
    ).toMatchObject({ codec: 'mp3', samples: 44100 });
    expect(f.state.ffmpegFiles).toEqual(['unrelated-wasm-resource']);
    expect(await readFile(path.join(f.downloads, 'prior.webm'), 'utf8')).toBe(
      'owned-prior',
    );
    if (process.env.PEAR_REAL_FFMPEG_REPORT) {
      const destination = path.join(
        process.env.PEAR_REAL_FFMPEG_REPORT,
        'handler',
      );
      await mkdir(destination, { recursive: true });
      await copyFile(
        path.join(f.downloads, receipt.records[0].path),
        path.join(destination, 'owned-valid.mp3'),
      );
      await writeFile(
        path.join(destination, 'receipt.json'),
        JSON.stringify(receipt, null, 2) + '\n',
      );
      await writeFile(
        path.join(destination, 'observations.json'),
        JSON.stringify(
          {
            boundary:
              'Actual handler/processor/engine/tagger/publication with synthetic SDK/native boundaries and owned WAV bytes; declared AAC source metadata is fixture data',
            failure,
            recovery: {
              tagCalls: tags,
              publishCalls: f.state.publishCalls,
              engineCount: f.state.realEngines?.length,
              files: names,
              decoded: probe(path.join(f.downloads, receipt.records[0].path)),
              prior: 'owned-prior',
              memfs: f.state.ffmpegFiles,
            },
          },
          null,
          2,
        ) + '\n',
      );
    }
  } finally {
    NodeID3.write = original;
    await f.close();
  }
});
