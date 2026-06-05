import { newGuardState } from "./guards";
import type { GuardState, GuardPolicy } from "./guards";

/**
 * Per-plugin-instance store of guard state, keyed by sessionID. Mirrors the
 * pattern of createSessionStore/createTrajectoryStore: no module-level
 * singletons, so concurrent subagent sessions never share mutable state (M7).
 * Also holds a per-session "pending note" used by advisory mode to defer a
 * banner from the before-hook to the after-hook (where output is mutable).
 */
export function createGuardStore() {
  const states = new Map<string, GuardState>();
  const pendingNotes = new Map<string, string>();
  return {
    ensure(sessionID: string, policy: GuardPolicy): GuardState {
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
      pendingNotes.set(sessionID, note);
    },
    takePendingNote(sessionID: string): string | undefined {
      const n = pendingNotes.get(sessionID);
      if (n !== undefined) pendingNotes.delete(sessionID);
      return n;
    },
    clear(sessionID: string): void {
      states.delete(sessionID);
      pendingNotes.delete(sessionID);
    },
  };
}
