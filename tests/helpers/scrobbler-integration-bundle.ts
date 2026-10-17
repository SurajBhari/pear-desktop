import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '../..');
export async function scrobblerBundle(boundary: unknown) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-scrobbler-integration-'),
  );
  const entry = path.join(directory, 'entry.ts');
  const lines = [
    `export * from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/services/lastfm.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/services/listenbrainz.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/main.ts'))};`,
    `export {onMenu} from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/menu.ts'))};`,
    `export {defaultConfig} from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/index.ts'))};`,
  ];
  const libre = path.join(root, 'src/plugins/scrobbler/services/librefm.ts');
  if (existsSync(libre)) lines.push(`export * from ${JSON.stringify(libre)};`);
  await writeFile(entry, lines.join('\n'));
  (globalThis as Record<string, unknown>).__scrobblerBoundary = boundary;
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      plugins: [
        {
          name: 'owned-scrobbler-public-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (
              [
                'electron',
                '@/utils',
                '@/i18n',
                '@/providers/song-info',
                '@/providers/prompt-options',
                'custom-electron-prompt',
                'node:timers',
              ].includes(id)
            )
              return '\0scrobbler:' + id;
            if (id.endsWith('ws-auth-window'))
              return '\0scrobbler:native-auth-contract';
            if (id.startsWith('@/'))
              return path.join(root, 'src', id.slice(2)) + '.ts';
          },
          load(id) {
            if (id === '\0scrobbler:electron')
              return 'const b=globalThis.__scrobblerBoundary;export const app={getVersion:()=>"TEST"};export const net={fetch:(...a)=>b.fetcher(...a)};export const ipcMain=b.ipcMain;export const BrowserWindow=b.BrowserWindow;export const dialog={showMessageBox:async()=>({response:1})};';
            if (id === '\0scrobbler:@/utils')
              return 'export const createBackend=v=>v;export const createPlugin=v=>v;';
            if (id === '\0scrobbler:@/i18n')
              return 'export const t=k=>k;export const APPLICATION_NAME="Pear";';
            if (id === '\0scrobbler:@/providers/song-info')
              return 'const b=globalThis.__scrobblerBoundary;export const registerCallback=(...a)=>b.registerCallback(...a);export const getSongInfoProvenance=i=>b.provenance.get(i)??null;export const getCurrentSongInfoProvenance=w=>b.currentProvenance;export const MediaType={Audio:"AUDIO",OriginalMusicVideo:"ORIGINAL_MUSIC_VIDEO"};export const SongInfoEvent={VideoSrcChanged:"peard:video-src-changed",PlayOrPaused:"peard:play-or-paused",TimeChanged:"peard:time-changed"};';
            if (id === '\0scrobbler:native-auth-contract')
              return 'export const openScrobblingAuthWindow=(...a)=>globalThis.__scrobblerBoundary.openSurface(...a.slice(1));';
            if (id === '\0scrobbler:node:timers')
              return 'const b=globalThis.__scrobblerBoundary;export const setTimeout=(...a)=>b.setTimeout(...a);export const clearTimeout=id=>b.clearTimeout(id);';
            if (id === '\0scrobbler:custom-electron-prompt')
              return 'export default (...a)=>globalThis.__scrobblerBoundary.prompt(...a);';
            if (id === '\0scrobbler:@/providers/prompt-options')
              return 'export default ()=>({});';
          },
        },
      ],
      build: {
        ssr: entry,
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'bundle.mjs' } },
      },
    });
    return await import(pathToFileURL(path.join(directory, 'bundle.mjs')).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
