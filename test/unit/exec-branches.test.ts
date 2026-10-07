import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KILL_GRACE_MS, SWEEP_TIMEOUT_MS, runArgv, runShell, setSweeperExecutableForTests, trackingForTests } from "../../src/verify/exec";

// Branches of src/verify/exec.ts that test/unit/exec.test.ts reaches only in a
// separate host process (test/fixtures/exec/host.mjs), where coverage is not
// collected, or not at all. Real processes throughout; the only substitutions
// are the orphan sweeper (a node stand-in in place of PowerShell, spawned in
// this process so the sweep's code paths are measured) and, in one test, a
// failing taskkill.

const STAND_IN = "omr-stand-in-sweeper";
const state = vi.hoisted(() => ({
  /** The stand-in's script and arguments, run by node in place of PowerShell. */
  standIn: { script: "", args: [] as string[] },
  /** PID of the last stand-in started. */
  standInPid: 0,
  /** The cwd the last stand-in was spawned with (QA-G-9). */
  standInCwd: undefined as unknown,
  /** The last direct child spawned through exec.ts (not a stand-in). */
  lastChild: undefined as ChildProcess | undefined,
  /** Make the next `taskkill` report a failure without running it. */
  taskkillFails: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const spawn = (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    if (file === STAND_IN) {
      const standIn = real.spawn(process.execPath, ["-e", state.standIn.script, ...state.standIn.args], options);
      state.standInPid = standIn.pid ?? 0;
      state.standInCwd = options.cwd;
      return standIn;
    }
    const child = real.spawn(file, args, options);
    state.lastChild = child;
    return child;
  };
  const execFile = (file: string, args: readonly string[], options: object, done: (err: Error | null) => void): ChildProcess | undefined => {
    if (state.taskkillFails && /taskkill(\.exe)?$/i.test(file)) {
      state.taskkillFails = false;
      setImmediate(() => done(new Error("taskkill failed (simulated)")));
      return undefined;
    }
    return real.execFile(file, args, options, done);
  };
  return { ...real, spawn, execFile };
});

const isWin = process.platform === "win32";
const TREE = fileURLToPath(new URL("../fixtures/exec/tree.cjs", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  setSweeperExecutableForTests(undefined);
  state.taskkillFails = false;
  state.lastChild = undefined;
  state.standInPid = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(check: () => boolean, limitMs = 10_000): Promise<boolean> {
  for (const end = Date.now() + limitMs; ;) {
    if (check()) return true;
    if (Date.now() >= end) return false;
    await sleep(50);
  }
}

/** A test/fixtures/exec/tree.cjs "early-exit" run: a direct child that exits, leaving a holder of its pipes. */
function earlyExit() {
  const dir = mkdtempSync(join(tmpdir(), "omr-exec-br-"));
  dirs.push(dir);
  const file = (name: string) => join(dir, `${name}.pid`);
  const pid = (name: "child" | "holder") => Number(readFileSync(file(name), "utf8"));
  return {
    dir,
    args: [TREE, "early-exit", dir],
    pid,
    /** The holder is running and the direct child is gone; +300 ms lets the sweeper arm (SWEEP_ARM_MS 200). */
    async childExited(): Promise<void> {
      expect(await waitFor(() => existsSync(file("holder")) && readFileSync(file("holder"), "utf8") !== "")).toBe(true);
      expect(await waitFor(() => !alive(pid("child")))).toBe(true);
      await sleep(300);
    },
    /** Let the holder end on its own, and make sure it did. */
    async release(): Promise<void> {
      writeFileSync(join(dir, "release"), "");
      if (!existsSync(file("holder"))) return;
      const holder = pid("holder");
      if (!(await waitFor(() => !alive(holder), 5000))) process.kill(holder);
    },
  };
}

/** Use a node stand-in as the sweeper. */
function standIn(script: string, ...args: string[]): void {
  state.standIn = { script, args };
  setSweeperExecutableForTests(STAND_IN);
}

/** Wait for the stand-in to end and for its `close` to reach the sweeper. */
async function standInGone(limitMs = 10_000): Promise<void> {
  const pid = state.standInPid;
  expect(pid).toBeGreaterThan(0);
  expect(await waitFor(() => !alive(pid), limitMs)).toBe(true);
  await sleep(200);
}

/**
 * A stand-in that pins "1 tree", kills the holder `killAfterMs` after it reads
 * `kill`, and reports it `reportAfterMs` after the kill.
 */
const killingStandIn = (reportAfterMs: number, killAfterMs = 0) => [
  "const fs = require('node:fs');",
  "const holderFile = require('node:path').join(process.argv[1], 'holder.pid');",
  "process.stdout.write('pinned 1\\n');",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (s) => {",
  "  input += s;",
  "  if (!input.includes('kill')) return;",
  "  const holder = Number(fs.readFileSync(holderFile, 'utf8'));",
  "  setTimeout(() => {",
  "    process.kill(holder);",
  `    setTimeout(() => { process.stdout.write(holder + '\\n'); process.exit(0); }, ${reportAfterMs});`,
  `  }, ${killAfterMs});`,
  "});",
].join("\n");

describe.runIf(isWin)("orphan sweep branches (Windows-only: the sweeper runs only on Windows)", () => {
  it("a sweep that pinned trees and is still reporting at the grace counts as a kill, and is unref'd, not disposed (QA-1.2-24, QA-1.2-19)", async () => {
    const t = earlyExit();
    standIn(killingStandIn(KILL_GRACE_MS + 500), t.dir);
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30_000, signal: controller.signal });
    try {
      await t.childExited();
      controller.abort();
      const r = await pending;
      expect(r).toMatchObject({ code: 1, timedOut: true });
      expect(r.stderr).toMatch(/\[orphan sweep still reporting at settle: it may have ended what held the pipes\]/);
      expect(r.stderr).not.toMatch(/output streams force-closed/);
      expect(alive(t.pid("holder"))).toBe(false);
      // The unref'd sweep still finishes after the run settled.
      await standInGone();
    } finally {
      await t.release();
      await pending;
    }
  }, 30_000);

  it("a sweep that never pinned anything and is pending at the grace leaves the natural result, then reports 'no marker' (QA-1.2-29, QA-1.2-15)", async () => {
    const t = earlyExit();
    // No marker, no kill, and it outlives the grace: exits 0 on its own.
    standIn("process.stdin.resume(); setTimeout(() => process.exit(0), 4000);");
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30_000, signal: controller.signal });
    try {
      await t.childExited();
      const abortedAt = Date.now();
      controller.abort();
      // The holder ends on its own well inside the grace.
      writeFileSync(join(t.dir, "release"), "");
      const r = await pending;
      expect(r).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false });
      // Settled by the grace, so the sweep was still pending there.
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(KILL_GRACE_MS - 50);
      // Its exit without a marker reaches the (settled) run as "no marker".
      await standInGone();
    } finally {
      await t.release();
      await pending;
    }
  }, 30_000);

  it("an armed sweeper is disposed (killed before it pinned) when the run settles naturally", async () => {
    const t = earlyExit();
    standIn("setTimeout(() => {}, 60000);");
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30_000 });
    try {
      await t.childExited();
      expect(state.standInPid).toBeGreaterThan(0);
      // QA-G-9: never the host's cwd (the user's project).
      expect(state.standInCwd).toBe(tmpdir());
      writeFileSync(join(t.dir, "release"), "");
      expect(await pending).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false });
      // dispose() ended the hung stand-in rather than leaving it for 60 s.
      await standInGone(5000);
    } finally {
      await t.release();
      await pending;
    }
  }, 30_000);

  it("an abort right after the child's exit sweeps once, before the arm timer, which then does not sweep again", async () => {
    const t = earlyExit();
    // The kill waits past SWEEP_ARM_MS (200 ms), so the pipes are still held when the arm timer fires.
    standIn(killingStandIn(0, 600), t.dir);
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30_000, signal: controller.signal });
    const child = state.lastChild;
    expect(child).toBeDefined();
    // Registered after exec.ts's own `exit` listener, so the run has seen the exit.
    child?.once("exit", () => setImmediate(() => controller.abort()));
    try {
      const r = await pending;
      expect(r).toMatchObject({ code: 1, timedOut: true });
      expect(r.stderr).toMatch(/\[killed 1 process tree\(s\) left running by the exited command: pid \d+\]/);
      expect(alive(t.pid("holder"))).toBe(false);
    } finally {
      await t.release();
    }
  }, 30_000);

  it("gives a sweep that pinned trees SWEEP_TIMEOUT_MS after the kill, over twice the slowest CI sweep, before abandoning it (QA-1.2-14)", async () => {
    // Phase 3.1, CI round 3: the first sweep of a saturated CI job killed
    // 28.7 s after the kill request, 1.3 s inside the former 30 s limit.
    expect(SWEEP_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 28_700);
    const t = earlyExit();
    // Pins "1 tree", then never kills nor exits: only the limit ends it.
    standIn("process.stdout.write('pinned 1\\n'); process.stdin.resume();");
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30_000, signal: controller.signal });
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await t.childExited();
      timers.mockClear();
      controller.abort();
      const r = await pending;
      // The grace settled the run, so the sweep's limit alone bounds the sweeper.
      expect(r).toMatchObject({ code: 1, timedOut: true });
      expect(r.stderr).toMatch(/output streams force-closed \d+ ms after the kill: a descendant still held them/);
      expect(timers.mock.calls.some(([, ms]) => ms === SWEEP_TIMEOUT_MS)).toBe(true);
    } finally {
      timers.mockRestore();
      if (state.standInPid > 0 && alive(state.standInPid)) process.kill(state.standInPid);
      await t.release();
      await pending;
    }
  }, 30_000);

  it("falls back to a direct kill when taskkill fails on a live direct child", async () => {
    state.taskkillFails = true;
    const start = Date.now();
    const r = await runArgv(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tmpdir(), timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(state.taskkillFails).toBe(false);
    expect(Date.now() - start).toBeLessThan(KILL_GRACE_MS + 5000);
  }, 20_000);
});

