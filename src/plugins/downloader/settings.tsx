import { createSignal, For, Show } from 'solid-js';

import { t } from '@/i18n';

import type {
  AudioDescriptor,
  AudioPreference,
  DuplicatePolicy,
} from './audio';
import type { DownloaderPluginConfig } from './index';
import type { LibraryReport } from './library';

const tr = (key: string, options?: Record<string, string | number>) =>
  t(`plugins.downloader.quality.${key}`, options);
const reasonKeys: Record<string, string> = {
  'Cannot verify complete audio: content length missing or invalid':
    'unknownLength',
  'Audio-only source required': 'audioOnly',
  'DRM or segmented source unsupported': 'drm',
  'Unsupported source container/codec': 'container',
  'Invalid source itag': 'itag',
  'Live/Post-Live-DVR unsupported': 'live',
  'Track not playable in current session': 'unplayable',
  'Unknown source quality': 'unknownQuality',
  'Unindexed: source/completion unknown': 'unindexed',
  'Empty file': 'empty',
  'File differs from completed record': 'changed',
  'Verification read budget reached': 'budget',
  'Metadata read budget reached': 'metadataBudget',
  'Metadata unreadable; preserved': 'metadata',
  'Completed receipt verified at renamed path': 'renamed',
  'Indexed file missing': 'missing',
  'Select a track before inspecting source audio': 'selectTrack',
};
const translatedReason = (reason: string | undefined) =>
  reason && (reasonKeys[reason] ? tr(`reasons.${reasonKeys[reason]}`) : reason);

