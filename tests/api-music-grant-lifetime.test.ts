import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';

// These tests catch publication before commit, missed committed retirement,
// revived epochs, and terminal authority re-entry. The application is never
// imported: actual source classes run with only the virtual boundary below.
const root = process.env.PEAR_SOURCE_ROOT ?? process.cwd();
const sourceHashes: Record<string, { original: string; transformed: string }> = {};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const resource = 'http://127.0.0.1:26538/api/v1/music';
const backend = 'src/plugins/api-server/backend/';
const typesPath = 'src/plugins/api-server/music-types.ts';
const noop = () => {};
const unexpected = () => { throw Error('Unexpected dependency call'); };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const code = (expected: string) => (error: any) => error?.code === expected;

function environment(platform = 'linux') {
  let clock = 1000, sequence = 0;
  const timers = new Set<any>();
  const context = vm.createContext({
    AbortController, AbortSignal, Buffer, URL, TextEncoder, structuredClone,
    Date: Object.freeze({ now: () => clock }),
    setTimeout: (run: () => void, delay: number) => {
      const timer = { run, at: clock + delay, unref: noop };
      timers.add(timer); return timer;
    },
    clearTimeout: (timer: any) => timers.delete(timer),
    process: Object.freeze({ platform, getuid: () => 1000 }),
  }, { codeGeneration: { strings: false, wasm: false } });
  const crypto = {
    createHash, timingSafeEqual,
    randomUUID: () => `00000000-0000-4000-8000-${(++sequence).toString().padStart(12, '0')}`,
    randomBytes: (length: number) => Buffer.alloc(length, ++sequence),
  };
  const load = (file: string, imports: Record<string, any>) => {
    const original = readFileSync(path.join(root, file), 'utf8');
    const stripped = stripTypeScriptTypes(original, { mode: 'transform' });
    const seen = new Set<string>();
    let source = stripped.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,
      (_all, bindings: string, specifier: string) => {
        assert.ok(Object.hasOwn(imports, specifier), `Unapproved import ${file}: ${specifier}`);
        assert.ok(!seen.has(specifier), `Duplicate import ${specifier}`);
        seen.add(specifier);
        const names = bindings.split(',').map(s => s.trim()).filter(Boolean);
        for (const binding of names) {
          const name = binding.split(/\s+as\s+/)[0];
          assert.ok(Object.hasOwn(imports[specifier], name), `Unapproved binding ${specifier}:${name}`);
        }
        return `const {${names.map(s => s.replace(/\s+as\s+/, ':')).join(',')}} = __imports[${JSON.stringify(specifier)}];`;
      });
    source = source.replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g,
      (_all, name: string, specifier: string) => {
        assert.ok(Object.hasOwn(imports, specifier), `Unapproved default import ${specifier}`);
        assert.ok(!seen.has(specifier)); seen.add(specifier);
        return `const ${name} = __imports[${JSON.stringify(specifier)}];`;
      });
    assert.deepEqual([...seen].sort(), Object.keys(imports).sort(), `Import shape ${file}`);
    const exports = [...source.matchAll(/export\s+(?:class|function|const)\s+(\w+)/g)].map(m => m[1]);
    source = source.replace(/export\s+(?=class|function|const)/g, '').replace(/export\s*\{\s*\};?/g, '');
    assert.ok(!/\b(?:import|export)\s/.test(source), `Unexpected module shape ${file}`);
    source = `(function(__imports){'use strict';\n${source}\nreturn {${exports.join(',')}};})`;
    sourceHashes[file] = { original: hash(original), transformed: hash(source) };
    return new vm.Script(source, { filename: file }).runInContext(context)(imports);
  };
  const types = load(typesPath, {});
  const grants = load(backend + 'music-grants.ts', { 'node:crypto': crypto, '../music-types': types });
  const access = load(backend + 'music-access.ts', {});
  const operations = load(backend + 'music-operations.ts', {
    'node:crypto': crypto, './music-access': access, './music-grants': grants, '../music-types': types,
  });
  const filesystem: any = {
    directory: false, contents: null, staged: null, fail: '', events: [] as string[],
    onCommit: undefined,
  };
  const fail = (phase: string) => { if (filesystem.fail === phase) throw Error(phase); };
  const absent = () => Object.assign(Error('missing'), { code: 'ENOENT' });
  const stat = (directory: boolean) => ({
    isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false,
    mode: directory ? 0o700 : 0o600, uid: 1000, nlink: 1,
    size: Buffer.byteLength(filesystem.contents ?? ''),
  });
  const publish = () => {
    fail('commit'); filesystem.events.push('commit');
    filesystem.contents = filesystem.staged; filesystem.directory = true;
    filesystem.onCommit?.();
  };
  const virtual = {
    lstat: async () => { fail('read'); if (!filesystem.directory) throw absent(); return stat(true); },
    mkdir: async () => { fail('stage'); filesystem.directory = true; },
    open: async (file: string, flags: any) => {
      const write = flags === 'wx';
      fail(write ? 'stage' : 'read');
      if (!write && filesystem.contents === null) throw absent();
      return {
        stat: async () => { fail('stat'); return stat(false); },
        readFile: async () => filesystem.contents,
        writeFile: async (content: string) => { fail('write'); filesystem.staged = content; },
        sync: async () => { fail('sync'); },
        close: async () => { fail(write ? 'stageClose' : 'readClose'); },
      };
    },
    rename: async () => publish(),
    unlink: async () => { filesystem.staged = null; },
  };
  const windows = {
    read: async () => { fail('read'); return { contents: filesystem.contents, binding: 'initial' }; },
    stage: async (_directory: string, content: string) => {
      fail('stage'); filesystem.staged = content;
      return { commit: async () => { publish(); return 'next'; }, close: async () => { fail('preparedClose'); } };
    },
  };
  const storeModule = load(backend + 'music-grant-store.ts', {
    'node:crypto': crypto,
    'node:fs': { constants: { O_RDONLY: 0, O_NOFOLLOW: 0 } },
    'node:fs/promises': virtual,
    'node:path': { join: (...parts: string[]) => parts.join('/') },
    './music-grants': grants,
    './windows-private-path': { createWindowsPrivatePath: () => windows },
    '../music-types': types,
  });
  const store = new storeModule.MusicGrantStore('/virtual', () => clock);
  return {
    context, load, types, grants, access, operations, storeModule, store, filesystem,
    crypto, timers, now: () => clock,
    setTime: (time: number) => { clock = time; },
    fire: () => { const due = [...timers].filter(t => t.at <= clock); for (const timer of due) { timers.delete(timer); timer.run(); } },
    issue: (name = 'First', scopes = ['catalog.read']) => store.issue(name, 'rest', resource, scopes, () => true),
    authorize: (token: string, scope = 'catalog.read') => store.authorize(token, 'rest', resource, scope),
    signal: (lease: any, ownStore = store) => storeModule.musicGrantLifetimeSignal?.(ownStore, lease),
  };
}

