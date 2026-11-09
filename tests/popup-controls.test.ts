import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { test, expect, type Page } from '@playwright/test';

async function fixture(
  page: Page,
  kind: 'dismiss-multidevice-popup' | 'toast-autoclose',
) {
  const name =
    kind === 'toast-autoclose'
      ? 'startToastAutoclose'
      : 'startMultideviceDismissal';
  let source: string;
  try {
    source = stripTypeScriptTypes(
      await readFile(
        new URL(`../src/plugins/${kind}/controller.ts`, import.meta.url),
        'utf8',
      ),
    ).replace(/export /g, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    source = `function ${name}() { return () => {}; }`;
  }
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-02T00:00:00Z'));
  await page.setContent(
    '<ytmusic-app><div id="popups"></div><div id="unrelated"></div></ytmusic-app>',
  );
  await page.addScriptTag({
    content: `${source};window.startPopup = ${name};`,
  });
  await page.evaluate(() => {
    const f = window as any;
    f.closeCalls = [];
    f.release = () => {};
    f.addDialog = (id: string, multi = true, opened = true, native = true) => {
      const dialog = document.createElement('tp-yt-paper-dialog');
      dialog.id = id;
      if (opened) dialog.setAttribute('opened', '');
      dialog.innerHTML = multi
        ? '<ytmusic-you-there-renderer></ytmusic-you-there-renderer>'
        : '<ytmusic-confirm-dialog-renderer></ytmusic-confirm-dialog-renderer>';
      if (native)
        (dialog as any).close = () => {
          f.closeCalls.push(id);
          dialog.removeAttribute('opened');
        };
      document.querySelector('#popups')!.append(dialog);
      return dialog;
    };
    f.addToast = (id: string, native = true, button = false) => {
      const toast = document.createElement('tp-yt-paper-toast');
      toast.id = id;
      toast.className = 'paper-toast-open';
      toast.innerHTML = '<span>Message</span>';
      if (native)
        (toast as any).close = () => {
          f.closeCalls.push(id);
          toast.classList.remove('paper-toast-open');
        };
      if (button) {
        const b = document.createElement('button');
        b.id = 'close-button';
        b.onclick = () => {
          f.closeCalls.push(`${id}-button`);
          toast.classList.remove('paper-toast-open');
        };
        toast.append(b);
      }
      document.querySelector('#popups')!.append(toast);
      return toast;
    };
    f.begin = () => {
      f.release = f.startPopup(document);
    };
  });
}
const closed = (page: Page) => page.evaluate(() => (window as any).closeCalls);

for (const dynamic of [false, true])
  test(`multidevice only: ${dynamic ? 'later' : 'existing'} open native dialog closes`, async ({
    page,
  }) => {
    await fixture(page, 'dismiss-multidevice-popup');
    await page.evaluate((dynamic) => {
      const f = window as any;
      if (dynamic) f.begin();
      f.addDialog('multi');
      f.addDialog('other', false);
      f.addDialog('closed', true, false);
      f.addDialog('unsupported', true, true, false);
      if (!dynamic) f.begin();
    }, dynamic);
    await expect.poll(() => closed(page), { timeout: 500 }).toEqual(['multi']);
    expect(await page.locator('tp-yt-paper-dialog').count()).toBe(4);
  });
test('multidevice same dialog can reopen without repeated attempts while closed', async ({
  page,
}) => {
  await fixture(page, 'dismiss-multidevice-popup');
  await page.evaluate(() => {
    const f = window as any;
    f.addDialog('multi');
    f.begin();
  });
  await expect.poll(() => closed(page), { timeout: 500 }).toEqual(['multi']);
  await page.evaluate(() =>
    document.querySelector('#multi')!.setAttribute('opened', ''),
  );
  await expect
    .poll(() => closed(page), { timeout: 500 })
    .toEqual(['multi', 'multi']);
});
for (const stop of ['stop', 'pagehide', 'replacement'])
  test(`multidevice ${stop} fences pending delivery and later open`, async ({
    page,
  }) => {
    await fixture(page, 'dismiss-multidevice-popup');
    await page.evaluate((stop) => {
      const f = window as any;
      f.begin();
      f.addDialog('pending');
      if (stop === 'stop') f.release();
      else if (stop === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      else
        document
          .querySelector('ytmusic-app')!
          .replaceWith(document.createElement('ytmusic-app'));
    }, stop);
    await page.clock.runFor(10);
    expect(await closed(page)).toEqual([]);
  });
test('multidevice reentrant retirement stops traversal without removing dialogs', async ({
  page,
}) => {
  await fixture(page, 'dismiss-multidevice-popup');
  await page.evaluate(() => {
    const f = window as any;
    const a = f.addDialog('first');
    (a as any).close = () => {
      f.closeCalls.push('first');
      window.dispatchEvent(new Event('pagehide'));
    };
    f.addDialog('second');
    f.begin();
  });
  expect(await closed(page)).toEqual(['first']);
  expect(await page.locator('tp-yt-paper-dialog').count()).toBe(2);
});
for (const button of [false, true])
  test(`toast uses ${button ? 'close button' : 'native close'} after three seconds`, async ({
    page,
  }) => {
    await fixture(page, 'toast-autoclose');
    await page.evaluate((button) => {
      const f = window as any;
      f.addToast('one', true, button);
      f.begin();
    }, button);
    await page.clock.runFor(2999);
    expect(await closed(page)).toEqual([]);
    await page.clock.runFor(1);
    expect(await closed(page)).toEqual([button ? 'one-button' : 'one']);
  });
test('later toast and close/reopen get their own full deadline', async ({
  page,
}) => {
  await fixture(page, 'toast-autoclose');
  await page.evaluate(() => {
    const f = window as any;
    f.begin();
    f.addToast('one');
  });
  await page.clock.runFor(2000);
  await page.evaluate(() => {
    const t = document.querySelector('#one')!;
    t.classList.remove('paper-toast-open');
    t.classList.add('paper-toast-open');
  });
  await page.clock.runFor(1000);
  expect(await closed(page)).toEqual([]);
  await page.clock.runFor(2000);
  expect(await closed(page)).toEqual(['one']);
});
test('new message resets toast deadline; unrelated mutation does not', async ({
  page,
}) => {
  await fixture(page, 'toast-autoclose');
  await page.evaluate(() => {
    const f = window as any;
    f.addToast('one');
    f.begin();
  });
  await page.clock.runFor(2000);
  await page.evaluate(() => {
    document.querySelector('#one span')!.textContent = 'New message';
    document.querySelector('#unrelated')!.textContent = 'Elsewhere';
  });
  await page.clock.runFor(1000);
  expect(await closed(page)).toEqual([]);
  await page.clock.runFor(1500);
  await page.evaluate(() =>
    document.querySelector('#unrelated')!.classList.add('x'),
  );
  await page.clock.runFor(500);
  expect(await closed(page)).toEqual(['one']);
});
for (const stop of ['stop', 'pagehide', 'replacement', 'detached'])
  test(`toast ${stop} retires pending deadline`, async ({ page }) => {
    await fixture(page, 'toast-autoclose');
    await page.evaluate(() => {
      const f = window as any;
      f.addToast('one');
      f.begin();
    });
    await page.clock.runFor(2000);
    await page.evaluate((stop) => {
      if (stop === 'stop') (window as any).release();
      else if (stop === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      else if (stop === 'detached') document.querySelector('#one')!.remove();
      else
        document
          .querySelector('ytmusic-app')!
          .replaceWith(document.createElement('ytmusic-app'));
    }, stop);
    await page.clock.runFor(4000);
    expect(await closed(page)).toEqual([]);
  });
test('focused toast action is retained until focus leaves', async ({
  page,
}) => {
  await fixture(page, 'toast-autoclose');
  await page.evaluate(() => {
    const f = window as any;
    const t = f.addToast('one');
    const b = document.createElement('button');
    b.textContent = 'Undo';
    t.append(b);
    b.focus();
    f.begin();
  });
  await page.clock.runFor(3000);
  expect(await closed(page)).toEqual([]);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.clock.runFor(3000);
  expect(await closed(page)).toEqual(['one']);
});
test('toast without supported close remains intact and foreign observers survive stop', async ({
  page,
}) => {
  await fixture(page, 'toast-autoclose');
  await page.evaluate(() => {
    const f = window as any;
    f.foreign = 0;
    f.observer = new MutationObserver(() => f.foreign++);
    f.observer.observe(document.querySelector('ytmusic-app'), {
      childList: true,
      subtree: true,
    });
    f.addToast('one', false);
    f.begin();
  });
  await page.clock.runFor(3000);
  expect(await page.locator('#one.paper-toast-open').count()).toBe(1);
  await page.evaluate(() => {
    (window as any).release();
    (window as any).foreign = 0;
    document
      .querySelector('#unrelated')!
      .append(document.createElement('span'));
  });
  await page.clock.runFor(1);
  expect(await page.evaluate(() => (window as any).foreign)).toBeGreaterThan(0);
});
for (const kind of ['dismiss-multidevice-popup', 'toast-autoclose'] as const)
  test(`${kind} ignores unrelated page mutations without scanning popup DOM`, async ({
    page,
  }) => {
    await fixture(page, kind);
    await page.evaluate(() => {
      const f = window as any;
      const app = document.querySelector('ytmusic-app')!;
      const native = app.querySelectorAll.bind(app);
      f.scans = 0;
      app.querySelectorAll = (
        ...args: Parameters<typeof app.querySelectorAll>
      ) => {
        f.scans++;
        return native(...args);
      };
      f.begin();
      f.scans = 0;
      document.querySelector('#unrelated')!.classList.add('y');
      document
        .querySelector('#unrelated')!
        .append(document.createElement('span'));
    });
    await page.clock.runFor(1);
    expect(await page.evaluate(() => (window as any).scans)).toBe(0);
  });
for (const kind of ['dismiss-multidevice-popup', 'toast-autoclose'] as const)
  test(`${kind} disconnects its observers immediately on app replacement`, async ({
    page,
  }) => {
    await fixture(page, kind);
    await page.evaluate(() => {
      const f = window as any;
      const Native = MutationObserver;
      f.activeObservers = 0;
      window.MutationObserver = class extends Native {
        active = false;
        override observe(target: Node, options?: MutationObserverInit) {
          if (!this.active) f.activeObservers++;
          this.active = true;
          super.observe(target, options);
        }
        override disconnect() {
          if (this.active) f.activeObservers--;
          this.active = false;
          super.disconnect();
        }
      };
      f.begin();
      document
        .querySelector('ytmusic-app')!
        .replaceWith(document.createElement('ytmusic-app'));
    });
    await page.clock.runFor(1);
    expect(await page.evaluate(() => (window as any).activeObservers)).toBe(0);
  });
test('multidevice method getter retirement cannot close a stale dialog', async ({
  page,
}) => {
  await fixture(page, 'dismiss-multidevice-popup');
  await page.evaluate(() => {
    const f = window as any;
    const dialog = f.addDialog('one');
    Object.defineProperty(dialog, 'close', {
      get() {
        window.dispatchEvent(new Event('pagehide'));
        return () => f.closeCalls.push('stale');
      },
    });
    f.begin();
  });
  expect(await closed(page)).toEqual([]);
});
test('toast method getter retirement cannot close stale UI', async ({
  page,
}) => {
  await fixture(page, 'toast-autoclose');
  await page.evaluate(() => {
    const f = window as any;
    const toast = f.addToast('one');
    Object.defineProperty(toast, 'close', {
      get() {
        window.dispatchEvent(new Event('pagehide'));
        return () => f.closeCalls.push('stale');
      },
    });
    f.begin();
  });
  await page.clock.runFor(3000);
  expect(await closed(page)).toEqual([]);
});
test('multidevice close method is read once and receives its native receiver', async ({
  page,
}) => {
  await fixture(page, 'dismiss-multidevice-popup');
  await page.evaluate(() => {
    const f = window as any;
    const dialog = f.addDialog('one');
    f.reads = 0;
    Object.defineProperty(dialog, 'close', {
      get() {
        f.reads++;
        return function (this: HTMLElement) {
          f.closeCalls.push(this === dialog ? 'one' : 'wrong');
          this.removeAttribute('opened');
        };
      },
    });
    f.begin();
  });
  expect(await closed(page)).toEqual(['one']);
  expect(await page.evaluate(() => (window as any).reads)).toBe(1);
});
test('toast close method is read once and receives its native receiver', async ({
  page,
}) => {
  await fixture(page, 'toast-autoclose');
  await page.evaluate(() => {
    const f = window as any;
    const toast = f.addToast('one');
    f.reads = 0;
    Object.defineProperty(toast, 'close', {
      get() {
        f.reads++;
        return function (this: HTMLElement) {
          f.closeCalls.push(this === toast ? 'one' : 'wrong');
          this.classList.remove('paper-toast-open');
        };
      },
    });
    f.begin();
  });
  await page.clock.runFor(3000);
  expect(await closed(page)).toEqual(['one']);
  expect(await page.evaluate(() => (window as any).reads)).toBe(1);
});
for (const kind of ['dismiss-multidevice-popup', 'toast-autoclose'] as const)
  test(`${kind} actual plugin restart disposes previous observers and deadlines`, async ({
    page,
  }) => {
    await fixture(page, kind);
    const resources = await readFile(
      new URL('../src/i18n/resources/en.json', import.meta.url),
      'utf8',
    );
    const bundle = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'native-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (id === '@/utils' || id === '@/i18n') return `\0${id}`;
            return null;
          },
          load(id) {
            if (id === '\0@/utils')
              return 'export const createPlugin = p => p;';
            if (id === '\0@/i18n')
              return `const resources=${resources}; export const t=key=>key.split('.').reduce((v,k)=>v?.[k],resources)??key;`;
            return null;
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: fileURLToPath(
            new URL(`../src/plugins/${kind}/index.ts`, import.meta.url),
          ),
          name: 'PopupPlugin',
          formats: ['iife'],
        },
      },
    });
    const outputs = Array.isArray(bundle) ? bundle : [bundle];
    const chunk = outputs
      .flatMap((result) => ('output' in result ? result.output : []))
      .find((output) => output.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk')
      throw new Error('Missing actual plugin bundle');
    await page.addScriptTag({ content: chunk.code });
    await page.evaluate((kind) => {
      const f = window as any;
      const Native = MutationObserver;
      f.activeObservers = 0;
      window.MutationObserver = class extends Native {
        active = false;
        override observe(target: Node, options?: MutationObserverInit) {
          if (!this.active) f.activeObservers++;
          this.active = true;
          super.observe(target, options);
        }
        override disconnect() {
          if (this.active) f.activeObservers--;
          this.active = false;
          super.disconnect();
        }
      };
      f.plugin = f.PopupPlugin;
      f.plugin.renderer.start();
      if (kind === 'toast-autoclose') f.addToast('one');
    }, kind);
    expect(await page.evaluate(() => (window as any).plugin.name())).toBe(
      kind === 'toast-autoclose'
        ? 'Toast Auto-Close'
        : 'Dismiss Multidevice Popup',
    );
    await page.clock.runFor(2000);
    await page.evaluate(() => (window as any).plugin.renderer.start());
    expect(await page.evaluate(() => (window as any).activeObservers)).toBe(2);
    await page.clock.runFor(1000);
    expect(await closed(page)).toEqual([]);
    await page.evaluate(() => (window as any).plugin.renderer.stop());
    expect(await page.evaluate(() => (window as any).activeObservers)).toBe(0);
    await page.clock.runFor(3000);
    expect(await closed(page)).toEqual([]);
  });
