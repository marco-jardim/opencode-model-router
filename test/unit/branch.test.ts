/**
 * test/unit/branch.test.ts
 *
 * I7 (P0.2, S9/S12): the branch rule the wiring applies to two tree snapshots (the dispatch's and the gate's, or the one
 * recorded when a deferred producer returned and router_verify's), and the unverifiable reason it words. Fail closed: a new
 * branch at the same commit and detached HEAD at another commit both count as a switch; ancestry never excuses one.
 */
import { describe, expect, it } from "vitest";
import { branchSwitched, branchSwitchReason, branchUnconfirmedReason, describeBranch, treeMove, treeMoveReason } from "../../src/verify/branch";
import type { HeadState, ReflogEntry } from "../../src/verify/head";

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

const C = "c".repeat(40);
const E = (commit: string, subject: string): ReflogEntry => ({ commit, subject });
/** `before` at A (reflog 5) and `now` at B (reflog 6), one entry in between: the window is [newest, the old newest]. */
const oneMove = (subject: string): ReturnType<typeof treeMove> =>
  treeMove(H(A, "main", "/repo", 5), H(B, "main", "/repo", 6), [E(B, subject), E(A, "commit: old")]);

describe("treeMove", () => {
  it("roots that differ are a relocation, before anything else", () => {
    expect(treeMove(H(A, "main", "/repo"), H(A, "feat", "/other"), [E(A, "checkout: moving from main to feat"), E(A, "x")], "linux")).toEqual({ kind: "relocated" });
    expect(treeMove(H(A, "main", "/repo"), H(A, "main", "/other"), undefined, "linux")).toEqual({ kind: "relocated" });
  });

  it("separators are normalised; case matters except on win32", () => {
    expect(treeMove(H(A, "main", "C:\\Work\\Repo"), H(A, "main", "c:/work/repo/"), [], "win32")).toBeUndefined();
    expect(treeMove(H(A, "main", "C:/Work/Repo"), H(A, "main", "c:/work/repo"), [], "win32")).toBeUndefined();
    expect(treeMove(H(A, "main", "/Work/Repo"), H(A, "main", "/work/repo"), [], "linux")).toEqual({ kind: "relocated" });
  });

  it("trailing separators are trimmed like the old `/\\/+$/` regex (CodeQL js/polynomial-redos)", () => {
    const oldNorm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const pairs: [string, string][] = [
      ["/repo", "/repo///"],
      ["/repo", "/repo/x"],
      ["/", "///"],
      ["/repo\\\\", "/repo"],
      ["//repo//", "//repo"],
      ["/repo/", "/repo//x/"],
    ];
    for (const [a, b] of pairs) {
      const expected = oldNorm(a) === oldNorm(b) ? undefined : { kind: "relocated" };
      expect(treeMove(H(A, "main", a), H(A, "main", b), [], "linux"), `${a} vs ${b}`).toEqual(expected);
    }
  });

  it("100 000 repeated '/' in a root compare fast (no polynomial backtracking)", () => {
    const run = "/".repeat(100_000);
    const started = performance.now();
    expect(treeMove(H(A, "main", `${run}x`), H(A, "main", `${run}y`), [], "linux")).toEqual({ kind: "relocated" });
    expect(treeMove(H(A, "main", `/repo${run}`), H(A, "main", "/repo"), [], "win32")).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("names that differ are a switch, even with a window of commits only", () => {
    expect(treeMove(H(A, "main"), H(A, "feat"), [E(A, "commit: x"), E(A, "commit: y")])).toEqual({ kind: "switched" });
    expect(treeMove(H(A, "main"), H(A, null), undefined)).toEqual({ kind: "switched" });
    expect(treeMove(H(A, null), H(A, "main"), [])).toEqual({ kind: "switched" });
  });

  it.each([
    "commit: x",
    "commit (amend): x",
    "commit (initial): x",
    "commit (merge): x",
    "merge feat: Fast-forward",
    "merge feat/x: Merge made by the 'ort' strategy.",
    "cherry-pick: x",
    "revert: x",
    "am: x",
    "pull: Fast-forward",
    "pull origin main: Merge made by the 'ort' strategy.",
    "Commit: capitalised",
  ])("a HEAD move with the subject %j is the producer's own work", (subject) => {
    expect(oneMove(subject)).toBeUndefined();
  });

  it.each([
    "pull --rebase origin (start): checkout abc",
    "pull origin main (start): checkout abc",
    "pull --rebase origin (pick): x",
    "rebase (start): checkout main",
    "rebase (finish): returning to refs/heads/main",
    "reset: moving to HEAD~1",
    "checkout: moving from a to b",
    "Checkout: moving from a to b",
    "switch: moving from a to b",
    "precheckout: x",
    "recommit: x",
    "commit-tree: x",
    "merged: x",
    "amend: x",
    "random text",
  ])("a HEAD move with the subject %j is a rewrite quoting it", (subject) => {
    expect(oneMove(subject)).toEqual({ kind: "rewritten", detail: subject });
  });

  it("an empty subject that moved HEAD is an unnamed rewrite", () => {
    expect(oneMove("")).toEqual({ kind: "rewritten", detail: "an unnamed reflog entry" });
  });

  it("HEAD-neutral entries (same commit as the older entry) are ignored, whatever their subject", () => {
    const before = H(A, "main", "/repo", 5);
    const now = H(A, "main", "/repo", 9);
    const window = [
      E(A, "reset: moving to HEAD"), // git stash
      E(A, "reset: moving to HEAD"), // git reset (unstage)
      E(A, "checkout: moving from main to main"),
      E(A, "reset: moving to HEAD"), // merge --abort
      E(A, "commit: old"),
    ];
    expect(treeMove(before, now, window)).toBeUndefined();
  });

  it("a neutral entry between commits does not hide a later move", () => {
    const window = [E(C, "commit: c"), E(B, "reset: moving to HEAD"), E(B, "commit: b"), E(A, "commit: old")];
    expect(treeMove(H(A, "main", "/repo", 5), H(C, "main", "/repo", 8), window)).toBeUndefined();
    const bad = [E(C, "commit: c"), E(B, "reset: moving to HEAD"), E(B, "checkout: moving from x to main"), E(A, "commit: old")];
    expect(treeMove(H(A, "main", "/repo", 5), H(C, "main", "/repo", 8), bad)).toEqual({ kind: "rewritten", detail: "checkout: moving from x to main" });
  });

  it("the first moving entry, newest first, is the one quoted", () => {
    const window = [E(C, "reset: newer"), E(B, "checkout: older"), E(A, "commit: old")];
    expect(treeMove(H(A, "main", "/repo", 5), H(C, "main", "/repo", 7), window)).toEqual({ kind: "rewritten", detail: "reset: newer" });
  });

  it("a round trip that ends where it began is still a move (the name and head are the same)", () => {
    const window = [E(A, "checkout: moving from x to main"), E(B, "commit: on x"), E(A, "checkout: moving from main to x"), E(A, "commit: old")];
    // The checkout -b is neutral, the commit on x moves, and the checkout back moves HEAD again: caught by the window.
    expect(treeMove(H(A, "main", "/repo", 5), H(A, "main", "/repo", 8), window)).toEqual({ kind: "rewritten", detail: "checkout: moving from x to main" });
  });

  it.each<[string, readonly ReflogEntry[]]>([
    ["the newest entry is not now.head", [E(C, "commit: x"), E(A, "commit: old")]],
    ["the oldest entry is not before.head", [E(B, "commit: x"), E(C, "commit: old")]],
    ["the window is shorter than the count", [E(B, "commit: x")]],
    ["the window is longer than the count", [E(B, "commit: x"), E(C, "commit: y"), E(A, "commit: old")]],
    ["the window is empty while the count grew", []],
  ])("an anchor mismatch is a rewrite: %s", (_name, window) => {
    expect(treeMove(H(A, "main", "/repo", 5), H(B, "main", "/repo", 6), window))
      .toEqual({ kind: "rewritten", detail: "the reflog window does not line up with the recorded HEAD" });
  });

  it("with equal counts the window is the one old entry (or empty) and must line up", () => {
    expect(treeMove(H(A, "main", "/repo", 5), H(A, "main", "/repo", 5), [])).toBeUndefined();
    expect(treeMove(H(A, "main", "/repo", 5), H(A, "main", "/repo", 5), [E(A, "commit: old")])).toBeUndefined();
    expect(treeMove(H(A, "main", "/repo", 5), H(A, "main", "/repo", 5), [E(B, "commit: old")]))
      .toEqual({ kind: "rewritten", detail: "the reflog window does not line up with the recorded HEAD" });
  });

  it("without reflog counts, a window is still anchored on its own length and ends", () => {
    expect(treeMove(H(A, "main"), H(B, "main"), [E(B, "commit: x"), E(A, "commit: old")])).toBeUndefined();
    expect(treeMove(H(A, "main"), H(B, "main"), [E(B, "reset: x"), E(A, "commit: old")])).toEqual({ kind: "rewritten", detail: "reset: x" });
    expect(treeMove(H(A, "main"), H(B, "main"), [E(B, "commit: x"), E(C, "commit: old")]))
      .toEqual({ kind: "rewritten", detail: "the reflog window does not line up with the recorded HEAD" });
    expect(treeMove(H(A, "main"), H(B, "main"), [])).toEqual({ kind: "rewritten", detail: "the reflog window does not line up with the recorded HEAD" });
    expect(treeMove(H(A, "main"), H(A, "main"), [])).toBeUndefined();
  });

  it("the detail has control characters removed and is capped at 120 characters", () => {
    const move = oneMove(`reset: ${"x".repeat(200)}\u001b[31m\n`);
    expect(move?.kind).toBe("rewritten");
    expect(move?.detail).toHaveLength(120);
    expect(move?.detail).not.toMatch(/[\u0000-\u001f]/);
    expect(oneMove("reset: a\u001b[31mb\n")?.detail).toBe("reset: a[31mb");
  });

  it("a reflog that shrank, or a HEAD that moved with no new entry, is another history in place", () => {
    expect(treeMove(H(A, "main", "/repo", 5), H(A, "main", "/repo", 3), [])).toEqual({ kind: "rewritten", detail: "the reflog has fewer entries than before" });
    expect(treeMove(H(A, "main", "/repo", 5), H(B, "main", "/repo", 5), [])).toEqual({ kind: "rewritten", detail: "HEAD moved without a reflog entry" });
    expect(treeMove(H(A, "main", "/repo", 5), H(A, "main", "/repo", 5), [])).toBeUndefined();
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
      .toBe("the working tree /repo moved or was rewritten since the producer returned (reflog: \"reset: moving to HEAD~1\"); the checks could verify a tree without the producer's work. Re-dispatch, or send a fresh [acceptance] block.");
  });

  it("words a relocation", () => {
    expect(treeMoveReason("/repo", H(A, "main"), H(A, "main", "/other"), { kind: "relocated" }, "during the dispatch"))
      .toBe("the working tree /repo is now /other during the dispatch; the checks would verify another tree. Re-dispatch in the intended worktree.");
  });
});
