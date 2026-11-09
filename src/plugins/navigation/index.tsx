import { IconChevronLeft } from '@mdui/icons/chevron-left.js';
import { IconChevronRight } from '@mdui/icons/chevron-right.js';
import { render } from 'solid-js/web';

import { t } from '@/i18n';
import { LitElementWrapper } from '@/solit';
import { createPlugin } from '@/utils';

import { attachHistoryGestures } from './gestures';
import { backend } from './main';

type NavigationPluginConfig = { enabled: boolean; swipeNavigation: boolean };

export default createPlugin({
  name: () => t('plugins.navigation.name'),
  description: () => t('plugins.navigation.description'),
  restartNeeded: false,
  config: {
    enabled: true,
    swipeNavigation: false,
  } as NavigationPluginConfig,
  menu: async ({ getConfig, setConfig }) => [
    {
      label: t('plugins.navigation.menu.swipe-navigation'),
      type: 'checkbox',
      checked: (await getConfig()).swipeNavigation === true,
      click: (item) => setConfig({ swipeNavigation: item.checked }),
    },
  ],
  backend,
  renderer: {
    buttonContainer: document.createElement('div'),
    dispose: null as (() => void) | null,
    gestures: null as ReturnType<typeof attachHistoryGestures> | null,
    releaseCommands: null as (() => void) | null,
    generation: 0,
    configRevision: 0,
    swipeNavigation: false,
    async start({ getConfig, ipc }) {
      const generation = ++this.generation;
      const revision = this.configRevision;
      this.dispose?.();
      this.dispose = null;
      this.buttonContainer.remove();
      this.gestures?.dispose();
      this.gestures = null;
      this.releaseCommands?.();
      this.releaseCommands = null;
      const config = await getConfig();
      if (this.generation !== generation) return;
      if (this.configRevision === revision) {
        this.swipeNavigation = config.swipeNavigation === true;
      }
      if (!this.buttonContainer) {
        this.buttonContainer = document.createElement('div');
      }

      this.dispose = render(
        () => (
          <>
            <mdui-tooltip
              content={t('plugins.navigation.templates.back.title')}
            >
              <mdui-button-icon
                onClick={() => history.back()}
                style={{ width: '40px', height: '40px' }}
              >
                <LitElementWrapper
                  elementClass={IconChevronLeft}
                  props={{
                    style: {
                      'padding': '5px',
                      'scale': '1.5',
                      'font-size': '24px',
                    },
                  }}
                />
              </mdui-button-icon>
            </mdui-tooltip>
            <mdui-tooltip
              content={t('plugins.navigation.templates.forward.title')}
            >
              <mdui-button-icon
                onClick={() => history.forward()}
                style={{ width: '40px', height: '40px' }}
              >
                <LitElementWrapper
                  elementClass={IconChevronRight}
                  props={{
                    style: {
                      'padding': '5px',
                      'scale': '1.5',
                      'font-size': '24px',
                    },
                  }}
                />
              </mdui-button-icon>
            </mdui-tooltip>
          </>
        ),
        this.buttonContainer,
      );
      const menu = document.querySelector('#right-content');
      menu?.prepend(this.buttonContainer);
      const gestures = attachHistoryGestures(window, this.swipeNavigation);
      this.gestures = gestures;
      const command = (value: unknown) => gestures.command(value);
      if (ipc.subscribe) {
        this.releaseCommands = ipc.subscribe(
          'navigation-history-command',
          command,
        );
      } else {
        ipc.on('navigation-history-command', command);
        this.releaseCommands = () =>
          ipc.removeAllListeners('navigation-history-command');
      }
    },
    stop() {
      this.generation++;
      this.gestures?.dispose();
      this.gestures = null;
      this.releaseCommands?.();
      this.releaseCommands = null;
      this.dispose?.();
      this.dispose = null;
      this.buttonContainer.replaceChildren();
      this.buttonContainer.remove();
    },
    onConfigChange(config) {
      this.configRevision++;
      this.swipeNavigation =
        config.enabled !== false && config.swipeNavigation === true;
      this.gestures?.setEnabled(this.swipeNavigation);
    },
  },
});
