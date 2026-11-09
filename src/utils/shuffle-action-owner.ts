type Role = 'restore' | 'force';
type State = { restore?: object; force?: object; cooldownUntil: number };
const documents = new WeakMap<Document, State>();
const COOLDOWN_MS = 3000;

/** Pure document-scoped admission; callers own all scheduling and native actions. */
export function createShuffleActionOwner(document: Document, role: Role) {
  let state = documents.get(document);
  if (!state) {
    state = { cooldownUntil: 0 };
    documents.set(document, state);
  }
  const token = {};
  state[role] = token;
  const owned = state;
  const isCurrent = () => owned[role] === token;
  const canBegin = (now: number) =>
    isCurrent() &&
    Number.isFinite(now) &&
    now >= owned.cooldownUntil &&
    (role !== 'force' || owned.restore === undefined);
  return {
    isCurrent,
    canBegin,
    begin(now: number): boolean {
      if (!canBegin(now)) return false;
      // Reserve before calling native code, which can synchronously reenter.
      owned.cooldownUntil = now + COOLDOWN_MS;
      return true;
    },
    release(): void {
      if (isCurrent()) delete owned[role];
    },
  };
}
