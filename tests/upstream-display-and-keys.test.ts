import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';

test('Discord shows the actual artist before genre tags', async () => {
  const raw = await readFile(
    new URL('../src/plugins/discord/discord-service.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw).replace(/^import[\s\S]*?;\n/gm, '');
  const source = await import(
    `data:text/javascript;base64,${Buffer.from('const padHangulFields=()=>{};const sanitizeActivityText=x=>x;const buildDiscordButtons=()=>[];const ActivityType={Listening:2};' + actual).toString('base64')}`
  );
  const value = source.DiscordService.prototype.buildActivityInfo(
    { title: 'Song', artist: 'The Artist', tags: ['Pop'], songDuration: 0 },
    { hideDurationLeft: true },
  );
  expect(value.state).toBe('The Artist');
});

test('album theme colors the home page body and removes cleanly', async ({
  page,
}) => {
  await page.setContent(
    '<style>body{background:rgb(1,2,3)}:root{--ytmusic-background:rgb(30,40,50)}</style><ytmusic-app-layout></ytmusic-app-layout>',
  );
  const style = await page.addStyleTag({
    content: await readFile(
      new URL('../src/plugins/album-color-theme/style.css', import.meta.url),
      'utf8',
    ),
  });
  expect(
    await page
      .locator('body')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(30, 40, 50)');
  await style.evaluate((el) => el.remove());
  expect(
    await page
      .locator('body')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(1, 2, 3)');
});

for (const linux of [false, true])
  for (const enabled of [false, true])
    for (const overrideMediaKeys of [false, true]) {
      test(`media-key feature switch linux=${linux} enabled=${enabled} override=${overrideMediaKeys}`, async () => {
        const source = await readFile(
          new URL('../src/index.ts', import.meta.url),
          'utf8',
        );
        const start = source.indexOf('const disabledFeatures =');
        const end = source.indexOf("if (config.get('options.proxy'))", start);
        const actual = stripTypeScriptTypes(source.slice(start, end));
        const switches: any[] = [];
        const app = {
          commandLine: {
            appendSwitch: (...args: any[]) => switches.push(args),
          },
          setName() {},
          disableHardwareAcceleration() {},
        };
        const config = {
          get: () => false,
          plugins: {
            getOptions: () => ({ enabled, overrideMediaKeys }),
            isEnabled: async () => false,
          },
        };
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        await new AsyncFunction('app', 'config', 'is', actual)(app, config, {
          linux: () => linux,
          dev: () => false,
        });
        const features = switches
          .find((x) => x[0] === 'disable-features')[1]
          .split(',');
        expect(features.includes('HardwareMediaKeyHandling')).toBe(
          !linux && enabled && overrideMediaKeys,
        );
      });
    }
