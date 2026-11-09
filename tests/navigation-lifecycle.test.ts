import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { build } from 'vite';
import solid from 'vite-plugin-solid';

// The actual navigation TSX and actual browser Solid runtime own the DOM/root.
// Icon/wrapper boundaries carry probes for owner cleanup and a live listener.
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-navigation-'));
  const dom = new Window();
  dom.document.body.innerHTML =
    '<div id="right-content"><span id="unrelated">Native</span></div>';
  const globals = globalThis as any;
  const saved = new Map(
    ['window', 'document', 'Node', 'HTMLElement', 'history'].map((key) => [
      key,
      globals[key],
    ]),
  );
  Object.assign(globals, {
    window: dom,
    document: dom.document,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    history: { back() {}, forward() {} },
  });
  const root = path.resolve(import.meta.dirname, '..');
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `export {default as plugin} from ${JSON.stringify(path.join(root, 'src/plugins/navigation/index.tsx'))};export {probe,pulse} from '@/solit';`,
  );
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        solid(),
        {
          name: 'navigation-native-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (
              ['@/i18n', '@/utils', '@/solit'].includes(id) ||
              id.startsWith('@mdui/icons/')
            )
              return '\0' + id;
            return undefined;
          },
          load(id) {
            if (id === '\0@/i18n') return 'export const t=key=>key;';
            if (id === '\0@/utils')
              return 'export const createPlugin=value=>value;';
            if (id.startsWith('\0@mdui/icons/'))
              return 'export const IconChevronLeft=class {};export const IconChevronRight=class {};';
            if (id === '\0@/solit')
              return `
import {createSignal,createEffect,onCleanup} from 'solid-js';
const [value,setValue]=createSignal(0);export const pulse=()=>setValue(v=>v+1);
export const probe={live:0,disposed:0,effects:0,events:0};
export const LitElementWrapper=()=>{const node=document.createElement('span');probe.live++;
const listener=()=>probe.events++;window.addEventListener('owner-probe',listener);
createEffect(()=>{node.textContent=String(value());probe.effects++});
onCleanup(()=>{probe.live--;probe.disposed++;window.removeEventListener('owner-probe',listener)});return node;};`;
            return undefined;
          },
        },
      ],
      resolve: { conditions: ['browser'] },
      build: {
        write: true,
        minify: false,
        lib: { entry, formats: ['cjs'], fileName: () => 'actual.cjs' },
        outDir: directory,
        emptyOutDir: false,
      },
    });
    const source = createRequire(import.meta.url)(
      path.join(directory, 'actual.cjs'),
    );
    return {
      dom,
      ...source,
      close: async () => {
        source.plugin.renderer.stop();
        for (const [key, value] of saved) {
          if (value === undefined) delete globals[key];
          else globals[key] = value;
        }
        await dom.happyDOM.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
    await dom.happyDOM.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('repeated navigation toggles dispose Solid owners and detach their listeners', async () => {
  const f = await fixture();
  try {
    const renderer = f.plugin.renderer;
    for (let cycle = 0; cycle < 20; cycle++) {
      await renderer.start({
        getConfig: () => ({ enabled: true, swipeNavigation: true }),
        ipc: { on() {}, removeAllListeners() {} },
      });
      expect(f.dom.document.querySelectorAll('mdui-button-icon')).toHaveLength(
        2,
      );
      expect(f.probe.live).toBe(2);
      const beforePulse = f.probe.effects;
      f.pulse();
      expect(f.probe.effects - beforePulse).toBe(2);
      const beforeEvent = f.probe.events;
      f.dom.dispatchEvent(new f.dom.Event('owner-probe'));
      expect(f.probe.events - beforeEvent).toBe(2);
      renderer.stop();
      renderer.stop();
      expect(f.probe.live).toBe(0);
      expect(f.probe.disposed).toBe((cycle + 1) * 2);
      expect(f.dom.document.querySelectorAll('mdui-button-icon')).toHaveLength(
        0,
      );
      const stoppedEffects = f.probe.effects;
      const stoppedEvents = f.probe.events;
      f.pulse();
      f.dom.dispatchEvent(new f.dom.Event('owner-probe'));
      expect(f.probe.effects).toBe(stoppedEffects);
      expect(f.probe.events).toBe(stoppedEvents);
      expect(f.dom.document.querySelector('#unrelated')?.textContent).toBe(
        'Native',
      );
    }
  } finally {
    await f.close();
  }
});

test('native browser commands forward only history intents and release old windows', async () => {
  const f = await fixture();
  const window = new EventEmitter() as any;
  window.isDestroyed = () => false;
  window.webContents = { isDestroyed: () => false };
  const sent: unknown[][] = [];
  const context = {
    window,
    ipc: { send: (...args: unknown[]) => sent.push(args) },
  };
  try {
    f.plugin.backend?.start(context);
    window.emit('app-command', {}, 'browser-backward');
    window.emit('app-command', {}, 'browser-forward');
    window.emit('app-command', {}, 'media-play-pause');
    expect(sent).toEqual([
      ['navigation-history-command', 'back'],
      ['navigation-history-command', 'forward'],
    ]);
    f.plugin.backend?.start(context);
    window.emit('app-command', {}, 'browser-backward');
    expect(sent).toHaveLength(3);
    window.emit('closed');
    window.emit('app-command', {}, 'browser-backward');
    expect(sent).toHaveLength(3);
    f.plugin.backend?.stop();
    f.plugin.backend?.stop();
    expect(window.listenerCount('app-command')).toBe(0);
    expect(window.listenerCount('closed')).toBe(0);
  } finally {
    f.plugin.backend?.stop();
    await f.close();
  }
});

test('a failed settings read leaves no navigation controls or Solid owners behind', async () => {
  const f = await fixture();
  try {
    await expect(
      f.plugin.renderer.start({
        getConfig: async () => {
          throw new Error('Settings unavailable');
        },
        ipc: { on() {}, removeAllListeners() {} },
      }),
    ).rejects.toThrow('Settings unavailable');
    expect(f.dom.document.querySelectorAll('mdui-button-icon')).toHaveLength(0);
    expect(f.probe.live).toBe(0);
  } finally {
    await f.close();
  }
});
