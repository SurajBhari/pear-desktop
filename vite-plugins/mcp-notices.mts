import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

import type { Plugin } from 'vite';

type LockRecord = { key: string; sha256: string };
type Edge = {
  from: string;
  kind: string;
  dependency_name: string;
  reference: string;
  to: string;
};
type NoticeRecord = {
  name: string;
  version: string;
  recordId: string;
  qualification: string;
  sourceGroup: string;
  noticeFile: string;
  noticeSha256: string;
  noticeBytes: number;
  source: {
    archiveSha256: string;
    packageJsonSha256: string;
    originalNoticePath: string;
    licenseLabel: Record<string, string>;
    qualification: string;
  };
  package: LockRecord;
  snapshots: LockRecord[];
};
type Binding = {
  format: number;
  acceptedSourceHashes: {
    sdk1320Source: string;
    bodyParser240Source: string;
  };
  sdkSpecifier: string;
  sdkImporterSha256: string;
  sdkPatchSha256: string;
  graph: {
    rootSnapshot: string;
    snapshots: string[];
    edges: Edge[];
    peerContexts: {
      snapshot: string;
      context: string;
      exact_snapshot_target: string;
    }[];
  };
  records: NoticeRecord[];
};

const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => {
  throw new Error(`MCP notices: ${message}`);
};
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2');
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]!;
  });

// pnpm lockfile v9's literal mapping blocks: deliberately reject duplicate keys.
// Hash only the selected canonical blocks so unrelated lock edits stay independent.
function blocks(text: string, indent: number) {
  const result = new Map<string, string>();
  let key: string | undefined;
  let lines: string[] = [];
  const finish = () => {
    if (key === undefined) return;
    if (result.has(key)) fail(`duplicate lock record ${key}`);
    result.set(key, `${lines.join('\n').trimEnd()}\n`);
  };
  for (const line of text.split('\n')) {
    const match = new RegExp(`^ {${indent}}(\\S.*?):(?:\\s|$)`).exec(line);
    if (match) {
      finish();
      key = unquote(match[1]);
      lines = [line];
    } else if (key !== undefined) {
      lines.push(line);
    }
  }
  finish();
  return result;
}

function lockSection(lock: string, name: string) {
  const parts = lock.split(new RegExp(`^${name}:\\n`, 'm'));
  if (parts.length !== 2)
    return fail(`missing or ambiguous lock section ${name}`);
  return parts[1].split(/^\S.*:\n/m)[0];
}

function requireBlock(
  map: Map<string, string>,
  record: LockRecord,
  kind: string,
) {
  const value = map.get(record.key);
  if (value === undefined)
    return fail(`missing ${kind} graph node ${record.key}`);
  if (sha256(value) !== record.sha256)
    fail(`${kind} hash changed for ${record.key}`);
  return value;
}

const identity = (snapshot: string) => snapshot.split('(')[0];
const edgeKey = (edge: Edge) =>
  JSON.stringify([
    edge.from,
    edge.kind,
    edge.dependency_name,
    edge.reference,
    edge.to,
  ]);

function verifyGraph(binding: Binding, snapshots: Map<string, string>) {
  const expected = binding.graph.snapshots;
  const nodes = new Set(expected);
  const bound = binding.records.flatMap((record) =>
    record.snapshots.map((s) => s.key),
  );
  if (
    expected.length !== 94 ||
    nodes.size !== 94 ||
    bound.length !== 94 ||
    new Set(bound).size !== 94 ||
    bound.some((key) => !nodes.has(key)) ||
    !nodes.has(binding.graph.rootSnapshot)
  )
    fail('missing or ambiguous SDK graph nodes (expected 94)');
  const actualEdges: Edge[] = [];
  for (const from of expected) {
    const text =
      snapshots.get(from) ?? fail(`missing snapshot graph node ${from}`);
    let kind = '';
    for (const line of text.split('\n').slice(1)) {
      const section = /^    (\w+):$/.exec(line);
      if (section) kind = section[1];
      else if (/^    \S/.test(line)) kind = '';
      if (!['dependencies', 'optionalDependencies'].includes(kind)) continue;
      const entry = /^      (\S.*?): (.+)$/.exec(line);
      if (!entry) continue;
      const name = unquote(entry[1]);
      const reference = unquote(entry[2]);
      const to = `${name}@${reference}`;
      if (!nodes.has(to)) fail(`unbound declared graph edge ${from} -> ${to}`);
      actualEdges.push({ from, kind, dependency_name: name, reference, to });
    }
  }
  const actual = actualEdges.map(edgeKey).sort();
  const approved = binding.graph.edges.map(edgeKey).sort();
  if (JSON.stringify(actual) !== JSON.stringify(approved))
    fail('declared SDK graph edges changed or missing');
  const reached = new Set([binding.graph.rootSnapshot]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of actualEdges) {
      if (reached.has(edge.from) && !reached.has(edge.to)) {
        reached.add(edge.to);
        changed = true;
      }
    }
  }
  if (reached.size !== nodes.size) fail('unreachable SDK graph node');
  const actualContexts: string[] = [];
  for (const snapshot of expected) {
    let depth = 0;
    let start = 0;
    for (const [index, char] of [...snapshot].entries()) {
      if (char === '(' && depth++ === 0) start = index + 1;
      if (char === ')' && --depth === 0) {
        const context = snapshot.slice(start, index);
        if (!context.startsWith('patch_hash='))
          actualContexts.push(JSON.stringify([snapshot, context]));
      }
    }
  }
  const approvedContexts = binding.graph.peerContexts.map((peer) =>
    JSON.stringify([peer.snapshot, peer.context]),
  );
  if (
    JSON.stringify(actualContexts.sort()) !==
    JSON.stringify(approvedContexts.sort())
  )
    fail('peer-context graph references changed or missing');
  for (const peer of binding.graph.peerContexts) {
    if (
      !nodes.has(peer.snapshot) ||
      !nodes.has(peer.exact_snapshot_target) ||
      !peer.snapshot.includes(`(${peer.context})`) ||
      peer.exact_snapshot_target.replace(/\(patch_hash=[a-f0-9]+\)/g, '') !==
        peer.context
    )
      fail('missing or changed peer-context graph node');
  }
}