async function admissionFixture(
  scopes = ['catalog.read', 'playback.read'],
  transport: 'rest' | 'mcp' = 'mcp',
) {
  const f = environment();
  const grant = await f.store.issue('Admission', transport, resource, scopes, () => true);
  const counts = { owner: 0, resolver: 0, broker: 0, grant: 0, action: 0 };
  let live = true, ownerLive = true;
  const owner = { identity: {}, current: () => { counts.owner++; return ownerLive; } };
  let selected = owner;
  const retirement = new Set<() => void>();
  const admission = { frame: {}, generation: 0 };
  const broker: any = {
    capture: () => admission,
    isCurrent: () => { counts.broker++; return live; },
    subscribeRetirement: (callback: () => void) => { retirement.add(callback); return () => retirement.delete(callback); },
    retain: () => noop,
    read: unexpected,
    resultOwner: unexpected,
  };
  const policy = f.load(backend + 'music-http-policy.ts', {
    'node:net': { isIP: (value: string) => value === '127.0.0.1' ? 4 : 0 },
    './music-grants': f.grants, '../music-types': f.types,
  });
  const scheme = Object.fromEntries([
    'parseMusicInput','parseMusicCommentsInput','parseNativeCommentsMetadata',
    'parseMusicLyricsInput','parseMusicRelatedInput','parseNativeLyricsMetadata',
    'parseNativeRelatedMetadata','parseNativeMetadataProbe','parseMusicQueueInput',
    'parseMusicCollectionInput','parseNativeQueue','parseNativeCatalog','parseNativeSnapshot',
    'parseMusicOperationPrepareInput','parseMusicControlMutationInput','parseMusicQueueMutationInput',
    'parseMusicMutationInput','parseMusicOperationId',
  ].map(name => [name, unexpected]));
  // Receipt tests provide only the literal valid input below. Schema validation
  // is an injected guard boundary here, not part of these source-logic tests.
  scheme.parseMusicOperationPrepareInput = structuredClone;
  scheme.parseMusicMutationInput = structuredClone;
  scheme.parseMusicOperationId = (value: any) => value;
  const imports: Record<string, any> = {
    'node:crypto': f.crypto,
    '@/providers/music-catalog': { sliceMusicSource: unexpected },
    '@/providers/music-comments': { loadComments: unexpected },
    '@/providers/music-request': { createMusicRequestBroker: unexpected },
    './music-access': f.access,
    './music-comments-web': { createPublicCommentsWeb: unexpected },
    './music-http-policy': policy,
    './music-operations': f.operations,
    './scheme/music': scheme,
    '../music-types': f.types,
  };
  // The admitted RED source has only a type import; GREEN introduces the value.
  const serviceSource = readFileSync(path.join(root, backend + 'music-service.ts'), 'utf8');
  if (serviceSource.includes('musicGrantLifetimeSignal')) imports['./music-grant-store'] = f.storeModule;
  const module = f.load(backend + 'music-service.ts', imports);
  const originalCurrent = f.store.isCurrent.bind(f.store);
  f.store.isCurrent = (...args: any[]) => { counts.grant++; return originalCurrent(...args); };
  const listenerLifetime = new AbortController();
  const listener = {
    identity: {}, address: '127.0.0.1', port: 26538, tls: false,
    resources: Object.freeze({ local: resource }), signal: listenerLifetime.signal,
    current: () => { counts.owner++; return !listenerLifetime.signal.aborted; },
    ownsSocket: () => true,
  };
  const service = new module.MusicService({
    window: {}, config: { enabled: true, musicApiEnabled: true, hostname: '127.0.0.1', port: 26538, useHttps: false },
    grants: f.store, broker, commentsWeb: { dispose: noop }, now: f.now,
    resolveAccessOwner: () => { counts.resolver++; return selected; },
    ...(transport === 'rest' ? {
      restListenerOwner: () => { counts.resolver++; return listener; },
    } : {}),
  });
  const session = { id: 'session', current: () => true };
  const request = new AbortController();
  const invocation = {
    token: grant.token, transport, resource, signal: request.signal,
    ...(transport === 'mcp' ? { session } : {}),
  };
  let lease: any;
  const start = (extra: string[] = [], override: any = {}) => {
    const promise = service.admittedFor({ ...invocation, ...override }, 'catalog.read', extra, true,
      (value: any) => { counts.action++; lease = value; return new Promise(noop); });
    // Attach immediately: deterministic tests intentionally settle in later turns.
    const result = promise.then((value: any) => value, (error: any) => error);
    return result;
  };
  return {
    ...f, service, grant, counts, session, request, invocation, owner, broker,
    start, lease: () => lease,
    silentRetire: () => { live = false; },
    retireObserved: () => { live = false; for (const callback of retirement) callback(); },
    replaceOwner: () => { selected = { identity: {}, current: () => true }; },
    falseOwner: () => { ownerLive = false; },
    retireListener: () => listenerLifetime.abort(),
    restoreOwner: () => { ownerLive = true; selected = owner; live = true; },
  };
}

