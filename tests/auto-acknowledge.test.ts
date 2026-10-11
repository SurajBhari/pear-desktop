import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { build } from 'vite';
import { test, expect, type Page } from '@playwright/test';

const warning =
  'The following content may contain suicide or self-harm topics.';
const explicitTopics = [
  'suicide or self-harm',
  'self-harm',
  'self harm',
  'suicid',
  'selbstmord',
  'selbstverletzung',
  'suizid',
  'automutilation',
  'autolesion',
  'zelfmoord',
  'zelfbeschadiging',
  'самоубий',
  'самоповрежд',
  'суицид',
  'samoboj',
  'samookalecz',
  'intihar',
  'selvmord',
  'sjalvmord',
  'itsemurh',
  'itsensa vahingoitt',
  '自杀',
  '自殺',
  '自残',
  '自殘',
  '自傷',
  '自伤',
  '자살',
  '자해',
  'انتحار',
];
const negatives = [
  'Video unavailable',
  'This video is private',
  'Sign in to confirm your age',
  'This video may be inappropriate for some users.',
  'Playback on other websites has been disabled by the video owner',
  'YouTube Premium',
  'Get YouTube Premium',
  'Sign in to confirm you’re not a bot',
  '',
];
async function matcherSource() {
  try {
    return stripTypeScriptTypes(
      await readFile(
        new URL('../src/plugins/auto-acknowledge/matcher.ts', import.meta.url),
        'utf8',
      ),
    ).replace(/^export /gm, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A missing implementation is a behavioral no-op, not an import-error RED.
    return 'const shouldAcknowledge=()=>false;const findWarningAction=()=>null;';
  }
}
async function matcher(page: Page) {
  await page.addScriptTag({
    content:
      (await matcherSource()) +
      ';window.ackMatcher={shouldAcknowledge,findWarningAction};',
  });
}
const publicPositives = [
  warning,
  'O conteúdo a seguir pode conter tópicos sobre suicídio ou automutilação',
  'Die folgenden Inhalte können Themen wie Selbstmord oder Selbstverletzung enthalten',
  'Seuraava sisältö saattaa sisältää itsemurhaan tai itsensä vahingoittamiseen liittyviä aiheita.',
  '다음 콘텐츠에는 자살 또는 자해 주제가 포함될 수 있습니다.',
];
test('parser preserves all public multilingual warning fixtures and explicit topic needles', async ({
  page,
}) => {
  await matcher(page);
  const result = await page.evaluate(
    ({ publicPositives, explicitTopics }) => {
      const match = (window as any).ackMatcher.shouldAcknowledge;
      return {
        fixtures: publicPositives.map((reason) =>
          match({
            reason,
            subreason: 'Viewer discretion is advised. Learn more',
            hasProceedButton: true,
          }),
        ),
        topics: explicitTopics.map((reason) =>
          match({ reason, hasProceedButton: true }),
        ),
      };
    },
    { publicPositives, explicitTopics },
  );
  expect(result.fixtures).toEqual(publicPositives.map(() => true));
  expect(result.topics).toEqual(explicitTopics.map(() => true));
});
test('parser retains neutral warning header with topic subreason and normalization', async ({
  page,
}) => {
  await matcher(page);
  expect(
    await page.evaluate(() =>
      (window as any).ackMatcher.shouldAcknowledge({
        reason: 'Content warning',
        subreason: 'SUICÍDIO ou automutilação',
        hasProceedButton: true,
      }),
    ),
  ).toBe(true);
});
test('parser denies all public unrelated gates and generic discretion in either field', async ({
  page,
}) => {
  await matcher(page);
  const result = await page.evaluate(
    ({ negatives, warning }) => {
      const match = (window as any).ackMatcher.shouldAcknowledge;
      return {
        original: negatives.map((reason) =>
          match({ reason, subreason: '', hasProceedButton: true }),
        ),
        primary: negatives.map((reason) =>
          match({ reason, subreason: warning, hasProceedButton: true }),
        ),
        secondary: negatives
          .filter(Boolean)
          .map((subreason) =>
            match({ reason: warning, subreason, hasProceedButton: true }),
          ),
        generic: match({
          reason: 'Viewer discretion is advised',
          subreason: 'Learn more',
          hasProceedButton: true,
        }),
        inappropriate: match({
          reason: 'This video may be inappropriate for some users.',
          subreason: 'Viewer discretion is advised.',
          hasProceedButton: true,
        }),
      };
    },
    { negatives, warning },
  );
  expect(result.original).toEqual(negatives.map(() => false));
  expect(result.primary).toEqual(negatives.map(() => false));
  expect(result.secondary).toEqual(negatives.filter(Boolean).map(() => false));
  expect(result.generic).toBe(false);
  expect(result.inappropriate).toBe(false);
});
test('parser requires nonempty primary reason and supported proceed action', async ({
  page,
}) => {
  await matcher(page);
  expect(
    await page.evaluate(
      (warning) =>
        [null, '', '   '].map((reason) =>
          (window as any).ackMatcher.shouldAcknowledge({
            reason,
            subreason: warning,
            hasProceedButton: true,
          }),
        ),
      warning,
    ),
  ).toEqual([false, false, false]);
  expect(
    await page.evaluate(
      (warning) =>
        (window as any).ackMatcher.shouldAcknowledge({
          reason: warning,
          hasProceedButton: false,
        }),
      warning,
    ),
  ).toBe(false);
});
function markup(reason = warning, button = '<button>Proceed</button>') {
  return `<yt-playability-error-supported-renderers><yt-player-error-message-renderer style="display:block;width:300px;height:120px"><div id="reason">${reason}</div><div id="subreason">Viewer discretion is advised.</div><div id="button">${button}</div></yt-player-error-message-renderer></yt-playability-error-supported-renderers>`;
}
async function nativeFixture(page: Page, html = markup()) {
  await page.setContent(
    `<ytmusic-app><ytmusic-player style="display:block"><div id="movie_player">${html}</div></ytmusic-player><div id="other"></div></ytmusic-app>`,
  );
  await matcher(page);
}
test('native eligibility chooses only the exact supported scoped HTML button', async ({
  page,
}) => {
  await nativeFixture(page);
  expect(
    await page.evaluate(() => {
      const root = document.querySelector('ytmusic-player')!;
      const action = (window as any).ackMatcher.findWarningAction(
        root,
        document,
      );
      return {
        reason: action?.reason,
        button: action?.button === root.querySelector('#button button'),
        renderer:
          action?.renderer ===
          root.querySelector('yt-player-error-message-renderer'),
      };
    }),
  ).toEqual({ reason: warning, button: true, renderer: true });
});
for (const mode of [
  'bare',
  'outside',
  'wrapper',
  'random',
  'anchor',
  'disabled',
  'aria-disabled',
  'hidden',
  'ancestor-opacity',
  'ancestor-inert',
  'ancestor-hidden',
  'unknown',
  'no-reason',
] as const)
  test(`native eligibility preserves ${mode} controls`, async ({ page }) => {
    await nativeFixture(page);
    await page.evaluate((mode) => {
      const root = document.querySelector('ytmusic-player')!;
      const renderer = root.querySelector('yt-player-error-message-renderer')!;
      const button = renderer.querySelector('button')!;
      if (mode === 'bare') renderer.parentElement!.replaceWith(renderer);
      else if (mode === 'outside')
        document.querySelector('#other')!.append(renderer.parentElement!);
      else if (mode === 'wrapper') button.remove();
      else if (mode === 'random') renderer.append(button);
      else if (mode === 'anchor')
        button.replaceWith(
          Object.assign(document.createElement('a'), {
            textContent: 'Proceed',
          }),
        );
      else if (mode === 'disabled') button.disabled = true;
      else if (mode === 'aria-disabled')
        button.setAttribute('aria-disabled', 'true');
      else if (mode === 'hidden') button.hidden = true;
      else if (mode === 'ancestor-opacity')
        (root as HTMLElement).style.opacity = '0';
      else if (mode === 'ancestor-inert') (root as HTMLElement).inert = true;
      else if (mode === 'ancestor-hidden') (root as HTMLElement).hidden = true;
      else if (mode === 'unknown')
        renderer.querySelector('#reason')!.textContent = 'Video unavailable';
      else renderer.querySelector('#reason')!.remove();
    }, mode);
    expect(
      await page.evaluate(() =>
        (window as any).ackMatcher.findWarningAction(
          document.querySelector('ytmusic-player'),
          document,
        ),
      ),
    ).toBe(null);
  });

async function controllerSource() {
  let controller: string;
  try {
    controller = stripTypeScriptTypes(
      await readFile(
        new URL(
          '../src/plugins/auto-acknowledge/controller.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    )
      .replace(/^import[^;]+;/gm, '')
      .replace(/^export /gm, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    controller =
      'const startAutoAcknowledge=()=>({dispose(){},bindPlayerApi(){}});';
  }
  return (
    (await matcherSource()) +
    '\n' +
    controller +
    ';window.startAck=startAutoAcknowledge;'
  );
}
async function controllerFixture(page: Page, initial = true) {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T01:00:00Z'));
  await page.setContent(
    `<ytmusic-app><ytmusic-player style="display:block"><div id="movie_player">${initial ? markup() : ''}</div><div id="progress"></div></ytmusic-player><div id="other"></div></ytmusic-app>`,
  );
  await page.addScriptTag({ content: await controllerSource() });
  await page.evaluate(() => {
    const f = window as any;
    f.calls = [];
    f.scans = 0;
    f.intervals = 0;
    f.observers = [];
    f.pageHidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => f.pageHidden,
    });
    const Native = MutationObserver;
    window.MutationObserver = class extends Native {
      record: any;
      constructor(callback: MutationCallback) {
        super(callback);
        this.record = { active: false, targets: [] };
        f.observers.push(this.record);
      }
      override observe(target: Node, options?: MutationObserverInit) {
        this.record.active = true;
        this.record.targets.push({ target, options });
        super.observe(target, options);
      }
      override disconnect() {
        this.record.active = false;
        this.record.targets = [];
        super.disconnect();
      }
    };
    const originalInterval = window.setInterval.bind(window);
    window.setInterval = ((...args: any[]) => {
      f.intervals++;
      return Reflect.apply(originalInterval, window, args) as number;
    }) as any;
    f.instrument = (root: Element) => {
      const query = root.querySelectorAll.bind(root);
      root.querySelectorAll = ((selector: string) => {
        if (selector.includes('yt-player-error-message-renderer')) f.scans++;
        return query(selector);
      }) as any;
      root
        .querySelectorAll('button')
        .forEach((button) =>
          button.addEventListener('click', () =>
            f.calls.push(button.id || 'proceed'),
          ),
        );
    };
    f.instrument(document.querySelector('ytmusic-player'));
    f.begin = () => {
      f.ctrl = f.startAck(document);
    };
    f.markup = (reason: string) =>
      `<yt-playability-error-supported-renderers><yt-player-error-message-renderer style="display:block;width:300px;height:120px"><div id="reason">${reason}</div><div id="subreason">Viewer discretion is advised.</div><div id="button"><button>Proceed</button></div></yt-player-error-message-renderer></yt-playability-error-supported-renderers>`;
    f.add = (reason: string) => {
      document.querySelector('#movie_player')!.innerHTML = f.markup(reason);
      document
        .querySelector('#movie_player button')!
        .addEventListener('click', () => f.calls.push('later'));
    };
    f.api = () => {
      const api = document.querySelector('#movie_player') as any;
      const hooks = new Map<string, Set<() => void>>([
        ['videodatachange', new Set()],
        ['onStateChange', new Set()],
      ]);
      f.hooks = hooks;
      f.removed = [];
      f.videoId = 'video-a';
      api.getVideoData = function () {
        return { video_id: f.videoId };
      };
      api.addEventListener = function (name: string, callback: () => void) {
        if (this !== api) throw Error('wrong receiver');
        if (!hooks.has(name)) hooks.set(name, new Set());
        hooks.get(name)!.add(callback);
      };
      api.removeEventListener = function (name: string, callback: () => void) {
        if (this !== api) throw Error('wrong receiver');
        hooks.get(name)?.delete(callback);
        f.removed.push(name);
      };
      f.ctrl?.bindPlayerApi(api);
      return api;
    };
  });
}
const calls = (page: Page) => page.evaluate(() => (window as any).calls);
for (const initial of [false, true])
  test(`controller acknowledges ${initial ? 'initial' : 'later'} supported native warning once`, async ({
    page,
  }) => {
    await controllerFixture(page, initial);
    await page.evaluate(() => (window as any).begin());
    if (!initial)
      await page.evaluate((warning) => (window as any).add(warning), warning);
    await page.clock.runFor(300);
    expect(await calls(page)).toEqual([initial ? 'proceed' : 'later']);
    await page.evaluate(() => {
      document.querySelector('#subreason')!.textContent =
        'Viewer discretion is advised. Learn more';
    });
    await page.clock.runFor(1500);
    expect(await calls(page)).toHaveLength(1);
  });
test('controller handles neutral warning header with explicit-topic subreason but preserves known gate copy', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => (window as any).begin());
  await page.evaluate((warning) => {
    (window as any).add('Content warning');
    document.querySelector('#subreason')!.textContent = warning;
  }, warning);
  await page.clock.runFor(300);
  expect(await calls(page)).toEqual(['later']);
  await page.evaluate((warning) => {
    (window as any).add('Video unavailable');
    document.querySelector('#subreason')!.textContent = warning;
  }, warning);
  await page.clock.runFor(1500);
  expect(await calls(page)).toHaveLength(1);
});
test('controller has no recurring polls or warning scans during idle or unrelated mutations', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => (window as any).begin());
  await page.clock.runFor(300);
  const before = await page.evaluate(() => (window as any).scans);
  await page.clock.runFor(60000);
  await page.evaluate(() => {
    for (let i = 0; i < 100; i++) {
      document.querySelector('#other')!.append(document.createElement('span'));
      document
        .querySelector('#progress')!
        .append(document.createElement('span'));
      document.body.append(document.createElement('aside'));
    }
  });
  await page.clock.runFor(1000);
  expect(
    await page.evaluate(() => ({
      scans: (window as any).scans,
      intervals: (window as any).intervals,
    })),
  ).toEqual({ scans: before, intervals: 0 });
});
test('controller coalesces warning text bursts and executes trailing debounce work', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => (window as any).begin());
  await page.evaluate((warning) => {
    (window as any).add('Loading warning');
    for (let i = 0; i < 100; i++)
      document.querySelector('#reason')!.textContent = warning;
  }, warning);
  await page.clock.runFor(249);
  expect(await calls(page)).toEqual([]);
  await page.clock.runFor(20);
  expect(await calls(page)).toEqual(['later']);
  expect(await page.evaluate(() => (window as any).scans)).toBeLessThanOrEqual(
    3,
  );
});
test('controller preserves one trailing throttle attempt for a new warning episode', async ({
  page,
}) => {
  await controllerFixture(page);
  await page.evaluate(() => (window as any).begin());
  expect(await calls(page)).toEqual(['proceed']);
  await page.clock.runFor(300);
  await page.evaluate((warning) => (window as any).add(warning), warning);
  await page.clock.runFor(899);
  expect(await calls(page)).toEqual(['proceed']);
  await page.clock.runFor(20);
  expect(await calls(page)).toEqual(['proceed', 'later']);
});
for (const mode of [
  'button',
  'reason-text',
  'class',
  'ancestor-style',
  'document-visibility',
] as const)
  test(`controller reacts to ${mode} eligibility changes without polling`, async ({
    page,
  }) => {
    await controllerFixture(page);
    await page.evaluate((mode) => {
      const f = window as any;
      if (mode === 'button')
        document.querySelector<HTMLButtonElement>('button')!.disabled = true;
      else if (mode === 'reason-text')
        document.querySelector('#reason')!.firstChild!.textContent =
          'Loading warning';
      else if (mode === 'class') {
        const style = document.createElement('style');
        style.textContent = '.hide-warning{visibility:hidden}';
        document.head.append(style);
        document
          .querySelector('yt-player-error-message-renderer')!
          .classList.add('hide-warning');
      } else if (mode === 'ancestor-style') document.body.style.opacity = '0';
      else f.pageHidden = true;
      f.begin();
    }, mode);
    expect(await calls(page)).toEqual([]);
    await page.evaluate(
      ({ mode, warning }) => {
        if (mode === 'button')
          document.querySelector<HTMLButtonElement>('button')!.disabled = false;
        else if (mode === 'reason-text')
          document.querySelector('#reason')!.firstChild!.textContent = warning;
        else if (mode === 'class')
          document
            .querySelector('yt-player-error-message-renderer')!
            .classList.remove('hide-warning');
        else if (mode === 'ancestor-style') document.body.style.opacity = '1';
        else {
          (window as any).pageHidden = false;
          document.dispatchEvent(new Event('visibilitychange'));
        }
      },
      { mode, warning },
    );
    await page.clock.runFor(300);
    expect(await calls(page)).toEqual(['proceed']);
  });
