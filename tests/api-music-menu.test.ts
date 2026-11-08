import { test, expect } from '@playwright/test';
import { musicModuleSource } from './helpers/api-music-source';
const resource = 'http://127.0.0.1:26538/api/v1/music';
async function fixture(responses: number[] = [2, 0]) {
  const m = await musicModuleSource('src/plugins/api-server/music-menu.ts', {
    ipcMain: {},
  });
  expect(typeof m.createMusicGrantMenu).toBe('function');
  let live = true,
    revision = 1;
  const copies: string[] = [],
    issues: any[] = [],
    revoked: string[] = [],
    writes: any[] = [],
    dialogs: any[] = [];
  const config: any = {
    enabled: true,
    musicApiEnabled: true,
    hostname: '127.0.0.1',
    port: 26538,
    secret: 'unchanged',
    authorizedClients: ['keep'],
  };
  const grant = {
    token: 'synthetic-native-only-bearer',
    record: {
      id: 'fixture-id',
      name: 'Fixture',
      resource,
      transport: 'rest',
      scopes: [],
      expiresAt: 86400000,
    },
  };
  const store = {
    issue: async (...args: any[]) => {
      issues.push(args);
      if (!args[4]()) throw { code: 'retired' };
      return grant;
    },
    revoke: async (id: string) => {
      revoked.push(id);
    },
    list: async () => [grant.record],
  };
  const service = {
    resource,
    grants: store,
    captureNativeOwner() {
      const r = revision;
      return { current: () => live && revision === r };
    },
  };
  const native = {
    prompt: async () => 'Fixture',
    show: async (options: any) => {
      dialogs.push(options);
      return { response: responses.shift() ?? 3 };
    },
    copy: (token: string) => copies.push(token),
  };
  const ctx: any = {
    window: {},
    getConfig: async () => config,
    setConfig: async (v: any) => writes.push(v),
    refresh: () => {},
  };
  const menu = await m.createMusicGrantMenu(ctx, () => service, native);
  return {
    menu,
    native,
    config,
    copies,
    issues,
    revoked,
    writes,
    dialogs,
    retire: () => {
      live = false;
    },
    change: () => {
      revision++;
    },
  };
}
test('native grant editor begins empty scopes shows exact local resource and copies only explicit action', async () => {
  const f = await fixture();
  await f.menu.find((i: any) => i.label === 'Create client grant…').click();
  expect(f.issues[0].slice(0, 4)).toEqual(['Fixture', 'rest', resource, []]);
  expect(f.copies).toEqual(['synthetic-native-only-bearer']);
  expect(JSON.stringify(f.dialogs)).not.toContain(
    'synthetic-native-only-bearer',
  );
  expect(f.dialogs[0].detail).toContain(resource);
  expect(f.dialogs[0].detail).toContain('24 hours');
});
test('cancel copy revokes newly issued grant and stale dialog ownership cannot issue or copy', async () => {
  const canceled = await fixture([2, 1]);
  await canceled.menu
    .find((i: any) => i.label === 'Create client grant…')
    .click();
  expect(canceled.copies).toEqual([]);
  expect(canceled.revoked).toEqual(['fixture-id']);
  const stale = await fixture();
  stale.native.prompt = async () => {
    stale.retire();
    return 'Fixture';
  };
  await stale.menu.find((i: any) => i.label === 'Create client grant…').click();
  expect(stale.issues).toEqual([]);
  expect(stale.copies).toEqual([]);
  const change = await fixture();
  change.native.show = async () => {
    change.change();
    return { response: 2 };
  };
  await change.menu
    .find((i: any) => i.label === 'Create client grant…')
    .click();
  expect(change.issues).toEqual([]);
});
test('grant enable writes only enabled leaf and native revocation is explicit', async () => {
  const f = await fixture([0]);
  await f.menu
    .find((i: any) => i.type === 'checkbox')
    .click({ checked: false });
  expect(f.writes).toEqual([{ musicApiEnabled: false }]);
  expect(f.config.secret).toBe('unchanged');
  expect(f.config.authorizedClients).toEqual(['keep']);
  await f.menu.find((i: any) => i.label === 'Revoke client grants…').click();
  expect(f.revoked).toEqual(['fixture-id']);
});

