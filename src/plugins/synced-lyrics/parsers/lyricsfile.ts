// Lyricsfile subset parser adapted from upstream #4702 by @AARP41298.
import type { LineLyricsWord } from '../types';

interface LyricsFileWord {
  text: string;
  start_ms: number;
  end_ms?: number;
}

interface LyricsFileLine {
  text: string;
  start_ms: number;
  end_ms?: number;
  words: LyricsFileWord[];
}

type CandidateLyricsFileLine = Omit<LyricsFileLine, 'text'> & { text?: string };

export interface ParsedLyricsFileLine {
  time: string;
  timeInMs: number;
  duration: number;
  text: string;
  words: LineLyricsWord[];
}

const KEY_VALUE_REGEX = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/;

const parseScalar = (
  raw: string,
): string | number | boolean | null | never[] => {
  const value = raw.trim();
  if (value === '' || value === 'null' || value === '~') return null;
  if (value === '[]') return [];
  if (value === 'true') return true;
  if (value === 'false') return false;

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      // JSON escapes preserve Unicode, escaped quotes and literal backslashes.
      const json = Array.from(value, (c) =>
        c.charCodeAt(0) < 32 ? JSON.stringify(c).slice(1, -1) : c,
      ).join('');
      return JSON.parse(json) as string;
    } catch {
      return null;
    }
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  // Block/fold scalars need a full YAML parser. Never interpret their header as lyrics.
  // Quoted literal pipes/angles above are ordinary supported strings.
  if (value.startsWith('|') || value.startsWith('>')) {
    throw new Error('Unsupported lyricsfile block/fold scalar');
  }

  if (/^-?\d+$/.test(value)) return Number(value);

  return value;
};

const splitKeyValue = (content: string): [string, string] | null => {
  const match = content.match(KEY_VALUE_REGEX);
  if (!match) return null;
  return [match[1], match[2]];
};

const assignWord = (word: LyricsFileWord, key: string, value: unknown) => {
  if (key === 'text' && typeof value === 'string') word.text = value;
  if (key === 'start_ms' && typeof value === 'number') word.start_ms = value;
  if (key === 'end_ms' && typeof value === 'number') word.end_ms = value;
};

const assignLine = (
  line: CandidateLyricsFileLine,
  key: string,
  value: unknown,
) => {
  if (key === 'text') line.text = typeof value === 'string' ? value : undefined;
  if (key === 'start_ms' && typeof value === 'number') line.start_ms = value;
  if (key === 'end_ms' && typeof value === 'number') line.end_ms = value;
  if (key === 'words' && Array.isArray(value)) line.words = [];
};

const parseOffset = (source: string): number => {
  const metadata = source.split(/^lines:/m)[0];
  const match = metadata.match(/^\s+offset_ms:\s*(-?\d+)\s*$/m);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) ? value : 0;
};

