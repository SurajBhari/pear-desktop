import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import {
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { build, normalizePath } from 'vite';
const root = path.resolve(import.meta.dirname, '..'),
  requireRoot = createRequire(path.join(root, 'package.json'));
const nativeQueryQuarantine = new Set<any>();
/** Bounded cleanup contract. A signal request or main close alone never permits deletion. */
export async function cleanupOwnedNativeChild(
  child: any,
  ports: {
    now(): number;
    timer(callback: () => void, ms: number): any;
    clear(timer: any): void;
    closed(): boolean;
    waitClose(): Promise<boolean>;
    queriesClosed(): boolean;
    treeEmpty(deadline: number): Promise<boolean>;
    remove(): Promise<void>;
    record(result: any): void;
    release(): void;
  },
) {
  const deadline = ports.now() + 2000;
  const errors: string[] = [];
  const bounded = async <T>(
    action: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    const remaining = deadline - ports.now();
    if (remaining <= 0) return fallback;
    let timer: any;
    try {
      const value = await Promise.race([
        action(),
        new Promise<T>((resolve) => {
          timer = ports.timer(() => resolve(fallback), remaining);
        }),
      ]);
      return ports.now() < deadline ? value : fallback;
    } catch {
      errors.push('owned cleanup action failed');
      return fallback;
    } finally {
      if (timer !== undefined) ports.clear(timer);
    }
  };
  let closed = ports.closed(),
    killRequested: boolean | null = null,
    treeEmpty = false,
    removed = false,
    removalObserved = false,
    removalRequested = false;
  if (child && !closed) {
    try {
      killRequested = child.kill('SIGKILL');
    } catch {
      killRequested = false;
      errors.push('owned child termination request failed');
    }
    closed = await bounded(ports.waitClose, false);
  }
  const queryClosure = () => {
    try {
      return ports.queriesClosed();
    } catch {
      errors.push('owned query closure failed');
      return false;
    }
  };
  let queriesClosed = queryClosure();
  if (closed && queriesClosed)
    treeEmpty = await bounded(() => ports.treeEmpty(deadline), false);
  queriesClosed = queryClosure();
  if (closed && queriesClosed && treeEmpty)
    removed = await bounded(async () => {
      removalRequested = true;
      await ports.remove();
      removalObserved = true;
      return true;
    }, false);
  const endedAtMono = ports.now();
  const deadlineExpired = endedAtMono >= deadline;
  const result = {
    startedAtMono: deadline - 2000,
    endedAtMono,
    complete:
      closed && queriesClosed && treeEmpty && removed && !deadlineExpired,
    deadlineExpired,
    queriesClosed,
    removalRequested,
    closed,
    killRequested,
    treeEmpty,
    removed: removalObserved,
    errors,
  };
  try {
    ports.record(result);
  } catch {
    result.complete = false;
    errors.push('cleanup evidence persistence failed');
  }
  if (!result.complete) {
    try {
      ports.release();
    } catch {
      errors.push('owned handle release failed');
    }
  }
  return result;
}

/** The quiescent test leader is authenticated before the fixed Windows tree tool. */
export async function retireOwnedWindowsFixture(
  child: any,
  identity: { pid: number; parent: number },
  ports: {
    live(): boolean;
    cohort(): Promise<{ pid: number; parent: number; creation: string }[]>;
    leader(): Promise<{ pid: number; parent: number; creation: string }[]>;
    terminate(): Promise<void>;
  },
) {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isSafeInteger(identity.parent) ||
    identity.parent <= 0 ||
    !ports.live() ||
    child.pid !== identity.pid
  )
    throw Error('Owned Windows leader is not live');
  const cohort = await ports.cohort();
  const leader = cohort.find((row) => row.pid === identity.pid);
  if (
    !leader ||
    leader.parent !== identity.parent ||
    !leader.creation ||
    !cohort.every(
      (row) =>
        Number.isSafeInteger(row.pid) &&
        row.pid > 0 &&
        Number.isSafeInteger(row.parent) &&
        typeof row.creation === 'string' &&
        !!row.creation,
    )
  )
    throw Error('Unqualified Windows cohort');
  const current = await ports.leader();
  if (
    current.length !== 1 ||
    current[0].pid !== leader.pid ||
    current[0].parent !== leader.parent ||
    current[0].creation !== leader.creation ||
    !ports.live()
  )
    throw Error('Windows leader identity changed');
  await ports.terminate();
  return { cohort, forcedFixtureRetirement: true };
}
export function ownedWindowsCohortAbsent(
  cohort: { pid: number; creation: string }[],
  current: { pid: number; creation: string }[],
) {
  return (
    cohort.length > 0 &&
    cohort.every(
      (row) =>
        Number.isSafeInteger(row.pid) &&
        row.pid > 0 &&
        typeof row.creation === 'string' &&
        !!row.creation,
    ) &&
    current.every(
      (row) =>
        Number.isSafeInteger(row.pid) &&
        typeof row.creation === 'string' &&
        !!row.creation,
    ) &&
    cohort.every(
      (old) =>
        !current.some(
          (row) => row.pid === old.pid && row.creation === old.creation,
        ),
    )
  );
}

export function assertNativeCleanupComplete(
  result: { complete: boolean; removalRequested?: boolean },
  originalFailure: unknown,
  owned: string,
) {
  if (!result.complete && originalFailure === undefined)
    throw Error(
      'Owned native cleanup incomplete; cleanup/removal evidence is not complete: ' +
        owned,
    );
}

export type OwnedQueryPhase =
  | 'cohort'
  | 'leader'
  | 'taskkill'
  | 'absence'
  | 'posix-identity'
  | 'posix-group-list';
