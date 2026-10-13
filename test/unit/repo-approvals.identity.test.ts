/**
 * Cross-repo Phase 4 (P4.3): `inspectCandidate` and `verifyIdentity` on real temp repositories
 * (`docs/design/cross-repo-phase4-plan.md` SD-P4-4, -6, -8, -9; QA cases 2, 3, 4).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GitSpawn } from "../../src/routing/roles/admission";
import {
  APPROVE_MAIN_WORKTREE,
  inspectCandidate,
  resetApprovalsState,
  verifyIdentity,
  type CandidateIdentity,
  type InspectDeps,
} from "../../src/routing/roles/approvals";

const isWin = process.platform === "win32";
const linkType = isWin ? "junction" : "dir";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("inspectCandidate and verifyIdentity (real git)", { timeout: 120_000 }, () => {
  let base = "";
  const env: NodeJS.ProcessEnv = {};

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (dir: string, message: string): void => {
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message);
  };
  const repo = (dir: string, message = "init"): string => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    commit(dir, message);
    return dir;
  };
  const deps = (over: InspectDeps = {}): InspectDeps => ({ env: { dir: join(base, "store") }, ...over });
  const identity = async (dir: string, over?: InspectDeps): Promise<CandidateIdentity> => {
    const result = await inspectCandidate(dir, deps(over));
    if (typeof result === "string") throw new Error(`${dir} ${result}`);
    return result;
  };
  /** Git helpers that record every call and fail the test when git would run. */
  const noGit = (): { deps: InspectDeps; calls: string[] } => {
    const calls: string[] = [];
    const record = (name: string) => async (cwd: string): Promise<undefined> => {
      calls.push(`${name} ${cwd}`);
      return undefined;
    };
    return {
      calls,
      deps: deps({
        showToplevel: record("showToplevel"),
        commonDir: record("commonDir"),
        rootCommits: record("rootCommits"),
        origin: record("origin"),
        headInfo: record("headInfo"),
      }),
    };
  };

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-identity-")));
    for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    writeFileSync(join(base, "gitconfig"), "");
    env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
    env.GIT_CONFIG_NOSYSTEM = "1";
    mkdirSync(join(base, "store"));
  }, 120_000);

  afterAll(() => {
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetApprovalsState();
  });

  describe("inspectCandidate", () => {
    it("returns the identity of a main worktree: canonical path and common dir, sorted roots, sanitized origin, branch, head", async () => {
      const dir = repo(join(base, "main-repo"));
      git(dir, "remote", "add", "origin", "https://u:tok@example.invalid/x.git?token=1#frag");
      const root = git(dir, "rev-list", "--max-parents=0", "HEAD");
      const head = git(dir, "rev-parse", "HEAD");
      expect(await identity(dir)).toEqual({
        path: dir,
        commonDir: join(dir, ".git"),
        roots: [root],
        origin: "https://example.invalid/x.git",
        branch: "main",
        head,
      });
    });

    it("reports a detached HEAD and a missing origin", async () => {
      const dir = repo(join(base, "detached"));
      git(dir, "checkout", "-q", "--detach");
      expect(await identity(dir)).toMatchObject({ path: dir, origin: "none", branch: "(detached)", head: git(dir, "rev-parse", "HEAD") });
    });

    it("lists every root commit of HEAD, sorted (a merged orphan history)", async () => {
      const dir = repo(join(base, "two-roots"));
      git(dir, "checkout", "-q", "--orphan", "other");
      commit(dir, "second root");
      git(dir, "checkout", "-q", "main");
      git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "-q", "--allow-unrelated-histories", "-m", "merge", "other");
      const roots = git(dir, "rev-list", "--max-parents=0", "HEAD").split(/\r?\n/).sort();
      expect(roots).toHaveLength(2);
      expect((await identity(dir)).roots).toEqual(roots);
    });

    it("follows a junction to the canonical main worktree", async () => {
      const dir = repo(join(base, "link-target"));
      const link = join(base, "link-to-repo");
      symlinkSync(dir, link, linkType);
      expect(await identity(link)).toMatchObject({ path: dir, commonDir: join(dir, ".git") });
    });

    it("refuses a subdirectory and a plain directory before any git call", async () => {
      const dir = repo(join(base, "with-sub"));
      mkdirSync(join(dir, "src"));
      mkdirSync(join(base, "plain"));
      const { deps: spy, calls } = noGit();
      for (const candidate of [join(dir, "src"), join(base, "plain")]) {
        const problem = await inspectCandidate(candidate, spy);
        expect(problem).toEqual(expect.stringContaining("has no .git directory"));
        expect(problem).toEqual(expect.stringContaining(APPROVE_MAIN_WORKTREE));
      }
      expect(calls).toEqual([]);
    });

    it("refuses a repository without commits", async () => {
      const dir = join(base, "empty");
      mkdirSync(dir);
      git(dir, "init", "-q", "-b", "main");
      expect(await inspectCandidate(dir, deps())).toEqual(expect.stringContaining("has no commits yet"));
    });

    it("refuses a linked worktree (gitfile): approve the main worktree", async () => {
      const dir = repo(join(base, "has-linked"));
      const linked = join(base, "linked-wt");
      git(dir, "worktree", "add", "-q", "-b", "wt", linked);
      const { deps: spy, calls } = noGit();
      expect(await inspectCandidate(linked, spy)).toBe(
        `has a .git file (a linked worktree, a submodule or a separate git dir) instead of a .git directory; ${APPROVE_MAIN_WORKTREE}`,
      );
      expect(calls).toEqual([]);
    });

    it("refuses a separate git dir (gitfile)", async () => {
      const work = join(base, "sep-work");
      git(base, "init", "-q", "-b", "main", "--separate-git-dir", join(base, "sep.git"), work);
      commit(work, "init");
      expect(await inspectCandidate(work, deps())).toEqual(expect.stringContaining(`has a .git file`));
    });

    it("refuses a .git that is a link (junction) to another repository's git directory", async () => {
      const dir = repo(join(base, "git-owner"));
      const borrower = join(base, "git-borrower");
      mkdirSync(borrower);
      symlinkSync(join(dir, ".git"), join(borrower, ".git"), linkType);
      const { deps: spy, calls } = noGit();
      expect(await inspectCandidate(borrower, spy)).toBe(`has a .git link instead of a .git directory; ${APPROVE_MAIN_WORKTREE}`);
      expect(calls).toEqual([]);
    });

    it("refuses protected locations (equal, ancestor) and a filesystem root before any git call", async () => {
      const { deps: spy, calls } = noGit();
      // The long form: the host's home may be spelled with an 8.3 segment, which the text check refuses first.
      expect(await inspectCandidate(realpathSync.native(homedir()), spy)).toEqual(expect.stringContaining("is the user profile"));
      expect(await inspectCandidate(parse(base).root, spy)).toBe("is a drive or filesystem root");
      expect(await inspectCandidate(join(base, "store"), spy)).toEqual(expect.stringContaining("is the approvals store directory"));
      expect(await inspectCandidate(base, spy)).toEqual(expect.stringContaining("contains the approvals store directory"));
      expect(calls).toEqual([]);
    });

    it("refuses an excluded path on its text and on its canonical form before any git call", async () => {
      const target = repo(join(base, "excl", "r"));
      const link = join(base, "excl-link");
      symlinkSync(target, link, linkType);
      const { deps: spy, calls } = noGit();
      const exclude = [join(base, "excl", "*")];
      expect(await inspectCandidate(target, { ...spy, exclude })).toEqual(expect.stringContaining("is excluded by routing.repoExclude"));
      expect(await inspectCandidate(link, { ...spy, exclude })).toEqual(expect.stringMatching(/^resolves to .*, which is excluded by routing\.repoExclude/));
      expect(calls).toEqual([]);
    });

    it("refuses an unsafe text before any filesystem call", async () => {
      const boom = (): never => {
        throw new Error("unexpected filesystem call");
      };
      const spy = deps({ realpath: boom, lstat: boom });
      expect(await inspectCandidate("relative/repo", spy)).toEqual(expect.stringContaining("absolute"));
      expect(await inspectCandidate([base, "x", "..", "y"].join(sep), spy)).toEqual(expect.stringContaining(".. segment"));
      if (isWin) {
        expect(await inspectCandidate("\\\\host\\share\\repo", spy)).toEqual(expect.stringContaining("network or device path"));
        expect(await inspectCandidate("D:\\git\\REPO~1", spy)).toEqual(expect.stringContaining("8.3"));
      }
    });

    it("gives up when git does not answer within the bound (injected spawn)", async () => {
      const dir = repo(join(base, "slow"));
      const hang: GitSpawn = () => new Promise(() => undefined);
      const started = Date.now();
      expect(await inspectCandidate(dir, deps({ git: { spawn: hang, timeoutMs: 100 } }))).toEqual(expect.stringContaining("timed out"));
      expect(Date.now() - started).toBeLessThan(5_000);
      resetApprovalsState();
      const timedOut: GitSpawn = async () => ({ code: null, output: Buffer.alloc(0), truncated: false, failure: "timeout" });
      expect(await inspectCandidate(dir, deps({ git: { spawn: timedOut } }))).toEqual(expect.stringContaining("timed out"));
    });

    it("caches the git answers 5 s per canonical path; the checks before git run every time", async () => {
      const dir = repo(join(base, "cached"));
      const clock = { t: 1_000 };
      let runs = 0;
      const fake = deps({
        now: () => clock.t,
        showToplevel: async () => {
          runs++;
          return dir;
        },
        commonDir: async () => join(dir, ".git"),
        rootCommits: async () => [SHA_A],
        origin: async () => undefined,
        headInfo: async () => ({ branch: "main", head: SHA_B }),
      });
      expect(await inspectCandidate(dir, fake)).toMatchObject({ path: dir, roots: [SHA_A], head: SHA_B });
      clock.t += 4_999;
      expect(await inspectCandidate(dir, fake)).toMatchObject({ path: dir });
      expect(runs).toBe(1);
      // An exclusion added meanwhile wins at once: the text checks are not cached.
      expect(await inspectCandidate(dir, { ...fake, exclude: [dir] })).toEqual(expect.stringContaining("is excluded"));
      clock.t += 1;
      expect(await inspectCandidate(dir, fake)).toMatchObject({ path: dir });
      expect(runs).toBe(2);
    });
  });

  describe("verifyIdentity", () => {
    it("holds for the approved repository and fails once the folder is replaced by another repository", async () => {
      const dir = repo(join(base, "swap"), "first");
      const approved = await identity(dir);
      expect(await verifyIdentity(approved)).toBeUndefined();
      renameSync(dir, join(base, "swap-old"));
      repo(dir, "second");
      expect(await verifyIdentity(approved)).toEqual(expect.stringContaining("has other root commits"));
    });

    it("fails after an orphan-branch checkout (another root set)", async () => {
      const dir = repo(join(base, "orphan"));
      const approved = await identity(dir);
      git(dir, "checkout", "-q", "--orphan", "other");
      commit(dir, "orphan root");
      expect(await verifyIdentity(approved)).toEqual(expect.stringContaining("has other root commits"));
    });

    it("fails for a junction to the approved repository and for an approved path turned into a junction", async () => {
      const dir = repo(join(base, "turned"));
      const approved = await identity(dir);
      const link = join(base, "turned-link");
      symlinkSync(dir, link, linkType);
      expect(await verifyIdentity({ ...approved, path: link })).toEqual(expect.stringContaining(`now resolves to ${dir}`));
      const moved = join(base, "turned-real");
      renameSync(dir, moved);
      symlinkSync(moved, dir, linkType);
      expect(await verifyIdentity(approved)).toEqual(expect.stringContaining(`now resolves to ${moved}`));
    });

    it("fails for a removed folder, a gitfile and another common dir", async () => {
      const dir = repo(join(base, "verify-main"));
      const approved = await identity(dir);
      expect(await verifyIdentity({ ...approved, path: join(base, "gone") })).toBe("no longer resolves");
      const linked = join(base, "verify-linked");
      git(dir, "worktree", "add", "-q", "-b", "wt", linked);
      expect(await verifyIdentity({ ...approved, path: linked })).toEqual(expect.stringContaining("has a .git file"));
      expect(await verifyIdentity({ ...approved, commonDir: join(base, "elsewhere.git") })).toEqual(expect.stringContaining("now uses the git directory"));
    });

    it("caches the root commits per (common dir, HEAD commit)", async () => {
      const dir = repo(join(base, "roots-cache"));
      const approved = await identity(dir);
      let listed = 0;
      const counting = {
        rootCommits: async (): Promise<string[]> => {
          listed++;
          return [...approved.roots];
        },
      };
      expect(await verifyIdentity(approved, counting)).toBeUndefined();
      expect(await verifyIdentity(approved, counting)).toBeUndefined();
      expect(listed).toBe(1);
      commit(dir, "next");
      expect(await verifyIdentity(approved, counting)).toBeUndefined();
      expect(listed).toBe(2);
    });
  });
});