for (const exit of ['stop', 'pagehide'] as const)
  test(`controller ${exit} fences pending work and preserves foreign observers/listeners`, async ({
    page,
  }) => {
    await controllerFixture(page, false);
    await page.evaluate(
      ({ exit, warning }) => {
        const f = window as any;
        const foreign = new MutationObserver(() => {});
        foreign.observe(document.body, { childList: true });
        f.foreign = foreign;
        f.foreignEvent = 0;
        document.addEventListener('visibilitychange', () => f.foreignEvent++);
        f.begin();
        f.add(warning);
        if (exit === 'stop') {
          f.ctrl.dispose();
          f.ctrl.dispose();
        } else window.dispatchEvent(new Event('pagehide'));
        document.dispatchEvent(new Event('visibilitychange'));
      },
      { exit, warning },
    );
    await page.clock.runFor(2000);
    expect(await calls(page)).toEqual([]);
    expect(
      await page.evaluate(() => ({
        active: (window as any).observers.filter((r: any) => r.active).length,
        event: (window as any).foreignEvent,
      })),
    ).toEqual({ active: 1, event: 1 });
  });
for (const mode of ['player', 'app', 'connected-move'] as const)
  test(`controller rebinds ${mode} before acting on current warning`, async ({
    page,
  }) => {
    await controllerFixture(page, false);
    await page.evaluate(() => (window as any).begin());
    await page.evaluate(
      ({ mode, warning }) => {
        const f = window as any;
        if (mode === 'player') {
          const replacement = document.createElement('ytmusic-player');
          replacement.style.display = 'block';
          replacement.innerHTML =
            '<div id="movie_player">' + f.markup(warning) + '</div>';
          document.querySelector('ytmusic-player')!.replaceWith(replacement);
          f.instrument(replacement);
        } else if (mode === 'app') {
          const app = document.createElement('ytmusic-app');
          app.innerHTML =
            '<ytmusic-player style="display:block"><div id="movie_player">' +
            f.markup(warning) +
            '</div></ytmusic-player>';
          document.querySelector('ytmusic-app')!.replaceWith(app);
          f.instrument(app.querySelector('ytmusic-player'));
        } else {
          const outer = document.createElement('section');
          outer.id = 'new-owner';
          const inner = document.createElement('div');
          outer.append(inner);
          document.body.append(outer);
          inner.append(document.querySelector('ytmusic-app')!);
          f.add(warning);
        }
      },
      { mode, warning },
    );
    await page.clock.runFor(300);
    expect(await calls(page)).toHaveLength(1);
    if (mode === 'connected-move') {
      await page.evaluate(() => document.querySelector('#new-owner')!.remove());
      await page.clock.runFor(2000);
      expect(
        await page.evaluate(() =>
          (window as any).observers.some(
            (r: any) =>
              r.active &&
              r.targets.some((t: any) => t.target.id === 'new-owner'),
          ),
        ),
      ).toBe(false);
    }
  });