test('native prompt and permission dialog disappearance settle without issuing or copying a grant', async () => {
  for (const stage of ['prompt', 'permissions']) {
    const f = await fixture();
    if (stage === 'prompt')
      f.native.prompt = async () => {
        throw Error('Owned prompt retired');
      };
    else
      f.native.show = async () => {
        throw Error('Owned permissions dialog retired');
      };
    await expect(
      f.menu.find((i: any) => i.label === 'Create client grant…').click(),
    ).resolves.toBeUndefined();
    expect(f.issues).toEqual([]);
    expect(f.copies).toEqual([]);
  }
});
// C1: preserve the original grant-editor tests above byte-for-byte.
test('native editor independently selects Home and library with empty defaults and explicit copy', async () => {
  for (const [button, scope] of [
    [4, 'personalized.read'],
    [5, 'library.read'],
  ] as const) {
    const f = await fixture([button, 2, 0]);
    await f.menu
      .find((i: any) => i.label.startsWith('Create client grant'))
      .click();
    expect(f.issues).toHaveLength(1);
    expect(f.issues[0][3]).toEqual([scope]);
    expect(f.copies).toEqual(['synthetic-native-only-bearer']);
    expect(f.dialogs[0].detail).toContain('Selected: none');
    expect(f.dialogs[0].buttons[4]).toContain('Home');
    expect(f.dialogs[0].buttons[5]).toContain('library');
    expect(JSON.stringify(f.dialogs)).not.toContain(
      'synthetic-native-only-bearer',
    );
  }
});

test('MCP native target uses separate transport/resource and explicitly offers all seven scopes', async () => {
  const m = await musicModuleSource('src/plugins/api-server/music-menu.ts');
  const issues: unknown[][] = [],
    dialogs: any[] = [],
    writes: unknown[] = [];
  const choices = [6, 7, 8, 2, 0];
  const target = {
    transport: 'mcp',
    resource: 'http://127.0.0.1:26539/mcp',
    captureNativeOwner: () => ({ current: () => true }),
    grants: {
      issue: async (...args: unknown[]) => {
        issues.push(args);
        return { token: 'owned-native-mcp', record: { id: 'owned' } };
      },
      revoke: async () => {},
      list: async () => [],
    },
  };
  const menu = await m.createMusicGrantMenu(
    {
      getConfig: async () => ({ enabled: true, mcpEnabled: true }),
      setConfig: async (value: unknown) => {
        writes.push(value);
      },
      refresh: () => {},
    },
    () => target,
    {
      prompt: async () => 'Owned MCP',
      show: async (value: unknown) => {
        dialogs.push(value);
        return { response: choices.shift() };
      },
      copy: () => {},
    },
    'mcp',
  );
  await menu
    .find((entry: any) => entry.type === 'checkbox')
    .click({ checked: false });
  expect(writes).toEqual([{ mcpEnabled: false }]);
  await menu
    .find((entry: any) => entry.label === 'Create client grant…')
    .click();
  expect(issues[0].slice(0, 4)).toEqual([
    'Owned MCP',
    'mcp',
    target.resource,
    ['comments.read', 'playback.control', 'queue.write'],
  ]);
  expect(dialogs[0].detail).toContain('Selected: none');
  expect(JSON.stringify(dialogs)).toContain('playback control');
  expect(JSON.stringify(dialogs)).toContain('queue write');
  expect(JSON.stringify(dialogs)).not.toContain('owned-native-mcp');
});

