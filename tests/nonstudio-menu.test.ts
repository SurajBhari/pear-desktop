import { test, expect, type Page } from '@playwright/test';
import { filterBundle } from './helpers/filter-bundle';

async function fixture(page: Page, raw: any = { enabled: false }) {
  await page.setContent('<div></div>');
  await page.addScriptTag({ content: await filterBundle() });
  await page.evaluate((raw) => {
    const w = window as any;
    w.raw = raw;
    w.writes = [];
    w.refreshes = 0;
    w.destroyed = false;
    w.context = {
      window: { isDestroyed: () => w.destroyed },
      getConfig: async () => w.raw,
      setConfig: async (value: any) => {
        w.writes.push(value);
        // Match actual config.setPartial's nested category merge, not replacement.
        w.raw = {
          ...w.raw,
          ...value,
          categories: { ...w.raw.categories, ...value.categories },
        };
      },
      refresh: async () => {
        w.refreshes++;
      },
    };
    w.menu = () => w.FilterFixture.live.menu?.(w.context) ?? [];
    w.row = (menu: any[], key: string) =>
      menu.find((row) => row.label === `plugins.skip-live-songs.menu.${key}`);
  }, raw);
}

test('native menu exposes five legacy-default checkbox states while disabled', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    const menu = await w.menu();
    return {
      rows: menu.map((row: any) => ({
        type: row.type,
        checked: row.checked,
        enabled: row.enabled,
      })),
      writes: w.writes,
    };
  });
  expect(result.rows).toEqual(
    [true, false, false, false, false].map((checked) => ({
      type: 'checkbox',
      checked,
      enabled: true,
    })),
  );
  expect(result.writes).toEqual([]);
});

test('serialized desired values use latest records across menu generations and preserve unknown data', async ({
  page,
}) => {
  await fixture(page, {
    enabled: false,
    categories: { live: false, future: { untouched: true } },
  });
  const result = await page.evaluate(async () => {
    const w = window as any;
    const first = await w.menu(),
      second = await w.menu();
    w.raw.categories.demo = true;
    let release: any;
    const pending = new Promise((resolve) => (release = resolve));
    const save = w.context.setConfig;
    w.context.setConfig = async (value: any) => {
      await pending;
      await save(value);
    };
    const a = w.row(first, 'acoustic')?.click({ checked: true });
    const b = w.row(second, 'session')?.click({ checked: true });
    const c = w.row(first, 'acoustic')?.click({ checked: false });
    release();
    await Promise.all([a, b, c]);
    return { raw: w.raw, writes: w.writes, refreshes: w.refreshes };
  });
  expect(result.writes).toEqual([
    { categories: { acoustic: true } },
    { categories: { session: true } },
    { categories: { acoustic: false } },
  ]);
  expect(result.raw).toEqual({
    enabled: false,
    categories: {
      live: false,
      demo: true,
      acoustic: false,
      session: true,
      future: { untouched: true },
    },
  });
  expect(result.writes.every((write: any) => !('enabled' in write))).toBe(true);
  expect(result.refreshes).toBe(3);
});

for (const categories of [null, [], { live: 'true' }, { demo: undefined }]) {
  test(`unsupported categories preserve stored data (${JSON.stringify(categories)})`, async ({
    page,
  }) => {
    await fixture(page, { enabled: false, categories });
    const result = await page.evaluate(async () => {
      const w = window as any,
        menu = await w.menu();
      return {
        rows: menu.map((row: any) => ({
          enabled: row.enabled,
          label: row.label,
        })),
        writes: w.writes,
      };
    });
    expect(result.rows).toEqual([
      { enabled: false, label: 'plugins.skip-live-songs.menu.unsupported' },
    ]);
    expect(result.writes).toEqual([]);
  });
}

