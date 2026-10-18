import { test, expect } from '@playwright/test';
import { request, Agent } from 'node:http';
import { X509Certificate } from 'node:crypto';
import {
  musicRemoteHttpFixture,
  parseMusicRuntimeAdmission,
  assertMusicRuntimeObservations,
} from './helpers/api-music-remote-http';

for (const tls of [false, true])
  test(`owned loopback ${tls ? 'TLS' : 'HTTP'} explicit remote audience stays separate from local grants`, async () => {
    const f = await musicRemoteHttpFixture({ tls });
    try {
      const first = await f.http(
        '/api/v1/music/search',
        'POST',
        '{"query":"owned","limit":100}',
      );
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(100);
      const second = await f.http(
        '/api/v1/music/search',
        'POST',
        JSON.stringify({ cursor: first.body.nextCursor, limit: 100 }),
      );
      expect(second.status).toBe(200);
      expect(second.body.items).toHaveLength(51);
      expect(
        (
          await f.http(
            '/api/v1/music/search',
            'POST',
            JSON.stringify({ cursor: first.body.nextCursor, limit: 100 }),
          )
        ).body,
      ).toEqual(second.body);
      expect(
        (
          await f.http(
            '/api/v1/music/current',
            'GET',
            undefined,
            {},
            f.local.token,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await f.http('/api/v1/music/current', 'GET', undefined, {
            host: `127.0.0.1:${f.port}`,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await f.http(
            '/api/v1/music/current',
            'GET',
            undefined,
            { host: `127.0.0.1:${f.port}` },
            f.local.token,
          )
        ).status,
      ).toBe(200);
      f.config.musicApiRemoteEnabled = false;
      f.publish();
      expect((await f.http('/api/v1/music/current')).status).toBe(403);
      expect(
        (
          await f.http(
            '/api/v1/music/current',
            'GET',
            undefined,
            { host: `127.0.0.1:${f.port}` },
            f.local.token,
          )
        ).status,
      ).toBe(200);
    } finally {
      await f.close();
    }
  });

test('actual socket namespace consumes OPTIONS errors and encoded aliases before legacy CORS', async () => {
  const f = await musicRemoteHttpFixture();
  try {
    for (const [target, method, body, status] of [
      ['/api/v1/music/current', 'OPTIONS', undefined, 405],
      ['/api/v1/music/missing', 'GET', undefined, 404],
      ['/api/v1/%6dusic/current', 'GET', undefined, 400],
      [
        '/api/v1/music/search',
        'POST',
        '{"resource":"http://forged.invalid/api/v1/music","query":"x"}',
        400,
      ],
    ] as const) {
      const r = await f.http(target, method, body);
      expect(r.status).toBe(status);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['access-control-allow-private-network']).toBeUndefined();
    }
    const legacy = await f.http('/api/v1/song');
    expect(legacy.status).toBe(200);
    expect(legacy.headers['access-control-allow-origin']).toBe('*');
    expect(
      (await f.http('/api/v1/song', 'OPTIONS')).headers[
        'access-control-allow-origin'
      ],
    ).toBe('*');
  } finally {
    await f.close();
  }
});

test('actual remote REST invokes accepted prepare control receipt methods and exact replay once', async () => {
  const f = await musicRemoteHttpFixture();
  try {
    const command = { action: 'pause' };
    const prepared = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      JSON.stringify(command),
    );
    expect(prepared.status).toBe(200);
    const input = JSON.stringify({
      ...command,
      operationId: prepared.body.operationId,
    });
    const result = await f.http('/api/v1/music/control', 'POST', input);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('accepted');
    expect((await f.http('/api/v1/music/control', 'POST', input)).body).toEqual(
      result.body,
    );
    expect(
      (await f.http('/api/v1/music/operations/' + prepared.body.operationId))
        .body,
    ).toEqual(result.body);
    expect(
      f.sent.filter(
        (p) =>
          p[0] === 'peard:music-read' && p[1].input.operation === 'control',
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('all fourteen socket branches call actual For methods with one selected immutable REST invocation and deadline', async () => {
  const f = await musicRemoteHttpFixture();
  const names = [
    'current',
    'search',
    'browse',
    'queue',
    'home',
    'library',
    'lyrics',
    'related',
    'comments',
    'prepare',
    'navigate',
    'control',
    'mutateQueue',
    'operation',
  ];
  const seen = new Set<string>();
  try {
    for (const name of names) {
      const original = f.service[name + 'For'].bind(f.service);
      f.service[name + 'For'] = (...args: any[]) => {
        const inv = args[0];
        expect(inv.transport).toBe('rest');
        expect(inv.resource).toBe(f.config.musicApiRemoteResource);
        expect(inv.session).toBeUndefined();
        expect(Object.isFrozen(inv)).toBe(true);
        expect(typeof args.at(-1)).toBe('number');
        seen.add(name);
        return original(...args);
      };
      f.service[name] = () => {
        throw Error('Route used old local wrapper ' + name);
      };
    }
    for (const target of [
      '/current',
      '/queue?limit=100',
      '/home?limit=100',
      '/library/playlists?limit=100',
      '/song/lyrics?videoId=abcdefghijk',
      '/song/related?videoId=abcdefghijk&limit=100',
      '/song/comments?videoId=abcdefghijk&limit=100',
    ])
      expect((await f.http('/api/v1/music' + target)).status, target).toBe(200);
    for (const [target, input] of [
      ['/search', { query: 'owned', limit: 100 }],
      [
        '/browse',
        { target: { kind: 'playlist', id: 'PL_N1PlaylistA' }, limit: 100 },
      ],
    ] as const)
      expect(
        (await f.http('/api/v1/music' + target, 'POST', JSON.stringify(input)))
          .status,
        target,
      ).toBe(200);
    for (const [target, action, fields] of [
      ['/control', 'pause', {}],
      ['/play/song', 'play_song', { videoId: 'abcdefghijk' }],
      ['/queue/song', 'enqueue_song', { videoId: 'abcdefghijk' }],
    ] as const) {
      const prepare = await f.http(
        '/api/v1/music/operations/prepare',
        'POST',
        JSON.stringify({ action, ...fields }),
      );
      expect(prepare.status).toBe(200);
      const result = await f.http(
        '/api/v1/music' + target,
        'POST',
        JSON.stringify({
          ...fields,
          ...(target === '/control' ? { action } : {}),
          operationId: prepare.body.operationId,
        }),
      );
      expect(result.status, target).toBe(200);
      expect(result.body.status).toBe('accepted');
      expect(
        (await f.http('/api/v1/music/operations/' + prepare.body.operationId))
          .body,
      ).toEqual(result.body);
    }
    expect([...seen].sort()).toEqual([...names].sort());
  } finally {
    await f.close();
  }
});

// Deliberately absent from ordinary discovery: missing root admission is NOT a skip/pass witness.
if (process.env.PEAR_MUSIC_RUNTIME_ADMISSION) {
  test('runtime-admitted nonloopback HTTP and TLS require actual direct peers', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const input = parseMusicRuntimeAdmission(
      JSON.parse(
        await readFile(process.env.PEAR_MUSIC_RUNTIME_ADMISSION!, 'utf8'),
      ),
    );
    expect(['macOS', 'Windows', 'Linux']).toContain(input.environment);
    for (const tls of [false, true]) {
      const f = await musicRemoteHttpFixture({
        tls,
        remoteEnabled: false,
        admission: input,
      });
      let contract:
        | Awaited<ReturnType<typeof remoteOwnershipContract>>
        | undefined;
      let transport: ReturnType<typeof f.transportFacts> | undefined;
      let cleanup: Awaited<ReturnType<typeof f.close>> | undefined;
      try {
        expect(createHash('sha256').update(f.cert).digest('hex')).toBe(
          input.certSHA256,
        );
        contract = await remoteOwnershipContract(f);
        const beforeLocalAttempt = f.sent.filter(
          (p) => p[0] === 'peard:music-read',
        ).length;
        const localAttempt = await f.http(
          '/api/v1/music/current',
          'GET',
          undefined,
          { host: `127.0.0.1:${f.port}` },
          f.local.token,
        );
        expect(localAttempt.status).toBe(403);
        expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(
          beforeLocalAttempt,
        );
        await assertMusicRuntimeObservations(
          f.observations,
          input,
          f.port,
          tls,
        );
        transport = contract.transportFacts();
        expect(transport.endpoint.nonloopback).toBe(true);
        expect(transport.endpoint.family).toBe(4);
      } finally {
        cleanup = await f.close();
        expect(f.server.listening).toBe(false);
        expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
        expect(cleanup).toEqual({
          serverListening: false,
          brokerDispatched: 0,
          brokerQueued: 0,
          openRequestClients: 0,
          openServerSockets: 0,
          held: 0,
          ownedStoreRemoval: 'completed',
        });
      }
      await test.info().attach(`runtime-${tls ? 'TLS' : 'HTTP'}-checkpoints`, {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            protocol: tls ? 'TLS' : 'HTTP',
            checkpoints: [
              'actual_nonempty_socket_facts',
              'search100plus51_replay',
              'distinct_grants_default_disabled',
              'namespace_headers',
              'accepted_receipt_exact_replay',
              'terminal_owner_cursor_receipt',
              'two_client_logical_cancel_physical_hold',
              'bounded_cleanup',
            ],
            outcome: 'PASS',
            telemetry: {
              version: 1,
              ...transport!,
              pages: contract!.pages,
              ownership: contract!.ownership,
              counts: {
                ...contract!.counts,
                requests: transport!.endpoint.observations,
              },
              cleanup,
            },
          }),
        ),
      });
    }
  });
}

test('normal complete POST keepalive stays alive and one socket loss retains physical holds without canceling another client', async () => {
  const f = await musicRemoteHttpFixture();
  const agent = new Agent({ keepAlive: true });
  let req: any;
  try {
    f.setHold();
    const lost = new Promise<void>((resolve) => {
      req = request(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: '/api/v1/music/search',
          method: 'POST',
          agent,
          headers: {
            host: f.host,
            authorization: 'Bearer ' + f.grant.token,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.setTimeout(5000, () => req.destroy());
      req.on('error', () => resolve());
      req.end('{"query":"owned","limit":100}');
    });
    await expect.poll(() => f.held.length).toBe(1);
    const healthy = f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"owned","limit":100}',
    );
    await expect.poll(() => f.held.length).toBe(2);
    expect(f.sent.filter((p) => p[0] === 'peard:music-cancel')).toHaveLength(0);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 0 });
    req.destroy();
    await lost;
    await expect
      .poll(() => f.sent.filter((p) => p[0] === 'peard:music-cancel').length)
      .toBe(1);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 0 });
    f.settle();
    expect((await healthy).status).toBe(200);
    expect(f.service.stats().cursors).toBe(1);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
  } finally {
    req?.destroy();
    agent.destroy();
    await f.close();
  }
});

