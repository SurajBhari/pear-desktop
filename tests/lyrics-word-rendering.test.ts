import { createRequire } from 'node:module';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const renderer = path.join(
  root,
  'src/plugins/synced-lyrics/renderer/renderer.tsx',
);
const component = path.join(
  root,
  'src/plugins/synced-lyrics/renderer/components/SyncedLine.tsx',
);
const lifecycle = path.join(
  root,
  'src/plugins/synced-lyrics/renderer/index.ts',
);
const provider = path.join(
  root,
  'src/plugins/synced-lyrics/providers/LRCLib.ts',
);
const scroll = path.join(
  root,
  'src/plugins/synced-lyrics/renderer/scroll-motion.ts',
);
let scratch: string;
let code: string;
let css: string;
let clip: string | undefined;

test.use({
  video: process.env.PEAR_LYRICS_EVIDENCE_DIR ? 'on' : 'off',
  launchOptions: process.env.PEAR_TEST_CHROMIUM
    ? { executablePath: process.env.PEAR_TEST_CHROMIUM }
    : {},
});
test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'pear-word-render-'));
  const entry = path.join(scratch, 'entry.tsx');
  await writeFile(
    entry,
    `import{render}from'solid-js/web';import{LyricsRenderer,currentTime,setCurrentTime,setIsVisible,setConfig,startLyricsEffects}from ${JSON.stringify(renderer)};import{renderer as plugin}from ${JSON.stringify(lifecycle)};import{LRCLib}from ${JSON.stringify(provider)};import{setLyrics}from'fixture-state';const settings={enabled:true,lineEffect:'fancy',romanization:false,convertChineseCharacter:'disabled',defaultTextString:'',showTimeCodes:false};window.mount=(lines)=>{setConfig(settings);startLyricsEffects();setLyrics({state:'done',data:{lines}});setIsVisible(true);const dispose=render(()=> <LyricsRenderer/>,document.querySelector('#lyrics-tab'));window.fixture={setConfig,setTime:setCurrentTime,time:currentTime,setVisible:setIsVisible,setLines:lines=>setLyrics({state:'done',data:{lines}}),dispose,plugin};setCurrentTime(0)};window.searchProvider=async data=>{window.fetch=async()=>new Response(JSON.stringify(data),{status:200});return new LRCLib().search({title:'Song',artist:'Artist',album:'Album',songDuration:10,videoId:'A'})};window.nativeClock=async()=>{const video=document.createElement('video');document.body.append(video);const header=new Uint8Array(44+44100*40*2);const view=new DataView(header.buffer);const ascii=(offset,value)=>[...value].forEach((c,i)=>header[offset+i]=c.charCodeAt(0));ascii(0,'RIFF');view.setUint32(4,header.length-8,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,44100,true);view.setUint32(28,88200,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,header.length-44,true);const url=URL.createObjectURL(new Blob([header],{type:'audio/wav'}));video.src=url;await new Promise((yes,no)=>{video.onloadedmetadata=yes;video.onerror=no});const events=new EventTarget();const api={getCurrentTime:()=>video.currentTime,getVideoData:()=>({video_id:'A'}),getPlayerResponse:()=>({videoDetails:{videoId:'A'}}),addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),seekTo:t=>video.currentTime=t};await plugin.start({getConfig:async()=>settings,ipc:{invoke:async()=>{},subscribe:()=>()=>{}}});await plugin.onPlayerApiReady(api);window.fixture.video=video;window.fixture.disposeClock=()=>{plugin.stop();video.pause();video.remove();URL.revokeObjectURL(url)};return video.duration};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^@\/i18n$/, replacement: '\0fixture-i18n' },
        { find: /^@\/utils$/, replacement: '\0fixture-create-renderer' },
        {
          find: /^@\/providers\/song-info-front$/,
          replacement: '\0fixture-song',
        },
        { find: '@', replacement: path.join(root, 'src') },
      ],
      conditions: ['browser'],
    },
    plugins: [
      solidPlugin(),
      {
        name: 'owned-lyrics-render-boundaries',
        enforce: 'pre',
        resolveId(id, importer) {
          const name = importer?.replaceAll('\\', '/');
          if (id === 'solid-js')
            return requireRoot.resolve('solid-js/dist/solid.js');
          if (id === 'solid-js/web')
            return requireRoot.resolve('solid-js/web/dist/web.js');
          if (id === 'fixture-state') return '\0fixture-state';
          if (id === '@/i18n') return '\0fixture-i18n';
          if (
            name?.endsWith('/renderer/renderer.tsx') ||
            name?.endsWith('/renderer/index.ts')
          ) {
            if (id === './store') return '\0fixture-state';
            if (id === './utils') return '\0fixture-render-utils';
            if (id === './components') return '\0fixture-components';
            if (id === './components/LyricsPicker') return '\0fixture-picker';
            if (id === './scroll-motion') return '\0fixture-scroll-probe';
          }
          if (name?.endsWith('/components/SyncedLine.tsx')) {
            if (id === '..') return lifecycle;
            if (id === '../utils') return '\0fixture-conversion';
          }
        },
        load(id) {
          if (id === '\0fixture-state')
            return "import{createSignal}from'solid-js';export const[currentLyrics,setLyrics]=createSignal(null);export const fetchLyrics=()=>{},retrySearch=()=>{},invalidateLyricsTrack=()=>{},startLyricsSession=()=>{},stopLyricsSession=()=>{};";
          if (id === '\0fixture-i18n')
            return "export const t=()=> 'Instrumental';";
          if (id === '\0fixture-create-renderer')
            return 'export const createRenderer=value=>value;';
          if (id === '\0fixture-song')
            return "export const getSongInfo=()=>({videoId:'A'});";
          if (id === '\0fixture-render-utils')
            return "export const selectors={body:{tabRenderer:'#lyrics-tab'},head:'#lyrics-header'},startLyricsView=()=>{},disposeLyricsView=()=>{},tabStates={'true':()=>{}},waitForLyricsElement=async selector=>document.querySelector(selector);";
          if (id === '\0fixture-conversion')
            return 'export const canonicalize=s=>s,simplifyUnicode=s=>s,convertChineseCharacter=s=>s,romanize=async s=>s;';
          if (id === '\0fixture-components')
            return `export{SyncedLine}from ${JSON.stringify(component)};export const ErrorDisplay=()=>null,LoadingKaomoji=()=>null,NotFoundKaomoji=()=>null,PlainLyrics=()=>null;`;
          if (id === '\0fixture-scroll-probe')
            return `import{createLyricsScrollController as actual}from ${JSON.stringify(scroll)};export function createLyricsScrollController(...args){const controller=actual(...args);const move=controller.move;controller.move=(index,immediate=false)=>{(window.centerMoves??=[]).push({index,immediate});return move(index,immediate)};return controller;}`;
          if (id === '\0fixture-picker')
            return "export const resetLyricsPickerSelection=()=>{};export const LyricsPicker=props=>{const div=document.createElement('div');div.style.height='40px';props.setStickRef(div);return div};";
        },
      },
    ],
    build: {
      lib: { entry, formats: ['iife'], name: 'wordFixture' },
      minify: false,
      write: false,
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  code = bundle.output.find((item) => item.type === 'chunk')!.code;
  css = await readFile(
    path.join(root, 'src/plugins/synced-lyrics/style.css'),
    'utf8',
  );
});
test.afterEach(async ({ page }, info) => {
  if (
    process.env.PEAR_LYRICS_EVIDENCE_DIR &&
    info.title.startsWith('real virtualized')
  )
    clip = await page.video()?.path();
});
test.afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  if (clip && process.env.PEAR_LYRICS_EVIDENCE_DIR)
    await copyFile(
      clip,
      path.join(
        process.env.PEAR_LYRICS_EVIDENCE_DIR,
        'lyrics-scroll-word-fixture.webm',
      ),
    );
});

async function mount(page: Page, lines: any[]) {
  await page.setContent(
    '<style>html{font-size:16px;background:#151515;color:white}#lyrics-tab{width:600px;height:420px;--ytmusic-body-line-height:1.4}</style><button id="lyrics-header" aria-selected="true"></button><div id="lyrics-tab"></div>',
  );
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    (window as any).seekCalls = [];
  });
  await page.addScriptTag({ content: code });
  await page.evaluate((lines) => (window as any).mount(lines), lines);
}
const timed = {
  time: '00:01',
  timeInMs: 1000,
  duration: 4000,
  text: 'Hello world',
  words: [
    { word: 'Hello ', timeInMs: 1000 },
    { word: 'world', timeInMs: 2000 },
  ],
  status: 'upcoming',
};

test('real words highlight at source timestamps; reverse seek and pause never run CSS delay clocks', async ({
  page,
}) => {
  await mount(page, [timed]);
  await page.evaluate(() => (window as any).fixture.setTime(1500));
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(1);
  await expect(page.locator('.lyrics-word.upcoming')).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(1);
  await page.evaluate(() => (window as any).fixture.setTime(2500));
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(2);
  await page.evaluate(() => (window as any).fixture.setTime(500));
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(0);
});

test('word and line baselines/widths stay fixed across highlight; Unicode whitespace and markup remain text', async ({
  page,
}) => {
  const text = '  👩🏽‍🚀 е́\t東京 <img src=x>  ';
  await mount(page, [
    { ...timed, text, words: [{ word: text, timeInMs: 1000 }] },
  ]);
  const line = page.locator('.lyrics-original');
  await expect(line).toHaveText(text, { useInnerText: false });
  expect(await line.textContent()).toBe(text);
  const before = await line.boundingBox();
  const glyphs = () =>
    line.evaluate((node) => {
      const origin = node.getBoundingClientRect();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const rectangles = [];
      while (walker.nextNode()) {
        const text = walker.currentNode;
        for (const part of new Intl.Segmenter(undefined, {
          granularity: 'grapheme',
        }).segment(text.textContent ?? '')) {
          const range = document.createRange();
          range.setStart(text, part.index);
          range.setEnd(text, part.index + part.segment.length);
          const rectangle = range.getBoundingClientRect();
          rectangles.push({
            glyph: part.segment,
            x: rectangle.x - origin.x,
            y: rectangle.y - origin.y,
            width: rectangle.width,
            height: rectangle.height,
          });
        }
      }
      return rectangles;
    });
  const baseline = await glyphs();
  expect(baseline.length).toBeGreaterThan(5);
  await page.evaluate(() => (window as any).fixture.setTime(2000));
  await page.waitForTimeout(300);
  expect(await line.boundingBox()).toEqual(before);
  expect(await glyphs()).toEqual(baseline);
  expect(
    await page.locator('.lyrics-word').evaluate((node) => {
      const s = getComputedStyle(node);
      return [s.transform, s.animationName, s.transitionDelay];
    }),
  ).toEqual(['none', 'none', '0s']);
  await expect(page.locator('img')).toHaveCount(0);
});

test('line-only lyrics never fabricate word timings and keyboard seeks; reduced motion recenters without an animation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mount(
    page,
    Array.from({ length: 15 }, (_, i) => ({
      ...timed,
      words: undefined,
      text: `Line ${i}`,
      timeInMs: i * 5000,
    })),
  );
  await page.evaluate(() => (window as any).fixture.setTime(31000));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.querySelector('.synced-line.current');
        const list = document.querySelector('.synced-lyrics-vlist');
        if (!active || !list) return Infinity;
        const row = active.getBoundingClientRect(),
          panel = list.getBoundingClientRect();
        return Math.abs(row.y + row.height / 2 - panel.y - panel.height / 2);
      }),
    )
    .toBeLessThan(12);
  const moves = await page.evaluate(() => (window as any).centerMoves);
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.every((move: any) => move.immediate)).toBe(true);
  await expect(
    page.locator('.synced-line.current .lyrics-original'),
  ).toHaveText('Line 6');
  await expect(page.locator('.lyrics-word')).toHaveCount(0);
  const active = page.locator('.synced-line.current');
  await active.focus();
  await page.keyboard.press('Enter');
  // The real renderer owns the API; a synthetic paused media API is installed for seeking.
  await page.evaluate(async () => {
    await (window as any).nativeClock();
    (window as any).fixture.video.currentTime = 31;
    (window as any).fixture.setTime(31000);
  });
  await active.focus();
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => (window as any).fixture.video.currentTime),
  ).toBe(30.01);
  expect(
    await active.evaluate((node) => getComputedStyle(node).animationName),
  ).toBe('none');
  if (process.env.PEAR_LYRICS_EVIDENCE_DIR)
    await page.locator('#lyrics-tab').screenshot({
      path: path.join(
        process.env.PEAR_LYRICS_EVIDENCE_DIR,
        'lyrics-reduced-motion.png',
      ),
    });
});

test('explicit silent intervals get calm accessible feedback and hidden panels stop scrolling', async ({
  page,
}) => {
  await mount(page, [
    { ...timed, timeInMs: 0, duration: 10000, text: '', words: [] },
    { ...timed, timeInMs: 10000 },
  ]);
  await page.evaluate(() => (window as any).fixture.setTime(2500));
  await expect(page.locator('.instrumental-indicator')).toHaveCount(1);
  await expect(page.locator('.instrumental-indicator')).toHaveAttribute(
    'aria-label',
    'Instrumental',
  );
  const marker = page.locator('.instrumental-indicator');
  const geometry = await marker.boundingBox();
  await page.evaluate(() => (window as any).fixture.setTime(7500));
  expect(await marker.boundingBox()).toEqual(geometry);
  expect(
    await marker.evaluate((node) => [
      getComputedStyle(node).animationName,
      getComputedStyle(node).transform,
    ]),
  ).toEqual(['none', 'none']);
  if (process.env.PEAR_LYRICS_EVIDENCE_DIR)
    await page.locator('#lyrics-tab').screenshot({
      path: path.join(
        process.env.PEAR_LYRICS_EVIDENCE_DIR,
        'lyrics-instrumental.png',
      ),
    });
  await page.evaluate(() => {
    (window as any).fixture.setVisible(false);
    (window as any).fixture.setTime(11000);
  });
  await expect(page.locator('.synced-lyrics-vlist')).toHaveCount(0);
});

test('actual LRCLib uses optional lyricsfile, keeps ordinary LRC fallback and represents verified instrumental metadata', async ({
  page,
}) => {
  await mount(page, [timed]);
  const record = {
    trackName: 'Song',
    artistName: 'Artist',
    duration: 10,
    instrumental: false,
    syncedLyrics: '[00:01.00]Fallback',
    plainLyrics: 'Plain',
  };
  const payload = `version: "1.0"
lines:
  - text: Hello world
    start_ms: 1000
    end_ms: 3000
    words:
      - text: "Hello "
        start_ms: 1000
      - text: world
        start_ms: 2000
`;
  const result = await page.evaluate(
    (record) => (window as any).searchProvider([record]),
    { ...record, lyricsfile: payload },
  );
  expect(result.lines[1].words).toEqual(timed.words);
  const fallback = await page.evaluate(
    (record) => (window as any).searchProvider([record]),
    { ...record, lyricsfile: 'unsupported document' },
  );
  expect(fallback.lines[1]).toMatchObject({ text: 'Fallback', words: [] });
  const instrumental = await page.evaluate(
    (record) => (window as any).searchProvider([record]),
    { ...record, instrumental: true },
  );
  expect(instrumental.lines).toEqual([
    {
      time: '00:00',
      timeInMs: 0,
      duration: 10000,
      text: '',
      words: [],
      instrumental: true,
      status: 'upcoming',
    },
  ]);
  expect(
    await page.evaluate((record) => (window as any).searchProvider([record]), {
      ...record,
      instrumental: true,
      duration: 0,
    }),
  ).toBeNull();
});

test('real paused/playing/rate/seek media clock drives words; native renderer stop removes its clock', async ({
  page,
}) => {
  await mount(page, [timed]);
  await page.evaluate(async () => {
    await (window as any).nativeClock();
    (window as any).fixture.video.currentTime = 1.1;
  });
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(1);
  await page.evaluate(async () => {
    const video = (window as any).fixture.video;
    video.playbackRate = 2;
    await video.play();
  });
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(2);
  await page.evaluate(() => {
    const video = (window as any).fixture.video;
    video.pause();
    video.currentTime = 0.5;
  });
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(0);
  await page.evaluate(() => (window as any).fixture.disposeClock());
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => [
      (window as any).fixture.time(),
      (window as any).fixture.plugin.updateTimestampInterval,
    ]),
  ).toEqual([-1, undefined]);
});

test('actual LRCLib rejects malformed optional lyricsfile instead of masking complete LRC/plain fallbacks', async ({
  page,
}) => {
  await mount(page, [timed]);
  const record = {
    trackName: 'Song',
    artistName: 'Artist',
    duration: 10,
    instrumental: false,
    syncedLyrics: '[00:01.00]Fallback',
    plainLyrics: 'Plain fallback',
  };
  const malformed = [
    'lines:\n  - start_ms: 1000\n    words: []\n',
    'lines:\n  - text: null\n    start_ms: 1000\n    words: []\n',
    'lines:\n  - text: 123\n    start_ms: 1000\n    words: []\n',
    'lines:\n  - text: |\n      Real lyric text\n    start_ms: 1000\n    words: []\n',
    'lines:\n  - text: >-\n      Real lyric text\n    start_ms: 1000\n    words: []\n',
    'lines:\n  - text: Good\n    start_ms: 0\n  - start_ms: 1000\n    words: []\n',
    'lines: []',
  ];
  for (const lyricsfile of malformed) {
    const result = await page.evaluate(
      (record) => (window as any).searchProvider([record]),
      { ...record, lyricsfile },
    );
    expect(
      result.lines.find((line: any) => line.text === 'Fallback'),
    ).toBeDefined();
    const plain = await page.evaluate(
      (record) => (window as any).searchProvider([record]),
      { ...record, syncedLyrics: '', lyricsfile },
    );
    expect(plain.lines).toBeUndefined();
    expect(plain.lyrics).toBe('Plain fallback');
  }
  const explicit = await page.evaluate(
    (record) => (window as any).searchProvider([record]),
    {
      ...record,
      lyricsfile:
        'lines:\n  - text: ""\n    start_ms: 0\n    end_ms: 1000\n    words: []\n  - text: "|"\n    start_ms: 1000\n    words: []',
    },
  );
  expect(explicit.lines.map((line: any) => line.text)).toEqual(['', '|']);
});

test('real virtualized list centers measured rows, retargets mid-motion, resizes and hides without retired scrolling', async ({
  page,
}) => {
  await mount(
    page,
    Array.from({ length: 30 }, (_, i) => ({
      ...timed,
      words: undefined,
      timeInMs: i * 4000,
      duration: 4000,
      text:
        i % 2
          ? `Line ${i}`
          : `Line ${i} wraps gently across this longer lyric phrase`,
    })),
  );
  const centerError = () =>
    page.evaluate(() => {
      const active = document.querySelector('.synced-line.current');
      const list = document.querySelector('.synced-lyrics-vlist');
      if (!active || !list) return Infinity;
      const row = active.getBoundingClientRect();
      const panel = list.getBoundingClientRect();
      return Math.abs(row.y + row.height / 2 - panel.y - panel.height / 2);
    });
  await page.evaluate(() => (window as any).fixture.setTime(25000));
  await expect.poll(centerError).toBeLessThan(12);
  await page.evaluate(() => (window as any).fixture.setTime(45000));
  await page.waitForTimeout(60);
  const offsets = await page.evaluate(() => {
    const panel = document.querySelector('.synced-lyrics-vlist')!;
    const before = panel.scrollTop;
    (window as any).fixture.setTime(13000);
    return [before, panel.scrollTop];
  });
  expect(Math.abs(offsets[0] - offsets[1])).toBeLessThan(2);
  await expect.poll(centerError).toBeLessThan(12);
  await page.evaluate(
    () =>
      (document.querySelector<HTMLElement>('#lyrics-tab')!.style.height =
        '600px'),
  );
  await expect.poll(centerError).toBeLessThan(12);
  await page.evaluate(() => {
    (window as any).oldPanel = document.querySelector('.synced-lyrics-vlist');
    (window as any).fixture.setTime(33000);
    (window as any).fixture.setVisible(false);
    (window as any).oldOffset = (window as any).oldPanel.scrollTop;
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).oldPanel.scrollTop)).toBe(
    await page.evaluate(() => (window as any).oldOffset),
  );
  await page.evaluate(() => (window as any).fixture.setVisible(true));
  await expect.poll(centerError).toBeLessThan(12);
  if (process.env.PEAR_LYRICS_EVIDENCE_DIR)
    await page.screenshot({
      path: path.join(
        process.env.PEAR_LYRICS_EVIDENCE_DIR,
        'lyrics-word-browser.png',
      ),
    });
  if (process.env.PEAR_LYRICS_EVIDENCE_DIR) {
    await page.evaluate(() => {
      const w = window as any;
      w.fixture.setLines(
        Array.from({ length: 20 }, (_, i) => ({
          time: '',
          timeInMs: i * 4000,
          duration: 4000,
          status: 'upcoming',
          text: i === 8 ? 'Hello world' : `Fixture line ${i}`,
          words:
            i === 8
              ? [
                  { word: 'Hello ', timeInMs: 32000 },
                  { word: 'world', timeInMs: 33000 },
                ]
              : undefined,
        })),
      );
      w.fixture.setTime(32500);
    });
    await expect.poll(centerError).toBeLessThan(12);
    await expect(page.locator('.lyrics-word.sung')).toHaveCount(1);
    await page.waitForTimeout(200);
    await page.locator('#lyrics-tab').screenshot({
      path: path.join(
        process.env.PEAR_LYRICS_EVIDENCE_DIR,
        'lyrics-first-word.png',
      ),
    });
    await page.evaluate(() => (window as any).fixture.setTime(33500));
    await expect(page.locator('.lyrics-word.sung')).toHaveCount(2);
    await page.waitForTimeout(200);
    await page.locator('#lyrics-tab').screenshot({
      path: path.join(
        process.env.PEAR_LYRICS_EVIDENCE_DIR,
        'lyrics-second-word.png',
      ),
    });
  }
});

test('saved timing offset moves line and word clocks together and keyboard seek reverses it', async ({
  page,
}) => {
  await mount(page, [timed]);
  await page.evaluate(() => (window as any).nativeClock());
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.setConfig({
      enabled: true,
      lineEffect: 'fancy',
      romanization: false,
      defaultTextString: '',
      showTimeCodes: false,
      timingOffsetMs: 500,
      romanizationSizePercent: 50,
    });
    f.video.currentTime = 1.2;
    f.setTime(1200);
  });
  await expect(page.locator('.synced-line.upcoming')).toHaveCount(1);
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(0);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.video.currentTime = 1.6;
    f.setTime(1600);
  });
  await expect(page.locator('.synced-line.current')).toHaveCount(1);
  await expect(page.locator('.lyrics-word.sung')).toHaveCount(1);
  const active = page.locator('.synced-line.current');
  await active.focus();
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => (window as any).fixture.video.currentTime),
  ).toBe(1.51);
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue(
        '--lyrics-romanization-ratio',
      ),
    ),
  ).toBe('0.5');
});
