import { test, expect } from '@playwright/test';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { musicModuleSource } from './helpers/api-music-source';
const resource = 'http://127.0.0.1:26538/api/v1/music';
async function fixture() {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grants.ts',
  );
  expect(typeof m.createMusicGrant).toBe('function');
  return m;
}
test('256-bit canonical native credentials persist only digests and default to zero permissions', async () => {
  const m = await fixture(),
    a = m.createMusicGrant('Fixture', 'rest', resource, []),
    b = m.createMusicGrant('Fixture', 'rest', resource, []);
  expect(a.token).toMatch(/^pdm_[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(a.token.slice(4), 'base64url')).toHaveLength(32);
  expect(a.token).not.toBe(b.token);
  expect(a.record.expiresAt - a.record.createdAt).toBe(86400000);
  expect(a.record.scopes).toEqual([]);
  expect(JSON.stringify(a.record)).not.toContain(a.token);
  expect(
    m.grantAllows(
      a.record,
      a.token,
      'rest',
      resource,
      'playback.read',
      a.record.createdAt,
    ),
  ).toBe(false);
});
test('credential scope transport exact resource expiry and canonical bits are independent guards', async () => {
  const m = await fixture(),
    a = m.createMusicGrant('Fixture', 'rest', resource, ['playback.read']);
  expect(
    m.grantAllows(
      a.record,
      a.token,
      'rest',
      resource,
      'playback.read',
      a.record.createdAt,
    ),
  ).toBe(true);
  for (const [token, transport, target, scope, now] of [
    [a.token, 'mcp', resource, 'playback.read', a.record.createdAt],
    [a.token, 'rest', resource + '/', 'playback.read', a.record.createdAt],
    [a.token, 'rest', resource, 'catalog.read', a.record.createdAt],
    [a.token, 'rest', resource, 'playback.read', a.record.expiresAt],
    ['legacy-id', 'rest', resource, 'playback.read', a.record.createdAt],
    [
      'eyJ.synthetic.jwt',
      'rest',
      resource,
      'playback.read',
      a.record.createdAt,
    ],
    [a.token + '=', 'rest', resource, 'playback.read', a.record.createdAt],
  ])
    expect(m.grantAllows(a.record, token, transport, target, scope, now)).toBe(
      false,
    );
  expect(m.parseMusicBearer('Bearer ' + a.token)).toBe(a.token);
  for (const raw of [
    a.token,
    'bearer ' + a.token,
    'Bearer  ' + a.token,
    'Bearer ' + a.token + ', Bearer ' + a.token,
    'Bearer ' + a.token + '\n',
  ])
    expect(m.parseMusicBearer(raw)).toBeNull();
});
test('grant record validation rejects unknown scopes duplicate scopes unbound resources and excessive lifetime', async () => {
  const m = await fixture();
  for (const scopes of [['unknown'], ['playback.read', 'playback.read']])
    expect(() =>
      m.createMusicGrant('Fixture', 'rest', resource, scopes),
    ).toThrow();
  for (const url of [
    'https://u:p@localhost:1/api/v1/music',
    'http://localhost:1/api/v1/music#token',
    'http://localhost:1/api/v1/music?token',
  ])
    expect(() => m.createMusicGrant('Fixture', 'rest', url, [])).toThrow();
  const a = m.createMusicGrant('Fixture', 'rest', resource, []);
  expect(m.parseMusicGrantRecord({ ...a.record, token: a.token })).toBeNull();
  expect(
    m.parseMusicGrantRecord({
      ...a.record,
      expiresAt: a.record.createdAt + 86400001,
    }),
  ).toBeNull();
});
test('private atomic ledger has owner permissions digest-only readback and revoke survives reload', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  expect(typeof m.MusicGrantStore).toBe('function');
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-grant-'));
  try {
    const store = new m.MusicGrantStore(path.join(folder, 'owned'));
    const grant = await store.issue(
      'Fixture',
      'rest',
      resource,
      ['playback.read'],
      () => true,
    );
    const file = path.join(folder, 'owned', 'grants.json'),
      content = await readFile(file, 'utf8');
    expect(content).not.toContain(grant.token);
    expect(content).not.toContain('Bearer');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const reload = new m.MusicGrantStore(path.join(folder, 'owned'));
    expect(
      (await reload.authorize(grant.token, 'rest', resource, 'playback.read'))
        .id,
    ).toBe(grant.record.id);
    await reload.revoke(grant.record.id, () => true);
    await expect(
      reload.authorize(grant.token, 'rest', resource, 'playback.read'),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('stale native issue and concurrent revocation transactions do not mint or resurrect grants', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  expect(typeof m.MusicGrantStore).toBe('function');
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-grant-'));
  try {
    const store = new m.MusicGrantStore(path.join(folder, 'owned'));
    await expect(
      store.issue('Stale', 'rest', resource, [], () => false),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(await store.list()).toEqual([]);
    const a = await store.issue(
      'Fixture',
      'rest',
      resource,
      ['catalog.read'],
      () => true,
    );
    const b = store.issue(
      'Concurrent',
      'rest',
      resource,
      ['playback.read'],
      () => true,
    );
    const revoke = store.revoke(a.record.id, () => true);
    await Promise.all([b, revoke]);
    expect((await store.list()).map((r: any) => r.name)).toEqual([
      'Concurrent',
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('malformed oversized ledger and non-private file fail closed without replacing it', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-grant-store.ts',
  );
  expect(typeof m.MusicGrantStore).toBe('function');
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-grant-'));
  try {
    for (const [content, mode] of [
      ['{', 0o600],
      ['x'.repeat(512 * 1024 + 1), 0o600],
      ['{"version":1,"records":[]}', 0o644],
    ] as const) {
      const dir = path.join(folder, String(mode) + '-' + content.length);
      await mkdir(dir, { mode: 0o700 });
      const file = path.join(dir, 'grants.json');
      await writeFile(file, content, { mode });
      const store = new m.MusicGrantStore(dir);
      await expect(store.list()).rejects.toMatchObject({ code: 'unavailable' });
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
