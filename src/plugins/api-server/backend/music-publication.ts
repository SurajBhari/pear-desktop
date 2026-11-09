import { createHash } from 'node:crypto';

import { musicAccessCurrent, type MusicAccessBinding } from './music-access';

import type {
  MusicAdmission,
  MusicRequestBroker,
} from '@/providers/music-request';

// Capture the intrinsic getter/call before any adapter or SDK callback can run.
export const nativeMusicSignalAborted: (signal: AbortSignal) => boolean =
  Function.prototype.call.bind(
    // oxlint-disable-next-line typescript/unbound-method -- The intrinsic getter is explicitly bound to call.
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!,
  );
export interface MusicPublicationWitness {
  matches(encoded: string): boolean;
  /** Reentrant readiness work must finish before the final native checkpoint. */
  ready(): boolean;
  /** Original lifetimes and captured clock only; no disposed service lease. */
  current(): boolean;
}
export interface MusicDeliverySink {
  capture(witness: MusicPublicationWitness): boolean;
}
/** Tokenless, DTO-free lifetime capture, separate from the service lease closure. */
export function captureMusicPublication(input: {
  digest: string;
  access: MusicAccessBinding;
  broker: MusicRequestBroker;
  admission: MusicAdmission;
  signals: readonly AbortSignal[];
  createdAt: number;
  expiresAt: number;
  deadline: number;
  now: () => number;
}): MusicPublicationWitness {
  const {
    digest,
    access,
    broker,
    admission,
    createdAt,
    expiresAt,
    deadline,
    now,
  } = input;
  const signals = Object.freeze([...input.signals]);
  let retired = false;
  const current = () => {
    const time = now();
    if (
      !Number.isFinite(time) ||
      time < createdAt ||
      time >= expiresAt ||
      time >= deadline
    )
      retired = true;
    for (let index = 0; index < signals.length; index++)
      if (nativeMusicSignalAborted(signals[index])) retired = true;
    return !retired;
  };
  return Object.freeze({
    matches: (encoded: string) =>
      createHash('sha256').update(encoded, 'utf8').digest('hex') === digest,
    current,
    ready() {
      if (!current()) return false;
      try {
        if (!broker.isCurrent(admission) || !musicAccessCurrent(access))
          retired = true;
      } catch {
        retired = true;
      }
      return current();
    },
  });
}
