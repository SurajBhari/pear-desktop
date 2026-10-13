import { createHash } from 'node:crypto';

export interface WsAccount {
  apiRoot: string;
  apiKey: string;
  secret: string;
}
export type WsParameters = Record<string, string | number>;
export interface WsReply {
  token?: string;
  session?: { key: string };
}
export class WsError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
export const createApiSignature = (
  parameters: WsParameters,
  secret: string,
): string =>
  createHash('md5')
    .update(
      Object.keys(parameters)
        .filter((key) => !['format', 'callback', 'api_sig'].includes(key))
        .sort()
        .map((key) => key + String(parameters[key]))
        .join('') + secret,
      'utf8',
    )
    .digest('hex');

const failure = () => new WsError(0, 'Scrobbling service request failed');
const MAX_BYTES = 65_536;
export const apiEndpoint = (raw: string): string => {
  if (typeof raw !== 'string' || raw.length > 4096) throw failure();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw failure();
  }
  if (
    url.protocol === 'http:' &&
    ['ws.audioscrobbler.com', 'libre.fm'].includes(url.hostname) &&
    url.pathname === '/2.0/' &&
    !url.port
  )
    url.protocol = 'https:';
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw failure();
  return url.href;
};

const credential = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value))
    throw failure();
  return value;
};
const xmlText = (value: string) => {
  if (/[<>]/.test(value) || /&(?!(?:amp|lt|gt|quot|apos);)/.test(value))
    throw failure();
  return value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, entity: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!,
  );
};
const xmlReply = (text: string): WsReply => {
  const source = text.trim().replace(/^<\?xml\s+[^?]*\?>\s*/, '');
  // This adapter accepts the protocol's scalar auth envelopes, never a DTD,
  // entity declaration, arbitrary XML document or executable auth-page markup.
  if (/<[!?]/.test(source)) throw failure();
  const envelope =
    /^<lfm\s+status=(['"])(ok|failed)\1\s*>([\s\S]*)<\/lfm>$/.exec(source);
  if (!envelope) throw failure();
  const body = envelope[3].trim();
  if (envelope[2] === 'failed') {
    const error = /^<error\s+code=(['"])(\d{1,3})\1\s*>[^<>]*<\/error>$/.exec(
      body,
    );
    if (!error) throw failure();
    throw new WsError(
      Number(error[2]),
      'Scrobbling service rejected the request',
    );
  }
  const token = /^<token>([^<>]*)<\/token>$/.exec(body);
  if (token) return { token: credential(xmlText(token[1])) };
  const session = /^<session>([\s\S]*)<\/session>$/.exec(body);
  if (session) {
    const children = [
      ...session[1].matchAll(/<(name|key|subscriber)>([^<>]*)<\/\1>/g),
    ];
    const remainder = session[1]
      .replace(/<(name|key|subscriber)>([^<>]*)<\/\1>/g, '')
      .trim();
    const names = children.map((entry) => entry[1]);
    if (
      remainder ||
      new Set(names).size !== names.length ||
      !names.includes('key')
    )
      throw failure();
    for (const child of children) xmlText(child[2]);
    const key = children.find((entry) => entry[1] === 'key')![2];
    return { session: { key: credential(xmlText(key)) } };
  }
  // Posting responses are acknowledgements; session/token data is never
  // extracted from their nested track metadata.
  if (/^<(nowplaying|scrobbles)\b[^>]*>[\s\S]*<\/\1>$/.test(body)) return {};
  throw failure();
};
export const decodeWsResponse = (text: string): WsReply => {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw failure();
  if (text.trimStart().startsWith('<')) return xmlReply(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw failure();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw failure();
  const reply = parsed as Record<string, unknown>;
  if ('error' in reply) {
    if (!Number.isInteger(reply.error) || Number(reply.error) <= 0)
      throw failure();
    throw new WsError(
      Number(reply.error),
      'Scrobbling service rejected the request',
    );
  }
  if ('session' in reply) {
    if (
      !reply.session ||
      typeof reply.session !== 'object' ||
      Array.isArray(reply.session)
    )
      throw failure();
    return {
      session: {
        key: credential((reply.session as Record<string, unknown>).key),
      },
    };
  }
  if ('token' in reply) return { token: credential(reply.token) };
  return {};
};

const unlessAborted = <T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(failure());
    if (signal.aborted) {
      // Consume a supplied rejection even when cancellation won before entry.
      promise.catch(() => {});
      reject(failure());
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });

const readReply = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) {
    response.body?.cancel().catch(() => {});
    throw failure();
  }
  if (!response.body) throw failure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await unlessAborted(reader.read(), signal);
      if (signal.aborted) throw failure();
      if (chunk.done) {
        complete = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw failure();
      chunks.push(chunk.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    if (!complete) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
export const requestWs = async (
  fetcher: typeof fetch,
  account: WsAccount,
  parameters: WsParameters,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<WsReply> => {
  if (signal?.aborted) throw failure();
  for (const value of [account.apiKey, account.secret])
    if (typeof value !== 'string' || !value.trim() || value.length > 512)
      throw failure();
  if (typeof parameters.method !== 'string' || !parameters.method)
    throw failure();
  const scope = new AbortController();
  const retire = () => scope.abort();
  signal?.addEventListener('abort', retire, { once: true });
  const deadline = setTimeout(
    retire,
    Number.isFinite(timeoutMs)
      ? Math.min(15_000, Math.max(1, timeoutMs))
      : 15_000,
  );
  try {
    const endpoint = apiEndpoint(account.apiRoot);
    const data = { ...parameters, api_key: account.apiKey, format: 'json' };
    const body = new URLSearchParams(
      Object.entries(data).map(([key, value]) => [key, String(value)]),
    );
    body.set('api_sig', createApiSignature(data, account.secret));
    const get = /^auth\./i.test(parameters.method);
    const response = await unlessAborted(
      fetcher(get ? `${endpoint}?${body.toString()}` : endpoint, {
        method: get ? 'GET' : 'POST',
        ...(get ? {} : { body }),
        redirect: 'error',
        credentials: 'omit',
        signal: scope.signal,
      }).then((reply) => {
        if (scope.signal.aborted) {
          reply.body?.cancel().catch(() => {});
          throw failure();
        }
        return reply;
      }),
      scope.signal,
    );
    const reply = decodeWsResponse(await readReply(response, scope.signal));
    if (!response.ok || scope.signal.aborted) throw failure();
    return reply;
  } catch (error) {
    if (
      error instanceof WsError &&
      Number.isInteger(error.code) &&
      error.code >= 0 &&
      error.code <= 999
    )
      throw new WsError(
        error.code,
        error.code === 0
          ? 'Scrobbling service request failed'
          : 'Scrobbling service rejected the request',
      );
    throw failure();
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', retire);
  }
};
