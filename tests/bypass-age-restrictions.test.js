import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';

const vendorPath = new URL(
  '../src/plugins/bypass-age-restrictions/vendor/bypass.js',
  import.meta.url,
);
const mediaUrl =
  'https://rr1.googlevideo.com/videoplayback?id=fixture-media&gcr=us';
const authHeaders = {
  Authorization: 'fixture-google-token',
  Cookie: 'fixture-cookie',
  'X-Goog-AuthUser': 'fixture-account',
  'X-Origin': 'https://music.youtube.com',
  Range: 'bytes=0-100',
};
const blocked = {
  videoDetails: { videoId: 'fixture-video' },
  playabilityStatus: { status: 'LOGIN_REQUIRED' },
};
const unlocked = {
  videoDetails: { videoId: 'fixture-video' },
  playabilityStatus: { status: 'OK' },
  streamingData: { adaptiveFormats: [{ url: mediaUrl }] },
};

async function createRealm({
  loggedIn = false,
  youtubeResponse = blocked,
} = {}) {
  const dom = new Window({
    url: 'https://music.youtube.com/watch?v=fixture-video',
  });
  const requests = [];
  const realm = vm.createContext({
    document: dom.document,
    location: dom.location,
    localStorage: dom.localStorage,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    console: { info() {}, error() {} },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    dispatchEvent() {},
    ytcfg: {
      get: (key) =>
        ({
          LOGGED_IN: loggedIn,
          STS: 12345,
          INNERTUBE_API_KEY: 'fixture-key',
          INNERTUBE_CLIENT_NAME: 'WEB_REMIX',
          INNERTUBE_CLIENT_VERSION: 'fixture-version',
          INNERTUBE_CONTEXT: { client: {} },
          HL: 'en',
          PLAYER_VARS: { video_id: 'fixture-video' },
        })[key],
    },
    recordXhr(request) {
      requests.push(request);
      return JSON.stringify(
        new URL(request.url).hostname === 'youtube-proxy.zerody.one'
          ? unlocked
          : youtubeResponse,
      );
    },
    fetch: async (input, options) => {
      const request =
        input instanceof Request
          ? new Request(input, options)
          : new Request(input, options);
      requests.push({
        transport: 'fetch',
        url: request.url,
        headers: Object.fromEntries(request.headers),
        credentials: request.credentials,
      });
      return new Response('{}');
    },
  });
  vm.runInContext(
    `
    window = globalThis;
    self = globalThis;
    XMLHttpRequest = class {
      #credentialFlag = false;
      #state = 0;
      get withCredentials() { return this.#credentialFlag; }
      set withCredentials(value) {
        if (this.#state !== 0 && this.#state !== 1) throw new Error('InvalidStateError');
        this.#credentialFlag = Boolean(value);
      }
      headers = {};
      open(method, url) { this.#state = 1; this.headers = {}; this.method = method; this.url = new URL(url, location.href).href; }
      setRequestHeader(name, value) { this.headers[name] = value; }
      send(body) {
        this.responseText = recordXhr({ transport: 'xhr', url: this.url, method: this.method, headers: { ...this.headers }, credentials: this.#credentialFlag, body });
        this.#state = 4;
      }
    };
  `,
    realm,
  );
  const source = await readFile(vendorPath, 'utf8');
  const { iife } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const inject = () => {
    // Mirrors Electron's serialization into world 0, rather than calling in preload.
    vm.runInContext(`(${iife.toString()})(true)`, realm);
    vm.runInContext(
      `for (const symbol of Object.getOwnPropertySymbols(window)) {
      if (window[symbol]?.ENABLE_UNLOCK_NOTIFICATION !== undefined) window[symbol].ENABLE_UNLOCK_NOTIFICATION = false;
    }`,
      realm,
    );
  };
  return { realm, requests, inject, close: () => dom.happyDOM.close() };
}

let fixture;
test('fetch rejects invalid request options asynchronously as native fetch does', async () => {
  fixture = await createRealm();
  fixture.inject();
  let result;
  expect(() => {
    result = vm.runInContext(
      `fetch('https://music.youtube.com/youtubei/v1/player', { method: 'GET', body: 'invalid-body' })`,
      fixture.realm,
    );
  }).not.toThrow();
  expect(typeof result?.then).toBe('function');
  const outcome = await Promise.resolve(result).then(
    () => ({ rejected: false, message: '' }),
    (error) => ({ rejected: true, message: String(error) }),
  );
  expect(outcome.rejected).toBe(true);
  expect(outcome.message).toMatch(/body/i);
});
test.afterEach(async () => {
  if (fixture?.requests.length) {
    await test.info().attach('fixture-transport-requests', {
      body: Buffer.from(JSON.stringify(fixture.requests, null, 2)),
      contentType: 'application/json',
    });
  }
  await fixture?.close();
  fixture = undefined;
});

