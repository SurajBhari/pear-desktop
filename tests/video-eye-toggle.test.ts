import { test, expect } from '@playwright/test';
import { videoEyeBundle } from './helpers/video-eye-toggle';

let source: string;
test.beforeAll(async () => {
  source = await videoEyeBundle();
});
test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="mount"></div>');
  await page.addScriptTag({ content: source });
  await page.addStyleTag({
    content: await page.evaluate(() => (window as any).eyeStyles.join('\n')),
  });
  await page.evaluate(() =>
    document.body.classList.add('video-toggle-custom-mode'),
  );
});

test('one named native button reflects persisted state and supports keyboard activation', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).mountEye(false));
  const button = page.getByRole('button', { name: 'Video', exact: true });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('title', 'Video');
  await expect(page.locator('input')).toHaveCount(0);
  await expect(button).toHaveCSS('width', '44px');
  await expect(button).toHaveCSS('height', '44px');
  await button.focus();
  await page.keyboard.press('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('title', 'Song');
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(
    await page.evaluate(() => [
      (window as any).eyeChanges,
      (window as any).eyeBubbles,
    ]),
  ).toEqual([[true, false], 0]);
});

test('external track/config state updates the icon without emitting another toggle', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).mountEye(true));
  const button = page.getByRole('button', { name: 'Video', exact: true });
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as any).eyeFixture.setVisible(false));
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await button.click();
  expect(await page.evaluate(() => (window as any).eyeChanges)).toEqual([true]);
  await page.evaluate(() => (window as any).eyeFixture.dispose());
  await expect(button).toHaveCount(0);
});

async function startPlugin(
  page: import('@playwright/test').Page,
  hidden: boolean,
) {
  await page.evaluate(async (hidden) => {
    document.body.innerHTML =
      '<ytmusic-player id="player"><div id="song-video" class="ytmusic-player"></div><div id="song-image"><img id="img" class="style-scope yt-img-shadow"></div><video></video></ytmusic-player>';
    const win = window as any;
    win.eyeWrites = [];
    win.mainConfig = {
      plugins: {
        isEnabled: async () => false,
        setOptions: (_id: string, value: any) =>
          win.eyeWrites.push({ ...value }),
      },
    };
    const config = {
      ...win.eyePlugin.config,
      enabled: true,
      hideVideo: hidden,
    };
    win.eyeApi = {
      getPlayerResponse: () => ({
        videoDetails: {
          musicVideoType: 'MUSIC_VIDEO_TYPE_OMV',
          thumbnail: { thumbnails: [] },
        },
      }),
    };
    await win.eyePlugin.renderer.start({ getConfig: async () => config });
    await win.eyePlugin.renderer.onPlayerApiReady(win.eyeApi, {
      getConfig: async () => config,
    });
  }, hidden);
  await expect(
    page.locator('#ytmd-video-toggle-switch-button-container'),
  ).toBeAttached();
}

test('actual custom plugin synchronizes the eye, media visibility and saved choice', async ({
  page,
}) => {
  await startPlugin(page, true);
  const button = page.getByRole('button', { name: 'Video', exact: true });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#song-video')).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(
    await page.evaluate(() => (window as any).eyeWrites.at(-1).hideVideo),
  ).toBe(false);
  await expect(page.locator('#player')).toHaveAttribute(
    'playback-mode',
    'OMV_PREFERRED',
  );
  await page.evaluate(() => {
    const win = window as any;
    win.eyeApi.getPlayerResponse = () => ({
      videoDetails: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    });
    document
      .querySelector('video')!
      .dispatchEvent(new Event('peard:src-changed'));
  });
  await expect(button).toBeHidden();
  await expect(page.locator('#player')).toHaveAttribute(
    'playback-mode',
    'ATV_PREFERRED',
  );
  expect(
    await page.evaluate(() => (window as any).eyeWrites.at(-1).hideVideo),
  ).toBe(true);
});

for (const background of ['#fff', '#111']) {
  test(`keyboard focus changes rendered pixels over ${background} media without moving the control`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 260, height: 150 });
    await page.addStyleTag({
      content: `html,body { background: ${background}; }`,
    });
    await page.evaluate(() => (window as any).mountEye(false));
    await page.mouse.move(0, 0);
    const button = page.getByRole('button', { name: 'Video', exact: true });
    const bounds = await button.boundingBox();
    const before = await page.screenshot({
      clip: { x: 5, y: 15, width: 80, height: 80 },
    });
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    expect(
      await button.evaluate((element) => element.matches(':focus-visible')),
    ).toBe(true);
    const after = await page.screenshot({
      clip: { x: 5, y: 15, width: 80, height: 80 },
    });
    expect(after.equals(before)).toBe(false);
    expect(await button.boundingBox()).toEqual(bounds);
  });
}