describe.runIf(!isWin)("QA-G-5: a normal exit ends what the run left in its process group (POSIX)", () => {
  it.each([false, true])("a passing command's background grandchild is dead within 3 s of the settle (lowPriority %s)", async (lowPriority) => {
    const r = await runShell("sleep 30 >/dev/null 2>&1 & echo $!", { cwd: tmpdir(), timeoutMs: 20_000, lowPriority });
    expect(r).toMatchObject({ code: 0, stderr: "", timedOut: false });
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    try {
      expect(await waitFor(() => !alive(grandchild), 3000)).toBe(true);
    } finally {
      if (alive(grandchild)) process.kill(grandchild);
    }
  }, 20_000);
});

describe("kill and exit-hook edges", () => {
  it("an abort that arrives before a failed spawn reports its error counts as a kill (no PID: direct kill only)", async () => {
    const controller = new AbortController();
    const pending = runArgv("omr-no-such-executable-xyz", [], { cwd: tmpdir(), timeoutMs: 20_000, signal: controller.signal });
    // Synchronous: the spawn error is emitted on a later tick.
    controller.abort();
    const r = await pending;
    expect(r.code).toBe(1);
    expect(r.timedOut).toBe(true);
    // Which error settles the run is a race: the spawn's ENOENT, or (seen on Linux, node 20) the
    // direct kill of the never-started child, which Node may report as an `error` event
    // ("Error: kill EPERM") before the ENOENT tick. Either way it is a kill with code 1.
    expect(r.stderr).toMatch(/ENOENT|Error: kill E[A-Z]+/);
  });

  it("the exit hook does nothing when no run is in flight", () => {
    const { track, untrack, isTracked } = trackingForTests;
    const pid = 2_000_000_127;
    const token = Symbol("idle");
    // Installs the hook if no run did yet.
    track(pid, token);
    untrack(pid, token);
    expect(isTracked(pid)).toBe(false);
    const hooks = process.listeners("exit").filter(l => l.name === "killTrackedProcesses");
    expect(hooks.length).toBeGreaterThan(0);
    // This module's hook is the last installed; with nothing tracked it spawns no taskkill.
    expect(() => hooks[hooks.length - 1](0)).not.toThrow();
  });
});
