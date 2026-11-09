// EAPI protocol adapted from upstream #4113 by ArjixWasTaken (MIT), itself
// adapted from https://greasyfork.org/en/scripts/548724 (MIT).
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { jaroWinkler } from '@skyra/jaro-winkler';
import { z } from 'zod';

import { LRC } from '../parsers/lrc';

import type { LyricResult } from '../types';
import type { BackendContext } from '@/types/contexts';

const inputSchema = z.object({
  title: z.string().trim().min(1).max(512),
  artist: z.string().trim().min(1).max(512),
  songDuration: z.number().finite().positive().max(86400),
});
const songSchema = z.object({
  resourceId: z.coerce.number().int().positive(),
  baseInfo: z.object({
    simpleSongData: z.object({
      name: z.string().max(512),
      ar: z
        .array(z.object({ name: z.string().max(512) }))
        .max(20)
        .optional(),
      dt: z.number().finite().positive(),
    }),
  }),
});
const searchSchema = z.object({
  data: z.object({ resources: z.array(songSchema).max(50).default([]) }),
});
const lyricSchema = z.object({
  lrc: z
    .object({
      lyric: z
        .string()
        .max(512 * 1024)
        .nullable(),
    })
    .optional(),
});
const key = 'e82ckenh8dichen8';
const encodeKey = '3go8&$8*3*3h0k(2)2';
const checkToken =
  '9ca17ae2e6ffcda170e2e6ee8ad85dba908ca4d74da9ac8ea2d44e938f9eadc66da5a8979af572a5a9b68ac12af0feaec3b92aa69af9b1d372f6b8adccb35e968b9bb6c14f908d0099fb6ff48efdacd361f5b6ee9e';
const md5 = (value: string | Buffer) =>
  createHash('md5').update(value).digest();

// Keep the upstream title decomposition, bounded by the validated title length.
const splitTitle = (title: string): string[] => {
  const pattern =
    /(?:[「『](?<content>.+?)[」』])|(?:【.*?】|〖.*?〗|\(.*?\)|（.*?）)|(?<delimiter>\s+-\s+|\s*[/／|:|│]\s*)/i;
  const noise = /\b(MV|PV)\b|\b(?:covered by|feat?|ft?)\b.+/gi;
  const parse = (text: string): string[] => {
    if (!text.trim()) return [];
    const match = text.match(pattern);
    if (!match || match.index === undefined) return [text];
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const { delimiter, content } = match.groups ?? {};
    if (delimiter && (before.trim().length < 2 || after.trim().length < 2)) {
      const remaining = parse(after);
      return [before + match[0] + (remaining[0] ?? ''), ...remaining.slice(1)];
    }
    return [...parse(before), ...(content ? [content] : []), ...parse(after)];
  };
  return [
    ...new Set(
      parse(title)
        .map((part) => part.replace(noise, '').trim())
        .filter(Boolean),
    ),
  ].slice(0, 3);
};

class NetEaseAPI {
  private registration?: Promise<void>;
  private cookies = new Map<string, string>();
  constructor(
    private fetch: (url: string, init: RequestInit) => Promise<Response>,
    private assertCurrent: () => void,
    private signal: AbortSignal,
  ) {}

