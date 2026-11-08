import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
async function fixture() {
  const key = `lyricsMenu_${crypto.randomUUID()}`;
  const state: any = {
    output: '500',
    calls: [],
    writes: [],
    logs: [],
    destroyed: false,
    gate: undefined,
    refreshes: 0,
    config: {
      romanization: true,
      timingOffsetMs: 100,
      romanizationSizePercent: 70,
    },
  };
  (globalThis as any)[key] = state;
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/menu.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const boundary = `const state=globalThis[${JSON.stringify(key)}];const providerNames=[];const t=x=>x;const console={error:(...args)=>state.logs.push(args),warn:(...args)=>state.logs.push(args),log:(...args)=>state.logs.push(args)};const promptOptions=()=>({});const prompt=async options=>{state.calls.push(options);return state.output};`;
  const m = await import(
    `data:text/javascript;base64,${Buffer.from(boundary + raw).toString('base64')}`
  );
  const context = {
    window: { isDestroyed: () => state.destroyed },
    getConfig: async () => {
      await state.gate;
      return state.config;
    },
    setConfig: async (x: any) => {
      state.writes.push(x);
      state.config = { ...state.config, ...x };
    },
    refresh: async () => {
      state.refreshes++;
    },
  };
  let menu = await m.menu(context);
  return {
    state,
    module: m,
    get menu() {
      return menu;
    },
    refresh: async () => {
      menu = await m.menu(context);
    },
    close: () => delete (globalThis as any)[key],
  };
}

async function actualMenuContextFixture(menuModule: any) {
  const state: any = {
    persisted: { enabled: true },
    events: [] as string[],
    rejectWrite: false,
    rejectRead: false,
    rejectRefresh: false,
  };
  const defaults = {
    enabled: true,
    enableDownload: true,
    romanization: true,
    timingOffsetMs: 0,
    romanizationSizePercent: 70,
    enhancedLrc: false,
    showTimeCodes: false,
    defaultTextString: '♪',
    showLyricsEvenIfInexact: true,
    preciseTiming: true,
    lineEffect: 'fancy',
    useYTMLyricsWithoutProxy: false,
  };
  const config = {
    get: (path: string) => {
      state.events.push('read');
      if (state.rejectRead) throw Error('owned config read rejection');
      return path === 'plugins.synced-lyrics' ? state.persisted : undefined;
    },
    setPartial: (path: string, patch: object, fallback: object) => {
      state.events.push('write');
      if (state.rejectWrite) throw Error('owned config persistence rejection');
      if (path === 'plugins.synced-lyrics')
        state.persisted = { ...fallback, ...state.persisted, ...patch };
    },
  };
  const raw = stripTypeScriptTypes(
    await readFile(new URL('../src/loader/menu.ts', import.meta.url), 'utf8'),
    { mode: 'transform' },
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replaceAll('export const ', 'const ');
  const loader = vm.runInNewContext(
    `(function(){${raw}\nreturn {createContext};})()`,
    {
      allPlugins: () =>
        Promise.resolve({ 'synced-lyrics': { config: defaults } }),
      config,
      deepmerge: (...values: object[]) => Object.assign({}, ...values),
      LoggerPrefix: 'test',
      refreshMenu: async () => {
        state.events.push('refresh');
        if (state.rejectRefresh) throw Error('owned refresh rejection');
      },
      t: (key: string) => key,
    },
  );
  const context = loader.createContext('synced-lyrics', {
    isDestroyed: () => false,
  });
  const menu = await menuModule.menu(context);
  state.events.length = 0;
  return { state, context, menu };
}

async function captureUnhandled<T>(operation: () => Promise<T>) {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const result = await operation();
    await new Promise((resolve) => setImmediate(resolve));
    return { result, unhandled };
  } finally {
    process.off('unhandledRejection', listener);
  }
}

test('obsolete default between-lyrics character submenu is absent without rewriting legacy configuration', async () => {
  const f = await fixture();
  try {
    f.state.config.defaultTextString = '♪';
    await f.refresh();
    expect(
      f.menu.find(
        (item: any) =>
          item.label === 'plugins.synced-lyrics.menu.default-text-string.label',
      ),
    ).toBeUndefined();
    expect(f.state.config.defaultTextString).toBe('♪');
    expect(f.state.writes).toEqual([]);
  } finally {
    f.close();
  }
});

test('export option defaults on in the synced lyrics plugin config', async () => {
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/index.ts', import.meta.url),
      'utf8',
    ),
    { mode: 'transform' },
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default createPlugin(', 'return createPlugin(');
  const plugin = vm.runInNewContext(`(function(){${raw}\n})()`, {
    backend: {},
    createPlugin: (value: unknown) => value,
    menu: () => [],
    renderer: {},
    style: '',
    t: (key: string) => key,
  });
  expect(plugin.config.enableDownload).toBe(true);
});
test('offset native editor stores a bounded partial change and explains positive delay', async () => {
  const f = await fixture();
  try {
    const item = f.menu.find(
      (x: any) => x.label === 'plugins.synced-lyrics.tools.offset',
    );
    expect(item).toBeTruthy();
    await item.click();
    expect(f.state.calls[0].value).toBe('100');
    expect(f.state.calls[0].label).toBe(
      'plugins.synced-lyrics.tools.offset-help',
    );
    expect(f.state.writes).toEqual([{ timingOffsetMs: 500 }]);
    for (const output of ['NaN', 'Infinity', '30001', '-30001', '', null]) {
      f.state.output = output;
      await item.click();
    }
    expect(f.state.writes).toHaveLength(1);
  } finally {
    f.close();
  }
});
test('offset config wait cannot open a prompt for a closed owner', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.state.gate = new Promise<void>((r) => {
      release = r;
    });
    const item = f.menu.find(
      (x: any) => x.label === 'plugins.synced-lyrics.tools.offset',
    );
    expect(item).toBeTruthy();
    const pending = item.click();
    f.state.destroyed = true;
    release();
    await pending;
    expect(f.state.calls).toEqual([]);
    expect(f.state.writes).toEqual([]);
  } finally {
    f.close();
  }
});
test('romanization presets and enhanced export use independent partial settings', async () => {
  const f = await fixture();
  try {
    const item = f.menu.find(
      (x: any) => x.label === 'plugins.synced-lyrics.tools.romanization-size',
    );
    expect(item).toBeTruthy();
    await item.submenu.find((x: any) => x.label === '50%').click();
    const enhanced = f.menu.find(
      (x: any) => x.label === 'plugins.synced-lyrics.tools.enhanced-lrc',
    );
    expect(enhanced).toBeTruthy();
    enhanced.click({ checked: true });
    expect(f.state.writes).toEqual([
      { romanizationSizePercent: 50 },
      { enhancedLrc: true },
    ]);
  } finally {
    f.close();
  }
});