test('committed targeted revoke retires the exact authorized epoch', async () => {
  const f = environment();
  const grant = await f.issue();
  const lease = await f.authorize(grant.token);
  const signal = f.signal(lease);
  assert.ok(signal, 'authorize must bind a main-only lifetime signal');
  assert.equal(signal.aborted, false);
  await f.store.revoke(grant.record.id, () => true);
  assert.equal(signal.aborted, true);
  await assert.rejects(f.authorize(grant.token), code('unauthorized'));
});

for (const platform of ['linux', 'win32']) {
  test(`${platform}: commit publishes targeted retirement before generic observers`, async () => {
    const f = environment(platform);
    const first = await f.issue(), other = await f.issue('Other');
    const lease = await f.authorize(first.token), otherLease = await f.authorize(other.token);
    const signal = f.signal(lease), otherSignal = f.signal(otherLease);
    assert.ok(signal); assert.ok(otherSignal);
    let observed = 0;
    signal.addEventListener('abort', () => {
      assert.equal(f.store.isCurrent(lease, 'catalog.read'), false);
      assert.equal(f.store.isCurrent(otherLease, 'catalog.read'), true);
      observed++;
    });
    f.store.subscribe(() => {
      assert.equal(signal.aborted, true);
      assert.equal(otherSignal.aborted, false);
      assert.equal(observed, 1);
    });
    await f.store.revoke(first.record.id, () => true);
    assert.equal(observed, 1);
    assert.equal(f.signal(await f.authorize(other.token)), otherSignal);
  });

  for (const phase of platform === 'linux' ? ['stage', 'write', 'sync', 'stageClose', 'commit'] : ['stage', 'commit']) {
    test(`${platform}: ${phase} rejection preserves the live committed epoch`, async () => {
      const f = environment(platform), first = await f.issue();
      const lease = await f.authorize(first.token), signal = f.signal(lease);
      assert.ok(signal);
      const before = f.filesystem.contents;
      f.filesystem.fail = phase;
      await assert.rejects(f.store.revoke(first.record.id, () => true), code('unavailable'));
      assert.equal(signal.aborted, false);
      assert.equal(f.filesystem.contents, before);
      assert.equal(f.signal(await f.authorize(first.token)), signal);
    });
  }

  for (const failure of ['observer', ...(platform === 'win32' ? ['preparedClose'] : [])]) {
    test(`${platform}: ${failure} rejection cannot undo a committed retirement`, async () => {
      const f = environment(platform), first = await f.issue();
      const lease = await f.authorize(first.token), signal = f.signal(lease);
      assert.ok(signal);
      if (failure === 'observer') f.store.subscribe(() => { throw Error('ordinary observer'); });
      else f.filesystem.fail = failure;
      await assert.rejects(f.store.revoke(first.record.id, () => true));
      assert.equal(signal.aborted, true);
      assert.equal(JSON.parse(f.filesystem.contents).records.length, 0);
      await assert.rejects(f.authorize(first.token), code('unauthorized'));
    });
  }

  test(`${platform}: failed currentness check before commit preserves the epoch`, async () => {
    const f = environment(platform), first = await f.issue();
    const signal = f.signal(await f.authorize(first.token)); assert.ok(signal);
    let checks = 0;
    await assert.rejects(f.store.revoke(first.record.id, () => ++checks < 3), code('retired'));
    assert.equal(signal.aborted, false);
    assert.equal(f.signal(await f.authorize(first.token)), signal);
  });

  test(`${platform}: rollback retires transient epoch and preserves unrelated epoch`, async () => {
    const f = environment(platform), first = await f.issue();
    const firstSignal = f.signal(await f.authorize(first.token)); assert.ok(firstSignal);
    let transient: any, checks = 0;
    f.store.subscribe(() => {
      const records = (f.store as any).records;
      const added = records.find((r: any) => r.id !== first.record.id);
      if (added && !transient) {
        // Issue rollback is serialized before a later authorize can run; inspect
        // the actual committed epoch, without duplicating publication logic.
        transient = (f.store as any).epochs.get(added.id).controller.signal;
      }
    });
    await assert.rejects(f.store.issue('Transient', 'rest', resource, ['catalog.read'], () => ++checks < 5), code('retired'));
    assert.ok(transient); assert.equal(transient.aborted, true);
    assert.equal(firstSignal.aborted, false);
    assert.equal((await f.store.list()).length, 1);
  });
}

