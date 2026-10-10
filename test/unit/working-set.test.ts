/** Cross-repo P1.4: the per-orchestrator working set of bound repository locations. */
import { afterEach, describe, expect, it } from "vitest";
import type { RepoLocation } from "../../src/routing/roles/admission";
import { WORKING_SET_MAX, addToWorkingSet, forgetWorkingSet, workingSetOf } from "../../src/routing/wire/working-set";

const located = (worktree: string, branch: string | null = "main"): RepoLocation => ({
  repository: worktree, name: worktree.split("/").pop() ?? worktree, worktree, branch, head: "abc1234def", worktrees: [],
});

afterEach(() => {
  forgetWorkingSet("orch-a");
  forgetWorkingSet("orch-b");
});

describe("working set (cross-repo P1.4)", () => {
  it("adds per orchestrator session, oldest first; an unknown session has none", () => {
    expect(workingSetOf("orch-a")).toEqual([]);
    addToWorkingSet("orch-a", located("/src/api"));
    addToWorkingSet("orch-a", located("/src/web"));
    addToWorkingSet("orch-b", located("/src/lib"));
    expect(workingSetOf("orch-a").map((l) => l.worktree)).toEqual(["/src/api", "/src/web"]);
    expect(workingSetOf("orch-b").map((l) => l.worktree)).toEqual(["/src/lib"]);
  });

  it("de-duplicates by worktree: a re-bound worktree moves to the newest place with its latest location", () => {
    addToWorkingSet("orch-a", located("/src/api", "main"));
    addToWorkingSet("orch-a", located("/src/web"));
    addToWorkingSet("orch-a", located("/src/api", "feat"));
    expect(workingSetOf("orch-a").map((l) => [l.worktree, l.branch])).toEqual([["/src/web", "main"], ["/src/api", "feat"]]);
  });

  it(`is bounded to ${String(WORKING_SET_MAX)} roots, the oldest evicted`, () => {
    expect(WORKING_SET_MAX).toBe(16);
    for (let i = 0; i < WORKING_SET_MAX + 2; i++) addToWorkingSet("orch-a", located(`/src/r${String(i)}`));
    const set = workingSetOf("orch-a").map((l) => l.worktree);
    expect(set).toHaveLength(16);
    expect(set[0]).toBe("/src/r2");
    expect(set[15]).toBe("/src/r17");
  });

  it("returns a copy, and forget drops only that session's set", () => {
    addToWorkingSet("orch-a", located("/src/api"));
    addToWorkingSet("orch-b", located("/src/lib"));
    (workingSetOf("orch-a") as RepoLocation[]).length = 0;
    expect(workingSetOf("orch-a")).toHaveLength(1);
    forgetWorkingSet("orch-a");
    expect(workingSetOf("orch-a")).toEqual([]);
    expect(workingSetOf("orch-b")).toHaveLength(1);
  });
});