const phase5Resource = 'http://phase5.fixture.invalid:26538/api/v1/music';
async function phase5MenuFixture(
  configPatch: Record<string, unknown> = {},
  choices = [2, 0],
) {
  const source = await musicModuleSource(
    'src/plugins/api-server/music-menu.ts',
  );
  expect(typeof source.createRemoteMusicGrantMenu).toBe('function');
  let windowAlive = true,
    contentsAlive = true,
    epoch = 0,
    refreshes = 0;
  const contents = { isDestroyed: () => !contentsAlive };
  const window = { isDestroyed: () => !windowAlive, webContents: contents };
  const config: any = {
    enabled: true,
    musicApiEnabled: true,
    musicApiRemoteEnabled: true,
    musicApiRemoteResource: phase5Resource,
    secret: 'public-fixture-preserved',
    authorizedClients: ['legacy'],
    mcpEnabled: true,
    ...configPatch,
  };
  const writes: any[] = [],
    dialogs: any[] = [],
    copies: string[] = [],
    issues: any[][] = [],
    revoked: string[] = [],
    resolutions: unknown[][] = [],
    captures: unknown[][] = [];
  const hooks: { read?: () => void; write?: () => void; issue?: () => void } =
    {};
  const record = {
    id: 'phase5-issued',
    name: 'Phase5 remote',
    transport: 'rest',
    resource: phase5Resource,
    scopes: [],
    expiresAt: 86400000,
  };
  const store = {
    issue: async (...args: any[]) => {
      issues.push(args);
      if (!args[4]()) throw Error('retired');
      hooks.issue?.();
      return { token: 'synthetic-phase5-only', record };
    },
    revoke: async (id: string, current: () => boolean) => {
      if (!current()) throw Error('retired');
      revoked.push(id);
    },
    list: async () => [
      { ...record, id: 'local-keep', resource },
      {
        ...record,
        id: 'mcp-keep',
        transport: 'mcp',
        resource: 'http://127.0.0.1:26539/mcp',
      },
      record,
    ],
  };
  const service = {
    get resource(): string {
      throw Error('Remote must not read local accessor');
    },
    grants: store,
    captureNativeOwner(this: unknown, ...args: unknown[]) {
      expect(this === service).toBe(true);
      expect(args).toEqual([phase5Resource]);
      captures.push(args);
      const captured = epoch;
      return { current: () => captured === epoch };
    },
  };
  const resolve = (...args: unknown[]) => {
    expect(args).toEqual([phase5Resource]);
    resolutions.push(args);
    return service;
  };
  const native = {
    prompt: async () => 'Phase5 remote',
    promptResource: async (_value: string): Promise<string | null> =>
      phase5Resource,
    show: async (options: any) => {
      dialogs.push(options);
      return { response: choices.shift() ?? 3 };
    },
    copy: (token: string) => {
      copies.push(token);
    },
  };
  const context: any = {
    window,
    getConfig: async () => {
      hooks.read?.();
      return config;
    },
    setConfig: async (patch: any) => {
      writes.push(patch);
      Object.assign(config, patch);
      hooks.write?.();
    },
    refresh: async () => {
      refreshes++;
    },
  };
  const menu = await source.createRemoteMusicGrantMenu(
    context,
    resolve,
    native,
  );
  return {
    source,
    menu,
    context,
    config,
    native,
    hooks,
    service,
    writes,
    dialogs,
    copies,
    issues,
    revoked,
    resolutions,
    captures,
    refreshes: () => refreshes,
    retireOwner: () => {
      epoch++;
    },
    retireWindow: () => {
      windowAlive = false;
    },
    retireContents: () => {
      contentsAlive = false;
    },
    replaceContents: () => {
      window.webContents = { isDestroyed: () => false };
    },
    edit: () =>
      menu.find((entry: any) => entry.label === 'Remote resource URL…'),
  };
}

test('Phase5 focused resource editor preserves unrelated leaves and never enables access', async () => {
  const f = await phase5MenuFixture({
    musicApiRemoteEnabled: false,
    musicApiRemoteResource: undefined,
  });
  const before = f.resolutions.length;
  f.native.promptResource = async () => {
    f.config.secret = 'public-fixture-concurrent';
    f.config.authorizedClients.push('keep-new');
    f.config.mcpEnabled = false;
    return phase5Resource;
  };
  await f.edit().click();
  expect(f.writes).toEqual([{ musicApiRemoteResource: phase5Resource }]);
  expect(f.config.musicApiRemoteEnabled).toBe(false);
  expect(f.config.secret).toBe('public-fixture-concurrent');
  expect(f.config.authorizedClients).toEqual(['legacy', 'keep-new']);
  expect(f.config.mcpEnabled).toBe(false);
  expect(f.resolutions.length).toBe(before);
  expect(f.refreshes()).toBe(1);
});