test('lookup requires exact store and exact frozen lease without inspecting getters', async () => {
  const f = environment(), grant = await f.issue();
  const lease = await f.authorize(grant.token), signal = f.signal(lease);
  assert.ok(signal);
  assert.equal(Object.isFrozen(lease), true); assert.equal(Object.isFrozen(lease.scopes), true);
  assert.deepEqual(Object.keys(lease).sort(), ['createdAt','digest','expiresAt','id','name','resource','scopes','transport']);
  assert.equal(f.signal(JSON.parse(JSON.stringify(lease))), undefined);
  assert.equal(f.signal(lease, {}), undefined);
  const hostile = new Proxy({}, { get: () => { throw Error('getter ran'); } });
  assert.equal(f.signal(hostile), undefined);
  assert.equal(f.signal(null), undefined);
  assert.equal(f.signal(undefined), undefined);
  assert.equal(f.signal('unbound'), undefined);
  assert.equal(JSON.stringify(lease), JSON.stringify(grant.record));
});

test('name and scope ordering preserve epochs; authorization changes and restored IDs rotate forever', async () => {
  const f = environment(), grant = await f.issue('First', ['catalog.read', 'playback.read']);
  const original = await f.authorize(grant.token), signal = f.signal(original); assert.ok(signal);
  let records = await f.store.list(); records[0].name = 'Renamed'; records[0].scopes.reverse();
  await (f.store as any).save(records, () => true);
  assert.equal(f.signal(await f.authorize(grant.token)), signal);
  for (const field of ['digest', 'transport', 'resource', 'createdAt', 'expiresAt', 'scopes']) {
    const current = (await f.store.list())[0];
    const currentSignal = (f.store as any).epochs.get(current.id).controller.signal;
    const changed = structuredClone(current);
    if (field === 'scopes') changed.scopes = ['catalog.read'];
    else if (field === 'digest') changed.digest = 'f'.repeat(64);
    else if (field === 'transport') changed.transport = 'mcp';
    else if (field === 'resource') changed.resource = resource + '/other';
    else changed[field]++;
    await (f.store as any).save([changed], () => true);
    assert.equal(currentSignal.aborted, true, field);
    await (f.store as any).save([current], () => true);
    const restored = (f.store as any).epochs.get(current.id).controller.signal;
    assert.notEqual(restored, currentSignal); assert.equal(restored.aborted, false);
    assert.equal(currentSignal.aborted, true);
  }
  assert.equal(signal.aborted, true);
  const old = f.signal(await f.authorize(grant.token));
  await f.store.revoke(grant.record.id, () => true);
  await (f.store as any).save([grant.record], () => true);
  assert.equal(old.aborted, true);
  assert.notEqual(f.signal(await f.authorize(grant.token)), old);
});

