import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { build } from 'vite';
import solidPlugin from 'vite-plugin-solid';

import { i18nImporter } from '../vite-plugins/i18n-importer.mts';

const root = path.resolve(import.meta.dirname, '..');
const cases = [
  ['大韓民國', 'daehanminguk'],
  ['女子 大學', 'yeoja daehak'],
  ['한글', 'hangeul'],
];

for (const defaultOnly of [false, true]) {
  test(`production Korean converter handles Hanja and Hangul with default-only JSON ${defaultOnly}`, async () => {
    const scratch = await mkdtemp(
      path.join(tmpdir(), 'pear-korean-converter-'),
    );
    const window = new Window({ url: 'https://music.youtube.com/' });
    try {
      const entry = path.join(scratch, 'entry.js');
      await writeFile(
        entry,
        `import { romanizeHangul } from ${JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/renderer/utils.tsx'))}; window.romanizeFixture = romanizeHangul;`,
      );
      const result = await build({
        root,
        configFile: false,
        logLevel: 'error',
        json: defaultOnly
          ? { namedExports: false, stringify: true }
          : undefined,
        resolve: { alias: { '@': path.join(root, 'src') } },
        plugins: [
          solidPlugin(),
          {
            name: 'korean-fixture-i18n',
            resolveId(id) {
              if (id === 'virtual:i18n') return '\0korean-fixture-i18n';
            },
            load(id) {
              if (id === '\0korean-fixture-i18n') return i18nImporter();
            },
          },
        ],
        build: {
          lib: { entry, formats: ['iife'], name: 'koreanFixture' },
          minify: true,
          write: false,
        },
      });
      const bundle = Array.isArray(result) ? result[0] : result;
      const chunks = bundle.output.filter((item) => item.type === 'chunk');
      expect(chunks).toHaveLength(1);
      Object.assign(window, {
        mainConfig: {
          get: () => undefined,
          plugins: { getPlugins: () => ({}) },
        },
        ipcRenderer: {
          invoke: async () => undefined,
          on() {},
          send() {},
          removeAllListeners() {},
        },
        electronIs: {
          linux: () => false,
          windows: () => false,
          osx: () => true,
          macOS: () => true,
        },
        fetch: () =>
          Promise.reject(
            new Error('Unexpected network request in converter fixture'),
          ),
      });
      window.eval(chunks[0].code);
      const romanize = (
        window as unknown as { romanizeFixture: (input: string) => string }
      ).romanizeFixture;
      for (const [input, expected] of cases)
        expect(romanize(input)).toBe(expected);
    } finally {
      await window.happyDOM.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
