import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

/** Inline the real provider and its new relative dependencies in data-URL fixtures. */
export async function rendererAudioFixtureSource(includeExports = true) {
  const read = async (name: string) =>
    readFile(
      new URL(`../../src/providers/${name}.ts`, import.meta.url),
      'utf8',
    );
  const stripImports = (source: string) =>
    stripTypeScriptTypes(source, {
      // Node 24 supports transform; the installed Node typings only list strip.
      // @ts-expect-error transform is required for real provider parameter properties.
      mode: 'transform',
    }).replace(/^import[\s\S]*?;\n/gm, '');
  const dependency = (source: string) =>
    stripImports(source).replace(/^export /gm, '');
  const [peak, output, audio] = await Promise.all([
    read('output-peak-worklet'),
    read('renderer-output'),
    read('renderer-audio'),
  ]);
  const provider = stripImports(audio);
  return `const RendererOutput=(()=>{${dependency(peak)}\n${dependency(output)}\nreturn RendererOutput;})();\n${includeExports ? provider : provider.replace(/^export /gm, '')}`;
}
