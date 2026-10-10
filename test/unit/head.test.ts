/**
 * test/unit/head.test.ts — the cheap HEAD reader, against REAL git in temp repositories.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readHeadState, readReflogSubjects } from "../../src/verify/head";

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

describe("readHeadState", () => {
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

describe("readReflogSubjects", () => {
  it("newest first", async () => {
    const dir = repo();
    commit(dir, "two");
    git(dir, "checkout", "-q", "-b", "feat");
    git(dir, "reset", "-q", "--hard", "HEAD");
    const subjects = await readReflogSubjects(dir, 10);
    expect(subjects).toEqual([
      "reset: moving to HEAD",
      "checkout: moving from main to feat",
      "commit: two",
      "commit (initial): one",
    ]);
  });

  it("returns only the newest N", async () => {
    const dir = repo();
    commit(dir, "two");
    commit(dir, "three");
    expect(await readReflogSubjects(dir, 2)).toEqual(["commit: three", "commit: two"]);
  });

  it("a count of 0 or less is [] without running git (even outside a repository)", async () => {
    const outside = fresh();
    expect(await readReflogSubjects(outside, 0)).toEqual([]);
    expect(await readReflogSubjects(outside, -5)).toEqual([]);
    expect(await readReflogSubjects(outside, Number.NaN)).toEqual([]);
  });

  it("a count above 1000 is clamped, not rejected", async () => {
    const dir = repo();
    expect(await readReflogSubjects(dir, 5000)).toEqual(["commit (initial): one"]);
  });

  it("failure is undefined", async () => {
    expect(await readReflogSubjects(fresh(), 3)).toBeUndefined();
  });
});
