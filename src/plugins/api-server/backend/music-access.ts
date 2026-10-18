/** Main-owned adapter authority. Never accept these fields from client input. */
export interface MusicSessionOwner {
  readonly id: string;
  current(): boolean;
}
export interface MusicInvocation {
  readonly token: unknown;
  readonly transport: 'rest' | 'mcp';
  readonly resource: string;
  readonly signal: AbortSignal;
  readonly session?: MusicSessionOwner;
}
export interface MusicAccessOwner {
  readonly identity: object;
  current(): boolean;
}
export interface MusicAccessBinding {
  readonly transport: 'rest' | 'mcp';
  readonly resource: string;
  readonly owner: MusicAccessOwner;
  readonly session?: MusicSessionOwner;
}
// Separate factory: a cached guard must not retain an invocation's bearer or signal.
function musicOwnerFor(owner: MusicAccessOwner): MusicAccessOwner {
  return Object.freeze({
    identity: owner.identity,
    current: () => owner.current(),
  });
}
export function captureMusicAccess(
  invocation: MusicInvocation,
  owner: MusicAccessOwner,
): MusicAccessBinding {
  return Object.freeze({
    transport: invocation.transport,
    resource: invocation.resource,
    owner: musicOwnerFor(owner),
    ...(invocation.session ? { session: invocation.session } : {}),
  });
}
/** Identity comparison has no guard callouts; foreign lookup precedes retirement. */
export function sameMusicAccess(a: MusicAccessBinding, b: MusicAccessBinding) {
  return (
    a.transport === b.transport &&
    a.resource === b.resource &&
    a.owner.identity === b.owner.identity &&
    a.session === b.session
  );
}
export function musicAccessCurrent(binding: MusicAccessBinding) {
  return (
    binding.owner.current() &&
    (!binding.session || binding.session.current()) &&
    binding.owner.current()
  );
}
/** Account only scalar routing labels, never serialize owner functions/objects. */
export function musicAccessBytes(binding: MusicAccessBinding) {
  return Buffer.byteLength(
    JSON.stringify({
      transport: binding.transport,
      resource: binding.resource,
      session: binding.session?.id,
    }),
  );
}
