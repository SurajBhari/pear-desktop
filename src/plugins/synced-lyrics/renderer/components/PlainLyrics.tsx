import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from 'solid-js';

import { config } from '../renderer';
import {
  canonicalize,
  convertChineseCharacter,
  romanize,
  simplifyUnicode,
} from '../utils';

interface PlainLyricsProps {
  line: string;
}

export const PlainLyrics = (props: PlainLyricsProps) => {
  const [romanization, setRomanization] = createSignal('');
  const text = createMemo(() => {
    let line = props.line;
    const convertChineseText = config()?.convertChineseCharacter;
    if (convertChineseText && convertChineseText !== 'disabled') {
      line = convertChineseCharacter(line, convertChineseText);
    }
    return line;
  });

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
    <div
      class={`${
        props.line.match(/^\[.+\]$/s) ? 'lrc-header' : ''
      } text-lyrics description ytmusic-description-shelf-renderer`}
      style={{
        'display': 'flex',
        'flex-direction': 'column',
      }}
    >
      <yt-formatted-string
        text={{
          runs: [{ text: text() }],
        }}
      />
      <Show
        when={
          config()?.romanization &&
          simplifyUnicode(text()) !== simplifyUnicode(romanization())
        }
      >
        <yt-formatted-string
          class="romaji"
          text={{
            runs: [{ text: romanization() }],
          }}
        />
      </Show>
    </div>
  );
};
