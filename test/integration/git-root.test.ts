/**
 * Task 3b.5 (`docs/design/cross-repo-phase3-plan.md`): `router_git_*` with `root` against real git, junctions (win32) or
 * directory symlinks (posix) and linked worktrees, driven through the plugin like the "router_git root (cross-repo P3b)"
 * describe of `test/unit/roles.runtime.test.ts` (its helpers copied to the minimum needed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";

// git spawns are counted (pass-through spies; nothing else changes).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});
// The resolver's realpath (`src/index.ts`: `realpathSync.native`) records its arguments (pass-through; nothing else changes).
const realpathCalls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const native = (path: string, options?: unknown): unknown => {
    realpathCalls.push(String(path));
    return actual.realpathSync.native(path, options as never);
  };
  const realpathSync = Object.assign((path: string, options?: unknown): unknown => actual.realpathSync(path, options as never), { native });
  return { ...actual, default: { ...actual, realpathSync }, realpathSync };
});
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath, type RouterConfig } from "../../src/router/config";
import { resetDispatchRegistry } from "../../src/router/sessions";
import { bind, noncePromptLine, registerPending, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import { resetAuthorityForTests } from "../../src/routing/roles/authority";
import { resetDispatchRouting } from "../../src/routing/wire/dispatch";
import { addToWorkingSet, forgetWorkingSet } from "../../src/routing/wire/working-set";
import { GIT_ROOT_OUTSIDE_READ_SET, GIT_ROOT_RESOLVES_OUTSIDE } from "../../src/routing/roles/git-root";
import { approvalsPath } from "../../src/routing/roles/approvals";

const temps: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  // Links first (never a recursive removal through a junction), then the temp trees.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateConfigCache();
  resetBindingRegistryForTests();
  resetAuthorityForTests();
  resetDispatchRouting();
  resetDispatchRegistry();
});

function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** HOME redirected to a temp dir whose global override holds `override`. */
function home(override: Record<string, unknown>): { dir: string; cfg: RouterConfig } {
  const dir = temp("omr-3b5-home-");
  vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "0");
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  return { dir, cfg: loadConfig(dir) };
}

async function plugin(directory: string): Promise<Record<string, any>> {
  const hooks = await ModelRouterPlugin({
    directory, worktree: directory, routerHost: "v2",
    client: {
      session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(path.id === "root" ? {} : { parentID: "root" }) } }) },
      app: { log: vi.fn(async () => ({})) },
    },
  } as unknown as RouterPluginInput) as Record<string, any>;
  cleanups.push(async () => { await hooks.dispose?.(); });
  return hooks;
}

/** A directory link: a junction on win32 (no privilege needed), a directory symlink elsewhere. Removed as a link, never recursively. */
function link(target: string, path: string): string {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  cleanups.push(() => {
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
  });
  return path;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** A real repository at `dir` (branch main, one commit). */
function gitRepo(dir: string, message = "init lib"): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.ts"), "x\n");
  git(dir, "add", "a.ts");
  git(dir, "commit", "-q", "-m", message);
  return dir;
}

/** A work root W (a repository) and a parent P holding the repository `lib-b`. */
function fixture() {
  const work = gitRepo(temp("omr-3b5-work-"));
  const parent = temp("omr-3b5-parent-");
  const repo = gitRepo(join(parent, "lib-b"));
  return { work, parent, repo };
}

const CHILD = "git-root-it-child";
const locationOf = (path: string) => ({ repository: path, name: basename(path), worktree: path, branch: "main", head: null, worktrees: [] });
const toolCtx = (sessionID: string) => ({ sessionID, messageID: "m", agent: "x", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });

/**
 * Binds CHILD exactly to a dispatch from `root` with read, glob, grep and router_git and the work root `workRoot`; `approval`
 * marks the binding's location as backed by that approved path (Phase 4).
 */
