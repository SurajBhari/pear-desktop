import { test, expect } from '@playwright/test';
import { musicHttpFixture } from './helpers/api-music-http';
import { musicRendererFixture } from './helpers/api-music-renderer';

const song = {
  action: 'play_song',
  videoId: 'seedVideo01',
  playlistId: 'PL_N1PlaylistA',
};

test('N1 REST prepares an immutable server UUID without native dispatch', async () => {
  const f = await musicHttpFixture();
  try {
    const g = await f.store.issue(
      'N1',
      'rest',
      f.service.resource,
      ['playback.control'],
      () => true,
    );
    const r = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      JSON.stringify(song),
      { authorization: 'Bearer ' + g.token },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      status: 'pending',
    });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('N1 actual renderer dispatches ordinary song on captured app with exact endpoint', async () => {
  const f = await musicRendererFixture();
  const events: any[] = [];
  f.app.addEventListener('yt-navigate', (event: any) =>
    events.push({ target: event.target, detail: event.detail }),
  );
  try {
    const q = f.read(f.query(), {
      operation: 'navigate',
      command: song,
      deadlineAt: Date.now() + 10000,
    });
    await f.flush();
    expect(events).toHaveLength(1);
    expect(events[0].target).toBe(f.app);
    expect(events[0].detail).toEqual({
      endpoint: {
        watchEndpoint: { videoId: song.videoId, playlistId: song.playlistId },
      },
    });
    expect(f.result(q)).toEqual({
      ok: true,
      value: { version: 1, phase: 'owned_dispatch' },
    });
    expect(f.fetches).toHaveLength(0);
  } finally {
    await f.close();
  }
});

// Literal synthetic service shapes from the pinned public-schema N1 seeds.
const seeds = [
  {
    'name': 'ordinary-song',
    'command': {
      'action': 'play_song',
      'videoId': 'seedVideo01',
      'playlistId': 'PL_N1PlaylistA',
    },
    'request': null,
    'raw': null,
    'expected': {
      'watchEndpoint': {
        'videoId': 'seedVideo01',
        'playlistId': 'PL_N1PlaylistA',
      },
    },
  },
  {
    'name': 'ordinary-playlist',
    'command': {
      'action': 'play_playlist',
      'playlistId': 'PL_N1PlaylistA',
      'shuffle': false,
    },
    'request': null,
    'raw': null,
    'expected': {
      'watchPlaylistEndpoint': {
        'playlistId': 'PL_N1PlaylistA',
      },
    },
  },
  {
    'name': 'shuffled-playlist',
    'command': {
      'action': 'play_playlist',
      'playlistId': 'PL_N1PlaylistA',
      'shuffle': true,
    },
    'request': {
      'path': '/browse',
      'body': {
        'browseId': 'VLPL_N1PlaylistA',
      },
    },
    'raw': {
      'header': {
        'musicResponsiveHeaderRenderer': {
          'buttons': [
            {
              'buttonRenderer': {
                'icon': {
                  'iconType': 'MUSIC_SHUFFLE',
                },
                'navigationEndpoint': {
                  'watchPlaylistEndpoint': {
                    'playlistId': 'PL_N1PlaylistA',
                    'params': 'opaqueShuffleSeedA',
                  },
                },
              },
            },
          ],
        },
      },
    },
    'expected': {
      'watchPlaylistEndpoint': {
        'playlistId': 'PL_N1PlaylistA',
        'params': 'opaqueShuffleSeedA',
      },
    },
  },
  {
    'name': 'video-radio',
    'command': {
      'action': 'radio',
      'seed': {
        'kind': 'video',
        'videoId': 'seedVideo01',
      },
    },
    'request': {
      'path': '/next',
      'body': {
        'videoId': 'seedVideo01',
        'isAudioOnly': true,
      },
    },
    'raw': {
      'contents': {
        'singleColumnMusicWatchNextResultsRenderer': {
          'tabbedRenderer': {
            'watchNextTabbedResultsRenderer': {
              'tabs': [
                {
                  'tabRenderer': {
                    'content': {
                      'musicQueueRenderer': {
                        'content': {
                          'playlistPanelRenderer': {
                            'playlistId': 'PL_N1QueueSource',
                            'contents': [
                              {
                                'playlistPanelVideoRenderer': {
                                  'videoId': 'seedVideo01',
                                  'navigationEndpoint': {
                                    'watchEndpoint': {
                                      'videoId': 'seedVideo01',
                                    },
                                  },
                                  'menu': {
                                    'menuRenderer': {
                                      'items': [
                                        {
                                          'menuNavigationItemRenderer': {
                                            'icon': {
                                              'iconType': 'MIX',
                                            },
                                            'navigationEndpoint': {
                                              'watchEndpoint': {
                                                'videoId': 'seedVideo01',
                                                'playlistId':
                                                  'RDSERVICE_video_A',
                                                'params': 'opaqueRadioVideoB',
                                              },
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                },
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
    'expected': {
      'watchEndpoint': {
        'videoId': 'seedVideo01',
        'playlistId': 'RDSERVICE_video_A',
        'params': 'opaqueRadioVideoB',
      },
    },
  },
  {
    'name': 'playlist-radio',
    'command': {
      'action': 'radio',
      'seed': {
        'kind': 'playlist',
        'playlistId': 'PL_N1PlaylistA',
      },
    },
    'request': {
      'path': '/browse',
      'body': {
        'browseId': 'VLPL_N1PlaylistA',
      },
    },
    'raw': {
      'header': {
        'musicResponsiveHeaderRenderer': {
          'buttons': [
            {
              'buttonRenderer': {
                'icon': {
                  'iconType': 'MIX',
                },
                'navigationEndpoint': {
                  'watchPlaylistEndpoint': {
                    'playlistId': 'RDSERVICE_playlist_C',
                    'params': 'opaqueRadioPlaylistC',
                  },
                },
              },
            },
          ],
        },
      },
    },
    'expected': {
      'watchPlaylistEndpoint': {
        'playlistId': 'RDSERVICE_playlist_C',
        'params': 'opaqueRadioPlaylistC',
      },
    },
  },
  {
    'name': 'current-radio',
    'command': {
      'action': 'radio',
      'seed': {
        'kind': 'current',
      },
    },
    'request': {
      'path': '/next',
      'body': {
        'videoId': 'seedVideo03',
        'isAudioOnly': true,
      },
    },
    'raw': {
      'contents': {
        'singleColumnMusicWatchNextResultsRenderer': {
          'tabbedRenderer': {
            'watchNextTabbedResultsRenderer': {
              'tabs': [
                {
                  'tabRenderer': {
                    'content': {
                      'musicQueueRenderer': {
                        'content': {
                          'playlistPanelRenderer': {
                            'playlistId': 'PL_N1QueueSource',
                            'contents': [
                              {
                                'playlistPanelVideoRenderer': {
                                  'videoId': 'seedVideo03',
                                  'navigationEndpoint': {
                                    'watchEndpoint': {
                                      'videoId': 'seedVideo03',
                                    },
                                  },
                                  'menu': {
                                    'menuRenderer': {
                                      'items': [
                                        {
                                          'menuNavigationItemRenderer': {
                                            'icon': {
                                              'iconType': 'MIX',
                                            },
                                            'navigationEndpoint': {
                                              'watchEndpoint': {
                                                'videoId': 'seedVideo03',
                                                'playlistId':
                                                  'RDSERVICE_current_D',
                                                'params': 'opaqueRadioCurrentD',
                                              },
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                },
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
    'expected': {
      'watchEndpoint': {
        'videoId': 'seedVideo03',
        'playlistId': 'RDSERVICE_current_D',
        'params': 'opaqueRadioCurrentD',
      },
    },
  },
] as const;

for (const seed of seeds)
  test('N1 public recipe positive ' + seed.name, async () => {
    const f = await musicRendererFixture();
    const events: any[] = [];
    f.app.addEventListener('yt-navigate', (event: any) => events.push(event));
    try {
      if (seed.name === 'current-radio') f.setVideo('seedVideo03');
      const q = f.read(f.query(), {
        operation: 'navigate',
        command: seed.command,
        deadlineAt: Date.now() + 10000,
      });
      await f.flush();
      if (seed.request) {
        expect(f.fetches).toHaveLength(1);
        expect({ path: f.fetches[0].url, body: f.fetches[0].data }).toEqual(
          seed.request,
        );
        f.fetches[0].resolve(seed.raw);
        await f.flush();
      }
      expect(events).toHaveLength(1);
      expect(events[0].target).toBe(f.app);
      expect(events[0].detail).toEqual({ endpoint: seed.expected });
      expect(f.result(q)).toMatchObject({
        ok: true,
        value: { version: 1, phase: 'owned_dispatch' },
      });
      if (seed.name === 'current-radio') {
        const binding = f.result(q).value.binding;
        expect(binding.videoId).toBe('seedVideo03');
        expect(binding.playbackEpoch).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}$/);
        expect(binding.playbackEpoch.split(':')[0]).toBe(q.documentId);
      }
    } finally {
      await f.close();
    }
  });

test('N1 REST executes once and replays immutable receipt under originating scope', async () => {
  const f = await musicHttpFixture();
  let brokerCalls = 0;
  const broker = (f.service as any).broker;
  const admission = broker.capture();
  broker.capture = () => admission;
  broker.read = async (_a: any, input: any, _p: any, options: any) => {
    brokerCalls++;
    expect(input.command).toEqual(song);
    options.onPhysicalSettled('authenticated_ack');
    return { version: 1, phase: 'owned_dispatch' };
  };
  try {
    const grant = await f.store.issue(
      'N1',
      'rest',
      f.service.resource,
      ['playback.control'],
      () => true,
    );
    const headers = { authorization: 'Bearer ' + grant.token };
    const prepared = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      JSON.stringify(song),
      headers,
    );
    const body = {
      videoId: song.videoId,
      playlistId: song.playlistId,
      operationId: prepared.body.operationId,
    };
    const [a, b] = await Promise.all([
      f.http('/api/v1/music/play/song', 'POST', JSON.stringify(body), headers),
      f.http('/api/v1/music/play/song', 'POST', JSON.stringify(body), headers),
    ]);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      operationId: body.operationId,
      status: 'accepted',
      meaning: 'owned_navigation_dispatch',
    });
    expect(b.body).toEqual(a.body);
    expect(brokerCalls).toBe(1);
    const conflict = await f.http(
      '/api/v1/music/play/song',
      'POST',
      JSON.stringify({ ...body, videoId: 'other000001' }),
      headers,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('conflict');
    const status = await f.http(
      '/api/v1/music/operations/' + body.operationId,
      'GET',
      undefined,
      headers,
    );
    expect(status.body).toEqual(a.body);
    const wrongScope = await f.http(
      '/api/v1/music/operations/' + body.operationId,
      'GET',
      undefined,
      { authorization: 'Bearer ' + f.grant.token },
    );
    expect(wrongScope.status).toBe(403);
    const unknown = await f.http(
      '/api/v1/music/play/song',
      'POST',
      JSON.stringify({
        ...body,
        operationId: '00000000-0000-4000-8000-000000000000',
      }),
      headers,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('unknown_operation');
    expect(brokerCalls).toBe(1);
  } finally {
    await f.close();
  }
});

test('N1 native grant selector adds and removes playback control at preserved index six', async () => {
  const { musicModuleSource } = await import('./helpers/api-music-source');
  const m = await musicModuleSource('src/plugins/api-server/music-menu.ts');
  let issued: any;
  const choices = [6, 6, 6, 2, 0],
    dialogs: any[] = [];
  const service = {
    resource: 'http://127.0.0.1:26538/api/v1/music',
    captureNativeOwner: () => ({ current: () => true }),
    grants: {
      issue: async (_n: any, _t: any, _r: any, scopes: any) => {
        issued = [...scopes];
        return { record: { id: 'owned' }, token: 'private-fixture' };
      },
      revoke: async () => {},
    },
  };
  const menu = await m.createMusicGrantMenu(
    { getConfig: async () => ({ enabled: true, musicApiEnabled: true }) },
    () => service,
    {
      prompt: async () => 'N1',
      show: async (options: any) => {
        dialogs.push(options);
        return { response: choices.shift() };
      },
      copy: () => {},
    },
  );
  await menu.find((item: any) => item.label === 'Create client grant…').click();
  expect(issued).toEqual(['playback.control']);
  expect(dialogs[0].buttons.slice(2, 6)).toEqual([
    'Create grant',
    'Cancel',
    'Add Home read',
    'Add library playlists read',
  ]);
  expect(dialogs[0].buttons[6]).toBe('Add playback control');
  expect(dialogs[1].buttons[6]).toBe('Remove playback control');
});

async function operationFixture() {
  const { musicServiceFixture } = await import('./helpers/api-music-service');
  const f = await musicServiceFixture(),
    broker = (f.service as any).broker;
  const admission = broker.capture();
  broker.capture = () => admission;
  const grant = await f.store.issue(
    'N1 operations',
    'rest',
    f.resource,
    ['playback.control'],
    () => true,
  );
  const calls: any[] = [];
  broker.read = (_admission: any, input: any, _principal: any, options: any) =>
    new Promise((resolve, reject) =>
      calls.push({ input, options, resolve, reject }),
    );
  return {
    ...f,
    broker,
    grant,
    calls,
    access: {
      transport: 'rest',
      resource: f.resource,
      owner: f.service.accessOwner('rest', f.resource),
    },
  };
}

function until(check: () => boolean) {
  return expect.poll(check).toBe(true);
}

test('N1 silent native flip at deadline stays timeout without terminal authority probes', async () => {
  const f = await operationFixture();
  const probes: string[] = [];
  let terminal = false;
  const current = f.store.isCurrent.bind(f.store),
    native = f.broker.isCurrent.bind(f.broker);
  f.store.isCurrent = (...args: any[]) => {
    if (terminal) probes.push('grant');
    return current(...args);
  };
  f.broker.isCurrent = (...args: any[]) => {
    if (terminal) probes.push('native');
    return native(...args);
  };
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      row = (f.service as any).operations.lookup(
        prepared.operationId,
        f.grant.record,
        f.access,
      ),
      execution = f.service.navigate(
        f.grant.token,
        { ...song, operationId: prepared.operationId },
        undefined,
        (f.service as any).now() + 10000,
      ).catch((error: any) => error.code);
    await until(() => f.calls.length === 1);
    f.advance(10000);
    terminal = true;
    f.retire(); // Deliberately silent; no subscribeRetirement notification.
    f.calls[0].reject(Error('ACK lost after hidden native flip'));
    expect(await execution).toBe('timeout');
    expect(probes).toEqual([]);
    expect(row.receipt).toMatchObject({ status: 'uncertain', error: 'outcome_unknown' });
    expect(row.physicalHold).toBe(true);
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    expect(row.physicalHold).toBe(false);
    expect(f.calls).toHaveLength(1);
  } finally {
    terminal = false;
    await f.close();
  }
});

// These boundaries use the fixture clock, so no real deadline timer can win.
for (const elapsed of [10000, 10001]) {
  test(`N1 deadline-only lost ACK rejects timeout at elapsed ${elapsed} and preserves the physical hold`, async () => {
    const f = await operationFixture();
    try {
      const prepared = await f.service.prepare(f.grant.token, song),
        command = { ...song, operationId: prepared.operationId },
        deadline = (f.service as any).now() + 10000,
        row = (f.service as any).operations.lookup(
          prepared.operationId,
          f.grant.record,
          f.access,
        );
      const execution = f.service.navigate(
        f.grant.token,
        command,
        undefined,
        deadline,
      );
      await until(() => f.calls.length === 1);
      f.advance(elapsed);
      f.calls[0].reject(Error('Owned dispatch ACK lost at deadline'));
      await expect(execution).rejects.toMatchObject({ code: 'timeout' });
      const receipt = {
        operationId: prepared.operationId,
        status: 'uncertain',
        error: 'outcome_unknown',
      };
      expect(row.physicalHold).toBe(true);
      expect(
        await f.service.operation(f.grant.token, prepared.operationId),
      ).toEqual(receipt);
      expect(await f.service.navigate(f.grant.token, command)).toEqual(receipt);
      expect(f.calls).toHaveLength(1);
      f.calls[0].options.onPhysicalSettled('authenticated_ack');
      expect(row.physicalHold).toBe(false);
      expect(
        await f.service.operation(f.grant.token, prepared.operationId),
      ).toEqual(receipt);
      expect(await f.service.navigate(f.grant.token, command)).toEqual(receipt);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

test('N1 deadline crossed during authorization rejects timeout without broker admission', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song);
    f.authHold();
    const execution = f.service.navigate(
      f.grant.token,
      { ...song, operationId: prepared.operationId },
      undefined,
      (f.service as any).now() + 10000,
    );
    f.advance(10000);
    f.authRelease();
    await expect(execution).rejects.toMatchObject({ code: 'timeout' });
    expect(f.calls).toHaveLength(0);
    expect(
      await f.service.operation(f.grant.token, prepared.operationId),
    ).toEqual(prepared);
  } finally {
    await f.close();
  }
});

test('N1 deadline crossed at grant subscription rejects timeout without broker admission', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      subscribe = f.store.subscribe.bind(f.store);
    f.store.subscribe = (listener: () => void) => {
      const detach = subscribe(listener);
      f.advance(10000);
      return detach;
    };
    const execution = f.service.navigate(
      f.grant.token,
      { ...song, operationId: prepared.operationId },
      undefined,
      (f.service as any).now() + 10000,
    );
    await expect(execution).rejects.toMatchObject({ code: 'timeout' });
    expect(f.calls).toHaveLength(0);
    f.store.subscribe = subscribe;
    expect(
      await f.service.operation(f.grant.token, prepared.operationId),
    ).toEqual(prepared);
  } finally {
    await f.close();
  }
});

test('N1 grant expiry after completed authorization takes precedence over deadline', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      authorize = f.store.authorize.bind(f.store);
    f.store.authorize = async (...args: any[]) => {
      const principal = await authorize(...args);
      f.advance(86400000);
      return principal;
    };
    await expect(
      f.service.navigate(
        f.grant.token,
        { ...song, operationId: prepared.operationId },
        undefined,
        (f.service as any).now() + 10000,
      ),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('N1 deadline-only grant notification preserves a typed timeout abort', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      command = { ...song, operationId: prepared.operationId },
      subscribe = f.store.subscribe.bind(f.store);
    let notify: (() => void) | undefined;
    f.store.subscribe = (listener: () => void) => {
      notify = listener;
      return subscribe(listener);
    };
    const execution = f.service
      .navigate(
        f.grant.token,
        command,
        undefined,
        (f.service as any).now() + 10000,
      )
      .catch((error: any) => error.code);
    await until(() => f.calls.length === 1);
    f.advance(10000);
    notify!();
    f.calls[0].reject(Error('Delayed ACK after unrelated grant notification'));
    expect(await execution).toBe('timeout');
    f.store.subscribe = subscribe;
    expect(
      await f.service.operation(f.grant.token, prepared.operationId),
    ).toMatchObject({
      status: 'uncertain',
      error: 'outcome_unknown',
    });
    expect(f.calls).toHaveLength(1);
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
  } finally {
    await f.close();
  }
});

for (const retirement of [
  'native',
  'grant-expiry',
  'grant-revocation',
  'revision',
]) {
  test(`N1 actual ${retirement} retirement takes precedence over coincident deadline`, async () => {
    const f = await operationFixture();
    try {
      const prepared = await f.service.prepare(f.grant.token, song),
        command = { ...song, operationId: prepared.operationId };
      const execution = f.service
        .navigate(
          f.grant.token,
          command,
          undefined,
          (f.service as any).now() + 10000,
        )
        .catch((error: any) => error.code);
      await until(() => f.calls.length === 1);
      f.advance(retirement === 'grant-expiry' ? 86400000 : 10000);
      if (retirement === 'native') f.retireObserved();
      if (retirement === 'grant-revocation')
        await f.store.revoke(f.grant.record.id, () => true);
      if (retirement === 'revision') f.service.configure(f.config);
      f.calls[0].reject(Error('ACK lost with actual retirement'));
      expect(await execution).toBe('retired');
      await expect(
        f.service.navigate(f.grant.token, command),
      ).rejects.toMatchObject({
        code: retirement.startsWith('grant-') ? 'unauthorized' : 'retired',
      });
      expect(f.calls).toHaveLength(1);
      f.calls[0].options.onPhysicalSettled('authenticated_ack');
    } finally {
      await f.close();
    }
  });
}

// Capture the actual installed callbacks; only the fixture clock/state changes.
for (const condition of [
  'deadline-only',
  'expired-grant',
  'lost-native-owner',
  'grant-timer-before-clock-expiry',
]) {
  test(`N1 final deadline callback classifies actual ${condition} state`, async () => {
    const f = await operationFixture();
    const callbacks: (() => void)[] = [],
      original = globalThis.setTimeout;
    let execution: Promise<any> | undefined;
    try {
      if (condition === 'expired-grant')
        f.advance(f.grant.record.expiresAt - (f.service as any).now() - 10001);
      if (condition === 'grant-timer-before-clock-expiry')
        f.advance(f.grant.record.expiresAt - (f.service as any).now() - 1000);
      const prepared = await f.service.prepare(f.grant.token, song);
      try {
        globalThis.setTimeout = ((callback: any, ...args: any[]) => {
          callbacks.push(callback);
          return (original as any)(callback, ...args);
        }) as any;
        execution = f.service
          .navigate(
            f.grant.token,
            { ...song, operationId: prepared.operationId },
            undefined,
            (f.service as any).now() + 10000,
          )
          .catch((error: any) => error.code);
        for (let turn = 0; turn < 100 && f.calls.length === 0; turn++)
          await Promise.resolve();
      } finally {
        globalThis.setTimeout = original;
      }
      expect(f.calls).toHaveLength(1);
      expect(callbacks).toHaveLength(2);
      f.advance(
        condition === 'expired-grant'
          ? 10001
          : condition === 'grant-timer-before-clock-expiry'
            ? 0
            : 10000,
      );
      if (condition === 'lost-native-owner') f.retireObserved();
      callbacks[1]();
      expect(await execution).toBe(
        condition === 'deadline-only' ? 'timeout' : 'retired',
      );
    } finally {
      globalThis.setTimeout = original;
      if (f.calls.length) {
        f.calls[0].reject(Error('Late ACK after controlled final callback'));
        f.calls[0].options.onPhysicalSettled('authenticated_ack');
      }
      await f.close();
    }
  });
}

for (const condition of ['deadline-only', 'lost-native-owner']) {
  test(`N1 initial deadline callback classifies actual ${condition} state`, async () => {
    const f = await operationFixture();
    const callbacks: (() => void)[] = [],
      original = globalThis.setTimeout;
    try {
      const prepared = await f.service.prepare(f.grant.token, song);
      f.authHold();
      let execution: Promise<any>;
      try {
        globalThis.setTimeout = ((callback: any, ...args: any[]) => {
          callbacks.push(callback);
          return (original as any)(callback, ...args);
        }) as any;
        execution = f.service
          .navigate(
            f.grant.token,
            { ...song, operationId: prepared.operationId },
            undefined,
            (f.service as any).now() + 10000,
          )
          .catch((error: any) => error.code);
      } finally {
        globalThis.setTimeout = original;
      }
      expect(callbacks).toHaveLength(1);
      f.advance(10000);
      if (condition === 'lost-native-owner') f.retireObserved();
      callbacks[0]();
      expect(await execution).toBe(
        condition === 'deadline-only' ? 'timeout' : 'retired',
      );
      expect(f.calls).toHaveLength(0);
    } finally {
      globalThis.setTimeout = original;
      f.authRelease();
      await f.close();
    }
  });
}

test('N1 equal grant and request deadline timer retires the grant', async () => {
  const f = await operationFixture();
  try {
    f.advance(f.grant.record.expiresAt - (f.service as any).now() - 50);
    const prepared = await f.service.prepare(f.grant.token, song),
      row = (f.service as any).operations.lookup(
        prepared.operationId,
        f.grant.record,
        f.access,
      ),
      execution = f.service
        .navigate(
          f.grant.token,
          { ...song, operationId: prepared.operationId },
          undefined,
          f.grant.record.expiresAt,
        )
        .catch((error: any) => error.code);
    for (let turn = 0; turn < 100 && f.calls.length === 0; turn++)
      await Promise.resolve();
    expect(f.calls).toHaveLength(1);
    f.advance(50);
    expect(await execution).toBe('retired');
    expect(row.physicalHold).toBe(true);
    f.calls[0].reject(Error('Late ACK after grant expiry'));
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    await expect(
      f.service.operation(f.grant.token, prepared.operationId),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('N1 typed timeout abort remains an error when native ownership also retires', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      command = { ...song, operationId: prepared.operationId },
      timeout = await f.service
        .navigate(f.grant.token, command, undefined, (f.service as any).now())
        .catch((error: any) => error);
    expect(timeout).toMatchObject({ code: 'timeout' });
    const controller = new AbortController(),
      execution = f.service
        .navigate(f.grant.token, command, controller.signal)
        .catch((error: any) => error.code);
    await until(() => f.calls.length === 1);
    controller.abort(timeout);
    f.retireObserved();
    f.calls[0].reject(Error('Late ACK failure'));
    expect(await execution).toBe('timeout');
    await expect(
      f.service.operation(f.grant.token, prepared.operationId),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(f.calls).toHaveLength(1);
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
  } finally {
    await f.close();
  }
});

test('N1 duplicate cancellation cannot cancel original execution and status remains private', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      command = { ...song, operationId: prepared.operationId };
    const original = f.service.navigate(f.grant.token, command);
    await until(() => f.calls.length === 1);
    const duplicateSignal = new AbortController(),
      duplicate = f.service
        .navigate(f.grant.token, command, duplicateSignal.signal)
        .catch((e: any) => e.code);
    await new Promise((r) => setTimeout(r, 5));
    duplicateSignal.abort();
    expect(await duplicate).toBe('retired');
    expect(f.calls[0].options.signal.aborted).toBe(false);
    expect(f.calls).toHaveLength(1);
    const foreign = await f.store.issue(
      'Foreign',
      'rest',
      f.resource,
      ['playback.control'],
      () => true,
    );
    await expect(
      f.service.operation(foreign.token, prepared.operationId),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    f.calls[0].resolve({ version: 1, phase: 'owned_dispatch' });
    expect(await original).toMatchObject({ status: 'accepted' });
    expect(await f.service.navigate(f.grant.token, command)).toMatchObject({
      status: 'accepted',
    });
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('N1 lost ACK is permanently uncertain and late physical settlement never upgrades receipt', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, {
        action: 'radio',
        seed: { kind: 'current' },
      }),
      command = {
        action: 'radio',
        seed: { kind: 'current' },
        operationId: prepared.operationId,
      };
    const execution = f.service.navigate(f.grant.token, command);
    await until(() => f.calls.length === 1);
    f.calls[0].reject(new Error('ACK lost after submission'));
    const receipt = await execution;
    expect(receipt).toEqual({
      operationId: prepared.operationId,
      status: 'uncertain',
      error: 'outcome_unknown',
    });
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    expect(
      await f.service.operation(f.grant.token, prepared.operationId),
    ).toEqual(receipt);
    expect(await f.service.navigate(f.grant.token, command)).toEqual(receipt);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('N1 typed pre-effect denial replays definite failure without a second broker call', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      command = { ...song, operationId: prepared.operationId };
    const execution = f.service.navigate(f.grant.token, command);
    await until(() => f.calls.length === 1);
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    f.calls[0].resolve({
      version: 1,
      phase: 'pre_effect_denial',
      reason: 'unsupported',
    });
    const receipt = await execution;
    expect(receipt).toEqual({
      operationId: prepared.operationId,
      status: 'failed',
      error: 'unsupported',
    });
    expect(await f.service.navigate(f.grant.token, command)).toEqual(receipt);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('N1 expiration and backend replacement cannot remint a prepared operation', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song);
    f.advance(120001);
    await expect(
      f.service.navigate(f.grant.token, {
        ...song,
        operationId: prepared.operationId,
      }),
    ).rejects.toMatchObject({ code: 'expired_operation' });
    expect(f.calls).toHaveLength(0);
    const fresh = await f.service.prepare(f.grant.token, song);
    f.service.configure(f.config);
    // F2 R1: a replacement revision cannot expose even a retired receipt.
    await expect(
      f.service.navigate(f.grant.token, {
        ...song,
        operationId: fresh.operationId,
      }),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(f.calls).toHaveLength(0);
    const replacement = await f.store.issue(
      'Replacement',
      'rest',
      f.resource,
      ['playback.control'],
      () => true,
    );
    await expect(
      f.service.navigate(replacement.token, {
        ...song,
        operationId: fresh.operationId,
      }),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('N1 operation budgets admit 32 per principal and 128 global separately from cursors', async () => {
  const f = await operationFixture();
  try {
    const grants = [f.grant];
    for (let i = 1; i < 5; i++)
      grants.push(
        await f.store.issue(
          'Budget ' + i,
          'rest',
          f.resource,
          ['playback.control'],
          () => true,
        ),
      );
    for (let g = 0; g < 4; g++) {
      for (let i = 0; i < 32; i++)
        expect(await f.service.prepare(grants[g].token, song)).toMatchObject({
          status: 'pending',
        });
      await expect(
        f.service.prepare(grants[g].token, song),
      ).rejects.toMatchObject({ code: 'busy' });
    }
    await expect(
      f.service.prepare(grants[4].token, song),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(f.calls).toHaveLength(0);
    f.advance(120001);
    expect(await f.service.prepare(grants[4].token, song)).toMatchObject({
      status: 'pending',
    });
  } finally {
    await f.close();
  }
});

for (const mode of [
  'current-B',
  'current-ABA',
  'network-replaced',
  'api-replaced',
  'cancel',
  'deadline',
] as const)
  test(
    'N1 current radio rejects pre-effect ' +
      mode +
      ' within its single actor job',
    async () => {
      const f = await musicRendererFixture();
      const events: any[] = [];
      f.app.addEventListener('yt-navigate', (e: any) => events.push(e));
      try {
        f.setVideo('seedVideo03');
        const seed = seeds.find((s) => s.name === 'current-radio')!;
        const q = f.read(f.query(), {
          operation: 'navigate',
          command: seed.command,
          deadlineAt: Date.now() + (mode === 'deadline' ? 20 : 10000),
        });
        await f.flush();
        expect(f.fetches).toHaveLength(1);
        if (mode === 'current-B' || mode === 'current-ABA') {
          f.setVideo('other000001');
          f.videoEvent();
          if (mode === 'current-ABA') {
            f.setVideo('seedVideo03');
            f.videoEvent();
          }
        } else if (mode === 'network-replaced')
          f.app.networkManager = { fetch: () => Promise.resolve(seed.raw) };
        else if (mode === 'api-replaced') f.replaceApi();
        else if (mode === 'cancel')
          f.emit('peard:music-cancel', { ...q, phase: 'read' });
        else await new Promise((r) => setTimeout(r, 25));
        f.fetches[0].resolve(seed.raw);
        await f.flush();
        expect(events).toHaveLength(0);
        expect(f.result(q)).toEqual({
          ok: true,
          value: {
            version: 1,
            phase: 'pre_effect_denial',
            reason: mode === 'deadline' ? 'timeout' : 'retired',
          },
        });
      } finally {
        await f.close();
      }
    },
  );

test('N1 video radio cannot transplant a different service video into a bound seed', async () => {
  const f = await musicRendererFixture();
  const events: any[] = [];
  f.app.addEventListener('yt-navigate', (e: any) => events.push(e));
  try {
    const seed = seeds.find((s) => s.name === 'video-radio')!;
    const raw = JSON.parse(JSON.stringify(seed.raw));
    raw.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs[0].tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.contents[0].playlistPanelVideoRenderer.menu.menuRenderer.items[0].menuNavigationItemRenderer.navigationEndpoint.watchEndpoint.videoId =
      'other000001';
    const q = f.read(f.query(), {
      operation: 'navigate',
      command: seed.command,
      deadlineAt: Date.now() + 10000,
    });
    await f.flush();
    f.fetches[0].resolve(raw);
    await f.flush();
    expect(events).toHaveLength(0);
    expect(f.result(q)).toMatchObject({
      ok: true,
      value: { phase: 'pre_effect_denial', reason: 'unsupported' },
    });
  } finally {
    await f.close();
  }
});

test('N1 oversized provider envelope cannot bypass the native byte budget through a small recipe', async () => {
  const f = await musicRendererFixture();
  let dispatches = 0;
  f.app.addEventListener('yt-navigate', () => dispatches++);
  try {
    const seed = seeds.find((s) => s.name === 'shuffled-playlist')!,
      raw = JSON.parse(JSON.stringify(seed.raw));
    raw.unrelated = 'x'.repeat(1024 * 1024 + 1);
    const q = f.read(f.query(), {
      operation: 'navigate',
      command: seed.command,
      deadlineAt: Date.now() + 10000,
    });
    await f.flush();
    f.fetches[0].resolve(raw);
    await f.flush();
    expect(dispatches).toBe(0);
    expect(f.result(q)).toMatchObject({
      ok: true,
      value: { phase: 'pre_effect_denial', reason: 'budget' },
    });
  } finally {
    await f.close();
  }
});

test('N1 captured dispatch uses its exact receiver even when function call property is replaced', async () => {
  const f = await musicRendererFixture();
  const dispatch = f.app.dispatchEvent,
    descriptor = Object.getOwnPropertyDescriptor(dispatch, 'call');
  let events = 0;
  f.app.addEventListener('yt-navigate', () => events++);
  try {
    Object.defineProperty(dispatch, 'call', {
      value: () => true,
      configurable: true,
    });
    const q = f.read(f.query(), {
      operation: 'navigate',
      command: song,
      deadlineAt: Date.now() + 10000,
    });
    await f.flush();
    expect(events).toBe(1);
    expect(f.result(q)).toMatchObject({
      ok: true,
      value: { phase: 'owned_dispatch' },
    });
  } finally {
    if (descriptor) Object.defineProperty(dispatch, 'call', descriptor);
    else delete dispatch.call;
    await f.close();
  }
});

test('N1 global operation budget cannot be bypassed by a second backend window', async () => {
  const f = await operationFixture();
  let second: any;
  try {
    for (let g = 0; g < 4; g++) {
      const grant = await f.store.issue(
        'Global ' + g,
        'rest',
        f.resource,
        ['playback.control'],
        () => true,
      );
      for (let i = 0; i < 32; i++) await f.service.prepare(grant.token, song);
    }
    const other = await f.store.issue(
      'Second window',
      'rest',
      f.resource,
      ['playback.control'],
      () => true,
    );
    second = new f.service.constructor({
      window: {},
      config: f.config,
      grants: f.store,
      broker: f.broker,
      now: (f.service as any).now,
    });
    await expect(second.prepare(other.token, song)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(f.calls).toHaveLength(0);
  } finally {
    second?.stop();
    await f.close();
  }
});

test('N1 expired uncertain physical hold retains its budget until actual settlement', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      command = { ...song, operationId: prepared.operationId };
    const execution = f.service.navigate(f.grant.token, command);
    await until(() => f.calls.length === 1);
    f.calls[0].reject(Error('lost ACK'));
    const receipt = await execution;
    f.advance(120001);
    expect(
      await f.service.operation(f.grant.token, prepared.operationId),
    ).toEqual(receipt);
    expect(await f.service.navigate(f.grant.token, command)).toEqual(receipt);
    expect(f.calls).toHaveLength(1);
    for (let i = 0; i < 31; i++) await f.service.prepare(f.grant.token, song);
    await expect(f.service.prepare(f.grant.token, song)).rejects.toMatchObject({
      code: 'busy',
    });
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    expect(await f.service.prepare(f.grant.token, song)).toMatchObject({
      status: 'pending',
    });
    await expect(
      f.service.navigate(f.grant.token, command),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('N1 a different live window cannot execute or retire the original prepared command', async () => {
  const f = await operationFixture();
  let second: any;
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      command = { ...song, operationId: prepared.operationId };
    second = new f.service.constructor({
      window: {},
      config: f.config,
      grants: f.store,
      broker: f.broker,
      now: (f.service as any).now,
    });
    await expect(second.navigate(f.grant.token, command)).rejects.toMatchObject(
      { code: 'retired' },
    );
    expect(
      await f.service.operation(f.grant.token, prepared.operationId),
    ).toEqual(prepared);
    expect(f.calls).toHaveLength(0);
    const original = f.service.navigate(f.grant.token, command);
    await until(() => f.calls.length === 1);
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    f.calls[0].resolve({ version: 1, phase: 'owned_dispatch' });
    expect(await original).toMatchObject({ status: 'accepted' });
  } finally {
    second?.stop();
    await f.close();
  }
});

for (const mode of [
  'getter',
  'cycle',
  'depth',
  'unknown-endpoint',
  'ambiguous-role',
  'wrong-playlist',
  'shuffle-start',
] as const)
  test('N1 bounded recipe rejects ' + mode + ' without dispatch', async () => {
    const f = await musicRendererFixture();
    let dispatches = 0,
      getterCalls = 0;
    f.app.addEventListener('yt-navigate', () => dispatches++);
    try {
      const seed = seeds.find((s) => s.name === 'shuffled-playlist')!,
        raw = JSON.parse(JSON.stringify(seed.raw));
      let command: any = seed.command;
      if (mode === 'getter')
        Object.defineProperty(raw, 'trap', {
          enumerable: true,
          get() {
            getterCalls++;
            throw Error('Must never invoke provider getter');
          },
        });
      else if (mode === 'cycle') raw.self = raw;
      else if (mode === 'depth') {
        let next = raw;
        for (let i = 0; i < 33; i++) next = next.deep = {};
      } else if (mode === 'unknown-endpoint')
        raw.header.musicResponsiveHeaderRenderer.buttons[0].buttonRenderer.navigationEndpoint =
          { urlEndpoint: { url: 'https://example.invalid' } };
      else if (mode === 'ambiguous-role')
        raw.header.musicResponsiveHeaderRenderer.buttons.push(
          raw.header.musicResponsiveHeaderRenderer.buttons[0],
        );
      else if (mode === 'wrong-playlist')
        raw.header.musicResponsiveHeaderRenderer.buttons[0].buttonRenderer.navigationEndpoint.watchPlaylistEndpoint.playlistId =
          'PL_OtherPlaylist';
      else command = { ...seed.command, videoId: 'seedVideo01' };
      const q = f.read(f.query(), {
        operation: 'navigate',
        command,
        deadlineAt: Date.now() + 10000,
      });
      await f.flush();
      expect(f.fetches).toHaveLength(1);
      f.fetches[0].resolve(raw);
      await f.flush();
      expect(dispatches).toBe(0);
      expect(getterCalls).toBe(0);
      expect(f.result(q)).toMatchObject({
        ok: true,
        value: { phase: 'pre_effect_denial' },
      });
    } finally {
      await f.close();
    }
  });

test('N1 strict HTTP bodies reject client UUID issuance, action replacement and wrong scope before native work', async () => {
  const f = await musicHttpFixture();
  try {
    const grant = await f.store.issue(
        'N1 strict',
        'rest',
        f.service.resource,
        ['playback.control'],
        () => true,
      ),
      headers = { authorization: 'Bearer ' + grant.token };
    const supplied = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      JSON.stringify({
        ...song,
        operationId: '00000000-0000-4000-8000-000000000000',
      }),
      headers,
    );
    expect(supplied.status).toBe(400);
    const wrong = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      JSON.stringify(song),
      { authorization: 'Bearer ' + f.grant.token },
    );
    expect(wrong.status).toBe(403);
    const prepared = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      JSON.stringify(song),
      headers,
    );
    const body = {
      videoId: song.videoId,
      playlistId: song.playlistId,
      operationId: prepared.body.operationId,
    };
    expect(
      (
        await f.http(
          '/api/v1/music/play/song',
          'POST',
          JSON.stringify({ ...body, action: 'radio' }),
          headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.http('/api/v1/music/play/song', 'POST', JSON.stringify(body), {
          authorization: 'Bearer ' + f.grant.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.http(
          '/api/v1/music/operations/prepare',
          'POST',
          JSON.stringify({ ...song, transport: 'rest' }),
          headers,
        )
      ).status,
    ).toBe(400);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('N1 entry storage admits a bounded encoded scalar record and rejects 32KiB overflow before allocation', async () => {
  const { musicModuleSource } = await import('./helpers/api-music-source');
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-operations.ts',
  );
  const ledger = new m.MusicOperationLedger(Date.now),
    principal = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'é'.repeat(14000),
      transport: 'rest',
      resource: 'http://127.0.0.1:26538/api/v1/music',
      digest: 'f'.repeat(64),
      scopes: ['playback.control'],
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    };
  // Internal scalar storage policy is independent of the stricter issuer name limit.
  const binding = {
    principal,
    access: {
      transport: 'rest',
      resource: principal.resource,
      owner: { identity: {}, current: () => true },
    },
    resource: principal.resource,
    service: {},
    revision: 0,
    admission: { frame: {}, generation: 0 },
    current: () => true,
  };
  expect(ledger.prepare(song, binding)).toMatchObject({ status: 'pending' });
  expect(() =>
    ledger.prepare(song, {
      ...binding,
      principal: { ...principal, name: '💫'.repeat(9000) },
    }),
  ).toThrow('Music response budget exceeded.');
  for (let i = 1; i < 32; i++) ledger.prepare(song, binding);
  expect(() => ledger.prepare(song, binding)).toThrow('Music service is busy.');
});

// F2 R1: receipt access belongs to the original service and native admission in every phase.
for (const phase of [
  'pending',
  'executing',
  'accepted',
  'failed',
  'uncertain',
  'retired',
] as const)
  for (const context of [
    'foreign-window',
    'same-window-new-service',
    'frame-replaced',
    'generation-replaced',
  ] as const)
    test(
      'N1 F2 original receipt context ' + phase + ' / ' + context,
      async () => {
        const f = await operationFixture();
        let second: any, originalExecution: Promise<any> | undefined;
        try {
          const prepared = await f.service.prepare(f.grant.token, song),
            command = { ...song, operationId: prepared.operationId };
          const originalAdmission = f.broker.capture();
          const row = (f.service as any).operations.lookup(
            prepared.operationId,
            f.grant.record,
            f.access,
          );
          if (phase !== 'pending' && phase !== 'retired') {
            originalExecution = f.service.navigate(f.grant.token, command);
            await until(() => f.calls.length === 1);
            if (phase === 'uncertain') {
              f.calls[0].reject(Error('Lost original ACK'));
              await originalExecution;
            } else if (phase !== 'executing') {
              f.calls[0].options.onPhysicalSettled('authenticated_ack');
              f.calls[0].resolve(
                phase === 'failed'
                  ? {
                      version: 1,
                      phase: 'pre_effect_denial',
                      reason: 'unsupported',
                    }
                  : { version: 1, phase: 'owned_dispatch' },
              );
              await originalExecution;
            }
          }
          if (phase === 'retired') f.service.configure(f.config);
          const before = {
            receipt: { ...row.receipt },
            expires: row.expires,
            executing: row.executing,
            physicalHold: row.physicalHold,
            calls: f.calls.length,
          };
          let caller = f.service;
          if (
            context === 'foreign-window' ||
            context === 'same-window-new-service'
          ) {
            second = new f.service.constructor({
              window:
                context === 'foreign-window'
                  ? {}
                  : (f.service as any).runtime.window,
              config: f.config,
              grants: f.store,
              broker: f.broker,
              now: (f.service as any).now,
            });
            caller = second;
          } else
            f.broker.capture = () => ({
              ...originalAdmission,
              ...(context === 'frame-replaced'
                ? { frame: {} }
                : { generation: originalAdmission.generation + 1 }),
            });
          const status = await caller
            .operation(f.grant.token, prepared.operationId)
            .then(
              (receipt: any) => ({ receipt }),
              (error: any) => ({ error: error.code }),
            );
          const foreignExecution = caller.navigate(f.grant.token, command).then(
            (receipt: any) => ({ receipt }),
            (error: any) => ({ error: error.code }),
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect({
            receipt: row.receipt,
            expires: row.expires,
            executing: row.executing,
            physicalHold: row.physicalHold,
            calls: f.calls.length,
          }).toEqual(before);
          if (phase === 'executing') {
            f.calls[0].options.onPhysicalSettled('authenticated_ack');
            f.calls[0].resolve({ version: 1, phase: 'owned_dispatch' });
            await originalExecution;
          }
          const replay = await foreignExecution;
          expect(status).toEqual({ error: 'retired' });
          expect(replay).toEqual({ error: 'retired' });
          f.broker.capture = () => originalAdmission;
          if (phase !== 'retired') {
            const original = await f.service.operation(
              f.grant.token,
              prepared.operationId,
            );
            expect(original).toEqual(row.receipt);
            if (phase !== 'pending')
              expect(await f.service.navigate(f.grant.token, command)).toEqual(
                original,
              );
          }
          expect(f.calls.length).toBe(before.calls);
          if (phase === 'uncertain') {
            expect(row.physicalHold).toBe(true);
            f.calls[0].options.onPhysicalSettled('authenticated_ack');
            expect(row.receipt).toEqual(before.receipt);
          }
        } finally {
          second?.stop();
          await f.close();
        }
      },
    );

for (const phase of ['pending', 'accepted', 'uncertain'] as const)
  test(
    'N1 F2 revision replacement cannot expose ' +
      phase +
      ' receipt or release physical hold',
    async () => {
      const f = await operationFixture();
      try {
        const prepared = await f.service.prepare(f.grant.token, song),
          command = { ...song, operationId: prepared.operationId };
        const row = (f.service as any).operations.lookup(
          prepared.operationId,
          f.grant.record,
          f.access,
        );
        if (phase !== 'pending') {
          const original = f.service.navigate(f.grant.token, command);
          await until(() => f.calls.length === 1);
          if (phase === 'uncertain') f.calls[0].reject(Error('Lost ACK'));
          else {
            f.calls[0].options.onPhysicalSettled('authenticated_ack');
            f.calls[0].resolve({ version: 1, phase: 'owned_dispatch' });
          }
          await original;
        }
        f.service.configure(f.config);
        const before = {
          receipt: { ...row.receipt },
          expires: row.expires,
          physicalHold: row.physicalHold,
          calls: f.calls.length,
        };
        await expect(
          f.service.operation(f.grant.token, prepared.operationId),
        ).rejects.toMatchObject({ code: 'retired' });
        await expect(
          f.service.navigate(f.grant.token, command),
        ).rejects.toMatchObject({ code: 'retired' });
        expect({
          receipt: row.receipt,
          expires: row.expires,
          physicalHold: row.physicalHold,
          calls: f.calls.length,
        }).toEqual(before);
        if (phase === 'uncertain') {
          expect(row.physicalHold).toBe(true);
          f.calls[0].options.onPhysicalSettled('authenticated_ack');
          expect(row.receipt).toEqual(before.receipt);
        }
      } finally {
        await f.close();
      }
    },
  );

// F3 R1-E: a rejected context must preserve actual membership even after TTL.
for (const context of ['foreign-window', 'same-window-new-service'] as const)
  for (const route of ['status', 'execute'] as const)
    test('N1 F3 expired membership ' + context + ' / ' + route, async () => {
      const f = await operationFixture();
      let second: any;
      try {
        const prepared = await f.service.prepare(f.grant.token, song),
          ledger = (f.service as any).operations;
        const row = ledger.lookup(
          prepared.operationId,
          f.grant.record,
          f.access,
        );
        second = new f.service.constructor({
          window:
            context === 'foreign-window'
              ? {}
              : (f.service as any).runtime.window,
          config: f.config,
          grants: f.store,
          broker: f.broker,
          now: (f.service as any).now,
        });
        f.advance(120001);
        const snapshot = () => ({
          present: ledger.rows.has(row.id),
          receipt: { ...row.receipt },
          expires: row.expires,
          bytes: row.bytes,
          canonical: row.canonical,
          command: row.command,
          binding: row.binding,
          physicalHold: row.physicalHold,
          executing: row.executing,
          promise: row.promise,
          timer: ledger.timer,
          calls: f.calls.length,
        });
        const before = snapshot();
        await expect(
          route === 'status'
            ? second.operation(f.grant.token, row.id)
            : second.navigate(f.grant.token, { ...song, operationId: row.id }),
        ).rejects.toMatchObject({ code: 'retired' });
        expect(snapshot()).toEqual(before);
        await expect(
          f.service.operation(f.grant.token, row.id),
        ).rejects.toMatchObject({ code: 'expired_operation' });
        expect(ledger.rows.has(row.id)).toBe(false);
        expect(f.calls).toHaveLength(0);
      } finally {
        second?.stop();
        await f.close();
      }
    });

for (const route of ['status', 'execute'] as const)
  test(
    'N1 F3 original context retains ordinary expired ' + route + ' cleanup',
    async () => {
      const f = await operationFixture();
      try {
        const prepared = await f.service.prepare(f.grant.token, song),
          ledger = (f.service as any).operations;
        f.advance(120001);
        expect(ledger.rows.has(prepared.operationId)).toBe(true);
        await expect(
          route === 'status'
            ? f.service.operation(f.grant.token, prepared.operationId)
            : f.service.navigate(f.grant.token, {
                ...song,
                operationId: prepared.operationId,
              }),
        ).rejects.toMatchObject({ code: 'expired_operation' });
        expect(ledger.rows.has(prepared.operationId)).toBe(false);
        await expect(
          f.service.navigate(f.grant.token, {
            ...song,
            operationId: prepared.operationId,
          }),
        ).rejects.toMatchObject({ code: 'unknown_operation' });
        expect(f.calls).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );

test('N1 F3 independent TTL timer still removes eligible inactive membership without a request', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      ledger = (f.service as any).operations,
      timer = ledger.timer;
    expect(typeof timer._onTimeout).toBe('function');
    f.advance(120001);
    timer._onTimeout(); // Execute the actual bounded timer callback under the fixture clock.
    expect(ledger.rows.has(prepared.operationId)).toBe(false);
    expect(ledger.timer).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const route of ['status', 'execute'] as const)
  test(
    'N1 F3 expired active hold survives foreign ' +
      route +
      ' and independent timer cleanup',
    async () => {
      const f = await operationFixture();
      let second: any;
      try {
        const prepared = await f.service.prepare(f.grant.token, song),
          command = { ...song, operationId: prepared.operationId },
          ledger = (f.service as any).operations;
        const row = ledger.lookup(
            prepared.operationId,
            f.grant.record,
            f.access,
          ),
          original = f.service.navigate(f.grant.token, command);
        await until(() => f.calls.length === 1);
        f.calls[0].reject(Error('Lost original ACK'));
        const uncertain = await original;
        await f.service.prepare(f.grant.token, song);
        const timer = ledger.timer;
        second = new f.service.constructor({
          window: {},
          config: f.config,
          grants: f.store,
          broker: f.broker,
          now: (f.service as any).now,
        });
        f.advance(120001);
        const promise = row.promise,
          expires = row.expires;
        await expect(
          route === 'status'
            ? second.operation(f.grant.token, row.id)
            : second.navigate(f.grant.token, command),
        ).rejects.toMatchObject({ code: 'retired' });
        expect(ledger.rows.has(row.id)).toBe(true);
        expect(row.physicalHold).toBe(true);
        expect(row.promise).toBe(promise);
        expect(row.expires).toBe(expires);
        expect(row.receipt).toEqual(uncertain);
        timer._onTimeout();
        expect(ledger.rows.has(row.id)).toBe(true);
        expect(row.physicalHold).toBe(true);
        expect(await f.service.operation(f.grant.token, row.id)).toEqual(
          uncertain,
        );
        expect(await f.service.navigate(f.grant.token, command)).toEqual(
          uncertain,
        );
        expect(f.calls).toHaveLength(1);
        f.calls[0].options.onPhysicalSettled('authenticated_ack');
        expect(ledger.rows.has(row.id)).toBe(false);
        expect(row.receipt).toEqual(uncertain);
        await expect(
          f.service.navigate(f.grant.token, command),
        ).rejects.toMatchObject({ code: 'unknown_operation' });
        expect(f.calls).toHaveLength(1);
      } finally {
        second?.stop();
        await f.close();
      }
    },
  );

test('N1 F3 principal digest transport resource identity precedes the main-only context callback', async () => {
  const f = await operationFixture();
  try {
    const prepared = await f.service.prepare(f.grant.token, song),
      ledger = (f.service as any).operations;
    f.advance(120001);
    let validations = 0;
    const validate = () => {
      validations++;
      throw Error('Context rejection');
    };
    for (const patch of [
      { id: '00000000-0000-4000-8000-000000000000' },
      { digest: '0'.repeat(64) },
      { transport: 'mcp' },
    ])
      expect(() =>
        ledger.lookup(
          prepared.operationId,
          { ...f.grant.record, ...patch },
          f.access,
          validate,
        ),
      ).toThrow('Music operation history is unavailable.');
    expect(() =>
      ledger.lookup(
        prepared.operationId,
        f.grant.record,
        { ...f.access, resource: 'http://localhost:26538/api/v1/music' },
        validate,
      ),
    ).toThrow('Music operation history is unavailable.');
    expect(validations).toBe(0);
    expect(ledger.rows.has(prepared.operationId)).toBe(true);
    expect(() =>
      ledger.lookup(prepared.operationId, f.grant.record, f.access, validate),
    ).toThrow('Context rejection');
    expect(validations).toBe(1);
    expect(ledger.rows.has(prepared.operationId)).toBe(true);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});
