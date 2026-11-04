import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { test } from '@playwright/test';

const require = createRequire(import.meta.url);
// Execute the complete owned source, with real filesystem operations except the
// specific unsupported-link/failure boundary under test. No product test hooks.
function load(relative, overrides = {}) {
  const source = stripTypeScriptTypes(
    readFileSync(new URL(relative, import.meta.url), 'utf8'),
  );
  const names = [
    ...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g),
  ].map((m) => m[1]);
  const code = source
    .replace(
      /import ([\s\S]*?) from '([^']+)';/g,
      (_, bindings, id) =>
        `const ${bindings} = require(${JSON.stringify(id)});`,
    )
    .replace(/export (?=(?:async )?(?:function|const|class))/g, '');
  const module = { exports: {} };
  vm.runInThisContext(
    `(function(require,module){${code}\nObject.assign(module.exports,{${names.join(',')}});})`,
  )((id) => overrides[id] ?? require(id), module);
  return module.exports;
}
const audio = load('../src/plugins/downloader/audio.ts');
const input = {
  videoId: 'publication-fixture',
  source: audio.describeAudioFormats([
    {
      itag: 251,
      mime_type: 'audio/webm; codecs="opus"',
      has_audio: true,
      has_video: false,
      content_length: 3,
    },
  ])[0],
  output: { extension: 'webm', args: ['-acodec', 'copy'] },
  policy: 'save-variant',
};
const bytes = Buffer.from('finished audio');
const errno = (code) => Object.assign(new Error(`injected ${code}`), { code });
const index = '.pear-desktop-library.json';
async function fixture(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pear-publication-'));
  const library = load('../src/plugins/downloader/library.ts', {
    './audio': audio,
    'node:fs/promises': {
      ...fs,
      link: async () => {
        throw errno(options.code ?? 'ENOTSUP');
      },
      ...options.operations,
    },
  });
  try {
    await fn({
      root,
      library,
      save: (guard = () => {}) =>
        library.publishCompleted(root, root, 'Track.webm', bytes, input, guard),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function noReceipt(root) {
  await assert.rejects(fs.readFile(path.join(root, index)), { code: 'ENOENT' });
}

for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM']) {
  test(`publishes and verifies processed audio when hard links fail with ${code}`, async () => {
    await fixture(
      async ({ root, library, save }) => {
        const saved = await save();
        assert.equal(saved.status, 'saved');
        assert.deepEqual(await fs.readFile(saved.path), bytes);
        assert.equal(
          (await library.scanLibrary(root)).files[0].status,
          'complete',
        );
        assert.deepEqual(
          (await fs.readdir(root)).sort(),
          [index, 'Track.webm'].sort(),
        );
      },
      { code },
    );
  });
}

for (const code of ['EACCES', 'EIO', 'ENOSPC', 'EXDEV']) {
  test(`does not hide unrelated link error ${code} with a fallback`, async () => {
    await fixture(
      async ({ root, save }) => {
        await assert.rejects(save(), { code });
        assert.deepEqual(await fs.readdir(root), []);
      },
      { code },
    );
  });
}

for (const collision of ['file', 'symlink']) {
  test(`no-hardlink publication preserves a pre-existing ${collision} and concurrent variant policy`, async () => {
    await fixture(async ({ root, save, library }) => {
      const prior = path.join(root, 'prior.webm');
      await fs.writeFile(prior, 'unrelated prior');
      if (collision === 'symlink')
        await fs.symlink(prior, path.join(root, 'Track.webm'));
      else await fs.writeFile(path.join(root, 'Track.webm'), 'unrelated title');
      const results = await Promise.all([save(), save()]);
      assert.deepEqual(results.map((r) => r.status).sort(), [
        'saved',
        'skipped',
      ]);
      assert.equal(await fs.readFile(prior, 'utf8'), 'unrelated prior');
      assert.equal(
        await fs.readFile(path.join(root, 'Track.webm'), 'utf8'),
        collision === 'symlink' ? 'unrelated prior' : 'unrelated title',
      );
      assert.equal(
        (await fs.lstat(path.join(root, 'Track.webm'))).isSymbolicLink(),
        collision === 'symlink',
      );
      assert.equal(
        (await library.scanLibrary(root)).files.filter(
          (f) => f.status === 'complete',
        ).length,
        1,
      );
      assert.equal(
        (await fs.readdir(root)).some(
          (name) => name.startsWith('.pear-') && name !== index,
        ),
        false,
      );
    });
  });
}

for (const failure of ['writeFile', 'sync']) {
  for (const replacement of ['none', 'file', 'symlink']) {
    test(`failed fallback ${failure} retains unreceipted candidates safely: ${replacement}`, async () => {
      await fixture(
        async ({ root, save }) => {
          await assert.rejects(save(), { code: 'EIO' });
          await noReceipt(root);
          const names = await fs.readdir(root);
          if (replacement === 'none') {
            assert.deepEqual(names, ['Track.webm']);
            const report = await load('../src/plugins/downloader/library.ts', {
              './audio': audio,
            }).scanLibrary(root);
            assert.equal(report.files[0].status, 'uncertain');
          } else {
            assert.deepEqual(names.sort(), ['Track.webm', 'replacement.webm']);
            assert.equal(
              await fs.readFile(path.join(root, 'Track.webm'), 'utf8'),
              'replacement owner',
            );
            assert.equal(
              (await fs.lstat(path.join(root, 'Track.webm'))).isSymbolicLink(),
              replacement === 'symlink',
            );
          }
        },
        {
          operations: {
            open: async (target, ...args) => {
              const handle = await fs.open(target, ...args);
              if (path.basename(target) !== 'Track.webm') return handle;
              handle[failure] = async () => {
                await handle.write(Buffer.from('partial'));
                if (replacement !== 'none') {
                  const other = path.join(
                    path.dirname(target),
                    'replacement.webm',
                  );
                  await fs.writeFile(other, 'replacement owner');
                  await fs.unlink(target);
                  if (replacement === 'symlink')
                    await fs.symlink(other, target);
                  else await fs.copyFile(other, target);
                }
                throw errno('EIO');
              };
              return handle;
            },
          },
        },
      );
    });
  }
}

test('failed fallback never unlinks a candidate across a foreign-owner race', async () => {
  let candidateUnlinks = 0;
  await fixture(
    async ({ root, save }) => {
      const canonical = await fs.realpath(root);
      await assert.rejects(save(), (error) => {
        assert.equal(error.code, 'EIO');
        assert.equal(error.path, path.join(canonical, 'Track.webm'));
        assert.match(error.message, /incomplete file.*Skip existing files/);
        return true;
      });
      await noReceipt(root);
      assert.equal(candidateUnlinks, 0);
      assert.equal(
        await fs.readFile(path.join(root, 'Track.webm'), 'utf8'),
        'partial',
      );
    },
    {
      operations: {
        open: async (target, ...args) => {
          const handle = await fs.open(target, ...args);
          if (path.basename(target) === 'Track.webm')
            handle.writeFile = async () => {
              await handle.write(Buffer.from('partial'));
              throw errno('EIO');
            };
          return handle;
        },
        unlink: async (target) => {
          if (path.basename(target) === 'Track.webm') {
            candidateUnlinks++;
            // Another owner can replace a path after any preceding lstat.
            await fs.unlink(target);
            await fs.writeFile(target, 'foreign owner');
          }
          return fs.unlink(target);
        },
      },
    },
  );
});

test('fallback publishes no receipt while bytes are partial and verifies only after sync', async () => {
  let scan;
  await fixture(
    async ({ root, save, library }) => {
      scan = library.scanLibrary;
      const saved = await save();
      assert.equal(saved.status, 'saved');
      assert.equal(
        (await library.scanLibrary(root)).files[0].status,
        'complete',
      );
    },
    {
      operations: {
        open: async (target, ...args) => {
          const handle = await fs.open(target, ...args);
          if (path.basename(target) !== 'Track.webm') return handle;
          const writeFile = handle.writeFile.bind(handle);
          handle.writeFile = async (data) => {
            await handle.write(data.subarray(0, 3), 0, 3, 0);
            await noReceipt(path.dirname(target));
            const report = await scan(path.dirname(target));
            assert.equal(report.files[0].status, 'uncertain');
            assert.equal(report.files[0].size, 3);
            await writeFile(data);
          };
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await noReceipt(path.dirname(target));
            // Full bytes can be visible during fallback, but have no completion receipt.
            assert.deepEqual(await fs.readFile(target), bytes);
            await sync();
          };
          return handle;
        },
      },
    },
  );
});

for (const boundary of ['link', 'open', 'sync']) {
  test(`retirement at fallback ${boundary} leaves no receipt and retains opened candidates`, async () => {
    let retired = false;
    await fixture(
      async ({ root, save }) => {
        await assert.rejects(
          save(() => {
            if (retired) throw new Error('owned backend retired');
          }),
          /owned backend retired/,
        );
        assert.deepEqual(
          await fs.readdir(root),
          boundary === 'link' ? [] : ['Track.webm'],
        );
      },
      {
        operations: {
          link: async () => {
            if (boundary === 'link') retired = true;
            throw errno('ENOTSUP');
          },
          open: async (target, ...args) => {
            const handle = await fs.open(target, ...args);
            if (path.basename(target) === 'Track.webm') {
              if (boundary === 'open') retired = true;
              if (boundary === 'sync') {
                const sync = handle.sync.bind(handle);
                handle.sync = async () => {
                  await sync();
                  retired = true;
                };
              }
            }
            return handle;
          },
        },
      },
    );
  });
}

test('hardlink-capable publication keeps complete atomic audio visibility', async () => {
  await fixture(
    async ({ root, save }) => {
      const result = await save();
      assert.deepEqual(await fs.readFile(result.path), bytes);
      assert.deepEqual(
        (await fs.readdir(root)).sort(),
        [index, 'Track.webm'].sort(),
      );
    },
    {
      operations: {
        link: fs.link,
        open: async (target, ...args) => {
          assert.notEqual(path.basename(target), 'Track.webm');
          return fs.open(target, ...args);
        },
      },
    },
  );
});

test('successful fallback refuses a replaced output identity without recording it', async () => {
  await fixture(
    async ({ root, save }) => {
      await assert.rejects(save(), /changed|replaced/i);
      await noReceipt(root);
      assert.equal(
        await fs.readFile(path.join(root, 'Track.webm'), 'utf8'),
        'replacement owner',
      );
      assert.deepEqual(await fs.readdir(root), ['Track.webm']);
    },
    {
      operations: {
        open: async (target, ...args) => {
          const handle = await fs.open(target, ...args);
          if (path.basename(target) === 'Track.webm') {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              await sync();
              await fs.unlink(target);
              await fs.writeFile(target, 'replacement owner');
            };
          }
          return handle;
        },
      },
    },
  );
});

test('no-hardlink manifest failure retains finished audio as uncertain with no false success', async () => {
  await fixture(async ({ root, save, library }) => {
    await fs.mkdir(path.join(root, index));
    await assert.rejects(save(), /index|manifest/i);
    assert.deepEqual(await fs.readFile(path.join(root, 'Track.webm')), bytes);
    assert.equal(
      (await library.scanLibrary(root)).files[0].status,
      'uncertain',
    );
    assert.deepEqual(
      (await fs.readdir(root)).sort(),
      [index, 'Track.webm'].sort(),
    );
  });
});
