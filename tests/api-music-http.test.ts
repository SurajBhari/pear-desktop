import { test, expect } from '@playwright/test';
import { request } from 'node:http';
import { musicHttpFixture } from './helpers/api-music-http';

test('real loopback HTTP requires scoped native bearer while legacy NONE headers and data remain unchanged', async () => {
  const f = await musicHttpFixture();
  try {
    for (const authorization of [
      undefined,
      'Bearer legacy-client-id',
      'Bearer eyJ.synthetic.jwt',
    ]) {
      const result = await f.http(
        '/api/v1/music/search',
        'POST',
        '{"query":"fixture"}',
        authorization ? { authorization } : {},
      );
      expect(result.status).toBe(401);
      expect(result.headers['access-control-allow-origin']).toBeUndefined();
      expect(
        result.headers['access-control-allow-private-network'],
      ).toBeUndefined();
      expect(result.headers['cache-control']).toBe('no-store');
    }
    expect(f.calls).toHaveLength(0);
    const legacy = await f.http('/api/v1/song');
    expect(legacy.body).toEqual({ legacy: 'NONE unchanged' });
    expect(legacy.headers['access-control-allow-origin']).toBe('*');
    expect(legacy.headers['access-control-allow-private-network']).toBe('true');
    const allowed = await f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"fixture","limit":100}',
      { authorization: 'Bearer ' + f.grant.token },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.items).toHaveLength(100);
  } finally {
    await f.close();
  }
});
test('actual raw duplicate Host Authorization Origin forwarded headers and noncanonical targets reject before native work', async () => {
  const f = await musicHttpFixture();
  try {
    for (const extra of [
      `Host: ${f.host}\r\n`,
      `Authorization: Bearer ${f.grant.token}\r\n`,
      'Origin: https://fixture.invalid\r\n',
      `Forwarded: host=${f.host}\r\n`,
      `X-Forwarded-Host: ${f.host}\r\n`,
    ]) {
      const raw = await f.raw(
        `GET /api/v1/music/current HTTP/1.1\r\nHost: ${f.host}\r\nAuthorization: Bearer ${f.grant.token}\r\n${extra}Connection: close\r\n\r\n`,
      );
      expect(raw).toMatch(/^HTTP\/1\.1 (400|403)/);
      expect(raw.toLowerCase()).not.toContain('access-control-allow-origin');
    }
    const wrongHost = await f.http('/api/v1/music/current', 'GET', undefined, {
      host: 'fixture.invalid',
      authorization: 'Bearer ' + f.grant.token,
    });
    expect(wrongHost.status).toBe(403);
    const noncanonical = await f.http(
      '/api/v1/music%2Fcurrent',
      'GET',
      undefined,
      { authorization: 'Bearer ' + f.grant.token },
    );
    expect(noncanonical.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('16KiB body query scalar declared-kind and content-type boundaries return fixed local errors', async () => {
  const f = await musicHttpFixture();
  try {
    for (const [body, headers, status] of [
      [JSON.stringify({ query: 'x'.repeat(17000) }), {}, 413],
      [
        '{"query":"fixture","params":"synthetic-private-provider-params"}',
        {},
        400,
      ],
      ['{"query":"fixture","kind":"uploads"}', {}, 400],
      ['{"query":"fixture"}', { 'content-type': 'text/plain' }, 415],
    ] as const) {
      const result = await f.http('/api/v1/music/search', 'POST', body, {
        authorization: 'Bearer ' + f.grant.token,
        ...headers,
      });
      expect(result.status).toBe(status);
      expect(result.text).not.toContain('synthetic-private-provider-params');
    }
    expect(f.calls).toHaveLength(0);
    const allowed = await f.http(
      '/api/v1/music/search',
      'POST',
      JSON.stringify({ query: '🎵'.repeat(256) }),
      { authorization: 'Bearer ' + f.grant.token },
    );
    expect(allowed.status).toBe(200);
  } finally {
    await f.close();
  }
});
test('normal completed POST body close keeps admitted native work alive until its response', async () => {
  const f = await musicHttpFixture();
  try {
    f.setHold();
    const response = f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"fixture"}',
      { authorization: 'Bearer ' + f.grant.token },
    );
    while (!f.calls.length) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls[0].options.signal.aborted).toBe(false);
    f.calls[0].resolve(f.c.normalizeMusicSource(f.searchPage(), 'search'));
    expect((await response).status).toBe(200);
  } finally {
    await f.close();
  }
});
test('premature actual socket loss cancels caller and late unabortable completion cannot publish a cursor', async () => {
  const f = await musicHttpFixture();
  try {
    f.setHold();
    const req = request({
      hostname: '127.0.0.1',
      port: f.port,
      path: '/api/v1/music/search',
      method: 'POST',
      headers: {
        host: f.host,
        authorization: 'Bearer ' + f.grant.token,
        'content-type': 'application/json',
      },
    });
    req.on('error', () => {});
    req.end('{"query":"fixture"}');
    while (!f.calls.length) await new Promise((r) => setTimeout(r, 1));
    req.destroy();
    const end = Date.now() + 1000;
    while (!f.calls[0].options.signal.aborted && Date.now() < end)
      await new Promise((r) => setTimeout(r, 1));
    expect(f.calls[0].options.signal.aborted).toBe(true);
    f.calls[0].resolve(f.c.normalizeMusicSource(f.searchPage(), 'search'));
    await new Promise((r) => setTimeout(r, 10));
    expect(f.service.stats().cursors).toBe(0);
  } finally {
    await f.close();
  }
});

test('matching forged Host and valid grant cannot cross an actual listener port boundary', async () => {
  const f = await musicHttpFixture();
  try {
    const otherPort = f.port === 65535 ? f.port - 1 : f.port + 1;
    f.service.configure({ ...f.config, port: otherPort });
    const grant = await f.store.issue(
      'Other resource',
      'rest',
      f.service.resource,
      ['catalog.read'],
      () => true,
    );
    const result = await f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"fixture"}',
      {
        host: '127.0.0.1:' + otherPort,
        authorization: 'Bearer ' + grant.token,
      },
    );
    expect(result.status).toBe(403);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});


test('queue GET rejects duplicate and coercing query fields without native work', async () => {
  const f = await musicHttpFixture();
  try {
    for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=1.0', 'limit=1&limit=2', 'unknown=1', '%6cimit=1']) {
      const result = await f.http('/api/v1/music/queue?' + query, 'GET', undefined, { authorization: 'Bearer ' + f.grant.token });
      expect(result.status, query).toBe(400);
    }
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});
