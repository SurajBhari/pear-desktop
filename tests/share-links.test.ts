import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

import { test, expect } from '@playwright/test';

const music =
  'https://music.youtube.com/watch?v=DYj8OTx_rLQ&list=PL_test&si=token#t=4';
const video = music.replace('music.youtube.com', 'youtube.com');
async function source() {
  const read = async (path: string) =>
    stripTypeScriptTypes(
      await readFile(new URL(path, import.meta.url), 'utf8'),
    );
  const helper = (await read('../src/utils/share-url.ts')).replace(
    /^export /gm,
    '',
  );
  const controller = (await read('../src/providers/share-links.ts'))
    .replace(/^import[^;]+;\n/gm, '')
    .replace(/^export /gm, '');
  return `${helper}\n${controller}\nwindow.shareFixture={setupShareLinks,stripMusicFromShareUrl};`;
}
async function fixture(page: import('@playwright/test').Page) {
  await page.setContent(
    `<yt-copy-link-renderer><input id="share-url"><button id="copy">Copy</button></yt-copy-link-renderer><input id="other">`,
  );
  await page.addScriptTag({ content: await source() });
  await page.evaluate((music) => {
    const w = window as any;
    const input = document.querySelector<HTMLInputElement>('#share-url')!;
    input.value = music;
    w.toggleShare = w.shareFixture.setupShareLinks(document);
    document.querySelector('#copy')!.addEventListener('click', () => {
      w.copied = input.value;
    });
  }, music);
}
test('only the exact music host is rewritten with complete query and fragment semantics', async ({
  page,
}) => {
  await fixture(page);
  expect(
    await page.evaluate(
      (music) => (window as any).shareFixture.stripMusicFromShareUrl(music),
      music,
    ),
  ).toBe(video);
  for (const other of [
    'https://music.youtube.com.evil/watch?v=x',
    'https://user:secret@music.youtube.com/watch?v=x',
    'file:///music.youtube.com',
    'not a URL',
  ])
    expect(
      await page.evaluate(
        (other) => (window as any).shareFixture.stripMusicFromShareUrl(other),
        other,
      ),
    ).toBe(other);
});
test('default-disabled share field is untouched; enabled Copy reads rewritten URL and stop restores', async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator('#share-url')).toHaveValue(music);
  await page.evaluate(() => (window as any).toggleShare(true));
  await page.locator('#copy').click();
  expect(await page.evaluate(() => (window as any).copied)).toBe(video);
  await page.evaluate(() => (window as any).toggleShare(false));
  await expect(page.locator('#share-url')).toHaveValue(music);
});
test('reused share field accepts property and attribute updates without rewriting unrelated inputs', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).toggleShare(true);
  });
  const second = 'https://music.youtube.com/watch?v=NewVideo123&si=new';
  await page.evaluate((second) => {
    document.querySelector<HTMLInputElement>('#share-url')!.value = second;
    document.querySelector<HTMLInputElement>('#other')!.value = second;
  }, second);
  await expect(page.locator('#share-url')).toHaveValue(
    second.replace('music.', ''),
  );
  await expect(page.locator('#other')).toHaveValue(second);
  const third = 'https://music.youtube.com/playlist?list=PL_other';
  await page.evaluate(
    (third) =>
      document.querySelector('#share-url')!.setAttribute('value', third),
    third,
  );
  await expect(page.locator('#share-url')).toHaveValue(
    third.replace('music.', ''),
  );
});
test('late and detached fields are scoped and teardown preserves newer external descriptors', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).toggleShare(true);
  });
  await page.evaluate((music) => {
    const node = document.createElement('input');
    node.id = 'share-url';
    node.value = music;
    document.querySelector('yt-copy-link-renderer')!.replaceChildren(node);
  }, music);
  await expect(page.locator('#share-url')).toHaveValue(video);
  await page.evaluate(() => {
    const node = document.querySelector<HTMLInputElement>('#share-url')!;
    Object.defineProperty(node, 'value', {
      configurable: true,
      get: () => 'external-owned',
      set: () => {},
    });
    (window as any).toggleShare(false);
  });
  // Playwright locators read DOM values from their isolated utility world.
  // Own JS descriptors belong to the website's main world, as does Copy.
  expect(
    await page.evaluate(
      () => document.querySelector<HTMLInputElement>('#share-url')!.value,
    ),
  ).toBe('external-owned');
});

test('detached field keeps a synchronous website write before observer teardown', async ({
  page,
}) => {
  await fixture(page);
  const next = 'https://music.youtube.com/watch?v=OtherVideo1';
  const value = await page.evaluate((next) => {
    (window as any).toggleShare(true);
    const node = document.querySelector<HTMLInputElement>('#share-url')!;
    node.remove();
    node.value = next;
    return node.value;
  }, next);
  expect(value).toBe(next);
});

test('new external descriptor owns subsequent attribute writes', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).toggleShare(true);
    const node = document.querySelector<HTMLInputElement>('#share-url')!;
    Object.defineProperty(node, 'value', {
      configurable: true,
      get: () => 'external-owned',
      set: () => {},
    });
    node.setAttribute('value', 'https://music.youtube.com/watch?v=OtherVideo1');
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );
  const native = await page.evaluate(() => {
    const node = document.querySelector<HTMLInputElement>('#share-url')!;
    return Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.get!.call(node);
  });
  expect(native).toBe(video);
});

