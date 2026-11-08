import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { build } from 'vite';
import solidPlugin from 'vite-plugin-solid';

import { i18nImporter } from '../vite-plugins/i18n-importer.mts';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const components = path
  .join(root, 'src/plugins/synced-lyrics/renderer/components')
  .replaceAll('\\', '/');
const actualUtils = path
  .join(root, 'src/plugins/synced-lyrics/renderer/utils.tsx')
  .replaceAll('\\', '/');
let scratch: string;
let code: string;

test.beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'pear-lyrics-owner-test-'));
  const entry = path.join(scratch, 'entry.tsx');
  await writeFile(
    entry,
    `import {createSignal} from 'solid-js';import {render} from 'solid-js/web';import {PlainLyrics} from ${JSON.stringify(path.join(components, 'PlainLyrics.tsx'))};import {SyncedLine} from ${JSON.stringify(path.join(components, 'SyncedLine.tsx'))};import {setConfig,pending,unhandled} from 'fixture-state';
window.mountLyrics=(kind)=>{const [line,setLine]=createSignal('A');const container=document.createElement('div');document.body.append(container);const dispose=render(()=>kind==='plain'?<PlainLyrics line={line()}/>:<SyncedLine line={{text:line(),time:'00:00',timeInMs:0,duration:1000}} index={0} status="current" scroller={{}}/>,container);return{setLine,setConfig,pending,unhandled,container,dispose};};`,
  );
  const realSolid = requireRoot.resolve('solid-js/dist/solid.js');
  const state = `import {createSignal} from 'solid-js';const [config,setConfig]=createSignal({romanization:true,convertChineseCharacter:'disabled',defaultTextString:'',showTimeCodes:false});export{config,setConfig};export const pending=[],unhandled=[];
export function romanize(input){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});const nativeThen=promise.then.bind(promise);promise.then=(success,failure)=>{const child=nativeThen(success,failure);let applicationHandles=!!failure;const nativeCatch=child.catch.bind(child);child.catch=(handler)=>{applicationHandles=true;return nativeCatch(handler)};nativeCatch(error=>queueMicrotask(()=>{if(!applicationHandles)unhandled.push(String(error))}));return child};pending.push({input,resolve,reject});return promise}`;
  const result = await build({
    root,
    configFile: false,
    logLevel: 'error',
    json: { namedExports: false, stringify: true },
    resolve: {
      alias: [
        { find: /^solid-js$/, replacement: '\0solid-owner-spy' },
        {
          find: /^solid-js\/web$/,
          replacement: requireRoot.resolve('solid-js/web/dist/web.js'),
        },
        { find: '@', replacement: path.join(root, 'src') },
      ],
      conditions: ['browser'],
    },
    plugins: [
      solidPlugin(),
      {
        name: 'actual-solid-conversion-boundaries',
        enforce: 'pre',
        resolveId(id, importer) {
          importer = importer?.replaceAll('\\', '/');
          if (id === 'virtual:i18n') return '\0lyrics-owner-i18n';
          if (id === 'solid-js') return '\0solid-owner-spy';
          if (id === 'solid-js/web')
            return requireRoot.resolve('solid-js/web/dist/web.js');
          if (id === 'fixture-state') return '\0fixture-state';
          if (id === '../renderer' && importer?.startsWith(components))
            return '\0fixture-renderer';
          if (id === '../utils' && importer?.startsWith(components))
            return '\0fixture-utils';
          if (id === '..' && importer?.endsWith('SyncedLine.tsx'))
            return '\0fixture-api';
          if (id === './renderer' && importer === actualUtils)
            return '\0fixture-renderer';
        },
        load(id) {
          if (id === '\0lyrics-owner-i18n') return i18nImporter();
          if (id === '\0solid-owner-spy')
            return `export * from ${JSON.stringify(realSolid)};import{createSignal as original}from ${JSON.stringify(realSolid)};export function createSignal(value,...options){const[read,set]=original(value,...options);if(value!=='')return[read,set];return[read,(next)=>{window.romanizationWrites.push(next);return set(next)}]}`;
          if (id === '\0fixture-state') return state;
          if (id === '\0fixture-renderer')
            return "export{config}from'fixture-state';export const currentTime=()=>0,isPlaying=()=>false,LyricsRenderer=()=>null,setIsVisible=()=>{};";
          if (id === '\0fixture-utils')
            return `export {canonicalize,simplifyUnicode,convertChineseCharacter} from ${JSON.stringify(actualUtils)};export{romanize}from'fixture-state';`;
          if (id === '\0fixture-api') return 'export const _ytAPI=null;';
        },
      },
    ],
    build: {
      lib: { entry, formats: ['iife'], name: 'lyricsOwnerFixture' },
      minify: true,
      write: false,
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  code = bundle.output.find((item) => item.type === 'chunk')!.code;
});
test.afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(kind: string) {
  const window = new Window();
  Object.assign(window, {
    romanizationWrites: [],
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
    fetch: () =>
      Promise.reject(new Error('Network prohibited in lyrics owner fixture')),
  });
  window.eval(code);
  const mounted = (
    window as unknown as { mountLyrics: (kind: string) => any }
  ).mountLyrics(kind);
  const writes = (window as unknown as { romanizationWrites: string[] })
    .romanizationWrites;
  const romaji = () =>
    Array.from(mounted.container.querySelectorAll('.romaji'))
      .flatMap((node: any) => {
        const elements = node.matches('yt-formatted-string')
          ? [node]
          : Array.from(node.querySelectorAll('yt-formatted-string'));
        return elements.flatMap(
          (item: any) => item.text?.runs?.map((run: any) => run.text) ?? [],
        );
      })
      .join('')
      .trim();
  return {
    window,
    mounted,
    writes,
    romaji,
    close: async () => {
      mounted.dispose();
      await window.happyDOM.close();
    },
  };
}

for (const kind of ['plain', 'synced']) {
  test(`${kind}: reversed A/B completion keeps only the newest output`, async () => {
    const f = fixture(kind);
    try {
      expect(f.mounted.pending.map((p: any) => p.input)).toEqual(['A']);
      f.mounted.setLine('B');
      expect(f.mounted.pending.map((p: any) => p.input)).toEqual(['A', 'B']);
      f.mounted.pending[1].resolve('Roman-B');
      await settle();
      expect(f.romaji()).toBe('Roman-B');
      f.mounted.pending[0].resolve('Roman-A');
      await settle();
      expect(f.romaji()).toBe('Roman-B');
      expect(f.writes).toEqual(['Roman-B']);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: an old failure cannot overwrite a newer success or escape handling`, async () => {
    const f = fixture(kind);
    try {
      f.mounted.setLine('B');
      f.mounted.pending[1].resolve('Roman-B');
      await settle();
      f.mounted.pending[0].reject(new Error('obsolete A'));
      await settle();
      expect(f.romaji()).toBe('Roman-B');
      expect(f.writes).toEqual(['Roman-B']);
      expect(f.mounted.unhandled).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: disabling invalidates pending output and reenabling captures current input`, async () => {
    const f = fixture(kind);
    try {
      f.mounted.setConfig((c: any) => ({ ...c, romanization: false }));
      f.mounted.setLine('B');
      f.mounted.pending[0].resolve('Roman-A');
      await settle();
      expect(f.writes).toEqual([]);
      expect(f.romaji()).toBe('');
      f.mounted.setConfig((c: any) => ({ ...c, romanization: true }));
      expect(f.mounted.pending.at(-1).input).toBe('B');
      f.mounted.pending.at(-1).resolve('Roman-B');
      await settle();
      expect(f.romaji()).toBe('Roman-B');
    } finally {
      await f.close();
    }
  });
  test(`${kind}: disposed owners never publish pending conversions`, async () => {
    const f = fixture(kind);
    try {
      f.mounted.dispose();
      f.mounted.pending[0].resolve('Roman-A');
      await settle();
      expect(f.writes).toEqual([]);
      expect(f.mounted.container.childElementCount).toBe(0);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: current failure removes stale annotation and leaves plain text without unhandled rejection`, async () => {
    const f = fixture(kind);
    try {
      f.mounted.pending[0].resolve('Roman-A');
      await settle();
      f.mounted.setLine('B');
      f.mounted.pending[1].reject(new Error('current B'));
      await settle();
      expect(f.romaji()).toBe('');
      expect(f.writes.at(-1)).toBe('B');
      expect(f.mounted.unhandled).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test(`${kind}: Chinese conversion config remains tracked before asynchronous work`, async () => {
    const f = fixture(kind);
    try {
      f.mounted.setLine('简体中文');
      f.mounted.setConfig((c: any) => ({
        ...c,
        convertChineseCharacter: 'simplifiedToTraditional',
      }));
      expect(f.mounted.pending.at(-1).input).toBe('簡體中文');
      f.mounted.pending.at(-1).resolve('latest');
      await settle();
      f.mounted.pending[1].resolve('obsolete');
      await settle();
      expect(f.romaji()).toBe('latest');
      expect(f.writes).toEqual(['latest']);
    } finally {
      await f.close();
    }
  });
}
