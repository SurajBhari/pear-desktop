import { test, expect } from '@playwright/test';
import {
  selectCrossfadeAudioFormat,
  validCrossfadeStream,
} from '../src/plugins/crossfade/stream';
const format = (changes: Record<string, unknown> = {}) => ({
  has_audio: true,
  has_video: false,
  is_type_otf: false,
  mime_type: 'audio/webm; codecs="opus"',
  bitrate: 128000,
  content_length: 1000000,
  itag: 251,
  is_original: true,
  decipher: async () => 'https://media.invalid/audio',
  ...changes,
});
test('selects highest bounded original audio deterministically from adaptive candidates', () => {
  const formats = [
    format({ has_video: true, bitrate: 256000 }),
    format({ bitrate: 256001 }),
    format({ bitrate: 128000, itag: 252 }),
    format({ bitrate: 192000, itag: 250 }),
    format({ bitrate: 192000, itag: 249 }),
  ];
  expect(selectCrossfadeAudioFormat(formats)?.itag).toBe(249);
});
test('rejects unknown, oversized, OTF, muxed, dubbed, descriptive, secondary, DRC and ambiguous originals', () => {
  for (const change of [
    { content_length: undefined },
    { content_length: 64 * 1024 * 1024 + 1 },
    { content_length: NaN },
    { is_type_otf: true },
    { has_video: true },
    { has_audio: false },
    { mime_type: 'video/mp4' },
    { is_original: undefined },
    { is_original: false, audio_track: { audio_is_default: true } },
    { audio_track: { audio_is_default: false } },
    ...[
      'is_dubbed',
      'is_descriptive',
      'is_secondary',
      'is_auto_dubbed',
      'is_drc',
    ].map((k) => ({ [k]: true })),
  ])
    expect(selectCrossfadeAudioFormat([format(change)])).toBeNull();
  expect(
    selectCrossfadeAudioFormat([
      format({
        is_original: undefined,
        audio_track: { audio_is_default: true },
      }),
    ]),
  ).not.toBeNull();
});
test('renderer transport validation rejects unbounded and non HTTPS resources', () => {
  const stream = {
    url: 'https://media.invalid/audio?secret=not-logged',
    mimeType: 'audio/webm; codecs="opus"',
    contentLength: 1000,
  };
  expect(validCrossfadeStream(stream)).toBe(true);
  for (const change of [
    { url: 'file:///etc/passwd' },
    { url: 'javascript:alert(1)' },
    { url: 'https://u:p@media.invalid/a' },
    { mimeType: 'video/mp4' },
    { contentLength: 0 },
    { contentLength: Infinity },
  ])
    expect(validCrossfadeStream({ ...stream, ...change })).toBe(false);
});

test('actual private backend uses adaptive original audio and exactly one decipher with its owned player', async () => {
  const { crossfadeDefinition } =
    await import('./helpers/crossfade-definition');
  const player = { owned: true };
  let requests = 0,
    deciphers = 0;
  let handler: any;
  const selected = {
    ...format(),
    decipher: async (p: unknown) => {
      expect(p).toBe(player);
      deciphers++;
      return 'https://media.invalid/owned';
    },
  };
  const yt = {
    session: { player },
    getBasicInfo: async () => {
      requests++;
      return {
        basic_info: { id: 'AAAAAAAAAAA', is_live: false },
        streaming_data: {
          formats: [format({ has_video: true })],
          adaptive_formats: [format({ bitrate: 300000 }), selected],
        },
      };
    },
  };
  const plugin = crossfadeDefinition({ yt });
  await plugin.backend({
    ipc: { handle: (_name: string, value: unknown) => (handler = value) },
  });
  expect(await handler('bad')).toBeNull();
  expect(requests).toBe(0);
  expect(await handler('AAAAAAAAAAA')).toEqual({
    url: 'https://media.invalid/owned',
    mimeType: selected.mime_type,
    contentLength: selected.content_length,
  });
  expect(requests).toBe(1);
  expect(deciphers).toBe(1);
});
