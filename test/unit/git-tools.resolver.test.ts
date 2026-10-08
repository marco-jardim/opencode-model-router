import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkWorkRootAnswer, gitEnvironment, gitExecutable, gitTools, mainWorktree, workRootGuards, type GitWorkRootResolver, type WorkRootAnswer,
} from "../../src/router/git-tools";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const WIN = process.platform === "win32";
const SPAWN_TIMEOUT = 90_000;
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const REFUSED = "[router_git] error: refused: this role session has no bound work root (I9)";
const NOT_ROLE: WorkRootAnswer = { role: false };
const bind = (root: string | null): WorkRootAnswer => ({ role: true, root });
let bound: string;
let other: string;
let plain: string;

type Execute = (args: unknown, context: unknown) => Promise<string>;

function git(dir: string, ...args: string[]) {
  return execFileSync(gitExecutable(), ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd: dir, env: gitEnvironment(), encoding: "utf8" });
}
function repository(dir: string, file: string) {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com"); git(dir, "config", "user.name", "t"); git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, file), "x\n");
  writeFileSync(join(dir, "sub", "inner.txt"), "y\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
}
function context(sessionID: string, directory: string) {
  return { sessionID, messageID: "m", agent: "runner", directory, worktree: directory, abort: new AbortController().signal,
    metadata: () => undefined, ask: async () => undefined };
}
const call = (resolver: GitWorkRootResolver | undefined, directory: string, sessionID = "child", name = "router_git_ls_files", args: unknown = {}) => {
  const tools = gitTools(resolver ? { resolveWorkRoot: resolver } : undefined);
  return (tools[name]!.execute as unknown as Execute)(args, context(sessionID, directory));
};
const gitSpawns = () => vi.mocked(childProcess.spawn).mock.calls.length;

beforeEach(() => {
  vi.mocked(childProcess.spawn).mockClear();
  bound = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-bound-")));
  other = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-other-")));
  plain = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-plain-")));
  repository(bound, "bound.txt");
  repository(other, "other.txt");
  vi.mocked(childProcess.spawn).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [bound, other, plain]) rmSync(dir, RM);
});

