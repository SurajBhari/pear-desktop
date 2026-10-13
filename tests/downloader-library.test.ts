import { existsSync, renameSync, symlinkSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import NodeID3 from 'node-id3';

import { describeAudioFormats } from '../src/plugins/downloader/audio';
import {
  publishCompleted,
  scanLibrary,
  checkDuplicate,
  type CompletedInput,
} from '../src/plugins/downloader/library';

const source = describeAudioFormats([
  {
    itag: 251,
    mime_type: 'audio/webm; codecs="opus"',
    has_audio: true,
    has_video: false,
    bitrate: 160000,
    content_length: 3,
  },
])[0];
const input = (overrides: Partial<CompletedInput> = {}): CompletedInput => ({
  videoId: 'fixture-one',
  source,
  output: { extension: 'webm', args: ['-acodec', 'copy'] },
  policy: 'save-variant',
  ...overrides,
});
const withRoot = async (fn: (root: string) => Promise<void>) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pear-library-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

for (const [oldTier, oldRate, newTier, newRate, expected] of [
  ['AUDIO_QUALITY_MEDIUM', 160000, 'AUDIO_QUALITY_HIGH', 140000, 'save'],
  ['AUDIO_QUALITY_HIGH', 96000, 'AUDIO_QUALITY_MEDIUM', 128000, 'skip'],
] as const) {
  test(`keep-better prioritizes declared quality before bitrate: ${oldTier} to ${newTier}`, async () =>
    withRoot(async (root) => {
      const candidate = (quality: string, bitrate: number) =>
        input({
          policy: 'keep-better',
          source: describeAudioFormats([
            {
              itag: 251,
              mime_type: 'audio/webm; codecs="opus"',
              has_audio: true,
              has_video: false,
              content_length: 3,
              audio_quality: quality,
              bitrate,
              audio_sample_rate: 48000,
              audio_channels: 2,
            },
          ])[0],
        });
      await publishCompleted(
        root,
        root,
        'old.webm',
        new Uint8Array([1, 2, 3]),
        candidate(oldTier, oldRate),
        () => {},
      );
      expect(await checkDuplicate(root, candidate(newTier, newRate))).toBe(
        expected,
      );
      expect(
        (
          await publishCompleted(
            root,
            root,
            'new.webm',
            new Uint8Array([4, 5, 6]),
            candidate(newTier, newRate),
            () => {},
          )
        ).status,
      ).toBe(expected === 'save' ? 'saved' : 'skipped');
      expect(await readFile(path.join(root, 'old.webm'))).toEqual(
        Buffer.from([1, 2, 3]),
      );
    }));
}

for (const replacement of [
  'symlink',
  'real-directory',
  'root-symlink',
] as const) {
  test(`scan never consumes replacement ancestor bytes: ${replacement}`, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'pear-scan-ancestor-'));
    const root = path.join(fixture, 'library');
    const nested = path.join(root, 'nested');
    const outside = path.join(fixture, 'outside');
    await mkdir(nested, { recursive: true });
    await mkdir(outside);
    const replacementDirectory =
      replacement === 'root-symlink' ? path.join(outside, 'nested') : outside;
    if (replacement === 'root-symlink') await mkdir(replacementDirectory);
    const tagged = NodeID3.write(
      {
        userDefinedText: [
          {
            description: 'pear-desktop:youtube-video-id',
            value: 'outside-fixture',
          },
        ],
      },
      Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    );
    for (const name of ['first.mp3', 'second.mp3']) {
      await writeFile(
        path.join(nested, name),
        Buffer.from([0xff, 0xfb, 0x90, 0x64]),
      );
      await writeFile(path.join(replacementDirectory, name), tagged);
    }
    let replaced = false;
    let pinnedRoot = false;
    try {
      let report: Awaited<ReturnType<typeof scanLibrary>>;
      try {
        report = await scanLibrary(root, {
          onProgress: () => {
            if (replaced) return;
            replaced = true;
            if (replacement === 'root-symlink') {
              try {
                renameSync(root, path.join(fixture, 'retired-root'));
              } catch (error) {
                if (
                  process.platform === 'win32' &&
                  (error as NodeJS.ErrnoException).code === 'EPERM'
                )
                  pinnedRoot = true;
                throw error;
              }
              symlinkSync(outside, root, 'dir');
              return;
            }
            renameSync(nested, path.join(root, '.pear-retired'));
            if (replacement === 'symlink') symlinkSync(outside, nested, 'dir');
            else renameSync(outside, nested);
          },
        });
      } catch (error) {
        if (!pinnedRoot) throw error;
        // Windows pins the open directory: the attempted replacement never occurs.
        expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
        expect(replaced).toBe(true);
        expect(existsSync(path.join(fixture, 'retired-root'))).toBe(false);
        expect(await readFile(path.join(nested, 'first.mp3'))).toEqual(
          Buffer.from([0xff, 0xfb, 0x90, 0x64]),
        );
        expect(
          await readFile(path.join(replacementDirectory, 'first.mp3')),
        ).toEqual(tagged);
        return;
      }
      expect(replaced).toBe(true);
      expect(
        report.files.some((row) => row.videoId === 'outside-fixture'),
      ).toBe(false);
      expect(
        report.errors.some((error) => /changed|symlink/i.test(error)),
      ).toBe(true);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test('keep-better does not infer an upgrade between a known tier and an unknown tier', async () =>
  withRoot(async (root) => {
    const known = input({
      policy: 'keep-better',
      source: { ...source, quality: 'AUDIO_QUALITY_HIGH', bitrate: 96000 },
    });
    await publishCompleted(
      root,
      root,
      'known.webm',
      new Uint8Array([1, 2, 3]),
      known,
      () => {},
    );
    const unknown = input({
      policy: 'keep-better',
      source: { ...source, quality: undefined, bitrate: 192000 },
    });
    expect(await checkDuplicate(root, unknown)).toBe('ask');
  }));

test('success-only publication persists ID/source/output, verifies renamed library records and no auth fields', async () =>
  withRoot(async (root) => {
    const r = await publishCompleted(
      root,
      root,
      'Track.webm',
      new Uint8Array([1, 2, 3]),
      input(),
      () => {},
    );
    expect(r.status).toBe('saved');
    const raw = await readFile(
      path.join(root, '.pear-desktop-library.json'),
      'utf8',
    );
    expect(raw).toContain('fixture-one');
    expect(raw).not.toContain('cookie');
    expect((await scanLibrary(root)).files[0].status).toBe('complete');
    await rename(
      path.join(root, 'Track.webm'),
      path.join(root, 'Renamed.webm'),
    );
    const moved = await scanLibrary(root);
    expect(moved.files).toHaveLength(1);
    expect(moved.files[0]).toMatchObject({
      path: 'Renamed.webm',
      videoId: 'fixture-one',
      status: 'complete',
    });
    expect(await checkDuplicate(root, input({ policy: 'skip-any' }))).toBe(
      'skip',
    );
  }));

test('title collision preserves unrelated original and selected variants; same variant races publish only once', async () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, 'Track.webm'), 'unrelated');
    const results = await Promise.all([
      publishCompleted(
        root,
        root,
        'Track.webm',
        new Uint8Array([1, 2, 3]),
        input(),
        () => {},
      ),
      publishCompleted(
        root,
        root,
        'Track.webm',
        new Uint8Array([1, 2, 3]),
        input(),
        () => {},
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['saved', 'skipped']);
    expect(await readFile(path.join(root, 'Track.webm'), 'utf8')).toBe(
      'unrelated',
    );
    expect(
      (await readdir(root)).filter((n) => n.endsWith('.webm')),
    ).toHaveLength(2);
  }));

