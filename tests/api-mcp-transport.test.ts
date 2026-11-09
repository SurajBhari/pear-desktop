import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { musicModuleSource } from './helpers/api-music-source';

const scopes = [
  'playback.read',
  'catalog.read',
  'personalized.read',
  'library.read',
  'comments.read',
];
const snapshot = {
  version: 1,
  playbackEpoch: '1'.repeat(32) + ':' + '2'.repeat(32),
  current: null,
  state: 'stopped',
  elapsedSeconds: null,
  elapsedMilliseconds: null,
  durationSeconds: null,
  volume: null,
};
async function ownedPort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string')
    throw Error('Missing owned port');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}
async function acceptsConnection(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function fixture(permissions = scopes) {
  const m = await musicModuleSource([
    'src/plugins/api-server/backend/mcp.ts',
    'src/plugins/api-server/backend/music-service.ts',
    'src/plugins/api-server/backend/music-grant-store.ts',
    'src/plugins/api-server/backend/scheme/music.ts',
  ]);
  expect(typeof m.createMcpListener).toBe('function');
  let contents: string | null = null;
  const grants = new m.MusicGrantStore('/owned-virtual', Date.now, {
    read: async () => ({ contents, binding: 'owned' }),
    stage: async (_d: string, next: string) => ({
      commit: async () => {
        contents = next;
        return 'owned';
      },
      close: async () => {},
    }),
  });
  const source = new AbortController();
  let reads = 0;
  let read: () => Promise<unknown> = async () => snapshot;
  const admission = {};
  const broker = {
    retain: () => () => {},
    subscribeRetirement: () => () => {},
    capture: () => admission,
    isCurrent: (a: unknown) => a === admission,
    read: async () => {
      reads++;
      return await read();
    },
    resultOwner: () => ({
      epoch: '1'.repeat(32),
      retirementSignal: source.signal,
      current: () => !source.signal.aborted,
    }),
  };
  let listener: any;
  const service = m.createMusicService({
    window: {},
    config: { enabled: true, musicApiEnabled: false },
    grants,
    broker,
    resolveAccessOwner: () => listener?.owner,
  });
  listener = m.createMcpListener({ service, grants, port: 0 });
  await listener.start();
  const grant = await grants.issue(
    'Owned MCP',
    'mcp',
    listener.resource,
    permissions,
    () => true,
  );
  const headers = {
    Authorization: `Bearer ${grant.token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  const completions: Promise<{ status: number; body: unknown }>[] = [];
  const transport = new StreamableHTTPClientTransport(
    new URL(listener.resource),
    {
      requestInit: { headers: { Authorization: headers.Authorization } },
      fetch: async (input, init) => {
        const message =
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const response = await fetch(input, init);
        if (
          message &&
          typeof message === 'object' &&
          'method' in message &&
          message.method === 'tools/call'
        )
          completions.push(
            response
              .clone()
              .json()
              .then((body) => ({ status: response.status, body })),
          );
        return response;
      },
    },
  );
  const client = new Client({ name: 'owned-r9-fixture', version: '1' });
  await client.connect(transport);
  const post = (body: unknown, extra = {}) =>
    fetch(listener.resource, {
      method: 'POST',
      headers: {
        ...headers,
        'mcp-session-id': transport.sessionId!,
        'mcp-protocol-version': '2025-11-25',
        ...extra,
      },
      body: JSON.stringify(body),
    });
  return {
    m,
    service,
    grants,
    listener,
    client,
    transport,
    post,
    grant,
    source,
    completions,
    raw: (body: Buffer) =>
      fetch(listener.resource, {
        method: 'POST',
        headers: {
          ...headers,
          'mcp-session-id': transport.sessionId!,
          'mcp-protocol-version': '2025-11-25',
        },
        body: new Uint8Array(body),
      }),
    init: () =>
      fetch(listener.resource, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'bootstrap',
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'owned-raw', version: '1' },
          },
        }),
      }),
    get reads() {
      return reads;
    },
    setRead: (fn: () => Promise<unknown>) => {
      read = fn;
    },
    close: async () => {
      await client.close();
      await listener.stop();
      service.stop();
    },
  };
}

test('public SDK client initializes, lists strict nine read tools, calls useful service data and DELETEs', async () => {
  const f = await fixture();
  try {
    const listed = await f.client.listTools();
    expect(listed.tools).toHaveLength(9);
    expect(listed.tools.every((t) => t.inputSchema.type === 'object')).toBe(
      true,
    );
    expect(f.reads).toBe(0);
    const result = await f.client.callTool({
      name: 'music_now_playing',
      arguments: {},
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(snapshot);
    expect(f.reads).toBe(1);
    const invalid = await f.post({
      jsonrpc: '2.0',
      id: 'bad',
      method: 'tools/call',
      params: {
        name: 'music_now_playing',
        arguments: { token: 'secret-input-do-not-echo' },
      },
    });
    expect(await invalid.text()).not.toContain('secret-input-do-not-echo');
    expect(f.reads).toBe(1);
    await f.transport.terminateSession();
    expect(
      (await f.post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

test('empty-scope identity lists nothing and committed revoke retires the authenticated session', async () => {
  const f = await fixture([]);
  try {
    expect((await f.client.listTools()).tools).toEqual([]);
    expect(f.reads).toBe(0);
    await f.grants.revoke(f.grant.record.id, () => true);
    expect(
      (await f.post({ jsonrpc: '2.0', id: 0, method: 'ping' })).status,
    ).toBe(401);
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test('authenticated cancellation owns numeric zero and completes original HTTP while another call remains live', async () => {
  const f = await fixture();
  try {
    const initialized = await f.init();
    const sessionId = initialized.headers.get('mcp-session-id')!;
    await initialized.arrayBuffer();
    const post = (body: unknown) =>
      f.post(body, { 'mcp-session-id': sessionId });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const resolvers: ((value: unknown) => void)[] = [];
    f.setRead(() => new Promise((resolve) => resolvers.push(resolve)));
    const first = post({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/call',
      params: { name: 'music_now_playing', arguments: {} },
    });
    const second = post({
      jsonrpc: '2.0',
      id: '0',
      method: 'tools/call',
      params: { name: 'music_now_playing', arguments: {} },
    });
    await expect.poll(() => resolvers.length).toBe(2);
    expect(
      (
        await post({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 0 },
        })
      ).status,
    ).toBe(202);
    const canceled = await first;
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      id: 0,
      error: { code: -32800 },
    });
    resolvers[1](snapshot);
    expect(await (await second).json()).toMatchObject({
      id: '0',
      result: { structuredContent: snapshot },
    });
    resolvers[0](snapshot);
  } finally {
    await f.close();
  }
});

test('raw profile rejects batches, Origin, query target, unknown session, and foreign credentials without source work', async () => {
  const f = await fixture();
  try {
    expect(
      (await f.post([{ jsonrpc: '2.0', id: 7, method: 'ping' }])).status,
    ).toBe(400);
    expect(
      (
        await f.post(
          { jsonrpc: '2.0', id: 7, method: 'ping' },
          { Origin: 'http://localhost' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(
          { jsonrpc: '2.0', id: 7, method: 'ping' },
          { 'mcp-session-id': 'foreign' },
        )
      ).status,
    ).toBe(404);
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test('original source and committed grant retirement after the SDK await deny final application bytes', async () => {
  for (const retire of ['source', 'grant']) {
    const f = await fixture();
    let sdkAwaits = 0;
    const original =
      WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
    WebStandardStreamableHTTPServerTransport.prototype.handleRequest =
      async function (request, options) {
        const response = await original.call(this, request, options);
        sdkAwaits++;
        if (retire === 'source') f.source.abort();
        else await f.grants.revoke(f.grant.record.id, () => true);
        return response;
      };
    try {
      const received = await f
        .post({
          jsonrpc: '2.0',
          id: 'late-retire',
          method: 'tools/call',
          params: { name: 'music_now_playing', arguments: {} },
        })
        .then(
          async (response) => ({
            status: response.status,
            text: await response.text(),
          }),
          () => null,
        );
      expect(sdkAwaits).toBe(1);
      expect(received).toBeNull();
      expect(f.reads).toBe(1);
    } finally {
      WebStandardStreamableHTTPServerTransport.prototype.handleRequest =
        original;
      await f.close();
    }
  }
});

test('two real SDK clients deliver all nine reads through the shared service and native-source seam', async () => {
  const f = await fixture();
  const transport = new StreamableHTTPClientTransport(
    new URL(f.listener.resource),
    { requestInit: { headers: { Authorization: `Bearer ${f.grant.token}` } } },
  );
  const other = new Client({ name: 'owned-second-client', version: '1' });
  const item = {
    kind: 'song',
    id: 'abcdefghijk',
    title: 'Owned useful result',
    artists: [],
    durationSeconds: null,
  };
  const catalog = {
    version: 1,
    items: [item],
    shelves: [{ title: 'Owned shelf', start: 0, count: 1 }],
    continuation: null,
    targetRecipes: [],
  };
  const cases: [string, Record<string, unknown>, unknown][] = [
    ['music_now_playing', {}, snapshot],
    [
      'music_get_queue',
      {},
      {
        version: 1,
        queueRevision: 'a'.repeat(32),
        selectedIndex: 0,
        items: [item],
      },
    ],
    ['music_search', { query: 'Owned' }, catalog],
    ['music_browse', { target: { kind: 'playlist', id: 'PLowned' } }, catalog],
    ['music_home', {}, catalog],
    [
      'music_get_library_playlists',
      {},
      { ...catalog, items: [{ ...item, kind: 'playlist', id: 'PLowned' }] },
    ],
    [
      'music_lyrics',
      { videoId: item.id },
      {
        version: 1,
        binding: { videoId: item.id, playbackEpoch: null },
        lyrics: {
          videoId: item.id,
          available: true,
          lyrics: 'Owned literal lyrics',
          source: null,
        },
      },
    ],
    [
      'music_related',
      { videoId: item.id },
      {
        version: 1,
        binding: { videoId: item.id, playbackEpoch: null },
        source: catalog,
      },
    ],
    [
      'music_comments',
      { videoId: item.id },
      {
        version: 1,
        binding: { videoId: item.id, playbackEpoch: null },
        requests: 1,
        comments: {
          available: true,
          comments: [],
          commentCount: null,
          continuation: null,
        },
      },
    ],
  ];
  try {
    await other.connect(transport);
    expect((await other.listTools()).tools.map((tool) => tool.name)).toEqual(
      (await f.client.listTools()).tools.map((tool) => tool.name),
    );
    for (const [index, [name, args, value]] of cases.entries()) {
      f.setRead(async () => value);
      const result = await (index % 2 ? other : f.client).callTool({
        name,
        arguments: args,
      });
      expect(result.isError, name).toBeUndefined();
      expect(result.structuredContent, name).toBeTruthy();
      expect(result.content).toEqual([{ type: 'text', text: 'Music result.' }]);
    }
    expect(f.reads).toBe(9);
  } finally {
    await other.close();
    await f.close();
  }
});

test('session labels never upgrade a different grant and per-grant session capacity is finite', async () => {
  const f = await fixture();
  try {
    const foreign = await f.grants.issue(
      'Foreign owned grant',
      'mcp',
      f.listener.resource,
      scopes,
      () => true,
    );
    expect(
      (
        await f.post(
          { jsonrpc: '2.0', id: 'swap', method: 'ping' },
          { Authorization: `Bearer ${foreign.token}` },
        )
      ).status,
    ).toBe(404);
    for (let index = 0; index < 3; index++) {
      const response = await f.init();
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect((await f.init()).status).toBe(503);
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test('advertised strict schemas and production calls reject the same invalid authority and selector shapes', async () => {
  const f = await fixture();
  const invalid: Record<string, unknown> = {
    music_now_playing: { token: 'do-not-echo' },
    music_get_queue: { limit: 0 },
    music_search: { query: 'Owned', cursor: 'mcur_' + 'a'.repeat(43) },
    music_browse: {
      target: { kind: 'playlist', id: 'PLowned', token: 'do-not-echo' },
    },
    music_home: { unknown: true },
    music_get_library_playlists: { limit: 0 },
    music_lyrics: { videoId: 'abcdefghijk', current: true },
    music_related: { videoId: 'abcdefghijk', cursor: 'mcur_' + 'a'.repeat(43) },
    music_comments: { videoId: 'abcdefghijk', allowPublicWebFallback: 'yes' },
  };
  try {
    const validator = new AjvJsonSchemaValidator();
    for (const tool of (await f.client.listTools()).tools) {
      expect(
        validator.getValidator(tool.inputSchema)(invalid[tool.name]).valid,
        tool.name,
      ).toBe(false);
      const response = await f.post({
        jsonrpc: '2.0',
        id: 'invalid-' + tool.name,
        method: 'tools/call',
        params: { name: tool.name, arguments: invalid[tool.name] },
      });
      const text = await response.text();
      expect(text).not.toContain('do-not-echo');
      const message = JSON.parse(text);
      expect(
        Boolean(
          message &&
          typeof message === 'object' &&
          ('error' in message ||
            ('result' in message &&
              message.result &&
              typeof message.result === 'object' &&
              'isError' in message.result &&
              message.result.isError === true)),
        ),
        tool.name,
      ).toBe(true);
    }
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test('advertised JSON grammar preserves video IDs playlist patterns and Unicode query refinement', async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    const ajv = new AjvJsonSchemaValidator();
    for (const [name, schema, cases] of [
      [
        'music_lyrics',
        f.m.musicLyricsArgumentsSchema,
        [{ videoId: 'bad' }, { videoId: 'abcdefghijk' }, { current: true }],
      ],
      [
        'music_browse',
        f.m.musicBrowseArgumentsSchema,
        [
          { target: { kind: 'playlist', id: 'invalid' } },
          { target: { kind: 'playlist', id: 'PLowned' } },
        ],
      ],
      [
        'music_search',
        f.m.musicSearchArgumentsSchema,
        [
          { query: ' ' },
          { query: '🌍'.repeat(256) },
          { query: '🌍'.repeat(257) },
          { query: '\uD800' },
          { query: 'owned\n' },
        ],
      ],
    ] as const) {
      const tool = tools.find((tool) => tool.name === name)!;
      const validate = ajv.getValidator(tool.inputSchema);
      for (const args of cases)
        expect(validate(args).valid, name + JSON.stringify(args)).toBe(
          schema.safeParse(args).success,
        );
    }
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test('real SDK client local cancellation is followed by observed original POST completion', async () => {
  const f = await fixture();
  let settle: ((value: unknown) => void) | undefined;
  try {
    f.setRead(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const controller = new AbortController();
    const called = f.client.callTool(
      { name: 'music_now_playing', arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    const observed = called.then(
      () => false,
      () => true,
    );
    await expect.poll(() => f.reads).toBe(1);
    controller.abort();
    expect(await observed).toBe(true);
    await expect.poll(() => f.completions.length).toBe(1);
    expect(await f.completions[0]).toMatchObject({
      status: 200,
      body: { error: { code: -32800 } },
    });
    expect((await f.client.listTools()).tools).toHaveLength(9);
  } finally {
    settle?.(snapshot);
    await f.close();
  }
});

test('fatal UTF8 body admission rejects malformed query bytes before native dispatch', async () => {
  const f = await fixture();
  try {
    const body = Buffer.concat([
      Buffer.from(
        '{"jsonrpc":"2.0","id":"utf8","method":"tools/call","params":{"name":"music_search","arguments":{"query":"',
      ),
      Buffer.from([0xff]),
      Buffer.from('"}}}'),
    ]);
    expect((await f.raw(body)).status).toBe(400);
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test('a live SDK session completes repeated sequential JSON requests without a lifetime request-count cap', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 160; index++) {
      const response = await f.post({
        jsonrpc: '2.0',
        id: 'sequence-' + index,
        method: 'ping',
      });
      expect(response.status, String(index)).toBe(200);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 'sequence-' + index,
        result: {},
      });
    }
    expect(
      (await f.post({ jsonrpc: '2.0', id: 'sequence-159', method: 'ping' }))
        .status,
    ).toBe(409);
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test('a live publication witness cannot authorize a different SDK-produced success payload', async () => {
  const f = await fixture();
  const original =
    WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
  WebStandardStreamableHTTPServerTransport.prototype.handleRequest =
    async function (request, options) {
      const response = await original.call(this, request, options);
      const message = (await response.json()) as {
        result: { structuredContent: unknown };
      };
      message.result.structuredContent = { unowned: 'SDK fabricated success' };
      return new Response(JSON.stringify(message), {
        status: response.status,
        headers: response.headers,
      });
    };
  try {
    const response = await f.post({
      jsonrpc: '2.0',
      id: 'payload-swap',
      method: 'tools/call',
      params: { name: 'music_now_playing', arguments: {} },
    });
    const text = await response.text();
    expect(text).not.toContain('SDK fabricated success');
    expect(f.reads).toBe(1);
  } finally {
    WebStandardStreamableHTTPServerTransport.prototype.handleRequest = original;
    await f.close();
  }
});

for (const concurrent of [false, true]) {
  test(`stop drains a pending bind and permits immediate same-port replacement: concurrent=${concurrent}`, async () => {
    const f = await fixture();
    const port = await ownedPort();
    const listener = f.m.createMcpListener({
      service: f.service,
      grants: f.grants,
      port,
    });
    let replacement: ReturnType<typeof f.m.createMcpListener> | undefined;
    try {
      const starting = listener.start();
      const stopping = listener.stop();
      if (concurrent) await Promise.all([listener.stop(), listener.stop()]);
      await stopping;
      await starting;
      await listener.stop();
      expect(listener.owner.current()).toBe(false);
      expect(await acceptsConnection(port)).toBe(false);
      replacement = f.m.createMcpListener({
        service: f.service,
        grants: f.grants,
        port,
      });
      await replacement.start();
      expect(await acceptsConnection(port)).toBe(true);
      await Promise.all([
        replacement.stop(),
        replacement.stop(),
        replacement.stop(),
      ]);
      expect(await acceptsConnection(port)).toBe(false);
      expect(f.reads).toBe(0);
    } finally {
      await replacement?.stop();
      await listener.stop();
      await f.close();
    }
  });
}
