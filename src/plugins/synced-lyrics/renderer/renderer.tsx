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
        '--lyrics-font-size': fancy
          ? 'clamp(2.4rem, 3vw, 3rem)'
          : 'clamp(1.4rem, 1.1vmax, 3rem)',
        '--lyrics-line-height': fancy
          ? '1.333'
          : 'var(--ytmusic-body-line-height)',
        '--lyrics-width': config()?.lineEffect === 'scale' ? '83%' : '100%',
        '--lyrics-padding': fancy ? '16px' : '0',
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
export const [isPlaying, setIsPlaying] = createSignal(false);
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

  let pointer: { x: number; y: number } | null = null;
  let keyboardMode = true;
  let windowActive = true;
  const updatePicker = (
    focusTarget: EventTarget | null = document.activeElement,
  ) => {
    const picker = stickyRef();
    if (!picker) return;
    const { top, left, right, bottom } = tab.getBoundingClientRect();
    const height = picker.offsetHeight;
    const scrollOffset = scroller()?.scrollOffset ?? -1;
    const isInView = scrollOffset <= height;
    // Use the reveal region, rather than the moving picker's bounds, so hiding
    // it never removes the target needed to reveal it again.
    const isPointerOver =
      pointer !== null &&
      pointer.x >= left &&
      pointer.x < right &&
      pointer.y >= top &&
      pointer.y < Math.min(top + height + 5, bottom);
    const hasKeyboardFocus =
      keyboardMode &&
      focusTarget instanceof Node &&
      picker.contains(focusTarget);
    const showPicker =
      windowActive &&
      !document.hidden &&
      (isInView || isPointerOver || hasKeyboardFocus);
    picker.style.setProperty(
      '--lyrics-picker-top',
      showPicker ? '0' : `-${height}px`,
    );
  };
  const pointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    updatePicker();
  };
  const pointerLeave = () => {
    pointer = null;
    updatePicker();
  };
  const pointerDown = (event: PointerEvent) => {
    // A mouse/touch click may focus a button, but must not latch hover open.
    keyboardMode = false;
    if (event.pointerType === 'touch') pointer = null;
    updatePicker();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    keyboardMode = true;
    updatePicker();
  };
  const focusChange = (event: FocusEvent) => {
    updatePicker(
      event.type === 'focusout' ? event.relatedTarget : event.target,
    );
  };
  const windowBlur = () => {
    windowActive = false;
    pointerLeave();
  };
  const windowFocus = () => {
    windowActive = true;
    updatePicker();
  };

  onMount(() => {
    tab.addEventListener('pointermove', pointerMove);
    tab.addEventListener('pointerleave', pointerLeave);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('keydown', keyDown, true);
    tab.addEventListener('focusin', focusChange);
    tab.addEventListener('focusout', focusChange);
    window.addEventListener('blur', windowBlur);
    window.addEventListener('focus', windowFocus);
    const visibility = () => {
      setPageVisible(!document.hidden);
      if (document.hidden) pointer = null;
      updatePicker();
    };
    const reduce = () => setReducedMotion(preference.matches);
    document.addEventListener('visibilitychange', visibility);
    preference.addEventListener('change', reduce);
    const interrupt = cancelCenter;
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      tab.addEventListener(event, interrupt, { passive: true });
    const resize = new ResizeObserver(() => {
      updatePicker();
      if (isVisible() && !document.hidden && currentIndex() >= 0)
        center(currentIndex() + 1, true);
    });
    resize.observe(tab);

    onCleanup(() => {
      tab.removeEventListener('pointermove', pointerMove);
      tab.removeEventListener('pointerleave', pointerLeave);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('keydown', keyDown, true);
      tab.removeEventListener('focusin', focusChange);
      tab.removeEventListener('focusout', focusChange);
      window.removeEventListener('blur', windowBlur);
      window.removeEventListener('focus', windowFocus);
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
    const scroll = () => updatePicker();
    vList?.addEventListener('scroll', scroll);
    vList?.addEventListener('scrollend', scroll);
    updatePicker();
    onCleanup(() => {
      vList?.removeEventListener('scroll', scroll);
      vList?.removeEventListener('scrollend', scroll);
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
