import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hardenedEnvironment } from "../../src/executor/git";
import {
  COMMIT_SUBJECT_PATTERN, SLOT_EXCLUDES_CONTENT, commitTypeFor, createGitOps, createGitRunner, encodeRefId, executorGitArgs, formatCommitMessage,
  integrationBranchName, phaseTagName, planRefPrefix, readCommitIdentity, taskBranchName,
  type GitOps,
} from "../../src/executor/git";
import { ExecutorError, type FileSystem, type Footprint, type GitRunner, type ProcessResult } from "../../src/executor/types";
import { createV2Observations } from "../../src/compat/v2-observations";
import { serviceObservation } from "../../src/executor/observations";
import * as gitTools from "../../src/router/git-tools";
import { completedServiceProcess, servicePairs } from "../helpers/service-observations";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));

const PLAN = "p-20261010-abc123";

describe("executorGitArgs", () => {
  const args = executorGitArgs({ hooksDir: "C:\\h\\no-hooks", excludesFile: "C:\\h\\ex", conversion: { autocrlf: null, eol: null } });
  it("sets hooksPath after the hardening prefix so a later -c wins over the NUL hooksPath", () => {
    const nul = args.findIndex(a => /^core\.hooksPath=(NUL|\/dev\/null)$/i.test(a));
    const ours = args.indexOf("core.hooksPath=C:\\h\\no-hooks");
    expect(ours).toBeGreaterThan(-1);
    if (nul !== -1) expect(ours).toBeGreaterThan(nul);
  });
  it("turns off editors, signing, rebase helpers and hooks", () => {
    for (const c of ["core.editor=:", "sequence.editor=:", "commit.gpgSign=false", "tag.gpgSign=false", "rerere.enabled=false",
      "submodule.recurse=false", "user.useConfigOnly=true", "core.longpaths=true", "core.excludesFile=C:\\h\\ex"]) {
      expect(args).toContain(c);
    }
  });
  it("adds line-ending settings only when the snapshot has them", () => {
    expect(args.some(a => a.startsWith("core.autocrlf="))).toBe(false);
    const withConv = executorGitArgs({ hooksDir: "h", excludesFile: "e", conversion: { autocrlf: "true", eol: "lf" } });
    expect(withConv).toContain("core.autocrlf=true");
    expect(withConv).toContain("core.eol=lf");
  });
  it("has the fixed excludes content", () => {
    expect(SLOT_EXCLUDES_CONTENT.split("\n")).toContain("node_modules/");
    expect(SLOT_EXCLUDES_CONTENT.endsWith("\n")).toBe(true);
  });
});

describe("encodeRefId", () => {
  const table: Array<[string, string]> = [
    ["1.1.1", "1.1.1"], ["2.4.QA", "2.4.qa_u30"], ["a..b", "a_0.b"], ["x.lock", "x_0lock"], ["t_1", "t__1"], ["a.", "a_0"],
  ];
  it.each(table)("%s -> %s", (id, out) => { expect(encodeRefId(id)).toBe(out); });
  it.each(["", " a", "a b", "-a", ".a", "a/b", "a:b", "a~b", "a^b", "a?b", "a*b", "a[b", "a\\b", "é", "a".repeat(65)])("rejects %j", id => {
    expect(() => encodeRefId(id)).toThrow(/cannot be encoded/);
  });
  it("maps 10k ids, including case variants, to distinct case-folded refs", () => {
    const alphabet = ["a", "A", "b", "B", ".", "_", "-", "1", "L", "l"];
    const seen = new Map<string, string>();
    let count = 0;
    const walk = (prefix: string, depth: number): void => {
      if (count >= 10_000) return;
      if (depth === 0) {
        if (!/^[A-Za-z0-9]/.test(prefix)) return;
        const enc = encodeRefId(prefix).toLowerCase();
        expect(seen.has(enc), `${prefix} collides with ${seen.get(enc)}`).toBe(false);
        seen.set(enc, prefix);
        count++;
        return;
      }
      for (const ch of alphabet) walk(prefix + ch, depth - 1);
    };
    for (const len of [1, 2, 3, 4, 5]) walk("", len);
    expect(count).toBe(10_000);
  });
});

describe("ref name builders", () => {
  it("builds the omr/<plan>/ names", () => {
    expect(planRefPrefix(PLAN)).toBe(`omr/${PLAN}/`);
    expect(taskBranchName(PLAN, "1.1.1")).toBe(`omr/${PLAN}/t/1.1.1`);
    expect(integrationBranchName(PLAN)).toBe(`omr/${PLAN}/integration`);
    expect(phaseTagName(PLAN, "2.4")).toBe(`omr/${PLAN}/phase/2.4`);
  });
  it("rejects a malformed plan id", () => {
    expect(() => planRefPrefix("Bad Plan")).toThrow(/invalid plan id/);
  });
});

describe("commit messages", () => {
  const base = { scope: "executor", planId: PLAN, taskId: "2.4.6" } as const;
  it.each(["feat", "fix", "test", "docs", "revert"] as const)("formats %s", type => {
    const m = formatCommitMessage({ ...base, type, title: "Add the pool" });
    expect(m).toBe(`${type}(executor): Add the pool [${PLAN}:2.4.6]`);
    expect(COMMIT_SUBJECT_PATTERN.test(m)).toBe(true);
    expect(m).not.toContain("\n");
  });
  it("replaces controls, collapses whitespace and keeps # titles", () => {
    expect(formatCommitMessage({ ...base, type: "feat", title: "  a\u0000b\tc\n\n#12  fix " })).toBe(`feat(executor): a b c #12 fix [${PLAN}:2.4.6]`);
    expect(formatCommitMessage({ ...base, type: "fix", title: "# heading" })).toBe(`fix(executor): # heading [${PLAN}:2.4.6]`);
  });
  it("uses the task id for an empty title", () => {
    expect(formatCommitMessage({ ...base, type: "feat", title: " \u0001 " })).toBe(`feat(executor): 2.4.6 [${PLAN}:2.4.6]`);
  });
  it("truncates a long title at a word boundary", () => {
    const title = "word ".repeat(30);
    const m = formatCommitMessage({ ...base, type: "feat", title });
    const t = /\): (.*) \[/.exec(m)?.[1] ?? "";
    expect(t.length).toBeLessThanOrEqual(72);
    expect(t.endsWith("word")).toBe(true);
    expect(title.startsWith(t)).toBe(true);
  });
  it("hard-cuts a long title without a usable space and never splits a surrogate pair", () => {
    const m = formatCommitMessage({ ...base, type: "feat", title: "x".repeat(100) });
    expect(/\): (.*) \[/.exec(m)?.[1]).toBe("x".repeat(72));
    const emoji = formatCommitMessage({ ...base, type: "feat", title: `${"x".repeat(71)}\u{1F600}${"y".repeat(10)}` });
    expect(/\): (.*) \[/.exec(emoji)?.[1]).toBe("x".repeat(71));
  });
  it("rejects a scope or task id that breaks the pattern", () => {
    expect(() => formatCommitMessage({ ...base, type: "feat", scope: "a b", title: "t" })).toThrow(/does not match/);
    expect(() => formatCommitMessage({ ...base, type: "feat", taskId: "x y", title: "t" })).toThrow(/does not match/);
  });
  it("has no trailers", () => {
    expect(formatCommitMessage({ ...base, type: "revert", title: "Revert x" })).not.toMatch(/\n|Co-authored|Signed-off/i);
  });
});

