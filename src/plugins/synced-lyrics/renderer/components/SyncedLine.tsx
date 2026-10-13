import {
  createEffect,
  For,
  Show,
  createSignal,
  createMemo,
  onCleanup,
} from 'solid-js';
import { type VirtualizerHandle } from 'virtua/solid';

import { t } from '@/i18n';
import { type LineLyrics } from '@/plugins/synced-lyrics/types';

import { _ytAPI } from '..';
import { lyricsDisplayTime, lyricsSeekTime } from '../../tools';
import { config, currentTime } from '../renderer';
import {
  canonicalize,
  convertChineseCharacter,
  romanize,
  simplifyUnicode,
} from '../utils';
import { renderedWords } from '../word-timing';

interface SyncedLineProps {
  scroller: VirtualizerHandle;
  index: number;
  line: LineLyrics;
  status: 'upcoming' | 'current' | 'previous';
}

const displayTime = () =>
  lyricsDisplayTime(currentTime(), config()?.timingOffsetMs);
const seek = (line: LineLyrics) =>
  _ytAPI?.seekTo(lyricsSeekTime(line.timeInMs, config()?.timingOffsetMs));
const keySeek = (event: KeyboardEvent, line: LineLyrics) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  seek(line);
};
const convertText = (text: string) => {
  const conversion = config()?.convertChineseCharacter;
  return conversion && conversion !== 'disabled'
    ? convertChineseCharacter(text, conversion)
    : text;
};

const EmptyLine = (props: SyncedLineProps) => {
  const states = createMemo(() => {
    const text = config()?.defaultTextString ?? '';
    return Array.isArray(text) ? text : [text];
  });
  const text = createMemo(() => {
    const progress = Math.max(
      0,
      Math.min(1, (displayTime() - props.line.timeInMs) / props.line.duration),
    );
    const index = Number.isFinite(progress)
      ? Math.floor((states().length - 1) * progress)
      : 0;
    return states()[props.status === 'current' ? index : 0] ?? '';
  });
  const knownGap = () =>
    Number.isFinite(props.line.duration) && props.line.duration >= 2000;
  return (
    <div
      aria-label={t('plugins.synced-lyrics.instrumental-break')}
      class={`synced-line ${props.status}`}
      onClick={() => seek(props.line)}
      onKeyDown={(event) => keySeek(event, props.line)}
      role="button"
      tabIndex={0}
    >
      <div class="description ytmusic-description-shelf-renderer" dir="auto">
        <div class="text-lyrics">
          <Show when={config()?.showTimeCodes}>
            <span class="lyrics-time">[{props.line.time}] </span>
          </Show>
          <Show when={knownGap()}>
            <span
              aria-label={t('plugins.synced-lyrics.instrumental-break')}
              class="instrumental-indicator"
              role="img"
            >
              <span aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </span>
          </Show>
          <span class="lyrics-placeholder">{text()}</span>
        </div>
      </div>
    </div>
  );
};

export const SyncedLine = (props: SyncedLineProps) => {
  const text = createMemo(() => convertText(props.line.text));
  const words = createMemo(() => {
    const timed = renderedWords(props.line);
    if (!timed) return null;
    const converted = timed.map((word) => ({
      ...word,
      word: convertText(word.word),
    }));
    // Context-sensitive conversion/romanization cannot borrow guessed alignment.
    return converted.map((word) => word.word).join('') === text()
      ? converted
      : null;
  });
  const [romanization, setRomanization] = createSignal('');
  createEffect(() => {
    const input = canonicalize(text());
    const enabled = config()?.romanization;
    let active = true;
    onCleanup(() => {
      active = false;
    });
    if (!enabled) return;
    romanize(input)
      .then((result) => {
        if (active) setRomanization(canonicalize(result));
      })
      .catch(() => {
        if (active) setRomanization(input);
      });
  });
  return (
    <Show fallback={<EmptyLine {...props} />} when={text().trim()}>
      <div
        aria-label={text()}
        class={`synced-line ${props.status}`}
        onClick={() => seek(props.line)}
        onKeyDown={(event) => keySeek(event, props.line)}
        role="button"
        tabIndex={0}
      >
        <div class="description ytmusic-description-shelf-renderer" dir="auto">
          <div class="text-lyrics">
            <Show when={config()?.showTimeCodes}>
              <span class="lyrics-time">[{props.line.time}] </span>
            </Show>
            <span class="lyrics-original" dir="auto">
              <Show fallback={text()} when={words()}>
                <For each={words()}>
                  {(word) => (
                    <span
                      class={`lyrics-word ${props.status === 'current' && displayTime() >= word.timeInMs ? 'sung' : 'upcoming'}`}
                    >
                      {word.word}
                    </span>
                  )}
                </For>
              </Show>
            </span>
            <Show
              when={
                config()?.romanization &&
                simplifyUnicode(text()) !== simplifyUnicode(romanization())
              }
            >
              <span class="romaji">
                <yt-formatted-string
                  text={{ runs: [{ text: romanization() }] }}
                />
              </span>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};