export function planOwnedQuery(
  phase: OwnedQueryPhase,
  state: {
    now: number;
    nativeDeadline: number;
    caseDeadline: number;
    cleanupDeadline?: number;
    terminal?: boolean;
    active?: boolean;
  },
) {
  const phases = {
    cohort: { cap: 5000, after: 8000, cleanup: false },
    leader: { cap: 5000, after: 2500, cleanup: false },
    taskkill: { cap: 1000, after: 1000, cleanup: false },
    absence: { cap: 1000, after: 250, cleanup: true },
    'posix-identity': { cap: 1000, after: 1000, cleanup: false },
    'posix-group-list': { cap: 1000, after: 250, cleanup: true },
  };
  const selected = phases[phase];
  if (
    !selected ||
    ![state.now, state.nativeDeadline, state.caseDeadline].every(
      Number.isFinite,
    ) ||
    (selected.cleanup && !Number.isFinite(state.cleanupDeadline))
  )
    throw Error('Invalid owned query budget');
  if (state.terminal) return { admitted: false as const, reason: 'terminal' };
  if (state.active)
    return { admitted: false as const, reason: 'owned-query-active' };
  const operationDeadline = selected.cleanup
    ? Math.min(state.cleanupDeadline!, state.caseDeadline - 1000)
    : Math.min(state.nativeDeadline, state.caseDeadline - 3000);
  const available = Math.floor(
    operationDeadline - state.now - selected.after - 500,
  );
  if (available < 1)
    return { admitted: false as const, reason: 'budget-exhausted' };
  const timeoutMs = Math.min(selected.cap, available);
  return {
    admitted: true as const,
    capMs: selected.cap,
    timeoutMs,
    terminalAt: state.now + timeoutMs + 500,
    operationDeadline,
    reserveAfterMs: selected.after,
    closeGraceMs: 500,
  };
}
export function createOwnedQueryScope(ports: {
  execFile(
    command: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; windowsHide: boolean },
    callback: (error: any, stdout: string, stderr: string) => void,
  ): any;
  now(): number;
  timer(callback: () => void, ms: number): any;
  clear(timer: any): void;
  record(receipt: any): void;
  retain(owner: any): void;
  release(owner: any): void;
  onFailure(reason: string, error: unknown): void;
}) {
  let state: 'native' | 'cleanup' | 'failed' | 'complete' = 'native';
  let firstError: unknown,
    failureReason: string | undefined,
    active: any,
    notified = false;
  const owners: any[] = [];
  const code = (value: any) =>
    value == null
      ? null
      : Number.isSafeInteger(value)
        ? value
        : [
              'ENOENT',
              'EACCES',
              'EPERM',
              'ESRCH',
              'ETIMEDOUT',
              'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            ].includes(value)
          ? value
          : 'other';
  const signal = (value: any) =>
    value == null
      ? null
      : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(value)
        ? value
        : 'other';
  const receipt = (owner: any) => ({
    ...owner.facts,
    elapsedMs: Math.round(ports.now() - owner.started),
    failureReason: failureReason ?? null,
    pending: owner.facts.spawned && !owner.facts.physicalClosed,
  });
  const publish = (owner: any) => {
    try {
      ports.record(receipt(owner));
      return true;
    } catch {
      return false;
    }
  };
  const notify = () => {
    if (state === 'failed' && !active && !notified) {
      notified = true;
      try {
        ports.onFailure(failureReason!, firstError);
      } catch {
        /* Preserve the original query failure. */
      }
    }
  };
  const requestKill = (owner: any) => {
    if (!owner.child || owner.facts.physicalClosed || owner.facts.killRequested)
      return;
    owner.facts.killRequested = true;
    try {
      if (owner.child.kill('SIGTERM') === false)
        owner.facts.killRequestFailed = true;
    } catch {
      owner.facts.killRequestFailed = true;
    }
  };
  let finish!: (owner: any, forced?: boolean) => void;
  const fail = (reason: string, error: unknown) => {
    if (state !== 'failed') {
      state = 'failed';
      firstError = error;
      failureReason = reason;
    }
    if (active && !active.settled) {
      const owner = active;
      owner.facts.cancelled = true;
      requestKill(owner);
      if (owner.facts.physicalClosed || ports.now() >= owner.plan.terminalAt)
        finish(owner, true);
      else if (owner.drainTimer === undefined)
        owner.drainTimer = ports.timer(
          () => finish(owner, true),
          Math.max(0, Math.min(500, owner.plan.terminalAt - ports.now())),
        );
    }
    notify();
  };
  finish = (owner: any, forced = false) => {
    if (
      owner.settled ||
      (!forced && !(owner.facts.callbackObserved && owner.facts.physicalClosed))
    )
      return;
    owner.settled = true;
    ports.clear(owner.timer);
    if (owner.drainTimer !== undefined) ports.clear(owner.drainTimer);
    if (active === owner) active = undefined;
    const error = owner.callbackError ?? owner.eventError;
    if (state !== 'failed' && (ports.now() >= owner.plan.terminalAt || forced))
      fail('query-terminal', Error('Owned query terminal deadline'));
    if (state !== 'failed' && error) fail('query-error', error);
    owner.facts.logicalSettled = true;
    owner.facts.settledElapsedMs = ports.now() - owner.started;
    owner.facts.killed =
      owner.child?.killed === true || owner.callbackError?.killed === true;
    owner.facts.timeout =
      owner.callbackError?.killed === true &&
      owner.facts.callbackElapsedMs >= owner.plan.timeoutMs;
    owner.facts.closeUncertain = !owner.facts.physicalClosed;
    if (!publish(owner) && state !== 'failed')
      fail('receipt-failed', Error('Owned query receipt persistence failed'));
    const output = owner.stdout;
    owner.stdout = '';
    owner.stderr = '';
    if (state === 'failed') owner.reject(firstError);
    else owner.resolve(output);
    owner.resolveSettled();
    notify();
  };
  const cancel = (
    reason: string,
    error: unknown = Error('Owned native query cancelled'),
  ): Promise<void> => {
    const waiting = active?.settledPromise;
    fail(reason, error);
    return waiting ?? Promise.resolve();
  };
  const run = (
    command: string,
    args: string[],
    commandKind: string,
    phase: OwnedQueryPhase,
    context: {
      nativeDeadline: number;
      caseDeadline: number;
      cleanupDeadline?: number;
    },
    onAdmitted?: () => void,
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      if (state === 'failed' || state === 'complete') {
        reject(firstError ?? Error('Owned query scope is terminal'));
        return;
      }
      const cleanupPhase = phase === 'absence' || phase === 'posix-group-list';
      if ((state === 'cleanup') !== cleanupPhase || active) {
        void cancel(
          'query-reentry',
          Error('Owned query phase or reentry rejected'),
        );
        reject(firstError);
        return;
      }
      let plan: ReturnType<typeof planOwnedQuery>;
      try {
        plan = planOwnedQuery(phase, {
          ...context,
          now: ports.now(),
          terminal: false,
          active: false,
        });
      } catch (error) {
        fail('invalid-query-budget', error);
        reject(firstError);
        return;
      }
      if (!plan.admitted) {
        fail(plan.reason, Error('Owned query budget exhausted'));
        reject(firstError);
        return;
      }
      const owner: any = {
        started: ports.now(),
        plan,
        resolve,
        reject,
        settled: false,
        stdout: '',
        stderr: '',
        callbackError: undefined,
        eventError: undefined,
      };
      owner.settledPromise = new Promise<void>((yes) => {
        owner.resolveSettled = yes;
      });
      owner.facts = {
        id: owners.length + 1,
        commandKind,
        phase,
        spawned: false,
        pid: null,
        capMs: plan.capMs,
        timeoutMs: plan.timeoutMs,
        closeGraceMs: 500,
        terminalAt: plan.terminalAt,
        remainingNativeMs: context.nativeDeadline - owner.started,
        remainingCaseMs: context.caseDeadline - owner.started,
        remainingCleanupMs:
          context.cleanupDeadline === undefined
            ? null
            : context.cleanupDeadline - owner.started,
        callbackObserved: false,
        callbackElapsedMs: null,
        closeElapsedMs: null,
        settledElapsedMs: null,
        physicalClosed: false,
        exitObserved: false,
        exitCode: null,
        exitSignal: null,
        closeCode: null,
        closeSignal: null,
        code: null,
        signal: null,
        errorObserved: false,
        killRequested: false,
        killRequestFailed: false,
        killed: false,
        timeout: false,
        cancelled: false,
        closeUncertain: false,
        logicalSettled: false,
        stdoutBytes: 0,
        stderrBytes: 0,
      };
      active = owner;
      try {
        const launchNow = ports.now();
        const fresh = planOwnedQuery(phase, {
          ...context,
          now: launchNow,
          terminal: false,
          active: false,
        });
        if (!fresh.admitted) {
          fail(
            fresh.reason,
            Error('Owned query budget exhausted before launch'),
          );
          finish(owner, true);
          return;
        }
        owner.started = launchNow;
        owner.plan = fresh;
        Object.assign(owner.facts, {
          capMs: fresh.capMs,
          timeoutMs: fresh.timeoutMs,
          terminalAt: fresh.terminalAt,
          remainingNativeMs: context.nativeDeadline - launchNow,
          remainingCaseMs: context.caseDeadline - launchNow,
          remainingCleanupMs:
            context.cleanupDeadline === undefined
              ? null
              : context.cleanupDeadline - launchNow,
        });
        owner.child = ports.execFile(
          command,
          args,
          {
            timeout: fresh.timeoutMs,
            maxBuffer: 256 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (owner.facts.callbackObserved) return;
            owner.facts.callbackObserved = true;
            owner.facts.callbackElapsedMs = ports.now() - owner.started;
            owner.facts.code = code(error?.code);
            owner.facts.signal = signal(error?.signal);
            owner.facts.stdoutBytes = Buffer.byteLength(stdout ?? '');
            owner.facts.stderrBytes = Buffer.byteLength(stderr ?? '');
            if (!owner.settled) {
              owner.callbackError = error;
              owner.stdout = stdout;
              owner.stderr = stderr;
              finish(owner);
            } else publish(owner);
          },
        );
        owner.facts.spawned = true;
        owner.facts.pid = Number.isSafeInteger(owner.child.pid)
          ? owner.child.pid
          : null;
        owners.push(owner);
        owner.child.on('error', (error: unknown) => {
          owner.facts.errorObserved = true;
          owner.eventError = error;
        });
        owner.child.on('exit', (value: any, sig: any) => {
          owner.facts.exitObserved = true;
          owner.facts.exitCode = code(value);
          owner.facts.exitSignal = signal(sig);
        });
        owner.child.once('close', (value: any, sig: any) => {
          owner.facts.physicalClosed = true;
          owner.facts.closeElapsedMs = ports.now() - owner.started;
          owner.facts.closeCode = code(value);
          owner.facts.closeSignal = signal(sig);
          try {
            ports.release(owner);
          } catch {
            fail(
              'ownership-release-failed',
              Error('Owned query release failed'),
            );
          }
          if (owner.settled) publish(owner);
          else finish(owner, state === 'failed');
        });
        ports.retain(owner);
        owner.timer = ports.timer(
          () => {
            fail('query-terminal', Error('Owned query terminal deadline'));
            finish(owner, true);
          },
          Math.max(0, owner.plan.terminalAt - ports.now()),
        );
        onAdmitted?.();
      } catch (error) {
        fail('query-spawn-failed', error);
        if (!owner.child) finish(owner, true);
      }
    });
  return {
    run,
    cancel,
    active: () => !!active,
    isTerminal: () => state === 'failed' || state === 'complete',
    enterCleanup: () => {
      if (
        state !== 'native' ||
        active ||
        owners.some((o) => !o.facts.physicalClosed)
      )
        return false;
      state = 'cleanup';
      return true;
    },
    complete: () => {
      if (
        state === 'cleanup' &&
        !active &&
        owners.every((o) => o.facts.physicalClosed)
      )
        state = 'complete';
    },
    queriesClosed: () => owners.every((o) => o.facts.physicalClosed),
    snapshot: () => owners.map(receipt),
  };
}