describe("commitTypeFor", () => {
  const fp = (writes: string[]): Footprint => ({ reads: [], writes, confidence: "explicit", sources: ["path"] });
  it("maps task kinds", () => {
    expect(commitTypeFor({ kind: "task", footprint: fp(["src/a.ts"]) })).toBe("feat");
    expect(commitTypeFor({ kind: "task", footprint: fp([]) })).toBe("feat");
    expect(commitTypeFor({ kind: "task", footprint: fp(["README.md", "docs/x.txt"]) })).toBe("docs");
    expect(commitTypeFor({ kind: "task", footprint: fp(["README.md", "src/a.ts"]) })).toBe("feat");
    expect(commitTypeFor({ kind: "fix", footprint: fp([]) })).toBe("fix");
    expect(commitTypeFor({ kind: "tests", footprint: fp([]) })).toBe("test");
    expect(commitTypeFor({ kind: "qa", footprint: fp([]) })).toBe("docs");
  });
  it("refuses manual and preflight", () => {
    expect(() => commitTypeFor({ kind: "manual", footprint: fp([]) })).toThrow(/never commits/);
    expect(() => commitTypeFor({ kind: "preflight", footprint: fp([]) })).toThrow(/never commits/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GitOps against a fake runner and a fake file system
// ---------------------------------------------------------------------------------------------------------------

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const HOME = join(tmpdir(), "omr-git-unit-home");
const TOP = join(tmpdir(), "omr-git-unit-top");
const LOCK = "omr-executor slot test";
const SLOT_PATH = join(tmpdir(), "omr-slots-x", "slot-1");

interface Recorded { args: string[]; cwd: string }
type Handler = (args: string[], cwd: string) => Partial<ProcessResult> | undefined;
interface FakeRunner extends GitRunner { calls: Recorded[] }

function result(r: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, ...r };
}

function fakeRunner(handler: Handler = () => undefined): FakeRunner {
  const calls: Recorded[] = [];
  return {
    calls,
    async run(args, o) {
      calls.push({ args: [...args], cwd: o.cwd });
      return result(handler([...args], o.cwd));
    },
  };
}

/** The git sub-command and its arguments, after the executor `-c` prefix, identity `-c` pairs and scope options. */
function sub(args: readonly string[]): string[] {
  let i = args.indexOf("user.useConfigOnly=true") + 1;
  while (i < args.length) {
    if (args[i] === "-c") { i += 2; continue; }
    if ((args[i] ?? "").startsWith("--git-dir=") || (args[i] ?? "").startsWith("--work-tree=")) { i++; continue; }
    break;
  }
  return args.slice(i);
}

function subs(r: FakeRunner): string[][] {
  return r.calls.filter(c => c.args.includes("user.useConfigOnly=true")).map(c => sub(c.args));
}

function enoent(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
}

/** A value of "dir" is a directory, "junction" a junction, anything else a file with that content; `reals` overrides realpath. */
function memoryFs(seed: Record<string, "dir" | string> = {}): FileSystem & { entries: Map<string, "dir" | string>; reals: Map<string, string> } {
  const entries = new Map<string, "dir" | string>();
  const reals = new Map<string, string>();
  for (const [p, v] of Object.entries(seed)) entries.set(resolve(p), v);
  return {
    entries,
    reals,
    async readText(p) { const v = entries.get(resolve(p)); if (v === undefined || v === "dir") throw enoent(p); return v; },
    async writeText(p, data) { entries.set(resolve(p), data); },
    async appendText(p, data) { entries.set(resolve(p), `${entries.get(resolve(p)) ?? ""}${data}`); },
    async rename(a, b) { const v = entries.get(resolve(a)); if (v === undefined) throw enoent(a); entries.delete(resolve(a)); entries.set(resolve(b), v); },
    async rm(p) { entries.delete(resolve(p)); },
    async mkdir(p) { entries.set(resolve(p), "dir"); },
    async readdir(p) {
      const base = resolve(p);
      return [...entries.keys()].filter(k => dirname(k) === base && k !== base).map(k => basename(k));
    },
    async lstat(p) {
      const v = entries.get(resolve(p));
      if (v === undefined) return null;
      return { kind: v === "dir" ? "dir" : v === "junction" ? "junction" : "file", size: v === "dir" ? 0 : v.length, mtimeMs: 0 };
    },
    async realpath(p) { return reals.get(resolve(p)) ?? resolve(p); },
    async fsyncDir() { /* nothing to flush in memory */ },
  };
}

function identityRunner(values: Record<string, string | null> = { "user.name": "Ann Dev", "user.email": "ann@example.test" }): FakeRunner {
  return fakeRunner(args => {
    const key = args[args.length - 1] ?? "";
    const v = values[key];
    if (v === undefined || v === null) return { code: 1 };
    return { stdout: `${v}\n` };
  });
}

function makeOps(git: GitRunner, userGit: GitRunner = identityRunner(), fs: FileSystem = memoryFs()): GitOps {
  return createGitOps({ git, userGit, fs, planId: PLAN, toplevel: TOP, executorHome: HOME });
}

describe("GitOps context and identity", () => {
  it("reads the identity from the user runner with config --includes --get, never git var", async () => {
    const user = identityRunner({ "user.name": "Ann Dev", "user.email": "ann@example.test", "core.autocrlf": "true" });
    const ops = makeOps(fakeRunner(), user);
    await ops.worktreeList();
    const keys = user.calls.map(c => c.args.join(" "));
    expect(keys).toContain("config --includes --get user.name");
    expect(keys).toContain("config --includes --get user.email");
    expect(keys.some(k => k.includes("var"))).toBe(false);
    expect(user.calls.every(c => c.cwd === TOP)).toBe(true);
  });

  it("passes the line-ending snapshot into every call", async () => {
    const user = identityRunner({ "user.name": "A", "user.email": "a@b.c", "core.autocrlf": "true", "core.eol": "lf" });
    const git = fakeRunner();
    await makeOps(git, user).worktreeList();
    expect(git.calls[0]?.args).toContain("core.autocrlf=true");
    expect(git.calls[0]?.args).toContain("core.eol=lf");
  });

  it("omits whitespace-only line-ending settings from the git context", async () => {
    const user = identityRunner({ "user.name": "A", "user.email": "a@b.c", "core.autocrlf": " \t ", "core.eol": "  " });
    await expect(readCommitIdentity(user, TOP)).resolves.toMatchObject({ conversion: { autocrlf: null, eol: null } });
    const git = fakeRunner();
    await makeOps(git, user).worktreeList();
    expect(git.calls[0]?.args.some(arg => /^core\.(autocrlf|eol)=/.test(arg))).toBe(false);
  });

  it("throws E_IDENTITY with an actionable message when user.name or user.email is absent", async () => {
    for (const missing of ["user.name", "user.email"]) {
      const user = identityRunner({ "user.name": "A", "user.email": "a@b.c", [missing]: null });
      const git = fakeRunner();
      const error = await makeOps(git, user).worktreeList().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ExecutorError);
      expect(error).toMatchObject({ code: "E_IDENTITY" });
      expect((error as Error).message).toMatch(/git config user\.name/);
      expect((error as Error).message).toMatch(/never invents/);
      expect(git.calls).toHaveLength(0);
    }
  });

  it.each([
    ["empty", ""], ["blank", "   "], ["angle", "A <b>"], ["gt", "a>b"],
  ])("rejects a %s identity value", async (_label, value) => {
    const user = identityRunner({ "user.name": value, "user.email": "a@b.c" });
    await expect(makeOps(fakeRunner(), user).worktreeList()).rejects.toMatchObject({ code: "E_IDENTITY" });
  });

  it("rejects an unsupported core.eol value and a failing config read", async () => {
    const odd = identityRunner({ "user.name": "A", "user.email": "a@b.c", "core.eol": "l f;" });
    await expect(makeOps(fakeRunner(), odd).worktreeList()).rejects.toMatchObject({ code: "E_GIT" });
    const broken = fakeRunner(() => ({ code: 128, stderr: "fatal: bad config" }));
    await expect(makeOps(fakeRunner(), broken).worktreeList()).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("caches a successful read per runner and does not cache a failure", async () => {
    const user = identityRunner();
    const ops = makeOps(fakeRunner(), user);
    await ops.worktreeList();
    await ops.worktreeList();
    expect(user.calls).toHaveLength(4);
    const first = readCommitIdentity(user, TOP);
    expect(readCommitIdentity(user, TOP)).toBe(first);
    await first;
    let phase = 0;
    const flaky = fakeRunner(args => {
      const key = args[args.length - 1] ?? "";
      if (phase === 0 || key.startsWith("core.")) return { code: 1 };
      return { stdout: `${key}-value\n` };
    });
    await expect(readCommitIdentity(flaky, TOP)).rejects.toMatchObject({ code: "E_IDENTITY" });
    phase = 1;
    await expect(readCommitIdentity(flaky, TOP)).resolves.toMatchObject({ name: "user.name-value" });
  });

  it("creates the hooks directory and the excludes file, and refuses a non-empty hooks directory", async () => {
    const fs = memoryFs();
    await makeOps(fakeRunner(), identityRunner(), fs).worktreeList();
    expect(fs.entries.get(join(HOME, "git", "no-hooks"))).toBe("dir");
    expect(fs.entries.get(join(HOME, "git", "slot-excludes"))).toBe(SLOT_EXCLUDES_CONTENT);
    const dirty = memoryFs({ [join(HOME, "git", "no-hooks", "pre-commit")]: "x" });
    dirty.entries.set(resolve(HOME), "dir");
    dirty.entries.set(resolve(join(HOME, "git")), "dir");
    dirty.entries.set(resolve(join(HOME, "git", "no-hooks")), "dir");
    await expect(makeOps(fakeRunner(), identityRunner(), dirty).worktreeList()).rejects.toThrow(/not empty/);
  });

  it("refuses a file where the executor git directory should be", async () => {
    const fs = memoryFs({ [HOME]: "file" });
    await expect(makeOps(fakeRunner(), identityRunner(), fs).worktreeList()).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("propagates directory creation failures without invoking git", async () => {
    const fs = memoryFs();
    const failure = Object.assign(new Error("executor home is read-only"), { code: "EACCES" });
    vi.spyOn(fs, "mkdir").mockRejectedValue(failure);
    const git = fakeRunner();
    await expect(makeOps(git, identityRunner(), fs).worktreeList()).rejects.toBe(failure);
    expect(git.calls).toHaveLength(0);
  });

  it("tolerates a concurrent creator of the executor git directories", async () => {
    const fs = memoryFs();
    const mkdir = fs.mkdir.bind(fs);
    fs.mkdir = async path => {
      await mkdir(path);
      throw Object.assign(new Error("created concurrently"), { code: "EEXIST" });
    };
    const git = fakeRunner();
    await expect(makeOps(git, identityRunner(), fs).worktreeList()).resolves.toEqual([]);
    expect(fs.entries.get(resolve(join(HOME, "git", "slot-excludes")))).toBe(SLOT_EXCLUDES_CONTENT);
    expect(subs(git)).toEqual([["worktree", "list", "--porcelain"]]);
  });

  it("refuses an excludes directory rather than overwriting it", async () => {
    const excludes = join(HOME, "git", "slot-excludes");
    const fs = memoryFs({ [excludes]: "dir" });
    const git = fakeRunner();
    await expect(makeOps(git, identityRunner(), fs).worktreeList()).rejects.toMatchObject({
      code: "E_GIT", message: "slot excludes path is not a file", detail: { path: excludes },
    });
    expect(fs.entries.get(resolve(excludes))).toBe("dir");
    expect(git.calls).toHaveLength(0);
  });

  it("refuses a hooks directory missing after creation", async () => {
    const fs = memoryFs();
    const hooks = join(HOME, "git", "no-hooks");
    const mkdir = fs.mkdir.bind(fs);
    fs.mkdir = async path => { if (path !== hooks) await mkdir(path); };
    const git = fakeRunner();
    await expect(makeOps(git, identityRunner(), fs).worktreeList()).rejects.toMatchObject({
      code: "E_GIT", message: "hooks directory is not a real directory", detail: { path: hooks },
    });
    expect(git.calls).toHaveLength(0);
  });

  it("rechecks the hooks directory even after the context has been cached", async () => {
    const fs = memoryFs();
    const git = fakeRunner();
    const ops = makeOps(git, identityRunner(), fs);
    await ops.worktreeList();
    fs.entries.delete(resolve(join(HOME, "git", "no-hooks")));
    await expect(ops.worktreeList()).rejects.toMatchObject({ code: "E_GIT", message: "hooks directory is not a real directory" });
    expect(git.calls).toHaveLength(1);
  });

  it("every repository call starts with the hardening prefix and the hooks directory", async () => {
    const git = fakeRunner();
    await makeOps(git).worktreeList();
    const args = git.calls[0]?.args ?? [];
    expect(args.indexOf(`core.hooksPath=${join(HOME, "git", "no-hooks")}`)).toBeGreaterThan(-1);
    expect(sub(args)).toEqual(["worktree", "list", "--porcelain"]);
    expect(git.calls[0]?.cwd).toBe(TOP);
    expect(args.some(a => a.startsWith("user.name="))).toBe(false);
  });
});

describe("GitOps version and ref format", () => {
  it("parses and caches the version", async () => {
    const git = fakeRunner(() => ({ stdout: "git version 2.45.1.windows.1\n" }));
    const ops = makeOps(git);
    await expect(ops.version()).resolves.toBe("2.45.1");
    await expect(ops.version()).resolves.toBe("2.45.1");
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0]?.args).toEqual(["--version"]);
  });

  it("accepts the minimum and refuses anything older or unparsable", async () => {
    await expect(makeOps(fakeRunner(() => ({ stdout: "git version 2.33.0" }))).version()).resolves.toBe("2.33.0");
    await expect(makeOps(fakeRunner(() => ({ stdout: "git version 3.0" }))).version()).resolves.toBe("3.0.0");
    await expect(makeOps(fakeRunner(() => ({ stdout: "git version 2.32.9" }))).version()).rejects.toMatchObject({ code: "E_GIT" });
    await expect(makeOps(fakeRunner(() => ({ stdout: "git version 1.9.9" }))).version()).rejects.toMatchObject({ code: "E_GIT" });
    await expect(makeOps(fakeRunner(() => ({ stdout: "nonsense" }))).version()).rejects.toThrow(/cannot parse/);
    await expect(makeOps(fakeRunner(() => ({ code: 1 }))).version()).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("invokes git check-ref-format once per name and caches the verdict", async () => {
    const git = fakeRunner(args => (args.includes("refs/heads/bad") ? { code: 1 } : undefined));
    const ops = makeOps(git);
    await ops.checkRefFormat("good");
    await ops.checkRefFormat("good");
    await expect(ops.checkRefFormat("bad")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.checkRefFormat("bad")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    const checks = git.calls.filter(c => c.args.includes("check-ref-format"));
    expect(checks).toHaveLength(2);
    expect(checks[0]?.args.slice(-2)).toEqual(["check-ref-format", "refs/heads/good"]);
  });

  it("refuses a leading dash, control characters and an empty name without running git", async () => {
    const git = fakeRunner();
    const ops = makeOps(git);
    for (const name of ["", "-x", "a\u0001b", "a\nb", "x".repeat(251)]) {
      await expect(ops.checkRefFormat(name)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    }
    expect(git.calls).toHaveLength(0);
  });

  it("reports a git failure other than 1 as E_GIT", async () => {
    await expect(makeOps(fakeRunner(() => ({ code: 129 }))).checkRefFormat("x")).rejects.toMatchObject({ code: "E_GIT" });
  });

  it.each(["omr/p-20261010-abc123/t/1.1.1", `omr/${PLAN}/t/2.4.qa_u30`])("accepts %s as a ref", async name => {
    await expect(makeOps(fakeRunner()).checkRefFormat(name)).resolves.toBeUndefined();
  });
});

describe("GitOps runner failures", () => {
  it("stringifies non-Error runner failures and ignores a non-string error code", async () => {
    const failing: GitRunner = {
      async run() { throw { code: 7, toString: () => "cannot read https://user:secret@example.test/x" }; },
    };
    const error: unknown = await makeOps(failing).worktreeList().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "E_GIT", detail: { op: "worktree list", code: null, stderr: "" } });
    expect(error).toBeInstanceOf(ExecutorError);
    expect(String(error)).toContain("cannot read");
    expect(String(error)).not.toContain("secret");
  });

  it("preserves a runner's structured executor error", async () => {
    const failure = new ExecutorError("E_GIT", "runner rejected the operation", { diagnostic: "kept" });
    const failing: GitRunner = { async run() { throw failure; } };
    await expect(makeOps(failing).worktreeList()).rejects.toBe(failure);
  });

  it.each(["SIGTERM", null] as const)("reports a missing exit code using signal %s or unknown", async signal => {
    const git = fakeRunner(() => ({ code: null, signal, stderr: "fatal: interrupted" }));
    await expect(makeOps(git).worktreeList()).rejects.toMatchObject({
      code: "E_GIT",
      message: `git worktree list failed (exit ${signal ?? "unknown"})`,
      detail: { op: "worktree list", code: null, stderr: "fatal: interrupted" },
    });
  });

  it("wraps a thrown runner error as E_GIT without leaking URL credentials", async () => {
    const failing: GitRunner = {
      async run() { throw Object.assign(new Error("could not read https://user:secret@example.test/x"), { code: "ETIMEDOUT" }); },
    };
    const error = await makeOps(failing).worktreeList().then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: "E_GIT" });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect((error as Error).message).not.toContain("secret");
  });

  it("treats truncated output as E_GIT and keeps only the stderr tail", async () => {
    await expect(makeOps(fakeRunner(() => ({ truncated: true }))).worktreeList()).rejects.toThrow(/truncated/);
    const noisy = "x".repeat(5000) + "END https://u:pw@h.test/";
    const error = await makeOps(fakeRunner(() => ({ code: 3, stderr: noisy }))).worktreeList().then(() => null, (e: unknown) => e);
    const detail = JSON.stringify((error as ExecutorError).detail);
    expect(detail.length).toBeLessThan(2400);
    expect(detail).not.toContain("pw");
  });
});

describe("GitOps worktrees", () => {
  const SLOT = join(tmpdir(), "omr-slots-x", "slot-1");

  it("adds a detached, locked worktree after the version check", async () => {
    const git = fakeRunner(args => (args[0] === "--version" ? { stdout: "git version 2.45.0" } : undefined));
    await makeOps(git).worktreeAdd(SLOT, OID_A, LOCK);
    expect(git.calls[0]?.args).toEqual(["--version"]);
    expect(sub(git.calls[1]?.args ?? [])).toEqual(["worktree", "add", "--detach", "--lock", "--reason", LOCK, SLOT, OID_A]);
    expect(git.calls[1]?.cwd).toBe(TOP);
  });

  it("refuses a relative path, a short commit and a bad lock reason before running git", async () => {
    const git = fakeRunner();
    const ops = makeOps(git);
    await expect(ops.worktreeAdd("rel/slot", OID_A, LOCK)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.worktreeAdd(SLOT, "abc", LOCK)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.worktreeAdd(SLOT, OID_A, "bad\\reason")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.worktreeAdd(SLOT, OID_A, "")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(git.calls).toHaveLength(0);
  });

  it("refuses worktreeRemove while the directory exists and runs nothing", async () => {
    const git = fakeRunner();
    const fs = memoryFs({ [SLOT]: "dir" });
    await expect(makeOps(git, identityRunner(), fs).worktreeRemove(SLOT, LOCK)).rejects.toThrow(/still exists/);
    expect(git.calls).toHaveLength(0);
  });

  const listing = (locked: string) =>
    `worktree ${TOP}\nHEAD ${OID_A}\nbranch refs/heads/main\n\nworktree ${SLOT}\nHEAD ${OID_B}\ndetached\n${locked}\n\n`;

  it("unlocks a worktree locked with exactly our reason, then removes the entry", async () => {
    const git = fakeRunner(args => (sub(args)[0] === "worktree" && sub(args)[1] === "list" ? { stdout: listing(`locked ${LOCK}`) } : undefined));
    await makeOps(git).worktreeRemove(SLOT, LOCK);
    const verbs = subs(git).map(s => s.slice(0, 2).join(" "));
    expect(verbs).toEqual(["worktree list", "worktree unlock", "worktree remove"]);
    expect(subs(git)[2]).toEqual(["worktree", "remove", "--force", SLOT]);
    expect(subs(git).some(s => s.includes("prune"))).toBe(false);
  });

  it("refuses to touch a worktree locked by someone else and ignores one git does not list", async () => {
    const other = fakeRunner(args => (sub(args)[1] === "list" ? { stdout: listing("locked someone else") } : undefined));
    await expect(makeOps(other).worktreeRemove(SLOT, LOCK)).rejects.toThrow(/locked by someone else/);
    expect(subs(other).map(s => s[1])).toEqual(["list"]);
    const absent = fakeRunner(args => (sub(args)[1] === "list" ? { stdout: `worktree ${TOP}\nHEAD ${OID_A}\n\n` } : undefined));
    await makeOps(absent).worktreeRemove(SLOT, LOCK);
    expect(subs(absent)).toHaveLength(1);
  });

  it("removes an unlocked entry without unlocking and rejects a relative path", async () => {
    const git = fakeRunner(args => (sub(args)[1] === "list" ? { stdout: listing("") } : undefined));
    await makeOps(git).worktreeRemove(SLOT, LOCK);
    expect(subs(git).map(s => s[1])).toEqual(["list", "remove"]);
    await expect(makeOps(git).worktreeRemove("rel", LOCK)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("parses the porcelain list, including a bare lock", async () => {
    const out = `worktree ${TOP}\nHEAD ${OID_A}\nbranch refs/heads/main\n\nworktree ${SLOT}\nHEAD ${OID_B}\ndetached\nlocked\n\n`;
    const entries = await makeOps(fakeRunner(() => ({ stdout: out }))).worktreeList();
    expect(entries).toEqual([
      { path: resolve(TOP), head: OID_A, branch: "refs/heads/main", locked: null },
      { path: resolve(SLOT), head: OID_B, branch: null, locked: "" },
    ]);
  });
});

describe("GitOps refs", () => {
  const listed = (...refs: string[]) => refs.map(r => `${r}\0${OID_A}\n`).join("");

  it("deleteRefs deletes exactly the refs under the plan prefix with a compare-and-swap", async () => {
    const git = fakeRunner(args => {
      if (sub(args)[0] === "for-each-ref") {
        return { stdout: listed(`refs/heads/omr/${PLAN}/t/1`, `refs/tags/omr/${PLAN}/phase/2`, "refs/heads/omr/other-plan-1/t/1", "refs/heads/main") };
      }
      return undefined;
    });
    const deleted = await makeOps(git).deleteRefs(`omr/${PLAN}/`);
    expect(deleted).toEqual([`refs/heads/omr/${PLAN}/t/1`, `refs/tags/omr/${PLAN}/phase/2`]);
    const updates = subs(git).filter(s => s[0] === "update-ref");
    expect(updates).toEqual([
      ["update-ref", "-d", "--no-deref", `refs/heads/omr/${PLAN}/t/1`, OID_A],
      ["update-ref", "-d", "--no-deref", `refs/tags/omr/${PLAN}/phase/2`, OID_A],
    ]);
    const forEach = subs(git).find(s => s[0] === "for-each-ref");
    expect(forEach?.slice(-2)).toEqual([`refs/heads/omr/${PLAN}/`, `refs/tags/omr/${PLAN}/`]);
    expect(git.calls.some(c => c.args.includes("check-ref-format"))).toBe(true);
  });

  // QA-2.4-4
  it("deleteRefs skips a branch that is checked out in any worktree", async () => {
    const out = (ref: string) => `${ref}\0${OID_A}\n`;
    const git = fakeRunner(args => {
      const s = sub(args);
      if (s[0] === "for-each-ref") return { stdout: out(`refs/heads/omr/${PLAN}/t/1`) + out(`refs/heads/omr/${PLAN}/t/2`) };
      if (s[0] === "worktree") return { stdout: `worktree ${SLOT_PATH}\nHEAD ${OID_A}\nbranch refs/heads/omr/${PLAN}/t/1\n\n` };
      return undefined;
    });
    await expect(makeOps(git).deleteRefs(`omr/${PLAN}/`)).resolves.toEqual([`refs/heads/omr/${PLAN}/t/2`]);
    expect(subs(git).filter(s => s[0] === "update-ref")).toEqual([["update-ref", "-d", "--no-deref", `refs/heads/omr/${PLAN}/t/2`, OID_A]]);
  });

  it("deleteRefs accepts a deeper slash-terminated prefix of the plan", async () => {
    const git = fakeRunner();
    await expect(makeOps(git).deleteRefs(`omr/${PLAN}/t/`)).resolves.toEqual([]);
  });

  it.each([
    "", "omr/", "omr", "cpx/", "refs/heads/", `omr/${PLAN}`, "omr/p-20261010-abc1234/", "omr/p-20261010-abc12/", `omr/${PLAN}//`,
    `omr/${PLAN}/../x/`, `omr/${PLAN}/t/..x/`, `OMR/${PLAN}/`, `x/omr/${PLAN}/`,
  ])("deleteRefs refuses %j and runs no git", async prefix => {
    const git = fakeRunner();
    await expect(makeOps(git).deleteRefs(prefix)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(git.calls).toHaveLength(0);
  });

  it("deleteRefs refuses a prefix git considers malformed", async () => {
    const git = fakeRunner(args => (args.includes("check-ref-format") ? { code: 1 } : undefined));
    await expect(makeOps(git).deleteRefs(`omr/${PLAN}/a~b/`)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(subs(git)).toHaveLength(0);
  });

  it("deleteRefs skips lines with a malformed object id", async () => {
    const git = fakeRunner(args => (sub(args)[0] === "for-each-ref" ? { stdout: `refs/heads/omr/${PLAN}/t/1\0zzz\n` } : undefined));
    await expect(makeOps(git).deleteRefs(`omr/${PLAN}/`)).resolves.toEqual([]);
  });

  it("tag and branchForce refuse names outside the plan prefix", async () => {
    const git = fakeRunner();
    const ops = makeOps(git);
    for (const name of ["main", "omr/", `omr/${PLAN}/`, "omr/other-plan-9/t/1", "cpx/p24", `omr/${PLAN}`]) {
      await expect(ops.tag(name, OID_A)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
      await expect(ops.branchForce(name, OID_A, null)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    }
    await expect(ops.tag(`omr/${PLAN}/phase/2`, "nope")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(subs(git)).toHaveLength(0);
  });

  it("tags with the full name and commit", async () => {
    const git = fakeRunner();
    await makeOps(git).tag(`omr/${PLAN}/phase/2`, OID_A);
    expect(subs(git)).toEqual([["tag", `omr/${PLAN}/phase/2`, OID_A]]);
  });

  // QA-2.4-4
  it("branchForce always compares and swaps with --no-deref: the old id, or zeros for a branch that must not exist", async () => {
    const name = `omr/${PLAN}/t/1`;
    const git = fakeRunner(args => (sub(args)[0] === "symbolic-ref" ? { code: 1 } : undefined));
    const ops = makeOps(git);
    await ops.branchForce(name, OID_A, OID_B);
    await ops.branchForce(name, OID_A, null);
    const updates = subs(git).filter(s => s[0] === "update-ref");
    expect(updates).toEqual([
      ["update-ref", "--no-deref", `refs/heads/${name}`, OID_A, OID_B],
      ["update-ref", "--no-deref", `refs/heads/${name}`, OID_A, "0".repeat(40)],
    ]);
    await expect(ops.branchForce(name, OID_A, "short")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.branchForce(name, OID_A, undefined as unknown as string)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.branchForce(name, "short", null)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  // QA-2.4-4
  it("branchForce refuses a symbolic ref and runs update-ref for nothing else", async () => {
    const name = `omr/${PLAN}/t/1`;
    const symbolic = fakeRunner(args => (sub(args)[0] === "symbolic-ref" ? { code: 0, stdout: "refs/heads/main\n" } : undefined));
    await expect(makeOps(symbolic).branchForce(name, OID_A, OID_B)).rejects.toThrow(/symbolic ref/);
    expect(subs(symbolic).find(s => s[0] === "symbolic-ref")).toEqual(["symbolic-ref", "-q", `refs/heads/${name}`]);
    expect(subs(symbolic).some(s => s[0] === "update-ref")).toBe(false);
    const failing = fakeRunner(args => (sub(args)[0] === "symbolic-ref" ? { code: 128 } : undefined));
    await expect(makeOps(failing).branchForce(name, OID_A, OID_B)).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("branchForce refuses a branch checked out in a worktree", async () => {
    const name = `omr/${PLAN}/t/1`;
    const git = fakeRunner(args => (sub(args)[1] === "list"
      ? { stdout: `worktree ${TOP}\nHEAD ${OID_A}\nbranch refs/heads/${name}\n\n` } : undefined));
    await expect(makeOps(git).branchForce(name, OID_A, OID_B)).rejects.toThrow(/checked out in a worktree/);
    expect(subs(git).some(s => s[0] === "update-ref")).toBe(false);
  });

  // QA-2.4-19
  it("passes the identity -c on every ref-writing op: tag, update-ref and worktree add", async () => {
    const name = `omr/${PLAN}/t/1`;
    const git = fakeRunner(args => (sub(args)[0] === "symbolic-ref" ? { code: 1 } : args.includes("--version") ? { stdout: "git version 2.45.0\n" } : undefined));
    const ops = makeOps(git);
    await ops.tag(`omr/${PLAN}/phase/2`, OID_A);
    await ops.branchForce(name, OID_A, null);
    await ops.worktreeAdd(SLOT_PATH, OID_A, LOCK);
    for (const verb of ["tag", "update-ref", "worktree"]) {
      const call = git.calls.find(c => sub(c.args)[0] === verb && (verb !== "worktree" || sub(c.args)[1] === "add"));
      expect(call?.args, verb).toContain("user.name=Ann Dev");
      expect(call?.args, verb).toContain("user.email=ann@example.test");
    }
  });
});

describe("GitOps repository reads", () => {
  it.each(["executable", "environment"] as const)("excludes the production GitRunner's %s preparation from merge service", async preparation => {
    const run = async (delayMs: number) => {
      let now = 0;
      const lines: string[] = [];
      const sink = createV2Observations({ write: line => { lines.push(line); } });
      const repo = resolve(".");
      const guards = vi.spyOn(gitTools, "workRootGuards").mockReturnValue([repo]);
      const executable = vi.spyOn(gitTools, "gitExecutable").mockImplementation(() => {
        if (preparation === "executable") now += delayMs;
        return "git";
      });
      const gitEnvironment = gitTools.gitEnvironment;
      const environment = vi.spyOn(gitTools, "gitEnvironment").mockImplementation(extra => {
        if (preparation === "environment") now += delayMs;
        return gitEnvironment(extra);
      });
      vi.mocked(spawn).mockImplementation(() => completedServiceProcess(() => { now += 11; }));
      const production = createGitRunner({ mode: "hardened", toplevel: repo });
      const git: GitRunner = {
        // Repository preconditions are doubles; the observed merge uses the REAL runner and spawnBounded.
        run: async (args, opts) => sub(args)[0] === "merge" ? production.run(args, opts) : result({ stdout: OID_B }),
      };
      const ops = createGitOps({ git, userGit: identityRunner(), fs: memoryFs(), planId: PLAN, toplevel: repo, executorHome: HOME });
      const observation = serviceObservation(sink, () => ({ planId: PLAN, taskId: null, attempt: null,
        phaseId: "p1", entryId: "i-1", taskIds: ["T1"], component: "fast-forward", candidate: OID_B }), () => now);
      try {
        expect(await ops.mergeFfOnly(repo, OID_B, observation)).toEqual({ ok: true, head: OID_B });
        expect(executable).toHaveBeenCalledOnce();
        expect(environment).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledOnce();
        sink.close();
        return { elapsed: now, rows: servicePairs(lines) };
      } finally {
        sink.close();
        guards.mockRestore();
        executable.mockRestore();
        environment.mockRestore();
        vi.mocked(spawn).mockReset();
      }
    };
    const baseline = await run(0);
    const delayed = await run(2_000);
    expect(delayed.elapsed - baseline.elapsed).toBe(2_000);
    for (const result of [baseline, delayed]) {
      expect(result.rows.filter(r => r.spanKind === "service" && r.action === "end")).toMatchObject([
        { stage: "merge", candidate: OID_B, durationMs: 11, result: "pass" },
      ]);
    }
    expect(delayed.rows).toContainEqual(expect.objectContaining({ spanKind: "service-prep", action: "end", durationMs: 2_000 }));
  });

  it("revParse peels to a commit and validates the revision and the output", async () => {
    const git = fakeRunner(() => ({ stdout: `${OID_A}\n` }));
    const ops = makeOps(git);
    await expect(ops.revParse(TOP, "HEAD")).resolves.toBe(OID_A);
    expect(subs(git)[0]).toEqual(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
    await expect(ops.revParse(TOP, "")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.revParse(TOP, "a\nb")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(makeOps(fakeRunner(() => ({ stdout: "not-an-oid" }))).revParse(TOP, "HEAD")).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("diffNames splits NUL output and requires full ids", async () => {
    const git = fakeRunner(() => ({ stdout: "a.txt\0dir/b.txt\0" }));
    const ops = makeOps(git);
    await expect(ops.diffNames(TOP, OID_A, OID_B)).resolves.toEqual(["a.txt", "dir/b.txt"]);
    expect(subs(git)[0]).toEqual(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", OID_A, OID_B, "--"]);
    await expect(ops.diffNames(TOP, "HEAD", OID_B)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("isAncestor maps exit codes 0, 1 and others", async () => {
    await expect(makeOps(fakeRunner(() => ({ code: 0 }))).isAncestor(OID_A, OID_B)).resolves.toBe(true);
    await expect(makeOps(fakeRunner(() => ({ code: 1 }))).isAncestor(OID_A, OID_B)).resolves.toBe(false);
    await expect(makeOps(fakeRunner(() => ({ code: 128 }))).isAncestor(OID_A, OID_B)).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("mergeFfOnly reports a non-fast-forward without merging, and merges otherwise", async () => {
    const heads = [OID_A, OID_B];
    const refuse = fakeRunner(args => (sub(args)[0] === "rev-parse" ? { stdout: `${OID_A}\n` } : sub(args)[0] === "merge-base" ? { code: 1 } : undefined));
    await expect(makeOps(refuse).mergeFfOnly(TOP, OID_B)).resolves.toEqual({ ok: false, head: OID_A });
    expect(subs(refuse).some(s => s[0] === "merge")).toBe(false);
    const accept = fakeRunner(args => (sub(args)[0] === "rev-parse" ? { stdout: `${heads.shift() ?? OID_B}\n` } : undefined));
    await expect(makeOps(accept).mergeFfOnly(TOP, OID_B)).resolves.toEqual({ ok: true, head: OID_B });
    expect(subs(accept).find(s => s[0] === "merge")).toEqual(["merge", "--ff-only", "--no-edit", OID_B]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// In-slot operations: a real directory layout for the `.git` pointers, a fake runner for git
// ---------------------------------------------------------------------------------------------------------------

describe("GitOps in a slot", () => {
  let root = "";
  let top = "";
  let slot = "";
  let gitdir = "";
  let common = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "omr-git-slot-"));
    top = join(root, "top");
    slot = join(root, "slots", "slot-1");
    common = join(top, ".git");
    gitdir = join(common, "worktrees", "slot-1");
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    writeFileSync(join(slot, ".git"), `gitdir: ${gitdir}\n`);
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  const BACK = () => ({ [slot]: "dir", [join(gitdir, "gitdir")]: `${join(slot, ".git")}\n` });

  function slotOps(handler: Handler = () => undefined, seed: Record<string, string> = {}, user: GitRunner = identityRunner()) {
    const git = fakeRunner(handler);
    const fs = memoryFs({ ...BACK(), ...seed });
    return { git, fs, ops: createGitOps({ git, userGit: user, fs, planId: PLAN, toplevel: top, executorHome: HOME }) };
  }

  it.each([false, true])("G8 git process spans exclude identity/pointer/precondition/result preparation, with parity (failure=%s)", async failure => {
    const run = async (mode: "off" | "on" | "throw") => {
      let now = 0;
      const lines: string[] = [];
      const sink = createV2Observations({ write: line => { lines.push(line); } });
      if (mode === "throw") sink.record = () => { throw new Error("observer"); };
      const user = identityRunner();
      const userRun = user.run.bind(user);
      user.run = async (args, options) => { now += 1_000; return userRun(args, options); };
      const { ops, git, fs } = slotOps(args => {
        const op = sub(args)[0];
        if (op === "rebase") {
          now += 7;
          if (failure) throw new Error("rebase spawn failed");
        } else if (op === "merge") now += 5;
        else if (op === "update-ref") now += 3;
        else now += 500;
        if (op === "rev-parse") return { stdout: OID_B };
        if (op === "symbolic-ref") return { code: 1 };
        return undefined;
      }, {}, user);
      const lstat = fs.lstat.bind(fs);
      fs.lstat = async path => { now += 1_000; return lstat(path); };
      const observation = (component: "rebase" | "fast-forward") => serviceObservation(mode === "off" ? undefined : sink,
        () => ({ planId: PLAN, taskId: null, attempt: null, phaseId: "p1", entryId: "i-1", taskIds: ["T1", "T2"], component, candidate: OID_B }), () => now);
      try {
        const rebase = await ops.rebaseOnto(slot, OID_A, OID_B, observation("rebase")).catch((e: unknown) => e instanceof Error ? e.message : String(e));
        const merge = await ops.mergeFfOnly(top, OID_B, observation("fast-forward"));
        await ops.branchForce(integrationBranchName(PLAN), OID_B, OID_A, observation("fast-forward"));
        sink.close();
        return { rebase, merge, calls: git.calls, userCalls: user.calls, elapsed: now, rows: mode === "on" ? servicePairs(lines) : [] };
      } finally { sink.close(); }
    };
    const off = await run("off");
    for (const mode of ["on", "throw"] as const) {
      const { rows, ...effects } = await run(mode);
      const { rows: _offRows, ...original } = off;
      expect(effects).toEqual(original);
      if (mode === "on") {
        expect(rows.filter(r => r.action === "end" && r.spanKind === "service")).toMatchObject([
          { stage: "rebase", durationMs: 7, result: failure ? "error" : "pass" },
          { stage: "merge", durationMs: 5, result: "pass" }, { stage: "cas", durationMs: 3, result: "pass" },
        ]);
        expect(rows.some(r => r.spanKind === "service-prep" && r.durationMs >= 1_000)).toBe(true);
        expect(effects.elapsed).toBeGreaterThan(5_000);
      }
    }
  });

  it("verifySlotPointers accepts a linked worktree of this repository", async () => {
    const { ops } = slotOps();
    await expect(ops.verifySlotPointers(slot)).resolves.toEqual({ gitdir, common });
  });

  it("verifySlotPointers refuses every broken pointer with E_SLOT_BROKEN", async () => {
    const { ops, fs } = slotOps();
    const other = mkdtempSync(join(root, "bad-"));
    fs.entries.set(resolve(other), "dir");
    await expect(ops.verifySlotPointers(other)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    mkdirSync(join(other, ".git"));
    await expect(ops.verifySlotPointers(other)).rejects.toThrow(/not a regular file/);
    rmSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(other, "admin"));
    writeFileSync(join(other, ".git"), `gitdir: ${join(other, "admin")}\n`);
    await expect(ops.verifySlotPointers(other)).rejects.toThrow(/linked worktree/);
    writeFileSync(join(other, "admin", "commondir"), "..\n");
    await expect(ops.verifySlotPointers(other)).rejects.toThrow(/common directory is not the repository/);
    await expect(ops.verifySlotPointers("relative")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("verifySlotPointers refuses a git directory outside <common>/worktrees, a missing or foreign back-pointer", async () => {
    const outside = mkdtempSync(join(root, "adm-"));
    writeFileSync(join(outside, "commondir"), `${common}\n`);
    const target = mkdtempSync(join(root, "co-"));
    writeFileSync(join(target, ".git"), `gitdir: ${outside}\n`);
    const withTarget = slotOps();
    withTarget.fs.entries.set(resolve(target), "dir");
    await expect(withTarget.ops.verifySlotPointers(target)).rejects.toThrow(/not under <common>\/worktrees/);
    await expect(slotOps(() => undefined, { [join(gitdir, "gitdir")]: `${join(root, "elsewhere", ".git")}\n` }).ops.verifySlotPointers(slot))
      .rejects.toThrow(/does not return to the slot/);
    const missing = createGitOps({
      git: fakeRunner(), userGit: identityRunner(), fs: memoryFs({ [slot]: "dir" }), planId: PLAN, toplevel: top, executorHome: HOME,
    });
    await expect(missing.verifySlotPointers(slot)).rejects.toThrow(/back-pointer/);
    await expect(slotOps(() => undefined, { [join(gitdir, "gitdir")]: "\n" }).ops.verifySlotPointers(slot)).rejects.toThrow(/unusable/);
    await expect(slotOps(() => undefined, { [join(gitdir, "gitdir")]: "\\\\host\\share\\x\n" }).ops.verifySlotPointers(slot)).rejects.toThrow(/unusable/);
  });

  // QA-2.4-2
  it("verifySlotPointers refuses a slot that is missing, a link, or resolves through one, before reading any pointer", async () => {
    const gone = createGitOps({ git: fakeRunner(), userGit: identityRunner(), fs: memoryFs(), planId: PLAN, toplevel: top, executorHome: HOME });
    await expect(gone.verifySlotPointers(slot)).rejects.toThrow(/does not exist/);
    const junction = slotOps();
    junction.fs.entries.set(resolve(slot), "junction");
    await expect(junction.ops.verifySlotPointers(slot)).rejects.toThrow(/not a real directory \(junction\)/);
    const through = slotOps();
    through.fs.reals.set(resolve(slot), join(root, "elsewhere", "slot-1"));
    await expect(through.ops.verifySlotPointers(slot)).rejects.toThrow(/resolves through a link/);
    await expect(through.ops.addAll(slot)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(through.git.calls).toHaveLength(0);
  });

  // QA-2.4-2
  it("compares the back-pointer lexically (slashes and case) and never follows a link in it", async () => {
    const forward = join(slot, ".git").replace(/\\/g, "/");
    await expect(slotOps(() => undefined, { [join(gitdir, "gitdir")]: `${forward}\n` }).ops.verifySlotPointers(slot)).resolves.toEqual({ gitdir, common });
    if (process.platform === "win32") {
      await expect(slotOps(() => undefined, { [join(gitdir, "gitdir")]: `${forward.toUpperCase()}\n` }).ops.verifySlotPointers(slot)).resolves.toEqual({ gitdir, common });
    }
    const decoy = join(root, "decoy", ".git");
    const trick = slotOps(() => undefined, { [join(gitdir, "gitdir")]: `${decoy}\n` });
    trick.fs.reals.set(resolve(decoy), resolve(join(slot, ".git")));
    await expect(trick.ops.verifySlotPointers(slot)).rejects.toThrow(/does not return to the slot/);
  });

  it("scopes every slot call with --git-dir and --work-tree, cwd = slot, after the pointer check", async () => {
    const { git, ops } = slotOps();
    await ops.addAll(slot);
    const call = git.calls[0];
    expect(call?.cwd).toBe(slot);
    expect(call?.args).toContain(`--git-dir=${gitdir}`);
    expect(call?.args).toContain(`--work-tree=${slot}`);
    const broken = slotOps();
    await expect(broken.ops.addAll(join(root, "nowhere"))).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(broken.git.calls).toHaveLength(0);
  });

  it("passes the identity with -c on the ref-writing ops only (commit, rebase, cherry-pick, revert, checkout, merge)", async () => {
    const { git, ops } = slotOps(args => (sub(args)[0] === "rev-parse" ? { stdout: `${OID_A}\n` } : undefined));
    const msg = formatCommitMessage({ type: "feat", scope: "x", title: "t", planId: PLAN, taskId: "1" });
    await ops.commit(slot, msg);
    await ops.rebaseOnto(slot, OID_A, OID_B);
    await ops.cherryPick(slot, [OID_A]);
    await ops.revert(slot, OID_A, msg);
    await ops.checkoutDetach(slot, OID_A);
    await ops.cleanTracked(slot, []);
    await ops.cleanForChecks(slot, ["node_modules"]);
    await ops.statusPorcelain(slot);
    await ops.addAll(slot);
    await ops.revParse(slot, "HEAD");
    await ops.diffNames(slot, OID_A, OID_B);
    await ops.mergeFfOnly(slot, OID_A);
    const withIdentity = new Set<string>();
    const without = new Set<string>();
    for (const c of git.calls) {
      if (!c.args.includes("user.useConfigOnly=true")) continue;
      const verb = sub(c.args)[0] ?? "";
      (c.args.includes("user.name=Ann Dev") && c.args.includes("user.email=ann@example.test") ? withIdentity : without).add(verb);
    }
    expect([...withIdentity].sort()).toEqual(["checkout", "cherry-pick", "commit", "merge", "rebase", "revert"]);
    for (const verb of ["clean", "status", "add", "rev-parse", "diff", "merge-base"]) expect(without.has(verb)).toBe(true);
    expect(git.calls.some(c => c.args.some(a => a.startsWith("user.") && a !== "user.useConfigOnly=true" && !a.startsWith("user.name=") && !a.startsWith("user.email=")))).toBe(false);
  });

  it("commits without hooks, signing or cleanup, and validates the message first", async () => {
    const { git, ops } = slotOps(args => (sub(args)[0] === "rev-parse" ? { stdout: `${OID_B}\n` } : undefined));
    const msg = formatCommitMessage({ type: "fix", scope: "x", title: "Fix #1", planId: PLAN, taskId: "1.2" });
    await expect(ops.commit(slot, msg)).resolves.toBe(OID_B);
    const commit = subs(git).find(s => s[0] === "commit");
    expect(commit).toEqual(["commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-m", msg]);
    const callArgs = git.calls.find(c => sub(c.args)[0] === "commit")?.args ?? [];
    expect(callArgs).toContain(`core.hooksPath=${join(HOME, "git", "no-hooks")}`);
    const before = git.calls.length;
    for (const bad of ["fix: nope", `${msg}\nSigned-off-by: x`, "", "feat(x): t [Plan:1]"]) {
      await expect(ops.commit(slot, bad)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    }
    expect(git.calls.length).toBe(before);
  });

  it("checkoutDetach quits an interrupted rebase, cherry-pick, revert and merge before the forced checkout", async () => {
    const seed = {
      [join(gitdir, "rebase-merge")]: "dir", [join(gitdir, "CHERRY_PICK_HEAD")]: "x", [join(gitdir, "REVERT_HEAD")]: "x",
      [join(gitdir, "MERGE_HEAD")]: "x",
    };
    const { git, ops } = slotOps(() => undefined, seed);
    await ops.checkoutDetach(slot, OID_A);
    expect(subs(git)).toEqual([
      ["rebase", "--quit"], ["cherry-pick", "--quit"], ["revert", "--quit"], ["merge", "--quit"],
      ["checkout", "--detach", "--force", OID_A, "--"],
    ]);
    const clean = slotOps();
    await clean.ops.checkoutDetach(slot, OID_A);
    expect(subs(clean.git)).toEqual([["checkout", "--detach", "--force", OID_A, "--"]]);
    await expect(clean.ops.checkoutDetach(slot, "HEAD")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  // QA-2.4-14
  it("cleanTracked is -x with only the kept paths surviving, cleanForChecks restores tracked files first and verifies after", async () => {
    const { git, ops } = slotOps();
    await ops.cleanTracked(slot, ["node_modules", "/foo.egg-info"]);
    await ops.cleanForChecks(slot, ["node_modules", "/.venv"]);
    expect(subs(git)).toEqual([
      ["clean", "-q", "-ffdx", "-e", "node_modules", "-e", "/foo.egg-info"],
      ["checkout", "--force", "HEAD", "--", "."],
      ["clean", "-q", "-ffdx", "-e", "node_modules", "-e", "/.venv"],
      ["clean", "-ffndx", "-e", "node_modules", "-e", "/.venv"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
    ]);
  });

  it("cleanForChecks fails when files remain and refuses a malformed exclusion", async () => {
    const left = slotOps(args => (sub(args)[1] === "-ffndx" ? { stdout: "Would remove dist/\n" } : undefined));
    await expect(left.ops.cleanForChecks(slot, [])).rejects.toThrow(/files remain/);
    const { git, ops } = slotOps();
    for (const bad of ["", "a\nb", "x".repeat(401)]) {
      await expect(ops.cleanForChecks(slot, [bad])).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
      await expect(ops.cleanTracked(slot, [bad])).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
      await expect(ops.cleanPreview(slot, [bad])).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    }
    expect(git.calls).toHaveLength(0);
  });

  // QA-2.4-8
  it("cleanForChecks fails listing the paths that still differ from HEAD", async () => {
    const dirty = slotOps(args => (sub(args)[0] === "status" ? { stdout: " M src/a.ts\0?? stray.txt\0" } : undefined));
    const error: unknown = await dirty.ops.cleanForChecks(slot, []).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: "E_GIT" });
    expect(JSON.stringify(error)).toContain("src/a.ts");
    expect(JSON.stringify(error)).toContain("stray.txt");
    expect(subs(dirty.git)[0]).toEqual(["checkout", "--force", "HEAD", "--", "."]);
  });

  // QA-2.4-1
  it("cleanPreview runs the same clean -ndx vector and parses plain and C-quoted paths", async () => {
    const out = "Would remove tools/node_modules/\nWould remove a.txt\nWould remove \"we\\\"ird\\tname\"\nWould remove \"caf\\303\\251/\"\nWould skip repository sub/\n";
    const { git, ops } = slotOps(args => (sub(args)[0] === "clean" ? { stdout: out } : undefined));
    await expect(ops.cleanPreview(slot, ["/.venv"])).resolves.toEqual(["tools/node_modules/", "a.txt", "we\"ird\tname", "café/", "sub/"]);
    expect(subs(git)[0]).toEqual(["clean", "-ffndx", "-e", "/.venv"]);
    await expect(slotOps(() => ({ stdout: "surprise\n" })).ops.cleanPreview(slot, [])).rejects.toMatchObject({ code: "E_GIT" });
  });

  // QA-2.4-22
  it("the hardened git environment forces the C locale and cleanPreview rejects a translated line", async () => {
    const saved = { ...process.env };
    process.env.LANG = "de_DE.UTF-8";
    process.env.LC_ALL = "de_DE.UTF-8";
    process.env.LANGUAGE = "de";
    try {
      const env = hardenedEnvironment({ LC_MESSAGES: "de_DE.UTF-8" });
      expect(env.LC_ALL).toBe("C");
      expect(env.LANGUAGE).toBe("");
    } finally {
      for (const key of ["LANG", "LC_ALL", "LANGUAGE"]) {
        const old = saved[key];
        if (old === undefined) delete process.env[key]; else process.env[key] = old;
      }
    }
    const german = slotOps(args => (sub(args)[0] === "clean" ? { stdout: "Würde a.txt entfernen\n" } : undefined));
    await expect(german.ops.cleanPreview(slot, [])).rejects.toMatchObject({ code: "E_GIT" });
  });

  // QA-2.4-17
  it("lsFiles reads the index with -z and literal pathspecs, trackedLinks keeps only mode 120000", async () => {
    const { git, ops } = slotOps(args => {
      const s = sub(args);
      if (s[0] === "ls-files" && s.includes("-s")) return { stdout: ["100644", "120000", "100755"].map((mode, n) => `${mode} ${OID_A} 0\t${["a.txt", "link dir/l", "run.sh"][n] ?? ""}\0`).join("") };
      if (s[0] === "ls-files") return { stdout: "a.txt\0d/b.txt\0" };
      return undefined;
    });
    await expect(ops.lsFiles(slot)).resolves.toEqual(["a.txt", "d/b.txt"]);
    await expect(ops.lsFiles(slot, ["d"])).resolves.toEqual(["a.txt", "d/b.txt"]);
    await expect(ops.trackedLinks(slot)).resolves.toEqual(["link dir/l"]);
    expect(subs(git)).toEqual([
      ["ls-files", "-z", "--cached", "--full-name"],
      ["ls-files", "-z", "--cached", "--full-name", "--", ":(literal)d"],
      ["ls-files", "-s", "-z", "--full-name"],
    ]);
    await expect(ops.lsFiles(slot, [""])).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  // QA-2.4-20
  it("re-checks the hooks directory before every git call, not only when the context is built", async () => {
    const { git, fs, ops } = slotOps();
    await ops.addAll(slot);
    const hook = join(HOME, "git", "no-hooks", "pre-commit");
    fs.entries.set(resolve(hook), "#!/bin/sh");
    const before = git.calls.length;
    await expect(ops.addAll(slot)).rejects.toThrow(/hooks directory is not empty/);
    await expect(ops.checkoutDetach(slot, OID_A)).rejects.toThrow(/hooks directory is not empty/);
    await expect(ops.revParse(top, "HEAD")).rejects.toThrow(/hooks directory is not empty/);
    expect(git.calls.length).toBe(before);
    fs.entries.delete(resolve(hook));
    await ops.addAll(slot);
    expect(git.calls.length).toBe(before + 1);
  });

  it("statusPorcelain parses -z entries, renames and rejects garbage", async () => {
    const out = ` M a.txt\0?? b c.txt\0R  new.txt\0old.txt\0`;
    const { ops } = slotOps(() => ({ stdout: out }));
    await expect(ops.statusPorcelain(slot)).resolves.toEqual([
      { xy: " M", path: "a.txt", orig: null }, { xy: "??", path: "b c.txt", orig: null }, { xy: "R ", path: "new.txt", orig: "old.txt" },
    ]);
    await expect(slotOps(() => ({ stdout: "xx\0" })).ops.statusPorcelain(slot)).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("rebaseOnto returns the new head", async () => {
    const ok = slotOps(args => (sub(args)[0] === "rev-parse" ? { stdout: `${OID_B}\n` } : undefined));
    await expect(ok.ops.rebaseOnto(slot, OID_A, OID_B)).resolves.toEqual({ ok: true, head: OID_B });
    expect(subs(ok.git)[0]).toEqual(["rebase", "--onto", OID_A, OID_B]);
  });

  it.each(["rebase-merge", "rebase-apply"])("rebaseOnto reports conflicts after aborting an active %s", async state => {
    const conflict = slotOps(args => {
      const s = sub(args);
      if (s[0] === "rebase" && s[1] === "--onto") return { code: 1 };
      if (s[0] === "diff") return { stdout: "a.txt\0b.txt\0a.txt\0" };
      return undefined;
    }, { [join(gitdir, state)]: "dir" });
    await expect(conflict.ops.rebaseOnto(slot, OID_A, OID_B)).resolves.toEqual({ ok: false, conflicts: ["a.txt", "b.txt"] });
    expect(subs(conflict.git).map(s => s.slice(0, 2).join(" "))).toEqual(["rebase --onto", "diff --name-only", "rebase --abort"]);
  });

  it.each([1, 128])("a rebase refused before starting (exit %s) keeps its bounded sanitized error and never aborts", async code => {
    const none = slotOps(args => {
      const s = sub(args);
      if (s[0] === "rebase" && s[1] === "--onto") return { code, stderr: `${"é".repeat(3000)}\nfatal: https://alice:secret@example.test/repo?token=private` };
      if (s[0] === "diff") return { stdout: "pre-existing-conflict.txt\0" };
      if (s[0] === "rebase" && s[1] === "--abort") return { code: 128, stderr: "fatal: no rebase in progress" };
      return undefined;
    });
    const error: unknown = await none.ops.rebaseOnto(slot, OID_A, OID_B).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "E_GIT", message: `git rebase failed (exit ${code})`, detail: {
      op: "rebase", code, stderr: expect.stringContaining("fatal: https://example.test/repo?token=***"),
    } });
    const text = JSON.stringify(error);
    expect(text).not.toMatch(/alice|secret|private|\uFFFD/);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(2200);
    expect(subs(none.git)).toEqual([["rebase", "--onto", OID_A, OID_B]]);
  });

  it("an active failed rebase with no conflicted path is aborted and retains the initiating failure", async () => {
    const none = slotOps(args => (sub(args)[0] === "rebase" && sub(args)[1] === "--onto" ? { code: 128, stderr: "boom" } : undefined),
      { [join(gitdir, "rebase-merge")]: "dir" });
    await expect(none.ops.rebaseOnto(slot, OID_A, OID_B)).rejects.toMatchObject({
      code: "E_GIT", message: "git rebase failed (exit 128)", detail: { op: "rebase", code: 128, stderr: "boom" },
    });
    expect(subs(none.git).map(s => s.slice(0, 2).join(" "))).toEqual(["rebase --onto", "diff --name-only", "rebase --abort"]);
  });

  it("a real abort failure retains both bounded sanitized errors and never falls back to reset", async () => {
    const abortFails = slotOps(args => {
      const s = sub(args);
      if (s[0] === "rebase" && s[1] === "--onto") return { code: 1, stderr: `${"é".repeat(3000)}\nconflict https://alice:secret@example.test/repo?token=private` };
      if (s[0] === "diff") return { stdout: "a.txt\0" };
      if (s[0] === "rebase" && s[1] === "--abort") return { code: 128, stderr: `${"é".repeat(3000)}\nlocked https://bob:hidden@example.test/repo?password=private` };
      return undefined;
    }, { [join(gitdir, "rebase-merge")]: "dir" });
    const error: unknown = await abortFails.ops.rebaseOnto(slot, OID_A, OID_B).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "E_GIT", message: "git rebase failed (exit 1); rebase cleanup failed: git rebase --abort failed (exit 128)", detail: {
      original: { op: "rebase", code: 1, stderr: expect.stringContaining("conflict https://example.test/repo?token=***") },
      cleanup: { op: "rebase --abort", code: 128, stderr: expect.stringContaining("locked https://example.test/repo?password=***") },
    } });
    const text = JSON.stringify(error);
    expect(text).not.toMatch(/alice|secret|bob|hidden|private|\uFFFD/);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(4400);
    expect(subs(abortFails.git).map(s => s.slice(0, 2).join(" "))).toEqual(["rebase --onto", "diff --name-only", "rebase --abort"]);
  });

  it("an abort runner exception also retains the initiating rebase context", async () => {
    const abortThrows = slotOps(args => {
      const s = sub(args);
      if (s[0] === "rebase" && s[1] === "--onto") return { code: 1, stderr: "initiating failure" };
      if (s[0] === "diff") return { stdout: "a.txt\0" };
      if (s[0] === "rebase" && s[1] === "--abort") throw Object.assign(new Error("timed out https://alice:secret@example.test/repo"), { code: "ETIMEDOUT" });
      return undefined;
    }, { [join(gitdir, "rebase-apply")]: "dir" });
    await expect(abortThrows.ops.rebaseOnto(slot, OID_A, OID_B)).rejects.toMatchObject({ code: "E_GIT",
      message: "git rebase failed (exit 1); rebase cleanup failed: git rebase --abort could not run: timed out https://example.test/repo",
      detail: { original: { op: "rebase", code: 1, stderr: "initiating failure" }, cleanup: { op: "rebase --abort", code: "ETIMEDOUT", stderr: "" } },
    });
  });

  it("rebaseAbort is a no-op unless a rebase is in progress", async () => {
    const idle = slotOps();
    await idle.ops.rebaseAbort(slot);
    expect(idle.git.calls).toHaveLength(0);
    const running = slotOps(() => undefined, { [join(gitdir, "rebase-apply")]: "dir" });
    await running.ops.rebaseAbort(slot);
    expect(subs(running.git)).toEqual([["rebase", "--abort"]]);
  });

  it("cherryPick refuses an empty list and bad ids, and reports conflicts", async () => {
    const { ops } = slotOps();
    await expect(ops.cherryPick(slot, [])).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(ops.cherryPick(slot, ["HEAD"])).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    const conflict = slotOps(args => {
      const s = sub(args);
      if (s[0] === "cherry-pick" && s[1] === "--no-edit") return { code: 1 };
      if (s[0] === "diff") return { stdout: "x.txt\0" };
      return undefined;
    });
    await expect(conflict.ops.cherryPick(slot, [OID_A, OID_B])).resolves.toEqual({ ok: false, conflicts: ["x.txt"] });
    expect(subs(conflict.git)[0]).toEqual(["cherry-pick", "--no-edit", OID_A, OID_B]);
  });

  it("revert stages with --no-commit then commits the given message; a conflict falls back to a hard reset", async () => {
    const msg = formatCommitMessage({ type: "revert", scope: "x", title: "Revert t", planId: PLAN, taskId: "1" });
    const ok = slotOps(args => (sub(args)[0] === "rev-parse" ? { stdout: `${OID_B}\n` } : undefined));
    await expect(ok.ops.revert(slot, OID_A, msg)).resolves.toEqual({ ok: true, head: OID_B });
    expect(subs(ok.git).slice(0, 2)).toEqual([["revert", "--no-commit", OID_A], ["commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-m", msg]]);
    const conflict = slotOps(args => {
      const s = sub(args);
      if (s[0] === "revert" && s[1] === "--no-commit") return { code: 1 };
      if (s[0] === "diff") return { stdout: "x.txt\0" };
      if (s[0] === "revert" && s[1] === "--abort") return { code: 128 };
      return undefined;
    });
    await expect(conflict.ops.revert(slot, OID_A, msg)).resolves.toEqual({ ok: false, conflicts: ["x.txt"] });
    expect(subs(conflict.git).some(s => s[0] === "reset" && s.includes("--hard"))).toBe(true);
    await expect(ok.ops.revert(slot, OID_A, "bad message")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });
});
