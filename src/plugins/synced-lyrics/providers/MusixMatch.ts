import * as z from 'zod';

import { matchesMusixMatchTrack } from './musixmatch-matching';

import { LRC } from '../parsers/lrc';
import { netFetch } from '../renderer';

import type { LyricProvider, LyricResult, SearchSongInfo } from '../types';

export class MusixMatch implements LyricProvider {
  name = 'MusixMatch';
  baseUrl = 'https://www.musixmatch.com/';

  private apiPromise: Promise<MusixMatchAPI> | undefined;

  private getApi() {
    this.apiPromise ??= MusixMatchAPI.new().catch((error: unknown) => {
      this.apiPromise = undefined;
      throw error;
    });
    return this.apiPromise;
  }

  async search(info: SearchSongInfo): Promise<LyricResult | null> {
    // late-init the API, to avoid an electron IPC issue
    // an added benefit is that if it has an error during init, the user can hit the retry button
    const api = await this.getApi();
    await api.reinit();

    const data = await api.query(Endpoint.getMacroSubtitles, {
      q_track: info.alternativeTitle || info.title,
      q_artist: info.artist,
      q_duration: info.songDuration.toString(),
      ...(info.album ? { q_album: info.album } : {}),
      namespace: 'lyrics_richsynched',
      subtitle_format: 'lrc',
    });

    const { macro_calls: macroCalls } = data.body;

    // prettier-ignore
    const getter = <T extends keyof typeof macroCalls>(key: T): typeof macroCalls[T]['message']['body'] => macroCalls[key].message.body;

    const track = getter('matcher.track.get')?.track;
    const lyrics = getter('track.lyrics.get')?.lyrics?.lyrics_body;
    const subtitle = getter('track.subtitles.get')?.subtitle_list?.[0];

    if (!track || !matchesMusixMatchTrack(info, track)) return null;

    return {
      title: track.track_name,
      artists: [track.artist_name],
      lines: subtitle
        ? LRC.parse(subtitle.subtitle.subtitle_body).lines.map((line) => {
            const prefix = line.text.match(/^[ \t]+/)?.[0].length ?? 0;
            if (!prefix) return { ...line, status: 'upcoming' as const };

            let remaining = prefix;
            // Invalid joins stay plain-text fallbacks, never guessed word alignment.
            const words =
              line.words.map((word) => word.word).join('') === line.text
                ? line.words.map((word) => {
                    const removed = Math.min(remaining, word.word.length);
                    remaining -= removed;
                    return { ...word, word: word.word.slice(removed) };
                  })
                : [];
            return {
              ...line,
              text: line.text.slice(prefix),
              words,
              status: 'upcoming' as const,
            };
          })
        : undefined,
      lyrics: lyrics,
    };
  }
}

// API Implementation, based on https://github.com/Strvm/musicxmatch-api/blob/main/src/musicxmatch_api/main.py

const zBoolean = z.union([z.literal(0), z.literal(1)]);
const Track = z.object({
  track_id: z.number(),
  track_name: z.string(),
  artist_name: z.string(),
  track_length: z.number().nonnegative().optional(),
});

const Lyrics = z.object({
  instrumental: zBoolean.optional(),
  lyrics_body: z.string(),
  lyrics_language: z.string().optional(),
  lyrics_language_description: z.string().optional(),
});

const Subtitle = z.object({
  subtitle_body: z.string(),
  subtitle_length: z.number().optional(),
  subtitle_language: z.string().optional(),
});

enum Endpoint {
  getMacroSubtitles = 'macro.subtitles.get',
  searchTrack = 'track.search',
}

type Query = {
  q?: string;
  q_track?: string;
  q_artist?: string;
  q_album?: string;
  q_duration?: string;
};

type Params = {
  [Endpoint.getMacroSubtitles]: Query & {
    namespace: 'lyrics_richsynched';
    subtitle_format: 'lrc';
  };
  [Endpoint.searchTrack]: {
    q: string;
    f_has_lyrics: 'true' | 'false';
    page_size: string;
    page: string;
  };
};

const ResponseSchema = {
  [Endpoint.searchTrack]: z.object({
    track_list: z.array(z.object({ track: Track })),
  }),
  [Endpoint.getMacroSubtitles]: z.object({
    macro_calls: z.object({
      'track.lyrics.get': z.object({
        message: z.object({
          body: z
            .object({ lyrics: Lyrics })
            .or(
              z
                .instanceof(Array)
                .describe('default response for 404 status')
                .transform(() => undefined)
                .or(z.string().transform(() => undefined)),
            )
            .optional(),
        }),
      }),
      'track.subtitles.get': z.object({
        message: z.object({
          body: z
            .object({
              subtitle_list: z.array(z.object({ subtitle: Subtitle })),
            })
            .or(
              z
                .instanceof(Array)
                .describe('default response for 404 status')
                .transform(() => undefined)
                .or(z.string().transform(() => undefined)),
            )

            .optional(),
        }),
      }),
      'matcher.track.get': z.object({
        message: z.object({
          body: z
            .object({ track: Track })
            .or(
              z
                .instanceof(Array)
                .describe('default response for 404 status')
                .transform(() => undefined)
                .or(z.string().transform(() => undefined)),
            )
            .optional(),
        }),
      }),
    }),
  }),
} as const;

