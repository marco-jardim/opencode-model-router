import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment, gitExecutable, gitTools, type GitWorkRootResolver } from "../../src/router/git-tools";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const SPAWN_TIMEOUT = 90_000;
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const REFUSED = "[router_git] error: refused: this role session has no bound work root (I9)";
let bound: string;
let other: string;
let plain: string;

type Execute = (args: unknown, context: unknown) => Promise<string>;

function repository(dir: string, file: string) {
  const git = (...args: string[]) => execFileSync(gitExecutable(), ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd: dir, env: gitEnvironment(), encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, file), "x\n");
  writeFileSync(join(dir, "sub", "inner.txt"), "y\n");
  git("add", "-A"); git("commit", "-qm", "init");
}
function context(sessionID: string, directory: string) {
  return { sessionID, messageID: "m", agent: "runner", directory, worktree: directory, abort: new AbortController().signal,
    metadata: () => undefined, ask: async () => undefined };
}
const call = (resolver: GitWorkRootResolver | undefined, directory: string, sessionID = "child", name = "router_git_ls_files") => {
  const tools = gitTools(resolver ? { resolveWorkRoot: resolver } : undefined);
  return (tools[name]!.execute as unknown as Execute)({}, context(sessionID, directory));
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
  it("undefined keeps today's behaviour: context.directory decides", async () => {
    expect(await call(() => undefined, other)).toContain("other.txt");
    expect(await call(undefined, other)).toContain("other.txt");
    expect(await call(() => undefined, bound)).toContain("bound.txt");
  }, SPAWN_TIMEOUT);

  it("null refuses with the I9 message and spawns nothing, for every operation", async () => {
    for (const name of ["router_git_ls_files", "router_git_status", "router_git_log", "router_git_diff", "router_git_show", "router_git_blame"]) {
      expect(await call(() => null, bound, "child", name)).toBe(REFUSED);
    }
    expect(gitSpawns()).toBe(0);
  }, SPAWN_TIMEOUT);

  it("a string names the root, whatever context.directory and worktree say", async () => {
    const out = await call(() => bound, other);
    expect(out).toContain("bound.txt");
    expect(out).not.toContain("other.txt");
    expect(await call(() => bound, plain)).toContain("bound.txt");
  }, SPAWN_TIMEOUT);

  it("a subdirectory of a checkout is inspected through that checkout, never another one", async () => {
    const out = await call(() => join(bound, "sub"), other);
    expect(out).toContain("inner.txt");
    expect(out).not.toContain("other.txt");
  }, SPAWN_TIMEOUT);

  it("passes the session id and is consulted on every call", async () => {
    const seen: string[] = [];
    const resolver: GitWorkRootResolver = sessionID => { seen.push(sessionID); return sessionID === "a" ? bound : sessionID === "b" ? other : null; };
    expect(await call(resolver, plain, "a")).toContain("bound.txt");
    expect(await call(resolver, plain, "b")).toContain("other.txt");
    expect(await call(resolver, plain, "c")).toBe(REFUSED);
    expect(seen).toEqual(["a", "b", "c"]);
  }, SPAWN_TIMEOUT);

  it("a throwing resolver is reported as a tool error and nothing is spawned", async () => {
    expect(await call(() => { throw new Error("binding lookup failed"); }, bound)).toBe("[router_git] error: binding lookup failed");
    expect(await call(() => { throw new Error("lookup https://u:secret99@host/x failed"); }, bound)).not.toContain("secret99");
    expect(gitSpawns()).toBe(0);
  }, SPAWN_TIMEOUT);

  it("a relative, empty or non-string root is refused as not absolute, spawning nothing", async () => {
    for (const root of ["relative/dir", "", 42, {}]) {
      expect(await call(() => root as unknown as string, bound)).toBe("[router_git] error: Bound work root is not an absolute path");
    }
    expect(gitSpawns()).toBe(0);
  }, SPAWN_TIMEOUT);

  it("a bound root that is not a repository is reported as an error, not a fallback to context.directory", async () => {
    const out = await call(() => plain, bound);
    expect(out).toMatch(/^\[router_git\] error: /);
    expect(out).not.toContain("bound.txt");
  }, SPAWN_TIMEOUT);

  it("a bound root that does not exist is reported as an error", async () => {
    expect(await call(() => join(plain, "missing"), bound)).toMatch(/^\[router_git\] error: /);
  }, SPAWN_TIMEOUT);
});