for (const move of ['detach', 'change-id'] as const) {
  test(`explicit equal-value website write survives ${move} before observer restore`, async ({
    page,
  }) => {
    await fixture(page);
    await page.evaluate(
      ({ move, video }) => {
        (window as any).toggleShare(true);
        const input = document.querySelector<HTMLInputElement>('#share-url')!;
        (window as any).savedField = input;
        if (move === 'detach') input.remove();
        else input.id = 'unrelated-field';
        input.value = video;
      },
      { move, video },
    );
    await page.evaluate(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    );
    expect(await page.evaluate(() => (window as any).savedField.value)).toBe(
      video,
    );
  });
}

test('stopping an untransformed attribute-backed field preserves subsequent native attribute updates', async ({
  page,
}) => {
  const initial = 'https://youtube.com/watch?v=OwnedVideo01';
  const next = 'https://youtube.com/watch?v=OwnedVideo02';
  await page.setContent(
    `<yt-copy-link-renderer><input id="share-url" value="${initial}"></yt-copy-link-renderer><input id="baseline" value="${initial}">`,
  );
  await page.addScriptTag({ content: await source() });
  await page.evaluate(() => {
    const toggle = (window as any).shareFixture.setupShareLinks(document);
    toggle(true);
    toggle(false);
  });
  await page.evaluate((next) => {
    document.querySelector('#share-url')!.setAttribute('value', next);
    document.querySelector('#baseline')!.setAttribute('value', next);
  }, next);
  await expect(page.locator('#baseline')).toHaveValue(next);
  await expect(page.locator('#share-url')).toHaveValue(next);
});

async function attributeFixture(
  page: import('@playwright/test').Page,
  type = '',
) {
  await page.setContent(
    `<yt-copy-link-renderer><input id="share-url" ${type ? `type="${type}"` : ''} value="${music}" name="owned" readonly></yt-copy-link-renderer><input id="baseline" ${type ? `type="${type}"` : ''} value="${music}">`,
  );
  await page.addScriptTag({ content: await source() });
  await page.evaluate(() => {
    (window as any).toggleShare = (window as any).shareFixture.setupShareLinks(
      document,
    );
  });
}

test('transformed attribute-backed field retains native attribute updates after disable', async ({
  page,
}) => {
  await attributeFixture(page);
  const next = 'https://music.youtube.com/watch?v=NextVideo12';
  const result = await page.evaluate((next) => {
    const input = document.querySelector<HTMLInputElement>('#share-url')!,
      baseline = document.querySelector<HTMLInputElement>('#baseline')!;
    (window as any).toggleShare(true);
    const enabled = input.value;
    (window as any).toggleShare(false);
    const restored = input.value;
    input.setAttribute('value', next);
    baseline.setAttribute('value', next);
    return {
      enabled,
      restored,
      current: input.value,
      baseline: baseline.value,
      owned: Object.hasOwn(input, 'value'),
    };
  }, next);
  expect(result).toEqual({
    enabled: video,
    restored: music,
    current: next,
    baseline: next,
    owned: false,
  });
});

test('an initially dirty same-value field retains native dirty state after disable', async ({
  page,
}) => {
  await attributeFixture(page);
  const result = await page.evaluate((music) => {
    const input = document.querySelector<HTMLInputElement>('#share-url')!,
      baseline = document.querySelector<HTMLInputElement>('#baseline')!;
    input.value = music;
    baseline.value = music;
    (window as any).toggleShare(true);
    (window as any).toggleShare(false);
    input.setAttribute('value', 'next');
    baseline.setAttribute('value', 'next');
    return { current: input.value, baseline: baseline.value };
  }, music);
  expect(result).toEqual({ current: music, baseline: music });
});

for (const value of [music, video])
  test(`explicit site property assignment remains dirty-authoritative for ${value.includes('music.') ? 'music' : 'equal rewritten'} URL`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const result = await page.evaluate((value) => {
      const input = document.querySelector<HTMLInputElement>('#share-url')!,
        baseline = document.querySelector<HTMLInputElement>('#baseline')!;
      (window as any).toggleShare(true);
      input.value = value;
      baseline.value = value;
      (window as any).toggleShare(false);
      input.setAttribute('value', 'next');
      baseline.setAttribute('value', 'next');
      return { current: input.value, baseline: baseline.value };
    }, value);
    expect(result).toEqual({ current: value, baseline: value });
  });

for (const last of ['attribute', 'property'])
  test(`pending site updates preserve ${last}-last ordering at immediate disable`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const attribute = 'https://music.youtube.com/watch?v=Attribute12',
      property = 'https://music.youtube.com/watch?v=Property123';
    const result = await page.evaluate(
      ({ attribute, property, last }) => {
        const input = document.querySelector<HTMLInputElement>('#share-url')!;
        (window as any).toggleShare(true);
        if (last === 'attribute') input.setAttribute('value', attribute);
        else {
          input.setAttribute('value', attribute);
          input.value = property;
        }
        (window as any).toggleShare(false);
        const restored = input.value;
        input.setAttribute('value', 'later');
        return { restored, after: input.value };
      },
      { attribute, property, last },
    );
    expect(result).toEqual(
      last === 'attribute'
        ? { restored: attribute, after: 'later' }
        : { restored: property, after: property },
    );
  });

