import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';

async function fixture() {
  const key = `seekMenu_${crypto.randomUUID()}`;
  const calls: any[] = [];
  const writes: any[] = [];
  const state = {
    output: undefined as any,
    calls,
    destroyed: false,
    configGate: undefined as undefined | Promise<void>,
  };
  (globalThis as any)[key] = state;
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/shortcuts/menu.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const boundary = `const state=globalThis[${JSON.stringify(key)}];const prompt=async options=>{state.calls.push(options);return state.output};const t=x=>x;const promptOptions=()=>({});`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundary + raw).toString('base64')}`
  );
  const config = {
    enabled: true,
    overrideMediaKeys: false,
    global: { previous: 'Alt+Up', next: 'Alt+Down', playPause: '' },
    local: { previous: 'Control+Up', next: 'Control+Down', playPause: '' },
    seekForwardSeconds: 5,
    seekBackwardSeconds: 5,
    podcastSeekForwardSeconds: 10,
    podcastSeekBackwardSeconds: 30,
  };
  const menu = await source.onMenu({
    window: { isDestroyed: () => state.destroyed },
    getConfig: async () => {
      await state.configGate;
      return config;
    },
    setConfig: async (x: any) => writes.push(x),
  });
  return {
    state,
    calls,
    writes,
    config,
    menu,
    close: () => delete (globalThis as any)[key],
  };
}

test('keybind prompt exposes seek actions and applies a partial cloned mapping', async () => {
  const f = await fixture();
  try {
    f.state.output = [{ value: 'seekForward', accelerator: 'Alt+Right' }];
    await f.menu
      .find((x: any) => x.label === 'plugins.shortcuts.menu.set-keybinds')
      .click();
    expect(f.calls[0].keybindOptions.map((x: any) => x.value)).toContain(
      'seekForward',
    );
    expect(f.writes[0]).toEqual({
      global: { ...f.config.global, seekForward: 'Alt+Right' },
    });
    expect((f.config.global as any).seekForward).toBeUndefined();
  } finally {
    f.close();
  }
});

test('local keybind cancellation makes no configuration writes', async () => {
  const f = await fixture();
  try {
    const local = f.menu.find(
      (x: any) => x.label === 'plugins.shortcuts.menu.set-local-keybinds',
    );
    expect(local).toBeTruthy();
    f.state.output = null;
    await local.click();
    expect(f.writes).toEqual([]);
    expect(
      f.calls[0].keybindOptions.find((x: any) => x.value === 'previous')
        .default,
    ).toBe('Control+Up');
  } finally {
    f.close();
  }
});

test('duration menu validates bounds and preserves unrelated settings', async () => {
  const f = await fixture();
  try {
    const settings = f.menu.find(
      (x: any) => x.label === 'plugins.shortcuts.menu.seek-seconds',
    );
    expect(settings).toBeTruthy();
    f.state.output = '27';
    await settings.submenu[0].click();
    expect(f.writes).toEqual([{ seekForwardSeconds: 27 }]);
    for (const value of ['NaN', 'Infinity', '-2', '0', '601']) {
      f.state.output = value;
      await settings.submenu[0].click();
    }
    expect(f.writes).toHaveLength(1);
  } finally {
    f.close();
  }
});

for (const scope of ['global', 'local']) {
  for (const stage of ['before prompt', 'before save']) {
    test(`${scope} keybind ignores a window closed ${stage} during config lookup`, async () => {
      const f = await fixture();
      try {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        f.state.output = [{ value: 'seekForward', accelerator: 'Alt+Right' }];
        if (stage === 'before prompt') f.state.configGate = gate;
        else {
          // The prompt boundary sets the gate for the latest config read.
          Object.defineProperty(f.state, 'output', {
            get() {
              f.state.configGate = gate;
              return [{ value: 'seekForward', accelerator: 'Alt+Right' }];
            },
          });
        }
        const click = f.menu
          .find(
            (x: any) =>
              x.label ===
              `plugins.shortcuts.menu.${scope === 'global' ? 'set-keybinds' : 'set-local-keybinds'}`,
          )
          .click();
        if (stage === 'before save') {
          while (!f.calls.length) await Promise.resolve();
          await Promise.resolve();
        }
        f.state.destroyed = true;
        release();
        await click;
        expect(f.calls).toHaveLength(stage === 'before prompt' ? 0 : 1);
        expect(f.writes).toEqual([]);
      } finally {
        f.close();
      }
    });
  }
}

test('duration prompt ignores a window closed during config lookup', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.state.configGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.output = '27';
    const settings = f.menu.find(
      (x: any) => x.label === 'plugins.shortcuts.menu.seek-seconds',
    );
    const click = settings.submenu[0].click();
    f.state.destroyed = true;
    release();
    await click;
    expect(f.calls).toEqual([]);
    expect(f.writes).toEqual([]);
  } finally {
    f.close();
  }
});
