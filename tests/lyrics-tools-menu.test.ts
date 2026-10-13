import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
async function fixture() {
  const key = `lyricsMenu_${crypto.randomUUID()}`;
  const state: any = {
    output: '500',
    calls: [],
    writes: [],
    destroyed: false,
    gate: undefined,
  };
  (globalThis as any)[key] = state;
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/menu.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const boundary = `const state=globalThis[${JSON.stringify(key)}];const providerNames=[];const t=x=>x;const promptOptions=()=>({});const prompt=async options=>{state.calls.push(options);return state.output};`;
  const m = await import(
    `data:text/javascript;base64,${Buffer.from(boundary + raw).toString('base64')}`
  );
  const menu = await m.menu({
    window: { isDestroyed: () => state.destroyed },
    getConfig: async () => {
      await state.gate;
      return {
        romanization: true,
        timingOffsetMs: 100,
        romanizationSizePercent: 70,
      };
    },
    setConfig: async (x: any) => state.writes.push(x),
  });
  return { state, menu, close: () => delete (globalThis as any)[key] };
}
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
