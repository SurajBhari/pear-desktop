import { EventEmitter } from 'node:events';
import { musicModuleSource } from './api-music-source';
export async function musicRequestFixture() {
  const ipcMain = new EventEmitter(),
    contents = new EventEmitter() as any,
    window = new EventEmitter() as any;
  const sent: any[] = [];
  contents.mainFrame = {};
  contents.isDestroyed = () => false;
  contents.send = (...args: any[]) => sent.push(args);
  window.webContents = contents;
  window.isDestroyed = () => false;
  const source = await musicModuleSource('src/providers/music-request.ts', {
    ipcMain,
  });
  if (!source.createMusicRequestBroker) throw new Error('Missing music broker');
  const broker = source.createMusicRequestBroker(window);
  const emit = (value: any, sender = contents, frame = contents.mainFrame) =>
    ipcMain.emit('peard:music-reply', { sender, senderFrame: frame }, value);
  const challenge = (
    index = sent.filter((p) => p[0] === 'peard:music-owner-query').length - 1,
  ) => sent.filter((p) => p[0] === 'peard:music-owner-query')[index][1];
  const ready = (
    packet = challenge(),
    documentId = '1'.repeat(32),
    sourceId = '2'.repeat(32),
  ) => emit({ ...packet, type: 'ready', documentId, sourceId });
  const settled = (
    packet = challenge(),
    result: any = {
      ok: true,
      value: {
        version: 1,
        items: [],
        shelves: [],
        continuation: null,
        targetRecipes: [],
      },
    },
  ) =>
    emit({
      ...packet,
      type: 'settled',
      documentId: '1'.repeat(32),
      sourceId: '2'.repeat(32),
      result,
    });
  const read = (
    principal = 'principal-a',
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ) =>
    broker.read(
      broker.capture(),
      { operation: 'search', query: 'fixture' },
      principal,
      { signal, isCurrent },
    );
  return {
    broker,
    again: () => source.createMusicRequestBroker(window),
    ipcMain,
    contents,
    window,
    sent,
    emit,
    challenge,
    ready,
    settled,
    read,
  };
}
