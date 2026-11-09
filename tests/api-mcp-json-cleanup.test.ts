import { expect, test } from '@playwright/test';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { pathToFileURL } from 'node:url';

// The optional entry selects an owned unpatched published archive for the RED
// control. Ordinary runs always exercise the installed, maintained public SDK.
async function transport() {
  const entry = process.env.PEAR_MCP_JSON_PROBE_ENTRY;
  const Constructor = entry
    ? (await import(pathToFileURL(entry).href))
        .WebStandardStreamableHTTPServerTransport
    : WebStandardStreamableHTTPServerTransport;
  return new Constructor({
    sessionIdGenerator: () => '00000000-0000-4000-8000-000000000000',
    enableJsonResponse: true,
    maxRequestBodySize: 65536,
  });
}

test('public SDK JSON serialization failure settles numeric0 while string0 and later reuse remain independent', async () => {
  const http = await transport();
  let failNumeric = true;
  const errors: Error[] = [];
  const sends: Promise<void>[] = [];
  http.onmessage = (message: any) => {
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'owned-json-cleanup', version: '1' },
          }
        : message.id === 0 && failNumeric
          ? {
              toJSON() {
                throw new Error('owned serialization failure');
              },
            }
          : { owned: message.id };
    sends.push(
      http
        .send({ jsonrpc: '2.0', id: message.id, result })
        .catch((error: Error) => {
          errors.push(error);
        }),
    );
  };
  const post = (id: string | number, method = 'ping', initialized = true) =>
    http.handleRequest(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(initialized
            ? {
                'mcp-session-id': '00000000-0000-4000-8000-000000000000',
                'mcp-protocol-version': '2025-11-25',
              }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          ...(method === 'initialize'
            ? {
                params: {
                  protocolVersion: '2025-11-25',
                  capabilities: {},
                  clientInfo: { name: 'owned-probe', version: '1' },
                },
              }
            : {}),
        }),
      }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect((await post('initialize', 'initialize', false)).status).toBe(200);
    const numeric = post(0);
    const string = await post('0');
    expect(await string.json()).toEqual({
      jsonrpc: '2.0',
      id: '0',
      result: { owned: '0' },
    });
    const outcome = await Promise.race([
      numeric,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 300);
      }),
    ]);
    expect(
      outcome,
      'the original JSON POST must settle even if encoding throws',
    ).toBeDefined();
    expect(outcome!.status).toBe(500);
    expect((await outcome!.json()).error.code).toBe(-32603);
    await Promise.all(sends);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('owned serialization failure');
    failNumeric = false;
    const reused = await post(0);
    expect(await reused.json()).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { owned: 0 },
    });
  } finally {
    clearTimeout(timer);
    await http.close();
  }
});
