import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

import { test, expect } from '@playwright/test';

async function client() {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL(
        '../src/plugins/scrobbler/services/ws-client.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
}
const account = {
  apiRoot: 'https://service.invalid/2.0/',
  apiKey: 'dummy-key',
  secret: 'dummy-secret',
};

test('signature uses ordinal key order, excludes transport fields and preserves Unicode', async () => {
  const m = await client();
  const parameters = {
    track: 'Café 星',
    method: 'track.scrobble',
    format: 'json',
    callback: 'ignored',
    api_sig: 'old',
    api_key: 'dummy-key',
    timestamp: 123,
  };
  const expected = createHash('md5')
    .update(
      'api_keydummy-keymethodtrack.scrobbletimestamp123trackCafé 星dummy-secret',
    )
    .digest('hex');
  expect(m.createApiSignature(parameters, account.secret)).toBe(expected);
  expect(parameters.api_sig).toBe('old');
});
test('only canonical legacy HTTP roots migrate; HTTPS rejects credentials/query/hash', async () => {
  const m = await client();
  expect(m.apiEndpoint('http://ws.audioscrobbler.com/2.0/')).toBe(
    'https://ws.audioscrobbler.com/2.0/',
  );
  expect(m.apiEndpoint('https://service.invalid/2.0/')).toBe(account.apiRoot);
  for (const invalid of [
    'http://service.invalid/2.0/',
    'https://user:pass@service.invalid/',
    'https://service.invalid/?token=x',
    'https://service.invalid/#x',
    'file:///tmp/ws',
  ])
    expect(() => m.apiEndpoint(invalid)).toThrow();
});
test('JSON and canonical Libre XML credentials decode; service errors keep numeric codes', async () => {
  const m = await client();
  expect(m.decodeWsResponse('{"session":{"key":"dummy-session"}}')).toEqual({
    session: { key: 'dummy-session' },
  });
  expect(
    m.decodeWsResponse(
      '<?xml version="1.0"?><lfm status="ok"><token>dummy-token</token></lfm>',
    ),
  ).toEqual({ token: 'dummy-token' });
  expect(
    m.decodeWsResponse(
      '<lfm status="ok"><session><name>Artist</name><key>dummy-session</key><subscriber>0</subscriber></session></lfm>',
    ),
  ).toEqual({ session: { key: 'dummy-session' } });
  for (const body of [
    '{"error":9,"message":"dummy-session"}',
    '<lfm status="failed"><error code="9">dummy-session</error></lfm>',
  ]) {
    try {
      m.decodeWsResponse(body);
      throw Error('expected service rejection');
    } catch (error) {
      expect(error.code).toBe(9);
      expect(error.message).not.toContain('dummy-session');
    }
  }
});
test('unsupported credentials/envelopes/DTD and duplicate XML keys cannot authenticate', async () => {
  const m = await client();
  for (const body of [
    'null',
    '[]',
    '{"session":{"key":9}}',
    '{"token":" "}',
    '<!DOCTYPE lfm [<!ENTITY x "dummy">]><lfm status="ok"><token>&x;</token></lfm>',
    '<lfm status="ok"><session><key>first</key><key>second</key></session></lfm>',
    '<lfm status="ok"><token>one</token>',
    '<lfm status="ok"><token>&unknown;</token></lfm>',
  ])
    expect(() => m.decodeWsResponse(body)).toThrow();
});
test('request uses configured endpoint, form encoding and rejects credential redirects', async () => {
  const m = await client();
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response('{}');
  };
  await m.requestWs(fetcher, account, {
    method: 'track.updateNowPlaying',
    track: 'A & B',
  });
  expect(calls[0].url).toBe(account.apiRoot);
  expect(calls[0].options.redirect).toBe('error');
  const data = new URLSearchParams(calls[0].options.body);
  expect(data.get('track')).toBe('A & B');
  expect(data.get('api_key')).toBe('dummy-key');
  expect(data.get('api_sig')).toMatch(/^[a-f0-9]{32}$/);
  expect(data.has('secret')).toBe(false);
  expect(calls[0].options.method).toBe('POST');
});
test('HTTP service error bodies are read and never logged in the thrown message', async () => {
  const m = await client();
  await expect(
    m.requestWs(
      async () =>
        new Response('{"error":9,"message":"dummy-session"}', { status: 401 }),
      account,
      { method: 'track.scrobble' },
    ),
  ).rejects.toMatchObject({ code: 9 });
});
test('streamed and declared response sizes are bounded; failed body readers are canceled', async () => {
  const m = await client();
  let canceled = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(65_537));
    },
    cancel() {
      canceled++;
    },
  });
  await expect(
    m.requestWs(async () => new Response(body), account, {
      method: 'auth.getToken',
    }),
  ).rejects.toMatchObject({ code: 0 });
  expect(canceled).toBe(1);
  await expect(
    m.requestWs(
      async () =>
        new Response('{}', { headers: { 'content-length': '65537' } }),
      account,
      { method: 'auth.getToken' },
    ),
  ).rejects.toMatchObject({ code: 0 });
});
test('deadline aborts a stalled body and releases its reader', async () => {
  const m = await client();
  let canceled = 0;
  const body = new ReadableStream({
    start() {},
    cancel() {
      canceled++;
    },
  });
  await expect(
    m.requestWs(
      async () => new Response(body),
      account,
      { method: 'auth.getToken' },
      undefined,
      15,
    ),
  ).rejects.toMatchObject({ code: 0 });
  expect(canceled).toBe(1);
});
test('retired caller cannot start a request or consume a subsequently returned response', async () => {
  const m = await client();
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await expect(
    m.requestWs(
      async () => {
        calls++;
        return new Response('{}');
      },
      account,
      { method: 'auth.getToken' },
      abort.signal,
    ),
  ).rejects.toMatchObject({ code: 0 });
  expect(calls).toBe(0);
  const second = new AbortController();
  let release;
  const pending = m.requestWs(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    account,
    { method: 'auth.getToken' },
    second.signal,
  );
  second.abort();
  release(new Response('{"session":{"key":"dummy-session"}}'));
  await expect(pending).rejects.toMatchObject({ code: 0 });
});