export interface DownloaderSettingsApi {
  invoke: (event: string, ...args: unknown[]) => Promise<unknown>;
  currentUrl: () => string;
  close: () => void;
}
export const DownloaderSettings = (props: {
  api: DownloaderSettingsApi;
  initial: {
    config: DownloaderPluginConfig;
    library?: LibraryReport;
    review?: { id: string; title: string; reason: string }[];
  };
}) => {
  const [source, setSource] = createSignal<AudioPreference>(
    props.initial.config.sourceAudio ?? { mode: 'best' },
  );
  const [preset, setPreset] = createSignal(props.initial.config.selectedPreset);
  const [policy, setPolicy] = createSignal<DuplicatePolicy>(
    props.initial.config.duplicatePolicy ?? 'legacy',
  );
  const [fallback, setFallback] = createSignal(
    !!props.initial.config.sourceFallback,
  );
  const [formats, setFormats] = createSignal<AudioDescriptor[]>([]);
  const [track, setTrack] = createSignal<{ id: string; title?: string }>();
  const [selected, setSelected] = createSignal('');
  const [library, setLibrary] = createSignal(props.initial.library);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const run = async (fn: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(
        translatedReason(e instanceof Error ? e.message : undefined) ??
          tr('failed'),
      );
    } finally {
      setBusy(false);
    }
  };
  const patchSource = (patch: Partial<AudioPreference>) =>
    setSource({ ...source(), ...patch });
  return (
    <>
      <header>
        <h2 id="pear-downloader-heading">{tr('title')}</h2>
        <button
          aria-label={tr('close')}
          onClick={() => props.api.close()}
          type="button"
        >
          ×
        </button>
      </header>
      <p>{tr('summary')}</p>
      <fieldset disabled={busy()}>
        <legend>{tr('preferences')}</legend>
        <label>
          {tr('source')}
          <select
            onChange={(e) =>
              patchSource({
                mode: e.currentTarget.value as AudioPreference['mode'],
                bitrate:
                  Number.isFinite(source().bitrate) &&
                  source().bitrate! > 0 &&
                  source().bitrate! <= 10000
                    ? source().bitrate
                    : 160,
                itag:
                  Number.isSafeInteger(source().itag) && source().itag! > 0
                    ? source().itag
                    : 251,
              })
            }
            value={source().mode}
          >
            <option value="best">{tr('best')}</option>
            <option value="opus">{tr('opus')}</option>
            <option value="aac">{tr('aac')}</option>
            <option value="bitrate">{tr('bitrateMode')}</option>
            <option value="itag">{tr('itagMode')}</option>
          </select>
        </label>
        <Show when={source().mode === 'bitrate'}>
          <label>
            {tr('bitrate')}
            <input
              max="10000"
              min="1"
              onInput={(e) =>
                patchSource({ bitrate: e.currentTarget.valueAsNumber })
              }
              type="number"
              value={source().bitrate ?? 160}
            />
          </label>
        </Show>
        <Show when={source().mode === 'itag'}>
          <label>
            {tr('itag')}
            <input
              min="1"
              onInput={(e) =>
                patchSource({ itag: e.currentTarget.valueAsNumber })
              }
              type="number"
              value={source().itag ?? 251}
            />
          </label>
        </Show>
        <label>
          {tr('language')}
          <select
            onChange={(e) =>
              patchSource({
                language:
                  e.currentTarget.value === 'original' ? 'original' : 'en',
              })
            }
            value={
              !source().language || source().language === 'original'
                ? 'original'
                : 'custom'
            }
          >
            <option value="original">{tr('originalLanguage')}</option>
            <option value="custom">{tr('specificLanguage')}</option>
          </select>
        </label>
        <Show when={source().language && source().language !== 'original'}>
          <label>
            {tr('languageCode')}
            <input
              maxlength={40}
              onInput={(e) => patchSource({ language: e.currentTarget.value })}
              value={source().language}
            />
          </label>
        </Show>
        <label class="check">
          <input
            checked={!!source().drc}
            onChange={(e) => patchSource({ drc: e.currentTarget.checked })}
            type="checkbox"
          />
          {tr('drc')}
        </label>
        <label>
          {tr('output')}
          <select
            onChange={(e) => setPreset(e.currentTarget.value)}
            value={preset()}
          >
            <option value="mp3 (256kbps)">{tr('outputMp3')}</option>
            <option value="Source">{tr('outputSource')}</option>
            <option value="Custom">{tr('outputCustom')}</option>
          </select>
        </label>
        <p>{tr('sourceHelp')}</p>
        <label>
          {tr('duplicate')}
          <select
            onChange={(e) =>
              setPolicy(e.currentTarget.value as DuplicatePolicy)
            }
            value={policy()}
          >
            <option value="legacy">{tr('legacy')}</option>
            <option value="skip-any">{tr('skipAny')}</option>
            <option value="keep-better">{tr('better')}</option>
            <option value="save-variant">{tr('variantPolicy')}</option>
            <option value="ask">{tr('ask')}</option>
          </select>
        </label>
        <p>{tr('duplicateHelp')}</p>
        <label class="check">
          <input
            checked={fallback()}
            onChange={(e) => setFallback(e.currentTarget.checked)}
            type="checkbox"
          />
          {tr('fallback')}
        </label>
        <button
          onClick={() =>
            run(async () => {
              await props.api.invoke('downloader-save-settings', {
                sourceAudio: source(),
                selectedPreset: preset(),
                duplicatePolicy: policy(),
                sourceFallback: fallback(),
              });
              setMessage(tr('saved'));
            })
          }
          type="button"
        >
          {tr('save')}
        </button>
      </fieldset>
      <fieldset disabled={busy()}>
        <legend>{tr('formats')}</legend>
        <button
          onClick={() =>
            run(async () => {
              const result = (await props.api.invoke(
                'downloader-formats',
                props.api.currentUrl(),
              )) as { id: string; title?: string; formats: AudioDescriptor[] };
              setTrack(result);
              setFormats(result.formats);
              setSelected(result.formats.find((f) => f.supported)?.key ?? '');
              setMessage(tr('refreshed'));
            })
          }
          type="button"
        >
          {tr('inspect')}
        </button>
        <Show when={track()}>
          <p>
            {track()?.title} · {track()?.id}
          </p>
          <label>
            {tr('variant')}
            <select
              onChange={(e) => setSelected(e.currentTarget.value)}
              value={selected()}
            >
              <For each={formats()}>
                {(f) => (
                  <option disabled={!f.supported} value={f.key}>
                    {f.codec || tr('unknownCodec')} ·{' '}
                    {f.muxed ? tr('tvExtraction') : ''}
                    {f.container || tr('unknownContainer')} ·{' '}
                    {(f.averageBitrate ?? f.bitrate)
                      ? tr('rate', {
                          bitrate: Math.round(
                            (f.averageBitrate ?? f.bitrate!) / 1000,
                          ),
                        })
                      : tr('unknownBitrate')}{' '}
                    ·{' '}
                    {f.language === 'original'
                      ? f.original
                        ? tr('originalVariant')
                        : tr('unknownLanguage')
                      : f.language}
                    {f.drc ? tr('drcVariant') : ''} ·{' '}
                    {tr('itagDetail', { itag: f.itag })}
                    {f.track ? ` · ${tr('trackDetail', { id: f.track })}` : ''}
                    {f.reason ? ` · ${translatedReason(f.reason)}` : ''}
                  </option>
                )}
              </For>
            </select>
          </label>
          <p>{tr('unavailable')}</p>
          <button
            disabled={!selected()}
            onClick={() =>
              run(async () => {
                const result = (await props.api.invoke(
                  'downloader-selected',
                  track()!.id,
                  selected(),
                )) as
                  | { status?: string; error?: string; path?: string }
                  | undefined;
                if (result?.status === 'failed')
                  throw new Error(result.error ?? tr('downloadFailed'));
                setMessage(
                  result?.status === 'saved'
                    ? tr('savedVariant', { path: result.path ?? '' })
                    : tr('result', { status: result?.status ?? 'skipped' }),
                );
              })
            }
            type="button"
          >
            {tr('download')}
          </button>
        </Show>
      </fieldset>
      <fieldset>
        <legend>{tr('library')}</legend>
        <Show when={props.initial.review?.length}>
          <p>{tr('review')}</p>
          <ul>
            <For each={props.initial.review}>
              {(row) => (
                <li>
                  {row.title}: {row.reason}
                  <button
                    disabled={busy()}
                    onClick={() =>
                      run(async () => {
                        const result = (await props.api.invoke(
                          'downloader-formats',
                          `https://music.youtube.com/watch?v=${encodeURIComponent(row.id)}`,
                        )) as {
                          id: string;
                          title?: string;
                          formats: AudioDescriptor[];
                        };
                        setTrack(result);
                        setFormats(result.formats);
                        setSelected(
                          result.formats.find((f) => f.supported)?.key ?? '',
                        );
                        setMessage(tr('chooseAbove'));
                      })
                    }
                    type="button"
                  >
                    {tr('reviewChoose')}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p>{tr('scanHelp')}</p>
        <button
          disabled={busy()}
          onClick={() =>
            run(async () => {
              setLibrary(
                (await props.api.invoke('downloader-scan')) as LibraryReport,
              );
              setMessage(tr('scanDone'));
            })
          }
          type="button"
        >
          {tr('scan')}
        </button>
        <Show when={busy()}>
          <button
            onClick={() => props.api.invoke('downloader-scan-cancel')}
            type="button"
          >
            {tr('cancelScan')}
          </button>
        </Show>
        <Show when={library()}>
          <p>
            {tr('scanSummary', { count: library()!.visited })}
            {library()!.truncated ? tr('limited') : ''}.{' '}
            {library()!.errors.join('; ')}
          </p>
          <ul>
            <For each={library()!.files.slice(0, 100)}>
              {(file) => (
                <li>
                  <strong>{tr(`status.${file.status}`)}</strong> · {file.path}
                  {file.videoId ? ` · ${file.videoId}` : ''}
                  {file.reason ? ` — ${translatedReason(file.reason)}` : ''}
                </li>
              )}
            </For>
          </ul>
          <Show when={library()!.files.length > 100}>
            <p>{tr('first100')}</p>
          </Show>
        </Show>
      </fieldset>
      <p aria-live="polite" role="status">
        {busy() ? tr('working') : message()}
      </p>
      <p role="alert">{error()}</p>
    </>
  );
};