for (const type of ['', 'search', 'url', 'tel', 'password', 'email'])
  test(`rewrite and native restoration preserve ${type || 'implicit text'} attrs, focus, selection and listeners`, async ({
    page,
  }) => {
    await attributeFixture(page, type);
    const result = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#share-url')!;
      const identity = input;
      const events: string[] = [];
      for (const name of ['input', 'change', 'focus', 'blur'])
        input.addEventListener(name, () => events.push(name));
      input.focus();
      if (input.selectionStart !== null)
        input.setSelectionRange(3, 9, 'backward');
      events.length = 0;
      const before = {
        attrs: [...input.attributes].map((a) => [a.name, a.value]),
        selection: [
          input.selectionStart,
          input.selectionEnd,
          input.selectionDirection,
        ],
      };
      (window as any).toggleShare(true);
      const activeSelection = [
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ];
      (window as any).toggleShare(false);
      const after = {
        attrs: [...input.attributes].map((a) => [a.name, a.value]),
        selection: [
          input.selectionStart,
          input.selectionEnd,
          input.selectionDirection,
        ],
        focused: document.activeElement === input,
        identity: input === identity,
        defaultValue: input.defaultValue,
        events: [...events],
      };
      input.dispatchEvent(new Event('change'));
      return {
        before,
        activeSelection,
        after,
        retainedListener: events.at(-1),
      };
    });
    expect(result.activeSelection).toEqual(result.before.selection);
    expect(result.after.attrs).toEqual(result.before.attrs);
    expect(result.after.selection).toEqual(result.before.selection);
    expect(result.after.focused).toBe(true);
    expect(result.after.identity).toBe(true);
    expect(result.after.defaultValue).toBe(music);
    expect(result.after.events).toEqual([]);
    expect(result.retainedListener).toBe('change');
  });

for (const type of ['hidden', 'checkbox', 'radio', 'button'])
  test(`non-text ${type} field remains native and untouched`, async ({
    page,
  }) => {
    await attributeFixture(page, type);
    const result = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#share-url')!;
      const before = {
        value: input.value,
        attrs: [...input.attributes].map((a) => [a.name, a.value]),
      };
      (window as any).toggleShare(true);
      const active = input.value;
      (window as any).toggleShare(false);
      return {
        before,
        active,
        after: {
          value: input.value,
          attrs: [...input.attributes].map((a) => [a.name, a.value]),
        },
        owned: Object.hasOwn(input, 'value'),
      };
    });
    expect(result.active).toBe(music);
    expect(result.after).toEqual(result.before);
    expect(result.owned).toBe(false);
  });

test('an explicit input edit stays authoritative through disable', async ({
  page,
}) => {
  await attributeFixture(page);
  const result = await page.evaluate((video) => {
    const input = document.querySelector<HTMLInputElement>('#share-url')!;
    (window as any).toggleShare(true);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, video);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (window as any).toggleShare(false);
    input.setAttribute('value', 'next');
    return input.value;
  }, video);
  expect(result).toBe(video);
});

test('pending older attribute records cannot overwrite a newer input edit', async ({
  page,
}) => {
  await attributeFixture(page);
  const result = await page.evaluate((video) => {
    const input = document.querySelector<HTMLInputElement>('#share-url')!;
    (window as any).toggleShare(true);
    input.setAttribute(
      'value',
      'https://music.youtube.com/watch?v=OlderAttr12',
    );
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, video);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (window as any).toggleShare(false);
    return input.value;
  }, video);
  expect(result).toBe(video);
});

test('a newer foreign descriptor installed during restoration owns subsequent native state', async ({
  page,
}) => {
  await attributeFixture(page);
  const latest = 'https://music.youtube.com/watch?v=NewOwner123';
  const result = await page.evaluate(
    ({ music, latest }) => {
      const input = document.querySelector<HTMLInputElement>('#share-url')!;
      const native = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!;
      const foreignGet = () => native.get!.call(input),
        foreignSet = (value: string) => native.set!.call(input, value);
      let armed = false;
      Object.defineProperty(input, 'value', {
        configurable: true,
        get: () => native.get!.call(input),
        set: (value: string) => {
          native.set!.call(input, value);
          if (armed && value === music) {
            native.set!.call(input, latest);
            Object.defineProperty(input, 'value', {
              configurable: true,
              get: foreignGet,
              set: foreignSet,
            });
          }
        },
      });
      (window as any).toggleShare(true);
      armed = true;
      (window as any).toggleShare(false);
      const descriptor = Object.getOwnPropertyDescriptor(input, 'value')!;
      return {
        value: input.value,
        foreign: descriptor.get === foreignGet && descriptor.set === foreignSet,
      };
    },
    { music, latest },
  );
  expect(result).toEqual({ value: latest, foreign: true });
});

