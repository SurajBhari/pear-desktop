import { existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';

async function actual() {
  const url = new URL('../src/providers/queue-playlist.ts', import.meta.url);
  if (existsSync(url)) return import(url.href);
  // Initial missing-feature witness stays an assertion failure, not a missing-module error.
  return {
    parsePlaylistInput: () => null,
    sliceQueueDatasFromVideo: (rows: unknown[]) => rows,
    validatedPlaylistQueueDatas: () => undefined,
    queueItemsFromDatas: () => [],
  };
}
const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
const rows = ids.map((videoId) => ({
  content: {
    playlistPanelVideoRenderer: {
      videoId,
      selected: true,
      title: { runs: [{ text: videoId }] },
    },
  },
}));
const playlistId = 'PLABCDEFGHIJKLmnop_0123';

test('ordered middle, first and absent starts preserve the approved slice contract', async () => {
  const p = await actual();
  expect(p.sliceQueueDatasFromVideo(rows, ids[1])).toEqual(rows.slice(1));
  expect(p.sliceQueueDatasFromVideo(rows, ids[0])).toBe(rows);
  expect(p.sliceQueueDatasFromVideo(rows, 'zzzzzzzzzzz')).toBe(rows);
});

test('validated direct and wrapped video rows retain order and duplicates without mutating source', async () => {
  const p = await actual();
  const wrapped = {
    content: {
      playlistPanelVideoWrapperRenderer: {
        primaryRenderer: {
          playlistPanelVideoRenderer: { videoId: ids[1], selected: true },
        },
      },
    },
  };
  const batch = [rows[0], wrapped, rows[0]];
  const before = structuredClone(batch);
  const verified = p.validatedPlaylistQueueDatas({ queueDatas: batch });
  expect(verified).toEqual(batch);
  expect(p.sliceQueueDatasFromVideo(verified, ids[1])).toEqual(batch.slice(1));
  const contents = p.queueItemsFromDatas(verified);
  expect(
    contents.map(
      (content: any) =>
        (
          content.playlistPanelVideoRenderer ??
          content.playlistPanelVideoWrapperRenderer.primaryRenderer
            .playlistPanelVideoRenderer
        ).videoId,
    ),
  ).toEqual([ids[0], ids[1], ids[0]]);
  expect(
    contents.map(
      (content: any) =>
        (
          content.playlistPanelVideoRenderer ??
          content.playlistPanelVideoWrapperRenderer.primaryRenderer
            .playlistPanelVideoRenderer
        ).selected,
    ),
  ).toEqual([false, false, false]);
  expect(batch).toEqual(before);
});

test('raw playlist/video/position input is validated and bounded before serialization', async () => {
  const p = await actual();
  expect(p.parsePlaylistInput(playlistId, ids[0], undefined)).toEqual({
    playlistId,
    videoId: ids[0],
    insertPosition: 'INSERT_AT_END',
  });
  expect(
    p.parsePlaylistInput('WL', undefined, 'INSERT_AFTER_CURRENT_VIDEO'),
  ).toEqual({
    playlistId: 'WL',
    videoId: undefined,
    insertPosition: 'INSERT_AFTER_CURRENT_VIDEO',
  });
  for (const invalid of [
    undefined,
    null,
    1,
    '',
    'PL',
    'https://music.youtube.com/playlist?list=' + playlistId,
    'PL' + 'a'.repeat(127),
    'PLbad space',
  ])
    expect(p.parsePlaylistInput(invalid, undefined, undefined)).toBeNull();
  for (const invalid of [
    '',
    null,
    123,
    'too-short',
    'a'.repeat(12),
    'javascript:x',
  ])
    expect(p.parsePlaylistInput(playlistId, invalid, undefined)).toBeNull();
  for (const invalid of ['', null, 0, 'INSERT_ANYWHERE'])
    expect(p.parsePlaylistInput(playlistId, undefined, invalid)).toBeNull();
});

test('one verified response accepts the bound and preserves an empty no-op batch', async () => {
  const p = await actual();
  expect(p.validatedPlaylistQueueDatas({ queueDatas: [] })).toEqual([]);
  expect(
    p.validatedPlaylistQueueDatas({
      queueDatas: Array.from({ length: 1000 }, () => rows[0]),
    }),
  ).toHaveLength(1000);
});

for (const [name, response] of [
  ['oversize', { queueDatas: Array.from({ length: 1001 }, () => rows[0]) }],
  ['missing array', {}],
  ['wrong array', { queueDatas: {} }],
  [
    'invalid native video',
    {
      queueDatas: [
        { content: { playlistPanelVideoRenderer: { videoId: 'not-video' } } },
      ],
    },
  ],
  ['malformed mixed row', { queueDatas: [rows[0], null] }],
  [
    'ambiguous renderers',
    {
      queueDatas: [
        {
          content: {
            playlistPanelVideoRenderer: { videoId: ids[0] },
            playlistPanelVideoWrapperRenderer: {
              primaryRenderer: {
                playlistPanelVideoRenderer: { videoId: ids[1] },
              },
            },
          },
        },
      ],
    },
  ],
  ['continuation', { queueDatas: rows, continuation: 'owned-next' }],
  [
    'continuations',
    {
      queueDatas: rows,
      continuations: [{ nextContinuationData: { continuation: 'owned-next' } }],
    },
  ],
] as const)
  test(`rejects ${name} as a whole batch before queue mutation`, async () => {
    const p = await actual();
    expect(() => p.validatedPlaylistQueueDatas(response)).toThrow();
  });
