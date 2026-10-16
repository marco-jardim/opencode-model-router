/**
 * test/unit/head.test.ts — the cheap HEAD reader, against REAL git in temp repositories.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { treeMove, type TreeMove } from "../../src/verify/branch";
import { readHead, readHeadState, readReflogWindow, type HeadState, type ReflogEntry } from "../../src/verify/head";

const base = mkdtempSync(join(tmpdir(), "head-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
const fresh = (): string => {
  const dir = join(base, `r${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const git = (cwd: string, ...args: string[]): string => execFileSync(
  "git",
  ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
const commit = (dir: string, message: string): void => {
  writeFileSync(join(dir, "f.txt"), `${message}\n${Math.random()}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
};
const repo = (): string => {
  const dir = fresh();
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "one");
  return dir;
};

// G-17, QA-62C-16: every test here spawns real git, synchronously, three to ten processes per test. On a loaded 2-4 core
// windows-latest runner one spawn took about 1.5 s, so a seven-spawn test took 10.5 s against the 5 s default (PR #116,
// win22); it passes in about 1 s elsewhere (win24: 1095 ms). Every describe below spawns real git, so each carries the limit
// the other real-git files use (reference.test.ts: 60 s). No assertion changes.
const REAL_GIT = { timeout: 60_000 };

describe("readHeadState", REAL_GIT, () => {
  it("attached: root (realpath), head, branch name and the reflog count", async () => {
    const dir = repo();
    const state = await readHeadState(dir);
    expect(state).toEqual({ root: realpathSync.native(dir), head: git(dir, "rev-parse", "HEAD"), branch: "main", reflog: 1 });
  });

  it("a nested branch name keeps its slash", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "feat/x");
    expect((await readHeadState(dir))?.branch).toBe("feat/x");
  });

  it("detached: branch is null", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "--detach");
    const state = await readHeadState(dir);
    expect(state?.branch).toBeNull();
    expect(state?.head).toBe(git(dir, "rev-parse", "HEAD"));
  });

  it("a subdirectory reports the toplevel", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    expect((await readHeadState(join(dir, "sub")))?.root).toBe(realpathSync.native(dir));
  });

  it("a linked worktree has its own root, branch and reflog", async () => {
    const dir = repo();
    const linked = join(base, `wt${++counter}`);
    git(dir, "worktree", "add", "-q", "-b", "wt-branch", linked);
    const main = await readHeadState(dir);
    const state = await readHeadState(linked);
    expect(state?.root).toBe(realpathSync.native(linked));
    expect(state?.root).not.toBe(main?.root);
    expect(state?.branch).toBe("wt-branch");
    expect(state?.head).toBe(main?.head);
    expect(typeof state?.reflog).toBe("number");
  });

  it("an unborn branch is undefined", async () => {
    const dir = fresh();
    git(dir, "init", "-q", "-b", "main");
    expect(await readHeadState(dir)).toBeUndefined();
  });

  it("a directory that is not a repository is undefined", async () => {
    expect(await readHeadState(fresh())).toBeUndefined();
  });

  it("an aborted signal is undefined", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await readHeadState(repo(), { signal: controller.signal })).toBeUndefined();
  });

  it("the reflog count grows after a commit and after a checkout", async () => {
    const dir = repo();
    const first = await readHeadState(dir);
    commit(dir, "two");
    const second = await readHeadState(dir);
    git(dir, "checkout", "-q", "-b", "feat");
    const third = await readHeadState(dir);
    expect(first?.reflog).toBe(1);
    expect(second?.reflog).toBe(2);
    expect(third?.reflog).toBe(3);
  });
});

describe("readHead", REAL_GIT, () => {
  it("a repository gives the same state as readHeadState", async () => {
    const dir = repo();
    expect(await readHead(dir)).toEqual(await readHeadState(dir));
    expect(typeof (await readHead(dir) as HeadState).head).toBe("string");
  });

  it("a directory that is not a repository is \"none\" (git ran and exited non-zero)", async () => {
    expect(await readHead(fresh())).toBe("none");
  });

  it("an unborn branch is \"none\"", async () => {
    const dir = fresh();
    git(dir, "init", "-q", "-b", "main");
    expect(await readHead(dir)).toBe("none");
  });

  it("an aborted signal is undefined (unknown), not \"none\"", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await readHead(repo(), { signal: controller.signal })).toBeUndefined();
  });

  it("a spawn failure (cwd that does not exist) is undefined", async () => {
    expect(await readHead(join(base, "no-such-dir"))).toBeUndefined();
  });

  it("reflogs disabled: a count of 0 leaves reflog absent", async () => {
    const dir = fresh();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "core.logAllRefUpdates", "false");
    commit(dir, "one");
    const state = await readHead(dir);
    expect(state).toEqual({ root: realpathSync.native(dir), head: git(dir, "rev-parse", "HEAD"), branch: "main" });
    expect(state).not.toHaveProperty("reflog");
  });
});

describe("readReflogWindow", REAL_GIT, () => {
  it("count + 1 entries, newest first, with the commit and the subject", async () => {
    const dir = repo();
    const one = git(dir, "rev-parse", "HEAD");
    commit(dir, "two");
    const two = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "feat");
    git(dir, "reset", "-q", "--hard", "HEAD");
    expect(await readReflogWindow(dir, 3)).toEqual([
      { commit: two, subject: "reset: moving to HEAD" },
      { commit: two, subject: "checkout: moving from main to feat" },
      { commit: two, subject: "commit: two" },
      { commit: one, subject: "commit (initial): one" },
    ]);
  });

  it("the extra entry is the one that was newest at the earlier read", async () => {
    const dir = repo();
    commit(dir, "two");
    const before = await readHead(dir) as HeadState;
    commit(dir, "three");
    commit(dir, "four");
    const now = await readHead(dir) as HeadState;
    const window = await readReflogWindow(dir, (now.reflog ?? 0) - (before.reflog ?? 0));
    expect(window?.map((e) => e.subject)).toEqual(["commit: four", "commit: three", "commit: two"]);
    expect(window?.[0]?.commit).toBe(now.head);
    expect(window?.[2]?.commit).toBe(before.head);
  });

  it("fewer entries than asked for returns what exists", async () => {
    const dir = repo();
    expect(await readReflogWindow(dir, 5)).toHaveLength(1);
  });

  it("an empty subject is kept as an empty string", async () => {
    const dir = repo();
    commit(dir, "two");
    git(dir, "update-ref", "HEAD", "HEAD~1");
    const window = await readReflogWindow(dir, 1);
    expect(window?.[0]?.subject).toBe("");
    expect(window?.[0]?.commit).toBe(git(dir, "rev-parse", "HEAD"));
  });

  it("a count of 0 or less is [] without running git (even outside a repository)", async () => {
    const outside = fresh();
    expect(await readReflogWindow(outside, 0)).toEqual([]);
    expect(await readReflogWindow(outside, -5)).toEqual([]);
    expect(await readReflogWindow(outside, Number.NaN)).toEqual([]);
  });

  it("a count above 1000 is undefined (not clamped: the anchor would be lost)", async () => {
    expect(await readReflogWindow(repo(), 1001)).toBeUndefined();
    expect(await readReflogWindow(repo(), 1000)).toHaveLength(1);
  });

  it("failure is undefined", async () => {
    expect(await readReflogWindow(fresh(), 3)).toBeUndefined();
  });
});

/** The tree-move verdict between a recorded head state and now, the way the wiring computes it. */
async function moveSince(dir: string, before: HeadState): Promise<TreeMove | undefined> {
  const now = await readHead(dir) as HeadState;
  let window: ReflogEntry[] | undefined;
  if (before.reflog !== undefined && now.reflog !== undefined && now.reflog >= before.reflog) {
    window = await readReflogWindow(dir, now.reflog - before.reflog);
  }
  return treeMove(before, now, window);
}

