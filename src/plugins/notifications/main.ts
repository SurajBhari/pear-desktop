import { Notification } from 'electron';
import is from 'electron-is';

import {
  registerCallback,
  type SongInfo,
  SongInfoEvent,
} from '@/providers/song-info';

import interactive from './interactive';
import { createRatingFeedbackMain } from './rating-feedback-main';
import { notificationImage } from './utils';

import type { NotificationsPluginConfig } from './index';
import type { BackendContext } from '@/types/contexts';
let config: NotificationsPluginConfig | undefined;
let configRevision = 0,
  startRevision = 0;
let active:
  | {
      dispose(): void;
      configChanged(): void;
      track(): { url: string | undefined; paused: boolean | undefined };
    }
  | undefined;
let savedContext: BackendContext<NotificationsPluginConfig> | undefined;
export const onMainStop = () => {
  startRevision++;
  const previous = active;
  active = undefined;
  previous?.dispose();
};
const setup = (
  context: BackendContext<NotificationsPluginConfig>,
  previousTrack?: { url: string | undefined; paused: boolean | undefined },
) => {
  if (!config?.enabled) return;
  let live = true,
    callback: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    toast: Notification | undefined,
    currentUrl: string | undefined,
    paused: boolean | undefined;
  currentUrl = previousTrack?.url;
  paused = previousTrack?.paused;
  const setupRevision = startRevision;
  const win = context.window,
    contents = win.webContents;
  if (setupRevision !== startRevision || !config?.enabled) return;
  const scalar = () => live && active === lifetime && !!config?.enabled;
  const owner = {
    isCurrent: () => {
      if (!scalar()) return false;
      try {
        return (
          !win.isDestroyed() &&
          scalar() &&
          context.window === win &&
          scalar() &&
          win.webContents === contents &&
          !contents.isDestroyed() &&
          scalar()
        );
      } catch {
        return false;
      }
    },
  };
  const options = () => config!;
  let interactiveProducer: ReturnType<typeof interactive> | undefined;
  let rating: ReturnType<typeof createRatingFeedbackMain> | undefined;
  const close = () => {
    const previous = toast;
    toast = undefined;
    previous?.close();
  };
  const show = (info: SongInfo) => {
    clearTimeout(timer);
    timer = undefined;
    if (interactiveProducer) {
      interactiveProducer.show(info);
      return;
    }
    close();
    if (!owner.isCurrent()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!owner.isCurrent()) return;
      const captured = config!,
        icon = notificationImage(info, captured);
      if (!owner.isCurrent()) return;
      const candidate = new Notification({
        title: info.title || 'Playing',
        body: info.artist,
        icon,
        silent: true,
        urgency: captured.urgency,
      });
      if (!owner.isCurrent()) {
        candidate.close();
        return;
      }
      toast = candidate;
      const send = candidate.show.bind(candidate);
      if (!owner.isCurrent()) {
        if (toast === candidate) toast = undefined;
        candidate.close();
        return;
      }
      send();
      if (!owner.isCurrent() && toast === candidate) {
        toast = undefined;
        candidate.close();
      }
    }, 10);
  };
  const closed = () => {
    if (active === lifetime) {
      active = undefined;
      lifetime.dispose();
    }
  };
  const navigation = (
    _event: unknown,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) {
      clearTimeout(timer);
      timer = undefined;
      close();
    }
  };
  const lifetime = {
    track: () => ({ url: currentUrl, paused }),
    configChanged() {
      rating?.configChanged();
    },
    dispose() {
      if (!live) return;
      live = false;
      win.removeListener('closed', closed);
      contents.removeListener('destroyed', closed);
      contents.removeListener('did-start-navigation', navigation);
      clearTimeout(timer);
      timer = undefined;
      callback?.();
      rating?.dispose();
      interactiveProducer?.dispose();
      close();
    },
  };
  active = lifetime;
  const retire = () => {
    if (active === lifetime) active = undefined;
    lifetime.dispose();
    return false;
  };
  const register = <Args extends unknown[]>(
    target: NodeJS.EventEmitter,
    event: string,
    listener: (...args: Args) => void,
  ) => {
    if (!owner.isCurrent()) return retire();
    const on = target.on.bind(target);
    if (!owner.isCurrent()) return retire();
    on(event, listener);
    if (!owner.isCurrent()) {
      // newListener runs before insertion: earlier disposal cannot remove this late addition.
      retire();
      target.removeListener(event, listener);
      return false;
    }
    return true;
  };
  if (!register(win, 'closed', closed)) return;
  if (!register(contents, 'destroyed', closed)) return;
  if (!register(contents, 'did-start-navigation', navigation)) return;
  interactiveProducer =
    is.windows() && config.interactive
      ? interactive(context.window, options, context, owner)
      : undefined;
  if (!owner.isCurrent()) {
    interactiveProducer?.dispose();
    return;
  }
  rating = createRatingFeedbackMain(context, options, owner);
  if (!owner.isCurrent()) {
    rating.dispose();
    return;
  }
  callback = registerCallback(
    (info, event) => {
      if (!owner.isCurrent()) return;
      rating?.observe(info);
      if (!owner.isCurrent()) return;
      interactiveProducer?.observe(info, event);
      if (!owner.isCurrent() || event === SongInfoEvent.TimeChanged) return;
      const newTrack = info.url !== currentUrl,
        unpaused =
          !newTrack &&
          event === SongInfoEvent.PlayOrPaused &&
          paused === true &&
          info.isPaused === false;
      currentUrl = info.url;
      paused = info.isPaused;
      if (
        !info.isPaused &&
        (newTrack || (config!.unpauseNotification && unpaused))
      )
        show(info);
      else if (
        interactiveProducer &&
        event === SongInfoEvent.PlayOrPaused &&
        config!.refreshOnPlayPause
      )
        show(info);
    },
    { replayCurrent: true },
  );
  if (!owner.isCurrent()) callback();
};
export const onMainLoad = async (
  context: BackendContext<NotificationsPluginConfig>,
) => {
  onMainStop();
  savedContext = context;
  const start = ++startRevision,
    revision = configRevision;
  const initial = await context.getConfig();
  if (start !== startRevision) return;
  if (revision === configRevision) config = initial;
  setup(context);
};
export const onConfigChange = (newConfig: NotificationsPluginConfig) => {
  const previous = config;
  configRevision++;
  config = newConfig;
  if (!newConfig.enabled) {
    onMainStop();
    return;
  }
  if (
    active &&
    previous &&
    (previous.interactive !== newConfig.interactive ||
      previous.trayControls !== newConfig.trayControls)
  ) {
    const track = active.track();
    onMainStop();
    if (savedContext) setup(savedContext, track);
  } else active?.configChanged();
};
