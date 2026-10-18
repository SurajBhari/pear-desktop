import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { test } from '@playwright/test';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));
const { parse } = requireVite('@babel/parser') as {
  parse: (
    source: string,
    options: { sourceType: string; plugins: string[] },
  ) => unknown;
};
type AstNode = { type: string; [key: string]: unknown };
type ImportNode = AstNode & {
  source: { value: string };
  start: number;
  end: number;
  specifiers: { importKind?: string; local: { name: string } }[];
};
type LoadNode = AstNode & {
  key: { name: string };
  body: { body: AstNode[] };
};
type Producer = AstNode & {
  test: {
    type: string;
    operator: string;
    left: { name: string };
    right: { value: string };
  };
  consequent: { type: string; argument: { type: string; value: string } };
};

function nodes(source: string) {
  const pending: unknown[] = [
    parse(source, { sourceType: 'module', plugins: ['typescript'] }),
  ];
  const result: AstNode[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string') result.push(record as AstNode);
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) pending.push(...(value as unknown[]));
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return result;
}

for (const [helper, virtualId] of [
  ['shortcut-rating-source.ts', '\0shortcut:volume-renderer'],
  ['shortcut-rating-native.ts', '\0native-shortcut:volume-renderer'],
]) {
  test(`${helper} links the precise-volume renderer import contract`, async ({
    browserName: _browserName,
  }, info) => {
    // Read both boundaries as text; never import the plugin or native helper.
    const [index, fixture] = await Promise.all([
      readFile(path.join(root, 'src/plugins/precise-volume/index.ts'), 'utf8'),
      readFile(path.join(root, 'tests/helpers', helper), 'utf8'),
    ]);
    const imports = nodes(index).filter(
      (node): node is ImportNode =>
        node.type === 'ImportDeclaration' &&
        node.importKind !== 'type' &&
        ['./renderer', './override'].includes(
          (node as ImportNode).source.value,
        ),
    );
    assert.equal(
      imports.length,
      2,
      'Both actual renderer boundaries are needed',
    );
    const bindings = imports.flatMap((node) =>
      node.specifiers
        .filter((specifier) => specifier.importKind !== 'type')
        .map((specifier) => specifier.local.name),
    );
    assert(bindings.length > 0, 'The consumer must retain its actual bindings');
    const consumer =
      imports.map((node) => index.slice(node.start, node.end)).join('\n') +
      `\nexport { ${bindings.join(', ')} };`;
    const loads = nodes(fixture).filter(
      (node): node is LoadNode =>
        node.type === 'ObjectMethod' && (node as LoadNode).key.name === 'load',
    );
    const producers = loads
      .flatMap((load) => load.body.body)
      .filter(
        (node): node is Producer =>
          node.type === 'IfStatement' &&
          (node as Producer).test.type === 'BinaryExpression' &&
          (node as Producer).test.operator === '===' &&
          (node as Producer).test.left.name === 'id' &&
          (node as Producer).test.right.value === virtualId,
      );
    assert.equal(producers.length, 1, 'Find the actual volume mock producer');
    const returned = producers[0].consequent;
    assert.equal(returned.type, 'ReturnStatement');
    assert.equal(returned.argument.type, 'StringLiteral');
    const mockSource: string = returned.argument.value;
    const entry = '\0shortcut-volume-fixture-contract';
    const entryPath = info.outputPath('consumer.ts');
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'source-extracted-volume-fixture-contract',
          resolveId(id) {
            if (id === entry || id === entryPath) return entry;
            if (['./renderer', './override'].includes(id)) return virtualId;
            throw new Error(`Unexpected contract import: ${id}`);
          },
          load(id) {
            if (id === entry) return consumer;
            if (id === virtualId) return mockSource;
            throw new Error(`Unexpected contract module: ${id}`);
          },
        },
      ],
      build: {
        ssr: entryPath,
        write: false,
        outDir: info.outputPath('volume-fixture-contract'),
        emptyOutDir: false,
        minify: false,
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const exported = outputs.flatMap((output) =>
      'output' in output
        ? output.output.flatMap((chunk) =>
            chunk.type === 'chunk' ? chunk.exports : [],
          )
        : [],
    );
    assert.deepEqual(
      exported.sort((a, b) => a.localeCompare(b)),
      bindings.sort((a, b) => a.localeCompare(b)),
    );
  });
}
