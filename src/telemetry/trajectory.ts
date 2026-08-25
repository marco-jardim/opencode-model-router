// ---------------------------------------------------------------------------
// Trajectory scorecard — pure module, no fs/network/SDK/process.env
// ---------------------------------------------------------------------------

import { DEFAULT_IDLE_TTL_MS } from "../router/idle-sweep";

export interface TrajectoryToolEvent {
  tool: string;
  readOnly: boolean;
  producing?: boolean;
  blocked?: boolean;
  selfScript?: boolean;
  deliverable?: boolean;
  ok?: boolean;
  redundant?: boolean;
}

export interface TrajectoryState {
  sessionID: string;
  tier: string | null;
  toolCallCount: number;
  readCount: number;
  execCount: number;
  selfScriptCount: number;
  redundantCount: number;
  blockedCount: number;
  deliverableExecuted: boolean;
  ttfa: number | null;
  stopReason: string | null;
  // Layer 2/3 scaffolding fields (populated in later waves)
  dodSource: "explicit" | "inferred" | "annotation" | null;
  verdict: "PASS" | "FAIL" | "SKIPPED" | null;
  verifyMethod: "deterministic" | "checker" | "none" | null;
  graderTier: string | null;
  attempts: number;
  escalations: number;
  finalTier: string | null;
  costUnits: number;
  /** Dispatch rounds seen for this session (1 on first dispatch). */
  dispatches: number;
}

export function createTrajectory(
  sessionID: string,
  tier?: string | null,
): TrajectoryState {
  return {
    sessionID,
    tier: tier ?? null,
    toolCallCount: 0,
    readCount: 0,
    execCount: 0,
    selfScriptCount: 0,
    redundantCount: 0,
    blockedCount: 0,
    deliverableExecuted: false,
    ttfa: null,
    stopReason: null,
    dodSource: null,
    verdict: null,
    verifyMethod: null,
    graderTier: null,
    attempts: 0,
    escalations: 0,
    finalTier: null,
    costUnits: 0,
    dispatches: 1,
  };
}

export function recordToolEvent(
  state: TrajectoryState,
  event: TrajectoryToolEvent,
): void {
  state.toolCallCount += 1;

  if (event.blocked) {
    state.blockedCount += 1;
  }

  if (event.selfScript) {
    state.selfScriptCount += 1;
  }

  if (event.redundant) {
    state.redundantCount += 1;
  }

  const producing = event.producing ?? !event.readOnly;

  if (event.readOnly) {
    state.readCount += 1;
  }

  if (producing) {
    state.execCount += 1;
    if (state.ttfa === null) {
      state.ttfa = state.toolCallCount;
    }
  }

  if (event.deliverable) {
    state.deliverableExecuted = true;
  }
}

export function setStopReason(state: TrajectoryState, reason: string): void {
  if (state.stopReason === null) {
    state.stopReason = reason;
  }
}

export function trajectoryMetrics(
  state: TrajectoryState,
): Record<string, unknown> {
  const readExecRatio =
    state.execCount === 0
      ? state.readCount
      : state.readCount / state.execCount;

  return {
    ttfa: state.ttfa,
    read_exec_ratio: readExecRatio,
    self_script_count: state.selfScriptCount,
    deliverable_executed: state.deliverableExecuted,
    tool_call_count: state.toolCallCount,
    stop_reason: state.stopReason,
    dod_source: state.dodSource,
    verdict: state.verdict,
    verify_method: state.verifyMethod,
    grader_tier: state.graderTier,
    attempts: state.attempts,
    escalations: state.escalations,
    final_tier: state.finalTier,
    cost_units: state.costUnits,
    dispatches: state.dispatches,
  };
}

export function dumpTrajectory(state: TrajectoryState): string {
  return `[trajectory ${state.sessionID}] ${JSON.stringify(trajectoryMetrics(state))}`;
}

// ---------------------------------------------------------------------------
// Per-instance store factory — mirrors src/router/sessions.ts pattern
// ---------------------------------------------------------------------------

export interface TrajectoryStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export function createTrajectoryStore(options: TrajectoryStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const store = new Map<string, TrajectoryState>();
  const lastTouch = new Map<string, number>();

  function touch(sessionID: string): void {
    lastTouch.set(sessionID, now());
  }

  function evictState(sessionID: string): void {
    store.delete(sessionID);
    lastTouch.delete(sessionID);
  }

  function ensureState(sessionID: string, tier?: string | null): TrajectoryState {
    touch(sessionID);
    let s = store.get(sessionID);
    if (!s) {
      s = createTrajectory(sessionID, tier);
      store.set(sessionID, s);
    }
    return s;
  }

  return {
    ensure(sessionID: string, tier?: string | null): TrajectoryState {
      return ensureState(sessionID, tier);
    },

    get(sessionID: string): TrajectoryState | undefined {
      return store.get(sessionID);
    },

    recordToolEvent(sessionID: string, event: TrajectoryToolEvent): void {
      const s = ensureState(sessionID);
      recordToolEvent(s, event);
    },

    /**
     * Record a resumed dispatch into an existing session. Creates state when
     * absent so a resume that outlived an idle-TTL sweep still reports a
     * dispatch count rather than throwing.
     */
    recordResume(sessionID: string, tier?: string | null): void {
      const s = ensureState(sessionID, tier);
      s.dispatches += 1;
      touch(sessionID);
    },

    setStopReason(sessionID: string, reason: string): void {
      touch(sessionID);
      const s = store.get(sessionID);
      if (!s) return;
      setStopReason(s, reason);
    },

    dump(sessionID: string): string | null {
      const s = store.get(sessionID);
      if (!s) return null;
      return dumpTrajectory(s);
    },

    /** Drop a session's trajectory state. */
    evict(sessionID: string): void {
      evictState(sessionID);
    },

    /** Evict every session idle for >= ttlMs. Future stamps are never evicted. */
    sweep(nowMs: number = now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): void {
      for (const [sessionID, stamp] of [...lastTouch.entries()]) {
        if (nowMs - stamp >= ttlMs) evictState(sessionID);
      }
    },
  };
}
