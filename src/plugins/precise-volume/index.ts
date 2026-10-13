import prompt, { type KeybindOptions } from 'custom-electron-prompt';
import { type MenuItem, type BrowserWindow } from 'electron';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';
import { createPlugin, createBackend } from '@/utils';
import { registerOwnedGlobalShortcut } from '@/utils/global-shortcut-owner';

import { overrideListener } from './override';
import { onConfigChange, onPlayerApiReady } from './renderer';
import hudStyle from './volume-hud.css?inline';

export type PreciseVolumePluginConfig = {
  enabled: boolean;
  /**
   * Percentage of volume to change
   */
  steps: number;
  /**
   * Enable ArrowUp + ArrowDown local shortcuts
   */
  arrowsShortcut: boolean;
  globalShortcuts: {
    volumeUp: string;
    volumeDown: string;
  };
  /**
   * Plugin save volume between session here
   */
  savedVolume: number | undefined;
};

type VolumeBackend = {
  window?: BrowserWindow;
  config?: PreciseVolumePluginConfig;
  send?: (event: string, direction: boolean) => void;
  active: boolean;
  generation: number;
  revision: number;
  reconciling: boolean;
  scope?: AbortController;
  closeListener?: () => void;
  releases: (() => void)[];
  reconcile(): void;
  stop(): void;
};