test('listener loss fences held authorization and old cursors receipts remain retired after same-resource replacement', async () => {
  const f = await musicRemoteHttpFixture();
  try {
    const page = await f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"owned","limit":100}',
    );
    const prepared = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      '{"action":"pause"}',
    );
    expect(prepared.status).toBe(200);
    const original = f.store.authorize.bind(f.store);
    let release: () => void = () => {};
    let entered = false;
    f.store.authorize = async (...args: any[]) => {
      entered = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    };
    const waiting = f.http('/api/v1/music/current');
    await expect.poll(() => entered).toBe(true);
    const before = f.sent.filter((p) => p[0] === 'peard:music-read').length;
    f.retireListener();
    expect((await waiting).status).toBe(409);
    f.publish(false);
    release();
    f.store.authorize = original;
    expect(
      (
        await f.http(
          '/api/v1/music/search',
          'POST',
          JSON.stringify({ cursor: page.body.nextCursor, limit: 100 }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await f.http('/api/v1/music/operations/' + prepared.body.operationId))
        .status,
    ).toBe(409);
    expect(
      (
        await f.http(
          '/api/v1/music/control',
          'POST',
          JSON.stringify({
            action: 'pause',
            operationId: prepared.body.operationId,
          }),
        )
      ).status,
    ).toBe(409);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(
      before,
    );
    expect((await f.http('/api/v1/music/current')).status).toBe(200);
  } finally {
    await f.close();
  }
});

