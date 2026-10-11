import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron, test } from '@playwright/test';
import { normalizePath } from 'vite';
const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const execute = promisify(execFile);
let output: Promise<string> | undefined;
export function nativeBuild() {
  if (output) return output;
  output = (async () => {
    const owned = await mkdtemp(path.join(tmpdir(), 'pear-locale-built-'));
    const config = path.join(owned, 'config.mts');
    const parentSources: Record<string, string> = {};
    if (process.env.PEAR_LOCALE_PARENT_CONTROL === '1')
      for (const file of [
        'src/index.ts',
        'src/menu.ts',
        'src/preload.ts',
        'src/renderer.ts',
        'src/i18n/index.ts',
      ])
        parentSources['/' + file] = (
          await execute('git', ['show', 'HEAD:' + file], {
            cwd: root,
            maxBuffer: 1024 * 1024,
          })
        ).stdout;
    await writeFile(
      config,
      `import base from ${JSON.stringify(normalizePath(path.join(root, 'electron.vite.config.mts')))};
const parentSources=${JSON.stringify(parentSources)};export default async environment=>{const result=typeof base==='function'?await base(environment):base;for(const scope of ['main','preload','renderer']){result[scope].build.outDir=${JSON.stringify(owned)}+'/dist/'+scope;result[scope].plugins.push({name:'owned-locale-observation',enforce:'pre',transform(code,id){const parent=Object.keys(parentSources).find(file=>id.endsWith(file));if(parent)code=parentSources[parent];if(id.endsWith('/src/i18n/index.ts')){code=code.replace('  loadLanguageResource,','  async name=>{if('+(scope==='main'?'globalThis.__holdLocale':'true')+'&&name===\"ru\")await new Promise(resolve=>{globalThis.__releaseLocale=resolve;});return await loadLanguageResource(name);},');return code+'\\nglobalThis.__localeSnapshot=()=>({ids:Object.keys(i18next.store?.data??{}),language:i18next.language,resolved:i18next.resolvedLanguage,label:i18next.t(\"main.menu.options.submenu.language.label\"),events:globalThis.__localeEvents??[]});globalThis.__localeApi={loadI18n,setLanguage};';}if(scope==='renderer'&&id.endsWith('/src/renderer.ts'))return code.replace('  definePearTransElements();','  globalThis.__localeEvents=[...(globalThis.__localeEvents??[]),\"elements\"];definePearTransElements();').replace('const main = async () => {','const main = async () => {globalThis.__localeEvents=[...(globalThis.__localeEvents??[]),\"main\"];');if(scope==='preload'&&id.endsWith('/src/preload.ts'))return code.replace('  await loadAllPreloadPlugins();','  globalThis.__localeEvents=[\"plugins\"];await loadAllPreloadPlugins();')+'\\ncontextBridge.exposeInMainWorld(\"__preloadLocale\",{snapshot:()=>globalThis.__localeSnapshot(),pending:()=>typeof globalThis.__releaseLocale,release:()=>globalThis.__releaseLocale?.()});';if(parent)return code;}});}return result;};`,
    );
    await execute(
      process.execPath,
      [
        path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'),
        'build',
        '--config',
        config,
      ],
      { cwd: root, maxBuffer: 2 * 1024 * 1024 },
    );
    await writeFile(
      path.join(owned, 'package.json'),
      '{"type":"module","name":"owned-locale-proof","version":"3.13.0"}',
    );
    await cp(path.join(root, 'assets'), path.join(owned, 'assets'), {
      recursive: true,
    });
    const { symlink } = await import('node:fs/promises');
    await symlink(
      path.join(root, 'node_modules'),
      path.join(owned, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return owned;
  })();
  return output;
}

export async function nativeLocale(
  language: string,
  { packaged = false, missing = false } = {},
) {
  const built = await nativeBuild();
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-locale-run-'));
  const profile = path.join(owned, 'userData');
  await mkdir(profile);
  const plugins = Object.fromEntries(
    (await readdir(path.join(root, 'src/plugins'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => [entry.name, { enabled: false }]),
  );
  await writeFile(
    path.join(profile, 'config.json'),
    JSON.stringify({
      options: {
        language,
        autoUpdates: false,
        appVisible: false,
        autoResetAppCache: false,
      },
      plugins,
      __internal__: { migrations: { version: '3.13.0' } },
    }),
  );
  let appRoot = built;
  if (packaged || missing) {
    appRoot = path.join(owned, 'package');
    await mkdir(appRoot);
    await cp(path.join(built, 'dist'), path.join(appRoot, 'dist'), {
      recursive: true,
    });
    await cp(path.join(built, 'assets'), path.join(appRoot, 'assets'), {
      recursive: true,
    });
    await cp(
      path.join(built, 'package.json'),
      path.join(appRoot, 'package.json'),
    );
    const { symlink } = await import('node:fs/promises');
    await symlink(
      path.join(root, 'node_modules'),
      path.join(appRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    if (missing)
      for (const scope of ['main', 'preload'])
        for (const file of await readdir(path.join(appRoot, 'dist', scope)))
          if (/^fr-/.test(file))
            await rm(path.join(appRoot, 'dist', scope, file));
    if (packaged) {
      const { symlink } = await import('node:fs/promises');
      await symlink(
        path.join(root, 'node_modules'),
        path.join(owned, 'node_modules'),
      );
      const requireBuilder = createRequire(
        requireRoot.resolve('electron-builder'),
      );
      const asar = requireBuilder('@electron/asar');
      const archive = path.join(owned, 'app.asar');
      await asar.createPackageWithOptions(appRoot, archive, {
        globOptions: { ignore: ['node_modules/**'] },
        unpack: 'assets/**',
      });
      appRoot = archive;
    }
  }
  const entry = path.join(owned, 'entry.cjs');
  await writeFile(
    entry,
    `const {app,session,BrowserWindow,Menu,dialog}=require('electron');const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};for(const key of ['userData','sessionData','downloads']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned locale profile');app.setPath(key,target);}app.setLoginItemSettings=()=>{};globalThis.__nativeLocale={app,BrowserWindow,Menu,requests:[],dialogs:[]};dialog.showMessageBox=async(...args)=>{globalThis.__nativeLocale.dialogs.push(args);return {response:0};};setInterval(()=>{try{const flat=items=>items.flatMap(item=>[item,...flat(item.submenu?.items??[])]);const menu=Menu.getApplicationMenu();const proof={pid:process.pid,time:Date.now(),snapshot:globalThis.__localeSnapshot?.(),windows:BrowserWindow.getAllWindows().map(win=>({id:win.id,url:win.webContents.getURL()})),labels:flat(menu?.items??[]).map(item=>item.label),dialogs:globalThis.__nativeLocale.dialogs.length};fs.writeFileSync(path.join(owned,'native-proof.json'),JSON.stringify(proof));}catch{}},25);app.whenReady().then(()=>{for(const scheme of ['https','http'])session.defaultSession.protocol.handle(scheme,request=>{globalThis.__nativeLocale.requests.push(request.url);return new Response('<html><body><ytmusic-app></ytmusic-app><ytmusic-player-bar></ytmusic-player-bar></body></html>',{headers:{'Content-Type':'text/html'}});});});import(${JSON.stringify(pathToFileURL(path.join(appRoot, 'dist/main/index.js')).href)}).catch(error=>{fs.writeFileSync(path.join(owned,'native-error.txt'),String(error.stack??error));console.error(error);app.exit(1);});`,
  );
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PEAR_TEST_STARTUP_FACTS: path.join(owned, 'startup.json'),
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    cwd: owned,
    args: [
      '--require',
      path.join(root, 'tests/helpers/electron-startup-observer.cjs'),
      entry,
      `--user-data-dir=${profile}`,
      '--no-sandbox',
      '--disable-gpu',
    ],
    env,
  });
  let transcript = '';
  app.process().stdout?.on('data', (data) => {
    transcript += String(data);
  });
  app.process().stderr?.on('data', (data) => {
    transcript += String(data);
  });
  return {
    app,
    owned,
    profile,
    appRoot,
    close: async () => {
      await app.close().catch(() => {});
      const { readFile } = await import('node:fs/promises');
      transcript += await readFile(
        path.join(owned, 'native-error.txt'),
        'utf8',
      ).catch(() => '');
      const transcriptPath =
        process.env.PEAR_LOCALE_NATIVE_TRANSCRIPT_PATH ??
        test.info().outputPath('lazy-native-transcript.log');
      try {
        await mkdir(path.dirname(transcriptPath), { recursive: true });
        await writeFile(transcriptPath, transcript);
      } finally {
        await rm(owned, { recursive: true, force: true });
      }
    },
  };
}
