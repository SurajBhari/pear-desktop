import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { Window, PropertySymbol, type Node as HappyNode } from 'happy-dom';

async function fixture(
  url = 'https://music.youtube.com/playlist?list=PL_owned',
) {
  const dom = new Window({ url });
  // Happy DOM 20.10.6 keeps its mutation delivery closures only in WeakRefs.
  // Real observers retain delivery while observed; preserve that lifetime in
  // this fixture so a GC during the full suite cannot silently drop mutations.
  const NativeObserver = dom.MutationObserver;
  dom.MutationObserver = class extends NativeObserver {
    private deliveries = new Set<unknown>();
    override observe(target: HappyNode, options: MutationObserverInit) {
      const previous = new Set(target[PropertySymbol.mutationListeners]);
      super.observe(target, options);
      for (const listener of target[PropertySymbol.mutationListeners]) {
        if (!previous.has(listener)) {
          const delivery = listener.callback.deref();
          if (delivery) this.deliveries.add(delivery);
        }
      }
    }
    override disconnect() {
      super.disconnect();
      this.deliveries.clear();
    }
  };
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  dom.requestAnimationFrame = (fn: FrameRequestCallback) => {
    frames.set(++serial, fn);
    return serial;
  };
  dom.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/playlist-search/controller.ts', import.meta.url),
      'utf8',
    ),
  );
  const m = await import(
    `data:text/javascript;base64,${Buffer.from(raw).toString('base64')}`
  );
  const flush = async () => {
    await dom.happyDOM.waitUntilComplete();
    const work = [...frames];
    frames.clear();
    for (const [, fn] of work) fn(0);
    await dom.happyDOM.waitUntilComplete();
  };
  const mount = (
    text: string[] = ['Café Sunrise — Artist A', 'Nightfall — Artist B'],
  ) => {
    dom.document.body.innerHTML =
      '<div id="browse-page"><ytmusic-playlist-shelf-renderer><div id="contents"></div></ytmusic-playlist-shelf-renderer></div><div id="queue"><ytmusic-responsive-list-item-renderer>Untouched queue</ytmusic-responsive-list-item-renderer></div>';
    const shelf = dom.document.querySelector(
      'ytmusic-playlist-shelf-renderer',
    )!;
    for (const title of text) {
      const row = dom.document.createElement(
        'ytmusic-responsive-list-item-renderer',
      );
      row.innerHTML = '<yt-formatted-string></yt-formatted-string>';
      row.firstElementChild!.textContent = title;
      shelf.querySelector('#contents')!.append(row);
    }
    return shelf;
  };
  const labels = {
    label: 'Search loaded items',
    placeholder: 'Title or artist',
    clear: 'Clear',
    results: (n: number, total: number) => `${n} of ${total} loaded`,
  };
  let release: undefined | (() => void);
  return {
    dom,
    m,
    frames,
    flush,
    mount,
    start: () => {
      release = m.startPlaylistSearch(dom.document, labels);
    },
    stop: () => {
      release?.();
    },
    input: () => dom.document.querySelector('input')! as HTMLInputElement,
    rows: () =>
      [
        ...dom.document.querySelectorAll(
          '#browse-page ytmusic-responsive-list-item-renderer',
        ),
      ] as HTMLElement[],
    change: (term: string) => {
      const input = dom.document.querySelector('input')! as HTMLInputElement;
      input.value = term;
      input.dispatchEvent(new dom.Event('input'));
    },
    close: async () => {
      release?.();
      await dom.happyDOM.close();
    },
  };
}

