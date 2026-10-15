import { randomUUID } from 'node:crypto';

import { grantMatches, type MusicGrantRecord } from './music-grants';

import {
  failMusic,
  musicOperationScope,
  utf8Bytes,
  type MusicOperationCommand,
  type MusicOperationReceipt,
} from '../music-types';

import type { MusicAdmission } from '@/providers/music-request';

export const MUSIC_OPERATION_LIMITS = Object.freeze({
  entryBytes: 32 * 1024,
  aggregateBytes: 4 * 1024 * 1024,
  retentionMs: 120000,
  perPrincipal: 32,
  global: 128,
});
export interface MusicOperationBinding {
  principal: MusicGrantRecord;
  resource: string;
  service: object;
  revision: number;
  admission: MusicAdmission;
  current(): boolean;
}
export interface MusicOperationRow {
  readonly id: string;
  readonly command: MusicOperationCommand;
  readonly canonical: string;
  readonly requiredScope: 'playback.control' | 'queue.write';
  readonly binding: MusicOperationBinding;
  readonly expires: number;
  readonly bytes: number;
  receipt: MusicOperationReceipt;
  executing: boolean;
  physicalHold: boolean;
  notAdmitted?: boolean;
  promise?: Promise<MusicOperationReceipt>;
}
let ledger: MusicOperationLedger | undefined;
export function musicOperationLedger(now: () => number) {
  if (!ledger) {
    ledger = new MusicOperationLedger(now);
  }
  return ledger;
}
function freezeCommand(command: MusicOperationCommand): MusicOperationCommand {
  if (command.action === 'radio')
    return Object.freeze({
      action: 'radio',
      seed: Object.freeze({ ...command.seed }),
    });
  return Object.freeze({ ...command });
}
/** Independent bounded receipt history. Issuance is the only way to create a row. */
export class MusicOperationLedger {
  private readonly rows = new Map<string, MusicOperationRow>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly now: () => number) {}
  private purge() {
    for (const [id, row] of this.rows)
      if (!row.executing && !row.physicalHold && row.expires <= this.now())
        this.rows.delete(id);
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    let next = Infinity;
    for (const row of this.rows.values())
      if (!row.executing && !row.physicalHold)
        next = Math.min(next, row.expires);
    if (next !== Infinity) {
      this.timer = setTimeout(
        () => {
          this.purge();
          this.schedule();
        },
        Math.max(1, next - this.now()),
      );
      this.timer.unref?.();
    }
  }
  prepare(
    command: MusicOperationCommand,
    binding: MusicOperationBinding,
  ): MusicOperationReceipt {
    this.purge();
    const immutable = freezeCommand(command),
      canonical = JSON.stringify(immutable),
      expires = this.now() + MUSIC_OPERATION_LIMITS.retentionMs,
      uuid = '00000000-0000-4000-8000-000000000000';
    // Reserve the complete scalar record with the largest fixed receipt fields.
    // Native frame/service references and the settlement closure are never serialized.
    const bytes =
      utf8Bytes(
        JSON.stringify({
          id: uuid,
          command: immutable,
          canonical,
          requiredScope: musicOperationScope(immutable),
          binding: {
            principal: binding.principal,
            resource: binding.resource,
            revision: binding.revision,
            admission: { generation: binding.admission.generation },
          },
          expires,
          receipt: {
            operationId: uuid,
            status: 'uncertain',
            meaning: 'owned_navigation_dispatch',
            error: 'expired_operation',
          },
          executing: false,
          physicalHold: false,
          notAdmitted: false,
        }),
      ) + 32;
    if (bytes > MUSIC_OPERATION_LIMITS.entryBytes) return failMusic('budget');
    const rows = [...this.rows.values()];
    if (
      rows.length >= MUSIC_OPERATION_LIMITS.global ||
      rows.filter((r) => r.binding.principal.id === binding.principal.id)
        .length >= MUSIC_OPERATION_LIMITS.perPrincipal ||
      rows.reduce((sum, r) => sum + r.bytes, 0) + bytes >
        MUSIC_OPERATION_LIMITS.aggregateBytes
    )
      return failMusic('busy');
    if (!binding.current()) return failMusic('retired');
    const id = randomUUID(),
      receipt: MusicOperationReceipt = { operationId: id, status: 'pending' };
    const row: MusicOperationRow = {
      id,
      command: immutable,
      canonical,
      requiredScope: musicOperationScope(immutable),
      binding,
      expires,
      bytes,
      receipt,
      executing: false,
      physicalHold: false,
    };
    Object.defineProperty(row, 'requiredScope', {
      value: musicOperationScope(immutable),
      enumerable: true,
      writable: false,
      configurable: false,
    });
    this.rows.set(id, row);
    this.schedule();
    return { ...receipt };
  }
  requiredScope(id: string, token: unknown, resource: string) {
    const row = this.rows.get(id);
    if (
      !row ||
      !grantMatches(row.binding.principal, token, 'rest', resource, this.now())
    )
      return undefined;
    return row.requiredScope;
  }
  lookup(
    id: string,
    principal: MusicGrantRecord,
    resource: string,
    validateContext?: (row: MusicOperationRow) => void,
  ): MusicOperationRow {
    const row = this.rows.get(id);
    if (!row) return failMusic('unknown_operation');
    if (
      row.binding.principal.id !== principal.id ||
      row.binding.principal.digest !== principal.digest ||
      row.binding.principal.transport !== principal.transport ||
      row.binding.resource !== resource
    )
      return failMusic('unknown_operation');
    // Main-only synchronous validation must precede every request-driven mutation.
    // The callback is neither retained on the row nor serialized to native IPC.
    validateContext?.(row);
    if (row.expires <= this.now() && !row.executing && !row.physicalHold) {
      this.rows.delete(id);
      this.schedule();
      return failMusic('expired_operation');
    }
    return row;
  }
  retire(service: object) {
    for (const row of this.rows.values())
      if (
        row.binding.service === service &&
        row.receipt.status === 'pending' &&
        !row.executing
      )
        row.receipt = {
          operationId: row.id,
          status: 'retired',
          error: 'retired',
        };
    this.schedule();
  }
  settled(row: MusicOperationRow, notAdmitted = false) {
    row.physicalHold = false;
    row.notAdmitted = notAdmitted;
    this.purge();
    this.schedule();
  }
  completed(row: MusicOperationRow) {
    row.executing = false;
    this.purge();
    this.schedule();
  }
  receipt(row: MusicOperationRow): MusicOperationReceipt {
    if (
      row.receipt.status === 'pending' &&
      !row.executing &&
      !row.binding.current()
    )
      row.receipt = {
        operationId: row.id,
        status: 'retired',
        error: 'retired',
      };
    return { ...row.receipt };
  }
}
