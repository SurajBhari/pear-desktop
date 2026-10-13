import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import { existsSync, statSync, readFileSync } from 'node:fs';

const root = path.resolve(import.meta.dirname, '../..');

/** Bundles the actual production modules; only app translation/plugin wrappers are replaced. */
export async function equalizerBundle(extra = '', translate = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-equalizer-'));
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `export {default as plugin} from ${JSON.stringify(path.join(root, 'src/plugins/equalizer/index.ts'))};${extra}`,
  );
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'equalizer-app-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id === '@/utils' || id === '@/i18n') return `\0${id}`;
            if (
              [
                'custom-electron-prompt',
                'youtubei.js',
                '@/plugins/utils/main',
                '@/providers/prompt-options',
              ].includes(id)
            )
              return `\0${id}`;
            if (id.endsWith('?inline') && importer)
              return `\0style:${path.resolve(path.dirname(importer), id.slice(0, -7))}.js`;
            if (id.startsWith('@/')) {
              const target = path.join(root, 'src', id.slice(2));
              return [
                target,
                `${target}.ts`,
                `${target}.tsx`,
                path.join(target, 'index.ts'),
              ].find((file) => existsSync(file) && statSync(file).isFile());
            }
          },
          load(id) {
            if (id === '\0@/utils')
              return 'export const createPlugin=value=>value;';
            if (id === '\0@/i18n')
              return translate
                ? `const resources=${readFileSync(path.join(root, 'src/i18n/resources/en.json'), 'utf8')};export const t=key=>key.split('.').reduce((value,part)=>value?.[part],resources)??key;`
                : 'export const t=key=>key;';
            if (id === '\0custom-electron-prompt')
              return 'export default async()=>undefined;';
            if (id === '\0youtubei.js')
              return 'export const Innertube={create:async()=>({})};';
            if (id === '\0@/plugins/utils/main')
              return 'export const getNetFetchAsFetch=()=>fetch;';
            if (id === '\0@/providers/prompt-options')
              return 'export default {};';
            if (id.startsWith('\0style:'))
              return `export default ${JSON.stringify(readFileSync(id.slice(7, -3), 'utf8'))};`;
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
          name: 'EqualizerFixture',
          fileName: () => 'fixture.js',
        },
      },
    });
    return await readFile(path.join(directory, 'fixture.js'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function fixturePage(
  page: import('@playwright/test').Page,
  source: string,
) {
  await page.route('https://eq.fixture.invalid/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><video></video></body></html>',
    }),
  );
  await page.goto('https://eq.fixture.invalid/');
  await page.addScriptTag({ content: source });
}