test('pruning aborts expired epochs while current epoch indexing stays bounded', async () => {
  const f = environment(), grant = await f.issue();
  const old = f.signal(await f.authorize(grant.token)); assert.ok(old);
  f.setTime(grant.record.expiresAt);
  const fresh = await f.issue('Fresh');
  assert.equal(old.aborted, true); assert.equal((await f.store.list()).length, 1);
  for (let i = 1; i < 128; i++) await f.issue('Bounded');
  assert.equal((f.store as any).epochs.size, 128);
  await assert.rejects(f.issue('Overflow'), code('budget'));
  assert.equal((f.store as any).epochs.size, 128);
  assert.equal(f.signal(await f.authorize(fresh.token)).aborted, false);
});

for (const initial of ['missing-directory', 'missing-file', 'parsed', 'read-close-error', 'windows', 'read-retry']) {
  test(`initial ${initial} coherently publishes records and epochs`, async () => {
    const seed = environment(), grant = await seed.issue();
    const f = environment(initial === 'windows' ? 'win32' : 'linux');
    if (initial !== 'missing-directory') f.filesystem.directory = true;
    if (!initial.startsWith('missing')) f.filesystem.contents = seed.filesystem.contents;
    if (initial === 'read-close-error') f.filesystem.fail = 'readClose';
    if (initial === 'read-retry') f.filesystem.fail = 'read';
    if (initial.endsWith('error') || initial === 'read-retry') {
      await assert.rejects(f.store.list(), code('unavailable'));
      f.filesystem.fail = '';
    }
    if (initial.startsWith('missing')) {
      assert.equal((await f.store.list()).length, 0);
      const issued = await f.issue(); assert.ok(f.signal(await f.authorize(issued.token)));
    } else {
      const lease = await f.authorize(grant.token), signal = f.signal(lease); assert.ok(signal);
      await f.store.revoke(grant.record.id, () => true); assert.equal(signal.aborted, true);
    }
  });
}

test('service observes committed targeted revoke at deadline without terminal authority probes', async () => {
  const f = await admissionFixture(), pending = f.start(); await flush();
  assert.equal(f.counts.action, 1);
  const before = { ...f.counts }; f.setTime(6000);
  await f.store.revoke(f.grant.record.id, () => true);
  f.fire();
  const reason = await pending;
  assert.equal(reason.code, 'retired');
  assert.deepEqual(f.counts, before);
  assert.equal((f.store as any).observers.size, 1);
  assert.equal(f.timers.size, 0);
});

test('service binds first epoch before any post-authorization guard or extra scope callback', async () => {
  const f = await admissionFixture();
  const original = f.store.authorize.bind(f.store);
  let calls = 0, afterFirst: any;
  f.store.authorize = async (...args: any[]) => {
    calls++;
    const lease = await original(...args);
    await f.store.revoke(f.grant.record.id, () => true);
    afterFirst = { ...f.counts };
    return lease;
  };
  const pending = f.start(['playback.read']); await flush();
  const reason = await pending;
  assert.equal(reason.code, 'retired'); assert.equal(calls, 1);
  assert.deepEqual(f.counts, afterFirst);
  assert.equal(f.counts.action, 0);
});

for (const elapsed of [5000, 5001]) {
  test(`deadline-only ${elapsed} stays timeout and preserves its first typed reason`, async () => {
    const f = await admissionFixture(), pending = f.start(); await flush();
    const before = { ...f.counts }; f.setTime(1000 + elapsed); f.fire();
    const reason = await pending;
    assert.equal(reason.code, 'timeout'); assert.deepEqual(f.counts, before);
    assert.equal(f.lease().signal.reason, reason);
    f.retireObserved(); await f.store.revoke(f.grant.record.id, () => true);
    assert.equal(f.lease().signal.reason, reason);
    assert.equal((f.store as any).observers.size, 1);
  });
}

