import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';

async function fixture(direct = false) {
  const key = `directMenu_${crypto.randomUUID()}`;
  const state: any = { direct, writes: [], closed: false };
  (globalThis as any)[key] = state;
  const actual = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/menu.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(`const state=globalThis[${JSON.stringify(key)}];const t=x=>x;const providerNames=[];const promptOptions=()=>({});const prompt=()=>{throw Error('Unexpected prompt');};\n` + actual).toString('base64')}`
  );
  const items = await module.menu({
    window: { isDestroyed: () => state.closed },
    getConfig: async () => ({ useYTMLyricsWithoutProxy: state.direct }),
    setConfig: async (value: unknown) => state.writes.push(value),
  });
  return { state, items, close: () => delete (globalThis as any)[key] };
}

test('native direct-lyrics checkbox writes only its own preference and respects closed window', async () => {
  for (const enabled of [false, true]) {
    const f = await fixture(enabled);
    try {
      const item = f.items.find(
        (x: any) =>
          x.label === 'plugins.synced-lyrics.menu.direct-ytmusic.label',
      );
      expect(item).toBeTruthy();
      expect(item.type).toBe('checkbox');
      expect(item.checked).toBe(enabled);
      await item.click({ checked: !enabled });
      expect(f.state.writes).toEqual([{ useYTMLyricsWithoutProxy: !enabled }]);
      f.state.closed = true;
      await item.click({ checked: enabled });
      expect(f.state.writes).toHaveLength(1);
    } finally {
      f.close();
    }
  }
});

test('installed synced-lyrics defaults keep proxy mode until explicit opt-in', async () => {
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/index.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const actual = await import(
    `data:text/javascript;base64,${Buffer.from('const t=x=>x;const backend={};const renderer={};const menu=()=>[];const style="";const createPlugin=x=>x;\n' + raw).toString('base64')}`
  );
  expect(actual.default.config.useYTMLyricsWithoutProxy).toBe(false);
});
