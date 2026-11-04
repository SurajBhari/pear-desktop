import { test, expect } from '@playwright/test';
import { musicModuleSource } from './helpers/api-music-source';
import { musicServiceFixture } from './helpers/api-music-service';

const remote = 'http://music-http.fixture.invalid:26538/api/v1/music';
const config = {
  enabled: true,
  musicApiEnabled: true,
  hostname: '127.0.0.1',
  port: 26538,
  useHttps: false,
};
async function policySource() {
  return musicModuleSource(
    'src/plugins/api-server/backend/music-http-policy.ts',
  );
}

test('canonical remote resources are opt-in and invalid remote configuration preserves local authority', async () => {
  const p = await policySource();
  expect(typeof p.musicHttpResources).toBe('function');
  expect(p.musicHttpResources(config)).toEqual({
    local: 'http://127.0.0.1:26538/api/v1/music',
  });
  expect(
    p.musicHttpResources({
      ...config,
      musicApiRemoteEnabled: true,
      musicApiRemoteResource: remote,
    }),
  ).toEqual({ local: 'http://127.0.0.1:26538/api/v1/music', remote });
  for (const resource of [
    undefined,
    '',
    remote + '/',
    remote + '?x',
    remote + '#x',
    remote.replace('/api/v1/music', '/api/v1/%6dusic'),
    remote.replace('http://', 'ftp://'),
    'http://u:p@music-http.fixture.invalid:26538/api/v1/music',
    'http://127.1.2.3:26538/api/v1/music',
    'http://[::ffff:7f00:1]:26538/api/v1/music',
    'http://localhost:26538/api/v1/music',
    'http://0.0.0.0:26538/api/v1/music',
    'http://[::]:26538/api/v1/music',
    'http://*.invalid:26538/api/v1/music',
    remote.replace('http:', 'HTTP:'),
  ]) {
    expect(
      p.musicHttpResources({
        ...config,
        musicApiRemoteEnabled: true,
        musicApiRemoteResource: resource,
      }),
      String(resource),
    ).toEqual({ local: 'http://127.0.0.1:26538/api/v1/music' });
  }
  expect(
    p.musicHttpResources({
      ...config,
      hostname: '192.0.2.1',
      musicApiRemoteEnabled: true,
      musicApiRemoteResource: remote,
    }),
  ).toEqual({ remote });
  expect(
    p.musicHttpResources({
      ...config,
      musicApiEnabled: false,
      musicApiRemoteEnabled: true,
      musicApiRemoteResource: remote,
    }),
  ).toEqual({});
});

