/**
 * #84 P3.3 global QA round 1, router_git_* in role mode:
 * - QA-G-A2-2: the bound work root's `.git` pointers never lead a filesystem call or a git process to a network/device path, and
 *   the repository git inspects there is the one listed at dispatch (its common directory, and for a linked worktree the admin
 *   directory that points back to this root);
 * - QA-G-A2-4: a work root below its checkout's top level only shows what lies inside the work root.
 * `node:fs` is wrapped so a call naming a network path is recorded and answered locally (ENOENT): no test here touches the
 * network through the plugin. Git itself is only ever pointed at `//localhost/<missing share>` (a fast local failure).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment, gitExecutable, gitTools, mainWorktree, workRootGuards, type GitToolsOptions, type WorkRootAnswer } from "../../src/router/git-tools";

const touched: string[] = [];

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const remote = (path: unknown): path is string => typeof path === "string" && (/^[\\/]{2}/.test(path) || /attacker|omr-no-such-share/i.test(path));
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });
  const guard = <F extends (...args: any[]) => any>(name: string, original: F, local?: () => unknown): F =>
    ((path: unknown, ...rest: unknown[]) => {
      if (remote(path)) {
        touched.push(`${name}:${path}`);
        if (local !== undefined) return local();
        throw enoent(path);
      }
      return original(path, ...rest);
    }) as F;
  const realpathSync = Object.assign(guard("realpath", actual.realpathSync), { native: guard("realpath", actual.realpathSync.native) });
  const wrapped = {
    ...actual, realpathSync, statSync: guard("stat", actual.statSync), lstatSync: guard("lstat", actual.lstatSync),
    existsSync: guard("exists", actual.existsSync, () => false), openSync: guard("open", actual.openSync),
  };
  return { ...wrapped, default: wrapped };
});
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const SPAWN_TIMEOUT = 90_000;
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const NETWORK_POINTER = "//localhost/omr-no-such-share-84/repo";
let bound: string;
let other: string;
let plain: string;

type Execute = (args: unknown, context: unknown) => Promise<string>;
const bind = (root: string | null): WorkRootAnswer => ({ role: true, root });

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
function context(directory: string) {
  return { sessionID: "child", messageID: "m", agent: "runner", directory, worktree: directory, abort: new AbortController().signal,
    metadata: () => undefined, ask: async () => undefined };
}
const call = (root: string, options: Omit<GitToolsOptions, "resolveWorkRoot"> = {}, name = "router_git_ls_files", args: unknown = {}) => {
  const tools = gitTools({ resolveWorkRoot: () => bind(root), ...options });
  return (tools[name]!.execute as unknown as Execute)(args, context(plain));
};
const gitSpawns = () => vi.mocked(childProcess.spawn).mock.calls.length;
/** Replace a file (Git for Windows hides a worktree's `.git` file; a hidden file cannot be overwritten in place). */
function rewrite(path: string, text: string) {
  rmSync(path, { force: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  bound = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-repo-bound-")));
  other = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-repo-other-")));
  plain = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-repo-plain-")));
  repository(bound, "bound.txt");
  repository(other, "other.txt");
  vi.mocked(childProcess.spawn).mockClear();
  touched.length = 0;
});
afterEach(() => {
  vi.mocked(childProcess.spawn).mockClear();
  for (const dir of [bound, other, plain]) rmSync(dir, RM);
});

describe("QA-G-A2-2: a network .git pointer is never followed", () => {
  it("mainWorktree and workRootGuards refuse a network pointer in .git or in commondir without touching it", () => {
    const pointer = join(plain, "pointer");
    mkdirSync(pointer);
    writeFileSync(join(pointer, ".git"), "gitdir: //attacker/share/repo/.git/worktrees/x\n");
    expect(mainWorktree(pointer)).toBeUndefined();
    const common = join(plain, "common");
    mkdirSync(join(common, "admin"), { recursive: true });
    writeFileSync(join(common, ".git"), "gitdir: admin\n");
    writeFileSync(join(common, "admin", "commondir"), "\\\\attacker\\share\\repo.git\n");
    expect(mainWorktree(common)).toBeUndefined();
    for (const dir of [pointer, common]) expect(workRootGuards(dir).some(guard => /attacker/i.test(guard))).toBe(false);
    expect(touched).toEqual([]);
  });

  it("role mode refuses a work root whose .git file or .git/commondir names a network path, before any git is spawned", async () => {
    const sibling = join(plain, "sibling");
    git(bound, "worktree", "add", "-q", "--detach", sibling);
    const real = realpathSync.native(sibling);
    rewrite(join(real, ".git"), `gitdir: ${NETWORK_POINTER}\n`);
    vi.mocked(childProcess.spawn).mockClear();
    expect(await call(real, { dispatchRepository: bound })).toMatch(/^\[router_git\] error: .*network or device path/);
    expect(await call(real)).toMatch(/^\[router_git\] error: .*network or device path/);
    writeFileSync(join(bound, ".git", "commondir"), `${NETWORK_POINTER}\n`);
    expect(await call(bound, { dispatchRepository: bound })).toMatch(/^\[router_git\] error: .*network or device path/);
    expect(gitSpawns()).toBe(0);
    expect(touched).toEqual([]);
  }, SPAWN_TIMEOUT);
});

describe("QA-G-A2-2: the repository inspected is the one listed at dispatch", () => {
  it("refuses a work root of another repository than the dispatch's; a sibling worktree of the dispatch's repository works", async () => {
    expect(await call(bound, { dispatchRepository: other })).toMatch(/^\[router_git\] error: refused: .*not the repository listed at dispatch/);
    expect(await call(bound, { dispatchRepository: join(other, "sub") })).toMatch(/not the repository listed at dispatch/);
    const sibling = join(plain, "sibling");
    git(bound, "worktree", "add", "-q", "--detach", sibling);
    writeFileSync(join(sibling, "only-in-sibling.txt"), "z\n");
    const status = await call(realpathSync.native(sibling), { dispatchRepository: bound }, "router_git_status");
    expect(status).toContain("only-in-sibling.txt");
    expect(await call(bound, { dispatchRepository: realpathSync.native(sibling) })).toContain("bound.txt");
  }, SPAWN_TIMEOUT);

  it("refuses a worktree whose .git file was redirected to another repository or to another worktree's admin directory", async () => {
    const first = join(plain, "first");
    const second = join(plain, "second");
    git(bound, "worktree", "add", "-q", "--detach", first);
    git(bound, "worktree", "add", "-q", "--detach", second);
    const realFirst = realpathSync.native(first);
    const secondPointer = readFileSync(join(second, ".git"), "utf8");
    // Another local repository's .git directory.
    rewrite(join(realFirst, ".git"), `gitdir: ${join(other, ".git")}\n`);
    const redirected = await call(realFirst, { dispatchRepository: bound });
    expect(redirected).toMatch(/^\[router_git\] error: refused: /);
    expect(redirected).not.toContain("other.txt");
    // The admin directory of another worktree of the same repository: its gitdir file points back to that worktree, not here.
    rewrite(join(realFirst, ".git"), secondPointer);
    expect(await call(realFirst, { dispatchRepository: bound })).toMatch(/^\[router_git\] error: refused: .*does not point back to this work root/);
    expect(await call(realFirst)).toMatch(/does not point back to this work root/);
  }, SPAWN_TIMEOUT);
});

describe("QA-G-A2-4: a work root below its checkout's top level", () => {
  it("lists, shows and accepts paths inside the work root only; the checkout's top level and a worktree root work as before", async () => {
    const sub = join(bound, "sub");
    const files = await call(sub, { dispatchRepository: bound });
    expect(files).toContain("sub/inner.txt");
    expect(files).not.toContain("bound.txt");
    writeFileSync(join(bound, "outside-new.txt"), "o\n");
    writeFileSync(join(sub, "inside-new.txt"), "i\n");
    const status = await call(sub, { dispatchRepository: bound }, "router_git_status");
    expect(status).toContain("sub/inside-new.txt");
    expect(status).not.toContain("outside-new.txt");
    const log = await call(sub, { dispatchRepository: bound }, "router_git_log", { limit: 1 });
    expect(log).toContain("sub/inner.txt");
    expect(log).not.toContain("bound.txt");
    expect(await call(sub, { dispatchRepository: bound }, "router_git_show")).not.toContain("bound.txt");
    expect(await call(sub, {}, "router_git_blame", { path: "bound.txt" })).toMatch(/^\[router_git\] error: .*outside the work root/);
    expect(await call(sub, {}, "router_git_diff", { path: "bound.txt" })).toMatch(/outside the work root/);
    expect(await call(sub, {}, "router_git_blame", { path: "sub/inner.txt" })).toContain("y");
    // The top level itself and a linked worktree root are not limited.
    expect(await call(bound, { dispatchRepository: bound })).toContain("bound.txt");
    const sibling = join(plain, "sibling");
    git(bound, "worktree", "add", "-q", "--detach", sibling);
    const worktree = await call(realpathSync.native(sibling), { dispatchRepository: bound });
    expect(worktree).toContain("bound.txt");
    expect(worktree).toContain("sub/inner.txt");
  }, SPAWN_TIMEOUT);
});
