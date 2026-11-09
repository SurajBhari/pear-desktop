const LOGIN_CONTROL_SELECTORS = [
  '.sign-in-link',
  'ytmusic-guide-signin-promo-renderer',
  '.ytmusic-pivot-bar-renderer[tab-id="FEmusic_liked"]',
  'a[href="/music_premium"]',
  'a[href^="https://accounts.google.com/ServiceLogin"]',
  'a[href^="https://accounts.google.com/AccountChooser"]',
];

const STYLE_ATTRIBUTE = 'data-pear-no-google-login';

export const createLoginControlHider = (document: Document) => {
  let style: HTMLStyleElement | undefined;

  return {
    start() {
      if (style?.isConnected) return;

      style ??= document.createElement('style');
      style.setAttribute(STYLE_ATTRIBUTE, '');
      style.textContent = `${LOGIN_CONTROL_SELECTORS.join(',\n')} { display: none !important; }`;

      const styleRoot = document.head ?? document.documentElement;
      styleRoot.append(style);
    },

    stop() {
      style?.remove();
      style = undefined;
    },
  };
};
