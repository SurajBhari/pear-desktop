/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { build } from 'vite';

import {
  playerActionsElectronBoundary,
  playerActionsFixture,
} from './helpers/player-actions-fixture';

function evaluateBoundaryModule(code: string, imports: string[]) {
  const module = { exports: {} as any };
  new Script(code).runInNewContext(
    {
      module,
      exports: module.exports,
      require: (id: unknown) => {
        imports.push(id === 'electron' ? 'electron' : 'other');
        throw new Error('OWNED_BOUNDARY_PROBE_MODULE_IMPORT_REFUSED');
      },
    },
    { timeout: 1000 },
  );
  return module.exports;
}

async function compileBoundaryProbe(code: string, imports: string[]) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-player-actions-boundary-'),
  );
  try {
    const entry = path.join(directory, 'entry.ts');
    await writeFile(entry, code);
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [playerActionsElectronBoundary(directory)],
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ['cjs'], fileName: () => 'probe.cjs' },
      },
    });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap(
      (output: any) => output.output ?? [],
    );
    const chunk = chunks.find((output: any) => output.type === 'chunk');
    if (!chunk) throw new Error('Owned boundary probe emitted no chunk');
    return evaluateBoundaryModule(chunk.code, imports);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('synchronous output guard allocation failure retires wet and a genuine later engagement retries', async () => {
  const globals = globalThis as any;
  const saved = new Map(
    [
      'window',
      'document',
      'Node',
      'Element',
      'HTMLElement',
      'HTMLVideoElement',
      'MutationObserver',
      'CustomEvent',
      'Event',
      'AudioWorkletNode',
    ].map((name) => [name, Object.getOwnPropertyDescriptor(globals, name)]),
  );
  const f = await playerActionsFixture({
    onConstructionFailure: async ({ dom, directory, key }) => {
      expect(dom.closed).toBe(true);
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(globals[key]).toBeUndefined();
      for (const [name, descriptor] of saved)
        expect(Object.getOwnPropertyDescriptor(globals, name)).toEqual(
          descriptor,
        );
      console.log(
        JSON.stringify({
          kind: 'OWNED_PLAYER_ACTIONS_CONSTRUCTION_CLEANUP',
          domClosed: dom.closed,
          temporaryDirectoryAbsent: true,
          fixtureClockRemoved: true,
          globalDescriptorsRestored: true,
        }),
      );
    },
  });
  try {
    const graph = f.graph('guard-allocation'),
      create = graph.audioContext.createWaveShaper;
    graph.audioContext.createWaveShaper = () => {
      throw Error('owned guard allocation failure');
    };
    f.announce(graph);
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 0.85, reverbIntensity: 1 },
      }),
      setConfig: async () => {},
    });
    await f.settle();
    expect(r.slowedReverb.workletFailed).toBe(true);
    expect(r.slowedReverb.wetGain).toBeNull();
    expect(r.slowedReverb.wetOutput).toBeNull();
    expect(f.media.playbackRate).toBe(0.85);
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
    r.onConfigChange({
      ...r.getCurrent(),
      slowedReverb: { ...r.getCurrent().slowedReverb, reverbIntensity: 0 },
    });
    graph.audioContext.createWaveShaper = create;
    r.onConfigChange({
      ...r.getCurrent(),
      slowedReverb: { ...r.getCurrent().slowedReverb, reverbIntensity: 1 },
    });
    await f.settle();
    expect(f.loads.length).toBe(1);
    f.loads[0].resolve();
    await f.settle();
    expect(r.slowedReverb.workletFailed).toBe(false);
    expect(r.slowedReverb.reverbNode).not.toBeNull();
    expect(r.slowedReverb.wetGain.connections).toEqual(
      new Set([graph.audioGraph.masterInput]),
    );
  } finally {
    await f.close();
    for (const [name, descriptor] of saved)
      expect(Object.getOwnPropertyDescriptor(globals, name)).toEqual(
        descriptor,
      );
  }
});

test('fixture Electron export is exact and shortcut methods refuse every invocation without module delegates', async () => {
  const calibration: string[] = [];
  expect(() =>
    evaluateBoundaryModule(
      'module.exports = require("electron");',
      calibration,
    ),
  ).toThrow('OWNED_BOUNDARY_PROBE_MODULE_IMPORT_REFUSED');
  expect(calibration).toEqual(['electron']);
  const imports: string[] = [];
  const actual = await compileBoundaryProbe(
    "import {globalShortcut} from 'electron'; export {globalShortcut};",
    imports,
  );
  expect(imports).toEqual([]);
  expect(Object.keys(actual)).toEqual(['globalShortcut']);
  const methods = [
    'register',
    'registerAll',
    'unregister',
    'unregisterAll',
    'isRegistered',
  ];
  expect(Object.keys(actual.globalShortcut).sort()).toEqual(
    [...methods].sort(),
  );
  for (const method of methods) {
    expect(typeof actual.globalShortcut[method]).toBe('function');
    for (const attempt of [1, 2]) {
      let failure: any;
      try {
        actual.globalShortcut[method]('owned argument is never retained');
      } catch (error) {
        failure = error;
      }
      expect(failure?.message).toBe(
        'OWNED_PLAYER_ACTIONS_SHORTCUT_INVOCATION_REFUSED',
      );
      expect(Object.keys(failure).sort()).toEqual(['attempt', 'method']);
      expect(failure.method).toBe(method);
      expect(failure.attempt).toBe(attempt);
    }
  }
  expect(imports).toEqual([]);
});

test('fixture AST boundary refuses unexpected Electron surfaces before generated module evaluation', async () => {
  const forbidden = [
    "import {app} from 'electron'; export {app};",
    "import electron from 'electron'; export {electron};",
    "import * as electron from 'electron'; export const value=electron.missing;",
    "export const load=()=>import('electron');",
    "const target='electron'; export const load=()=>import(target);",
    "import {globalShortcut} from 'electron/main'; export {globalShortcut};",
    `import {globalShortcut} from ${JSON.stringify(path.resolve(import.meta.dirname, '../node_modules/electron/index.js'))}; export {globalShortcut};`,
    "export {globalShortcut} from 'electron';",
    "export const load=()=>require('electron');",
  ];
  for (const source of forbidden) {
    const imports: string[] = [];
    await expect(compileBoundaryProbe(source, imports)).rejects.toThrow(
      'OWNED_PLAYER_ACTIONS_ELECTRON_SURFACE_REFUSED',
    );
    expect(imports).toEqual([]);
  }
});