for (const equal of [false, true])
  test(`a reentrant ${equal ? 'equal' : 'new'} site property write during restoration remains dirty-authoritative`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const latest = equal
      ? music
      : 'https://music.youtube.com/watch?v=Reentrant12';
    const result = await page.evaluate(
      ({ music, latest }) => {
        const input = document.querySelector<HTMLInputElement>('#share-url')!;
        const native = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!;
        let armed = false,
          nested = false;
        const get = () => native.get!.call(input),
          set = (value: string) => {
            native.set!.call(input, value);
            if (armed && !nested && value === music) {
              nested = true;
              input.value = latest;
              nested = false;
            }
          };
        Object.defineProperty(input, 'value', { configurable: true, get, set });
        (window as any).toggleShare(true);
        armed = true;
        (window as any).toggleShare(false);
        const restored = input.value;
        input.setAttribute('value', 'later');
        const own = Object.getOwnPropertyDescriptor(input, 'value')!;
        return {
          restored,
          after: input.value,
          previous: own.get === get && own.set === set,
        };
      },
      { music, latest },
    );
    expect(result).toEqual({ restored: latest, after: latest, previous: true });
  });

for (const stage of ['capture', 'rewrite'])
  test(`a foreign descriptor installed by the ${stage} getter remains authoritative`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const latest = 'https://music.youtube.com/watch?v=GetterOwner1';
    const result = await page.evaluate(
      ({ stage, latest }) => {
        const input = document.querySelector<HTMLInputElement>('#share-url')!;
        const native = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!;
        const foreignGet = () => native.get!.call(input),
          foreignSet = (value: string) => native.set!.call(input, value);
        let reads = 0;
        Object.defineProperty(input, 'value', {
          configurable: true,
          get: () => {
            const before = native.get!.call(input);
            if (++reads === (stage === 'capture' ? 1 : 2)) {
              native.set!.call(input, latest);
              Object.defineProperty(input, 'value', {
                configurable: true,
                get: foreignGet,
                set: foreignSet,
              });
            }
            return before;
          },
          set: foreignSet,
        });
        (window as any).toggleShare(true);
        (window as any).toggleShare(false);
        const own = Object.getOwnPropertyDescriptor(input, 'value')!;
        return {
          value: input.value,
          foreign: own.get === foreignGet && own.set === foreignSet,
        };
      },
      { stage, latest },
    );
    expect(result).toEqual({ value: latest, foreign: true });
  });

for (const selection of ['all', 'end'])
  test(`a ${selection} URL selection retains its intent across rewrite and native restoration`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const result = await page.evaluate((selection) => {
      const input = document.querySelector<HTMLInputElement>('#share-url')!;
      input.focus();
      input.setSelectionRange(
        selection === 'all' ? 0 : input.value.length,
        input.value.length,
      );
      (window as any).toggleShare(true);
      const active = {
        length: input.value.length,
        start: input.selectionStart,
        end: input.selectionEnd,
      };
      (window as any).toggleShare(false);
      return {
        active,
        stopped: {
          length: input.value.length,
          start: input.selectionStart,
          end: input.selectionEnd,
        },
      };
    }, selection);
    for (const state of [result.active, result.stopped]) {
      expect(state.start).toBe(selection === 'all' ? 0 : state.length);
      expect(state.end).toBe(state.length);
    }
  });

for (const retirement of ['disable', 'detach'] as const)
  for (const equal of [false, true])
    test(`an in-flight ${equal ? 'equal' : 'new'} site assignment survives synchronous ${retirement} cleanup`, async ({
      page,
    }) => {
      await attributeFixture(page);
      const latest = equal ? video : 'https://youtube.com/watch?v=InFlight123';
      const result = await page.evaluate(
        ({ latest, retirement }) => {
          const w = window as any;
          const input = document.querySelector<HTMLInputElement>('#share-url')!;
          const other = document.createElement('input');
          other.id = 'share-url';
          input.parentElement!.append(other);
          const native = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )!;
          let armed = false;
          const get = () => native.get!.call(input);
          const set = (value: string) => {
            native.set!.call(input, value);
            if (armed) {
              if (retirement === 'disable') w.toggleShare(false);
              else {
                input.remove();
                other.value = 'https://music.youtube.com/watch?v=OtherFlight';
              }
            }
          };
          const previous = { configurable: true, enumerable: true, get, set };
          Object.defineProperty(input, 'value', previous);
          w.toggleShare(true);
          armed = true;
          input.value = latest;
          const before = input.value;
          input.defaultValue = 'later';
          const own = Object.getOwnPropertyDescriptor(input, 'value')!;
          w.toggleShare(false);
          return {
            before,
            after: input.value,
            previous:
              own.get === get &&
              own.set === set &&
              own.enumerable &&
              own.configurable,
          };
        },
        { latest, retirement },
      );
      expect(result).toEqual({ before: latest, after: latest, previous: true });
    });

for (const writes of [false, true])
  test(`a throwing in-flight previous setter ${writes ? 'with' : 'without'} native side effects preserves current state on cleanup`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const result = await page.evaluate(
      ({ video, writes }) => {
        const w = window as any;
        const input = document.querySelector<HTMLInputElement>('#share-url')!;
        const native = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!;
        const failure = new Error('site setter failed');
        let armed = false,
          attempts = 0;
        const get = () => native.get!.call(input);
        const set = (value: string) => {
          if (!armed) native.set!.call(input, value);
          else {
            attempts++;
            if (writes) native.set!.call(input, value);
            w.toggleShare(false);
            throw failure;
          }
        };
        Object.defineProperty(input, 'value', { configurable: true, get, set });
        w.toggleShare(true);
        armed = true;
        let sameError = false;
        try {
          input.value = video;
        } catch (error) {
          sameError = error === failure;
        }
        const before = input.value;
        input.defaultValue = 'later';
        const own = Object.getOwnPropertyDescriptor(input, 'value')!;
        return {
          sameError,
          attempts,
          before,
          after: input.value,
          previous: own.get === get && own.set === set,
        };
      },
      { video, writes },
    );
    expect(result).toEqual({
      sameError: true,
      attempts: 1,
      before: video,
      after: video,
      previous: true,
    });
  });

