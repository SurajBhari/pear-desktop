import { t } from '@/i18n';

import {
  bassProfile,
  editedConfig,
  flatProfile,
  MAX_BANDS,
  modes,
  normalizeConfig,
  type EqualizerPluginConfig,
  type EqualizerProfile,
} from './config';
import { stockPresets, stockProfile } from './stock-presets';
import style from './style.css?inline';

export function openEqualizerPanel(
  getConfig: () => EqualizerPluginConfig,
  change: (value: Partial<EqualizerPluginConfig>) => void,
  flush: () => void,
  sampleRate: () => number | undefined,
) {
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const dialog = document.createElement('dialog');
  dialog.className = 'eq-panel';
  dialog.setAttribute('aria-label', t('plugins.equalizer.editor.title'));
  const css = document.createElement('style');
  css.textContent = style;
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = t('plugins.equalizer.editor.title');
  const body = document.createElement('div');
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const button = (text: string, click: () => void) => {
    const node = document.createElement('button');
    node.textContent = text;
    node.onclick = click;
    return node;
  };
  const label = (text: string, control: HTMLElement) => {
    const node = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = text;
    node.append(caption, control);
    return node;
  };
  let disposed = false;
  let selectedPreset = '';
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    flush();
    dialog.close();
    dialog.remove();
    previousFocus?.focus();
  };
  header.append(title, button(t('plugins.equalizer.editor.close'), dispose));
  dialog.append(css, header, error, body);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dispose();
  });
  function render() {
    if (disposed) return;
    body.replaceChildren();
    const raw = getConfig();
    const state = normalizeConfig(raw);
    const profile = state.profile;
    const notice = document.createElement('p');
    notice.className = 'eq-notice';
    notice.setAttribute('role', 'status');
    const rate = sampleRate();
    notice.textContent = !state.editable
      ? t('plugins.equalizer.editor.unsupported')
      : rate && profile?.bands.some((b) => b.frequency >= rate / 2)
        ? t('plugins.equalizer.editor.nyquist')
        : t('plugins.equalizer.editor.headroom');
    body.append(notice);
    if (!state.editable || !profile) return;
    const active = () => normalizeConfig(getConfig()).profile!;
    const commit = (
      next: EqualizerProfile,
      changes: Partial<EqualizerPluginConfig> = {},
      redraw = false,
    ) => {
      change(editedConfig(getConfig(), next, changes));
      if (redraw) render();
    };
    const numeric = (
      value: number,
      min: number,
      max: number,
      step: number,
      edit: (v: number) => void,
    ) => {
      const node = document.createElement('input');
      node.type = 'number';
      node.min = String(min);
      node.max = String(max);
      node.step = String(step);
      node.value = String(Number(value.toFixed(4)));
      node.oninput = () => {
        const v = node.valueAsNumber;
        if (Number.isFinite(v) && v >= min && v <= max) edit(v);
      };
      node.onchange = flush;
      return node;
    };
    const toolbar = document.createElement('div');
    toolbar.className = 'eq-toolbar';
    const layout = document.createElement('select');
    for (const mode of modes) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent =
        mode === 'custom'
          ? t('plugins.equalizer.editor.custom')
          : mode.split('-')[1];
      layout.append(option);
    }
    layout.value = profile.mode;
    layout.onchange = () => {
      const mode = layout.value as EqualizerProfile['mode'];
      commit(
        state.rememberedProfiles[mode] ?? flatProfile(mode),
        {
          rememberedProfiles: {
            ...state.rememberedProfiles,
            [profile.mode]: active(),
          },
        },
        true,
      );
    };
    toolbar.append(label(t('plugins.equalizer.editor.layout'), layout));
    const bypass = document.createElement('input');
    bypass.type = 'checkbox';
    bypass.checked = raw.bypass;
    bypass.onchange = () => change({ bypass: bypass.checked });
    toolbar.append(
      label(t('plugins.equalizer.editor.bypass'), bypass),
      button(t('plugins.equalizer.editor.reset'), () => {
        const p = active();
        commit(
          { ...p, preamp: 0, bands: p.bands.map((b) => ({ ...b, gain: 0 })) },
          {},
          true,
        );
      }),
    );
    if (profile.mode !== 'custom')
      toolbar.append(
        button(t('plugins.equalizer.editor.use-custom'), () =>
          commit({ ...active(), mode: 'custom' }, {}, true),
        ),
      );
    body.append(
      toolbar,
      label(
        t('plugins.equalizer.editor.preamp'),
        numeric(profile.preamp, -24, 12, 0.1, (preamp) =>
          commit({ ...active(), preamp }),
        ),
      ),
    );
    const bands = document.createElement('div');
    bands.className =
      profile.mode === 'custom' ? 'eq-bands eq-custom' : 'eq-bands';
    profile.bands.forEach((band, i) => {
      const row = document.createElement('fieldset');
      row.className = 'eq-band';
      const legend = document.createElement('legend');
      legend.textContent =
        profile.mode === 'custom'
          ? `${i + 1} · ${band.type}`
          : `${Number(band.frequency.toFixed(1))} Hz`;
      row.append(legend);
      const edit = (key: 'frequency' | 'gain' | 'Q', value: number) => {
        const p = active();
        commit({
          ...p,
          bands: p.bands.map((b) =>
            b.id === band.id ? { ...b, [key]: value } : b,
          ),
        });
      };
      const gain = numeric(band.gain, -24, 24, 0.1, (value) => {
        range.value = String(value);
        edit('gain', value);
      });
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '-24';
      range.max = '24';
      range.step = '0.1';
      range.value = String(band.gain);
      range.setAttribute(
        'aria-label',
        `${legend.textContent} ${t('plugins.equalizer.editor.gain')}`,
      );
      range.oninput = () => {
        gain.value = range.value;
        edit('gain', range.valueAsNumber);
      };
      range.onchange = flush;
      row.append(range, label(t('plugins.equalizer.editor.gain'), gain));
      if (profile.mode === 'custom') {
        row.append(
          label(
            t('plugins.equalizer.editor.frequency'),
            numeric(band.frequency, 20, 20000, 0.1, (value) =>
              edit('frequency', value),
            ),
          ),
        );
        const q = numeric(band.Q, 0.1, 30, 0.1, (value) => edit('Q', value));
        q.disabled = band.type === 'lowshelf' || band.type === 'highshelf';
        row.append(label(t('plugins.equalizer.editor.q'), q));
        const remove = button(t('plugins.equalizer.editor.remove-band'), () => {
          const p = active();
          commit(
            { ...p, bands: p.bands.filter((b) => b.id !== band.id) },
            {},
            true,
          );
        });
        remove.setAttribute(
          'aria-label',
          `${t('plugins.equalizer.editor.remove-band')} ${i + 1}`,
        );
        row.append(remove);
      }
      bands.append(row);
    });
    body.append(bands);
    if (profile.mode === 'custom') {
      const add = button(t('plugins.equalizer.editor.add-band'), () => {
        const p = active();
        commit(
          {
            ...p,
            bands: [
              ...p.bands,
              {
                id: crypto.randomUUID(),
                type: 'peaking',
                frequency: 1000,
                gain: 0,
                Q: 1,
              },
            ],
          },
          {},
          true,
        );
      });
      add.disabled = profile.bands.length >= MAX_BANDS;
      const count = document.createElement('span');
      count.textContent = ` ${profile.bands.length} / ${MAX_BANDS}`;
      body.append(add, count);
    }
    const presets = document.createElement('div');
    presets.className = 'eq-toolbar eq-presets';
    const select = document.createElement('select');
    const options = [
      { id: '', name: t('plugins.equalizer.editor.choose-preset') },
      { id: 'flat', name: t('plugins.equalizer.editor.flat') },
      {
        id: 'bass',
        name: t('plugins.equalizer.menu.presets.list.bass-booster'),
      },
    ];
    for (const preset of options) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      select.append(option);
    }
    const stockGroup = document.createElement('optgroup');
    stockGroup.label = t('plugins.equalizer.stock.label');
    for (const preset of stockPresets) {
      const option = document.createElement('option');
      option.value = `stock:${preset.id}`;
      option.textContent = t(`plugins.equalizer.stock.names.${preset.id}`);
      stockGroup.append(option);
    }
    select.append(stockGroup);
    const userGroup = document.createElement('optgroup');
    userGroup.label = t('plugins.equalizer.stock.user-presets');
    for (const preset of state.userPresets) {
      const option = document.createElement('option');
      option.value = `user:${preset.id}`;
      option.textContent = preset.name;
      userGroup.append(option);
    }
    if (state.userPresets.length) select.append(userGroup);
    const selectedUserId = () =>
      selectedPreset.startsWith('user:') ? selectedPreset.slice(5) : null;
    select.value = selectedPreset;
    select.onchange = () => {
      selectedPreset = select.value;
      const p =
        selectedPreset === 'flat'
          ? flatProfile(profile.mode)
          : selectedPreset === 'bass'
            ? bassProfile()
            : selectedPreset.startsWith('stock:')
              ? stockProfile(selectedPreset.slice(6))
              : state.userPresets.find(
                  (preset) => preset.id === selectedUserId(),
                )?.profile;
      if (p)
        commit(
          p,
          selectedPreset.startsWith('stock:')
            ? {
                rememberedProfiles: {
                  ...state.rememberedProfiles,
                  [profile.mode]: active(),
                },
              }
            : {},
          true,
        );
    };
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 80;
    name.value =
      state.userPresets.find((p) => p.id === selectedUserId())?.name ?? '';
    const save = button(t('plugins.equalizer.editor.save'), () => {
      const next = normalizeConfig(getConfig());
      const id =
        next.userPresets.find((p) => p.name === name.value.trim())?.id ??
        crypto.randomUUID();
      selectedPreset = `user:${id}`;
      const preset = {
        id,
        name: name.value.trim(),
        profile: structuredClone(next.profile!),
      };
      commit(
        next.profile!,
        {
          userPresets: [...next.userPresets.filter((p) => p.id !== id), preset],
        },
        true,
      );
    });
    const updateSave = () => {
      save.disabled = !name.value.trim();
      save.textContent = state.userPresets.some(
        (p) => p.name === name.value.trim(),
      )
        ? t('plugins.equalizer.editor.update')
        : t('plugins.equalizer.editor.save');
    };
    name.oninput = updateSave;
    updateSave();
    const remove = button(t('plugins.equalizer.editor.delete'), () => {
      const id = selectedUserId();
      selectedPreset = '';
      commit(
        active(),
        { userPresets: state.userPresets.filter((p) => p.id !== id) },
        true,
      );
    });
    remove.disabled = !state.userPresets.some((p) => p.id === selectedUserId());
    presets.append(
      label(t('plugins.equalizer.editor.preset'), select),
      label(t('plugins.equalizer.editor.preset-name'), name),
      save,
      remove,
    );
    body.append(presets);
  }
  render();
  document.body.append(dialog);
  dialog.showModal();
  return {
    dispose,
    refresh: render,
    reportError: (message: string | null) => {
      error.textContent = message ?? '';
      error.hidden = !message;
    },
  };
}
