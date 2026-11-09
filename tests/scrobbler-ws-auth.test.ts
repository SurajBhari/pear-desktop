import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

import { test, expect } from '@playwright/test';

const dataUrl = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function fixture(timing = { pollMs: 1, deadlineMs: 1000 }) {
  const read = async (file: string) =>
    stripTypeScriptTypes(
      await readFile(
        new URL(`../src/plugins/scrobbler/services/${file}`, import.meta.url),
        'utf8',
      ),
    );
  const clientUrl = dataUrl(await read('ws-client.ts'));
  const m = await import(
    dataUrl(
      (await read('ws-auth.ts')).replace(
        /from ['"]\.\/ws-client['"]/g,
        `from '${clientUrl}'`,
      ),
    )
  );
  const calls = [];
  const surfaces = [];
  const writes = [];
  let current = true;
  let authorized = true;
  let delay;
  let ready;
  let persistence: Promise<void> | undefined;
  const fetcher = async (url, options) => {
    const parameters =
      options.method === 'GET'
        ? new URL(url).searchParams
        : new URLSearchParams(options.body);
    const method = parameters.get('method');
    calls.push({ method, options, url });
    if (method === 'auth.getToken')
      return new Response('{"token":"dummy-token"}');
    if (delay) await delay;
    return new Response(
      authorized ? '{"session":{"key":"dummy-new-session"}}' : '{"error":14}',
    );
  };
  const open = (url, signal) => {
    const closed = deferred();
    const surface = {
      url,
      signal,
      ready: ready ?? Promise.resolve(),
      closed: closed.promise,
      closes: 0,
      close() {
        this.closes++;
        closed.resolve();
      },
    };
    surfaces.push(surface);
    return surface;
  };
  const controller = new m.WsAuthController(fetcher, open, timing);
  const account = {
    apiRoot: 'https://service.invalid/2.0/',
    apiKey: 'dummy-key',
    secret: 'dummy-secret',
    authRoot: 'https://www.last.fm/api/auth/',
  };
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  return {
    controller,
    account,
    calls,
    surfaces,
    writes,
    flush,
    login: () =>
      controller.login(
        account,
        (key) => {
          writes.push(key);
          return persistence;
        },
        () => current,
      ),
    setCurrent: (value) => {
      current = value;
    },
    setAuthorized: (value) => {
      authorized = value;
    },
    setDelay: (promise) => {
      delay = promise;
    },
    setReady: (promise) => {
      ready = promise;
    },
    setPersistence: (promise: Promise<void>) => {
      persistence = promise;
    },
    stop: () => controller.stop(),
    deferred,
  };
}

test('duplicate login shares one nonblocking promise and only the session response completes', async () => {
  const f = await fixture();
  const wait = f.deferred();
  f.setDelay(wait.promise);
  try {
    const first = f.login();
    const second = f.login();
    expect(second).toBe(first);
    await f.flush();
    expect(f.surfaces.length).toBe(1);
    expect(f.writes).toEqual([]);
    expect(new URL(f.surfaces[0].url).searchParams.get('token')).toBe(
      'dummy-token',
    );
    wait.resolve();
    expect(await first).toBe(true);
    expect(f.writes).toEqual(['dummy-new-session']);
    expect(f.surfaces[0].closes).toBe(1);
  } finally {
    wait.resolve();
    f.stop();
  }
});
test('closing auth while the service awaits settles without changing the session', async () => {
  const f = await fixture();
  const wait = f.deferred();
  f.setDelay(wait.promise);
  try {
    const pending = f.login();
    await f.flush();
    expect(f.surfaces.length).toBe(1);
    f.surfaces[0].close();
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
  } finally {
    wait.resolve();
    f.stop();
  }
});
for (const cause of ['stop', 'owner change'])
  test(`late service success after ${cause} cannot persist`, async () => {
    const f = await fixture();
    const wait = f.deferred();
    f.setDelay(wait.promise);
    try {
      const pending = f.login();
      await f.flush();
      expect(f.surfaces.length).toBe(1);
      if (cause === 'stop') f.stop();
      else f.setCurrent(false);
      wait.resolve();
      expect(await pending).toBe(false);
      expect(f.writes).toEqual([]);
      expect(f.surfaces[0].signal.aborted).toBe(true);
    } finally {
      wait.resolve();
      f.stop();
    }
  });
test('deadline retires unauthorized polling and closing/retirement does not create another window', async () => {
  const f = await fixture({ pollMs: 1, deadlineMs: 25 });
  f.setAuthorized(false);
  try {
    expect(await f.login()).toBe(false);
    expect(f.surfaces.length).toBe(1);
    expect(f.writes).toEqual([]);
    expect(f.surfaces[0].closes).toBe(1);
    f.stop();
    expect(await f.login()).toBe(false);
    expect(f.surfaces.length).toBe(1);
  } finally {
    f.stop();
  }
});
test('failed navigation and retired parent settle a still-loading window', async () => {
  const f = await fixture();
  const loading = f.deferred();
  f.setReady(loading.promise);
  try {
    const pending = f.login();
    await f.flush();
    expect(f.surfaces.length).toBe(1);
    loading.reject(new Error('private-url-error'));
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.surfaces[0].closes).toBe(1);
  } finally {
    f.stop();
  }
});
test('owner already retired cannot request a token or open authentication', async () => {
  const f = await fixture();
  f.setCurrent(false);
  try {
    expect(await f.login()).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.surfaces).toEqual([]);
  } finally {
    f.stop();
  }
});

