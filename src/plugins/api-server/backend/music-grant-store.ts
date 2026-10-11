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

import { failMusic, type MusicScope } from '../music-types';

/** Native main-process ledger. No record can be imported from renderer-writable plugin settings. */
export class MusicGrantStore {
  private records: MusicGrantRecord[] | undefined;
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
      (process.platform === 'win32' ||
        ((s.mode & 0o777) === (directory ? 0o700 : 0o600) &&
          s.uid === process.getuid?.())) &&
      (directory || (s.nlink === 1 && s.size <= GRANT_MAX_BYTES))
    );
  }
  private async load() {
    if (this.records) return;
    try {
      let dir: Stats;
      try {
        dir = await lstat(this.directory);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.records = [];
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
          this.records = [];
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
          records.some((r) => !r) ||
          new Set(records.map((r) => r?.id)).size !== records.length
        )
          return failMusic('unavailable');
        this.records = records as MusicGrantRecord[];
      } finally {
        await handle.close();
      }
    } catch {
      return failMusic('unavailable');
    }
  }
  private async save(records: MusicGrantRecord[], current: () => boolean) {
    if (!current()) return failMusic('retired');
    const content = JSON.stringify({ version: 1, records });
    if (
      records.length > GRANT_MAX_RECORDS ||
      Buffer.byteLength(content) > GRANT_MAX_BYTES
    )
      return failMusic('budget');
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
      this.records = records;
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
