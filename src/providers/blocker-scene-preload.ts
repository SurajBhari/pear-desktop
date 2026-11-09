import { contextBridge, ipcRenderer } from 'electron';

/** A pending restore owns only the newly loaded main document's media guard. */
export const installBlockerSceneGuard = (): void => {
  const claim = ipcRenderer.sendSync(
    'peard:blocker-scene-claim',
    location.href,
    performance.timeOrigin,
  ) as { token: string; muted: boolean } | null;
  let active = !!claim;
  let cancelled = false;
  let userRevision = 0;
  const previous = new Map<HTMLMediaElement, boolean>();
  const mute = () => {
    if (!active) return;
    for (const video of document.querySelectorAll<HTMLMediaElement>(
      'video, audio',
    )) {
      if (!previous.has(video)) previous.set(video, video.muted);
      video.muted = true;
    }
  };
  const observer = new MutationObserver(mute);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (restored: boolean) => {
    if (!active) return;
    active = false;
    observer.disconnect();
    if (timer) clearTimeout(timer);
    document.removeEventListener('pointerdown', input, true);
    document.removeEventListener('keydown', input, true);
    ipcRenderer.removeListener('peard:blocker-scene-release', released);
    for (const [video, muted] of previous)
      video.muted = restored ? claim!.muted : muted;
    if (restored) {
      const target =
        document.querySelector<HTMLMediaElement>('#movie_player video') ??
        document.querySelector<HTMLMediaElement>('video');
      if (target) target.muted = claim!.muted;
    }
    previous.clear();
  };
  const input = (event: Event) => {
    if (!event.isTrusted || !active) return;
    cancel();
  };
  const cancel = () => {
    if (!active) return;
    cancelled = true;
    finish(false);
    ipcRenderer.send('peard:blocker-scene-cancel', claim!.token);
  };
  const released = (
    _: Electron.IpcRendererEvent,
    token: string,
    _muted: boolean,
    reason?: string,
  ) => {
    if (token !== claim?.token) return;
    if (reason !== 'complete') {
      cancelled = true;
      // Pause only while this guard still owns the media. Local user controls
      // release it before their handler runs, so their newer choice wins.
      if (active) for (const video of previous.keys()) video.pause();
    }
    finish(reason === 'complete' && !cancelled);
  };
  contextBridge.exposeInMainWorld('blockerSceneGuard', {
    pending: () => active,
    restorationDocument: () => !!claim,
    cancelled: () => cancelled,
    userRevision: () => userRevision,
    cancelFromUser: () => {
      userRevision++;
      cancel();
    },
  });
  if (!claim) return;
  mute();
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('pointerdown', input, true);
  document.addEventListener('keydown', input, true);
  ipcRenderer.on('peard:blocker-scene-release', released);
  timer = setTimeout(() => {
    cancelled = true;
    finish(false);
    ipcRenderer.send('peard:blocker-scene-cancel', claim.token);
  }, 25_000);
};