test('export visibility defaults on for legacy settings and persists both directions', async () => {
  const f = await fixture();
  try {
    const item = () =>
      f.menu.find(
        (x: any) => x.label === 'plugins.synced-lyrics.tools.show-export.label',
      );
    expect(item()).toMatchObject({ type: 'checkbox', checked: true });
    await item()!.click({ checked: false });
    expect(f.state.writes).toEqual([{ enableDownload: false }]);
    await f.refresh();
    expect(item()).toMatchObject({ type: 'checkbox', checked: false });
    await item()!.click({ checked: true });
    expect(f.state.writes).toEqual([
      { enableDownload: false },
      { enableDownload: true },
    ]);
    await f.refresh();
    expect(item()).toMatchObject({ type: 'checkbox', checked: true });
  } finally {
    f.close();
  }
});

test('actual menu context contains a rejected visibility write and reconciles it', async () => {
  const f = await fixture();
  const h = await actualMenuContextFixture(f.module);
  const checkbox = h.menu.find(
    (x: any) => x.label === 'plugins.synced-lyrics.tools.show-export.label',
  );
  const item = { ...checkbox, checked: false };
  h.state.rejectWrite = true;
  const { result, unhandled } = await captureUnhandled(() => item.click(item));
  expect(result).toBe(false);
  expect(h.state.persisted).toEqual({ enabled: true });
  expect(item.checked).toBe(true);
  expect(h.state.events).toEqual(['write', 'read', 'refresh']);
  expect(unhandled).toEqual([]);
  expect((await h.context.getConfig()).enableDownload).toBe(true);
  f.close();
});

test('in-app style click without a native MenuItem uses tracked checkbox state', async () => {
  const f = await fixture();
  const h = await actualMenuContextFixture(f.module);
  const checkbox = h.menu.find(
    (x: any) => x.label === 'plugins.synced-lyrics.tools.show-export.label',
  );
  const { result, unhandled } = await captureUnhandled(() =>
    checkbox.click(undefined),
  );
  expect(result).toBe(true);
  expect(h.state.persisted.enableDownload).toBe(false);
  expect(h.state.events).toEqual(['write', 'refresh']);
  expect(unhandled).toEqual([]);
  f.close();
});

test('in-app style failed write restores stored visibility without a MenuItem', async () => {
  const f = await fixture();
  const h = await actualMenuContextFixture(f.module);
  const checkbox = h.menu.find(
    (x: any) => x.label === 'plugins.synced-lyrics.tools.show-export.label',
  );
  h.state.rejectWrite = true;
  const { result, unhandled } = await captureUnhandled(() =>
    checkbox.click(undefined),
  );
  expect(result).toBe(false);
  expect(h.state.persisted).toEqual({ enabled: true });
  expect(h.state.events).toEqual(['write', 'read', 'refresh']);
  expect(unhandled).toEqual([]);
  expect((await h.context.getConfig()).enableDownload).toBe(true);
  f.close();
});

test('failed refresh and config read are contained after a rejected write', async () => {
  const f = await fixture();
  const h = await actualMenuContextFixture(f.module);
  const checkbox = h.menu.find(
    (x: any) => x.label === 'plugins.synced-lyrics.tools.show-export.label',
  );
  const item = { ...checkbox, checked: false };
  h.state.rejectWrite = true;
  h.state.rejectRead = true;
  h.state.rejectRefresh = true;
  const { result, unhandled } = await captureUnhandled(() => item.click(item));
  expect(result).toBe(false);
  expect(h.state.persisted.enableDownload).toBeUndefined();
  expect(item.checked).toBe(true);
  expect(h.state.events).toEqual(['write', 'read', 'refresh']);
  expect(unhandled).toEqual([]);
  f.close();
});

test('a successful visibility write remains successful when refresh rejects', async () => {
  const f = await fixture();
  const h = await actualMenuContextFixture(f.module);
  const checkbox = h.menu.find(
    (x: any) => x.label === 'plugins.synced-lyrics.tools.show-export.label',
  );
  const item = { ...checkbox, checked: false };
  h.state.rejectRefresh = true;
  const { result, unhandled } = await captureUnhandled(() => item.click(item));
  expect(result).toBe(true);
  expect(h.state.persisted.enableDownload).toBe(false);
  expect(item.checked).toBe(false);
  expect(h.state.events).toEqual(['write', 'refresh']);
  expect(unhandled).toEqual([]);
  f.close();
});
