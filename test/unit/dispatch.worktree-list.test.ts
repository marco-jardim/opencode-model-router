/**
 * #84 P3.3 global QA round 1, QA-G-A2-3: `gitWorktreeList` (the work-root resolution of a role dispatch and the adapter's fresh
 * `external_directory` re-check) runs git the hardened way `listWorktrees` does (role-agents.ts): the absolute git executable
 * selected outside the work-root guards, `hardeningArgs()`, `gitEnvironment()` (no inherited GIT_*, no system/global config),
 * `shell: false` — never a bare `git` looked up on PATH with the plugin's environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment, gitExecutable, hardeningArgs } from "../../src/router/git-tools";
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
  vi.mocked(childProcess.spawn).mockClear();
  vi.mocked(childProcess.execFile).mockClear();
});
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
