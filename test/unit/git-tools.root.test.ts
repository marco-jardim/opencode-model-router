/**
 * 3b.3: the optional read-only `root` argument of router_git_* (real git, temporary repositories under the OS temp
 * directory). The resolver is a fake standing in for `resolveGitRoot` (3b.2): these tests pin what the tool does with each
 * answer — refusals and malformed answers spawn nothing, the work root behaves as without `root`, and an admitted repository
 * is inspected (as the git cwd only) with the role hardening, its provenance line first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  checkGitRootAnswer, gitEnvironment, gitExecutable, gitTools,
  type GitRootAnswer, type GitRootResolver, type GitToolsOptions,
} from "../../src/router/git-tools";
import { isSensitivePath } from "../../src/router/sensitive-paths";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const WIN = process.platform === "win32";
const INHERITED_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"] as const;
/** A name-like `root` value: the fake resolver ignores it, so it must never reach a git argv. */
const VALUE = "omr-root-token-3b3";
const INVALID = "[router_git] error: refused: the root resolver returned an invalid answer; nothing ran";
const SESSION = "ses-root-3b3";

let work: string; // W: the bound work root (its own repository)
let target: string; // the other repository, canonical
let scratch: string;
let savedEnv: Partial<Record<typeof INHERITED_ENV[number], string>>;
let provenance: string;

const fold = (path: string) => WIN ? path.toLowerCase() : path;
const same = (a: string, b: string) => fold(realpathSync.native(a)) === fold(realpathSync.native(b));
const insideOf = (root: string, path: string) => {
  const rel = relative(fold(realpathSync.native(root)), fold(realpathSync.native(path)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function gitIn(cwd: string, ...args: string[]): string {
  const run = (argv: string[]) => execFileSync(gitExecutable(), ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...argv],
    { cwd, env: gitEnvironment(), encoding: "utf8" });
  const output = run(args);
  if (args[0] === "init") {
    for (const [key, value] of [["gc.auto", "0"], ["maintenance.auto", "false"], ["gc.autoDetach", "false"]] as const) run(["config", key, value]);
  }
  return output;
}
function repository(dir: string, files: Record<string, string>, message: string): void {
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.email", "test@example.invalid"); gitIn(dir, "config", "user.name", "Test");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  gitIn(dir, "add", "--", ...Object.keys(files)); gitIn(dir, "commit", "-qm", message);
}
/** Content, size and mtime of every file under .git, plus the set of entries (git-tools.test.ts pattern). */
function gitDirDigest(repo: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { hash.update(`${relative(repo, path)}\0`); walk(path); continue; }
      const stats = statSync(path);
      hash.update(`${relative(repo, path)}\0${stats.size}:${stats.mtimeMs}\0`).update(readFileSync(path));
    }
  };
  walk(join(repo, ".git"));
  return hash.digest("hex");
}

type Execute = (args: unknown, context: unknown) => Promise<unknown>;
type Tools = Record<string, { execute: unknown }>;
function context(abort: AbortSignal = new AbortController().signal) {
  return { sessionID: SESSION, messageID: "m", agent: "explorer", directory: work, worktree: work, abort,
    metadata: () => undefined, ask: async () => undefined };
}
async function run(tools: Tools, name: string, args: unknown, abort?: AbortSignal): Promise<string> {
  return String(await (tools[name]!.execute as Execute)(args, context(abort)));
}
const spawns = () => vi.mocked(childProcess.spawn).mock.calls;
const resetSpawns = () => vi.mocked(childProcess.spawn).mockClear();

interface ResolverCall { value: string; ctx: { sessionID: string; signal?: AbortSignal; deadlineAt: number } }
function resolver(answer: unknown | (() => unknown), calls: ResolverCall[] = []): GitRootResolver {
  return async (value, ctx) => {
    calls.push({ value, ctx });
    return (typeof answer === "function" ? (answer as () => unknown)() : answer) as GitRootAnswer;
  };
}
function admitted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, inWorkRoot: false, root: target, repository: target, name: "lib", branch: "main", workRoot: work, provenance, ...over };
}
function roleTools(extra: GitToolsOptions = {}): Tools {
  return gitTools({ resolveWorkRoot: () => ({ role: true, root: work }), ...extra }) as unknown as Tools;
}