test('keep-better compares actual same-codec source, ignores output upscale and asks about unknown/cross-codec', async () =>
  withRoot(async (root) => {
    await publishCompleted(
      root,
      root,
      'old.webm',
      new Uint8Array([1, 2, 3]),
      input(),
      () => {},
    );
    expect(
      await checkDuplicate(
        root,
        input({
          policy: 'keep-better',
          source: { ...source, bitrate: 128000 },
        }),
      ),
    ).toBe('skip');
    expect(
      await checkDuplicate(
        root,
        input({
          policy: 'keep-better',
          source: { ...source, key: 'better', bitrate: 256000 },
        }),
      ),
    ).toBe('save');
    expect(
      await checkDuplicate(
        root,
        input({
          policy: 'keep-better',
          source: {
            ...source,
            key: 'aac',
            codec: 'mp4a.40.2',
            bitrate: 256000,
          },
        }),
      ),
    ).toBe('ask');
    expect(
      await checkDuplicate(
        root,
        input({
          policy: 'keep-better',
          source: { ...source, bitrate: undefined },
        }),
      ),
    ).toBe('ask');
  }));

test('corrupt/modified/zero-byte and unindexed files are not verified skips or deleted', async () =>
  withRoot(async (root) => {
    await publishCompleted(
      root,
      root,
      'Track.webm',
      new Uint8Array([1, 2, 3]),
      input(),
      () => {},
    );
    await writeFile(path.join(root, 'Track.webm'), new Uint8Array([3, 2, 1]));
    await writeFile(path.join(root, 'partial.mp3'), '');
    await writeFile(path.join(root, 'legacy.flac'), 'unknown');
    const report = await scanLibrary(root);
    expect(report.files.find((f) => f.path === 'Track.webm')?.status).toBe(
      'changed',
    );
    expect(report.files.find((f) => f.path === 'partial.mp3')?.status).toBe(
      'invalid',
    );
    expect(report.files.find((f) => f.path === 'legacy.flac')?.status).toBe(
      'uncertain',
    );
    expect(await checkDuplicate(root, input({ policy: 'skip-any' }))).toBe(
      'save',
    );
    expect(await readFile(path.join(root, 'legacy.flac'), 'utf8')).toBe(
      'unknown',
    );
  }));

