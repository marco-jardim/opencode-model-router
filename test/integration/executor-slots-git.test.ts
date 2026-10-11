/**
 * Phase 2.4 integration: the slot pool on real git in temporary repositories (offline).
 *
 * - A slot goes through create, lease, reset (tracked edits gone; node_modules and .venv kept), drift and re-provision,
 *   commit, cleanForChecks (dist\ removed, dependency directories kept), then retire through GC.
 * - GC with a marked slot, an unmarked directory (it survives) and a junction pointing out (its target survives).
 * - Hooks: the repository's pre-commit (failing) and post-checkout hooks write a sentinel; it stays absent.
 * - Identity: the repository config is used; with an isolated HOME and no repository identity, E_IDENTITY.
 * - uv: skipped with a recorded reason when uv (with a local Python) is absent.
 *
 * Time never waits: the pool's clock fires every timer at once.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, symlinkSync,
  writeFileSync, writeSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createGitOps, createGitRunner, formatCommitMessage, type GitOps } from "../../src/executor/git";
import { createSlotPool, markerPath, slotLockReason } from "../../src/executor/slots/pool";
import { slotEnvFor } from "../../src/executor/slots/env";
import { createProvisioner, detectManagers, type Detection, type Provisioner } from "../../src/executor/slots/provision";
import type { Clock, FileSystem, FsStat, GitRunner, ProcessResult, Spawner } from "../../src/executor/types";
import { runArgv } from "../../src/verify/exec";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const WIN = process.platform === "win32";
const PLAN = "p-20261010-abc123";
const FIXTURES = fileURLToPath(new URL("../fixtures/cpx/repos/", import.meta.url));
/** Filled by pythonAvailable(), which test collection calls before the function's own position in the file. */
let pythonProbe: { ok: boolean; reason: string; command: string; prefix: string[] } | undefined;

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
        // A directory junction on Windows: rmdir drops the link itself, never its target.
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
      if (WIN) return; // Windows cannot open a directory for fsync.
      const fd = openSync(p, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}

/** Real time, but every timer fires on the next turn: the pool's retries never wait. */
function instantClock(): Clock & { delays: number[] } {
  let id = 0;
  let skew = 0;
  const delays: number[] = [];
  const cancelled = new Set<number>();
  return {
    delays,
    now: () => Date.now() + skew,
    iso: (ms) => new Date(ms ?? Date.now() + skew).toISOString(),
    setTimer(ms, fn) {
      const n = ++id;
      delays.push(ms);
      skew += ms;
      setImmediate(() => { if (!cancelled.delete(n)) fn(); });
      return { id: n };
    },
    clearTimer(h) { cancelled.add(h.id); },
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  };
}

/**
 * The provisioner's clock: real timers (its heartbeat is 10 s and its lock polling only runs under contention, so a
 * fast step never waits on one). The instant clock would spin the heartbeat for the whole step.
 */
