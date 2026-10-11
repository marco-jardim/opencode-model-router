// ---------------------------------------------------------------------------
// Timing recorder (critical-path 1.1.2): dispatch durations and orchestrator turn counters.
//
// Writes `timings.jsonl` (one DispatchTimingRow per finished or abandoned child dispatch) and `turns.jsonl` (one
// OrchestratorTurnRow per turn of a root session) through the side logs of persist.ts. It is independent of
// `routing.engine`: it needs no store, no flusher and no decision log, so it works with `static`.
// Counters and labels only: no prompt, output or tool text ever reaches a row.
// Every entry point is idempotent and never throws into the caller; each row is appended (awaited) before the
// method's promise resolves — there is no coalescing flush. Runnable under Node type stripping (see types.ts).
//
// Keys: an open dispatch is keyed by its `callID` (known when the dispatch starts); the child session id is bound to it
// later (`bindChild`) and the host's end events find the dispatch through it (QA-1.1-1).
// One recorder per outcomes directory and process: `acquireTimingRecorder` (QA-1.1-3).
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { createSideLogs, nodePersistDeps } from "./persist";
import type {
  Clock,
  DispatchCapacity,
  DispatchTimingOutcome,
  DispatchTimingRow,
  OrchestratorTurnRow,
  OutcomeLogger,
  SideLogs,
  WriteResult,
} from "./types";
import { SIDE_ROW_VERSION, safeNow } from "./types";

/** Open dispatch starts kept; past this the least recently used one is evicted (no row). */
export const MAX_OPEN_STARTS = 1000;
/** A start still open after this long is closed as `unknown` by {@link TimingRecorder.sweep}. */
export const OPEN_START_TTL_MS = 6 * 60 * 60 * 1000;
/** Event ids remembered for dedupe (LRU). */
export const MAX_SEEN_EVENT_IDS = 5000;
/** Root sessions tracked for turn aggregation (LRU). */
export const MAX_ROOT_SESSIONS = 1000;
/** A turn with no step for this long is flushed by {@link TimingRecorder.sweep}; a turn still receiving steps is left open. */
export const DEFAULT_TURN_IDLE_MS = 30 * 60 * 1000;
/** A row whose `endedAt` is later than `now` by more than this is ignored by the estimator (clock-jump guard). */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Plugin logger subset; `debug` is optional (only the missing-start notice uses it). */
export interface TimingLogger extends OutcomeLogger {
  debug?(message: string, extra?: Record<string, unknown>): void;
}

/** What is known when a child dispatch starts. */
export interface DispatchStartInput {
  /** Identifies the dispatch from the moment it starts (the host tool call). */
  readonly callID: string;
  /** The child session when already known, else `null` and {@link TimingRecorder.bindChild} supplies it later. */
  readonly childSessionID: string | null;
  readonly parentSessionID: string;
  readonly role: string;
  readonly class: string;
  readonly scope: string;
  readonly tier: string;
  readonly model: string;
  readonly background: boolean;
  /** Epoch ms the dispatch started. */
  readonly at: number;
}

