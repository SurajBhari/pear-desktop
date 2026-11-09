import { Worker } from 'node:worker_threads';

import { hasControls } from './base';

// Regex/MusicBrainz metadata work originated with @ImMALWARE in pear-devs/pear-desktop#4632.
// User patterns are data. Compilation and execution happen only in a terminable worker.
const program = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ patterns, input }) => {
  const compiled = [];
  for (let i = 0; i < patterns.length; i++) {
    try { compiled.push(new RegExp(patterns[i], 'gi')); }
    catch { parentPort.postMessage({ invalid: i }); return; }
  }
  if (!input) { parentPort.postMessage({ valid: true }); return; }
  let { title, artist } = input;
  for (const expression of compiled) {
    title = title.replace(expression, '').trim();
    artist = artist.replace(expression, '').trim();
  }
  parentPort.postMessage({ title, artist });
});
parentPort.postMessage({ ready: true });
`;
type Fields = { title: string; artist: string };
export type RegexValidation =
  | { ok: true; patterns: string[] }
  | { ok: false; line?: number };
type Reply = {
  invalid?: number;
  valid?: boolean;
  title?: string;
  artist?: string;
};
type Job = {
  patterns: string[];
  input?: Fields;
  signal?: AbortSignal;
  settle: (reply?: Reply) => void;
  cancel: () => void;
};
const boundedPatterns = (patterns: unknown): patterns is string[] =>
  Array.isArray(patterns) &&
  patterns.length <= 32 &&
  patterns.every((value) => typeof value === 'string' && value.length <= 256) &&
  (patterns as string[]).reduce((total, value) => total + value.length, 0) <=
    8192;
const fieldsValid = (value: Fields) =>
  typeof value.title === 'string' &&
  typeof value.artist === 'string' &&
  !!value.title.trim() &&
  !!value.artist.trim() &&
  value.title.length <= 4096 &&
  value.artist.length <= 4096 &&
  !hasControls(value.title + value.artist);

export class RegexFilters {
  private active?: Job;
  private pending?: Job;
  private stopped = false;
  constructor(
    private readonly dependencies: {
      createWorker?: (source: string) => Worker;
    } = {},
  ) {}
  async validate(
    text: unknown,
    signal?: AbortSignal,
  ): Promise<RegexValidation> {
    if (typeof text !== 'string' || text.length > 16384) return { ok: false };
    const lines = text
      .split('\n')
      .map((value, index) => ({ value: value.trim(), line: index + 1 }))
      .filter(({ value }) => value);
    const oversize = lines.findIndex(
      ({ value }, index) => value.length > 256 || index >= 32,
    );
    if (oversize !== -1) return { ok: false, line: lines[oversize].line };
    const patterns = lines.map(({ value }) => value);
    if (!boundedPatterns(patterns)) return { ok: false };
    const reply = await this.run(patterns, undefined, signal);
    if (typeof reply?.invalid === 'number')
      return { ok: false, line: lines[reply.invalid]?.line };
    return reply?.valid ? { ok: true, patterns } : { ok: false };
  }
  async apply<T extends Fields>(
    patterns: unknown,
    input: T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!boundedPatterns(patterns) || !patterns.length || !fieldsValid(input))
      return input;
    const reply = await this.run(
      patterns,
      { title: input.title, artist: input.artist },
      signal,
    );
    if (
      !reply ||
      typeof reply.title !== 'string' ||
      typeof reply.artist !== 'string' ||
      !fieldsValid({ title: reply.title, artist: reply.artist })
    )
      return input;
    return { ...input, title: reply.title, artist: reply.artist };
  }
  stop() {
    this.stopped = true;
    this.pending?.cancel();
    this.active?.cancel();
  }
  private run(
    patterns: string[],
    input?: Fields,
    signal?: AbortSignal,
  ): Promise<Reply | undefined> {
    if (this.stopped || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const job: Job = {
        patterns,
        input,
        signal,
        settle: resolve,
        cancel: () => {},
      };
      const cancel = () => {
        if (this.pending === job) this.pending = undefined;
        signal?.removeEventListener('abort', cancel);
        resolve(undefined);
      };
      job.cancel = cancel;
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending?.cancel();
      this.pending = job;
      this.pump();
    });
  }
  private pump() {
    if (this.active || !this.pending || this.stopped) return;
    const job = this.pending;
    this.pending = undefined;
    this.active = job;
    job.signal?.removeEventListener('abort', job.cancel);
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let done = false;
    const finish = (reply?: Reply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', cancel);
      worker?.removeListener('error', cancel);
      worker?.removeListener('exit', cancel);
      worker?.removeListener('message', message);
      // Await actual termination before admitting another worker.
      Promise.resolve(worker?.terminate())
        .catch(() => {})
        .then(() => {
          if (this.active === job) this.active = undefined;
          job.settle(job.signal?.aborted || this.stopped ? undefined : reply);
          this.pump();
        });
    };
    const cancel = () => finish();
    let ready = false;
    const message = (reply: unknown) => {
      if (!reply || typeof reply !== 'object') return finish();
      if (!ready && 'ready' in reply && reply.ready === true) {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(cancel, 100);
        worker!.postMessage({ patterns: job.patterns, input: job.input });
      } else if (ready) finish(reply as Reply);
      else finish();
    };
    job.cancel = cancel;
    job.signal?.addEventListener('abort', cancel, { once: true });
    try {
      worker =
        this.dependencies.createWorker?.(program) ??
        new Worker(program, {
          eval: true,
          resourceLimits: { maxOldGenerationSizeMb: 16, stackSizeMb: 2 },
        });
      timer = setTimeout(cancel, 1500);
      worker.on('error', cancel);
      worker.on('exit', cancel);
      worker.on('message', message);
      if (job.signal?.aborted) finish();
    } catch {
      finish();
    }
  }
}