export function ownedNativeTimingReceipt(
  timing:
    | {
        caseStartedAtMono: number;
        nativeStartedAtMono: number | null;
        subjectClosedAtMono: number | null;
        nativeWorkEndedAtMono: number | null;
        cleanupStartedAtMono: number | null;
        cleanupEndedAtMono: number | null;
      }
    | undefined,
  assertionsEndedAtMono: number,
) {
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const caseStart = number(timing?.caseStartedAtMono),
    nativeStart = number(timing?.nativeStartedAtMono),
    subjectClose = number(timing?.subjectClosedAtMono),
    workEnd = number(timing?.nativeWorkEndedAtMono),
    cleanupStart = number(timing?.cleanupStartedAtMono),
    cleanupEnd = number(timing?.cleanupEndedAtMono),
    assertionEnd = number(assertionsEndedAtMono);
  const present =
    caseStart !== null &&
    nativeStart !== null &&
    subjectClose !== null &&
    workEnd !== null &&
    cleanupStart !== null &&
    cleanupEnd !== null &&
    assertionEnd !== null;
  const ordered =
    present &&
    caseStart <= nativeStart &&
    nativeStart <= subjectClose &&
    subjectClose <= workEnd &&
    workEnd <= cleanupStart &&
    cleanupStart <= cleanupEnd &&
    cleanupEnd <= assertionEnd;
  const complete =
    ordered &&
    workEnd < Math.min(nativeStart + 25000, caseStart + 27000) &&
    cleanupEnd - cleanupStart <= 2000 &&
    assertionEnd - cleanupEnd <= 1000 &&
    caseStart + 30000 - cleanupEnd >= 1000 &&
    assertionEnd < caseStart + 30000;
  return {
    schema: 1,
    clock: 'host-performance.now',
    complete,
    reason: !present
      ? 'missing-or-invalid-timing'
      : !ordered
        ? 'inconsistent-timing'
        : !complete
          ? 'timing-budget-exhausted'
          : null,
    caseStartedAtMono: caseStart,
    nativeStartedAtMono: nativeStart,
    subjectClosedAtMono: subjectClose,
    nativeWorkEndedAtMono: workEnd,
    cleanupStartedAtMono: cleanupStart,
    cleanupEndedAtMono: cleanupEnd,
    assertionsEndedAtMono: assertionEnd,
    caseElapsedMs: present ? assertionEnd - caseStart : null,
    nativeElapsedMs: present ? workEnd - nativeStart : null,
    cleanupElapsedMs: present ? cleanupEnd - cleanupStart : null,
    postElapsedMs: present ? assertionEnd - cleanupEnd : null,
    remainingCaseAtCleanupEndMs: present
      ? caseStart + 30000 - cleanupEnd
      : null,
    remainingCaseAtAssertionsEndMs: present
      ? caseStart + 30000 - assertionEnd
      : null,
    postReserveMs: 1000,
  };
}

