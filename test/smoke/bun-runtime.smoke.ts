// Bun runtime smoke for the verification primitives (Phase 3.1, QA-deferred).
//
// opencode loads the plugin under Bun 1.3.x, but every unit and e2e test runs under Node. This
// standalone script runs the real src/verify modules under Bun and checks the behaviours that
// differed, or could differ, between the two runtimes:
//   a. exec.ts      exit codes, argv byte fidelity, the deadline tree kill, lowPriority, and the
//                   win32 batch-file refusal (QA-1.2-17: Bun spawned a .cmd without complaint);
//   b. runner.ts    JS runners resolve a real node, never bun (QA-1.3-18, QA-1.3-30);
//   c. slot.ts      one holder per slot, in one Bun process and across two;
//   d. reference.ts capture + materialize + dispose with a linked node_modules: the real
//                   node_modules survives and no omr-ref-* dir remains (Bun's native fs.rm);
//   e. exec.ts      the exit hook kills a runShell tree when a Bun host calls process.exit.
//
// Run it with `bun test/smoke/bun-runtime.smoke.ts` (not through vitest). It prints one line per
// check and exits 0 when every check passed, 1 otherwise. Everything it creates lives in one
// directory under os.tmpdir(), and every child it spawns runs without a shell.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runArgv, runShell } from "../../src/verify/exec";
import { captureReference, materialize, nodeReferenceFs, REF_DIR_PREFIX } from "../../src/verify/reference";
import { isScopedSpec, isUnverifiable, planScopedRun, resolveEntry, type PlannerFs } from "../../src/verify/runner";
import { acquireSlot, machineClockFrom } from "../../src/verify/slot";

const SELF = fileURLToPath(import.meta.url);
const REPO = join(dirname(SELF), "..", "..");
const BUN = process.execPath;
const isWin = process.platform === "win32";
/** How long after a deadline (or the host's exit) a killed tree may still be alive. */
const DEAD_WITHIN_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls `fn` every `stepMs` until it returns a value other than undefined, or `timeoutMs` passes. */
async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs: number, stepMs = 50): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() >= end) return undefined;
    await sleep(stepMs);
  }
}

/** Every PID a check learned about, killed at the end if still alive. */
const pids = new Set<number>();

async function readPids(file: string): Promise<number[] | undefined> {
  try {
    const list = (await readFile(file, "utf8")).trim().split(/\s+/).map(Number);
    if (list.length === 0 || list.some((n) => !Number.isInteger(n) || n <= 0)) return undefined;
    for (const p of list) pids.add(p);
    return list;
  } catch {
    return undefined;
  }
}

