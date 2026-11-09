import { test, expect } from '@playwright/test';
import { playlistApiFixture } from './helpers/playlist-api-fixture';

const body = {
  playlistId: 'PLABCDEFGHIJKLMN',
  videoId: 'aaaaaaaaaaa',
  insertPosition: 'INSERT_AFTER_CURRENT_VIDEO',
};

test('authenticated API contract waits for owned dispatch and preserves legacy single-add acceptance', async () => {
  const f = await playlistApiFixture();
  try {
    const promise = f.request(body);
    await f.flush();
    const query = f.query();
    expect(typeof query?.requestId).toBe('string');
    let settled = false;
    void promise.then(() => (settled = true));
    expect(settled).toBe(false);
    f.ready(query.requestId);
    expect(f.sent.at(-1)).toEqual([
      'peard:add-playlist-to-queue',
      { requestId: query.requestId, ownerId: f.owner, ...body },
    ]);
    f.ack(query.requestId, { ok: true, count: 3 });
    expect((await promise).status).toBe(204);
    const single = await f.source.backend.app.request(
      'http://owned.fixture/api/v1/queue',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: 'bbbbbbbbbbb' }),
      },
    );
    expect(single.status).toBe(204);
    expect(f.sent.at(-1)).toEqual([
      'peard:add-to-queue',
      'bbbbbbbbbbb',
      'INSERT_AT_END',
    ]);
  } finally {
    await f.close();
  }
});

for (const [name, value] of [
  ['URL', { ...body, playlistId: 'https://invalid.example/list' }],
  ['video', { ...body, videoId: 'invalid' }],
  ['position', { ...body, insertPosition: 'BAD' }],
  ['oversize', { ...body, playlistId: 'PL' + 'a'.repeat(127) }],
  ['extra', { ...body, unexpected: true }],
] as const)
  test(`API rejects ${name} input before queue IPC`, async () => {
    const f = await playlistApiFixture();
    try {
      expect((await f.request(value)).status).toBe(400);
      expect(f.query()).toBeUndefined();
    } finally {
      await f.close();
    }
  });

for (const [reason, status] of [
  ['retired', 409],
  ['busy', 409],
  ['service', 502],
  ['timeout', 504],
] as const)
  test(`API exposes ${reason} completion as ${status}`, async () => {
    const f = await playlistApiFixture();
    try {
      const promise = f.request(body);
      await f.flush();
      const id = f.query()?.requestId;
      expect(typeof id).toBe('string');
      f.ready(id);
      f.ack(id, { ok: false, reason });
      expect((await promise).status).toBe(status);
    } finally {
      await f.close();
    }
  });

test('authentication and API stop/config retirement prevent stale queue mutations', async () => {
  const f = await playlistApiFixture();
  try {
    f.config.authStrategy = f.source.AuthStrategy.AUTH_AT_FIRST;
    expect((await f.request(body)).status).toBe(401);
    expect(f.query()).toBeUndefined();
    f.config.authStrategy = f.source.AuthStrategy.NONE;
    const old = f.request(body);
    await f.flush();
    const id = f.query()?.requestId;
    expect(typeof id).toBe('string');
    f.ready(id);
    f.source.backend.stop();
    expect((await old).status).toBe(409);
    expect(f.timers.size).toBe(0);
    await f.source.backend.start(f.ctx);
    const next = f.request(body);
    await f.flush();
    const fresh = f.query()?.requestId;
    expect(typeof fresh).toBe('string');
    f.ready(fresh);
    f.source.backend.onConfigChange({
      ...f.config,
      authorizedClients: ['new-scope'],
    });
    expect((await next).status).toBe(409);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('configuration retirement during asynchronous auth cannot admit an old request into the new scope', async () => {
  const f = await playlistApiFixture();
  try {
    let release!: (value: typeof f.config) => void;
    const gate = new Promise<typeof f.config>((resolve) => (release = resolve));
    let lookups = 0;
    f.ctx.getConfig = async () => (++lookups === 1 ? gate : f.config);
    const promise = f.request(body);
    await f.flush();
    expect(lookups).toBe(1);
    expect(f.query()).toBeUndefined();
    f.source.backend.onConfigChange({
      ...f.config,
      authorizedClients: ['new-auth-owner'],
    });
    release(f.config);
    expect((await promise).status).toBe(409);
    expect(f.query()).toBeUndefined();
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});
