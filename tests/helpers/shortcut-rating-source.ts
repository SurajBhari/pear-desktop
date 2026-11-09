import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, normalizePath, transformWithOxc } from 'vite';

const root = normalizePath(
  process.env.PEAR_SHORTCUT_SOURCE_ROOT ??
    path.resolve(import.meta.dirname, '../..'),
);
const equivalent = (value: string) =>
  value
    .toLowerCase()
    .replace(
      /commandorcontrol|cmdorctrl/g,
      process.platform === 'darwin' ? 'command' : 'control',
    )
    .replace(/\bcmd\b/g, 'command')
    .replace(/\bctrl\b/g, 'control');

export async function shortcutRatingSource() {
  const directory = await mkdtemp(path.join(tmpdir(), 'shortcut-source-'));
  const key = 'shortcut_' + crypto.randomUUID();
  const sent: any[] = [],
    warnings: any[] = [],
    writes: any[] = [];
  const global = new Map<string, () => void>(),
    local = new Map<string, () => void>();
  const callbacks = new Set<any>();
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: (...args: any[]) => sent.push(args),
  });
  let visible = true,
    minimized = false;
  const effects: string[] = [];
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    restore: () => {
      effects.push('restore');
      minimized = false;
    },
    show: () => {
      effects.push('show');
      visible = true;
    },
    focus: () => effects.push('focus'),
  });
  const provider = await readFile(
    path.join(root, 'src/providers/song-info.ts'),
    'utf8',
  );
  const enumCode = (
    await transformWithOxc(
      provider.match(/export enum MediaType \{[\s\S]*?\n\}/)![0],
      'media.ts',
    )
  ).code;
  const { MediaType } = await import(
    'data:text/javascript;base64,' + Buffer.from(enumCode).toString('base64')
  );
  const state: any = {
    window,
    contents,
    sent,
    warnings,
    writes,
    global,
    local,
    callbacks,
    MediaType,
    ipcMain: new EventEmitter(),
    warn: (...args: any[]) => warnings.push(args),
    current: { mediaType: MediaType.Audio },
    prompt: async () => null,
    registerHook: undefined,
    unregisterHook: undefined,
    isRegisteredHook: undefined,
    nativeRegister: (accelerator: string, invoke: () => void) => {
      state.registerHook?.(accelerator);
      if (accelerator === 'invalid') throw Error('Invalid accelerator');
      if (
        [...global.keys()].some(
          (value) => equivalent(value) === equivalent(accelerator),
        )
      )
        return false;
      global.set(accelerator, invoke);
      return true;
    },
    nativeUnregister: (accelerator: string) => {
      state.unregisterHook?.(accelerator);
      for (const value of global.keys())
        if (equivalent(value) === equivalent(accelerator)) global.delete(value);
    },
    nativeRegistered: (accelerator: string) => {
      state.isRegisteredHook?.(accelerator);
      return [...global.keys()].some(
        (value) => equivalent(value) === equivalent(accelerator),
      );
    },
  };
  (globalThis as any)[key] = state;
  const entry = path.join(directory, 'entry.ts');
  const exports = [
    `export {backend} from ${JSON.stringify(root + '/src/plugins/shortcuts/main.ts')};`,
    `export {onMenu} from ${JSON.stringify(root + '/src/plugins/shortcuts/menu.ts')};`,
    `export {default as shortcuts} from ${JSON.stringify(root + '/src/plugins/shortcuts/index.ts')};`,
    `export {default as precise} from ${JSON.stringify(root + '/src/plugins/precise-volume/index.ts')};`,
    `export {default as playbackSpeed} from ${JSON.stringify(root + '/src/plugins/playback-speed/index.ts')};`,
  ];
  if (existsSync(root + '/src/utils/global-shortcut-owner.ts'))
    exports.push(
      `export * from ${JSON.stringify(root + '/src/utils/global-shortcut-owner.ts')};`,
    );
  if (existsSync(root + '/src/plugins/shortcuts/play-pause-gesture.ts'))
    exports.push(
      `export * from ${JSON.stringify(root + '/src/plugins/shortcuts/play-pause-gesture.ts')};`,
    );
  await writeFile(entry, exports.join('\n'));
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      plugins: [
        {
          name: 'shortcut-public-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            if (
              [
                'electron',
                'electron-is',
                'electron-localshortcut',
                '@/utils',
                '@/i18n',
                '@/providers/song-info',
                '@/providers/prompt-options',
                'custom-electron-prompt',
              ].includes(id)
            )
              return '\0shortcut:' + id;
            if (id === './mpris') return '\0shortcut:mpris';
            if (
              importer &&
              normalizePath(importer).endsWith('/playback-speed/index.ts') &&
              id === './renderer'
            )
              return '\0shortcut:speed-renderer';
            if (
              importer &&
              normalizePath(importer).endsWith('/precise-volume/index.ts') &&
              ['./renderer', './override'].includes(id)
            )
              return '\0shortcut:volume-renderer';
            if (id.startsWith('@/'))
              return normalizePath(path.join(root, 'src', id.slice(2)) + '.ts');
          },
          load(id) {
            const b = `const b=globalThis[${JSON.stringify(key)}];`;
            if (id === '\0shortcut:electron')
              return (
                b +
                'export const ipcMain=b.ipcMain;export const BrowserWindow=class {};export const globalShortcut={register:(...a)=>b.nativeRegister(...a),unregister:(...a)=>b.nativeUnregister(...a),isRegistered:(...a)=>b.nativeRegistered(...a)};'
              );
            if (id === '\0shortcut:electron-is')
              return 'export default {linux:()=>false};';
            if (id === '\0shortcut:electron-localshortcut')
              return (
                b +
                'export const isRegistered=(w,k)=>{b.localRegisteredHook?.(k);return b.local.has(k)},register=(w,k,f)=>{b.localRegisterHook?.(k);b.local.set(k,f)},unregister=(w,k)=>{b.localUnregisterHook?.(k);b.local.delete(k)};'
              );
            if (id === '\0shortcut:@/utils')
              return 'export const createBackend=v=>v,createPlugin=v=>v;';
            if (id === '\0shortcut:@/i18n') return 'export const t=k=>k;';
            if (id === '\0shortcut:@/providers/song-info')
              return (
                b +
                'export const MediaType=b.MediaType;export const registerCallback=(f,o)=>{b.callbacks.add(f);if(o?.replayCurrent)f(b.current);return()=>b.callbacks.delete(f)};'
              );
            if (id === '\0shortcut:custom-electron-prompt')
              return b + 'export default (...a)=>b.prompt(...a);';
            if (id === '\0shortcut:@/providers/prompt-options')
              return 'export default ()=>({});';
            if (id === '\0shortcut:mpris')
              return 'export const registerMPRIS=()=>{};';
            if (id === '\0shortcut:volume-renderer')
              return 'export const onConfigChange=()=>{},onPlayerApiReady=()=>{},overrideListener=()=>{},stop=()=>{};';
            if (id === '\0shortcut:speed-renderer')
              return 'export const onConfigChange=()=>{},onPlayerApiReady=()=>{},onUnload=()=>{};';
          },
          transform(source, id) {
            if (normalizePath(id).startsWith(root + '/src/'))
              return source.replaceAll(
                'console.warn(',
                `globalThis[${JSON.stringify(key)}].warn(`,
              );
          },
          generateBundle() {
            const owner = root + '/src/utils/global-shortcut-owner.ts';
            if (
              existsSync(owner) &&
              [...this.getModuleIds()].filter(
                (id) => normalizePath(id) === owner,
              ).length !== 1
            )
              this.error('Shortcut owner must have one shared module identity');
          },
        },
      ],
      build: {
        ssr: normalizePath(entry),
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'bundle.mjs' } },
      },
    });
    const source = await import(
      pathToFileURL(path.join(directory, 'bundle.mjs')).href
    );
    let config: any = {
      ...source.shortcuts.config,
      enabled: true,
      global: { ...source.shortcuts.config.global },
      local: { ...source.shortcuts.config.local },
    };
    const context: any = {
      window,
      getConfig: () => config,
      setConfig: (patch: any) => {
        writes.push(patch);
        config = { ...config, ...patch };
      },
      ipc: { send: (...args: any[]) => contents.send(...args) },
    };
    return {
      source,
      state,
      context,
      window,
      contents,
      sent,
      warnings,
      writes,
      effects,
      get config() {
        return config;
      },
      set config(value: any) {
        config = value;
      },
      hidden() {
        visible = false;
        minimized = true;
      },
      input(type: string, extra: any = {}) {
        contents.emit(
          'before-input-event',
          {},
          { type, code: 'KeyP', isAutoRepeat: false, ...extra },
        );
      },
      async close() {
        source.backend.stop();
        source.precise.backend?.stop?.();
        source.playbackSpeed.backend?.stop?.();
        delete (globalThis as any)[key];
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    delete (globalThis as any)[key];
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
