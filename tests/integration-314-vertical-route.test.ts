import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  verticalBrowserBundle,
  installVerticalBrowser,
} from './helpers/integration-314-vertical-browser';
import { verticalMainFixture } from './helpers/integration-314-vertical-main';

const report = process.env.VERTICAL_314_REPORT_DIR;
const save = async (file: string, value: unknown) => {
  if (report)
    await writeFile(
      path.join(report, file),
      JSON.stringify(value, null, 2) + '\n',
    );
};

test('vertical route source closure preflight without Chromium', async () => {
  const browser = await verticalBrowserBundle();
  const main = await verticalMainFixture();
  try {
    expect(main.source.verticalCallbacks).toBe(main.source.aliasCallbacks);
    expect(main.source.verticalCallbacks.size).toBe(2);
    await save('import-closure.json', {
      main: main.modules,
      browser: browser.modules,
    });
  } finally {
    const closed = await main.close();
    expect(closed.callbackCount).toBe(0);
    expect(closed.ipcListeners).toBe(0);
  }
});

test('REST Previous crosses native ownership, metadata, finish download and lyrics, then survives owner replacement', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const browser = await verticalBrowserBundle();
  const main = await verticalMainFixture();
  const sent: any[] = [],
    held: any[] = [],
    front: any[] = [],
    responses: any[] = [];
  let holdControl = false,
    delivery = Promise.resolve(),
    closed: any;
  await page.exposeFunction('verticalSend', ({ channel, args }: any) => {
    const event = {
      sender: main.contents,
      senderFrame: main.contents.mainFrame,
    };
    front.push({ channel, args });
    main.ipcMain.emit(channel, event, ...args);
  });
  main.contents.send = (channel: string, ...args: any[]) => {
    const message = { channel, args };
    sent.push(message);
    if (
      holdControl &&
      channel === 'peard:music-read' &&
      args[0].input.operation === 'control'
    )
      held.push(message);
    else
      delivery = delivery.then(() =>
        page.evaluate(
          ({ channel, args }) => (window as any).verticalDeliver(channel, args),
          message,
        ),
      );
  };
  const http = async (
    endpoint: string,
    value?: any,
    token = main.local.token,
  ) => {
    const result = await main.http(
      '/api/v1/music' + endpoint,
      value === undefined ? 'GET' : 'POST',
      value === undefined ? undefined : JSON.stringify(value),
      { host: '127.0.0.1:' + main.port },
      token,
    );
    responses.push({ endpoint, status: result.status, body: result.body });
    return result;
  };
  const grant = async () =>
    main.store.issue(
      'Vertical synthetic',
      'rest',
      `http://127.0.0.1:${main.port}/api/v1/music`,
      ['playback.read', 'playback.control'],
      () => true,
    );
  const prepare = async (action: string, token = main.local.token) => {
    const prepared = await http('/operations/prepare', { action }, token);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    return { action, operationId: prepared.body.operationId };
  };
  const state = () =>
    page.evaluate(() => {
      const w = window as any,
        s = w.VerticalSource;
      return {
        effects: w.v.effects,
        front: s.getSongInfo().videoId,
        lyrics: JSON.parse(JSON.stringify(s.lyricsStore.lyrics.LRCLib)),
        native: w.v.state.id,
        controller: w.v.controller.stats?.(),
      };
    });
  try {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://music.vertical.invalid')
        return route.fulfill({
          contentType: 'text/html',
          body: '<ytmusic-app></ytmusic-app><div id="movie_player"></div><video></video><ytmusic-player-bar></ytmusic-player-bar><div id="queue"></div><input id="progress-bar" value="0"><div id="lyrics-header"></div>',
        });
      throw Error('Unowned browser request: ' + url.origin);
    });
    await page.goto('https://music.vertical.invalid');
    // Only the LRCLib HTTP leaf is controlled. Ignore AbortSignal deliberately:
    // delayed external data must still be fenced by the real provider/store.
    await page.evaluate(() => {
      const w = window as any;
      w.lyricsRequests = [];
      w.heldLyrics = [];
      w.fetch = async (input: any) => {
        const url = new URL(String(input));
        if (url.origin !== 'https://lrclib.net')
          throw Error('Unowned lyrics origin');
        const title =
          url.searchParams.get('track_name') ?? url.searchParams.get('q') ?? '';
        w.lyricsRequests.push({ url: url.href, title });
        const isA = title.includes('Short A'),
          isC = title.includes('Current C');
        const value = [
          {
            id: isA ? 1 : 2,
            name: isA ? 'Short A' : isC ? 'Current C' : 'Blocked B',
            trackName: isA ? 'Short A' : isC ? 'Current C' : 'Blocked B',
            artistName: isA || isC ? 'Allowed' : 'Blocked',
            albumName: '',
            duration: isA ? 2 : 20,
            instrumental: false,
            syncedLyrics: isA
              ? '[00:00.00]OLD A\n[00:01.00]OLD A END'
              : isC
                ? '[00:01.00]CURRENT C\n[00:12.00]CURRENT C END'
                : '[00:01.00]CURRENT B\n[00:12.00]CURRENT B END',
            plainLyrics: isA ? 'OLD A' : isC ? 'CURRENT C' : 'CURRENT B',
          },
        ];
        if (isA)
          await new Promise<void>((resolve) => w.heldLyrics.push(resolve));
        return new Response(JSON.stringify(value), {
          headers: { 'content-type': 'application/json' },
        });
      };
    });
    await installVerticalBrowser(page, browser.code);
    await page.evaluate(() => (window as any).v.announce());
    await expect
      .poll(
        () => main.callbacks.filter((row) => row.id === 'trackA00001').length,
      )
      .toBe(1);
    await expect
      .poll(() => page.evaluate(() => (window as any).heldLyrics.length))
      .toBe(1);
    main.ipcMain.emit('peard:player-api-loaded', {
      sender: main.contents,
      senderFrame: main.contents.mainFrame,
    });
    await delivery;
    await page.evaluate(() =>
      document.querySelector('#progress-bar')!.setAttribute('value', '1.5'),
    );
    await expect
      .poll(
        () =>
          main.callbacks
            .filter((row) => row.event === 'peard:time-changed')
            .at(-1)?.elapsed,
      )
      .toBe(1.5);

    const revoked = await grant();
    const discarded = await prepare('previous', revoked.token);
    await main.store.revoke(revoked.record.id, () => true);
    const denied = await http('/control', discarded, revoked.token);
    expect(denied.status).toBe(401);
    expect((await state()).effects).toEqual([]);
    expect(
      sent.filter(
        (row) =>
          row.channel === 'peard:music-read' &&
          row.args[0].input.operation === 'control',
      ),
    ).toHaveLength(0);

    const active = await grant();
    const command = await prepare('previous', active.token);
    const accepted = await http('/control', command, active.token);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    expect((await state()).effects).toEqual([
      { action: 'previous', id: 'trackA00001', time: 1.5 },
    ]);
    expect(JSON.stringify(accepted.body)).toContain('owned_control_dispatch');
    expect((await http('/control', command, active.token)).body).toEqual(
      accepted.body,
    );
    await expect
      .poll(
        () => main.callbacks.filter((row) => row.id === 'trackB00001').length,
      )
      .toBe(1);
    await expect.poll(() => main.state.info).toEqual(['trackA00001']);
    await expect.poll(() => main.state.runs.length).toBe(1);
    await expect
      .poll(async () =>
        JSON.parse(
          await readFile(
            path.join(main.directory, '.pear-desktop-library.json'),
            'utf8',
          ).catch((error) => {
            if (error.code === 'ENOENT') return '{\"records\":[]}';
            throw error;
          }),
        ).records.map((row: any) => row.videoId),
      )
      .toEqual(['trackA00001']);
    await expect
      .poll(async () => (await state()).lyrics.data?.title)
      .toBe('Blocked B');
    const before = await state();
    expect(before).toMatchObject({
      front: 'trackB00001',
      native: 'trackB00001',
      effects: [{ action: 'previous', id: 'trackA00001', time: 1.5 }],
    });
    expect(main.source.verticalCallbacks).toBe(main.source.aliasCallbacks);
    expect(main.source.verticalCallbacks.size).toBe(2);

    // Prove real authenticated delivery entered the transport before retirement.
    const old = await prepare('pause', active.token);
    holdControl = true;
    const pending = http('/control', old, active.token);
    await expect.poll(() => held.length).toBe(1);
    const oldPacket = held[0].args[0];
    expect(oldPacket).toMatchObject({
      input: { operation: 'control', command: { action: 'pause' } },
    });
    expect(oldPacket.documentId).toMatch(/^[a-f0-9]{32}$/);
    expect(oldPacket.sourceId).toMatch(/^[a-f0-9]{32}$/);
    const oldFrame = main.contents.mainFrame;
    const oldMetadata = front.find(
      (row) => row.channel === 'peard:video-src-changed',
    )!;
    expect(oldMetadata).toBeTruthy();
    await page.evaluate(() => {
      const w = window as any,
        v = w.v,
        s = w.VerticalSource;
      s.lyrics.stop();
      s.blocklist.renderer.stop();
      v.controller.dispose();
      v.disposeOwner();
      document
        .querySelector('#movie_player')!
        .replaceWith(
          Object.assign(document.createElement('div'), { id: 'movie_player' }),
        );
      v.handlers.clear();
      v.arrive(2); // Replacement owner starts on allowed C; B's old intent is retired.
    });
    main.contents.emit(
      'did-start-navigation',
      {},
      'https://music.vertical.invalid/rebound',
      false,
      true,
    );
    main.contents.mainFrame = {};
    main.contents.emit(
      'did-navigate',
      {},
      'https://music.vertical.invalid/rebound',
    );
    await main.rebind();
    holdControl = false;
    await page.evaluate(() => (window as any).v.bind());
    await page.evaluate(() => (window as any).v.announce());
    await expect
      .poll(
        () => main.callbacks.filter((row) => row.id === 'trackC00001').length,
      )
      .toBe(1);
    const retired = await pending;
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({
      status: 'uncertain',
      error: 'outcome_unknown',
    });
    // Replay exact old packet to new real controller, with its old auth fields.
    await page.evaluate(
      ({ channel, args }) => (window as any).verticalDeliver(channel, args),
      held.shift(),
    );
    // Old native frame cannot admit metadata into the actual main provider.
    main.ipcMain.emit(
      oldMetadata.channel,
      { sender: main.contents, senderFrame: oldFrame },
      ...oldMetadata.args,
    );
    await page.evaluate(() => {
      for (const resolve of (window as any).heldLyrics.splice(0)) resolve();
    });
    await delivery;
    await expect
      .poll(async () => (await state()).lyrics.data?.title)
      .toBe('Current C');
    expect((await state()).effects).toEqual(before.effects);
    expect(main.state.info).toEqual(['trackA00001']);
    expect(main.state.runs).toHaveLength(1);
    expect(
      main.callbacks.filter((row) => row.id === 'trackA00001'),
    ).toHaveLength(2); // metadata + real time event, no retired publication

    const current = await prepare('pause', active.token);
    const recovered = await http('/control', current, active.token);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.status).toBe('accepted');
    const after = await state();
    expect(after.effects).toEqual([
      ...before.effects,
      { action: 'pause', id: 'trackC00001' },
    ]);
    expect(after.front).toBe(after.native);
    expect(after.front).toBe('trackC00001');
    await save('case-observations.json', {
      responses,
      before,
      after,
      callbacks: main.callbacks,
      downloads: main.state.info,
      ffmpegRuns: main.state.runs.length,
      oldPacket: {
        requestId: oldPacket.requestId,
        nonce: oldPacket.nonce,
        documentId: oldPacket.documentId,
        sourceId: oldPacket.sourceId,
      },
      mainModules: main.modules,
      browserModules: browser.modules,
    });
  } finally {
    await save('last-run-debug.json', {
      responses,
      sent,
      front,
      callbacks: main.callbacks,
      state: await state().catch(() => null),
      downloads: main.state,
    });
    await page
      .evaluate(() => {
        const w = window as any;
        if (w.v) {
          w.VerticalSource.lyrics.stop();
          w.VerticalSource.blocklist.renderer.stop();
          w.v.controller.dispose();
          w.v.disposeOwner();
        }
        for (const resolve of w.heldLyrics?.splice(0) ?? []) resolve();
      })
      .catch(() => {});
    await delivery.catch(() => {});
    closed = await main.close();
    await page.close();
    await save('teardown.json', closed);
    expect(closed).toMatchObject({
      callbackCount: 0,
      handlerCount: 0,
      jobs: 0,
      ipcListeners: 0,
      brokerDispatched: 0,
      brokerQueued: 0,
      serverListening: false,
      openRequestClients: 0,
      openServerSockets: 0,
      held: 0,
    });
  }
});
