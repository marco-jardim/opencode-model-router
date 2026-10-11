// ---------------------------------------------------------------------------
// Timing recorder (critical-path 1.1.2): dispatch durations and orchestrator turn counters.
//
// Writes `timings.jsonl` (one DispatchTimingRow per finished or abandoned child dispatch) and `turns.jsonl` (one
// OrchestratorTurnRow per turn of a root session) through the side logs of persist.ts. It is independent of
// `routing.engine`: it needs no store, no flusher and no decision log, so it works with `static`.
// Counters and labels only: no prompt, output or tool text ever reaches a row.
// Every entry point is idempotent and never throws into the caller; each row is appended (awaited) before the
// method's promise resolves — there is no coalescing flush. Runnable under Node type stripping (see types.ts).
// ---------------------------------------------------------------------------

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

/** Plugin logger subset; `debug` is optional (only the missing-start notice uses it). */
export interface TimingLogger extends OutcomeLogger {
  debug?(message: string, extra?: Record<string, unknown>): void;
}

/** What is known when a child dispatch starts. */
export interface DispatchStartInput {
  readonly childSessionID: string;
  readonly parentSessionID: string;
  readonly callID: string;
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
  /** Outcomes directory; used to create the side logs when `sideLogs` is not given. */
  readonly dir: string;
  readonly now: Clock;
  readonly logger?: TimingLogger;
  /** Injected side logs (tests, or a shared instance); otherwise created from `dir`. */
  readonly sideLogs?: SideLogs;
}

export interface TimingRecorder {
  /** Opens the timing of a child dispatch. Again for a child whose timing is open: keeps the first start, refreshes its LRU position. */
  recordDispatchStart(input: DispatchStartInput): void;
  /**
   * Closes the open timing of `childSessionID` and appends its row (`durationMs = at − startedAt`, clamped to 0 on clock skew).
   * Ignored when `eventId` was seen, or when the timing is not open (closed already, evicted, never started: logged once at debug).
   */
  onExecutionOutcome(childSessionID: string, eventId: string, outcome: DispatchTimingOutcome, at: number): Promise<void>;
  /** Records the latest provider capacity class on an OPEN timing; the row carries it. Ignored once closed. */
  onCapacitySignal(childSessionID: string, capacity: DispatchCapacity, at: number): void;
  /** Declares `sessionID` a root (orchestrator) session: its steps are aggregated into turns. Idempotent. */
  markRootSession(sessionID: string): void;
  /** Turn boundary of a root session: appends the current turn's row if it has steps, then starts the next turn. */
  onRootPrompt(sessionID: string, at: number): Promise<void>;
  /** Adds one step to the current turn of a root session; any other session is ignored. */
  onRootStep(sessionID: string, tokens: RootStepTokens): void;
  /** Closes open starts older than {@link OPEN_START_TTL_MS} as `unknown` and appends every open turn. `at` defaults to now. */
  sweep(at?: number): Promise<void>;
}