async function bindExact(hooks: Record<string, any>, dir: string, workRoot: string, approval?: string): Promise<void> {
  const nonce = `nonce-${CHILD}-000000000000`;
  const location = approval === undefined ? locationOf(workRoot) : { ...locationOf(workRoot), approval };
  registerPending({
    parentSessionID: "root", callID: `call_${CHILD}`, agent: "explorer", description: "task", nonce,
    grant: { actions: new Set(["read", "glob", "grep", "router_git"]), notes: [], workRoot, location },
    budget: 80, decisionID: null, registeredAt: Date.now(),
  } as any);
  const bound = await bind(CHILD, async () => ({ parentID: "root", agent: "explorer", title: "task", firstText: noncePromptLine(nonce) }),
    { maxOf: () => ["read", "glob", "grep", "router_git"] });
  expect(bound.kind).toBe("exact");
  await hooks["tool.execute.before"]({ tool: "read", sessionID: CHILD, agent: "explorer", callID: `${CHILD}-0` }, { args: { filePath: join(dir, "a.ts") } });
}

const call = (hooks: Record<string, any>, tool: string, args: Record<string, unknown>): Promise<string> =>
  (hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>)[tool]!.execute(args, toolCtx(CHILD));
const gitSpawns = (): unknown[][] => [...vi.mocked(childProcess.spawn).mock.calls, ...vi.mocked(childProcess.execFile).mock.calls]
  .filter((args) => /git/i.test(String(args[0])));
const resetSpawns = (): void => { vi.mocked(childProcess.spawn).mockClear(); vi.mocked(childProcess.execFile).mockClear(); };
const PROVENANCE = /^\[router: read from (.+) \((.+)\) at (.+) — read-only in this dispatch\]$/;
const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase() : a === b;
const provenanceOf = (output: string): { name: string; branch: string; worktree: string } | undefined => {
  const match = PROVENANCE.exec(output.split("\n")[0] ?? "");
  return match === null ? undefined : { name: match[1]!, branch: match[2]!, worktree: match[3]! };
};
const REFUSED = "[router_git] error: refused: ";

