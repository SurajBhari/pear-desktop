import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  untrack,
} from 'solid-js';
import { type VirtualizerHandle, VList } from 'virtua/solid';

import {
  ErrorDisplay,
  LoadingKaomoji,
  NotFoundKaomoji,
  SyncedLine,
  PlainLyrics,
} from './components';
import { LyricsPicker } from './components/LyricsPicker';
import { ensureReactiveRoot } from './reactive-root';
import { createLyricsScrollController } from './scroll-motion';
import { currentLyrics } from './store';
import { selectors } from './utils';
import { withInstrumentalGaps } from './word-timing';

import { lyricsDisplayTime, romanizationRatio } from '../tools';

import type { LineLyrics, SyncedLyricsPluginConfig } from '../types';

export const [isVisible, setIsVisible] = createSignal<boolean>(false);
export const [config, setConfig] =
  createSignal<SyncedLyricsPluginConfig | null>(null);

export const startLyricsEffects = () =>
  runWithOwner(ensureReactiveRoot(), () => {
    createEffect(() => {
      if (!config()?.enabled) return;
      const root = document.documentElement;

      // Saved effect names remain readable; emphasis never changes glyph metrics.
      const fancy = config()?.lineEffect === 'fancy';
      const styles = {
        '--lyrics-font-size': fancy ? '3rem' : 'clamp(1.4rem, 1.1vmax, 3rem)',
        '--lyrics-line-height': fancy
          ? '1.333'
          : 'var(--ytmusic-body-line-height)',
        '--lyrics-width': config()?.lineEffect === 'scale' ? '83%' : '100%',
        '--lyrics-padding': fancy ? '2rem' : '0',
        '--lyrics-romanization-ratio': String(
          romanizationRatio(config()?.romanizationSizePercent),
        ),
      };
      const previous = Object.keys(styles).map((key) => [
        key,
        root.style.getPropertyValue(key),
        root.style.getPropertyPriority(key),
      ]);
      for (const [key, value] of Object.entries(styles))
        root.style.setProperty(key, value);
      onCleanup(() => {
        for (const [key, value, priority] of previous) {
          if (value) root.style.setProperty(key, value, priority);
          else root.style.removeProperty(key);
        }
      });
    });
  });

type LyricsRendererChild =
  | { kind: 'LyricsPicker' }
  | { kind: 'LoadingKaomoji' }
  | { kind: 'NotFoundKaomoji' }
  | { kind: 'Error'; error: Error }
  | {
      kind: 'SyncedLine';
      line: LineLyrics;
    }
  | {
      kind: 'PlainLine';
      line: string;
    };

const lyricsPicker: LyricsRendererChild = { kind: 'LyricsPicker' };