describe("router_git work-root resolver", () => {
  it("{ role: false } is byte-identical to no resolver (I1)", async () => {
    for (const [name, args] of [["router_git_ls_files", {}], ["router_git_status", {}], ["router_git_log", { limit: 1 }], ["router_git_diff", { mode: "stat" }]] as const) {
      const without = await call(undefined, other, "child", name, args);
      const explicit = await call(() => NOT_ROLE, other, "child", name, args);
      expect(explicit).toStrictEqual(without);
    }
    expect(await call(() => NOT_ROLE, other)).toContain("other.txt");
    expect(await call(() => NOT_ROLE, bound)).toContain("bound.txt");
  }, SPAWN_TIMEOUT);

  it("{ role: true, root: null } refuses with the I9 message and spawns nothing, for every operation", async () => {
    for (const name of ["router_git_ls_files", "router_git_status", "router_git_log", "router_git_diff", "router_git_show", "router_git_blame"]) {
      expect(await call(() => bind(null), bound, "child", name)).toBe(REFUSED);
    }
    expect(gitSpawns()).toBe(0);
  }, SPAWN_TIMEOUT);

  it("a bound root names the repository, whatever context.directory and worktree say", async () => {
    const out = await call(() => bind(bound), other);
    expect(out).toContain("bound.txt");
    expect(out).not.toContain("other.txt");
    expect(await call(() => bind(bound), plain)).toContain("bound.txt");
  }, SPAWN_TIMEOUT);

  it("a subdirectory of a checkout is inspected through that checkout, never another one", async () => {
    const out = await call(() => bind(join(bound, "sub")), other);
    expect(out).toContain("inner.txt");
    expect(out).not.toContain("other.txt");
  }, SPAWN_TIMEOUT);

  it("a real sibling worktree (git worktree add) is inspected there while context.directory names the main checkout", async () => {
    const sibling = join(plain, "sibling-worktree");
    git(bound, "worktree", "add", "-q", "--detach", sibling);
    writeFileSync(join(sibling, "only-in-sibling.txt"), "z\n");
    writeFileSync(join(bound, "only-in-main.txt"), "m\n");
    const status = await call(() => bind(sibling), bound, "child", "router_git_status");
    expect(status).toContain("only-in-sibling.txt");
    expect(status).not.toContain("only-in-main.txt");
    const guards = workRootGuards(realpathSync.native(sibling)).map(dir => dir.toLowerCase());
    expect(guards).toContain(realpathSync.native(sibling).toLowerCase());
    expect(guards).toContain(bound.toLowerCase()); // the main worktree of the sibling (QA-P13-1-6)
    expect(mainWorktree(realpathSync.native(sibling))?.toLowerCase()).toBe(bound.toLowerCase());
    expect(mainWorktree(bound)).toBe(bound);
    expect(mainWorktree(plain)).toBeUndefined();
  }, SPAWN_TIMEOUT);

  it("passes the session id and is consulted on every call", async () => {
    const seen: string[] = [];
    const resolver: GitWorkRootResolver = sessionID => { seen.push(sessionID); return sessionID === "a" ? bind(bound) : sessionID === "b" ? bind(other) : sessionID === "c" ? bind(null) : NOT_ROLE; };
    expect(await call(resolver, plain, "a")).toContain("bound.txt");
    expect(await call(resolver, plain, "b")).toContain("other.txt");
    expect(await call(resolver, plain, "c")).toBe(REFUSED);
    expect(await call(resolver, other, "d")).toContain("other.txt");
    expect(seen).toEqual(["a", "b", "c", "d"]);
  }, SPAWN_TIMEOUT);

  it("a throwing resolver is reported as a tool error and nothing is spawned", async () => {
    expect(await call(() => { throw new Error("binding lookup failed"); }, bound)).toBe("[router_git] error: binding lookup failed");
    expect(await call(() => { throw new Error("lookup https://u:secret99@host/x failed"); }, bound)).not.toContain("secret99");
    expect(gitSpawns()).toBe(0);
  }, SPAWN_TIMEOUT);

  it("fails closed on a malformed answer: undefined, null, a bare string or a missing root never fall back to context.directory", async () => {
    for (const answer of [undefined, null, bound, {}, { role: "yes" }, { role: true }, { role: 1, root: bound }]) {
      const out = await call(() => answer as unknown as WorkRootAnswer, bound);
      expect(out).toBe("[router_git] error: Invalid work-root answer: expected { role: false } or { role: true, root }");
    }
    expect(gitSpawns()).toBe(0);
  }, SPAWN_TIMEOUT);

  it("a relative, root-relative, drive-relative, empty or non-string root is refused as not absolute, spawning nothing", async () => {
    const roots: unknown[] = ["relative/dir", "", 42, {}, ...(WIN ? ["\\tmp\\x", "C:tmp", "/tmp/x"] : ["tmp/x"])];
    for (const root of roots) {
      expect(await call(() => ({ role: true, root }) as unknown as WorkRootAnswer, bound)).toBe("[router_git] error: Bound work root is not an absolute path");
    }
    expect(gitSpawns()).toBe(0);
    expect(checkWorkRootAnswer({ role: false, root: bound })).toEqual({ role: false });
    expect(checkWorkRootAnswer({ role: true, root: bound })).toEqual({ role: true, root: bound });
  }, SPAWN_TIMEOUT);

  it("a bound root that is not a repository is reported as an error, not a fallback to context.directory", async () => {
    const out = await call(() => bind(plain), bound);
    expect(out).toMatch(/^\[router_git\] error: /);
    expect(out).not.toContain("bound.txt");
  }, SPAWN_TIMEOUT);

  it("a bound root that does not exist is reported as an error", async () => {
    expect(await call(() => bind(join(plain, "missing")), bound)).toMatch(/^\[router_git\] error: /);
  }, SPAWN_TIMEOUT);
});