// Real git in temporary repositories: slow on Windows CI runners, so bounded by an explicit timeout (as #88 did).
describe("router_git root through junctions and worktrees (3b.5)", { timeout: 60_000 }, () => {
  it("a link below a parent that leads out of the parents is refused at step 5 (resolves outside the read set), nothing spawned", async () => {
    const { work, parent } = fixture();
    const outside = gitRepo(temp("omr-3b5-outside-"), "outside");
    const escape = link(outside, join(parent, "escape"));
    const { dir } = home({ routing: { delegation: "roles", repoParents: [parent] } });
    const hooks = await plugin(dir);
    await bindExact(hooks, dir, work);
    resetSpawns();
    for (const tool of ["router_git_status", "router_git_log"]) {
      expect(await call(hooks, tool, { root: escape })).toBe(`${REFUSED}root=${escape} resolves to ${outside}, ${GIT_ROOT_RESOLVES_OUTSIDE}`);
    }
    expect(gitSpawns()).toEqual([]);
  });

  it("a link from outside the parents into a repository of R is refused at the text gate (step 3): never resolved, nothing spawned", async () => {
    const { work, parent, repo } = fixture();
    const elsewhere = temp("omr-3b5-elsewhere-");
    const inward = link(repo, join(elsewhere, "lib-b"));
    const { dir } = home({ routing: { delegation: "roles", repoParents: [parent] } });
    const hooks = await plugin(dir);
    await bindExact(hooks, dir, work);
    resetSpawns();
    realpathCalls.length = 0;
    for (const tool of ["router_git_status", "router_git_log"]) {
      expect(await call(hooks, tool, { root: inward })).toBe(`${REFUSED}root=${inward} ${GIT_ROOT_OUTSIDE_READ_SET} ${parent}); nothing ran`);
    }
    // SD-3b-3: the text gate stopped it; the link itself was never handed to realpath.
    expect(realpathCalls.filter((path) => samePath(path, inward))).toEqual([]);
    expect(gitSpawns()).toEqual([]);
    // The same repository through its own path below the parent is admitted (the refusal is the link's, not the repository's).
    expect(provenanceOf(await call(hooks, "router_git_status", { root: repo }))).toMatchObject({ name: "lib-b", branch: "main" });
    // The spy does see the resolver's realpath (step 4), so the empty filter above is not vacuous.
    expect(realpathCalls.some((path) => samePath(path, repo))).toBe(true);
  });

  it("a linked worktree of a working-set repository, outside the parents, is allowed: provenance names it and its branch, output comes from it", async () => {
    const { work, parent } = fixture();
    // Phase 4 QA (M1): the repository that lists the worktree lies below a parent (outside them it would need an approval).
    const main = gitRepo(join(parent, "main-repo"), "init main");
    const worktree = join(temp("omr-3b5-wt-"), "feature-wt");
    git(main, "worktree", "add", "-q", "-b", "feature", worktree);
    writeFileSync(join(worktree, "feature.ts"), "f\n");
    git(worktree, "add", "feature.ts");
    git(worktree, "commit", "-q", "-m", "feature commit");
    writeFileSync(join(worktree, "only-in-worktree.txt"), "u\n");
    const { dir } = home({ routing: { delegation: "roles", repoParents: [parent] } });
    const hooks = await plugin(dir);
    addToWorkingSet("root", { repository: main, name: basename(main), worktree, branch: "feature", head: null, worktrees: [] });
    cleanups.push(() => { forgetWorkingSet("root"); });
    await bindExact(hooks, dir, work);

    const status = await call(hooks, "router_git_status", { root: worktree });
    expect(status).not.toContain("[router_git] error");
    const line = provenanceOf(status);
    expect(line).toMatchObject({ branch: "feature" });
    expect(samePath(line!.worktree, worktree)).toBe(true);
    expect(status).toContain("only-in-worktree.txt");

    const log = await call(hooks, "router_git_log", { root: worktree, limit: 1 });
    expect(provenanceOf(log)).toEqual(line);
    expect(log).toContain("feature commit");
    expect(log).not.toContain("init main");
    // The main worktree is clean and on main: the output above is the linked worktree's.
    expect(git(main, "--no-optional-locks", "status", "--porcelain")).toBe("");
  });

  it("Phase 4 QA M1: a linked worktree of a working-set repository outside the parents, neither approved nor the session's, is refused", async () => {
    const { work, parent } = fixture();
    const main = gitRepo(temp("omr-3b5-main-"), "init main");
    const worktree = join(temp("omr-3b5-wt-"), "feature-wt");
    git(main, "worktree", "add", "-q", "-b", "feature", worktree);
    const { dir } = home({ routing: { delegation: "roles", repoParents: [parent] } });
    const hooks = await plugin(dir);
    // An untagged entry (as an approval-backed binding used to be stored): it no longer stands in for the approval.
    addToWorkingSet("root", { repository: main, name: basename(main), worktree, branch: "feature", head: null, worktrees: [] });
    cleanups.push(() => { forgetWorkingSet("root"); });
    await bindExact(hooks, dir, work);
    for (const root of [worktree, main]) {
      const out = await call(hooks, "router_git_status", { root });
      expect(out.startsWith(REFUSED)).toBe(true);
      expect(provenanceOf(out)).toBeUndefined();
    }
  });

  it("Phase 4 QA m2: a binding backed by a revoked or expired approval runs nothing, with or without root", async () => {
    const { work, parent, repo } = fixture();
    const { dir } = home({ routing: { delegation: "roles", repoParents: [parent] } });
    const hooks = await plugin(dir);
    await bindExact(hooks, dir, work, work);
    const reason = `approval for ${work} was revoked or expired: no work root. Only the user can approve it again (/router approve ${work}).`;
    resetSpawns();
    // No store entry for it (revoked).
    expect(await call(hooks, "router_git_status", {})).toBe(`${REFUSED}${reason}`);
    expect(await call(hooks, "router_git_status", { root: repo })).toBe(`${REFUSED}${reason}`);
    expect(gitSpawns()).toEqual([]);
    // An entry in force: both run.
    const now = Date.now();
    const roots = git(work, "rev-list", "--max-parents=0", "HEAD").split(/\r?\n/).filter((line) => line !== "").sort();
    mkdirSync(dirname(approvalsPath()), { recursive: true });
    const entry = { path: work, commonDir: join(work, ".git"), roots, origin: "none", approvedAt: now, lastUsedAt: now };
    writeFileSync(approvalsPath(), JSON.stringify({ version: 1, approvals: [entry] }));
    expect(await call(hooks, "router_git_status", {})).not.toContain("[router_git] error");
    expect(provenanceOf(await call(hooks, "router_git_status", { root: repo }))).toMatchObject({ name: "lib-b", branch: "main" });
    // Expired (older than routing.repoApprovalDays, default 14): refused again.
    writeFileSync(approvalsPath(), JSON.stringify({ version: 1, approvals: [{ ...entry, approvedAt: now - 20 * 86_400_000, lastUsedAt: now - 15 * 86_400_000 }] }));
    expect(await call(hooks, "router_git_status", {})).toBe(`${REFUSED}${reason}`);
    expect(await call(hooks, "router_git_log", { root: repo, limit: 1 })).toBe(`${REFUSED}${reason}`);
  });

  it("a routing.repoParents entry that is a link: a bare name, the provenance path and the multi-match hint paths are accepted (QA F1)", async () => {
    const work = gitRepo(temp("omr-3b5-work-"));
    const realParent = temp("omr-3b5-realparent-");
    gitRepo(join(realParent, "lib-b"));
    gitRepo(join(realParent, "lib"), "init lib top");
    gitRepo(join(realParent, "team", "lib"), "init lib team");
    const linkParent = link(realParent, join(temp("omr-3b5-linkhost-"), "P"));
    const { dir } = home({ routing: { delegation: "roles", repoParents: [linkParent], repoDepth: 2 } });
    const hooks = await plugin(dir);
    await bindExact(hooks, dir, work);

    // A bare name: found below the link, admitted (provenance at the canonical path).
    const byName = await call(hooks, "router_git_status", { root: "lib-b" });
    expect(byName).not.toContain("[router_git] error");
    const line = provenanceOf(byName);
    expect(line).toMatchObject({ name: "lib-b", branch: "main" });
    expect(samePath(line!.worktree, join(realParent, "lib-b"))).toBe(true);
    // The provenance path passed back, and the path through the link as configured: the same repository.
    expect(provenanceOf(await call(hooks, "router_git_log", { root: line!.worktree, limit: 1 }))).toEqual(line);
    expect(provenanceOf(await call(hooks, "router_git_status", { root: join(linkParent, "lib-b") }))).toEqual(line);

    // Two repositories named lib: the hint lists paths that are accepted when passed back.
    const ambiguous = await call(hooks, "router_git_status", { root: "lib" });
    const hint = /^\[router_git\] error: refused: root=lib matches 2 repositories: (.+); nothing ran\. Pass root as one of these absolute paths$/.exec(ambiguous);
    expect(hint, ambiguous).not.toBeNull();
    const listed = hint![1]!.split(", ");
    expect(listed).toHaveLength(2);
    const messages: string[] = [];
    for (const path of listed) {
      const log = await call(hooks, "router_git_log", { root: path, limit: 1 });
      expect(log, path).not.toContain("[router_git] error");
      expect(samePath(provenanceOf(log)!.worktree, path)).toBe(true);
      messages.push(log);
    }
    expect(messages.some((log) => log.includes("init lib top"))).toBe(true);
    expect(messages.some((log) => log.includes("init lib team"))).toBe(true);
  });

  it("status, diff and log with root leave the target repository's .git/index and its status unchanged", async () => {
    const { work, parent, repo } = fixture();
    writeFileSync(join(repo, "c.ts"), "y\n");
    git(repo, "add", "c.ts");
    git(repo, "commit", "-q", "-m", "second");
    // A stat-dirty but clean file: a plain `git status` would refresh and rewrite the index.
    utimesSync(join(repo, "a.ts"), new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    writeFileSync(join(repo, "c.ts"), "z\n");
    writeFileSync(join(repo, "new.txt"), "n\n");
    const porcelain = (): string => git(repo, "--no-optional-locks", "status", "--porcelain");
    const index = join(repo, ".git", "index");
    const before = { status: porcelain(), mtimeMs: statSync(index).mtimeMs, bytes: readFileSync(index) };
    expect(before.status).toContain("c.ts");
    expect(before.status).toContain("new.txt");

    const { dir } = home({ routing: { delegation: "roles", repoParents: [parent] } });
    const hooks = await plugin(dir);
    await bindExact(hooks, dir, work);
    const status = await call(hooks, "router_git_status", { root: repo });
    expect(status).not.toContain("[router_git] error");
    expect(status).toContain("new.txt");
    const diff = await call(hooks, "router_git_diff", { root: repo });
    expect(diff).not.toContain("[router_git] error");
    expect(diff).toContain("c.ts");
    const log = await call(hooks, "router_git_log", { root: repo, limit: 1 });
    expect(log).not.toContain("[router_git] error");
    expect(log).toContain("second");

    expect(statSync(index).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(index).equals(before.bytes)).toBe(true);
    expect(porcelain()).toBe(before.status);
  });
});
