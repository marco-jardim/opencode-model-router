import { newGuardState } from "./guards";
import type { GuardState, GuardPolicy } from "./guards";
import { DEFAULT_IDLE_TTL_MS } from "../router/idle-sweep";

export interface GuardStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Per-plugin-instance store of guard state, keyed by sessionID. Mirrors the
 * pattern of createSessionStore/createTrajectoryStore: no module-level
 * singletons, so concurrent subagent sessions never share mutable state (M7).
 * Also holds a per-session "pending note" used by advisory mode to defer a
 * banner from the before-hook to the after-hook (where output is mutable).
 *
 * Idle-TTL: every mutating entry point refreshes a per-session lastTouch stamp;
 * `sweep()` evicts sessions idle for at least ttlMs. No timers.
 */
export function createGuardStore(options: GuardStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const states = new Map<string, GuardState>();
  const pendingNotes = new Map<string, string>();
  const lastTouch = new Map<string, number>();

  function touch(sessionID: string): void {
    lastTouch.set(sessionID, now());
  }

  function evict(sessionID: string): void {
    states.delete(sessionID);
    pendingNotes.delete(sessionID);
    lastTouch.delete(sessionID);
  }

  return {
    ensure(sessionID: string, policy: GuardPolicy): GuardState {
      touch(sessionID);
      let s = states.get(sessionID);
      if (!s) {
        s = newGuardState(policy);
        states.set(sessionID, s);
      }
      return s;
    },
    get(sessionID: string): GuardState | undefined {
      return states.get(sessionID);
    },
    setPendingNote(sessionID: string, note: string): void {
      touch(sessionID);
      pendingNotes.set(sessionID, note);
    },
    takePendingNote(sessionID: string): string | undefined {
      touch(sessionID);
      const n = pendingNotes.get(sessionID);
      if (n !== undefined) pendingNotes.delete(sessionID);
      return n;
    },
    /**
     * Start a new dispatch round for an existing session: reset the
     * per-dispatch tool-call count while preserving cumulative totals,
     * redundancy fingerprints and deliverable state. No-op for sessions
     * that were never guarded (nothing to reset).
     */
    beginDispatch(sessionID: string): void {
      const s = states.get(sessionID);
      if (!s) return;
      s.toolCallCount = 0;
      s.dispatches += 1;
      touch(sessionID);
    },
    clear(sessionID: string): void {
      evict(sessionID);
    },
    /** Evict every session idle for >= ttlMs. Future stamps are never evicted. */
    sweep(nowMs: number = now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): void {
      for (const [sessionID, stamp] of [...lastTouch.entries()]) {
        if (nowMs - stamp >= ttlMs) evict(sessionID);
      }
    },
  };
}
