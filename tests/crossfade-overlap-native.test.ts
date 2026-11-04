import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { startCrossfadeFixture } from './helpers/crossfade-native';
import { installCrossfadeDiagnosticReporter } from './helpers/crossfade-diagnostic-reporter';

installCrossfadeDiagnosticReporter();

test('actual source retains the same outgoing A tail after B play; opening 750Hz never returns in qualified overlap', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    baseline: process.env.CROSSFADE_M87_BASELINE === '1',
    diagnosticCase: 'OVERLAP_DEFAULT',
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(1);
  const result = await page.evaluate(async () => {
    const f = (window as any).crossfadeFixture,
      original = f.aux[0];
    const samples: any[] = [];
    for (let i = 0; i < 35; i++) {
      await new Promise((r) => setTimeout(r, 20));
      samples.push({
        opening: f.power(750),
        tail: f.power(500),
        incoming: f.power(1000),
        a: original?.currentTime,
        same: f.aux[0] === original,
        count: f.graph.auxiliaryMediaCount,
      });
    }
    const events = f.events;
    f.diagnostic?.checkpoint('TERMINAL');
    f.renderer.stop();
    await f.context.close();
    return {
      samples,
      events,
      requests: f.requests,
      nexts: f.nexts,
      registered: f.aux.length,
    };
  });
  if (process.env.CROSSFADE_PROOF_OUTPUT)
    await writeFile(
      process.env.CROSSFADE_PROOF_OUTPUT,
      JSON.stringify(result, null, 2),
    );
  const qualified = result.samples.filter(
    (s) =>
      s.count === 1 &&
      s.incoming > 0.003 &&
      (s.tail > 0.003 || s.opening > 0.003),
  );
  expect(qualified.length, JSON.stringify(result)).toBeGreaterThan(3);
  expect(qualified.every((s) => s.same)).toBe(true);
  expect(
    qualified.every((s) => s.a > 3),
    JSON.stringify(qualified),
  ).toBe(true);
  expect(
    qualified.every((s) => s.opening < Math.max(s.tail, s.incoming) * 0.15),
    JSON.stringify(qualified),
  ).toBe(true);
  expect(result.registered).toBe(1);
  expect(result.requests).toBe(1);
  expect(result.nexts).toBe(1);
});

for (const scenario of ['manualDuringNext', 'duplicateEpisodeDuringNext'])
  test(`same target B cannot admit outgoing overlap after ${scenario}`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page, { [scenario]: true });
    await expect
      .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
        timeout: 7000,
        intervals: [20],
      })
      .toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).crossfadeFixture.graph.auxiliaryMediaCount,
        ),
      )
      .toBe(0);
    expect(
      await page.evaluate(() => {
        const f = (window as any).crossfadeFixture;
        return { next: f.nexts, volume: f.main.volume };
      }),
    ).toEqual({ next: 1, volume: 0.65 });
  });
test('late native B and suspended context cannot keep outgoing admission or wall-clock completion alive', async ({
  page,
}) => {
  await startCrossfadeFixture(page, { delayBMs: 2500 });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(1);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).crossfadeFixture.graph.auxiliaryMediaCount,
        ),
      { timeout: 2500, intervals: [20] },
    )
    .toBe(0);
  expect(
    await page.evaluate(() => (window as any).crossfadeFixture.main.volume),
  ).toBe(0.65);
});
test('context suspension during overlap immediately retires outgoing and restores ordinary native route', async ({
  page,
}) => {
  await startCrossfadeFixture(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(1);
  await page.waitForTimeout(100);
  await page.evaluate(() => (window as any).crossfadeFixture.context.suspend());
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).crossfadeFixture.graph.auxiliaryMediaCount,
      ),
    )
    .toBe(0);
});

// Persistent MAIN-1–3 assertions copied from the sealed independent review.
async function saveReviewProbe(name: string, value: unknown) {
  await test.info().attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}
