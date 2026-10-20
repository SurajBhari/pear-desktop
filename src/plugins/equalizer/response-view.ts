import { t } from '@/i18n';

import type { EqualizerProfile } from './config';
import type { EqualizerResponse } from './controller';

type PointEditor = {
  profile: () => EqualizerProfile;
  edit: (id: string, frequency: number, gain: number) => void;
  add: (frequency: number, gain: number) => void;
  flush: () => void;
};
type GraphScale = {
  width: number;
  top: number;
  bottom: number;
  start: number;
  end: number;
  preamp: number;
};

// Draw only on edits or graph changes. There is no playback/animation loop.
export function createResponseView(
  read: () => EqualizerResponse | null,
  editor?: PointEditor,
) {
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
  svg.setAttribute('role', editor ? 'group' : 'img');
  svg.setAttribute('aria-label', t('plugins.equalizer.editor.response'));
  const grid = document.createElementNS(ns, 'path');
  grid.setAttribute('class', 'eq-response-grid');
  const curve = document.createElementNS(ns, 'path');
  curve.setAttribute('class', 'eq-response-curve');
  const labels = document.createElementNS(ns, 'g');
  const points = document.createElementNS(ns, 'g');
  svg.append(grid, curve, labels, points);
  if (editor) svg.classList.add('eq-response-editable');
  const help = document.createElement('p');
  help.className = 'eq-response-help';
  help.textContent = t(
    `plugins.equalizer.editor.${editor ? 'graph-help' : 'response-help'}`,
  );
  help.id = `eq-graph-help-${crypto.randomUUID()}`;
  svg.setAttribute('aria-describedby', help.id);
  element.append(caption, svg, help);
  let disposed = false;
  let lastResponse: EqualizerResponse | null | undefined;
  let lastWidth = -1;
  let lastBands = '';
  let scale: GraphScale | null = null;
  let gesture: {
    pointer: number;
    id: string | null;
    x: number;
    y: number;
    moved: boolean;
    scale: GraphScale;
  } | null = null;
  const pointNodes = new Map<string, SVGGElement>();
  const refresh = () => {
    if (disposed) return;
    let response: EqualizerResponse | null = null;
    try {
      response = read();
    } catch {
      // The audible graph is untouched if a preview cannot be computed.
    }
    const width = Math.max(240, svg.getBoundingClientRect().width || 800);
    const bands = editor?.profile().bands ?? [];
    const bandKey = JSON.stringify(bands);
    if (
      response === lastResponse &&
      width === lastWidth &&
      bandKey === lastBands
    )
      return;
    lastResponse = response;
    lastWidth = width;
    lastBands = bandKey;
    svg.style.display = response ? '' : 'none';
    value.textContent = response
      ? t('plugins.equalizer.editor.effective-preamp', {
          value: response.effectivePreampDb.toFixed(1),
        })
      : t('plugins.equalizer.editor.response-unavailable');
    if (!response) {
      scale = null;
      return;
    }
    const right = width - 12;
    const plotWidth = width - 68;
    // Keep axis text at CSS-pixel size when the panel gets narrower.
    svg.setAttribute('viewBox', `0 0 ${width} 180`);
    const preamp = gesture?.scale.preamp ?? response.effectivePreampDb;
    const top =
      gesture?.scale.top ??
      Math.max(
        12,
        Math.ceil(Math.max(...response.gainsDb) / 12) * 12,
        ...bands.map((band) => Math.ceil((band.gain + preamp) / 12) * 12),
      );
    const bottomStep = Math.floor(preamp / 12) * 12;
    const bottom =
      gesture?.scale.bottom ??
      Math.min(
        -24,
        bottomStep - 12,
        ...bands.map((band) => Math.floor((band.gain + preamp) / 12) * 12),
      );
    const end = Math.min(20000, response.sampleRate / 2);
    const start = Math.min(20, end / 2);
    scale = { width, top, bottom, start, end, preamp };
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
    for (const [id, node] of pointNodes) {
      if (!bands.some((band) => band.id === id)) {
        node.remove();
        pointNodes.delete(id);
      }
    }
    bands.forEach((band, i) => {
      let node = pointNodes.get(band.id);
      if (!node) {
        node = document.createElementNS(ns, 'g');
        node.dataset.bandId = band.id;
        node.setAttribute('class', 'eq-response-point');
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-describedby', help.id);
        const hit = document.createElementNS(ns, 'circle');
        hit.setAttribute('r', '14');
        hit.setAttribute('class', 'eq-response-point-hit');
        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('r', '6');
        node.append(hit, dot);
        pointNodes.set(band.id, node);
        points.append(node);
      }
      node.setAttribute(
        'transform',
        `translate(${x(Math.max(start, Math.min(end, band.frequency)))} ${y(band.gain + preamp)})`,
      );
      node.setAttribute(
        'aria-label',
        t('plugins.equalizer.editor.graph-band', {
          number: i + 1,
          frequency: Number(band.frequency.toFixed(1)),
          gain: band.gain.toFixed(1),
        }),
      );
    });
  };
  const position = (event: PointerEvent, axes: GraphScale) => {
    const bounds = svg.getBoundingClientRect();
    const px = ((event.clientX - bounds.left) / bounds.width) * axes.width;
    const py = ((event.clientY - bounds.top) / bounds.height) * 180;
    const ratio = Math.max(0, Math.min(1, (px - 56) / (axes.width - 68)));
    const gainOffset = ((py - 12) / 140) * (axes.top - axes.bottom);
    return {
      frequency: Number(
        (axes.start * Math.pow(axes.end / axes.start, ratio)).toFixed(1),
      ),
      gain: Number(
        Math.max(
          -48,
          Math.min(48, axes.top - gainOffset - axes.preamp),
        ).toFixed(1),
      ),
      inside: px >= 56 && px <= axes.width - 12 && py >= 12 && py <= 152,
    };
  };
  svg.addEventListener('pointerdown', (event) => {
    if (!editor || !scale || gesture || event.button !== 0 || !event.isPrimary)
      return;
    const point = (event.target as Element).closest<SVGGElement>(
      '[data-band-id]',
    );
    if (!point && !position(event, scale).inside) return;
    event.preventDefault();
    point?.focus();
    gesture = {
      pointer: event.pointerId,
      id: point?.dataset.bandId ?? null,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      scale: { ...scale },
    };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!editor || !gesture || gesture.pointer !== event.pointerId) return;
    gesture.moved ||=
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 3;
    if (!gesture.id || !gesture.moved) return;
    const { frequency, gain } = position(event, gesture.scale);
    editor.edit(gesture.id, frequency, gain);
  });
  const finish = (event: PointerEvent) => {
    if (!editor || !gesture || gesture.pointer !== event.pointerId) return;
    const ended = gesture;
    gesture = null;
    if (svg.hasPointerCapture(event.pointerId))
      svg.releasePointerCapture(event.pointerId);
    // Add only on a stationary background release; dragging never triggers add.
    if (event.type === 'pointerup' && !ended.id && !ended.moved) {
      const target = position(event, ended.scale);
      if (target.inside) editor.add(target.frequency, target.gain);
    }
    lastWidth = -1; // Restore the current headroom scale after a gesture.
    refresh();
    editor.flush();
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
  svg.addEventListener('lostpointercapture', finish);
  svg.addEventListener('keydown', (event) => {
    if (
      !editor ||
      !scale ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    const point = (event.target as Element).closest<SVGGElement>(
      '[data-band-id]',
    );
    const band = editor
      .profile()
      .bands.find((candidate) => candidate.id === point?.dataset.bandId);
    if (!band) return;
    event.preventDefault();
    const semitone = 2 ** (1 / 12);
    const frequency =
      event.key === 'ArrowLeft'
        ? band.frequency / semitone
        : event.key === 'ArrowRight'
          ? band.frequency * semitone
          : band.frequency;
    const gain =
      band.gain +
      (event.key === 'ArrowUp' ? 0.1 : event.key === 'ArrowDown' ? -0.1 : 0);
    editor.edit(
      band.id,
      Number(Math.max(scale.start, Math.min(scale.end, frequency)).toFixed(1)),
      Number(Math.max(-48, Math.min(48, gain)).toFixed(1)),
    );
    editor.flush();
  });
  const observer = new ResizeObserver(() => {
    // Attribute/label writes must not create work when measured width is stable.
    const width = Math.max(240, svg.getBoundingClientRect().width || 800);
    if (width !== lastWidth) refresh();
  });
  observer.observe(svg);
  refresh();
  return {
    element,
    refresh,
    dispose: () => {
      disposed = true;
      const pointer = gesture?.pointer;
      gesture = null;
      if (pointer !== undefined && svg.hasPointerCapture(pointer))
        svg.releasePointerCapture(pointer);
      observer.disconnect();
    },
  };
}