/** Resolves with the ms it took for every pid to die, or undefined if one outlived `timeoutMs`. */
async function allDeadWithin(list: readonly number[], timeoutMs: number): Promise<number | undefined> {
  const start = Date.now();
  const ok = await waitFor(() => (list.every((p) => !alive(p)) ? true : undefined), timeoutMs, 25);
  return ok ? Date.now() - start : undefined;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---- child modes: the smoke re-runs itself under bun for the cross-process checks ----------------

/** `--slot-child <dir>`: take slot 0 of 1 without waiting, print held/busy, hold until <dir>/done. */
async function slotChild(dir: string): Promise<never> {
  const r = await acquireSlot({ max: 1, waitMs: 0, meta: { cwd: dir, command: "bun smoke" } }, { dir });
  if ("busy" in r) {
    process.stdout.write("busy\n");
    process.exit(0);
  }
  process.stdout.write("held\n");
  await waitFor(() => (existsSync(join(dir, "done")) ? true : undefined), 30_000);
  await r.release();
  process.exit(0);
}

/** `--exit-host <tree.cjs> <pidfile>`: start a runShell tree, wait for its pids, then process.exit. */
async function exitHost(tree: string, pidfile: string): Promise<never> {
  void runShell(`"${BUN}" "${tree}" "${pidfile}"`, { timeoutMs: 120_000 });
  const list = await waitFor(() => readPids(pidfile), 20_000);
  process.stdout.write(list ? "started\n" : "no pids\n");
  process.exit(list ? 0 : 3);
}

// ---- helper scripts, run by bun ------------------------------------------------------------------

const SCRIPTS: Record<string, string> = {
  "echo.cjs": "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  "exit.cjs": "process.exit(Number(process.argv[2]));\n",
  "sleep.cjs": "setTimeout(() => {}, 60000);\n",
  // A child that spawns a grandchild sleeping 60 s, records both pids atomically, then sleeps.
  "tree.cjs": [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const gc = spawn(process.execPath, [path.join(__dirname, "sleep.cjs")], { stdio: "ignore" });',
    "const out = process.argv[2];",
    'fs.writeFileSync(out + ".tmp", process.pid + " " + gc.pid);',
    'fs.renameSync(out + ".tmp", out);',
    "setTimeout(() => {}, 60000);",
    "",
  ].join("\n"),
  // Records its pid, then sleeps (the priority probe).
  "pid.cjs": [
    'const fs = require("node:fs");',
    "const out = process.argv[2];",
    'fs.writeFileSync(out + ".tmp", String(process.pid));',
    'fs.renameSync(out + ".tmp", out);',
    "setTimeout(() => {}, 30000);",
    "",
  ].join("\n"),
};

// ---- checks --------------------------------------------------------------------------------------

type Result = "pass" | "fail" | "skip";
const results: Array<{ name: string; result: Result }> = [];

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, result: "pass" });
    console.log(`PASS ${name} (${Date.now() - start} ms)${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, result: "fail" });
    console.log(`FAIL ${name} (${Date.now() - start} ms): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function skip(name: string, why: string): void {
  results.push({ name, result: "skip" });
  console.log(`SKIP ${name}: ${why}`);
}

const q = (s: string) => JSON.stringify(s);

async function execChecks(work: string): Promise<void> {
  const script = (n: string) => join(work, n);

  await check("exec: runArgv keeps exit codes 0 and 3", async () => {
    const r0 = await runArgv(BUN, [script("exit.cjs"), "0"], { timeoutMs: 30_000 });
    const r3 = await runArgv(BUN, [script("exit.cjs"), "3"], { timeoutMs: 30_000 });
    assert(r0.code === 0 && !r0.timedOut, `exit 0 gave code ${r0.code} timedOut ${r0.timedOut} ${q(r0.stderr)}`);
    assert(r3.code === 3 && !r3.timedOut, `exit 3 gave code ${r3.code} timedOut ${r3.timedOut} ${q(r3.stderr)}`);
  });

  await check("exec: runArgv passes argv byte for byte", async () => {
    const args = ["a b", 'q"uote', "it's", "&|>", "<^%PATH%!", "trail\\", 'a\\"b', "ünïcødé ✓ 日本語 🚀"];
    const r = await runArgv(BUN, [script("echo.cjs"), ...args], { timeoutMs: 30_000 });
    assert(r.code === 0, `code ${r.code} ${q(r.stderr)}`);
    const got: unknown = JSON.parse(r.stdout);
    assert(JSON.stringify(got) === JSON.stringify(args), `sent ${q(JSON.stringify(args))}, got ${q(r.stdout)}`);
  });

  await check("exec: the deadline kills the whole tree", async () => {
    const pidfile = join(work, "tree-timeout.pids");
    const timeoutMs = 2000;
    const t0 = Date.now();
    const r = await runArgv(BUN, [script("tree.cjs"), pidfile], { timeoutMs });
    const list = await readPids(pidfile);
    assert(list?.length === 2, `the tree never recorded its pids (code ${r.code}, ${q(r.stderr)})`);
    assert(r.timedOut, `timedOut is false (code ${r.code})`);
    const remaining = Math.max(0, t0 + timeoutMs + DEAD_WITHIN_MS - Date.now());
    const took = await allDeadWithin(list, remaining);
    const alivePids = list.filter(alive);
    assert(took !== undefined, `still alive ${DEAD_WITHIN_MS} ms after the deadline: ${alivePids.join(", ")} (child ${list[0]}, grandchild ${list[1]})`);
    return `child and grandchild dead ${Date.now() - t0 - timeoutMs} ms after the deadline`;
  });

  await check("exec: lowPriority lowers the child", async () => {
    const pidfile = join(work, "prio.pid");
    const ac = new AbortController();
    const run = runArgv(BUN, [script("pid.cjs"), pidfile], { lowPriority: true, signal: ac.signal });
    try {
      const list = await waitFor(() => readPids(pidfile), 20_000);
      assert(list?.length === 1, "the child never recorded its pid");
      const pid = list[0];
      if (isWin) {
        const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const r = await runArgv(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').Priority`], { timeoutMs: 60_000 });
        const prio = Number(r.stdout.trim());
        assert(r.code === 0 && Number.isFinite(prio) && r.stdout.trim() !== "", `powershell: code ${r.code} ${q(r.stdout)} ${q(r.stderr)}`);
        assert(prio <= 6, `base priority ${prio}, expected <= 6 (below normal)`);
        return `base priority ${prio}`;
      }
      const r = await runArgv("ps", ["-o", "ni=", "-p", String(pid)], { timeoutMs: 30_000 });
      const ni = Number(r.stdout.trim());
      assert(r.code === 0 && r.stdout.trim() !== "", `ps: code ${r.code} ${q(r.stdout)} ${q(r.stderr)}`);
      assert(ni >= 10, `niceness ${ni}, expected >= 10`);
      return `niceness ${ni}`;
    } finally {
      ac.abort();
      await run;
    }
  });

  if (!isWin) {
    skip("exec: runArgv refuses a .cmd target", "win32 only");
    return;
  }
  await check("exec: runArgv refuses a .cmd target and it does not run", async () => {
    const marker = join(work, "batch-ran.txt");
    const bat = join(work, "probe.cmd");
    await writeFile(bat, `@echo off\r\necho ran> "${marker}"\r\n`);
    for (const target of [bat, join(work, "PROBE.CMD"), `${bat}. `]) {
      const r = await runArgv(target, ["&echo injected&"], { timeoutMs: 30_000 });
      assert(r.code === 1, `${q(target)}: code ${r.code}`);
      assert(r.stderr.includes("spawn EINVAL (batch files must run through runShell)"), `${q(target)}: stderr ${q(r.stderr)}`);
    }
    await sleep(500);
    assert(!existsSync(marker), "the batch file ran (marker file present)");
  });
}

function plannerFs(): PlannerFs {
  return {
    async fileExists(p) {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (p) => readFile(p, "utf8"),
    realpath: (p) => realpath(p),
    async stat(p) {
      const s = await stat(p, { bigint: true });
      return { isFile: s.isFile(), size: s.size, dev: s.dev, ino: s.ino };
    },
    readdir: (p) => readdir(p),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runArgv("git", args, { cwd, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: exit ${r.code} ${r.stderr.trim()}`);
  return r.stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "config", "core.autocrlf", "false");
  await git(dir, "config", "user.name", "omr bun smoke");
  await git(dir, "config", "user.email", "omr-bun-smoke@example.invalid");
  await git(dir, "config", "commit.gpgsign", "false");
}

async function runnerChecks(work: string): Promise<void> {
  // The e2e vitest fixture, with a stub vitest package: resolveEntry and the planner only read
  // node_modules/vitest/package.json and check that its bin exists, so no install is needed.
  const repo = join(work, "vitest-app");
  await cp(join(REPO, "test", "fixtures", "projects", "vitest-app"), repo, {
    recursive: true,
    filter: (p) => basename(p) !== "node_modules",
  });
  const pkg = join(repo, "node_modules", "vitest");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "vitest", version: "4.1.11", bin: { vitest: "./vitest.mjs" } }));
  await writeFile(join(pkg, "vitest.mjs"), "process.exit(0);\n");
  await initRepo(repo);
  const fs = plannerFs();
  const isNode = (file: string) => /^node(\.exe)?$/i.test(basename(file));

  await check("runner: resolveEntry picks node, not bun", async () => {
    const e = await resolveEntry({ kind: "vitest", launcher: "direct", gitRoot: repo }, repo, fs);
    assert(!isUnverifiable(e), `unverifiable: ${JSON.stringify(e)}`);
    assert(isNode(e.file), `file is ${q(e.file)}`);
    return e.file;
  });

  await check("runner: planScopedRun's spec runs node, not bun", async () => {
    const testFile = (await readdir(join(repo, "test"))).find((n) => n.endsWith(".test.js"));
    assert(testFile, "the fixture has no test/*.test.js");
    const plan = await planScopedRun({
      command: "npm test",
      cwd: repo,
      changedFiles: [{ path: join("test", testFile) }],
      budget: { maxWorkers: 1 },
      fs,
      search: { findByName: async () => [], findByContent: async () => [] },
    });
    assert(isScopedSpec(plan), `not a spec: ${JSON.stringify(plan)}`);
    assert(isNode(plan.file), `ScopedSpec.file is ${q(plan.file)}`);
    assert(!/bun-node-/i.test(plan.file), `ScopedSpec.file is Bun's temporary node: ${q(plan.file)}`);
    const r = await runArgv(plan.file, ["-p", "typeof process.versions.bun + ' ' + process.release.name"], { timeoutMs: 30_000 });
    assert(r.code === 0 && r.stdout.trim() === "undefined node", `${q(plan.file)} reports ${q(r.stdout.trim())} (code ${r.code})`);
    return plan.file;
  });
}

async function slotChecks(work: string): Promise<void> {
  const meta = { cwd: work, command: "bun smoke" };

  await check("slot: max 1 in one Bun process", async () => {
    const dir = join(work, "slots-inproc");
    const h1 = await acquireSlot({ max: 1, waitMs: 0, meta }, { dir });
    assert(!("busy" in h1), "first acquire was busy");
    const h2 = await acquireSlot({ max: 1, waitMs: 0, meta }, { dir });
    assert("busy" in h2, "second acquire was granted while the first holds the slot");
    await h1.release();
    const h3 = await acquireSlot({ max: 1, waitMs: 0, meta }, { dir });
    assert(!("busy" in h3), "acquire after release was busy");
    await h3.release();
  });

  await check("slot: the machine clock under Bun reads the OS uptime", async () => {
    const hr = () => Number(process.hrtime.bigint() / 1_000n) / 1_000;
    const up = () => uptime() * 1_000;
    const mono = machineClockFrom(hr, up);
    const a = mono();
    await sleep(50);
    const b = mono();
    const u = up();
    assert(b >= a, `went back: ${a} -> ${b}`);
    assert(Math.abs(b - u) <= 2_500, `mono ${b} vs uptime ${u}`);
    return `hrtime ${Math.round(hr())} ms, mono ${Math.round(b)} ms, uptime ${Math.round(u)} ms`;
  });

  await check("slot: max 1 across two Bun processes", async () => {
    const dir = join(work, "slots-xproc");
    await mkdir(dir, { recursive: true });
    const outs: string[] = ["", ""];
    const exits = [0, 1].map(
      (i) =>
        new Promise<number | null>((resolve) => {
          const c = spawn(BUN, [SELF, "--slot-child", dir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
          if (c.pid) pids.add(c.pid);
          c.stdout.setEncoding("utf8");
          c.stdout.on("data", (s: string) => (outs[i] += s));
          c.stderr.on("data", () => {});
          c.on("error", () => resolve(null));
          c.on("close", (code) => resolve(code));
        }),
    );
    try {
      const both = await waitFor(() => (outs.every((o) => o.includes("\n")) ? true : undefined), 30_000);
      assert(both, `children did not report: ${JSON.stringify(outs)}`);
      const lines = outs.map((o) => o.trim()).sort();
      assert(JSON.stringify(lines) === JSON.stringify(["busy", "held"]), `expected one held and one busy, got ${JSON.stringify(lines)}`);
    } finally {
      await writeFile(join(dir, "done"), "");
      const codes = await Promise.all(exits);
      assert(codes.every((c) => c === 0), `child exit codes ${JSON.stringify(codes)}`);
    }
  });
}

/** Walks `dir` without following links and unlinks every link, so a recursive delete cannot follow one. */
async function unlinkLinks(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    const st = await lstat(p).catch(() => undefined);
    if (!st) continue;
    if (st.isSymbolicLink()) await unlink(p);
    else if (st.isDirectory()) await unlinkLinks(p);
  }
}

async function referenceChecks(work: string): Promise<void> {
  await check("reference: dispose keeps the real node_modules and leaves no omr-ref dir", async () => {
    const repo = join(work, "ref-repo");
    const refTmp = join(work, "ref-tmp");
    await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
    await mkdir(refTmp, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await writeFile(join(repo, "package.json"), '{ "name": "ref-repo", "private": true }\n');
    await writeFile(join(repo, "a.txt"), "v1\n");
    const sentinel = join(repo, "node_modules", ".omr-sentinel");
    const depFile = join(repo, "node_modules", "dep", "index.js");
    await writeFile(sentinel, "sentinel\n");
    await writeFile(depFile, "module.exports = 1;\n");
    await initRepo(repo);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "--no-verify", "-m", "init");
    await writeFile(join(repo, "a.txt"), "v2\n"); // dirty tracked file
    await writeFile(join(repo, "b.txt"), "untracked\n");

    const warnings: string[] = [];
    const deps = {
      argv: runArgv,
      fs: nodeReferenceFs,
      tmpdir: refTmp,
      logger: { warn: (msg: string, data?: Record<string, unknown>) => void warnings.push(`${msg} ${JSON.stringify(data ?? {})}`) },
    };
    const signal = new AbortController().signal;
    const ref = await captureReference(repo, signal, deps);
    assert(ref, "captureReference returned undefined");
    const m = await materialize(ref, undefined, signal, deps);
    assert(m.ok, `materialize failed: ${m.ok ? "" : `${m.reason} ${m.detail}`}`);
    const handle = m.reference;
    let linkKind = "";
    try {
      assert(handle.links.length >= 1, "no node_modules link was created");
      const st = await lstat(handle.links[0]);
      assert(st.isSymbolicLink(), `${q(handle.links[0])} is not a link`);
      assert(existsSync(join(handle.links[0], ".omr-sentinel")), "the link does not reach the real node_modules");
      assert((await readFile(join(handle.dir, "a.txt"), "utf8")) === "v2\n", "the dirty tracked file is not at the reference");
      assert((await readFile(join(handle.dir, "b.txt"), "utf8")) === "untracked\n", "the untracked file is not at the reference");
      // A link that a test run left behind inside the worktree: dispose's sweep must unlink it too.
      await symlink(await realpath(join(repo, "node_modules")), join(handle.dir, "stray-link"), isWin ? "junction" : "dir");
      linkKind = isWin ? "junction" : "symlink";
    } finally {
      await handle.dispose();
    }
    assert(existsSync(sentinel), "the real node_modules sentinel is gone");
    assert(existsSync(depFile), "the real node_modules/dep/index.js is gone");
    const left = (await readdir(refTmp)).filter((n) => n.startsWith(REF_DIR_PREFIX));
    assert(left.length === 0, `omr-ref dirs remain: ${left.join(", ")}; warnings: ${warnings.join(" | ")}`);
    const wt = await git(repo, "worktree", "list", "--porcelain");
    assert(!wt.includes(REF_DIR_PREFIX), `a worktree entry remains: ${q(wt)}`);
    return `${linkKind} links removed, exact=${handle.exact}${warnings.length ? `, warnings: ${warnings.join(" | ")}` : ""}`;
  });
}

async function exitHookCheck(work: string): Promise<void> {
  await check("exec: the exit hook kills a runShell tree when a Bun host exits", async () => {
    const pidfile = join(work, "tree-exit.pids");
    let hostOut = "";
    const code = await new Promise<number | null>((resolve) => {
      const host = spawn(BUN, [SELF, "--exit-host", join(work, "tree.cjs"), pidfile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      if (host.pid) pids.add(host.pid);
      host.stdout.setEncoding("utf8");
      host.stderr.setEncoding("utf8");
      host.stdout.on("data", (s: string) => (hostOut += s));
      host.stderr.on("data", (s: string) => (hostOut += s));
      host.on("error", () => resolve(null));
      host.on("exit", (c) => resolve(c));
    });
    const exitedAt = Date.now();
    const list = await readPids(pidfile);
    assert(code === 0 && list?.length === 2, `host exit ${code}, pids ${JSON.stringify(list)}, output ${q(hostOut)}`);
    const took = await allDeadWithin(list, DEAD_WITHIN_MS);
    assert(took !== undefined, `still alive ${DEAD_WITHIN_MS} ms after the host exited: ${list.filter(alive).join(", ")} (child ${list[0]}, grandchild ${list[1]})`);
    return `child and grandchild dead ${Date.now() - exitedAt} ms after the host exited`;
  });
}

async function main(): Promise<number> {
  if (!process.versions.bun) {
    console.error("bun-runtime smoke: run this file with bun (`bun test/smoke/bun-runtime.smoke.ts`), not node");
    return 2;
  }
  console.log(`bun ${process.versions.bun} on ${process.platform}-${process.arch}, execPath ${BUN}`);
  const work = await realpath(await mkdtemp(join(tmpdir(), "omr-bun-smoke-")));
  try {
    for (const [name, text] of Object.entries(SCRIPTS)) await writeFile(join(work, name), text);
    await execChecks(work);
    await runnerChecks(work);
    await slotChecks(work);
    await referenceChecks(work);
    await exitHookCheck(work);
  } finally {
    for (const p of pids) {
      if (p !== process.pid && alive(p)) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // Gone meanwhile.
        }
      }
    }
    await unlinkLinks(work);
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e: unknown) => {
      console.log(`WARN could not remove ${work}: ${String(e)}`);
    });
  }
  const failed = results.filter((r) => r.result === "fail");
  const passed = results.filter((r) => r.result === "pass").length;
  const skipped = results.length - passed - failed.length;
  console.log(`${failed.length === 0 ? "OK" : "FAILED"}: ${passed} passed, ${failed.length} failed, ${skipped} skipped`);
  return failed.length === 0 ? 0 : 1;
}

const [mode, arg1, arg2] = process.argv.slice(2);
if (mode === "--slot-child" && arg1) await slotChild(arg1);
else if (mode === "--exit-host" && arg1 && arg2) await exitHost(arg1, arg2);
else {
  const watchdog = setTimeout(() => {
    console.log("FAIL watchdog: the smoke did not finish within 10 minutes");
    process.exit(1);
  }, 600_000);
  watchdog.unref();
  const code = await main().catch((e: unknown) => {
    console.log(`FAIL smoke crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return 1;
  });
  process.exit(code);
}
