import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));

/** Real menu/loader/config/backend lifecycle, with owned native/store/listen boundaries. */
export async function musicMenuLifecycleFixture({ inAppEnabled = false } = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-music-menu-lifecycle-'),
  );
  const source = await readFile(path.join(root, 'src/index.ts'), 'utf8');
  // Exercise the entrypoint's unchanged callback without launching Electron's app.
  const start = source.indexOf('config.watch((newValue, oldValue) => {');
  const end = source.indexOf('\n    configWatcherRegistered = true;', start);
  if (start < 0 || end <= start) throw Error('Missing actual config watcher');
  const watcher = source.slice(start, end).trim();
  const absolute = (relative: string) =>
    JSON.stringify(path.join(root, relative));
  const entry = path.join(directory, 'entry.ts');
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(
    entry,
    `
import * as config from '@/config';
import {backend} from ${absolute('src/plugins/api-server/backend/main.ts')};
import {refreshMenu} from '@/menu';
import {getMenuTemplate} from ${absolute('src/loader/menu.ts')};
import {getMcpGrantTarget,publishMcpGrantTarget} from ${absolute('src/plugins/api-server/backend/mcp-owner.ts')};
import {allPlugins} from 'virtual:plugins';
import {deepmerge} from 'deepmerge-ts';import {deepEqual} from 'fast-equals';
import {state,window,ipcMain} from 'owned-state';
const allPluginStubs=await allPlugins();const configWindow=window;
const getAllLoadedMainPlugins=()=>({'api-server':{backend}});
const forceLoadMainPlugin=()=>{throw Error('Unexpected plugin start');};
const forceUnloadMainPlugin=()=>{throw Error('Unexpected plugin unload');};
const showNeedToRestartDialog=()=>{throw Error('Unexpected restart dialog');};
${watcher}
const initial=config.get('plugins.api-server');
backend.musicWindow=window;backend.oldConfig={...initial};backend.musicGrants={};
backend.musicService={configure(){state.serviceConfigurations++;},stop(){}};
const listener=state.makeListener(true);backend.mcpListener=listener;publishMcpGrantTarget(window,listener);
export const published=()=>state.menus.at(-1);
export const closeBackend=()=>backend.stop();
export {state,window,refreshMenu,getMenuTemplate,getMcpGrantTarget,config,backend};
`,
  );
  const ownedState = `
import {EventEmitter} from 'node:events';
export const state={menus:[],sends:[],lateSends:0,prompts:0,listenerStops:0,serviceConfigurations:0,writes:0,watcherCalls:0,failWrites:false,destroyed:false,holdStarts:false,startReleases:[],listeners:[],mcpLoads:0,holdPluginsOnce:false,pluginReleases:[],holdMenuAfterWrite:false};
export const window=Object.assign(new EventEmitter(),{isDestroyed:()=>state.destroyed,webContents:Object.assign(new EventEmitter(),{isDestroyed:()=>state.destroyed,mainFrame:{},navigationHistory:{},send:(...args)=>{if(state.destroyed){state.lateSends++;throw Error('Owned send after destroyed window');}state.sends.push(args);}})});
export const ipcMain=new EventEmitter();
state.makeListener=(live=false)=>{let stopped=false;const current=()=>live&&!stopped;const listener={resource:'http://127.0.0.1:26539/mcp',grants:{},owner:{current},captureNativeOwner:()=>({current}),start:async()=>{if(state.holdStarts)await new Promise(resolve=>state.startReleases.push(resolve));if(!stopped)live=true;},stop:async()=>{if(stopped)return;stopped=true;live=false;state.listenerStops++;}};state.listeners.push(listener);return listener;};
const data={options:{language:'en',themes:[],restartOnConfigChanges:false},plugins:{'in-app-menu':{enabled:${JSON.stringify(inAppEnabled)}},'api-server':{enabled:true,mcpEnabled:true,mcpPort:26539,musicApiEnabled:false,hostname:'127.0.0.1',port:26538,useHttps:false,certPath:'',keyPath:'',authorizedClients:[],authStrategy:'NONE',secret:'synthetic-fixture-secret'}}};
const watchers=[];
export const store={get:key=>key.split('.').reduce((value,part)=>value?.[part],data),set:(key,value)=>{if(state.failWrites)throw Error('Owned configuration write failure');const old=structuredClone(data);const parts=key.split('.');let target=data;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=value;state.writes++;for(const watcher of watchers){state.watcherCalls++;watcher(data,old);}if(state.holdMenuAfterWrite){state.holdMenuAfterWrite=false;state.holdPluginsOnce=true;}},onDidAnyChange:callback=>{watchers.push(callback);return()=>{};}};
`;
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: { entry, formats: ['es'], fileName: () => 'fixture.mjs' },
        rolldownOptions: {
          external: isBuiltin,
          output: {
            banner:
              "import {createRequire as ownedCreateRequire} from 'node:module';const require=ownedCreateRequire(import.meta.url);",
          },
        },
      },
      plugins: [
        {
          name: 'owned-native-menu-config-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            const normalizedImporter = importer?.replaceAll('\\', '/');
            const boundaries: Record<string, string> = {
              'owned-state': 'state',
              electron: 'electron',
              'electron-is': 'is',
              'virtual:plugins': 'plugins',
              'virtual:i18n': 'languages',
              '@/i18n': 'i18n',
              '@/providers/prompt-options': 'options',
              './providers/prompt-options': 'options',
              'custom-electron-prompt': 'prompt',
              '@/providers/app-controls': 'controls',
              './providers/app-controls': 'controls',
              './providers/extracted-data': 'data',
            };
            if (boundaries[id]) return '\0' + boundaries[id];
            if (
              id === './mcp' &&
              normalizedImporter?.endsWith('/api-server/backend/main.ts')
            )
              return '\0mcp';
            if (
              (id === './store' || id === './defaults') &&
              normalizedImporter?.includes('/src/config/')
            )
              return id === './store' ? '\0store' : '\0defaults';
            if (id.startsWith('@/')) {
              const target = path.join(root, 'src', id.slice(2));
              for (const suffix of ['.ts', '/index.ts', '.tsx'])
                if (existsSync(target + suffix)) return target + suffix;
            }
            if (
              !id.startsWith('.') &&
              !path.isAbsolute(id) &&
              !id.startsWith('\0')
            ) {
              try {
                if (importer && path.isAbsolute(importer))
                  return createRequire(importer).resolve(id);
              } catch {
                /* entry uses root dependencies */
              }
              return requireRoot.resolve(id);
            }
            return undefined;
          },
          load(id) {
            if (id === '\0state') return ownedState;
            if (id === '\0store') return "export {store} from 'owned-state';";
            if (id === '\0defaults') return 'export const defaultConfig={};';
            if (id === '\0mcp')
              return "import {state} from 'owned-state';state.mcpLoads++;export const createMcpListener=()=>state.makeListener();";
            if (id === '\0plugins')
              return `import {state} from 'owned-state';import {onMenu} from ${absolute('src/plugins/api-server/menu.ts')};import {defaultAPIServerConfig} from ${absolute('src/plugins/api-server/config.ts')};export const allPlugins=async()=>{if(state.holdPluginsOnce){state.holdPluginsOnce=false;await new Promise(resolve=>state.pluginReleases.push(resolve));}return {'api-server':{name:()=> 'API',config:defaultAPIServerConfig,menu:onMenu}};};`;
            if (id === '\0languages')
              return "export const availableLanguages=['en'];export const languageLabels={en:{name:'English',localName:'English'}};";
            if (id === '\0i18n')
              return "export const APPLICATION_NAME='Owned Fixture';export const t=key=>key;export const setLanguage=async()=>{};";
            if (id === '\0electron')
              return `import {state,window,ipcMain} from 'owned-state';export {ipcMain};export const app={name:'Owned Fixture',getVersion:()=> '3.13.0',getPath:()=>${JSON.stringify(directory)}};export class BrowserWindow{constructor(){throw Error('Native window prohibited');}};export const Menu={buildFromTemplate:template=>template,setApplicationMenu:template=>state.menus.push(template)};export const clipboard={writeText:()=>{throw Error('Credential copy prohibited');}};export const dialog={showMessageBox:async()=>({response:3})};export const shell={};export const nativeImage={};export const net={fetch:()=>{throw Error('Network prohibited');}};`;
            if (id === '\0is')
              return 'export default {macOS:()=>false,windows:()=>false,linux:()=>true};';
            if (id === '\0options') return 'export default ()=>({});';
            if (id === '\0prompt')
              return "import {state} from 'owned-state';export default async()=>{state.prompts++;return null;};";
            if (id === '\0controls')
              return "export const restart=()=>{throw Error('Restart prohibited');};";
            if (id === '\0data') return 'export const startingPages=[];';
            return undefined;
          },
        },
      ],
    });
    const fixture = await import(
      pathToFileURL(path.join(directory, 'fixture.mjs')).href
    );
    const entries = () =>
      fixture
        .published()
        .find((item: any) => item.label === 'main.menu.plugins.label')
        .submenu.find((item: any) => item.label === 'API')
        .submenu.find((item: any) => item.label === 'MCP music access').submenu;
    const flags = () => {
      const items = entries();
      return {
        checked: items.find(
          (item: any) => item.label === 'Enable MCP music access',
        ).checked,
        create: items.find((item: any) => item.label === 'Create client grant…')
          .enabled,
        revoke: items.find(
          (item: any) => item.label === 'Revoke client grants…',
        ).enabled,
      };
    };
    return {
      ...fixture,
      flags,
      entries,
      toggle: async (checked: boolean) => {
        const item = entries().find(
          (item: any) => item.label === 'Enable MCP music access',
        );
        // Electron changes checked before dispatching the native click callback.
        item.checked = checked;
        await item.click(item);
      },
      close: async () => {
        fixture.closeBackend();
        for (const release of fixture.state.startReleases) release();
        for (const release of fixture.state.pluginReleases) release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