for (const cause of ['stop', 'close', 'deadline'])
  test(`an admitted persistence wait settles after ${cause} and its late completion cannot revive login`, async () => {
    const f = await fixture({
      pollMs: 1,
      deadlineMs: cause === 'deadline' ? 100 : 1000,
    });
    const wait = f.deferred();
    f.setPersistence(wait.promise);
    try {
      const pending = f.login();
      await f.flush();
      expect(f.writes).toEqual(['dummy-new-session']);
      if (cause === 'stop') f.stop();
      if (cause === 'close') f.surfaces[0].close();
      const result = await Promise.race([
        pending.then((value) => ({ settled: true, value })),
        new Promise((resolve) =>
          setTimeout(() => resolve({ settled: false }), 300),
        ),
      ]);
      expect(result).toEqual({ settled: true, value: false });
      expect(f.surfaces[0].signal.aborted).toBe(true);
      const closes = f.surfaces[0].closes;
      wait.resolve();
      await f.flush();
      expect(f.surfaces[0].closes).toBe(closes);
      expect(f.writes).toEqual(['dummy-new-session']);
    } finally {
      wait.resolve();
      f.stop();
    }
  });

test('admission snapshots the original signing tuple across caller mutation', async () => {
  const f = await fixture();
  try {
    const pending = f.login();
    f.account.apiRoot = 'https://changed.invalid/2.0/';
    f.account.apiKey = 'dummy-changed-key';
    expect(await pending).toBe(true);
    for (const call of f.calls) {
      expect(new URL(call.url).origin).toBe('https://service.invalid');
      expect(new URL(call.url).searchParams.get('api_key')).toBe('dummy-key');
    }
    expect(new URL(f.surfaces[0].url).searchParams.get('api_key')).toBe(
      'dummy-key',
    );
  } finally {
    f.stop();
  }
});
test('an unavailable ownership predicate settles false without network or synchronous exception', async () => {
  const f = await fixture();
  try {
    await expect(
      f.controller.login(
        f.account,
        () => {},
        () => {
          throw Error('dummy ownership failure');
        },
      ),
    ).resolves.toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.surfaces).toEqual([]);
  } finally {
    f.stop();
  }
});

test('unsupported and mutable auth endpoints retire before token or surface admission', async () => {
  for (const kind of [
    'array',
    'boxed',
    'coercible',
    'mutated array',
    'overlong',
  ]) {
    const f = await fixture();
    const original = f.account.authRoot;
    const array = [original];
    const value =
      kind === 'boxed'
        ? new String(original)
        : kind === 'coercible'
          ? { toString: () => original }
          : kind === 'overlong'
            ? original + ' '.repeat(4097)
            : array;
    Object.assign(f.account, { authRoot: value });
    try {
      const pending = f.login();
      array[0] = 'https://libre.fm/api/auth/';
      expect(await pending).toBe(false);
      expect(f.calls).toEqual([]);
      expect(f.surfaces).toEqual([]);
    } finally {
      f.stop();
    }
  }
});

test('an ownership callback cannot admit persistence after it synchronously stops the controller', async () => {
  const f = await fixture();
  try {
    const pending = f.controller.login(
      f.account,
      (key) => {
        f.writes.push(key);
      },
      () => {
        if (f.calls.some((call) => call.method === 'auth.getSession')) f.stop();
        return true;
      },
    );
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
  } finally {
    f.stop();
  }
});