function run(source) {
  return vm.runInContext(source, fixture.realm);
}
function primeProxy() {
  fixture.realm.blockedJson = JSON.stringify(blocked);
  run('JSON.parse(blockedJson)');
  fixture.requests.length = 0;
}
function assertNoCredentials(request) {
  expect(request.credentials).toBe(
    request.transport === 'xhr' ? false : 'omit',
  );
  const headerNames = Object.keys(request.headers).map((name) =>
    name.toLowerCase(),
  );
  expect(
    headerNames.some((name) =>
      /^(authorization|cookie|cookie2|proxy-authorization|x-goog-.*|x-origin)$/.test(
        name,
      ),
    ),
  ).toBe(false);
}

test('patches only the serialized main realm and is idempotent', async () => {
  fixture = await createRealm();
  const isolatedParse = JSON.parse;
  fixture.inject();
  const firstParse = run('JSON.parse');
  const firstRequest = run('Request');
  const firstOpen = run('XMLHttpRequest.prototype.open');
  fixture.inject();
  expect(run('JSON.parse')).toBe(firstParse);
  expect(run('Request')).toBe(firstRequest);
  expect(run('XMLHttpRequest.prototype.open')).toBe(firstOpen);
  expect(JSON.parse).toBe(isolatedParse);
  expect(run('typeof process')).toBe('undefined');
  expect(run('typeof require')).toBe('undefined');
});

test('raw restricted player response tries YouTube then account proxy without Google credentials', async () => {
  fixture = await createRealm({ loggedIn: true });
  fixture.inject();
  fixture.realm.authHeaders = authHeaders;
  run(
    `const auth = new XMLHttpRequest(); auth.open('POST', '/youtubei/v1/player'); for (const [name,value] of Object.entries(authHeaders)) auth.setRequestHeader(name,value); auth.send('{}');`,
  );
  fixture.requests.length = 0;
  fixture.realm.blockedJson = JSON.stringify(blocked);
  const response = run('JSON.parse(blockedJson)');
  expect(response.playabilityStatus.status).toBe('OK');
  expect(response.unlocked).toBe(true);
  const firstParty = fixture.requests.filter(
    (r) => new URL(r.url).hostname === 'music.youtube.com',
  );
  expect(
    firstParty.some(
      (r) => r.headers.Authorization === authHeaders.Authorization,
    ),
  ).toBe(true);
  const proxy = fixture.requests.find(
    (r) => new URL(r.url).hostname === 'youtube-proxy.zerody.one',
  );
  expect(new URL(proxy.url).searchParams.get('videoId')).toBe('fixture-video');
  expect(proxy.url).not.toContain('fixture-google-token');
  assertNoCredentials(proxy);
});

test('media proxy XHR excludes explicit auth headers and cookies, case insensitively', async () => {
  fixture = await createRealm();
  fixture.inject();
  primeProxy();
  fixture.realm.mediaUrl = mediaUrl;
  fixture.realm.authHeaders = {
    ...authHeaders,
    authorization: 'lowercase-token',
    'x-goog-authuser': 'lowercase-account',
  };
  run(
    `const media = new XMLHttpRequest(); media.open('GET', mediaUrl); media.withCredentials = true; for (const [name,value] of Object.entries(authHeaders)) media.setRequestHeader(name,value); media.send(null);`,
  );
  const request = fixture.requests[0];
  expect(new URL(request.url).hostname).toBe('ny.4everproxy.com');
  expect(request.headers.Range).toBe('bytes=0-100');
  assertNoCredentials(request);
});

for (const headerKind of ['object', 'Headers', 'tuples']) {
  test(`media proxy Request strips Google headers supplied as ${headerKind}`, async () => {
    fixture = await createRealm();
    fixture.inject();
    primeProxy();
    fixture.realm.mediaUrl = mediaUrl;
    fixture.realm.authHeaders = authHeaders;
    const expression =
      headerKind === 'Headers'
        ? 'new Headers(authHeaders)'
        : headerKind === 'tuples'
          ? 'Object.entries(authHeaders)'
          : 'authHeaders';
    const request = run(
      `new Request(mediaUrl, { credentials: 'include', headers: ${expression} })`,
    );
    expect(new URL(request.url).hostname).toBe('ny.4everproxy.com');
    assertNoCredentials({
      transport: 'fetch',
      credentials: request.credentials,
      headers: Object.fromEntries(request.headers),
    });
  });
}