test('delayed real auxiliary play must not hand off a clock misaligned by more than 100ms', async ({
  page,
}) => {
  await startCrossfadeFixture(page);
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    const reg = f.graph.registerMedia.bind(f.graph);
    f.graph.registerMedia = (...args: any[]) => {
      const el = args[0],
        play = el.play.bind(el);
      el.play = () =>
        new Promise<void>((resolve, reject) =>
          setTimeout(() => play().then(resolve, reject), 450),
        );
      return reg(...args);
    };
    const next = f.api.nextVideo;
    f.api.nextVideo = () => {
      f.beforeNext = {
        main: f.main.currentTime,
        aux: f.aux[0].currentTime,
        delta: f.main.currentTime - f.aux[0].currentTime,
        count: f.graph.auxiliaryMediaCount,
      };
      return next();
    };
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(1);
  const result = await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    const r = { ...f.beforeNext, nexts: f.nexts };
    f.renderer.stop();
    void f.context.close();
    return r;
  });
  await saveReviewProbe('delayed-play-alignment', result);
  console.log('ALIGNMENT', JSON.stringify(result));
  expect(
    Math.abs(result.delta),
    'the approved handoff requires <=100ms A alignment',
  ).toBeLessThanOrEqual(0.1);
});
for (const event of ['waiting', 'stalled'])
  test(`native ${event} during real overlap must retire outgoing immediately`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page);
    await expect
      .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
        timeout: 7000,
        intervals: [20],
      })
      .toBe(1);
    await page.waitForTimeout(120);
    const result = await page.evaluate((event) => {
      const f = (window as any).crossfadeFixture;
      const before = {
        count: f.graph.auxiliaryMediaCount,
        main: f.main.currentTime,
        aux: f.aux[0].currentTime,
      };
      f.main.dispatchEvent(new Event(event));
      const after = {
        count: f.graph.auxiliaryMediaCount,
        paused: f.aux[0].paused,
        main: f.main.currentTime,
        aux: f.aux[0].currentTime,
      };
      f.renderer.stop();
      void f.context.close();
      return { event, before, after };
    }, event);
    await saveReviewProbe(`${event}-cancellation`, result);
    console.log('BUFFERING', JSON.stringify(result));
    expect(result.before.count).toBe(1);
    expect(result.after.count).toBe(0);
    expect(result.after.paused).toBe(true);
  });

