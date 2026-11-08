import { randomUUID } from 'node:crypto';

import {
  musicGrantLifetimeSignal,
  type MusicGrantStore,
} from './music-grant-store';

import type { MusicInvocation, MusicSessionOwner } from './music-access';
import type { MusicGrantRecord } from './music-grants';
import type { MusicPublicationWitness } from './music-publication';
import type { MusicService } from './music-service';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';

export const MCP_LIMITS = Object.freeze({
  sessions: 16,
  grantSessions: 4,
  sessionIds: 4,
  grantIds: 8,
  globalIds: 32,
  http: 64,
  headers: 16 * 1024,
  body: 64 * 1024,
  toolInputElements: 64,
  response: 4 * 1024 * 1024,
  output: 4 * 1024 * 1024,
  idle: 15 * 60_000,
  absolute: 60 * 60_000,
});
export interface McpTransaction {
  readonly id: RequestId;
  readonly method: string;
  readonly controller: AbortController;
  readonly delivery: AbortController;
  readonly deadline: number;
  canceled: boolean;
  witness?: MusicPublicationWitness;
  takeInvocation?(): MusicInvocation | undefined;
}
export interface McpSession extends MusicSessionOwner {
  readonly signal: AbortSignal;
  readonly principal: MusicGrantRecord;
  readonly grantSignal: AbortSignal;
  readonly nativeSignal: AbortSignal;
  initialized: boolean;
  protocolVersion: string;
  readonly transactions: Map<RequestId, McpTransaction>;
  readonly completed: Map<RequestId, number>;
  touched: number;
  readonly created: number;
  closeSdk?(): Promise<void>;
  retire(): void;
}
/** Routing labels never confer authority. Every lookup receives fresh authentication. */
export function createMcpSessions(
  grants: MusicGrantStore,
  service: MusicService,
  now = Date.now,
) {
  const sessions = new Map<string, McpSession>();
  const samePrincipal = (session: McpSession, principal: MusicGrantRecord) =>
    session.principal.id === principal.id &&
    session.principal.digest === principal.digest &&
    session.principal.resource === principal.resource &&
    session.grantSignal === musicGrantLifetimeSignal(grants, principal) &&
    grants.isCurrentPrincipal(session.principal) &&
    grants.isCurrentPrincipal(principal);
  const detach = grants.subscribe(() => {
    for (const session of sessions.values())
      if (!grants.isCurrentPrincipal(session.principal)) session.retire();
  });
  const sweep = () => {
    for (const session of sessions.values())
      if (!session.current()) session.retire();
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  return {
    create(
      principal: MusicGrantRecord,
      native: { signal: AbortSignal; current(): boolean },
      protocolVersion: string,
    ): McpSession | undefined {
      sweep();
      const grantSignal = musicGrantLifetimeSignal(grants, principal);
      if (
        !grantSignal ||
        !grants.isCurrentPrincipal(principal) ||
        !native.current() ||
        sessions.size >= MCP_LIMITS.sessions ||
        [...sessions.values()].filter((s) => s.principal.id === principal.id)
          .length >= MCP_LIMITS.grantSessions
      )
        return;
      const controller = new AbortController(),
        created = now();
      let retired = false;
      const nativeRetired = () => session.retire();
      const session: McpSession = {
        id: randomUUID(),
        signal: controller.signal,
        principal,
        grantSignal,
        nativeSignal: native.signal,
        initialized: false,
        protocolVersion,
        transactions: new Map(),
        completed: new Map(),
        created,
        touched: created,
        current() {
          if (
            retired ||
            controller.signal.aborted ||
            native.signal.aborted ||
            grantSignal.aborted ||
            now() < created ||
            now() >= created + MCP_LIMITS.absolute ||
            now() >= session.touched + MCP_LIMITS.idle
          )
            return false;
          try {
            return (
              native.current() &&
              !controller.signal.aborted &&
              !native.signal.aborted &&
              !grantSignal.aborted
            );
          } catch {
            return false;
          }
        },
        retire() {
          if (retired) return;
          retired = true;
          sessions.delete(session.id);
          controller.abort();
          native.signal.removeEventListener('abort', nativeRetired);
          grantSignal.removeEventListener('abort', nativeRetired);
          service.retireSession(session);
          for (const row of session.transactions.values()) {
            row.takeInvocation = undefined;
            row.controller.abort();
            row.delivery.abort();
            row.witness = undefined;
          }
          session.transactions.clear();
          session.completed.clear();
          session.closeSdk?.().catch(() => {});
          session.closeSdk = undefined;
        },
      };
      sessions.set(session.id, session);
      native.signal.addEventListener('abort', nativeRetired, { once: true });
      grantSignal.addEventListener('abort', nativeRetired, { once: true });
      if (!session.current()) {
        session.retire();
        return;
      }
      return session;
    },
    find(id: string, principal: MusicGrantRecord): McpSession | undefined {
      const session = sessions.get(id);
      if (!session) return;
      if (!session.current()) {
        session.retire();
        return;
      }
      if (!samePrincipal(session, principal)) return;
      session.touched = now();
      return session;
    },
    admit(
      session: McpSession,
      id: RequestId,
      method: string,
    ): McpTransaction | undefined {
      const time = now();
      for (const [key, expiry] of session.completed)
        if (time >= expiry) session.completed.delete(key);
      const active = [...sessions.values()];
      if (
        !session.current() ||
        session.transactions.has(id) ||
        session.completed.has(id) ||
        session.transactions.size >= MCP_LIMITS.sessionIds ||
        active.reduce((n, s) => n + s.transactions.size, 0) >=
          MCP_LIMITS.globalIds ||
        active
          .filter((s) => s.principal.id === session.principal.id)
          .reduce((n, s) => n + s.transactions.size, 0) >= MCP_LIMITS.grantIds
      )
        return;
      const row: McpTransaction = {
        id,
        method,
        controller: new AbortController(),
        delivery: new AbortController(),
        deadline: time + 16_000,
        canceled: false,
      };
      session.transactions.set(id, row);
      return row;
    },
    finish(session: McpSession, row: McpTransaction) {
      row.takeInvocation = undefined;
      row.witness = undefined;
      if (session.transactions.get(row.id) === row) {
        session.transactions.delete(row.id);
        if (session.current()) {
          while (session.completed.size >= 128) {
            const first = session.completed.keys().next();
            if (first.done) break;
            session.completed.delete(first.value);
          }
          session.completed.set(row.id, now() + 120_000);
        }
      }
    },
    close() {
      clearInterval(timer);
      detach();
      for (const session of [...sessions.values()]) session.retire();
    },
  };
}