test('unsupported method and malformed endpoint fail before network without exposing input', async () => {
  const m = await client();
  let calls = 0;
  await expect(
    m.requestWs(
      async () => {
        calls++;
        return new Response('{}');
      },
      account,
      { method: 7 },
    ),
  ).rejects.toMatchObject({ code: 0 });
  expect(calls).toBe(0);
  try {
    m.apiEndpoint('private-input-not-a-url');
    throw Error('expected rejection');
  } catch (error) {
    expect(error.message).not.toContain('private-input');
  }
});

test('malformed configured signing credentials never reach fetch', async () => {
  const m = await client();
  for (const field of ['apiKey', 'secret'])
    for (const value of [null, '', ['dummy-key'], 7]) {
      let calls = 0;
      await expect(
        m.requestWs(
          async () => {
            calls++;
            return new Response('{}');
          },
          { ...account, [field]: value },
          { method: 'auth.getToken' },
        ),
      ).rejects.toMatchObject({ code: 0 });
      expect(calls).toBe(0);
    }
});

test('a configured endpoint array is rejected before its string coercion can reach fetch', async () => {
  const m = await client();
  let calls = 0;
  await expect(
    m.requestWs(
      async () => {
        calls++;
        return new Response('{}');
      },
      { ...account, apiRoot: [account.apiRoot] },
      { method: 'auth.getToken' },
    ),
  ).rejects.toMatchObject({ code: 0 });
  expect(calls).toBe(0);
});
test('all XML session scalars validate their entities before authentication', async () => {
  const m = await client();
  for (const scalar of [
    '<name>&unknown;</name>',
    '<subscriber>&unknown;</subscriber>',
    '<name>A & B</name>',
  ])
    expect(() =>
      m.decodeWsResponse(
        `<lfm status="ok"><session>${scalar}<key>dummy-session</key></session></lfm>`,
      ),
    ).toThrow();
  expect(
    m.decodeWsResponse(
      '<lfm status="ok"><session><name>A &amp; B</name><key>dummy-session</key></session></lfm>',
    ),
  ).toEqual({ session: { key: 'dummy-session' } });
});
test('an external WsError preserves numeric code while sanitizing foreign exception text', async () => {
  const m = await client();
  const pending = m.requestWs(
    async () => {
      throw new m.WsError(9, 'dummy-sensitive-request');
    },
    account,
    { method: 'track.scrobble' },
  );
  await expect(pending).rejects.toMatchObject({ code: 9 });
  await expect(pending).rejects.toThrow(
    'Scrobbling service rejected the request',
  );
});
