import type { RepeatMode } from '@/types/datahost-get-state';

type RepeatController = HTMLElement & {
  getState?: () => { queue?: { repeatMode?: RepeatMode } };
  onRepeatButtonClick?: () => void;
};

const modes: RepeatMode[] = ['NONE', 'ALL', 'ONE'];

// Adapted from upstream #4357: preserve explicit UI/IPC choices across resets.
export function createRepeatPreference() {
  const controller = () =>
    document.querySelector<RepeatController>('ytmusic-player-bar');
  const readMode = () => {
    try {
      const value = controller()?.getState?.()?.queue?.repeatMode;
      return value && modes.includes(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  let preferred = readMode();
  let disposed = false;
  let generation = 0;
  let restoreTimer: number | undefined;
  let rememberTimer: number | undefined;
  const cancelRestore = () => {
    generation++;
    window.clearTimeout(restoreTimer);
    restoreTimer = undefined;
  };
  const rememberUserChange = () => {
    if (disposed) return;
    cancelRestore();
    preferred = readMode() ?? preferred;
    const epoch = generation;
    window.clearTimeout(rememberTimer);
    rememberTimer = window.setTimeout(() => {
      rememberTimer = undefined;
      if (!disposed && epoch === generation)
        preferred = readMode() ?? preferred;
    }, 0);
  };
  const onClick = (event: MouseEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest('#right-controls .repeat')
    )
      rememberUserChange();
  };
  const onTrack = (event: Event) => {
    if (!(event instanceof CustomEvent) || disposed) return;
    const detail: unknown = event.detail;
    if (
      !detail ||
      typeof detail !== 'object' ||
      !('name' in detail) ||
      detail.name !== 'dataloaded'
    )
      return;
    cancelRestore();
    const target = preferred;
    if (!target || target === 'NONE') return;
    const epoch = generation;
    restoreTimer = window.setTimeout(() => {
      restoreTimer = undefined;
      if (
        disposed ||
        epoch !== generation ||
        target !== preferred ||
        readMode() !== 'NONE'
      )
        return;
      const bar = controller();
      if (!bar?.onRepeatButtonClick) return;
      const count = modes.indexOf(target);
      for (let index = 0; index < count; index++) bar.onRepeatButtonClick();
    }, 350);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelRestore();
    window.clearTimeout(rememberTimer);
    rememberTimer = undefined;
    document.removeEventListener('click', onClick);
    document.removeEventListener('videodatachange', onTrack);
    window.removeEventListener('pagehide', dispose);
  };
  document.addEventListener('click', onClick);
  document.addEventListener('videodatachange', onTrack);
  window.addEventListener('pagehide', dispose);
  return { rememberUserChange, dispose };
}
