import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export async function playlistRequestFixture() {
  const ipc = new EventEmitter();
  const sent: any[] = [];
  const timers = new Map<number, () => void>();
  let serial = 0;
  const contents = new EventEmitter() as any;
  contents.mainFrame = {};
  contents.dead = false;
  contents.isDestroyed = () => contents.dead;
  contents.send = (...args: any[]) => sent.push(args);
  const window = new EventEmitter() as any;
  window.webContents = contents;
  window.dead = false;
  window.isDestroyed = () => window.dead;
  const state = {
    ipc,
    randomUUID,
    setTimeout: (fn: () => void) => {
      timers.set(++serial, fn);
      return serial;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  let request: any = async () => ({ ok: false, reason: 'service' });
  const url = new URL(
    '../../src/providers/queue-playlist-request.ts',
    import.meta.url,
  );
  if (existsSync(url)) {
    const strip = (s: string) =>
      stripTypeScriptTypes(s)
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/^export /gm, '');
    const pure = strip(
      await readFile(
        new URL('../../src/providers/queue-playlist.ts', import.meta.url),
        'utf8',
      ),
    );
    const main = strip(await readFile(url, 'utf8'));
    const prefix =
      'const {ipc,randomUUID,setTimeout,clearTimeout}=state;const ipcMain=ipc;';
    request = new Function(
      'state',
      prefix + pure + '\n' + main + '\nreturn requestPlaylistQueue;',
    )(state);
  }
  const input = {
    playlistId: 'PLABCDEFGHIJKLMN',
    insertPosition: 'INSERT_AT_END',
  };
  const emit = (payload: any, sender = contents, frame = contents.mainFrame) =>
    ipc.emit(
      'peard:playlist-queue-reply',
      { sender, senderFrame: frame },
      payload,
    );
  const query = () =>
    sent.filter((x) => x[0] === 'peard:playlist-queue-owner-query').at(-1)?.[1];
  const owner = '1'.repeat(32);
  return {
    ipc,
    window,
    contents,
    sent,
    timers,
    owner,
    input,
    query,
    emit,
    request: (body: any = input, signal?: AbortSignal) =>
      request(window, body, signal),
    ready: (id: string) =>
      emit({ requestId: id, ownerId: owner, type: 'owner' }),
    ack: (id: string, result: any = { ok: true, count: 2 }) =>
      emit({ requestId: id, ownerId: owner, type: 'result', result }),
    tick: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    close: () => {
      window.dead = true;
      window.emit('closed');
    },
  };
}
