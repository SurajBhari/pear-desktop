import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '../..');
export async function filterBundle() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-filter-'));
  const entry = path.join(directory, 'entry.ts');
  const exports = ['blocklist', 'skip-live-songs'].map((name, index) => {
    const target = path.join(root, 'src/plugins', name, 'index.ts');
    // Missing-feature RED boundary: absence behaves as an inactive plugin, not an import error.
    return existsSync(target)
      ? `export {default as ${index ? 'live' : 'blocklist'}} from ${JSON.stringify(target)};`
      : `export const ${index ? 'live' : 'blocklist'}={renderer:{async start(){},onPlayerApiReady(){},onConfigChange(){},stop(){}}};`;
  });
  await writeFile(entry, exports.join('\n'));
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'filter-owned-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            if (
              [
                '@/utils',
                '@/i18n',
                '@/providers/song-info-front',
                'custom-electron-prompt',
                '@/providers/prompt-options',
              ].includes(id)
            )
              return `\0${id}`;
            if (id.endsWith('?inline') && importer)
              return `\0style:${path.resolve(path.dirname(importer), id.slice(0, -7))}.js`;
            if (id.startsWith('@/')) {
              const p = path.join(root, 'src', id.slice(2));
              return [p, `${p}.ts`, `${p}.tsx`, path.join(p, 'index.ts')].find(
                (file) => existsSync(file) && statSync(file).isFile(),
              );
            }
          },
          load(id) {
            if (id === '\0@/utils')
              return 'export const createPlugin=value=>value;';
            if (id === '\0@/i18n')
              return 'export const t=(key,args)=>args?.name?key+": "+args.name:key;';
            if (id === '\0@/providers/song-info-front')
              return 'export const getSongInfo=()=>window.metadata;';
            if (id === '\0custom-electron-prompt')
              return 'export default async (...args)=>window.promptBoundary(...args);';
            if (id === '\0@/providers/prompt-options')
              return 'export default ()=>({});';
            if (id.startsWith('\0style:'))
              return readFile(id.slice(7, -3), 'utf8').then(
                (s) => `export default ${JSON.stringify(s)};`,
              );
          },
        },
      ],
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry,
          formats: ['iife'],
          name: 'FilterFixture',
          fileName: () => 'fixture.js',
        },
      },
    });
    return await readFile(path.join(directory, 'fixture.js'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
