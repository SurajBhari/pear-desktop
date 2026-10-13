/* oxlint-disable typescript/require-await -- immediate async fetch/decipher fixtures implement the actual SDK contract. */
import { test, expect } from '@playwright/test';
import { FormatUtils } from 'youtubei.js';

import Format from '../node_modules/youtubei.js/dist/src/parser/classes/misc/Format.js';
import {
  describeAudioFormats,
  selectAudioFormat,
  sourceContainer,
} from '../src/plugins/downloader/audio';
import {
  downloadSelectedAudio,
  type DownloadInfo,
} from '../src/plugins/downloader/transfer';

const MULTI_RANGE_LENGTH = 22_020_133; // 21 MiB + 37 bytes.
const audio = (itag = 251, extra: Record<string, unknown> = {}) =>
  new Format({
    itag,
    mimeType: 'audio/webm; codecs="opus"',
    audioQuality: 'AUDIO_QUALITY_MEDIUM',
    audioSampleRate: '48000',
    audioChannels: 2,
    bitrate: 160000,
    contentLength: '3',
    url: 'https://fixture.test/audio?x=1',
    ...extra,
  });
function infoFor(
  formats: Format[],
  fetch: typeof globalThis.fetch,
): DownloadInfo {
  return {
    streaming_data: { formats: [], adaptive_formats: formats },
    playability_status: { status: 'OK' },
    page: [{ video_details: { is_live: false } }],
    actions: {
      session: { http: { fetch_function: fetch }, player: undefined },
    },
    cpn: 'fixture',
  } as unknown as DownloadInfo;
}

test('runtime catalogue retains audio-only unknown itags and rejects unsupported lengths/DRM/muxed video', () => {
  const valid = audio(999);
  const rows = describeAudioFormats([
    valid,
    audio(251, { contentLength: undefined }),
    audio(774, { drmFamilies: ['WIDEVINE'] }),
    audio(18, { qualityLabel: '360p' }),
  ]);
  expect(rows[0].codec).toBe('opus');
  expect(rows[0].container).toBe('webm');
  expect(rows[0].supported).toBe(true);
  expect(rows.slice(1).every((row) => !row.supported)).toBe(true);
  expect(sourceContainer(rows[0])).toBe('webm');
});

test('preferences and exact identity preserve codec/language/DRC; itag alone cannot select a different variant', () => {
  const original = audio();
  const drc = audio(251, { isDrc: true });
  const premium = audio(774, {
    bitrate: 256000,
    audioQuality: 'AUDIO_QUALITY_HIGH',
  });
  const aac = audio(141, {
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 256000,
  });
  const rows = describeAudioFormats([drc, original, premium, aac]);
  expect(selectAudioFormat(rows, { mode: 'opus' }).itag).toBe(774);
  expect(selectAudioFormat(rows, { mode: 'aac' }).itag).toBe(141);
  expect(selectAudioFormat(rows, { mode: 'bitrate', bitrate: 170 }).itag).toBe(
    251,
  );
  expect(selectAudioFormat(rows, { mode: 'itag', itag: 251 }).key).toBe(
    rows[1].key,
  );
  expect(
    selectAudioFormat(rows, { mode: 'itag', itag: 251 }, rows[0].key),
  ).toBe(rows[0]);
  expect(() => selectAudioFormat(rows, { mode: 'itag', itag: 999 })).toThrow(
    /offered/,
  );
});