class MusixMatchAPI {
  private initPromise: Promise<void>;
  private refreshPromise: Promise<void> | undefined;
  private token: string | null = null;

  private constructor() {
    this.initPromise = this.init();
  }

  public static async new() {
    const api = new MusixMatchAPI();
    await api.initPromise;
    return api;
  }

  public async reinit() {
    const previous = this.initPromise;
    try {
      await previous;
    } catch {
      if (this.initPromise === previous) this.initPromise = this.init();
      await this.initPromise;
    }
  }

  private async refresh(rejectedToken: string) {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.token && this.token !== rejectedToken) return;
    const pending = this.init(true);
    this.initPromise = pending;
    this.refreshPromise = pending;
    try {
      await pending;
    } finally {
      if (this.refreshPromise === pending) this.refreshPromise = undefined;
    }
  }

  private async request(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<{ status: number; response: unknown }> {
    const query = new URLSearchParams({
      app_id: this.app_id,
      format: 'json',
      ...params,
    });
    let status: number;
    let text: string;
    try {
      [status, text] = await netFetch(`${this.baseUrl}${endpoint}?${query}`, {
        headers: this.headers,
      });
    } catch {
      // Transport errors may include the token-bearing URL. Keep UI errors safe.
      throw new Error('MusixMatch request failed');
    }
    if (status === 401) return { status, response: undefined };
    if (status < 200 || status >= 300)
      throw new Error(`MusixMatch HTTP ${status}`);
    try {
      return { status, response: JSON.parse(text) };
    } catch {
      throw new Error('Invalid MusixMatch JSON response');
    }
  }

  // god I love typescript generics, they're so useful
  public async query<
    T extends Endpoint,
    R = {
      header: { status_code: number };
      body: T extends keyof typeof ResponseSchema
        ? z.infer<(typeof ResponseSchema)[T]>
        : unknown;
    },
  >(endpoint: T, params: Params[T], refreshed = false): Promise<R> {
    await this.initPromise;
    if (this.refreshPromise) await this.refreshPromise;
    if (!this.token) throw new Error('Token not initialized');
    const usedToken = this.token;
    const { status, response } = await this.request(endpoint, {
      usertoken: usedToken,
      ...params,
    });
    // prettier-ignore
    if (
      status === 401 || (response && typeof response === 'object' &&
      'message' in response && response.message && typeof response.message === 'object' &&
      'header' in response.message && response.message.header && typeof response.message.header === 'object' &&
      'status_code' in response.message.header && typeof response.message.header.status_code === 'number' &&
      response.message.header.status_code === 401)
    ) {
      if (refreshed)
        throw new Error('MusixMatch authentication rejected after refresh');
      await this.refresh(usedToken);
      return this.query(endpoint, params, true);
    }

    const parsed = z
      .object({
        message: z.object({ body: ResponseSchema[endpoint] }),
      })
      .safeParse(response);

    if (!parsed.success) {
      throw new Error('Invalid MusixMatch response schema');
    }

    return parsed.data.message as R;
  }

  private savedTokenSchema = z.object({
    token: z.string().min(1),
    expires: z.number(),
    client: z.literal('mac-ios-v2.0'),
  });

  private key = 'ytm:synced-lyrics:mxm:token';
  private async init(force = false) {
    this.token = null;
    if (!force) {
      let saved: unknown;
      try {
        saved = JSON.parse(localStorage.getItem(this.key) ?? 'null');
      } catch {
        saved = null;
      }
      const parsed = this.savedTokenSchema.safeParse(saved);
      if (parsed.success && parsed.data.expires > Date.now()) {
        this.token = parsed.data.token;
        return;
      }
    }

    localStorage.removeItem(this.key);

    this.token = await this.getToken();
    if (!this.token) throw new Error('Failed to get token');

    localStorage.setItem(
      this.key,
      JSON.stringify({
        token: this.token,
        expires: Date.now() + 60_000,
        client: this.app_id,
      }),
    );
  }

  private tokenSchema = z.object({
    message: z.object({
      header: z.object({ status_code: z.literal(200) }),
      body: z.object({ user_token: z.string().min(1) }),
    }),
  });
  private async getToken() {
    const endpoint = 'token.get';
    const { response } = await this.request(endpoint, {});
    const parsed = this.tokenSchema.safeParse(response);
    if (!parsed.success)
      throw new Error('MusixMatch authentication token unavailable');
    return parsed.data.message.body.user_token;
  }

  private readonly baseUrl = 'https://apic-appmobile.musixmatch.com/ws/1.1/';
  private readonly app_id = 'mac-ios-v2.0';
  private readonly headers = {
    'authority': 'apic-appmobile.musixmatch.com',
    'X-Cookie': 'x-mxm-token-guid=',
    'x-mxm-app-version': '10.1.1',
    'X-User-Agent': 'Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'application/json',
  };
}
