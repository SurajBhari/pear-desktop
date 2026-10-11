import { expect, test } from '@playwright/test';
import { menuFixture } from './helpers/i18n-menu-fixture';
import { flush } from './helpers/i18n-source-fragments';
const languageItems = (template: any[]) =>
  template
    .find(
      (item) =>
        item.label.includes('Options') ||
        item.label === 'main.menu.options.label',
    )
    .submenu.find((item: any) => item.label?.includes('(Language)'))
    .submenu.slice(1);

test('actual menu lists every static label without loading catalogue resources', async () => {
  const f = await menuFixture();
  try {
    await f.setApplicationMenu(f.window);
    const items = languageItems(f.state.menus.at(-1));
    expect(items).toHaveLength(67);
    expect(
      items.filter((item: any) => item.label === 'Unknown (Unknown)'),
    ).toHaveLength(5);
    expect(f.state.imports).toEqual(['en']);
  } finally {
    await f.close();
  }
});

test('actual language menu waits for activation and discards slow superseded dialog/menu', async () => {
  const f = await menuFixture();
  try {
    await f.setApplicationMenu(f.window);
    let items = languageItems(f.state.menus.at(-1));
    f.state.hold = true;
    const old = items
      .find((item: any) => item.label.startsWith('Russian ('))
      .click();
    await flush();
    expect(f.state.dialogs).toHaveLength(0);
    expect(f.state.menus).toHaveLength(1);
    await items.find((item: any) => item.label.startsWith('French (')).click();
    expect(f.engine.language).toBe('fr');
    expect(f.state.dialogs).toHaveLength(1);
    f.state.pending.shift()();
    await old;
    expect(f.engine.language).toBe('fr');
    expect(f.state.dialogs).toHaveLength(1);
    expect(f.state.menus).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const retire of ['destroy', 'restart', 'replace', 'template'])
  test(`actual locale menu suppresses publication on ${retire}`, async () => {
    const f = await menuFixture();
    try {
      await f.setApplicationMenu(f.window);
      const item = languageItems(f.state.menus.at(-1)).find((item: any) =>
        item.label.startsWith('Russian ('),
      );
      if (retire === 'restart') f.state.restart = true;
      else f.state.hold = true;
      const pending = item.click();
      await flush();
      if (retire === 'destroy') f.window.destroyed = true;
      if (retire === 'replace') {
        const other = {
          ...f.window,
          webContents: { ...f.window.webContents, isDestroyed: () => false },
        };
        await f.setApplicationMenu(other);
      }
      if (retire === 'template') {
        f.state.templateHold = true;
        f.state.pending.shift()();
        await flush();
        f.window.destroyed = true;
        f.state.templates.shift()?.();
      } else f.state.pending.shift()?.();
      await pending;
      expect(f.state.dialogs).toHaveLength(0);
      expect(f.state.sends).toHaveLength(0);
      expect(f.state.menus).toHaveLength(retire === 'replace' ? 2 : 1);
      expect(f.state.language).toBe('ru');
    } finally {
      await f.close();
    }
  });

test('restart intent retires locale publication even before native window close settles', async () => {
  const f = await menuFixture();
  try {
    await f.setApplicationMenu(f.window);
    f.state.restart = true;
    f.state.restartCloses = false;
    const item = languageItems(f.state.menus.at(-1)).find((item: any) =>
      item.label.startsWith('Russian ('),
    );
    await item.click();
    expect(f.state.language).toBe('ru');
    expect(f.window.destroyed).toBe(false);
    expect(f.state.dialogs).toHaveLength(0);
    expect(f.state.menus).toHaveLength(1);
    expect(f.engine.language).toBe('en');
  } finally {
    await f.close();
  }
});

const pluginLabel = (f: any) =>
  f.state.menus
    .at(-1)
    .find((item: any) => item.label === f.engine.t('main.menu.plugins.label'))
    .submenu[0].label;
for (const method of ['refreshMenu', 'setApplicationMenu'] as const)
  test(`ordinary held ${method} cannot overwrite a newer same-window language menu`, async () => {
    const f = await menuFixture();
    try {
      f.state.controlledPlugin = true;
      await f.setApplicationMenu(f.window);
      const initial = f.state.menus.at(-1);
      f.state.enabledHoldOnce = true;
      const old = f[method](f.window);
      await flush();
      expect(f.state.enabledHolds).toHaveLength(1);
      await languageItems(initial)
        .find((item: any) => item.label.startsWith('Russian ('))
        .click();
      expect(pluginLabel(f)).toBe('Язык');
      f.state.enabledHolds.shift()();
      await old;
      expect(pluginLabel(f)).toBe('Язык');
      expect(f.state.sends).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

for (const stage of ['admission', 'template', 'build'] as const)
  test(`reentrant ${stage} handover prevents older global menu publication`, async () => {
    const f = await menuFixture();
    try {
      let newer: Promise<void> | undefined;
      let calls = 0;
      if (stage === 'build')
        f.state.beforeBuild = () => {
          newer = f.refreshMenu(f.window);
        };
      const published = await f.setApplicationMenu(f.window, () => {
        if (
          ++calls ===
          (stage === 'admission' ? 1 : stage === 'template' ? 2 : -1)
        )
          newer = f.refreshMenu(f.window);
        return true;
      });
      await newer;
      expect(published).toBe(false);
      expect(f.state.menus).toHaveLength(1);
      expect(f.state.sends).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('a newer attempt during native global apply suppresses the older in-app refresh', async () => {
  const f = await menuFixture();
  try {
    let newer: Promise<void> | undefined;
    f.state.afterPublish = () => {
      newer = f.refreshMenu(f.window);
    };
    await f.refreshMenu(f.window);
    await newer;
    expect(f.state.menus).toHaveLength(2);
    expect(f.state.sends).toHaveLength(1);
  } finally {
    await f.close();
  }
});
