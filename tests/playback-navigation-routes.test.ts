import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { shortcutRatingSource } from './helpers/shortcut-rating-source';
import { musicModuleSource } from './helpers/api-music-source';
import { navigationFixture } from './helpers/playback-navigation-fixture';

for (const route of ['local', 'global', 'media', 'mpris'] as const) {
  test(`actual ${route} Previous adapter feeds the source IPC occurrence permission`, async ({
    page,
  }) => {
    let messages: unknown[][] = [];
    if (route === 'mpris') {
      const source: any = await musicModuleSource(
        'src/providers/song-controls.ts',
      );
      const controls = source.getSongControls({
        webContents: { send: (...args: unknown[]) => messages.push(args) },
      });
      const text = await readFile(
        new URL('../src/plugins/shortcuts/mpris.ts', import.meta.url),
        'utf8',
      );
      const start = text.indexOf("player.on('previous'");
      const end = text.indexOf("player.on('seek'", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      let invoke: (() => void) | undefined;
      new Function('player', 'previous', text.slice(start, end))(
        {
          on: (name: string, fn: () => void) => {
            if (name === 'previous') invoke = fn;
          },
        },
        controls.previous,
      );
      invoke!();
    } else {
      const f = await shortcutRatingSource();
      try {
        f.config.overrideMediaKeys = route === 'media';
        f.config[route === 'local' ? 'local' : 'global'].previous = 'F8';
        await f.source.backend.start(f.context);
        if (route === 'local') f.input('keyDown');
        const map = route === 'local' ? f.state.local : f.state.global;
        const invoke = map.get(route === 'media' ? 'MediaPreviousTrack' : 'F8');
        expect(invoke).toBeDefined();
        invoke();
        messages = f.sent;
      } finally {
        await f.close();
      }
    }
    expect(messages).toEqual([['peard:previous-video']]);
    await navigationFixture(page);
    const skips = await page.evaluate(() => {
      const w = window as any;
      w.previousCommand();
      return w.state.skips;
    });
    expect(skips).toEqual([{ id: 'trackA00001', index: 4 }]);
  });
}
