/**
 * test/unit/branch-restart-window.test.ts
 *
 * QA-SYNC1-17: a branch switch seen on a dispatch-time head restored from the journal names its real window (from the dispatch to
 * the check after the restart); the live wording ("during the dispatch") is unchanged.
 */
import { describe, expect, it } from "vitest";
import { AFTER_RESTART_WINDOW, branchSwitchReason, treeMoveReason } from "../../src/verify/branch";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("QA-SYNC1-17: the branch-switch window after a restart", () => {
  it("names the window up to the check after the restart", () => {
    expect(AFTER_RESTART_WINDOW).toBe("between the dispatch and the check after the restart");
    expect(treeMoveReason("/repo", { root: "/repo", head: A, branch: "main" }, { root: "/repo", head: B, branch: "other" }, { kind: "switched" }, AFTER_RESTART_WINDOW))
      .toBe("the working tree /repo switched from branch main to branch other between the dispatch and the check after the restart; the checks would verify another branch. Check out branch main again and re-dispatch, or send a fresh [acceptance] block on the current branch.");
  });

  it("control: the live wording stays \"during the dispatch\"", () => {
    expect(branchSwitchReason("/repo", { head: A, branch: "main" }, { head: B, branch: "other" }, "during the dispatch"))
      .toBe("the working tree /repo switched from branch main to branch other during the dispatch; the checks would verify another branch");
  });
});
