import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hardeningArgs } from "../../src/router/git-tools";
import { GIT_BOUND_MS, gitBounded, gitHeadInfo, gitOrigin, gitRootCommits, type GitSpawn } from "../../src/routing/roles/admission";

/** P4.3: the hardened, bounded git helpers behind repository approvals, against real temporary repositories. */
describe("repository approval git helpers", { timeout: 60_000 }, () => {
  let base = "";
  const env: NodeJS.ProcessEnv = {};
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  const commit = (cwd: string, message: string): string => {
    git(cwd, ...identity, "commit", "-q", "--allow-empty", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const repo = (name: string): string => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    return dir;
  };

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-approvals-git-")));
    for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    writeFileSync(join(base, "gitconfig"), "");
    env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
    env.GIT_CONFIG_NOSYSTEM = "1";
  });

  afterAll(() => {
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  it("lists the root commit of a normal repository once, whatever follows it", async () => {
    const dir = repo("normal");
    const root = commit(dir, "first");
    commit(dir, "second");
    commit(dir, "third");
    expect(await gitRootCommits(dir)).toEqual([root]);
  });

  it("adds the root of an orphan branch once it is merged into HEAD, sorted", async () => {
    const dir = repo("orphan");
    const mainRoot = commit(dir, "main root");
    git(dir, "checkout", "-q", "--orphan", "other");
    const otherRoot = commit(dir, "other root");
    // HEAD on the orphan branch reaches only its own root.
    expect(await gitRootCommits(dir)).toEqual([otherRoot]);
    git(dir, "checkout", "-q", "main");
    expect(await gitRootCommits(dir)).toEqual([mainRoot]);
    git(dir, ...identity, "merge", "-q", "--no-ff", "--allow-unrelated-histories", "--no-edit", "other");
    expect(await gitRootCommits(dir)).toEqual([mainRoot, otherRoot].sort());
  });

  it("gives undefined for a repository without commits", async () => {
    const dir = repo("empty");
    expect(await gitRootCommits(dir)).toBeUndefined();
    expect(await gitHeadInfo(dir)).toBeUndefined();
    expect(await gitOrigin(dir)).toBeUndefined();
  });

  it("reports the branch and full head, and no branch when HEAD is detached", async () => {
    const dir = repo("head");
    const first = commit(dir, "first");
    expect(await gitHeadInfo(dir)).toEqual({ branch: "main", head: first });
    git(dir, "checkout", "-q", "-b", "feat/login");
    const second = commit(dir, "second");
    expect(await gitHeadInfo(dir)).toEqual({ branch: "feat/login", head: second });
    git(dir, "checkout", "-q", "--detach", first);
    const detached = await gitHeadInfo(dir);
    expect(detached).toEqual({ branch: undefined, head: first });
    expect(detached?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns origin raw, unsanitised, and undefined without one", async () => {
    const dir = repo("origin");
    commit(dir, "first");
    expect(await gitOrigin(dir)).toBeUndefined();
    const url = "https://user:secret@example.invalid/team/x.git?token=1#frag";
    git(dir, "remote", "add", "origin", url);
    expect(await gitOrigin(dir)).toBe(url);
    git(dir, "remote", "set-url", "origin", "git@example.invalid:team/x.git");
    expect(await gitOrigin(dir)).toBe("git@example.invalid:team/x.git");
  });

  it("gives undefined for a directory that is not a repository, a subdirectory of one, and a missing path", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain, { recursive: true });
    const dir = repo("outer");
    commit(dir, "first");
    git(dir, "remote", "add", "origin", "https://example.invalid/outer.git");
    const sub = join(dir, "src");
    mkdirSync(sub);
    const missing = join(base, "missing");
    for (const cwd of [plain, sub, missing]) {
      expect(await gitRootCommits(cwd)).toBeUndefined();
      expect(await gitOrigin(cwd)).toBeUndefined();
      expect(await gitHeadInfo(cwd)).toBeUndefined();
    }
    expect(await gitBounded(plain, ["rev-parse", "--show-toplevel"])).toEqual({ ok: false, failure: "exit", code: 128 });
    expect(await gitBounded(missing, ["rev-parse", "--show-toplevel"])).toEqual({ ok: false, failure: "spawn", detail: expect.any(String) });
  });

  it("is not confused by a file named HEAD in the worktree", async () => {
    const dir = repo("head-file");
    const root = commit(dir, "first");
    writeFileSync(join(dir, "HEAD"), "not a revision\n");
    expect(await gitRootCommits(dir)).toEqual([root]);
    expect(await gitHeadInfo(dir)).toEqual({ branch: "main", head: root });
  });

  it("returns git's raw stdout on success", async () => {
    const dir = repo("raw");
    const root = commit(dir, "first");
    expect(await gitBounded(dir, ["rev-parse", "HEAD"])).toEqual({ ok: true, stdout: `${root}\n` });
  });

  it("spawns hardened git: the hardening arguments, a ceiling at the parent, the bound and the output cap", async () => {
    const dir = repo("hardened");
    const seen: { executable: string; args: readonly string[]; cwd: string; options: Parameters<GitSpawn>[3] }[] = [];
    const spawn: GitSpawn = (executable, args, cwd, options) => {
      seen.push({ executable, args, cwd, options });
      return Promise.resolve({ code: 0, output: Buffer.from("x\n"), truncated: false });
    };
    expect(await gitBounded(dir, ["rev-list", "--max-parents=0", "HEAD", "--"], { spawn })).toEqual({ ok: true, stdout: "x\n" });
    const [call] = seen;
    expect(seen).toHaveLength(1);
    expect(isAbsolute(call?.executable ?? "")).toBe(true);
    expect(call?.cwd).toBe(dir);
    expect(call?.args.slice(0, hardeningArgs().length)).toEqual(hardeningArgs());
    expect(call?.args.slice(-4)).toEqual(["rev-list", "--max-parents=0", "HEAD", "--"]);
    expect(call?.options.env.GIT_CEILING_DIRECTORIES).toBe(dirname(dir));
    expect(call?.options.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(call?.options.settleOnFailure).toBe(true);
    expect(call?.options.maxBytes).toBe(64 * 1024);
    expect(call?.options.timeoutMs).toBeGreaterThan(0);
    expect(call?.options.timeoutMs).toBeLessThanOrEqual(GIT_BOUND_MS);
    // The helpers go through the same path.
    seen.length = 0;
    await gitRootCommits(dir, { spawn });
    expect(seen[0]?.args.slice(-5)).toEqual(["--no-replace-objects", "rev-list", "--max-parents=0", "HEAD", "--"]);
  });

  it("types each failure: timeout, non-zero exit, truncated output, spawn error", async () => {
    const dir = repo("failures");
    const answer = (result: Awaited<ReturnType<GitSpawn>>): GitSpawn => () => Promise.resolve(result);
    const empty = Buffer.from("");
    expect(await gitBounded(dir, ["status"], { spawn: answer({ code: null, output: empty, truncated: false, failure: "git timed out" }) }))
      .toEqual({ ok: false, failure: "timeout", code: null, detail: "git timed out" });
    expect(await gitBounded(dir, ["status"], { spawn: answer({ code: 128, output: empty, truncated: false }) }))
      .toEqual({ ok: false, failure: "exit", code: 128 });
    expect(await gitBounded(dir, ["status"], { spawn: answer({ code: null, output: Buffer.from("abc"), truncated: true }) }))
      .toEqual({ ok: false, failure: "truncated", code: null });
    const broken: GitSpawn = () => Promise.reject(new Error("spawn git ENOENT"));
    expect(await gitBounded(dir, ["status"], { spawn: broken })).toEqual({ ok: false, failure: "spawn", detail: "spawn git ENOENT" });
    expect(await gitRootCommits(dir, { spawn: broken })).toBeUndefined();
    expect(await gitOrigin(dir, { spawn: broken })).toBeUndefined();
    expect(await gitHeadInfo(dir, { spawn: broken })).toBeUndefined();
  });

  it("gives up within its bound when git never settles", async () => {
    const dir = repo("hang");
    commit(dir, "first");
    const hang: GitSpawn = () => new Promise(() => undefined);
    const started = performance.now();
    const result = await gitBounded(dir, ["rev-list", "--max-parents=0", "HEAD", "--"], { spawn: hang, timeoutMs: 100 });
    const elapsed = performance.now() - started;
    expect(result).toEqual({ ok: false, failure: "timeout", detail: expect.stringContaining("did not settle") });
    expect(elapsed).toBeLessThan(2_000);
    const helpers = performance.now();
    expect(await gitRootCommits(dir, { spawn: hang, timeoutMs: 100 })).toBeUndefined();
    expect(await gitOrigin(dir, { spawn: hang, timeoutMs: 100 })).toBeUndefined();
    expect(await gitHeadInfo(dir, { spawn: hang, timeoutMs: 100 })).toBeUndefined();
    expect(performance.now() - helpers).toBeLessThan(6_000);
  });
});
