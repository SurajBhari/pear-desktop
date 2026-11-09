import { t } from '@/i18n';

export const NotFoundKaomoji = () => (
  <p
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
    {t('plugins.synced-lyrics.errors.not-found')}
  </p>
);
