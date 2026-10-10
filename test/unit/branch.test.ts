/**
 * test/unit/branch.test.ts
 *
 * I7 (P0.2, S9/S12): the branch rule the wiring applies to two tree snapshots (the dispatch's and the gate's, or the one
 * recorded when a deferred producer returned and router_verify's), and the unverifiable reason it words. Fail closed: a new
 * branch at the same commit and detached HEAD at another commit both count as a switch; ancestry never excuses one.
 */
import { describe, expect, it } from "vitest";
import { branchSwitched, branchSwitchReason, branchUnconfirmedReason, describeBranch, treeMove, treeMoveReason } from "../../src/verify/branch";
import type { HeadState } from "../../src/verify/head";

const A = "a".repeat(40);
const B = "b".repeat(40);
type State = { head: string; branch?: string | null };
/** A snapshot's branch state; `branch` omitted = unknown. */
const s = (head: string, branch?: string | null): State => (branch === undefined ? { head } : { head, branch });

describe("branchSwitched", () => {
  it.each<[string, State, State, boolean]>([
    ["same branch, same HEAD", s(A, "main"), s(A, "main"), false],
    ["same branch, HEAD moved (a commit on it)", s(A, "main"), s(B, "main"), false],
    ["a new branch at the same commit (checkout -b): fail closed", s(A, "main"), s(A, "feat/x"), true],
    ["another branch at another commit", s(A, "main"), s(B, "feat/x"), true],
    ["attached to detached at the same commit", s(A, "main"), s(A, null), true],
    ["detached to attached", s(A, null), s(A, "main"), true],
    ["detached at the same commit", s(A, null), s(A, null), false],
    ["detached to detached at another commit: fail closed (no reflog)", s(A, null), s(B, null), true],
    ["unknown on both sides, same HEAD", s(A), s(A), false],
    ["unknown before, known now, same HEAD", s(A), s(A, "main"), false],
    ["unknown before, known now, HEAD moved", s(A), s(B, "main"), true],
    ["known before, unknown now, HEAD moved", s(A, "main"), s(B), true],
    ["unknown on both sides, HEAD moved", s(A), s(B), true],
  ])("%s -> %s", (_name, before, now, expected) => {
    expect(branchSwitched(before, now)).toBe(expected);
  });

  it("an explicit undefined branch is unknown, like an absent one", () => {
    expect(branchSwitched({ head: A, branch: undefined }, s(B, "main"))).toBe(true);
    expect(branchSwitched({ head: A, branch: undefined }, s(A, "main"))).toBe(false);
  });
});

describe("describeBranch", () => {
  it("names a branch, a detached HEAD by its 7-char sha, or an unknown branch", () => {
    expect(describeBranch(s(A, "feat/x"))).toBe("branch feat/x");
    expect(describeBranch(s("1234567890abcdef", null))).toBe("detached HEAD at 1234567");
    expect(describeBranch(s(A))).toBe("an unknown branch");
  });
});

describe("branchSwitchReason", () => {
  const tail = "; the checks would verify another branch";

  it("words a switch during the dispatch, each side describing itself", () => {
    expect(branchSwitchReason("/repo", s(A, "main"), s(A, "feat/x"), "during the dispatch"))
      .toBe(`the working tree /repo switched from branch main to branch feat/x during the dispatch${tail}`);
    expect(branchSwitchReason("/repo", s(A), s(B, "main"), "during the dispatch"))
      .toBe(`the working tree /repo switched from an unknown branch to branch main during the dispatch${tail}`);
  });

  it("words a switch since the producer returned", () => {
    expect(branchSwitchReason("/repo", s(A, "main"), s("1234567890abcdef", null), "since the producer returned"))
      .toBe(`the working tree /repo switched from branch main to detached HEAD at 1234567 since the producer returned${tail}`);
  });

  it("says 'moved' for detached HEAD at another commit", () => {
    expect(branchSwitchReason("/repo", s(A, null), s(B, null), "during the dispatch"))
      .toBe(`the working tree /repo moved from detached HEAD at aaaaaaa to detached HEAD at bbbbbbb during the dispatch${tail}`);
  });

  it("words a branch that cannot be confirmed at router_verify", () => {
    expect(branchUnconfirmedReason("/repo"))
      .toBe("cannot confirm the branch of /repo: the working tree could not be read at router_verify, so the checks could verify another branch. Run router_verify again, or re-dispatch.");
  });
});

const H = (head: string, branch: string | null, root = "/repo", reflog?: number): HeadState =>
  reflog === undefined ? { root, head, branch } : { root, head, branch, reflog };

