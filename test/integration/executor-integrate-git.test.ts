/**
 * Phase 3.2 integration (G): the integrate modules on real git in temporary repositories (offline).
 *
 * Real `GitOps`, real `SlotPool`, real `createIntegrateGit`; the check commands are tiny node scripts in the temp
 * repositories, run through the checks' `CommandRunner` seam (the project's own test suite is never spawned).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync, writeSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  COMMIT_SUBJECT_PATTERN, createGitOps, createGitRunner, formatCommitMessage, integrationBranchName, taskBranchName, type GitOps,
} from "../../src/executor/git";
import {
  createIntegrateGit, createIntegrationChecks, createWriteGuard, BackgroundRuns,
  type CommandRunner, type IntegrateGit, type IntegrationChecks, type ResolvedCommand, type RunResolver, type WriteGuard,
} from "../../src/executor/integrate/checks";
import { maxRangeProbes } from "../../src/executor/integrate/bisect";
import { createLander } from "../../src/executor/integrate/land";
import { createPhaseSuiteRunner, revertMessage } from "../../src/executor/integrate/phase-suite";
import {
  createIntegrationQueue, createRepoLockFactory,
  type IntegrationStepEvent, type LandRequest, type StepJournal, type TaskRange,
} from "../../src/executor/integrate/queue";
import { createLedgerStore } from "../../src/executor/ledger";
import { createSlotPool } from "../../src/executor/slots/pool";
import { detectManagers, type Provisioner } from "../../src/executor/slots/provision";
import type {
  Clock, ExecutorEventInput, FileSystem, FsStat, GitRunner, IntegrationEntry, IntegrationListener, IntegrationStep, LeaseService,
  LedgerV1, LedgerWriter, ProcessResult, Spawner,
} from "../../src/executor/types";
import { buildDraft, holderOf, openAttempt, T0, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const WIN = process.platform === "win32";
const PLAN = "p-20261010-abc123";
/** Real git on Windows is slow: every block of this file gets a generous per-test timeout (the slots test uses 300 s for its longest case). */
const SLOW = { timeout: 180_000 } as const;
const FIXTURES = fileURLToPath(new URL("../fixtures/cpx/integrate/", import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// Seams backed by the real machine
// ---------------------------------------------------------------------------------------------------------------

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(Reflect.get(error, "code")) : undefined;
}

/** The executor FileSystem over node:fs. */
function nodeFs(): FileSystem {
  return {
    readText: (p) => fsp.readFile(p, "utf8"),
    async writeText(p, data, o) {
      const fd = openSync(p, o?.exclusive === true ? "wx" : "w");
      try {
        writeSync(fd, data);
        if (o?.fsync === true) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    appendText: (p, data) => fsp.appendFile(p, data, "utf8"),
    rename: (a, b) => fsp.rename(a, b),
    async rm(p, o) {
      if (o.recursive) {
        await fsp.rm(p, { recursive: true });
        return;
      }
      const st = await fsp.lstat(p);
      if (st.isDirectory()) {
        await fsp.rmdir(p);
        return;
      }
      try {
        await fsp.unlink(p);
      } catch (error) {
        if (st.isSymbolicLink() && (code(error) === "EPERM" || code(error) === "EISDIR")) await fsp.rmdir(p);
        else throw error;
      }
    },
    mkdir: async (p) => { await fsp.mkdir(p); },
    readdir: (p) => fsp.readdir(p),
    async lstat(p): Promise<FsStat | null> {
      try {
        const st = await fsp.lstat(p);
        const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
        return { kind, size: st.size, mtimeMs: st.mtimeMs };
      } catch (error) {
        if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return null;
        throw error;
      }
    },
    realpath: (p) => fsp.realpath(p),
    async fsyncDir(p) {
      if (WIN) return;
      const fd = openSync(p, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}

/** Real time, but every timer fires on the next turn: the pool's retries never wait. */
function instantClock(): Clock {
  let id = 0;
  let skew = 0;
  const cancelled = new Set<number>();
  return {
    now: () => Date.now() + skew,
    iso: (ms) => new Date(ms ?? Date.now() + skew).toISOString(),
    setTimer(ms, fn) {
      const n = ++id;
      skew += ms;
      setImmediate(() => { if (!cancelled.delete(n)) fn(); });
      return { id: n };
    },
    clearTimer(h) { cancelled.add(h.id); },
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  };
}

/** Real timers (the repo lock's heartbeat and the queue's stalled poll must not spin as they would on the instant clock). */
function realClock(): Clock {
  let id = 0;
  const timers = new Map<number, NodeJS.Timeout>();
  return {
    now: () => Date.now(),
    iso: (ms) => new Date(ms ?? Date.now()).toISOString(),
    setTimer(ms, fn) {
      const n = ++id;
      const t = setTimeout(() => { timers.delete(n); fn(); }, ms);
      t.unref();
      timers.set(n, t);
      return { id: n };
    },
    clearTimer(h) {
      const t = timers.get(h.id);
      if (t !== undefined) clearTimeout(t);
      timers.delete(h.id);
    },
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  };
}

/** No shell; bounded output; the timeout kills the child. */
function nodeSpawner(): Spawner {
  return {
    pid: process.pid,
    hostname: hostname(),
    isAlive(pid) {
      try { process.kill(pid, 0); return true; } catch (error) { return code(error) === "EPERM"; }
    },
    run(command, args, o) {
      return new Promise<ProcessResult>((resolve, reject) => {
        const started = Date.now();
        const child = spawn(command, [...args], {
          cwd: o.cwd, env: o.env === undefined ? process.env : { ...o.env }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          ...(o.signal === undefined ? {} : { signal: o.signal }),
        });
        const max = o.maxOutputBytes ?? 1024 * 1024;
        let stdout = "";
        let stderr = "";
        let truncated = false;
        const take = (current: string, chunk: Buffer): string => {
          if (current.length >= max) { truncated = true; return current; }
          return current + chunk.toString("utf8");
        };
        child.stdout.on("data", (chunk: Buffer) => { stdout = take(stdout, chunk); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = take(stderr, chunk); });
        const timer = setTimeout(() => { child.kill(); }, o.timeoutMs);
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (exit, signal) => {
          clearTimeout(timer);
          resolve({ code: exit, signal, stdout, stderr, truncated, durationMs: Date.now() - started });
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Repository setup (plain git, global and system config ignored)
// ---------------------------------------------------------------------------------------------------------------

let base = "";
let emptyHome = "";
let emptyGlobal = "";

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGlobal, HOME: emptyHome, USERPROFILE: emptyHome, XDG_CONFIG_HOME: emptyHome };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv(), windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "--all");
  git(repo, "-c", "user.name=Setup", "-c", "user.email=setup@example.test", "-c", "commit.gpgSign=false", "commit", "-q", "--no-verify", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const read = (p: string): string => readFileSync(p, "utf8");

/** Copies a fixture directory (`.gitignore` is stored as `gitignore.txt`, so the outer repository never sees it). */
function copyFixture(name: string, repo: string): void {
  cpSync(join(FIXTURES, name), repo, { recursive: true });
  const stored = join(repo, "gitignore.txt");
  if (existsSync(stored)) {
    writeFileSync(join(repo, ".gitignore"), read(stored));
    rmSync(stored);
  }
}

/** A repository with LF endings pinned, a fixture's files and one file per `files` entry; returns the repo and its first commit. */
function newRepo(name: string, fixture: string, files: Readonly<Record<string, string>> = {}): { repo: string; c0: string } {
  const repo = join(base, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Integrate Tester");
  git(repo, "config", "user.email", "integrate.tester@example.test");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  copyFixture(fixture, repo);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  return { repo, c0: commitAll(repo, "c0") };
}

/** Commits `files` on top of the current HEAD of `cwd`. */
function commitFiles(cwd: string, message: string, files: Readonly<Record<string, string>>): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  }
  return commitAll(cwd, message);
}

/** Provisioning is not the subject here: a slot is just a reset worktree. */
function noProvisioner(): Provisioner {
  return {
    detect: (slot, tracked) => detectManagers(slot, tracked, nodeFs(), { provision: "auto", python: "auto" }),
    provision: async () => undefined,
  };
}

/** The check commands of the fixtures: `typecheck` is `node check.js` (a small node script in the temp repository). */
function nodeResolver(extra: Readonly<Record<string, string>> = {}): RunResolver {
  return {
    async resolve(ref, cwd) {
      const script = ref.script === "typecheck" ? "check.js" : extra[ref.script];
      if (script === undefined) return { ok: false, reason: `no script ${ref.script} in ${cwd}` };
      const command: ResolvedCommand = { label: `node ${script}`, file: process.execPath, args: [script], source: "package-script", ref };
      return { ok: true, command };
    },
  };
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** The CommandRunner seam over real child processes; every invocation is recorded (argv and cwd). */
function realRunner(calls: Array<{ file: string; args: readonly string[]; cwd: string }>, extraEnv: Readonly<Record<string, string>> = {}): CommandRunner {
  const spawner = nodeSpawner();
  return async (c, o) => {
    calls.push({ file: c.file, args: [...c.args], cwd: o.cwd });
    const r = await spawner.run(c.file, c.args, {
      cwd: o.cwd, env: definedEnv({ ...process.env, ...extraEnv, ...(c.env ?? {}) }), timeoutMs: 60_000, signal: o.signal,
    });
    return { exitCode: r.code, timedOut: false, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs };
  };
}

interface Env {
  repo: string; ledger: LedgerV1; home: string; slotsDir: string; ops: GitOps; run: GitRunner; igit: IntegrateGit;
  guard: WriteGuard; pool: ReturnType<typeof createSlotPool>;
  /** Every git invocation of the hardened runner: [cwd, args]. */
  gitCalls: Array<{ cwd: string; args: readonly string[] }>;
}

/**
 * The real stack for one temporary repository: GitOps and the slot pool over the repository at `toplevel` (the
 * owner checkout, which may be a linked worktree), a ledger shaped by `buildDraft`, the write guard of 3.2.2.
 */
function makeEnv(tag: string, toplevel: string, baseBranch: string, c0: string, tasks = 1, maxParallel = 2): Env {
  const home = join(base, `home-${tag}`);
  const slotsDir = join(base, `slots-${tag}`, PLAN);
  const fs = nodeFs();
  const gitCalls: Env["gitCalls"] = [];
  const hardened = createGitRunner({ mode: "hardened", toplevel });
  const run: GitRunner = {
    run(args, o) {
      gitCalls.push({ cwd: o.cwd, args: [...args] });
      return hardened.run(args, o);
    },
  };
  const ops = createGitOps({ git: run, userGit: createGitRunner({ mode: "user", toplevel }), fs, planId: PLAN, toplevel, executorHome: home });
  const ledger = buildDraft(tasks, PLAN);
  ledger.repo = { key: `key-${tag}`, toplevel, baseBranch, baseCommit: c0 };
  ledger.integration = { branch: integrationBranchName(PLAN), worktree: join(slotsDir, "integration"), head: c0 };
  ledger.config.slotsDir = slotsDir;
  const pool = createSlotPool({
    planId: PLAN, repoKey: `key-${tag}`, toplevel, slotsDir, markersDir: join(home, "markers"), executorHome: home,
    maxParallel, git: ops, fs, clock: instantClock(), provisioner: noProvisioner(),
  });
  const guard = createWriteGuard({ ledger: () => ledger, pool, realpath: (p) => fsp.realpath(p), platform: process.platform });
  const igit = createIntegrateGit(run, guard);
  return { repo: toplevel, ledger, home, slotsDir, ops, run, igit, guard, pool, gitCalls };
}

/*@@HARNESS@@*/

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-integrate-git-")));
  emptyHome = join(base, "empty-home");
  mkdirSync(emptyHome);
  emptyGlobal = join(base, "empty.gitconfig");
  writeFileSync(emptyGlobal, "");
});

afterAll(async () => {
  await removeDirWhenReleased(base);
});

afterEach(() => {
  const registry: unknown = Reflect.get(globalThis, Symbol.for("omr.executor.slots"));
  if (registry instanceof Map) registry.clear();
});

interface Calls { commands: Array<{ file: string; args: readonly string[]; cwd: string }> }

/** The real checks of 3.2.2 over the env, running the fixtures' node scripts; the machine-wide verification slot is a stub. */
function makeChecks(env: Env, calls: Calls, extraEnv: Readonly<Record<string, string>> = {}): IntegrationChecks {
  return createIntegrationChecks({
    ledger: () => env.ledger, pool: env.pool, git: env.ops, igit: env.igit, resolver: nodeResolver(), spawn: realRunner(calls.commands, extraEnv),
    guard: env.guard, background: new BackgroundRuns(), clock: instantClock(), logger: { warn: () => undefined },
    preemptForeground: async () => undefined,
    acquire: async () => ({ release: async () => undefined, lost: false }),
  });
}

const runNode = (cwd: string, script: string): number | null =>
  spawnSync(process.execPath, [script], { cwd, encoding: "utf8", windowsHide: true }).status;

/** Owner-checkout state that landing must never change: HEAD, status, index bytes, a file's text. */
function ownerState(cwd: string, file: string): { head: string; ref: string; status: string; file: string } {
  return {
    head: git(cwd, "rev-parse", "HEAD"),
    ref: git(cwd, "symbolic-ref", "-q", "HEAD"),
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
    file: read(join(cwd, file)),
  };
}

describe("checks on real git (3.2.2)", SLOW, () => {
  it("a stale ignored dist/out.js that would make the check pass is cleaned first and the check fails as it should", async () => {
    const { repo, c0 } = newRepo("stale", "stale-dist", { "src/a.txt": "one\n" });
    const c1 = commitFiles(repo, "c1", { "src/a.txt": "two\n" });
    const env = makeEnv("stale", repo, "main", c0);
    await env.pool.open();
    const calls: Calls = { commands: [] };
    const checks = makeChecks(env, calls);
    const lease = await env.pool.acquire(PLAN, "T1", c0);
    mkdirSync(join(lease.path, "dist"), { recursive: true });
    writeFileSync(join(lease.path, "dist", "out.js"), "// stale build output\n");
    expect(git(lease.path, "status", "--porcelain")).toBe("");
    expect(runNode(lease.path, "check.js")).toBe(0);
    const result = await checks.run({ slot: lease, base: c0, candidate: c1, priority: "foreground", signal: new AbortController().signal });
    expect(result.verdict).toBe("fail");
    if (result.verdict === "fail") expect(result.output).toContain("missing build output dist/out.js");
    expect(existsSync(join(lease.path, "dist", "out.js"))).toBe(false);
    expect(calls.commands).toHaveLength(1);
    expect(calls.commands[0]?.cwd).toBe(lease.path);
    expect(await env.ops.revParse(lease.path, "HEAD")).toBe(c1);
  });

  it("a passing candidate passes and a failing one fails with the output tail; the slot ends at the candidate", async () => {
    const { repo, c0 } = newRepo("verdicts", "node-basic", { "src/value.txt": "fine\n" });
    const good = commitFiles(repo, "good", { "src/value.txt": "better\n" });
    const bad = commitFiles(repo, "bad", { "src/value.txt": "BAD\n" });
    const env = makeEnv("verdicts", repo, "main", c0);
    await env.pool.open();
    const checks = makeChecks(env, { commands: [] });
    const lease = await env.pool.acquire(PLAN, "T1", c0);
    const signal = new AbortController().signal;
    const pass = await checks.run({ slot: lease, base: c0, candidate: good, priority: "foreground", signal });
    expect(pass.verdict).toBe("pass");
    const fail = await checks.run({ slot: lease, base: good, candidate: bad, priority: "foreground", signal });
    expect(fail.verdict).toBe("fail");
    if (fail.verdict === "fail") expect(fail.output).toContain("check failed: BAD in value.txt");
    expect(await env.ops.revParse(lease.path, "HEAD")).toBe(bad);
    expect(git(repo, "rev-parse", "main")).toBe(bad);
  });
});

// (phase-suite helpers are added below the landing tests)
interface LandSetup { repo: string; c0: string; cand: string; env: Env; lander: ReturnType<typeof createLander>; req: LandRequest }

/** An owner checkout on `main` (c0) and an integration branch one commit ahead (cand) that changes src/value.txt. */
function landSetup(tag: string, candidateFiles: Readonly<Record<string, string>> = { "src/value.txt": "landed\n" }): LandSetup {
  const { repo, c0 } = newRepo(`land-${tag}`, "node-basic", { ".gitignore": "out/\n", "src/value.txt": "base\n" });
  const branch = integrationBranchName(PLAN);
  git(repo, "checkout", "-q", "-b", branch);
  const cand = commitFiles(repo, "candidate", candidateFiles);
  git(repo, "checkout", "-q", "main");
  const env = makeEnv(`land-${tag}`, repo, "main", c0);
  const lander = createLander({ git: env.ops, igit: env.igit, guard: env.guard, run: env.run, realpath: (p) => fsp.realpath(p), platform: process.platform });
  return { repo, c0, cand, env, lander, req: { toplevel: repo, baseBranch: "main", candidate: cand, integrationBranch: branch } };
}

describe("landing on real git (3.2.5)", SLOW, () => {
  it("clean owner checkout on the base branch with the base an ancestor: fast-forward, nothing forced", async () => {
    const s = landSetup("ff");
    const i = await s.lander.inspect(s.req);
    expect(i).toEqual({ ok: true, baseTip: s.c0, noop: false });
    const out = await s.lander.fastForward(s.req);
    expect(out).toEqual({ kind: "landed", from: s.c0, to: s.cand });
    expect(git(s.repo, "rev-parse", "main")).toBe(s.cand);
    expect(read(join(s.repo, "src", "value.txt"))).toBe("landed\n");
    expect(git(s.repo, "status", "--porcelain")).toBe("");
    // Idempotent: a second land is a no-op that reports the same landing.
    const again = await s.lander.fastForward(s.req);
    expect(again).toEqual({ kind: "landed", from: s.cand, to: s.cand });
    expect(git(s.repo, "rev-parse", "main")).toBe(s.cand);
    expect(git(s.repo, "reflog", "show", "--format=%H", "main").split("\n")[0]).toBe(s.cand);
  });

  it("a dirty owner checkout is refused with the inbox commands and nothing changes", async () => {
    const s = landSetup("dirty");
    writeFileSync(join(s.repo, "scratch.txt"), "mine\n");
    writeFileSync(join(s.repo, "src", "value.txt"), "edited by the owner\n");
    const before = ownerState(s.repo, "src/value.txt");
    const out = await s.lander.fastForward(s.req);
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.refusal.reason).toBe("dirty");
    if (out.refusal.reason === "dirty") expect([...out.refusal.paths].sort()).toEqual(["scratch.txt", "src/value.txt"]);
    const commands = s.lander.commands(s.req, out.refusal);
    expect(commands[0]).toContain("status --porcelain=v1 --untracked-files=all");
    expect(commands.at(-1)).toBe(`git -C "${s.repo}" merge --ff-only ${s.cand}`);
    expect(ownerState(s.repo, "src/value.txt")).toEqual(before);
    expect(git(s.repo, "rev-parse", "main")).toBe(s.c0);
  });

  it("a diverged base branch is refused with the log and merge commands, never merged or forced", async () => {
    const s = landSetup("diverged");
    const moved = commitFiles(s.repo, "owner moved on", { "owner.txt": "owner work\n" });
    const before = ownerState(s.repo, "owner.txt");
    const out = await s.lander.fastForward(s.req);
    expect(out).toEqual({ kind: "refused", refusal: { reason: "diverged", baseTip: moved } });
    if (out.kind !== "refused") return;
    const commands = s.lander.commands(s.req, out.refusal);
    expect(commands[0]).toBe(`git -C "${s.repo}" log --oneline ${s.cand}..main`);
    expect(commands.join("\n")).toContain(`merge refs/heads/${s.req.integrationBranch}`);
    expect(ownerState(s.repo, "owner.txt")).toEqual(before);
    expect(git(s.repo, "rev-parse", "main")).toBe(moved);
    expect(git(s.repo, "rev-parse", s.req.integrationBranch)).toBe(s.cand);
  });

  it("a base branch that is not checked out is refused with a switch command and nothing changes", async () => {
    const s = landSetup("not-checked-out");
    git(s.repo, "checkout", "-q", "-b", "side");
    const before = ownerState(s.repo, "src/value.txt");
    const out = await s.lander.fastForward(s.req);
    expect(out).toEqual({ kind: "refused", refusal: { reason: "not-checked-out", head: "refs/heads/side" } });
    if (out.kind !== "refused") return;
    expect(s.lander.commands(s.req, out.refusal)).toEqual([`git -C "${s.repo}" switch main`, `git -C "${s.repo}" merge --ff-only ${s.cand}`]);
    expect(ownerState(s.repo, "src/value.txt")).toEqual(before);
    expect(git(s.repo, "rev-parse", "main")).toBe(s.c0);
    // Detached HEAD is also "not checked out".
    git(s.repo, "checkout", "-q", "--detach");
    const detached = await s.lander.inspect(s.req);
    expect(detached).toEqual({ ok: false, refusal: { reason: "not-checked-out", head: null }, baseTip: s.c0 });
  });

  it("an ignored file where the fast-forward adds a path is refused (git would overwrite it silently)", async () => {
    const s = landSetup("ignored", { "src/value.txt": "landed\n" });
    // Rebuild the candidate so that it force-adds out/gen.txt, a path the base ignores.
    git(s.repo, "checkout", "-q", s.req.integrationBranch);
    mkdirSync(join(s.repo, "out"), { recursive: true });
    writeFileSync(join(s.repo, "out", "gen.txt"), "from candidate\n");
    git(s.repo, "add", "-f", "out/gen.txt");
    git(s.repo, "-c", "user.name=Setup", "-c", "user.email=setup@example.test", "-c", "commit.gpgSign=false", "commit", "-q", "--no-verify", "-m", "adds out/gen.txt");
    const cand = git(s.repo, "rev-parse", "HEAD");
    git(s.repo, "checkout", "-q", "main");
    mkdirSync(join(s.repo, "out"), { recursive: true });
    writeFileSync(join(s.repo, "out", "gen.txt"), "owner's ignored file\n");
    const req: LandRequest = { ...s.req, candidate: cand };
    const before = ownerState(s.repo, "src/value.txt");
    const out = await s.lander.fastForward(req);
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.refusal.reason).toBe("ignored-overwrite");
    expect(s.lander.commands(req, out.refusal).join("\n")).toContain("ignored file would be overwritten");
    expect(ownerState(s.repo, "src/value.txt")).toEqual(before);
    expect(read(join(s.repo, "out", "gen.txt"))).toBe("owner's ignored file\n");
    expect(git(s.repo, "rev-parse", "main")).toBe(s.c0);
  });

  it("the phase tag omr/<planId>/phase-<id> is created once; a second create is exists-same, a different commit exists-other", async () => {
    const s = landSetup("tag");
    await s.env.pool.open();
    const integration = await s.env.pool.acquireSpecial(PLAN, "integration");
    const name = s.lander.tagName(PLAN, "p1");
    expect(name).toBe(`omr/${PLAN}/phase-p1`);
    expect(await s.lander.tag({ cwd: integration.path, name, commit: s.c0 })).toBe("created");
    expect(git(s.repo, "rev-parse", `refs/tags/${name}`)).toBe(s.c0);
    expect(await s.lander.tag({ cwd: integration.path, name, commit: s.c0 })).toBe("exists-same");
    expect(await s.lander.tag({ cwd: integration.path, name, commit: s.cand })).toEqual({ kind: "exists-other", at: s.c0 });
    expect(git(s.repo, "rev-parse", `refs/tags/${name}`)).toBe(s.c0);
  });

  // QA-3.2 linked worktree: the owner checkout is a linked worktree, the main worktree holds another branch and a dirty tree.
  // Every git call of the stack runs in the owner checkout (or a slot); the main worktree is never read or written.
  describe("the owner checkout is a linked worktree while the main worktree is dirty on another branch", SLOW, () => {
    const mainSnapshot = (main: string) => ({
      head: git(main, "rev-parse", "HEAD"),
      ref: git(main, "symbolic-ref", "HEAD"),
      status: git(main, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"),
      indexMtime: statSync(join(main, ".git", "index")).mtimeMs,
      tracked: read(join(main, "src", "value.txt")),
      untracked: read(join(main, "main-scratch.txt")),
    });

    async function linkedSetup(tag: string) {
      const { repo: main, c0 } = newRepo(`linked-main-${tag}`, "node-basic", { "src/value.txt": "base\n" });
      const owner = join(base, `linked-owner-${tag}`);
      git(main, "worktree", "add", "-q", "-b", "work", owner, "main");
      const branch = integrationBranchName(PLAN);
      git(owner, "checkout", "-q", "-b", branch);
      const cand = commitFiles(owner, "candidate", { "src/value.txt": "landed\n" });
      git(owner, "checkout", "-q", "work");
      // The main worktree: another branch (main), a modified tracked file and an untracked file.
      writeFileSync(join(main, "src", "value.txt"), "dirty in the main worktree\n");
      writeFileSync(join(main, "main-scratch.txt"), "untracked in the main worktree\n");
      const env = makeEnv(`linked-${tag}`, owner, "work", c0);
      const lander = createLander({ git: env.ops, igit: env.igit, guard: env.guard, run: env.run, realpath: (p) => fsp.realpath(p), platform: process.platform });
      const req: LandRequest = { toplevel: owner, baseBranch: "work", candidate: cand, integrationBranch: branch };
      mainSnapshot(main);
      return { main, owner, c0, cand, env, lander, req, branch };
    }

    it("checks in a slot, the landing and the phase tag never read or write the main worktree", async () => {
      const s = await linkedSetup("land");
      const before = mainSnapshot(s.main);
      await s.env.pool.open();
      const calls: Calls = { commands: [] };
      const checks = makeChecks(s.env, calls);
      const lease = await s.env.pool.acquire(PLAN, "T1", s.c0);
      const verdict = await checks.run({ slot: lease, base: s.c0, candidate: s.cand, priority: "foreground", signal: new AbortController().signal });
      expect(verdict.verdict).toBe("pass");
      const special = await s.env.pool.acquireSpecial(PLAN, "integration");
      expect(await s.lander.tag({ cwd: special.path, name: s.lander.tagName(PLAN, "p1"), commit: s.cand })).toBe("created");
      const out = await s.lander.fastForward(s.req);
      expect(out).toEqual({ kind: "landed", from: s.c0, to: s.cand });
      expect(git(s.owner, "rev-parse", "work")).toBe(s.cand);
      expect(read(join(s.owner, "src", "value.txt"))).toBe("landed\n");
      expect(git(s.main, "rev-parse", "main")).toBe(s.c0);
      expect(mainSnapshot(s.main)).toEqual(before);
      // Every git call of the hardened runner ran in the owner checkout or a slot, none in the main worktree.
      const mainFold = s.main.toLowerCase();
      for (const call of s.env.gitCalls) {
        expect(call.cwd.toLowerCase()).not.toBe(mainFold);
        expect(call.args.some((a) => a.toLowerCase() === mainFold || a.toLowerCase() === `--work-tree=${mainFold}`)).toBe(false);
      }
      expect(s.env.gitCalls.some((c) => c.cwd === s.owner)).toBe(true);
    });

    it("a base branch checked out only in the main worktree is not checked out in the owner checkout: refused", async () => {
      const s = await linkedSetup("refused");
      const before = mainSnapshot(s.main);
      const req: LandRequest = { ...s.req, baseBranch: "main" };
      const out = await s.lander.fastForward(req);
      expect(out).toEqual({ kind: "refused", refusal: { reason: "not-checked-out", head: "refs/heads/work" } });
      expect(mainSnapshot(s.main)).toEqual(before);
      expect(git(s.main, "rev-parse", "main")).toBe(s.c0);
      expect(git(s.owner, "rev-parse", "work")).toBe(s.c0);
    });
  });

  it("a landing write outside the repository toplevel is refused by the write guard", async () => {
    const s = landSetup("guard");
    const outcome = await s.lander.fastForward({ ...s.req, toplevel: s.env.slotsDir });
    expect(outcome.kind).toBe("error");
    expect(git(s.repo, "rev-parse", "main")).toBe(s.c0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The task lane (3.2.3 git steps): rebase in the integration slot, checks, compare-and-swap fast-forward
// ---------------------------------------------------------------------------------------------------------------

/** I2: every reflog step of `branch` is ancestor -> descendant (no rewind, no sideways move). */
function expectLinearReflog(repo: string, branch: string): void {
  const shas = git(repo, "reflog", "show", "--format=%H", `refs/heads/${branch}`).split("\n").filter((l) => l !== "").reverse();
  for (let n = 1; n < shas.length; n++) {
    const older = shas[n - 1] as string;
    const newer = shas[n] as string;
    if (older !== newer) expect(spawnSync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: repo, env: isolatedEnv() }).status).toBe(0);
  }
}

async function laneSetup(tag: string, o: { integrationEdit: Readonly<Record<string, string>>; taskEdit: Readonly<Record<string, string>> }) {
  const { repo, c0 } = newRepo(`lane-${tag}`, "node-basic", { "src/value.txt": "base\n", ".gitignore": "dist/\n" });
  const branch = integrationBranchName(PLAN);
  git(repo, "checkout", "-q", "-b", branch);
  const tip = commitFiles(repo, "integration moved", o.integrationEdit);
  git(repo, "checkout", "-q", "main");
  const env = makeEnv(`lane-${tag}`, repo, "main", c0);
  await env.pool.open();
  const calls: Calls = { commands: [] };
  const checks = makeChecks(env, calls);
  const task = await env.pool.acquire(PLAN, "T1", c0);
  for (const [rel, text] of Object.entries(o.taskEdit)) {
    mkdirSync(dirname(join(task.path, rel)), { recursive: true });
    writeFileSync(join(task.path, rel), text);
  }
  await env.ops.addAll(task.path);
  const taskHead = await env.ops.commit(task.path, formatCommitMessage({ type: "feat", scope: "core", title: "task one", planId: PLAN, taskId: "T1" }));
  const integration = await env.pool.acquireSpecial(PLAN, "integration");
  await checks.prepare(integration, taskHead);
  // refs/heads/<branch> is already at `tip` (committed on it above). Never `update-ref <short name>`: that writes
  // .git/omr/.../integration, a pseudo-ref that shadows refs/heads/... in rev-parse (it made the CAS look like a no-op).
  expect(git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(tip);
  return { repo, c0, branch, tip, env, calls, checks, task, taskHead, integration };
}

describe("the task lane on real git", SLOW, () => {
  it("a clean rebase onto a moved integration branch, passing checks, then the compare-and-swap fast-forward", async () => {
    const s = await laneSetup("clean", { integrationEdit: { "src/other.txt": "theirs\n" }, taskEdit: { "src/mine.txt": "mine\n" } });
    const rebased = await s.env.ops.rebaseOnto(s.integration.path, s.tip, s.c0);
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    expect(rebased.head).not.toBe(s.taskHead);
    expect(await s.env.ops.isAncestor(s.tip, rebased.head)).toBe(true);
    const verdict = await s.checks.run({ slot: s.integration, base: s.tip, candidate: rebased.head, priority: "foreground", signal: new AbortController().signal });
    expect(verdict.verdict).toBe("pass");
    expect(s.calls.commands.every((c) => c.cwd === s.integration.path)).toBe(true);
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.tip);
    await s.env.ops.branchForce(s.branch, rebased.head, s.tip);
    expect(git(s.repo, "rev-parse", `refs/heads/${s.branch}`)).toBe(rebased.head);
    expect(git(s.repo, "diff", "--name-only", s.tip, rebased.head)).toBe("src/mine.txt");
    expectLinearReflog(s.repo, s.branch);
    // The owner checkout (main) was never touched.
    expect(git(s.repo, "rev-parse", "main")).toBe(s.c0);
    expect(git(s.repo, "status", "--porcelain")).toBe("");
  });

  it("a same-line edit conflicts: the paths are reported, the rebase is aborted, the branch is unchanged", async () => {
    const s = await laneSetup("conflict", { integrationEdit: { "src/value.txt": "theirs\n" }, taskEdit: { "src/value.txt": "mine\n" } });
    const rebased = await s.env.ops.rebaseOnto(s.integration.path, s.tip, s.c0);
    expect(rebased).toEqual({ ok: false, conflicts: ["src/value.txt"] });
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.tip);
    expect(await s.env.ops.revParse(s.integration.path, "HEAD")).toBe(s.taskHead);
    expect(git(s.integration.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(await s.env.ops.verifySlotPointers(s.integration.path).then((p) => p.gitdir), "rebase-merge"))).toBe(false);
    expectLinearReflog(s.repo, s.branch);
  });

  it("failing checks fail the candidate and the branch is never moved", async () => {
    const s = await laneSetup("failing", { integrationEdit: { "src/other.txt": "theirs\n" }, taskEdit: { "src/value.txt": "BAD\n" } });
    const rebased = await s.env.ops.rebaseOnto(s.integration.path, s.tip, s.c0);
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    const verdict = await s.checks.run({ slot: s.integration, base: s.tip, candidate: rebased.head, priority: "foreground", signal: new AbortController().signal });
    expect(verdict.verdict).toBe("fail");
    if (verdict.verdict === "fail") expect(verdict.output).toContain("check failed: BAD in value.txt");
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.tip);
    expectLinearReflog(s.repo, s.branch);
  });
});

/** A lease service double: the queue releases a task's leases when it releases its slot (A2); the test only records it. */
function recordingLeases(released: string[]): LeaseService {
  const target: Partial<LeaseService> = { releaseTask: (taskId: string) => { released.push(taskId); } };
  return new Proxy(target, {
    get(t, key) {
      const own: unknown = Reflect.get(t, key);
      if (own !== undefined || typeof key === "symbol") return own;
      return () => { throw new Error(`LeaseService.${key} is not expected in this test`); };
    },
  }) as LeaseService;
}

/** Waits (real time, bounded) until `done()` holds; the queue's lanes run in the background. `state()` explains a timeout. */
async function until(done: () => boolean, what: string, state: () => string = () => "", ms = 150_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${state()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Task states, status, gates, inbox texts and logger warnings: what a stuck queue test reports. */
function describeQueue(l: Readonly<LedgerV1>, warnings: readonly string[], listened: readonly string[]): string {
  return [
    `status=${l.status} head=${l.integration.head}`,
    `tasks: ${Object.values(l.tasks).map((t) => `${t.id}=${t.state}`).join(" ")}`,
    `gates: ${l.phases.map((p) => `${p.id}=${p.gate}`).join(" ")}`,
    ...l.inbox.map((i) => `inbox ${i.kind}/${i.severity}: ${i.text.slice(0, 400)}`),
    ...warnings.map((w) => `warn: ${w.slice(0, 400)}`),
    `listener: ${listened.join(", ")}`,
  ].join("\n");
}

/** The integration-step events of the plan's history (IntegrationHistory, wired from the 2.2 store's export). */
async function historySteps(store: ReturnType<typeof createLedgerStore>, planId: string): Promise<IntegrationStepEvent[]> {
  const { events } = await store.exportPlan(planId);
  return events.filter((e): e is IntegrationStepEvent => e.type === "integration-step");
}

// ---------------------------------------------------------------------------------------------------------------
// Shared invariant checker (memo section 7): I1, I2, I5 on real git
// ---------------------------------------------------------------------------------------------------------------

interface InvariantState {
  repo: string; branch: string; ownerFile: string;
  /** Commits whose integration checks passed (I1), filled by the checks spy. */
  passed: Set<string>;
  /** Every tip the branch has been seen at, oldest first (I2). */
  tips: string[];
  /** Tags seen so far and where they pointed (I2: tags never move). */
  tags: Map<string, string>;
  owner: ReturnType<typeof ownerState>;
}

function invariantsFor(repo: string, branch: string, ownerFile: string, initial: string): InvariantState {
  return { repo, branch, ownerFile, passed: new Set([initial]), tips: [initial], tags: new Map(), owner: ownerState(repo, ownerFile) };
}

/** I1: the branch tip is a commit whose checks passed; I2: ancestor -> descendant only, tags never move; I5: the owner checkout is unchanged. */
function checkInvariants(s: InvariantState): void {
  const tip = git(s.repo, "rev-parse", `refs/heads/${s.branch}`);
  expect(s.passed.has(tip), `I1: tip ${tip} was never checked`).toBe(true);
  const last = s.tips[s.tips.length - 1] as string;
  if (tip !== last) {
    expect(spawnSync("git", ["merge-base", "--is-ancestor", last, tip], { cwd: s.repo, env: isolatedEnv() }).status, `I2: ${last} -> ${tip}`).toBe(0);
    s.tips.push(tip);
  }
  expectLinearReflog(s.repo, s.branch);
  const tagList = git(s.repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags/").split("\n").filter((l) => l !== "");
  for (const line of tagList) {
    const [ref, sha] = line.split(" ") as [string, string];
    const seen = s.tags.get(ref);
    if (seen !== undefined) expect(sha, `I2: tag ${ref} moved`).toBe(seen);
    else s.tags.set(ref, sha);
  }
  expect(ownerState(s.repo, s.ownerFile), "I5: the owner checkout changed").toEqual(s.owner);
}

// ---------------------------------------------------------------------------------------------------------------
// The real queue (3.2.3) over the real 2.2 LedgerStore, real git, real slot pool
// ---------------------------------------------------------------------------------------------------------------

type Crash = (events: readonly ExecutorEventInput[]) => "before" | "after" | null;

/**
 * The store's writer with two test seams: after every durable batch the invariant checker runs (violations are collected,
 * never thrown into the queue), and an optional one-shot crash either refuses a batch before it is written or throws
 * after it is durable (a process that dies right after the fsync).
 */
function instrumentedWriter(inner: LedgerWriter, after: () => void, crash: Crash | null): LedgerWriter & { crashed: boolean } {
  const w = {
    crashed: false,
    get planId() { return inner.planId; },
    get ledger() { return inner.ledger; },
    async append(batch: Parameters<LedgerWriter["append"]>[0]): Promise<Readonly<LedgerV1>> {
      const preview: readonly ExecutorEventInput[] = typeof batch === "function" ? batch(inner.ledger) : batch;
      const when = w.crashed || crash === null ? null : crash(preview);
      if (when === "before") {
        w.crashed = true;
        throw new Error("crash injected before the batch was written");
      }
      const next = await inner.append(batch);
      after();
      if (when === "after") {
        w.crashed = true;
        throw new Error("crash injected after the batch was written");
      }
      return next;
    },
    openIntegration: () => inner.openIntegration(),
    wakeKeys: () => inner.wakeKeys(),
    snapshot: () => inner.snapshot(),
    close: () => inner.close(),
  };
  return w;
}

interface QueueSpec {
  tag: string;
  fixture: string;
  base: Readonly<Record<string, string>>;
  ownerFile: string;
  /** Per task id, the files its one commit (on top of c0) writes. */
  tasks: ReadonlyArray<{ id: string; files: Readonly<Record<string, string>> }>;
  batchMax: number;
  phaseSuite: LedgerV1["config"]["phaseSuite"];
  /** Extra resolvable scripts for the suite's RunResolver double (script name -> node script). */
  scripts?: Readonly<Record<string, string>>;
}

async function queueSetup(spec: QueueSpec) {
  const { repo, c0 } = newRepo(`queue-${spec.tag}`, spec.fixture, spec.base);
  const integrationBranch = integrationBranchName(PLAN);
  git(repo, "branch", integrationBranch, c0);
  const branches = new Map<string, string>();
  for (const t of spec.tasks) {
    const name = taskBranchName(PLAN, t.id);
    git(repo, "checkout", "-q", "-b", name, c0);
    commitFiles(repo, `task ${t.id}`, t.files);
    branches.set(t.id, name);
  }
  git(repo, "checkout", "-q", "main");
  const env = makeEnv(`queue-${spec.tag}`, repo, "main", c0, spec.tasks.length, Math.max(2, spec.tasks.length));
  await env.pool.open();
  const draft = buildDraft(spec.tasks.length, PLAN);
  draft.repo = env.ledger.repo;
  draft.integration = env.ledger.integration;
  draft.config.slotsDir = env.slotsDir;
  draft.config.batchMax = spec.batchMax;
  draft.config.phaseSuite = spec.phaseSuite;
  draft.edges = [];
  draft.tasks = {};
  for (const t of spec.tasks) {
    const lease = await env.pool.acquire(PLAN, t.id, c0);
    const attempt = { ...openAttempt(1), endedAt: T0, outcome: "succeeded" as const };
    draft.tasks[t.id] = taskNode(t.id, { state: "verified", slot: lease.slot, branch: branches.get(t.id) ?? null, attempts: [attempt] });
  }
  env.ledger = draft;
  // The integration worktree exists before the queue's first resume(): step 0 reads the branch tip in it, and "a failure to
  // resolve counts as moved" (phase-3.2.md:420), which halts the plan. The plan start creates it; the queue's own
  // acquireSpecial(integration) later returns this same lease (pool.ts claimSpecial, mode "same").
  const integrationLease = await env.pool.acquireSpecial(PLAN, "integration");
  expect(integrationLease.path.toLowerCase()).toBe(draft.integration.worktree.toLowerCase());
  expect(git(integrationLease.path, "rev-parse", `refs/heads/${integrationBranch}`)).toBe(c0);
  const home = join(base, `ledger-${spec.tag}`);
  mkdirSync(home, { recursive: true });
  const store = createLedgerStore({ home });
  const holder = holderOf("ses-integrate", process.pid, hostname(), new Date().toISOString());
  const inv = invariantsFor(repo, integrationBranch, spec.ownerFile, c0);
  const violations: string[] = [];
  const afterBatch = (): void => {
    try {
      checkInvariants(inv);
    } catch (e) {
      violations.push(e instanceof Error ? e.message : String(e));
    }
  };
  const calls: Calls = { commands: [] };
  const inner = makeChecks(env, calls);
  const checkRuns: string[] = [];
  const checks: IntegrationChecks = {
    ...inner,
    async run(req) {
      const r = await inner.run(req);
      checkRuns.push(`${req.candidate}:${r.verdict}`);
      if (r.verdict === "pass") inv.passed.add(req.candidate);
      return r;
    },
  };
  const suite = createPhaseSuiteRunner({
    checks, igit: env.igit, git: env.ops, pool: env.pool, resolver: nodeResolver(spec.scripts ?? {}), background: new BackgroundRuns(),
    clock: realClock(), logger: { warn: () => undefined },
  });
  const lander = createLander({ git: env.ops, igit: env.igit, guard: env.guard, run: env.run, realpath: (p) => fsp.realpath(p), platform: process.platform });
  const listened: string[] = [];
  const listener: IntegrationListener = {
    onIntegrated: (id) => { listened.push(`integrated ${id}`); },
    onConflict: (id) => { listened.push(`conflict ${id}`); },
    onFailed: (id) => { listened.push(`failed ${id}`); },
    onReverted: (id) => { listened.push(`reverted ${id}`); },
    onGate: (p, g) => { listened.push(`gate ${p} ${g}`); },
    onInbox: (item) => { listened.push(`inbox ${item.kind}`); },
  };
  const released: string[] = [];
  const warnings: string[] = [];
  const lockRoot = join(base, `locks-${spec.tag}`);
  mkdirSync(lockRoot, { recursive: true });
  const newQueue = (writer: LedgerWriter) => createIntegrationQueue({
    planId: PLAN, writer, history: { steps: () => historySteps(store, PLAN) }, git: env.ops, igit: env.igit, pool: env.pool,
    leases: recordingLeases(released), checks, suite, lander, listener, settle: (_id, release) => { void release(); },
    locks: createRepoLockFactory({ stateRoot: lockRoot, clock: realClock(), pid: process.pid, hostname: hostname(), isPidAlive: (pid) => nodeSpawner().isAlive(pid) }),
    guard: env.guard, clock: realClock(), logger: { warn: (m) => { warnings.push(m); } },
  });
  return {
    repo, c0, env, store, holder, inv, violations, afterBatch, calls, checkRuns, listened, released, warnings, integrationBranch, newQueue,
    draft,
  };
}

/** A resume() that halted explains every later timeout: fail at once with the ledger's account instead. */
function expectNotHalted(report: { halted: boolean }, l: Readonly<LedgerV1>, warnings: readonly string[], listened: readonly string[]): void {
  expect(report.halted, describeQueue(l, warnings, listened)).toBe(false);
  expect(l.status, describeQueue(l, warnings, listened)).toBe("running");
}

const TERMINAL = new Set(["integrated", "conflict", "failed"]);
const settled = (l: Readonly<LedgerV1>): boolean => Object.values(l.tasks).every((t) => TERMINAL.has(t.state));

/** The `task-integrated` events of the whole plan history, per task. */
async function integratedCounts(store: ReturnType<typeof createLedgerStore>): Promise<Record<string, number>> {
  const { events } = await store.exportPlan(PLAN);
  const out: Record<string, number> = {};
  for (const e of events) if (e.type === "task-integrated") out[e.taskId] = (out[e.taskId] ?? 0) + 1;
  return out;
}

describe("the integration queue with the real LedgerStore on real git (3.2.3)", SLOW, () => {
  const ok = (id: string) => ({ id, files: { [`src/${id.toLowerCase()}.txt`]: `${id}\n` } });

  it("journals integrated, conflict and failed one task at a time; I1, I2 and I5 hold after every batch", async () => {
    const s = await queueSetup({
      tag: "states", fixture: "node-basic", base: { "src/value.txt": "base\n" }, ownerFile: "src/value.txt", batchMax: 1, phaseSuite: "off",
      tasks: [ok("T1"), { id: "T2", files: { "src/value.txt": "T2 edits the same line\n", "src/t1.txt": "T2 too\n" } }, { id: "T3", files: { "src/t3.txt": "BAD\n" } }],
    });
    // T2 adds src/t1.txt as T1 does, with other text: its rebase onto the head after T1 conflicts there.
    const inner = await s.store.create(s.draft, s.holder);
    const writer = instrumentedWriter(inner, s.afterBatch, null);
    const q = s.newQueue(writer);
    try {
      expectNotHalted(await q.resume(), writer.ledger, s.warnings, s.listened);
      q.enqueue(["T1", "T2", "T3"]);
      await until(() => settled(writer.ledger) && writer.openIntegration().length === 0, "T1..T3 settled",
        () => describeQueue(writer.ledger, s.warnings, s.listened));
      const l = writer.ledger;
      expect(l.tasks["T1"]?.state).toBe("integrated");
      expect(l.tasks["T2"]?.state).toBe("conflict");
      expect(l.tasks["T3"]?.state).toBe("failed");
      const tip = git(s.repo, "rev-parse", s.integrationBranch);
      expect(l.integration.head).toBe(tip);
      expect(l.tasks["T1"]?.integrated?.to).toBe(tip);
      expect(git(s.repo, "diff", "--name-only", s.c0, tip)).toBe("src/t1.txt");
      expect(await integratedCounts(s.store)).toEqual({ T1: 1 });
      expect(s.listened).toEqual(expect.arrayContaining(["integrated T1", "conflict T2", "failed T3"]));
      expect(s.released).toContain("T1");
      checkInvariants(s.inv);
      expect(s.violations).toEqual([]);
    } finally {
      await q.dispose();
      await writer.close();
    }
  });

  it("a batch of 4 with task 3 failing: the culprit is found, the three innocents integrate, checks <= 2n-1", async () => {
    const s = await queueSetup({
      tag: "batch", fixture: "node-basic", base: { "src/value.txt": "base\n" }, ownerFile: "src/value.txt", batchMax: 4, phaseSuite: "off",
      tasks: [ok("T1"), ok("T2"), { id: "T3", files: { "src/t3.txt": "BAD\n" } }, ok("T4")],
    });
    const inner = await s.store.create(s.draft, s.holder);
    const writer = instrumentedWriter(inner, s.afterBatch, null);
    const q = s.newQueue(writer);
    try {
      expectNotHalted(await q.resume(), writer.ledger, s.warnings, s.listened);
      q.enqueue(["T1", "T2", "T3", "T4"]);
      await until(() => settled(writer.ledger) && writer.openIntegration().length === 0, "the batch settled",
        () => describeQueue(writer.ledger, s.warnings, s.listened));
      const l = writer.ledger;
      expect(["T1", "T2", "T3", "T4"].map((id) => l.tasks[id]?.state)).toEqual(["integrated", "integrated", "failed", "integrated"]);
      const tip = git(s.repo, "rev-parse", s.integrationBranch);
      expect(l.integration.head).toBe(tip);
      expect(git(s.repo, "diff", "--name-only", s.c0, tip).split("\n").sort()).toEqual(["src/t1.txt", "src/t2.txt", "src/t4.txt"]);
      expect(git(s.repo, "show", `${tip}:src/t4.txt`)).toBe("T4");
      expect(spawnSync("git", ["cat-file", "-e", `${tip}:src/t3.txt`], { cwd: s.repo, env: isolatedEnv() }).status).not.toBe(0);
      expect(s.checkRuns.length).toBeLessThanOrEqual(2 * 4 - 1);
      expect(await integratedCounts(s.store)).toEqual({ T1: 1, T2: 1, T4: 1 });
      checkInvariants(s.inv);
      expect(s.violations).toEqual([]);
    } finally {
      await q.dispose();
      await writer.close();
    }
  });

  const crashCases: Array<{ name: string; crash: Crash }> = [
    {
      name: "after the fast-forward start is journaled (git has not moved yet)",
      crash: (events) => events.some((e) => e.type === "integration-step" && e.edge === "start" && e.step === "fast-forward") ? "after" : null,
    },
    {
      name: "between the branch compare-and-swap and the row-30 batch (git moved, the journal did not)",
      crash: (events) => events.some((e) => e.type === "integration-head") ? "before" : null,
    },
  ];
  for (const c of crashCases) {
    it(`a restart ${c.name}: resume() reaches the same final state with exactly one integration`, async () => {
      const s = await queueSetup({
        tag: `crash-${crashCases.indexOf(c)}`, fixture: "node-basic", base: { "src/value.txt": "base\n" }, ownerFile: "src/value.txt",
        batchMax: 1, phaseSuite: "off", tasks: [ok("T1")],
      });
      const inner1 = await s.store.create(s.draft, s.holder);
      const w1 = instrumentedWriter(inner1, s.afterBatch, c.crash);
      const q1 = s.newQueue(w1);
      expectNotHalted(await q1.resume(), w1.ledger, s.warnings, s.listened);
      q1.enqueue(["T1"]);
      await until(() => w1.crashed, "the injected crash", () => describeQueue(w1.ledger, s.warnings, s.listened));
      // dispose() waits for the stopped lanes to go idle and releases the repo lock (queue.ts dispose).
      await q1.dispose();
      await w1.close();
      expect(w1.ledger.tasks["T1"]?.state).toBe("integrating");
      // The next process: a new writer from the durable journal, a new queue, resume().
      const inner2 = await s.store.open(PLAN, s.holder);
      const w2 = instrumentedWriter(inner2, s.afterBatch, null);
      const q2 = s.newQueue(w2);
      try {
        const report = await q2.resume();
        expectNotHalted(report, w2.ledger, s.warnings, s.listened);
        // Step 0 completes a fast-forward that landed in git; otherwise step 1 rolls the entry back and requeues the task.
        if (crashCases.indexOf(c) === 1) expect(report.completed).toEqual(["T1"]);
        else expect(report.completed).toEqual([]);
        q2.enqueue(["T1"]);
        await until(() => settled(w2.ledger) && w2.openIntegration().length === 0, "T1 settled after the restart",
          () => describeQueue(w2.ledger, s.warnings, s.listened));
        const tip = git(s.repo, "rev-parse", s.integrationBranch);
        expect(w2.ledger.tasks["T1"]?.state).toBe("integrated");
        expect(w2.ledger.integration.head).toBe(tip);
        expect(git(s.repo, "diff", "--name-only", s.c0, tip)).toBe("src/t1.txt");
        expect(git(s.repo, "rev-list", "--count", `${s.c0}..${tip}`)).toBe("1");
        expect(await integratedCounts(s.store)).toEqual({ T1: 1 });
        checkInvariants(s.inv);
        expect(s.violations).toEqual([]);
      } finally {
        await q2.dispose();
        await w2.close();
      }
    });
  }

  it("a phaseSuite naming the routing.run.commands entry `test-files` is resolved by the RunResolver and runs in the ci slot", async () => {
    const s = await queueSetup({
      tag: "suite", fixture: "suite-6", base: { "lib.txt": "v1\n", "use.txt": "expects v1\n" }, ownerFile: "lib.txt", batchMax: 1,
      phaseSuite: [{ script: "test-files", args: [] }], scripts: { "test-files": "suite.js" }, tasks: [ok("T1")],
    });
    const inner = await s.store.create(s.draft, s.holder);
    const writer = instrumentedWriter(inner, s.afterBatch, null);
    const q = s.newQueue(writer);
    try {
      expectNotHalted(await q.resume(), writer.ledger, s.warnings, s.listened);
      q.enqueue(["T1"]);
      const gate = (): string | undefined => writer.ledger.phases.find((p) => p.id === "p1")?.gate;
      await until(() => settled(writer.ledger) && gate() !== "pending" && gate() !== "suite-running" && writer.openIntegration().length === 0,
        "the phase suite", () => describeQueue(writer.ledger, s.warnings, s.listened));
      expect(writer.ledger.tasks["T1"]?.state).toBe("integrated");
      expect(gate()).toBe("awaiting-qa");
      // The pool's layout: <slotsDir>\ci (slots/pool.ts:2).
      const ciPath = join(s.env.slotsDir, "ci");
      const suiteRuns = s.calls.commands.filter((c) => c.args.includes("suite.js"));
      expect(suiteRuns.length).toBeGreaterThanOrEqual(1);
      for (const r of suiteRuns) expect(r.cwd.toLowerCase()).toBe(ciPath.toLowerCase());
      expect(s.listened).toEqual(expect.arrayContaining(["integrated T1", "gate p1 suite-running", "gate p1 awaiting-qa"]));
      const steps = await historySteps(s.store, PLAN);
      const suiteStart = steps.find((e) => e.step === "phase-suite" && e.edge === "start");
      expect(suiteStart?.detail).toContain("test-files");
      checkInvariants(s.inv);
      expect(s.violations).toEqual([]);
    } finally {
      await q.dispose();
      await writer.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Phase suite (3.2.4): bisect, culprit revert, flaky rerun
// ---------------------------------------------------------------------------------------------------------------

/** A StepJournal double that records the steps and rejects a start while another step is open (the queue's rule). */
function fakeJournal(env: Env, open: IntegrationStep): { j: StepJournal; log: string[] } {
  let current: IntegrationStep | null = open;
  const log: string[] = [];
  const entry: IntegrationEntry = { id: "i-2", kind: "phase-suite", phaseId: "p1", taskIds: [], slot: null, baseHead: env.ledger.repo.baseCommit, candidate: null };
  const j: StepJournal = {
    entry,
    signal: new AbortController().signal,
    async start(step) {
      if (current !== null) throw new Error(`step ${current} is still open`);
      current = step;
      log.push(`start ${step}`);
    },
    async end(result) {
      if (current === null) throw new Error("no step is open");
      log.push(`end ${current} ${result}`);
      current = null;
    },
    assertWriteCwd: (cwd, purpose) => env.guard.assertWriteCwd(cwd, purpose),
    counter: () => undefined,
  };
  return { j, log };
}

const SUITE_COMMAND: ResolvedCommand = { label: "node suite.js", file: process.execPath, args: ["suite.js"], source: "run-command", ref: null };

/**
 * Six task commits on main after c0 (the phase base): task 3 edits only lib.txt, which use.txt expects, so the suite
 * breaks in a file the task does not touch (a transitive breakage). With `conflict`, task 5 edits the same line of lib.txt.
 */
function suiteSetup(tag: string, o: { conflict?: boolean } = {}, extraEnv: Readonly<Record<string, string>> = {}) {
  const { repo, c0 } = newRepo(`suite-${tag}`, "suite-6", { "lib.txt": "v1\n", "use.txt": "expects v1\n" });
  const ranges: TaskRange[] = [];
  let prev = c0;
  for (let n = 1; n <= 6; n++) {
    const files = n === 3 ? { "lib.txt": "v2\n" } : n === 5 && o.conflict === true ? { "lib.txt": "v3\n" } : { [`t${n}.txt`]: `task ${n}\n` };
    const sha = commitFiles(repo, `task ${n}`, files);
    ranges.push({ taskId: `T${n}`, from: prev, to: sha });
    prev = sha;
  }
  const head = prev;
  const branch = integrationBranchName(PLAN);
  git(repo, "branch", branch, head);
  const env = makeEnv(`suite-${tag}`, repo, "main", c0);
  const calls: Calls = { commands: [] };
  const checks = makeChecks(env, calls, extraEnv);
  const runner = createPhaseSuiteRunner({
    checks, igit: env.igit, git: env.ops, pool: env.pool, resolver: nodeResolver(), background: new BackgroundRuns(), clock: instantClock(),
    logger: { warn: () => undefined },
  });
  return { repo, c0, head, ranges, branch, env, calls, runner };
}

describe("phase suite on real git (3.2.4)", SLOW, () => {
  it("a transitive breakage in a file the culprit task does not touch is bisected to task 3 of 6", async () => {
    const s = suiteSetup("bisect");
    await s.env.pool.open();
    const ci = await s.env.pool.acquireSpecial(PLAN, "ci");
    const { j, log } = fakeJournal(s.env, "phase-suite");
    const verdict = await s.runner.run({ planId: PLAN, phaseId: "p1", commit: s.head, base: s.c0, ranges: s.ranges, commands: [SUITE_COMMAND], slot: ci }, j);
    expect(verdict.kind).toBe("culprit");
    if (verdict.kind === "culprit") expect(verdict.range.taskId).toBe("T3");
    // Two reruns at the suite commit, the run at the base, then the probes: log2(6) rounded up is at most 3.
    expect(log.filter((l) => l === "start suite-rerun")).toHaveLength(3);
    // The probes stay within the bound of bisect.ts; the final memo step is one more start.
    expect(log.filter((l) => l === "start bisect").length).toBeGreaterThanOrEqual(1);
    expect(log.filter((l) => l === "start bisect").length).toBeLessThanOrEqual(maxRangeProbes(6) + 1);
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.head);
    expect(git(s.repo, "rev-parse", "main")).toBe(s.head);
    expect(git(ci.path, "status", "--porcelain")).toBe("");
  });

  it("a suite that fails once and passes both reruns is flaky: no culprit, nothing reverted", async () => {
    const counter = join(base, "flaky-counter.txt");
    const s = suiteSetup("flaky", {}, { OMR_FIXTURE_FLAKY: counter });
    await s.env.pool.open();
    const ci = await s.env.pool.acquireSpecial(PLAN, "ci");
    // Task 3 breaks the suite for real; the flaky counter only fails the very first run, so a clean head is needed.
    git(s.repo, "branch", "clean-head", s.ranges[1]?.to ?? s.head);
    const clean = git(s.repo, "rev-parse", "clean-head");
    const { j } = fakeJournal(s.env, "phase-suite");
    const verdict = await s.runner.run({ planId: PLAN, phaseId: "p1", commit: clean, base: s.c0, ranges: s.ranges.slice(0, 2), commands: [SUITE_COMMAND], slot: ci }, j);
    expect(verdict).toEqual({ kind: "flaky", ids: [] });
    expect(read(counter)).toBe("3");
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.head);
  });

  // Regression: `revertMessage` used to build a multi-line `Revert "<subject>"` message that GitOps.revert (requireMessage,
  // COMMIT_SUBJECT_PATTERN) refused, so every runner revert ended in an "error" verdict after three tries.
  it("the culprit revert is built in the integration slot, checked with the regression command, and only then fast-forwarded", async () => {
    const s = suiteSetup("revert");
    await s.env.pool.open();
    const integration = await s.env.pool.acquireSpecial(PLAN, "integration");
    const culprit = s.ranges[2] as TaskRange;
    const { j, log } = fakeJournal(s.env, "revert-build");
    const verdict = await s.runner.revert({
      planId: PLAN, phaseId: "p1", culprit, suiteCommit: s.head, head: s.head,
      regression: { ids: [], files: [], commands: [SUITE_COMMAND] }, slot: integration,
    }, j);
    expect(verdict.kind).toBe("ok");
    if (verdict.kind !== "ok") return;
    expect(verdict.reverted).toEqual([culprit.to]);
    expect(log).toEqual(["end revert-build ok", "start revert-checks"]);
    // Built in the slot: the revert sits on the head, the regression command passes on it (lib.txt is v1 again).
    expect(await s.env.ops.revParse(integration.path, "HEAD")).toBe(verdict.revertHead);
    expect(read(join(integration.path, "lib.txt"))).toBe("v1\n");
    expect(git(integration.path, "log", "-1", "--format=%P")).toBe(s.head);
    const message = git(integration.path, "log", "-1", "--format=%B");
    expect(message).toMatch(COMMIT_SUBJECT_PATTERN);
    expect(message).toBe(revertMessage("task 3", "T3", culprit.from, culprit.to, "p1", PLAN));
    expect(message.startsWith("revert(p1): T3 ")).toBe(true);
    expect(message.endsWith(`[${PLAN}:T3]`)).toBe(true);
    expect(s.calls.commands.some((c) => c.args.includes("suite.js") && c.cwd === integration.path)).toBe(true);
    // The runner never moved the branch (I1/I2); the queue fast-forwards it after the checks.
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.head);
    expect((await s.env.ops.mergeFfOnly(integration.path, verdict.revertHead)).ok).toBe(true);
    await s.env.ops.branchForce(s.branch, verdict.revertHead, s.head);
    expect(git(s.repo, "rev-parse", s.branch)).toBe(verdict.revertHead);
    expect(await s.env.ops.isAncestor(s.head, verdict.revertHead)).toBe(true);
  });

  it("a revert that conflicts with a later task is reported with the paths and leaves the branch and the slot unchanged", async () => {
    const s = suiteSetup("conflict", { conflict: true });
    await s.env.pool.open();
    const integration = await s.env.pool.acquireSpecial(PLAN, "integration");
    const culprit = s.ranges[2] as TaskRange;
    const { j } = fakeJournal(s.env, "revert-build");
    const verdict = await s.runner.revert({
      planId: PLAN, phaseId: "p1", culprit, suiteCommit: s.head, head: s.head,
      regression: { ids: [], files: [], commands: [SUITE_COMMAND] }, slot: integration,
    }, j);
    expect(verdict).toEqual({ kind: "conflict", at: culprit.to, paths: ["lib.txt"] });
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.head);
    expect(await s.env.ops.revParse(integration.path, "HEAD")).toBe(s.head);
    expect(git(integration.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(integration.path, ".git"))).toBe(true);
    expect(git(s.repo, "rev-parse", "main")).toBe(s.head);
  });

  // The same git behavior with a message the executor pattern accepts: what the runner needs once the defect is fixed.
  const revertSubject = (taskId: string): string => formatCommitMessage({ type: "revert", scope: "p1", title: `revert ${taskId}`, planId: PLAN, taskId });

  it("a revert built in the integration slot passes the checks with the regression command and only then fast-forwards the branch", async () => {
    const s = suiteSetup("revert-direct");
    await s.env.pool.open();
    const integration = await s.env.pool.acquireSpecial(PLAN, "integration");
    const culprit = s.ranges[2] as TaskRange;
    const checks = makeChecks(s.env, s.calls);
    await checks.prepare(integration, s.head);
    const built = await s.env.ops.revert(integration.path, culprit.to, revertSubject("T3"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.head);
    // The suite command fails at the head and passes on the revert (extra regression command).
    expect(runNode(s.repo, "suite.js")).not.toBe(0);
    const verdict = await checks.run({
      slot: integration, base: s.head, candidate: built.head, priority: "foreground", signal: new AbortController().signal,
      extra: { ids: [], files: [], commands: [SUITE_COMMAND] },
    });
    expect(verdict.verdict).toBe("pass");
    expect(s.calls.commands.some((c) => c.args.includes("suite.js") && c.cwd === integration.path)).toBe(true);
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.head);
    expect((await s.env.ops.mergeFfOnly(integration.path, built.head)).ok).toBe(true);
    await s.env.ops.branchForce(s.branch, built.head, s.head);
    expect(git(s.repo, "rev-parse", s.branch)).toBe(built.head);
    expect(read(join(integration.path, "lib.txt"))).toBe("v1\n");
    expect(git(integration.path, "log", "-1", "--format=%P")).toBe(s.head);
    // A compare-and-swap with a stale expectation is refused and moves nothing.
    await expect(s.env.ops.branchForce(s.branch, s.head, s.head)).rejects.toThrow();
    expect(git(s.repo, "rev-parse", s.branch)).toBe(built.head);
  });

  it("a revert that conflicts with a later task reports the paths, aborts, and leaves the branch and the slot unchanged", async () => {
    const s = suiteSetup("conflict-direct", { conflict: true });
    await s.env.pool.open();
    const integration = await s.env.pool.acquireSpecial(PLAN, "integration");
    const culprit = s.ranges[2] as TaskRange;
    await makeChecks(s.env, s.calls).prepare(integration, s.head);
    const built = await s.env.ops.revert(integration.path, culprit.to, revertSubject("T3"));
    expect(built).toEqual({ ok: false, conflicts: ["lib.txt"] });
    expect(await s.env.ops.revParse(integration.path, "HEAD")).toBe(s.head);
    expect(git(integration.path, "status", "--porcelain")).toBe("");
    expect(git(s.repo, "rev-parse", s.branch)).toBe(s.head);
    expect(git(s.repo, "rev-parse", "main")).toBe(s.head);
  });
});
