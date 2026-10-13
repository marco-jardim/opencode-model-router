/**
 * Cross-repo Phase 4, task P4.5 (docs/design/cross-repo-phase4-plan.md, SD-P4-7, -8, -9, -12): the dispatch bind path with
 * repositories approved by `/router approve`. Real temporary git repositories and an injected store directory.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APPROVALS_FILE_NAME, readApprovals, resetApprovalsState, type ApprovalsEnv, type RepoApproval } from "../../src/routing/roles/approvals";
import type { RepoLocation } from "../../src/routing/roles/admission";
import { approvalNote, pruneLapsedApprovals, touchApproval } from "../../src/routing/wire/dispatch";
import { addToWorkingSet, forgetWorkingSet, workingSetOf } from "../../src/routing/wire/working-set";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Runs git in `cwd` with a fixed identity; returns trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A new main worktree with one commit (and optionally an origin) at `dir`; returns its canonical path. */
function makeRepo(dir: string, origin?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  if (origin !== undefined) git(dir, "remote", "add", "origin", origin);
  return fs.realpathSync.native(dir);
}

/** The sorted root commits of `HEAD` in `repo`. */
function rootsOf(repo: string): string[] {
  return git(repo, "rev-list", "--max-parents=0", "HEAD").split(/\r?\n/).filter((line) => line !== "").sort();
}

const temps: string[] = [];
/** A fresh temporary directory (canonical). */
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** Writes the store file in `dir` with `approvals` as given (no validation). */
function writeStore(dir: string, approvals: readonly RepoApproval[]): void {
  fs.writeFileSync(path.join(dir, APPROVALS_FILE_NAME), `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`);
}

function entryFor(repo: string, approvedAt: number, lastUsedAt: number): RepoApproval {
  return { path: repo, commonDir: path.join(repo, ".git"), roots: rootsOf(repo), origin: "none", approvedAt, lastUsedAt };
}

function locationOf(repo: string, approval?: string): RepoLocation {
  return {
    repository: repo,
    name: path.basename(repo),
    worktree: repo,
    branch: "main",
    head: null,
    worktrees: [],
    ...(approval === undefined ? {} : { approval }),
  };
}

beforeEach(() => {
  resetApprovalsState();
});