for (const stage of ['read', 'write', 'readback', 'refresh']) {
  test(`menu ${stage} failure settles and later clicks can save`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (stage) => {
      const w = window as any,
        menu = await w.menu();
      let reads = 0,
        writeAttempts = 0,
        refreshAttempts = 0;
      const get = w.context.getConfig,
        set = w.context.setConfig,
        refresh = w.context.refresh;
      w.context.getConfig = async () => {
        reads++;
        if (
          (stage === 'read' && reads === 1) ||
          (stage === 'readback' && reads === 2)
        )
          throw Error('read');
        return get();
      };
      w.context.setConfig = async (value: any) => {
        writeAttempts++;
        if (stage === 'write') {
          stage = 'recovered';
          throw Error('write');
        }
        return set(value);
      };
      w.context.refresh = async () => {
        refreshAttempts++;
        if (stage === 'refresh') {
          stage = 'recovered';
          throw Error('refresh');
        }
        return refresh();
      };
      const first = await Promise.allSettled([
        w.row(menu, 'demo')?.click({ checked: true }),
      ]);
      await w.row(menu, 'session')?.click({ checked: true });
      return {
        statuses: first.map((value) => value.status),
        raw: w.raw,
        writes: w.writes,
        reads,
        writeAttempts,
        refreshAttempts,
      };
    }, stage);
    expect(result.statuses).toEqual(['fulfilled']);
    expect(result.raw.categories?.session).toBe(true);
    expect(result.raw.enabled).toBe(false);
    expect(result.writes.length).toBeGreaterThan(0);
    if (stage === 'readback') expect(result.reads).toBe(4);
    if (stage === 'write') expect(result.writeAttempts).toBe(2);
    if (stage === 'refresh') expect(result.refreshAttempts).toBe(3);
  });
}

test('destroyed windows fence initial menus and pending writes', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      menu = await w.menu();
    let release: any;
    const pending = new Promise((resolve) => (release = resolve));
    w.context.getConfig = () => pending;
    const click = w.row(menu, 'demo')?.click({ checked: true });
    w.destroyed = true;
    release(w.raw);
    await click;
    return { writes: w.writes, refreshes: w.refreshes, menu: await w.menu() };
  });
  expect(result).toEqual({ writes: [], refreshes: 0, menu: [] });
});

test('menu initialization read rejection is handled as unsupported', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    w.context.getConfig = async () => {
      throw Error('read');
    };
    return (await w.menu()).map((row: any) => ({
      label: row.label,
      enabled: row.enabled,
    }));
  });
  expect(result).toEqual([
    { label: 'plugins.skip-live-songs.menu.unsupported', enabled: false },
  ]);
});

test('a stale checkbox cannot replace newly unsupported categories', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      menu = await w.menu();
    w.raw.categories = { live: 'future-format' };
    await w.row(menu, 'demo')?.click({ checked: true });
    return { writes: w.writes, raw: w.raw, refreshes: w.refreshes };
  });
  expect(result).toEqual({
    writes: [],
    raw: { enabled: false, categories: { live: 'future-format' } },
    refreshes: 1,
  });
});

test('silent persistence mismatch settles and refreshes actual stored state', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      menu = await w.menu();
    w.context.setConfig = async () => {};
    const outcome = await Promise.allSettled([
      w.row(menu, 'demo')?.click({ checked: true }),
    ]);
    return { status: outcome[0].status, raw: w.raw, refreshes: w.refreshes };
  });
  expect(result).toEqual({
    status: 'fulfilled',
    raw: { enabled: false },
    refreshes: 1,
  });
});

test('window destruction during persistence fences readback, refresh and queued saves', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      menu = await w.menu();
    let reads = 0;
    w.context.getConfig = async () => {
      reads++;
      return w.raw;
    };
    const save = w.context.setConfig;
    w.context.setConfig = async (value: any) => {
      await save(value);
      w.destroyed = true;
    };
    await Promise.all([
      w.row(menu, 'demo')?.click({ checked: true }),
      w.row(menu, 'session')?.click({ checked: true }),
    ]);
    return { writes: w.writes, reads, refreshes: w.refreshes };
  });
  expect(result).toEqual({
    writes: [{ categories: { demo: true } }],
    reads: 1,
    refreshes: 0,
  });
});
