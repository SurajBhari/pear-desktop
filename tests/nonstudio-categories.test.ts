import { test, expect } from '@playwright/test';
import * as patterns from '../src/plugins/skip-live-songs/patterns';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const keys = ['live', 'acoustic', 'demo', 'session', 'venue'] as const;
const defaults = {
  live: true,
  acoustic: false,
  demo: false,
  session: false,
  venue: false,
};
const all = Object.fromEntries(
  keys.map((key) => [key, true]),
) as typeof defaults;
const off = Object.fromEntries(
  keys.map((key) => [key, false]),
) as typeof defaults;
// Baseline fallback exercises real existing matching, rather than a missing import.
const match =
  (patterns as any).isNonStudioTitle ??
  ((title: unknown) => patterns.isLiveTitle(title));
const configFile = path.resolve('src/plugins/skip-live-songs/config.ts');
const resolve = existsSync(configFile)
  ? (await import(pathToFileURL(configFile).href)).resolveRecordingCategories
  : () => ({ ...defaults });

const positive = {
  live: [
    'Song (Live)',
    'Song [Live at Wembley]',
    'Song - Live',
    'Песня (концертная запись)',
    'Song (Concert Recording)',
    'Song [Festival Performance]',
    'Song - Tour Performance',
  ],
  acoustic: [
    'Song (Acoustic Version)',
    'Song - Unplugged',
    'Song [Acoustic]',
    'Song (Unplugged Recording)',
  ],
  demo: [
    'Song (Demo)',
    'Song [Rehearsal]',
    'Song - Demo Version',
    'Song (Rehearsal Recording)',
    // ROOT-R2: prior final-position-only negative is now a qualified positive.
    'Song (Demo) ordinary title',
  ],
  session: [
    'Song (BBC Radio Session)',
    'Song - Radio Session',
    'Song [Broadcast Recording]',
    'Song (Session Recording)',
    'Song (BBC Session)',
  ],
  venue: [
    'Song (Recorded performance at Wembley Arena,1992)',
    'Song [Recorded at Paris, 1992]',
    'Song - Performance at Royal Albert Hall',
  ],
};
for (const key of keys) {
  for (const title of positive[key]) {
    test(`${key} qualified descriptor: ${title}`, () => {
      expect(match(title, { ...off, [key]: true })).toBe(true);
      expect(match(title, off)).toBe(false);
      expect(match(title, defaults)).toBe(key === 'live');
    });
  }
}
for (const title of [
  'Acoustic',
  'Radio',
  'Demo',
  'Paris',
  'Session',
  'Live Forever',
  'Live in the Moment',
  'Live and Let Die',
  'Studio Session',
  'Song (Paris,1992)',
  'Song (1992 Remaster)',
  'Song (Studio Session)',
  'Song (BBC Arena,1992)',
  'Song (1992)',
  'Song (Acoustic Dreams)',
  'Song (Radio)',
  'Song (Demo Days)',
  'Song (Session)',
  'Song (Arena Hall)',
  '(Acoustic Version)',
  ' - Demo',
  'Song (Demo]',
  'Song [Rehearsal)',
  'Song (Demo',
  'Song Demo)',
  'Song ((Demo))',
  'Song - Acoustic Dreams',
  'Song : Radio',
  'Song (x'.repeat(5000),
  '',
  null,
  undefined,
  42,
]) {
  test(`ordinary or malformed title retained: ${String(title).slice(0, 70)}`, () =>
    expect(match(title, all)).toBe(false));
}

test('legacy defaults, explicit false and partial category records resolve without writes', () => {
  expect(resolve(undefined)).toEqual(defaults);
  expect(resolve({})).toEqual(defaults);
  expect(resolve({ live: false, acoustic: true })).toEqual({
    ...defaults,
    live: false,
    acoustic: true,
  });
  expect(resolve(off)).toEqual(off);
  const future = Object.freeze({ demo: true, futureMode: { value: 5 } });
  expect(resolve(future)).toEqual({ ...defaults, demo: true });
  expect(future).toEqual({ demo: true, futureMode: { value: 5 } });
  expect(
    resolve(Object.assign(Object.create(null), { session: true })),
  ).toEqual({ ...defaults, session: true });
});
for (const [index, invalid] of [
  null,
  true,
  1,
  'live',
  [],
  { live: 1 },
  { acoustic: undefined },
  new Date(),
  Object.create({ live: true }),
].entries()) {
  test(`invalid categories stay unsupported input ${index}`, () =>
    expect(resolve(invalid)).toBeNull());
}
test('category accessors are unsupported without invoking getters, including unknown keys', () => {
  let reads = 0;
  const raw = Object.defineProperty({}, 'live', {
    get() {
      reads++;
      return true;
    },
    enumerable: true,
  });
  expect(resolve(raw)).toBeNull();
  const future = Object.defineProperty({}, 'future', {
    get() {
      reads++;
      throw Error('private');
    },
    enumerable: true,
  });
  expect(resolve(future)).toBeNull();
  expect(reads).toBe(0);
});

const suffixMarkers = {
  live: 'Live',
  acoustic: 'Acoustic Version',
  demo: 'Demo',
  session: 'BBC Radio Session',
  venue: 'Recorded performance at Wembley Arena,1992',
};
for (const key of keys) {
  for (const suffix of ['Official Audio', 'Official Video']) {
    test(`qualified ${key} bracket marker precedes ${suffix}`, () => {
      const title = `Song (${suffixMarkers[key]}) ${suffix}`;
      expect(match(title, { ...off, [key]: true })).toBe(true);
      expect(match(title, off)).toBe(false);
      expect(match(title, defaults)).toBe(key === 'live');
    });
  }
  test(`qualified ${key} marker is found among multiple balanced markers`, () => {
    expect(
      match(`Song [Official Audio] (${suffixMarkers[key]}) [2020 Remaster]`, {
        ...off,
        [key]: true,
      }),
    ).toBe(true);
  });
}
test('each selected category can match its own marker in a multi-category title', () => {
  const title = 'Song (Demo) [Acoustic Version] Official Audio';
  expect(match(title, { ...off, demo: true })).toBe(true);
  expect(match(title, { ...off, acoustic: true })).toBe(true);
  expect(match(title, defaults)).toBe(false);
});
for (const title of [
  '(Demo) Official Audio',
  '(Live) (Demo) Official Audio',
  '- (Demo) Official Audio',
  'Song (Demo) extra (broken',
  'Song [Live] Official Audio]',
  'Song - Demo Official Audio',
  'Song - Acoustic Version Official Video',
  'Song - Radio Session Official Audio',
]) {
  test(`suffix support retains structural/final-separator guard: ${title}`, () =>
    expect(match(title, all)).toBe(false));
}

for (const title of [
  'Song (Live) Official Audio',
  'Song [Live at Wembley] Official Video',
  'Song (концертная запись) Official Audio',
]) {
  test(`legacy live marker remains eligible with ordinary suffix: ${title}`, () => {
    expect(patterns.isLiveTitle(title)).toBe(true);
    expect(match(title, defaults)).toBe(true);
    expect(match(title, { ...defaults, live: false })).toBe(false);
  });
}