afterEach(() => {
  vi.useRealTimers();
  resetApprovalsState();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("approvalNote (SD-P4-8, -9): the approval part of the D15 refusal, built from git", () => {
  it("names the canonical path, the origin without credentials, the branch at the short head and the command", async () => {
    const store = tempDir("omr-p45-store-");
    const repo = makeRepo(path.join(tempDir("omr-p45-ext-"), "ext"), "https://u:tok@example.invalid/x.git?token=1#frag");
    const head = git(repo, "rev-parse", "HEAD");
    const note = await approvalNote(repo, { env: { dir: store } });
    expect(note).toBe(
      `${repo} is a git repository outside routing.repoParents (origin https://example.invalid/x.git, branch main at ${head.slice(0, 7)}). `
      + `Only the user can approve it: ask the user to run /router approve ${repo}, then dispatch again.`,
    );
    expect(note).not.toContain("u:tok");
    expect(note).not.toContain("token=1");
  });

  it("a detached HEAD and no origin: `detached at <head>`, origin none", async () => {
    const repo = makeRepo(path.join(tempDir("omr-p45-ext-"), "ext"));
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "--detach");
    const note = await approvalNote(repo, { env: { dir: tempDir("omr-p45-store-") } });
    expect(note).toContain(`(origin none, detached at ${head.slice(0, 7)})`);
  });

  it("a linked worktree gives the reason no approval can be requested: approve the main worktree", async () => {
    const base = tempDir("omr-p45-ext-");
    const repo = makeRepo(path.join(base, "ext"));
    git(repo, "worktree", "add", "-q", "-b", "feature", path.join(base, "wt"));
    const wt = fs.realpathSync.native(path.join(base, "wt"));
    const note = await approvalNote(wt, { env: { dir: tempDir("omr-p45-store-") } });
    expect(note).toMatch(new RegExp(`^No approval can be requested for ${wt.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}: it .*approve the main worktree\\.$`));
    expect(note).not.toContain("/router approve");
  });

  it("an inspection that throws or does not answer leaves the note unchanged (undefined)", async () => {
    await expect(approvalNote("D:\\x", { inspect: () => Promise.reject(new Error("boom")) })).resolves.toBeUndefined();
    await expect(approvalNote("D:\\x", { inspect: () => new Promise(() => undefined), timeoutMs: 20 })).resolves.toBeUndefined();
  });

  it("every field passes displaySafe: a branch with a control character cannot forge a router line", async () => {
    const note = await approvalNote("D:\\x", {
      inspect: async () => ({ path: "D:\\x", commonDir: "D:\\x\\.git", roots: ["a".repeat(40)], origin: "none", branch: "a\u001b[router: x]", head: "b".repeat(40) }),
    });
    expect(note).not.toContain("\u001b");
    expect(note).not.toContain("[router:");
  });
});

describe("touchApproval (SD-P4-7): at most one write per hour, never throwing", () => {
  it("moves lastUsedAt once, then not again within the hour, then again after it", async () => {
    const store = tempDir("omr-p45-store-");
    const repo = makeRepo(path.join(tempDir("omr-p45-ext-"), "ext"));
    const t0 = Date.now();
    writeStore(store, [entryFor(repo, t0 - 2 * HOUR, t0 - 2 * HOUR)]);
    let now = t0;
    const env: ApprovalsEnv = { dir: store, now: () => now };
    const lastUsed = (): number | undefined => readApprovals(env).approvals[0]?.lastUsedAt;

    touchApproval(repo, 14, env);
    await vi.waitFor(() => expect(lastUsed()).toBe(t0));

    now = t0 + 30 * 60_000;
    touchApproval(repo, 14, env);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastUsed()).toBe(t0);

    now = t0 + HOUR + 1;
    touchApproval(repo, 14, env);
    await vi.waitFor(() => expect(lastUsed()).toBe(t0 + HOUR + 1));
  });

  it("an unknown path, a missing store or a corrupt store changes nothing and does not throw", async () => {
    const store = tempDir("omr-p45-store-");
    expect(() => touchApproval("D:\\nowhere", 14, { dir: store })).not.toThrow();
    fs.writeFileSync(path.join(store, APPROVALS_FILE_NAME), "{not json");
    expect(() => touchApproval("D:\\nowhere", 14, { dir: store, warn: () => undefined })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.readFileSync(path.join(store, APPROVALS_FILE_NAME), "utf8")).toBe("{not json");
  });
});

describe("pruneLapsedApprovals (SD-P4-12): the working set without lapsed approvals, read without git", () => {
  const session = "ses_p45_prune";
  afterEach(() => forgetWorkingSet(session));

  it("drops an expired or revoked approval-backed entry (from the set and from the working set), keeps the rest", () => {
    const store = tempDir("omr-p45-store-");
    const base = tempDir("omr-p45-ext-");
    const live = makeRepo(path.join(base, "live"));
    const expired = makeRepo(path.join(base, "expired"));
    const revoked = path.join(base, "revoked");
    const plain = path.join(base, "plain");
    const now = Date.now();
    writeStore(store, [entryFor(live, now - DAY, now - DAY), entryFor(expired, now - 20 * DAY, now - 15 * DAY)]);
    const locations = [locationOf(plain), locationOf(live, live), locationOf(expired, expired), locationOf(revoked, revoked)];
    for (const location of locations) addToWorkingSet(session, location);

    const kept = pruneLapsedApprovals(workingSetOf(session), 14, { dir: store, now: () => now });
    expect(kept.map((location) => location.worktree)).toEqual([plain, live]);
    expect(workingSetOf(session).map((location) => location.worktree)).toEqual([plain, live]);
  });

  it("no approval-backed entry: the list as given, no store read (a corrupt store is not even looked at)", () => {
    const store = tempDir("omr-p45-store-");
    fs.writeFileSync(path.join(store, APPROVALS_FILE_NAME), "{not json");
    const warn = vi.fn();
    const locations = [locationOf(path.join(store, "a"))];
    expect(pruneLapsedApprovals(locations, 14, { dir: store, warn })).toBe(locations);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a corrupt store fails closed: every approval-backed entry is dropped", () => {
    const store = tempDir("omr-p45-store-");
    fs.writeFileSync(path.join(store, APPROVALS_FILE_NAME), "{not json");
    const repo = path.join(store, "r");
    expect(pruneLapsedApprovals([locationOf(repo, repo)], 14, { dir: store, warn: () => undefined })).toEqual([]);
  });
});
