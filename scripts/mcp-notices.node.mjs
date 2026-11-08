import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readFile,
  mkdtemp,
  cp,
  writeFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { emitMcpNotices } from '../vite-plugins/mcp-notices.mts';

const root = resolve(import.meta.dirname, '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const bindingPath = 'licenses/mcp/binding.json';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pear-mcp-notices-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ['licenses', 'patches', 'package.json', 'pnpm-lock.yaml'])
    await cp(join(root, file), join(dir, file), { recursive: true });
  const binding = JSON.parse(await readFile(join(dir, bindingPath), 'utf8'));
  const save = () => writeFile(join(dir, bindingPath), JSON.stringify(binding));
  return { dir, binding, save };
}

test('accepted SDK94 emits deterministic escaped offline HTML within packaged assets', async () => {
  const first = await emitMcpNotices(root);
  assert.deepEqual(first, await emitMcpNotices(root));
  assert.equal(first.fileName, 'assets/mcp-dependency-notices.html');
  assert.equal((first.source.match(/<article /g) ?? []).length, 94);
  assert.match(first.source, /Content-Security-Policy/);
  assert.match(first.source, /script-src 'none'/);
  assert.match(first.source, /MCP dependency notices/);
  const introduction = first.source
    .split('<h1>MCP dependency notices</h1>')[1]
    .split('<article ')[0];
  assert.equal(
    introduction.trim(),
    '<p>Original license and copyright notices for the MCP integration (SDK 1.32.0).</p>',
  );
  assert.doesNotMatch(first.source, /<script|\s(?:src|href)=/);
  const packaging = await readFile(join(root, 'electron-builder.yml'), 'utf8');
  assert.match(packaging, /- dist/);
});

test('wrong notice SHA and a missing original are refused', async (t) => {
  const { dir, binding, save } = await fixture(t);
  const record = binding.records[0];
  record.noticeSha256 = '0'.repeat(64);
  await save();
  await assert.rejects(emitMcpNotices(dir), /notice hash/);
  await rm(join(dir, 'licenses/mcp', record.noticeFile));
  await assert.rejects(emitMcpNotices(dir), /ENOENT/);
});

test('exact-version dependency provenance cannot drift from the reviewed source binding', async (t) => {
  const { dir } = await fixture(t);
  for (const file of ['sdk-1.32.0.json', 'body-parser-2.4.0.json']) {
    const source = join(dir, 'licenses/mcp/sources', file);
    const original = await readFile(source, 'utf8');
    await writeFile(source, original + ' ');
    await assert.rejects(emitMcpNotices(dir), /source provenance hash/);
    await writeFile(source, original);
  }
});

test('Windows CRLF checkout preserves semantic SDK metadata without normalizing original notices', async (t) => {
  const { dir } = await fixture(t);
  for (const file of [
    'pnpm-lock.yaml',
    'licenses/mcp/sources/sdk-1.32.0.json',
    'licenses/mcp/sources/body-parser-2.4.0.json',
  ]) {
    const target = join(dir, file);
    await writeFile(
      target,
      (await readFile(target, 'utf8')).replace(/\r?\n/g, '\r\n'),
    );
  }
  assert.deepEqual(await emitMcpNotices(dir), await emitMcpNotices(root));
});

test('missing or ambiguous graph records and changed SDK snapshot blocks are refused', async (t) => {
  const { dir, binding, save } = await fixture(t);
  binding.records.pop();
  await save();
  await assert.rejects(emitMcpNotices(dir), /94|graph/);
  binding.records.push(binding.records[0]);
  await save();
  await assert.rejects(emitMcpNotices(dir), /duplicate|ambiguous/);
});

test('path escapes and symlinked notice files are refused', async (t) => {
  const { dir, binding, save } = await fixture(t);
  const original = binding.records[0].noticeFile;
  binding.records[0].noticeFile = '../package.json';
  await save();
  await assert.rejects(emitMcpNotices(dir), /notice path/);
  binding.records[0].noticeFile = original;
  await save();
  const file = join(dir, 'licenses/mcp', original);
  await rm(file);
  await symlink(join(root, 'licenses/mcp', original), file);
  await assert.rejects(emitMcpNotices(dir), /notice path|symlink/);
});