beforeEach(() => {
  resetSpawns();
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-root-scratch-")));
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-root-w-")));
  target = realpathSync.native(mkdtempSync(join(tmpdir(), "router-git-root-t-")));
  savedEnv = {};
  for (const name of INHERITED_ENV) if (process.env[name] !== undefined) savedEnv[name] = process.env[name];
  writeFileSync(join(scratch, "empty.gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(scratch, "empty.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_CONFIG_SYSTEM;
  repository(work, { "work.txt": "work\n", "pkg/a.txt": "a\n" }, "work initial");
  writeFileSync(join(work, "w-untracked.txt"), "w\n");
  repository(target, { "lib.txt": "lib\n" }, "lib initial");
  writeFileSync(join(target, "lib-new.txt"), "new\n");
  provenance = `[router: read from lib (main) at ${target} — read-only in this dispatch]`;
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of INHERITED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const dir of [work, target, scratch]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("router_git_* root (3b.3)", () => {
  it("without a resolver, root is an error and nothing is spawned (I9: schema unchanged)", async () => {
    for (const tools of [gitTools() as unknown as Tools, roleTools()]) {
      for (const name of ["router_git_status", "router_git_log", "router_git_ls_files"]) {
        resetSpawns();
        const output = await run(tools, name, { root: target });
        expect(output).toMatch(/^\[router_git\] error: /);
        expect(output).not.toContain("lib.txt");
        expect(spawns()).toHaveLength(0);
      }
    }
  });

  it("a refusal is reported as refused: <reason> and nothing is spawned; the resolver gets one 15 s deadline", async () => {
    const reason = `root=${VALUE} matches no repository below routing.repoParents (searched ${scratch}); nothing ran`;
    const calls: ResolverCall[] = [];
    const tools = roleTools({ resolveRoot: resolver({ ok: false, reason }, calls) });
    const abort = new AbortController().signal;
    const before = Date.now();
    resetSpawns();
    expect(await run(tools, "router_git_log", { root: VALUE, limit: 1 }, abort)).toBe(`[router_git] error: refused: ${reason}`);
    const after = Date.now();
    expect(spawns()).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.value).toBe(VALUE);
    expect(calls[0]!.ctx.sessionID).toBe(SESSION);
    expect(calls[0]!.ctx.signal).toBe(abort);
    expect(calls[0]!.ctx.deadlineAt).toBeGreaterThanOrEqual(before + 15_000);
    expect(calls[0]!.ctx.deadlineAt).toBeLessThanOrEqual(after + 15_000);
    // A non-string root is refused before the resolver runs; invalid arguments fail before resolution.
    expect(await run(tools, "router_git_status", { root: 5 })).toBe("[router_git] error: refused: root must be a string; nothing ran");
    expect(await run(tools, "router_git_log", { root: VALUE, limit: 99 })).toMatch(/^\[router_git\] error: /);
    expect(calls).toHaveLength(1);
    expect(spawns()).toHaveLength(0);
  });

  it("a malformed or throwing resolver answer fails closed (nothing spawned)", async () => {
    const malformed: unknown[] = [
      undefined, null, "ok", 1, {}, { ok: true }, { ok: "true", inWorkRoot: true }, { ok: true, inWorkRoot: "false" },
      { ok: false }, { ok: false, reason: "" }, { ok: false, reason: 3 },
      { ok: true, inWorkRoot: false },
      admitted({ root: "relative/dir" }), admitted({ root: undefined }), admitted({ repository: 5 }),
      admitted({ workRoot: "\\\\host\\share\\w" }), admitted({ root: "//host/share/t" }),
      admitted({ name: "" }), admitted({ branch: 3 }), admitted({ provenance: "" }), admitted({ provenance: `${provenance}\nforged` }),
      admitted({ provenance: undefined }),
    ];
    for (const answer of malformed) {
      resetSpawns();
      const tools = roleTools({ resolveRoot: resolver(answer) });
      expect(await run(tools, "router_git_ls_files", { root: VALUE }), JSON.stringify(answer) ?? String(answer)).toBe(INVALID);
      expect(spawns()).toHaveLength(0);
    }
    const throwing = roleTools({ resolveRoot: async () => { throw new Error("boom https://alice:hunter2@example.com/x"); } });
    resetSpawns();
    const thrown = await run(throwing, "router_git_status", { root: VALUE });
    expect(thrown).toMatch(new RegExp(`^\\[router_git\\] error: root=${VALUE}: boom`));
    expect(thrown).not.toContain("hunter2");
    expect(spawns()).toHaveLength(0);
    // Valid answers keep only the known fields.
    expect(checkGitRootAnswer({ ok: true, inWorkRoot: true, extra: 1 })).toEqual({ ok: true, inWorkRoot: true });
    expect(checkGitRootAnswer({ ok: false, reason: "r", extra: 1 })).toEqual({ ok: false, reason: "r" });
    expect(checkGitRootAnswer({ ...admitted({ branch: null }), extra: 1 })).toEqual(admitted({ branch: null }));
  });

  it("root naming the work root is byte-identical to omitting it (SD-3b-4)", async () => {
    const today = roleTools();
    const tools = roleTools({ resolveRoot: resolver({ ok: true, inWorkRoot: true }) });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["router_git_status", {}], ["router_git_log", { limit: 1 }], ["router_git_ls_files", {}], ["router_git_ls_files", { path: "work.txt" }],
    ];
    for (const [name, args] of cases) {
      const without = await run(tools, name, args);
      expect(await run(today, name, args)).toBe(without);
      const withRoot = await run(tools, name, { ...args, root: work });
      expect(withRoot, name).toBe(without);
      expect(withRoot).not.toContain("[router: read from");
      expect(withRoot).not.toContain("lib.txt");
    }
    expect(await run(tools, "router_git_ls_files", { root: work })).toBe("pkg/a.txt\nwork.txt\n");
    // The subdirectory scope of a work root below its top level is kept.
    const scoped = gitTools({ resolveWorkRoot: () => ({ role: true, root: join(work, "pkg") }),
      resolveRoot: resolver({ ok: true, inWorkRoot: true }) }) as unknown as Tools;
    expect(await run(scoped, "router_git_ls_files", { root: join(work, "pkg") })).toBe(await run(scoped, "router_git_ls_files", {}));
    expect(await run(scoped, "router_git_ls_files", { root: join(work, "pkg") })).toBe("pkg/a.txt\n");
  }, 60_000);

  it("an admitted repository: provenance first, then its status, log and ls-files (never the work root's)", async () => {
    const tools = roleTools({ resolveRoot: resolver(admitted()) });
    const targetBefore = gitDirDigest(target);
    const workBefore = gitDirDigest(work);
    resetSpawns();
    expect(await run(tools, "router_git_ls_files", { root: VALUE })).toBe(`${provenance}\nlib.txt\n`);
    expect(await run(tools, "router_git_status", { root: VALUE })).toBe(`${provenance}\n?? lib-new.txt\n`);
    const log = await run(tools, "router_git_log", { root: VALUE, limit: 1 });
    expect(log.startsWith(`${provenance}\ncommit `)).toBe(true);
    expect(log).toContain("lib initial");
    for (const output of [log]) {
      expect(output.split("[router: read from").length).toBe(2); // one provenance line, never a second
      expect(output).not.toContain("work initial");
      expect(output).not.toContain("w-untracked.txt");
    }
    // `root` is only the spawn cwd: never an argument, and nothing runs in the work root.
    const calls = spawns().map(call => call as unknown as [string, readonly string[] | undefined, { cwd?: unknown } | undefined]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(([, , options]) => typeof options?.cwd === "string" && same(options.cwd, target))).toBe(true);
    for (const [, args, options] of calls) {
      expect((args ?? []).join("\0")).not.toContain(VALUE);
      if (typeof options?.cwd === "string") expect(insideOf(work, options.cwd)).toBe(false);
    }
    expect(gitDirDigest(target)).toBe(targetBefore);
    expect(gitDirDigest(work)).toBe(workBefore);
  }, 30_000);

  it("path is relative to the target; a sensitive path is still refused", async () => {
    const tools = roleTools({ resolveRoot: resolver(admitted()) });
    const before = gitDirDigest(target);
    expect(await run(tools, "router_git_ls_files", { root: VALUE, path: "lib.txt" })).toBe(`${provenance}\nlib.txt\n`);
    expect(await run(tools, "router_git_ls_files", { root: VALUE, path: "work.txt" })).toBe(`${provenance}\n`);
    expect(await run(tools, "router_git_log", { root: VALUE, path: "lib.txt", limit: 1 })).toContain("lib initial");
    expect(isSensitivePath(".env")).toBe(true);
    resetSpawns();
    expect(await run(tools, "router_git_log", { root: VALUE, path: ".env" }))
      .toBe(`[router_git] error: root=${VALUE}: Sensitive git path refused; use read (asks for approval)`);
    expect(spawns()).toHaveLength(0);
    expect(await run(tools, "router_git_ls_files", { root: VALUE, path: "../escape.txt" }))
      .toBe(`[router_git] error: root=${VALUE}: Invalid git path: expected a relative path inside the repository`);
    expect(gitDirDigest(target)).toBe(before);
  }, 30_000);

  it("a common-dir mismatch is refused before anything is spawned (gitdir redirection)", async () => {
    resetSpawns();
    const mismatch = roleTools({ resolveRoot: resolver(admitted({ repository: work })) });
    expect(await run(mismatch, "router_git_status", { root: VALUE }))
      .toBe(`[router_git] error: root=${VALUE}: refused: the work root's repository is not the repository listed at dispatch`);
    // A checkout whose .git file redirects into the work root's repository is not the admitted repository.
    const redirect = join(scratch, "redirect");
    mkdirSync(redirect);
    writeFileSync(join(redirect, ".git"), `gitdir: ${join(work, ".git")}\n`);
    const redirected = roleTools({ resolveRoot: resolver(admitted({ root: redirect })) });
    const output = await run(redirected, "router_git_log", { root: VALUE });
    expect(output).toMatch(new RegExp(`^\\[router_git\\] error: root=${VALUE}: `));
    expect(output).not.toContain("work initial");
    expect(spawns()).toHaveLength(0);
  });

  it("F2: a main worktree whose .git is not its own git directory is refused before anything is spawned", async () => {
    const refusal = (root: string) =>
      `[router_git] error: refused: root=${VALUE}: ${join(root, ".git")} is not the repository's own git directory; nothing ran`;
    // A .git file redirecting into another repository (W), the resolver answering repository === root (a main worktree).
    const redirect = join(scratch, "redirect");
    mkdirSync(redirect);
    writeFileSync(join(redirect, ".git"), `gitdir: ${join(work, ".git")}\n`);
    // A .git junction (a symbolic link elsewhere) to W's git directory.
    const linkedGit = join(scratch, "linked-git");
    mkdirSync(linkedGit);
    symlinkSync(join(work, ".git"), join(linkedGit, ".git"), "junction");
    // No .git at all.
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    for (const root of [redirect, linkedGit, plain]) {
      const tools = roleTools({ resolveRoot: resolver(admitted({ root, repository: root })) });
      resetSpawns();
      for (const name of ["router_git_log", "router_git_status", "router_git_ls_files"]) {
        const output = await run(tools, name, { root: VALUE });
        expect(output, `${root} ${name}`).toBe(refusal(root));
        expect(output).not.toContain("work initial");
        expect(output).not.toContain("[router: read from");
      }
      expect(spawns()).toHaveLength(0);
    }
  });

  it("F2: a root that is no longer its resolved real path (a junction swapped in) is refused before anything is spawned", async () => {
    const junction = join(scratch, "junction");
    symlinkSync(work, junction, "junction");
    expect(same(junction, work)).toBe(true);
    for (const repository of [junction, target, work]) {
      const tools = roleTools({ resolveRoot: resolver(admitted({ root: junction, repository })) });
      resetSpawns();
      const output = await run(tools, "router_git_log", { root: VALUE });
      expect(output, repository).toBe(`[router_git] error: refused: root=${VALUE}: ${junction} changed since it was resolved; nothing ran`);
      expect(output).not.toContain("work initial");
      expect(spawns()).toHaveLength(0);
    }
    // A root removed since it was resolved is refused the same way.
    const gone = join(scratch, "gone");
    const tools = roleTools({ resolveRoot: resolver(admitted({ root: gone, repository: gone })) });
    resetSpawns();
    expect(await run(tools, "router_git_status", { root: VALUE }))
      .toBe(`[router_git] error: refused: root=${VALUE}: ${gone} changed since it was resolved; nothing ran`);
    expect(spawns()).toHaveLength(0);
  });

  it("F2: a normal main worktree and a linked worktree of the admitted repository are still inspected", async () => {
    const main = roleTools({ resolveRoot: resolver(admitted()) });
    expect(await run(main, "router_git_ls_files", { root: VALUE })).toBe(`${provenance}\nlib.txt\n`);
    const linked = join(scratch, "lib-linked");
    gitIn(target, "worktree", "add", "-q", "-b", "side", linked);
    writeFileSync(join(linked, "side-new.txt"), "side\n");
    const tools = roleTools({ resolveRoot: resolver(admitted({ root: linked, repository: target })) });
    expect(await run(tools, "router_git_ls_files", { root: VALUE })).toBe(`${provenance}\nlib.txt\n`);
    expect(await run(tools, "router_git_status", { root: VALUE })).toBe(`${provenance}\n?? side-new.txt\n`);
    const log = await run(tools, "router_git_log", { root: VALUE, limit: 1 });
    expect(log.startsWith(`${provenance}\ncommit `)).toBe(true);
    expect(log).toContain("lib initial");
    expect(log).not.toContain("work initial");
  }, 60_000);

  it("one deadline covers resolution and inspection (SD-3b-8)", async () => {
    // The resolver uses up the call's 15 s: the inspection's first budget check (before its first spawn) times out, rather
    // than starting a fresh 15 s budget.
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    const tools = roleTools({ resolveRoot: resolver(() => { now.mockReturnValue(start + 20_000); return admitted(); }) });
    resetSpawns();
    expect(await run(tools, "router_git_status", { root: VALUE })).toBe(`[router_git] error: root=${VALUE}: Git inspection timed out`);
    expect(spawns()).toHaveLength(0);
  });

  it("the executable guards cover the work root too: a git inside W is never run for root", async () => {
    const saved = { ProgramFiles: process.env.ProgramFiles, ProgramW6432: process.env.ProgramW6432, PATH: process.env.PATH };
    const programFiles = join(work, "tools");
    const fakeDir = WIN ? join(programFiles, "Git", "cmd") : join(work, "bin");
    mkdirSync(fakeDir, { recursive: true });
    const fake = join(fakeDir, WIN ? "git.exe" : "git");
    writeFileSync(fake, "not a git executable\n", { mode: 0o755 });
    try {
      process.env.ProgramFiles = programFiles; process.env.ProgramW6432 = programFiles;
      process.env.PATH = WIN ? "" : fakeDir;
      vi.resetModules();
      // A fresh module resolves its candidates from this environment: the fake inside W is the only one.
      const fresh = await import("../../src/router/git-tools");
      const freshChild = await import("node:child_process");
      const tools = fresh.gitTools({ resolveWorkRoot: () => ({ role: true, root: work }), resolveRoot: resolver(admitted()) }) as unknown as Tools;
      const real = realpathSync.native(fake);
      expect(fresh.gitCandidates()).toEqual([real]);
      // Positive control: the target's own guards alone would select it.
      expect(fresh.selectGitExecutable([real], [target, ...fresh.workRootGuards(target)])).toBe(real);
      vi.mocked(freshChild.spawn).mockClear();
      resetSpawns();
      const output = await run(tools, "router_git_ls_files", { root: VALUE });
      expect(output).toBe(`[router_git] error: root=${VALUE}: Refusing git executable inside the session repository: ${real}`);
      expect(vi.mocked(freshChild.spawn).mock.calls).toHaveLength(0);
      expect(spawns()).toHaveLength(0);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      vi.resetModules();
    }
  }, 30_000);
});