test('raw TLS boundaries reject duplicate authority fatal UTF8 and oversized streamed bodies without native work', async () => {
  const f = await musicRemoteHttpFixture({ tls: true });
  try {
    const base = `Host: ${f.host}\r\nAuthorization: Bearer ${f.grant.token}\r\n`;
    for (const extra of [
      `Host: ${f.host}\r\n`,
      `Authorization: Bearer ${f.grant.token}\r\n`,
      'Origin: \r\n',
      'Origin: null\r\nOrigin: null\r\n',
      'Forwarded: \r\n',
      'X-Forwarded-Proto: https\r\n',
      'Content-Type: application/json\r\nContent-Type: application/json\r\n',
    ]) {
      const response = await f.raw(
        `GET /api/v1/music/current HTTP/1.1\r\n${base}${extra}Connection: close\r\n\r\n`,
      );
      expect(response).toMatch(/^HTTP\/1\.1 (400|403)/);
      expect(response.toLowerCase()).not.toContain(
        'access-control-allow-origin',
      );
    }
    const invalid = Buffer.concat([
      Buffer.from(
        `POST /api/v1/music/search HTTP/1.1\r\n${base}Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n`,
      ),
      Buffer.from([0xc3, 0x28]),
    ]);
    expect(await f.raw(invalid)).toMatch(/^HTTP\/1\.1 400/);
    const body = 'x'.repeat(16385);
    expect(
      await f.raw(
        `POST /api/v1/music/search HTTP/1.1\r\n${base}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
      ),
    ).toMatch(/^HTTP\/1\.1 413/);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    expect((await f.http('/api/v1/music/current')).status).toBe(200);
  } finally {
    await f.close();
  }
});

test('partial body abort and listener reentry or configuration ABA cannot dispatch old authority and healthy owner recovers', async () => {
  const f = await musicRemoteHttpFixture();
  let req: any;
  try {
    const body = '{"query":"owned","limit":100}';
    const original = f.store.authorize.bind(f.store);
    let entered = false;
    f.store.authorize = async (...args: any[]) => {
      const result = await original(...args);
      entered = true;
      return result;
    };
    const response = new Promise<number | undefined>((resolve, reject) => {
      req = request(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: '/api/v1/music/search',
          method: 'POST',
          agent: false,
          headers: {
            host: f.host,
            authorization: 'Bearer ' + f.grant.token,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.setTimeout(3000, () => req.destroy());
      req.on('error', reject);
      req.write(body.slice(0, 2));
    });
    await expect.poll(() => entered).toBe(true);
    f.retireListener();
    req.end(body.slice(2));
    expect(await response).toBe(409);
    f.publish(false);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    // Actual partial-body socket loss is separate from normal body completion.
    const aborted = request(
      {
        hostname: '127.0.0.1',
        port: f.port,
        path: '/api/v1/music/search',
        method: 'POST',
        agent: false,
        headers: {
          host: f.host,
          authorization: 'Bearer ' + f.grant.token,
          'content-type': 'application/json',
          'content-length': 100,
        },
      },
      (res) => res.resume(),
    );
    aborted.on('error', () => {});
    aborted.setTimeout(3000, () => aborted.destroy());
    aborted.write('{');
    await expect.poll(() => f.observations.length).toBe(2);
    aborted.destroy();
    let armed = true;
    f.store.authorize = async (...args: any[]) => {
      const result = await original(...args);
      const a = f.owner(),
        current = a.current;
      a.current = () => {
        if (armed) {
          armed = false;
          f.publish(false);
        }
        return current();
      };
      return result;
    };
    expect((await f.http('/api/v1/music/current')).status).toBe(409);
    f.store.authorize = original;
    let release: () => void = () => {};
    entered = false;
    f.store.authorize = async (...args: any[]) => {
      entered = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    };
    const waiting = f.http('/api/v1/music/current');
    await expect.poll(() => entered).toBe(true);
    f.config.musicApiRemoteEnabled = false;
    f.publish();
    f.config.musicApiRemoteEnabled = true;
    f.publish();
    release();
    f.store.authorize = original;
    expect((await waiting).status).toBe(409);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    expect((await f.http('/api/v1/music/current')).status).toBe(200);
  } finally {
    req?.destroy();
    await f.close();
  }
});

test('explicit runtime admission parser rejects missing or malformed authority without running sockets', () => {
  for (const input of [
    undefined,
    null,
    {},
    'host',
    {
      environment: 'macOS',
      bindAddress: '127.0.0.1',
      clientAddress: '127.0.0.1',
      certSHA256: 'bad',
    },
  ])
    expect(() => parseMusicRuntimeAdmission(input)).toThrow();
});

test('runtime witness rejects missing, substituted, stale and mismatched actual socket facts', async () => {
  const input = {
    environment: 'macOS',
    bindAddress: '192.0.2.10',
    clientAddress: '192.0.2.10',
    certSHA256: 'a'.repeat(64),
  };
  const epoch = {};
  const observed = {
    peer: '192.0.2.10',
    local: '192.0.2.10',
    port: 1234,
    tls: true,
    owned: true,
    epoch,
  };
  for (const observations of [
    [],
    Array.from({ length: 257 }, () => observed),
    [{ ...observed, peer: '127.0.0.1' }],
    [{ ...observed, local: '::ffff:127.0.0.1' }],
    [{ ...observed, peer: '192.0.2.11' }],
    [{ ...observed, local: '192.0.2.11' }],
    [{ ...observed, port: 1235 }],
    [{ ...observed, tls: false }],
    [{ ...observed, owned: false }],
    [{ ...observed, epoch: undefined }],
  ])
    await expect(
      assertMusicRuntimeObservations(observations, input, 1234, true),
    ).rejects.toThrow();
  await assertMusicRuntimeObservations([observed], input, 1234, true);
});

// Shared behavior on loopback is only a contract control, never a nonloopback witness.
for (const tls of [false, true])
  test(`owned loopback ${tls ? 'TLS' : 'HTTP'} full remote ownership contract`, async () => {
    const f = await musicRemoteHttpFixture({ tls, remoteEnabled: false });
    let measured: any, cleanup: any;
    try {
      const contract = await remoteOwnershipContract(f);
      measured = contract.transportFacts();
      expect(contract.pages).toEqual({
        firstItems: 100,
        secondItems: 51,
        nativeFetchesForPaging: 1,
        replayNativeDelta: 0,
      });
      expect(contract.ownership).toEqual({
        retiredA: true,
        distinctAB: true,
        oldCursorStatus: 404,
        oldReceiptStatus: 409,
      });
      expect(contract.counts).toEqual({
        nativeReadPackets: 7,
        controlsAfterAccepted: 1,
        controlsAfterReplay: 1,
        controlsFinal: 2,
        cancelPackets: 1,
        holdsBeforeLoss: 2,
        holdsAfterLoss: 2,
        holdsAfterSettlement: 0,
      });
      expect(measured.endpoint.nonloopback).toBe(false);
      expect(measured.endpoint.observations).toBeGreaterThan(0);
      expect(measured.endpoint.epochs.map((e: any) => e.label)).toEqual([
        'disabled',
        'A',
        'B',
        'configured',
      ]);
      expect(measured.tls.encrypted).toBe(tls);
      if (tls) {
        expect(measured.tls.verifiedResponses).toBeGreaterThan(0);
        expect(measured.tls.peerLeafFingerprint256).toBe(
          new X509Certificate(f.cert).fingerprint256
            .replaceAll(':', '')
            .toLowerCase(),
        );
        expect(measured.tls.peerLeafFingerprint256).toBe(
          'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1',
        );
        expect(measured.tls.versions.length).toBeGreaterThan(0);
      } else {
        expect(measured.tls).toEqual({
          encrypted: false,
          versions: [],
          verifiedResponses: 0,
          peerLeafFingerprint256: null,
        });
      }
    } finally {
      cleanup = await f.close();
      expect(f.server.listening).toBe(false);
      expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    }
    expect(cleanup).toEqual({
      serverListening: false,
      brokerDispatched: 0,
      brokerQueued: 0,
      openRequestClients: 0,
      openServerSockets: 0,
      held: 0,
      ownedStoreRemoval: 'completed',
    });
  });

async function remoteOwnershipContract(
  f: Awaited<ReturnType<typeof musicRemoteHttpFixture>>,
) {
  const initialObservationCount = f.observations.length;
  const reads = () => f.sent.filter((p) => p[0] === 'peard:music-read');
  const controls = () =>
    reads().filter((p) => p[1].input.operation === 'control');
  const cleanHeaders = (response: any) => {
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      response.headers['access-control-allow-private-network'],
    ).toBeUndefined();
  };
  // Explicitly prove the default-disabled state on this listener before useful work.
  f.config.musicApiRemoteEnabled = false;
  f.publish();
  const disabledEpoch = f.owner();
  const disabled = await f.http('/api/v1/music/current');
  expect(disabled.status).toBe(403);
  cleanHeaders(disabled);
  expect(reads()).toHaveLength(0);
  f.config.musicApiRemoteEnabled = true;
  f.publish();
  const enabledEpoch = f.owner();
  expect(f.grant.token).not.toBe(f.local.token);
  for (const [method, headers, token, status] of [
    ['GET', {}, f.local.token, 401],
    ['GET', { host: 'forged.invalid:' + f.port }, f.grant.token, 403],
    ['GET', { origin: 'https://forged.invalid' }, f.grant.token, 403],
    ['GET', { forwarded: 'for=192.0.2.1' }, f.grant.token, 403],
    ['OPTIONS', {}, f.grant.token, 405],
  ] as const) {
    const denied = await f.http(
      '/api/v1/music/current',
      method,
      undefined,
      headers,
      token,
    );
    expect(denied.status).toBe(status);
    cleanHeaders(denied);
  }
  expect(reads()).toHaveLength(0);
  const first = await f.http(
    '/api/v1/music/search',
    'POST',
    '{"query":"owned","limit":100}',
  );
  expect(first.status).toBe(200);
  expect(first.body.items).toHaveLength(100);
  cleanHeaders(first);
  expect(reads()).toHaveLength(1);
  const readsAfterFirst = reads().length;
  const cursorInput = JSON.stringify({
    cursor: first.body.nextCursor,
    limit: 100,
  });
  const second = await f.http('/api/v1/music/search', 'POST', cursorInput);
  expect(second.status).toBe(200);
  expect(second.body.items).toHaveLength(51);
  cleanHeaders(second);
  expect(
    first.body.items.concat(second.body.items).map((item: any) => item.id),
  ).toEqual(
    Array.from({ length: 151 }, (_, i) => 'v' + String(i).padStart(10, '0')),
  );
  const replay = await f.http('/api/v1/music/search', 'POST', cursorInput);
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(second.body);
  cleanHeaders(replay);
  expect(reads()).toHaveLength(1);
  const pagingReads = reads().length;
  const prepare = () =>
    f.http('/api/v1/music/operations/prepare', 'POST', '{"action":"pause"}');
  const prepared = await prepare();
  expect(prepared.status).toBe(200);
  const controlInput = JSON.stringify({
    action: 'pause',
    operationId: prepared.body.operationId,
  });
  f.setHold();
  const pending = f.http('/api/v1/music/control', 'POST', controlInput);
  void pending.catch(() => {});
  await expect.poll(() => f.held.length).toBe(1);
  expect(controls()).toHaveLength(1);
  expect(f.sent.filter((p) => p[0] === 'peard:music-cancel')).toHaveLength(0);
  f.settle();
  f.setHold(false);
  const result = await pending;
  expect(result.status).toBe(200);
  expect(result.body.status).toBe('accepted');
  const controlsAfterAccepted = controls().length;
  expect(
    (await f.http('/api/v1/music/operations/' + prepared.body.operationId))
      .body,
  ).toEqual(result.body);
  expect(
    (await f.http('/api/v1/music/control', 'POST', controlInput)).body,
  ).toEqual(result.body);
  expect(controls()).toHaveLength(1);
  const controlsAfterReplay = controls().length;
  const epochA = f.owner();
  f.retireListener();
  expect(epochA.signal.aborted).toBe(true);
  f.publish(false);
  const epochB = f.owner();
  expect(epochB.identity).not.toBe(epochA.identity);
  const before = reads().length;
  const oldCursor = await f.http('/api/v1/music/search', 'POST', cursorInput);
  expect(oldCursor.status).toBe(404);
  const oldReceipt = await f.http(
    '/api/v1/music/operations/' + prepared.body.operationId,
  );
  expect(oldReceipt.status).toBe(409);
  expect(
    (await f.http('/api/v1/music/control', 'POST', controlInput)).status,
  ).toBe(409);
  expect(reads()).toHaveLength(before);
  expect((await f.http('/api/v1/music/current')).status).toBe(200);
  const fresh = await prepare();
  expect(fresh.status).toBe(200);
  expect(
    (
      await f.http(
        '/api/v1/music/control',
        'POST',
        JSON.stringify({
          action: 'pause',
          operationId: fresh.body.operationId,
        }),
      )
    ).body.status,
  ).toBe('accepted');
  expect(controls()).toHaveLength(2);
  const configPage = await f.http(
    '/api/v1/music/search',
    'POST',
    '{"query":"config","limit":100}',
  );
  const configReceipt = await prepare();
  expect(configPage.status).toBe(200);
  expect(configReceipt.status).toBe(200);
  f.config.musicApiRemoteEnabled = false;
  f.publish();
  f.config.musicApiRemoteEnabled = true;
  f.publish();
  const configEpoch = f.owner();
  const beforeConfigReplay = reads().length;
  expect(
    (
      await f.http(
        '/api/v1/music/search',
        'POST',
        JSON.stringify({ cursor: configPage.body.nextCursor, limit: 100 }),
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.http('/api/v1/music/operations/' + configReceipt.body.operationId))
      .status,
  ).toBe(409);
  expect(reads()).toHaveLength(beforeConfigReplay);
  f.setHold();
  const lost = f.startHttp(
    '/api/v1/music/search',
    'POST',
    '{"query":"owned","limit":100}',
  );
  const lostResult = lost.response.then(
    () => 'completed',
    () => 'disconnected',
  );
  let holdsBeforeLoss = -1,
    holdsAfterLoss = -1,
    holdsAfterSettlement = -1;
  try {
    await expect.poll(() => f.held.length).toBe(1);
    const healthy = f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"owned","limit":100}',
    );
    void healthy.catch(() => {});
    await expect.poll(() => f.held.length).toBe(2);
    expect(f.sent.filter((p) => p[0] === 'peard:music-cancel')).toHaveLength(0);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 0 });
    holdsBeforeLoss = f.broker.stats().dispatched;
    lost.request.destroy();
    expect(await lostResult).toBe('disconnected');
    await expect
      .poll(() => f.sent.filter((p) => p[0] === 'peard:music-cancel').length)
      .toBe(1);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 0 });
    holdsAfterLoss = f.broker.stats().dispatched;
    f.settle();
    f.setHold(false);
    const useful = await healthy;
    expect(useful.status).toBe(200);
    expect(useful.body.items).toHaveLength(100);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    holdsAfterSettlement = f.broker.stats().dispatched;
  } finally {
    lost.request.destroy();
    f.settle();
    f.setHold(false);
  }
  expect(f.observations.length).toBeGreaterThan(0);
  for (const observed of f.observations.slice(initialObservationCount)) {
    expect(observed.owned).toBe(true);
    expect(observed.port).toBe(f.port);
    expect(observed.tls).toBe(f.tls);
    expect([
      disabledEpoch.identity,
      enabledEpoch.identity,
      epochA.identity,
      epochB.identity,
      configEpoch.identity,
    ]).toContain(observed.epoch);
  }
  expect(enabledEpoch.identity).toBe(epochA.identity);
  return {
    pages: {
      firstItems: first.body.items.length,
      secondItems: second.body.items.length,
      nativeFetchesForPaging: pagingReads,
      replayNativeDelta: pagingReads - readsAfterFirst,
    },
    ownership: {
      retiredA: epochA.signal.aborted,
      distinctAB: epochA.identity !== epochB.identity,
      oldCursorStatus: oldCursor.status,
      oldReceiptStatus: oldReceipt.status,
    },
    counts: {
      nativeReadPackets: reads().length,
      controlsAfterAccepted,
      controlsAfterReplay,
      controlsFinal: controls().length,
      cancelPackets: f.sent.filter((p) => p[0] === 'peard:music-cancel').length,
      holdsBeforeLoss,
      holdsAfterLoss,
      holdsAfterSettlement,
    },
    transportFacts: () =>
      f.transportFacts([
        { label: 'disabled', identity: disabledEpoch.identity },
        { label: 'A', identity: epochA.identity },
        { label: 'B', identity: epochB.identity },
        { label: 'configured', identity: configEpoch.identity },
      ]),
  };
}