test('controller discovers late primary app/player without timers then narrows discovery scope', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => {
    document.querySelector('ytmusic-app')!.remove();
    (window as any).begin();
  });
  await page.clock.runFor(1000);
  await page.evaluate((warning) => {
    const f = window as any;
    const app = document.createElement('ytmusic-app');
    app.innerHTML =
      '<ytmusic-player style="display:block"><div id="movie_player">' +
      f.markup(warning) +
      '</div></ytmusic-player>';
    document.body.append(app);
    f.instrument(app.querySelector('ytmusic-player'));
  }, warning);
  await page.clock.runFor(300);
  expect(await calls(page)).toHaveLength(1);
  expect(
    await page.evaluate(() => ({
      intervals: (window as any).intervals,
      documentSubtree: (window as any).observers.some(
        (r: any) =>
          r.active &&
          r.targets.some(
            (t: any) =>
              t.target === document.documentElement && t.options.subtree,
          ),
      ),
    })),
  ).toEqual({ intervals: 0, documentSubtree: false });
});
for (const retire of ['stop', 'disable', 'replace'] as const)
  test(`controller rechecks native click accessor ${retire} side effects`, async ({
    page,
  }) => {
    await controllerFixture(page, false);
    await page.evaluate(
      ({ retire, warning }) => {
        const f = window as any;
        f.begin();
        f.add(warning);
        f.getterReads = 0;
        const button = document.querySelector('button')!;
        const native = HTMLButtonElement.prototype.click;
        Object.defineProperty(button, 'click', {
          configurable: true,
          get() {
            f.getterReads++;
            if (retire === 'stop') f.ctrl.dispose();
            else if (retire === 'disable') button.disabled = true;
            else
              document.querySelector('#reason')!.textContent =
                'Video unavailable';
            return native;
          },
        });
      },
      { retire, warning },
    );
    await page.clock.runFor(2000);
    expect(await calls(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).getterReads)).toBe(1);
    if (retire === 'stop')
      expect(
        await page.evaluate(
          () => (window as any).observers.filter((r: any) => r.active).length,
        ),
      ).toBe(0);
  });