test('raw fetch and Request input honor the same media proxy credential boundary', async () => {
  fixture = await createRealm();
  fixture.inject();
  primeProxy();
  fixture.realm.mediaUrl = mediaUrl;
  fixture.realm.authHeaders = authHeaders;
  await run(
    `fetch(mediaUrl, { credentials: 'include', headers: authHeaders })`,
  );
  await run(
    `fetch(new Request(mediaUrl, { credentials: 'include', headers: authHeaders }))`,
  );
  expect(fixture.requests).toHaveLength(2);
  for (const request of fixture.requests) {
    expect(new URL(request.url).hostname).toBe('ny.4everproxy.com');
    assertNoCredentials(request);
  }
});

test('account proxy transport cannot inherit explicit Google authentication', async () => {
  fixture = await createRealm();
  fixture.inject();
  fixture.realm.authHeaders = authHeaders;
  run(
    `const account = new XMLHttpRequest(); account.open('GET', 'https://youtube-proxy.zerody.one/getPlayer?videoId=fixture-video'); account.withCredentials = true; for (const [name,value] of Object.entries(authHeaders)) account.setRequestHeader(name,value); account.send(null);`,
  );
  assertNoCredentials(fixture.requests[0]);
});

test('proxy Request sanitization does not mutate or trust frozen caller options', async () => {
  fixture = await createRealm();
  fixture.inject();
  primeProxy();
  fixture.realm.mediaUrl = mediaUrl;
  fixture.realm.authHeaders = authHeaders;
  const request = run(
    `new Request(mediaUrl, Object.freeze({ credentials: 'include', headers: Object.freeze({ ...authHeaders }) }))`,
  );
  assertNoCredentials({
    transport: 'fetch',
    credentials: request.credentials,
    headers: Object.fromEntries(request.headers),
  });
});

test('reusing a proxy XHR for YouTube restores first-party credentials and headers', async () => {
  fixture = await createRealm();
  fixture.inject();
  primeProxy();
  fixture.realm.mediaUrl = mediaUrl;
  run(`const reused = new XMLHttpRequest(); reused.open('GET', mediaUrl); reused.withCredentials = true; reused.setRequestHeader('Authorization', 'fixture-token'); reused.send(null);
    reused.open('POST', '/youtubei/v1/player'); reused.withCredentials = true; reused.setRequestHeader('Authorization', 'fixture-token'); reused.send('{}');`);
  assertNoCredentials(fixture.requests[0]);
  expect(fixture.requests[1].credentials).toBe(true);
  expect(fixture.requests[1].headers.Authorization).toBe('fixture-token');
});

test('unrestricted raw responses remain unchanged and search thumbnails are restored', async () => {
  fixture = await createRealm();
  fixture.inject();
  fixture.realm.unlockedJson = JSON.stringify(unlocked);
  expect(JSON.stringify(run('JSON.parse(unlockedJson)'))).toBe(
    JSON.stringify(unlocked),
  );
  expect(fixture.requests).toHaveLength(0);
  const blurredUrl = `https://i.ytimg.com/vi/fixture-video/hqdefault.jpg?sqp=${'a'.repeat(32)}`;
  fixture.realm.searchJson = JSON.stringify({
    contents: {
      twoColumnSearchResultsRenderer: {
        thumbnails: [{ url: blurredUrl, height: 90 }],
      },
    },
  });
  expect(
    run('JSON.parse(searchJson)').contents.twoColumnSearchResultsRenderer
      .thumbnails[0].url,
  ).toBe(blurredUrl.split('?')[0]);
});

test('initial player assignment and embedded preview responses retain upstream unlocking behavior', async () => {
  fixture = await createRealm();
  fixture.inject();
  const initial =
    run(`const initialHolder = {}; initialHolder.playerResponse = {
    videoDetails: { videoId: 'fixture-video' }, playabilityStatus: { status: 'LOGIN_REQUIRED' }
  }; initialHolder.playerResponse;`);
  expect(initial.playabilityStatus.status).toBe('OK');
  fixture.realm.previewJson = JSON.stringify({
    videoDetails: { videoId: 'fixture-video' },
    previewPlayabilityStatus: { status: 'LOGIN_REQUIRED' },
  });
  expect(run('JSON.parse(previewJson)').previewPlayabilityStatus.status).toBe(
    'OK',
  );
});

