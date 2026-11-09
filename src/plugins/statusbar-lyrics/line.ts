import { withInstrumentalGaps } from '@/plugins/synced-lyrics/renderer/word-timing';

import type { LineLyrics } from '@/plugins/synced-lyrics/types';

// Root tools.ts uses this same signed offset contract. Positive means later.
export const statusDisplayTime = (mediaMs: number, offset: unknown) => {
  const value =
    typeof offset === 'number' &&
    Number.isFinite(offset) &&
    Math.abs(offset) <= 30000
      ? offset
      : 0;
  return mediaMs - value;
};

export function statusLine(
  lines: LineLyrics[] | undefined,
  time: number,
  trackEnd = Infinity,
) {
  if (!Number.isFinite(time) || !Array.isArray(lines) || lines.length > 20000)
    return '';
  const valid = lines.filter(
    (line) =>
      typeof line.text === 'string' &&
      Number.isFinite(line.timeInMs) &&
      line.timeInMs >= 0 &&
      (line.duration > 0 || line.duration === null),
  );
  // The shared JSON cache turns an unknown LRC end (Infinity) into null.
  // Keep its cue window bounded by the next real cue or known native track end.
  const bounded = valid.map((line, index) => {
    if (line.duration !== Infinity && line.duration !== null) return line;
    const next = valid[index + 1]?.timeInMs;
    const end =
      next ?? (Number.isFinite(trackEnd) && trackEnd > 0 ? trackEnd : Infinity);
    return { ...line, duration: end - line.timeInMs };
  });
  const ordered = withInstrumentalGaps(bounded);
  let current: LineLyrics | undefined;
  for (const line of ordered) {
    if (line.timeInMs > time) break;
    current = line;
  }
  if (
    !current ||
    current.instrumental ||
    time >= current.timeInMs + current.duration
  )
    return '';
  return current.text.replace(/\s+/gu, ' ').trim();
}
