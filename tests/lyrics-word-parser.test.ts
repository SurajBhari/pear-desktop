import { test, expect } from '@playwright/test';
import { LRC } from '../src/plugins/synced-lyrics/parsers/lrc';
import { LyricsFile } from '../src/plugins/synced-lyrics/parsers/lyricsfile';
import {
  renderedWords,
  withInstrumentalGaps,
} from '../src/plugins/synced-lyrics/renderer/word-timing';

for (const scalar of [
  undefined,
  '',
  'null',
  '~',
  'true',
  '123',
  '[]',
  '|',
  '>',
  '|+',
  '|-',
  '|2',
  '>-',
  '>2+',
]) {
  test(`malformed lyricsfile text rejects the whole optional payload: ${scalar ?? 'missing'}`, () => {
    const malformed = scalar === undefined ? '' : `    text: ${scalar}\n`;
    const source = `lines:\n  - text: Good\n    start_ms: 0\n    words: []\n  - start_ms: 1000\n${malformed}    words: []\n`;
    expect(() => LyricsFile.parse(source)).toThrow();
  });
}

test('explicit empty gaps, whitespace and quoted pipes/angles remain real text', () => {
  const source = `lines:
  - text: ""
    start_ms: 0
    end_ms: 1000
    words: []
  - text: "|"
    start_ms: 1000
    words: []
  - text: '>'
    start_ms: 2000
    words: []
  - text: "  👩🏽‍🚀 е́\t東京  "
    start_ms: 3000
    words: []
`;
  expect(LyricsFile.parse(source).lines.map((line) => line.text)).toEqual([
    '',
    '|',
    '>',
    '  👩🏽‍🚀 е́\t東京  ',
  ]);
});

test('CRLF and padded metadata remain compatible without trimming lyric whitespace', () => {
  const result = LRC.parse(
    ' [offset:100]  \r\n [00:01.00]  text  \r\n[00:04.00]Later',
  );
  expect(result.lines[1]).toMatchObject({
    timeInMs: 1100,
    duration: 3000,
    text: '  text  ',
  });
});

test('enhanced LRC preserves complete Unicode/whitespace between actual timestamps and applies offset once', () => {
  const { lines } = LRC.parse(
    '[offset:100]\n[00:01.00]<00:01.00>👩🏽‍🚀 е́\t<00:02.00>東京  世界\n[00:04.00]line only',
  );
  const sung = lines.find((line) => line.timeInMs === 1100)!;
  expect(sung.text).toBe('👩🏽‍🚀 е́\t東京  世界');
  expect(sung.words).toEqual([
    { word: '👩🏽‍🚀 е́\t', timeInMs: 1100 },
    { word: '東京  世界', timeInMs: 2100 },
  ]);
  expect(sung.duration).toBe(3000);
  expect(lines.at(-1)?.words).toEqual([]);
});

test('lyricsfile retains supplied Unicode word starts/ends, offset and explicit silent gaps', () => {
  const source = `version: "1.0"
metadata:
  offset_ms: 100
lines:
  - text: "👩🏽‍🚀 е́\t東京"
    start_ms: 1000
    end_ms: 3500
    words:
      - text: "👩🏽‍🚀 е́\t"
        start_ms: 1000
        end_ms: 1800
      - text: 東京
        start_ms: 2000
        end_ms: 3500
  - text: Later
    start_ms: 7000
    words: []
`;
  const lines = LyricsFile.parse(source).lines;
  const line = lines[1];
  expect(line).toMatchObject({
    text: '👩🏽‍🚀 е́\t東京',
    timeInMs: 1100,
    duration: 2500,
  });
  expect(line.words).toEqual([
    { word: '👩🏽‍🚀 е́\t', timeInMs: 1100, endTimeInMs: 1900 },
    { word: '東京', timeInMs: 2100, endTimeInMs: 3600 },
  ]);
  const display = withInstrumentalGaps(
    lines.map((line) => ({ ...line, status: 'upcoming' as const })),
  );
  expect(
    display.find((line) => line.instrumental && line.timeInMs === 3600)
      ?.duration,
  ).toBe(3500);
  expect(LyricsFile.parse('plain: Lyrics only\nlines: []').lines).toEqual([]);
});

test('malformed/mismatched word timing honestly falls back to complete text rather than inventing alignment', () => {
  const line = {
    text: 'first second',
    time: '00:00',
    timeInMs: 0,
    duration: 5000,
    status: 'current' as const,
  };
  expect(renderedWords(line)).toBeNull();
  expect(
    renderedWords({ ...line, words: [{ word: 'first', timeInMs: 0 }] }),
  ).toBeNull();
  expect(
    renderedWords({
      ...line,
      words: [
        { word: 'first ', timeInMs: 2000 },
        { word: 'second', timeInMs: 1000 },
      ],
    }),
  ).toBeNull();
  expect(
    renderedWords({ ...line, words: [{ word: line.text, timeInMs: NaN }] }),
  ).toBeNull();
  expect(
    renderedWords({ ...line, words: [{ word: line.text, timeInMs: 6000 }] }),
  ).toBeNull();
  expect(
    renderedWords({
      ...line,
      words: [{ word: line.text, timeInMs: 0, endTimeInMs: -1 }],
    }),
  ).toBeNull();
  expect(
    withInstrumentalGaps([
      { ...line, duration: Infinity },
      { ...line, timeInMs: 10000 },
    ]).length,
  ).toBe(2);
  expect(
    renderedWords({
      ...line,
      text: 'е́👩🏽‍🚀',
      words: [
        { word: 'е', timeInMs: 0 },
        { word: '́👩🏽‍🚀', timeInMs: 1000 },
      ],
    }),
  ).toBeNull();
});

test('invalid final lyricsfile end does not produce negative duration or a fake gap', () => {
  expect(
    LyricsFile.parse(
      'lines:\n  - text: Last\n    start_ms: 1000\n    end_ms: 500\n    words: []',
    ).lines[1].duration,
  ).toBe(Infinity);
});
