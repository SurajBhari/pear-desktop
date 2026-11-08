import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

import { test, expect } from '@playwright/test';

import type { LyricResult } from '../src/plugins/synced-lyrics/types';

async function fixture(page: import('@playwright/test').Page, direct = false) {
  await page.setContent('<ytmusic-app></ytmusic-app>');
  const source = stripTypeScriptTypes(
    await readFile(
      new URL(
        '../src/plugins/synced-lyrics/providers/YTMusic.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export /gm, '');
  await page.addScriptTag({
    content: `
const state={settings:{useYTMLyricsWithoutProxy:${direct}},requests:[],proxy:[],gate:null};
const config=()=>state.settings;
const browse={contents:{sectionListRenderer:{contents:[{musicDescriptionShelfRenderer:{description:{runs:[{text:'One lyric'},{text:'Second lyric'}]}}}]}}};
const next={contents:{singleColumnMusicWatchNextResultsRenderer:{tabbedRenderer:{watchNextTabbedResultsRenderer:{tabs:[{tabRenderer:{endpoint:{browseEndpoint:{browseId:'MPLYt_test',browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:'MUSIC_PAGE_TYPE_TRACK_LYRICS'}}}}}}]}}}}};
const network={async fetch(endpoint,body){if(this!==network)throw Error('Network receiver lost');state.requests.push([endpoint,body]);if(state.gate && endpoint===state.heldEndpoint)await state.gate;return endpoint.startsWith('/next')?next:browse;}};
document.querySelector('ytmusic-app').networkManager=network;
window.fetch=async(endpoint,options)=>{state.proxy.push([endpoint,options]);return {ok:true,json:async()=>browse};};
${source}
window.lyricsFixture={state,network,browse,search:()=>new YTMusic().search({videoId:'OwnedSong01',title:'Owned Song',artist:'Owned Artist'})};
`,
  });
}

test('default proxy mode preserves authenticated next and existing browse response shape', async ({
  page,
}) => {
  await fixture(page);
  const output = await page.evaluate(async () => {
    const f = (window as any).lyricsFixture;
    const result = await f.search();
    return { result, requests: f.state.requests, proxy: f.state.proxy };
  });
  expect(output.result).toEqual({
    title: 'Owned Song',
    artists: ['Owned Artist'],
    lyrics: 'One lyric\nSecond lyric',
  });
  expect(output.requests).toEqual([
    ['/next?prettyPrint=false', { videoId: 'OwnedSong01' }],
  ]);
  expect(output.proxy).toHaveLength(1);
  expect(output.proxy[0][0]).toBe(
    'https://ytmbrowseproxy.zvz.be/browse?prettyPrint=false',
  );
  expect(JSON.parse(output.proxy[0][1].body).browseId).toBe('MPLYt_test');
});

test('enabled direct mode uses the current app network manager for browse and sends no proxy request', async ({
  page,
}) => {
  await fixture(page, true);
  const output = await page.evaluate(async () => {
    const f = (window as any).lyricsFixture;
    const result = await f.search();
    return { result, requests: f.state.requests, proxy: f.state.proxy };
  });
  expect(output.result).toEqual({
    title: 'Owned Song',
    artists: ['Owned Artist'],
    lyrics: 'One lyric\nSecond lyric',
  });
  expect(output.requests).toEqual([
    ['/next?prettyPrint=false', { videoId: 'OwnedSong01' }],
    ['/browse?prettyPrint=false', { browseId: 'MPLYt_test' }],
  ]);
  expect(output.proxy).toEqual([]);
});

for (const direct of [false, true]) {
  test(`timed ${direct ? 'direct' : 'proxy'} lyrics preserve Unicode whitespace and normalize only a music-note gap`, async ({
    page,
  }) => {
    await fixture(page, direct);
    const lines = await page.evaluate(async () => {
      const f = (
        window as unknown as {
          lyricsFixture: {
            browse: { contents: unknown };
            search(): Promise<LyricResult>;
          };
        }
      ).lyricsFixture;
      f.browse.contents = {
        elementRenderer: {
          newElement: {
            type: {
              componentType: {
                model: {
                  timedLyricsModel: {
                    lyricsData: {
                      timedLyricsData: [
                        {
                          lyricLine: '  東京\t ',
                          cueRange: {
                            startTimeMilliseconds: '0',
                            endTimeMilliseconds: '1000',
                          },
                        },
                        {
                          lyricLine: '\t👩🏽‍🚀 е́  世界\u00a0',
                          cueRange: {
                            startTimeMilliseconds: '1000',
                            endTimeMilliseconds: '2000',
                          },
                        },
                        {
                          lyricLine: ' \t♪ \u00a0',
                          cueRange: {
                            startTimeMilliseconds: '2000',
                            endTimeMilliseconds: '4000',
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      };
      return (await f.search()).lines;
    });
    expect(lines?.map((line) => line.text)).toEqual([
      '  東京\t ',
      '\t👩🏽‍🚀 е́  世界\u00a0',
      '',
    ]);
    expect(lines?.map((line) => [line.timeInMs, line.duration])).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 2000],
    ]);
  });
}

for (const kind of ['app', 'network', 'mode'] as const) {
  test(`pending direct browse cannot publish after ${kind} replacement`, async ({
    page,
  }) => {
    await fixture(page, true);
    await page.evaluate(() => {
      const f = (window as any).lyricsFixture;
      f.state.heldEndpoint = '/browse?prettyPrint=false';
      f.state.gate = new Promise<void>((resolve) => (f.release = resolve));
      f.pending = f.search();
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).lyricsFixture.state.requests.length,
        ),
      )
      .toBe(2);
    await page.evaluate((kind) => {
      const f = (window as any).lyricsFixture;
      if (kind === 'app') {
        document.querySelector('ytmusic-app')!.remove();
        document.body.appendChild(document.createElement('ytmusic-app'));
      }
      if (kind === 'network')
        (document.querySelector('ytmusic-app') as any).networkManager = {
          fetch: () => {
            throw Error('No replacement fetch');
          },
        };
      if (kind === 'mode') f.state.settings.useYTMLyricsWithoutProxy = false;
      f.release();
    }, kind);
    expect(
      await page.evaluate(() => (window as any).lyricsFixture.pending),
    ).toBeNull();
  });
}

test('a replaced app during next cannot initiate browse in the new app or at the proxy', async ({
  page,
}) => {
  await fixture(page, true);
  await page.evaluate(() => {
    const f = (window as any).lyricsFixture;
    f.state.heldEndpoint = '/next?prettyPrint=false';
    f.state.gate = new Promise<void>((resolve) => (f.release = resolve));
    f.pending = f.search();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).lyricsFixture.state.requests.length),
    )
    .toBe(1);
  await page.evaluate(() => {
    const f = (window as any).lyricsFixture;
    document.querySelector('ytmusic-app')!.remove();
    const replacement = document.createElement('ytmusic-app');
    (replacement as any).networkManager = f.network;
    document.body.appendChild(replacement);
    f.release();
  });
  expect(
    await page.evaluate(() => (window as any).lyricsFixture.pending),
  ).toBeNull();
  expect(
    await page.evaluate(() => (window as any).lyricsFixture.state.proxy),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as any).lyricsFixture.state.requests.length,
    ),
  ).toBe(1);
});

test('missing native app or network manager returns unavailable without a proxy request', async ({
  page,
}) => {
  await fixture(page, true);
  expect(
    await page.evaluate(async () => {
      const f = (window as any).lyricsFixture;
      (document.querySelector('ytmusic-app') as any).networkManager = undefined;
      return f.search();
    }),
  ).toBeNull();
  expect(
    await page.evaluate(() => (window as any).lyricsFixture.state.proxy),
  ).toEqual([]);
});