test('a foreign descriptor installed during an in-flight site setter stays authoritative through cleanup', async ({
  page,
}) => {
  await attributeFixture(page);
  const latest = 'https://music.youtube.com/watch?v=ForeignFlight';
  const result = await page.evaluate((latest) => {
    const w = window as any;
    const input = document.querySelector<HTMLInputElement>('#share-url')!;
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!;
    const foreignGet = () => native.get!.call(input),
      foreignSet = (value: string) => native.set!.call(input, value);
    let armed = false;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: foreignGet,
      set: (value: string) => {
        native.set!.call(input, value);
        if (armed) {
          native.set!.call(input, latest);
          Object.defineProperty(input, 'value', {
            configurable: true,
            get: foreignGet,
            set: foreignSet,
          });
          w.toggleShare(false);
        }
      },
    });
    w.toggleShare(true);
    armed = true;
    input.value = latest;
    const before = input.value;
    input.defaultValue = 'later';
    const own = Object.getOwnPropertyDescriptor(input, 'value')!;
    return {
      before,
      after: input.value,
      foreign: own.get === foreignGet && own.set === foreignSet,
    };
  }, latest);
  expect(result).toEqual({ before: latest, after: latest, foreign: true });
});

test('synchronous disable and reenable inside a site setter does not retain an obsolete descriptor', async ({
  page,
}) => {
  await attributeFixture(page);
  const result = await page.evaluate((video) => {
    const w = window as any;
    const input = document.querySelector<HTMLInputElement>('#share-url')!;
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!;
    let armed = false;
    const get = () => native.get!.call(input);
    const set = (value: string) => {
      native.set!.call(input, value);
      if (armed) {
        armed = false;
        w.toggleShare(false);
        w.toggleShare(true);
      }
    };
    Object.defineProperty(input, 'value', { configurable: true, get, set });
    w.toggleShare(true);
    armed = true;
    input.value = video;
    w.toggleShare(false);
    const before = input.value;
    input.defaultValue = 'later';
    const own = Object.getOwnPropertyDescriptor(input, 'value')!;
    return {
      before,
      after: input.value,
      previous: own.get === get && own.set === set,
    };
  }, video);
  expect(result).toEqual({ before: video, after: video, previous: true });
});
for (const mode of ['property', 'attribute'] as const)
  test(`adopted widget releases original-document lease and preserves ${mode} writes`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const next = 'https://music.youtube.com/watch?v=BBBBBBBBBBB';
    await page.evaluate(
      ({ mode, next }) => {
        const w = window as any;
        const input = document.querySelector<HTMLInputElement>('#share-url')!;
        const foreign = document.implementation.createHTMLDocument('foreign');
        w.toggleShare(true);
        foreign.body.append(foreign.adoptNode(input.parentElement!));
        w.movedInput = input;
        if (mode === 'property') input.value = next;
      },
      { mode, next },
    );
    await page.evaluate(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    );
    const state = await page.evaluate(
      ({ mode, next }) => {
        const input = (window as any).movedInput as HTMLInputElement;
        if (mode === 'attribute') input.defaultValue = next;
        return {
          value: input.value,
          ownDescriptor:
            Object.getOwnPropertyDescriptor(input, 'value') !== undefined,
          ownerChanged: input.ownerDocument !== document,
        };
      },
      { mode, next },
    );
    expect(state).toEqual({
      value: next,
      ownDescriptor: false,
      ownerChanged: true,
    });
  });
for (const destination of ['foreign', 'detached'] as const)
  test(`queued added widget already ${destination} is never admitted`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const state = await page.evaluate(async (destination) => {
      const w = window as any;
      w.toggleShare(true);
      const renderer = document.createElement('yt-copy-link-renderer');
      renderer.innerHTML =
        '<input type="text" id="share-url" value="https://music.youtube.com/watch?v=CCCCCCCCCCC">';
      document.body.append(renderer);
      const input = renderer.querySelector<HTMLInputElement>('input')!;
      if (destination === 'foreign') {
        const other = document.implementation.createHTMLDocument('other');
        other.body.append(other.adoptNode(renderer));
      } else renderer.remove();
      await new Promise<void>((r) => setTimeout(r, 0));
      return {
        value: input.value,
        ownDescriptor:
          Object.getOwnPropertyDescriptor(input, 'value') !== undefined,
      };
    }, destination);
    expect(state).toEqual({
      value: 'https://music.youtube.com/watch?v=CCCCCCCCCCC',
      ownDescriptor: false,
    });
  });
