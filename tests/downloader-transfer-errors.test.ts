import { readdir } from 'node:fs/promises';

import { test, expect } from '@playwright/test';

import { downloaderFixture } from './helpers/downloader-small-fixture';

const outputs = (f: Awaited<ReturnType<typeof downloaderFixture>>) =>
  JSON.stringify({
    dialogs: f.state.dialogs,
    feedback: f.state.feedback,
    logs: f.state.logs,
  });

for (const { badgePlatform, expectedBadges } of [
  { badgePlatform: 'linux', expectedBadges: [0] },
  { badgePlatform: 'darwin', expectedBadges: [0] },
  { badgePlatform: 'win32', expectedBadges: [] },
] as const)
  for (const status of [302, 403, 410])
    test(`actual SDK HTTP ${status} stays a single safe transfer failure through processing on ${badgePlatform}`, async () => {
      const f = await downloaderFixture({ badgePlatform });
      try {
        f.state.infoMode = 'resolve';
        f.state.mediaStatus = status;
        const context = f.createContext('transfer-status');
        (context.window as unknown as { focused: boolean }).focused = true;
        await f.source.downloader.onMainLoad(context);
        await f.source.downloader.downloadSongFromId('one');
        expect(f.state.dialogs).toHaveLength(1);
        expect(f.state.dialogs[0]).toMatchObject({
          detail: expect.stringMatching(
            new RegExp(
              `Audio transfer failed.*stage: transfer.*HTTP status: ${status}`,
            ),
          ),
        });
        expect(outputs(f)).not.toContain('Audio processing/tagging failed');
        expect(outputs(f)).not.toContain('private-');
        expect(f.state.runs).toEqual([]);
        expect(await readdir(f.downloads)).toEqual([]);
        expect(f.state.progress.at(-1)?.value).toBe(-1);
        expect(f.state.badges).toEqual(expectedBadges);
      } finally {
        await f.close();
      }
    });

test('unknown network failure remains a safe transfer failure without invented HTTP status', async () => {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    f.state.mediaNetworkError = true;
    await f.source.downloader.onMainLoad(f.createContext('network-failure'));
    await f.source.downloader.downloadSongFromId('one');
    const feedback = f.state.feedback
      .filter((row) => row.name === 'downloader-feedback')
      .at(-1)?.args[0];
    expect(feedback).toEqual(expect.stringContaining('stage: transfer'));
    expect(outputs(f)).not.toContain('HTTP status:');
    expect(outputs(f)).not.toContain('Audio processing/tagging failed');
    expect(outputs(f)).not.toContain('private-');
    expect(f.state.runs).toEqual([]);
    expect(await readdir(f.downloads)).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const status of [0, 200, 299, 600, 403.5, NaN, '403'])
  test(`unrecognized HTTP status ${status} is omitted from diagnostics`, async () => {
    const f = await downloaderFixture();
    try {
      f.state.infoMode = 'resolve';
      f.state.mediaStatus = status;
      await f.source.downloader.onMainLoad(f.createContext('invalid-status'));
      await f.source.downloader.downloadSongFromId('one');
      expect(outputs(f)).toContain('stage: transfer');
      expect(outputs(f)).not.toContain('HTTP status:');
      expect(outputs(f)).not.toContain('private-');
      expect(await readdir(f.downloads)).toEqual([]);
    } finally {
      await f.close();
    }
  });

test('converter failure stays a processing failure and is reported once', async () => {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    f.state.ffmpegPartialFailure = true;
    const context = f.createContext('processing-failure');
    (context.window as unknown as { focused: boolean }).focused = true;
    await f.source.downloader.onMainLoad(context);
    await f.source.downloader.downloadSongFromId('one');
    expect(f.state.dialogs).toHaveLength(1);
    expect(f.state.dialogs[0]).toMatchObject({
      detail: expect.stringContaining('Owned partial-output converter failure'),
    });
    expect(outputs(f)).not.toContain('stage: transfer');
    expect(outputs(f)).not.toContain('HTTP status:');
    expect(await readdir(f.downloads)).toEqual([]);
  } finally {
    await f.close();
  }
});

test('retired owner cancellation emits no transfer failure or completion', async () => {
  const f = await downloaderFixture();
  try {
    f.state.infoMode = 'resolve';
    f.state.networkMode = 'defer';
    const context = f.createContext('cancel-transfer');
    await f.source.downloader.onMainLoad(context);
    const pending = f.source.downloader.downloadSongFromId('one');
    await expect.poll(() => f.state.network.length).toBe(1);
    f.source.downloader.onMainStop?.(context);
    await pending;
    expect(f.state.dialogs).toEqual([]);
    expect(f.state.logs).toEqual([]);
    expect(outputs(f)).not.toContain('stage: transfer');
    expect(f.state.runs).toEqual([]);
    expect(await readdir(f.downloads)).toEqual([]);
  } finally {
    await f.close();
  }
});
