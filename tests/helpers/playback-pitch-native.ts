import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { compressorNative } from './compressor-native';

const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));

/** Actual playback renderer/controllers, native media, isolated Electron profile. */
export async function playbackPitchNative<T>(
  task: () => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-pitch-source-'));
  try {
    const entry = path.join(directory, 'entry.ts');
    await writeFile(
      entry,
      [
        `export * as playbackSpeed from ${JSON.stringify(path.join(root, 'src/plugins/playback-speed/renderer.tsx'))};`,
        `export {createSlowedReverbController} from ${JSON.stringify(path.join(root, 'src/plugins/player-actions/slowed-reverb/controller.ts'))};`,
        `export * from ${JSON.stringify(path.join(root, 'src/plugins/utils/renderer/playback-rate-owner.ts'))};`,
      ].join('\n'),
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        solid(),
        {
          name: 'owned-native-pitch-ui-boundaries',
          enforce: 'pre',
          async resolveId(id, importer) {
            if (id === 'solid-js')
              return requireRoot
                .resolve('solid-js/dist/solid.js')
                .replaceAll('\\', '/');
            if (id === 'solid-js/web')
              return requireRoot
                .resolve('solid-js/web/dist/web.js')
                .replaceAll('\\', '/');
            if (
              id === './components/slider' &&
              importer
                ?.replaceAll('\\', '/')
                .endsWith('/playback-speed/renderer.tsx')
            )
              return '\0pitch-slider';
            if (
              [
                '@/i18n',
                '@/providers/dom-elements',
                '@/providers/song-info-front',
                '@/plugins/utils/renderer/check',
              ].includes(id)
            )
              return '\0' + id;
            if (id.endsWith('?inline')) return '\0pitch-css';
            if (id.startsWith('@/')) {
              const target = path.join(root, 'src', id.slice(2));
              for (const suffix of ['.ts', '.tsx', '/index.ts']) {
                try {
                  await access(target + suffix);
                  return (target + suffix).replaceAll('\\', '/');
                } catch {
                  /* next */
                }
              }
            }
            return undefined;
          },
          load(id) {
            if (id === '\0pitch-slider')
              return `export const PlaybackSpeedSlider=props=>{const input=document.createElement('input');input.type='range';input.min='0.07';input.max='16';input.step='0.01';input.id='native-pitch-speed';input.addEventListener('change',()=>props.onImmediateValueChanged(new CustomEvent('change',{detail:{value:Number(input.value)}})));return input;};`;
            if (id === '\0@/i18n') return 'export const t=key=>key;';
            if (id === '\0@/providers/song-info-front')
              return 'export const getSongInfo=()=>({});';
            if (id === '\0@/providers/dom-elements')
              return "export const getSongMenu=()=>document.querySelector('ytmusic-menu-popup-renderer');";
            if (id === '\0@/plugins/utils/renderer/check')
              return 'export const isMusicOrVideoTrack=()=>true;export const isPlayerMenu=()=>true;';
            if (id === '\0pitch-css') return 'export default "";';
            return undefined;
          },
          generateBundle() {
            const identities = [...this.getModuleIds()].filter((id) =>
              id.replaceAll('\\', '/').endsWith('/playback-rate-owner.ts'),
            );
            if (identities.length !== 1)
              this.error(
                `Expected one playback rate owner, found ${identities.length}`,
              );
          },
        },
      ],
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry,
          name: 'pitchSource',
          formats: ['iife'],
          fileName: () => 'actual.js',
        },
      },
    });
    return await compressorNative(
      await readFile(path.join(directory, 'actual.js'), 'utf8'),
      task,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
