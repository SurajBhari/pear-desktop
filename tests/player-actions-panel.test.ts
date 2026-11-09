import { test, expect } from '@playwright/test';
import { playerActionsFixture } from './helpers/player-actions-fixture';

test('the panel cog survives nested volume-container and entire layout replacement', async () => {
  const f = await playerActionsFixture();
  try {
    f.source.registerPlayerPanelSection({
      id: 'test',
      title: 'Test',
      root: f.dom.document.createElement('div'),
    });
    expect(f.dom.document.querySelectorAll('.pbg-cog')).toHaveLength(1);
    f.dom.document.querySelector('.volume-container')!.remove();
    await f.settle();
    expect(f.dom.document.querySelectorAll('.pbg-cog')).toHaveLength(1);
    f.dom.document.querySelector('ytmusic-app-layout')!.remove();
    const layout = f.dom.document.createElement('ytmusic-app-layout');
    layout.innerHTML = '<ytmusic-player-bar></ytmusic-player-bar>';
    f.dom.document.body.append(layout);
    await f.settle();
    expect(f.dom.document.querySelectorAll('.pbg-cog')).toHaveLength(1);
  } finally {
    f.source.unregisterPlayerPanelSection('test');
    await f.close();
  }
});

test('keyboard panel launch focuses a control and Escape restores focus to its cog', async () => {
  const f = await playerActionsFixture();
  const input = f.dom.document.createElement('input');
  const root = f.dom.document.createElement('div');
  root.append(input);
  try {
    f.source.registerPlayerPanelSection({ id: 'test', title: 'Test', root });
    const cog = f.dom.document.querySelector('.pbg-cog')! as any;
    cog.focus();
    cog.click();
    expect(f.dom.document.activeElement).toBe(input);
    f.dom.document.dispatchEvent(
      new f.dom.KeyboardEvent('keydown', { key: 'Escape' }),
    );
    expect(f.dom.document.querySelector('.pbg-panel')).toBeNull();
    expect(f.dom.document.activeElement).toBe(cog);
    f.source.unregisterPlayerPanelSection('test');
    expect(f.activeObservers.size).toBe(0);
    expect(f.intervals.size).toBe(0);
    expect(f.listenerSets.get('keydown')?.size ?? 0).toBe(0);
    expect(f.listenerSets.get('click')?.size ?? 0).toBe(0);
  } finally {
    f.source.unregisterPlayerPanelSection('test');
    await f.close();
  }
});

test('playback-speed owns replacement popup/video hooks and repeated toggles leave no Solid owners', async () => {
  const f = await playerActionsFixture();
  try {
    for (let i = 0; i < 20; i++) {
      f.source.playbackSpeed.onPlayerApiReady();
      f.source.playbackSpeed.onUnload();
      expect(f.speedDisposals).toBe(i + 1);
      expect(f.activeObservers.size).toBe(0);
    }
    f.source.playbackSpeed.onPlayerApiReady();
    f.speedControls
      .at(-1)
      .onImmediateValueChanged(
        new f.dom.CustomEvent('change', { detail: { value: 1.5 } }),
      );
    f.drainRates();
    f.media.remove();
    f.dom.document
      .querySelector('#movie_player')!
      .append(f.dom.document.createElement('video'));
    const newVideo = f.video();
    await f.settle();
    expect(newVideo.playbackRate).toBe(1.5);
    f.dom.document.querySelector('ytmusic-popup-container')!.remove();
    const popup = f.dom.document.createElement('ytmusic-popup-container');
    popup.innerHTML =
      '<ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer>';
    f.dom.document.body.append(popup);
    await f.settle();
    expect(
      popup.querySelector('ytmusic-menu-popup-renderer')!.children.length,
    ).toBe(1);
    f.source.playbackSpeed.onUnload();
    expect(f.activeObservers.size).toBe(0);
  } finally {
    await f.close();
  }
});

for (const height of [425, 360])
  test(`native real-CSS panel stays accessible at 325x${height}`, async ({
    page,
  }) => {
    const [
      { build },
      { mkdtemp, rm, writeFile, readFile },
      { tmpdir },
      { default: path },
    ] = await Promise.all([
      import('vite'),
      import('node:fs/promises'),
      import('node:os'),
      import('node:path'),
    ]);
    const root = path.resolve(import.meta.dirname, '..');
    const directory = await mkdtemp(path.join(tmpdir(), 'pear-panel-css-'));
    try {
      const entry = path.join(directory, 'entry.ts');
      await writeFile(
        entry,
        `import plugin from ${JSON.stringify(path.join(root, 'src/plugins/player-actions/index.ts'))};window.panelFixture=plugin;`,
      );
      const english = JSON.parse(
        await readFile(path.join(root, 'src/i18n/resources/en.json'), 'utf8'),
      );
      const output = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'native-panel-boundaries',
            enforce: 'pre',
            resolveId(id: string) {
              if (
                ['@/i18n', '@/utils', '@/providers/song-info-front'].includes(
                  id,
                )
              )
                return '\0' + id;
              if (id.startsWith('@/'))
                return path.join(root, 'src', id.slice(2)) + '.ts';
              return undefined;
            },
            load(id: string) {
              if (id === '\0@/utils')
                return 'export const createPlugin=value=>value;';
              if (id === '\0@/providers/song-info-front')
                return 'export const getSongInfo=()=>({});';
              if (id === '\0@/i18n')
                return `const en=${JSON.stringify(english)};export const t=key=>key.split('.').reduce((value,part)=>value?.[part],en)??key;`;
              return undefined;
            },
          },
        ],
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ['iife'], name: 'panelFixture' },
        },
      });
      const bundle = Array.isArray(output) ? output[0] : output;
      if (!('output' in bundle))
        throw new Error('Expected native panel bundle output');
      const chunk = bundle.output.find((item) => item.type === 'chunk');
      if (!chunk || chunk.type !== 'chunk')
        throw new Error('Expected native panel JavaScript');
      const code = chunk.code;
      await page.setViewportSize({ width: 325, height });
      await page.setContent(
        '<style>body{margin:0;background:#181818}ytmusic-player-bar{position:fixed;bottom:0;height:72px;display:flex;align-items:center;width:100%}#movie_player{display:none}</style><ytmusic-app-layout><ytmusic-player-bar><div id="volume-slider"></div></ytmusic-player-bar></ytmusic-app-layout><div id="movie_player"><video></video></div>',
      );
      await page.addScriptTag({ content: code });
      await page.evaluate(async () => {
        const w = window as any;
        await w.panelFixture.renderer.start({
          getConfig: async () => ({ ...w.panelFixture.config, enabled: true }),
          setConfig: async () => {},
        });
        w.panelFixture.renderer.onPlayerApiReady({
          getPlayerResponse: () => ({ videoDetails: { videoId: 'A' } }),
          getVideoData: () => ({ video_id: 'A' }),
        });
      });
      await page
        .getByRole('button', { name: 'Player Actions', exact: true })
        .click();
      const panel = page.getByRole('dialog', { name: 'Player Actions' });
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(325);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      await expect(
        page.getByRole('slider', { name: 'Speed', exact: true }),
      ).toBeVisible();
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await page.evaluate(() => (window as any).panelFixture.renderer.stop());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