test('controller leaves a throwing unsupported native action intact without repeated retries', async ({
  page,
}) => {
  await controllerFixture(page);
  await page.evaluate(() => {
    const f = window as any;
    f.attempts = 0;
    document.querySelector('button')!.click = () => {
      f.attempts++;
      throw Error('unsupported site action');
    };
    f.begin();
  });
  await page.clock.runFor(60000);
  expect(await page.evaluate(() => (window as any).attempts)).toBe(1);
  expect(await page.locator('yt-player-error-message-renderer').count()).toBe(
    1,
  );
});
test('controller API ready seeds identity and new track reschedules without stale handover calls', async ({
  page,
}) => {
  await controllerFixture(page);
  await page.evaluate(() => {
    (window as any).begin();
    (window as any).api();
  });
  await page.clock.runFor(300);
  expect(await calls(page)).toEqual(['proceed']);
  await page.evaluate(() => {
    const f = window as any;
    f.videoId = 'video-b';
    for (const callback of f.hooks.get('videodatachange') ?? [])
      callback('dataloaded', {});
  });
  await page.clock.runFor(1000);
  expect(await calls(page)).toHaveLength(2);
  await page.evaluate(() => {
    const f = window as any;
    f.savedCallbacks = [...f.hooks.get('onStateChange')];
    f.ctrl.dispose();
    for (const callback of f.savedCallbacks) callback();
  });
  await page.clock.runFor(2000);
  expect(await calls(page)).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).removed.sort())).toEqual([
    'onStateChange',
    'videodatachange',
  ]);
});
test('controller API handover removes only owned callbacks and preserves a foreign listener', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => {
    const f = window as any;
    f.begin();
    const api = f.api();
    const foreign = () => {};
    f.hooks.get('videodatachange').add(foreign);
    f.foreignHook = foreign;
    f.ctrl?.bindPlayerApi(api);
    f.ctrl.dispose();
  });
  expect(
    await page.evaluate(() => [
      ...(window as any).hooks.get('videodatachange'),
    ]),
  ).toHaveLength(1);
});
test('controller isolates its supplied document from a different document lifetime', async ({
  page,
}) => {
  await controllerFixture(page);
  await page.evaluate(() => {
    const f = window as any;
    const other = document.implementation.createHTMLDocument('isolated');
    f.other = f.startAck(other);
    f.other.dispose();
    f.begin();
  });
  expect(await calls(page)).toEqual(['proceed']);
});