/** Token counters of one root-session step. */
export interface RootStepTokens {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface TimingRecorderOptions {
  /** Outcomes directory; used to create the side logs when `sideLogs` is not given, and as the dedupe namespace. */
  readonly dir: string;
  readonly now: Clock;
  readonly logger?: TimingLogger;
  /** Injected side logs (tests, or a shared instance); otherwise created from `dir`. */
  readonly sideLogs?: SideLogs;
  /** A turn idle for at least this long is flushed by `sweep` (default {@link DEFAULT_TURN_IDLE_MS}). */
  readonly turnIdleMs?: number;
  /** Called after each row was appended (only when the side logs are created here). */
  readonly onRow?: (row: DispatchTimingRow | OrchestratorTurnRow) => void;
}

export interface TimingRecorder {
  /**
   * Opens the timing of a dispatch, keyed by `callID`. Again for an open `callID`: no-op (refreshes its LRU position). A start
   * for a child whose timing is open under ANOTHER callID closes that older timing as `unknown` at the new `at` first.
   */
  recordDispatchStart(input: DispatchStartInput): void;
  /** Tells which child session runs the open `callID`. Re-callable (the last child wins). Unknown `callID`: ignored. */
  bindChild(callID: string, childSessionID: string): void;
  /** Drops the open timing of `callID` without a row: the call was rejected, no dispatch happened. */
  cancelStart(callID: string): void;
  /** Sets the background flag of an open `callID` (known only after the host acknowledged the call). */
  setBackground(callID: string, background: boolean): void;
  /**
   * Closes the open timing of `childSessionID` and appends its row (`durationMs = at − startedAt`; an end before the start is
   * clamped to 0 and written as `unknown`). Ignored when the child has no open timing (closed already, evicted, never
   * started: logged once at debug); an event id is consumed only when a timing was open, and a seen id is ignored.
   */
  onExecutionOutcome(childSessionID: string, eventId: string, outcome: DispatchTimingOutcome, at: number): Promise<void>;
  /** Records the latest provider capacity class on the OPEN timing of `childSessionID`; the row carries it. Ignored once closed. */
  onCapacitySignal(childSessionID: string, capacity: DispatchCapacity, at: number): void;
  /** Declares `sessionID` a root (orchestrator) session: its steps are aggregated into turns. Idempotent; refreshes its recency. */
  markRootSession(sessionID: string): void;
  /** True when `sessionID` is a tracked root session. */
  isRootSession(sessionID: string): boolean;
  /**
   * Turn boundary of a root session: appends the current turn's row if it has steps, then starts the next turn. `turn` counts
   * per process (a restart numbers from 1 again). A seen `eventId` is ignored.
   */
  onRootPrompt(sessionID: string, at: number, eventId?: string): Promise<void>;
  /**
   * Adds one step to the current turn of a root session; any other session is ignored. A seen `eventId` is ignored.
   * Returns whether the step was counted.
   */
  onRootStep(sessionID: string, tokens: RootStepTokens, eventId?: string): boolean;
  /**
   * Housekeeping: closes open starts older than {@link OPEN_START_TTL_MS} as `unknown` and appends the turns idle for at least
   * `turnIdleMs` (a turn still receiving steps stays open). `at` defaults to now. A forward clock jump of more than 6 hours
   * (a suspended machine) therefore closes every running dispatch as `unknown`, which no estimate uses.
   */
  sweep(at?: number): Promise<void>;
  /** Shutdown: appends every open turn whatever its idle time and waits for pending writes. Open starts get no row. */
  flush(): Promise<void>;
  /** Same as {@link flush}. */
  dispose(): Promise<void>;
}

interface OpenStart {
  readonly input: DispatchStartInput;
  child: string | null;
  background: boolean;
  readonly startedAt: number;
  capacity: DispatchCapacity | null;
}

interface RootTurn {
  /** Index the next appended row carries (1-based). */
  turn: number;
  steps: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Epoch ms of the latest step (or of the turn's creation); `sweep` flushes the turn once it is old enough. */
  lastStepAt: number;
}

const NOOP_LOGGER: TimingLogger = { warn: () => undefined };

function counter(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Remembers `key` (most recent last); true when it was not remembered yet. Past `cap` the oldest is forgotten. */
function rememberOnce(seen: Set<string>, key: string, cap: number): boolean {
  if (seen.has(key)) {
    seen.delete(key);
    seen.add(key);
    return false;
  }
  seen.add(key);
  if (seen.size > cap) {
    const oldest = seen.values().next();
    if (oldest.done !== true) seen.delete(oldest.value);
  }
  return true;
}

/** True for a non-empty event id (an absent or empty id cannot be deduplicated). */
function hasId(id: string | undefined): id is string {
  return typeof id === "string" && id !== "";
}

/**
 * Capacity class of a provider error (ADR 0007 D6/D13). `type` decides, the body never does:
 * `provider.rate-limit` → rate-limit; `provider.internal` with status 529 → overload; `provider.quota` → usage-limit;
 * any other type is classified by status: 429 → rate-limit, 529 → overload; anything else → `null`.
 */
export function classifyCapacity(error: { readonly type?: string | null; readonly status?: number | null }): DispatchCapacity | null {
  const { type, status } = error;
  if (type === "provider.rate-limit") return "rate-limit";
  if (type === "provider.quota") return "usage-limit";
  if (type === "provider.internal" && status === 529) return "overload";
  if (status === 429) return "rate-limit";
  if (status === 529) return "overload";
  return null;
}

/**
 * Timing recorder over the side logs. Independent of `routing.engine`. Entry points are idempotent and never throw; a write
 * failure is logged once per kind (`timings`, `turns`, `internal`) and the row is dropped, never retried.
 */
export function createTimingRecorder(options: TimingRecorderOptions): TimingRecorder {
  const logger = options.logger ?? NOOP_LOGGER;
  const sideLogs =
    options.sideLogs ?? createSideLogs(options.dir, nodePersistDeps(logger), options.onRow === undefined ? {} : { onRow: options.onRow });
  const clock = (): number => safeNow(options.now);
  const stamp = (at: number): number => (Number.isFinite(at) && at >= 0 ? at : clock());
  const turnIdleMs = options.turnIdleMs !== undefined && Number.isFinite(options.turnIdleMs) && options.turnIdleMs >= 0 ? options.turnIdleMs : DEFAULT_TURN_IDLE_MS;
  const namespace = options.dir;

  /** Insertion order = recency: the first key is the least recently used. Keyed by callID. */
  const open = new Map<string, OpenStart>();
  /** child session → callID of its open timing. */
  const childIndex = new Map<string, string>();
  const seenEvents = new Set<string>();
  const roots = new Map<string, RootTurn>();
  const warned = new Set<string>();
  const pending = new Set<Promise<void>>();
  let noticedMissingStart = false;

  function warnOnce(kind: string, message: string, error?: unknown): void {
    if (warned.has(kind)) return;
    warned.add(kind);
    try {
      logger.warn(message, { kind, ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) });
    } catch {
      warned.add(`${kind}:logger`); // a failing logger must not reach the caller; nothing else to do
    }
  }

  function checkWrite(kind: "timings" | "turns", result: WriteResult): void {
    if (!result.ok) warnOnce(kind, `[router] ${kind} side log write failed; the rows were dropped`, result.error);
  }

  /** Runs a write that nobody awaits; `flush` waits for it. */
  function track(work: Promise<void>): void {
    const done: Promise<void> = work.then(
      () => undefined,
      (error: unknown) => warnOnce("internal", "[router] timing recorder background write failed", error),
    );
    pending.add(done);
    void done.then(() => {
      pending.delete(done);
    });
  }

  function removeOpen(callID: string, entry: OpenStart): void {
    open.delete(callID);
    if (entry.child !== null && childIndex.get(entry.child) === callID) childIndex.delete(entry.child);
  }

  /** The row of a closed timing; null when the dispatch never got a child session (nothing to attribute the row to). */
  function timingRow(entry: OpenStart, outcome: DispatchTimingOutcome, at: number): DispatchTimingRow | null {
    if (entry.child === null) return null;
    const { input } = entry;
    // QA-1.1-9: an end before the start means the clock moved; the duration is clamped and the row is `unknown` (no estimate uses it).
    const clamped = at < entry.startedAt;
    const endedAt = Math.max(at, entry.startedAt);
    return {
      kind: "dispatch-timing",
      v: SIDE_ROW_VERSION,
      ts: new Date(clock()).toISOString(),
      parentSessionID: input.parentSessionID,
      childSessionID: entry.child,
      callID: input.callID,
      role: input.role,
      class: input.class,
      scope: input.scope,
      tier: input.tier,
      model: input.model,
      background: entry.background,
      startedAt: entry.startedAt,
      endedAt,
      durationMs: endedAt - entry.startedAt,
      outcome: clamped ? "unknown" : outcome,
      capacity: entry.capacity,
    };
  }

  function turnRow(sessionID: string, state: RootTurn): OrchestratorTurnRow {
    return {
      kind: "orchestrator-turn",
      v: SIDE_ROW_VERSION,
      ts: new Date(clock()).toISOString(),
      sessionID,
      turn: state.turn,
      steps: state.steps,
      input: state.input,
      cacheRead: state.cacheRead,
      cacheWrite: state.cacheWrite,
    };
  }

  /** Takes the finished turn out of `state` (so a step arriving during the append counts for the next one); null without steps. */
  function takeTurn(sessionID: string, state: RootTurn): OrchestratorTurnRow | null {
    if (state.steps === 0) return null;
    const row = turnRow(sessionID, state);
    state.turn += 1;
    state.steps = 0;
    state.input = 0;
    state.cacheRead = 0;
    state.cacheWrite = 0;
    return row;
  }

  async function appendTimingRows(rows: readonly DispatchTimingRow[]): Promise<void> {
    if (rows.length > 0) checkWrite("timings", await sideLogs.appendTimings(rows));
  }

  async function appendTurnRows(rows: readonly OrchestratorTurnRow[]): Promise<void> {
    if (rows.length > 0) checkWrite("turns", await sideLogs.appendTurns(rows));
  }

  function touchRoot(sessionID: string, state: RootTurn): void {
    roots.delete(sessionID);
    roots.set(sessionID, state);
  }

  async function flushTurns(idleOnly: boolean, t: number): Promise<void> {
    const turns: OrchestratorTurnRow[] = [];
    for (const [sessionID, state] of roots) {
      if (idleOnly && t - state.lastStepAt < turnIdleMs) continue;
      const row = takeTurn(sessionID, state);
      if (row !== null) turns.push(row);
    }
    await appendTurnRows(turns);
  }

  async function waitPending(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  async function flush(): Promise<void> {
    try {
      await waitPending();
      await flushTurns(false, clock());
      await waitPending();
    } catch (error) {
      warnOnce("internal", "[router] timing recorder flush failed", error);
    }
  }

  return {
    recordDispatchStart(input: DispatchStartInput): void {
      try {
        const existing = open.get(input.callID);
        if (existing !== undefined) {
          open.delete(input.callID); // idempotent: the first start stays, only the recency moves
          open.set(input.callID, existing);
          return;
        }
        const startedAt = stamp(input.at);
        if (input.childSessionID !== null) {
          // QA-1.1-2: the child runs another dispatch already: that one ended without an outcome event of its own.
          const olderCall = childIndex.get(input.childSessionID);
          const older = olderCall === undefined ? undefined : open.get(olderCall);
          if (olderCall !== undefined && older !== undefined) {
            removeOpen(olderCall, older);
            const row = timingRow(older, "unknown", startedAt);
            if (row !== null) track(appendTimingRows([row]));
          }
        }
        open.set(input.callID, { input, child: input.childSessionID, background: input.background, startedAt, capacity: null });
        if (input.childSessionID !== null) childIndex.set(input.childSessionID, input.callID);
        while (open.size > MAX_OPEN_STARTS) {
          const oldest = open.entries().next();
          if (oldest.done === true) break;
          removeOpen(oldest.value[0], oldest.value[1]); // evicted: no row
        }
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to record a dispatch start", error);
      }
    },

    bindChild(callID: string, childSessionID: string): void {
      try {
        const entry = open.get(callID);
        if (entry === undefined || typeof childSessionID !== "string" || childSessionID === "") return;
        if (entry.child !== null && childIndex.get(entry.child) === callID) childIndex.delete(entry.child);
        entry.child = childSessionID; // the last call wins
        childIndex.set(childSessionID, callID);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to bind a child session", error);
      }
    },

    cancelStart(callID: string): void {
      try {
        const entry = open.get(callID);
        if (entry !== undefined) removeOpen(callID, entry);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to cancel a dispatch start", error);
      }
    },

    setBackground(callID: string, background: boolean): void {
      try {
        const entry = open.get(callID);
        if (entry !== undefined) entry.background = background === true;
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to set the background flag", error);
      }
    },

    async onExecutionOutcome(childSessionID: string, eventId: string, outcome: DispatchTimingOutcome, at: number): Promise<void> {
      try {
        const callID = childIndex.get(childSessionID);
        const entry = callID === undefined ? undefined : open.get(callID);
        if (callID === undefined || entry === undefined) {
          // QA-1.1-3: an end id is consumed only by a delivery that found a start, so it cannot be spent on an unknown child.
          if (!noticedMissingStart) {
            noticedMissingStart = true;
            logger.debug?.("[router] execution outcome without an open dispatch start; no timing row", { childSessionID });
          }
          return;
        }
        // Same dedupe style as Ingest.onExecutionEnded: an event id is consumed by its first delivery.
        if (hasId(eventId) && !rememberOnce(seenEvents, `${namespace}|end|${eventId}`, MAX_SEEN_EVENT_IDS)) return;
        removeOpen(callID, entry); // closed before the append, so a concurrent outcome finds nothing
        const row = timingRow(entry, outcome, stamp(at));
        if (row !== null) await appendTimingRows([row]);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to record an execution outcome", error);
      }
    },

    onCapacitySignal(childSessionID: string, capacity: DispatchCapacity, _at: number): void {
      try {
        const callID = childIndex.get(childSessionID);
        const entry = callID === undefined ? undefined : open.get(callID);
        if (entry !== undefined) entry.capacity = capacity;
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to record a capacity signal", error);
      }
    },

    markRootSession(sessionID: string): void {
      try {
        const existing = roots.get(sessionID);
        if (existing !== undefined) {
          touchRoot(sessionID, existing);
          return;
        }
        roots.set(sessionID, { turn: 1, steps: 0, input: 0, cacheRead: 0, cacheWrite: 0, lastStepAt: clock() });
        while (roots.size > MAX_ROOT_SESSIONS) {
          const oldest = roots.entries().next();
          if (oldest.done === true) break;
          const [evictedID, evicted] = oldest.value;
          roots.delete(evictedID);
          const row = takeTurn(evictedID, evicted); // a turn in progress is not lost with its session
          if (row !== null) track(appendTurnRows([row]));
        }
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to mark a root session", error);
      }
    },

    isRootSession(sessionID: string): boolean {
      return roots.has(sessionID);
    },

    async onRootPrompt(sessionID: string, _at: number, eventId?: string): Promise<void> {
      try {
        const state = roots.get(sessionID);
        if (state === undefined) return;
        if (hasId(eventId) && !rememberOnce(seenEvents, `${namespace}|prompt|${eventId}`, MAX_SEEN_EVENT_IDS)) return;
        touchRoot(sessionID, state);
        state.lastStepAt = clock();
        const row = takeTurn(sessionID, state);
        if (row !== null) await appendTurnRows([row]);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to close an orchestrator turn", error);
      }
    },

    onRootStep(sessionID: string, tokens: RootStepTokens, eventId?: string): boolean {
      try {
        const state = roots.get(sessionID);
        if (state === undefined) return false;
        if (hasId(eventId) && !rememberOnce(seenEvents, `${namespace}|step|${eventId}`, MAX_SEEN_EVENT_IDS)) return false;
        touchRoot(sessionID, state);
        state.lastStepAt = clock();
        state.steps += 1;
        state.input += counter(tokens.input);
        state.cacheRead += counter(tokens.cacheRead);
        state.cacheWrite += counter(tokens.cacheWrite);
        return true;
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to add a root step", error);
        return false;
      }
    },

    async sweep(at?: number): Promise<void> {
      try {
        const t = at === undefined ? clock() : stamp(at);
        const stale: DispatchTimingRow[] = [];
        for (const [callID, entry] of [...open]) {
          if (t - entry.startedAt <= OPEN_START_TTL_MS) continue;
          removeOpen(callID, entry);
          const row = timingRow(entry, "unknown", t);
          if (row !== null) stale.push(row);
        }
        await appendTimingRows(stale);
        await flushTurns(true, t);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder sweep failed", error);
      }
    },

    flush,
    dispose: flush,
  };
}

// ---------------------------------------------------------------------------
// Process-wide registry (QA-1.1-3): one recorder per outcomes directory
// ---------------------------------------------------------------------------

export interface AcquireTimingRecorderOptions {
  readonly dir: string;
  readonly now: Clock;
  readonly logger?: TimingLogger;
  /** Injected side logs (tests); applies to the first acquirer of the directory only. */
  readonly sideLogs?: SideLogs;
  readonly turnIdleMs?: number;
  /** Observer of this holder: called after each row of the shared recorder was appended, until {@link TimingRecorderHolder.release}. */
  readonly onRow?: (row: DispatchTimingRow | OrchestratorTurnRow) => void;
}

/** A holder of the shared recorder of a directory; `release()` once. */
export interface TimingRecorderHolder extends TimingRecorder {
  /** Gives up this holder; the last release of the directory flushes the recorder and removes it from the registry. */
  release(): Promise<void>;
}

interface RegistryEntry {
  readonly recorder: TimingRecorder;
  readonly observers: Set<(row: DispatchTimingRow | OrchestratorTurnRow) => void>;
  refs: number;
}

const registry = new Map<string, RegistryEntry>();

function registryId(dir: string): string {
  const abs = resolve(dir);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * The process-wide recorder for `options.dir` (case-insensitive on win32): two plugin instances of one host process share
 * its open starts, root turns and event-id dedupe, so an event delivered to both is counted once. The first acquirer
 * creates it (its `now`, `logger`, `sideLogs` and `turnIdleMs` apply); each holder `release()`s once.
 */
export function acquireTimingRecorder(options: AcquireTimingRecorderOptions): TimingRecorderHolder {
  const id = registryId(options.dir);
  let entry = registry.get(id);
  if (entry === undefined) {
    const observers = new Set<(row: DispatchTimingRow | OrchestratorTurnRow) => void>();
    const logger = options.logger ?? NOOP_LOGGER;
    const recorder = createTimingRecorder({
      dir: options.dir,
      now: options.now,
      logger,
      ...(options.sideLogs === undefined ? {} : { sideLogs: options.sideLogs }),
      ...(options.turnIdleMs === undefined ? {} : { turnIdleMs: options.turnIdleMs }),
      onRow: (row) => {
        for (const observer of [...observers]) {
          try {
            observer(row);
          } catch (error) {
            logger.warn("[router] timing row observer failed", { error: error instanceof Error ? error.message : String(error) });
          }
        }
      },
    });
    entry = { recorder, observers, refs: 0 };
    registry.set(id, entry);
  }
  const shared = entry;
  shared.refs += 1;
  const observer = options.onRow;
  if (observer !== undefined) shared.observers.add(observer);
  let released = false;
  // When side logs are injected the recorder does not install `onRow` (the injected logs own their observer): a holder's observer then never fires.
  return {
    recordDispatchStart: (input) => shared.recorder.recordDispatchStart(input),
    bindChild: (callID, childSessionID) => shared.recorder.bindChild(callID, childSessionID),
    cancelStart: (callID) => shared.recorder.cancelStart(callID),
    setBackground: (callID, background) => shared.recorder.setBackground(callID, background),
    onExecutionOutcome: (childSessionID, eventId, outcome, at) => shared.recorder.onExecutionOutcome(childSessionID, eventId, outcome, at),
    onCapacitySignal: (childSessionID, capacity, at) => shared.recorder.onCapacitySignal(childSessionID, capacity, at),
    markRootSession: (sessionID) => shared.recorder.markRootSession(sessionID),
    isRootSession: (sessionID) => shared.recorder.isRootSession(sessionID),
    onRootPrompt: (sessionID, at, eventId) => shared.recorder.onRootPrompt(sessionID, at, eventId),
    onRootStep: (sessionID, tokens, eventId) => shared.recorder.onRootStep(sessionID, tokens, eventId),
    sweep: (at) => shared.recorder.sweep(at),
    flush: () => shared.recorder.flush(),
    dispose: () => shared.recorder.flush(),
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (observer !== undefined) shared.observers.delete(observer);
      shared.refs -= 1;
      if (shared.refs > 0) return;
      if (registry.get(id) === shared) registry.delete(id);
      await shared.recorder.flush();
    },
  };
}