test('repeated raw player responses reuse the upstream response cache', async () => {
  fixture = await createRealm();
  fixture.inject();
  fixture.realm.blockedJson = JSON.stringify(blocked);
  expect(run('JSON.parse(blockedJson)').playabilityStatus.status).toBe('OK');
  const requestCount = fixture.requests.length;
  expect(requestCount).toBeGreaterThan(0);
  expect(run('JSON.parse(blockedJson)').playabilityStatus.status).toBe('OK');
  expect(fixture.requests).toHaveLength(requestCount);
});

test('proxy XHR clears the native credential flag set before open', async () => {
  fixture = await createRealm();
  fixture.inject();
  run(`const precredentialed = new XMLHttpRequest(); precredentialed.withCredentials = true;
    precredentialed.open('GET', 'https://youtube-proxy.zerody.one/getPlayer?videoId=fixture-video');
    precredentialed.send(null);`);
  assertNoCredentials(fixture.requests[0]);
});

test('first-party reopen retains the original native credential preference after proxy use', async () => {
  fixture = await createRealm();
  fixture.inject();
  run(`const credentialPreference = new XMLHttpRequest(); credentialPreference.withCredentials = true;
    credentialPreference.open('GET', 'https://youtube-proxy.zerody.one/getPlayer?videoId=fixture-video');
    credentialPreference.send(null);
    credentialPreference.open('GET', 'https://youtube-proxy.zerody.one/getPlayer?videoId=fixture-video');
    credentialPreference.send(null);
    credentialPreference.open('POST', '/youtubei/v1/player'); credentialPreference.send('{}');`);
  assertNoCredentials(fixture.requests[0]);
  assertNoCredentials(fixture.requests[1]);
  expect(fixture.requests[2].credentials).toBe(true);
});

test('reusing a completed credentialed first-party XHR for the media proxy clears its native slot', async () => {
  fixture = await createRealm();
  fixture.inject();
  primeProxy();
  fixture.realm.mediaUrl = mediaUrl;
  run(`const reusedFromFirstParty = new XMLHttpRequest();
    reusedFromFirstParty.open('POST', '/youtubei/v1/player');
    reusedFromFirstParty.withCredentials = true;
    reusedFromFirstParty.send('{}');
    reusedFromFirstParty.open('GET', mediaUrl);
    reusedFromFirstParty.send(null);`);
  expect(fixture.requests[0].credentials).toBe(true);
  assertNoCredentials(fixture.requests[1]);
});

test('plugin is opt-in and injects synchronously through the main-world bridge', async () => {
  fixture = await createRealm();
  const calls = [];
  const key = `ageBridge_${crypto.randomUUID()}`;
  globalThis[key] = {
    executeInMainWorld({ func, args }) {
      calls.push(args);
      vm.runInContext(
        `(${func.toString()})(...${JSON.stringify(args)})`,
        fixture.realm,
      );
    },
  };
  const dataUrl = (value) =>
    `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
  try {
    const vendorUrl = dataUrl(await readFile(vendorPath, 'utf8'));
    const source = stripTypeScriptTypes(
      await readFile(
        new URL(
          '../src/plugins/bypass-age-restrictions/index.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    )
      .replace(
        "'electron'",
        JSON.stringify(
          dataUrl(
            `export const contextBridge = globalThis[${JSON.stringify(key)}];`,
          ),
        ),
      )
      .replace(
        "'@/i18n'",
        JSON.stringify(dataUrl('export const t = key => key;')),
      )
      .replace(
        "'@/utils'",
        JSON.stringify(
          dataUrl('export const createPlugin = plugin => plugin;'),
        ),
      )
      .replace("'./vendor/bypass.js'", JSON.stringify(vendorUrl));
    const { default: plugin } = await import(dataUrl(source));
    expect(plugin.config.enabled).toBe(false);
    expect(plugin.restartNeeded).toBe(true);
    const before = run('JSON.parse');
    expect(plugin.preload()).toBeUndefined();
    expect(calls).toEqual([[true]]);
    expect(run('JSON.parse')).not.toBe(before);
  } finally {
    delete globalThis[key];
  }
});