test('Phase5 resource cancellation invalid input and invalid enable preserve configuration', async () => {
  for (const value of [
    null,
    '',
    ' ',
    phase5Resource + '/',
    'http://127.0.0.1:26538/api/v1/music',
  ]) {
    const f = await phase5MenuFixture({
      musicApiRemoteResource: undefined,
      musicApiRemoteEnabled: false,
    });
    f.native.promptResource = async () => value;
    await f.edit().click();
    expect(f.writes).toEqual([]);
    expect(f.refreshes()).toBe(0);
  }
  const f = await phase5MenuFixture({
    musicApiRemoteResource: undefined,
    musicApiRemoteEnabled: false,
  });
  const toggle = f.menu.find((entry: any) => entry.type === 'checkbox');
  await toggle.click({ checked: true });
  expect(f.writes).toEqual([]);
  await toggle.click({ checked: false });
  expect(f.writes).toEqual([{ musicApiRemoteEnabled: false }]);
  for (const malformed of [{}, [], null, 42]) {
    const invalid = await phase5MenuFixture({
      musicApiRemoteResource: malformed,
    });
    const prompts: string[] = [];
    invalid.native.promptResource = async (value) => {
      prompts.push(typeof value);
      return null;
    };
    await invalid.edit().click();
    expect(prompts).toEqual([]);
    expect(invalid.writes).toEqual([]);
    expect(invalid.refreshes()).toBe(0);
    expect(invalid.dialogs.length).toBe(1);
  }
});

test('Phase5 config actions retire window or webContents before writes and refresh', async () => {
  for (const stage of ['read', 'prompt'] as const)
    for (const kind of ['window', 'contents', 'replacement'] as const) {
      const f = await phase5MenuFixture();
      const retire = () =>
        kind === 'window'
          ? f.retireWindow()
          : kind === 'contents'
            ? f.retireContents()
            : f.replaceContents();
      if (stage === 'read') f.hooks.read = retire;
      else
        f.native.promptResource = async () => {
          retire();
          return phase5Resource;
        };
      await f.edit().click();
      expect(f.writes).toEqual([]);
      expect(f.refreshes()).toBe(0);
    }
  const toggle = await phase5MenuFixture();
  toggle.hooks.read = toggle.retireContents;
  await toggle.menu
    .find((entry: any) => entry.type === 'checkbox')
    .click({ checked: false });
  expect(toggle.writes).toEqual([]);
  expect(toggle.refreshes()).toBe(0);
  const settled = await phase5MenuFixture();
  settled.hooks.write = settled.retireWindow;
  await settled.edit().click();
  expect(settled.writes).toEqual([{ musicApiRemoteResource: phase5Resource }]);
  expect(settled.refreshes()).toBe(0);
});

test('Phase5 resource snapshot rejects same-object mutation and own-presence drift', async () => {
  for (const ownPresence of [false, true]) {
    const f = await phase5MenuFixture();
    if (ownPresence) delete f.config.musicApiRemoteResource;
    f.native.promptResource = async () => {
      f.config.musicApiRemoteResource = ownPresence
        ? undefined
        : 'http://changed.fixture.invalid:26538/api/v1/music';
      return phase5Resource;
    };
    await f.edit().click();
    expect(f.writes).toEqual([]);
    expect(f.refreshes()).toBe(0);
  }
});

test('Phase5 config read prompt and native lifetime exceptions retire without effects', async () => {
  for (const kind of ['read', 'prompt', 'lifetime', 'error'] as const) {
    const f = await phase5MenuFixture();
    if (kind === 'read')
      f.context.getConfig = async () => {
        throw Error('owned read retired');
      };
    if (kind === 'prompt')
      f.native.promptResource = async () => {
        throw Error('owned prompt retired');
      };
    if (kind === 'lifetime')
      f.context.window.isDestroyed = () => {
        throw Error('owned window retired');
      };
    if (kind === 'error') {
      f.native.promptResource = async () => '';
      f.native.show = async () => {
        throw Error('owned error retired');
      };
    }
    await expect(f.edit().click()).resolves.toBeUndefined();
    expect(f.writes).toEqual([]);
    expect(f.refreshes()).toBe(0);
  }
});

