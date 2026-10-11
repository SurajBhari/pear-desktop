import { requestWs, WsError, type WsAccount } from './ws-client';

export interface WsAuthAccount extends WsAccount {
  authRoot: string;
}
export interface AuthSurface {
  ready: Promise<void>;
  closed: Promise<void>;
  close(): void;
}
export type OpenAuthSurface = (url: string, signal: AbortSignal) => AuthSurface;
interface LoginJob {
  fingerprint: string;
  promise: Promise<boolean>;
  scope: AbortController;
  surface?: AuthSurface;
  closed: boolean;
}
const authUrl = (account: WsAuthAccount) => {
  if (typeof account.authRoot !== 'string' || account.authRoot.length > 4096)
    throw new Error('Unsupported authentication endpoint');
  const url = new URL(account.authRoot);
  if (
    url.protocol !== 'https:' ||
    !['www.last.fm', 'last.fm', 'libre.fm'].includes(url.hostname) ||
    url.pathname !== '/api/auth/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  )
    throw new Error('Unsupported authentication endpoint');
  return url;
};
const cancelable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Authentication retired'));
    if (signal.aborted) {
      promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
const pause = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Authentication retired'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Authentication retired'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
export class WsAuthController {
  private readonly fetcher: typeof fetch;
  private readonly openSurface: OpenAuthSurface;
  private readonly pollMs: number;
  private readonly deadlineMs: number;
  private retired = false;
  private job?: LoginJob;
  constructor(
    fetcher: typeof fetch,
    openSurface: OpenAuthSurface,
    timing: { pollMs?: number; deadlineMs?: number } = {},
  ) {
    this.fetcher = fetcher;
    this.openSurface = openSurface;
    this.pollMs = Number.isFinite(timing.pollMs)
      ? Math.max(1, Math.min(1000, timing.pollMs!))
      : 1000;
    this.deadlineMs = Number.isFinite(timing.deadlineMs)
      ? Math.max(1, Math.min(300_000, timing.deadlineMs!))
      : 300_000;
  }
  login(
    account: WsAuthAccount,
    persist: (key: string) => void | Promise<void>,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const safeCurrent = () => {
      try {
        return isCurrent() === true;
      } catch {
        return false;
      }
    };
    if (this.retired || !safeCurrent() || this.retired)
      return Promise.resolve(false);
    let admitted: WsAuthAccount;
    let fingerprint: string;
    try {
      admitted = {
        apiRoot: account.apiRoot,
        apiKey: account.apiKey,
        secret: account.secret,
        authRoot: account.authRoot,
      };
      if (Object.values(admitted).some((value) => typeof value !== 'string'))
        return Promise.resolve(false);
      if (admitted.authRoot.length > 4096 || admitted.apiRoot.length > 4096)
        return Promise.resolve(false);
      fingerprint = JSON.stringify([
        admitted.apiRoot,
        admitted.apiKey,
        admitted.secret,
        admitted.authRoot,
      ]);
    } catch {
      return Promise.resolve(false);
    }
    if (this.job)
      return this.job.fingerprint === fingerprint
        ? this.job.promise
        : Promise.resolve(false);
    const job: LoginJob = {
      fingerprint,
      scope: new AbortController(),
      closed: false,
      promise: Promise.resolve(false),
    };
    this.job = job;
    job.promise = Promise.resolve().then(() =>
      this.run(job, admitted, persist, safeCurrent),
    );
    return job.promise;
  }
  private close(job: LoginJob) {
    if (job.closed || !job.surface) return;
    job.closed = true;
    try {
      job.surface.close();
    } catch {
      /* A destroyed native window is already retired. */
    }
  }
  private async run(
    job: LoginJob,
    account: WsAuthAccount,
    persist: (key: string) => void | Promise<void>,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const owns = () =>
      !this.retired && this.job === job && !job.scope.signal.aborted;
    const current = () => {
      if (!owns()) return false;
      const authorized = isCurrent();
      // Public ownership callbacks may synchronously retire the job.
      return authorized && owns();
    };
    const deadline = setTimeout(() => job.scope.abort(), this.deadlineMs);
    try {
      if (!current()) return false;
      const url = authUrl(account);
      const token = (
        await requestWs(
          this.fetcher,
          account,
          { method: 'auth.getToken' },
          job.scope.signal,
        )
      ).token;
      if (!token || !current()) return false;
      url.searchParams.set('api_key', account.apiKey);
      url.searchParams.set('token', token);
      job.surface = this.openSurface(url.href, job.scope.signal);
      job.surface.closed.then(
        () => {
          job.closed = true;
          job.scope.abort();
        },
        () => {
          job.closed = true;
          job.scope.abort();
        },
      );
      await cancelable(job.surface.ready, job.scope.signal);
      while (current()) {
        try {
          const session = (
            await requestWs(
              this.fetcher,
              account,
              { method: 'auth.getSession', token },
              job.scope.signal,
            )
          ).session;
          if (!session || !current()) return false;
          // Cancellation retires the wait, not a write already admitted while
          // current. Late resolution/rejection cannot revive this job.
          await cancelable(
            Promise.resolve(persist(session.key)),
            job.scope.signal,
          );
          return current();
        } catch (error) {
          if (!(error instanceof WsError) || error.code !== 14 || !current())
            return false;
        }
        await pause(this.pollMs, job.scope.signal);
      }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(deadline);
      job.scope.abort();
      this.close(job);
      if (this.job === job) this.job = undefined;
    }
  }
  stop(): void {
    this.retired = true;
    if (this.job) {
      this.job.scope.abort();
      this.close(this.job);
    }
  }
}
