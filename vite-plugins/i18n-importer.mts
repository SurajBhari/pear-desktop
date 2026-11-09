import { readFileSync } from 'node:fs';
import { basename, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { globSync } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const i18nImporter = () => {
  const root = resolve(__dirname, '..');
  const languages = globSync(['src/i18n/resources/*.json'], { cwd: root }).map(
    (path) => {
      const name = basename(path, extname(path));
      const absolutePath = resolve(root, path).replace(/\\/g, '/');
      const resource = JSON.parse(readFileSync(absolutePath, 'utf8')) as {
        language?: { name?: string; 'local-name'?: string };
      };
      return {
        name,
        path: absolutePath,
        label: {
          name: resource.language?.name ?? 'Unknown',
          localName: resource.language?.['local-name'] ?? 'Unknown',
        },
      };
    },
  );

  return `export const availableLanguages = Object.freeze(${JSON.stringify(languages.map(({ name }) => name))});
export const languageLabels = Object.freeze(${JSON.stringify(Object.fromEntries(languages.map(({ name, label }) => [name, label])))});
const loaders = new Map([
${languages.map(({ name, path }) => `  [${JSON.stringify(name)}, () => import(${JSON.stringify(path)}).then(mod => mod.default)],`).join('\n')}
]);
const resources = new Map();
export const loadLanguageResource = (name) => {
  const loader = loaders.get(name);
  if (!loader) return Promise.resolve(undefined);
  const cached = resources.get(name);
  if (cached) return cached;
  const pending = Promise.resolve().then(loader);
  resources.set(name, pending);
  pending.catch(() => { if (resources.get(name) === pending) resources.delete(name); });
  return pending;
};
export const languageResources = async () => Object.fromEntries(await Promise.all(
  availableLanguages.map(async name => [name, { translation: await loadLanguageResource(name) }])
));
`;
};
