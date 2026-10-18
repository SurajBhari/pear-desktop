import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import { test } from '@playwright/test';

const source = readFileSync(
  new URL('../src/plugins/downloader/library.ts', import.meta.url),
  'utf8',
);
const start = source.indexOf('export async function scanLibrary(');
const end = source.indexOf('export async function publishCompleted(', start);
assert(start >= 0 && end > start);
const scanSource = stripTypeScriptTypes(
  source.slice(start, end).replace('export async function', 'async function'),
);
const plain = (value) => JSON.parse(JSON.stringify(value));
function record(file, videoId, size = 4) {
  return {
    path: file,
    videoId,
    size,
    sha256: 'a'.repeat(64),
    variant: 'b'.repeat(64),
    completedAt: '2026-10-18T00:00:00.000Z',
    source: {
      key: videoId,
      codec: 'opus',
      language: 'en',
      length: 12000,
      supported: true,
    },
    output: { extension: 'webm', args: [] },
  };
}
function harness(records = []) {
  const h = {
    records,
    nodes: new Map(),
    directories: new Map([['', []]]),
    relocations: new Map(),
    hashes: [],
    progress: [],
    indexErrors: [],
    hashHook: undefined,
    statOverride: undefined,
    openFailures: new Set(),
    opened: 0,
    closed: 0,
    metadataBytes: [],
    tags: {},
  };
  let serial = 1n;
  h.nodes.set('', { kind: 'directory', ino: serial++, dev: 1n, size: 0n });
  h.add = (name, size = 4, kind = 'file') => {
    const parent =
      path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
    assert(h.directories.has(parent));
    h.directories.get(parent).push(path.posix.basename(name));
    h.nodes.set(name, { kind, ino: serial++, dev: 1n, size: BigInt(size) });
    if (kind === 'directory') h.directories.set(name, []);
    return h;
  };
  const relative = (full) => path.posix.relative('/library', full);
  const stat = (name, opened = false) => {
    const node =
      opened && h.statOverride
        ? h.statOverride(name, h.nodes.get(name))
        : h.nodes.get(name);
    if (!node) throw Error('unreadable fake entry');
    return {
      ino: node.ino,
      dev: node.dev,
      size: node.size,
      isDirectory: () => node.kind === 'directory',
      isFile: () => node.kind === 'file',
      isSymbolicLink: () => node.kind === 'symlink',
    };
  };
  const handle = (name) => ({
    stat: async () => stat(name, true),
    read: async (_buffer, _offset, length) => {
      h.metadataBytes.push(length);
      return { bytesRead: length };
    },
    close: async () => {
      h.closed++;
    },
  });
  const context = {
    Error,
    Buffer,
    INDEX: '.pear-desktop-library.json',
    MAX_VERIFY_BYTES: 512 * 1024 * 1024,
    path: path.posix,
    noFollow: 0,
    relocations: h.relocations,
    lstat: async (full) => stat(relative(full)),
    canonicalRoot: async (root) => {
      assert.equal(root, '/library');
      return root;
    },
    contained: async (root, target) => {
      assert.equal(root, '/library');
      assert(!relative(target).startsWith('..'));
      return target;
    },
    readIndex: async (_root, validate) => {
      await validate();
      return { records: h.records, errors: [...h.indexErrors] };
    },
    opendir: async (full) => {
      const names = h.directories.get(relative(full));
      if (!names) throw Error('unreadable fake folder');
      return {
        async *[Symbol.asyncIterator]() {
          for (const name of names) yield { name };
        },
      };
    },
    hashFile: async (root, current, assertCurrent, limit, validate) => {
      assert.equal(root, '/library');
      assertCurrent();
      h.hashes.push({ path: current.path, videoId: current.videoId, limit });
      await validate(handle(current.path));
      return h.hashHook ? h.hashHook(current, limit) : true;
    },
    open: async (full) => {
      const name = relative(full);
      if (h.openFailures.has(name)) throw Error('metadata open failed');
      h.opened++;
      return handle(name);
    },
    NodeID3: { read: (buffer) => (buffer.length ? h.tags : {}) },
    setImmediate: (callback) => callback(),
  };
  h.scan = vm.runInNewContext(scanSource + '\nscanLibrary;', context);
  h.run = (options = {}) =>
    h.scan('/library', {
      onProgress: (visited) => h.progress.push(visited),
      ...options,
    });
  return h;
}

