import { expect, test } from '@playwright/test';
import { nonstudioApplicationMenuFixture } from './helpers/nonstudio-application-menu';

const category = (f: any, name: string) =>
  f
    .plugin()
    ?.submenu?.items.find(
      (item: any) => item.label === `plugins.skip-live-songs.menu.${name}`,
    );

test('actual metadata emitter retains the opt-in and strips renderer/backend lifecycles from main stubs', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    const plugin = (await f.allPlugins())['skip-live-songs'];
    expect(plugin.menuWhenDisabled).toBe(true);
    expect(plugin.menu).toEqual(expect.any(Function));
    expect(plugin.config.enabled).toBe(false);
    expect(plugin).not.toHaveProperty('renderer');
    expect(plugin).not.toHaveProperty('backend');
    expect(f.state.lifecycleStarts).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual shared loader publishes disabled category submenu and in-app serialization from the same native template', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    await f.refreshMenu(f.window);
    const plugin = f.plugin();
    expect(plugin.submenu?.items).toHaveLength(7);
    expect(plugin.submenu.items[0]).toMatchObject({
      label: 'main.menu.plugins.enabled',
      type: 'checkbox',
      checked: false,
    });
    expect(category(f, 'acoustic')).toMatchObject({
      type: 'checkbox',
      checked: false,
      enabled: true,
    });
    const nativeSerialized = f.state.ipc['get-menu']();
    const serialized = nativeSerialized.items
      .find((item: any) => item.label === 'main.menu.plugins.label')
      .submenu.items.find(
        (item: any) => item.label === 'plugins.skip-live-songs.name',
      );
    expect(serialized.submenu.items).toHaveLength(7);
    expect(serialized.submenu.items[0].checked).toBe(false);
    expect(
      serialized.submenu.items.find(
        (item: any) => item.label === 'plugins.skip-live-songs.menu.acoustic',
      ).checked,
    ).toBe(false);
    expect(f.state.sends).toEqual([['refresh-in-app-menu']]);
    expect(f.state.writes).toEqual([]);
    expect(f.state.nativeWindows).toBe(0);
    expect(f.state.lifecycleStarts).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual loader configuration callback updates a category while off without enabling or starting the plugin', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    await f.refreshMenu(f.window);
    const row = category(f, 'demo');
    expect(row).toBeDefined();
    row.checked = true;
    await row.click(row);
    expect(f.config.get('plugins.skip-live-songs')).toEqual({
      enabled: false,
      categories: { live: false, demo: true, future: { preserved: true } },
    });
    expect(f.plugin().submenu.items[0].checked).toBe(false);
    expect(category(f, 'demo').checked).toBe(true);
    expect(f.state.writes).toHaveLength(1);
    expect(f.state.sends).toHaveLength(2);
    expect(f.state.lifecycleStarts).toBe(0);
    expect(f.state.nativeWindows).toBe(0);
  } finally {
    await f.close();
  }
});

test('missing false and malformed opt-ins keep disabled plugins as the existing single enable checkbox', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    await f.refreshMenu(f.window);
    for (const name of [
      'blocklist',
      'ambient-mode',
      'auto-acknowledge',
      'adblocker',
      'skip-disliked-songs',
      'skip-silences',
    ]) {
      expect(f.plugin(name)).toMatchObject({
        type: 'checkbox',
        checked: false,
      });
      expect(f.plugin(name).submenu).toBeUndefined();
      expect(f.state.menuLoads[name]).toBeUndefined();
    }
    expect(f.state.lifecycleStarts).toBe(0);
  } finally {
    await f.close();
  }
});

test('opt-in empty or missing menus retain the single enable checkbox fallback', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    await f.refreshMenu(f.window);
    for (const name of ['force-shuffle', 'fullscreen-auto-hide']) {
      expect(f.plugin(name)).toMatchObject({
        type: 'checkbox',
        checked: false,
      });
      expect(f.plugin(name).submenu).toBeUndefined();
    }
  } finally {
    await f.close();
  }
});

