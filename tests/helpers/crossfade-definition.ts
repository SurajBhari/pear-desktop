import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import {
  crossfadeDefaults,
  parseCrossfadeMenu,
} from '../../src/plugins/crossfade/config';
import { selectCrossfadeAudioFormat } from '../../src/plugins/crossfade/stream';
/** Executes actual menu/backend definition with external prompt/client boundaries only. */
export function crossfadeDefinition(
  boundaries: { prompt?: () => Promise<unknown>; yt?: unknown } = {},
) {
  const source = stripTypeScriptTypes(
    readFileSync(
      new URL('../../src/plugins/crossfade/index.ts', import.meta.url),
      'utf8',
    ),
  )
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace('export default', 'globalThis.plugin =');
  const context = vm.createContext({
    createPlugin: (value: unknown) => value,
    t: (key: string) => key,
    prompt: boundaries.prompt,
    promptOptions: () => ({}),
    crossfadeDefaults,
    parseCrossfadeMenu,
    selectCrossfadeAudioFormat,
    Innertube: { create: async () => boundaries.yt },
    getNetFetchAsFetch: () => () => {},
    console,
  });
  vm.runInContext(source, context);
  return context.plugin as any;
}
