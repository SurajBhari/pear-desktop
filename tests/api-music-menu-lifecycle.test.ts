import { expect, test } from '@playwright/test';
import { musicMenuLifecycleFixture } from './helpers/api-music-menu-lifecycle';

const notifications = (f: any) =>
  f.state.sends.filter((entry: any[]) => entry[0] === 'refresh-in-app-menu')
    .length;

test('actual native MCP checkbox retires access and republishes disabled grant descriptors after OFF', async () => {
  const f = await musicMenuLifecycleFixture();
  try {
    await f.refreshMenu(f.window);
    expect(f.flags()).toEqual({ checked: true, create: true, revoke: true });
    const staleCreate = f
      .entries()
      .find((item: any) => item.label === 'Create client grant…');
    await f.toggle(false);
    expect(f.config.get('plugins.api-server').mcpEnabled).toBe(false);
    expect(f.getMcpGrantTarget(f.window)).toBeUndefined();
    expect(f.state.watcherCalls).toBe(1);
    expect(f.state.listenerStops).toBe(1);
    await staleCreate.click();
    expect(f.state.prompts).toBe(0);
    expect(f.flags()).toEqual({ checked: false, create: false, revoke: false });
    expect(f.state.menus).toHaveLength(2);
    expect(f.state.mcpLoads).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual toggle waits for its config write before republishing native grant entries', async () => {
  const f = await musicMenuLifecycleFixture();
  try {
    await f.refreshMenu(f.window);
    f.state.holdPluginsOnce = true;
    const pending = f.toggle(false);
    await expect.poll(() => f.state.pluginReleases.length).toBe(1);
    expect(f.config.get('plugins.api-server').mcpEnabled).toBe(true);
    expect(f.state.menus).toHaveLength(1);
    expect(f.state.watcherCalls).toBe(0);
    f.state.pluginReleases.shift()();
    await pending;
    expect(f.flags()).toEqual({ checked: false, create: false, revoke: false });
    expect(f.state.watcherCalls).toBe(1);
    expect(f.state.menus).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('failed actual checkbox config write propagates without retiring access or publishing a menu', async () => {
  const f = await musicMenuLifecycleFixture();
  try {
    await f.refreshMenu(f.window);
    const target = f.getMcpGrantTarget(f.window);
    f.state.failWrites = true;
    await expect(f.toggle(false)).rejects.toThrow(
      'Owned configuration write failure',
    );
    expect(f.config.get('plugins.api-server').mcpEnabled).toBe(true);
    expect(f.getMcpGrantTarget(f.window)).toBe(target);
    expect(target.owner.current()).toBe(true);
    expect(f.state.menus).toHaveLength(1);
    expect(f.state.writes).toBe(0);
    expect(f.state.watcherCalls).toBe(0);
    expect(f.state.listenerStops).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual OFF to ON toggle waits for readiness then OFF republishes disabled descriptors again', async () => {
  const f = await musicMenuLifecycleFixture();
  try {
    await f.refreshMenu(f.window);
    await f.toggle(false);
    f.state.holdStarts = true;
    await f.toggle(true);
    await expect.poll(() => f.state.startReleases.length).toBe(1);
    expect(f.config.get('plugins.api-server').mcpEnabled).toBe(true);
    expect(f.getMcpGrantTarget(f.window)).toBeUndefined();
    expect(f.flags()).toEqual({ checked: true, create: false, revoke: false });
    f.state.startReleases.shift()();
    await expect.poll(() => f.flags().create).toBe(true);
    expect(f.flags()).toEqual({ checked: true, create: true, revoke: true });
    await f.toggle(false);
    expect(f.flags()).toEqual({ checked: false, create: false, revoke: false });
    expect(f.getMcpGrantTarget(f.window)).toBeUndefined();
    expect(f.state.writes).toBe(3);
    expect(f.state.menus).toHaveLength(5);
  } finally {
    await f.close();
  }
});

test('actual OFF during pending MCP readiness prevents the retired listener from republishing', async () => {
  const f = await musicMenuLifecycleFixture();
  try {
    await f.refreshMenu(f.window);
    await f.toggle(false);
    f.state.holdStarts = true;
    await f.toggle(true);
    await expect.poll(() => f.state.startReleases.length).toBe(1);
    await f.toggle(false);
    expect(f.flags()).toEqual({ checked: false, create: false, revoke: false });
    expect(f.state.menus).toHaveLength(4);
    f.state.startReleases.shift()();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.getMcpGrantTarget(f.window)).toBeUndefined();
    expect(f.state.menus).toHaveLength(4);
    expect(f.state.listenerStops).toBe(2);
  } finally {
    await f.close();
  }
});

for (const retirement of ['newer menu', 'destroyed window'] as const) {
  test(`actual toggle's held global menu publication respects ${retirement}`, async () => {
    const f = await musicMenuLifecycleFixture();
    try {
      await f.refreshMenu(f.window);
      f.state.holdMenuAfterWrite = true;
      const pending = f.toggle(false);
      await expect.poll(() => f.state.pluginReleases.length).toBe(1);
      if (retirement === 'newer menu') await f.refreshMenu(f.window);
      else f.state.destroyed = true;
      const latest = f.published();
      const publications = f.state.menus.length;
      f.state.pluginReleases.shift()();
      await pending;
      expect(f.published()).toBe(latest);
      expect(f.state.menus).toHaveLength(publications);
      expect(publications).toBe(retirement === 'newer menu' ? 2 : 1);
      expect(
        f.state.sends.filter(
          (entry: any[]) => entry[0] === 'refresh-in-app-menu',
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test('enabled in-app menu receives one notification per current OFF, ON, and readiness publication', async () => {
  const f = await musicMenuLifecycleFixture({ inAppEnabled: true });
  try {
    await f.refreshMenu(f.window);
    expect(notifications(f)).toBe(1);
    await f.toggle(false);
    expect(notifications(f)).toBe(2);
    expect(f.flags()).toEqual({ checked: false, create: false, revoke: false });
    f.state.holdStarts = true;
    await f.toggle(true);
    await expect.poll(() => f.state.startReleases.length).toBe(1);
    expect(notifications(f)).toBe(3);
    expect(f.flags()).toEqual({ checked: true, create: false, revoke: false });
    f.state.startReleases.shift()();
    await expect.poll(() => f.flags().create).toBe(true);
    expect(notifications(f)).toBe(4);
    await f.toggle(false);
    expect(notifications(f)).toBe(5);
    expect(f.state.menus).toHaveLength(5);
    expect(f.state.lateSends).toBe(0);
  } finally {
    await f.close();
  }
});

for (const retirement of ['destroyed window', 'newer global menu'] as const) {
  test(`enabled in-app toggle's held publication cannot notify after ${retirement}`, async () => {
    const f = await musicMenuLifecycleFixture({ inAppEnabled: true });
    try {
      await f.refreshMenu(f.window);
      expect(notifications(f)).toBe(1);
      f.state.holdMenuAfterWrite = true;
      const pending = f.toggle(false);
      await expect.poll(() => f.state.pluginReleases.length).toBe(1);
      if (retirement === 'newer global menu') await f.refreshMenu(f.window);
      else f.state.destroyed = true;
      const latest = f.published();
      const publications = f.state.menus.length;
      const currentNotifications = notifications(f);
      f.state.pluginReleases.shift()();
      await pending;
      expect(f.published()).toBe(latest);
      expect(f.state.menus).toHaveLength(publications);
      expect(notifications(f)).toBe(currentNotifications);
      expect(f.state.lateSends).toBe(0);
      expect(currentNotifications).toBe(
        retirement === 'newer global menu' ? 2 : 1,
      );
    } finally {
      await f.close();
    }
  });
}

for (const startupEnabled of [true, false]) {
  test(`restart-needed in-app notifications follow startup=${startupEnabled} while current preference=${!startupEnabled}`, async () => {
    const f = await musicMenuLifecycleFixture({ inAppEnabled: startupEnabled });
    try {
      await f.refreshMenu(f.window);
      expect(notifications(f)).toBe(startupEnabled ? 1 : 0);
      // Change only the owned pending preference. The in-app renderer's runtime
      // presence is fixed at launch because the plugin requires a restart.
      f.config.get('plugins')['in-app-menu'] = { enabled: !startupEnabled };
      await f.toggle(false);
      expect(f.flags()).toEqual({
        checked: false,
        create: false,
        revoke: false,
      });
      expect(f.state.menus).toHaveLength(2);
      expect(notifications(f)).toBe(startupEnabled ? 2 : 0);
      expect(f.state.lateSends).toBe(0);
    } finally {
      await f.close();
    }
  });
}