test('actual scan lookup record accesses stay linear for indexed and unindexed files', async () => {
  const files = 256,
    count = 256,
    reads = { path: 0, size: 0 };
  const records = Array.from({ length: count }, (_, n) => {
    const value = record('track-' + n + '.webm', 'v' + n, 1024),
      file = value.path,
      size = value.size;
    Object.defineProperties(value, {
      path: {
        enumerable: true,
        get: () => {
          reads.path++;
          return file;
        },
      },
      size: {
        enumerable: true,
        get: () => {
          reads.size++;
          return size;
        },
      },
    });
    return value;
  });
  const h = harness(records);
  for (let n = 0; n < files / 2; n++)
    h.add('track-' + (count - 1 - n) + '.webm', 1024);
  for (let n = 0; n < files / 2; n++) h.add('new-' + n + '.webm', 2048);
  const report = await h.run({ maxVerifyBytes: 0 });
  assert.equal(report.visited, files);
  assert.equal(report.files.length, files);
  assert.equal(report.truncated, true);
  assert.equal(report.files.filter((row) => row.videoId).length, files / 2);
  assert.equal(h.hashes.length, 0);
  const bound = 8 * (files + count),
    total = reads.path + reads.size;
  console.log(
    'SCAN_LOOKUP_ACCESSES',
    JSON.stringify({ files, records: count, ...reads, total, bound }),
  );
  assert(
    total <= bound,
    'Actual scan record accesses exceed linear bound: ' +
      JSON.stringify({ ...reads, total, bound }),
  );
});
test('duplicate indexed paths retain first record identity and verification result', async () => {
  const h = harness([
    record('same.webm', 'first'),
    record('same.webm', 'second'),
  ]);
  h.add('same.webm');
  h.hashHook = (current) => current.videoId === 'first';
  const report = await h.run({ maxVerifyBytes: 8 });
  assert.deepEqual(plain(report.files), [
    {
      path: 'same.webm',
      size: 4,
      status: 'complete',
      videoId: 'first',
      source: h.records[0].source,
    },
  ]);
  assert.deepEqual(
    h.hashes.map((value) => value.videoId),
    ['first'],
  );
  assert.equal(report.truncated, false);
});
test('same-size buckets retain manifest order and duplicate candidates for relocation', async () => {
  const h = harness([
    record('old.webm', 'first'),
    record('excluded.webm', 'excluded', 8),
    record('old.webm', 'second'),
    record('later.webm', 'later'),
  ]);
  h.add('renamed.webm');
  h.hashHook = (current) => current.videoId === 'second';
  const report = await h.run({ maxVerifyBytes: 8 });
  assert.deepEqual(
    h.hashes.map((value) => [value.videoId, value.limit]),
    [
      ['first', 4],
      ['second', 4],
    ],
  );
  assert.deepEqual(
    plain(report.files).map((row) => [row.path, row.status, row.videoId]),
    [
      ['excluded.webm', 'missing', 'excluded'],
      ['later.webm', 'missing', 'later'],
      ['renamed.webm', 'complete', 'second'],
    ],
  );
  assert.equal(
    report.files[2].reason,
    'Completed receipt verified at renamed path',
  );
  assert.equal(h.relocations.get('/library').get('old.webm'), 'renamed.webm');
  assert.equal(report.truncated, false);
});
test('candidate verification consumes the same budget and suppresses missing rows when truncated', async () => {
  const h = harness([record('old-a.webm', 'a'), record('old-b.webm', 'b')]);
  h.add('new.webm');
  h.hashHook = () => false;
  const report = await h.run({ maxVerifyBytes: 4 });
  assert.deepEqual(plain(report.files), [
    {
      path: 'new.webm',
      size: 4,
      status: 'uncertain',
      reason: 'Unindexed: source/completion unknown',
    },
  ]);
  assert.deepEqual(
    h.hashes.map((value) => value.videoId),
    ['a'],
  );
  assert.equal(report.truncated, true);
});
test('indexed verification keeps complete changed and thrown-hash report semantics', async () => {
  for (const mode of ['complete', 'different', 'throw']) {
    const h = harness([record('track.webm', 'track')]);
    h.add('track.webm');
    h.hashHook = () => {
      if (mode === 'throw') throw Error('hash failure');
      return mode === 'complete';
    };
    const report = await h.run({ maxVerifyBytes: 4 }),
      row = report.files[0];
    assert.equal(row.videoId, 'track');
    assert.equal(row.status, mode === 'complete' ? 'complete' : 'changed');
    assert.equal(
      row.reason,
      mode === 'complete'
        ? undefined
        : mode === 'different'
          ? 'File differs from completed record'
          : 'Unindexed: source/completion unknown',
    );
    assert.equal(report.truncated, false);
  }
});
test('missing entries sorting errors and progress retain their actual report shapes', async () => {
  const h = harness([record('z.webm', 'missing'), record('b.webm', 'present')]);
  h.add('c.webm', 8).add('b.webm').add('a.webm', 0);
  h.indexErrors = ['Invalid manifest records ignored'];
  const report = await h.run({ maxVerifyBytes: 4 });
  assert.deepEqual(
    plain(report.files).map((row) => [
      row.path,
      row.status,
      row.videoId ?? null,
    ]),
    [
      ['a.webm', 'invalid', null],
      ['b.webm', 'complete', 'present'],
      ['c.webm', 'uncertain', null],
      ['z.webm', 'missing', 'missing'],
    ],
  );
  assert.deepEqual(plain(report.errors), h.indexErrors);
  assert.deepEqual(h.progress, [1, 2, 3]);
  assert.equal(report.visited, 3);
  assert.equal(report.truncated, false);
});
test('pre-cancelled scans reject without file verification or relocation publication', async () => {
  const h = harness([record('track.webm', 'track')]);
  h.add('track.webm');
  await assert.rejects(
    h.run({ signal: AbortSignal.abort() }),
    /Library scan cancelled/,
  );
  assert.equal(h.hashes.length, 0);
  assert.equal(h.relocations.size, 0);
});
test('cancellation after progress prevents later verification and relocation publication', async () => {
  const h = harness([record('one.webm', 'one'), record('two.webm', 'two')]);
  h.add('one.webm').add('two.webm');
  const controller = new AbortController();
  await assert.rejects(
    h.run({ signal: controller.signal, onProgress: () => controller.abort() }),
    /Library scan cancelled/,
  );
  assert.deepEqual(
    h.hashes.map((value) => value.videoId),
    ['one'],
  );
  assert.equal(h.relocations.size, 0);
});
test('lookup state is rebuilt for each scan rather than retaining a previous manifest', async () => {
  const h = harness([record('track.webm', 'before')]);
  h.add('track.webm');
  assert.equal((await h.run()).files[0].videoId, 'before');
  h.records = [record('track.webm', 'after')];
  assert.equal((await h.run()).files[0].videoId, 'after');
  assert.deepEqual(
    h.hashes.map((value) => value.videoId),
    ['before', 'after'],
  );
});
test('symlink hidden unsupported and unreadable entries keep the existing traversal guards', async () => {
  const h = harness([record('valid.webm', 'valid')]);
  h.add('link.webm', 4, 'symlink')
    .add('.pear-private.webm')
    .add('.pear-desktop-library.json')
    .add('notes.txt')
    .add('bad.webm')
    .add('valid.webm');
  h.nodes.delete('bad.webm');
  const report = await h.run();
  assert.deepEqual(
    plain(report.files).map((row) => [row.path, row.status]),
    [['valid.webm', 'complete']],
  );
  assert.deepEqual(plain(report.errors), ['Unreadable library entry']);
  assert.equal(report.visited, 1);
});
test('file depth and entry caps preserve truncation and do not add missing rows', async () => {
  const depth = harness([record('missing.webm', 'missing')]);
  depth
    .add('child', 0, 'directory')
    .add('child/hidden.webm')
    .add('root.webm', 8);
  const report = await depth.run({ maxDepth: 0 });
  assert.equal(report.truncated, true);
  assert.equal(report.visited, 1);
  assert.deepEqual(
    plain(report.files).map((row) => row.path),
    ['root.webm'],
  );
  const files = harness();
  files.add('one.webm', 8).add('two.webm', 8);
  const capped = await files.run({ maxFiles: 1 });
  assert.equal(capped.visited, 1);
  assert.equal(capped.truncated, true);
  const entries = harness();
  for (let n = 0; n < 4; n++) entries.add('junk-' + n + '.txt');
  entries.add('late.webm');
  const limited = await entries.run({ maxFiles: 1 });
  assert.equal(limited.visited, 0);
  assert.equal(limited.truncated, true);
  assert.equal(limited.files.length, 0);
});
test('changed or symlinked directory identity stops remaining child entries', async () => {
  for (const change of ['inode', 'symlink']) {
    const h = harness();
    h.add('child', 0, 'directory')
      .add('child/one.webm', 8)
      .add('child/two.webm', 8);
    const report = await h.run({
      onProgress: () => {
        const node = h.nodes.get('child');
        if (change === 'inode') node.ino += 100n;
        else node.kind = 'symlink';
      },
    });
    assert.equal(report.visited, 1);
    assert.deepEqual(
      plain(report.files).map((row) => row.path),
      ['child/one.webm'],
    );
    assert.deepEqual(plain(report.errors), [
      'Library directory changed or became a symlink during scan; remaining entries skipped',
    ]);
  }
});
test('metadata reads keep their byte budget embedded identity and handle cleanup', async () => {
  for (const budget of [8, 0]) {
    const h = harness();
    h.add('tagged.mp3', 16);
    h.tags = {
      userDefinedText: [
        { description: 'pear-desktop:youtube-video-id', value: 'embedded' },
      ],
    };
    const report = await h.run({ maxVerifyBytes: budget }),
      row = report.files[0];
    assert.deepEqual(h.metadataBytes, [budget]);
    assert.equal(h.opened, 1);
    assert.equal(h.closed, 1);
    assert.equal(row.status, 'uncertain');
    assert.equal(row.videoId, budget ? 'embedded' : undefined);
    assert.equal(report.truncated, budget === 0);
    assert.equal(
      row.reason,
      budget
        ? 'Unindexed: source/completion unknown'
        : 'Metadata read budget reached',
    );
  }
});
test('file identity mismatch prevents completed verification and preserves metadata failure handling', async () => {
  const h = harness([record('track.webm', 'track')]);
  h.add('track.webm');
  h.statOverride = (_name, node) => ({ ...node, ino: 999n });
  assert.equal((await h.run()).files[0].status, 'changed');
  const metadata = harness();
  metadata.add('track.mp3', 8);
  metadata.statOverride = (_name, node) => ({ ...node, size: 999n });
  const report = await metadata.run();
  assert.equal(report.files[0].reason, 'Metadata unreadable; preserved');
  assert.equal(metadata.closed, 1);
  assert.equal(metadata.metadataBytes.length, 0);
});
