import { randomBytes } from 'node:crypto';

import { sliceMusicSource } from '@/providers/music-catalog';
import { loadComments } from '@/providers/music-comments';
import {
  createMusicRequestBroker,
  type MusicRequestBroker,
  type MusicAdmission,
} from '@/providers/music-request';

import {
  captureMusicAccess,
  sameMusicAccess,
  musicAccessCurrent,
  musicAccessBytes,
  type MusicInvocation,
  type MusicAccessOwner,
  type MusicAccessBinding,
  type MusicSessionOwner,
} from './music-access';
import {
  createPublicCommentsWeb,
  type PublicCommentsWeb,
} from './music-comments-web';
import {
  musicGrantLifetimeSignal,
  type MusicGrantStore,
} from './music-grant-store';
import {
  localMusicHttpResource,
  musicHttpResources,
  musicHttpListenerSupports,
  type MusicHttpListenerOwner,
} from './music-http-policy';
import {
  musicOperationLedger,
  type MusicOperationLedger,
  type MusicOperationRow,
  type MusicOperationBinding,
} from './music-operations';
import {
  parseMusicInput,
  parseMusicCommentsInput,
  parseNativeCommentsMetadata,
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
  parseMusicQueueMutationInput,
  parseMusicMutationInput,
  parseMusicOperationId,
  type MusicTarget,
  type MusicClientInput,
} from './scheme/music';

import {
  MUSIC_LIMITS,
  MusicServiceError,
  failMusic,
  musicOperationScope,
  utf8Bytes,
  type MusicScope,
  type CommentsSource,
  type CommentsSort,
  type CommentPage,
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
  access: MusicAccessBinding;
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
        kind: 'comments';
        source: CommentsSource;
        channel: 'music' | 'public-web';
        sort: CommentsSort;
        binding: MetadataBinding;
        admission: MusicAdmission;
        replay?: CommentPage;
      }
    | {
        kind: 'queue';
        source: NativeQueueSnapshot;
        replay?: QueuePage;
      }
  );
