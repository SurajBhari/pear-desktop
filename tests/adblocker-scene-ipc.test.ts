import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { test, expect } from '@playwright/test';

test('the actual page IPC bridge cannot claim, cancel, observe or remove private scene channels', async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      path.resolve(import.meta.dirname, '../src/preload.ts'),
      'utf8',
    ),
  );
  const begin = source.indexOf('const pageIpcChannel =');
  const end = source.indexOf("contextBridge.exposeInMainWorld('reload'", begin);
  expect(begin).toBeGreaterThan(0);
  const calls: string[] = [];
  let page: Record<string, Function> | undefined;
  const methods = [
    'on',
    'subscribe',
    'off',
    'once',
    'send',
    'removeListener',
    'removeAllListeners',
    'invoke',
    'sendSync',
    'sendToHost',
  ];
  const ipc = Object.fromEntries(
    methods.map((name) => [
      name,
      (channel: string) => {
        calls.push(channel);
        return null;
      },
    ]),
  );
  const context = {
    ipcRenderer: ipc,
    contextBridge: {
      exposeInMainWorld: (_: string, value: Record<string, Function>) => {
        page = value;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(begin, end), context);
  for (const method of methods) {
    let message = '';
    try {
      await page![method]('peard:blocker-scene-claim');
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('Reserved internal IPC channel');
  }
  let missing = '';
  try {
    page!.removeAllListeners();
  } catch (error) {
    missing = String(error);
  }
  expect(missing).toContain('Reserved internal IPC channel');
  expect(calls).toEqual([]);
  page!.send('peard:search', 'ordinary control');
  // Trusted preload uses the native object directly, not the page wrapper.
  ipc.sendSync('peard:blocker-scene-claim');
  expect(calls).toEqual(['peard:search', 'peard:blocker-scene-claim']);
});
