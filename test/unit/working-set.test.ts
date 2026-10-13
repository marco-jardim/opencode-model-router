/** Cross-repo P1.4: the per-orchestrator working set of bound repository locations. */
import { afterEach, describe, expect, it } from "vitest";
import type { RepoLocation } from "../../src/routing/roles/admission";
import { WORKING_SET_MAX, addToWorkingSet, dropFromWorkingSets, forgetWorkingSet, workingSetOf } from "../../src/routing/wire/working-set";

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

describe("dropFromWorkingSets (cross-repo P4, /router revoke)", () => {
  const inRepo = (repository: string, worktree: string, approval?: string): RepoLocation => ({
    ...located(worktree), repository, ...(approval === undefined ? {} : { approval }),
  });

  it("removes the repository (main worktree, its other worktrees, approval-backed entries) from every session", () => {
    addToWorkingSet("orch-a", inRepo("/ext/app", "/ext/app", "/ext/app"));
    addToWorkingSet("orch-a", located("/src/api"));
    addToWorkingSet("orch-a", inRepo("/ext/app", "/wt/app-feat", "/ext/app"));
    addToWorkingSet("orch-b", inRepo("/ext/app", "/wt/app-fix"));
    addToWorkingSet("orch-b", located("/src/lib"));
    expect(dropFromWorkingSets("/ext/app", "linux")).toBe(3);
    expect(workingSetOf("orch-a").map((l) => l.worktree)).toEqual(["/src/api"]);
    expect(workingSetOf("orch-b").map((l) => l.worktree)).toEqual(["/src/lib"]);
  });

  it("is case-insensitive on win32 only, and an unknown path removes nothing", () => {
    addToWorkingSet("orch-a", inRepo("D:\\Ext\\App", "D:\\Ext\\App", "D:\\Ext\\App"));
    expect(dropFromWorkingSets("d:\\ext\\app", "linux")).toBe(0);
    expect(workingSetOf("orch-a")).toHaveLength(1);
    expect(dropFromWorkingSets("D:\\other", "win32")).toBe(0);
    expect(dropFromWorkingSets("d:\\ext\\app", "win32")).toBe(1);
    expect(workingSetOf("orch-a")).toEqual([]);
  });

  it("leaves an emptied session with no set and other sessions untouched", () => {
    addToWorkingSet("orch-a", inRepo("/ext/app", "/ext/app"));
    addToWorkingSet("orch-b", located("/src/lib"));
    dropFromWorkingSets("/ext/app", "linux");
    expect(workingSetOf("orch-a")).toEqual([]);
    expect(workingSetOf("orch-b").map((l) => l.worktree)).toEqual(["/src/lib"]);
  });
});