test('cancelled/empty conversion never publishes file or completion record and keeps prior audio', async () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, 'prior.webm'), 'prior');
    await expect(
      publishCompleted(
        root,
        root,
        'new.webm',
        new Uint8Array(),
        input(),
        () => {},
      ),
    ).rejects.toThrow(/empty/);
    await expect(
      publishCompleted(
        root,
        root,
        'new.webm',
        new Uint8Array([1]),
        input(),
        () => {
          throw new Error('retired');
        },
      ),
    ).rejects.toThrow('retired');
    expect(await readdir(root)).toEqual(['prior.webm']);
  }));

test('manifest write failure retains published audio as uncertain and records no false success', async () =>
  withRoot(async (root) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(root, '.pear-desktop-library.json'));
    await expect(
      publishCompleted(
        root,
        root,
        'Track.webm',
        new Uint8Array([1, 2, 3]),
        input(),
        () => {},
      ),
    ).rejects.toThrow(/index|manifest/i);
    expect(await readFile(path.join(root, 'Track.webm'))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(
      (await scanLibrary(root)).files.find((f) => f.path === 'Track.webm')
        ?.status,
    ).toBe('uncertain');
  }));

test('bounded scan rejects traversal manifest records and skips symlinks without reading outside root', async () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, 'a.mp3'), 'unknown');
    await writeFile(path.join(root, 'b.mp3'), 'unknown');
    await symlink(root, path.join(root, 'loop'), 'junction');
    await writeFile(
      path.join(root, '.pear-desktop-library.json'),
      JSON.stringify({
        version: 1,
        records: [{ path: '../outside.mp3', videoId: 'fake' }],
      }),
    );
    const report = await scanLibrary(root, { maxFiles: 1 });
    expect(report.truncated).toBe(true);
    expect(report.files).toHaveLength(1);
    expect(report.errors.length).toBeGreaterThan(0);
    await expect(
      publishCompleted(
        root,
        path.dirname(root),
        'escape.webm',
        new Uint8Array([1]),
        input(),
        () => {},
      ),
    ).rejects.toThrow(/outside/);
  }));

