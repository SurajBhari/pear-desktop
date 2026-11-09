import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { build } from 'vite';
import solidPlugin from 'vite-plugin-solid';

import { i18nImporter } from '../vite-plugins/i18n-importer.mts';

const root = path.resolve(import.meta.dirname, '..');
let scratch: string;
let code: string;

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'pear-deferred-pinyin-test-'));
  const entry = path.join(scratch, 'entry.js');
  await writeFile(
    entry,
    `import {romanize,romanizeHangul,romanizeChinese,convertChineseCharacter} from ${JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/renderer/utils.tsx'))}; window.converters={romanize,romanizeHangul,romanizeChinese,convertChineseCharacter};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: 'error',
    json: { namedExports: false, stringify: true },
    resolve: {
      alias: { '@': path.join(root, 'src') },
      conditions: ['browser'],
    },
    plugins: [
      solidPlugin(),
      {
        name: 'converter-test-i18n',
        resolveId(id) {
          if (id === 'virtual:i18n') return '\0converter-test-i18n';
        },
        load(id) {
          if (id === '\0converter-test-i18n') return i18nImporter();
        },
      },
    ],
    build: {
      lib: { entry, formats: ['iife'], name: 'converterFixture' },
      minify: true,
      write: false,
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  const chunks = bundle.output.filter((item) => item.type === 'chunk');
  expect(chunks).toHaveLength(1);
  code = chunks[0].code;
  expect(code).not.toMatch(/\bimport\s*\(/);
  await writeFile(path.join(scratch, 'actual-converters.iife.js'), code);
});
test.afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function fixture() {
  const window = new Window({ url: 'https://music.youtube.com/' });
  const allocations = { maps: 0, fetches: 0 };
  const NativeMap = window.Map;
  window.Map = class extends NativeMap {
    constructor(...args: ConstructorParameters<typeof NativeMap>) {
      super(...args);
      allocations.maps++;
    }
  };
  Object.assign(window, {
    mainConfig: { get: () => undefined, plugins: { getPlugins: () => ({}) } },
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
    fetch: () => {
      allocations.fetches++;
      return Promise.reject(
        new Error('Network prohibited in converter fixture'),
      );
    },
  });
  window.eval(code);
  const converters = (
    window as unknown as {
      converters: Record<
        string,
        (...args: string[]) => string | Promise<string>
      >;
    }
  ).converters;
  return { window, allocations, converters };
}

test('production IIFE keeps disabled/plain paths free of the Pinyin trie and concurrent first requests initialize once', async () => {
  const f = fixture();
  try {
    // The trie currently creates over 9,000 maps. Other helper imports create
    // fewer than 200; use allocation shape rather than a mocked import counter.
    expect(f.allocations.maps).toBeLessThan(200);
    const before = f.allocations.maps;
    expect(await f.converters.romanize('plain text 123')).toBe(
      'plain text 123',
    );
    // Language detection may allocate a small transient map; the dictionary
    // must remain absent, rather than requiring zero unrelated allocations.
    expect(f.allocations.maps - before).toBeLessThan(100);
    expect(f.allocations.maps).toBeLessThan(200);
    const outputs = await Promise.all(
      ['中文', '你好！', '重庆', '音乐'].map((input) =>
        f.converters.romanizeChinese(input),
      ),
    );
    expect(outputs).toEqual(['zhōng wén', 'nǐ hǎo！', 'chóng qìng', 'yīn yuè']);
    const firstUse = f.allocations.maps - before;
    expect(firstUse).toBeGreaterThan(1_000);
    expect(firstUse).toBeLessThan(10_000);
    const initialized = f.allocations.maps;
    await Promise.all(
      ['中文', '你好！', '重庆', '音乐'].map((input) =>
        f.converters.romanizeChinese(input),
      ),
    );
    expect(f.allocations.maps - initialized).toBeLessThan(100);
    expect(f.allocations.fetches).toBe(0);
    expect(f.window.document.body.textContent).toBe('');
  } finally {
    await f.window.happyDOM.close();
  }
});

test('sixteen real conversions preserve synchronous Korean/Hanja and async Chinese fallback behavior', async () => {
  const f = fixture();
  try {
    const cases = [
      ['romanizeHangul', '한글', 'hangeul'],
      ['romanizeHangul', '大韓民國', 'daehanminguk'],
      ['romanizeHangul', '女子 大學', 'yeoja daehak'],
      ['romanizeHangul', '대韓民國!', 'daehanminguk!'],
      ['romanizeHangul', '가나다', 'ganada'],
      ['romanizeChinese', '中文', 'zhōng wén'],
      ['romanizeChinese', '你好！', 'nǐ hǎo！'],
      ['romanizeChinese', '重庆', 'chóng qìng'],
      ['romanizeChinese', '音乐', 'yīn yuè'],
      ['romanizeChinese', 'English 中文 123', 'English zhōng wén 123'],
      ['romanize', '한글', 'hangeul'],
      ['romanize', '中文', 'zhōng wén'],
      ['romanize', 'English 你好 123', 'English nǐ hǎo 123'],
      ['romanize', 'plain text 123', 'plain text 123'],
    ];
    expect(typeof f.converters.romanizeHangul('한글')).toBe('string');
    for (const [fn, input, expected] of cases)
      expect(await f.converters[fn](input)).toBe(expected);
    expect(
      f.converters.convertChineseCharacter(
        '简体中文',
        'simplifiedToTraditional',
      ),
    ).toBe('簡體中文');
    expect(
      f.converters.convertChineseCharacter(
        '繁體中文',
        'traditionalToSimplified',
      ),
    ).toBe('繁体中文');
    expect(f.allocations.fetches).toBe(0);
  } finally {
    await f.window.happyDOM.close();
  }
});
