import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { test } from '@playwright/test';
import { Project, ts, VariableDeclarationKind } from 'ts-morph';
import { build, normalizePath, transformWithOxc } from 'vite';

type Mode = 'backend' | 'preload' | 'none' | 'renderer';
type ContextLoader = (mode: Mode) => {
  load: { handler: (id: string) => { code: string } };
};
const root = fileURLToPath(new URL('..', import.meta.url));
const rawEntry = join(root, 'src/plugins/visualizer/index.ts');
const entry = normalizePath(rawEntry);
const loaderPath = join(root, 'vite-plugins/plugin-loader.mts');
const marker = 'SYNTHETIC_VISUALIZER_BROWSER_BOUNDARY';
const stubs: Record<string, string> = {
  '@/i18n': 'export const t=x=>x;',
  '@/utils': 'export const createPlugin=x=>x;',
  '@/providers/renderer-audio': 'export const getCurrentAudioGraph=()=>null;',
  './empty-player.css?inline': 'export default "";',
  './visualizers': `globalThis.${marker}=window; export class ButterchurnVisualizer{};export class VudioVisualizer{};export class WaveVisualizer{};`,
  './visualizers/visualizer': 'export class Visualizer{};',
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function createClosedCompilerPlugin(
  rawEntry: string,
  entry: string,
  transformed: string,
  seen: string[],
) {
  return {
    name: 'closed-visualizer-context-boundary',
    enforce: 'pre' as const,
    resolveId(id: string) {
      seen.push(id);
      if (id === rawEntry || id === entry) return entry;
      if (Object.hasOwn(stubs, id)) return '\0stub:' + id;
      if (id === 'node:module') return { id, external: true };
      throw new Error('Unexpected compiler dependency: ' + id);
    },
    load(id: string) {
      if (id === rawEntry || id === entry) return transformed;
      if (id.startsWith('\0stub:') && Object.hasOwn(stubs, id.slice(6)))
        return stubs[id.slice(6)];
      throw new Error('Unexpected compiler module: ' + id);
    },
  };
}

function contextSource(mode: Mode, source: string): string {
  const loaderSource = stripTypeScriptTypes(
    readFileSync(loaderPath, 'utf8').replaceAll(
      'import.meta.url',
      JSON.stringify(pathToFileURL(loaderPath).href),
    ),
    { mode: 'transform' },
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/export default function\s*\(/, 'function pluginLoader(');
  assert(loaderSource.includes('function pluginLoader('));
  // Execute the actual context loader, never a copied model of its AST rules.
  const loader = vm.runInNewContext(
    loaderSource + '\npluginLoader',
    {
      readFileSync: (id: string, encoding: string) => {
        assert.equal(id, entry);
        assert.equal(encoding, 'utf8');
        return source;
      },
      resolve,
      basename,
      dirname,
      fileURLToPath,
      Project,
      ts,
      VariableDeclarationKind,
    },
    { timeout: 5000 },
  ) as ContextLoader;
  return loader(mode).load.handler(entry).code;
}

for (const mode of ['backend', 'preload', 'none', 'renderer'] as const) {
  test(`visualizer ${mode} compiler context owns its browser value imports`, async () => {
    const testInfo = test.info();
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'pear-visualizer-context-'));
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      const source = readFileSync(entry, 'utf8');
      const transformed = contextSource(mode, source);
      // Actual installed Vite/Oxc uses this production filename's real tsconfig
      // and its existing extends chain, including TypeScript import elision.
      const lowered = await transformWithOxc(transformed, entry, {
        lang: 'ts',
      });
      const visualizersImport = /from\s*["']\.\/visualizers["']/.test(
        lowered.code,
      );
      const audioProviderImport =
        /from\s*["']@\/providers\/renderer-audio["']/.test(lowered.code);
      const seen: string[] = [];
      // The compiler root is freshly owned and credential-free. All bundle
      // dependencies are a closed set of inert stubs plus one browser sentinel.
      const built = await build({
        root: fixtureRoot,
        publicDir: false,
        configFile: false,
        cacheDir: join(fixtureRoot, 'cache'),
        logLevel: 'silent',
        plugins: [
          createClosedCompilerPlugin(rawEntry, entry, transformed, seen),
        ],
        build: {
          lib: { entry, formats: ['es'], fileName: 'context' },
          write: false,
          minify: false,
          emptyOutDir: false,
          outDir: join(fixtureRoot, 'unwritten'),
        },
      });
      const outputs = (Array.isArray(built) ? built : [built])
        .flatMap((result) => {
          assert('output' in result);
          return result.output;
        })
        .filter((output) => output.type === 'chunk');
      assert.equal(outputs.length, 1);
      const bundle = outputs[0].code;
      const browserRetained = bundle.includes(marker);
      const cjs = ts.transpileModule(bundle, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const windowSentinel = { ownedSyntheticWindow: true };
      const sandbox: Record<string, unknown> = { exports: {} };
      if (mode === 'renderer') sandbox.window = windowSentinel;
      let vmError: { name: string; message: string } | null = null;
      try {
        vm.runInNewContext(cjs, sandbox, { timeout: 1000 });
      } catch (error) {
        vmError = {
          name:
            error &&
            typeof error === 'object' &&
            'name' in error &&
            typeof error.name === 'string'
              ? error.name
              : 'UNKNOWN',
          message:
            error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
              ? error.message
              : 'UNKNOWN',
        };
      }
      await testInfo.attach('pipeline.json', {
        body: JSON.stringify(
          {
            mode,
            sourceSha256: sha(source),
            contextSha256: sha(transformed),
            loweredSha256: sha(lowered.code),
            bundleSha256: sha(bundle),
            visualizersImport,
            audioProviderImport,
            browserRetained,
            vmError,
            seen,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      for (const [name, body] of [
        ['context.ts', transformed],
        ['lowered.js', lowered.code],
        ['bundle.mjs', bundle],
      ]) {
        await testInfo.attach(name, { body, contentType: 'text/plain' });
      }
      const renderer = mode === 'renderer';
      assert.equal(
        visualizersImport,
        renderer,
        'Actual TS lowering must elide visualizer values outside renderer',
      );
      assert.equal(
        audioProviderImport,
        renderer,
        'Actual TS lowering must elide renderer provider outside renderer',
      );
      assert.equal(
        browserRetained,
        renderer,
        'Closed bundle must preserve browser effects only for renderer',
      );
      assert.equal(
        vmError,
        null,
        'Context data VM must evaluate safely with only its owned window sentinel',
      );
      if (renderer)
        assert.equal(
          sandbox[marker],
          windowSentinel,
          'Renderer positive control executes the browser dependency',
        );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
}

test('closed compiler handlers accept only exact raw and canonical Windows entry IDs', () => {
  const raw = String.raw`D:\a\pear-desktop\pear-desktop\src\plugins\visualizer\index.ts`;
  const canonical =
    'D:/a/pear-desktop/pear-desktop/src/plugins/visualizer/index.ts';
  const transformed = 'OWNED_TRANSFORMED_ENTRY_DATA';
  const seen: string[] = [];
  // These are data inputs to the same handlers used by the actual compiler
  // pipeline above. No synthetic Windows file is opened or compiled.
  const plugin = createClosedCompilerPlugin(raw, canonical, transformed, seen);
  const attempt = (call: () => unknown) => {
    try {
      return { ok: true, value: call() };
    } catch {
      return { ok: false };
    }
  };
  const actual = [raw, canonical].map((id) => ({
    id,
    resolved: attempt(() => plugin.resolveId(id)),
    loaded: attempt(() => plugin.load(id)),
  }));
  assert.deepEqual(
    actual,
    [raw, canonical].map((id) => ({
      id,
      resolved: { ok: true, value: canonical },
      loaded: { ok: true, value: transformed },
    })),
    'Both actual handlers must admit the two exact entry spellings',
  );
  for (const [id, body] of Object.entries(stubs)) {
    assert.equal(plugin.resolveId(id), '\0stub:' + id);
    assert.equal(plugin.load('\0stub:' + id), body);
  }
  assert.deepEqual(plugin.resolveId('node:module'), {
    id: 'node:module',
    external: true,
  });
  const unknown = [
    raw.replace('visualizer\\index.ts', 'visualizer-other\\index.ts'),
    canonical.replace('/visualizer/', '/visualizer-other/'),
    'src/plugins/visualizer/index.ts',
    './src/plugins/visualizer/index.ts',
    raw + '?v=1',
    canonical + '?v=1',
    raw + '.backup',
    canonical + '.backup',
    canonical + '/child',
    'D:/unrelated/index.ts',
    '@/unknown',
    '\0stub:unknown',
  ];
  for (const id of unknown) {
    assert.throws(() => plugin.resolveId(id), /Unexpected compiler dependency/);
    assert.throws(() => plugin.load(id), /Unexpected compiler module/);
  }
  assert.throws(() => plugin.load('node:module'), /Unexpected compiler module/);
  assert.equal(
    seen[0],
    raw,
    'Resolver observations retain the original requested ID',
  );
});