/** Actual broker/controller and Electron IPC; only native getters and service responses are synthetic. */
export async function commentsNative<T>(
  task: () => Promise<T>,
  caseStartedAtMono: number,
): Promise<T> {
  const suppliedEvidence = process.env.PEAR_COM_EVIDENCE_DIRECTORY;
  const prepared = process.env.PEAR_COM_PREPARED_FIXTURE;
  const prepareOnly = process.env.PEAR_COM_PREPARE_ONLY === '1';
  if ((prepareOnly || prepared) && !suppliedEvidence)
    throw Error(
      'Explicit local fixture mode requires an owned evidence directory',
    );
  if (prepareOnly && (process.env.CI || prepared))
    throw Error(
      'Prepare-only mode is local and cannot replace native CI assertions',
    );
  const ownedDirectory = (directory: string) => {
    if (!path.isAbsolute(directory))
      throw Error('Relative native evidence path');
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw Error('Unowned native evidence directory');
  };
  if (suppliedEvidence) ownedDirectory(suppliedEvidence);
  if (prepared) {
    ownedDirectory(prepared);
    if (
      !path.basename(prepared).startsWith('pear-comments-native-') ||
      realpathSync(path.dirname(prepared)) !== realpathSync(tmpdir())
    )
      throw Error('Unowned A1 prepared fixture');
  }
  const owned = realpathSync(
    prepared ?? (await mkdtemp(path.join(tmpdir(), 'pear-comments-native-'))),
  );
  const evidence = suppliedEvidence ?? owned;
  const observer = path.join(
    root,
    'tests/helpers/electron-startup-observer.cjs',
  );
  const observerSHA256 =
    '8581f0b3171f094830ba28970278585bcf34f7308538744c22c12fde0abf4f83';
  const fixtureFiles = [
    'entry.cjs',
    'preload.cjs',
    'main.html',
    'child.html',
    'main-source.ts',
    'renderer-source.ts',
    'source.cjs',
    'renderer.js',
  ];
  const sourceFiles = [
    'src/providers/music-actions.ts',
    'src/providers/music-renderer.ts',
    'src/renderer.ts',
    'src/plugins/api-server/music-types.ts',
    'src/plugins/api-server/backend/music-service.ts',
    'src/plugins/api-server/backend/music-operations.ts',
    'src/plugins/api-server/backend/scheme/music.ts',
    'src/plugins/api-server/backend/routes/music.ts',
    'tests/api-music-comments-native.test.ts',
    'tests/api-music-comments.test.ts',
    'src/providers/music-comments.ts',
    'src/providers/music-request.ts',
    'src/plugins/api-server/backend/music-comments-web.ts',
    'src/providers/music-queue.ts',
    'src/providers/queue-playlist-renderer.ts',
    'src/plugins/api-server/music-menu.ts',
    'tests/helpers/api-music-native.ts',
    'tests/helpers/electron-startup-observer.cjs',
  ];
  const factsPath = path.join(owned, 'startup-facts.json');
  let keepFixture = false;
  let child: ReturnType<typeof spawn> | undefined;
  let completionFailure: unknown;
  let originalFailure: unknown,
    childClosed = false,
    qualifiedGroup: number | undefined;
  let onChildClose!: (value: boolean) => void;
  const childClose = new Promise<boolean>((resolve) => {
    onChildClose = resolve;
  });
  let runId: string | undefined,
    forcedFixtureRetirement = false,
    retirementRequested = false;
  let windowsCohort:
    | { pid: number; parent: number; creation: string }[]
    | undefined;
  let quiescentSeen = false;
  let resolveQuiescent!: (packet: {
    pid: number;
    runId: string;
    owned: string;
    userData: string;
  }) => void;
  let rejectQuiescent!: (error: unknown) => void;
  const quiescent = new Promise<{
    pid: number;
    runId: string;
    owned: string;
    userData: string;
  }>((resolve, reject) => {
    resolveQuiescent = resolve;
    rejectQuiescent = reject;
  });
  quiescent.catch(() => {});
  const nativeTiming = {
    caseStartedAtMono,
    nativeStartedAtMono: null as number | null,
    subjectClosedAtMono: null as number | null,
    nativeWorkEndedAtMono: null as number | null,
    cleanupStartedAtMono: null as number | null,
    cleanupEndedAtMono: null as number | null,
  };
  let nativeDeadlineMono = 0;
  const caseDeadlineMono = caseStartedAtMono + 30000;
  let workTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectWork!: (error: unknown) => void;
  const workAborted = new Promise<never>((_resolve, reject) => {
    rejectWork = reject;
  });
  workAborted.catch(() => {});
  const queryScope = createOwnedQueryScope({
    execFile,
    now: () => performance.now(),
    timer: (callback, ms) => setTimeout(callback, ms),
    clear: (timer) => clearTimeout(timer),
    record: (receipt) => {
      process.stdout.write('COM_OWNED_QUERY ' + JSON.stringify(receipt) + '\n');
    },
    retain: (owner) => {
      nativeQueryQuarantine.add(owner);
    },
    release: (owner) => {
      nativeQueryQuarantine.delete(owner);
    },
    onFailure: (_reason, error) => {
      rejectWork(error);
      rejectQuiescent(error);
    },
  });
  const guarded = <U>(operation: Promise<U>): Promise<U> =>
    Promise.race([operation, workAborted]);

  // These OS queries run only after actual native admission, never in preparation.
  // Only numeric process/group ownership is read; no parent command lines are dumped.
  const query = (
    command: string,
    args: string[],
    commandKind:
      | 'owned-cim-cohort'
      | 'owned-cim-identities'
      | 'owned-posix-group-list'
      | 'owned-taskkill'
      | 'owned-posix-group-identity',
    phase: OwnedQueryPhase,
    cleanupDeadline?: number,
    onAdmitted?: () => void,
  ) =>
    queryScope.run(
      command,
      args,
      commandKind,
      phase,
      {
        nativeDeadline: nativeDeadlineMono,
        caseDeadline: caseDeadlineMono,
        cleanupDeadline,
      },
      onAdmitted,
    );
  const cim = async (
    ids: number[],
    descendants: boolean,
    phase: 'cohort' | 'leader' | 'absence',
    cleanupDeadline?: number,
  ) => {
    if (process.platform !== 'win32')
      throw Error('Windows CIM phase on another platform');
    if (
      !ids.length ||
      !ids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
    )
      throw Error('Invalid owned CIM request');
    const script = `$ErrorActionPreference='Stop';$pending=[System.Collections.Generic.Queue[int]]::new();${ids.map((pid) => `$pending.Enqueue(${pid});`).join('')}$seen=@{};$rows=@();while($pending.Count -gt 0){$id=$pending.Dequeue();if($seen.ContainsKey($id)){continue};$seen[$id]=$true;$p=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$id);if($null -ne $p){$rows+=@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;creation=$p.CreationDate.ToUniversalTime().ToString('o')};${descendants ? 'foreach($c in @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = "+$id))){$pending.Enqueue([int]$c.ProcessId)}' : ''}}};ConvertTo-Json -InputObject @($rows) -Compress`;
    const value: unknown = JSON.parse(
      await query(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        descendants ? 'owned-cim-cohort' : 'owned-cim-identities',
        phase,
        cleanupDeadline,
      ),
    );
    if (
      !Array.isArray(value) ||
      !value.every(
        (row) =>
          row &&
          typeof row === 'object' &&
          Number.isSafeInteger(row.pid) &&
          Number.isSafeInteger(row.parent) &&
          typeof row.creation === 'string' &&
          !!row.creation,
      )
    )
      throw Error('Invalid owned CIM response');
    return value as { pid: number; parent: number; creation: string }[];
  };
  const treeEmpty = async (cleanupDeadline: number) => {
    if (queryScope.isTerminal() || !queryScope.queriesClosed()) return false;
    if (!child) return true;
    if (process.platform === 'win32') {
      if (!forcedFixtureRetirement || !windowsCohort) return false;
      try {
        return ownedWindowsCohortAbsent(
          windowsCohort,
          await cim(
            windowsCohort.map((row) => row.pid),
            false,
            'absence',
            cleanupDeadline,
          ),
        );
      } catch {
        return false;
      }
    }
    if (qualifiedGroup === undefined) return false;
    try {
      const rows = (
        await query(
          'ps',
          ['-A', '-o', 'pgid='],
          'owned-posix-group-list',
          'posix-group-list',
          cleanupDeadline,
        )
      )
        .trim()
        .split(/\s+/);
      if (!rows.length || !rows.every((value) => /^\d+$/.test(value)))
        return false;
      return !rows.some((value) => Number(value) === qualifiedGroup);
    } catch {
      return false;
    }
  };
  try {
    if (!prepared) {
      const mainEntry = path.join(owned, 'main-source.ts'),
        rendererEntry = path.join(owned, 'renderer-source.ts');
      await writeFile(
        mainEntry,
        [
          `export * from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-request.ts')))};`,
          `export {createMusicService} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/backend/music-service.ts')))};`,
          `export {MusicGrantStore} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/backend/music-grant-store.ts')))};`,
          `export {createPublicCommentsWeb} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/backend/music-comments-web.ts')))};`,
          `export {registerMusicRoutes} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/backend/routes/music.ts')))};`,
          `export {createMusicGrantMenu} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/music-menu.ts')))};`,
          `export {getMusicService} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/backend/music-service.ts')))};`,
        ].join('\n'),
      );
      const core = await readFile(path.join(root, 'src/renderer.ts'), 'utf8');
      const init = core.slice(
        core.indexOf('async function onApiLoaded() {') +
          'async function onApiLoaded() {'.length,
        core.indexOf('  // Workaround for macOS traffic lights'),
      );
      await writeFile(
        rendererEntry,
        [
          `export * from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-renderer.ts')))};`,
          `export * from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-actions.ts')))};`,
          `import {publishMusicActionsOwner} from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-actions.ts')))};`,
          `import {createRepeatPreference} from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/repeat-preference.ts')))};`,
          `import {createPlaylistQueueController} from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/queue-playlist-renderer.ts')))};`,
          `let api,repeatPreference,playlistQueue,disposeMusicActionsOwner;export function initializeCore(next){api=next;${init};return{repeatPreference,playlistQueue,disposeMusicActionsOwner};}`,
        ].join('\n'),
      );

      const common = {
        root,
        configFile: false as const,
        logLevel: 'silent' as const,
        resolve: { alias: {} },
        plugins: [
          {
            name: 'native-app-boundaries',
            enforce: 'pre' as const,
            resolveId(id: string) {
              if (['@/utils', '@/i18n', '@/config'].includes(id))
                return '\0owned:' + id;
              if (id.startsWith('@/')) {
                const p = path.join(root, 'src', id.slice(2));
                const resolved = [p, p + '.ts', path.join(p, 'index.ts')].find(
                  (f) => existsSync(f) && statSync(f).isFile(),
                );
                return resolved && normalizePath(resolved);
              }
            },
            load(id: string) {
              if (id === '\0owned:@/utils')
                return 'export const createBackend=value=>value;export const LoggerPrefix="owned fixture";';
              if (id === '\0owned:@/i18n')
                return 'export const APPLICATION_NAME="Pear";export const t=value=>value;';
              if (id === '\0owned:@/config')
                return 'export const get=()=>false;export const set=()=>{};';
            },
          },
        ],
      };
      await build({
        ...common,
        plugins: [
          ...common.plugins,
          {
            name: 'assert-native-broker-singleton',
            generateBundle() {
              for (const relative of [
                'src/providers/music-request.ts',
                'src/plugins/api-server/backend/music-service.ts',
              ]) {
                const expected = normalizePath(path.join(root, relative));
                const ids = [...this.getModuleIds()].filter(
                  (id) => id.replaceAll('\\', '/').split('?')[0] === expected,
                );
                if (ids.length !== 1 || ids[0] !== expected)
                  this.error(
                    `Owned native singleton identity: ${relative}: ${JSON.stringify(ids)}`,
                  );
              }
            },
          },
        ],
        ssr: { noExternal: true },
        build: {
          ssr: normalizePath(mainEntry),
          outDir: owned,
          emptyOutDir: false,
          minify: false,
          rollupOptions: {
            external: ['electron'],
            output: { format: 'cjs', entryFileNames: 'source.cjs' },
          },
        },
      });
      await build({
        ...common,
        build: {
          outDir: owned,
          emptyOutDir: false,
          minify: false,
          lib: {
            entry: normalizePath(rendererEntry),
            name: 'MusicNativeSource',
            formats: ['iife'],
            fileName: () => 'renderer.js',
          },
        },
      });
      await writeFile(
        path.join(owned, 'preload.cjs'),
        `const {contextBridge,ipcRenderer}=require('electron');ipcRenderer.send('peard:owned-music-preload',{phase:'entered',mainFrame:process.isMainFrame});contextBridge.exposeInMainWorld('musicProof',{send:(channel,packet)=>ipcRenderer.send(channel,packet),subscribe:(channel,fn)=>{const h=(_e,...args)=>fn(...args);ipcRenderer.on(channel,h);return()=>ipcRenderer.off(channel,h)}});ipcRenderer.send('peard:owned-music-preload',{phase:'bridge-ready',mainFrame:process.isMainFrame});`,
      );
      await writeFile(
        path.join(owned, 'main.html'),
        '<html><body><ytmusic-app></ytmusic-app><iframe src="child.html"></iframe></body></html>',
      );
      await writeFile(
        path.join(owned, 'child.html'),
        '<html><body>Owned child</body></html>',
      );
      await writeFile(
        path.join(owned, 'entry.cjs'),
        `
const {app,BrowserWindow,ipcMain,session,net}=require('electron');const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};
for(const key of ['userData','sessionData','downloads']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned profile');app.setPath(key,target);}
let stage='ready';const mark=label=>{stage=label;console.log('MUSIC_NATIVE_STAGE '+JSON.stringify({stage,pid:process.pid,time:Date.now()}));};const bounded=async(label,operation)=>{mark(label);let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native phase did not complete: '+label)),5000);})]);}finally{clearTimeout(timer);}};app.on('browser-window-created',(_event,win)=>{const id=win.id,contents=win.webContents;for(const name of ['did-start-loading','did-stop-loading','did-finish-load','did-frame-finish-load','did-start-navigation','did-navigate','did-fail-load','render-process-gone'])contents.on(name,(...args)=>{const mainFrame=name==='did-frame-finish-load'?args[1]:name==='did-fail-load'?args[4]:name==='did-start-navigation'?(args[0]?.isMainFrame??args[3]):undefined;console.log('MUSIC_NATIVE_EVENT '+JSON.stringify({stage,window:id,event:name,time:Date.now(),pid:process.pid,rendererPid:contents.isDestroyed()?0:contents.getOSProcessId(),...(typeof mainFrame==='boolean'?{mainFrame}:{}),...(name==='did-fail-load'?{code:args[1]}:{}),...(name==='render-process-gone'?{reason:args[1]?.reason}:{})}));});});ipcMain.on('peard:owned-music-preload',(event,packet)=>{const win=BrowserWindow.fromWebContents(event.sender);if(!win||!['entered','bridge-ready'].includes(packet?.phase))return;console.log('MUSIC_NATIVE_PRELOAD '+JSON.stringify({stage,window:win.id,time:Date.now(),pid:process.pid,rendererPid:win.webContents.getOSProcessId(),phase:packet.phase,mainFrame:event.senderFrame===win.webContents.mainFrame}));});(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file://')}));net.fetch=async()=>{throw Error('Unexpected native remote request')};globalThis.MusicNativeProof={mark,bounded,app,projectRoot:${JSON.stringify(root)},owned,preload:path.join(owned,'preload.cjs'),BrowserWindow,ipcMain,source:require('./source.cjs'),bundle:fs.readFileSync(path.join(owned,'renderer.js'),'utf8')};stage='task';const result=await (${task.toString()})();stage='shutdown';console.log('MUSIC_NATIVE '+JSON.stringify(result));if(process.platform==='win32')app.on('window-all-closed',()=>{});for(const w of BrowserWindow.getAllWindows())w.destroy();if(process.platform==='win32'){stage='quiescent';console.log('MUSIC_NATIVE_QUIESCENT '+JSON.stringify({pid:process.pid,runId:process.env.PEAR_COM_RUN_ID,owned,userData:app.getPath('userData')}));process.stdin.resume();await new Promise(()=>{})}else app.quit()})().catch(error=>{console.error('Owned native music witness failed at '+stage+': '+String(error?.stack??error).slice(-8000));app.exit(1)});
`,
      );
    }
    const crypto = await import('node:crypto');
    const hash = async (file: string) =>
      crypto
        .createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    if ((await hash(observer)) !== observerSHA256)
      throw Error('F3 observer bytes changed');
    const marker = path.join(evidence, 'COM-NATIVE-EVIDENCE-OWNER.json');
    const project = realpathSync(root);
    if (existsSync(marker)) {
      if (lstatSync(marker).isSymbolicLink())
        throw Error('Unowned evidence marker');
      const owner = JSON.parse(await readFile(marker, 'utf8'));
      if (owner.project !== project || owner.kind !== 'pear-a1-native')
        throw Error('Foreign native evidence owner');
    } else {
      if (prepared) throw Error('Missing explicit prepared evidence owner');
      await writeFile(
        marker,
        JSON.stringify({ kind: 'pear-a1-native', project }),
        { flag: 'wx' },
      );
    }
    const manifestPath = path.join(evidence, 'PREPARED-FIXTURE.json');
    if (!prepared) {
      const fixtureSHA256: Record<string, string> = {},
        sourceBindings: Record<string, string> = {};
      for (const file of fixtureFiles)
        fixtureSHA256[file] = await hash(path.join(owned, file));
      for (const file of sourceFiles)
        sourceBindings[file] = await hash(path.join(root, file));
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            status: prepareOnly
              ? 'PREPARED_UNLAUNCHED_PENDING_ROOT_ADMISSION'
              : 'SELF_CONTAINED_OWNED_NATIVE_FIXTURE',
            owned,
            entrySHA256: fixtureSHA256['entry.cjs'],
            fixtureSHA256,
            sourceBindings,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    }
    if (lstatSync(manifestPath).isSymbolicLink())
      throw Error('Unowned prepared manifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const exactKeys = (value: object, expected: string[]) =>
      Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
    if (
      manifest.owned !== owned ||
      !exactKeys(manifest.fixtureSHA256, fixtureFiles) ||
      !exactKeys(manifest.sourceBindings, sourceFiles)
    )
      throw Error('Prepared fixture identity changed');
    for (const file of fixtureFiles)
      if ((await hash(path.join(owned, file))) !== manifest.fixtureSHA256[file])
        throw Error('Prepared fixture bytes changed');
    for (const file of sourceFiles)
      if ((await hash(path.join(root, file))) !== manifest.sourceBindings[file])
        throw Error('Prepared source bytes changed');
    for (const file of [
      'profile',
      'userData',
      'sessionData',
      'downloads',
      'startup-facts.json',
      'startup-facts.json.request',
    ])
      if (existsSync(path.join(owned, file)))
        throw Error('Native fixture profile/facts are not fresh');
    if (prepareOnly) {
      keepFixture = true;
      return { prepared: true } as T;
    }
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.V8_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    env.PEAR_TEST_STARTUP_FACTS = factsPath;
    runId = crypto.randomUUID();
    env.PEAR_COM_RUN_ID = runId;
    if (
      !Number.isFinite(caseStartedAtMono) ||
      performance.now() >= caseDeadlineMono - 3000
    )
      throw Error('Owned native case budget exhausted before spawn');
    const launchDeadline = Date.now() + 25000;
    nativeTiming.nativeStartedAtMono = performance.now();
    nativeDeadlineMono = nativeTiming.nativeStartedAtMono + 25000;
    workTimer = setTimeout(
      () => {
        void queryScope.cancel(
          'native-work-deadline',
          Error('Owned native work deadline'),
        );
      },
      Math.max(
        0,
        Math.min(nativeDeadlineMono, caseDeadlineMono - 3000) -
          performance.now(),
      ),
    );
    child = spawn(
      realpathSync(requireRoot('electron') as string),
      [
        '--require',
        observer,
        path.join(owned, 'entry.cjs'),
        `--user-data-dir=${path.join(owned, 'profile')}`,
        '--no-sandbox',
      ],
      {
        cwd: owned,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.once('close', () => {
      nativeTiming.subjectClosedAtMono = performance.now();
      childClosed = true;
      onChildClose(true);
      if (process.platform === 'win32' && !retirementRequested)
        void queryScope.cancel(
          'subject-closed',
          Error('Owned Windows leader closed during query'),
        );
    });
    let stdout = '',
      stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-(512 * 1024));
      const line = stdout
        .split('\n')
        .find((value) => value.startsWith('MUSIC_NATIVE_QUIESCENT '));
      if (line && !quiescentSeen) {
        try {
          const packet = JSON.parse(
            line.slice('MUSIC_NATIVE_QUIESCENT '.length),
          );
          if (
            packet.pid !== child?.pid ||
            packet.runId !== runId ||
            packet.owned !== owned ||
            packet.userData !== path.join(owned, 'userData')
          )
            throw Error('Unqualified fixture retirement handshake');
          quiescentSeen = true;
          resolveQuiescent(packet);
        } catch (error) {
          rejectQuiescent(error);
        }
      }
    });
    child.stderr!.on(
      'data',
      (chunk) => (stderr = (stderr + chunk).slice(-16000)),
    );
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Error(
              `Owned native music witness timed out; stdout: ${stdout}; stderr: ${stderr}`,
            ),
          ),
        Math.max(0, launchDeadline - Date.now()),
      );
      child!.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child!.on('close', (code) => {
        clearTimeout(timer);
        code === 0 || retirementRequested
          ? resolve()
          : reject(
              Error(
                `Owned native witness exit ${code}; stdout: ${stdout}; stderr: ${stderr}`,
              ),
            );
      });
    });
    completion.catch((error) => {
      completionFailure = error;
      if (queryScope.active())
        void queryScope.cancel('native-completion', error);
      else rejectWork(error);
    });
    completion.then(() => {
      if (!quiescentSeen && process.platform === 'win32')
        rejectQuiescent(Error('Owned Windows leader closed before quiescence'));
    }, rejectQuiescent);
    if (process.platform === 'win32') {
      const packet = await guarded(quiescent);
      const facts = JSON.parse(await guarded(readFile(factsPath, 'utf8')));
      const proofLine = stdout
        .split('\n')
        .find((value) => value.startsWith('MUSIC_NATIVE '));
      const partial =
        proofLine && JSON.parse(proofLine.slice('MUSIC_NATIVE '.length));
      if (
        !partial ||
        partial.mainPid !== child.pid ||
        partial.guardFacts?.pid !== child.pid ||
        facts.pid !== child.pid ||
        facts.visibleWindow !== false ||
        realpathSync(facts.userData) !== path.join(owned, 'userData') ||
        packet.pid !== child.pid ||
        packet.runId !== runId
      )
        throw Error('Unqualified F3 Windows fixture retirement');
      const retired = await guarded(
        retireOwnedWindowsFixture(
          child,
          { pid: child.pid!, parent: process.pid },
          {
            live: () =>
              !childClosed &&
              child!.exitCode === null &&
              child!.signalCode === null &&
              Date.now() < launchDeadline &&
              !queryScope.isTerminal(),
            cohort: () => cim([child!.pid!], true, 'cohort'),
            leader: () => cim([child!.pid!], false, 'leader'),
            terminate: async () => {
              await query(
                'taskkill.exe',
                ['/PID', String(child!.pid), '/T', '/F'],
                'owned-taskkill',
                'taskkill',
                undefined,
                () => {
                  retirementRequested = true;
                },
              );
            },
          },
        ),
      );
      windowsCohort = retired.cohort;
      forcedFixtureRetirement = true;
    }
    if (process.platform !== 'win32' && !childClosed && child.pid) {
      try {
        const row = (
          await query(
            'ps',
            ['-p', String(child.pid), '-o', 'pid=,pgid='],
            'owned-posix-group-identity',
            'posix-identity',
          )
        )
          .trim()
          .split(/\s+/);
        if (
          row.length === 2 &&
          row.every((value) => /^\d+$/.test(value)) &&
          Number(row[0]) === child.pid &&
          Number(row[1]) === child.pid
        )
          qualifiedGroup = child.pid;
      } catch {
        /* No qualification means no deletion, never a guessed group. */
      }
    }
    await guarded(completion);
    if (process.env.PEAR_MUSIC_NATIVE_TRACE === '1')
      process.stdout.write(stdout);
    const line = stdout
      .split('\n')
      .find((line) => line.startsWith('MUSIC_NATIVE '));
    if (!line) throw Error('Missing native music witness');
    const proof = JSON.parse(line.slice('MUSIC_NATIVE '.length));
    const facts = JSON.parse(await guarded(readFile(factsPath, 'utf8')));
    if (
      proof.mainPid !== child.pid ||
      proof.guardFacts?.pid !== child.pid ||
      facts.pid !== child.pid ||
      facts.visibleWindow !== false ||
      realpathSync(facts.userData) !==
        realpathSync(path.join(owned, 'userData'))
    )
      throw Error(
        'Guard facts do not identify the hidden spawned main/profile',
      );
    if (suppliedEvidence)
      await writeFile(
        path.join(evidence, 'ACTUAL-NATIVE-FACTS.json'),
        JSON.stringify({ facts, spawnedPID: child.pid }, null, 2),
        { flag: 'wx' },
      );
    proof.fixtureRetirement = {
      forcedFixtureRetirement,
      sampledCohortCount: windowsCohort?.length ?? 0,
      meaning:
        process.platform === 'win32'
          ? 'fixed fixture tree retirement and sampled identity absence'
          : 'normal fixture quit and qualified group absence',
    };
    Object.assign(proof as object, { ownedTiming: nativeTiming });
    return proof;
  } catch (error) {
    originalFailure = completionFailure ?? error;
    throw originalFailure;
  } finally {
    if (workTimer !== undefined) clearTimeout(workTimer);
    if (nativeTiming.nativeStartedAtMono !== null)
      nativeTiming.nativeWorkEndedAtMono = performance.now();
    if (!keepFixture && (!prepared || child)) {
      if (queryScope.active())
        await queryScope.cancel(
          'native-failure',
          originalFailure ?? Error('Owned native failure'),
        );
      queryScope.enterCleanup();
      const cleanup = await cleanupOwnedNativeChild(child, {
        now: () => performance.now(),
        timer: (callback, ms) => setTimeout(callback, ms),
        clear: (timer) => clearTimeout(timer),
        closed: () => !child || childClosed,
        waitClose: () => childClose,
        queriesClosed: () => queryScope.queriesClosed(),
        treeEmpty,
        remove: () => rm(owned, { recursive: true, force: true }),
        record: (result) => {
          nativeTiming.cleanupStartedAtMono = result.startedAtMono;
          nativeTiming.cleanupEndedAtMono = result.endedAtMono;
          if (!result.complete || suppliedEvidence)
            writeFileSync(
              path.join(evidence, 'CLEANUP-FACTS.json'),
              JSON.stringify(
                {
                  ...result,
                  nativeTiming,
                  owned,
                  spawnedPID: child?.pid ?? null,
                  qualifiedGroup: qualifiedGroup ?? null,
                  forcedFixtureRetirement,
                  windowsCohort: windowsCohort ?? null,
                  queryFacts: queryScope.snapshot(),
                  witnessMeaning:
                    process.platform === 'win32'
                      ? 'confirmed fixed taskkill and sampled same-identity cohort absence; not unseen-tree proof'
                      : 'qualified dedicated group empty',
                  originalFailure:
                    originalFailure instanceof Error
                      ? originalFailure.message
                      : originalFailure === undefined
                        ? null
                        : 'original native failure',
                  profileRetained:
                    result.removalRequested && !result.removed
                      ? null
                      : !result.removed,
                },
                null,
                2,
              ),
              { flag: 'wx' },
            );
        },
        release: () => {
          child?.stdin?.destroy();
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          child?.unref();
        },
      });
      if (queryScope.active()) {
        await queryScope.cancel(
          'cleanup-ended',
          originalFailure ?? Error('Owned cleanup query incomplete'),
        );
        cleanup.complete = false;
      }
      if (cleanup.complete) queryScope.complete();
      assertNativeCleanupComplete(cleanup, originalFailure, owned);
    }
  }
}

