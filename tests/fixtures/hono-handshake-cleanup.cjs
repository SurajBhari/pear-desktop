const net = require('node:net');
const { once } = require('node:events');
const { Hono } = require('hono');
const { serve, upgradeWebSocket } = require('@hono/node-server');
const { WebSocketServer } = require('ws');

async function main() {
  const references = [];
  const app = new Hono();
  const upgrade = upgradeWebSocket(() => ({}));
  app.get('/ws', (context, next) => {
    references.push(new WeakRef(context.env.incoming));
    return upgrade(context, next);
  });
  const websocket = new WebSocketServer({ noServer: true });
  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
    websocket: { server: websocket },
  });
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  try {
    const statuses = [];
    for (const key of [null, 'not-a-valid-websocket-key']) {
      for (let index = 0; index < 6; index++) {
        statuses.push(
          await new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            let response = '';
            socket.setTimeout(3000, () =>
              socket.destroy(new Error('Handshake timeout')),
            );
            socket.on('error', reject);
            socket.on('data', (chunk) => {
              response += chunk.toString();
            });
            socket.on('end', () =>
              resolve(Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1])),
            );
            socket.on('connect', () => {
              const keyHeader =
                key === null ? '' : `Sec-WebSocket-Key: ${key}\r\n`;
              socket.write(
                `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n${keyHeader}\r\n`,
              );
            });
          }),
        );
      }
    }
    // Cross task boundaries so WeakRef's current-job guarantee is not in play.
    // Keep the server/helper alive: closing it could hide the retained map.
    for (let index = 0; index < 8; index++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      global.gc();
    }
    const retainedRequests = references.filter((reference) =>
      reference.deref(),
    ).length;
    process.stdout.write(
      JSON.stringify({
        capturedRequests: references.length,
        retainedRequests,
        statuses,
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