test('previous getter leaving document during admission retains its exact descriptor', async ({
  page,
}) => {
  await attributeFixture(page);
  const state = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#share-url')!,
      renderer = input.parentElement!,
      foreign = document.implementation.createHTMLDocument('foreign');
    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!;
    const get = function (this: HTMLInputElement) {
      foreign.body.append(foreign.adoptNode(renderer));
      return native.get!.call(this);
    };
    const set = function (this: HTMLInputElement, value: string) {
      native.set!.call(this, value);
    };
    const before = input.value;
    Object.defineProperty(input, 'value', {
      configurable: true,
      enumerable: true,
      get,
      set,
    });
    (window as any).toggleShare(true);
    return {
      value: input.value,
      previousGetter:
        Object.getOwnPropertyDescriptor(input, 'value')!.get === get,
      before,
    };
  });
  expect(state.value).toBe(state.before);
  expect(state.previousGetter).toBe(true);
});
for (const mode of [
  'first-hidden',
  'second-foreign',
  'second-detached',
  'second-role',
  'second-hidden',
] as const)
  test(`initial getter ${mode} relinquishes only this lease`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const state = await page.evaluate(async (mode) => {
      const input = document.querySelector<HTMLInputElement>('#share-url')!,
        renderer = input.parentElement!,
        other = document.implementation.createHTMLDocument('foreign');
      const native = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!;
      const before = native.get!.call(input);
      let reads = 0;
      const get = function (this: HTMLInputElement) {
        if (++reads === (mode === 'first-hidden' ? 1 : 2)) {
          if (mode.endsWith('hidden')) input.type = 'hidden';
          else if (mode === 'second-foreign')
            other.body.append(other.adoptNode(renderer));
          else if (mode === 'second-detached') renderer.remove();
          else input.id = 'ordinary-field';
        }
        return native.get!.call(this);
      };
      const set = function (this: HTMLInputElement, value: string) {
        native.set!.call(this, value);
      };
      Object.defineProperty(input, 'value', {
        get,
        set,
        configurable: true,
        enumerable: true,
      });
      (window as any).toggleShare(true);
      await new Promise<void>((r) => setTimeout(r, 0));
      const descriptor = Object.getOwnPropertyDescriptor(input, 'value')!;
      return {
        before,
        value: native.get!.call(input),
        previousGet: descriptor.get === get,
        previousSet: descriptor.set === set,
      };
    }, mode);
    expect(state.value).toBe(state.before);
    expect(state.previousGet).toBe(true);
    expect(state.previousSet).toBe(true);
  });
test('initial rewrite getter ownership loss does not prevent rewriting after return', async ({
  page,
}) => {
  await attributeFixture(page);
  const next = 'https://music.youtube.com/watch?v=BBBBBBBBBBB';
  const state = await page.evaluate(async (next) => {
    const input = document.querySelector<HTMLInputElement>('#share-url')!,
      renderer = input.parentElement!,
      other = document.implementation.createHTMLDocument('foreign'),
      native = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!;
    let reads = 0;
    const get = function (this: HTMLInputElement) {
      if (++reads === 2) other.body.append(other.adoptNode(renderer));
      return native.get!.call(this);
    };
    const set = function (this: HTMLInputElement, value: string) {
      native.set!.call(this, value);
    };
    Object.defineProperty(input, 'value', {
      get,
      set,
      configurable: true,
      enumerable: true,
    });
    (window as any).toggleShare(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    input.defaultValue = next;
    document.body.append(document.adoptNode(renderer));
    await new Promise<void>((r) => setTimeout(r, 0));
    return input.value;
  }, next);
  expect(state).toBe(next.replace('music.youtube.com', 'youtube.com'));
});
test('initial hidden mode returning to text receives active rewrite', async ({
  page,
}) => {
  await attributeFixture(page);
  const state = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('#share-url')!,
      native = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!;
    const before = input.value;
    let reads = 0;
    const get = function (this: HTMLInputElement) {
      if (++reads === 1) input.type = 'hidden';
      return native.get!.call(this);
    };
    const set = function (this: HTMLInputElement, value: string) {
      native.set!.call(this, value);
    };
    Object.defineProperty(input, 'value', {
      get,
      set,
      configurable: true,
      enumerable: true,
    });
    (window as any).toggleShare(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    input.type = 'text';
    await new Promise<void>((r) => setTimeout(r, 0));
    return { before, value: input.value };
  });
  expect(state.value).toBe(
    state.before.replace('music.youtube.com', 'youtube.com'),
  );
});