test('collection matching normalizes accents and Unicode, combines terms, and rejects home/search routes', async () => {
  const f = await fixture();
  try {
    expect(f.m.matchesCollectionText('Café — Beyoncé', 'cafe beyonce')).toBe(
      true,
    );
    expect(f.m.matchesCollectionText('Привет, мир', 'МИР')).toBe(true);
    expect(f.m.matchesCollectionText('夜の音楽', '夜 音')).toBe(true);
    expect(f.m.matchesCollectionText('Morning Artist', 'night')).toBe(false);
    expect(
      f.m.isCollectionLocation('https://music.youtube.com/browse/MPRE_owned'),
    ).toBe(true);
    expect(f.m.isCollectionLocation('https://music.youtube.com/')).toBe(false);
    expect(
      f.m.isCollectionLocation('https://music.youtube.com/search?q=Song'),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
test('filter owns only collection rows, preserves original display priority and restores on clear/stop', async () => {
  const f = await fixture();
  try {
    f.mount();
    const row = f.rows()[1];
    row.style.setProperty('display', 'grid', 'important');
    f.start();
    await f.flush();
    f.change('cafe');
    await f.flush();
    expect(row.style.getPropertyValue('display')).toBe('none');
    expect(row.style.getPropertyPriority('display')).toBe('important');
    expect(
      f.dom.document.querySelector('#queue > *')!.getAttribute('style'),
    ).toBeNull();
    expect(f.dom.document.querySelector('[role="status"]')!.textContent).toBe(
      '1 of 2 loaded',
    );
    f.change('');
    await f.flush();
    expect(row.style.getPropertyValue('display')).toBe('grid');
    expect(row.style.getPropertyPriority('display')).toBe('important');
    f.change('cafe');
    await f.flush();
    f.stop();
    expect(row.style.getPropertyValue('display')).toBe('grid');
    expect(f.dom.document.querySelector('input')).toBeNull();
    expect(f.frames.size).toBe(0);
  } finally {
    await f.close();
  }
});
test('late/replaced shelves and changed row text are filtered; route reset does not leak old query', async () => {
  const f = await fixture();
  try {
    f.start();
    await f.flush();
    expect(f.dom.document.querySelector('input')).toBeNull();
    f.mount();
    await f.flush();
    f.change('cafe');
    await f.flush();
    const row = f.rows()[1];
    row.firstElementChild!.textContent = 'Café remaster';
    await f.flush();
    expect(row.style.display).not.toBe('none');
    f.dom.happyDOM.setURL('https://music.youtube.com/playlist?list=PL_new');
    f.mount(['New song', 'Another song']);
    f.dom.document.dispatchEvent(new f.dom.Event('yt-navigate-finish'));
    await f.flush();
    expect(f.input().value).toBe('');
    expect(f.rows().every((row) => row.style.display !== 'none')).toBe(true);
  } finally {
    await f.close();
  }
});
test('stop while waiting or while a frame is queued cannot remount/hide later', async () => {
  const f = await fixture();
  try {
    f.start();
    f.stop();
    f.mount();
    await f.flush();
    expect(f.dom.document.querySelector('input')).toBeNull();
    f.start();
    await f.flush();
    f.change('missing');
    expect(f.frames.size).toBe(1);
    f.stop();
    await f.flush();
    expect(f.rows().every((row) => row.style.display !== 'none')).toBe(true);
  } finally {
    await f.close();
  }
});
test('Escape and clear button reset search while keyboard focus stays in the input', async () => {
  const f = await fixture();
  try {
    f.mount();
    f.start();
    await f.flush();
    const input = f.input();
    input.focus();
    f.change('missing');
    await f.flush();
    input.dispatchEvent(
      new f.dom.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    await f.flush();
    expect(input.value).toBe('');
    expect(f.dom.document.activeElement).toBe(input);
    f.change('missing');
    await f.flush();
    (f.dom.document.querySelector('button')! as HTMLElement).click();
    await f.flush();
    expect(input.value).toBe('');
    expect(f.dom.document.activeElement).toBe(input);
  } finally {
    await f.close();
  }
});

test('virtualized row reused after detached text changes cannot keep an old search cache', async () => {
  const f = await fixture();
  try {
    const shelf = f.mount();
    f.start();
    await f.flush();
    f.change('cafe');
    await f.flush();
    const row = f.rows()[1];
    row.remove();
    await f.flush();
    row.firstElementChild!.textContent = 'Café recycled';
    shelf.querySelector('#contents')!.append(row);
    await f.flush();
    expect(row.style.display).not.toBe('none');
    expect(f.dom.document.querySelector('[role="status"]')!.textContent).toBe(
      '2 of 2 loaded',
    );
  } finally {
    await f.close();
  }
});
test('reapplying a query captures a newer external display style before hiding it again', async () => {
  const f = await fixture();
  try {
    f.mount();
    f.start();
    await f.flush();
    const row = f.rows()[1];
    f.change('cafe');
    await f.flush();
    row.style.setProperty('display', 'flex', '');
    f.change('sunrise');
    await f.flush();
    expect(row.style.getPropertyValue('display')).toBe('none');
    f.stop();
    expect(row.style.getPropertyValue('display')).toBe('flex');
    expect(row.style.getPropertyPriority('display')).toBe('');
  } finally {
    await f.close();
  }
});

test('playing another track in the same playlist preserves its search query', async () => {
  const f = await fixture();
  try {
    f.mount();
    f.start();
    await f.flush();
    f.change('cafe');
    await f.flush();
    f.dom.happyDOM.setURL(
      'https://music.youtube.com/playlist?list=PL_owned&v=B',
    );
    f.dom.document.dispatchEvent(new f.dom.Event('yt-navigate-finish'));
    await f.flush();
    expect(f.input().value).toBe('cafe');
    expect(f.rows()[1].style.display).toBe('none');
  } finally {
    await f.close();
  }
});
test('native widget removal and shelf replacement in the same collection remount with the current query', async () => {
  const f = await fixture();
  try {
    f.mount();
    f.start();
    await f.flush();
    f.change('cafe');
    await f.flush();
    f.dom.document.querySelector('.pear-playlist-search')!.remove();
    await f.flush();
    expect(f.input()).toBeTruthy();
    expect(f.input().value).toBe('cafe');
    f.mount(['Café version 2', 'Another']);
    await f.flush();
    expect(f.input().value).toBe('cafe');
    expect(f.rows()[1].style.display).toBe('none');
  } finally {
    await f.close();
  }
});

test('native collection search fits a narrow window and exposes keyboard controls', async ({
  page,
}) => {
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/playlist-search/controller.ts', import.meta.url),
      'utf8',
    ),
  );
  const style = await readFile(
    new URL('../src/plugins/playlist-search/style.css', import.meta.url),
    'utf8',
  );
  const locales = JSON.parse(
    await readFile(
      new URL('../src/i18n/resources/en.json', import.meta.url),
      'utf8',
    ),
  )['plugins']['playlist-search'];
  await page.setViewportSize({ width: 360, height: 420 });
  await page.route('**/*', (route) =>
    route.request().url().startsWith('https://music.youtube.com/playlist')
      ? route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<style>html{font-size:10px;--ytmusic-text-primary:#fff;--ytmusic-text-secondary:#bbb;--ytmusic-background:#151515}body{margin:12px;background:#151515;color:#fff;font:16px system-ui}ytmusic-responsive-list-item-renderer{display:block;padding:12px 0}${style}</style><div id="browse-page"><ytmusic-playlist-shelf-renderer><div id="contents"><ytmusic-responsive-list-item-renderer>Café Sunrise — Beyoncé</ytmusic-responsive-list-item-renderer><ytmusic-responsive-list-item-renderer>Nightfall — Another artist</ytmusic-responsive-list-item-renderer></div></ytmusic-playlist-shelf-renderer></div>`,
        })
      : route.abort(),
  );
  await page.goto('https://music.youtube.com/playlist?list=PL_owned_fixture');
  await page.evaluate(
    async ({ raw, locales }) => {
      const module = await import(
        `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(raw)))}`
      );
      (window as any).releaseCollection = module.startPlaylistSearch(document, {
        label: locales.label,
        placeholder: locales.placeholder,
        clear: locales.clear,
        results: (m: number, t: number) =>
          locales.results
            .replace('{{matches}}', String(m))
            .replace('{{total}}', String(t)),
      });
    },
    { raw, locales },
  );
  const input = page.getByRole('searchbox', { name: locales.label });
  await input.fill('beyonce');
  await expect(page.getByRole('status')).toHaveText(
    '1 of 2 loaded items match',
  );
  await expect(
    page.locator('ytmusic-responsive-list-item-renderer').nth(1),
  ).toBeHidden();
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(
    page.getByRole('button', { name: locales.clear }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
  expect(
    await input.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe('none');
  if (process.env.PEAR_COLLECTION_EVIDENCE_DIR)
    await page.screenshot({
      path: `${process.env.PEAR_COLLECTION_EVIDENCE_DIR}/collection-search-narrow.png`,
    });
  await page.evaluate(() => (window as any).releaseCollection());
});

test('connected cached hidden shelves release ownership and mount the visible replacement', async () => {
  const f = await fixture();
  try {
    const old = f.mount();
    f.start();
    await f.flush();
    f.change('cafe');
    await f.flush();
    const hidden = f.rows()[1];
    old.hidden = true;
    const next = f.dom.document.createElement(
      'ytmusic-playlist-shelf-renderer',
    );
    next.innerHTML =
      '<div id="contents"><ytmusic-responsive-list-item-renderer>Café new</ytmusic-responsive-list-item-renderer><ytmusic-responsive-list-item-renderer>Other</ytmusic-responsive-list-item-renderer></div>';
    old.parentElement!.append(next);
    f.dom.document.dispatchEvent(new f.dom.Event('yt-navigate-finish'));
    await f.flush();
    expect(old.querySelector('input')).toBeNull();
    expect(hidden.style.display).not.toBe('none');
    expect(next.querySelector('input')!.value).toBe('cafe');
    expect(
      (
        next.querySelectorAll(
          'ytmusic-responsive-list-item-renderer',
        )[1] as HTMLElement
      ).style.display,
    ).toBe('none');
  } finally {
    await f.close();
  }
});
test('watch playback while the same visible collection remains keeps search ownership', async () => {
  const f = await fixture();
  try {
    const shelf = f.mount();
    f.start();
    await f.flush();
    f.change('cafe');
    await f.flush();
    f.dom.happyDOM.setURL(
      'https://music.youtube.com/watch?v=owned_song&list=PL_owned',
    );
    f.dom.document.dispatchEvent(new f.dom.Event('yt-navigate-finish'));
    await f.flush();
    expect(shelf.querySelector('input')!.value).toBe('cafe');
    expect(f.rows()[1].style.display).toBe('none');
  } finally {
    await f.close();
  }
});
test('cold home navigation delivered to Window enables collection discovery', async () => {
  const f = await fixture('https://music.youtube.com/');
  try {
    f.start();
    await f.flush();
    f.dom.happyDOM.setURL('https://music.youtube.com/playlist?list=PL_owned');
    const shelf = f.mount();
    f.dom.dispatchEvent(new f.dom.Event('yt-navigate-finish'));
    await f.flush();
    expect(shelf.querySelector('input')).toBeTruthy();
  } finally {
    await f.close();
  }
});

test('retired widget input and clear callbacks cannot reset a newer collection query', async () => {
  const f = await fixture();
  try {
    f.mount();
    f.start();
    await f.flush();
    f.change('cafe');
    await f.flush();
    const retired = f.input();
    const clear = f.dom.document.querySelector('button')! as HTMLElement;
    f.dom.happyDOM.setURL('https://music.youtube.com/playlist?list=PL_new');
    f.mount(['New song', 'Another']);
    f.dom.document.dispatchEvent(new f.dom.Event('yt-navigate-finish'));
    await f.flush();
    f.change('new');
    await f.flush();
    retired.dispatchEvent(
      new f.dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    clear.click();
    await f.flush();
    expect(f.input().value).toBe('new');
    expect(f.rows()[1].style.display).toBe('none');
  } finally {
    await f.close();
  }
});
