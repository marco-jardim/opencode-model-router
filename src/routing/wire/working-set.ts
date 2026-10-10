/**
 * The working set of an orchestrator session (`docs/design/cross-repo.md`, Phase 1 step P1.4): the repository locations its role
 * dispatches were bound to, so a later `root=` naming one of their worktrees is admitted by rule 2 (a worktree that a known
 * repository lists). Per orchestrator session, at most {@link WORKING_SET_MAX} roots (the oldest evicted), de-duplicated by
 * worktree (a re-bound worktree moves to the newest place, with its latest location). Forgotten on `session.deleted`.
 */
import type { RepoLocation } from "../roles/admission";

/** Roots kept per orchestrator session; the oldest is evicted first. */
export const WORKING_SET_MAX = 16;

const sets = new Map<string, RepoLocation[]>();

/** Record that a dispatch of `orchestratorSessionID` was bound to `location`. */
export function addToWorkingSet(orchestratorSessionID: string, location: RepoLocation): void {
  const current = sets.get(orchestratorSessionID) ?? [];
  const next = current.filter((entry) => entry.worktree !== location.worktree);
  next.push(location);
  while (next.length > WORKING_SET_MAX) next.shift();
  sets.set(orchestratorSessionID, next);
}

/** The bound locations of `orchestratorSessionID`, oldest first; [] when none. */
export function workingSetOf(orchestratorSessionID: string): readonly RepoLocation[] {
  return [...(sets.get(orchestratorSessionID) ?? [])];
}

/** Drop the working set of a deleted session. */
export function forgetWorkingSet(orchestratorSessionID: string): void {
  sets.delete(orchestratorSessionID);
}
