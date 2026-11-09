import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '../..');
let serial = 0;
export const lrclibSong = {
  videoId: 'public-fixture',
  title: 'Yellow',
  artist: 'Coldplay',
  songDuration: 269,
  tags: [],
};
export const lrclibTrack = (patch: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Yellow',
  trackName: 'Yellow',
  artistName: 'Coldplay',
  albumName: 'Parachutes',
  duration: 269,
  instrumental: false,
  syncedLyrics: '[00:01.00]First\n[00:04.00]Later',
  plainLyrics: 'First\nLater',
  ...patch,
});
export async function lrclibFixture(
  handler: (call: {
    url: URL;
    init?: RequestInit;
    index: number;
  }) => unknown | Promise<unknown>,
  integration = false,
) {
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-lrclib-'));
  const key = '__lrclibFixture' + ++serial;
  const state = {
    config: { enabled: true, showLyricsEvenIfInexact: false },
    song: { ...lrclibSong },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const oldFetch = globalThis.fetch;
  const calls: { url: URL; init?: RequestInit; index: number }[] = [];
  globals[key] = state;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init, index: calls.length };
    calls.push(call);
    const value = await handler(call);
    return value instanceof Response
      ? value
      : new Response(JSON.stringify(value), {
          headers: { 'content-type': 'application/json' },
        });
  }) as typeof fetch;
  try {
    const entry = path.join(owned, 'entry.ts');
    await writeFile(
      entry,
      `export {LRCLib} from ${JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/providers/LRCLib.ts'))};${integration ? 'export * from ' + JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/renderer/store.ts')) + ';' : ''}`,
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      resolve: {
        alias: [
          { find: '@/providers/song-info-front', replacement: '\0lrclib-song' },
          { find: '@', replacement: path.join(root, 'src') },
        ],
      },
      plugins: [
        {
          name: 'only-owned-config-http-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            if (
              (id === '../renderer/renderer' &&
                importer?.endsWith('/providers/LRCLib.ts')) ||
              (id === './renderer' && importer?.endsWith('/renderer/store.ts'))
            )
              return '\0lrclib-config';
            if (id === '@/providers/song-info-front') return '\0lrclib-song';
            if (
              integration &&
              id === '../providers/renderer' &&
              importer?.endsWith('/renderer/store.ts')
            )
              return '\0lrclib-providers';
            return undefined;
          },
          load(id) {
            if (id === '\0lrclib-config')
              return `export const config=()=>globalThis[${JSON.stringify(key)}].config;`;
            if (id === '\0lrclib-song')
              return `export const getSongInfo=()=>globalThis[${JSON.stringify(key)}].song;`;
            if (id === '\0lrclib-providers')
              return `import{LRCLib}from${JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/providers/LRCLib.ts'))};export const providers={LRCLib:new LRCLib(),YTMusic:{search:async()=>null},MusixMatch:{search:async()=>null},LyricsGenius:{search:async()=>null}};`;
            return undefined;
          },
        },
      ],
      build: {
        ssr: entry,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'source.mjs' } },
      },
    });
    const source = await import(
      pathToFileURL(path.join(owned, 'source.mjs')).href
    );
    return {
      provider: new source.LRCLib(),
      source,
      state,
      calls,
      async close() {
        source.stopLyricsSession?.();
        globalThis.fetch = oldFetch;
        delete globals[key];
        await rm(owned, { recursive: true, force: true });
      },
    };
  } catch (error) {
    globalThis.fetch = oldFetch;
    delete globals[key];
    await rm(owned, { recursive: true, force: true });
    throw error;
  }
}
export const settleLRCLib = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
