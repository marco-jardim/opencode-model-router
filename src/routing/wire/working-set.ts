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

/** Comparison key of a path: case-insensitive on Windows. */
function workingSetKey(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Remove one repository from every session's working set (SD-P4-12, `/router revoke`): every entry of the repository whose
 * main worktree is the canonical path `match` (any of its worktrees), every entry bound to that worktree, and every entry
 * backed by an approval of that path. Paths compare as text, case-insensitive on win32. Returns the number of entries removed.
 */
export function dropFromWorkingSets(match: string, platform: NodeJS.Platform = process.platform): number {
  const key = workingSetKey(match, platform);
  const hit = (entry: RepoLocation): boolean =>
    workingSetKey(entry.repository, platform) === key
    || workingSetKey(entry.worktree, platform) === key
    || (entry.approval !== undefined && workingSetKey(entry.approval, platform) === key);
  let removed = 0;
  for (const [sessionID, entries] of sets) {
    const kept = entries.filter((entry) => !hit(entry));
    if (kept.length === entries.length) continue;
    removed += entries.length - kept.length;
    if (kept.length === 0) sets.delete(sessionID);
    else sets.set(sessionID, kept);
  }
  return removed;
}
