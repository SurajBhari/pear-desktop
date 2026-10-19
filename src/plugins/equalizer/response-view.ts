import { t } from '@/i18n';

import type { EqualizerResponse } from './controller';

// Draw only on edits or graph changes. There is no playback/animation loop.
export function createResponseView(read: () => EqualizerResponse | null) {
  const element = document.createElement('figure');
  element.className = 'eq-response';
  const caption = document.createElement('figcaption');
  const title = document.createElement('span');
  title.textContent = t('plugins.equalizer.editor.response');
  const value = document.createElement('output');
  caption.append(title, value);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 800 180');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('plugins.equalizer.editor.response'));
  const grid = document.createElementNS(ns, 'path');
  grid.setAttribute('class', 'eq-response-grid');
  const curve = document.createElementNS(ns, 'path');
  curve.setAttribute('class', 'eq-response-curve');
  const labels = document.createElementNS(ns, 'g');
  svg.append(grid, curve, labels);
  const help = document.createElement('p');
  help.className = 'eq-response-help';
  help.textContent = t('plugins.equalizer.editor.response-help');
  element.append(caption, svg, help);
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    let response: EqualizerResponse | null = null;
    try {
      response = read();
    } catch {
      // The audible graph is untouched if a preview cannot be computed.
    }
    svg.style.display = response ? '' : 'none';
    value.textContent = response
      ? t('plugins.equalizer.editor.effective-preamp', {
          value: response.effectivePreampDb.toFixed(1),
        })
      : t('plugins.equalizer.editor.response-unavailable');
    if (!response) return;
    const width = Math.max(240, svg.getBoundingClientRect().width || 800);
    const right = width - 12;
    const plotWidth = width - 68;
    // Keep axis text at CSS-pixel size when the panel gets narrower.
    svg.setAttribute('viewBox', `0 0 ${width} 180`);
    const top = Math.max(
      12,
      Math.ceil(Math.max(...response.gainsDb) / 12) * 12,
    );
    const bottomStep = Math.floor(response.effectivePreampDb / 12) * 12;
    const bottom = Math.min(-24, bottomStep - 12);
    const end = Math.min(20000, response.sampleRate / 2);
    const start = Math.min(20, end / 2);
    const x = (frequency: number) => {
      const position =
        (Math.log(frequency / start) / Math.log(end / start)) * plotWidth;
      return 56 + position;
    };
    const y = (gain: number) => {
      const position =
        ((top - Math.max(bottom, Math.min(top, gain))) / (top - bottom)) * 140;
      return 12 + position;
    };
    const text = (
      content: string,
      px: number,
      py: number,
      anchor = 'middle',
    ) => {
      const node = document.createElementNS(ns, 'text');
      node.textContent = content;
      node.setAttribute('x', String(px));
      node.setAttribute('y', String(py));
      node.setAttribute('text-anchor', anchor);
      labels.append(node);
      return node;
    };
    labels.replaceChildren();
    let lines = '';
    for (const gain of [top, 0, bottom]) {
      lines += `M56 ${y(gain)}H${right} `;
      text(`${gain} dB`, 48, y(gain) + 4, 'end');
    }
    for (const frequency of [20, 100, 1000, 10000, 20000]) {
      if (frequency < start || frequency > end) continue;
      lines += `M${x(frequency)} 12V152 `;
      if (frequency !== 10000 || plotWidth >= 400)
        text(
          frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`,
          x(frequency),
          174,
          frequency === 20000 ? 'end' : 'middle',
        ).setAttribute('data-frequency', String(frequency));
    }
    grid.setAttribute('d', lines);
    let path = '';
    response.frequencies.forEach((frequency, i) => {
      if (frequency < start || frequency > end) return;
      path += `${path ? 'L' : 'M'}${x(frequency).toFixed(2)} ${y(response.gainsDb[i]).toFixed(2)} `;
    });
    curve.setAttribute('d', path);
  };
  const observer = new ResizeObserver(refresh);
  observer.observe(svg);
  refresh();
  return {
    element,
    refresh,
    dispose: () => {
      disposed = true;
      observer.disconnect();
    },
  };
}