function realClock(): Clock {
  let id = 0;
  const timers = new Map<number, NodeJS.Timeout>();
  return {
    now: () => Date.now(),
    iso: (ms) => new Date(ms ?? Date.now()).toISOString(),
    setTimer(ms, fn) {
      const n = ++id;
      timers.set(n, setTimeout(() => { timers.delete(n); fn(); }, ms));
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

function newRepo(name: string, fixtures: readonly string[]): string {
  const repo = join(base, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  for (const f of fixtures) cpSync(join(FIXTURES, f), repo, { recursive: true, filter: (src) => !src.includes("fixpkg") });
  return repo;
}

interface PoolSetup {
  repo: string; slotsDir: string; home: string; ops: GitOps;
  pool: ReturnType<typeof createSlotPool>;
  provisions: Array<{ slot: string; managers: string[]; fresh: boolean }>;
  onProvision: string[];
  clock: ReturnType<typeof instantClock>;
}

/** Writes the dependency directories the way an installer would (offline). */
function recordingProvisioner(calls: PoolSetup["provisions"]): Provisioner {
  return {
    detect: (slot, tracked) => detectManagers(slot, tracked, nodeFs(), { provision: "auto", python: "auto" }),
    async provision(slot: string, d: Detection, o: { fresh: boolean }) {
      calls.push({ slot, managers: [...d.managers], fresh: o.fresh });
      if (d.managers.some((m) => m === "npm" || m === "pnpm" || m === "yarn")) {
        mkdirSync(join(slot, "node_modules", "dep"), { recursive: true });
        writeFileSync(join(slot, "node_modules", "dep", "index.js"), `// installed ${calls.length}\n`);
      }
      if (d.managers.some((m) => m === "pip" || m === "uv" || m === "poetry")) {
        mkdirSync(join(slot, ".venv"), { recursive: true });
        writeFileSync(join(slot, ".venv", "pyvenv.cfg"), `home = fake\n# install ${calls.length}\n`);
      }
    },
  };
}

function makePool(repo: string, tag: string, provisioner?: Provisioner, userGit?: GitRunner): PoolSetup {
  const home = join(base, `home-${tag}`);
  const slotsDir = join(base, `slots-${tag}`, PLAN);
  const fs = nodeFs();
  const ops = createGitOps({
    git: createGitRunner({ mode: "hardened", toplevel: repo }), userGit: userGit ?? createGitRunner({ mode: "user", toplevel: repo }),
    fs, planId: PLAN, toplevel: repo, executorHome: home,
  });
  const provisions: PoolSetup["provisions"] = [];
  const onProvision: string[] = [];
  const clock = instantClock();
  const pool = createSlotPool({
    planId: PLAN, repoKey: `key-${tag}`, toplevel: repo, slotsDir, markersDir: join(home, "markers"), executorHome: home,
    maxParallel: 2, git: ops, fs, clock, provisioner: provisioner ?? recordingProvisioner(provisions),
    onProvision: (slot, managers) => { onProvision.push(`${slot}:${managers.join(",")}`); },
  });
  return { repo, slotsDir, home, ops, pool, provisions, onProvision, clock };
}

const read = (p: string): string => readFileSync(p, "utf8");

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-slots-git-")));
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

// ---------------------------------------------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------------------------------------------

// QA-2.4-1 (critical). M4 (does git follow junctions?) measured here on the real git of this machine: the first test runs a
// plain `git clean -ffdx` over a junction and records whether the target survived; the pool tests do not depend on the answer,
// they require the target to survive whatever git does.
describe("QA-2.4-1: the clean never reaches through a junction, at any depth or name", () => {
  const outsideWith = (name: string): string => {
    const outside = join(base, name);
    mkdirSync(join(outside, "sub"), { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    writeFileSync(join(outside, "sub", "deep.txt"), "deep\n");
    return outside;
  };
  const survives = (outside: string): boolean => existsSync(join(outside, "keep.txt")) && existsSync(join(outside, "sub", "deep.txt"));
  const pythonRepo = (name: string): { repo: string; c1: string } => {
    const repo = newRepo(name, ["py-pip"]);
    git(repo, "config", "user.name", "Slot Tester");
    git(repo, "config", "user.email", "slot.tester@example.test");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "core.eol", "lf");
    return { repo, c1: commitAll(repo, "c1") };
  };

  it("M4 measurement: plain `git clean -ffdx` over an untracked tools/node_modules/x junction (recorded result: target survives)", () => {
    const { repo } = pythonRepo("repo-m4-raw");
    const outside = outsideWith("outside-m4-raw");
    mkdirSync(join(repo, "tools", "node_modules"), { recursive: true });
    symlinkSync(outside, join(repo, "tools", "node_modules", "x"), "junction");
    git(repo, "clean", "-q", "-ffdx");
    const followed = !survives(outside);
    expect(followed).toBe(false);
  });

  it("cleanForChecks and reset keep the target of a node_modules junction below the root of a Python-only slot", async () => {
    const { repo, c1 } = pythonRepo("repo-m4");
    const s = makePool(repo, "m4");
    await s.pool.open();
    const lease = await s.pool.acquire(PLAN, "task-1", c1);
    expect(s.provisions[0]?.managers).toEqual(["pip"]);
    const outside = outsideWith("outside-m4");
    const plant = (): void => {
      mkdirSync(join(lease.path, "tools", "node_modules"), { recursive: true });
      symlinkSync(outside, join(lease.path, "tools", "node_modules", "x"), "junction");
      mkdirSync(join(lease.path, "pkg"), { recursive: true });
      symlinkSync(outside, join(lease.path, "pkg", "node_modules"), "junction");
    };
    plant();
    await s.pool.cleanForChecks(lease.slot);
    expect(survives(outside)).toBe(true);
    expect(existsSync(join(lease.path, "tools", "node_modules"))).toBe(false);
    expect(existsSync(join(lease.path, "pkg", "node_modules"))).toBe(false);
    expect(existsSync(join(lease.path, ".venv", "pyvenv.cfg"))).toBe(true);
    plant();
    await s.pool.release(lease.slot);
    const again = await s.pool.acquire(PLAN, "task-2", c1);
    expect(again.slot).toBe(lease.slot);
    expect(survives(outside)).toBe(true);
    expect(existsSync(join(lease.path, "tools", "node_modules"))).toBe(false);
    expect(existsSync(join(lease.path, ".venv", "pyvenv.cfg"))).toBe(true);
  });

  // QA-2.4-8 on real git
  it("cleanForChecks restores tracked files the agent changed or deleted and leaves a clean status", async () => {
    const { repo, c1 } = pythonRepo("repo-qa8");
    const s = makePool(repo, "qa8");
    await s.pool.open();
    const lease = await s.pool.acquire(PLAN, "task-1", c1);
    const original = read(join(lease.path, "requirements.txt"));
    writeFileSync(join(lease.path, "requirements.txt"), "tampered\n");
    writeFileSync(join(lease.path, "stray.txt"), "x\n");
    await s.pool.cleanForChecks(lease.slot);
    expect(read(join(lease.path, "requirements.txt"))).toBe(original);
    expect(existsSync(join(lease.path, "stray.txt"))).toBe(false);
    expect(await s.ops.statusPorcelain(lease.path)).toEqual([]);
  });
});

describe("slot pool on real git", () => {
  let s: PoolSetup;
  let c1 = "";
  let c2 = "";
  let c3 = "";
  let slot = "";
  let sentinel = "";

  beforeAll(() => {
    const repo = newRepo("repo", ["py-pip", "node-npm"]);
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "app.txt"), "one\n");
    git(repo, "config", "user.name", "Slot Tester");
    git(repo, "config", "user.email", "slot.tester@example.test");
    // The executor snapshots the user's line-ending settings (Git for Windows' system config sets autocrlf=true);
    // the repository pins LF so file contents compare byte for byte.
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "core.eol", "lf");
    c1 = commitAll(repo, "c1");
    writeFileSync(join(repo, "src", "app.txt"), "two\n");
    c2 = commitAll(repo, "c2");
    writeFileSync(join(repo, "requirements.txt"), `${read(join(repo, "requirements.txt"))}# drift\n`);
    c3 = commitAll(repo, "c3");
    sentinel = join(base, "hook-ran.txt");
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const script = (exit: number) => `#!/bin/sh\necho ran >> "${sentinel.replace(/\\/g, "/")}"\nexit ${exit}\n`;
    writeFileSync(join(hooks, "pre-commit"), script(1));
    writeFileSync(join(hooks, "post-checkout"), script(0));
    if (!WIN) {
      chmodSync(join(hooks, "pre-commit"), 0o755);
      chmodSync(join(hooks, "post-checkout"), 0o755);
    }
    s = makePool(repo, "main");
  });

  it("creates and leases a locked, detached worktree at the base commit and provisions it", async () => {
    await s.pool.open();
    const lease = await s.pool.acquire(PLAN, "task-1", c1);
    slot = lease.path;
    expect(lease).toMatchObject({ slot: "slot-1", commit: c1, owner: "task-1" });
    expect(slot).toBe(join(s.slotsDir, "slot-1"));
    expect(read(join(slot, ".git"))).toMatch(/^gitdir: /);
    expect(await s.ops.revParse(slot, "HEAD")).toBe(c1);
    const entry = (await s.ops.worktreeList()).find((w) => w.path.toLowerCase() === slot.toLowerCase());
    expect(entry).toMatchObject({ head: c1, branch: null, locked: slotLockReason(PLAN, "slot-1") });
    expect(s.provisions).toEqual([{ slot, managers: ["npm", "pip"], fresh: false }]);
    expect(s.onProvision).toEqual(["slot-1:npm,pip"]);
    const marker = JSON.parse(read(markerPath(join(s.home, "markers"), PLAN, "slot-1"))) as { state: string; manifests: Record<string, string> };
    expect(marker.state).toBe("leased");
    expect(Object.keys(marker.manifests).sort()).toEqual(["package-lock.json", "package.json", "requirements.txt"]);
    expect(slotEnvFor(slot)?.set["VIRTUAL_ENV"]).toBe(join(slot, ".venv"));
    expect(existsSync(sentinel)).toBe(false);
  });

  it("reset: tracked edits and untracked files are gone, node_modules and .venv are kept, no reinstall", async () => {
    writeFileSync(join(slot, "src", "app.txt"), "edited\n");
    writeFileSync(join(slot, "requirements.txt"), "edited\n");
    writeFileSync(join(slot, "untracked.txt"), "x\n");
    mkdirSync(join(slot, "scratch", "deep"), { recursive: true });
    writeFileSync(join(slot, "scratch", "deep", "f.txt"), "x\n");
    await s.pool.reset("slot-1", c2);
    expect(await s.ops.revParse(slot, "HEAD")).toBe(c2);
    expect(read(join(slot, "src", "app.txt"))).toBe("two\n");
    expect(read(join(slot, "requirements.txt"))).toBe(read(join(FIXTURES, "py-pip", "requirements.txt")));
    expect(existsSync(join(slot, "untracked.txt"))).toBe(false);
    expect(existsSync(join(slot, "scratch"))).toBe(false);
    expect(read(join(slot, "node_modules", "dep", "index.js"))).toBe("// installed 1\n");
    expect(existsSync(join(slot, ".venv", "pyvenv.cfg"))).toBe(true);
    expect(await s.ops.statusPorcelain(slot)).toEqual([]);
    expect(s.provisions).toHaveLength(1);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("drift: a commit that changes requirements.txt re-provisions fresh", async () => {
    const before = JSON.parse(read(markerPath(join(s.home, "markers"), PLAN, "slot-1"))) as { manifests: Record<string, string> };
    await s.pool.reset("slot-1", c3);
    expect(s.provisions).toHaveLength(2);
    expect(s.provisions[1]).toEqual({ slot, managers: ["npm", "pip"], fresh: true });
    expect(s.onProvision).toHaveLength(2);
    const after = JSON.parse(read(markerPath(join(s.home, "markers"), PLAN, "slot-1"))) as { state: string; commit: string; manifests: Record<string, string> };
    expect(after).toMatchObject({ state: "leased", commit: c3 });
    expect(after.manifests["requirements.txt"]).not.toBe(before.manifests["requirements.txt"]);
    expect(after.manifests["package.json"]).toBe(before.manifests["package.json"]);
  });

  it("commits with the repository identity, the exact subject and no hooks (a failing pre-commit never runs)", async () => {
    writeFileSync(join(slot, "src", "feature.txt"), "feature\n");
    await s.ops.addAll(slot);
    const message = formatCommitMessage({ type: "feat", scope: "slots", title: "Add the feature", planId: PLAN, taskId: "2.4.6" });
    const head = await s.ops.commit(slot, message);
    expect(head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(s.repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>", head)).toBe("Slot Tester <slot.tester@example.test>|Slot Tester <slot.tester@example.test>");
    expect(git(s.repo, "log", "-1", "--format=%B", head)).toBe(message);
    expect(git(s.repo, "rev-parse", `${head}^`)).toBe(c3);
    expect(git(s.repo, "rev-parse", "HEAD")).toBe(c3);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("cleanForChecks removes dist\\ and other ignored outputs and keeps the dependency directories", async () => {
    mkdirSync(join(slot, "dist", "nested"), { recursive: true });
    writeFileSync(join(slot, "dist", "nested", "bundle.js"), "stale\n");
    writeFileSync(join(slot, "build.log"), "x\n");
    await s.pool.cleanForChecks("slot-1");
    expect(existsSync(join(slot, "dist"))).toBe(false);
    expect(existsSync(join(slot, "build.log"))).toBe(false);
    expect(read(join(slot, "node_modules", "dep", "index.js"))).toBe("// installed 2\n");
    expect(existsSync(join(slot, ".venv", "pyvenv.cfg"))).toBe(true);
    expect(read(join(slot, "src", "feature.txt"))).toBe("feature\n");
    expect(s.provisions).toHaveLength(2);
  });

  it("a second task reuses the released slot without reinstalling", async () => {
    await s.pool.release("slot-1");
    const lease = await s.pool.acquire(PLAN, "task-2", c3);
    expect(lease).toMatchObject({ slot: "slot-1", owner: "task-2", commit: c3 });
    expect(await s.ops.revParse(slot, "HEAD")).toBe(c3);
    expect(existsSync(join(slot, "src", "feature.txt"))).toBe(false);
    expect(s.provisions).toHaveLength(2);
    expect(s.onProvision).toHaveLength(2);
    await s.pool.release("slot-1");
  });

  it.skipIf(!pythonAvailable().ok)(`a Python run in the slot imports the slot's source, not PYTHONPATH's${pythonAvailable().ok ? "" : ` (skipped: ${pythonAvailable().reason})`}`, async () => {
    const lease = await s.pool.acquire(PLAN, "task-py", c2);
    const py = pythonAvailable();
    const savedPath = process.env["PYTHONPATH"];
    process.env["PYTHONPATH"] = s.repo;
    try {
      const r = await runArgv(py.command, [...py.prefix, "-c", "import mypkg, os; print(mypkg.__file__); print(os.environ.get('PYTHONPATH'))"], {
        cwd: lease.path, timeoutMs: 60_000,
      });
      expect(r.code, r.stderr).toBe(0);
      const [module = "", pythonPath = ""] = r.stdout.trim().split(/\r?\n/);
      expect(realpathSync.native(module).toLowerCase().startsWith(lease.path.toLowerCase())).toBe(true);
      expect(pythonPath).toBe("None");
    } finally {
      if (savedPath === undefined) delete process.env["PYTHONPATH"];
      else process.env["PYTHONPATH"] = savedPath;
      await s.pool.release(lease.slot);
    }
  });

  it("GC: the marked slot is removed, an unmarked directory survives, a junction's target survives", async () => {
    const precious = join(base, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "gold.txt"), "keep\n");
    symlinkSync(precious, join(slot, "link-out"), WIN ? "junction" : "dir");
    mkdirSync(join(slot, "node_modules", "dep", "nested"), { recursive: true });
    symlinkSync(precious, join(slot, "node_modules", "dep", "nested", "link-in-deps"), WIN ? "junction" : "dir");
    const stray = join(s.slotsDir, "stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "keep.txt"), "mine\n");
    const out = await s.pool.gc(async (planId) => planId === PLAN);
    expect(out.removed).toEqual([slot]);
    expect(out.reported).toEqual([`${stray}: unmarked`]);
    expect(existsSync(slot)).toBe(false);
    expect(read(join(precious, "gold.txt"))).toBe("keep\n");
    expect(read(join(stray, "keep.txt"))).toBe("mine\n");
    expect((await s.ops.worktreeList()).some((w) => w.path.toLowerCase() === slot.toLowerCase())).toBe(false);
    expect(existsSync(markerPath(join(s.home, "markers"), PLAN, "slot-1"))).toBe(false);
    expect(existsSync(s.slotsDir)).toBe(true);
    expect(slotEnvFor(slot)).toBeNull();
    expect(await s.pool.list()).toEqual([]);
    expect(existsSync(sentinel)).toBe(false);
    expect(git(s.repo, "rev-parse", "HEAD")).toBe(c3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------------------------

describe("commit identity", () => {
  it("is E_IDENTITY when neither the repository nor an isolated HOME has one", async () => {
    const repo = newRepo("no-identity", ["node-npm"]);
    commitAll(repo, "c1");
    const inner = createGitRunner({ mode: "user", toplevel: repo });
    const isolated: GitRunner = {
      run: (args, o) => inner.run(args, {
        ...o, env: { ...(o.env ?? {}), HOME: emptyHome, USERPROFILE: emptyHome, XDG_CONFIG_HOME: emptyHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGlobal },
      }),
    };
    const s = makePool(repo, "noid", undefined, isolated);
    await expect(s.ops.worktreeList()).rejects.toMatchObject({ code: "E_IDENTITY", message: expect.stringContaining("git config user.name") });
    await s.pool.open();
    await expect(s.pool.acquire(PLAN, "t", git(repo, "rev-parse", "HEAD"))).rejects.toMatchObject({ code: "E_IDENTITY" });
    expect(existsSync(join(s.slotsDir, "slot-1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// uv (real installer, offline)
// ---------------------------------------------------------------------------------------------------------------

function uvAvailable(): { ok: boolean; reason: string } {
  const version = spawnSync("uv", ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.error !== undefined || version.status !== 0) return { ok: false, reason: "uv is not on PATH" };
  const python = spawnSync("uv", ["python", "find"], { encoding: "utf8", windowsHide: true, env: { ...process.env, UV_PYTHON_DOWNLOADS: "never" } });
  if (python.status !== 0) return { ok: false, reason: "uv finds no installed Python (downloads are disabled)" };
  return { ok: true, reason: "" };
}

/** The absolute interpreter (never the py launcher, which would follow VIRTUAL_ENV into the slot's fake .venv). */
function pythonAvailable(): { ok: boolean; reason: string; command: string; prefix: string[] } {
  if (pythonProbe !== undefined) return pythonProbe;
  const [launcher, args] = WIN ? ["py", ["-3"]] as const : ["python3", []] as const;
  const r = spawnSync(launcher, [...args, "-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
  const exe = r.stdout?.trim() ?? "";
  pythonProbe = r.error !== undefined || r.status !== 0 || exe === ""
    ? { ok: false, reason: `${launcher} is not available`, command: launcher, prefix: [] }
    : { ok: true, reason: "", command: exe, prefix: [] };
  return pythonProbe;
}

const UV = uvAvailable();

describe("uv slots", () => {
  it.skipIf(!UV.ok)(`provisions a py-uv slot with uv sync --frozen and registers its environment${UV.ok ? "" : ` (skipped: ${UV.reason})`}`, async () => {
    const repo = newRepo("uv-repo", ["py-uv"]);
    git(repo, "config", "user.name", "Slot Tester");
    git(repo, "config", "user.email", "slot.tester@example.test");
    const head = commitAll(repo, "c1");
    const lad = join(base, "uv-localappdata");
    const provisioner = createProvisioner({
      spawner: nodeSpawner(), fs: nodeFs(), clock: realClock(),
      host: { env: { ...process.env, LOCALAPPDATA: lad, HOME: lad, UV_OFFLINE: "1" }, platform: process.platform, nodeExecPath: process.execPath, guards: [repo] },
      config: { provision: "auto", python: "auto" },
    });
    const s = makePool(repo, "uv", provisioner);
    await s.pool.open();
    const lease = await s.pool.acquire(PLAN, "uv-task", head);
    expect(s.onProvision).toEqual(["slot-1:uv"]);
    expect(existsSync(join(lease.path, ".venv", "pyvenv.cfg"))).toBe(true);
    expect(slotEnvFor(lease.path)?.set["VIRTUAL_ENV"]).toBe(join(lease.path, ".venv"));
    await s.pool.release(lease.slot);
    const again = await s.pool.acquire(PLAN, "uv-task-2", head);
    expect(again.slot).toBe(lease.slot);
    expect(s.onProvision).toHaveLength(1);
    await s.pool.release(again.slot);
    expect((await s.pool.gc(async () => true)).removed).toEqual([lease.path]);
  }, 300_000);

  it.runIf(!UV.ok)(`records why the uv cases are skipped: ${UV.reason || "uv available"}`, () => {
    expect(UV.reason).not.toBe("");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The provisioner on the real file system
// ---------------------------------------------------------------------------------------------------------------

describe("provisioner on the real file system", () => {
  // Regression: ensureDir was a non-recursive mkdir, so the first provision on a machine without
  // %LOCALAPPDATA%\omr-executor (POSIX: $HOME/.cache/omr-executor) failed with ENOENT on the locks directory.
  it("the first provision on a machine creates the lock directory with its parents", async () => {
    const fresh = join(base, "fresh-localappdata");
    mkdirSync(fresh);
    const slot = join(base, "d3-slot");
    mkdirSync(slot);
    const provisioner = createProvisioner({
      spawner: nodeSpawner(), fs: nodeFs(), clock: realClock(),
      host: { env: { ...process.env, LOCALAPPDATA: fresh, HOME: fresh }, platform: process.platform, nodeExecPath: process.execPath, guards: [] },
      config: { provision: { npm: [["node", "-e", "require('fs').writeFileSync('ran.txt', 'ok')"]] }, python: "auto" },
    });
    await provisioner.provision(slot, { managers: ["npm"], yarnBerry: false, editable: false, manifests: {}, python: null }, { fresh: false });
    expect(read(join(slot, "ran.txt"))).toBe("ok");
  });

  it("runs an override step for real once the lock directory's parent exists, and releases the lock", async () => {
    const lad = join(base, "ready-localappdata");
    mkdirSync(join(lad, "omr-executor"), { recursive: true });
    mkdirSync(join(lad, ".cache", "omr-executor"), { recursive: true });
    const slot = join(base, "override-slot");
    mkdirSync(slot);
    const provisioner = createProvisioner({
      spawner: nodeSpawner(), fs: nodeFs(), clock: realClock(),
      host: { env: { ...process.env, LOCALAPPDATA: lad, HOME: lad, NPM_TOKEN: "secret-token" }, platform: process.platform, nodeExecPath: process.execPath, guards: [] },
      config: { provision: { npm: [["node", "-e", "require('fs').writeFileSync('env.txt', String(process.env.NPM_TOKEN))"]] }, python: "auto" },
    });
    await provisioner.provision(slot, { managers: ["npm"], yarnBerry: false, editable: false, manifests: {}, python: null }, { fresh: false });
    expect(read(join(slot, "env.txt"))).toBe("undefined");
    const locks = WIN ? join(lad, "omr-executor", "locks") : join(lad, ".cache", "omr-executor", "locks");
    expect(existsSync(join(locks, "npm.lock"))).toBe(false);
  });
});