test('IP identities normalize IPv6 and both mapped IPv4 spellings without DNS or CIDR inference', async () => {
  const p = await policySource();
  expect(typeof p.normalizeMusicIp).toBe('function');
  for (const [a, b] of [
    ['::ffff:127.2.3.4', '127.2.3.4'],
    ['::ffff:7f02:304', '127.2.3.4'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
  ])
    expect(p.normalizeMusicIp(a)).toBe(b);
  for (const x of [
    undefined,
    '',
    'localhost',
    '127.1',
    '127.0.0.1 ',
    '999.1.1.1',
    'fe80::1%en0',
  ])
    expect(p.normalizeMusicIp(x)).toBeUndefined();
});

test('pure preflight selects exact audiences from owned socket facts and rejects raw authority ambiguity', async () => {
  const p = await policySource();
  expect(typeof p.musicHttpPolicy).toBe('function');
  const socket = {
    remoteAddress: '::ffff:127.0.0.1',
    localAddress: '127.0.0.1',
    localPort: 26538,
  };
  const owner = {
    identity: {},
    address: '127.0.0.1',
    port: 26538,
    tls: false,
    resources: { local: 'http://127.0.0.1:26538/api/v1/music', remote },
    signal: new AbortController().signal,
    current: () => true,
    ownsSocket: (s: object) => s === socket,
  };
  const token = 'pmg_' + 'A'.repeat(43);
  const incoming = {
    socket,
    rawHeaders: ['Host', '127.0.0.1:26538', 'Authorization', 'Bearer ' + token],
  };
  // Use an actual accepted bearer grammar, not a legacy token.
  const f = await musicServiceFixture();
  try {
    incoming.rawHeaders[3] = 'Bearer ' + f.grant.token;
    expect(p.musicHttpPolicy(incoming, owner)).toEqual({
      token: f.grant.token,
      resource: owner.resources.local,
    });
    incoming.rawHeaders[1] = 'music-http.fixture.invalid:26538';
    expect(p.musicHttpPolicy(incoming, owner).resource).toBe(remote);
    socket.remoteAddress = '198.51.100.23';
    expect(p.musicHttpPolicy(incoming, owner).resource).toBe(remote);
    incoming.rawHeaders[1] = '127.0.0.1:26538';
    expect(() => p.musicHttpPolicy(incoming, owner)).toThrow();
    socket.remoteAddress = '::ffff:7f00:1';
    expect(p.musicHttpPolicy(incoming, owner).resource).toBe(
      owner.resources.local,
    );
    for (const extra of [
      ['Host', '127.0.0.1:26538'],
      ['Authorization', 'Bearer ' + f.grant.token],
      ['Content-Type', 'application/json', 'Content-Type', 'application/json'],
      ['Origin', ''],
      ['Origin', 'null'],
      ['Forwarded', ''],
      ['X-Forwarded-For', '127.0.0.1'],
    ])
      expect(() =>
        p.musicHttpPolicy(
          { ...incoming, rawHeaders: [...incoming.rawHeaders, ...extra] },
          owner,
        ),
      ).toThrow();
    for (const patch of [
      { port: 26539 },
      { address: '127.0.0.2' },
      { tls: true },
      { current: () => false },
      { ownsSocket: () => false },
    ])
      expect(() =>
        p.musicHttpPolicy(incoming, { ...owner, ...patch }),
      ).toThrow();
    socket.localAddress = '127.0.0.2';
    expect(
      p.musicHttpPolicy(incoming, { ...owner, address: '0.0.0.0' }).resource,
    ).toBe(owner.resources.local);
    expect(
      p.musicHttpPolicy(incoming, { ...owner, address: '::' }).resource,
    ).toBe(owner.resources.local);
  } finally {
    await f.close();
  }
});

test('Phase5 focused resource parser validates canonical audiences without activation', async () => {
  const p = await policySource();
  expect(typeof p.parseRemoteMusicResource).toBe('function');
  expect(p.parseRemoteMusicResource(remote)).toBe(remote);
  expect(
    p.parseRemoteMusicResource(
      'https://music-http.fixture.invalid/api/v1/music',
    ),
  ).toBe('https://music-http.fixture.invalid/api/v1/music');
  for (const value of [
    undefined,
    '',
    ' ' + remote,
    remote + '/',
    remote + '?x',
    remote + '#x',
    'http://127.0.0.1/api/v1/music',
    'http://localhost/api/v1/music',
    'http://0.0.0.0/api/v1/music',
  ])
    expect(p.parseRemoteMusicResource(value)).toBeUndefined();
});

test('Phase5 selected native grant rejects config listener and same-frame ABA then recovers', async () => {
  const menuSource = await musicModuleSource(
    'src/plugins/api-server/music-menu.ts',
  );
  expect(typeof menuSource.createRemoteMusicGrantMenu).toBe('function');
  const { musicRequestFixture } = await import('./helpers/api-music-request');
  for (const kind of ['config', 'listener', 'frame']) {
    const f = await musicServiceFixture(),
      n = await musicRequestFixture();
    const cfg = {
      ...config,
      hostname: '192.0.2.1',
      musicApiRemoteEnabled: true,
      musicApiRemoteResource: remote,
    };
    let lifetime = new AbortController();
    const owner = () => {
      const captured = lifetime;
      return {
        identity: {},
        address: '127.0.0.1',
        port: 26538,
        tls: false,
        resources: { remote },
        signal: captured.signal,
        current: () => !captured.signal.aborted,
        ownsSocket: () => true,
      };
    };
    let listener = owner();
    const service = f.m.createMusicService({
      window: n.window,
      config: cfg,
      grants: f.store,
      broker: n.broker,
      restListenerOwner: () => listener,
    });
    let issues = 0,
      copies = 0;
    const issue = f.store.issue.bind(f.store);
    f.store.issue = async (...args: any[]) => {
      issues++;
      return issue(...args);
    };
    const frame = n.contents.mainFrame;
    let retire = () => {
      if (kind === 'config') {
        service.configure({ ...cfg, musicApiRemoteEnabled: false });
        service.configure(cfg);
      }
      if (kind === 'listener') {
        lifetime.abort();
        lifetime = new AbortController();
        listener = owner();
      }
      if (kind === 'frame') {
        n.contents.emit(
          'did-start-navigation',
          {},
          'fixture://owned',
          false,
          true,
        );
        n.contents.emit('did-navigate');
      }
    };
    const choices = [0, 2, 0];
    const menu = await menuSource.createRemoteMusicGrantMenu(
      {
        window: n.window,
        getConfig: () => cfg,
        setConfig: () => {},
        refresh: () => {},
      },
      (resource: string) => f.m.getMusicService(n.window, resource),
      {
        prompt: async () => {
          retire();
          return 'Phase5 ABA';
        },
        promptResource: async () => remote,
        show: async () => ({ response: choices.shift() }),
        copy: () => {
          copies++;
        },
      },
    );
    try {
      expect(f.m.getMusicService(n.window)).toBeUndefined();
      await menu
        .find((entry: any) => entry.label === 'Create client grant…')
        .click();
      expect(issues).toBe(0);
      expect(copies).toBe(0);
      expect(n.contents.mainFrame === frame).toBe(true);
      retire = () => {};
      await menu
        .find((entry: any) => entry.label === 'Create client grant…')
        .click();
      expect(issues).toBe(1);
      expect(copies).toBe(1);
    } finally {
      service.stop();
      n.broker.dispose();
      await f.close();
    }
  }
});

test('namespace classification consumes absolute and encoded aliases without claiming unrelated paths', async () => {
  const p = await policySource();
  expect(typeof p.isMusicHttpNamespace).toBe('function');
  for (const target of [
    '/api/v1/music',
    '/api/v1/music/current',
    '/api/v1/music%2fcurrent',
    '/api/v1/%6dusic/current',
    'http://fixture.invalid/api/v1/music/current',
  ])
    expect(p.isMusicHttpNamespace(target, target)).toBe(true);
  expect(p.isMusicHttpNamespace('/api/v1/musical', '/api/v1/musical')).toBe(
    false,
  );
});

test('selected remote REST works without local resource and production seam never falls back when undefined', async () => {
  const f = await musicServiceFixture();
  const m = f.m;
  const window = {};
  const controller = new AbortController();
  let listener: any = {
    identity: {},
    address: '127.0.0.1',
    port: 26538,
    tls: false,
    resources: { remote },
    signal: controller.signal,
    current: () => !controller.signal.aborted,
    ownsSocket: () => true,
  };
  const cfg = {
    ...config,
    hostname: '192.0.2.1',
    musicApiRemoteEnabled: true,
    musicApiRemoteResource: remote,
  };
  const service = m.createMusicService({
    window,
    config: cfg,
    grants: f.store,
    broker: f.service.broker,
    restListenerOwner: () => listener,
  });
  try {
    expect(service.enabled).toBe(true);
    expect(m.getMusicService(window)).toBeUndefined();
    expect(m.getMusicService(window, remote)).toBe(service);
    expect(service.captureNativeOwner().current()).toBe(false);
    expect(service.captureNativeOwner(remote).current()).toBe(true);
    const g = await f.store.issue(
      'Remote',
      'rest',
      remote,
      ['catalog.read'],
      () => true,
    );
    const inv = {
      token: g.token,
      transport: 'rest',
      resource: remote,
      signal: new AbortController().signal,
    };
    expect(
      (await service.searchFor(inv, { query: 'owned', limit: 100 })).items,
    ).toHaveLength(100);
    const captured = service.captureNativeOwner(remote);
    controller.abort();
    listener = undefined;
    expect(captured.current()).toBe(false);
    expect(service.enabled).toBe(false);
    await expect(
      service.searchFor(inv, { query: 'owned', limit: 100 }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    listener = {
      identity: {},
      address: '127.0.0.1',
      port: 26538,
      tls: false,
      resources: { remote },
      signal: new AbortController().signal,
      current: () => true,
      ownsSocket: () => true,
    };
    expect(service.enabled).toBe(true);
    expect(captured.current()).toBe(false);
    expect(
      (await service.searchFor(inv, { query: 'owned', limit: 100 })).items,
    ).toHaveLength(100);
  } finally {
    service.stop();
    await f.close();
  }
});

test('remote configuration defaults false and leaves resource unconfigured', async () => {
  const m = await musicModuleSource('src/plugins/api-server/config.ts');
  expect(m.defaultAPIServerConfig.musicApiRemoteEnabled).toBe(false);
  expect(
    Object.hasOwn(m.defaultAPIServerConfig, 'musicApiRemoteResource'),
  ).toBe(false);
});

test('present undefined REST listener seam cannot disable a registered MCP owner on the same owned service', async () => {
  const f = await musicServiceFixture();
  const m = f.m;
  const resource = 'http://127.0.0.1:26539/mcp',
    window = {};
  const owner = { identity: {}, current: () => true };
  const service = m.createMusicService({
    window,
    config: { ...config, musicApiEnabled: false, hostname: '192.0.2.1' },
    grants: f.store,
    broker: f.service.broker,
    restListenerOwner: () => undefined,
    resolveAccessOwner: (transport: string, audience: string) =>
      transport === 'mcp' && audience === resource ? owner : undefined,
  });
  try {
    const grant = await f.store.issue(
      'Owned MCP',
      'mcp',
      resource,
      ['catalog.read'],
      () => true,
    );
    expect(service.enabled).toBe(false);
    expect(m.getMusicService(window)).toBeUndefined();
    expect(service.captureNativeOwner().current()).toBe(false);
    expect(
      (
        await service.searchFor(
          {
            token: grant.token,
            transport: 'mcp',
            resource,
            session: { id: 'stable', current: () => true },
            signal: new AbortController().signal,
          },
          { query: 'owned', limit: 100 },
        )
      ).items,
    ).toHaveLength(100);
    await expect(
      service.searchFor(
        {
          token: grant.token,
          transport: 'rest',
          resource: remote,
          signal: new AbortController().signal,
        },
        { query: 'owned', limit: 100 },
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  } finally {
    service.stop();
    await f.close();
  }
});
