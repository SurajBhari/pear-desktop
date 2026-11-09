interface LRCTag {
  tag: string;
  value: string;
}

interface LRCLine {
  time: string;
  timeInMs: number;
  duration: number;
  text: string;
  words: { timeInMs: number; word: string }[];
}

interface LRC {
  tags: LRCTag[];
  lines: LRCLine[];
}

const tagRegex = /^\[(?<tag>\w+):\s*(?<value>.+?)\s*\]$/;
// prettier-ignore
const timestampRegex = /^\[(?<minutes>\d+):(?<seconds>\d+)\.(?<centiseconds>\d+)\]/m;

// prettier-ignore
const wordRegex = /<(?<minutes>\d+):(?<seconds>\d+)\.(?<centiseconds>\d+)>/g;

export const LRC = {
  parse: (text: string): LRC => {
    const lrc: LRC = {
      tags: [],
      lines: [],
    };

    let offset = 0;

    for (let line of text.split(/\r?\n/)) {
      line = line.trimStart();
      if (!line.startsWith('[')) continue;

      const timestamps = [];
      let match: Record<string, string> | undefined;
      while ((match = line.match(timestampRegex)?.groups)) {
        const { minutes, seconds, centiseconds } = match;
        const milliseconds = match.centiseconds.padEnd(3, '0');
        const minutesInMs = parseInt(minutes) * 60000;
        const secondsInMs = parseInt(seconds) * 1000;
        const timeInMs = minutesInMs + secondsInMs + parseInt(milliseconds);

        timestamps.push({
          time: `${minutes}:${seconds}:${centiseconds}`,
          timeInMs,
        });

        line = line.replace(timestampRegex, '');
      }

      if (!timestamps.length) {
        const tag = line.trim().match(tagRegex)?.groups;
        if (tag) {
          if (tag.tag === 'offset') {
            offset = parseInt(tag.value);
            continue;
          }

          lrc.tags.push({
            tag: tag.tag,
            value: tag.value,
          });
        }
        continue;
      }

      const markers = Array.from(line.matchAll(wordRegex));
      const text = line.replace(wordRegex, '');
      const words = markers.map(({ groups, index, 0: marker }, idx) => {
        const { minutes, seconds, centiseconds } = groups!;
        const milliseconds = centiseconds.padEnd(3, '0');
        const minutesInMs = parseInt(minutes) * 60000;
        const secondsInMs = parseInt(seconds) * 1000;
        const timeInMs = minutesInMs + secondsInMs + parseInt(milliseconds);

        const prefix = idx === 0 ? line.slice(0, index) : '';
        const word =
          (prefix.trim() ? '' : prefix) +
          line.slice(index + marker.length, markers[idx + 1]?.index);
        return { timeInMs, word };
      });

      for (const { time, timeInMs } of timestamps) {
        lrc.lines.push({
          time,
          timeInMs,
          text,
          words: words.map((word) => ({ ...word })),
          duration: Infinity,
        });
      }
    }

    lrc.lines.sort(({ timeInMs: timeA }, { timeInMs: timeB }) => timeA - timeB);
    for (let i = 0; i < lrc.lines.length; i++) {
      const current = lrc.lines[i];
      const next = lrc.lines[i + 1];

      if (next) {
        current.duration = next.timeInMs - current.timeInMs;
      }
      current.timeInMs += offset;
      current.words = current.words.map((word) => ({
        ...word,
        timeInMs: word.timeInMs + offset,
      }));
    }

    const first = lrc.lines.at(0);
    if (first && first.timeInMs > 300) {
      lrc.lines.unshift({
        time: '00:00:00',
        timeInMs: 0,
        duration: first.timeInMs,
        text: '',
        words: [],
      });
    }

    return lrc;
  },
};
