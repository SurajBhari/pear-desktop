import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

test('the equalizer bypass menu follows the checkbox state across repeated clicks', async ({
  page,
}) => {
  await fixturePage(page, await equalizerBundle('', true));

  const writes = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const config = { ...fixture.plugin.config, bypass: false };
    const changes: boolean[] = [];
    const menu = await fixture.plugin.menu({
      getConfig: async () => config,
      setConfig: async (value: { bypass: boolean }) => {
        changes.push(value.bypass);
      },
      window: { webContents: { send() {} } },
    });
    const bypass = menu[1];
    const menuItem = { checked: false };

    menuItem.checked = true;
    bypass.click(menuItem);
    menuItem.checked = false;
    bypass.click(menuItem);
    return changes;
  });

  expect(writes).toEqual([true, false]);
});
