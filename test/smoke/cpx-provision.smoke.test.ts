/**
 * Phase 2.4 provisioning smoke (memo §9.3):
 *
 *   npm run smoke:cpx:provision            (sets RUN_OC_SMOKE_CPX=1)
 *
 * Gate: RUN_OC_SMOKE_CPX=1. Unset, every test of the file is skipped, so `npm test` never runs it (and vitest.config.ts
 * excludes test/smoke/** anyway). Set, it needs on PATH: git, pnpm (or corepack), Python 3 (Windows: the py launcher)
 * with pytest installed for that Python. A missing tool fails the test with the remedy; nothing is downloaded except
 * what pnpm and pip decide for a project with zero dependencies (nothing).
 *
 * - A slot of a repository with the node-pnpm and py-pip fixtures is provisioned for real (pnpm install, python -m venv,
 *   pip install -r requirements.txt).
 * - pytest runs through verify/exec runArgv in the slot, with PYTHONPATH pointing at the main checkout: it must report
 *   the slot's module path.
 * - A second task reuses the slot without reinstalling: onProvision is not called again; both acquire times are logged
 *   (informational, not a threshold).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitOps, createGitRunner, type GitOps } from "../../src/executor/git";
import { createSlotPool } from "../../src/executor/slots/pool";
import { createProvisioner, planProvision, type Detection, type ProvisionHost } from "../../src/executor/slots/provision";
import type { Clock, FileSystem, FsStat, ProcessResult, Spawner } from "../../src/executor/types";
import { runArgv } from "../../src/verify/exec";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const RUN = process.env.RUN_OC_SMOKE_CPX === "1";
const WIN = process.platform === "win32";
const PLAN = "p-20261011-smoke1";
const FIXTURES = fileURLToPath(new URL("../fixtures/cpx/repos/", import.meta.url));

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(Reflect.get(error, "code")) : undefined;
}

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
        return { kind: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other", size: st.size, mtimeMs: st.mtimeMs };
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

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.error !== undefined || r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.error?.message ?? r.stderr}`);
  return r.stdout.trim();
}

/** The interpreter that has pytest, by absolute path (the py launcher would follow VIRTUAL_ENV into the slot). */
function pytestPython(): string {
  const [launcher, args] = WIN ? ["py", ["-3"]] as const : ["python3", []] as const;
  const r = spawnSync(launcher, [...args, "-c", "import sys, pytest; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
  const exe = r.stdout?.trim() ?? "";
  if (r.error !== undefined || r.status !== 0 || exe === "") {
    throw new Error(`${launcher} ${args.join(" ")} with pytest is required for this smoke: install Python 3 and run "${launcher} ${args.join(" ")} -m pip install pytest"`);
  }
  return exe;
}

describe.skipIf(!RUN)("cpx provisioning smoke (real pnpm and pip)", () => {
  let base = "";
  let repo = "";
  let head = "";
  let ops: GitOps | undefined;
  let pool: ReturnType<typeof createSlotPool> | undefined;
  let slotPath = "";
  const provisioned: string[] = [];
  const times: Record<string, number> = {};

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-cpx-provision-")));
    repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Smoke Tester");
    git(repo, "config", "user.email", "smoke.tester@example.test");
    git(repo, "config", "core.autocrlf", "false");
    for (const f of ["node-pnpm", "py-pip"]) cpSync(join(FIXTURES, f), repo, { recursive: true, filter: (src) => !src.includes("fixpkg") });
    writeFileSync(join(repo, ".gitignore"), "__pycache__/\n.pytest_cache/\n");
    git(repo, "add", "--all");
    git(repo, "-c", "commit.gpgSign=false", "commit", "-q", "--no-verify", "-m", "fixtures");
    head = git(repo, "rev-parse", "HEAD");

    // Install locks under the scratch directory. Its parent is created up front: the provisioner creates only the last
    // level (D3 in test/integration/executor-slots-git.test.ts).
    const lad = join(base, "localappdata");
    mkdirSync(join(lad, "omr-executor"), { recursive: true });
    mkdirSync(join(lad, ".cache", "omr-executor"), { recursive: true });
    const host: ProvisionHost = {
      env: { ...process.env, ...(WIN ? { LOCALAPPDATA: lad } : { HOME: lad }) },
      platform: process.platform, nodeExecPath: process.execPath, guards: [repo],
    };
    const config = { provision: "auto", python: "auto" } as const;
    const probe: Detection = { managers: ["pip", "pnpm"], yarnBerry: false, editable: false, manifests: { "requirements.txt": "0".repeat(64) }, python: null };
    planProvision(join(base, "probe-slot"), probe, host, config); // fails fast, naming the remedy, when pnpm or Python is missing

    const fs = nodeFs();
    const home = join(base, "home");
    ops = createGitOps({
      git: createGitRunner({ mode: "hardened", toplevel: repo }), userGit: createGitRunner({ mode: "user", toplevel: repo }),
      fs, planId: PLAN, toplevel: repo, executorHome: home,
    });
    pool = createSlotPool({
      planId: PLAN, repoKey: "smoke", toplevel: repo, slotsDir: join(base, "slots", PLAN), markersDir: join(home, "markers"),
      executorHome: home, maxParallel: 2, git: ops, fs, clock: realClock(),
      provisioner: createProvisioner({ spawner: nodeSpawner(), fs, clock: realClock(), host, config }),
      onProvision: (slot, managers) => { provisioned.push(`${slot}:${managers.join(",")}`); },
      logger: { warn: (m) => { console.warn(`[cpx-provision smoke] ${m}`); } },
    });
  });

  afterAll(async () => {
    if (pool !== undefined) {
      const out = await pool.gc(async () => true);
      console.info(`[cpx-provision smoke] gc removed ${out.removed.length} slot(s); reported: ${JSON.stringify(out.reported)}`);
    }
    if (base !== "") await removeDirWhenReleased(base, { deadlineMs: 30_000 });
  }, 120_000);

  const thePool = (): ReturnType<typeof createSlotPool> => {
    if (pool === undefined) throw new Error("the pool was not created (see beforeAll)");
    return pool;
  };

  it("provisions a pnpm + pip slot for real", async () => {
    await thePool().open();
    const started = Date.now();
    const lease = await thePool().acquire(PLAN, "task-1", head);
    times["first"] = Date.now() - started;
    slotPath = lease.path;
    expect(provisioned).toEqual([`${lease.slot}:pip,pnpm`]);
    expect(existsSync(join(lease.path, ".venv", "pyvenv.cfg"))).toBe(true);
    expect(existsSync(join(lease.path, ".venv", WIN ? "Scripts" : "bin"))).toBe(true);
    const rec = await thePool().get(lease.slot);
    expect(rec).toMatchObject({ state: "leased", managers: ["pip", "pnpm"] });
    expect(Object.keys(rec?.manifests ?? {})).toEqual(expect.arrayContaining(["package.json", "pnpm-lock.yaml", "requirements.txt"]));
  }, 600_000);

  it("pytest in the slot imports the slot's module, not PYTHONPATH's", async () => {
    expect(slotPath).not.toBe("");
    const python = pytestPython();
    const saved = process.env["PYTHONPATH"];
    process.env["PYTHONPATH"] = repo;
    try {
      const r = await runArgv(python, ["-m", "pytest", "-q", "-s", "-p", "no:cacheprovider", "tests/test_where.py"], { cwd: slotPath, timeoutMs: 180_000 });
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
      const line = r.stdout.split(/\r?\n/).find((l) => l.includes("MODULE_PATH="));
      expect(line, r.stdout).toBeDefined();
      const module = (line ?? "").slice((line ?? "").indexOf("MODULE_PATH=") + "MODULE_PATH=".length).trim();
      console.info(`[cpx-provision smoke] pytest module path: ${module}`);
      expect(realpathSync.native(module).toLowerCase().startsWith(`${slotPath.toLowerCase()}${WIN ? "\\" : "/"}`)).toBe(true);
      const env = await runArgv(python, ["-c", "import os; print(os.environ.get('PYTHONPATH'))"], { cwd: slotPath, timeoutMs: 60_000 });
      expect(env.stdout.trim()).toBe("None");
    } finally {
      if (saved === undefined) delete process.env["PYTHONPATH"];
      else process.env["PYTHONPATH"] = saved;
    }
  }, 300_000);

  it("a second task reuses the slot without reinstalling (timed)", async () => {
    const first = await thePool().get("slot-1");
    expect(first?.owner).toBe("task-1");
    await thePool().release("slot-1");
    const before = provisioned.length;
    const started = Date.now();
    const lease = await thePool().acquire(PLAN, "task-2", head);
    times["second"] = Date.now() - started;
    expect(lease.slot).toBe("slot-1");
    expect(provisioned).toHaveLength(before);
    console.info(`[cpx-provision smoke] acquire times (ms, informational): first=${times["first"] ?? "?"} second=${times["second"]}`);
    await thePool().release(lease.slot);
  }, 300_000);
});
