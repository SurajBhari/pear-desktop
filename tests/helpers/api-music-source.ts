import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '../..');
/** Bundle actual pure music modules; no product substitute or transport mocks. */
export async function musicCatalogSource() {
  return musicModuleSource('src/providers/music-catalog.ts');
}

export async function musicModuleSource(
  relative: string | readonly string[],
  electron?: unknown,
) {
  const sources = (typeof relative === 'string' ? [relative] : relative).map(
    (source) => path.join(root, source),
  );
  if (!sources.every((source) => existsSync(source))) return {};
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-music-catalog-'));
  try {
    const entry = path.join(owned, 'entry.ts');
    await writeFile(
      entry,
      sources.map((source) => `export * from ${JSON.stringify(source)};`).join('\n'),
    );
    const aliases: Record<string, string> = { '@': path.join(root, 'src') };
    if (electron) {
      (globalThis as any).__musicElectron = electron;
      const mock = path.join(owned, 'electron.ts');
      await writeFile(
        mock,
        'export const ipcMain = globalThis.__musicElectron.ipcMain;',
      );
      aliases.electron = mock;
    }
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      resolve: { alias: aliases },
      build: {
        ssr: entry,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'source.mjs' } },
      },
    });
    return await import(pathToFileURL(path.join(owned, 'source.mjs')).href);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}