export default createPlugin({
  name: () => t('plugins.precise-volume.name'),
  description: () => t('plugins.precise-volume.description'),
  restartNeeded: true,
  config: {
    enabled: false,
    steps: 1,
    arrowsShortcut: true,
    globalShortcuts: {
      volumeUp: '',
      volumeDown: '',
    },
    savedVolume: undefined,
  } as PreciseVolumePluginConfig,
  stylesheets: [hudStyle],
  menu: async ({ setConfig, getConfig, window }) => {
    const config = await getConfig();

    function changeOptions(
      changedOptions: Partial<PreciseVolumePluginConfig>,
      options: PreciseVolumePluginConfig,
    ) {
      for (const option in changedOptions) {
        // HACK: Weird TypeScript error
        (options as Record<string, unknown>)[option] = (
          changedOptions as Record<string, unknown>
        )[option];
      }

      setConfig(options);
    }

    // Helper function for globalShortcuts prompt
    const kb = (
      label_: string,
      value_: string,
      default_: string,
    ): KeybindOptions => ({
      value: value_,
      label: label_,
      default: default_ || undefined,
    });

    async function promptVolumeSteps(options: PreciseVolumePluginConfig) {
      const output = await prompt(
        {
          title: t('plugins.precise-volume.prompt.volume-steps.title'),
          label: t('plugins.precise-volume.prompt.volume-steps.label'),
          value: options.steps || 1,
          type: 'counter',
          counterOptions: { minimum: 0, maximum: 100, multiFire: true },
          width: 380,
          ...promptOptions(),
        },
        window,
      );

      if (output || output === 0) {
        // 0 is somewhat valid
        changeOptions({ steps: output }, options);
      }
    }

    async function promptGlobalShortcuts(
      options: PreciseVolumePluginConfig,
      item: MenuItem,
    ) {
      const output = await prompt(
        {
          title: t('plugins.precise-volume.prompt.global-shortcuts.title'),
          label: t('plugins.precise-volume.prompt.global-shortcuts.label'),
          type: 'keybind',
          keybindOptions: [
            kb(
              t(
                'plugins.precise-volume.prompt.global-shortcuts.keybind-options.increase',
              ),
              'volumeUp',
              options.globalShortcuts?.volumeUp,
            ),
            kb(
              t(
                'plugins.precise-volume.prompt.global-shortcuts.keybind-options.decrease',
              ),
              'volumeDown',
              options.globalShortcuts?.volumeDown,
            ),
          ],
          ...promptOptions(),
        },
        window,
      );

      if (output) {
        const newGlobalShortcuts: {
          volumeUp: string;
          volumeDown: string;
        } = { volumeUp: '', volumeDown: '' };
        for (const { value, accelerator } of output) {
          newGlobalShortcuts[value as keyof typeof newGlobalShortcuts] =
            accelerator;
        }

        changeOptions({ globalShortcuts: newGlobalShortcuts }, options);

        item.checked =
          Boolean(options.globalShortcuts.volumeUp) ||
          Boolean(options.globalShortcuts.volumeDown);
      } else {
        // Reset checkbox if prompt was canceled
        item.checked = !item.checked;
      }
    }

    return [
      {
        label: t('plugins.precise-volume.menu.arrows-shortcuts'),
        type: 'checkbox',
        checked: Boolean(config.arrowsShortcut),
        click(item) {
          changeOptions({ arrowsShortcut: item.checked }, config);
        },
      },
      {
        label: t('plugins.precise-volume.menu.global-shortcuts'),
        type: 'checkbox',
        checked: Boolean(
          config.globalShortcuts?.volumeUp ??
          config.globalShortcuts?.volumeDown,
        ),
        click: (item) => promptGlobalShortcuts(config, item),
      },
      {
        label: t('plugins.precise-volume.menu.custom-volume-steps'),
        click: () => promptVolumeSteps(config),
      },
    ];
  },

  backend: createBackend<VolumeBackend, PreciseVolumePluginConfig>({
    active: false,
    generation: 0,
    revision: 0,
    reconciling: false,
    releases: [],
    async start({ getConfig, ipc, window }) {
      this.stop();
      const generation = this.generation;
      this.window = window;
      this.send = (event, direction) => ipc.send(event, direction);
      const closed = () => {
        if (this.generation === generation && this.window === window)
          this.stop();
      };
      window.on?.('closed', closed);
      if (this.generation !== generation || this.window !== window) {
        window.off?.('closed', closed);
        return;
      }
      this.closeListener = () => window.off?.('closed', closed);
      let loaded: PreciseVolumePluginConfig;
      try {
        loaded = await getConfig();
      } catch (error) {
        if (this.generation !== generation || this.window !== window) return;
        if (!this.config) {
          this.stop();
          throw error;
        }
        loaded = this.config;
      }
      if (this.generation !== generation || this.window !== window) return;
      const destroyed = window.isDestroyed();
      if (destroyed || this.generation !== generation || this.window !== window)
        return;
      const desired = this.config ?? loaded;
      if (desired.enabled !== true) {
        this.stop();
        return;
      }
      this.config = desired;
      this.active = true;
      this.reconcile();
    },
    onConfigChange(config) {
      if (config.enabled !== true) {
        this.stop();
        return;
      }
      this.revision++;
      this.config = config;
      this.scope?.abort();
      if (this.active) this.reconcile();
    },
    stop() {
      this.active = false;
      this.generation++;
      this.revision++;
      const scope = this.scope,
        close = this.closeListener,
        releases = this.releases.splice(0);
      this.scope = undefined;
      this.closeListener = undefined;
      this.window = undefined;
      this.config = undefined;
      this.send = undefined;
      scope?.abort();
      for (const release of releases) release();
      close?.();
    },
    reconcile() {
      if (this.reconciling) return;
      this.reconciling = true;
      try {
        for (;;) {
          const old = this.scope,
            releases = this.releases.splice(0);
          this.scope = undefined;
          old?.abort();
          for (const release of releases) release();
          const window = this.window,
            config = this.config,
            send = this.send,
            revision = this.revision;
          if (!this.active || !window || !config || !send) return;
          const scope = new AbortController();
          this.scope = scope;
          const contents = window.webContents;
          const scalar = () =>
            this.active &&
            this.window === window &&
            this.config === config &&
            this.send === send &&
            this.revision === revision &&
            this.scope === scope &&
            !scope.signal.aborted;
          const current = () => {
            if (!scalar()) return false;
            try {
              const unavailable =
                window.isDestroyed() ||
                window.webContents !== contents ||
                contents.isDestroyed?.();
              return !unavailable && scalar();
            } catch {
              return false;
            }
          };
          for (const [name, direction] of [
            ['volumeUp', true],
            ['volumeDown', false],
          ] as const) {
            if (!current()) break;
            const accelerator = config.globalShortcuts?.[name];
            if (typeof accelerator !== 'string' || !accelerator.trim())
              continue;
            const release = registerOwnedGlobalShortcut(
              { signal: scope.signal, isCurrent: current },
              accelerator,
              () => {
                if (current() && scalar()) send('changeVolume', direction);
              },
            );
            if (release) this.releases.push(release);
          }
          if (scalar()) return;
        }
      } finally {
        this.reconciling = false;
      }
    },
  }),

  renderer: {
    start() {
      overrideListener();
    },
    onPlayerApiReady,
    onConfigChange,
  },
});