for (const mode of [
  'rewrite-reenable',
  'record-retirement-reenable',
  'exact-retirement-reenable',
] as const)
  test(`retirement ${mode} preserves current generation and native authority`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const next = 'https://music.youtube.com/watch?v=BBBBBBBBBBB';
    const state = await page.evaluate(
      async ({ mode, next }) => {
        const input = document.querySelector<HTMLInputElement>('#share-url')!,
          renderer = input.parentElement!,
          foreign = document.implementation.createHTMLDocument('foreign'),
          native = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )!;
        const before = native.get!.call(input) as string;
        let reads = 0,
          armed = false,
          update!: (enabled: boolean) => void;
        const get = function (this: HTMLInputElement) {
          reads++;
          if (mode === 'rewrite-reenable' && reads === 2) {
            update(false);
            update(true);
          }
          if (mode === 'record-retirement-reenable' && armed) {
            armed = false;
            document.body.append(renderer);
            update(false);
            update(true);
          }
          if (mode === 'exact-retirement-reenable') {
            if (reads === 2) foreign.body.append(foreign.adoptNode(renderer));
            if (reads === 3) {
              document.body.append(document.adoptNode(renderer));
              update(false);
              update(true);
            }
          }
          return native.get!.call(this) as string;
        };
        const set = function (this: HTMLInputElement, value: string) {
          native.set!.call(this, value);
        };
        Object.defineProperty(input, 'value', {
          get,
          set,
          configurable: true,
          enumerable: true,
        });
        update = (window as any).shareFixture.setupShareLinks(document);
        update(true);
        if (mode === 'record-retirement-reenable') {
          armed = true;
          renderer.remove();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const active = input.value;
        update(false);
        const descriptor = Object.getOwnPropertyDescriptor(input, 'value')!;
        const off = input.value;
        input.defaultValue = next;
        return {
          before,
          active,
          off,
          after: input.value,
          previousGet: descriptor.get === get,
          previousSet: descriptor.set === set,
        };
      },
      { mode, next },
    );
    expect(state.active).toBe(
      state.before.replace('music.youtube.com', 'youtube.com'),
    );
    expect(state.off).toBe(state.before);
    expect(state.after).toBe(next);
    expect(state.previousGet).toBe(true);
    expect(state.previousSet).toBe(true);
  });

for (const mode of [
  'success',
  'throw',
  'side-effect-throw',
  'foreign-owner',
] as const)
  test(`native coercion ${mode} keeps native authority across a new generation`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const next = 'https://music.youtube.com/watch?v=BBBBBBBBBBB';
    const later = 'https://music.youtube.com/watch?v=CCCCCCCCCCC';
    const state = await page.evaluate(
      ({ mode, next, later }) => {
        const input = document.querySelector<HTMLInputElement>('#share-url')!,
          native = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )!;
        const before = native.get!.call(input) as string;
        const update = (window as any).shareFixture.setupShareLinks(
          document,
        ) as (enabled: boolean) => void;
        update(true);
        // Snapshot the actual native handover state, including its dirty flag.
        // DOM cloning does not copy the provider's own accessor.
        const reference = input.cloneNode(false) as HTMLInputElement;
        reference.removeAttribute('id');
        document.body.append(reference);
        let foreignGet: ((this: HTMLInputElement) => string) | undefined;
        const assign = (
          target: HTMLInputElement,
          control: (enabled: boolean) => void,
        ) => {
          let error: { name: string; message: string } | undefined;
          try {
            (target as any).value = {
              toString() {
                control(false);
                control(true);
                if (mode === 'foreign-owner') {
                  const get = function (this: HTMLInputElement) {
                    return native.get!.call(this) as string;
                  };
                  const set = function (this: HTMLInputElement, value: string) {
                    native.set!.call(this, value);
                  };
                  Object.defineProperty(target, 'value', {
                    get,
                    set,
                    configurable: false,
                    enumerable: true,
                  });
                  if (target === input) foreignGet = get;
                }
                if (mode === 'side-effect-throw')
                  native.set!.call(target, next);
                if (mode.includes('throw'))
                  throw new TypeError('owned coercion failure');
                return next;
              },
            };
          } catch (failure) {
            error = {
              name: (failure as Error).name,
              message: (failure as Error).message,
            };
          }
          return error;
        };
        const error = assign(input, update),
          referenceError = assign(reference, () => {});
        const active = input.value;
        update(false);
        const off = input.value;
        input.defaultValue = reference.defaultValue = later;
        return {
          before,
          active,
          off,
          after: input.value,
          referenceAfter: reference.value,
          error,
          referenceError,
          previous:
            mode === 'foreign-owner'
              ? Object.getOwnPropertyDescriptor(input, 'value')!.get ===
                foreignGet
              : Object.getOwnPropertyDescriptor(input, 'value') === undefined,
        };
      },
      { mode, next, later },
    );
    expect(state.error).toEqual(state.referenceError);
    expect(state.after).toBe(state.referenceAfter);
    expect(state.previous).toBe(true);
    expect(state.active).toBe(
      mode === 'foreign-owner'
        ? next
        : (mode === 'throw' ? state.before : next).replace(
            'music.youtube.com',
            'youtube.com',
          ),
    );
  });