interface OpenStart {
  readonly input: DispatchStartInput;
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

/**
 * Timing recorder over the side logs. Independent of `routing.engine`. Entry points are idempotent and never throw; a write
 * failure is logged once per kind (`timings`, `turns`, `internal`) and the row is dropped, never retried.
 */
export function createTimingRecorder(options: TimingRecorderOptions): TimingRecorder {
  const logger = options.logger ?? NOOP_LOGGER;
  const sideLogs = options.sideLogs ?? createSideLogs(options.dir, nodePersistDeps(logger));
  const clock = (): number => safeNow(options.now);
  const stamp = (at: number): number => (Number.isFinite(at) ? at : clock());

  /** Insertion order = recency: the first key is the least recently used. */
  const open = new Map<string, OpenStart>();
  const seenEvents = new Set<string>();
  const roots = new Map<string, RootTurn>();
  const warned = new Set<string>();
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

  function timingRow(entry: OpenStart, outcome: DispatchTimingOutcome, at: number): DispatchTimingRow {
    const { input } = entry;
    const endedAt = Math.max(at, entry.startedAt);
    return {
      kind: "dispatch-timing",
      v: SIDE_ROW_VERSION,
      ts: new Date(clock()).toISOString(),
      parentSessionID: input.parentSessionID,
      childSessionID: input.childSessionID,
      callID: input.callID,
      role: input.role,
      class: input.class,
      scope: input.scope,
      tier: input.tier,
      model: input.model,
      background: input.background,
      startedAt: entry.startedAt,
      endedAt,
      durationMs: endedAt - entry.startedAt,
      outcome,
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

  return {
    recordDispatchStart(input: DispatchStartInput): void {
      try {
        const existing = open.get(input.childSessionID);
        if (existing !== undefined) {
          open.delete(input.childSessionID); // idempotent: the first start stays, only the recency moves
          open.set(input.childSessionID, existing);
          return;
        }
        open.set(input.childSessionID, { input, startedAt: stamp(input.at), capacity: null });
        while (open.size > MAX_OPEN_STARTS) {
          const oldest = open.keys().next();
          if (oldest.done === true) break;
          open.delete(oldest.value); // evicted: no row
        }
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to record a dispatch start", error);
      }
    },

    async onExecutionOutcome(childSessionID: string, eventId: string, outcome: DispatchTimingOutcome, at: number): Promise<void> {
      try {
        // Same dedupe style as Ingest.onExecutionEnded: an event id is consumed by its first delivery.
        if (typeof eventId === "string" && eventId !== "" && !rememberOnce(seenEvents, eventId, MAX_SEEN_EVENT_IDS)) return;
        const entry = open.get(childSessionID);
        if (entry === undefined) {
          if (!noticedMissingStart) {
            noticedMissingStart = true;
            logger.debug?.("[router] execution outcome without an open dispatch start; no timing row", { childSessionID });
          }
          return;
        }
        open.delete(childSessionID); // closed before the append, so a concurrent outcome finds nothing
        await appendTimingRows([timingRow(entry, outcome, stamp(at))]);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to record an execution outcome", error);
      }
    },

    onCapacitySignal(childSessionID: string, capacity: DispatchCapacity, _at: number): void {
      try {
        const entry = open.get(childSessionID);
        if (entry !== undefined) entry.capacity = capacity;
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to record a capacity signal", error);
      }
    },

    markRootSession(sessionID: string): void {
      try {
        const existing = roots.get(sessionID);
        if (existing !== undefined) {
          roots.delete(sessionID);
          roots.set(sessionID, existing);
          return;
        }
        roots.set(sessionID, { turn: 1, steps: 0, input: 0, cacheRead: 0, cacheWrite: 0 });
        while (roots.size > MAX_ROOT_SESSIONS) {
          const oldest = roots.keys().next();
          if (oldest.done === true) break;
          roots.delete(oldest.value);
        }
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to mark a root session", error);
      }
    },

    async onRootPrompt(sessionID: string, _at: number): Promise<void> {
      try {
        const state = roots.get(sessionID);
        if (state === undefined) return;
        const row = takeTurn(sessionID, state);
        if (row !== null) await appendTurnRows([row]);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to close an orchestrator turn", error);
      }
    },

    onRootStep(sessionID: string, tokens: RootStepTokens): void {
      try {
        const state = roots.get(sessionID);
        if (state === undefined) return;
        state.steps += 1;
        state.input += counter(tokens.input);
        state.cacheRead += counter(tokens.cacheRead);
        state.cacheWrite += counter(tokens.cacheWrite);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder failed to add a root step", error);
      }
    },

    async sweep(at?: number): Promise<void> {
      try {
        const t = at === undefined ? clock() : stamp(at);
        const stale: DispatchTimingRow[] = [];
        for (const [childSessionID, entry] of [...open]) {
          if (t - entry.startedAt <= OPEN_START_TTL_MS) continue;
          open.delete(childSessionID);
          stale.push(timingRow(entry, "unknown", t));
        }
        const turns: OrchestratorTurnRow[] = [];
        for (const [sessionID, state] of roots) {
          const row = takeTurn(sessionID, state);
          if (row !== null) turns.push(row);
        }
        await appendTimingRows(stale);
        await appendTurnRows(turns);
      } catch (error) {
        warnOnce("internal", "[router] timing recorder sweep failed", error);
      }
    },
  };
}
