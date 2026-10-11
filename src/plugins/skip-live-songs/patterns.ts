/** Adapted from #4093 (@amontariol). Explicit recording markers avoid city/title false positives. */
const livePatterns = [
  /[([]\s*live(?:\s+(?:at|from|in|on|with|recording|performance)\b[^)\]]*)?\s*[)\]]/i,
  /(?:-|:)\s*live\s*$/i,
  /[([]\s*(?:концертная (?:запись|версия)|живое исполнение|вживую)\s*[)\]]/i,
];
export const isLiveTitle = (title: unknown) =>
  typeof title === 'string' &&
  livePatterns.some((pattern) => pattern.test(title));
