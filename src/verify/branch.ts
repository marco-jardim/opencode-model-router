/**
 * src/verify/branch.ts — I7 (P0.2, S9/S12): did the verified working tree switch branch between two tree snapshots? Pure.
 *
 * The wiring compares the dispatch snapshot with the gate's (synchronous path), and the state recorded when a deferred
 * producer returned with router_verify's fresh snapshot, then hands the worded reason to the gate (Artefact.branchSwitch).
 * Kept out of tree.ts on purpose: several tests mock that module with `snapshotTree` alone.
 */
import type { TreeSnapshot } from "./dispatch";
import type { HeadState, ReflogEntry } from "./head";
import { isSlash, trimEndWhile } from "../util/linear-trim";

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
    const slashed = trimEndWhile(p.replace(/\\/g, "/"), isSlash); // linear: no `/\/+$/` (polynomial on a run of "/")
    return platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/** A reflog subject with control characters removed, capped at 120 chars. */
function cleanSubject(subject: string): string {
  return subject.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 120);
}

/**
 * The reflog subjects of entries that move HEAD and are the producer's own work: commits (initial, amend, merge), merges,
 * cherry-pick, revert, am and a `pull` that is not a rebase. Matched up to the first colon, so a message cannot widen it.
 * `pull --rebase` and a pull that rebased through config (`pull origin main (start): checkout …`) are refused: they replay
 * the producer's commits onto another base.
 */
const OWN_WORK = /^(?:commit(?: \([^)]*\))?|merge [^:]*|cherry-pick|revert|am|pull(?![^:]*(?:--rebase|\((?:start|pick|reword|edit|squash|fixup|drop|exec|break|label|reset|finish|continue|abort)\)))[^:]*)(?::|$)/i;

/**
 * Did the tree move between `before` and `now`? Roots that differ are a relocation; two known branches that differ are a
 * switch. `window` is the anchored HEAD reflog window since `before` (readReflogWindow: the entries newer than `before`
 * plus the one that was newest then, newest first); pass it only when both states have a reflog count and the count did not
 * shrink. The window must line up with both heads. An entry that left HEAD where it was (stash, unstage, a same-branch
 * checkout, an abort) is ignored; one that moved HEAD must be the producer's own work (OWN_WORK), else it is a rewrite.
 * Without a window, the fail-closed `branchSwitched` rule decides.
 */
export function treeMove(
  before: HeadState,
  now: HeadState,
  window: readonly ReflogEntry[] | undefined,
  platform: NodeJS.Platform = process.platform,
): TreeMove | undefined {
  if (!sameRoot(before.root, now.root, platform)) return { kind: "relocated" };
  if (before.branch !== now.branch) return { kind: "switched" };
  // Every HEAD update writes a reflog entry: a reflog that shrank, or a HEAD that moved with no new entry, is another history
  // in place (a replaced repository, an expired or edited reflog). Fail closed.
  const counted = before.reflog !== undefined && now.reflog !== undefined;
  if (counted) {
    if (now.reflog! < before.reflog!) return { kind: "rewritten", detail: "the reflog has fewer entries than before" };
    if (now.reflog === before.reflog && now.head !== before.head) return { kind: "rewritten", detail: "HEAD moved without a reflog entry" };
  }
  if (window === undefined) return branchSwitched(before, now) ? { kind: "switched" } : undefined;
  const misaligned: TreeMove = { kind: "rewritten", detail: "the reflog window does not line up with the recorded HEAD" };
  const grown = counted ? now.reflog! - before.reflog! : Math.max(0, window.length - 1);
  if (grown === 0) {
    // Nothing new: the heads are equal here (checked above when counted), and a window, when read, is the one old entry.
    if (now.head !== before.head) return misaligned;
    return window.length === 0 || (window.length === 1 && window[0]!.commit === now.head) ? undefined : misaligned;
  }
  if (window.length !== grown + 1) return misaligned;
  if (window[window.length - 1]!.commit !== before.head || window[0]!.commit !== now.head) return misaligned;
  for (let i = 0; i < window.length - 1; i++) {
    const entry = window[i]!;
    if (entry.commit === window[i + 1]!.commit) continue; // HEAD did not move.
    if (!OWN_WORK.test(entry.subject)) {
      return { kind: "rewritten", detail: entry.subject === "" ? "an unnamed reflog entry" : cleanSubject(entry.subject) };
    }
  }
  return undefined;
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
      return `the working tree ${root} moved or was rewritten ${when} (reflog: "${move.detail ?? ""}"); the checks could verify a tree without the producer's work. Re-dispatch, or send a fresh [acceptance] block.`;
    case "relocated":
      return `the working tree ${root} is now ${now.root} ${when}; the checks would verify another tree. Re-dispatch in the intended worktree.`;
  }
}
