import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { request as httpRequest } from 'node:http';
import {
  createServer as httpsServer,
  request as httpsRequest,
} from 'node:https';
import { connect } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { musicModuleSource } from './api-music-source';
import { musicRequestFixture } from './api-music-request';

const root = path.resolve(import.meta.dirname, '../..');
const scopes = [
  'playback.read',
  'catalog.read',
  'personalized.read',
  'library.read',
  'comments.read',
  'playback.control',
  'queue.write',
];
const song = (i: number) => ({
  kind: 'song',
  id: 'v' + String(i).padStart(10, '0'),
  title: 'Owned ' + i,
  artists: [],
  durationSeconds: null,
});
const catalog = (playlist = false) => ({
  version: 1,
  items: Array.from({ length: 151 }, (_, i) =>
    playlist ? { ...song(i), kind: 'playlist', id: 'PLowned' + i } : song(i),
  ),
  shelves: [],
  continuation: null,
  targetRecipes: [],
});
const binding = { videoId: 'abcdefghijk', playbackEpoch: null };
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
export interface MusicRuntimeAdmission {
  environment: string;
  bindAddress: string;
  clientAddress: string;
  certSHA256: string;
}
export function parseMusicRuntimeAdmission(
  value: unknown,
): MusicRuntimeAdmission {
  if (
    !value ||
    typeof value !== 'object' ||
    !('environment' in value) ||
    typeof value.environment !== 'string' ||
    !('bindAddress' in value) ||
    typeof value.bindAddress !== 'string' ||
    !('clientAddress' in value) ||
    typeof value.clientAddress !== 'string' ||
    !('certSHA256' in value) ||
    typeof value.certSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.certSHA256)
  )
    throw Error('Explicit root runtime admission required');
  return {
    environment: value.environment,
    bindAddress: value.bindAddress,
    clientAddress: value.clientAddress,
    certSHA256: value.certSHA256,
  };
}

