/**
 * src/verify/branch.ts — I7 (P0.2, S9/S12): did the verified working tree switch branch between two tree snapshots? Pure.
 *
 * The wiring compares the dispatch snapshot with the gate's (synchronous path), and the state recorded when a deferred
 * producer returned with router_verify's fresh snapshot, then hands the worded reason to the gate (Artefact.branchSwitch).
 * Kept out of tree.ts on purpose: several tests mock that module with `snapshotTree` alone.
 */
import type { TreeSnapshot } from "./dispatch";
import type { HeadState } from "./head";

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
  when: "during the dispatch" | "since the producer returned" | "since the attempt that introduced this acceptance",
): string {
  const verb = before.branch === null && now.branch === null ? "moved" : "switched";
  return `the working tree ${root} ${verb} from ${describeBranch(before)} to ${describeBranch(now)} ${when}; the checks would verify another branch`;
}

/** router_verify: a branch was recorded when the producer returned, but the current tree could not be read. */
export function branchUnconfirmedReason(root: string): string {
  return `cannot confirm the branch of ${root}: the working tree could not be read at router_verify, so the checks could verify another branch. Run router_verify again, or re-dispatch.`;
}

/** How a working tree moved between two head states. */
export type TreeMove = { readonly kind: "switched" | "rewritten" | "relocated"; readonly detail?: string };

function sameRoot(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/** A reflog subject with control characters removed, capped at 120 chars. */
function cleanSubject(subject: string): string {
  return subject.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 120);
}

/**
 * Did the tree move between `before` and `now`? Roots that differ are a relocation; two known branches that differ are a
 * switch. `subjects` is the HEAD reflog window since `before` (pass it only when both states have a reflog count and the count
 * did not shrink): a checkout, reset or rebase in it is a rewrite; commits alone are not a move. Without a window, the
 * fail-closed `branchSwitched` rule decides.
 */
export function treeMove(
  before: HeadState,
  now: HeadState,
  subjects: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): TreeMove | undefined {
  if (!sameRoot(before.root, now.root, platform)) return { kind: "relocated" };
  if (before.branch !== now.branch) return { kind: "switched" };
  if (subjects !== undefined) {
    const hit = subjects.find((subject) => /^(checkout|reset|rebase)\b/i.test(subject));
    return hit === undefined ? undefined : { kind: "rewritten", detail: cleanSubject(hit) };
  }
  return branchSwitched(before, now) ? { kind: "switched" } : undefined;
}

/** The gate's unverifiable reason for a TreeMove. */
export function treeMoveReason(
  root: string,
  before: HeadState,
  now: HeadState,
  move: TreeMove,
  when: "during the dispatch" | "since the producer returned",
): string {
  switch (move.kind) {
    case "switched":
      return `${branchSwitchReason(root, before, now, when)}. Check out ${describeBranch(before)} again and re-dispatch, or send a fresh [acceptance] block on the current branch.`;
    case "rewritten":
      return `the working tree ${root} was checked out or reset ${when} (reflog: "${move.detail ?? ""}"); the checks could verify a tree without the producer's work. Re-dispatch, or send a fresh [acceptance] block.`;
    case "relocated":
      return `the working tree ${root} is now ${now.root} ${when}; the checks would verify another tree. Re-dispatch in the intended worktree.`;
  }
}
