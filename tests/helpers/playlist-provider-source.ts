import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

/** Real provider embedding for existing renderer-entry fixtures; no copied queue behavior. */
export async function playlistProviderSource() {
  const strip = (source: string) =>
    stripTypeScriptTypes(source)
      .replace(/^import[\s\S]*?;\n/gm, '')
      .replace(/^export /gm, '');
  return (
    strip(
      await readFile(
        new URL('../../src/providers/queue-playlist.ts', import.meta.url),
        'utf8',
      ),
    ) +
    '\n' +
    strip(
      await readFile(
        new URL(
          '../../src/providers/queue-playlist-renderer.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    )
  );
}