test('actual SDK selected-only transfer bypasses duplicate-itag first-match and uses its decipher/native fetch', async () => {
  const wrong = audio(251, { isDrc: true });
  const chosen = audio();
  let deciphered = 0;
  chosen.decipher = async () => {
    deciphered++;
    return 'https://fixture.test/selected?x=1';
  };
  const requests: string[] = [];
  const info = infoFor([wrong, chosen], async (input) => {
    requests.push(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const output: number[] = [];
  for await (const chunk of await downloadSelectedAudio(info, chosen, () => {}))
    output.push(...chunk);
  expect(output).toEqual([1, 2, 3]);
  expect(deciphered).toBe(1);
  expect(requests[0]).toContain('/selected?');
  expect(FormatUtils.chooseFormat({ itag: 251 }, info.streaming_data)).toBe(
    wrong,
  );
});

test('actual SDK reassembles 21 MiB + 37 bytes through inclusive multi-range requests', async () => {
  const length = MULTI_RANGE_LENGTH;
  const chosen = audio(251, { contentLength: String(length) });
  const ranges: string[] = [];
  const info = infoFor([chosen], async (input) => {
    const range = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    ).searchParams.get('range')!;
    ranges.push(range);
    const [start, end] = range.split('-').map(Number);
    const bytes = new Uint8Array(Math.min(end, length - 1) - start + 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
    return new Response(bytes);
  });
  let total = 0;
  for await (const chunk of await downloadSelectedAudio(
    info,
    chosen,
    () => {},
  )) {
    const expected = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) expected[i] = (total + i) % 251;
    expect(Buffer.from(chunk).equals(Buffer.from(expected))).toBe(true);
    total += chunk.length;
  }
  expect(total).toBe(length);
  expect(ranges).toHaveLength(3);
  expect(ranges[1]).toBe('10485761-20971520');
});

for (const length of [
  undefined,
  0,
  -1,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
])
  test(`invalid length ${length} never invokes actual SDK transport`, async () => {
    const chosen = audio();
    chosen.content_length = length;
    let requests = 0;
    const info = infoFor([chosen], async () => {
      requests++;
      return new Response(new Uint8Array([1]));
    });
    await expect(downloadSelectedAudio(info, chosen, () => {})).rejects.toThrow(
      /length/,
    );
    expect(requests).toBe(0);
  });

for (const received of [2, 4])
  test(`declared 3 byte input with actual ${received} byte SDK body fails before success`, async () => {
    const chosen = audio();
    const info = infoFor(
      [chosen],
      async () => new Response(new Uint8Array(received)),
    );
    const read = async () => {
      for await (const _chunk of await downloadSelectedAudio(
        info,
        chosen,
        () => {},
      )) {
        /* consume actual SDK */
      }
    };
    await expect(read()).rejects.toThrow(/Incomplete|Excess/);
  });

test('live/post-live guards and retired binding prevent transfer, preserving caller cancellation', async () => {
  const chosen = audio();
  let requests = 0;
  const info = infoFor([chosen], async () => {
    requests++;
    return new Response(new Uint8Array(3));
  });
  info.page[0].video_details!.is_live = true;
  await expect(downloadSelectedAudio(info, chosen, () => {})).rejects.toThrow(
    /live/i,
  );
  expect(requests).toBe(0);
  info.page[0].video_details!.is_live = false;
  info.page[0].video_details!.is_post_live_dvr = true;
  await expect(downloadSelectedAudio(info, chosen, () => {})).rejects.toThrow(
    /live/i,
  );
  info.page[0].video_details!.is_post_live_dvr = false;
  await expect(
    downloadSelectedAudio(info, chosen, () => {
      throw new Error('retired');
    }),
  ).rejects.toThrow('retired');
});

test('actual SDK active range fetch receives composed owner cancellation and reader rejects', async () => {
  const owner = new AbortController();
  let signal: AbortSignal | undefined;
  const info = infoFor(
    [audio(251, { contentLength: String(MULTI_RANGE_LENGTH) })],
    (_input, init) =>
      new Promise((_resolve, reject) => {
        signal = AbortSignal.any([owner.signal, init!.signal!]);
        signal.addEventListener(
          'abort',
          () => reject(new Error('owned abort')),
          { once: true },
        );
      }),
  );
  const iterator = await downloadSelectedAudio(
    info,
    info.streaming_data!.adaptive_formats[0],
    () => {},
  );
  const pending = iterator.next();
  await expect.poll(() => !!signal).toBe(true);
  owner.abort();
  await expect(pending).rejects.toThrow('owned abort');
  expect(signal!.aborted).toBe(true);
});

test('actual SDK missing length truncates a 21MiB payload; product rejects it before that transport', async () => {
  const length = MULTI_RANGE_LENGTH;
  const chosen = audio();
  chosen.content_length = undefined;
  let requests = 0;
  const info = infoFor([chosen], (input) => {
    requests++;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const [start, end] = new URL(url).searchParams
      .get('range')!
      .split('-')
      .map(Number);
    return Promise.resolve(
      new Response(new Uint8Array(Math.min(length - 1, end) - start + 1)),
    );
  });
  const raw = await FormatUtils.download(
    { itag: 251, type: 'audio', format: 'any' },
    info.actions,
    info.playability_status,
    info.streaming_data,
    undefined,
    info.cpn,
  );
  let bytes = 0;
  for await (const chunk of raw) bytes += chunk.byteLength;
  expect(bytes).toBe(10485761);
  expect(bytes).toBeLessThan(length);
  requests = 0;
  await expect(downloadSelectedAudio(info, chosen, () => {})).rejects.toThrow(
    /length/,
  );
  expect(requests).toBe(0);
});

test('actual SDK short multi-range body for 21MiB declared input cannot reach conversion success', async () => {
  const length = MULTI_RANGE_LENGTH;
  const chosen = audio(251, { contentLength: String(length) });
  let requests = 0;
  let converted = false;
  const info = infoFor([chosen], (input) => {
    requests++;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const [start, end] = new URL(url).searchParams
      .get('range')!
      .split('-')
      .map(Number);
    return Promise.resolve(
      new Response(
        new Uint8Array(
          Math.min(length - 1, end) - start + 1 - (start === 0 ? 5 : 0),
        ),
      ),
    );
  });
  const consume = async () => {
    for await (const chunk of await downloadSelectedAudio(
      info,
      chosen,
      () => {},
    )) {
      expect(chunk.length).toBeGreaterThan(0);
    }
    converted = true;
  };
  await expect(consume()).rejects.toThrow(/Incomplete/);
  expect(requests).toBe(3);
  expect(converted).toBe(false);
});

test('allowing DRC never changes an original-language preference to a foreign DRC track', () => {
  const foreign = audio(251, { isDrc: true, bitrate: 999000 });
  foreign.language = 'pt';
  foreign.audio_track = {
    id: 'pt',
    display_name: 'Portuguese',
    audio_is_default: false,
  };
  const original = audio();
  const rows = describeAudioFormats([foreign, original]);
  expect(
    selectAudioFormat(rows, { mode: 'best', language: 'original', drc: true })
      .key,
  ).toBe(rows[1].key);
});

test('actual SDK media requests wait for consumption so queued FFmpeg operations cannot prefetch chunks', async () => {
  const chosen = audio();
  let requests = 0;
  const info = infoFor([chosen], () => {
    requests++;
    return Promise.resolve(new Response(new Uint8Array(3)));
  });
  const iterator = await downloadSelectedAudio(info, chosen, () => {});
  expect(requests).toBe(0);
  let bytes = 0;
  for await (const chunk of iterator) bytes += chunk.length;
  expect(bytes).toBe(3);
  expect(requests).toBe(1);
});