test('default handoff uses approved bounded seven-second lead rather than saved ten-second ceiling', async ({
  page,
}) => {
  await startCrossfadeFixture(page, { config: { enabled: false } });
  const rate = 48000,
    seconds = 20,
    n = rate * seconds,
    body = Buffer.alloc(44 + n * 2);
  body.write('RIFF', 0);
  body.writeUInt32LE(body.length - 8, 4);
  body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(rate, 24);
  body.writeUInt32LE(rate * 2, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write('data', 36);
  body.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    body.writeInt16LE(
      Math.round(0.1 * 32767 * Math.sin((2 * Math.PI * 500 * i) / rate)),
      44 + i * 2,
    );
  await page.unroute('https://media.eq.fixture.invalid/**');
  await page.route('https://media.eq.fixture.invalid/**', async (route) => {
    const range = route
        .request()
        .headers()
        ['range']?.match(/^bytes=(\d+)-(\d*)$/),
      start = range ? Number(range[1]) : 0,
      end =
        range && range[2]
          ? Math.min(Number(range[2]), body.length - 1)
          : body.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: 'audio/wav',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        ...(range
          ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` }
          : {}),
      },
      body: body.subarray(start, end + 1),
    });
  });
  const setup = await page.evaluate(async () => {
    const f = (window as any).crossfadeFixture;
    const main = f.main as HTMLMediaElement;
    const ready = () =>
      main.currentSrc === 'https://media.eq.fixture.invalid/a20.wav' &&
      main.duration === 20 &&
      main.readyState >= 2 &&
      main.seekable.length > 0 &&
      !main.seeking &&
      !main.paused &&
      f.context.state === 'running';
    const waitForMedia = async (events: string[], action: () => unknown) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onEvent = () => {},
        onError = () => {};
      let settled = false;
      try {
        await new Promise<void>((resolve, reject) => {
          let eventSeen = false,
            actionDone = false;
          const check = () => {
            if (!settled && eventSeen && actionDone && ready()) resolve();
          };
          onEvent = () => {
            eventSeen = true;
            check();
          };
          onError = () => {
            if (!settled) reject(new Error('Owned A20 media readiness failed'));
          };
          for (const event of events) main.addEventListener(event, onEvent);
          main.addEventListener('error', onError);
          timer = setTimeout(onError, 5000);
          try {
            Promise.resolve(action()).then(() => {
              actionDone = true;
              check();
            }, onError);
          } catch {
            onError();
          }
        });
      } finally {
        settled = true;
        clearTimeout(timer);
        for (const event of events) main.removeEventListener(event, onEvent);
        main.removeEventListener('error', onError);
      }
    };
    main.pause();
    await waitForMedia(
      ['loadedmetadata', 'loadeddata', 'canplay', 'playing'],
      () => {
        main.src = 'https://media.eq.fixture.invalid/a20.wav';
        return main.play();
      },
    );
    await waitForMedia(['seeked'], () => {
      main.currentTime = 9.5;
    });
    const next = f.api.nextVideo;
    f.api.nextVideo = () => {
      f.beforeNext = {
        main: f.main.currentTime,
        duration: f.main.duration,
        remaining: f.main.duration - f.main.currentTime,
        aux: f.aux[0].currentTime,
      };
      return next();
    };
    const names = [
      'getVideoData',
      'getPlayerResponse',
      'getPlayerState',
      'getCurrentTime',
      'getPlaybackRate',
      'nextVideo',
    ];
    const references = names.map((name) => f.api[name]);
    const witness = () => ({
      main: main.currentTime,
      duration: main.duration,
      remaining: main.duration - main.currentTime,
      readyState: main.readyState,
      seekableRanges: main.seekable.length,
      seeking: main.seeking,
      paused: main.paused,
      sourceIsA20:
        main.currentSrc === 'https://media.eq.fixture.invalid/a20.wav',
      contextRunning: f.context.state === 'running',
      nexts: f.nexts,
      methodsStable: Object.fromEntries(
        names.map((name, i) => [name, f.api[name] === references[i]]),
      ),
    });
    const disabledStart = witness();
    if (!ready() || f.nexts !== 0 || f.renderer.config.enabled !== false)
      throw new Error('Owned disabled9.5 precondition failed');
    await waitForMedia(['seeked'], () => {
      main.currentTime = 12.5;
    });
    const beforeEnable = witness();
    if (
      !ready() ||
      f.nexts !== 0 ||
      f.renderer.config.enabled !== false ||
      !(beforeEnable.remaining > 7 && beforeEnable.remaining < 10) ||
      !Object.values(beforeEnable.methodsStable).every((same) => same === true)
    )
      throw new Error('Owned pre-enable lead boundary invalid');
    f.setConfig({ enabled: true });
    if (
      f.renderer.config.fadeInDuration !== 5000 ||
      f.renderer.config.fadeOutDuration !== 5000 ||
      f.renderer.config.secondsBeforeEnd !== 10
    )
      throw new Error('Owned production defaults changed');
    f.main.dispatchEvent(new Event('timeupdate'));
    return { disabledStart, beforeEnable, productionDefaultsVerified: true };
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(1);
  const result = await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    const r = { ...f.beforeNext, nexts: f.nexts };
    f.renderer.stop();
    void f.context.close();
    return r;
  });
  const observation = { ...result, setup };
  await saveReviewProbe('default-lead', observation);
  console.log('LEAD', JSON.stringify(observation));
  expect(
    result.remaining,
    'lead=min(10,max(5000,5000)/1000+2)=7 seconds',
  ).toBeLessThanOrEqual(7);
});

for (const mode of ['user-command', 'timeout'])
  test(`bounded A realignment ${mode} retires exact listeners and cannot invoke next`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page);
    await page.evaluate((mode) => {
      const f = (window as any).crossfadeFixture,
        register = f.graph.registerMedia.bind(f.graph);
      f.graph.registerMedia = (...args: any[]) => {
        const element = args[0] as HTMLMediaElement,
          play = element.play.bind(element);
        element.play = () =>
          new Promise<void>((resolve, reject) =>
            setTimeout(() => play().then(resolve, reject), 450),
          );
        const current = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          'currentTime',
        )!;
        let seeks = 0;
        Object.defineProperty(element, 'currentTime', {
          get() {
            return current.get!.call(element);
          },
          set(value) {
            seeks++;
            if (seeks === 2) {
              f.realignCancelled = true;
              if (mode === 'user-command') f.manual();
            } else current.set!.call(element, value);
          },
        });
        const add = element.addEventListener.bind(element),
          remove = element.removeEventListener.bind(element),
          listeners = new Set<EventListenerOrEventListenerObject>();
        element.addEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (['seeked', 'error', 'pause'].includes(type))
            listeners.add(listener);
          add(type, listener, options);
        }) as typeof element.addEventListener;
        element.removeEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions,
        ) => {
          listeners.delete(listener);
          remove(type, listener, options);
        }) as typeof element.removeEventListener;
        f.alignmentListeners = listeners;
        return register(...args);
      };
    }, mode);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as any).crossfadeFixture.realignCancelled,
          ),
        { timeout: 7000, intervals: [20] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as any).crossfadeFixture.graph.auxiliaryMediaCount,
          ),
        { timeout: 700, intervals: [20] },
      )
      .toBe(0);
    expect(
      await page.evaluate(() => {
        const f = (window as any).crossfadeFixture;
        return {
          count: f.graph.auxiliaryMediaCount,
          nexts: f.nexts,
          paused: f.aux[0].paused,
          listeners: f.alignmentListeners.size,
          volume: f.main.volume,
        };
      }),
    ).toEqual({ count: 0, nexts: 0, paused: true, listeners: 0, volume: 0.65 });
  });

// R3 paired generation controls; read3 audits the adjacent handoff tail getter.
for (const atRead of [1, 2, 3])
  test(`metadata episode reentry at auxiliary clock read ${atRead} preserves successor generation`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page, { config: { secondsBeforeEnd: 2.5 } });
    await page.evaluate((atRead) => {
      const f = (window as any).crossfadeFixture,
        register = f.graph.registerMedia.bind(f.graph);
      f.rotated = false;
      f.clockReads = 0;
      f.graph.registerMedia = (...args: any[]) => {
        const el = args[0],
          current = Object.getOwnPropertyDescriptor(
            HTMLMediaElement.prototype,
            'currentTime',
          )!;
        if (!f.rotated)
          Object.defineProperty(el, 'currentTime', {
            get() {
              f.clockReads++;
              const time = current.get!.call(el);
              if (!f.rotated && f.clockReads === atRead) {
                f.rotated = true;
                f.api.dispatchEvent(new Event('videodatachange'));
                f.main.dispatchEvent(new Event('timeupdate'));
              }
              return time;
            },
            set(value) {
              current.set!.call(el, value);
            },
          });
        return register(...args);
      };
    }, atRead);
    await expect
      .poll(
        () => page.evaluate(() => (window as any).crossfadeFixture.rotated),
        { timeout: 7000, intervals: [20] },
      )
      .toBe(true);
    await page.waitForTimeout(350);
    const result = await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      const result = {
        rotated: f.rotated,
        reads: f.clockReads,
        requests: f.requests,
        nexts: f.nexts,
        registered: f.aux.length,
        count: f.graph.auxiliaryMediaCount,
      };
      f.renderer.stop();
      void f.context.close();
      return result;
    });
    await saveReviewProbe(`reentry-clock-${atRead}`, result);
    expect(result.requests).toBe(2);
    expect(
      result.nexts,
      'old generation must not cancel the newer prepared episode',
    ).toBe(1);
  });

test('handoff gain callout reentry preserves the newer episode and its resources', async ({
  page,
}) => {
  await startCrossfadeFixture(page, { config: { secondsBeforeEnd: 2.5 } });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture,
      insert = f.graph.insertMain.bind(f.graph);
    f.rotated = false;
    f.graph.insertMain = (input: GainNode, output: GainNode) => {
      const set = input.gain.setValueAtTime.bind(input.gain);
      input.gain.setValueAtTime = (value: number, time: number) => {
        const result = set(value, time);
        if (value === 0 && !f.rotated) {
          f.rotated = true;
          f.api.dispatchEvent(new Event('videodatachange'));
          f.main.dispatchEvent(new Event('timeupdate'));
        }
        return result;
      };
      return insert(input, output);
    };
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.rotated), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(true);
  await page.waitForTimeout(350);
  const result = await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    const result = {
      requests: f.requests,
      nexts: f.nexts,
      registered: f.aux.length,
      count: f.graph.auxiliaryMediaCount,
    };
    f.renderer.stop();
    void f.context.close();
    return result;
  });
  expect(result.requests).toBe(2);
  expect(
    result.nexts,
    'old gain callout must not cancel the newer episode',
  ).toBe(1);
  expect(result.registered).toBe(2);
  expect(result.count).toBe(1);
});