for (const kind of ['dismiss-multidevice-popup', 'toast-autoclose'] as const)
  test(`${kind} throwing native close cannot remove or break other UI`, async ({
    page,
  }) => {
    await fixture(page, kind);
    await page.evaluate((kind) => {
      const f = window as any;
      const one =
        kind === 'toast-autoclose' ? f.addToast('one') : f.addDialog('one');
      (one as any).close = () => {
        throw new Error('site action failed');
      };
      if (kind === 'toast-autoclose') f.addToast('two');
      else f.addDialog('two');
      f.begin();
    }, kind);
    await page.clock.runFor(3000);
    expect(await closed(page)).toEqual(['two']);
    expect(await page.locator('#one').count()).toBe(1);
  });
test('multidevice final opened getter retirement is checked before native close', async ({
  page,
}) => {
  await fixture(page, 'dismiss-multidevice-popup');
  await page.evaluate(() => {
    const f = window as any;
    const dialog = f.addDialog('one');
    let reads = 0;
    Object.defineProperty(dialog, 'opened', {
      get() {
        reads++;
        if (reads === 2) window.dispatchEvent(new Event('pagehide'));
        return true;
      },
    });
    f.begin();
  });
  expect(await closed(page)).toEqual([]);
});
test('toast native button nested in close-button wrapper receives its click', async ({
  page,
}) => {
  await fixture(page, 'toast-autoclose');
  await page.evaluate(() => {
    const f = window as any;
    const toast = f.addToast('one', false);
    const wrapper = document.createElement('div');
    wrapper.id = 'close-button';
    const button = document.createElement('button');
    button.textContent = 'Close';
    button.onclick = () => {
      f.closeCalls.push('native-button');
      toast.classList.remove('paper-toast-open');
    };
    wrapper.append(button);
    toast.append(wrapper);
    f.begin();
  });
  await page.clock.runFor(3000);
  expect(await closed(page)).toEqual(['native-button']);
});
test('unsupported throwing dialog state cannot leak plugin observers or skip next valid dialog', async ({
  page,
}) => {
  await fixture(page, 'dismiss-multidevice-popup');
  const state = await page.evaluate(() => {
    const f = window as any;
    const Native = MutationObserver;
    f.activeObservers = 0;
    window.MutationObserver = class extends Native {
      active = false;
      override observe(target: Node, options?: MutationObserverInit) {
        if (!this.active) f.activeObservers++;
        this.active = true;
        super.observe(target, options);
      }
      override disconnect() {
        if (this.active) f.activeObservers--;
        this.active = false;
        super.disconnect();
      }
    };
    const bad = f.addDialog('bad');
    Object.defineProperty(bad, 'opened', {
      get() {
        throw new Error('site state unavailable');
      },
    });
    f.addDialog('good');
    let threw = false;
    try {
      f.begin();
    } catch {
      threw = true;
    }
    f.release();
    return { threw, calls: f.closeCalls, active: f.activeObservers };
  });
  expect(state).toEqual({ threw: false, calls: ['good'], active: 0 });
  expect(await page.locator('#bad').count()).toBe(1);
});
for (const kind of ['dismiss-multidevice-popup', 'toast-autoclose'] as const)
  for (const move of [false, true])
    test(`${kind} ${move ? 'connected reparent then wrapper removal' : 'initial wrapper removal'} retires ownership`, async ({
      page,
    }) => {
      await fixture(page, kind);
      await page.evaluate((move) => {
        const f = window as any;
        const Native = MutationObserver;
        f.activeObservers = 0;
        window.MutationObserver = class extends Native {
          active = false;
          override observe(target: Node, options?: MutationObserverInit) {
            if (!this.active) f.activeObservers++;
            this.active = true;
            super.observe(target, options);
          }
          override disconnect() {
            if (this.active) f.activeObservers--;
            this.active = false;
            super.disconnect();
          }
        };
        const app = document.querySelector('ytmusic-app')!;
        if (!move) {
          const parent = document.createElement('div');
          app.replaceWith(parent);
          parent.append(app);
        }
        f.begin();
        if (move) {
          const outer = document.createElement('section');
          const parent = document.createElement('div');
          outer.append(parent);
          document.body.append(outer);
          parent.append(app);
        } else
          app.parentElement!.replaceWith(document.createElement('ytmusic-app'));
      }, move);
      await page.clock.runFor(1);
      if (move) {
        expect(await page.evaluate(() => (window as any).activeObservers)).toBe(
          2,
        );
        await page.evaluate(() =>
          document.querySelector('ytmusic-app')!.parentElement!.remove(),
        );
        await page.clock.runFor(1);
      }
      expect(await page.evaluate(() => (window as any).activeObservers)).toBe(
        0,
      );
    });
