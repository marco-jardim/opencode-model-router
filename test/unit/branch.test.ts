/**
 * test/unit/branch.test.ts
 *
 * I7 (P0.2, S9/S12): the branch rule the wiring applies to two tree snapshots (the dispatch's and the gate's, or the one
 * recorded when a deferred producer returned and router_verify's), and the unverifiable reason it words. Fail closed: a new
 * branch at the same commit and detached HEAD at another commit both count as a switch; ancestry never excuses one.
 */
import { describe, expect, it } from "vitest";
import { branchSwitched, branchSwitchReason, branchUnconfirmedReason, describeBranch } from "../../src/verify/branch";

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
      .toBe("cannot confirm the branch of /repo: the working tree could not be read at router_verify, so the checks could verify another branch");
  });
});