for (const change of ['observed-native', 'silent-native', 'hidden-owner', 'session', 'config', 'listener']) {
  test(`${change} at coincident deadline uses captured observations without late probes`, async () => {
    const f = await admissionFixture(undefined, change === 'listener' ? 'rest' : 'mcp'), pending = f.start(); await flush();
    const before = { ...f.counts }; f.setTime(6000);
    if (change === 'observed-native') f.retireObserved();
    if (change === 'silent-native') f.silentRetire();
    if (change === 'hidden-owner') f.replaceOwner();
    if (change === 'session') f.service.retireSession(f.session);
    if (change === 'config') f.service.configure({ enabled: true, musicApiEnabled: true, hostname: '127.0.0.1', port: 26538 });
    if (change === 'listener') f.retireListener();
    f.fire();
    const reason = await pending;
    assert.equal(reason.code, ['silent-native', 'hidden-owner'].includes(change) ? 'timeout' : 'retired');
    assert.deepEqual(f.counts, before);
    assert.equal(f.counts.action, 1);
    assert.equal((f.store as any).observers.size, 1);
  });
}

test('unrelated committed issuance at deadline stays timeout with no late guard probes', async () => {
  const f = await admissionFixture(), pending = f.start(); await flush();
  const signal = f.signal(f.lease().principal), before = { ...f.counts };
  f.setTime(6000);
  await f.store.issue('Unrelated', 'mcp', resource, ['catalog.read'], () => true);
  const reason = await pending;
  assert.equal(reason.code, 'timeout'); assert.equal(signal.aborted, false);
  assert.deepEqual(f.counts, before);
  await f.store.revoke(f.grant.record.id, () => true);
  assert.equal(f.lease().signal.reason, reason);
});

for (const timeFact of ['expiry', 'rollback', 'equal-expiry', 'early-expiry-timer']) {
  test(`pure ${timeFact} retires without authority callouts`, async () => {
    const f = await admissionFixture();
    if (timeFact === 'equal-expiry' || timeFact === 'early-expiry-timer') f.setTime(f.grant.record.expiresAt - 50);
    const pending = f.start(); await flush(); const before = { ...f.counts };
    if (timeFact === 'rollback') f.setTime(f.grant.record.createdAt - 1);
    else if (timeFact !== 'early-expiry-timer') f.setTime(f.grant.record.expiresAt);
    // Invoke the real admittedFor callback as an early timer delivery. The
    // lifetime fallback itself must remain retired even before clock expiry.
    if (timeFact === 'early-expiry-timer' || timeFact === 'rollback') {
      assert.equal(f.timers.size, 1); [...f.timers][0].run();
    } else f.fire();
    const reason = await pending; assert.equal(reason.code, 'retired');
    assert.deepEqual(f.counts, before); assert.equal(f.timers.size, 0);
  });
}

for (const first of ['timeout', 'retired']) {
  test(`first typed ${first} identity wins over targeted and native retirement`, async () => {
    const f = await admissionFixture(), pending = f.start(); await flush();
    const reason = new f.types.MusicServiceError(first);
    f.request.abort(reason);
    f.retireObserved(); await f.store.revoke(f.grant.record.id, () => true);
    assert.equal(await pending, reason);
    assert.equal(f.lease().signal.reason, reason);
  });
}

for (const kind of ['clone', 'foreign-store', 'unbound']) {
  test(`${kind} first principal fails closed before post-authorization callbacks`, async () => {
    const f = await admissionFixture();
    const original = f.store.authorize.bind(f.store);
    let before: any, authorizations = 0;
    f.store.authorize = async (...args: any[]) => {
      authorizations++;
      const principal = await original(...args); before = { ...f.counts };
      if (kind === 'clone') return structuredClone(principal);
      if (kind === 'unbound') return Object.freeze({ ...principal, scopes: Object.freeze([...principal.scopes]) });
      const other = new f.storeModule.MusicGrantStore('/foreign', f.now);
      await other.list();
      return other.authorize(f.grant.token, 'mcp', resource, 'catalog.read');
    };
    const pending = f.start(['playback.read']); await flush();
    assert.equal((await pending).code, 'retired'); assert.equal(authorizations, 1);
    assert.deepEqual(f.counts, before); assert.equal((f.store as any).observers.size, 1);
  });
}