test('COM actual REST IPC native comments and explicit owned WEB fallback preserve useful source-bound pages', async () => {
  const caseStartedAtMono = performance.now();
  if (test.info().timeout !== 30000)
    throw Error('Unexpected owned native case timeout');
  const proof: any = await commentsNative(async () => {
    const f = (globalThis as any).MusicNativeProof,
      fs = require('node:fs'),
      http = require('node:http'),
      nodePath = require('node:path'),
      { createRequire } = require('node:module');
    const requireApp = createRequire(
        nodePath.join(f.projectRoot, 'package.json'),
      ),
      { Hono } = requireApp('hono'),
      { serve } = requireApp('@hono/node-server');
    const factsPath = process.env.PEAR_TEST_STARTUP_FACTS;
    if (!factsPath) throw Error('Missing F3 facts');
    fs.writeFileSync(factsPath + '.request', 'owned');
    const wait = async (check: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() >= deadline) throw Error('Missing owned COM witness');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await wait(
      () => fs.existsSync(factsPath) && !fs.existsSync(factsPath + '.request'),
    );
    const guardFacts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    if (
      guardFacts.pid !== process.pid ||
      guardFacts.visibleWindow ||
      fs.realpathSync(guardFacts.userData) !==
        fs.realpathSync(nodePath.join(f.owned, 'userData'))
    )
      throw Error('Unqualified hidden COM profile');
    const win = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
      },
    });
    await win.loadFile(nodePath.join(f.owned, 'main.html'));
    const evaluate = (code: string) => win.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(`
      document.body.insertAdjacentHTML('beforeend','<ytmusic-player-bar></ytmusic-player-bar><div id="movie_player"></div>');
      window.api=document.querySelector('#movie_player');window.nativeCalls=[];window.playerEvents={};window.legacy=new Map();
      api.getVideoData=()=>({video_id:'current0001'});api.getPlayerResponse=()=>({videoDetails:{videoId:'current0001'}});api.addEventListener=(name,fn)=>window.playerEvents[name]=fn;api.removeEventListener=name=>delete window.playerEvents[name];
      const tokenItem=token=>({continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token}}}});
      const header={commentsHeaderRenderer:{countText:{simpleText:'151 Kommentare'},sortMenu:{sortFilterSubMenuRenderer:{subMenuItems:[{title:'Beliebt',selected:true,serviceEndpoint:{continuationCommand:{token:'COM_NATIVE_TOP_PRIVATE'}}},{title:'Neueste zuerst',serviceEndpoint:{continuationCommand:{token:'COM_NATIVE_NEWEST_PRIVATE'}}}]}}}};
      const legacy=id=>({commentThreadRenderer:{comment:{commentRenderer:{commentId:id,authorText:{simpleText:'Autor'},contentText:{runs:[{text:'Grüezi 🌍\\nمرحبا'}]},publishedTimeText:{simpleText:'vor 2 Tagen'},voteCount:{simpleText:'12'},replyCount:2}}}});
      const page=items=>({onResponseReceivedEndpoints:[{reloadContinuationItemsCommand:{targetId:'comments-section',continuationItems:items}}]});
      const entity=()=>({...page([{commentThreadRenderer:{commentViewModel:{commentViewModel:{commentKey:'native-entity-key',commentId:'native-newest',pinnedText:{content:'Angeheftet'}}}}}]),frameworkUpdates:{entityBatchUpdate:{mutations:[{payload:{commentEntityPayload:{key:'native-entity-key',properties:{commentId:'native-newest',content:{content:'最新のコメント'},publishedTime:'jetzt'},author:{displayName:'作者',isVerified:true},toolbar:{likeCountNotliked:'7',replyCount:'0'}}}}]}}});
      const absent=()=>({contents:{singleColumnMusicWatchNextResultsRenderer:{tabbedRenderer:{watchNextTabbedResultsRenderer:{tabs:[{tabRenderer:{content:{musicQueueRenderer:{}}}},{tabRenderer:{endpoint:{browseEndpoint:{browseId:'MPLYknown',browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:'MUSIC_PAGE_TYPE_TRACK_LYRICS'}}}}}},{tabRenderer:{endpoint:{browseEndpoint:{browseId:'MPTRknown',browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:'MUSIC_PAGE_TYPE_TRACK_RELATED'}}}}}}]}}}}});
      const appNode=document.querySelector('ytmusic-app');appNode.networkManager={fetch:async function(url,data){window.nativeCalls.push({url,data,receiver:this===appNode.networkManager});if(data.videoId==='abcdefghijk')return{contents:{itemSectionRenderer:{sectionIdentifier:'comment-item-section',contents:[tokenItem('COM_NATIVE_START_PRIVATE')]}}};if(data.continuation==='COM_NATIVE_START_PRIVATE')return page([header,...Array.from({length:151},(_,i)=>legacy('native-'+i))]);if(data.continuation==='COM_NATIVE_NEWEST_PRIVATE')return entity();if(data.videoId==='bbbbbbbbbbb')return absent();if(data.videoId==='ccccccccccc')return {};
      if(data.videoId==='ddddddddddd')return{contents:{itemSectionRenderer:{sectionIdentifier:'comment-item-section',contents:[{messageRenderer:{text:{simpleText:'コメントを読み込めませんでした。'}}}]}}};
      if(data.videoId==='eeeeeeeeeee')return{contents:{itemSectionRenderer:{sectionIdentifier:'comment-item-section',contents:[tokenItem('COM_NATIVE_ERROR_START_PRIVATE')]}}};
      if(data.continuation==='COM_NATIVE_ERROR_START_PRIVATE')return page([legacy('native-before-error'),tokenItem('COM_NATIVE_ERROR_NEXT_PRIVATE')]);
      if(data.continuation==='COM_NATIVE_ERROR_NEXT_PRIVATE')return page([{messageRenderer:{text:{simpleText:'Ein Fehler ist aufgetreten.'}}}]);
      if(data.videoId==='fffffffffff')return{contents:{itemSectionRenderer:{sectionIdentifier:'comment-item-section',contents:[tokenItem('COM_NATIVE_EMPTY_START_PRIVATE')]}}};
      if(data.continuation==='COM_NATIVE_EMPTY_START_PRIVATE')return page([legacy('native-before-empty'),tokenItem('COM_NATIVE_EMPTY_NEXT_PRIVATE')]);
      if(data.continuation==='COM_NATIVE_EMPTY_NEXT_PRIVATE')return page([]);
      throw Error('Unexpected synthetic comments request')}};
      window.ipcRenderer={send(){},subscribe:(name,fn)=>{window.legacy.set(name,fn);return()=>window.legacy.delete(name)}};window.core=MusicNativeSource.initializeCore(api);window.controller=MusicNativeSource.createMusicRendererController(api,()=>api,window.musicProof);undefined;
    `);
    const tokenItem = (token: string) => ({
      continuationItemRenderer: {
        continuationEndpoint: { continuationCommand: { token } },
      },
    });
    const page = (items: any[]) => ({
      onResponseReceivedEndpoints: [
        {
          reloadContinuationItemsCommand: {
            targetId: 'comments-section',
            continuationItems: items,
          },
        },
      ],
    });
    const webCalls: any[] = [];
    let releaseFirst!: () => void;
    const provider = http.createServer((req: any, res: any) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw);
        webCalls.push({
          url: req.url,
          headers: {
            cookie: req.headers.cookie ?? null,
            authorization: req.headers.authorization ?? null,
          },
          body,
        });
        let result: any;
        if (body.videoId === 'bbbbbbbbbbb')
          result = {
            contents: {
              itemSectionRenderer: {
                sectionIdentifier: 'comment-item-section',
                contents: [tokenItem('COM_WEB_START_PRIVATE')],
              },
            },
          };
        else if (body.continuation === 'COM_WEB_START_PRIVATE')
          result = page([
            {
              commentsHeaderRenderer: {
                sortMenu: {
                  sortFilterSubMenuRenderer: {
                    subMenuItems: [
                      {
                        selected: true,
                        serviceEndpoint: {
                          continuationCommand: { token: 'COM_WEB_TOP_PRIVATE' },
                        },
                      },
                      {
                        serviceEndpoint: {
                          continuationCommand: {
                            token: 'COM_WEB_NEWEST_PRIVATE',
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ]);
        else if (body.continuation === 'COM_WEB_NEWEST_PRIVATE')
          result = {
            ...page([
              {
                commentThreadRenderer: {
                  commentViewModel: {
                    commentViewModel: {
                      commentKey: 'web-key',
                      commentId: 'web-newest',
                    },
                  },
                },
              },
              tokenItem('COM_WEB_NEXT_PRIVATE'),
            ]),
            frameworkUpdates: {
              entityBatchUpdate: {
                mutations: [
                  {
                    payload: {
                      commentEntityPayload: {
                        key: 'web-key',
                        properties: {
                          commentId: 'web-newest',
                          content: { content: 'Public WEB 最新' },
                        },
                        author: { displayName: 'WEB author' },
                      },
                    },
                  },
                ],
              },
            },
          };
        else if (body.continuation === 'COM_WEB_NEXT_PRIVATE')
          result = page([
            {
              commentThreadRenderer: {
                comment: {
                  commentRenderer: {
                    commentId: 'web-next',
                    contentText: { simpleText: 'Next public page' },
                  },
                },
              },
            },
          ]);
        else {
          res.writeHead(500);
          res.end('{}');
          return;
        }
        const send = () => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        };
        if (webCalls.length === 1) releaseFirst = send;
        else send();
      });
    });
    await new Promise<void>((yes) => provider.listen(0, '127.0.0.1', yes));
    const store = new f.source.MusicGrantStore(
      nodePath.join(f.owned, 'comments-grants'),
    );
    const config = {
      enabled: true,
      musicApiEnabled: true,
      hostname: '127.0.0.1',
      port: 26538,
      useHttps: false,
    };
    const service = f.source.createMusicService({
      window: win,
      config,
      grants: store,
      commentsWeb: f.source.createPublicCommentsWeb({
        testPort: provider.address().port,
      }),
    });
    const app = new Hono();
    const httpLifetime = new AbortController();
    const httpSockets = new WeakSet<object>();
    let httpOwner: any;
    f.source.registerMusicRoutes(
      app,
      () => service,
      () => httpOwner,
    );
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    server.on('connection', (socket: object) => httpSockets.add(socket));
    server.once('close', () => httpLifetime.abort());
    server.on('error', () => httpLifetime.abort());
    if (!server.listening)
      await new Promise<void>((yes) => server.once('listening', yes));
    const port = server.address().port;
    service.configure({ ...config, port });
    httpOwner = {
      identity: {},
      address: (server.address() as { address: string }).address,
      port,
      tls: false,
      resources: Object.freeze({ local: service.resource }),
      signal: httpLifetime.signal,
      current: () => true && !httpLifetime.signal.aborted && server.listening,
      ownsSocket: (socket: object) => httpSockets.has(socket),
    };
    let token = '';
    const choices = [8, 2, 0];
    const menu = await f.source.createMusicGrantMenu(
      {
        getConfig: () => ({ enabled: true, musicApiEnabled: true }),
        setConfig() {
          throw Error('Unexpected settings write');
        },
      },
      () => service,
      {
        prompt: async () => 'Native COM',
        show: async () => ({ response: choices.shift() }),
        copy: (value: string) => (token = value),
      },
    );
    await menu
      .find((item: any) => item.label === 'Create client grant…')
      .click();
    if (!token) throw Error('Native comments grant unavailable');
    const before = await evaluate('window.nativeCalls.length');
    if (before !== 0 || webCalls.length)
      throw Error('Background comments work');
    const get = (query: string) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music/song/comments?' + query,
            headers: { authorization: 'Bearer ' + token },
          },
          (res: any) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (raw += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: JSON.parse(raw) }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
    const first = await get('videoId=abcdefghijk&limit=100'),
      local = await get('cursor=' + first.body.nextCursor + '&limit=100'),
      newest = await get('videoId=abcdefghijk&sort=newest');
    const absent = await get('videoId=bbbbbbbbbbb');
    if (webCalls.length) throw Error('Implicit WEB fallback');
    const fallback = get(
      'videoId=bbbbbbbbbbb&sort=newest&allowPublicWebFallback=true',
    );
    await wait(() => !!releaseFirst);
    const broker = f.source.createMusicRequestBroker(win);
    const physicalDuringWeb = broker.stats();
    releaseFirst();
    const web = await fallback;
    const more = await get('cursor=' + web.body.nextCursor),
      malformed = await get('videoId=ccccccccccc&allowPublicWebFallback=true');
    const webCallsBeforeErrors = webCalls.length;
    const messageError = await get(
      'videoId=ddddddddddd&allowPublicWebFallback=true',
    );
    const cursorFirst = await get(
      'videoId=eeeeeeeeeee&allowPublicWebFallback=true',
    );
    const cursorError = await get('cursor=' + cursorFirst.body.nextCursor);
    const emptyFirst = await get(
      'videoId=fffffffffff&allowPublicWebFallback=true',
    );
    const emptyLast = await get('cursor=' + emptyFirst.body.nextCursor);
    const webCallsAfterErrors = webCalls.length;
    const nativeCalls = await evaluate('window.nativeCalls');
    const result = {
      mainPid: process.pid,
      guardFacts,
      before,
      first,
      local,
      newest,
      absent,
      web,
      more,
      malformed,
      messageError,
      cursorFirst,
      cursorError,
      emptyFirst,
      emptyLast,
      webCallsBeforeErrors,
      webCallsAfterErrors,
      nativeCalls,
      webCalls,
      physicalDuringWeb,
      physicalAfter: broker.stats(),
      grantScopes: (await store.list())[0].scopes,
    };
    service.stop();
    await evaluate(
      'window.controller.dispose();window.core.playlistQueue.dispose();window.core.repeatPreference.dispose();window.core.disposeMusicActionsOwner();undefined',
    );
    await new Promise<void>((yes) => server.close(() => yes()));
    provider.closeAllConnections();
    await new Promise<void>((yes) => provider.close(() => yes()));
    return result;
  }, caseStartedAtMono);
  if (process.env.PEAR_COM_PREPARE_ONLY === '1') {
    expect(proof.prepared).toBe(true);
    return;
  }
  expect(proof.before).toBe(0);
  expect(proof.grantScopes).toEqual(['comments.read']);
  expect(proof.first.status).toBe(200);
  expect(proof.first.body).toMatchObject({
    source: 'music',
    videoId: 'abcdefghijk',
    sort: 'top',
    available: true,
  });
  expect(proof.first.body.comments).toHaveLength(100);
  expect(proof.first.body.comments[0]).toEqual({
    id: 'native-0',
    author: 'Autor',
    text: 'Grüezi 🌍\nمرحبا',
    publishedTime: 'vor 2 Tagen',
    likeCount: '12',
    replyCount: '2',
    pinned: false,
    verified: false,
    creator: false,
  });
  expect(proof.local.status).toBe(200);
  expect(proof.local.body.comments).toHaveLength(51);
  expect(proof.local.body.comments[0].id).toBe('native-100');
  expect(proof.local.body.comments[50].id).toBe('native-150');
  expect(proof.local.body.nextCursor).toBeNull();
  expect(proof.newest.body.comments).toEqual([
    {
      id: 'native-newest',
      author: '作者',
      text: '最新のコメント',
      publishedTime: 'jetzt',
      likeCount: '7',
      replyCount: '0',
      pinned: true,
      verified: true,
      creator: false,
    },
  ]);
  expect(proof.newest.body.sort).toBe('newest');
  expect(proof.absent.body).toMatchObject({
    available: false,
    source: 'music',
    comments: [],
    nextCursor: null,
  });
  expect(proof.web.status).toBe(200);
  expect(proof.web.body).toMatchObject({
    source: 'public-web',
    sort: 'newest',
    comments: [{ id: 'web-newest', text: 'Public WEB 最新' }],
  });
  expect(proof.more.status).toBe(200);
  expect(proof.more.body).toMatchObject({
    source: 'public-web',
    sort: 'newest',
    comments: [{ id: 'web-next', text: 'Next public page' }],
    nextCursor: null,
  });
  expect(proof.malformed.status).toBe(502);
  for (const error of [proof.messageError, proof.cursorError]) {
    expect(error.status).toBe(502);
    expect(error.body.comments).toBeUndefined();
    expect(error.body.available).toBeUndefined();
  }
  expect(proof.cursorFirst.status).toBe(200);
  expect(proof.cursorFirst.body).toMatchObject({
    source: 'music',
    comments: [{ id: 'native-before-error' }],
  });
  expect(typeof proof.cursorFirst.body.nextCursor).toBe('string');
  expect(proof.emptyFirst.status).toBe(200);
  expect(proof.emptyFirst.body).toMatchObject({
    source: 'music',
    comments: [{ id: 'native-before-empty' }],
  });
  expect(typeof proof.emptyFirst.body.nextCursor).toBe('string');
  expect(proof.emptyLast.status).toBe(200);
  expect(proof.emptyLast.body).toMatchObject({
    source: 'music',
    available: true,
    comments: [],
    nextCursor: null,
  });
  expect(proof.webCallsBeforeErrors).toBe(4);
  expect(proof.webCallsAfterErrors).toBe(4);
  expect(proof.physicalDuringWeb).toEqual({ dispatched: 1, queued: 0 });
  expect(proof.physicalAfter).toEqual({ dispatched: 0, queued: 0 });
  expect(
    proof.nativeCalls.map((call: any) => ({ url: call.url, data: call.data })),
  ).toEqual([
    { url: '/next', data: { videoId: 'abcdefghijk' } },
    { url: '/next', data: { continuation: 'COM_NATIVE_START_PRIVATE' } },
    { url: '/next', data: { videoId: 'abcdefghijk' } },
    { url: '/next', data: { continuation: 'COM_NATIVE_START_PRIVATE' } },
    { url: '/next', data: { continuation: 'COM_NATIVE_NEWEST_PRIVATE' } },
    { url: '/next', data: { videoId: 'bbbbbbbbbbb' } },
    { url: '/next', data: { videoId: 'bbbbbbbbbbb' } },
    { url: '/next', data: { videoId: 'ccccccccccc' } },
    { url: '/next', data: { videoId: 'ddddddddddd' } },
    { url: '/next', data: { videoId: 'eeeeeeeeeee' } },
    { url: '/next', data: { continuation: 'COM_NATIVE_ERROR_START_PRIVATE' } },
    { url: '/next', data: { continuation: 'COM_NATIVE_ERROR_NEXT_PRIVATE' } },
    { url: '/next', data: { videoId: 'fffffffffff' } },
    { url: '/next', data: { continuation: 'COM_NATIVE_EMPTY_START_PRIVATE' } },
    { url: '/next', data: { continuation: 'COM_NATIVE_EMPTY_NEXT_PRIVATE' } },
  ]);
  expect(proof.nativeCalls.every((call: any) => call.receiver)).toBe(true);
  expect(proof.webCalls.map((call: any) => call.body)).toEqual([
    {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250925.01.00',
          hl: 'en',
        },
      },
      videoId: 'bbbbbbbbbbb',
    },
    {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250925.01.00',
          hl: 'en',
        },
      },
      continuation: 'COM_WEB_START_PRIVATE',
    },
    {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250925.01.00',
          hl: 'en',
        },
      },
      continuation: 'COM_WEB_NEWEST_PRIVATE',
    },
    {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250925.01.00',
          hl: 'en',
        },
      },
      continuation: 'COM_WEB_NEXT_PRIVATE',
    },
  ]);
  expect(
    proof.webCalls.every(
      (call: any) =>
        call.url === '/youtubei/v1/next?prettyPrint=false' &&
        call.headers.cookie === null &&
        call.headers.authorization === null,
    ),
  ).toBe(true);
  expect(
    JSON.stringify([
      proof.first,
      proof.local,
      proof.newest,
      proof.absent,
      proof.web,
      proof.more,
      proof.messageError,
      proof.cursorFirst,
      proof.cursorError,
      proof.emptyFirst,
      proof.emptyLast,
    ]),
  ).not.toMatch(/COM_(?:NATIVE|WEB)_[A-Z_]+_PRIVATE/);
  const timingReceipt = ownedNativeTimingReceipt(
    proof.ownedTiming,
    performance.now(),
  );
  process.stdout.write(
    'COM_OWNED_TIMING ' + JSON.stringify(timingReceipt) + '\n',
  );
  if (!timingReceipt.complete)
    throw Error('Owned native timing evidence incomplete');
});
