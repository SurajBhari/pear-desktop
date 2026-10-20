import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { test, expect, type Page } from '@playwright/test';
import { build } from 'vite';
import solid from 'vite-plugin-solid';

let bundle: string;
test.beforeAll(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-history-swipes-'));
  const root = path.resolve(import.meta.dirname, '..');
  const entry = path.join(directory, 'entry.ts');
  try {
    await writeFile(
      entry,
      `export {default as plugin} from ${JSON.stringify(path.join(root, 'src/plugins/navigation/index.tsx'))};`,
    );
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        solid(),
        {
          name: 'navigation-boundaries',
          resolveId(id) {
            if (
              ['@/i18n', '@/utils', '@/solit'].includes(id) ||
              id.startsWith('@mdui/icons/')
            )
              return '\0' + id;
          },
          load(id) {
            if (id === '\0@/i18n') return 'export const t=key=>key;';
            if (id === '\0@/utils')
              return 'export const createPlugin=value=>value;';
            if (id === '\0@/solit')
              return 'export const LitElementWrapper=()=>document.createElement("span");';
            if (id.startsWith('\0@mdui/icons/'))
              return 'export const IconChevronLeft=class {};export const IconChevronRight=class {};';
          },
        },
      ],
      resolve: { conditions: ['browser'] },
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ['iife'], name: 'NavigationFixture' },
      },
    });
    const result = (Array.isArray(output) ? output[0] : output).output.find(
      (value) => value.type === 'chunk',
    );
    if (!result || result.type !== 'chunk')
      throw new Error('Navigation fixture bundle missing');
    bundle = result.code;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(page: Page, enabled = true) {
  await page.route('https://navigation.fixture/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>
    body{margin:0}#surface{height:100vh}#carousel{width:200px;overflow-x:auto}#carousel>div{width:1000px;height:40px}
    #contained{overscroll-behavior-x:contain;width:200px;height:40px}dialog{width:300px;height:100px}
  </style><div id="right-content"></div><div id="surface"><div id="carousel"><div>Carousel</div></div><div id="contained">Contained</div><input id="editor"><input id="range" type="range"><div id="shadow"></div></div><dialog><input aria-label="Dialog input"></dialog>`,
    }),
  );
  await page.goto('https://navigation.fixture/root');
  await page.evaluate(() => {
    history.pushState({}, '', '/one');
    history.pushState({}, '', '/two');
    const host = document.querySelector('#shadow')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<div style="width:200px;overflow-x:auto"><div style="width:1000px;height:40px">Shadow carousel</div></div>';
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async (enabled) => {
    const state = window as any;
    state.navigationListeners = new Map();
    state.navigationContext = {
      getConfig: () => ({ enabled: true, swipeNavigation: enabled }),
      ipc: {
        subscribe: (channel: string, listener: Function) => {
          state.navigationListeners.set(channel, listener);
          return () => state.navigationListeners.delete(channel);
        },
        on: (channel: string, listener: Function) =>
          state.navigationListeners.set(channel, listener),
        removeAllListeners: (channel: string) =>
          state.navigationListeners.delete(channel),
      },
    };
    await state.NavigationFixture.plugin.renderer.start(
      state.navigationContext,
    );
  }, enabled);
}

async function swipe(page: Page, x: number, y = 0) {
  await page.mouse.wheel(x, y);
  await page.mouse.wheel(x, y);
  await page.mouse.wheel(x, y);
}

test('trusted horizontal swipes navigate history once per stream in each direction', async ({
  page,
}) => {
  await fixture(page);
  await page.mouse.move(700, 500);
  await swipe(page, -80);
  await expect(page).toHaveURL('https://navigation.fixture/one');
  await swipe(page, -120);
  await expect(page).toHaveURL('https://navigation.fixture/one');
  // A deliberate quiet boundary separates the next input stream from momentum.
  await page.waitForTimeout(700);
  await swipe(page, 80);
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

for (const [name, selector] of [
  ['horizontal carousel', '#carousel'],
  ['carousel at its edge', '#carousel'],
  ['shadow carousel', '#shadow'],
  ['CSS containment', '#contained'],
  ['range control', '#range'],
] as const) {
  test(`swipes preserve ${name} and do not escape to history mid-stream`, async ({
    page,
  }) => {
    await fixture(page);
    if (name === 'carousel at its edge')
      await page.locator(selector).evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
    if (name === 'shadow carousel')
      await page.locator('#shadow').locator('div').first().hover();
    else await page.locator(selector).hover();
    await swipe(page, -100);
    await page.mouse.move(700, 500);
    await swipe(page, -100);
    await expect(page).toHaveURL('https://navigation.fixture/two');
  });
}

for (const mode of [
  'vertical',
  'diagonal',
  'shift',
  'control',
  'untrusted',
  'modal',
  'editable',
] as const) {
  test(`history swipes reject ${mode} input`, async ({ page }) => {
    await fixture(page);
    await page.mouse.move(700, 500);
    if (mode === 'modal')
      await page
        .locator('dialog')
        .evaluate((dialog: HTMLDialogElement) => dialog.showModal());
    if (mode === 'editable') await page.locator('#editor').focus();
    if (mode === 'shift') await page.keyboard.down('Shift');
    if (mode === 'control') await page.keyboard.down('Control');
    if (mode === 'untrusted')
      await page.locator('#surface').evaluate((node) => {
        for (let i = 0; i < 5; i++)
          node.dispatchEvent(
            new WheelEvent('wheel', { bubbles: true, deltaX: -100 }),
          );
      });
    else
      await swipe(
        page,
        mode === 'vertical' ? 0 : -100,
        mode === 'vertical' ? 100 : mode === 'diagonal' ? 90 : 0,
      );
    if (mode === 'shift') await page.keyboard.up('Shift');
    if (mode === 'control') await page.keyboard.up('Control');
    await expect(page).toHaveURL('https://navigation.fixture/two');
  });
}

test('config changes discard a partial swipe and disabling or stopping removes navigation listeners', async ({
  page,
}) => {
  await fixture(page, false);
  await page.mouse.move(700, 500);
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
  await page.evaluate(() =>
    (window as any).NavigationFixture.plugin.renderer.onConfigChange({
      enabled: true,
      swipeNavigation: true,
    }),
  );
  await page.mouse.wheel(-70, 0);
  await page.evaluate(() => {
    const renderer = (window as any).NavigationFixture.plugin.renderer;
    renderer.onConfigChange({ enabled: true, swipeNavigation: false });
    renderer.onConfigChange({ enabled: true, swipeNavigation: true });
  });
  await page.mouse.wheel(-100, 0);
  await expect(page).toHaveURL('https://navigation.fixture/two');
  await page.evaluate(() =>
    (window as any).NavigationFixture.plugin.renderer.stop(),
  );
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
  expect(
    await page.evaluate(() => (window as any).navigationListeners.size),
  ).toBe(0);
});

test('native browser commands share modal and configuration guards and validate their payload', async ({
  page,
}) => {
  await fixture(page);
  const command = (value: string) =>
    page.evaluate((value) => {
      (window as any).navigationListeners.get('navigation-history-command')?.(
        value,
      );
    }, value);
  await command('back');
  await expect(page).toHaveURL('https://navigation.fixture/one');
  await command('forward');
  await expect(page).toHaveURL('https://navigation.fixture/two');
  await command('anything');
  await page
    .locator('dialog')
    .evaluate((dialog: HTMLDialogElement) => dialog.showModal());
  await command('back');
  await expect(page).toHaveURL('https://navigation.fixture/two');
  await page
    .locator('dialog')
    .evaluate((dialog: HTMLDialogElement) => dialog.close());
  await page.evaluate(() =>
    (window as any).NavigationFixture.plugin.renderer.onConfigChange({
      enabled: true,
      swipeNavigation: false,
    }),
  );
  await command('back');
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

test('a later site wheel handler can still cancel history navigation', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() =>
    window.addEventListener('wheel', (event) => event.preventDefault(), {
      passive: false,
    }),
  );
  await page.mouse.move(700, 500);
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

test('a site cancellation of the first sample owns the rest of that wheel stream', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    let first = true;
    window.addEventListener(
      'wheel',
      (event) => {
        if (first) {
          first = false;
          event.preventDefault();
        }
      },
      { passive: false },
    );
  });
  await page.mouse.move(700, 500);
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

for (const input of ['wheel', 'command'] as const) {
  test(`an active shadow-root modal blocks history ${input}`, async ({
    page,
  }) => {
    await fixture(page);
    await page.locator('#shadow').evaluate((host) => {
      host.shadowRoot!.innerHTML =
        '<dialog><button>Active modal</button></dialog>';
      host.shadowRoot!.querySelector('dialog')!.showModal();
    });
    if (input === 'wheel') {
      await page.getByRole('button', { name: 'Active modal' }).hover();
      await swipe(page, -100);
    } else
      await page.evaluate(() =>
        (window as any).navigationListeners.get('navigation-history-command')(
          'back',
        ),
      );
    await expect(page).toHaveURL('https://navigation.fixture/two');
  });
}

for (const boundary of ['editable', 'shadow host'] as const) {
  test(`native commands respect a protected ${boundary} ancestor of focus`, async ({
    page,
  }) => {
    await fixture(page);
    await page.evaluate((boundary) => {
      if (boundary === 'editable') {
        const surface = document.querySelector('#surface')!;
        surface.setAttribute('contenteditable', 'true');
        const button = document.createElement('button');
        surface.append(button);
        button.focus();
      } else {
        const host = document.querySelector('#shadow')!;
        host.setAttribute('data-no-history-swipe', '');
        host.shadowRoot!.innerHTML = '<button>Protected</button>';
        host.shadowRoot!.querySelector('button')!.focus();
      }
      (window as any).navigationListeners.get('navigation-history-command')(
        'back',
      );
    }, boundary);
    await expect(page).toHaveURL('https://navigation.fixture/two');
  });
}

test('vertical starts and direction reversals cannot turn into a history swipe mid-stream', async ({
  page,
}) => {
  await fixture(page);
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 50);
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
  await page.waitForTimeout(700);
  await page.mouse.wheel(-60, 0);
  await page.mouse.wheel(50, 0);
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

test('blur and popstate discard a partial gesture instead of carrying it into another view', async ({
  page,
}) => {
  await fixture(page);
  await page.mouse.move(700, 500);
  await page.mouse.wheel(-100, 0);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
  await page.waitForTimeout(700);
  await page.mouse.wheel(-100, 0);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL('https://navigation.fixture/one');
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/one');
});

test('a stopped asynchronous start cannot reinstall listeners after its config resolves', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const state = window as any;
    const renderer = state.NavigationFixture.plugin.renderer;
    renderer.stop();
    let resolve: Function;
    const config = new Promise((done) => (resolve = done));
    state.pendingStart = renderer.start({
      ...state.navigationContext,
      getConfig: () => config,
    });
    renderer.stop();
    resolve!({ enabled: true, swipeNavigation: true });
  });
  await page.evaluate(() => (window as any).pendingStart);
  expect(
    await page.evaluate(() => (window as any).navigationListeners.size),
  ).toBe(0);
  await page.mouse.move(700, 500);
  await swipe(page, -100);
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

test('legacy settings keep experimental gestures opt-in without changing the navigation arrows', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const state = window as any;
    const renderer = state.NavigationFixture.plugin.renderer;
    renderer.stop();
    await renderer.start({
      ...state.navigationContext,
      getConfig: () => ({ enabled: true }),
    });
  });
  await expect(page.locator('mdui-button-icon')).toHaveCount(2);
  await page.mouse.move(700, 500);
  await swipe(page, -100);
  await page.evaluate(() =>
    (window as any).navigationListeners.get('navigation-history-command')(
      'back',
    ),
  );
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

test('native commands respect a protected slot ancestor of light-DOM focus', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const host = document.querySelector('#shadow')!;
    host.shadowRoot!.innerHTML =
      '<div data-no-history-swipe><slot></slot></div>';
    const button = document.createElement('button');
    host.append(button);
    button.focus();
    (window as any).navigationListeners.get('navigation-history-command')(
      'back',
    );
  });
  await expect(page).toHaveURL('https://navigation.fixture/two');
});

for (const input of ['wheel', 'command'] as const) {
  test(`a visible unfocused shadow overlay blocks background ${input}`, async ({
    page,
  }) => {
    await fixture(page);
    await page.locator('#shadow').evaluate((host) => {
      host.shadowRoot!.innerHTML =
        '<div role="dialog" aria-modal="true">Visible overlay</div>';
    });
    await page.locator('#surface').click({ position: { x: 700, y: 500 } });
    // The initial pointer interruption must not be the reason navigation stops.
    await page.waitForTimeout(700);
    if (input === 'wheel') await swipe(page, -100);
    else
      await page.evaluate(() =>
        (window as any).navigationListeners.get('navigation-history-command')(
          'back',
        ),
      );
    await expect(page).toHaveURL('https://navigation.fixture/two');
  });
}