describe("readHead + readReflogWindow + treeMove, real git", REAL_GIT, () => {
  const started = async (): Promise<{ dir: string; before: HeadState }> => {
    const dir = repo();
    commit(dir, "two");
    return { dir, before: await readHead(dir) as HeadState };
  };

  it("git stash and git stash pop with a dirty file is not a move", async () => {
    const { dir, before } = await started();
    writeFileSync(join(dir, "f.txt"), "dirty\n");
    git(dir, "stash");
    git(dir, "stash", "pop");
    expect(await moveSince(dir, before)).toBeUndefined();
  });

  it("git stash -u with an untracked file is not a move", async () => {
    const { dir, before } = await started();
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    git(dir, "stash", "-u");
    git(dir, "stash", "pop");
    expect(await moveSince(dir, before)).toBeUndefined();
  });

  it("git reset (unstage) is not a move", async () => {
    const { dir, before } = await started();
    writeFileSync(join(dir, "f.txt"), "staged\n");
    git(dir, "add", "f.txt");
    git(dir, "reset", "-q");
    expect(await moveSince(dir, before)).toBeUndefined();
  });

  it("git checkout <the current branch> is not a move", async () => {
    const { dir, before } = await started();
    git(dir, "checkout", "-q", "main");
    expect(await moveSince(dir, before)).toBeUndefined();
  });

  it("a commit is not a move", async () => {
    const { dir, before } = await started();
    commit(dir, "three");
    expect(await moveSince(dir, before)).toBeUndefined();
  });

  it("checkout -b x, a commit, checkout main is a move although the branch name is the same", async () => {
    const { dir, before } = await started();
    git(dir, "checkout", "-q", "-b", "x");
    commit(dir, "on x");
    git(dir, "checkout", "-q", "main");
    const now = await readHead(dir) as HeadState;
    expect(now.branch).toBe(before.branch);
    expect(now.head).toBe(before.head);
    expect(await moveSince(dir, before)).toEqual({ kind: "rewritten", detail: "checkout: moving from x to main" });
  });

  it("git reset --hard HEAD~1 is a rewrite", async () => {
    const { dir, before } = await started();
    git(dir, "reset", "-q", "--hard", "HEAD~1");
    expect(await moveSince(dir, before)).toEqual({ kind: "rewritten", detail: "reset: moving to HEAD~1" });
  });

  it("git update-ref HEAD HEAD~1 (an empty subject) is a rewrite", async () => {
    const { dir, before } = await started();
    git(dir, "update-ref", "HEAD", "HEAD~1");
    expect(await moveSince(dir, before)).toEqual({ kind: "rewritten", detail: "an unnamed reflog entry" });
  });

  it("an amend and a merge commit are the producer's own work", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "side");
    commit(dir, "side work");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "m.txt"), "main work\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "main work");
    const before = await readHead(dir) as HeadState;
    git(dir, "commit", "-q", "--amend", "-m", "main work, amended");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    expect(await moveSince(dir, before)).toBeUndefined();
  });

  it("a reflog-less repository (logAllRefUpdates=false) has no count, so the name rule decides", async () => {
    const dir = fresh();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "core.logAllRefUpdates", "false");
    commit(dir, "one");
    const before = await readHead(dir) as HeadState;
    commit(dir, "two");
    expect(before.reflog).toBeUndefined();
    expect(await moveSince(dir, before)).toBeUndefined();
  });
});
