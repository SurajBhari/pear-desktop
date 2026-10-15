import { randomBytes } from 'node:crypto';

import { sliceMusicSource } from '@/providers/music-catalog';
import {
  createMusicRequestBroker,
  type MusicRequestBroker,
  type MusicAdmission,
} from '@/providers/music-request';

import {
  musicOperationLedger,
  type MusicOperationLedger,
  type MusicOperationRow,
} from './music-operations';
import {
  parseMusicInput,
  parseMusicLyricsInput,
  parseMusicRelatedInput,
  parseNativeLyricsMetadata,
  parseNativeRelatedMetadata,
  parseNativeMetadataProbe,
  parseMusicQueueInput,
  parseMusicCollectionInput,
  parseNativeQueue,
  parseNativeCatalog,
  parseNativeSnapshot,
  parseMusicOperationPrepareInput,
  parseMusicControlMutationInput,
  parseMusicMutationInput,
  parseMusicOperationId,
  type MusicTarget,
  type MusicClientInput,
} from './scheme/music';

import {
  MUSIC_LIMITS,
  MusicServiceError,
  failMusic,
  utf8Bytes,
  type MusicScope,
  type MusicReadInput,
  type MusicItem,
  type MusicShelf,
  type NormalizedMusicSource,
  type NativeQueueSnapshot,
  type QueuePage,
  type MetadataBinding,
  type MetadataTarget,
  type LyricsResult,
  type MusicOperationReceipt,
} from '../music-types';

import type { APIServerConfig } from '../config';
import type { MusicGrantStore } from './music-grant-store';
import type { MusicGrantRecord } from './music-grants';
import type { BrowserWindow } from 'electron';

type SourceOwner = { epoch: string; current(): boolean };
type PageContext =
  | {
      route: 'search';
      query: string;
      kind?: 'song' | 'video' | 'album' | 'artist' | 'playlist';
    }
  | { route: 'browse'; target: MusicTarget; binding?: MetadataBinding }
  | { route: 'related'; videoId: string; binding: MetadataBinding }
  | { route: 'home' | 'library' };
export interface MusicPage {
  version: 1;
  availability: 'supported';
  items: (MusicItem & { reference?: string })[];
  shelves: MusicShelf[];
  nextCursor: string | null;
  query?: string;
  kind?: string;
  target?: MusicTarget;
  videoId?: string;
}
interface CursorBase {
  id: string;
  principal: MusicGrantRecord;
  scope: MusicScope;
  resource: string;
  issuerScope?: MusicScope;
  revision: number;
  owner: SourceOwner;
  offset: number;
  limit: number;
  expires: number;
  busy: boolean;
  bytes: number;
}
type Cursor = CursorBase &
  (
    | {
        kind: 'catalog';
        context: PageContext;
        source: NormalizedMusicSource;
        seenPlaylistIds?: string[];
        replay?: MusicPage;
      }
    | {
        kind: 'queue';
        source: NativeQueueSnapshot;
        replay?: QueuePage;
      }
  );