test('controller recognizes warning withdrawal and reopening as a new episode', async ({
  page,
}) => {
  await controllerFixture(page);
  await page.evaluate(() => (window as any).begin());
  await page.clock.runFor(300);
  await page.evaluate(() => {
    (
      document.querySelector('yt-player-error-message-renderer') as HTMLElement
    ).hidden = true;
  });
  await page.clock.runFor(300);
  await page.evaluate(() => {
    (
      document.querySelector('yt-player-error-message-renderer') as HTMLElement
    ).hidden = false;
  });
  await page.clock.runFor(700);
  expect(await calls(page)).toEqual(['proceed', 'proceed']);
});
for (const signal of ['resize', 'transitionend', 'animationend'] as const)
  test(`controller ${signal} signal catches stylesheet-only eligibility change`, async ({
    page,
  }) => {
    await controllerFixture(page);
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'visibility-rules';
      style.textContent = 'yt-player-error-message-renderer{opacity:0}';
      document.head.append(style);
      (window as any).begin();
    });
    expect(await calls(page)).toEqual([]);
    await page.evaluate((signal) => {
      (
        document.querySelector<HTMLStyleElement>('#visibility-rules')!
          .sheet as CSSStyleSheet
      ).deleteRule(0);
      if (signal === 'resize') window.dispatchEvent(new Event(signal));
      else
        document
          .querySelector('ytmusic-player')!
          .dispatchEvent(new Event(signal));
    }, signal);
    await page.clock.runFor(300);
    expect(await calls(page)).toEqual(['proceed']);
  });
