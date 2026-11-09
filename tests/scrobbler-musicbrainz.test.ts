import { existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';

async function client(
  fetcher: typeof fetch,
  extra: Record<string, unknown> = {},
) {
  expect(
    existsSync(
      new URL(
        '../src/plugins/scrobbler/services/musicbrainz.ts',
        import.meta.url,
      ),
    ),
  ).toBe(true);
  const { MusicBrainz } =
    await import('../src/plugins/scrobbler/services/musicbrainz');
  return new MusicBrainz({
    fetcher,
    identity: 'Pear/TEST',
    rate: { lastStart: -Infinity, tail: Promise.resolve(), queued: 0 },
    ...extra,
  });
}
const input = { title: 'песня (live)', artist: 'artist & guest' };
const corrected = { title: 'Песня (Live)', artist: 'Artist & Guest' };
const candidate = (extra = {}) => ({
  score: 100,
  title: 'Песня (Live)',
  'artist-credit': [{ name: 'Artist', joinphrase: ' & ' }, { name: 'Guest' }],
  ...extra,
});
test('explicit validated contact is required; full Unicode artist credits are preserved', async () => {
  const calls: any[] = [];
  const mb = await client(async (url, options) => {
    calls.push([url, options]);
    return Response.json({ recordings: [candidate()] });
  });
  const signal = new AbortController().signal;
  expect(await mb.correct(input, '', signal)).toEqual(input);
  expect(await mb.correct(input, 'bad\r\nemail', signal)).toEqual(input);
  expect(calls).toHaveLength(0);
  expect(await mb.correct(input, 'person@example.invalid', signal)).toEqual(
    corrected,
  );
  expect(calls).toHaveLength(1);
  const [url, options] = calls[0];
  expect(new URL(url).origin).toBe('https://musicbrainz.org');
  expect(new URL(url).searchParams.get('limit')).toBe('5');
  expect(options.redirect).toBe('error');
  expect(options.credentials).toBe('omit');
  expect(options.headers['User-Agent']).toContain('Pear/TEST');
  mb.stop();
});
test('malformed, low-confidence, ambiguous, variant-losing and failed matches retain input', async () => {
  for (const recordings of [
    [],
    [candidate({ score: undefined })],
    [candidate({ score: '100' })],
    [candidate({ score: 94 })],
    [candidate({ title: '' })],
    [candidate({ title: 'Песня' })],
    [candidate({ 'artist-credit': [] })],
    [candidate(), candidate({ title: 'Different', score: 99 })],
  ]) {
    const mb = await client(async () => Response.json({ recordings }));
    expect(
      await mb.correct(
        input,
        'person@example.invalid',
        new AbortController().signal,
      ),
    ).toEqual(input);
    mb.stop();
  }
  const split = { title: 'Wrong Artist - Real Title', artist: 'Actual Artist' };
  const mb = await client(async () => new Response('', { status: 400 }));
  expect(
    await mb.correct(
      split,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(split);
  mb.stop();
});
test('total deadline aborts hung request and cancellation never populates cache', async () => {
  let aborted = false;
  const mb = await client(
    async (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => {
          aborted = true;
          reject(Error('cancel'));
        }),
      ),
    { budgetMs: 40 },
  );
  expect(
    await mb.correct(
      input,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(input);
  expect(aborted).toBe(true);
  mb.stop();
});
test('requests respect start spacing, typed cache TTL and bounded body size', async () => {
  let now = 0;
  const starts: number[] = [];
  const mb = await client(
    async () => {
      starts.push(now);
      return Response.json({ recordings: [candidate()] });
    },
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
      positiveTtlMs: 2000,
    },
  );
  const signal = new AbortController().signal;
  await mb.correct(input, 'person@example.invalid', signal);
  await mb.correct(input, 'person@example.invalid', signal);
  expect(starts).toEqual([0]);
  now = 2100;
  await mb.correct(input, 'person@example.invalid', signal);
  await mb.correct(
    { title: 'Other', artist: 'Other' },
    'person@example.invalid',
    signal,
  );
  expect(starts).toEqual([0, 2100, 3200]);
  mb.stop();
  const huge = await client(
    async () => new Response(' '.repeat(256 * 1024 + 1)),
  );
  expect(await huge.correct(input, 'person@example.invalid', signal)).toEqual(
    input,
  );
  huge.stop();
});

test('retry is bounded and cannot bypass spacing or operation deadline', async () => {
  let now = 0;
  const starts: number[] = [];
  const mb = await client(
    async () => {
      starts.push(now);
      return starts.length === 1
        ? new Response('', { status: 503, headers: { 'retry-after': '1' } })
        : Response.json({ recordings: [candidate()] });
    },
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  expect(
    await mb.correct(
      input,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(corrected);
  expect(starts).toEqual([0, 1100]);
  mb.stop();
  let calls = 0;
  const limited = await client(async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'retry-after': '60' } });
  });
  expect(
    await limited.correct(
      input,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(input);
  expect(calls).toBe(1);
  limited.stop();
});

test('cancelled queue entries do not block later requests or cache a transient failure', async () => {
  let now = 0;
  let calls = 0;
  let release!: (value: Response) => void;
  const mb = await client(
    async () => {
      calls++;
      if (calls === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Response.json({ recordings: [candidate()] });
    },
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  const firstOwner = new AbortController();
  const first = mb.correct(input, 'person@example.invalid', firstOwner.signal);
  await expect.poll(() => calls).toBe(1);
  const queuedOwner = new AbortController();
  const queued = mb.correct(
    input,
    'person@example.invalid',
    queuedOwner.signal,
  );
  queuedOwner.abort();
  expect(await queued).toEqual(input);
  firstOwner.abort();
  expect(await first).toEqual(input);
  expect(
    await mb.correct(
      input,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(corrected);
  expect(calls).toBe(2);
  release(Response.json({ recordings: [candidate({ title: 'Late' })] }));
  mb.stop();
});

test('an abort while streaming cancels the body and discards the partial response', async () => {
  let cancelled = false;
  const owner = new AbortController();
  const mb = await client(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            setTimeout(() => owner.abort(), 10);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  expect(
    await mb.correct(input, 'person@example.invalid', owner.signal),
  ).toEqual(input);
  expect(cancelled).toBe(true);
  mb.stop();
});

test('late response after owner cancellation has its unread body cancelled', async () => {
  let release!: (value: Response) => void;
  let cancelled = false;
  const mb = await client(
    async () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const owner = new AbortController();
  const pending = mb.correct(input, 'person@example.invalid', owner.signal);
  await expect.poll(() => typeof release).toBe('function');
  owner.abort();
  expect(await pending).toEqual(input);
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await expect.poll(() => cancelled).toBe(true);
  mb.stop();
});

test('shared rate state preserves start spacing across client retirement and replacement', async () => {
  let now = 0;
  const starts: number[] = [];
  const rate = { lastStart: -Infinity, tail: Promise.resolve(), queued: 0 };
  const options = {
    rate,
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
  };
  const fetcher: typeof fetch = async () => {
    starts.push(now);
    return Response.json({ recordings: [] });
  };
  const first = await client(fetcher, options);
  await first.correct(
    input,
    'person@example.invalid',
    new AbortController().signal,
  );
  first.stop();
  const second = await client(fetcher, options);
  await second.correct(
    input,
    'person@example.invalid',
    new AbortController().signal,
  );
  second.stop();
  expect(starts).toEqual([0, 1100]);
});

test('split queries correct Artist - Title only after exact database and original-artist corroboration', async () => {
  let now = 0;
  const queries: string[] = [];
  const original = {
    title: 'Artist & Guest — Песня (Live)',
    artist: 'Artist & Guest',
    album: 'Album',
    duration: 180,
  };
  const mb = await client(
    async (url) => {
      const query = new URL(String(url)).searchParams.get('query')!;
      queries.push(query);
      return Response.json({
        recordings: queries.length === 1 ? [] : [candidate()],
      });
    },
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  expect(
    await mb.correct(
      original,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual({ ...original, title: 'Песня (Live)' });
  expect(queries).toEqual([
    'recording:"Artist & Guest — Песня (Live)" AND artist:"Artist & Guest"',
    'recording:"Песня (Live)" AND artist:"Artist & Guest"',
  ]);
  expect(original.title).toBe('Artist & Guest — Песня (Live)');
  mb.stop();
});

test('an upload-channel artist requires independent finite original duration evidence for a split correction', async () => {
  const original = {
    title: 'Artist & Guest - Песня (Live)',
    artist: 'Upload Channel',
    album: 'Album',
    duration: 180,
  };
  for (const [durationSeconds, length, accepted] of [
    [180, 181999, true],
    [180, 182001, false],
    [180, undefined, false],
    [0, 180000, false],
    [NaN, 180000, false],
    [180, '180000', false],
    [undefined, 180000, false],
  ] as const) {
    let now = 0;
    let calls = 0;
    const mb = await client(
      async () =>
        Response.json({
          recordings: ++calls === 1 ? [] : [candidate({ length })],
        }),
      {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
    );
    const result = await mb.correct(
      original,
      'person@example.invalid',
      new AbortController().signal,
      2500,
      { durationSeconds },
    );
    expect(result).toEqual(accepted ? { ...original, ...corrected } : original);
    mb.stop();
  }
});

test('legitimate dash titles, wrong variants/artists, ambiguity, no match and transient errors retain all input', async () => {
  const original = {
    title: 'Artist & Guest - Песня (Live)',
    artist: 'Upload Channel',
    album: 'Album',
    duration: 180,
  };
  for (const recordings of [
    [],
    [candidate({ title: 'Песня', length: 180000 })],
    [
      candidate({
        'artist-credit': [{ name: 'Wrong Artist' }],
        length: 180000,
      }),
    ],
    [
      candidate({ length: 180000 }),
      candidate({ title: 'Other', score: 99, length: 180000 }),
    ],
  ]) {
    let now = 0;
    let calls = 0;
    const mb = await client(
      async () =>
        Response.json({ recordings: ++calls === 1 ? [] : recordings }),
      {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
    );
    expect(
      await mb.correct(
        original,
        'person@example.invalid',
        new AbortController().signal,
        2500,
        { durationSeconds: 180 },
      ),
    ).toEqual(original);
    mb.stop();
  }
  let now = 0;
  const dash = { title: 'Time - After Time', artist: 'Real Artist' };
  const legitimate = await client(
    async () =>
      Response.json({
        recordings: [
          {
            score: 100,
            title: 'After Time',
            'artist-credit': [{ name: 'Time' }],
            length: 100000,
          },
        ],
      }),
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  expect(
    await legitimate.correct(
      dash,
      'person@example.invalid',
      new AbortController().signal,
      2500,
      { durationSeconds: 180 },
    ),
  ).toEqual(dash);
  legitimate.stop();
  for (const fetcher of [
    async () => {
      throw Error('offline');
    },
    async () => Response.json({ recordings: [] }),
  ]) {
    now = 0;
    const mb = await client(fetcher, {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    });
    expect(
      await mb.correct(
        original,
        'person@example.invalid',
        new AbortController().signal,
        2500,
        { durationSeconds: 180 },
      ),
    ).toEqual(original);
    mb.stop();
  }
});

test('split evidence belongs in cache identity and conflicting duplicate recording lengths retain input', async () => {
  let now = 0,
    calls = 0;
  const original = {
    title: 'Artist & Guest - Песня (Live)',
    artist: 'Upload Channel',
  };
  const mb = await client(
    async () =>
      Response.json({
        recordings: ++calls % 2 === 1 ? [] : [candidate({ length: 180000 })],
      }),
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  expect(
    await mb.correct(
      original,
      'person@example.invalid',
      new AbortController().signal,
      2500,
      { durationSeconds: 180 },
    ),
  ).toEqual(corrected);
  expect(
    await mb.correct(
      original,
      'person@example.invalid',
      new AbortController().signal,
      2500,
      { durationSeconds: 240 },
    ),
  ).toEqual(original);
  expect(calls).toBe(4);
  mb.stop();
  calls = 0;
  now = 0;
  const duplicates = await client(
    async () =>
      Response.json({
        recordings:
          ++calls === 1
            ? []
            : [candidate({ length: 180000 }), candidate({ length: 240000 })],
      }),
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  expect(
    await duplicates.correct(
      original,
      'person@example.invalid',
      new AbortController().signal,
      2500,
      { durationSeconds: 180 },
    ),
  ).toEqual(original);
  duplicates.stop();
});

test('canonical legitimate dash titles win before any heuristic split query', async () => {
  let calls = 0;
  const original = { title: 'Time - After Time', artist: 'Real Artist' };
  const mb = await client(async () => {
    calls++;
    return Response.json({
      recordings: [
        {
          score: 100,
          title: original.title,
          'artist-credit': [{ name: original.artist }],
          length: 180000,
        },
      ],
    });
  });
  expect(
    await mb.correct(
      original,
      'person@example.invalid',
      new AbortController().signal,
      2500,
      { durationSeconds: 180 },
    ),
  ).toEqual(original);
  expect(calls).toBe(1);
  mb.stop();
});

test('split confidence and competing-candidate gap are enforced at their exact boundaries', async () => {
  const original = {
    title: 'Artist & Guest - Песня (Live)',
    artist: 'Upload Channel',
  };
  for (const [score, otherScore, accepted] of [
    [95, 90, true],
    [95, 91, false],
    [94, 80, false],
  ] as const) {
    let now = 0,
      calls = 0;
    const mb = await client(
      async () =>
        Response.json({
          recordings:
            ++calls === 1
              ? []
              : [
                  candidate({ score, length: 180000 }),
                  candidate({
                    title: 'Other',
                    score: otherScore,
                    length: 180000,
                  }),
                ],
        }),
      {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
    );
    expect(
      await mb.correct(
        original,
        'person@example.invalid',
        new AbortController().signal,
        2500,
        { durationSeconds: 180 },
      ),
    ).toEqual(accepted ? corrected : original);
    mb.stop();
  }
});

test('identity preserves emoji symbols and punctuation in canonical matches', async () => {
  for (const [original, returned] of [
    [
      { title: 'Love 🔥', artist: 'Artist' },
      { title: 'Love 💧', artist: 'Artist' },
    ],
    [
      { title: '🔥', artist: '!!!' },
      { title: '💧', artist: '???' },
    ],
    [
      { title: 'Song!', artist: 'A+B' },
      { title: 'Song?', artist: 'A/B' },
    ],
  ]) {
    const mb = await client(async () =>
      Response.json({
        recordings: [
          {
            score: 100,
            title: returned.title,
            'artist-credit': [{ name: returned.artist }],
          },
        ],
      }),
    );
    expect(
      await mb.correct(
        original,
        'person@example.invalid',
        new AbortController().signal,
      ),
    ).toEqual(original);
    mb.stop();
  }
});

test('symbol-distinct inputs cannot collide in the result cache', async () => {
  let now = 0,
    calls = 0;
  const mb = await client(
    async () => {
      calls++;
      return Response.json({
        recordings: [
          { score: 100, title: '🔥', 'artist-credit': [{ name: '!!!' }] },
        ],
      });
    },
    {
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  const first = { title: '🔥', artist: '!!!' },
    next = { title: '🌙', artist: '+++ ' };
  expect(
    await mb.correct(
      first,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(first);
  expect(
    await mb.correct(
      next,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(next);
  expect(calls).toBe(2);
  mb.stop();
});

test('symbol-distinct candidates remain distinct competitors for ambiguity admission', async () => {
  const original = { title: 'love 🔥', artist: 'Artist' };
  for (const titles of [
    ['Love 🔥', 'Love 💧'],
    ['Love 💧', 'Love 🔥'],
  ]) {
    const mb = await client(async () =>
      Response.json({
        recordings: titles.map((title) => ({
          score: 100,
          title,
          'artist-credit': [{ name: 'Artist' }],
        })),
      }),
    );
    expect(
      await mb.correct(
        original,
        'person@example.invalid',
        new AbortController().signal,
      ),
    ).toEqual(original);
    mb.stop();
  }
});

test('Cyrillic case whitespace and NFKC normalization still permit supported canonical correction', async () => {
  const original = {
    title: '  песня   (live)  ',
    artist: '  Ａrtist  &   guest ',
  };
  const mb = await client(async () =>
    Response.json({ recordings: [candidate()] }),
  );
  expect(
    await mb.correct(
      original,
      'person@example.invalid',
      new AbortController().signal,
    ),
  ).toEqual(corrected);
  mb.stop();
});
