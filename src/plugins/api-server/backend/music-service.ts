import { randomBytes } from 'node:crypto';

import { sliceMusicSource } from '@/providers/music-catalog';
import {
  createMusicRequestBroker,
  type MusicRequestBroker,
  type MusicAdmission,
} from '@/providers/music-request';

import {
  parseMusicInput,
  parseNativeCatalog,
  parseNativeSnapshot,
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
  | { route: 'browse'; target: MusicTarget };
export interface MusicPage {
  version: 1;
  availability: 'supported';
  items: (MusicItem & { reference?: string })[];
  shelves: MusicShelf[];
  nextCursor: string | null;
  query?: string;
  kind?: string;
  target?: MusicTarget;
}
interface Cursor {
  id: string;
  principal: MusicGrantRecord;
  scope: MusicScope;
  revision: number;
  context: PageContext;
  source: NormalizedMusicSource;
  owner: SourceOwner;
  offset: number;
  limit: number;
  expires: number;
  busy: boolean;
  replay?: MusicPage;
  bytes: number;
}
interface TargetReference {
  id: string;
  principal: MusicGrantRecord;
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
    this.detachNativeRetirement =
      this.broker.subscribeRetirement?.(() => {
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
        if (!this.grants.isCurrent(cursor.principal, cursor.scope))
          this.cursors.delete(id);
      for (const [id, reference] of this.references)
        if (!this.grants.isCurrent(reference.principal, 'catalog.read'))
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
  ): Promise<T> {
    if (!this.enabled) return failMusic('unavailable');
    const revision = this.revision,
      admission = this.broker.capture(),
      resource = this.resource,
      deadline = this.now() + (currentRead ? 5000 : 15000),
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
  search(token: unknown, value: unknown, signal?: AbortSignal) {
    return this.catalog(token, parseMusicInput(value, 'search'), signal);
  }
  browse(token: unknown, value: unknown, signal?: AbortSignal) {
    return this.catalog(token, parseMusicInput(value, 'browse'), signal);
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
              reference.expires <= this.now()
            )
              return failMusic('not_found');
            if (
              reference.revision !== this.revision ||
              !reference.owner.current()
            )
              return failMusic('retired');
            nativeInput = {
              operation: 'browse',
              browseId: reference.browseId,
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
        !this.grants.isCurrent(r.principal, r.scope)
      )
        this.cursors.delete(id);
    for (const [id, r] of this.references)
      if (
        r.expires <= this.now() ||
        !this.grants.isCurrent(r.principal, 'catalog.read')
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
        : { target: context.target };
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
          revision: lease.revision,
          owner,
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
        id: result.nextCursor,
        principal: lease.principal,
        scope: lease.scope,
        revision: lease.revision,
        context,
        source,
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
    route: 'search' | 'browse',
    limit: number,
  ) {
    const cursor = this.cursors.get(id);
    if (
      !cursor ||
      cursor.principal.id !== lease.principal.id ||
      cursor.principal.digest !== lease.principal.digest ||
      cursor.context.route !== route ||
      cursor.expires <= this.now()
    )
      return failMusic('not_found');
    if (
      cursor.revision !== this.revision ||
      !cursor.owner.current() ||
      !this.grants.isCurrent(cursor.principal, cursor.scope)
    )
      return failMusic('retired');
    if (limit !== cursor.limit) return failMusic('invalid');
    if (cursor.busy) return failMusic('busy');
    if (cursor.replay) return structuredClone(cursor.replay);
    cursor.busy = true;
    try {
      let source = cursor.source,
        owner = cursor.owner,
        offset = cursor.offset;
      if (offset === source.items.length) {
        if (!source.continuation) return failMusic('not_found');
        const captured = await this.native(lease, {
          operation: 'continuation',
          ...source.continuation,
        });
        source = parseNativeCatalog(
          captured.value,
          source.continuation.endpoint,
        );
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