interface TargetReference {
  binding?: MetadataBinding;
  busy?: boolean;
  id: string;
  principal: MusicGrantRecord;
  scope: MusicScope;
  resource: string;
  issuerScope?: MusicScope;
  revision: number;
  owner: SourceOwner;
  browseId: string;
  params?: string;
  expires: number;
  bytes: number;
}
interface Lease {
  principal: MusicGrantRecord;
  scope: MusicScope;
  resource: string;
  issuerScope?: MusicScope;
  revision: number;
  admission: MusicAdmission;
  signal: AbortSignal;
  deadline: number;
  current(): boolean;
}
export interface MusicRuntime {
  window: BrowserWindow;
  config: APIServerConfig;
  grants: MusicGrantStore;
  broker?: MusicRequestBroker;
  now?: () => number;
}
const services = new WeakMap<BrowserWindow, MusicService>();
export function getMusicService(window: BrowserWindow) {
  const service = services.get(window);
  return service?.enabled ? service : undefined;
}
export function localMusicResource(config: APIServerConfig): string {
  const hostname = config.hostname.toLowerCase();
  if (
    !['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(hostname) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  )
    return failMusic('unavailable');
  const host = hostname === '::1' || hostname === '::' ? '[::1]' : '127.0.0.1';
  const advertised = hostname === 'localhost' ? 'localhost' : host;
  const https = config.useHttps && !!config.certPath && !!config.keyPath;
  return new URL(
    `${https ? 'https' : 'http'}://${advertised}:${config.port}/api/v1/music`,
  ).href;
}
const opaque = (prefix: string) =>
  `${prefix}_${randomBytes(32).toString('base64url')}`;
const categoryTargets = {
  'explore': 'FEmusic_explore',
  'charts': 'FEmusic_charts',
  'genres': 'FEmusic_moods_and_genres',
  'new-releases': 'FEmusic_new_releases_albums',
};
const personalCollection = (id: string) =>
  ['WL', 'LL', 'LM'].includes(id) || id.startsWith('FL');
function waitOwned<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () =>
    signal.reason instanceof MusicServiceError
      ? signal.reason
      : new MusicServiceError('retired');
  if (signal.aborted) return Promise.reject(reason());
  return new Promise((resolve, reject) => {
    const abort = () => reject(reason());
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}
/** Typed main service, private local remainders/recipes, and one authoritative authorization lifetime. */
export class MusicService {
  readonly grants: MusicGrantStore;
  private readonly broker: MusicRequestBroker;
  private readonly now: () => number;
  private readonly operations: MusicOperationLedger;
  private readonly detachNativeRetirement: () => void;
  private readonly detachGrantRetirement: () => void;
  private readonly releaseBroker: () => void;
  private config: APIServerConfig;
  private revision = 0;
  private stopped = false;
  private scope = new AbortController();
  private cacheTimer?: ReturnType<typeof setTimeout>;
  private readonly cursors = new Map<string, Cursor>();
  private readonly references = new Map<string, TargetReference>();
  constructor(private readonly runtime: MusicRuntime) {
    this.config = { ...runtime.config };
    this.grants = runtime.grants;
    this.broker = runtime.broker ?? createMusicRequestBroker(runtime.window);
    this.releaseBroker = this.broker.retain?.() ?? (() => {});
    this.now = runtime.now ?? Date.now;
    this.operations = musicOperationLedger(this.now);
    this.detachNativeRetirement =
      this.broker.subscribeRetirement?.(() => {
        this.operations.retire(this);
        this.revision++;
        this.scope.abort();
        this.scope = new AbortController();
        this.cursors.clear();
        this.references.clear();
        clearTimeout(this.cacheTimer);
        this.cacheTimer = undefined;
      }) ?? (() => {});
    this.detachGrantRetirement = this.grants.subscribe(() => {
      for (const [id, cursor] of this.cursors)
        if (
          !this.grants.isCurrent(cursor.principal, cursor.scope) ||
          (cursor.issuerScope &&
            !this.grants.isCurrent(cursor.principal, cursor.issuerScope))
        )
          this.cursors.delete(id);
      for (const [id, reference] of this.references)
        if (
          !this.grants.isCurrent(reference.principal, reference.scope) ||
          (reference.issuerScope &&
            !this.grants.isCurrent(reference.principal, reference.issuerScope))
        )
          this.references.delete(id);
      this.scheduleCacheCleanup();
    });
    services.set(runtime.window, this);
  }
  get enabled() {
    if (
      this.stopped ||
      this.config.enabled !== true ||
      this.config.musicApiEnabled !== true
    )
      return false;
    try {
      localMusicResource(this.config);
      return true;
    } catch {
      return false;
    }
  }
  get resource() {
    return localMusicResource(this.config);
  }
  captureNativeOwner() {
    const revision = this.revision,
      admission = this.broker.capture();
    return {
      signal: this.scope.signal,
      current: () =>
        this.enabled &&
        this.revision === revision &&
        this.broker.isCurrent(admission),
    };
  }
  configure(config: APIServerConfig) {
    this.operations.retire(this);
    this.revision++;
    this.scope.abort();
    this.scope = new AbortController();
    this.config = { ...config };
    this.cursors.clear();
    this.references.clear();
    clearTimeout(this.cacheTimer);
    this.cacheTimer = undefined;
  }
  stop() {
    if (this.stopped) return;
    this.operations.retire(this);
    this.stopped = true;
    this.revision++;
    this.scope.abort();
    this.cursors.clear();
    this.detachNativeRetirement();
    this.detachGrantRetirement();
    this.releaseBroker();
    this.references.clear();
    clearTimeout(this.cacheTimer);
    this.cacheTimer = undefined;
    if (services.get(this.runtime.window) === this)
      services.delete(this.runtime.window);
  }
  private async admitted<T>(
    token: unknown,
    scope: MusicScope,
    extra: MusicScope[],
    signal: AbortSignal | undefined,
    currentRead: boolean,
    action: (lease: Lease) => Promise<T>,
    deadlineAt?: number,
  ): Promise<T> {
    if (!this.enabled) return failMusic('unavailable');
    const revision = this.revision,
      admission = this.broker.capture(),
      resource = this.resource,
      deadline = Math.min(
        this.now() + (currentRead ? 5000 : 15000),
        deadlineAt ?? Infinity,
      ),
      controller = new AbortController();
    const joined = AbortSignal.any([
      this.scope.signal,
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    const currentOwner = () =>
      !joined.aborted &&
      !signal?.aborted &&
      !this.stopped &&
      this.enabled &&
      revision === this.revision &&
      this.resource === resource &&
      this.broker.isCurrent(admission) &&
      this.now() < deadline;
    let detach = () => {},
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(
        () => controller.abort(new MusicServiceError('timeout')),
        Math.max(0, deadline - this.now()),
      );
      timer.unref?.();
      if (!currentOwner()) return failMusic('retired');
      const principal = await waitOwned(
        this.grants.authorize(token, 'rest', resource, scope),
        joined,
      );
      if (!currentOwner()) return failMusic('retired');
      for (const permission of extra) {
        await waitOwned(
          this.grants.authorize(token, 'rest', resource, permission),
          joined,
        );
        if (!currentOwner()) return failMusic('retired');
      }
      const current = () =>
        currentOwner() &&
        this.grants.isCurrent(principal, scope) &&
        extra.every((permission) =>
          this.grants.isCurrent(principal, permission),
        );
      detach = this.grants.subscribe(() => {
        if (!current()) controller.abort();
      });
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          controller.abort(
            new MusicServiceError(
              principal.expiresAt < deadline ? 'retired' : 'timeout',
            ),
          ),
        Math.max(0, Math.min(deadline, principal.expiresAt) - this.now()),
      );
      timer.unref?.();
      if (!current()) return failMusic('retired');
      const result = await waitOwned(
        action({
          principal,
          scope,
          resource,
          ...(extra[0] ? { issuerScope: extra[0] } : {}),
          revision,
          admission,
          signal: joined,
          deadline: Math.min(deadline, principal.expiresAt),
          current,
        }),
        joined,
      );
      if (!current()) return failMusic('retired');
      return result;
    } catch (error) {
      if (error instanceof MusicServiceError) throw error;
      if (
        error instanceof MusicServiceError ||
        (error instanceof Error &&
          Object.hasOwn(error, 'code') &&
          [
            'unauthorized',
            'forbidden',
            'retired',
            'busy',
            'unavailable',
            'timeout',
            'invalid',
            'source',
            'budget',
            'unsupported',
            'not_found',
          ].includes((error as MusicServiceError).code))
      )
        return failMusic((error as MusicServiceError).code);
      return failMusic('source');
    } finally {
      clearTimeout(timer);
      detach();
    }
  }
  private async native(lease: Lease, input: MusicReadInput) {
    if (!lease.current()) return failMusic('retired');
    const value = await this.broker.read(
      lease.admission,
      input,
      lease.principal.id,
      {
        signal: lease.signal,
        deadline: lease.deadline,
        isCurrent: () => lease.current(),
      },
    );
    const owner = this.broker.resultOwner(value);
    if (!lease.current() || !owner?.current()) return failMusic('retired');
    return { value, owner };
  }
  prepare(
    token: unknown,
    input: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    return this.admitted(
      token,
      'playback.control',
      [],
      signal,
      false,
      (lease) => {
        const command = parseMusicOperationPrepareInput(input);
        return Promise.resolve(
          this.operations.prepare(command, {
            principal: lease.principal,
            resource: lease.resource,
            service: this,
            revision: lease.revision,
            admission: lease.admission,
            current: () =>
              this.enabled &&
              this.revision === lease.revision &&
              this.grants.isCurrent(lease.principal, 'playback.control') &&
              this.resource === lease.resource &&
              this.broker.isCurrent(lease.admission),
          }),
        );
      },
      deadline,
    );
  }
  private requireOperationContext(lease: Lease, row: MusicOperationRow) {
    if (
      row.requiredScope !== lease.scope ||
      !this.grants.isCurrent(lease.principal, row.requiredScope) ||
      row.binding.service !== this ||
      row.binding.revision !== lease.revision ||
      row.binding.admission.generation !== lease.admission.generation ||
      row.binding.admission.frame !== lease.admission.frame ||
      !row.binding.current() ||
      !lease.current()
    )
      return failMusic('retired');
  }
  operation(
    token: unknown,
    operationId: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    return this.admitted(
      token,
      'playback.control',
      [],
      signal,
      false,
      (lease) => {
        const row = this.operations.lookup(
          parseMusicOperationId(operationId),
          lease.principal,
          lease.resource,
          (row) => this.requireOperationContext(lease, row),
        );
        return Promise.resolve(this.operations.receipt(row));
      },
      deadlineAt,
    );
  }
  navigate(
    token: unknown,
    input: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    return this.admitted(
      token,
      'playback.control',
      [],
      signal,
      false,
      async (lease) => {
        const { operationId, ...command } = parseMusicMutationInput(input);
        const row = this.operations.lookup(
          operationId,
          lease.principal,
          lease.resource,
          (row) => this.requireOperationContext(lease, row),
        );
        if (JSON.stringify(command) !== row.canonical)
          return failMusic('conflict');
        const receipt = this.operations.receipt(row);
        if (receipt.status !== 'pending') return receipt;
        if (row.executing) return row.promise!;
        // Claim before the broker or any native callout can reenter. A duplicate's
        // signal only cancels its own admitted wait, never this first caller's job.
        row.executing = true;
        row.physicalHold = true;
        row.promise = (async (): Promise<MusicOperationReceipt> => {
          try {
            const value = await this.broker.read(
              lease.admission,
              {
                operation: 'navigate',
                command,
                deadlineAt: lease.deadline,
              },
              lease.principal.id,
              {
                signal: lease.signal,
                deadline: lease.deadline,
                isCurrent: () => lease.current(),
                onPhysicalSettled: (reason) =>
                  this.operations.settled(row, reason === 'not_admitted'),
              },
            );
            const own = Object.keys(value).every((key) => {
              const d = Object.getOwnPropertyDescriptor(value, key);
              return !!d && 'value' in d;
            });
            if (!own || !('phase' in value) || value.version !== 1)
              throw new MusicServiceError('source');
            if (
              value.phase === 'owned_dispatch' &&
              Object.keys(value).every((key) =>
                ['version', 'phase', 'binding'].includes(key),
              )
            )
              row.receipt = {
                operationId,
                status: 'accepted',
                meaning: 'owned_navigation_dispatch',
              };
            else if (
              value.phase === 'pre_effect_denial' &&
              Object.keys(value).length === 3 &&
              [
                'invalid',
                'source',
                'unsupported',
                'budget',
                'retired',
                'busy',
                'unavailable',
                'timeout',
              ].includes(value.reason)
            )
              row.receipt = {
                operationId,
                status: 'failed',
                error: value.reason,
              };
            else throw new MusicServiceError('source');
          } catch (error) {
            const code =
              error instanceof MusicServiceError ? error.code : 'source';
            row.receipt = row.notAdmitted
              ? { operationId, status: 'failed', error: code }
              : { operationId, status: 'uncertain', error: 'outcome_unknown' };
          } finally {
            this.operations.completed(row);
          }
          return this.operations.receipt(row);
        })();
        return row.promise;
      },
      deadline,
    );
  }
  control(
    token: unknown,
    input: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    return this.admitted(
      token,
      'playback.control',
      [],
      signal,
      false,
      async (lease) => {
        const { operationId, ...command } =
          parseMusicControlMutationInput(input);
        const row = this.operations.lookup(
          operationId,
          lease.principal,
          lease.resource,
          (row) => this.requireOperationContext(lease, row),
        );
        if (JSON.stringify(command) !== row.canonical)
          return failMusic('conflict');
        const receipt = this.operations.receipt(row);
        if (receipt.status !== 'pending') return receipt;
        if (row.executing) return row.promise!;
        // Claim before the broker or any native callout can reenter. A duplicate's
        // signal only cancels its own admitted wait, never this first caller's job.
        row.executing = true;
        row.physicalHold = true;
        row.promise = (async (): Promise<MusicOperationReceipt> => {
          try {
            const value = await this.broker.read(
              lease.admission,
              {
                operation: 'control',
                command,
                deadlineAt: lease.deadline,
              },
              lease.principal.id,
              {
                signal: lease.signal,
                deadline: lease.deadline,
                isCurrent: () => lease.current(),
                onPhysicalSettled: (reason) =>
                  this.operations.settled(row, reason === 'not_admitted'),
              },
            );
            const keys = Reflect.ownKeys(value);
            const prototype: unknown = Object.getPrototypeOf(value);
            const own =
              (prototype === Object.prototype || prototype === null) &&
              keys.every((key) => {
                const d = Object.getOwnPropertyDescriptor(value, key);
                return typeof key === 'string' && !!d && 'value' in d;
              });
            if (!own || !('phase' in value) || value.version !== 1)
              throw new MusicServiceError('source');
            if (
              value.phase === 'owned_control_dispatch' &&
              keys.length === 2 &&
              Object.keys(value).every((key) =>
                ['version', 'phase'].includes(key),
              )
            )
              row.receipt = {
                operationId,
                status: 'accepted',
                meaning: 'owned_control_dispatch',
              };
            else if (
              value.phase === 'pre_effect_denial' &&
              keys.length === 3 &&
              keys.every(
                (key) =>
                  typeof key === 'string' &&
                  ['version', 'phase', 'reason'].includes(key),
              ) &&
              [
                'invalid',
                'source',
                'unsupported',
                'budget',
                'retired',
                'busy',
                'unavailable',
                'timeout',
              ].includes(value.reason)
            )
              row.receipt = {
                operationId,
                status: 'failed',
                error: value.reason,
              };
            else throw new MusicServiceError('source');
          } catch (error) {
            const code =
              error instanceof MusicServiceError ? error.code : 'source';
            row.receipt = row.notAdmitted
              ? { operationId, status: 'failed', error: code }
              : { operationId, status: 'uncertain', error: 'outcome_unknown' };
          } finally {
            this.operations.completed(row);
          }
          return this.operations.receipt(row);
        })();
        return row.promise;
      },
      deadline,
    );
  }
  private metadataBinding(
    binding: MetadataBinding,
    owner: SourceOwner,
    target?: MetadataTarget,
  ) {
    if (
      binding.playbackEpoch !== null &&
      binding.playbackEpoch.split(':')[0] !== owner.epoch.split(':')[0]
    )
      return failMusic('source');
    if (
      target &&
      ('videoId' in target
        ? binding.videoId !== target.videoId || binding.playbackEpoch !== null
        : binding.playbackEpoch === null)
    )
      return failMusic('source');
    return binding;
  }
  private retireMetadata(binding: MetadataBinding) {
    const matches = (other?: MetadataBinding) =>
      other?.playbackEpoch === binding.playbackEpoch &&
      other?.videoId === binding.videoId;
    for (const [id, cursor] of this.cursors)
      if (
        cursor.kind === 'catalog' &&
        'binding' in cursor.context &&
        matches(cursor.context.binding)
      )
        this.cursors.delete(id);
    for (const [id, reference] of this.references)
      if (matches(reference.binding)) this.references.delete(id);
    this.scheduleCacheCleanup();
  }
  private async probeMetadata(
    lease: Lease,
    binding: MetadataBinding,
    owner: SourceOwner,
  ) {
    if (binding.playbackEpoch === null) return;
    const captured = await this.native(lease, {
      operation: 'metadata-current',
      deadlineAt: lease.deadline,
    });
    const fresh = parseNativeMetadataProbe(captured.value).binding;
    this.metadataBinding(fresh, captured.owner, { current: true });
    if (
      fresh.videoId !== binding.videoId ||
      fresh.playbackEpoch !== binding.playbackEpoch ||
      captured.owner.epoch !== owner.epoch ||
      !owner.current()
    ) {
      this.retireMetadata(binding);
      return failMusic('retired');
    }
  }
  lyrics(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<LyricsResult> {
    const target = parseMusicLyricsInput(value);
    return this.admitted(
      token,
      'catalog.read',
      [],
      signal,
      false,
      async (lease) => {
        const captured = await this.native(lease, {
          operation: 'lyrics',
          target,
          deadlineAt: lease.deadline,
        });
        const result = parseNativeLyricsMetadata(captured.value);
        this.metadataBinding(result.binding, captured.owner, target);
        return result.lyrics;
      },
      deadlineAt,
    );
  }
  related(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<MusicPage> {
    const input = parseMusicRelatedInput(value);
    return this.admitted(
      token,
      'catalog.read',
      [],
      signal,
      false,
      async (lease) => {
        if ('cursor' in input)
          return this.next(lease, input.cursor, 'related', input.limit);
        const target: MetadataTarget =
          'videoId' in input ? { videoId: input.videoId } : { current: true };
        const captured = await this.native(lease, {
          operation: 'related',
          target,
          deadlineAt: lease.deadline,
        });
        const result = parseNativeRelatedMetadata(captured.value);
        this.metadataBinding(result.binding, captured.owner, target);
        return this.page(
          lease,
          {
            route: 'related',
            videoId: result.binding.videoId,
            binding: result.binding,
          },
          result.source,
          captured.owner,
          0,
          input.limit,
        );
      },
      deadlineAt,
    );
  }
  current(token: unknown, signal?: AbortSignal) {
    return this.admitted(
      token,
      'playback.read',
      [],
      signal,
      true,
      async (lease) => {
        const captured = await this.native(lease, { operation: 'current' });
        return parseNativeSnapshot(captured.value);
      },
    );
  }
  async queue(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<QueuePage> {
    const input = parseMusicQueueInput(value);
    return this.admitted(
      token,
      'playback.read',
      [],
      signal,
      true,
      async (lease) => {
        if (!input.cursor) {
          const captured = await this.native(lease, { operation: 'queue' });
          return this.queuePage(
            lease,
            parseNativeQueue(captured.value),
            captured.owner,
            0,
            input.limit,
          );
        }
        const cursor = this.cursors.get(input.cursor);
        if (
          !cursor ||
          cursor.kind !== 'queue' ||
          cursor.resource !== lease.resource ||
          cursor.scope !== lease.scope ||
          cursor.principal.id !== lease.principal.id ||
          cursor.principal.digest !== lease.principal.digest ||
          cursor.expires <= this.now()
        )
          return failMusic('not_found');
        if (
          cursor.revision !== this.revision ||
          !cursor.owner.current() ||
          !this.grants.isCurrent(cursor.principal, cursor.scope) ||
          (cursor.issuerScope !== undefined &&
            !this.grants.isCurrent(cursor.principal, cursor.issuerScope))
        )
          return failMusic('retired');
        if (input.limit !== cursor.limit) return failMusic('invalid');
        if (cursor.busy) return failMusic('busy');
        cursor.busy = true;
        try {
          const captured = await this.native(lease, { operation: 'queue' });
          const fresh = parseNativeQueue(captured.value);
          if (
            fresh.queueRevision !== cursor.source.queueRevision ||
            captured.owner.epoch !== cursor.owner.epoch ||
            !cursor.owner.current() ||
            JSON.stringify(fresh) !== JSON.stringify(cursor.source)
          )
            return failMusic('retired');
          if (cursor.replay) return structuredClone(cursor.replay);
          const page = this.queuePage(
            lease,
            cursor.source,
            captured.owner,
            cursor.offset,
            cursor.limit,
          );
          const bytes = utf8Bytes(JSON.stringify(page)) + 32;
          if (this.bytes() + bytes > MUSIC_LIMITS.cacheBytes) {
            if (page.nextCursor) this.cursors.delete(page.nextCursor);
            return failMusic('budget');
          }
          cursor.bytes += bytes;
          cursor.replay = structuredClone(page);
          return page;
        } finally {
          cursor.busy = false;
        }
      },
    );
  }
  private queuePage(
    lease: Lease,
    source: NativeQueueSnapshot,
    owner: SourceOwner,
    offset: number,
    limit: number,
  ): QueuePage {
    if (!lease.current() || !owner.current()) return failMusic('retired');
    const items = source.items
      .slice(offset, offset + limit)
      .map((item, index) => ({
        index: offset + index,
        selected: offset + index === source.selectedIndex,
        item,
      }));
    const result: QueuePage = {
      version: 1,
      queueRevision: source.queueRevision,
      total: source.items.length,
      selectedIndex: source.selectedIndex,
      items,
      nextCursor: null,
    };
    for (;;) {
      result.nextCursor =
        offset + items.length < source.items.length ? opaque('mcur') : null;
      if (utf8Bytes(JSON.stringify(result)) <= MUSIC_LIMITS.pageBytes) break;
      if (!items.length) return failMusic('budget');
      items.pop();
    }
    if (!items.length && offset < source.items.length)
      return failMusic('budget');
    if (result.nextCursor) {
      const cursor: Cursor = {
        kind: 'queue',
        id: result.nextCursor,
        principal: lease.principal,
        scope: lease.scope,
        resource: lease.resource,
        ...(lease.issuerScope ? { issuerScope: lease.issuerScope } : {}),
        revision: lease.revision,
        source,
        owner,
        offset: offset + items.length,
        limit,
        expires: this.now() + MUSIC_LIMITS.cursorMs,
        busy: false,
        bytes: 0,
      };
      cursor.bytes = utf8Bytes(JSON.stringify(cursor)) + 64;
      this.allocate(cursor);
      this.scheduleCacheCleanup();
    }
    return structuredClone(result);
  }
  search(token: unknown, value: unknown, signal?: AbortSignal) {
    return this.catalog(token, parseMusicInput(value, 'search'), signal);
  }
  browse(token: unknown, value: unknown, signal?: AbortSignal) {
    return this.catalog(token, parseMusicInput(value, 'browse'), signal);
  }
  home(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MusicPage> {
    return this.collection(token, value, 'home', signal);
  }
  library(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MusicPage> {
    return this.collection(token, value, 'library', signal);
  }
  private collection(
    token: unknown,
    value: unknown,
    route: 'home' | 'library',
    signal?: AbortSignal,
  ): Promise<MusicPage> {
    const input = parseMusicCollectionInput(value);
    return this.admitted(
      token,
      route === 'home' ? 'personalized.read' : 'library.read',
      [],
      signal,
      false,
      async (lease) => {
        if (input.cursor)
          return this.next(lease, input.cursor, route, input.limit);
        const captured = await this.native(lease, { operation: route });
        const parsed = parseNativeCatalog(captured.value, 'browse');
        const { source, seenPlaylistIds } =
          route === 'library'
            ? this.librarySource(parsed, [])
            : { source: parsed, seenPlaylistIds: undefined };
        return this.page(
          lease,
          { route },
          source,
          captured.owner,
          0,
          input.limit,
          seenPlaylistIds,
        );
      },
    );
  }
  /** Bounded playlist-only first-occurrence projection; preserve shelf intersections. */
  private librarySource(source: NormalizedMusicSource, prior: string[]) {
    const seen = new Set(prior),
      items: MusicItem[] = [],
      offsets = [0];
    for (const item of source.items) {
      if (item.kind === 'playlist' && !seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
      offsets.push(items.length);
    }
    return {
      source: {
        ...source,
        items,
        shelves: source.shelves
          .map((s) => ({
            title: s.title,
            start: offsets[s.start],
            count: offsets[s.start + s.count] - offsets[s.start],
          }))
          .filter((s) => s.count > 0),
        targetRecipes: [],
      },
      seenPlaylistIds: [...seen],
    };
  }
  private catalog(
    token: unknown,
    input: MusicClientInput,
    signal?: AbortSignal,
  ): Promise<MusicPage> {
    const extra: MusicScope[] =
      input.operation === 'browse' &&
      input.target.kind === 'playlist' &&
      personalCollection(input.target.id)
        ? ['library.read']
        : [];
    return this.admitted(
      token,
      'catalog.read',
      extra,
      signal,
      false,
      async (lease) => {
        if (input.operation === 'page')
          return this.next(lease, input.cursor, input.route, input.limit);
        let nativeInput: MusicReadInput, context: PageContext;
        if (input.operation === 'search') {
          const filters = {
            song: 'songs',
            video: 'videos',
            album: 'albums',
            artist: 'artists',
            playlist: 'playlists',
          } as const;
          nativeInput = {
            operation: 'search',
            query: input.query,
            ...(input.kind ? { filter: filters[input.kind] } : {}),
          };
          context = {
            route: 'search',
            query: input.query,
            ...(input.kind ? { kind: input.kind } : {}),
          };
        } else {
          const target = input.target;
          context = { route: 'browse', target };
          if (target.kind === 'reference') {
            const reference = this.references.get(target.id);
            if (
              !reference ||
              reference.principal.id !== lease.principal.id ||
              reference.principal.digest !== lease.principal.digest ||
              reference.resource !== lease.resource ||
              reference.expires <= this.now()
            )
              return failMusic('not_found');
            if (
              reference.revision !== this.revision ||
              !reference.owner.current() ||
              !this.grants.isCurrent(reference.principal, reference.scope) ||
              (reference.issuerScope !== undefined &&
                !this.grants.isCurrent(
                  reference.principal,
                  reference.issuerScope,
                ))
            )
              return failMusic('retired');
            if (reference.busy) return failMusic('busy');
            reference.busy = true;
            try {
              await this.probeMetadata(
                lease,
                reference.binding ?? { videoId: '', playbackEpoch: null },
                reference.owner,
              );
            } finally {
              reference.busy = false;
            }
            if (reference.binding)
              context = { ...context, binding: reference.binding };
            const originLease = lease;
            lease = {
              ...originLease,
              issuerScope: reference.issuerScope ?? reference.scope,
              current: () =>
                originLease.current() &&
                reference.owner.current() &&
                this.grants.isCurrent(reference.principal, reference.scope) &&
                (!reference.issuerScope ||
                  this.grants.isCurrent(
                    reference.principal,
                    reference.issuerScope,
                  )),
            };
            nativeInput = {
              operation: 'browse',
              browseId: reference.browseId,
              ...(reference.binding?.playbackEpoch
                ? {
                    expectedCurrent: reference.binding,
                    deadlineAt: lease.deadline,
                  }
                : {}),
              ...(reference.params ? { params: reference.params } : {}),
            };
          } else
            nativeInput = {
              operation: 'browse',
              browseId:
                target.kind === 'category'
                  ? categoryTargets[target.id]
                  : target.kind === 'playlist'
                    ? `VL${target.id}`
                    : target.id,
            };
        }
        const captured = await this.native(lease, nativeInput);
        const source = parseNativeCatalog(
          captured.value,
          nativeInput.operation === 'search' ? 'search' : 'browse',
        );
        return this.page(
          lease,
          context,
          source,
          captured.owner,
          0,
          input.limit,
        );
      },
    );
  }
  private bytes() {
    return (
      [...this.cursors.values()].reduce((n, r) => n + r.bytes, 0) +
      [...this.references.values()].reduce((n, r) => n + r.bytes, 0)
    );
  }
  private sweep() {
    for (const [id, r] of this.cursors)
      if (
        r.expires <= this.now() ||
        !this.grants.isCurrent(r.principal, r.scope) ||
        (r.issuerScope !== undefined &&
          !this.grants.isCurrent(r.principal, r.issuerScope))
      )
        this.cursors.delete(id);
    for (const [id, r] of this.references)
      if (
        r.expires <= this.now() ||
        !this.grants.isCurrent(r.principal, r.scope) ||
        (r.issuerScope !== undefined &&
          !this.grants.isCurrent(r.principal, r.issuerScope))
      )
        this.references.delete(id);
  }
  private scheduleCacheCleanup() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = undefined;
    if (this.stopped) return;
    const deadlines = [
      ...this.cursors.values(),
      ...this.references.values(),
    ].map((r) => Math.min(r.expires, r.principal.expiresAt));
    if (!deadlines.length) return;
    this.cacheTimer = setTimeout(
      () => {
        this.cacheTimer = undefined;
        this.sweep();
        this.scheduleCacheCleanup();
      },
      Math.max(0, Math.min(...deadlines) - this.now()),
    );
    this.cacheTimer.unref?.();
  }
  private allocate(cursor: Cursor) {
    this.sweep();
    if (
      this.cursors.size >= MUSIC_LIMITS.globalCursors ||
      [...this.cursors.values()].filter(
        (r) => r.principal.id === cursor.principal.id,
      ).length >= MUSIC_LIMITS.principalCursors ||
      this.bytes() + cursor.bytes > MUSIC_LIMITS.cacheBytes
    )
      return failMusic('budget');
    this.cursors.set(cursor.id, cursor);
  }
  private page(
    lease: Lease,
    context: PageContext,
    source: NormalizedMusicSource,
    owner: SourceOwner,
    offset: number,
    limit: number,
    seenPlaylistIds?: string[],
  ): MusicPage {
    if (!lease.current() || !owner.current()) return failMusic('retired');
    const sliced = sliceMusicSource(source, offset, limit);
    const recipeByIndex = new Map(
      source.targetRecipes.map((recipe) => [recipe.itemIndex, recipe]),
    );
    const projected = sliced.items.map((item, index) => ({
      ...item,
      ...(recipeByIndex.has(offset + index)
        ? { reference: opaque('mref') }
        : {}),
    }));
    const echoed =
      context.route === 'search'
        ? {
            query: context.query,
            ...(context.kind ? { kind: context.kind } : {}),
          }
        : context.route === 'browse'
          ? { target: context.target }
          : context.route === 'related'
            ? { videoId: context.videoId }
            : {};
    let result: MusicPage;
    for (;;) {
      const end = offset + projected.length;
      const shelves = source.shelves
        .filter((s) => s.start < end && s.start + s.count > offset)
        .map((s) => ({
          title: s.title,
          start: Math.max(0, s.start - offset),
          count: Math.min(end, s.start + s.count) - Math.max(offset, s.start),
        }));
      result = {
        version: 1,
        availability: 'supported',
        ...echoed,
        items: projected,
        shelves,
        nextCursor:
          end < source.items.length || source.continuation
            ? opaque('mcur')
            : null,
      };
      if (utf8Bytes(JSON.stringify(result)) <= MUSIC_LIMITS.pageBytes) break;
      if (!projected.length) return failMusic('budget');
      projected.pop();
    }
    if (!projected.length && offset < source.items.length)
      return failMusic('budget');
    const newReferences: TargetReference[] = [];
    for (const [index, item] of projected.entries())
      if (item.reference) {
        const recipe = recipeByIndex.get(offset + index)!;
        const reference = {
          id: item.reference,
          principal: lease.principal,
          scope: lease.scope,
          resource: lease.resource,
          ...(lease.issuerScope ? { issuerScope: lease.issuerScope } : {}),
          revision: lease.revision,
          owner,
          ...('binding' in context && context.binding?.playbackEpoch
            ? { binding: context.binding }
            : {}),
          browseId: recipe.browseId,
          ...(recipe.params ? { params: recipe.params } : {}),
          expires: this.now() + MUSIC_LIMITS.cursorMs,
          bytes: 0,
        };
        reference.bytes = utf8Bytes(JSON.stringify(reference)) + 64;
        newReferences.push(reference);
      }
    const referenceBytes = newReferences.reduce((n, r) => n + r.bytes, 0);
    this.sweep();
    if (
      this.references.size + newReferences.length >
        MUSIC_LIMITS.globalCursors ||
      this.bytes() + referenceBytes > MUSIC_LIMITS.cacheBytes
    )
      return failMusic('budget');
    if (result.nextCursor) {
      const cursor: Cursor = {
        kind: 'catalog',
        id: result.nextCursor,
        principal: lease.principal,
        scope: lease.scope,
        resource: lease.resource,
        ...(lease.issuerScope ? { issuerScope: lease.issuerScope } : {}),
        revision: lease.revision,
        context,
        source,
        ...(seenPlaylistIds ? { seenPlaylistIds } : {}),
        owner,
        offset: offset + projected.length,
        limit,
        expires: this.now() + MUSIC_LIMITS.cursorMs,
        busy: false,
        bytes: 0,
      };
      cursor.bytes = utf8Bytes(JSON.stringify(cursor)) + 64;
      if (
        this.bytes() + cursor.bytes + referenceBytes >
        MUSIC_LIMITS.cacheBytes
      )
        return failMusic('budget');
      this.allocate(cursor);
    }
    for (const reference of newReferences)
      this.references.set(reference.id, reference);
    this.scheduleCacheCleanup();
    return structuredClone(result);
  }
  private async next(
    lease: Lease,
    id: string,
    route: PageContext['route'],
    limit: number,
  ) {
    const cursor = this.cursors.get(id);
    if (
      !cursor ||
      cursor.kind !== 'catalog' ||
      cursor.resource !== lease.resource ||
      cursor.scope !== lease.scope ||
      cursor.principal.id !== lease.principal.id ||
      cursor.principal.digest !== lease.principal.digest ||
      cursor.context.route !== route ||
      cursor.expires <= this.now()
    )
      return failMusic('not_found');
    if (
      cursor.revision !== this.revision ||
      !cursor.owner.current() ||
      !this.grants.isCurrent(cursor.principal, cursor.scope) ||
      (cursor.issuerScope !== undefined &&
        !this.grants.isCurrent(cursor.principal, cursor.issuerScope))
    )
      return failMusic('retired');
    if (limit !== cursor.limit) return failMusic('invalid');
    if (cursor.busy) return failMusic('busy');
    const originLease = lease;
    if (cursor.issuerScope)
      lease = {
        ...originLease,
        issuerScope: cursor.issuerScope,
        current: () =>
          originLease.current() &&
          this.grants.isCurrent(cursor.principal, cursor.issuerScope!),
      };
    cursor.busy = true;
    try {
      if ('binding' in cursor.context && cursor.context.binding)
        await this.probeMetadata(lease, cursor.context.binding, cursor.owner);
      if (cursor.replay) return structuredClone(cursor.replay);
      let seenPlaylistIds = cursor.seenPlaylistIds;
      let source = cursor.source,
        owner = cursor.owner,
        offset = cursor.offset;
      if (offset === source.items.length) {
        if (!source.continuation) return failMusic('not_found');
        const captured = await this.native(
          lease,
          cursor.context.route === 'related'
            ? {
                operation: 'related-continuation',
                token: source.continuation.token,
                binding: cursor.context.binding,
                deadlineAt: lease.deadline,
              }
            : {
                operation: 'continuation',
                ...source.continuation,
                ...('binding' in cursor.context &&
                cursor.context.binding?.playbackEpoch
                  ? {
                      expectedCurrent: cursor.context.binding,
                      deadlineAt: lease.deadline,
                    }
                  : {}),
              },
        );
        if (cursor.context.route === 'related') {
          const result = parseNativeRelatedMetadata(captured.value);
          this.metadataBinding(result.binding, captured.owner);
          if (
            JSON.stringify(result.binding) !==
            JSON.stringify(cursor.context.binding)
          )
            return failMusic('retired');
          source = result.source;
        } else
          source = parseNativeCatalog(
            captured.value,
            source.continuation.endpoint,
          );
        if (owner.epoch !== captured.owner.epoch || !owner.current())
          return failMusic('retired');
        if (cursor.context.route === 'library') {
          const projected = this.librarySource(source, seenPlaylistIds ?? []);
          source = projected.source;
          seenPlaylistIds = projected.seenPlaylistIds;
        }
        owner = captured.owner;
        offset = 0;
      }
      const page = this.page(
        lease,
        cursor.context,
        source,
        owner,
        offset,
        limit,
        seenPlaylistIds,
      );
      const bytes = utf8Bytes(JSON.stringify(page));
      if (this.bytes() + bytes + 32 > MUSIC_LIMITS.cacheBytes) {
        if (page.nextCursor) this.cursors.delete(page.nextCursor);
        for (const item of page.items)
          if (item.reference) this.references.delete(item.reference);
        return failMusic('budget');
      }
      cursor.bytes += bytes + 32;
      cursor.replay = structuredClone(page);
      return page;
    } finally {
      cursor.busy = false;
    }
  }
  stats() {
    return {
      cursors: this.cursors.size,
      references: this.references.size,
      cacheBytes: this.bytes(),
    };
  }
}
export function createMusicService(runtime: MusicRuntime) {
  return new MusicService(runtime);
}