test('controller retires stale API callbacks on player replacement while keeping current events', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate((warning) => {
    const f = window as any;
    f.begin();
    f.api();
    f.oldHooks = [...f.hooks.get('videodatachange')];
    const replacement = document.createElement('ytmusic-player');
    replacement.style.display = 'block';
    replacement.innerHTML =
      '<div id="movie_player">' + f.markup(warning) + '</div>';
    document.querySelector('ytmusic-player')!.replaceWith(replacement);
    f.instrument(replacement);
  }, warning);
  await page.clock.runFor(300);
  expect(await calls(page)).toHaveLength(1);
  await page.evaluate(() => (window as any).api());
  await page.clock.runFor(300);
  const beforeStale = await page.evaluate(() => (window as any).scans);
  await page.evaluate(() => {
    const f = window as any;
    f.videoId = 'video-c';
    for (const callback of f.oldHooks) callback('dataloaded', {});
  });
  await page.clock.runFor(1000);
  expect(await calls(page)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).scans)).toBe(beforeStale);
  await page.evaluate(() => {
    const f = window as any;
    for (const callback of f.hooks.get('onStateChange')) callback();
  });
  await page.clock.runFor(300);
  expect(await calls(page)).toHaveLength(2);
});
test('controller API getter retirement cannot install stale subscriptions', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => {
    const f = window as any;
    f.begin();
    const api = document.querySelector('#movie_player')!;
    f.apiAdds = 0;
    Object.defineProperty(api, 'addEventListener', {
      configurable: true,
      get() {
        f.ctrl.dispose();
        return () => f.apiAdds++;
      },
    });
    f.ctrl?.bindPlayerApi(api);
  });
  await page.clock.runFor(1000);
  expect(
    await page.evaluate(() => ({
      adds: (window as any).apiAdds,
      active: (window as any).observers.filter((r: any) => r.active).length,
    })),
  ).toEqual({ adds: 0, active: 0 });
});
test('controller cleans a partially registered throwing API without removing foreign hooks', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => {
    const f = window as any;
    f.begin();
    const api = document.querySelector('#movie_player') as any;
    const foreign = () => {};
    f.partial = new Set([foreign]);
    f.foreign = foreign;
    api.getVideoData = () => ({ video_id: 'known' });
    api.addEventListener = (_event: string, callback: () => void) => {
      f.partial.add(callback);
      throw Error('unsupported add');
    };
    api.removeEventListener = (_event: string, callback: () => void) =>
      f.partial.delete(callback);
    f.ctrl?.bindPlayerApi(api);
  });
  expect(
    await page.evaluate(() => ({
      count: (window as any).partial.size,
      foreign: (window as any).partial.has((window as any).foreign),
    })),
  ).toEqual({ count: 1, foreign: true });
});
test('controller owns two real document realms independently', async ({
  page,
}) => {
  await controllerFixture(page);
  await page.evaluate((warning) => {
    const f = window as any;
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const other = iframe.contentDocument!;
    other.body.innerHTML =
      '<ytmusic-app><ytmusic-player style="display:block"><div id="movie_player">' +
      f.markup(warning) +
      '</div></ytmusic-player></ytmusic-app>';
    f.realmCalls = 0;
    other
      .querySelector('button')!
      .addEventListener('click', () => f.realmCalls++);
    f.otherCtrl = f.startAck(other);
    f.begin();
    other.defaultView!.dispatchEvent(new Event('pagehide'));
  }, warning);
  expect(await calls(page)).toEqual(['proceed']);
  expect(await page.evaluate(() => (window as any).realmCalls)).toBe(1);
  await page.clock.runFor(1300);
  await page.evaluate((warning) => (window as any).add(warning), warning);
  await page.clock.runFor(300);
  expect(await calls(page)).toHaveLength(2);
});
test('controller rebinds replacement document element and retires the old discovery target', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => {
    document.querySelector('ytmusic-app')!.remove();
    (window as any).begin();
  });
  await page.evaluate((warning) => {
    const f = window as any;
    f.oldDocumentElement = document.documentElement;
    const html = document.createElement('html');
    html.innerHTML =
      '<head></head><body><ytmusic-app><ytmusic-player style="display:block"><div id="movie_player">' +
      f.markup(warning) +
      '</div></ytmusic-player></ytmusic-app></body>';
    document.documentElement.replaceWith(html);
    f.instrument(document.querySelector('ytmusic-player'));
  }, warning);
  await page.clock.runFor(300);
  expect(await calls(page)).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      (window as any).observers.some(
        (r: any) =>
          r.active &&
          r.targets.some(
            (t: any) => t.target === (window as any).oldDocumentElement,
          ),
      ),
    ),
  ).toBe(false);
});