test('grant listener is detached after a successful admission and after targeted retirement', async () => {
  for (const outcome of ['success', 'retire']) {
    const f = await admissionFixture();
    const principal = await f.store.authorize(f.grant.token, 'mcp', resource, 'catalog.read');
    const signal = f.signal(principal), listeners = new Set<any>();
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type: string, listener: any, options: any) => { if (type === 'abort') listeners.add(listener); add(type, listener, options); };
    signal.removeEventListener = (type: string, listener: any) => { if (type === 'abort') listeners.delete(listener); remove(type, listener); };
    if (outcome === 'success') {
      const result = await f.service.admittedFor(f.invocation, 'catalog.read', [], true, async () => 'admitted');
      assert.equal(result, 'admitted');
    } else {
      const pending = f.start(); await flush(); assert.equal(listeners.size, 1);
      await f.store.revoke(f.grant.record.id, () => true); assert.equal((await pending).code, 'retired');
    }
    assert.equal(listeners.size, 0); assert.equal((f.store as any).observers.size, 1);
    assert.equal(f.timers.size, 0);
  }
});

test('all required scopes and sticky guard failures survive reentrant ABA recovery', async () => {
  const f = await admissionFixture();
  const original = f.store.isCurrent.bind(f.store); let denied = false;
  f.store.isCurrent = (principal: any, scope: string) => {
    if (!denied && scope === 'playback.read') { denied = true; f.replaceOwner(); f.restoreOwner(); return false; }
    return original(principal, scope);
  };
  const pending = f.start(['playback.read']); await flush();
  assert.equal((await pending).code, 'retired'); assert.equal(f.counts.action, 0); assert.equal(denied, true);
  const result = await f.service.admittedFor(f.invocation, 'catalog.read', ['playback.read'], true, async () => 'fresh');
  assert.equal(result, 'fresh');
});

for (const outcome of ['deadline', 'targeted-revoke', 'observed-native']) {
  test(`actual navigation ${outcome} keeps uncertain receipts and physical holds until settlement`, async () => {
    const f = await admissionFixture(['catalog.read', 'playback.control']);
    const command = { action: 'play_song', videoId: 'seedVideo01', playlistId: 'PL_N1PlaylistA' };
    const prepared = await f.service.prepareFor(f.invocation, command);
    assert.equal(prepared.status, 'pending');
    const input = { ...command, operationId: prepared.operationId };
    const ledger = (f.service as any).operations;
    const access = f.access.captureMusicAccess(f.invocation, f.owner);
    const row = ledger.lookup(prepared.operationId, f.grant.record, access);
    const calls: any[] = [];
    f.broker.read = (_owner: any, _input: any, _principal: any, options: any) =>
      new Promise((resolve, reject) => calls.push({ options, resolve, reject }));
    const pending = f.service.navigateFor(f.invocation, input).catch((error: any) => error);
    await flush(); assert.equal(calls.length, 1);
    assert.equal(row.physicalHold, true); assert.equal(row.executing, true);
    f.setTime(11000);
    if (outcome === 'targeted-revoke') await f.store.revoke(f.grant.record.id, () => true);
    if (outcome === 'observed-native') f.retireObserved();
    calls[0].reject(Error('Owned ACK lost'));
    const reason = await pending;
    assert.equal(reason.code, outcome === 'deadline' ? 'timeout' : 'retired');
    await flush();
    assert.equal(row.executing, false); assert.equal(row.physicalHold, true);
    assert.equal(row.receipt.status, 'uncertain'); assert.equal(row.receipt.error, 'outcome_unknown');
    assert.equal(calls.length, 1);
    assert.throws(() => ledger.lookup(prepared.operationId, f.grant.record,
      { ...access, owner: { identity: {}, current: () => true } }), code('unknown_operation'));
    assert.throws(() => ledger.lookup(prepared.operationId, f.grant.record,
      { ...access, session: { id: 'foreign', current: () => true } }), code('unknown_operation'));
    if (outcome === 'deadline') {
      const duplicate = await f.service.navigateFor(f.invocation, input);
      assert.equal(duplicate.status, 'uncertain'); assert.equal(calls.length, 1);
    }
    calls[0].options.onPhysicalSettled('authenticated_ack');
    assert.equal(row.physicalHold, false);
    // A late duplicate ACK cannot upgrade the completed uncertain receipt.
    calls[0].resolve({ version: 1, phase: 'owned_dispatch' }); await flush();
    assert.equal(row.receipt.status, 'uncertain'); assert.equal(calls.length, 1);
    f.restoreOwner();
    const fresh = await f.store.issue('Recovery', 'mcp', resource, ['playback.control'], () => true);
    const invocation = { ...f.invocation, token: fresh.token, session: { id: 'recovery', current: () => true } };
    const recovery = await f.service.prepareFor(invocation, command);
    const healthy = f.service.navigateFor(invocation, { ...command, operationId: recovery.operationId });
    await flush(); assert.equal(calls.length, 2);
    calls[1].options.onPhysicalSettled('authenticated_ack');
    calls[1].resolve({ version: 1, phase: 'owned_dispatch' });
    assert.equal((await healthy).status, 'accepted');
  });
}