  private async request(path: string, data: Record<string, unknown>) {
    this.assertCurrent();
    const body = JSON.stringify({
      ...data,
      header: JSON.stringify({
        os: 'osx',
        appver: '3.0.14',
        requestId: 0,
        osver: '15.6.1',
      }),
    });
    const sign = md5(`nobody/api${path}use${body}md5forencrypt`).toString(
      'hex',
    );
    const payload = `/api${path}-36cd479b6b5-${body}-36cd479b6b5-${sign}`;
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(key), null);
    const encrypted = Buffer.concat([
      cipher.update(payload, 'utf8'),
      cipher.final(),
    ])
      .toString('hex')
      .toUpperCase();
    let response: Response;
    try {
      response = await this.fetch(
        `https://interface.music.163.com/eapi${path}?_nmclfl=1`,
        {
          method: 'POST',
          credentials: 'omit',
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NeteaseMusicDesktop/3.0.14.2534',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': [...this.cookies]
              .map(([name, value]) => `${name}=${value}`)
              .join('; '),
          },
          body: new URLSearchParams({ params: encrypted }).toString(),
        },
      );
    } catch {
      this.assertCurrent();
      throw new Error('NetEase request failed');
    }
    try {
      this.assertCurrent();
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`NetEase HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('NetEase response missing');
    const chunks: Uint8Array[] = [];
    let size = 0;
    let complete = false;
    try {
      while (true) {
        const result = await reader.read();
        this.assertCurrent();
        if (result.done) {
          complete = true;
          break;
        }
        size += result.value.byteLength;
        if (size > 512 * 1024) throw new Error('NetEase response too large');
        chunks.push(result.value);
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('Invalid NetEase JSON response');
    }
    if (!z.object({ code: z.literal(200) }).safeParse(json).success)
      throw new Error('NetEase response rejected');
    this.assertCurrent();
    const cookieHeader = response.headers.get('set-cookie');
    if (cookieHeader && cookieHeader.length <= 8192)
      for (const raw of cookieHeader.split(/,(?=\s*[^=;\s]+=)/)) {
        const pair = raw.split(';')[0];
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (
          separator > 0 &&
          /^[\w-]{1,100}$/.test(name) &&
          !/[\r\n]/.test(value)
        ) {
          if (!value) this.cookies.delete(name);
          else if (this.cookies.size < 32 || this.cookies.has(name))
            this.cookies.set(name, value);
        }
      }
    return json;
  }

  private register() {
    this.assertCurrent();
    this.registration ??= (async () => {
      // Anonymous, ephemeral protocol identity; never read hardware/account IDs.
      const id = randomBytes(24).toString('hex');
      const xored = Buffer.from(id, 'latin1');
      for (let i = 0; i < xored.length; i++)
        xored[i] ^= encodeKey.charCodeAt(i % encodeKey.length);
      const hash = md5(xored).toString('base64');
      const username = Buffer.from(`${id} ${hash}`, 'latin1').toString(
        'base64',
      );
      await this.request('/register/anonimous', { username });
    })().catch((error: unknown) => {
      this.registration = undefined;
      throw error;
    });
    return this.registration;
  }

  async search(value: unknown): Promise<LyricResult | null> {
    this.assertCurrent();
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid NetEase song metadata');
    const info = parsed.data;
    await this.register();
    this.assertCurrent();
    const rawParts = splitTitle(info.title);
    const artists = info.artist
      .toLowerCase()
      .split(/[&,]/)
      .map((artist) => artist.trim())
      .filter(Boolean);
    const songParts = rawParts.filter(
      (part) => !artists.includes(part.toLowerCase()),
    );
    const parts = songParts.length ? songParts : rawParts;
    if (!parts.length) return null;
    const keywords = [
      ...new Set([
        ...parts,
        ...(parts[0] !== info.artist ? [`${parts[0]} ${info.artist}`] : []),
      ]),
    ];
    const responses = await Promise.all(
      keywords.map(async (keyword) => {
        const response = await this.request('/search/song/list/page', {
          offset: '0',
          scene: 'NORMAL',
          needCorrect: 'true',
          checkToken,
          keyword,
          limit: '10',
          verifyId: 1,
        });
        const parsed = searchSchema.safeParse(response);
        if (!parsed.success) throw new Error('Invalid NetEase search response');
        return parsed.data.data.resources;
      }),
    );
    this.assertCurrent();
    const candidates = new Map<number, z.infer<typeof songSchema>>();
    for (const candidate of responses.flat())
      candidates.set(candidate.resourceId, candidate);
    const matches = [...candidates.values()]
      .map((candidate) => {
        const song = candidate.baseInfo.simpleSongData;
        const titleScore = Math.max(
          ...[info.title, ...parts].map((title) =>
            jaroWinkler(title.toLowerCase(), song.name.toLowerCase()),
          ),
        );
        const artistScore = Math.max(
          0,
          ...artists.flatMap((artist) =>
            (song.ar ?? []).map((a) =>
              jaroWinkler(artist, a.name.toLowerCase()),
            ),
          ),
        );
        const seconds = song.dt / 1000;
        const duration = Math.abs(seconds - info.songDuration);
        return { candidate, titleScore, artistScore, duration };
      })
      .filter(
        (row) =>
          row.titleScore >= 0.9 && row.artistScore >= 0.9 && row.duration <= 15,
      );
    matches.sort(
      (a, b) =>
        b.titleScore - a.titleScore ||
        b.artistScore - a.artistScore ||
        a.duration - b.duration ||
        a.candidate.resourceId - b.candidate.resourceId,
    );
    const chosen = matches[0]?.candidate;
    if (!chosen) return null;
    const response = lyricSchema.safeParse(
      await this.request('/song/lyric/v1', {
        id: chosen.resourceId,
        tv: '-1',
        yv: '-1',
        rv: '-1',
        lv: '-1',
        verifyId: 1,
      }),
    );
    if (!response.success) throw new Error('Invalid NetEase lyric response');
    const raw = response.data.lrc?.lyric;
    if (!raw) return null;
    const lyrics = raw
      .split(/\r?\n/)
      .filter((line) => {
        if (!line.trimStart().startsWith('{')) return true;
        try {
          JSON.parse(line);
          return false;
        } catch {
          return true;
        }
      })
      .join('\n');
    const lines = LRC.parse(lyrics).lines.map((line) => ({
      ...line,
      status: 'upcoming' as const,
    }));
    this.assertCurrent();
    if (!lines.length && !lyrics.trim()) return null;
    return {
      title: chosen.baseInfo.simpleSongData.name,
      artists: chosen.baseInfo.simpleSongData.ar?.map((a) => a.name) ?? [],
      lines: lines.length ? lines : undefined,
      lyrics,
    };
  }
}

type Context = Pick<BackendContext<{ enabled: boolean }>, 'window' | 'ipc'>;
let active: { window: Context['window']; dispose: () => void } | undefined;
export function startNetEaseProvider(context: Context) {
  active?.dispose();
  const window = context.window;
  const session = window.webContents.session;
  const controller = new AbortController();
  let disposed = false;
  const assertCurrent = () => {
    if (
      disposed ||
      active !== owner ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.session !== session
    )
      throw new Error('NetEase provider is no longer active');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    window.removeListener('closed', dispose);
    if (active === owner) {
      context.ipc.removeHandler('synced-lyrics:netease');
      active = undefined;
    }
  };
  const owner = { window, dispose };
  active = owner;
  window.once('closed', dispose);
  const api = new NetEaseAPI(
    session.fetch.bind(session),
    assertCurrent,
    controller.signal,
  );
  try {
    context.ipc.handle('synced-lyrics:netease', (value: unknown) =>
      api.search(value),
    );
  } catch (error) {
    dispose();
    throw error;
  }
}
export function stopNetEaseProvider(context: Context) {
  // The loader constructs a fresh context for stop; BrowserWindow is stable.
  if (active?.window === context.window) active.dispose();
}
