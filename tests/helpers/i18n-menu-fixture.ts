import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { i18nImporter } from '../../vite-plugins/i18n-importer.mts';
const root = path.resolve(import.meta.dirname, '../..');
export async function menuFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-locale-menu-'));
  const entry = path.join(directory, 'entry.ts');
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(
    entry,
    `export * from ${JSON.stringify(path.join(root, 'src/menu.ts'))};export * from 'owned-state';export * from '@/i18n';`,
  );
  const state = `export const state={imports:[],language:'en',restart:false,restartCloses:true,hold:false,pending:[],menus:[],dialogs:[],sends:[],loads:[],templateHold:false,templates:[],controlledPlugin:false,enabledHoldOnce:false,enabledHolds:[],beforeBuild:undefined,afterPublish:undefined};export const config={get:(id)=>id==='options.language'?state.language:id==='options.restartOnConfigChanges'?state.restart:undefined,setMenuOption:(id,value)=>{if(id==='options.language')state.language=value;if(state.restart&&state.restartCloses)state.window.destroyed=true;},plugins:{isEnabled:async(id)=>{if(id==='owned'&&state.enabledHoldOnce){state.enabledHoldOnce=false;await new Promise(resolve=>state.enabledHolds.push(resolve));}return id==='in-app-menu';},enable(){},disable(){}},set(){}};`;
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: directory,
      emptyOutDir: false,
      lib: { entry, formats: ['es'], fileName: () => 'fixture.mjs' },
      minify: false,
    },
    plugins: [
      {
        name: 'owned-locale-menu',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'owned-state') return '\0state';
          if (id === 'virtual:i18n') return '\0languages';
          if (id === 'virtual:plugins') return '\0plugins';
          if (id === 'electron') return '\0electron';
          if (id === 'electron-is') return '\0is';
          if (id === 'custom-electron-prompt') return '\0prompt';
          if (id === '@/i18n') return '\0i18n';
          if (id.endsWith('/src/config') || id === './config')
            return '\0config';
          if (id === './loader/menu') return '\0loader';
          if (id === './providers/app-controls') return '\0controls';
          if (id === './providers/extracted-data') return '\0data';
          if (id === './providers/prompt-options') return '\0options';
        },
        async transform(code, id) {
          if (
            process.env.PEAR_LOCALE_F1_MENU_CONTROL === '1' &&
            id.endsWith('/src/menu.ts')
          )
            return await readFile(
              '/Users/deruta/Documents/Codex/2026-10-06/pear-desktop-reports/2026-10-11-feature-program/lazy-locale-f2-publication-evidence/f1-preserved/src/menu.ts',
              'utf8',
            );
        },
        load(id) {
          if (id === '\0state') return state;
          if (id === '\0config')
            return `import {config} from 'owned-state';export const {get,set,setMenuOption,plugins}=config;`;
          if (id === '\0languages')
            return (
              "import {state} from 'owned-state';\n" +
              i18nImporter().replace(
                'export const loadLanguageResource =',
                'const originalLoadLanguageResource =',
              ) +
              '\nexport const loadLanguageResource=name=>{state.imports.push(name);return originalLoadLanguageResource(name);};'
            );
          if (id === '\0plugins')
            return `import {state} from 'owned-state';import {t} from '@/i18n';export const allPlugins=async()=>state.controlledPlugin?{owned:{name:()=>t('main.menu.options.submenu.language.label'),config:{enabled:false}}}:{};`;
          if (id === '\0i18n')
            return `import {createInstance} from 'i18next';import {createLanguageController} from ${JSON.stringify(path.join(root, 'src/i18n/language-controller.ts'))};import {availableLanguages,loadLanguageResource} from 'virtual:i18n';import {state} from 'owned-state';export const engine=createInstance();const controller=createLanguageController(engine,async id=>{state.loads.push(id);if(state.hold&&id==='ru')await new Promise(resolve=>state.pending.push(resolve));return await loadLanguageResource(id);},availableLanguages);export const {initialize:loadI18n,setLanguage}=controller;export const t=engine.t.bind(engine);export const APPLICATION_NAME='Owned fixture';`;
          if (id === '\0electron')
            return `import {state} from 'owned-state';export const app={name:'Owned fixture',getVersion:()=> '3.13.0',getPath:()=> ''};export const Menu={buildFromTemplate:template=>{const hook=state.beforeBuild;state.beforeBuild=undefined;hook?.();return template;},setApplicationMenu:menu=>{state.menus.push(menu);const hook=state.afterPublish;state.afterPublish=undefined;hook?.();}};export const dialog={showMessageBox:async(win,options)=>{state.dialogs.push(options);return {response:0};}};export const shell={openExternal(){}};export const clipboard={};`;
          if (id === '\0loader')
            return `import {state} from 'owned-state';export const getAllMenuTemplate=()=>({});export const loadAllMenuPlugins=async()=>{if(state.templateHold)await new Promise(resolve=>state.templates.push(resolve));};`;
          if (id === '\0is')
            return 'export default {macOS:()=>false,windows:()=>false,linux:()=>true};';
          if (id === '\0prompt') return 'export default async()=>null;';
          if (id === '\0controls') return 'export const restart=()=>{};';
          if (id === '\0data') return 'export const startingPages=[];';
          if (id === '\0options') return 'export default {};';
        },
      },
    ],
  });
  const fixture = await import(
    pathToFileURL(path.join(directory, 'fixture.mjs')).href
  );
  await fixture.loadI18n();
  const window = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      isDestroyed: () => window.destroyed,
      navigationHistory: {},
      send: (...args: unknown[]) => fixture.state.sends.push(args),
    },
  };
  fixture.state.window = window;
  return {
    ...fixture,
    window,
    directory,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
