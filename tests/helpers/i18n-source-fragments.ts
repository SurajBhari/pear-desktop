import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Project, ts } from 'ts-morph';
const root = path.resolve(import.meta.dirname, '../..');
export const source = (name: string) =>
  readFileSync(path.join(root, 'src', name), 'utf8');
export const parsed = (name: string) =>
  new Project({ useInMemoryFileSystem: true }).createSourceFile(
    name,
    source(name),
  );
export const javascript = (code: string) =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
export const flush = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
