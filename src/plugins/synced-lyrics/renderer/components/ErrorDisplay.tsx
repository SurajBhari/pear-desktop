import { t } from '@/i18n';
import { getSongInfo } from '@/providers/song-info-front';

import { lyricsStore, retrySearch } from '../store';

interface ErrorDisplayProps {
  error: Error;
}

export const ErrorDisplay = (_props: ErrorDisplayProps) => (
  <div
    class="lyrics-status"
    role="status"
    style={{
      'padding': '2rem 1.5rem',
      'color': 'var(--ytmusic-text-secondary)',
      'font-family': 'var(--lyrics-font-family)',
      'font-size': '1.4rem',
      'line-height': '1.5',
    }}
  >
    <p>{t('plugins.synced-lyrics.errors.fetch')}</p>
    <button
      class="lyrics-retry"
      onClick={() => retrySearch(lyricsStore.provider, getSongInfo())}
      style={{
        'margin-top': '1rem',
        'padding': '0.75rem 1.5rem',
        'border': '1px solid currentColor',
        'border-radius': '2rem',
        'background': 'transparent',
        'color': 'var(--ytmusic-text-primary)',
        'font': 'inherit',
        'cursor': 'pointer',
      }}
      type="button"
    >
      {t('plugins.synced-lyrics.refetch-btn.normal')}
    </button>
  </div>
);
