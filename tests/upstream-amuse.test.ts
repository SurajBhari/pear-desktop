import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { Hono } from 'hono';
import { transformWithOxc } from 'vite';

async function fixture() {
  const provider = await readFile(
    new URL('../src/providers/song-info.ts', import.meta.url),
    'utf8',
  );
  const enumSource = (
    await transformWithOxc(
      provider.match(/export enum MediaType \{[\s\S]*?\n\}/)![0],
      'media-type.ts',
    )
  ).code;
  const { MediaType } = await import(
    `data:text/javascript;base64,${Buffer.from(enumSource).toString('base64')}`
  );
  const key = `amuse_${crypto.randomUUID()}`;
  const state = { Hono, callback: undefined as any };
  (globalThis as any)[key] = state;
  const raw = await readFile(
    new URL('../src/plugins/amuse/backend.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw).replace(/^import[\s\S]*?;\n/gm, '');
  const boundaries = `const fixture=globalThis[${JSON.stringify(key)}];
    const Hono=fixture.Hono; const cors=()=>async(c,next)=>next();
    const serve=()=>({close(){}}); const t=key=>key; const createBackend=x=>x;
    const MediaType=${JSON.stringify(MediaType)};
    const registerCallback=fn=>{fixture.callback=fn;return()=>{fixture.callback=undefined}};`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundaries + actual).toString('base64')}`
  );
  source.default.start();
  return {
    MediaType,
    set: (info: any) => state.callback(info),
    query: async (route = '/query') =>
      (await source.default.app.request(route)).json(),
    close: () => {
      source.default.stop();
      delete (globalThis as any)[key];
    },
  };
}

test('Amuse exposes the full empty 6K Labs contract on both routes', async () => {
  const f = await fixture();
  try {
    const value = await f.query();
    expect(value).toEqual({
      player: {
        hasSong: false,
        isPaused: true,
        volumePercent: 0,
        seekbarCurrentPosition: 0,
        seekbarCurrentPositionHuman: '0:00',
        statePercent: 0,
        likeStatus: 'INDIFFERENT',
        repeatType: 'NONE',
      },
      track: {
        author: '',
        title: '',
        album: '',
        cover: '',
        duration: 0,
        durationHuman: '0:00',
        url: '',
        id: '',
        isVideo: false,
        isAdvertisement: false,
        inLibrary: false,
      },
    });
    expect(await f.query('/api')).toEqual(value);
  } finally {
    f.close();
  }
});

test('Amuse supplies real metadata and finite bounded progress', async () => {
  const f = await fixture();
  try {
    f.set({
      artist: 'Artist',
      title: 'Title',
      album: 'Album',
      videoId: 'id',
      songDuration: 125.9,
      elapsedSeconds: 66.9,
      mediaType: f.MediaType.Audio,
    });
    const value = await f.query();
    expect(value.player).toMatchObject({
      hasSong: true,
      seekbarCurrentPosition: 66,
      seekbarCurrentPositionHuman: '1:06',
      statePercent: 53,
    });
    expect(value.track).toMatchObject({
      album: 'Album',
      duration: 125,
      durationHuman: '2:05',
      isVideo: false,
    });
    f.set({
      artist: 'Artist',
      title: 'Title',
      songDuration: 5,
      elapsedSeconds: 999,
      mediaType: f.MediaType.UserGeneratedContent,
    });
    expect((await f.query()).player.statePercent).toBe(100);
    f.set({
      artist: 'Artist',
      title: 'Title',
      songDuration: NaN,
      elapsedSeconds: -Infinity,
    });
    expect((await f.query()).player.seekbarCurrentPositionHuman).toBe('0:00');
    expect((await f.query()).track.duration).toBe(0);
  } finally {
    f.close();
  }
});

test('Amuse recognizes the actual official music video enum as video', async () => {
  const f = await fixture();
  try {
    f.set({
      artist: 'Artist',
      title: 'Title',
      videoId: 'id',
      mediaType: f.MediaType.OriginalMusicVideo,
    });
    expect((await f.query()).track.isVideo).toBe(true);
  } finally {
    f.close();
  }
});
