import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, normalizePath } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));

export async function videoEyeBundle() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-video-eye-'));
  try {
    const entry = path.join(directory, 'entry.tsx');
    await writeFile(
      entry,
      `
      import {render} from 'solid-js/web';
      import {createSignal} from 'solid-js';
      import {VideoSwitchButton} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/video-toggle/templates/video-switch-button.tsx')))};
      import plugin from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/video-toggle/index.tsx')))};
      window.eyePlugin=plugin; window.eyeStyles=plugin.stylesheets;
      window.mountEye=(initial)=>{
        const [visible,setVisible]=createSignal(initial);
        window.eyeChanges=[]; window.eyeBubbles=0;
        document.body.onclick=()=>window.eyeBubbles++;
        const dispose=render(()=> <VideoSwitchButton videoVisible={visible()} onVideoToggle={value=>{window.eyeChanges.push(value);setVisible(value)}} songButtonText="Song" videoButtonText="Video"/>,document.querySelector('#mount'));
        window.eyeFixture={setVisible,dispose};
      };
    `,
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          { find: '@', replacement: normalizePath(path.join(root, 'src')) },
        ],
        conditions: ['browser'],
      },
      plugins: [
        solidPlugin(),
        {
          name: 'video-eye-app-boundaries',
          enforce: 'pre',
          resolveId(id) {
            const canonical = normalizePath(id);
            if (id === 'solid-js')
              return normalizePath(
                requireRoot.resolve('solid-js/dist/solid.js'),
              );
            if (id === 'solid-js/web')
              return normalizePath(
                requireRoot.resolve('solid-js/web/dist/web.js'),
              );
            if (
              id === '@/utils' ||
              canonical === normalizePath(path.join(root, 'src/utils'))
            )
              return '\0eye-utils';
            if (
              id === '@/i18n' ||
              canonical === normalizePath(path.join(root, 'src/i18n'))
            )
              return '\0eye-i18n';
            if (canonical.includes('precise-volume/renderer'))
              return '\0eye-volume';
          },
          load(id) {
            if (id === '\0eye-utils')
              return 'export const createPlugin=value=>value;';
            if (id === '\0eye-i18n')
              return 'export const t=key=>key.endsWith("button-song")?"Song":key.endsWith("button-video")?"Video":key;';
            if (id === '\0eye-volume')
              return 'export const moveVolumeHud=()=>{};';
          },
        },
      ],
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry,
          formats: ['iife'],
          name: 'EyeFixture',
          fileName: () => 'fixture.js',
        },
      },
    });
    return await readFile(path.join(directory, 'fixture.js'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
