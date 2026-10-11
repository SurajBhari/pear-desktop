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

export async function musicModuleSource(relative: string, electron?: unknown) {
  const catalog = path.join(root, relative);
  if (!existsSync(catalog)) return {};
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-music-catalog-'));
  try {
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, `export * from ${JSON.stringify(catalog)};`);
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
