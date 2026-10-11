import { parse } from 'node-html-parser';

// Public channel metadata only; adapted from Nynele's upstream PR #4491.
const limits = {
  cache: 64,
  positiveTtl: 6 * 60 * 60 * 1000,
  negativeTtl: 60 * 1000,
  bytes: 256 * 1024,
  deadline: 5000,
  concurrent: 2,
  interval: 1000,
};
const imageHosts = new Set([
  'yt3.googleusercontent.com',
  'yt3.ggpht.com',
  'lh3.googleusercontent.com',
]);
const channelUrl = (value: string | undefined): string | null => {
  if (!value || value.length > 256) return null;
  try {
    const url = new URL(value);
    const channel = /^\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
    return url.protocol === 'https:' &&
      ['music.youtube.com', 'www.youtube.com'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      channel
      ? `https://www.youtube.com/channel/${channel[1]}?ucbcb=1`
      : null;
  } catch {
    return null;
  }
};
const imageUrl = (value: string | undefined): string | null => {
  if (
    !value ||
    value.length > 2048 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      imageHosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.href.length <= 2048
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const metadataImage = (html: string): string | null => {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd < 0 ? html : html.slice(0, headEnd);
  for (const meta of parse(head).querySelectorAll('meta')) {
    if (
      (
        meta.getAttribute('property') ?? meta.getAttribute('name')
      )?.toLowerCase() !== 'og:image'
    )
      continue;
    const image = imageUrl(meta.getAttribute('content'));
    if (image) return image;
  }
  return null;
};
type Work = {
  controller: AbortController;
  generation: number;
  promise: Promise<string | null>;
};

/** Bounded plugin-local cache; canceled physical requests retain capacity until they settle. */
export class DiscordArtistArtwork {
  private readonly cache = new Map<
    string,
    { value: string | null; expires: number }
  >();
  private readonly byChannel = new Map<string, Work>();
  private readonly physical = new Set<Work>();
  private generation = 0;
  private nextRequest = 0;

  cancel(clearCache = false) {
    this.generation++;
    for (const work of this.physical) work.controller.abort();
    if (clearCache) this.cache.clear();
  }

  async load(
    artistUrl: string | undefined,
    current: () => boolean,
  ): Promise<string | null> {
    const url = channelUrl(artistUrl);
    const owned = () => {
      try {
        return current();
      } catch {
        return false;
      }
    };
    if (!url || !owned()) return null;
    const cached = this.cache.get(url),
      now = Date.now();
    if (cached && cached.expires > now) {
      this.cache.delete(url);
      this.cache.set(url, cached);
      return owned() ? cached.value : null;
    }
    this.cache.delete(url);
    const existing = this.byChannel.get(url);
    if (existing?.generation === this.generation)
      return existing.promise.then((value) => (owned() ? value : null));
    if (this.physical.size >= limits.concurrent || now < this.nextRequest)
      return null;
    this.nextRequest = now + limits.interval;
    const work: Work = {
      controller: new AbortController(),
      generation: this.generation,
      promise: Promise.resolve(null),
    };
    const currentRequest = () => work.generation === this.generation && owned();
    const live = () => currentRequest() && !work.controller.signal.aborted;
    this.physical.add(work);
    this.byChannel.set(url, work);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      work.controller.abort();
    }, limits.deadline);
    timer.unref?.();
    work.promise = (async () => {
      let value: string | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        // Node's global fetch has no Electron-session cookies or private profile.
        const response = await fetch(url, {
          credentials: 'omit',
          redirect: 'error',
          signal: work.controller.signal,
          headers: [
            ['Accept', 'text/html'],
            // Ask for public OpenGraph rendering, identifying the compatible client.
            [
              'User-Agent',
              'Mozilla/5.0 (compatible; Discordbot/2.0; Pear Desktop public artist metadata)',
            ],
          ],
        });
        reader = response.body?.getReader();
        if (
          response.ok &&
          /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
            response.headers.get('content-type') ?? '',
          ) &&
          reader &&
          live()
        ) {
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let bytes = 0,
            html = '';
          while (live()) {
            const part = await reader.read();
            if (!live()) break;
            if (part.done) {
              html += decoder.decode();
              value = metadataImage(html);
              break;
            }
            bytes += part.value.byteLength;
            if (bytes > limits.bytes) break;
            html += decoder.decode(part.value, { stream: true });
            value = metadataImage(html);
            if (value || /<\/head\s*>/i.test(html)) break;
          }
        }
      } catch {
        /* Public metadata failure falls back to the standard cover. */
      } finally {
        try {
          await reader?.cancel();
        } catch {
          /* Retired response. */
        }
      }
      if (!currentRequest() || (work.controller.signal.aborted && !timedOut))
        return null;
      if (timedOut) value = null;
      this.cache.set(url, {
        value,
        expires: Date.now() + (value ? limits.positiveTtl : limits.negativeTtl),
      });
      while (this.cache.size > limits.cache)
        this.cache.delete(this.cache.keys().next().value!);
      return value;
    })().finally(() => {
      clearTimeout(timer);
      this.physical.delete(work);
      if (this.byChannel.get(url) === work) this.byChannel.delete(url);
    });
    return work.promise;
  }
}