describe("treeMove", () => {
  it("roots that differ are a relocation, before anything else", () => {
    expect(treeMove(H(A, "main", "/repo"), H(A, "feat", "/other"), ["checkout: moving from main to feat"], "linux")).toEqual({ kind: "relocated" });
    expect(treeMove(H(A, "main", "/repo"), H(A, "main", "/other"), undefined, "linux")).toEqual({ kind: "relocated" });
  });

  it("separators are normalised; case matters except on win32", () => {
    expect(treeMove(H(A, "main", "C:\\Work\\Repo"), H(A, "main", "c:/work/repo/"), [], "win32")).toBeUndefined();
    expect(treeMove(H(A, "main", "C:/Work/Repo"), H(A, "main", "c:/work/repo"), [], "win32")).toBeUndefined();
    expect(treeMove(H(A, "main", "/Work/Repo"), H(A, "main", "/work/repo"), [], "linux")).toEqual({ kind: "relocated" });
  });

  it("names that differ are a switch, even with a window of commits only", () => {
    expect(treeMove(H(A, "main"), H(A, "feat"), ["commit: x"])).toEqual({ kind: "switched" });
    expect(treeMove(H(A, "main"), H(A, null), undefined)).toEqual({ kind: "switched" });
    expect(treeMove(H(A, null), H(A, "main"), [])).toEqual({ kind: "switched" });
  });

  it.each([
    ["checkout", "checkout: moving from main to main"],
    ["reset", "reset: moving to HEAD~1"],
    ["rebase", "rebase (finish): returning to refs/heads/main"],
    ["a capitalised verb", "Checkout: moving from a to b"],
  ])("a reflog window with %s is a rewrite, quoting the first such subject", (_name, subject) => {
    expect(treeMove(H(A, "main"), H(B, "main"), ["commit: two", subject, "checkout: later"])).toEqual({ kind: "rewritten", detail: subject });
  });

  it("the detail has control characters removed and is capped at 120 characters", () => {
    const move = treeMove(H(A, "main"), H(B, "main"), [`reset: ${"x".repeat(200)}\u001b[31m\n`]);
    expect(move?.kind).toBe("rewritten");
    expect(move?.detail).toHaveLength(120);
    expect(move?.detail).not.toMatch(/[\u0000-\u001f]/);
    expect(treeMove(H(A, "main"), H(B, "main"), ["reset: a\u001b[31mb\n"])?.detail).toBe("reset: a[31mb");
  });

  it("a window of commits only is not a move, detached to detached included", () => {
    expect(treeMove(H(A, "main"), H(B, "main"), ["commit: two", "commit (amend): one", "commit (merge): m", "pull: Fast-forward"])).toBeUndefined();
    expect(treeMove(H(A, null), H(B, null), ["commit: on detached"])).toBeUndefined();
    expect(treeMove(H(A, "main"), H(A, "main"), [])).toBeUndefined();
    expect(treeMove(H(A, "main"), H(B, "main"), ["precheckout: x", "recommit: reset"])).toBeUndefined();
  });

  it("without a window, the fail-closed branchSwitched rule applies", () => {
    expect(treeMove(H(A, "main"), H(B, "main"), undefined)).toBeUndefined();
    expect(treeMove(H(A, null), H(A, null), undefined)).toBeUndefined();
    expect(treeMove(H(A, null), H(B, null), undefined)).toEqual({ kind: "switched" });
  });
});

describe("treeMoveReason", () => {
  const remedy = " Check out branch main again and re-dispatch, or send a fresh [acceptance] block on the current branch.";

  it("words a switch with the existing text and a remedy", () => {
    const before = H(A, "main");
    const now = H(A, "feat/x");
    expect(treeMoveReason("/repo", before, now, { kind: "switched" }, "during the dispatch"))
      .toBe(`${branchSwitchReason("/repo", before, now, "during the dispatch")}.${remedy}`);
    expect(treeMoveReason("/repo", before, H(B, null), { kind: "switched" }, "since the producer returned"))
      .toBe(`the working tree /repo switched from branch main to detached HEAD at bbbbbbb since the producer returned; the checks would verify another branch.${remedy}`);
  });

  it("words a detached move and describes the before side in the remedy", () => {
    expect(treeMoveReason("/repo", H(A, null), H(B, null), { kind: "switched" }, "during the dispatch"))
      .toBe("the working tree /repo moved from detached HEAD at aaaaaaa to detached HEAD at bbbbbbb during the dispatch; the checks would verify another branch. Check out detached HEAD at aaaaaaa again and re-dispatch, or send a fresh [acceptance] block on the current branch.");
  });

  it("words a rewrite with the reflog subject", () => {
    expect(treeMoveReason("/repo", H(A, "main"), H(B, "main"), { kind: "rewritten", detail: "reset: moving to HEAD~1" }, "since the producer returned"))
      .toBe("the working tree /repo was checked out or reset since the producer returned (reflog: \"reset: moving to HEAD~1\"); the checks could verify a tree without the producer's work. Re-dispatch, or send a fresh [acceptance] block.");
  });

  it("words a relocation", () => {
    expect(treeMoveReason("/repo", H(A, "main"), H(A, "main", "/other"), { kind: "relocated" }, "during the dispatch"))
      .toBe("the working tree /repo is now /other during the dispatch; the checks would verify another tree. Re-dispatch in the intended worktree.");
  });
});