test('HTML special characters remain selectable text rather than markup', async (t) => {
  const { dir, binding, save } = await fixture(t);
  const bytes = Buffer.from('<script>alert("x")</script> & <tag>\n');
  binding.records[0].noticeSha256 = digest(bytes);
  binding.records[0].noticeBytes = bytes.length;
  await writeFile(
    join(dir, 'licenses/mcp', binding.records[0].noticeFile),
    bytes,
  );
  await save();
  const result = await emitMcpNotices(dir);
  assert.match(
    result.source,
    /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &lt;tag&gt;/,
  );
  assert.doesNotMatch(result.source, /<script>/);
});

test('unrelated builder/dev lock changes do not invalidate SDK binding', async (t) => {
  const { dir } = await fixture(t);
  const lock = join(dir, 'pnpm-lock.yaml');
  const source = await readFile(lock, 'utf8');
  await writeFile(
    lock,
    source.replace(
      /(  app-builder-lib@[^\n]+\n)/,
      '$1    # unrelated builder qualification\n',
    ),
  );
  assert.deepEqual(await emitMcpNotices(dir), await emitMcpNotices(root));
});

test('SDK lock edits, missing peer snapshots and removed declared edges fail closed', async (t) => {
  const { dir, binding } = await fixture(t);
  const lock = join(dir, 'pnpm-lock.yaml');
  const source = await readFile(lock, 'utf8');
  const key = binding.graph.rootSnapshot;
  await writeFile(
    lock,
    source.replace(`  '${key}':\n`, `  '${key}':\n    # graph changed\n`),
  );
  await assert.rejects(emitMcpNotices(dir), /snapshot hash/);
});

test('deleted graph nodes, edges and peer references are refused independently', async (t) => {
  const { dir, binding, save } = await fixture(t);
  const original = structuredClone(binding.graph);
  binding.graph.snapshots.pop();
  await save();
  await assert.rejects(emitMcpNotices(dir), /graph nodes/);
  binding.graph = structuredClone(original);
  binding.graph.edges.pop();
  await save();
  await assert.rejects(emitMcpNotices(dir), /graph edges/);
  binding.graph = structuredClone(original);
  binding.graph.peerContexts.pop();
  await save();
  await assert.rejects(emitMcpNotices(dir), /peer-context graph/);
});

test('missing current peer snapshot and changed SDK patch fail closed', async (t) => {
  const { dir, binding } = await fixture(t);
  const lock = join(dir, 'pnpm-lock.yaml');
  const text = await readFile(lock, 'utf8');
  const peer = binding.graph.peerContexts[0].exact_snapshot_target;
  // Rename only the snapshot block, leaving the package record untouched.
  const offset = text.indexOf('\nsnapshots:\n');
  const tail = text.slice(offset);
  const renamed = tail.replace(`  ${peer}:`, `  ${peer}-missing:`);
  assert.notEqual(renamed, tail);
  await writeFile(lock, text.slice(0, offset) + renamed);
  await assert.rejects(emitMcpNotices(dir), /missing snapshot graph node/);
  await writeFile(lock, text);
  await writeFile(
    join(dir, 'patches/@modelcontextprotocol__sdk@1.32.0.patch'),
    'changed source',
  );
  await assert.rejects(emitMcpNotices(dir), /SDK patch source hash/);
});

test('native integration keeps text out of main code and disables document capabilities', async () => {
  const provider = await readFile(
    join(root, 'src/providers/mcp-notices.ts'),
    'utf8',
  );
  for (const option of [
    'nodeIntegration: false',
    'contextIsolation: true',
    'sandbox: true',
    'javascript: false',
    'webviewTag: false',
    'devTools: false',
    'show: false',
  ])
    assert.ok(provider.includes(option), option);
  assert.doesNotMatch(
    provider,
    /preload:|persist:|readFile|binding\.json|notices\/.*\.txt/,
  );
  const menu = await readFile(join(root, 'src/menu.ts'), 'utf8');
  const entry = menu.indexOf("label: t('main.menu.mcp-dependency-notices')");
  assert.ok(entry > menu.indexOf("submenu: [\n        { role: 'about' }"));
  assert.ok(entry < menu.indexOf("if (process.platform === 'darwin')"));
  const english = JSON.parse(
    await readFile(join(root, 'src/i18n/resources/en.json'), 'utf8'),
  );
  assert.equal(
    english.main.menu['mcp-dependency-notices'],
    'MCP dependency notices',
  );
});
