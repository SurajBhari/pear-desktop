import { test, expect } from '@playwright/test';
import {
  lrclibFixture,
  lrclibSong,
  lrclibTrack,
  settleLRCLib,
} from './helpers/lrclib-provider';

const song = {
  ...lrclibSong,
  title: 'Clockwork Harbor',
  artist: 'Example Artist',
  album: 'Example Album',
  songDuration: 214,
};
const track = (patch: Record<string, unknown> = {}) =>
  lrclibTrack({
    trackName: song.title,
    artistName: song.artist,
    albumName: song.album,
    duration: song.songDuration,
    ...patch,
  });
const sparse = (patch: Record<string, unknown> = {}) =>
  track({
    syncedLyrics: '[00:00.00]One verse',
    plainLyrics: 'Sparse',
    ...patch,
  });
const distributed = (patch: Record<string, unknown> = {}) =>
  track({
    duration: 210,
    syncedLyrics:
      '[00:00.00]Opening verse\n[01:00.00]Middle verse\n[02:00.00]Closing verse',
    plainLyrics: 'Distributed',
    ...patch,
  });

for (const duration of [210, 218]) {
  for (const reversed of [false, true]) {
    test(`LRCLib candidate quality prefers distributed ${duration}s over sparse exact 214s in ${reversed ? 'reverse' : 'forward'} order`, async () => {
      const candidates = [sparse(), distributed({ duration })];
      const f = await lrclibFixture(() =>
        reversed ? candidates.toReversed() : candidates,
      );
      try {
        expect((await f.provider.search(song))?.lyrics).toBe('Distributed');
        expect(f.calls.length).toBeLessThanOrEqual(4);
      } finally {
        await f.close();
      }
    });
  }
}

