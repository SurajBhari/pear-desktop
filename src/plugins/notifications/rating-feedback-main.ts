import { randomBytes } from 'node:crypto';

import { ipcMain, Notification, type IpcMainEvent } from 'electron';

import { t } from '@/i18n';
import {
  parsePlaybackBinding,
  samePlaybackBinding,
  type PlaybackBinding,
} from '@/providers/playback-owner';
import {
  getSongInfoPlaybackBinding,
  getSongInfoProvenance,
  isSongInfoCurrent,
  type SongInfo,
  type SongInfoProvenance,
} from '@/providers/song-info';

import { notificationImage } from './utils';

import type { NotificationsPluginConfig } from './index';
import type { BackendContext } from '@/types/contexts';

const ARM = 'peard:rating-feedback-arm',
  STATE = 'peard:rating-feedback-state';
type Rating = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';
type Challenge = {
  info: SongInfo;
  provenance: SongInfoProvenance;
  binding: PlaybackBinding;
  frame: Electron.WebFrameMain;
  nonce: string;
  generation: number;
  state?: Rating;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length &&
  expected.every((k) => Object.hasOwn(v, k));
const rating = (v: unknown): v is Rating =>
  v === 'LIKE' || v === 'DISLIKE' || v === 'INDIFFERENT';

export function createRatingFeedbackMain(
  context: BackendContext<NotificationsPluginConfig>,
  config: () => NotificationsPluginConfig,
  owner: { isCurrent(): boolean },
) {
  const win = context.window,
    contents = win.webContents;
  let live = true,
    info: SongInfo | undefined,
    challenge: Challenge | undefined;
  const notifications = new Map<Notification, () => void>();
  const scalar = (expected?: Challenge) =>
    live && owner.isCurrent() && live && (!expected || challenge === expected);
  const current = (expected?: Challenge) => {
    if (!scalar(expected)) return false;
    try {
      const options = config();
      if (!scalar(expected) || !options.enabled || !options.notifyOnLikeChange)
        return false;
      if (
        win.isDestroyed() ||
        !scalar(expected) ||
        win.webContents !== contents ||
        contents.isDestroyed() ||
        !scalar(expected)
      )
        return false;
      if (expected) {
        const frame = contents.mainFrame;
        if (
          !scalar(expected) ||
          frame !== expected.frame ||
          !isSongInfoCurrent(expected.info, win) ||
          !scalar(expected)
        )
          return false;
        const provenance = getSongInfoProvenance(expected.info),
          binding = getSongInfoPlaybackBinding(expected.info);
        if (
          !scalar(expected) ||
          provenance !== expected.provenance ||
          !samePlaybackBinding(binding, expected.binding)
        )
          return false;
      }
      return scalar(expected);
    } catch {
      return false;
    }
  };
  const close = (toast: Notification) => {
    const listener = notifications.get(toast);
    notifications.delete(toast);
    if (listener) toast.removeListener('close', listener);
    try {
      toast.close();
    } catch {
      /* Native teardown is best effort. */
    }
  };
  const retire = () => {
    challenge = undefined;
    for (const toast of [...notifications.keys()]) close(toast);
  };
  const reconcile = () => {
    if (!current() || !info) {
      retire();
      return undefined;
    }
    const captured = info;
    if (!isSongInfoCurrent(captured, win) || !current() || info !== captured) {
      retire();
      return undefined;
    }
    const provenance = getSongInfoProvenance(captured),
      binding = getSongInfoPlaybackBinding(captured),
      frame = contents.mainFrame;
    if (!provenance || !binding || !current() || info !== captured) {
      retire();
      return undefined;
    }
    if (
      challenge &&
      challenge.info === captured &&
      challenge.provenance === provenance &&
      challenge.frame === frame &&
      samePlaybackBinding(challenge.binding, binding)
    )
      return current(challenge) ? challenge : undefined;
    retire();
    if (!current() || info !== captured) return undefined;
    const candidate: Challenge = {
      info: captured,
      provenance,
      binding,
      frame,
      nonce: randomBytes(32).toString('hex'),
      generation: 0,
    };
    challenge = candidate;
    return current(candidate) ? candidate : undefined;
  };
  const arm = (c: Challenge) => {
    if (current(c)) {
      const send = contents.send.bind(contents);
      if (current(c)) send(ARM, { nonce: c.nonce, binding: c.binding });
    }
  };
  const notify = (c: Challenge, state: Rating) => {
    if (!current(c)) return;
    const options = config(),
      title = t(
        `plugins.notifications.rating.${state === 'LIKE' ? 'liked' : state === 'DISLIKE' ? 'disliked' : 'removed'}`,
      ),
      body = c.info.title;
    if (!current(c)) return;
    const icon = notificationImage(c.info, options);
    if (!current(c)) return;
    const toast = new Notification({
      title,
      body,
      icon,
      silent: true,
      urgency: options.urgency,
    });
    if (!current(c)) {
      try {
        toast.close();
      } catch {}
      return;
    }
    const closed = () => {
      notifications.delete(toast);
      toast.removeListener('close', closed);
    };
    notifications.set(toast, closed);
    const on = toast.on.bind(toast) as (
      event: 'close',
      listener: () => void,
    ) => Notification;
    if (!current(c)) {
      close(toast);
      return;
    }
    on('close', closed);
    if (!current(c)) {
      close(toast);
      return;
    }
    const show = toast.show.bind(toast);
    if (!current(c)) {
      close(toast);
      return;
    }
    show();
    if (!current(c)) close(toast);
  };
  const receive = (event: IpcMainEvent, ...args: unknown[]) => {
    if (args.length !== 1 || !record(args[0]) || !current()) return;
    let frame: Electron.WebFrameMain;
    try {
      frame = contents.mainFrame;
      if (
        event.sender !== contents ||
        event.senderFrame !== frame ||
        !current() ||
        contents.mainFrame !== frame
      )
        return;
    } catch {
      return;
    }
    const value = args[0];
    if (value.type === 'ready' && keys(value, ['type'])) {
      const c = reconcile();
      if (c && c.frame === frame) arm(c);
      return;
    }
    const c = challenge;
    if (!c || !current(c) || c.frame !== frame || value.nonce !== c.nonce)
      return;
    const binding = parsePlaybackBinding(value.binding);
    if (!samePlaybackBinding(binding, c.binding) || !current(c)) return;
    if (value.type === 'retire' && keys(value, ['type', 'nonce', 'binding'])) {
      retire();
      return;
    }
    if (
      !keys(value, ['type', 'nonce', 'binding', 'sourceGeneration', 'state']) ||
      (value.type !== 'snapshot' && value.type !== 'change') ||
      !rating(value.state) ||
      !Number.isSafeInteger(value.sourceGeneration) ||
      (value.sourceGeneration as number) <= 0
    )
      return;
    const generation = value.sourceGeneration as number;
    if (value.type === 'snapshot') {
      if (generation > c.generation) {
        c.generation = generation;
        c.state = value.state;
      }
      return;
    }
    if (
      generation !== c.generation ||
      c.state === undefined ||
      c.state === value.state
    )
      return;
    c.state = value.state;
    notify(c, value.state);
  };
  const navigation = (
    _event: unknown,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) retire();
  };
  ipcMain.on(STATE, receive);
  contents.on('did-start-navigation', navigation);
  return {
    configChanged() {
      retire();
      const c = reconcile();
      if (c) arm(c);
    },
    observe(value: SongInfo) {
      if (!live) return;
      info = value;
      const previous = challenge,
        c = reconcile();
      if (c && c !== previous) arm(c);
    },
    dispose() {
      if (!live) return;
      live = false;
      retire();
      info = undefined;
      ipcMain.removeListener(STATE, receive);
      contents.removeListener('did-start-navigation', navigation);
    },
  };
}
