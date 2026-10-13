import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { build } from 'vite';
import solid from 'vite-plugin-solid';

test('actual Solid settings persist independent preferences, choose offered variant and show local uncertain/error states accessibly', async ({
  page,
}) => {
  const root = path.resolve(import.meta.dirname, '..');
  const temp = await mkdtemp(path.join(root, '.tmp-dl-ui-'));
  try {
    await writeFile(
      path.join(temp, 'i18n.ts'),
      `
import i18next from 'i18next';
import en from ${JSON.stringify(path.join(root, 'src/i18n/resources/en.json'))};
import ru from ${JSON.stringify(path.join(root, 'src/i18n/resources/ru.json'))};
const instance=i18next.createInstance();instance.init({initImmediate:false,lng:window.fixtureLanguage??'en',fallbackLng:'en',resources:{en:{translation:en},ru:{translation:ru}},interpolation:{escapeValue:false}});
export const t=instance.t.bind(instance);
`,
    );
    const entry = path.join(temp, 'entry.tsx');
    await writeFile(
      entry,
      `
 import {render} from 'solid-js/web';
 import {DownloaderSettings} from ${JSON.stringify(path.join(root, 'src/plugins/downloader/settings.tsx'))};
 import {describeAudioFormats} from ${JSON.stringify(path.join(root, 'src/plugins/downloader/audio.ts'))};
 const formats=describeAudioFormats([{itag:251,mime_type:'audio/webm; codecs="opus"',has_audio:true,has_video:false,content_length:3,bitrate:153000},{itag:774,mime_type:'audio/webm; codecs="opus"',has_audio:true,has_video:false}]);
 window.calls=[];
 const dialog=document.createElement('dialog');dialog.className='pear-downloader-settings';dialog.setAttribute('aria-labelledby','pear-downloader-heading');document.body.append(dialog);
 render(()=> <DownloaderSettings initial={{config:{enabled:true,selectedPreset:'Source',customPresetSetting:{extension:'flac',ffmpegArgs:[]},skipExisting:false}}} api={{currentUrl:()=> 'https://fixture.test/watch?v=owned',close:()=>dialog.close(),invoke:async(event,...args)=>{window.calls.push({event,args});if(event==='downloader-formats')return {id:'owned',title:'Owned track — 音楽',formats};if(event==='downloader-selected')return {status:'saved',path:'owned.webm'};if(event==='downloader-scan'){if(window.failScan)throw Error('Unreadable selected folder');return {visited:1,truncated:false,errors:[],files:[{path:'legacy.flac',status:'uncertain',reason:'Unknown source quality',size:100}]};}return {};}}}/>,dialog);dialog.showModal();
 `,
    );
    const result = await build({
      configFile: false,
      resolve: { alias: { '@/i18n': path.join(temp, 'i18n.ts') } },
      root,
      plugins: [solid()],
      logLevel: 'silent',
      build: {
        write: false,
        lib: { entry, formats: ['iife'], name: 'DownloaderTest' },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!('output' in output)) throw new Error('UI bundle absent');
    const chunk = output.output.find((item) => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('UI chunk absent');
    await page.setViewportSize({ width: 480, height: 800 });
    await page.setContent(
      '<html><body><button id="outside">Outside</button></body></html>',
    );
    await page.addStyleTag({
      content: await readFile(
        path.join(root, 'src/plugins/downloader/style.css'),
        'utf8',
      ),
    });
    await page.addScriptTag({ content: chunk.code });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Source audio', exact: true })
      .selectOption('itag');
    await page.getByLabel('Requested itag').fill('251');
    await page
      .getByRole('combobox', { name: 'Saved format', exact: true })
      .selectOption('Custom');
    await page
      .getByRole('combobox', { name: 'When this track is already downloaded' })
      .selectOption('keep-better');
    await page
      .getByRole('button', { name: 'Save preferences', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('Preferences saved');
    const saved = await page.evaluate(
      () =>
        (
          window as unknown as { calls: { event: string; args: unknown[] }[] }
        ).calls.find((c) => c.event === 'downloader-save-settings')?.args[0],
    );
    expect(saved).toMatchObject({
      selectedPreset: 'Custom',
      sourceAudio: { mode: 'itag', itag: 251 },
      duplicatePolicy: 'keep-better',
    });
    await page.getByRole('dialog').evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({ path: '/tmp/pear-dl-settings-ui.png' });
    await page
      .getByRole('button', { name: 'Show available qualities', exact: true })
      .click();
    await expect(
      page.getByRole('combobox', { name: 'Available audio quality' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('combobox', { name: 'Available audio quality' })
        .locator('option')
        .last(),
    ).toHaveJSProperty('disabled', true);
    await page
      .getByRole('group', { name: 'Available audio for current track' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/pear-dl-chooser-ui.png' });
    await page
      .getByRole('button', { name: 'Download selected quality', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      'Saved selected variant',
    );
    await page
      .getByRole('button', { name: 'Scan download folder', exact: true })
      .click();
    await expect(
      page.getByText('Unknown source quality', { exact: false }),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { failScan: boolean }).failScan = true;
    });
    await page
      .getByRole('button', { name: 'Scan download folder', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'Unreadable selected folder',
    );
    expect(
      await page
        .getByRole('dialog')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: '/tmp/pear-dl-library-ui.png' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ content: 'window.fixtureLanguage="ru";' });
    await page.addStyleTag({
      content: await readFile(
        path.join(root, 'src/plugins/downloader/style.css'),
        'utf8',
      ),
    });
    await page.addScriptTag({ content: chunk.code });
    await expect(
      page.getByRole('heading', { name: 'Исходное аудио и библиотека' }),
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Язык аудио' }),
    ).toHaveValue('original');
    await expect(
      page.getByRole('combobox', { name: 'Язык аудио' }),
    ).toContainText('Оригинальная дорожка (автоматически)');
    await expect(
      page.getByRole('button', {
        name: 'Показать доступное качество',
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: '/tmp/pear-dl-settings-ru.png' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