/** Real fixture-owned sockets and actual service/broker; native IPC is controlled. */
export async function musicRemoteHttpFixture(
  options: {
    tls?: boolean;
    remoteEnabled?: boolean;
    admission?: MusicRuntimeAdmission;
  } = {},
) {
  const tls = options.tls === true;
  const bindAddress = options.admission?.bindAddress ?? '127.0.0.1';
  const clientAddress = options.admission?.clientAddress ?? '127.0.0.1';
  const certPath = path.join(
      root,
      'tests/fixtures/api-music-http-tls/cert.pem',
    ),
    keyPath = path.join(root, 'tests/fixtures/api-music-http-tls/key.pem');
  const cert = await readFile(certPath),
    key = tls ? await readFile(keyPath) : undefined;
  const policy = await musicModuleSource(
    'src/plugins/api-server/backend/music-http-policy.ts',
  );
  if (options.admission) {
    if (
      !['macOS', 'Windows', 'Linux'].includes(options.admission.environment) ||
      createHash('sha256').update(cert).digest('hex') !==
        options.admission.certSHA256
    )
      throw Error('Invalid explicit runtime admission/certificate');
    for (const ip of [bindAddress, clientAddress]) {
      const normalized = policy.normalizeMusicIp(ip);
      if (
        !normalized ||
        normalized === '::1' ||
        normalized === '::' ||
        normalized === '0.0.0.0' ||
        normalized.startsWith('127.')
      )
        throw Error(
          'Runtime admission requires actual numeric nonloopback topology',
        );
    }
  }
  const f = await musicRequestFixture();
  const m = await musicModuleSource(
    [
      'src/plugins/api-server/backend/music-service.ts',
      'src/plugins/api-server/backend/music-grant-store.ts',
    ],
    { ipcMain: f.ipcMain },
  );
  const g = m;
  const route = await musicModuleSource(
    'src/plugins/api-server/backend/routes/music.ts',
    { ipcMain: f.ipcMain },
  );
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-remote-http-'));
  const store = new g.MusicGrantStore(path.join(folder, 'grants'));
  const config: any = {
    enabled: true,
    musicApiEnabled: true,
    hostname: bindAddress,
    port: 0,
    useHttps: tls,
    certPath: tls ? certPath : '',
    keyPath: tls ? keyPath : '',
    musicApiRemoteEnabled: options.remoteEnabled !== false,
  };
  let owner: any,
    epoch = new AbortController();
  const service = m.createMusicService({
    window: f.window,
    config,
    grants: store,
    broker: f.broker,
    restListenerOwner: () => owner,
  });
  const release = f.broker.retain();
  const app = new Hono();
  route.registerMusicRoutes(
    app,
    () => service,
    (incoming: any) => (owner?.ownsSocket(incoming.socket) ? owner : undefined),
  );
  app.use('*', cors());
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Private-Network', 'true');
    await next();
  });
  app.get('/api/v1/song', (c) => c.json({ legacy: 'NONE unchanged' }));
  const server = serve({
    fetch: app.fetch,
    hostname: bindAddress,
    port: 0,
    ...(tls ? { createServer: httpsServer, serverOptions: { cert, key } } : {}),
  });
  const sockets = new Set<any>();
  const membership = new WeakSet<object>();
  server.on('connection', (s) => {
    sockets.add(s);
    membership.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('secureConnection', (s) => {
    sockets.add(s);
    membership.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('owned listen timed out')),
      3000,
    );
    server.once('listening', () => {
      clearTimeout(timer);
      resolve();
    });
    server.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  }).catch(async (error) => {
    epoch.abort();
    service.stop();
    for (const socket of sockets) socket.destroy();
    server.close();
    release();
    f.broker.dispose();
    await rm(folder, { recursive: true, force: true });
    throw error;
  });
  const address = server.address() as any,
    port = address.port;
  config.port = port;
  config.musicApiRemoteResource = `${tls ? 'https' : 'http'}://music-http.fixture.invalid:${port}/api/v1/music`;
  const publish = (reconfigure = true) => {
    epoch.abort();
    epoch = new AbortController();
    if (reconfigure) service.configure({ ...config });
    const captured = epoch;
    owner = {
      identity: {},
      address: address.address,
      port,
      tls,
      resources: policy.musicHttpResources(config),
      signal: captured.signal,
      current: () =>
        owner?.signal === captured.signal &&
        !captured.signal.aborted &&
        server.listening,
      ownsSocket: (s: object) => membership.has(s),
    };
    return owner;
  };
  publish();
  const observations: any[] = [];
  let observationOverflow = false,
    tlsResponseOverflow = false;
  const tlsResponses: {
    version: string | null;
    authorized: boolean;
    fingerprint: string | undefined;
  }[] = [];
  server.on('request', (incoming) => {
    if (observations.length >= 256) {
      observationOverflow = true;
      return;
    }
    observations.push({
      peer: incoming.socket.remoteAddress,
      local: incoming.socket.localAddress,
      port: incoming.socket.localPort,
      tls: (incoming.socket as any).encrypted === true,
      tlsProtocol: tls ? (incoming.socket as any).getProtocol() : null,
      owned: owner?.ownsSocket(incoming.socket),
      epoch: owner?.identity,
    });
  });
  const grant = await store.issue(
    'Explicit remote',
    'rest',
    config.musicApiRemoteResource,
    scopes,
    () => true,
  );
  const local = await store.issue(
    'Local only',
    'rest',
    `${tls ? 'https' : 'http'}://127.0.0.1:${port}/api/v1/music`,
    scopes,
    () => true,
  );
  let hold = false;
  const held: any[] = [];
  const value = (input: any) => {
    if (input.operation === 'current') return snapshot;
    if (input.operation === 'queue')
      return {
        version: 1,
        queueRevision: 'a'.repeat(32),
        selectedIndex: 0,
        items: catalog().items,
      };
    if (input.operation === 'lyrics')
      return {
        version: 1,
        binding,
        lyrics: {
          videoId: binding.videoId,
          available: true,
          lyrics: 'Owned lyrics',
          source: 'Public fixture',
        },
      };
    if (input.operation === 'related')
      return { version: 1, binding, source: catalog() };
    if (input.operation === 'comments')
      return {
        version: 1,
        binding,
        requests: 1,
        comments: {
          available: true,
          comments: [
            {
              id: 'owned',
              author: 'Fixture',
              text: 'Owned comment',
              publishedTime: null,
              likeCount: null,
              replyCount: null,
              pinned: false,
              verified: false,
              creator: false,
            },
          ],
          commentCount: '1',
          continuation: null,
        },
      };
    if (input.operation === 'control')
      return { version: 1, phase: 'owned_control_dispatch' };
    if (input.operation === 'navigate')
      return { version: 1, phase: 'owned_dispatch' };
    if (input.operation === 'mutate-queue')
      return {
        version: 1,
        phase: 'owned_queue_dispatch',
        ...(['enqueue_song', 'enqueue_playlist'].includes(input.command.action)
          ? { count: 1 }
          : {}),
      };
    return catalog(input.operation === 'library');
  };
  const send = f.contents.send;
  f.contents.send = (channel: string, packet: any) => {
    send(channel, packet);
    if (channel === 'peard:music-owner-query')
      queueMicrotask(() => f.ready(packet));
    if (channel === 'peard:music-read') {
      const q = f.sent.find(
        (p) =>
          p[0] === 'peard:music-owner-query' &&
          p[1].requestId === packet.requestId,
      )![1];
      if (hold) held.push({ q, input: packet.input });
      else
        queueMicrotask(() =>
          f.settled(q, { ok: true, value: value(packet.input) }),
        );
    }
  };
  const host = `music-http.fixture.invalid:${port}`;
  const clients = new Set<any>();
  const startHttp = (
    target: string,
    method = 'GET',
    body?: string,
    headers: Record<string, string> = {},
    token = grant.token,
  ) => {
    let req: ReturnType<typeof httpRequest>;
    const response = new Promise<any>((resolve, reject) => {
      req = (tls ? httpsRequest : httpRequest)(
        {
          hostname: bindAddress,
          localAddress: clientAddress,
          port,
          path: target,
          method,
          agent: false,
          ...(tls
            ? {
                ca: cert,
                servername: 'music-http.fixture.invalid',
                rejectUnauthorized: true,
              }
            : {}),
          lookup: () => {
            throw Error('Fixture prohibits DNS');
          },
          headers: {
            host,
            authorization: 'Bearer ' + token,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            ...headers,
          },
        },
        (res) => {
          if (tls) {
            const socket = res.socket as any;
            if (tlsResponses.length >= 256) tlsResponseOverflow = true;
            else
              tlsResponses.push({
                version: socket.getProtocol(),
                authorized: socket.authorized === true,
                fingerprint: socket
                  .getPeerCertificate()
                  .fingerprint256?.replaceAll(':', '')
                  .toLowerCase(),
              });
          }
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              body: text ? JSON.parse(text) : null,
            }),
          );
        },
      );
      clients.add(req);
      req.once('close', () => clients.delete(req));
      req.setTimeout(5000, () => req.destroy(Error('owned request timed out')));
      req.on('error', reject);
      req.end(body);
    });
    return { request: req!, response };
  };
  const http = (...args: Parameters<typeof startHttp>) =>
    startHttp(...args).response;
  const raw = (message: string | Buffer) =>
    new Promise<string>((resolve, reject) => {
      const received: string[] = [];
      const underlying = connect({
        host: bindAddress,
        localAddress: clientAddress,
        port,
      });
      const socket = tls
        ? tlsConnect(
            {
              socket: underlying,
              ca: cert,
              servername: 'music-http.fixture.invalid',
              rejectUnauthorized: true,
            },
            () => socket.end(message),
          )
        : underlying;
      if (!tls) underlying.once('connect', () => socket.end(message));
      underlying.on('error', reject);
      socket.setTimeout(3000, () =>
        socket.destroy(Error('owned raw request timed out')),
      );
      socket.setEncoding('utf8');
      socket.on('data', (c) => received.push(String(c)));
      socket.on('end', () => resolve(received.join('')));
      socket.on('error', reject);
    });
  return {
    ...f,
    service,
    store,
    config,
    grant,
    local,
    host,
    port,
    tls,
    cert,
    server,
    http,
    startHttp,
    raw,
    observations,
    transportFacts(
      epochs: {
        label: 'disabled' | 'A' | 'B' | 'configured';
        identity: object;
      }[],
    ) {
      const normalize = (value: unknown) =>
        typeof value === 'string' ? policy.normalizeMusicIp(value) : undefined;
      const local = normalize(bindAddress),
        peer = normalize(clientAddress);
      const nonloopback = (ip: string | undefined) =>
        !!ip &&
        ip !== '::1' &&
        ip !== '::' &&
        ip !== '0.0.0.0' &&
        !ip.startsWith('127.');
      if (
        observationOverflow ||
        tlsResponseOverflow ||
        !local ||
        !peer ||
        !observations.length ||
        observations.length > 256 ||
        epochs.length !== 4 ||
        new Set(epochs.map((e) => e.identity)).size !== 4 ||
        epochs.map((e) => e.label).join('|') !== 'disabled|A|B|configured'
      )
        throw Error('Invalid measured transport facts');
      const totals = epochs.map((epoch) => ({
        label: epoch.label,
        observations: observations.filter(
          (observation) => observation.epoch === epoch.identity,
        ).length,
      }));
      for (const observed of observations) {
        if (
          normalize(observed.peer) !== peer ||
          normalize(observed.local) !== local ||
          observed.port !== port ||
          observed.tls !== tls ||
          observed.owned !== true ||
          !epochs.some((e) => e.identity === observed.epoch)
        )
          throw Error('Mismatched measured transport facts');
      }
      if (totals.some((e) => e.observations === 0))
        throw Error('Missing measured epoch');
      const versions: string[] = tls
        ? [...new Set(observations.map((o) => o.tlsProtocol))]
        : [];
      const fingerprint = tls
        ? new X509Certificate(cert).fingerprint256
            .replaceAll(':', '')
            .toLowerCase()
        : null;
      if (
        tls &&
        (!tlsResponses.length ||
          versions.some((v) => !['TLSv1.2', 'TLSv1.3'].includes(v)) ||
          tlsResponses.some(
            (r) =>
              !r.authorized ||
              r.fingerprint !== fingerprint ||
              !r.version ||
              !versions.includes(r.version),
          ))
      )
        throw Error('Unverified measured TLS facts');
      return {
        endpoint: {
          label: 'owned-v4',
          family: local.includes(':') ? 6 : 4,
          observations: observations.length,
          port,
          nonloopback: nonloopback(peer) && nonloopback(local),
          peerMatchesAdmission: observations.every(
            (o) => normalize(o.peer) === peer,
          ),
          localMatchesAdmission: observations.every(
            (o) => normalize(o.local) === local,
          ),
          owned: observations.every((o) => o.owned === true),
          epochs: totals,
        },
        tls: {
          encrypted: observations.every((o) => o.tls === true),
          versions: versions.sort(),
          verifiedResponses: tlsResponses.filter((r) => r.authorized).length,
          peerLeafFingerprint256: tls ? tlsResponses[0].fingerprint : null,
        },
      };
    },
    owner: () => owner,
    publish,
    retireListener: () => {
      epoch.abort();
      owner = undefined;
    },
    held,
    setHold: (v = true) => (hold = v),
    settle: () => {
      for (const h of held.splice(0))
        f.settled(h.q, { ok: true, value: value(h.input) });
    },
    async close() {
      epoch.abort();
      service.stop();
      // Register each owned close before destroying; a server close callback
      // alone does not attest completion of request/client socket close events.
      const closing = [...clients, ...sockets].map(
        (owned) =>
          new Promise<void>((resolve) => owned.once('close', () => resolve())),
      );
      for (const client of clients) client.destroy();
      for (const h of held.splice(0))
        f.settled(h.q, { ok: true, value: value(h.input) });
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('owned close timed out')),
          3000,
        );
        const serverClosed = new Promise<void>((closed) =>
          server.close(() => closed()),
        );
        Promise.all([...closing, serverClosed]).then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      release();
      f.broker.dispose();
      await rm(folder, { recursive: true, force: true });
      const stats = f.broker.stats();
      return {
        serverListening: server.listening,
        brokerDispatched: stats.dispatched,
        brokerQueued: stats.queued,
        openRequestClients: clients.size,
        openServerSockets: sockets.size,
        held: held.length,
        ownedStoreRemoval: 'completed' as const,
      };
    },
  };
}

export async function assertMusicRuntimeObservations(
  observations: any[],
  admission: MusicRuntimeAdmission,
  port: number,
  tls: boolean,
) {
  const policy = await musicModuleSource(
    'src/plugins/api-server/backend/music-http-policy.ts',
  );
  const nonloopback = (value: unknown) => {
    if (typeof value !== 'string') throw Error('Missing actual endpoint');
    const ip = policy.normalizeMusicIp(value);
    if (
      !ip ||
      ip === '::1' ||
      ip === '::' ||
      ip === '0.0.0.0' ||
      ip.startsWith('127.')
    )
      throw Error('Witness requires normalized numeric nonloopback endpoints');
    return ip;
  };
  const peer = nonloopback(admission.clientAddress),
    local = nonloopback(admission.bindAddress);
  if (!observations.length || observations.length > 256)
    throw Error('Missing or excessive actual socket observations');
  for (const observed of observations) {
    if (
      nonloopback(observed.peer) !== peer ||
      nonloopback(observed.local) !== local ||
      observed.port !== port ||
      observed.tls !== tls ||
      observed.owned !== true ||
      !observed.epoch
    )
      throw Error(
        'Actual socket witness does not match admitted endpoints/port/TLS/ownership',
      );
  }
}