test('cross-process writer reservation and cancelled scan preserve every existing file', async () =>
  withRoot(async (root) => {
    await writeFile(
      path.join(root, '.pear-desktop-writer.lock'),
      'owned synthetic other writer',
    );
    await expect(
      publishCompleted(
        root,
        root,
        'Track.webm',
        new Uint8Array([1]),
        input(),
        () => {},
      ),
    ).rejects.toThrow(/writer lock/);
    expect(await readdir(root)).toEqual(['.pear-desktop-writer.lock']);
    const abort = new AbortController();
    abort.abort();
    await expect(scanLibrary(root, { signal: abort.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(
      await readFile(path.join(root, '.pear-desktop-writer.lock'), 'utf8'),
    ).toBe('owned synthetic other writer');
  }));

test('ask policy publishes nothing until approved and always preserves the prior quality', async () =>
  withRoot(async (root) => {
    await publishCompleted(
      root,
      root,
      'Track.webm',
      new Uint8Array([1, 2, 3]),
      input(),
      () => {},
    );
    const alternate = input({
      policy: 'ask',
      source: { ...source, key: 'offered-upgrade', bitrate: 256000 },
    });
    expect(await checkDuplicate(root, alternate)).toBe('ask');
    expect(
      (
        await publishCompleted(
          root,
          root,
          'Track.webm',
          new Uint8Array([4, 5, 6]),
          alternate,
          () => {},
        )
      ).status,
    ).toBe('needs-choice');
    expect(
      (await readdir(root)).filter((name) => name.endsWith('.webm')),
    ).toHaveLength(1);
    expect(
      (
        await publishCompleted(
          root,
          root,
          'Track.webm',
          new Uint8Array([4, 5, 6]),
          { ...alternate, approved: true },
          () => {},
        )
      ).status,
    ).toBe('saved');
    expect(await readFile(path.join(root, 'Track.webm'))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(
      (await scanLibrary(root)).files.filter(
        (file) => file.status === 'complete',
      ),
    ).toHaveLength(2);
  }));

test('directory replacement after audio publication cannot write a manifest outside the bound library', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pear-root-race-'));
  const root = path.join(parent, 'library');
  const outside = path.join(parent, 'outside');
  const moved = path.join(parent, 'moved');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, 'prior.webm'), 'prior');
  let changed = false;
  let pinnedRoot = false;
  try {
    const guard = () => {
      if (!changed && existsSync(path.join(root, 'Track.webm'))) {
        changed = true;
        try {
          renameSync(root, moved);
        } catch (error) {
          if (
            process.platform === 'win32' &&
            (error as NodeJS.ErrnoException).code === 'EPERM'
          )
            pinnedRoot = true;
          throw error;
        }
        symlinkSync(outside, root, 'junction');
      }
    };
    let publicationError: unknown;
    try {
      await publishCompleted(
        root,
        root,
        'Track.webm',
        new Uint8Array([1, 2, 3]),
        input(),
        guard,
      );
    } catch (error) {
      publicationError = error;
    }
    expect(publicationError).toBeDefined();
    expect(changed).toBe(true);
    if (pinnedRoot) {
      expect((publicationError as NodeJS.ErrnoException).code).toBe('EPERM');
      expect(existsSync(moved)).toBe(false);
    } else {
      expect(() => {
        throw publicationError;
      }).toThrow(/directory changed|symlink/i);
    }
    expect(await readdir(outside)).toEqual([]);
    expect(
      await readFile(
        path.join(pinnedRoot ? root : moved, 'prior.webm'),
        'utf8',
      ),
    ).toBe('prior');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('dotted Unicode filenames inside the library remain verified rather than treated as parent traversal', async () =>
  withRoot(async (root) => {
    await publishCompleted(
      root,
      root,
      '...\u97f3\u697d - Track.webm',
      new Uint8Array([1, 2, 3]),
      input(),
      () => {},
    );
    const report = await scanLibrary(root);
    expect(report.files[0].status).toBe('complete');
    expect(await checkDuplicate(root, input({ policy: 'skip-any' }))).toBe(
      'skip',
    );
  }));