async function pluginSource(language = 'en') {
  const entry = new URL(
    '../src/plugins/auto-acknowledge/index.ts',
    import.meta.url,
  );
  try {
    await readFile(entry, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'window.AckPlugin={config:{enabled:true,debug:true},name:()=>"missing",description:()=>"missing",renderer:{async start({getConfig}){await getConfig();},stop(){},onConfigChange(){},onPlayerApiReady(){}}};';
  }
  const resources = await readFile(
    new URL(`../src/i18n/resources/${language}.json`, import.meta.url),
    'utf8',
  );
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'ack-public-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@/utils' || id === '@/i18n') return '\0' + id;
          return null;
        },
        load(id) {
          if (id === '\0@/utils') return 'export const createPlugin=p=>p;';
          if (id === '\0@/i18n')
            return `const resources=${resources};export const t=key=>key.split('.').reduce((v,k)=>v?.[k],resources)??key;`;
          return null;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: entry.pathname, name: 'AckPlugin', formats: ['iife'] },
    },
  });
  const chunk = (Array.isArray(result) ? result : [result])
    .flatMap((r) => ('output' in r ? r.output : []))
    .find((o) => o.type === 'chunk');
  if (!chunk) throw Error('No actual plugin output');
  return chunk.code;
}
async function pluginFixture(page: Page, initial = true, language = 'en') {
  await controllerFixture(page, initial);
  await page.addScriptTag({ content: await pluginSource(language) });
  await page.evaluate(() => {
    const f = window as any;
    f.plugin = (window as any).AckPlugin;
    f.config = { enabled: true, debug: false };
    f.debugEvents = [];
    f.settingWrites = [];
    console.debug = (...args: any[]) => f.debugEvents.push(args);
    f.context = {
      getConfig: async () => f.config,
      setConfig: async (value: any) => f.settingWrites.push(value),
    };
  });
}
for (const language of ['en', 'ru'])
  test(`actual plugin ${language} admission keeps default opt-in settings and translated debug menu`, async ({
    page,
  }) => {
    await pluginFixture(page, true, language);
    const result = await page.evaluate(async () => {
      const f = window as any;
      f.config = f.plugin.config;
      await f.plugin.renderer.start(f.context);
      const menu = await f.plugin.menu?.(f.context);
      menu?.[0]?.click({ checked: true });
      return {
        defaults: f.plugin.config,
        name: f.plugin.name(),
        description: f.plugin.description(),
        restart: f.plugin.restartNeeded,
        authors: f.plugin.authors,
        menuLabel: menu?.[0]?.label,
        writes: f.settingWrites,
        active: f.observers.filter((r: any) => r.active).length,
      };
    });
    expect(result.defaults).toEqual({ enabled: false, debug: false });
    expect(result.restart).toBe(false);
    expect(result.authors).toEqual(['CorruptedKnowledge']);
    expect(result.name).not.toContain('plugins.');
    expect(result.description).not.toContain('plugins.');
    expect(result.menuLabel).not.toContain('plugins.');
    expect(result.writes).toEqual([{ debug: true }]);
    expect(result.active).toBe(0);
    expect(await calls(page)).toEqual([]);
  });
test('actual plugin restart disposes prior controller and config disabling fences all pending work', async ({
  page,
}) => {
  await pluginFixture(page);
  await page.evaluate(async () => {
    const f = window as any;
    await f.plugin.renderer.start(f.context);
    await f.plugin.renderer.start(f.context);
  });
  expect(await calls(page)).toHaveLength(2);
  expect(
    await page.evaluate(
      () => (window as any).observers.filter((r: any) => r.active).length,
    ),
  ).toBe(2);
  await page.evaluate((warning) => {
    const f = window as any;
    f.add(warning);
    f.plugin.renderer.onConfigChange({ enabled: false, debug: false });
  }, warning);
  await page.clock.runFor(2000);
  expect(await calls(page)).toHaveLength(2);
  expect(
    await page.evaluate(
      () => (window as any).observers.filter((r: any) => r.active).length,
    ),
  ).toBe(0);
});
test('actual plugin debug updates retain controller identity and emit only fixed labels and counters', async ({
  page,
}) => {
  await pluginFixture(page);
  const result = await page.evaluate(async () => {
    const f = window as any;
    f.config.debug = true;
    await f.plugin.renderer.start(f.context);
    const controller = f.plugin.renderer.controller;
    f.plugin.renderer.onConfigChange({ enabled: true, debug: false });
    return {
      same: f.plugin.renderer.controller === controller,
      events: f.debugEvents,
    };
  });
  expect(result.same).toBe(true);
  expect(result.events.length).toBeGreaterThan(0);
  for (const event of result.events) {
    expect(event[0]).toBe('[auto-acknowledge]');
    expect(['acknowledged', 'ineligible', 'unsupported']).toContain(event[1]);
    expect(Object.keys(event[2]).sort()).toEqual(['attempts', 'clicks']);
  }
  expect(JSON.stringify(result.events)).not.toContain(warning);
  expect(await calls(page)).toHaveLength(1);
});
for (const race of ['stop', 'restart', 'newer-config'] as const)
  test(`actual plugin ${race} cannot resurrect stale async startup`, async ({
    page,
  }) => {
    await pluginFixture(page);
    await page.evaluate(async (race) => {
      const f = window as any;
      let resolve: any;
      f.pending = f.plugin.renderer.start({
        getConfig: () => new Promise((r) => (resolve = r)),
      });
      if (race === 'stop') f.plugin.renderer.stop();
      else if (race === 'restart') await f.plugin.renderer.start(f.context);
      else f.plugin.renderer.onConfigChange({ enabled: false, debug: false });
      resolve({ enabled: true, debug: true });
      await f.pending;
    }, race);
    expect(await calls(page)).toHaveLength(race === 'restart' ? 1 : 0);
    expect(
      await page.evaluate(
        () => (window as any).observers.filter((r: any) => r.active).length,
      ),
    ).toBe(race === 'restart' ? 2 : 0);
  });