test('previously published opt-in menu cannot survive an empty or removed handler', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    await f.refreshMenu(f.window);
    const plugin = (await f.allPlugins())['skip-live-songs'];
    plugin.menu = () => [];
    await f.refreshMenu(f.window);
    expect(f.plugin()).toMatchObject({ type: 'checkbox', checked: false });
    expect(f.plugin().submenu).toBeUndefined();
    delete plugin.menu;
    await f.refreshMenu(f.window);
    expect(f.plugin().submenu).toBeUndefined();
  } finally {
    await f.close();
  }
});

for (const retire of ['window', 'webContents']) {
  test(`actual shared publication fences a destroyed ${retire}`, async () => {
    const f = await nonstudioApplicationMenuFixture();
    try {
      await f.refreshMenu(f.window);
      const before = f.state.menus.length;
      const row = category(f, 'demo');
      expect(row).toBeDefined();
      if (retire === 'window') f.state.destroyed = true;
      else f.state.webDestroyed = true;
      await f.refreshMenu(f.window);
      expect(f.state.menus).toHaveLength(before);
      expect(f.state.sends).toHaveLength(1);
      row.checked = true;
      await row.click(row);
      expect(f.state.writes).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test('actual shared publication suppresses the superseded in-app notification', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    let newer: Promise<void> | undefined;
    f.state.afterPublish = () => {
      newer = f.refreshMenu(f.window);
    };
    await f.refreshMenu(f.window);
    await newer;
    expect(f.state.menus).toHaveLength(2);
    expect(f.state.sends).toEqual([['refresh-in-app-menu']]);
    expect(category(f, 'live').checked).toBe(false);
  } finally {
    await f.close();
  }
});

test('enabled ordinary plugins retain their existing menu regardless of malformed or missing opt-in', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    const names = [
      'blocklist',
      'ambient-mode',
      'auto-acknowledge',
      'adblocker',
      'skip-disliked-songs',
      'skip-silences',
    ];
    for (const name of names) f.data.plugins[name] = { enabled: true };
    await f.refreshMenu(f.window);
    for (const name of names) {
      expect(f.plugin(name).submenu.items[0]).toMatchObject({
        label: 'main.menu.plugins.enabled',
        checked: true,
      });
      expect(f.plugin(name).submenu.items.at(-1).label).toBe('Owned row');
      expect(f.state.menuLoads[name]).toBe(1);
    }
    expect(f.state.lifecycleStarts).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual in-app menu IPC reaches the published category callback and refreshes while plugin stays off', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    await f.refreshMenu(f.window);
    const commandId = category(f, 'demo').commandId;
    expect(f.state.ipc['get-menu-by-id'](commandId)).toMatchObject({
      type: 'checkbox',
      checked: false,
    });
    f.state.nativeIpc['peard:menu-event'](
      { sender: f.window.webContents },
      commandId,
    );
    await expect
      .poll(() => f.config.get('plugins.skip-live-songs').categories.demo)
      .toBe(true);
    await expect.poll(() => f.state.menus.length).toBe(2);
    expect(f.config.get('plugins.skip-live-songs').enabled).toBe(false);
    expect(category(f, 'demo').checked).toBe(true);
    expect(f.state.sends).toHaveLength(2);
    expect(f.state.lifecycleStarts).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual disabled legacy config shows live-only defaults without writing a migration', async () => {
  const f = await nonstudioApplicationMenuFixture();
  try {
    f.data.plugins['skip-live-songs'] = { enabled: false };
    await f.refreshMenu(f.window);
    expect(
      ['live', 'acoustic', 'demo', 'session', 'venue'].map(
        (key) => category(f, key).checked,
      ),
    ).toEqual([true, false, false, false, false]);
    expect(f.config.get('plugins.skip-live-songs')).toEqual({ enabled: false });
    expect(f.state.writes).toEqual([]);
  } finally {
    await f.close();
  }
});
