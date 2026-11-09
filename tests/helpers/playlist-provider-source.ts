import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { ts } from 'ts-morph';

/** Extract actual music ownership, not unrelated renderer startup lifetimes. */
export function rendererMusicActionsOwnerSource(source: string): string {
  const file = ts.createSourceFile(
    'renderer.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const startup = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'onApiLoaded',
  );
  const statements = startup?.body?.statements;
  if (!statements) throw new Error('Actual renderer startup missing');
  const calls = (node: ts.Node, name: string): boolean => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      return true;
    return (
      ts.forEachChild(node, (child) => calls(child, name) || undefined) === true
    );
  };
  const starts = statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'disposeMusicActionsOwner',
  );
  const ends = statements.filter(
    (node) => ts.isIfStatement(node) && calls(node, 'publishMusicActionsOwner'),
  );
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0].getStart(file) >= ends[0].getEnd()
  )
    throw new Error('Actual renderer music-owner boundary changed');
  return source.slice(starts[0].getStart(file), ends[0].getEnd());
}

/** Real provider embedding for existing renderer-entry fixtures; no copied queue behavior. */
export async function playlistProviderSource() {
  const strip = (source: string) =>
    stripTypeScriptTypes(source)
      .replace(/^import[\s\S]*?;\n/gm, '')
      .replace(/^export /gm, '');
  return (
    strip(
      await readFile(
        new URL('../../src/providers/queue-playlist.ts', import.meta.url),
        'utf8',
      ),
    ) +
    '\n' +
    strip(
      await readFile(
        new URL(
          '../../src/providers/queue-playlist-renderer.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    )
  );
}
