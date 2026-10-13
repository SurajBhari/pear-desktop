import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';

const load = async () => {
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/tools.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const timing = stripTypeScriptTypes(
    await readFile(
      new URL(
        '../src/plugins/synced-lyrics/renderer/word-timing.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  return import(
    `data:text/javascript;base64,${Buffer.from(timing + raw).toString('base64')}`
  );
};
const line = (timeInMs: number, text: string, words?: unknown[]) => ({
  timeInMs,
  text,
  words,
});

test('offset uses inverse clocks for display and seeking without mutating timings', async () => {
  const m = await load();
  expect(m.lyricsDisplayTime(1000, 250)).toBe(750);
  expect(m.lyricsSeekTime(1000, 250)).toBe(1.26);
  expect(m.lyricsDisplayTime(1000, -250)).toBe(1250);
  expect(m.lyricsSeekTime(0, -250)).toBe(0);
  for (const x of [NaN, Infinity, '500', 30001, -30001])
    expect(m.lyricsOffset(x)).toBe(0);
  expect(m.romanizationRatio(undefined)).toBe(0.7);
  expect(m.romanizationRatio(50)).toBe(0.5);
});

test('LRC export retains source text and original line timestamps plus explicit offset', async () => {
  const m = await load();
  const result = {
    title: 'My [song]\nInjected',
    artists: ['Artist'],
    lines: [line(1234, 'First\nline'), line(65012, 'Second')],
  };
  const before = JSON.stringify(result);
  const output = m.serializeLyricsExport(result, { offsetMs: 250 });
  expect(output.extension).toBe('lrc');
  expect(output.content).toContain('[00:01.484]First line\n[01:05.262]Second');
  expect(output.content).not.toContain('\nInjected');
  expect(JSON.stringify(result)).toBe(before);
  expect(output.filename).not.toMatch(/[\\/\r\n]/);
});

test('enhanced LRC exports only genuine ordered aligned words and otherwise uses line text', async () => {
  const m = await load();
  const result = {
    title: 'Song',
    artists: [],
    lines: [
      line(1000, 'Hello world', [
        { timeInMs: 1000, word: 'Hello ' },
        { timeInMs: 1500, word: 'world' },
      ]),
      line(3000, 'Fallback', [{ timeInMs: NaN, word: 'wrong' }]),
    ],
  };
  const output = m.serializeLyricsExport(result, { enhanced: true });
  expect(output.content).toContain('[00:01.00]<00:01.00>Hello <00:01.50>world');
  expect(output.content).toContain('[00:03.00]Fallback');
  expect(output.content).not.toContain('wrong');
});

test('plain export stays text; malformed or oversized renderer payloads are rejected', async () => {
  const m = await load();
  expect(
    m.serializeLyricsExport({ title: 'Song', artists: [], lyrics: 'One\nTwo' })
      .content,
  ).toBe('One\nTwo\n');
  expect(
    m.serializeLyricsExport({ title: 'Song', artists: [], lyrics: 'One' })
      .extension,
  ).toBe('txt');
  for (const data of [
    null,
    {},
    { title: 'x', artists: [], lines: [line(Infinity, 'x')] },
    { title: 'x', artists: [], lyrics: 'x'.repeat(1024 * 1024 + 1) },
    { title: 'x', artists: [], lines: [line(2000, 'a'), line(1000, 'b')] },
  ]) {
    expect(() => m.serializeLyricsExport(data)).toThrow();
  }
});

for (const invalid of ['late', 'grapheme', 'end'])
  test(`enhanced export uses the renderer validator and falls back for ${invalid}`, async () => {
    const m = await load();
    const text = invalid === 'grapheme' ? '👩‍💻' : 'Hello';
    const words =
      invalid === 'grapheme'
        ? [
            { timeInMs: 1000, word: '👩' },
            { timeInMs: 1500, word: '‍💻' },
          ]
        : [
            {
              timeInMs: invalid === 'late' ? 5000 : 1000,
              word: text,
              ...(invalid === 'end' ? { endTimeInMs: 5000 } : {}),
            },
          ];
    const row = { ...line(1000, text, words), duration: 1000 };
    expect(m.renderedWords(row)).toBeNull();
    expect(
      m.serializeLyricsExport(
        { title: 'Song', artists: [], lines: [row] },
        { enhanced: true },
      ).content,
    ).toContain(`[00:01.00]${text}`);
  });
test('enhanced export preserves open-ended DTO final words and exact millisecond offsets', async () => {
  const m = await load();
  const result = {
    title: 'Song',
    artists: [],
    lines: [
      {
        ...line(1123, 'Hello', [{ timeInMs: 1123, word: 'Hello' }]),
        duration: null,
      },
    ],
  };
  expect(
    m.serializeLyricsExport(result, { enhanced: true, offsetMs: 5 }).content,
  ).toContain('[00:01.128]<00:01.128>Hello');
});