test('actual plugin stop remains retired when a later config notification arrives', async ({
  page,
}) => {
  await pluginFixture(page, false);
  await page.evaluate(async () => {
    const f = window as any;
    await f.plugin.renderer.start(f.context);
    f.plugin.renderer.stop();
    f.plugin.renderer.onConfigChange({ enabled: true, debug: true });
  });
  await page.clock.runFor(2000);
  expect(
    await page.evaluate(
      () => (window as any).observers.filter((r: any) => r.active).length,
    ),
  ).toBe(0);
});
test('actual plugin public API ready hook schedules only the current owned player', async ({
  page,
}) => {
  await pluginFixture(page);
  await page.evaluate(async () => {
    const f = window as any;
    await f.plugin.renderer.start(f.context);
    f.ctrl = f.plugin.renderer.controller;
    const api = f.api();
    f.plugin.renderer.onPlayerApiReady(api);
  });
  await page.clock.runFor(300);
  expect(await calls(page)).toHaveLength(1);
  await page.evaluate(() => {
    const f = window as any;
    f.videoId = 'next-video';
    for (const callback of f.hooks.get('videodatachange'))
      callback('dataloaded', {});
  });
  await page.clock.runFor(1200);
  expect(await calls(page)).toHaveLength(2);
  await page.evaluate(() => (window as any).plugin.renderer.stop());
  expect(
    await page.evaluate(
      () => (window as any).observers.filter((r: any) => r.active).length,
    ),
  ).toBe(0);
});

for (const mode of ['initial', 'click-getter', 'second-legend'] as const)
  test(`controller effective native fieldset disability ${mode} preserves acknowledgement until enabled`, async ({
    page,
  }) => {
    await controllerFixture(page);
    const before = await page.evaluate((mode) => {
      const f = window as any;
      const container = document.querySelector('#button')!;
      const button = container.querySelector('button')!;
      const fieldset = document.createElement('fieldset');
      container.replaceWith(fieldset);
      if (mode === 'second-legend') {
        const first = document.createElement('legend');
        first.textContent = 'First legend';
        const second = document.createElement('legend');
        second.append(container);
        fieldset.append(first, second);
      } else fieldset.append(container);
      if (mode === 'click-getter') {
        const click = button.click;
        let reads = 0;
        Object.defineProperty(button, 'click', {
          configurable: true,
          get() {
            if (++reads === 1) fieldset.disabled = true;
            return click;
          },
        });
      } else fieldset.disabled = true;
      f.begin();
      return {
        ownDisabled: button.disabled,
        effectiveDisabled: button.matches(':disabled'),
      };
    }, mode);
    expect(before).toEqual({ ownDisabled: false, effectiveDisabled: true });
    expect(await calls(page)).toEqual([]);
    await page.evaluate(
      () =>
        ((document.querySelector('fieldset') as HTMLFieldSetElement).disabled =
          false),
    );
    await page.clock.runFor(1500);
    expect(await calls(page)).toEqual(['proceed']);
  });

for (const ownDisabled of [false, true])
  test(`controller preserves native first-legend ${ownDisabled ? 'own-disabled control' : 'enabled exception'}`, async ({
    page,
  }) => {
    await controllerFixture(page);
    const state = await page.evaluate((ownDisabled) => {
      const f = window as any;
      const container = document.querySelector('#button')!;
      const button = container.querySelector('button')!;
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      container.replaceWith(fieldset);
      legend.append(container);
      fieldset.append(legend);
      fieldset.disabled = true;
      button.disabled = ownDisabled;
      f.begin();
      return {
        fieldsetDisabled: fieldset.disabled,
        effectiveDisabled: button.matches(':disabled'),
      };
    }, ownDisabled);
    expect(state).toEqual({
      fieldsetDisabled: true,
      effectiveDisabled: ownDisabled,
    });
    expect(await calls(page)).toEqual(ownDisabled ? [] : ['proceed']);
    if (ownDisabled) {
      await page.evaluate(
        () =>
          (document.querySelector<HTMLButtonElement>('button')!.disabled =
            false),
      );
      await page.clock.runFor(1500);
      expect(await calls(page)).toEqual(['proceed']);
      expect(
        await page.evaluate(
          () =>
            document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled,
        ),
      ).toBe(true);
    }
  });

for (const scope of ['renderer-wrapper', 'app-ancestor'] as const)
  test(`controller observes effective native fieldset changes at ${scope} scope`, async ({
    page,
  }) => {
    await controllerFixture(page);
    await page.evaluate((scope) => {
      const f = window as any;
      const target = document.querySelector(
        scope === 'renderer-wrapper'
          ? 'yt-playability-error-supported-renderers'
          : 'ytmusic-app',
      )!;
      const fieldset = document.createElement('fieldset');
      target.replaceWith(fieldset);
      fieldset.append(target);
      fieldset.disabled = true;
      f.begin();
    }, scope);
    expect(await calls(page)).toEqual([]);
    await page.evaluate(
      () =>
        (document.querySelector<HTMLFieldSetElement>('fieldset')!.disabled =
          false),
    );
    await page.clock.runFor(1500);
    expect(await calls(page)).toEqual(['proceed']);
  });

test('controller ignores unrelated fieldset state changes without warning rescans', async ({
  page,
}) => {
  await controllerFixture(page, false);
  await page.evaluate(() => {
    const fieldset = document.createElement('fieldset');
    fieldset.innerHTML = '<input><span>Unrelated progress</span>';
    document.querySelector('#progress')!.append(fieldset);
    (window as any).begin();
  });
  const before = await page.evaluate(() => (window as any).scans);
  await page.evaluate(() => {
    const fieldset = document.querySelector<HTMLFieldSetElement>('fieldset')!;
    for (let index = 0; index < 100; index++)
      fieldset.disabled = index % 2 === 0;
  });
  await page.clock.runFor(60000);
  expect(
    await page.evaluate(() => ({
      scans: (window as any).scans,
      intervals: (window as any).intervals,
    })),
  ).toEqual({ scans: before, intervals: 0 });
});
