import type { LineLyrics, LineLyricsWord } from '../types';

/** Only use real, monotone timings whose text covers the supplied lyric exactly. */
export function renderedWords(line: LineLyrics): LineLyricsWord[] | null {
  const words = line.words;
  if (!words?.length || words.map((word) => word.word).join('') !== line.text)
    return null;
  const boundaries = new Set(
    Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        line.text,
      ),
      (part) => part.index,
    ),
  );
  boundaries.add(line.text.length);
  let offset = 0;
  let previous = line.timeInMs;
  const end = line.timeInMs + line.duration;
  for (const word of words) {
    if (
      typeof word.word !== 'string' ||
      !Number.isFinite(word.timeInMs) ||
      word.timeInMs < previous ||
      word.timeInMs >= end ||
      (word.endTimeInMs !== undefined &&
        (!Number.isFinite(word.endTimeInMs) ||
          word.endTimeInMs < word.timeInMs ||
          word.endTimeInMs > end))
    )
      return null;
    previous = word.timeInMs;
    offset += word.word.length;
    if (!boundaries.has(offset)) return null;
  }
  return words;
}

/** Explicit finite line ends can establish gaps; ordinary line LRC cannot. */
export function withInstrumentalGaps(lines: LineLyrics[]): LineLyrics[] {
  return lines.flatMap((line, index) => {
    const next = lines[index + 1];
    const end = line.timeInMs + line.duration;
    if (
      !line.text.trim() ||
      !next ||
      !Number.isFinite(end) ||
      line.duration <= 0 ||
      next.timeInMs - end < 2000
    )
      return [line];
    return [
      line,
      {
        time: '',
        timeInMs: end,
        duration: next.timeInMs - end,
        text: '',
        words: [],
        instrumental: true,
        status: 'upcoming' as const,
      },
    ];
  });
}
