import { FormatUtils, Utils, type YT } from 'youtubei.js';

import { validAudioLength } from './audio';

// Keep transport diagnostics independent of SDK response objects, which can
// contain signed media URLs, response headers and bodies.
export class AudioTransferError extends Error {
  readonly stage = 'transfer';
  readonly httpStatus?: number;

  constructor(
    reason: 'failed' | 'Incomplete' | 'Excess' = 'failed',
    error?: unknown,
  ) {
    let status: unknown;
    const info: unknown =
      error instanceof Utils.InnertubeError ? error.info : undefined;
    if (
      typeof info === 'object' &&
      info !== null &&
      'error_type' in info &&
      info.error_type === 'FETCH_FAILED' &&
      'response' in info
    ) {
      const response = info.response;
      if (
        typeof response === 'object' &&
        response !== null &&
        'ok' in response &&
        response.ok === false &&
        'status' in response
      )
        status = response.status;
    }
    const httpStatus =
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599 &&
      (status < 200 || status >= 300)
        ? status
        : undefined;
    super(
      `${reason === 'failed' ? 'Audio transfer failed' : `${reason} audio transfer`} (stage: transfer${httpStatus === undefined ? '' : `; HTTP status: ${httpStatus}`}); no file or completion record saved`,
    );
    this.httpStatus = httpStatus;
  }
}

export type DownloadInfo = Pick<
  YT.VideoInfo,
  'streaming_data' | 'playability_status' | 'page' | 'actions' | 'cpn'
>;
export type SelectedFormat = ReturnType<YT.VideoInfo['chooseFormat']>;
export async function downloadSelectedAudio(
  info: DownloadInfo,
  format: SelectedFormat,
  assertCurrent: () => void,
): Promise<AsyncGenerator<Uint8Array, void>> {
  assertCurrent();
  if (!validAudioLength(format.content_length))
    throw new Error('Audio content length missing or invalid');
  if (
    !info.streaming_data ||
    ![
      ...info.streaming_data.formats,
      ...info.streaming_data.adaptive_formats,
    ].includes(format)
  )
    throw new Error('Selected source does not belong to current response');
  if (
    info.page[0].video_details?.is_live ||
    info.page[0].video_details?.is_post_live_dvr
  )
    throw new Error('Live/Post-Live-DVR audio transfer unsupported');
  const length = format.content_length;
  const data = info.streaming_data;
  await Promise.resolve();
  assertCurrent();
  return (async function* () {
    // Consumption starts inside the processing mutex, so queued operations do
    // not let the SDK prefetch an entire 10 MiB range into each stream.
    assertCurrent();
    const stream = await FormatUtils.download(
      { itag: format.itag, type: 'audio', format: 'any' },
      info.actions,
      info.playability_status,
      { ...data, formats: [], adaptive_formats: [format] },
      info.actions.session.player,
      info.cpn,
    );
    try {
      assertCurrent();
    } catch (error) {
      await stream.cancel().catch(() => {});
      throw error;
    }
    const reader = stream.getReader();
    let received = 0;
    let complete = false;
    try {
      while (true) {
        assertCurrent();
        const result = await reader.read();
        assertCurrent();
        if (result.done) break;
        received += result.value.byteLength;
        if (received > length) throw new AudioTransferError('Excess');
        yield result.value;
      }
      if (received !== length) throw new AudioTransferError('Incomplete');
      complete = true;
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();
}
