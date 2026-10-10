/**
 * src/verify/branch.ts — I7 (P0.2, S9/S12): did the verified working tree switch branch between two tree snapshots? Pure.
 *
 * The wiring compares the dispatch snapshot with the gate's (synchronous path), and the state recorded when a deferred
 * producer returned with router_verify's fresh snapshot, then hands the worded reason to the gate (Artefact.branchSwitch).
 * Kept out of tree.ts on purpose: several tests mock that module with `snapshotTree` alone.
 */
import type { TreeSnapshot } from "./dispatch";

/** The part of a snapshot (or of a deferred registration) the branch rule reads. */
export type BranchState = Pick<TreeSnapshot, "head" | "branch">;

/**
 * Fail closed. Two known branches that differ are a switch, including a new branch at the same commit (`checkout -b`), and
 * so is a detached HEAD at another commit (a commit on a detached HEAD cannot be told apart from a checkout without the
 * reflog). With either side unknown, any HEAD move is a switch. Ancestry never excuses one: a descendant branch can still
 * leave the producer's commit unchecked-out.
 */
export function branchSwitched(before: BranchState, now: BranchState): boolean {
  if (before.branch !== undefined && now.branch !== undefined) {
    if (before.branch !== now.branch) return true;
    return before.branch === null && before.head !== now.head;
  }
  return before.head !== now.head;
}

/** `branch feat/x`, `detached HEAD at <7-char sha>`, or `an unknown branch`. */
export function describeBranch(state: BranchState): string {
  if (state.branch === undefined) return "an unknown branch";
  if (state.branch === null) return `detached HEAD at ${state.head.slice(0, 7)}`;
  return `branch ${state.branch}`;
}

/** The gate's unverifiable reason for a switch (Artefact.branchSwitch); each side describes itself. */
export function branchSwitchReason(
  root: string,
  before: BranchState,
  now: BranchState,
  when: "during the dispatch" | "since the producer returned",
): string {
  const verb = before.branch === null && now.branch === null ? "moved" : "switched";
  return `the working tree ${root} ${verb} from ${describeBranch(before)} to ${describeBranch(now)} ${when}; the checks would verify another branch`;
}

/** router_verify: a branch was recorded when the producer returned, but the current tree could not be read. */
export function branchUnconfirmedReason(root: string): string {
  return `cannot confirm the branch of ${root}: the working tree could not be read at router_verify, so the checks could verify another branch`;
}