for (const mode of ['toggle', 'record'] as const)
  test(`a throwing ${mode} retirement getter cannot strand its or another field's lease`, async ({
    page,
  }) => {
    await attributeFixture(page);
    const later = 'https://music.youtube.com/watch?v=CCCCCCCCCCC';
    const state = await page.evaluate(
      async ({ mode, later }) => {
        const first = document.querySelector<HTMLInputElement>('#share-url')!,
          renderer = first.parentElement!,
          secondRenderer = document.createElement('yt-copy-link-renderer'),
          second = document.createElement('input'),
          native = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )!;
        second.id = 'share-url';
        second.defaultValue = 'https://music.youtube.com/watch?v=BBBBBBBBBBB';
        secondRenderer.append(second);
        document.body.append(secondRenderer);
        let armed = false,
          sameError = false;
        const failure = new TypeError('retirement getter failed');
        const get = function (this: HTMLInputElement) {
          if (armed) throw failure;
          return native.get!.call(this) as string;
        };
        const set = function (this: HTMLInputElement, value: string) {
          native.set!.call(this, value);
        };
        Object.defineProperty(first, 'value', {
          get,
          set,
          configurable: true,
          enumerable: true,
        });
        const update = (window as any).shareFixture.setupShareLinks(document);
        update(true);
        armed = true;
        if (mode === 'toggle') {
          try {
            update(false);
          } catch (error) {
            sameError = error === failure;
          }
        } else {
          window.addEventListener(
            'error',
            (event) => {
              if (event.error === failure) {
                sameError = true;
                event.preventDefault();
              }
            },
            { once: true },
          );
          renderer.remove();
          secondRenderer.remove();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        const descriptor = Object.getOwnPropertyDescriptor(first, 'value')!;
        second.defaultValue = later;
        return {
          sameError,
          previousGet: descriptor.get === get,
          previousSet: descriptor.set === set,
          secondOwn:
            Object.getOwnPropertyDescriptor(second, 'value') !== undefined,
          second: second.value,
        };
      },
      { mode, later },
    );
    expect(state).toEqual({
      sameError: true,
      previousGet: true,
      previousSet: true,
      secondOwn: false,
      second: later,
    });
  });

test('a primary site setter or native coercion error survives throwing deferred retirement', async ({
  page,
}) => {
  const states = [];
  for (const mode of [
    'setter',
    'coercion',
    'setter-undefined',
    'coercion-null',
  ] as const) {
    await page.setContent(
      '<yt-copy-link-renderer><input id="share-url" type="text" value="https://music.youtube.com/watch?v=AAAAAAAAAAA"></yt-copy-link-renderer><yt-copy-link-renderer><input id="share-url" type="text" value="https://music.youtube.com/watch?v=DDDDDDDDDDD"></yt-copy-link-renderer>',
    );
    await page.addScriptTag({ content: await source() });
    states.push(
      await page.evaluate((mode) => {
        const [input, sibling] = [
          ...document.querySelectorAll<HTMLInputElement>('input'),
        ];
        const native = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!;
        const next = 'https://music.youtube.com/watch?v=BBBBBBBBBBB';
        const later = 'https://music.youtube.com/watch?v=CCCCCCCCCCC';
        const primary =
          mode === 'setter-undefined'
            ? undefined
            : mode === 'coercion-null'
              ? null
              : new TypeError('primary-' + mode);
        const cleanup = new Error('retirement-getter-error');
        let armed = false,
          failGetter = false,
          attempts = 0,
          coercions = 0;
        let update: (enabled: boolean) => void;
        const get = function (this: HTMLInputElement) {
          if (failGetter) throw cleanup;
          return native.get!.call(this) as string;
        };
        const set = function (this: HTMLInputElement, value: string) {
          const active = armed;
          if (active) {
            attempts++;
            armed = false;
          }
          native.set!.call(this, value);
          if (active && mode.startsWith('setter')) {
            update(false);
            failGetter = true;
            throw primary;
          }
        };
        Object.defineProperty(input, 'value', {
          get,
          set,
          configurable: true,
          enumerable: true,
        });
        update = (window as any).shareFixture.setupShareLinks(document);
        update(true);
        armed = true;
        let caught: unknown,
          didThrow = false;
        try {
          (input as any).value = mode.startsWith('setter')
            ? next
            : {
                toString() {
                  coercions++;
                  native.set!.call(input, next);
                  update(false);
                  failGetter = true;
                  throw primary;
                },
              };
        } catch (error) {
          caught = error;
          didThrow = true;
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, 'value')!;
        const after = native.get!.call(input) as string;
        input.defaultValue = sibling.defaultValue = later;
        const afterDefault = native.get!.call(input) as string;
        const siblingOwn =
          Object.getOwnPropertyDescriptor(sibling, 'value') !== undefined;
        const siblingAfter = sibling.value;
        failGetter = false;
        update(true);
        const recovered = input.value;
        update(false);
        return {
          mode,
          didThrow,
          samePrimary: caught === primary,
          sameCleanup: caught === cleanup,
          attempts,
          coercions,
          after,
          afterDefault,
          exactDescriptor:
            descriptor.get === get &&
            descriptor.set === set &&
            descriptor.configurable === true &&
            descriptor.enumerable === true,
          siblingOwn,
          siblingAfter,
          recovered,
          recoveredOff: input.value,
        };
      }, mode),
    );
  }
  expect(states).toEqual(
    ['setter', 'coercion', 'setter-undefined', 'coercion-null'].map((mode) => ({
      mode,
      didThrow: true,
      samePrimary: true,
      sameCleanup: false,
      attempts: 1,
      coercions: mode.startsWith('coercion') ? 1 : 0,
      after: 'https://music.youtube.com/watch?v=BBBBBBBBBBB',
      afterDefault: 'https://music.youtube.com/watch?v=BBBBBBBBBBB',
      exactDescriptor: true,
      siblingOwn: false,
      siblingAfter: 'https://music.youtube.com/watch?v=CCCCCCCCCCC',
      recovered: 'https://youtube.com/watch?v=BBBBBBBBBBB',
      recoveredOff: 'https://music.youtube.com/watch?v=BBBBBBBBBBB',
    })),
  );
});