async function originalNotice(root: string, record: NoticeRecord) {
  if (!/^notices\/[a-zA-Z0-9_.-]+\.txt$/.test(record.noticeFile))
    return fail('unsafe notice path');
  const base = join(root, 'licenses/mcp');
  const file = join(base, record.noticeFile);
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    (await realpath(file)) !==
      join(await realpath(root), 'licenses/mcp', record.noticeFile)
  )
    fail('unsafe notice path or symlink');
  const bytes = await readFile(file);
  if (
    sha256(bytes) !== record.noticeSha256 ||
    bytes.length !== record.noticeBytes
  )
    fail(`notice hash/length changed for ${record.name}@${record.version}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function emitMcpNotices(root: string) {
  const base = join(root, 'licenses/mcp');
  const binding = JSON.parse(
    await readFile(join(base, 'binding.json'), 'utf8'),
  ) as Binding;
  if (binding.format !== 1 || binding.records.length !== 94)
    fail('expected binding format 1 and 94 SDK records');
  const sdkSource = await readFile(
    join(base, 'sources/sdk-1.32.0.json'),
    'utf8',
  );
  if (
    sha256(sdkSource.replace(/\r\n/g, '\n')) !==
    binding.acceptedSourceHashes.sdk1320Source
  )
    fail('SDK source provenance hash changed');
  const bodyParserSource = await readFile(
    join(base, 'sources/body-parser-2.4.0.json'),
    'utf8',
  );
  if (
    sha256(bodyParserSource.replace(/\r\n/g, '\n')) !==
    binding.acceptedSourceHashes.bodyParser240Source
  )
    fail('body-parser source provenance hash changed');
  const ids = binding.records.map(
    (record) => `${record.name}@${record.version}`,
  );
  if (
    new Set(ids).size !== 94 ||
    new Set(binding.records.map((r) => r.recordId)).size !== 94
  )
    fail('duplicate or ambiguous notice identity');
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
  };
  if (
    manifest.dependencies?.['@modelcontextprotocol/sdk'] !==
    binding.sdkSpecifier
  )
    fail('SDK manifest specifier changed');
  const patch = await readFile(
    join(root, 'patches/@modelcontextprotocol__sdk@1.32.0.patch'),
  );
  if (sha256(patch) !== binding.sdkPatchSha256)
    fail('SDK patch source hash changed');
  const lock = (await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).replace(
    /\r\n/g,
    '\n',
  );
  if (!/^lockfileVersion: '9.0'$/m.test(lock))
    fail('unsupported lockfile version');
  const packages = blocks(lockSection(lock, 'packages'), 2);
  const snapshots = blocks(lockSection(lock, 'snapshots'), 2);
  const rootImporter =
    blocks(lockSection(lock, 'importers'), 2).get('.') ??
    fail('missing root importer');
  const productionImports =
    blocks(rootImporter, 4).get('dependencies') ??
    fail('missing production importer dependencies');
  const sdkImporter = blocks(productionImports, 6).get(
    '@modelcontextprotocol/sdk',
  );
  if (!sdkImporter || sha256(sdkImporter) !== binding.sdkImporterSha256)
    fail('SDK importer graph reference changed');
  for (const record of binding.records) {
    const id = `${record.name}@${record.version}`;
    if (
      record.package.key !== id ||
      record.snapshots.some((s) => identity(s.key) !== id)
    )
      fail('package/notice identity mismatch');
    requireBlock(packages, record.package, 'package');
    for (const snapshot of record.snapshots)
      requireBlock(snapshots, snapshot, 'snapshot');
  }
  verifyGraph(binding, snapshots);
  const articles: string[] = [];
  for (const [index, record] of binding.records.entries()) {
    const notice = await originalNotice(root, record);
    const title = escapeHtml(`${record.name}@${record.version}`);
    articles.push(
      `<article id="notice-${index + 1}"><h2>${title}</h2><pre>${escapeHtml(notice)}</pre></article>`,
    );
  }
  const source = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>MCP dependency notices</title>
<style>
:root { color-scheme: light dark; font: 16px/1.6 system-ui, sans-serif; }
body { margin: 0 auto; max-width: 76ch; padding: 2rem clamp(1rem, 4vw, 3rem); background: Canvas; color: CanvasText; }
h1 { font-size: 1.8rem; line-height: 1.25; letter-spacing: -.02em; }
h2 { font-size: 1.15rem; line-height: 1.4; overflow-wrap: anywhere; }
article { margin-block: 2.5rem; padding-top: 1rem; border-top: 1px solid GrayText; }
pre { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
@media print { body { max-width: none; padding: 0; } }
</style></head><body><main>
<h1>MCP dependency notices</h1>
<p>Original license and copyright notices for the MCP integration (SDK 1.32.0).</p>
${articles.join('\n')}
</main></body></html>\n`;
  return { fileName: 'assets/mcp-dependency-notices.html', source };
}

export function mcpNoticesPlugin(root: string): Plugin {
  return {
    name: 'mcp-dependency-notices',
    async generateBundle() {
      this.emitFile({ type: 'asset', ...(await emitMcpNotices(root)) });
    },
  };
}
