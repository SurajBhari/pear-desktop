import type { RecordingCategories } from './config';

/** Adapted from #4093 (@amontariol). Explicit recording markers avoid city/title false positives. */
const livePatterns = [
  /[([]\s*live(?:\s+(?:at|from|in|on|with|recording|performance)\b[^)\]]*)?\s*[)\]]/i,
  /(?:-|:)\s*live\s*$/i,
  /[([]\s*(?:концертная (?:запись|версия)|живое исполнение|вживую)\s*[)\]]/i,
];
export const isLiveTitle = (title: unknown) =>
  typeof title === 'string' &&
  livePatterns.some((pattern) => pattern.test(title));

interface RecordingDescriptor {
  value: string;
  bracketed: boolean;
}

/** Bracket markers may precede suffix text; separated descriptors must be final. */
const recordingDescriptors = (title: string): RecordingDescriptor[] => {
  if (title.length > 4096) return [];
  const descriptors: RecordingDescriptor[] = [];
  let opening = '';
  let start = 0;
  let hasBaseTitle = false;
  for (let index = 0; index < title.length; index++) {
    const character = title[index];
    if (character === '(' || character === '[') {
      if (opening) return [];
      opening = character;
      start = index;
    } else if (character === ')' || character === ']') {
      if (opening !== (character === ')' ? '(' : '[')) return [];
      if (hasBaseTitle) {
        descriptors.push({
          value: title.slice(start + 1, index).trim(),
          bracketed: true,
        });
      }
      opening = '';
    } else if (!opening && /[^\s:-]/.test(character)) {
      hasBaseTitle = true;
    }
  }
  if (opening) return [];
  const separated = /^(.*\S)\s*[-:]\s*([^()[\]]+)\s*$/.exec(title);
  if (
    separated &&
    /[^\s:-]/.test(separated[1].replace(/[([][^()[\]]*[)\]]/g, ''))
  ) {
    descriptors.push({ value: separated[2].trim(), bracketed: false });
  }
  return descriptors;
};

const categoryPatterns = {
  live: /^(?:(?:concert|festival|tour) (?:recording|performance)|live performance)$/i,
  acoustic: /^(?:acoustic|unplugged)(?: (?:version|recording|performance))?$/i,
  demo: /^(?:demo|rehearsal)(?: (?:version|recording))?$/i,
  session:
    /^(?:(?:BBC(?: radio)?|radio) session|(?:broadcast|session) recording)$/i,
  venue:
    /^(?:(?:recorded(?: performance)?|performance) (?:at|in|from)\s+\S[^()[\]]*)$/i,
};

export const isNonStudioTitle = (
  title: unknown,
  categories: RecordingCategories,
): boolean => {
  if (typeof title !== 'string') return false;
  const descriptors = recordingDescriptors(title.trim());
  return descriptors.some(({ value, bracketed }) =>
    (Object.keys(categoryPatterns) as (keyof RecordingCategories)[]).some(
      (category) =>
        categories[category] &&
        ((category === 'live' &&
          isLiveTitle(bracketed ? `Song (${value})` : `Song - ${value}`)) ||
          categoryPatterns[category].test(value)),
    ),
  );
};
