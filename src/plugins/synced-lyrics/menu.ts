import prompt from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';

import { providerNames } from './providers';

import type { SyncedLyricsPluginConfig } from './types';
import type { MenuContext } from '@/types/contexts';
import type { MenuItemConstructorOptions } from 'electron';

export const menu = async (
  ctx: MenuContext<SyncedLyricsPluginConfig>,
): Promise<MenuItemConstructorOptions[]> => {
  const config = await ctx.getConfig();
  let confirmedExport = config.enableDownload !== false;
  let requestedExport = confirmedExport;
  let requestId = 0;
  let pendingWrite: Promise<void> = Promise.resolve();

  const updateExportVisibility = (item?: { checked?: boolean }) => {
    const enabled =
      typeof item?.checked === 'boolean' ? item.checked : !requestedExport;
    const thisRequest = ++requestId;
    requestedExport = enabled;

    const write = async (): Promise<boolean> => {
      try {
        await ctx.setConfig({ enableDownload: enabled });
        confirmedExport = enabled;
        if (thisRequest === requestId) {
          requestedExport = enabled;
          if (item) item.checked = enabled;
        }
      } catch (writeError) {
        let persisted = confirmedExport;
        let readError: unknown;
        try {
          persisted = (await ctx.getConfig()).enableDownload !== false;
          confirmedExport = persisted;
        } catch (error) {
          readError = error;
        }

        if (thisRequest === requestId) {
          requestedExport = persisted;
          if (item) item.checked = persisted;
        }

        try {
          await ctx.refresh();
        } catch (error) {
          console.error(
            '[synced-lyrics] Failed to refresh menu after export preference rejection',
            error,
          );
        }
        console.error(
          '[synced-lyrics] Failed to save export visibility preference',
          writeError,
        );
        if (readError !== undefined)
          console.error(
            '[synced-lyrics] Failed to read export visibility preference after rejection',
            readError,
          );
        return false;
      }

      try {
        await ctx.refresh();
      } catch (error) {
        console.error(
          '[synced-lyrics] Failed to refresh menu after saving export preference',
          error,
        );
      }
      return true;
    };

    const operation = pendingWrite.then(write, write);
    pendingWrite = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };

  return [
    {
      label: t('plugins.synced-lyrics.menu.direct-ytmusic.label'),
      toolTip: t('plugins.synced-lyrics.menu.direct-ytmusic.tooltip'),
      type: 'checkbox',
      checked: config.useYTMLyricsWithoutProxy === true,
      click(item) {
        if (ctx.window.isDestroyed()) return;
        return ctx.setConfig({
          useYTMLyricsWithoutProxy: item.checked === true,
        });
      },
    },
    {
      label: t('plugins.synced-lyrics.tools.offset'),
      async click() {
        const current = await ctx.getConfig();
        if (ctx.window.isDestroyed()) return;
        const output: unknown = await prompt(
          {
            title: t('plugins.synced-lyrics.tools.offset'),
            label: t('plugins.synced-lyrics.tools.offset-help'),
            type: 'counter',
            value: String(current.timingOffsetMs ?? 0),
            counterOptions: {
              minimum: -30000,
              maximum: 30000,
              multiFire: true,
            },
            ...promptOptions(),
          },
          ctx.window,
        );
        if (
          ctx.window.isDestroyed() ||
          output === null ||
          output === undefined ||
          (typeof output !== 'number' && typeof output !== 'string') ||
          (typeof output === 'string' && !output.trim())
        )
          return;
        const value = Number(output);
        if (Number.isFinite(value) && Math.abs(value) <= 30000)
          await ctx.setConfig({ timingOffsetMs: value });
      },
    },
    {
      label: t('plugins.synced-lyrics.tools.romanization-size'),
      type: 'submenu',
      submenu: [50, 70, 100, 125].map((size) => ({
        label: `${size}%`,
        type: 'radio' as const,
        checked: (config.romanizationSizePercent ?? 70) === size,
        click: () => ctx.setConfig({ romanizationSizePercent: size }),
      })),
    },
    {
      label: t('plugins.synced-lyrics.tools.show-export.label'),
      toolTip: t('plugins.synced-lyrics.tools.show-export.tooltip'),
      type: 'checkbox',
      checked: config.enableDownload !== false,
      click: updateExportVisibility,
    },
    {
      label: t('plugins.synced-lyrics.tools.enhanced-lrc'),
      toolTip: t('plugins.synced-lyrics.tools.enhanced-lrc-help'),
      type: 'checkbox',
      checked: config.enhancedLrc === true,
      click: (item) => ctx.setConfig({ enhancedLrc: item.checked }),
    },
    {
      label: t('plugins.synced-lyrics.menu.preferred-provider.label'),
      toolTip: t('plugins.synced-lyrics.menu.preferred-provider.tooltip'),
      type: 'submenu',
      submenu: [
        {
          label: t('plugins.synced-lyrics.menu.preferred-provider.none.label'),
          toolTip: t(
            'plugins.synced-lyrics.menu.preferred-provider.none.tooltip',
          ),
          type: 'radio',
          checked: config.preferredProvider === undefined,
          click() {
            ctx.setConfig({ preferredProvider: undefined });
          },
        },
        ...providerNames.map(
          (provider) =>
            ({
              label: provider,
              type: 'radio',
              checked: config.preferredProvider === provider,
              click() {
                ctx.setConfig({ preferredProvider: provider });
              },
            }) as const,
        ),
      ],
    },
    {
      label: t('plugins.synced-lyrics.menu.precise-timing.label'),
      toolTip: t('plugins.synced-lyrics.menu.precise-timing.tooltip'),
      type: 'checkbox',
      checked: config.preciseTiming,
      click(item) {
        ctx.setConfig({
          preciseTiming: item.checked,
        });
      },
    },
    {
      label: t('plugins.synced-lyrics.menu.line-effect.label'),
      toolTip: t('plugins.synced-lyrics.menu.line-effect.tooltip'),
      type: 'submenu',
      submenu: [
        {
          label: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.fancy.label',
          ),
          toolTip: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.fancy.tooltip',
          ),
          type: 'radio',
          checked: config.lineEffect === 'fancy',
          click() {
            ctx.setConfig({
              lineEffect: 'fancy',
            });
          },
        },
        {
          label: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.scale.label',
          ),
          toolTip: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.scale.tooltip',
          ),
          type: 'radio',
          checked: config.lineEffect === 'scale',
          click() {
            ctx.setConfig({
              lineEffect: 'scale',
            });
          },
        },
        {
          label: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.offset.label',
          ),
          toolTip: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.offset.tooltip',
          ),
          type: 'radio',
          checked: config.lineEffect === 'offset',
          click() {
            ctx.setConfig({
              lineEffect: 'offset',
            });
          },
        },
        {
          label: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.focus.label',
          ),
          toolTip: t(
            'plugins.synced-lyrics.menu.line-effect.submenu.focus.tooltip',
          ),
          type: 'radio',
          checked: config.lineEffect === 'focus',
          click() {
            ctx.setConfig({
              lineEffect: 'focus',
            });
          },
        },
      ],
    },
    {
      label: t('plugins.synced-lyrics.menu.romanization.label'),
      toolTip: t('plugins.synced-lyrics.menu.romanization.tooltip'),
      type: 'checkbox',
      checked: config.romanization,
      click(item) {
        ctx.setConfig({
          romanization: item.checked,
        });
      },
    },
    {
      label: t('plugins.synced-lyrics.menu.convert-chinese-character.label'),
      toolTip: t(
        'plugins.synced-lyrics.menu.convert-chinese-character.tooltip',
      ),
      type: 'submenu',
      submenu: [
        {
          label: t(
            'plugins.synced-lyrics.menu.convert-chinese-character.submenu.disabled.label',
          ),
          toolTip: t(
            'plugins.synced-lyrics.menu.convert-chinese-character.submenu.disabled.tooltip',
          ),
          type: 'radio',
          checked:
            config.convertChineseCharacter === 'disabled' ||
            config.convertChineseCharacter === undefined,
          click() {
            ctx.setConfig({
              convertChineseCharacter: 'disabled',
            });
          },
        },
        {
          label: t(
            'plugins.synced-lyrics.menu.convert-chinese-character.submenu.simplified-to-traditional.label',
          ),
          toolTip: t(
            'plugins.synced-lyrics.menu.convert-chinese-character.submenu.simplified-to-traditional.tooltip',
          ),
          type: 'radio',
          checked: config.convertChineseCharacter === 'simplifiedToTraditional',
          click() {
            ctx.setConfig({
              convertChineseCharacter: 'simplifiedToTraditional',
            });
          },
        },
        {
          label: t(
            'plugins.synced-lyrics.menu.convert-chinese-character.submenu.traditional-to-simplified.label',
          ),
          toolTip: t(
            'plugins.synced-lyrics.menu.convert-chinese-character.submenu.traditional-to-simplified.tooltip',
          ),
          type: 'radio',
          checked: config.convertChineseCharacter === 'traditionalToSimplified',
          click() {
            ctx.setConfig({
              convertChineseCharacter: 'traditionalToSimplified',
            });
          },
        },
      ],
    },
    {
      label: t('plugins.synced-lyrics.menu.show-time-codes.label'),
      toolTip: t('plugins.synced-lyrics.menu.show-time-codes.tooltip'),
      type: 'checkbox',
      checked: config.showTimeCodes,
      click(item) {
        ctx.setConfig({
          showTimeCodes: item.checked,
        });
      },
    },
    {
      label: t('plugins.synced-lyrics.menu.show-lyrics-even-if-inexact.label'),
      toolTip: t(
        'plugins.synced-lyrics.menu.show-lyrics-even-if-inexact.tooltip',
      ),
      type: 'checkbox',
      checked: config.showLyricsEvenIfInexact,
      click(item) {
        ctx.setConfig({
          showLyricsEvenIfInexact: item.checked,
        });
      },
    },
  ];
};
