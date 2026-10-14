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
