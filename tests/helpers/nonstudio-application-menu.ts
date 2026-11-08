import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import pluginLoader from '../../vite-plugins/plugin-loader.mts';
import { pluginVirtualModuleGenerator } from '../../vite-plugins/plugin-importer.mts';

const root = path.resolve(import.meta.dirname, '../..');

/** Actual generated stubs, config wrappers, menu loader/publication and in-app serialization. */
export async function nonstudioApplicationMenuFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-nonstudio-menu-'));
  const entry = path.join(directory, 'entry.ts');
  const absolute = (file: string) => JSON.stringify(path.join(root, file));
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(
    entry,
    `export * from '@/menu';export * from 'owned-state';export * as config from '@/config';export {allPlugins} from 'virtual:plugins';export {forceLoadMenuPlugin,getAllMenuTemplate} from ${absolute('src/loader/menu.ts')};import {onMainLoad} from ${absolute('src/plugins/in-app-menu/main.ts')};import {window,state} from 'owned-state';onMainLoad({window,ipc:{handle:(name,fn)=>state.ipc[name]=fn,send:(...args)=>state.sends.push(args)}});`,
  );
  const generated = pluginVirtualModuleGenerator('main');
  const state = `import {EventEmitter} from 'node:events';
export const state={menus:[],sends:[],writes:[],menuLoads:{},ipc:{},nativeIpc:{},destroyed:false,webDestroyed:false,nativeWindows:0,lifecycleStarts:0,failWrites:false,beforeBuild:undefined,afterPublish:undefined};
export const data={options:{language:'en',themes:[],restartOnConfigChanges:false},plugins:{'in-app-menu':{enabled:true},'skip-live-songs':{enabled:false,categories:{live:false,future:{preserved:true}}}}};
export const store={get:key=>key.split('.').reduce((value,part)=>value?.[part],data),set:(key,value)=>{if(state.failWrites)throw Error('Owned write failure');const parts=key.split('.');let target=data;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=value;state.writes.push({key,value:structuredClone(value)});},onDidAnyChange:()=>()=>{}};
export const window=Object.assign(new EventEmitter(),{isDestroyed:()=>state.destroyed,isMaximized:()=>false,webContents:Object.assign(new EventEmitter(),{isDestroyed:()=>state.webDestroyed,navigationHistory:{},send:(...args)=>{if(state.destroyed||state.webDestroyed)throw Error('Send to destroyed window');state.sends.push(args);}})});
let command=0;export let applicationMenu;
const createMenu=rows=>{const menu={items:[]};menu.items=rows.map(row=>{const item={...row,commandId:++command,menu};if(Array.isArray(row.submenu))item.submenu=createMenu(row.submenu);item.click=(clicked,...args)=>{if(item.type==='checkbox'&&!clicked)item.checked=!item.checked;return row.click?.(clicked??item,...args);};return item;});return menu;};
export const Menu={buildFromTemplate:rows=>{const hook=state.beforeBuild;state.beforeBuild=undefined;hook?.();return createMenu(rows);},setApplicationMenu:menu=>{applicationMenu=menu;state.menus.push(menu);const hook=state.afterPublish;state.afterPublish=undefined;hook?.();},getApplicationMenu:()=>applicationMenu};
`;
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'owned-nonstudio-menu-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            const virtual: Record<string, string> = {
              'owned-state': '\0state',
              'virtual:plugins': '\0plugins',
              'virtual:i18n': '\0languages',
              electron: '\0electron',
              'electron-is': '\0is',
              'electron-localshortcut': '\0shortcut',
              '@/i18n': '\0i18n',
              '@/utils': '\0utils',
              'custom-electron-prompt': '\0prompt',
              '@/providers/app-controls': '\0controls',
              './providers/app-controls': '\0controls',
              './providers/extracted-data': '\0data',
              './providers/prompt-options': '\0options',
            };
            if (virtual[id]) return virtual[id];
            const normalizedImporter = importer?.replaceAll('\\', '/');
            if (
              id === './store' &&
              normalizedImporter &&
              path.relative(
                path.join(root, 'src', 'config'),
                path.dirname(normalizedImporter),
              ) === ''
            )
              return '\0store';
            const candidate = id.replaceAll('\\', '/');
            if (path.isAbsolute(id) && candidate.includes('/src/plugins/')) {
              const match =
                /\/src\/plugins\/(?:([^/]+)\/index|([^/.]+))\.(?:[cm]?[jt]sx?)$/.exec(
                  candidate,
                );
              const name = match?.[1] ?? match?.[2];
              if (name && name !== 'skip-live-songs') return `\0stub:${name}`;
            }
            if (id.startsWith('@/')) {
              const base = path.join(root, 'src', id.slice(2));
              return [
                base,
                `${base}.ts`,
                `${base}/index.ts`,
                `${base}.tsx`,
              ].find((file) => existsSync(file) && statSync(file).isFile());
            }
            // Let Vite preserve each importer's package scope and import conditions.
          },
          load(id) {
            if (id === '\0state') return state;
            if (id === '\0plugins') return generated;
            if (id === '\0store') return "export {store} from 'owned-state';";
            if (id.startsWith('\0stub:')) {
              const name = id.slice(6);
              const flags: Record<string, unknown> = {
                'ambient-mode': false,
                'auto-acknowledge': 'true',
                adblocker: null,
                'skip-disliked-songs': 1,
                'skip-silences': {},
                'force-shuffle': true,
                'fullscreen-auto-hide': true,
              };
              const flag = Object.hasOwn(flags, name)
                ? `menuWhenDisabled:${JSON.stringify(flags[name])},`
                : '';
              const menu =
                name === 'fullscreen-auto-hide'
                  ? ''
                  : `menu:()=>{state.menuLoads[${JSON.stringify(name)}]=(state.menuLoads[${JSON.stringify(name)}]??0)+1;return ${name === 'force-shuffle' ? '[]' : "[{label:'Owned row'}]"};},`;
              return `import {state} from 'owned-state';export const pluginStub={name:()=>${JSON.stringify(name)},config:{enabled:false},${flag}${menu}};export default {...pluginStub,backend:{start(){state.lifecycleStarts++;throw Error('Backend must not start');}},renderer:{start(){state.lifecycleStarts++;throw Error('Renderer must not start');}}};`;
            }
            if (id === '\0languages')
              return 'export const availableLanguages=[];export const languageLabels={};';
            if (id === '\0i18n')
              return "export const t=key=>key;export const APPLICATION_NAME='Owned fixture';export const setLanguage=async()=>{};";
            if (id === '\0utils')
              return "export const createPlugin=value=>value;export const LoggerPrefix='Owned fixture';";
            if (id === '\0electron')
              return `import {state,Menu,window} from 'owned-state';export {Menu};export class BrowserWindow{constructor(){state.nativeWindows++;throw Error('Native window prohibited');}static fromWebContents(){return window;}};export const app={name:'Owned fixture',getVersion:()=> '3.13.0',getPath:()=>${JSON.stringify(directory)}};export const ipcMain={handle:(name,fn)=>state.nativeIpc[name]=fn};export const nativeImage={createFromPath(){throw Error('Native images prohibited');}};export const shell={openExternal(){throw Error('External links prohibited');}};export const dialog={showMessageBox:async()=>({response:0})};export const clipboard={};`;
            if (id === '\0is')
              return 'export default {macOS:()=>false,windows:()=>false,linux:()=>true,freebsd:()=>false};';
            if (id === '\0shortcut') return 'export const register=()=>{};';
            if (id === '\0prompt')
              return "export default async()=>{throw Error('Prompt prohibited');};";
            if (id === '\0controls')
              return "export const restart=()=>{throw Error('Restart prohibited');};";
            if (id === '\0data') return 'export const startingPages=[];';
            if (id === '\0options') return 'export default {};';
          },
        },
        pluginLoader('backend'),
      ],
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: { entry, formats: ['es'], fileName: () => 'fixture.mjs' },
        rolldownOptions: { external: (id) => isBuiltin(id) },
      },
    });
    const fixture = await import(
      pathToFileURL(path.join(directory, 'fixture.mjs')).href
    );
    const published = () => fixture.Menu.getApplicationMenu()?.items;
    const plugin = (name = 'plugins.skip-live-songs.name') =>
      published()
        ?.find((item: any) => item.label === 'main.menu.plugins.label')
        ?.submenu.items.find((item: any) => item.label === name);
    return {
      ...fixture,
      published,
      plugin,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