interface TargetReference {
  access: MusicAccessBinding;
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
  access: MusicAccessBinding;
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
  commentsWeb?: PublicCommentsWeb;
  restListenerOwner?(): MusicHttpListenerOwner | undefined;
  resolveAccessOwner?(
    transport: 'rest' | 'mcp',
    resource: string,
  ): MusicAccessOwner | undefined;
}
const services = new WeakMap<BrowserWindow, MusicService>();
export function getMusicService(window: BrowserWindow, resource?: string) {
  const service = services.get(window);
  return service?.restAvailable(resource) ? service : undefined;
}
export function localMusicResource(config: APIServerConfig): string {
  return localMusicHttpResource(config) ?? failMusic('unavailable');
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
  if (signal.aborted) {
    // The action may synchronously retire its lease before returning a rejected
    // promise. Observe that promise even though its caller is already retired.
    promise.catch(() => {});
    return Promise.reject(reason());
  }
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
  private readonly commentsWeb: PublicCommentsWeb;
  private readonly now: () => number;
  private readonly operations: MusicOperationLedger;
  private readonly detachNativeRetirement: () => void;
  private readonly detachGrantRetirement: () => void;
  private readonly releaseBroker: () => void;
  private config: APIServerConfig;
  private revision = 0;
  private accessIdentity: object = {};
  private stopped = false;
  private scope = new AbortController();
  private cacheTimer?: ReturnType<typeof setTimeout>;
  private readonly cursors = new Map<string, Cursor>();
  private readonly references = new Map<string, TargetReference>();
  private readonly retiredSessions = new WeakSet<MusicSessionOwner>();
  private readonly sessionLeases = new Map<
    MusicSessionOwner,
    Set<AbortController>
  >();
  constructor(private readonly runtime: MusicRuntime) {
    this.config = { ...runtime.config };
    this.grants = runtime.grants;
    this.broker = runtime.broker ?? createMusicRequestBroker(runtime.window);
    this.commentsWeb = runtime.commentsWeb ?? createPublicCommentsWeb();
    this.releaseBroker = this.broker.retain?.() ?? (() => {});
    this.now = runtime.now ?? Date.now;
    this.operations = musicOperationLedger(this.now);
    this.detachNativeRetirement =
      this.broker.subscribeRetirement?.(() => {
        this.operations.retire(this);
        this.revision++;
        this.accessIdentity = {};
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
    const resources = musicHttpResources(this.config);
    return [resources.local, resources.remote].some(
      (resource) => resource !== undefined && this.restAvailable(resource),
    );
  }
  get httpConfigured() {
    return this.sharedAvailable() && this.config.musicApiEnabled === true;
  }
  get resource() {
    return localMusicResource(this.config);
  }
  restAvailable(resource?: string): boolean {
    try {
      return (
        this.restAccess(resource ?? this.resource)?.owner.current() === true
      );
    } catch {
      return false;
    }
  }
  captureNativeOwner(resource?: string) {
    const revision = this.revision;
    let selected: ReturnType<MusicService['restAccess']>;
    try {
      selected = this.restAccess(resource ?? this.resource);
    } catch {
      /* local discovery remains unavailable */
    }
    const admission = this.broker.capture();
    return {
      signal: AbortSignal.any([
        this.scope.signal,
        ...(selected?.signal ? [selected.signal] : []),
      ]),
      current: () => {
        const unchanged = () =>
          this.revision === revision && this.sharedAvailable();
        if (
          !selected ||
          !unchanged() ||
          !selected.owner.current() ||
          !unchanged()
        )
          return false;
        return (
          this.broker.isCurrent(admission) &&
          unchanged() &&
          selected.owner.current() &&
          unchanged()
        );
      },
    };
  }
  /** Exact main-owned session identity is terminal, regardless of later guard results. */
  retireSession(owner: MusicSessionOwner): void {
    this.retiredSessions.add(owner);
    const controllers = this.sessionLeases.get(owner);
    this.sessionLeases.delete(owner);
    for (const controller of controllers ?? []) controller.abort();
    for (const [id, cursor] of this.cursors)
      if (cursor.access.session === owner) this.cursors.delete(id);
    for (const [id, reference] of this.references)
      if (reference.access.session === owner) this.references.delete(id);
    this.scheduleCacheCleanup();
    this.operations.retireSession(this, owner);
  }
  configure(config: APIServerConfig) {
    this.operations.retire(this);
    this.revision++;
    this.accessIdentity = {};
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
    this.accessIdentity = {};
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
  private localInvocation(
    token: unknown,
    signal?: AbortSignal,
  ): MusicInvocation {
    return {
      token,
      transport: 'rest',
      resource: this.resource,
      signal: signal ?? new AbortController().signal,
    };
  }
  private sharedAvailable() {
    return !this.stopped && this.config.enabled === true;
  }
  /** Capture one REST listener lifetime; only pure owned fixtures omit the seam. */
  private restAccess(
    resource: string,
  ): { owner: MusicAccessOwner; signal?: AbortSignal } | undefined {
    const identity = this.accessIdentity;
    const revision = this.revision;
    const unchanged = () =>
      this.sharedAvailable() &&
      this.accessIdentity === identity &&
      this.revision === revision;
    if (
      !unchanged() ||
      !Object.values(musicHttpResources(this.config)).includes(resource)
    )
      return;
    const production = this.runtime.restListenerOwner !== undefined;
    const listener = this.runtime.restListenerOwner?.();
    if (!unchanged() || (production && !listener)) return;
    const current = () => {
      if (
        !unchanged() ||
        !Object.values(musicHttpResources(this.config)).includes(resource)
      )
        return false;
      if (!production) return unchanged();
      if (
        !listener ||
        !musicHttpListenerSupports(listener, resource) ||
        !unchanged()
      )
        return false;
      const selected = this.runtime.restListenerOwner?.();
      return (
        unchanged() &&
        selected === listener &&
        selected.identity === listener.identity &&
        !listener.signal.aborted
      );
    };
    if (!current()) return;
    return {
      owner: { identity: listener?.identity ?? identity, current },
      ...(listener ? { signal: listener.signal } : {}),
    };
  }
  private accessOwner(
    transport: 'rest' | 'mcp',
    resource: string,
  ): MusicAccessOwner | undefined {
    if (!this.sharedAvailable()) return undefined;
    if (transport === 'rest') return this.restAccess(resource)?.owner;
    return transport === 'mcp'
      ? this.runtime.resolveAccessOwner?.(transport, resource)
      : undefined;
  }
  private async admittedFor<T>(
    invocation: MusicInvocation,
    requiredScope: MusicScope | ((access: MusicAccessBinding) => MusicScope),
    extra: MusicScope[],
    currentRead: boolean,
    action: (lease: Lease) => Promise<T>,
    deadlineAt?: number,
  ): Promise<T> {
    const { token, transport, resource, signal, session } = invocation;
    const revision = this.revision,
      serviceSignal = this.scope.signal;
    if (session && this.retiredSessions.has(session))
      return failMusic('retired');
    const rest = transport === 'rest' ? this.restAccess(resource) : undefined;
    const owner =
      transport === 'rest'
        ? rest?.owner
        : this.accessOwner(transport, resource);
    if (!owner || (transport === 'rest' && session))
      return failMusic('unavailable');
    const access = captureMusicAccess(
      { token, transport, resource, signal, session },
      owner,
    );
    const accessCurrent = musicAccessCurrent(access);
    if (session && this.retiredSessions.has(session))
      return failMusic('retired');
    if (!accessCurrent) return failMusic('unavailable');
    const admission = this.broker.capture(),
      deadline = Math.min(
        this.now() + (currentRead ? 5000 : 15000),
        deadlineAt ?? Infinity,
      ),
      controller = new AbortController();
    const joined = AbortSignal.any([
      serviceSignal,
      controller.signal,
      ...(rest?.signal ? [rest.signal] : []),
      ...(signal ? [signal] : []),
    ]);
    // Native retirement advances this same private revision through the broker
    // observer. These terminal checks make no adapter/native guard callouts.
    let observedRetirement = false;
    let grantSignal: AbortSignal | undefined;
    const observe = (current: boolean) => {
      if (!current) observedRetirement = true;
      return current;
    };
    const unchanged = () =>
      !observedRetirement &&
      !grantSignal?.aborted &&
      !joined.aborted &&
      !signal.aborted &&
      (!session || !this.retiredSessions.has(session)) &&
      this.sharedAvailable() &&
      revision === this.revision &&
      this.scope.signal === serviceSignal;
    const stable = () => this.now() < deadline && unchanged();
    const authorityCurrent = () => {
      if (!stable()) return false;
      if (!observe(this.broker.isCurrent(admission)) || !stable()) return false;
      // Resolve AFTER native/owner/session callbacks. Never refresh the captured
      // binding: a different selected identity retires this invocation.
      const selected = this.accessOwner(transport, resource);
      return observe(selected?.identity === access.owner.identity) && stable();
    };
    const currentOwner = () => {
      if (!authorityCurrent()) return false;
      if (!observe(access.owner.current()) || !authorityCurrent()) return false;
      if (
        access.session &&
        (!observe(access.session.current()) || !authorityCurrent())
      )
        return false;
      return observe(access.owner.current()) && authorityCurrent();
    };
    const invalidReason = (
      principal?: MusicGrantRecord,
      fallback: 'retired' | 'timeout' = 'timeout',
    ) => {
      if (joined.reason instanceof MusicServiceError) return joined.reason;
      // Classification never re-enters native, access, session or grant guards.
      const now = this.now();
      return new MusicServiceError(
        !unchanged() ||
          (principal &&
            (now < principal.createdAt || now >= principal.expiresAt))
          ? 'retired'
          : fallback,
      );
    };
    let detach = () => {},
      detachGrantSignal = () => {},
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (session) {
        const controllers =
          this.sessionLeases.get(session) ?? new Set<AbortController>();
        controllers.add(controller);
        this.sessionLeases.set(session, controllers);
      }
      timer = setTimeout(
        () => controller.abort(invalidReason()),
        Math.max(0, deadline - this.now()),
      );
      timer.unref?.();
      if (!currentOwner()) throw invalidReason();
      // Receipt scope discovery and authorization share this captured origin.
      // A reentrant guard must not authorize a replacement using the old scope.
      const scope =
        typeof requiredScope === 'function'
          ? requiredScope(access)
          : requiredScope;
      if (typeof requiredScope === 'function' && !currentOwner())
        throw invalidReason();
      const principal = await waitOwned(
        this.grants.authorize(token, transport, resource, scope),
        joined,
      );
      // Bind the first authorized epoch before another authority callback can
      // re-enter. A prior commit is still visible even if attachment is late.
      grantSignal = musicGrantLifetimeSignal(this.grants, principal);
      if (!grantSignal) {
        observedRetirement = true;
        throw invalidReason(principal);
      }
      const capturedGrantSignal = grantSignal;
      const retireGrant = () => {
        observedRetirement = true;
        controller.abort(invalidReason(principal));
      };
      detachGrantSignal = () =>
        capturedGrantSignal.removeEventListener('abort', retireGrant);
      capturedGrantSignal.addEventListener('abort', retireGrant, {
        once: true,
      });
      if (capturedGrantSignal.aborted) retireGrant();
      if (
        !currentOwner() ||
        !observe(this.grants.isCurrent(principal, scope)) ||
        !currentOwner()
      )
        throw invalidReason(principal);
      for (const permission of extra) {
        await waitOwned(
          this.grants.authorize(token, transport, resource, permission),
          joined,
        );
        if (!currentOwner()) throw invalidReason(principal);
      }
      const current = () => {
        if (
          !currentOwner() ||
          !observe(this.grants.isCurrent(principal, scope)) ||
          !currentOwner()
        )
          return false;
        for (const permission of extra)
          if (
            !observe(this.grants.isCurrent(principal, permission)) ||
            !currentOwner()
          )
            return false;
        return true;
      };
      detach = this.grants.subscribe(() => {
        if (!current()) controller.abort(invalidReason(principal));
      });
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          controller.abort(
            invalidReason(
              principal,
              principal.expiresAt <= deadline ? 'retired' : 'timeout',
            ),
          ),
        Math.max(0, Math.min(deadline, principal.expiresAt) - this.now()),
      );
      timer.unref?.();
      if (!current()) throw invalidReason(principal);
      const result = await waitOwned(
        action({
          principal,
          access,
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
      if (!current()) throw invalidReason(principal);
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
      detachGrantSignal();
      detach();
      if (session) {
        const controllers = this.sessionLeases.get(session);
        controllers?.delete(controller);
        if (controllers?.size === 0) this.sessionLeases.delete(session);
      }
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
    if (!lease.current() || !owner?.current() || !lease.current())
      return failMusic('retired');
    return { value, owner };
  }
  prepare(
    token: unknown,
    input: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    // Preserve synchronous validation and promised local-resource failure.
    const command = parseMusicOperationPrepareInput(input);
    try {
      return this.prepareFor(
        this.localInvocation(token, signal),
        command,
        deadline,
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
  prepareFor(invocation: MusicInvocation, input: unknown, deadlineAt?: number) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    const command = parseMusicOperationPrepareInput(input),
      scope = musicOperationScope(command);
    return this.admittedFor(
      invocation,
      scope,
      [],
      false,
      (lease) => {
        const binding = this.receiptOwnerFor(
          lease.principal,
          lease.access,
          lease.revision,
          lease.admission,
          scope,
        );
        if (!lease.current()) return failMusic('retired');
        return Promise.resolve(this.operations.prepare(command, binding));
      },
      deadline,
    );
  }
  /** Separate factory: durable ownership never closes over a request lease or signal. */
  private receiptOwnerFor(
    principal: MusicGrantRecord,
    access: MusicAccessBinding,
    revision: number,
    admission: MusicAdmission,
    scope: MusicScope,
  ): MusicOperationBinding {
    const unchanged = () =>
      this.sharedAvailable() &&
      this.revision === revision &&
      (!access.session || !this.retiredSessions.has(access.session));
    const authorityCurrent = () => {
      if (!unchanged() || !this.broker.isCurrent(admission) || !unchanged())
        return false;
      const selected = this.accessOwner(access.transport, access.resource);
      return selected?.identity === access.owner.identity && unchanged();
    };
    const current = () => {
      if (!authorityCurrent()) return false;
      if (!access.owner.current() || !authorityCurrent()) return false;
      if (access.session && (!access.session.current() || !authorityCurrent()))
        return false;
      if (!this.grants.isCurrent(principal, scope) || !authorityCurrent())
        return false;
      return access.owner.current() && authorityCurrent();
    };
    return Object.freeze({
      principal,
      access,
      resource: access.resource,
      service: this,
      revision,
      admission: Object.freeze({
        frame: admission.frame,
        generation: admission.generation,
      }),
      current,
    });
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
  async operation(
    token: unknown,
    operationId: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    const id = parseMusicOperationId(operationId);
    return this.operationFor(
      this.localInvocation(token, signal),
      id,
      deadlineAt,
    );
  }
  async operationFor(
    invocation: MusicInvocation,
    operationId: unknown,
    deadlineAt?: number,
  ) {
    const id = parseMusicOperationId(operationId);
    const { token, transport, resource, signal, session } = invocation;
    const snapshot = { token, transport, resource, signal, session };
    return this.admittedFor(
      snapshot,
      (access) =>
        this.operations.requiredScope(id, token, access) ?? 'playback.control',
      [],
      false,
      (lease) => {
        const row = this.operations.lookup(
          parseMusicOperationId(operationId),
          lease.principal,
          lease.access,
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
    try {
      return this.navigateFor(
        this.localInvocation(token, signal),
        input,
        deadline,
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
  navigateFor(
    invocation: MusicInvocation,
    input: unknown,
    deadlineAt?: number,
  ) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    return this.admittedFor(
      invocation,
      'playback.control',
      [],
      false,
      async (lease) => {
        const { operationId, ...command } = parseMusicMutationInput(input);
        const row = this.operations.lookup(
          operationId,
          lease.principal,
          lease.access,
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
    try {
      return this.controlFor(
        this.localInvocation(token, signal),
        input,
        deadline,
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
  controlFor(invocation: MusicInvocation, input: unknown, deadlineAt?: number) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    return this.admittedFor(
      invocation,
      'playback.control',
      [],
      false,
      async (lease) => {
        const { operationId, ...command } =
          parseMusicControlMutationInput(input);
        const row = this.operations.lookup(
          operationId,
          lease.principal,
          lease.access,
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
  mutateQueue(
    token: unknown,
    input: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    try {
      return this.mutateQueueFor(
        this.localInvocation(token, signal),
        input,
        deadline,
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
  mutateQueueFor(
    invocation: MusicInvocation,
    input: unknown,
    deadlineAt?: number,
  ) {
    const deadline = Math.min(this.now() + 10000, deadlineAt ?? Infinity);
    return this.admittedFor(
      invocation,
      'queue.write',
      [],
      false,
      async (lease) => {
        const { operationId, ...command } = parseMusicQueueMutationInput(input);
        const row = this.operations.lookup(
          operationId,
          lease.principal,
          lease.access,
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
                operation: 'mutate-queue',
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
            const insertion =
              command.action === 'enqueue_song' ||
              command.action === 'enqueue_playlist';
            const dispatch =
              value.phase === 'owned_queue_dispatch' &&
              (insertion
                ? keys.length === 3 &&
                  'count' in value &&
                  Number.isInteger(value.count) &&
                  value.count! >= 1 &&
                  value.count! <= 1000
                : keys.length === 2) &&
              keys.every((key) =>
                ['version', 'phase', ...(insertion ? ['count'] : [])].includes(
                  key as string,
                ),
              );
            const noop =
              insertion &&
              value.phase === 'owned_queue_noop' &&
              keys.length === 3 &&
              value.count === 0 &&
              keys.every((key) =>
                ['version', 'phase', 'count'].includes(key as string),
              );
            if (dispatch || noop)
              row.receipt = {
                operationId,
                status: 'accepted',
                meaning: noop ? 'owned_queue_noop' : 'owned_queue_dispatch',
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
        (cursor.kind === 'comments' && matches(cursor.binding)) ||
        (cursor.kind === 'catalog' &&
          'binding' in cursor.context &&
          matches(cursor.context.binding))
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
    if (!lease.current()) return failMusic('retired');
  }
  lyrics(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<LyricsResult> {
    const target = parseMusicLyricsInput(value);
    return this.lyricsFor(
      this.localInvocation(token, signal),
      target,
      deadlineAt,
    );
  }
  lyricsFor(
    invocation: MusicInvocation,
    value: unknown,
    deadlineAt?: number,
  ): Promise<LyricsResult> {
    const target = parseMusicLyricsInput(value);
    return this.admittedFor(
      invocation,
      'catalog.read',
      [],
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
    return this.relatedFor(
      this.localInvocation(token, signal),
      input,
      deadlineAt,
    );
  }
  relatedFor(
    invocation: MusicInvocation,
    value: unknown,
    deadlineAt?: number,
  ): Promise<MusicPage> {
    const input = parseMusicRelatedInput(value);
    return this.admittedFor(
      invocation,
      'catalog.read',
      [],
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
  /** Public WEB work uses the same physical broker pool as all native reads. */
  private async publicComments(
    lease: Lease,
    binding: MetadataBinding,
    owner: SourceOwner,
    sort: CommentsSort,
    continuation?: string,
    maxRequests = 5,
  ) {
    await this.probeMetadata(lease, binding, owner);
    if (!lease.current() || !owner.current() || !lease.current())
      return failMusic('retired');
    const result = await this.broker.runOwned(
      lease.admission,
      lease.principal.id,
      async (context) => {
        const check = () => {
          if (this.now() >= lease.deadline) return failMusic('timeout');
          if (
            !context.current() ||
            !lease.current() ||
            !owner.current() ||
            !lease.current()
          )
            return failMusic('retired');
        };
        check();
        const response = await loadComments(
          (body) =>
            this.commentsWeb.request(body, {
              signal: context.signal,
              deadline: lease.deadline,
            }),
          {
            videoId: binding.videoId,
            sort,
            source: 'public-web',
            ...(continuation ? { continuation } : {}),
            maxRequests,
            check,
          },
        );
        check();
        const { requests, ...source } = response;
        return { version: 1 as const, binding, comments: source, requests };
      },
      {
        signal: lease.signal,
        deadline: lease.deadline,
        isCurrent: () => lease.current() && owner.current() && lease.current(),
      },
    );
    if (!lease.current() || !owner.current() || !lease.current())
      return failMusic('retired');
    await this.probeMetadata(lease, binding, owner);
    return parseNativeCommentsMetadata(result);
  }
  comments(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<CommentPage> {
    const input = parseMusicCommentsInput(value);
    return this.commentsFor(
      this.localInvocation(token, signal),
      input,
      deadlineAt,
    );
  }
  commentsFor(
    invocation: MusicInvocation,
    value: unknown,
    deadlineAt?: number,
  ): Promise<CommentPage> {
    const input = parseMusicCommentsInput(value);
    const deadline = Math.min(this.now() + 15000, deadlineAt ?? Infinity);
    return this.admittedFor(
      invocation,
      'comments.read',
      [],
      false,
      async (lease) => {
        if ('cursor' in input)
          return this.nextComments(lease, input.cursor, input.limit);
        const target: MetadataTarget =
          'videoId' in input ? { videoId: input.videoId } : { current: true };
        const captured = await this.native(lease, {
          operation: 'comments',
          target,
          sort: input.sort,
          deadlineAt: lease.deadline,
        });
        let result = parseNativeCommentsMetadata(captured.value),
          channel: 'music' | 'public-web' = 'music';
        this.metadataBinding(result.binding, captured.owner, target);
        // Only an authenticated, supported native absence and explicit consent may switch source.
        if (!result.comments.available && input.allowPublicWebFallback) {
          result = await this.publicComments(
            lease,
            result.binding,
            captured.owner,
            input.sort,
            undefined,
            5 - result.requests,
          );
          channel = 'public-web';
        }
        return this.commentsPage(
          lease,
          result.comments,
          captured.owner,
          result.binding,
          channel,
          input.sort,
          0,
          input.limit,
        );
      },
      deadline,
    );
  }
  private commentsPage(
    lease: Lease,
    source: CommentsSource,
    owner: SourceOwner,
    binding: MetadataBinding,
    channel: 'music' | 'public-web',
    sort: CommentsSort,
    offset: number,
    limit: number,
  ): CommentPage {
    if (!lease.current() || !owner.current() || !lease.current())
      return failMusic('retired');
    const comments = source.comments.slice(offset, offset + limit);
    let page: CommentPage;
    for (;;) {
      page = {
        version: 1,
        videoId: binding.videoId,
        sort,
        source: channel,
        available: source.available,
        comments,
        commentCount: source.commentCount,
        nextCursor:
          offset + comments.length < source.comments.length ||
          source.continuation
            ? opaque('mcur')
            : null,
      };
      if (utf8Bytes(JSON.stringify(page)) <= MUSIC_LIMITS.pageBytes) break;
      if (!comments.length) return failMusic('budget');
      comments.pop();
    }
    if (!comments.length && offset < source.comments.length)
      return failMusic('budget');
    if (page.nextCursor) {
      const cursor: Cursor = {
        kind: 'comments',
        id: page.nextCursor,
        principal: lease.principal,
        access: lease.access,
        scope: lease.scope,
        resource: lease.resource,
        revision: lease.revision,
        owner,
        offset: 0,
        limit,
        expires: this.now() + MUSIC_LIMITS.cursorMs,
        busy: false,
        bytes: 0,
        source: {
          ...source,
          comments: source.comments.slice(offset + comments.length),
        },
        channel,
        sort,
        binding,
        admission: lease.admission,
      };
      cursor.bytes =
        utf8Bytes(
          JSON.stringify({
            ...cursor,
            access: undefined,
            owner: { epoch: owner.epoch },
            admission: { generation: cursor.admission.generation },
          }),
        ) +
        musicAccessBytes(cursor.access) +
        64;
      this.allocate(cursor, lease);
    }
    this.scheduleCacheCleanup();
    return structuredClone(page);
  }
  private async nextComments(
    lease: Lease,
    id: string,
    limit: number,
  ): Promise<CommentPage> {
    const cursor = this.cursors.get(id);
    if (
      !cursor ||
      cursor.kind !== 'comments' ||
      !sameMusicAccess(cursor.access, lease.access) ||
      cursor.scope !== lease.scope ||
      cursor.resource !== lease.resource ||
      cursor.principal.id !== lease.principal.id ||
      cursor.principal.digest !== lease.principal.digest ||
      cursor.principal.transport !== lease.principal.transport ||
      cursor.expires <= this.now()
    )
      return failMusic('not_found');
    if (
      cursor.revision !== this.revision ||
      !musicAccessCurrent(cursor.access) ||
      !lease.current() ||
      cursor.admission.frame !== lease.admission.frame ||
      cursor.admission.generation !== lease.admission.generation ||
      !cursor.owner.current() ||
      !lease.current() ||
      !this.grants.isCurrent(cursor.principal, cursor.scope) ||
      !lease.current()
    )
      return failMusic('retired');
    if (limit !== cursor.limit) return failMusic('invalid');
    if (cursor.busy) return failMusic('busy');
    cursor.busy = true;
    try {
      await this.probeMetadata(lease, cursor.binding, cursor.owner);
      if (!lease.current()) return failMusic('retired');
      if (cursor.replay) return structuredClone(cursor.replay);
      let source = cursor.source,
        offset = cursor.offset;
      if (offset === source.comments.length) {
        if (!source.continuation) return failMusic('not_found');
        let result;
        if (cursor.channel === 'public-web')
          result = await this.publicComments(
            lease,
            cursor.binding,
            cursor.owner,
            cursor.sort,
            source.continuation,
          );
        else {
          const captured = await this.native(lease, {
            operation: 'comments-continuation',
            token: source.continuation,
            binding: cursor.binding,
            sort: cursor.sort,
            deadlineAt: lease.deadline,
          });
          if (
            captured.owner.epoch !== cursor.owner.epoch ||
            !cursor.owner.current() ||
            !lease.current()
          )
            return failMusic('retired');
          result = parseNativeCommentsMetadata(captured.value);
        }
        if (JSON.stringify(result.binding) !== JSON.stringify(cursor.binding))
          return failMusic('retired');
        source = result.comments;
        offset = 0;
      }
      const page = this.commentsPage(
          lease,
          source,
          cursor.owner,
          cursor.binding,
          cursor.channel,
          cursor.sort,
          offset,
          limit,
        ),
        bytes = utf8Bytes(JSON.stringify(page)) + 32;
      if (this.bytes() + bytes > MUSIC_LIMITS.cacheBytes) {
        if (page.nextCursor) this.cursors.delete(page.nextCursor);
        return failMusic('budget');
      }
      // A replay receipt replaces this consumed remainder; the newly issued cursor
      // owns only its remaining rows. Do not duplicate a whole source per local page.
      cursor.source = { ...cursor.source, comments: [], continuation: null };
      cursor.replay = structuredClone(page);
      cursor.bytes =
        utf8Bytes(
          JSON.stringify({
            ...cursor,
            access: undefined,
            owner: { epoch: cursor.owner.epoch },
            admission: { generation: cursor.admission.generation },
          }),
        ) +
        musicAccessBytes(cursor.access) +
        64;
      return page;
    } finally {
      cursor.busy = false;
    }
  }
  async current(token: unknown, signal?: AbortSignal) {
    return this.currentFor(this.localInvocation(token, signal));
  }
  currentFor(invocation: MusicInvocation, deadlineAt?: number) {
    return this.admittedFor(
      invocation,
      'playback.read',
      [],
      true,
      async (lease) => {
        const captured = await this.native(lease, { operation: 'current' });
        return parseNativeSnapshot(captured.value);
      },
      deadlineAt,
    );
  }
  async queue(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<QueuePage> {
    const input = parseMusicQueueInput(value);
    return this.queueFor(this.localInvocation(token, signal), input);
  }
  queueFor(
    invocation: MusicInvocation,
    value: unknown,
    deadlineAt?: number,
  ): Promise<QueuePage> {
    const input = parseMusicQueueInput(value);
    return this.admittedFor(
      invocation,
      'playback.read',
      [],
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
          !sameMusicAccess(cursor.access, lease.access) ||
          cursor.resource !== lease.resource ||
          cursor.scope !== lease.scope ||
          cursor.principal.id !== lease.principal.id ||
          cursor.principal.digest !== lease.principal.digest ||
          cursor.expires <= this.now()
        )
          return failMusic('not_found');
        if (
          cursor.revision !== this.revision ||
          !musicAccessCurrent(cursor.access) ||
          !lease.current() ||
          !cursor.owner.current() ||
          !lease.current() ||
          !this.grants.isCurrent(cursor.principal, cursor.scope) ||
          !lease.current() ||
          (cursor.issuerScope !== undefined &&
            !this.grants.isCurrent(cursor.principal, cursor.issuerScope)) ||
          !lease.current()
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
            !lease.current() ||
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
      deadlineAt,
    );
  }
  private queuePage(
    lease: Lease,
    source: NativeQueueSnapshot,
    owner: SourceOwner,
    offset: number,
    limit: number,
  ): QueuePage {
    if (!lease.current() || !owner.current() || !lease.current())
      return failMusic('retired');
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
        access: lease.access,
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
      cursor.bytes =
        utf8Bytes(JSON.stringify({ ...cursor, access: undefined })) +
        musicAccessBytes(cursor.access) +
        64;
      this.allocate(cursor, lease);
      this.scheduleCacheCleanup();
    }
    return structuredClone(result);
  }
  search(token: unknown, value: unknown, signal?: AbortSignal) {
    return this.catalog(token, parseMusicInput(value, 'search'), signal);
  }
  searchFor(invocation: MusicInvocation, value: unknown, deadlineAt?: number) {
    return this.catalogFor(
      invocation,
      parseMusicInput(value, 'search'),
      deadlineAt,
    );
  }
  browse(token: unknown, value: unknown, signal?: AbortSignal) {
    return this.catalog(token, parseMusicInput(value, 'browse'), signal);
  }
  browseFor(invocation: MusicInvocation, value: unknown, deadlineAt?: number) {
    return this.catalogFor(
      invocation,
      parseMusicInput(value, 'browse'),
      deadlineAt,
    );
  }
  home(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MusicPage> {
    const input = parseMusicCollectionInput(value);
    return this.homeFor(this.localInvocation(token, signal), input);
  }
  homeFor(
    invocation: MusicInvocation,
    value: unknown,
    deadlineAt?: number,
  ): Promise<MusicPage> {
    return this.collectionFor(invocation, value, 'home', deadlineAt);
  }
  library(
    token: unknown,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MusicPage> {
    const input = parseMusicCollectionInput(value);
    return this.libraryFor(this.localInvocation(token, signal), input);
  }
  libraryFor(
    invocation: MusicInvocation,
    value: unknown,
    deadlineAt?: number,
  ): Promise<MusicPage> {
    return this.collectionFor(invocation, value, 'library', deadlineAt);
  }
  private collectionFor(
    invocation: MusicInvocation,
    value: unknown,
    route: 'home' | 'library',
    deadlineAt?: number,
  ): Promise<MusicPage> {
    const input = parseMusicCollectionInput(value);
    return this.admittedFor(
      invocation,
      route === 'home' ? 'personalized.read' : 'library.read',
      [],
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
      deadlineAt,
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
  private async catalog(
    token: unknown,
    input: MusicClientInput,
    signal?: AbortSignal,
  ): Promise<MusicPage> {
    return this.catalogFor(this.localInvocation(token, signal), input);
  }
  private catalogFor(
    invocation: MusicInvocation,
    input: MusicClientInput,
    deadlineAt?: number,
  ): Promise<MusicPage> {
    const extra: MusicScope[] =
      input.operation === 'browse' &&
      input.target.kind === 'playlist' &&
      personalCollection(input.target.id)
        ? ['library.read']
        : [];
    return this.admittedFor(
      invocation,
      'catalog.read',
      extra,
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
              !sameMusicAccess(reference.access, lease.access) ||
              reference.principal.id !== lease.principal.id ||
              reference.principal.digest !== lease.principal.digest ||
              reference.resource !== lease.resource ||
              reference.expires <= this.now()
            )
              return failMusic('not_found');
            if (
              reference.revision !== this.revision ||
              !musicAccessCurrent(reference.access) ||
              !lease.current() ||
              !reference.owner.current() ||
              !lease.current() ||
              !this.grants.isCurrent(reference.principal, reference.scope) ||
              !lease.current() ||
              (reference.issuerScope !== undefined &&
                !this.grants.isCurrent(
                  reference.principal,
                  reference.issuerScope,
                )) ||
              !lease.current()
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
                originLease.current() &&
                this.grants.isCurrent(reference.principal, reference.scope) &&
                originLease.current() &&
                (!reference.issuerScope ||
                  (this.grants.isCurrent(
                    reference.principal,
                    reference.issuerScope,
                  ) &&
                    originLease.current())),
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
      deadlineAt,
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
  private allocate(cursor: Cursor, lease: Lease) {
    this.sweep();
    // Grant guards in sweep can synchronously retire the issuing session.
    if (!lease.current()) return failMusic('retired');
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
    if (!lease.current() || !owner.current() || !lease.current())
      return failMusic('retired');
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
          access: lease.access,
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
        reference.bytes =
          utf8Bytes(JSON.stringify({ ...reference, access: undefined })) +
          musicAccessBytes(reference.access) +
          64;
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
        access: lease.access,
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
      cursor.bytes =
        utf8Bytes(JSON.stringify({ ...cursor, access: undefined })) +
        musicAccessBytes(cursor.access) +
        64;
      if (
        this.bytes() + cursor.bytes + referenceBytes >
        MUSIC_LIMITS.cacheBytes
      )
        return failMusic('budget');
      this.allocate(cursor, lease);
    }
    if (!lease.current()) return failMusic('retired');
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
      !sameMusicAccess(cursor.access, lease.access) ||
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
      !musicAccessCurrent(cursor.access) ||
      !lease.current() ||
      !cursor.owner.current() ||
      !lease.current() ||
      !this.grants.isCurrent(cursor.principal, cursor.scope) ||
      !lease.current() ||
      (cursor.issuerScope !== undefined &&
        !this.grants.isCurrent(cursor.principal, cursor.issuerScope)) ||
      !lease.current()
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
          this.grants.isCurrent(cursor.principal, cursor.issuerScope!) &&
          originLease.current(),
      };
    cursor.busy = true;
    try {
      if ('binding' in cursor.context && cursor.context.binding)
        await this.probeMetadata(lease, cursor.context.binding, cursor.owner);
      if (!lease.current()) return failMusic('retired');
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
        if (
          owner.epoch !== captured.owner.epoch ||
          !owner.current() ||
          !lease.current()
        )
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
