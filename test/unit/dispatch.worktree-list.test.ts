/**
 * #84 P3.3 global QA round 1, QA-G-A2-3: `gitWorktreeList` (the work-root resolution of a role dispatch and the adapter's fresh
 * `external_directory` re-check) runs git the hardened way `listWorktrees` does (role-agents.ts): the absolute git executable
 * selected outside the work-root guards, `hardeningArgs()`, `gitEnvironment()` (no inherited GIT_*, no system/global config),
 * `shell: false` — never a bare `git` looked up on PATH with the plugin's environment. QA-G-A2-2-1: both listings
 * (`gitWorktreeList`, role-agents' `listWorktrees`) pass the user's inherited `safe.directory` values back as `-c` pairs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment, gitExecutable, hardeningArgs } from "../../src/router/git-tools";
import { listWorktrees } from "../../src/router/role-agents";
import { gitWorktreeList, parseWorktreeList } from "../../src/routing/wire/dispatch";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
let repo: string;
let plain: string;

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "router-wt-list-")));
  plain = realpathSync.native(mkdtempSync(join(tmpdir(), "router-wt-plain-")));
  execFileSync(gitExecutable(), ["init", "-q"], { cwd: repo, env: gitEnvironment() });
  // The user's system/global git config is replaced by a test file (QA-G-A2-2-1 reads safe.directory from it); empty by default.
  userGitConfig("");
  vi.mocked(childProcess.spawn).mockClear();
  vi.mocked(childProcess.execFile).mockClear();
});

/** The "inherited" git config the router reads: GIT_CONFIG_GLOBAL names a test file, system config off. */
function userGitConfig(text: string): void {
  const file = join(plain, `gitconfig-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, text);
  vi.stubEnv("GIT_CONFIG_GLOBAL", file);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
}
/** The argv of every `git worktree list` spawned so far. */
const worktreeArgv = (): string[][] => vi.mocked(childProcess.spawn).mock.calls
  .map(([, args]) => [...(args as readonly string[] | undefined ?? [])]).filter(args => args.includes("worktree"));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of [repo, plain]) rmSync(dir, RM);
});

describe("QA-G-A2-3: gitWorktreeList uses the hardened git spawn", () => {
  it("spawns the absolute git executable with the hardening flags and the stripped environment, never a bare `git`", async () => {
    // An inherited GIT_DIR would redirect a plain `git` run; the hardened environment drops every GIT_* variable.
    vi.stubEnv("GIT_DIR", join(plain, "not-a-repository"));
    const porcelain = await gitWorktreeList(repo);
    expect(parseWorktreeList(porcelain).map(path => realpathSync.native(path).toLowerCase())).toEqual([repo.toLowerCase()]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    const calls = vi.mocked(childProcess.spawn).mock.calls.filter(([, args]) => (args as string[] | undefined)?.includes("worktree"));
    expect(calls).toHaveLength(1);
    const [executable, args, options] = calls[0]! as unknown as [string, string[], childProcess.SpawnOptions];
    expect(executable).toBe(gitExecutable());
    expect(args).toEqual([...hardeningArgs(), "worktree", "list", "--porcelain"]);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(repo);
    expect(options.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(Object.keys(options.env ?? {}).some(key => key.toUpperCase() === "GIT_DIR")).toBe(false);
  }, 60_000);

  it("rejects when git fails (not a repository)", async () => {
    await expect(gitWorktreeList(plain)).rejects.toThrow();
  }, 60_000);
});

describe("QA-G-A2-2-1: the user's inherited safe.directory reaches both worktree listings", () => {
  const PAIRS = ["-c", "safe.directory=/srv/repo-a", "-c", "safe.directory=D:/x/y"];
  const LIST = ["worktree", "list", "--porcelain"];

  it("gitWorktreeList passes every inherited safe.directory as `-c safe.directory=<value>` after the hardening flags", async () => {
    userGitConfig("[safe]\n\tdirectory = /srv/repo-a\n\tdirectory = D:/x/y\n");
    await gitWorktreeList(repo);
    expect(worktreeArgv()).toEqual([[...hardeningArgs(), ...PAIRS, ...LIST]]);
  }, 60_000);

  it("listWorktrees (role registration) passes them too", async () => {
    userGitConfig("[safe]\n\tdirectory = /srv/repo-a\n\tdirectory = D:/x/y\n");
    await listWorktrees(repo);
    expect(worktreeArgv()).toEqual([[...hardeningArgs(), ...PAIRS, ...LIST]]);
  }, 60_000);

  it("adds nothing when the user's config has no safe.directory (other inherited keys never become -c pairs here)", async () => {
    userGitConfig("[core]\n\tautocrlf = true\n");
    await gitWorktreeList(repo);
    await listWorktrees(repo);
    expect(worktreeArgv()).toEqual([[...hardeningArgs(), ...LIST], [...hardeningArgs(), ...LIST]]);
  }, 60_000);
});