test('LRCLib candidate quality continues after sparse exact first response to bounded distributed alternatives', async () => {
  const f = await lrclibFixture(({ index }) =>
    index === 0 ? [sparse()] : [distributed({ duration: 214 })],
  );
  try {
    expect((await f.provider.search(song))?.lyrics).toBe('Distributed');
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality retains legitimate one-line fallback after bounded searches', async () => {
  const f = await lrclibFixture(({ index }) => (index === 0 ? [sparse()] : []));
  try {
    const result = await f.provider.search(song);
    expect(result?.lyrics).toBe('Sparse');
    expect(result?.lines).toMatchObject([{ timeInMs: 0, text: 'One verse' }]);
    expect(f.calls.length).toBeGreaterThan(1);
    expect(f.calls.length).toBeLessThanOrEqual(4);
    expect(new Set(f.calls.map(({ url }) => url.href)).size).toBe(
      f.calls.length,
    );
  } finally {
    await f.close();
  }
});

for (const [label, patch] of [
  ['artist mismatch', { artistName: 'Different Artist' }],
  ['album mismatch', { albumName: 'Different Album' }],
  ['missing album', { albumName: null }],
  ['title mismatch', { trackName: 'Different Harbor' }],
  ['fuzzy-only title', { trackName: 'Clockwork Harbors' }],
  ['live version', { trackName: `${song.title} (Live)` }],
  ['remix version', { trackName: `${song.title} (Remix)` }],
  ['remastered version', { trackName: `${song.title} (Remastered)` }],
  ['duration beyond four seconds', { duration: 209.99 }],
  [
    'fewer than three timestamps',
    { syncedLyrics: '[00:00.00]Start\n[02:00.00]End' },
  ],
  [
    'duplicate timestamp positions',
    { syncedLyrics: '[00:00.00]Start\n[00:00.00]Repeat\n[02:00.00]End' },
  ],
  [
    'blank distant cue',
    { syncedLyrics: '[00:00.00]Start\n[00:01.00]Next\n[02:00.00]   ' },
  ],
  [
    'spread below half duration',
    { syncedLyrics: '[00:00.00]Start\n[00:50.00]Next\n[01:46.99]End' },
  ],
] as const) {
  test(`LRCLib candidate quality cannot promote ${label}`, async () => {
    const f = await lrclibFixture(() => [sparse(), distributed(patch)]);
    try {
      f.state.config.showLyricsEvenIfInexact = true;
      expect((await f.provider.search(song))?.lyrics).toBe('Sparse');
      expect(f.calls.length).toBeLessThanOrEqual(4);
    } finally {
      await f.close();
    }
  });
}

test('LRCLib candidate quality includes exactly half-duration coverage', async () => {
  const f = await lrclibFixture(() => [
    sparse(),
    distributed({
      syncedLyrics: '[00:00.00]Start\n[00:50.00]Next\n[01:47.00]End',
    }),
  ]);
  try {
    expect((await f.provider.search(song))?.lyrics).toBe('Distributed');
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality measures parsed lyricsfile text and clocks', async () => {
  const f = await lrclibFixture(() => [
    sparse({ lyricsfile: 'lines:\n  - text: One verse\n    start_ms: 0' }),
    distributed({
      syncedLyrics: null,
      lyricsfile:
        'lines:\n  - text: Start\n    start_ms: 0\n  - text: Middle\n    start_ms: 60000\n  - text: End\n    start_ms: 120000',
    }),
  ]);
  try {
    expect((await f.provider.search(song))?.lyrics).toBe('Distributed');
  } finally {
    await f.close();
  }
});

for (const order of [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]) {
  test(`LRCLib candidate quality is order-independent with an ordinary timed candidate: ${order}`, async () => {
    const candidates = [
      sparse(),
      distributed(),
      track({
        duration: 212,
        syncedLyrics: '[00:01.00]First verse\n[00:02.00]Second verse',
        plainLyrics: 'Ordinary',
      }),
    ];
    const f = await lrclibFixture(() =>
      order.map((index) => candidates[index]),
    );
    try {
      expect((await f.provider.search(song))?.lyrics).toBe('Ordinary');
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

for (const durations of [
  [210, 218],
  [218, 210],
]) {
  test(`LRCLib candidate quality keeps existing first-encounter ties: ${durations}`, async () => {
    const f = await lrclibFixture(() => [
      sparse(),
      ...durations.map((duration) =>
        distributed({ duration, plainLyrics: String(duration) }),
      ),
    ]);
    try {
      expect((await f.provider.search(song))?.lyrics).toBe(
        String(durations[0]),
      );
    } finally {
      await f.close();
    }
  });
}

test('LRCLib candidate quality preserves explicit instrumental fast path', async () => {
  const f = await lrclibFixture(() => [
    track({ instrumental: true, syncedLyrics: null, plainLyrics: null }),
    distributed(),
  ]);
  try {
    expect((await f.provider.search(song))?.lines).toMatchObject([
      { instrumental: true, timeInMs: 0, duration: 214000 },
    ]);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality keeps timed sparse ahead of plain-only', async () => {
  const f = await lrclibFixture(() => [
    sparse(),
    distributed({ syncedLyrics: null }),
  ]);
  try {
    expect((await f.provider.search(song))?.lyrics).toBe('Sparse');
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality requires a requested duration for distributed preference', async () => {
  const f = await lrclibFixture(() => [sparse(), distributed()]);
  try {
    expect(
      (await f.provider.search({ ...song, songDuration: undefined }))?.lyrics,
    ).toBe('Sparse');
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality retains sparse fallback at the existing candidate limit', async () => {
  const f = await lrclibFixture(() =>
    Array.from({ length: 200 }, () => sparse()),
  );
  try {
    expect((await f.provider.search(song))?.lyrics).toBe('Sparse');
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality retains sparse fallback when another response exceeds the candidate budget', async () => {
  const f = await lrclibFixture(({ index }) =>
    index === 0 ? [sparse()] : Array.from({ length: 200 }, () => distributed()),
  );
  try {
    expect((await f.provider.search(song))?.lyrics).toBe('Sparse');
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality keeps sparse fallback on later network failure without retry', async () => {
  const f = await lrclibFixture(({ index }) => {
    if (index === 0) return [sparse()];
    throw new Error('Fixture network failure');
  });
  try {
    expect((await f.provider.search(song))?.lyrics).toBe('Sparse');
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('LRCLib candidate quality keeps sparse fallback when bounded alternative exceeds deadline', async () => {
  const body = new ReadableStream<Uint8Array>();
  const f = await lrclibFixture(({ index }) =>
    index === 0 ? [sparse()] : new Response(body),
  );
  const original = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  try {
    globalThis.setTimeout = ((callback: () => void) => {
      expire = callback;
      return { unref() {} };
    }) as unknown as typeof setTimeout;
    const pending = f.provider.search(song);
    await settleLRCLib();
    globalThis.setTimeout = original;
    expect(f.calls).toHaveLength(2);
    expect(typeof expire).toBe('function');
    expire!();
    expect((await pending)?.lyrics).toBe('Sparse');
    expect(f.calls.at(-1)?.init?.signal?.aborted).toBe(true);
  } finally {
    globalThis.setTimeout = original;
    await f.close();
  }
});