test('Phase5 remote grant fixes resource with empty scopes and scoped revocation', async () => {
  const f = await phase5MenuFixture();
  await f.menu
    .find((entry: any) => entry.label === 'Create client grant…')
    .click();
  expect(f.issues[0].slice(0, 4)).toEqual([
    'Phase5 remote',
    'rest',
    phase5Resource,
    [],
  ]);
  expect(f.copies.length).toBe(1);
  expect(f.captures.length).toBe(1);
  const detail = f.dialogs[0].detail;
  for (const phrase of [
    'REST',
    phase5Resource,
    'loopback',
    'Host',
    'Origin',
    'Forwarded',
    '24 hours',
    'Selected: none',
  ])
    expect(detail).toContain(phrase);
  f.native.show = async (options: any) => {
    expect(options.buttons.length).toBe(2);
    expect(options.buttons[0]).toContain(phase5Resource);
    return { response: 0 };
  };
  await f.menu
    .find((entry: any) => entry.label === 'Revoke client grants…')
    .click();
  expect(f.revoked).toEqual(['phase5-issued']);
});

test('Phase5 grant dialog and issue retirement prevent stale copy and revoke only its new grant', async () => {
  for (const stage of [
    'prompt',
    'permission',
    'issue',
    'copy',
    'cancel',
  ] as const) {
    const f = await phase5MenuFixture();
    if (stage === 'prompt')
      f.native.prompt = async () => {
        f.retireOwner();
        return 'Phase5 remote';
      };
    if (stage === 'issue') f.hooks.issue = f.retireOwner;
    if (stage === 'permission' || stage === 'copy' || stage === 'cancel')
      f.native.show = async (options: any) => {
        if (
          stage === 'permission' ||
          options.title === 'Music API client grant'
        ) {
          if (stage !== 'cancel') f.retireOwner();
          return { response: stage === 'cancel' ? 1 : 2 };
        }
        return { response: 2 };
      };
    await f.menu
      .find((entry: any) => entry.label === 'Create client grant…')
      .click();
    expect(f.copies.length).toBe(0);
    expect(f.issues.length).toBe(
      stage === 'prompt' || stage === 'permission' ? 0 : 1,
    );
    expect(f.revoked).toEqual(
      stage === 'prompt' || stage === 'permission' ? [] : ['phase5-issued'],
    );
  }
});

test('Phase5 existing local and MCP resolvers stay zero-argument with actual capture receiver', async () => {
  const m = await musicModuleSource('src/plugins/api-server/music-menu.ts');
  for (const transport of ['rest', 'mcp'] as const) {
    const choices = [2, 0],
      issues: unknown[][] = [];
    let copies = 0;
    const service = {
      resource: transport === 'rest' ? resource : 'http://127.0.0.1:26539/mcp',
      captureNativeOwner(this: unknown, ...args: unknown[]) {
        expect(this === service).toBe(true);
        expect(args.length).toBe(0);
        return { current: () => true };
      },
      grants: {
        issue: async (...args: unknown[]) => {
          issues.push(args);
          return { token: 'synthetic-zero-only', record: { id: 'only' } };
        },
        revoke: async () => {},
        list: async () => [],
      },
    };
    const resolve = (...args: unknown[]) => {
      expect(args.length).toBe(0);
      return service;
    };
    const menu = await m.createMusicGrantMenu(
      {
        getConfig: () => ({
          enabled: true,
          musicApiEnabled: true,
          mcpEnabled: true,
        }),
        setConfig: () => {},
        refresh: () => {},
      },
      resolve,
      {
        prompt: async () => 'Healthy',
        show: async () => ({ response: choices.shift() }),
        copy: () => {
          copies++;
        },
      },
      transport,
    );
    await menu
      .find((entry: any) => entry.label === 'Create client grant…')
      .click();
    expect(issues.length).toBe(1);
    expect(copies).toBe(1);
    expect(issues[0][1]).toBe(transport);
  }
});
