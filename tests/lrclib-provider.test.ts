import { test, expect } from '@playwright/test';
import {
  lrclibFixture,
  lrclibSong,
  lrclibTrack,
  settleLRCLib,
} from './helpers/lrclib-provider';

test('LRCLib complete exact synchronized match needs one query and preserves word timestamps/status', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({
      syncedLyrics:
        '[offset:100]\n[00:01.00]<00:01.00>👩🏽‍🚀 <00:02.00>東京\n[00:04.00]Later',
    }),
  ]);
  try {
    const result = await f.provider.search(lrclibSong);
    expect(f.calls).toHaveLength(1);
    expect(
      result?.lines.find((line: any) => line.timeInMs === 1100),
    ).toMatchObject({
      text: '👩🏽‍🚀 東京',
      status: 'upcoming',
      words: [
        { word: '👩🏽‍🚀 ', timeInMs: 1100 },
        { word: '東京', timeInMs: 2100 },
      ],
    });
  } finally {
    await f.close();
  }
});
test('LRCLib full multiartist identity outranks a closer single-artist record and emits requested artist order', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({ id: 1, artistName: 'Alpha', duration: 269 }),
    lrclibTrack({ id: 2, artistName: 'Beta & Alpha', duration: 270 }),
  ]);
  try {
    const result = await f.provider.search({
      ...lrclibSong,
      artist: 'Alpha & Beta',
    });
    expect(result?.artists).toEqual(['Alpha', 'Beta']);
    expect(result?.title).toBe('Yellow');
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('LRCLib exact title outranks fuzzy same-artist duration winner', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({ id: 1, trackName: 'Yellow Moon', duration: 269 }),
    lrclibTrack({ id: 2, duration: 270 }),
  ]);
  try {
    expect((await f.provider.search(lrclibSong))?.title).toBe('Yellow');
  } finally {
    await f.close();
  }
});
test('LRCLib rejects unrelated same-artist titles and every missing requested collaborator', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({ trackName: 'Unrelated' }),
    lrclibTrack({ id: 2, artistName: 'Alpha' }),
  ]);
  try {
    expect(await f.provider.search(lrclibSong)).toBeNull();
    f.state.config.showLyricsEvenIfInexact = true;
    expect(
      await f.provider.search({ ...lrclibSong, artist: 'Alpha & Beta' }),
    ).toBeNull();
    expect(f.calls.length).toBeLessThanOrEqual(8);
  } finally {
    await f.close();
  }
});
test('LRCLib normalizes channel suffix/official title and omits absent album instead of null', async () => {
  const f = await lrclibFixture(() => [lrclibTrack()]);
  try {
    expect(
      (
        await f.provider.search({
          ...lrclibSong,
          artist: ' Coldplay - Topic ',
          title: 'Coldplay - Yellow (Official Music Video)',
          album: null,
        })
      )?.title,
    ).toBe('Yellow');
    expect(f.calls[0].url.searchParams.get('album_name')).toBeNull();
    expect(f.calls[0].url.searchParams.get('artist_name')).toBe('Coldplay');
  } finally {
    await f.close();
  }
});
test('LRCLib alternative original-language title can produce a strict match after empty primary', async () => {
  const f = await lrclibFixture((call) =>
    call.index === 0 ? [] : [lrclibTrack({ trackName: '黄色' })],
  );
  try {
    expect(
      (await f.provider.search({ ...lrclibSong, alternativeTitle: '黄色' }))
        ?.title,
    ).toBe('黄色');
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test('LRCLib continues beyond nonempty but unusable candidates and deduplicates bounded fallbacks', async () => {
  const f = await lrclibFixture((call) =>
    call.index === 0
      ? [lrclibTrack({ syncedLyrics: 'invalid', plainLyrics: '' })]
      : [lrclibTrack()],
  );
  try {
    expect(
      (
        await f.provider.search({ ...lrclibSong, alternativeTitle: ' Yellow ' })
      )?.lines.some((line: any) => line.text === 'First'),
    ).toBe(true);
    expect(f.calls.length).toBeGreaterThan(1);
    expect(f.calls.length).toBeLessThanOrEqual(4);
    expect(new Set(f.calls.map((call) => call.url.href)).size).toBe(
      f.calls.length,
    );
  } finally {
    await f.close();
  }
});
test('LRCLib selects a validated synchronized record ahead of exact plain-only record', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({ id: 1, syncedLyrics: null, duration: 269 }),
    lrclibTrack({ id: 2, duration: 270 }),
  ]);
  try {
    expect(
      (await f.provider.search(lrclibSong))?.lines.some(
        (line: any) => line.text === 'First',
      ),
    ).toBe(true);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('LRCLib an empty exact plain result searches for timed lyrics within four unique queries', async () => {
  const f = await lrclibFixture((call) =>
    call.index === 0 ? [lrclibTrack({ syncedLyrics: null })] : [lrclibTrack()],
  );
  try {
    expect((await f.provider.search(lrclibSong))?.lines).toBeDefined();
    expect(f.calls.length).toBeGreaterThan(1);
    expect(f.calls.length).toBeLessThanOrEqual(4);
  } finally {
    await f.close();
  }
});
test('LRCLib rejects excessive duration and explicit version mismatches even with fuzzy preference', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({ duration: 300 }),
    lrclibTrack({ id: 2, trackName: 'Yellow (Live)' }),
  ]);
  try {
    f.state.config.showLyricsEvenIfInexact = true;
    expect(await f.provider.search(lrclibSong)).toBeNull();
    expect(
      await f.provider.search({
        ...lrclibSong,
        title: 'Yellow (Remix)',
        alternativeTitle: 'Yellow',
      }),
    ).toBeNull();
  } finally {
    await f.close();
  }
});
test('LRCLib ignores malformed rows rather than losing a valid subsequent candidate', async () => {
  const f = await lrclibFixture(() => [
    null,
    { artistName: 22 },
    { ...lrclibTrack(), duration: '269' },
    lrclibTrack({ id: 4 }),
  ]);
  try {
    expect((await f.provider.search(lrclibSong))?.title).toBe('Yellow');
  } finally {
    await f.close();
  }
});
for (const lyricsfile of [
  'lines:\n - text: |\n   start_ms: 0',
  'lines:\n - start_ms: 1000\n   words: []',
  null,
  32,
])
  test(`LRCLib malformed optional lyricsfile retains LRC fallback: ${String(lyricsfile)}`, async () => {
    const f = await lrclibFixture(() => [lrclibTrack({ lyricsfile })]);
    try {
      expect(
        (await f.provider.search(lrclibSong))?.lines.some(
          (line: any) => line.text === 'First',
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
test('LRCLib valid lyricsfile word boundaries and instrumental marker retain fork results', async () => {
  const f = await lrclibFixture((call) => [
    lrclibTrack(
      call.index === 0
        ? {
            lyricsfile:
              'metadata:\n  offset_ms: 100\nlines:\n  - text: "Hello world"\n    start_ms: 1000\n    end_ms: 3500\n    words:\n      - text: "Hello "\n        start_ms: 1000\n        end_ms: 1800\n      - text: world\n        start_ms: 2000\n        end_ms: 3500',
          }
        : { instrumental: true, syncedLyrics: null, plainLyrics: null },
    ),
  ]);
  try {
    const first = await f.provider.search(lrclibSong);
    expect(
      first?.lines.find((line: any) => line.timeInMs === 1100),
    ).toMatchObject({
      timeInMs: 1100,
      words: [
        { word: 'Hello ', timeInMs: 1100, endTimeInMs: 1900 },
        { word: 'world', timeInMs: 2100, endTimeInMs: 3600 },
      ],
      status: 'upcoming',
    });
    expect((await f.provider.search(lrclibSong))?.lines[0]).toMatchObject({
      timeInMs: 0,
      duration: 269000,
      words: [],
      instrumental: true,
      status: 'upcoming',
    });
  } finally {
    await f.close();
  }
});
test('LRCLib album tie-break stays below exact identity and synchronized completeness', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({
      id: 1,
      albumName: 'Other',
      duration: 269,
      plainLyrics: 'Other',
    }),
    lrclibTrack({
      id: 2,
      albumName: 'Parachutes',
      duration: 270,
      plainLyrics: 'Preferred',
    }),
  ]);
  try {
    expect(
      (await f.provider.search({ ...lrclibSong, album: 'Parachutes' }))?.lyrics,
    ).toBe('Preferred');
  } finally {
    await f.close();
  }
});
test('LRCLib bounded fallback failure has no cross-request negative/result cache', async () => {
  let empty = true;
  const f = await lrclibFixture(() => (empty ? [] : [lrclibTrack()]));
  try {
    f.state.config.showLyricsEvenIfInexact = true;
    expect(
      await f.provider.search({ ...lrclibSong, alternativeTitle: '黄色' }),
    ).toBeNull();
    expect(f.calls.length).toBeLessThanOrEqual(4);
    const count = f.calls.length;
    empty = false;
    expect((await f.provider.search(lrclibSong))?.title).toBe('Yellow');
    expect(f.calls.length).toBe(count + 1);
  } finally {
    await f.close();
  }
});
test('LRCLib superseding request retires a held obsolete response without caching or fallback', async () => {
  let release!: (value: unknown) => void;
  const f = await lrclibFixture((call) =>
    call.index === 0
      ? new Promise((r) => {
          release = r;
        })
      : [lrclibTrack({ trackName: 'Blue' })],
  );
  try {
    const old = f.provider.search(lrclibSong);
    await settleLRCLib();
    const fresh = f.provider.search({ ...lrclibSong, title: 'Blue' });
    expect((await fresh)?.title).toBe('Blue');
    release([lrclibTrack()]);
    expect(await old).toBeNull();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].init?.signal?.aborted).toBe(true);
  } finally {
    await f.close();
  }
});
test('LRCLib observed renderer stop prevents late empty response from dispatching fallback', async () => {
  let release!: (value: unknown) => void;
  const f = await lrclibFixture((call) =>
    call.index === 0
      ? new Promise((r) => {
          release = r;
        })
      : [],
  );
  try {
    f.state.config.showLyricsEvenIfInexact = true;
    const pending = f.provider.search(lrclibSong);
    await settleLRCLib();
    f.state.config.enabled = false;
    release([]);
    expect(await pending).toBeNull();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('LRCLib HTTP failure keeps a provider error and no extra queries', async () => {
  const f = await lrclibFixture(
    () => new Response('unavailable', { status: 503 }),
  );
  try {
    await expect(f.provider.search(lrclibSong)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('LRCLib metadata and response work limits reject oversized unsupported payloads', async () => {
  const f = await lrclibFixture(
    () =>
      new Response(
        JSON.stringify([
          lrclibTrack({ plainLyrics: 'x'.repeat(1024 * 1024 + 1) }),
        ]),
      ),
  );
  try {
    expect(
      await f.provider.search({ ...lrclibSong, title: 'x'.repeat(10000) }),
    ).toBeNull();
    expect(f.calls).toHaveLength(0);
    await expect(f.provider.search(lrclibSong)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('actual lyrics store retains session/track/cache ownership around LRCLib late data', async () => {
  let release!: (value: unknown) => void;
  const f = await lrclibFixture(
    (call) =>
      call.index === 0
        ? new Promise((r) => {
            release = r;
          })
        : [lrclibTrack({ trackName: 'Blue' })],
    true,
  );
  try {
    f.source.startLyricsSession();
    f.source.fetchLyrics(f.state.song);
    await settleLRCLib();
    f.source.stopLyricsSession();
    release([lrclibTrack()]);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.source.lyricsStore.lyrics.LRCLib).toMatchObject({
      state: 'fetching',
      data: null,
    });
    f.state.song = { ...lrclibSong, videoId: 'public-fresh', title: 'Blue' };
    f.source.startLyricsSession();
    f.source.fetchLyrics(f.state.song);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.source.lyricsStore.lyrics.LRCLib).toMatchObject({
      state: 'done',
      data: { title: 'Blue' },
    });
  } finally {
    await f.close();
  }
});

test('LRCLib actual artist credits stay one-to-one when fuzzy names are close', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({ artistName: 'Artist Alice3 & Artist Alice4' }),
  ]);
  try {
    f.state.config.showLyricsEvenIfInexact = true;
    expect(
      (
        await f.provider.search({
          ...lrclibSong,
          artist: 'Artist Alice1 & Artist Alice2',
        })
      )?.artists,
    ).toEqual(['Artist Alice3', 'Artist Alice4']);
  } finally {
    await f.close();
  }
});
test('LRCLib strict requested artist identity outranks tagged prefix fallback with timed lyrics', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({
      id: 1,
      artistName: 'Uploader',
      syncedLyrics: null,
      plainLyrics: 'Canonical',
    }),
    lrclibTrack({ id: 2, artistName: 'Coldplay' }),
  ]);
  try {
    const result = await f.provider.search({
      ...lrclibSong,
      artist: 'Uploader',
      alternativeTitle: 'Coldplay - Yellow',
      tags: ['Coldplay'],
    });
    expect(result?.artists).toEqual(['Uploader']);
    expect(result?.lyrics).toBe('Canonical');
  } finally {
    await f.close();
  }
});

test('LRCLib punctuation-only artist names cannot authorize each other through empty normalization', async () => {
  const f = await lrclibFixture(() => [lrclibTrack({ artistName: '???' })]);
  try {
    f.state.config.showLyricsEvenIfInexact = true;
    expect(
      await f.provider.search({ ...lrclibSong, artist: '!!!' }),
    ).toBeNull();
  } finally {
    await f.close();
  }
});
test('LRCLib preserves an exact punctuation-only performer instead of collapsing its identity', async () => {
  const f = await lrclibFixture(() => [lrclibTrack({ artistName: '!!!' })]);
  try {
    expect(
      (await f.provider.search({ ...lrclibSong, artist: '!!!' }))?.artists,
    ).toEqual(['!!!']);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('LRCLib a failed optional timed fallback preserves an already validated exact plain result', async () => {
  const f = await lrclibFixture((call) =>
    call.index === 0
      ? [lrclibTrack({ syncedLyrics: null })]
      : new Response('failure', { status: 503 }),
  );
  try {
    expect((await f.provider.search(lrclibSong))?.lyrics).toBe('First\nLater');
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});
for (const hasBest of [false, true])
  test(`LRCLib overall deadline bounds an unresponsive body ${hasBest ? 'while preserving a validated fallback' : 'without publishing incomplete data'}`, async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    const f = await lrclibFixture((call) =>
      hasBest && call.index === 0
        ? [lrclibTrack({ syncedLyrics: null })]
        : new Response(stream),
    );
    const original = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    try {
      globalThis.setTimeout = ((callback: () => void) => {
        expire = callback;
        return { unref() {} };
      }) as unknown as typeof setTimeout;
      const pending = f.provider.search(lrclibSong);
      void pending.catch(() => {});
      await settleLRCLib();
      globalThis.setTimeout = original;
      expect(f.calls).toHaveLength(hasBest ? 2 : 1);
      expect(typeof expire).toBe('function');
      expire!();
      if (hasBest) expect((await pending)?.lyrics).toBe('First\nLater');
      else await expect(pending).rejects.toThrow(/deadline/i);
      expect(f.calls.at(-1)?.init?.signal?.aborted).toBe(true);
    } finally {
      globalThis.setTimeout = original;
      try {
        body.close();
      } catch {}
      await f.close();
    }
  });

for (const [label, response] of [
  ['missing body', () => new Response(null)],
  ['object envelope', () => ({ results: [] })],
] as const) {
  test(`LRCLib rejects a successful response with ${label}`, async () => {
    const f = await lrclibFixture(response);
    try {
      await expect(f.provider.search(lrclibSong)).rejects.toThrow(
        /LRCLib response/,
      );
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

test('LRCLib verified title-prefix artist fallback accepts a complete matching credit', async () => {
  const f = await lrclibFixture(({ index }) =>
    index === 3 ? [lrclibTrack()] : [],
  );
  try {
    const result = await f.provider.search({
      ...lrclibSong,
      artist: 'Uploader',
      alternativeTitle: 'Coldplay - Yellow',
      tags: ['Coldplay'],
    });
    expect(f.calls).toHaveLength(4);
    expect(result?.artists).toEqual(['Coldplay']);
    expect(
      result?.lines?.some((line: { text: string }) => line.text === 'First'),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

for (const rejection of ['http', 'declared-budget'] as const) {
  for (const cancellation of ['settles', 'rejects', 'pending'] as const) {
    test(`LRCLib retires ${rejection} bodies without waiting for ${cancellation} cancellation or changing the primary error`, async () => {
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('unread response chunk'));
        },
        cancel() {
          canceled = true;
          if (cancellation === 'rejects')
            throw new Error('Cancellation failed');
          if (cancellation === 'pending') return new Promise<void>(() => {});
        },
      });
      const f = await lrclibFixture(
        () =>
          new Response(body, {
            status: rejection === 'http' ? 503 : 200,
            headers:
              rejection === 'declared-budget'
                ? { 'content-length': String(1024 * 1024 + 1) }
                : {},
          }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = f.provider.search(lrclibSong);
        const bounded = Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Cancellation blocked rejection')),
              500,
            );
          }),
        ]);
        await expect(bounded).rejects.toThrow(
          rejection === 'http' ? /HTTP 503/ : /response budget/,
        );
        expect(canceled).toBe(true);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].init?.signal?.aborted).toBe(false);
      } finally {
        clearTimeout(timer);
        void body.cancel().catch(() => {});
        await f.close();
      }
    });
  }
}

test('LRCLib rejected optional response cleanup retains the valid plain result and its search lease', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  });
  const f = await lrclibFixture(({ index }) =>
    index === 0
      ? [
          lrclibTrack({
            syncedLyrics: null,
            plainLyrics: 'Valid current plain',
          }),
        ]
      : new Response(body, { status: 503 }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      f.provider.search(lrclibSong),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Cancellation blocked fallback')),
          500,
        );
      }),
    ]);
    expect(result?.lyrics).toBe('Valid current plain');
    expect(canceled).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((call) => call.init?.signal?.aborted === false)).toBe(
      true,
    );
  } finally {
    clearTimeout(timer);
    void body.cancel().catch(() => {});
    await f.close();
  }
});

