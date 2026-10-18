import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  createMusicGrant,
  grantMatches,
  parseMusicGrantRecord,
  GRANT_MAX_BYTES,
  GRANT_MAX_RECORDS,
  type MusicGrantRecord,
  type MusicTransport,
} from './music-grants';
import {
  createWindowsPrivatePath,
  type WindowsPrivatePath,
} from './windows-private-path';

import { failMusic, type MusicScope } from '../music-types';

interface MusicGrantEpoch {
  record: MusicGrantRecord;
  controller: AbortController;
}
const leaseLifetimes = new WeakMap<
  MusicGrantRecord,
  { store: MusicGrantStore; signal: AbortSignal }
>();
/** Main-only negative fence; exact object provenance, with no authority callouts. */
export function musicGrantLifetimeSignal(
  store: MusicGrantStore,
  lease: MusicGrantRecord,
): AbortSignal | undefined {
  const lifetime = leaseLifetimes.get(lease);
  return lifetime?.store === store ? lifetime.signal : undefined;
}

/** Native main-process ledger. No record can be imported from renderer-writable plugin settings. */
export class MusicGrantStore {
  private records: MusicGrantRecord[] | undefined;
  private epochs = new Map<string, MusicGrantEpoch>();
  private windowsBinding: string | null | undefined;
  private readonly observers = new Set<() => void>();
  subscribe(observer: () => void) {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  private tail: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(
    private readonly directory: string,
    private readonly now = Date.now,
    private readonly windows:
      | WindowsPrivatePath
      | undefined = process.platform === 'win32'
      ? createWindowsPrivatePath()
      : undefined,
  ) {
    this.file = path.join(directory, 'grants.json');
  }
  private transact<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  private privateStat(s: Stats, directory: boolean) {
    return (
      (directory ? s.isDirectory() : s.isFile()) &&
      !s.isSymbolicLink() &&
      (s.mode & 0o777) === (directory ? 0o700 : 0o600) &&
      s.uid === process.getuid?.() &&
      (directory || (s.nlink === 1 && s.size <= GRANT_MAX_BYTES))
    );
  }
  private nextEpochs(records: MusicGrantRecord[]) {
    return new Map(
      records.map((record) => {
        const previous = this.epochs.get(record.id);
        const old = previous?.record;
        const unchanged =
          old &&
          old.digest === record.digest &&
          old.transport === record.transport &&
          old.resource === record.resource &&
          old.createdAt === record.createdAt &&
          old.expiresAt === record.expiresAt &&
          old.scopes.length === record.scopes.length &&
          old.scopes.every((scope) => record.scopes.includes(scope));
        return [
          record.id,
          unchanged && previous && !previous.controller.signal.aborted
            ? previous
            : { record, controller: new AbortController() },
        ] as const;
      }),
    );
  }
  private publish(
    records: MusicGrantRecord[],
    epochs = this.nextEpochs(records),
  ) {
    const previous = this.epochs;
    this.records = records;
    this.epochs = epochs;
    for (const [id, epoch] of previous)
      if (epochs.get(id) !== epoch) epoch.controller.abort();
  }
  private async load() {
    if (this.records) return;
    if (this.windows) {
      try {
        const snapshot = await this.windows.read(this.directory);
        const records =
          snapshot.contents === null ? [] : this.parse(snapshot.contents);
        this.windowsBinding = snapshot.binding;
        this.publish(records);
        return;
      } catch {
        return failMusic('unavailable');
      }
    }
    try {
      let dir: Stats;
      try {
        dir = await lstat(this.directory);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.publish([]);
          return;
        }
        throw e;
      }
      if (!this.privateStat(dir, true)) return failMusic('unavailable');
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          this.file,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.publish([]);
          return;
        }
        throw e;
      }
      try {
        if (!this.privateStat(await handle.stat(), false))
          return failMusic('unavailable');
        const contents = await handle.readFile({ encoding: 'utf8' });
        if (Buffer.byteLength(contents) > GRANT_MAX_BYTES)
          return failMusic('unavailable');
        this.publish(this.parse(contents));
      } finally {
        await handle.close();
      }
    } catch {
      return failMusic('unavailable');
    }
  }
  private parse(contents: string): MusicGrantRecord[] {
    if (Buffer.byteLength(contents) > GRANT_MAX_BYTES)
      return failMusic('unavailable');
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return failMusic('unavailable');
    const raw = value as Record<string, unknown>;
    if (
      Object.keys(raw).length !== 2 ||
      raw.version !== 1 ||
      !Array.isArray(raw.records) ||
      raw.records.length > GRANT_MAX_RECORDS
    )
      return failMusic('unavailable');
    const records = raw.records.map(parseMusicGrantRecord);
    if (
      records.some((record) => !record) ||
      new Set(records.map((record) => record?.id)).size !== records.length
    )
      return failMusic('unavailable');
    return records as MusicGrantRecord[];
  }
  private async save(records: MusicGrantRecord[], current: () => boolean) {
    if (!current()) return failMusic('retired');
    const content = JSON.stringify({ version: 1, records });
    if (
      records.length > GRANT_MAX_RECORDS ||
      Buffer.byteLength(content) > GRANT_MAX_BYTES
    )
      return failMusic('budget');
    const epochs = this.nextEpochs(records);
    if (this.windows) {
      if (this.windowsBinding === undefined) return failMusic('unavailable');
      let prepared:
        | Awaited<ReturnType<WindowsPrivatePath['stage']>>
        | undefined;
      try {
        prepared = await this.windows.stage(
          this.directory,
          content,
          this.windowsBinding,
        );
        if (!current()) return failMusic('retired');
        this.windowsBinding = await prepared.commit();
        this.publish(records, epochs);
        for (const observer of this.observers) observer();
      } catch (error) {
        if (
          error instanceof Error &&
          ['retired', 'budget', 'unavailable'].includes(
            (error as Error & { code?: string }).code ?? '',
          )
        )
          throw error;
        return failMusic('unavailable');
      } finally {
        await prepared?.close();
      }
      return;
    }
    const temporary = path.join(this.directory, `.grants-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { mode: 0o700, recursive: true });
      if (!this.privateStat(await lstat(this.directory), true))
        return failMusic('unavailable');
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!current()) return failMusic('retired');
      await rename(temporary, this.file);
      this.publish(records, epochs);
      for (const observer of this.observers) observer();
    } catch (error) {
      if (
        error instanceof Error &&
        ['retired', 'budget', 'unavailable'].includes(
          (error as Error & { code?: string }).code ?? '',
        )
      )
        throw error;
      return failMusic('unavailable');
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  list(): Promise<MusicGrantRecord[]> {
    return this.transact(async () => {
      await this.load();
      return structuredClone(
        this.records!.filter((r) => r.expiresAt > this.now()),
      );
    });
  }
  issue(
    name: string,
    transport: MusicTransport,
    resource: string,
    scopes: MusicScope[],
    current: () => boolean,
  ) {
    return this.transact(async () => {
      if (!current()) return failMusic('retired');
      await this.load();
      if (!current()) return failMusic('retired');
      const grant = createMusicGrant(
        name,
        transport,
        resource,
        scopes,
        this.now(),
      );
      const records = this.records!.filter((r) => r.expiresAt > this.now());
      if (records.length >= GRANT_MAX_RECORDS) return failMusic('budget');
      await this.save([...records, structuredClone(grant.record)], current);
      if (!current()) {
        await this.save(records, () => true);
        return failMusic('retired');
      }
      return grant;
    });
  }
  revoke(id: string, current: () => boolean): Promise<void> {
    return this.transact(async () => {
      if (!current()) return failMusic('retired');
      await this.load();
      await this.save(
        this.records!.filter((r) => r.id !== id),
        current,
      );
    });
  }
  authorize(
    token: unknown,
    transport: MusicTransport,
    resource: string,
    scope: MusicScope,
  ): Promise<MusicGrantRecord> {
    return this.transact(async () => {
      await this.load();
      const record = this.records!.find((r) =>
        grantMatches(r, token, transport, resource, this.now()),
      );
      if (!record) return failMusic('unauthorized');
      if (!record.scopes.includes(scope)) return failMusic('forbidden');
      const lease = structuredClone(record);
      Object.freeze(lease.scopes);
      leaseLifetimes.set(lease, {
        store: this,
        signal: this.epochs.get(record.id)!.controller.signal,
      });
      return Object.freeze(lease);
    });
  }
  isCurrent(record: MusicGrantRecord, scope: MusicScope): boolean {
    return !!this.records?.some(
      (r) =>
        r.id === record.id &&
        r.digest === record.digest &&
        r.transport === record.transport &&
        r.resource === record.resource &&
        r.scopes.includes(scope) &&
        this.now() >= r.createdAt &&
        this.now() < r.expiresAt,
    );
  }
}
