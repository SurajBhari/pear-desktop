/* oxlint-disable eslint/no-control-regex */
// Export sanitizers intentionally remove control characters from text and filenames.
import { renderedWords } from './renderer/word-timing';

import type { LyricResult } from './types';

export const lyricsOffset = (value: unknown): number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= 30000
    ? value
    : 0;
export const lyricsDisplayTime = (mediaMs: number, offset: unknown) =>
  mediaMs - lyricsOffset(offset);
export const lyricsSeekTime = (lineMs: number, offset: unknown) =>
  Math.max(0, (lineMs + lyricsOffset(offset) + 10) / 1000);
export const romanizationRatio = (value: unknown): number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 25 &&
  value <= 150
    ? value / 100
    : 0.7;

const MAX_BYTES = 1024 * 1024;
const singleLine = (text: string) => text.replace(/[\r\n\u0000]/g, ' ');
const tagText = (text: string) => singleLine(text).replace(/[[\]]/g, '');
const stamp = (ms: number) => {
  const total = Math.round(Math.max(0, ms));
  const seconds = Math.floor(total / 1000);
  const fraction = total % 1000;
  const digits =
    fraction % 10 === 0
      ? String(fraction / 10).padStart(2, '0')
      : String(fraction).padStart(3, '0');
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${digits}`;
};
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 86400000;

export const serializeLyricsExport = (
  input: unknown,
  options: { offsetMs?: unknown; enhanced?: boolean } = {},
): { content: string; extension: 'lrc' | 'txt'; filename: string } => {
  if (!input || typeof input !== 'object') throw new Error('Invalid lyrics');
  const result = input as LyricResult;
  if (
    typeof result.title !== 'string' ||
    result.title.length > 512 ||
    !Array.isArray(result.artists) ||
    result.artists.length > 50 ||
    result.artists.some(
      (artist) => typeof artist !== 'string' || artist.length > 512,
    )
  )
    throw new Error('Invalid lyrics metadata');
  const offset = lyricsOffset(options.offsetMs);
  let extension: 'lrc' | 'txt';
  let content: string;
  if (Array.isArray(result.lines) && result.lines.length) {
    if (result.lines.length > 10000) throw new Error('Too many lyrics lines');
    let previous = -1;
    const output = result.lines.map((line, lineIndex) => {
      if (
        !line ||
        !timestamp(line.timeInMs) ||
        line.timeInMs < previous ||
        typeof line.text !== 'string' ||
        line.text.length > 10000
      )
        throw new Error('Invalid lyrics line');
      previous = line.timeInMs;
      let text = singleLine(line.text);
      const words = line.words;
      const nextTime = result.lines?.[lineIndex + 1]?.timeInMs;
      // JSON transport turns a provider's open-ended final duration into null.
      // Infer only absent/open-ended duration; explicit finite bounds stay intact.
      const duration =
        line.duration === null || line.duration === undefined
          ? timestamp(nextTime)
            ? nextTime - line.timeInMs
            : Infinity
          : line.duration;
      const shapeValid =
        Array.isArray(words) &&
        words.length > 0 &&
        words.length <= 2000 &&
        words.every(
          (word) =>
            word && typeof word.word === 'string' && timestamp(word.timeInMs),
        );
      const validated =
        options.enhanced &&
        shapeValid &&
        typeof duration === 'number' &&
        !Number.isNaN(duration)
          ? renderedWords({ ...line, duration })
          : null;
      if (validated) {
        text = validated
          .map(
            (word) =>
              `<${stamp(word.timeInMs + offset)}>${singleLine(word.word)}`,
          )
          .join('');
      }
      return `[${stamp(line.timeInMs + offset)}]${text}`;
    });
    extension = 'lrc';
    content = `[ti:${tagText(result.title)}]\n[ar:${tagText(result.artists.join(', '))}]\n${output.join('\n')}\n`;
  } else if (typeof result.lyrics === 'string' && result.lyrics.trim()) {
    extension = 'txt';
    content =
      result.lyrics
        .replace(/\u0000/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n*$/, '') + '\n';
  } else throw new Error('No lyrics to export');
  if (new TextEncoder().encode(content).byteLength > MAX_BYTES)
    throw new Error('Lyrics export too large');
  let name =
    singleLine(result.title)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 120) || 'lyrics';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  return { content, extension, filename: `${name}.${extension}` };
};