for (const [label, syncedLyrics] of [
  ['invalid offset', '[offset:not-a-number]\n[00:01.00]Invalid offset'],
  ['overflowed cue', `[${'9'.repeat(320)}:01.00]Invalid minutes`],
  ['overflowed word', `[00:01.00]<${'9'.repeat(320)}:01.00>Invalid word`],
] as const) {
  test(`LRCLib ${label} cannot outrank the valid exact plain candidate`, async () => {
    const f = await lrclibFixture(() => [
      lrclibTrack({
        id: 1,
        syncedLyrics: null,
        plainLyrics: 'Valid exact plain',
      }),
      lrclibTrack({ id: 2, syncedLyrics, plainLyrics: null }),
    ]);
    try {
      const result = await f.provider.search(lrclibSong);
      expect(result?.lyrics).toBe('Valid exact plain');
      expect(result?.lines).toBeUndefined();
      expect(f.calls.length).toBeLessThanOrEqual(4);
    } finally {
      await f.close();
    }
  });
}

test('LRCLib invalid LRC timing retains plain lyrics from the same recording', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({
      syncedLyrics: '[offset:invalid]\n[00:01.00]Invalid cue',
      plainLyrics: 'Current usable plain',
    }),
  ]);
  try {
    const result = await f.provider.search(lrclibSong);
    expect(result?.lyrics).toBe('Current usable plain');
    expect(result?.lines).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('LRCLib nonfinite optional word end clocks fall back to valid LRC', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({
      lyricsfile:
        'lines:\n  - text: Invalid end\n    start_ms: 1000\n    words:\n      - text: Invalid\n        start_ms: 1000\n        end_ms: ' +
        '9'.repeat(320),
    }),
  ]);
  try {
    const result = await f.provider.search(lrclibSong);
    expect(result?.lines?.some((line: any) => line.text === 'First')).toBe(
      true,
    );
    expect(
      result?.lines?.some((line: any) => line.text === 'Invalid end'),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('LRCLib keeps finite negative enhanced clocks and the legal trailing infinite duration', async () => {
  const f = await lrclibFixture(() => [
    lrclibTrack({
      syncedLyrics:
        '[offset:-1500]\n[00:01.00]<00:01.00>Before\n[00:04.00]<00:04.00>After',
    }),
  ]);
  try {
    const result = await f.provider.search(lrclibSong);
    expect(f.calls).toHaveLength(1);
    expect(result?.lines).toMatchObject([
      {
        timeInMs: -500,
        duration: 3000,
        text: 'Before',
        words: [{ timeInMs: -500, word: 'Before' }],
        status: 'upcoming',
      },
      {
        timeInMs: 2500,
        duration: Infinity,
        text: 'After',
        words: [{ timeInMs: 2500, word: 'After' }],
        status: 'upcoming',
      },
    ]);
  } finally {
    await f.close();
  }
});