export const [currentTime, setCurrentTime] = createSignal<number>(-1);
export const LyricsRenderer = () => {
  const [scroller, setScroller] = createSignal<VirtualizerHandle>();
  const [stickyRef, setStickRef] = createSignal<HTMLElement | null>(null);
  const [pageVisible, setPageVisible] = createSignal(!document.hidden);
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const [reducedMotion, setReducedMotion] = createSignal(preference.matches);
  const motion = createLyricsScrollController(scroller);
  let centerFrame: number | undefined;
  let centerEpoch = 0;
  let mounted = true;
  const cancelCenter = () => {
    centerEpoch++;
    if (centerFrame !== undefined) cancelAnimationFrame(centerFrame);
    centerFrame = undefined;
    motion.cancel();
  };
  const center = (index: number, immediate: boolean) => {
    cancelCenter();
    const owner = centerEpoch;
    // Data/visibility changes precede the virtual list's new measurements.
    centerFrame = requestAnimationFrame(() => {
      if (owner !== centerEpoch || !mounted) return;
      centerFrame = undefined;
      if (isVisible() && !document.hidden) motion.move(index, immediate);
    });
  };
  onCleanup(() => {
    mounted = false;
    cancelCenter();
  });

  const tab = document.querySelector<HTMLElement>(selectors.body.tabRenderer)!;

  let mouseCoord = 0;
  const mousemoveListener = (e: Event) => {
    if ('clientY' in e) {
      mouseCoord = (e as MouseEvent).clientY;
    }

    const { top } = tab.getBoundingClientRect();
    const height = stickyRef()?.clientHeight ?? 0;
    const scrollOffset = scroller()?.scrollOffset ?? -1;

    const isInView = scrollOffset <= height;
    const isMouseOver = mouseCoord - top - 5 <= height;

    const showPicker = isInView || isMouseOver;

    if (showPicker) {
      // picker visible
      stickyRef()?.style.setProperty('--lyrics-picker-top', '0');
    } else {
      // picker hidden
      stickyRef()?.style.setProperty('--lyrics-picker-top', `-${height}px`);
    }
  };

  onMount(() => {
    tab.addEventListener('mousemove', mousemoveListener);
    const visibility = () => setPageVisible(!document.hidden);
    const reduce = () => setReducedMotion(preference.matches);
    document.addEventListener('visibilitychange', visibility);
    preference.addEventListener('change', reduce);
    const interrupt = cancelCenter;
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      tab.addEventListener(event, interrupt, { passive: true });
    const resize = new ResizeObserver(() => {
      if (isVisible() && !document.hidden && currentIndex() >= 0)
        center(currentIndex() + 1, true);
    });
    resize.observe(tab);

    onCleanup(() => {
      tab.removeEventListener('mousemove', mousemoveListener);
      document.removeEventListener('visibilitychange', visibility);
      preference.removeEventListener('change', reduce);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
        tab.removeEventListener(event, interrupt);
      resize.disconnect();
      cancelCenter();
    });
  });
  createEffect(() => {
    if (!isVisible() || !scroller()) return;
    const vList = tab.querySelector<HTMLElement>('.synced-lyrics-vlist');
    vList?.addEventListener('scroll', mousemoveListener);
    vList?.addEventListener('scrollend', mousemoveListener);
    onCleanup(() => {
      vList?.removeEventListener('scroll', mousemoveListener);
      vList?.removeEventListener('scrollend', mousemoveListener);
    });
  });

  const [children, setChildren] = createSignal<LyricsRendererChild[]>([
    { kind: 'LoadingKaomoji' },
  ]);
  const displayLines = createMemo(() => {
    const lines = currentLyrics()?.data?.lines;
    return lines ? withInstrumentalGaps(lines) : undefined;
  });

  createEffect(() => {
    const current = currentLyrics();
    if (!current) {
      setChildren(() => [{ kind: 'NotFoundKaomoji' }]);
      return;
    }

    const { state, data, error } = current;

    setChildren(() => {
      if (state === 'fetching') {
        return [{ kind: 'LoadingKaomoji' }];
      }

      if (state === 'error') {
        return [{ kind: 'Error', error: error! }];
      }

      if (data?.lines) {
        return displayLines()!.map((line) => ({
          kind: 'SyncedLine' as const,
          line,
        }));
      }

      if (data?.lyrics) {
        const lines = data.lyrics.split('\n').filter((line) => line.trim());
        return lines.map((line) => ({
          kind: 'PlainLine' as const,
          line,
        }));
      }

      return [{ kind: 'NotFoundKaomoji' }];
    });
  });

  const [statuses, setStatuses] = createSignal<
    ('previous' | 'current' | 'upcoming')[]
  >([]);
  createEffect(() => {
    const time = lyricsDisplayTime(currentTime(), config()?.timingOffsetMs);
    const lines = displayLines();
    if (!lines) return setStatuses([]);

    const previous = untrack(statuses);
    const current = lines.map((line) => {
      if (line.timeInMs > time) return 'upcoming';
      if (time - line.timeInMs >= line.duration) return 'previous';
      return 'current';
    });

    if (previous.length !== current.length) return setStatuses(current);
    if (previous.every((status, idx) => status === current[idx])) return;

    setStatuses(current);
    return;
  });

  const [currentIndex, setCurrentIndex] = createSignal(-1);
  createEffect(() => {
    const index = statuses().findIndex((status) => status === 'current');
    setCurrentIndex(index);
  });

  createEffect(() => {
    const current = currentLyrics();
    const idx = currentIndex();
    if (
      !isVisible() ||
      !pageVisible() ||
      !scroller() ||
      !current?.data?.lines ||
      idx < 0
    )
      return cancelCenter();
    // Index 0 is the provider picker; retarget from the actual current scroll offset.
    center(idx + 1, reducedMotion());
  });

  return (
    <Show when={isVisible()}>
      <VList
        {...{
          ref: setScroller,
          style: { 'scrollbar-width': 'none' },
          class: 'synced-lyrics-vlist',
          keepMounted: [0],
          overscan: 4,
        }}
        data={[lyricsPicker, ...children()]}
      >
        {(props, idx) => {
          if (typeof props === 'undefined') return null;
          switch (props.kind) {
            case 'LyricsPicker':
              return <LyricsPicker setStickRef={setStickRef} />;
            case 'Error':
              return <ErrorDisplay {...props} />;
            case 'LoadingKaomoji':
              return <LoadingKaomoji />;
            case 'NotFoundKaomoji':
              return <NotFoundKaomoji />;
            case 'SyncedLine': {
              return (
                <SyncedLine
                  {...props}
                  index={idx()}
                  scroller={scroller()!}
                  status={statuses()[idx() - 1]}
                />
              );
            }
            case 'PlainLine': {
              return <PlainLyrics {...props} />;
            }
          }
        }}
      </VList>
    </Show>
  );
};
