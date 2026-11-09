export const ATTEMPT_DEBOUNCE_MS = 250;
export const CLICK_THROTTLE_MS = 1200;
export const PLAYER_ROOT_SELECTOR = 'ytmusic-player, #movie_player';
export const ERROR_RENDERER_SELECTOR =
  'yt-playability-error-supported-renderers yt-player-error-message-renderer';
export const PROCEED_BUTTON_SELECTOR = '#button button';

// Explicit multilingual topic needles from public upstream #4667.
// Generic viewer-discretion copy also occurs on unrelated gates.
const WARNING_NEEDLES = [
  'suicide or self-harm',
  'self-harm',
  'self harm',
  'suicid',
  'selbstmord',
  'selbstverletzung',
  'suizid',
  'automutilation',
  'autolesion',
  'zelfmoord',
  'zelfbeschadiging',
  'самоубий',
  'самоповрежд',
  'суицид',
  'samoboj',
  'samookalecz',
  'intihar',
  'selvmord',
  'sjalvmord',
  'itsemurh',
  'itsensa vahingoitt',
  '自杀',
  '自殺',
  '自残',
  '自殘',
  '自傷',
  '自伤',
  '자살',
  '자해',
  'انتحار',
];
// Gate copy covered by the public upstream negative fixtures, in either field.
const GATE_NEEDLES = [
  'unavailable',
  'this video is private',
  'sign in',
  'inappropriate for some users',
  'disabled by the video owner',
  'youtube premium',
  'not a bot',
];
export const foldText = (value: string): string =>
  value.toLowerCase().normalize('NFD').replaceAll(/\p{M}/gu, '');
const foldedWarningNeedles = WARNING_NEEDLES.map(foldText);
export const isContentWarningText = (
  reason: string,
  subreason = '',
): boolean => {
  const text = foldText(`${reason}\n${subreason}`);
  return (
    !GATE_NEEDLES.some((needle) => text.includes(needle)) &&
    foldedWarningNeedles.some((needle) => text.includes(needle))
  );
};
export const shouldAcknowledge = (input: {
  reason: string | null | undefined;
  subreason?: string | null;
  hasProceedButton: boolean;
}): boolean =>
  Boolean(input.reason?.trim()) &&
  input.hasProceedButton &&
  isContentWarningText(input.reason!, input.subreason ?? '');
export const warningScreenKey = (reason: string, videoKey: string): string =>
  `${videoKey}::${reason.trim()}`;

export const isVisibleElement = (element: Element, doc: Document): boolean => {
  const view = doc.defaultView;
  if (
    !view ||
    doc.hidden ||
    !element.isConnected ||
    element.ownerDocument !== doc
  )
    return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (
      node.hasAttribute('hidden') ||
      node.hasAttribute('inert') ||
      node.getAttribute('aria-hidden') === 'true'
    )
      return false;
    const style = view.getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    )
      return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
export type WarningAction = {
  renderer: HTMLElement;
  button: HTMLButtonElement;
  reason: string;
  subreason: string;
};
export const findWarningAction = (
  root: Element,
  doc: Document,
): WarningAction | null => {
  const view = doc.defaultView;
  const app = doc.querySelector('ytmusic-app');
  if (
    !view ||
    !app ||
    app.querySelector(PLAYER_ROOT_SELECTOR) !== root ||
    !root.isConnected ||
    !isVisibleElement(root, doc)
  )
    return null;
  for (const renderer of root.querySelectorAll<HTMLElement>(
    ERROR_RENDERER_SELECTOR,
  )) {
    const reason = (
      renderer.querySelector('#reason')?.textContent ?? ''
    ).trim();
    const subreason = (
      renderer.querySelector('#subreason')?.textContent ?? ''
    ).trim();
    const button = renderer.querySelector(PROCEED_BUTTON_SELECTOR);
    if (
      !(button instanceof view.HTMLButtonElement) ||
      button.disabled ||
      button.matches(':disabled') ||
      button.getAttribute('aria-disabled') === 'true' ||
      !isVisibleElement(renderer, doc) ||
      !isVisibleElement(button, doc) ||
      !shouldAcknowledge({ reason, subreason, hasProceedButton: true })
    )
      continue;
    return { renderer, button, reason, subreason };
  }
  return null;
};