for (const platform of ['linux', 'win32']) {
  test(`${platform}: an issue whose postcommit observer throws remains committed`, async () => {
    const f = environment(platform), first = await f.issue();
    const firstSignal = f.signal(await f.authorize(first.token));
    let committed: any;
    const detach = f.store.subscribe(() => {
      committed = (f.store as any).records.find((record: any) => record.id !== first.record.id);
      throw Error('postcommit ordinary observer');
    });
    await assert.rejects(f.issue('Committed despite rejection'), code('unavailable'));
    detach(); assert.ok(committed); assert.equal((await f.store.list()).length, 2);
    assert.equal(firstSignal.aborted, false);
    const transient = (f.store as any).epochs.get(committed.id).controller.signal;
    assert.equal(transient.aborted, false);
    await f.store.revoke(committed.id, () => true); assert.equal(transient.aborted, true);
  });
}

for (const failure of ['stat', 'invalid-json', 'invalid-record']) {
  test(`initial ${failure} retries instead of caching incomplete epochs`, async () => {
    const seed = environment(), grant = await seed.issue(), f = environment();
    f.filesystem.directory = true;
    f.filesystem.contents = failure === 'invalid-json' ? '{' : failure === 'invalid-record'
      ? '{"version":1,"records":[{}]}' : seed.filesystem.contents;
    if (failure === 'stat') f.filesystem.fail = 'stat';
    await assert.rejects(f.store.list(), code('unavailable'));
    f.filesystem.fail = ''; f.filesystem.contents = seed.filesystem.contents;
    const signal = f.signal(await f.authorize(grant.token)); assert.ok(signal);
    await f.store.revoke(grant.record.id, () => true); assert.equal(signal.aborted, true);
  });
}

test('Windows empty snapshot and read retry initialize coherent epoch state', async () => {
  const f = environment('win32'); f.filesystem.fail = 'read';
  await assert.rejects(f.store.list(), code('unavailable'));
  f.filesystem.fail = ''; assert.equal((await f.store.list()).length, 0);
  const grant = await f.issue(), signal = f.signal(await f.authorize(grant.token));
  assert.ok(signal); await f.store.revoke(grant.record.id, () => true); assert.equal(signal.aborted, true);
});

test('authorization crossing deadline times out before action or terminal authority probes', async () => {
  const f = await admissionFixture(), authorize = f.store.authorize.bind(f.store);
  let before: any;
  f.store.authorize = async (...args: any[]) => {
    const principal = await authorize(...args);
    f.setTime(6000); before = { ...f.counts };
    return principal;
  };
  const pending = f.start(); await flush();
  const reason = await pending;
  assert.equal(reason.code, 'timeout');
  assert.ok(reason instanceof f.types.MusicServiceError);
  assert.deepEqual(f.counts, before); assert.equal(f.counts.action, 0);
  assert.equal((f.store as any).observers.size, 1); assert.equal(f.timers.size, 0);
});

test('subscription crossing deadline preserves its first typed timeout without dispatch', async () => {
  const f = await admissionFixture(), subscribe = f.store.subscribe.bind(f.store);
  let before: any, capturedReason: any;
  f.store.subscribe = (observer: () => void) => {
    const detach = subscribe(observer);
    f.setTime(6000); before = { ...f.counts };
    observer();
    const controllers = (f.service as any).sessionLeases.get(f.session);
    assert.equal(controllers.size, 1);
    capturedReason = [...controllers][0].signal.reason;
    return detach;
  };
  const pending = f.start(); await flush();
  const reason = await pending;
  assert.equal(reason.code, 'timeout'); assert.equal(reason, capturedReason);
  assert.deepEqual(f.counts, before); assert.equal(f.counts.action, 0);
  assert.equal((f.store as any).observers.size, 1); assert.equal(f.timers.size, 0);
  await f.store.revoke(f.grant.record.id, () => true);
  f.retireObserved(); assert.equal(reason, capturedReason);
});

// Exported only for the private replay's evidence file. It does not enter guest.
export { sourceHashes };