const parseRawLines = (source: string): LyricsFileLine[] => {
  const lines: LyricsFileLine[] = [];
  let inLines = false;
  let inWords = false;
  let linesIndent = 0;
  let lineItemIndent = -1;
  let wordsKeyIndent = -1;
  let currentLine: CandidateLyricsFileLine | null = null;
  let currentWord: LyricsFileWord | null = null;

  const finishWord = () => {
    if (
      currentLine &&
      currentWord &&
      Number.isFinite(currentWord.start_ms) &&
      currentWord.text !== undefined
    ) {
      currentLine.words.push(currentWord);
    }
    currentWord = null;
  };

  const finishLine = () => {
    finishWord();
    inWords = false;
    wordsKeyIndent = -1;
    if (currentLine) {
      // Missing/invalid text is malformed, not an explicit instrumental gap.
      // Reject the optional payload as a whole so a partial parse cannot mask LRC/plain data.
      if (typeof currentLine.text !== 'string')
        throw new Error('Lyricsfile line requires explicit string text');
      if (
        Number.isSafeInteger(currentLine.start_ms) &&
        currentLine.start_ms >= 0
      ) {
        lines.push({ ...currentLine, text: currentLine.text });
      }
    }
    currentLine = null;
  };

  for (const raw of source.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    const indent = raw.search(/\S/);
    const content = raw.trim();

    if (!inLines) {
      if (
        indent === 0 &&
        (content === 'lines:' || content.startsWith('lines:'))
      ) {
        inLines = true;
        linesIndent = indent;
        const inline = content.slice('lines:'.length).trim();
        if (inline === '[]') break;
      }
      continue;
    }

    if (indent <= linesIndent && !content.startsWith('-')) {
      break;
    }

    const isListItem = content === '-' || content.startsWith('- ');
    if (isListItem) {
      const rest = content === '-' ? '' : content.slice(2).trim();
      const nestedWord = inWords && indent > lineItemIndent;

      if (nestedWord) {
        finishWord();
        currentWord = { text: '', start_ms: Number.NaN };
        if (rest) {
          const kv = splitKeyValue(rest);
          if (kv) assignWord(currentWord, kv[0], parseScalar(kv[1]));
        }
      } else {
        finishLine();
        lineItemIndent = indent;
        currentLine = { start_ms: Number.NaN, words: [] };
        if (rest) {
          const kv = splitKeyValue(rest);
          if (kv) assignLine(currentLine, kv[0], parseScalar(kv[1]));
        }
      }
      continue;
    }

    const kv = splitKeyValue(content);
    if (!kv || !currentLine) continue;

    const [key, rawValue] = kv;
    const value = parseScalar(rawValue);

    if (key === 'words') {
      finishWord();
      inWords = true;
      wordsKeyIndent = indent;
      if (Array.isArray(value)) {
        currentLine.words = [];
        inWords = false;
      }
      continue;
    }

    if (inWords && indent > wordsKeyIndent && currentWord) {
      assignWord(currentWord, key, value);
      continue;
    }

    finishWord();
    inWords = false;
    assignLine(currentLine, key, value);
  }

  finishLine();
  return lines;
};

const pad = (value: number) => value.toString().padStart(2, '0');

const formatTime = (timeInMs: number): string => {
  const minutes = Math.floor(timeInMs / 60000);
  const seconds = Math.floor((timeInMs % 60000) / 1000);
  const centiseconds = Math.floor((timeInMs % 1000) / 10);
  return `${pad(minutes)}:${pad(seconds)}:${pad(centiseconds)}`;
};

const toParsedLine = (
  line: LyricsFileLine,
  nextStart: number | undefined,
  offset: number,
): ParsedLyricsFileLine => {
  const timeInMs = line.start_ms + offset;
  let duration =
    line.end_ms != null ? line.end_ms + offset - timeInMs : Infinity;
  if (!Number.isFinite(duration) || duration <= 0) duration = Infinity;

  if ((!Number.isFinite(duration) || duration <= 0) && nextStart != null) {
    duration = nextStart + offset - timeInMs;
  }

  return {
    time: formatTime(timeInMs),
    timeInMs,
    duration,
    text: line.text,
    words: line.words.map((word) => ({
      timeInMs: word.start_ms + offset,
      word: word.text,
      ...(word.end_ms === undefined
        ? {}
        : { endTimeInMs: word.end_ms + offset }),
    })),
  };
};

export const LyricsFile = {
  parse: (text: string): { lines: ParsedLyricsFileLine[] } => {
    // This is the provider's bounded lyricsfile subset, not a general YAML loader.
    if (text.length > 2_000_000) throw new Error('Lyricsfile too large');
    const offset = parseOffset(text);
    const rawLines = parseRawLines(text).sort(
      (a, b) => a.start_ms - b.start_ms,
    );

    const lines = rawLines.map((line, index) =>
      toParsedLine(line, rawLines[index + 1]?.start_ms, offset),
    );

    const first = lines.at(0);
    if (first && first.timeInMs > 300) {
      lines.unshift({
        time: '00:00:00',
        timeInMs: 0,
        duration: first.timeInMs,
        text: '',
        words: [],
      });
    }

    return { lines };
  },
};
