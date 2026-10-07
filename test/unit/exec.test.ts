import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS, KILL_GRACE_MS, SWEEP_TIMEOUT_MS, deadlineOf, runArgv, runShell, setSweeperExecutableForTests, trackingForTests } from "../../src/verify/exec";

// Real processes, no mocks: the defect this guards against only exists in how
// the OS tears a process tree down, which a fake child_process cannot model.
const node = `"${process.execPath}"`;
const dirs: string[] = [];
// Retries: on Windows a just-killed process can still hold its cwd (a scratch
// dir) for a few hundred ms after `alive()` reports it dead (QA-1.2-30).
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

/** A shell -> node -> grandchild node chain, like `cmd /c npm test` -> vitest -> workers. */
function forkingFixture() {
  const dir = mkdtempSync(join(tmpdir(), "omr-exec-"));
  dirs.push(dir);
  const script = join(dir, "fork.cjs");
  const pidFile = join(dir, "grandchild.pid");
  writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "require('node:fs').writeFileSync(process.argv[2] + '.middle', String(process.pid));",
    "require('node:fs').writeFileSync(process.argv[2], String(g.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  return {
    command: `${node} "${script}" "${pidFile}"`, script, pidFile, dir,
    grandchild: () => Number(readFileSync(pidFile, "utf8")),
    /** The node process between the shell (or runArgv) and the grandchild. */
    middle: () => Number(readFileSync(`${pidFile}.middle`, "utf8")),
  };
}

/**
 * Note: on Windows "dead" here does not mean the process's handles (including
 * its cwd) are closed yet; they can be released a few hundred ms later.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  return !zombieOrReaped(pid);
}

/**
 * Linux: a killed process whose parent already exited is re-parented, and
 * stays a zombie until its new parent reaps it. It is dead (it holds no CPU,
 * memory or fds), but `kill(pid, 0)` still succeeds on it.
 */
function zombieOrReaped(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch (err) {
    // Reaped between the signal probe and the read.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function waitForExit(pid: number, limitMs = 5000): Promise<boolean> {
  const end = Date.now() + limitMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= end) return false;
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Test cleanup: end whatever a failed assertion left running. */
function killIfAlive(...pids: number[]): void {
  for (const pid of pids) {
    if (!(pid > 0) || !alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      // It ended between the probe and the kill.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
}

describe("runShell", () => {
  it("returns exit code and output of a command that finishes", async () => {
    const r = await runShell(`${node} -e "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"`, { cwd: tmpdir(), timeoutMs: 20000 });
    expect(r).toEqual({ code: 3, stdout: "out", stderr: "err", timedOut: false });
  });

  it("kills the whole process tree on timeout, not just the shell", async () => {
    const f = forkingFixture();
    const r = await runShell(f.command, { cwd: f.dir, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("kills the whole process tree on abort", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runShell(f.command, { cwd: f.dir, timeoutMs: 20000, signal: controller.signal });
    setTimeout(() => controller.abort(), 1500);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("never starts a command whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runShell(`${node} -e "process.stdout.write('ran')"`, { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("");
  });
});

const isWin = process.platform === "win32";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "omr-exec-"));
  dirs.push(dir);
  return dir;
}

/** OS scheduling priority of a live process: Windows base priority (normal = 8) or POSIX niceness. */
function priorityOf(pid: number): number {
  if (isWin) {
    // Windows PowerShell 5.1 is always installed; pwsh 7 is not (QA-1.2-11).
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').Priority`], { timeout: 30000, windowsHide: true }).toString().trim());
  }
  return Number(execFileSync("ps", ["-o", "ni=", "-p", String(pid)]).toString().trim());
}

async function waitForFile(path: string, limitMs = 5000): Promise<void> {
  for (let i = 0; i < limitMs / 50; i++) {
    try {
      readFileSync(path, "utf8");
      return;
    } catch {
await new Promise(done => setTimeout(done, 50));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function overflowWarnings() {
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);
  process.on("warning", onWarning);
  return {
    stop: () => {
      process.off("warning", onWarning);
      return warnings.filter(w => w.name === "TimeoutOverflowWarning");
    },
  };
}

describe("runArgv", () => {
  it("kills the whole process tree on timeout", async () => {
    const f = forkingFixture();
    const r = await runArgv(process.execPath, [f.script, f.pidFile], { cwd: f.dir, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("kills the whole process tree on abort", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runArgv(process.execPath, [f.script, f.pidFile], { cwd: f.dir, timeoutMs: 20000, signal: controller.signal });
    setTimeout(() => controller.abort(), 1500);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("passes argv byte-for-byte, with no shell interpretation", async () => {
    const dir = scratch();
    const echo = join(dir, "echo args.cjs");
    writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const args = ["path with spaces", "\"double\" 'single'", "a&b|c>d", "$(whoami) `id`", "%PATH%", "ünïcödé ✓ 日本", "", "trailing\\"];
    const r = await runArgv(process.execPath, [echo, ...args], { cwd: dir, timeoutMs: 20000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(args);
  }, 20000);

  it("merges env over process.env instead of replacing it", async () => {
    const r = await runArgv(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ x: process.env.OMR_EXEC_X, path: Boolean(process.env.PATH || process.env.Path) }))"], {
      cwd: tmpdir(), timeoutMs: 20000, env: { OMR_EXEC_X: "yes" },
    });
    expect(JSON.parse(r.stdout)).toEqual({ x: "yes", path: true });
  }, 20000);

  it.runIf(isWin)("lets an env override win whatever the case of the inherited key (Windows-only: its environment names are case-insensitive)", async () => {
    const probe = "const keys = Object.keys(process.env).map(k => k.toUpperCase());"
      + "process.stdout.write(JSON.stringify({ path: process.env.PATH, temp: process.env.TEMP, paths: keys.filter(k => k === 'PATH').length, temps: keys.filter(k => k === 'TEMP').length }))";
    const r = await runArgv(process.execPath, ["-e", probe], { cwd: tmpdir(), timeoutMs: 20000, env: { path: "OMR-X", Temp: "C:\\omr-temp-override" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ path: "OMR-X", temp: "C:\\omr-temp-override", paths: 1, temps: 1 });
  }, 20000);

  it("caps output at exactly maxBuffer and marks the truncation on stderr", async () => {
    const r = await runArgv(process.execPath, ["-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024)); process.stderr.write('y'.repeat(3000))"], { cwd: tmpdir(), timeoutMs: 20000, maxBuffer: 1000 });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("x".repeat(1000));
    expect(r.stderr).toBe(`${"y".repeat(1000)}\n[stdout truncated at 1000 chars]\n[stderr truncated at 1000 chars]\n`);
  }, 20000);

  it("never splits a surrogate pair at the maxBuffer cut", async () => {
    const r = await runArgv(process.execPath, ["-e", "process.stdout.write('a' + '\\ud83d\\ude00'.repeat(10))"], { cwd: tmpdir(), timeoutMs: 20000, maxBuffer: 4 });
    expect(r.stdout).toBe("a\u{1F600}");
    expect(r.stderr).toBe("[stdout truncated at 4 chars]\n");
  }, 20000);

  it("decodes multi-byte UTF-8 characters split across pipe chunks (QA-1.2-8)", async () => {
    const unit = "a\u00e9\u65e5\u672c\u{1F600}";
    const script = "const u = 'a\\u00e9\\u65e5\\u672c\\ud83d\\ude00'.repeat(200000); process.stdout.write(u); process.stderr.write(u);";
    const r = await runArgv(process.execPath, ["-e", script], { cwd: tmpdir(), timeoutMs: 30000 });
    const expected = unit.repeat(200000);
    expect(r.code).toBe(0);
    expect(r.stdout.includes("\uFFFD") || r.stderr.includes("\uFFFD")).toBe(false);
    expect(r.stdout === expected && r.stderr === expected).toBe(true);
  }, 30000);

  it.each([false, true])("resolves a spawn error as code 1 with the error in stderr, never rejecting (lowPriority %s)", async (lowPriority) => {
    const r = await runArgv("omr-no-such-executable-xyz", ["a"], { cwd: tmpdir(), timeoutMs: 20000, lowPriority });
    expect(r.code).toBe(1);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toMatch(/ENOENT/);
  }, 20000);

  it.runIf(!isWin)("reports nice's exec failures (127, 126) as spawn errors and passes '--' before the target (POSIX-only: nice wraps the target only on POSIX)", async () => {
    // A name starting with "-" would be read as a nice option without `--`.
    for (const file of ["omr-no-such-executable-xyz", "-omr-dash-leading-name"]) {
      const r = await runArgv(file, ["a"], { cwd: tmpdir(), timeoutMs: 20000, lowPriority: true });
      expect(r).toMatchObject({ code: 1, stdout: "", timedOut: false });
      expect(r.stderr).toMatch(new RegExp(`^exec failed: spawn ${file} ENOENT \\(nice: `));
    }
    const dir = scratch();
    const notExecutable = join(dir, "not-executable");
    writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const low = await runArgv(notExecutable, [], { cwd: dir, timeoutMs: 20000, lowPriority: true });
    expect(low).toMatchObject({ code: 1, timedOut: false });
    expect(low.stderr).toMatch(/^exec failed: spawn .* EACCES \(nice: /);
    const direct = await runArgv(notExecutable, [], { cwd: dir, timeoutMs: 20000 });
    expect(direct).toMatchObject({ code: 1, timedOut: false });
    expect(direct.stderr).toMatch(/EACCES/);
    // runShell keeps shell semantics: a missing command is the shell's 127 either way.
    const shellMissing = await runShell("omr-no-such-executable-xyz", { cwd: dir, timeoutMs: 20000, lowPriority: true });
    expect(shellMissing.code).toBe(127);
    expect((await runShell("omr-no-such-executable-xyz", { cwd: dir, timeoutMs: 20000 })).code).toBe(127);
  }, 30000);

  it.runIf(isWin)("refuses a batch file before spawning anything, so cmd.exe never re-parses an argument (QA-1.2-17, Windows-only: batch files)", async () => {
    const dir = scratch();
    const marker = join(dir, "ran");
    const batch = `@echo off\r\necho ran> "${marker}"\r\necho probe-ran\r\n`;
    writeFileSync(join(dir, "probe.cmd"), batch);
    writeFileSync(join(dir, "probe.bat"), batch);
    // Every spelling CreateProcess hands to cmd.exe: any case, the trailing dots
    // and spaces Windows strips (Bun ran `probe.cmd  ` and `probe.cmd.`), and a
    // name relative to cwd.
    const files = ["probe.cmd", "PROBE.CMD", "probe.bat", "probe.Bat", "probe.cmd.", "probe.cmd  ", "probe.bat. ."].map(n => join(dir, n));
    for (const file of [...files, "probe.cmd"]) {
      for (const lowPriority of [false, true]) {
        const r = await runArgv(file, ['"&echo INJECTED&"'], { cwd: dir, timeoutMs: 20000, lowPriority });
        // The refusal's own text: a Node spawn would have failed with a bare
        // `spawn EINVAL`, and Bun would have run cmd.exe (and `echo INJECTED`).
        expect(r).toEqual({ code: 1, stdout: "", stderr: "exec failed: Error: spawn EINVAL (batch files must run through runShell)", timedOut: false });
      }
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("never starts when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runArgv(process.execPath, ["-e", "process.stdout.write('ran')"], { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal });
    expect(r).toEqual({ code: 1, stdout: "", stderr: "", timedOut: true });
  });

  it("treats an abort after natural exit as a no-op and leaves no listener behind", async () => {
    const controller = new AbortController();
    const r = await runArgv(process.execPath, ["-e", "process.exit(0)"], { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    expect(r).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false });
  }, 20000);

  it("does not leak abort listeners across many runs sharing one signal", async () => {
    const controller = new AbortController();
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);
    try {
      for (let batch = 0; batch < 3; batch++) {
        await Promise.all(Array.from({ length: 8 }, () => runArgv(process.execPath, ["-e", ""], { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal })));
      }
      await runArgv("omr-no-such-executable-xyz", [], { signal: controller.signal });
    } finally {
      process.off("warning", onWarning);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(warnings.filter(w => w.name === "MaxListenersExceededWarning")).toEqual([]);
  }, 60000);
});

describe("timeoutMs", () => {
  it.each([2 ** 31, Number.MAX_SAFE_INTEGER, Infinity])("lets a command finish normally with timeoutMs %s (no 32-bit timer overflow)", async (timeoutMs) => {
    const warnings = overflowWarnings();
    const r = await runArgv(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 700)"], { cwd: tmpdir(), timeoutMs });
    expect(r).toEqual({ code: 0, stdout: "done", stderr: "", timedOut: false });
    expect(warnings.stop()).toEqual([]);
  }, 20000);

  it("defaults to DEFAULT_TIMEOUT_MS with neither timeoutMs nor signal, and to no deadline with only a signal (QA-1.2-16)", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(deadlineOf({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(deadlineOf({ timeoutMs: Number.NaN })).toBe(DEFAULT_TIMEOUT_MS);
    const signal = new AbortController().signal;
    expect(deadlineOf({ signal })).toBeUndefined();
    expect(deadlineOf({ signal, timeoutMs: 500 })).toBe(500);
  });

  it("arms a DEFAULT_TIMEOUT_MS timer for a run with neither timeoutMs nor signal (QA-1.2-16)", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const r = await runArgv(process.execPath, ["-e", "process.stdout.write('ok')"], { cwd: tmpdir() });
      expect(r).toEqual({ code: 0, stdout: "ok", stderr: "", timedOut: false });
      expect(spy.mock.calls.some(([, ms]) => ms === DEFAULT_TIMEOUT_MS)).toBe(true);
      spy.mockClear();
      await runArgv(process.execPath, ["-e", ""], { cwd: tmpdir(), signal: new AbortController().signal });
      expect(spy.mock.calls.some(([, ms]) => ms === DEFAULT_TIMEOUT_MS)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 20000);

  it("treats timeoutMs <= 0 as already expired", async () => {
    const start = Date.now();
    const r = await runArgv(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { cwd: tmpdir(), timeoutMs: -5 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(10000);
  }, 20000);
});

const TREE = fileURLToPath(new URL("../fixtures/exec/tree.cjs", import.meta.url));
const HOST = fileURLToPath(new URL("../fixtures/exec/host.mjs", import.meta.url));
/** host.mjs imports src/verify/exec.ts directly, which needs Node's type stripping (22.18+, 23.6+). */
const typeStripping = Boolean(process.features.typescript);

/** Run test/fixtures/exec/host.mjs in its own node process. */
function startHost(args: string[]) {
  const child = spawn(process.execPath, [HOST, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  /** The first stdout line and when it arrived; "" when the host ended without one. */
  const firstLine = new Promise<{ line: string; at: number }>((resolve) => {
    child.stdout.on("data", (s: string) => {
      stdout += s;
      const end = stdout.indexOf("\n");
      if (end >= 0) resolve({ line: stdout.slice(0, end), at: Date.now() });
    });
    child.on("close", () => resolve({ line: "", at: Date.now() }));
  });
  child.stderr.on("data", (s: string) => { stderr += s; });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string; at: number }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr, at: Date.now() }));
  });
  return {
    firstLine,
    exited,
    stderr: () => stderr,
    /** Cleanup: end the host if a failed assertion left it running. */
    kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); },
  };
}

/** A test/fixtures/exec/tree.cjs run: argv for runArgv plus its PID files. */
function tree(mode: "early-exit" | "unreachable" | "broken-tree") {
  const dir = scratch();
  const file = (name: string) => join(dir, `${name}.pid`);
  return {
    dir,
    args: [TREE, mode, dir],
    file,
    pid: (name: "child" | "middle" | "holder") => Number(readFileSync(file(name), "utf8")),
    /** How the holder ended on its own ("released" or "timeout"); undefined while alive or when killed. */
    holderExit: (): string | undefined => (existsSync(join(dir, "holder.exit")) ? readFileSync(join(dir, "holder.exit"), "utf8") : undefined),
    /**
     * The direct child is gone and the run has seen its `exit`. The OS reports
     * the death before libuv delivers `exit` (up to a loop iteration later);
     * an abort in that gap still counts as ending a running command.
     */
    async childExited(): Promise<boolean> {
      const gone = await waitForExit(Number(readFileSync(file("child"), "utf8")));
      await new Promise(r => setTimeout(r, 300));
      return gone;
    },
    /** Let the holder end on its own (it polls for the file), then make sure it did. */
    async release(): Promise<void> {
      writeFileSync(join(dir, "release"), "");
      if (!existsSync(file("holder"))) return;
      const holder = Number(readFileSync(file("holder"), "utf8"));
      if (!(await waitForExit(holder))) process.kill(holder);
    },
  };
}

/**
 * The note of a run whose deadline or abort ended what the exited child left
 * running. Windows: the sweep's own note, or, when the sweep is slower than the
 * kill grace, the grace's force-close note or the still-reporting note
 * (QA-1.2-24, QA-1.2-26).
 */
const LEFTOVER_KILLED = /left running by the exited command|output streams force-closed \d+ ms after the kill: a descendant still held them|orphan sweep still reporting at settle/;

/**
 * G4's documented load limit (QA-1.2-14): under normal-priority CPU saturation
 * the Windows sweep can miss the 3 s. The first sweep of a CI job is the worst
 * case: on the 4-core runner, with the suite's workers and V8 coverage,
 * PowerShell took 6.6 s to start and its first CIM query 23.7 s, so the holder
 * died 28.7 s after the deadline (phase 3.1, CI round 3). Called only once the
 * holder outlived the 3 s, and it tolerates that only with the limit's
 * signature:
 * - Windows (POSIX has no sweeper, so no slack there);
 * - the grace, not a sweep report, settled the run: the pipes were force-closed,
 *   and the sweep had not reported that it could not run;
 * - the holder still dies within the sweep's own bound (SWEEP_TIMEOUT_MS after
 *   the kill, plus 2 s), before the fixture's 90 s self-exit; the caller then
 *   checks that it was killed, not ended on its own.
 */
async function expectLateSweep(holder: number, killAt: number, r: { stderr: string }): Promise<void> {
  expect(isWin, r.stderr).toBe(true);
  expect(r.stderr).toMatch(/output streams force-closed \d+ ms after the kill: a descendant still held them/);
  expect(r.stderr).not.toMatch(/orphan sweep unavailable/);
  const dead = await waitForExit(holder, Math.max(0, killAt + SWEEP_TIMEOUT_MS + 2000 - Date.now()));
  console.warn(`[G4 load limit, QA-1.2-14] holder not dead 3 s after the kill; ${dead ? `dead ${Date.now() - killAt} ms after it` : "still alive"}; stderr: ${r.stderr.trim()}`);
  expect(dead).toBe(true);
}

describe("process lifecycle around the direct child's exit", () => {
  // The holder inherits the run's stdout/stderr, so `close` cannot fire while it lives.

  it("a deadline after the direct child exited kills what it left running within 3 s (QA-1.2-1, G4)", async () => {
    const t = tree("early-exit");
    const start = Date.now();
    try {
      const r = await runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 3000 });
      const settledIn = Date.now() - start;
      const deadlineAt = start + 3000;
      const holder = t.pid("holder");
      // G4: dead within 3 s of the deadline. The run may settle first, when the
      // grace (2 s) ends before a slow sweep has reported (QA-1.2-26).
      if (!(await waitForExit(holder, Math.max(0, deadlineAt + 3000 - Date.now())))) await expectLateSweep(holder, deadlineAt, r);
      // Killed, not ended on its own: the holder records its own exits.
      expect(t.holderExit()).toBeUndefined();
      expect(settledIn).toBeLessThan(3000 + 3000);
      // The direct child exited 0, but the deadline had to end its leftovers.
      expect(r).toMatchObject({ code: 1, timedOut: true });
      expect(r.stderr).toMatch(LEFTOVER_KILLED);
    } finally {
      await t.release();
    }
  }, SWEEP_TIMEOUT_MS + 30_000);

  it("an abort between the child's exit and the pipes closing kills the leftovers, not the exited PID (QA-1.2-1, QA-1.2-10)", async () => {
    const t = tree("early-exit");
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30000, signal: controller.signal });
    try {
      await waitForFile(t.file("holder"));
      expect(await t.childExited()).toBe(true);
      const holder = t.pid("holder");
      expect(alive(holder)).toBe(true);
      const abortedAt = Date.now();
      controller.abort();
      const r = await pending;
      const settledIn = Date.now() - abortedAt;
      // G4: dead within 3 s of the abort, not necessarily when the run settles (QA-1.2-26).
      if (!(await waitForExit(holder, Math.max(0, abortedAt + 3000 - Date.now())))) await expectLateSweep(holder, abortedAt, r);
      // Killed, not ended on its own: the holder records its own exits.
      expect(t.holderExit()).toBeUndefined();
      expect(settledIn).toBeLessThan(3000);
      expect(r).toMatchObject({ code: 1, timedOut: true });
      expect(r.stderr).toMatch(LEFTOVER_KILLED);
    } finally {
      await t.release();
      await pending;
    }
  }, SWEEP_TIMEOUT_MS + 30_000);

  it.runIf(isWin).each([
    ["a missing executable", join(tmpdir(), "omr-no-such-powershell.exe"), /\[orphan sweep unavailable: spawn error: [^\]]*ENOENT[^\]]*\]/],
    ["one that exits non-zero before the marker", process.execPath, /\[orphan sweep unavailable: exit \d+\]/],
  ])("reports an orphan sweep that could not run: %s (QA-1.2-15, Windows-only: the sweeper is PowerShell)", async (_name, file, note) => {
    setSweeperExecutableForTests(file);
    const t = tree("early-exit");
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30000, signal: controller.signal });
    try {
      await waitForFile(t.file("holder"));
      expect(await t.childExited()).toBe(true);
      controller.abort();
      const r = await pending;
      expect(r.timedOut).toBe(true);
      expect(r.stderr).toMatch(note);
      // Nothing was swept, so the grace period force-closed the pipes.
      expect(r.stderr).toMatch(/output streams force-closed/);
    } finally {
      setSweeperExecutableForTests(undefined);
      await t.release();
      await pending;
    }
  }, 30000);

  it("an abort after the child exited is a no-op when nothing it started is reachable (QA-1.2-10)", async () => {
    const t = tree("unreachable");
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30000, signal: controller.signal });
    try {
      await waitForFile(t.file("holder"));
      expect(await t.childExited()).toBe(true);
      controller.abort();
      // The pipe holder now ends on its own, well inside the kill grace period.
      writeFileSync(join(t.dir, "release"), "");
      const r = await pending;
      expect(r).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false });
    } finally {
      await t.release();
      await pending;
    }
  }, 30000);

  it("resolves one grace period after the kill when an unreachable descendant still holds the pipes (QA-1.2-2)", async () => {
    const t = tree("broken-tree");
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30000, signal: controller.signal });
    try {
      await waitForFile(t.file("holder"));
      // Its parent is gone, so neither taskkill /T nor the process group reaches it.
      expect(await waitForExit(t.pid("middle"))).toBe(true);
      const abortedAt = Date.now();
      controller.abort();
      const r = await pending;
      const elapsed = Date.now() - abortedAt;
      expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE_MS - 100);
      expect(elapsed).toBeLessThan(KILL_GRACE_MS + 2000);
      expect(r.timedOut).toBe(true);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/output streams force-closed \d+ ms after the kill: a descendant still held them/);
      // Windows can report a killed process alive for a moment after the kill (see alive()).
      const child = t.pid("child");
      for (const until = Date.now() + 3000; alive(child) && Date.now() < until;) await new Promise(r => setTimeout(r, 50));
      expect(alive(child)).toBe(false);
      // Documented residual: a descendant whose parent died cannot be attributed safely.
      expect(alive(t.pid("holder"))).toBe(true);
    } finally {
      await t.release();
      await pending;
    }
  }, 30000);

  it("kills the trees of runs in flight from a single process 'exit' hook (QA-1.2-6 POSIX process groups, QA-1.2-18 Windows direct children)", async () => {
    const f = forkingFixture();
    // Windows: through cmd.exe, whose children libuv's kill-on-close job does not hold.
    const pending = isWin
      ? runShell(f.command, { cwd: f.dir, timeoutMs: 30000 })
      : runArgv(process.execPath, [f.script, f.pidFile], { cwd: f.dir, timeoutMs: 30000 });
    try {
      await waitForFile(f.pidFile);
      await Promise.all([1, 2, 3].map(() => runArgv(process.execPath, ["-e", ""], { cwd: tmpdir(), timeoutMs: 20000 })));
      const hooks = process.listeners("exit").filter(l => l.name === "killTrackedProcesses");
      expect(hooks).toHaveLength(1);
      // What runs when opencode exits mid-run.
      hooks[0](0);
      const r = await pending;
      expect(r.code).not.toBe(0);
      expect(await waitForExit(f.grandchild())).toBe(true);
      expect(await waitForExit(f.middle())).toBe(true);
      expect(process.listeners("exit").filter(l => l.name === "killTrackedProcesses")).toHaveLength(1);
    } finally {
      if (existsSync(f.pidFile)) killIfAlive(f.grandchild(), f.middle());
      await pending;
    }
  }, 30000);

  it.runIf(isWin && typeStripping)("a host that exits mid-run takes the run's whole tree with it within 3 s (QA-1.2-18, Windows-only: POSIX is the hook test above; needs Node type stripping)", async () => {
    const f = forkingFixture();
    const h = startHost(["exit-mid-run", f.pidFile, f.command]);
    try {
      expect(await h.exited).toMatchObject({ code: 0, stdout: "ready\n" });
      const exitedAt = Date.now();
      // Without the hook, libuv's job ends only cmd.exe: its node child and grandchild keep running.
      expect(await waitForExit(f.middle(), 3000)).toBe(true);
      expect(await waitForExit(f.grandchild(), Math.max(0, exitedAt + 3000 - Date.now()))).toBe(true);
    } finally {
      h.kill();
      if (existsSync(f.pidFile)) killIfAlive(f.grandchild(), f.middle());
    }
  }, 30000);

  it.runIf(isWin && typeStripping)("a sweep still in flight when the run settles does not keep the host alive (QA-1.2-19, Windows-only: the sweeper; needs Node type stripping)", async () => {
    const t = tree("early-exit");
    const h = startHost(["hung-sweeper", t.dir]);
    let standIn = 0;
    try {
      const first = await h.firstLine;
      expect(first.line, h.stderr()).not.toBe("");
      const out = JSON.parse(first.line) as { result: { timedOut: boolean; stderr: string }; sweeper: number | null };
      standIn = out.sweeper ?? 0;
      expect(standIn).toBeGreaterThan(0);
      // The hung sweep killed nothing, so the kill grace settled the run.
      expect(out.result.timedOut).toBe(true);
      expect(out.result.stderr).toMatch(/output streams force-closed/);
      const exited = await h.exited;
      expect(exited.code).toBe(0);
      // Before QA-1.2-19 the host stayed up until SWEEP_TIMEOUT_MS (30 s then) ended the sweeper.
      expect(exited.at - first.at).toBeLessThan(5000);
      // Nor did the sweeper outlive the host: a direct child, it dies with libuv's job.
      expect(await waitForExit(standIn, 3000)).toBe(true);
    } finally {
      h.kill();
      killIfAlive(standIn);
      await t.release();
    }
  }, 60000);

  it.runIf(isWin && typeStripping)("counts a sweep that pinned trees and reports after the grace as a kill (QA-1.2-24, Windows-only: the sweeper; needs Node type stripping)", async () => {
    const t = tree("early-exit");
    const h = startHost(["late-sweeper", t.dir]);
    let standIn = 0;
    try {
      const first = await h.firstLine;
      expect(first.line, h.stderr()).not.toBe("");
      const out = JSON.parse(first.line) as { result: { code: number; timedOut: boolean; stderr: string }; sweeper: number | null };
      standIn = out.sweeper ?? 0;
      expect(standIn).toBeGreaterThan(0);
      // The stand-in's kill closed the pipes, so nothing was force-closed; its
      // report came after the grace settled the run.
      expect(out.result).toMatchObject({ code: 1, timedOut: true });
      expect(out.result.stderr).toMatch(/\[orphan sweep still reporting at settle: it may have ended what held the pipes\]/);
      expect(out.result.stderr).not.toMatch(/output streams force-closed/);
      expect(alive(t.pid("holder"))).toBe(false);
      expect((await h.exited).code).toBe(0);
    } finally {
      h.kill();
      killIfAlive(standIn);
      await t.release();
    }
  }, 60000);

  it.runIf(isWin && typeStripping)("leaves the natural result when a sweep that pinned nothing is still pending at the grace (QA-1.2-29, Windows-only: the sweeper; needs Node type stripping)", async () => {
    const t = tree("early-exit");
    const h = startHost(["unpinned-sweeper", t.dir]);
    let standIn = 0;
    try {
      const first = await h.firstLine;
      expect(first.line, h.stderr()).not.toBe("");
      const out = JSON.parse(first.line) as { result: { code: number; timedOut: boolean; stderr: string }; sweeper: number | null; settledIn: number };
      standIn = out.sweeper ?? 0;
      expect(standIn).toBeGreaterThan(0);
      // The holder ended on its own right after the abort; the stand-in never
      // printed `pinned`, so it cannot have killed anything (QA-1.2-10).
      expect(out.result).toMatchObject({ code: 0, stderr: "", timedOut: false });
      // Settling at the grace proves the sweep was still pending there, so the
      // pinned-count condition is what kept the natural result.
      expect(out.settledIn).toBeGreaterThanOrEqual(KILL_GRACE_MS - 50);
      expect((await h.exited).code).toBe(0);
    } finally {
      h.kill();
      killIfAlive(standIn);
      await t.release();
    }
  }, 60000);
});

describe("tracked-process bookkeeping (QA-1.2-23)", () => {
  it("only lets the run that owns an entry untrack it, so a recycled id stays tracked", () => {
    const { track, untrack, isTracked } = trackingForTests;
    const pid = 2_000_000_123;
    const oldRun = Symbol("old");
    const newRun = Symbol("new");
    track(pid, oldRun);
    untrack(pid, oldRun);
    track(pid, newRun);
    untrack(pid, oldRun);
    expect(isTracked(pid)).toBe(true);
    untrack(pid, newRun);
    expect(isTracked(pid)).toBe(false);
  });

  it("stops an old run's late kill once a new run took its recycled id (QA-1.2-27)", () => {
    const { track, untrack, ownsTracked } = trackingForTests;
    const pid = 2_000_000_125;
    const oldRun = Symbol("old");
    const newRun = Symbol("new");
    // The old run's child exited with its group still alive: it stays tracked.
    track(pid, oldRun);
    expect(ownsTracked(pid, oldRun)).toBe(true);
    // The group emptied and a new run's group took the id.
    track(pid, newRun);
    // The old run's deadline or abort must not signal the new run's group.
    expect(ownsTracked(pid, oldRun)).toBe(false);
    expect(ownsTracked(pid, newRun)).toBe(true);
    untrack(pid, newRun);
    expect(ownsTracked(pid, newRun)).toBe(false);
  });

  it.runIf(!isWin)("a late kill skips a process group whose entry another run now owns (QA-1.2-27, POSIX-only: process groups)", async () => {
    const { track, untrack } = trackingForTests;
    const t = tree("early-exit");
    const controller = new AbortController();
    const pending = runArgv(process.execPath, t.args, { cwd: tmpdir(), timeoutMs: 30000, signal: controller.signal });
    const recycler = Symbol("recycler");
    let child = 0;
    try {
      await waitForFile(t.file("holder"));
      expect(await t.childExited()).toBe(true);
      child = t.pid("child");
      const holder = t.pid("holder");
      // Stand-in for a new run whose group took the id: it overwrites the entry.
      track(child, recycler);
      controller.abort();
      const r = await pending;
      expect(r.stderr).not.toMatch(/killed the process group/);
      expect(alive(holder)).toBe(true);
    } finally {
      untrack(child, recycler);
      await t.release();
      await pending;
    }
  }, 30000);
});

describe("lowPriority", () => {
  // Windows: BELOW_NORMAL base priority is 6 (normal 8). POSIX: `nice -n 10`.
  const lowered = (p: number) => (isWin ? p <= 6 : p >= 10);

  it("runs grandchildren of runArgv below normal priority", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runArgv(process.execPath, [f.script, f.pidFile], { cwd: f.dir, timeoutMs: 30000, lowPriority: true, signal: controller.signal });
    try {
      // Below-normal fixtures start late under normal-priority load (QA-1.2-22).
      await waitForFile(f.pidFile, 30_000);
      expect(lowered(priorityOf(f.grandchild()))).toBe(true);
    } finally {
      controller.abort();
      await pending;
    }
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 90_000);

  it("runs grandchildren of runShell below normal priority", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runShell(f.command, { cwd: f.dir, timeoutMs: 30000, lowPriority: true, signal: controller.signal });
    try {
      // Below-normal fixtures start late under normal-priority load (QA-1.2-22).
      await waitForFile(f.pidFile, 30_000);
      expect(lowered(priorityOf(f.grandchild()))).toBe(true);
    } finally {
      controller.abort();
      await pending;
    }
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 90_000);

  it.each([0, 3])("keeps exit code %i through the priority wrapper", async (code) => {
    const script = `process.exit(${code})`;
    expect((await runArgv(process.execPath, ["-e", script], { cwd: tmpdir(), timeoutMs: 60_000, lowPriority: true })).code).toBe(code);
    expect((await runShell(`${node} -e "${script}"`, { cwd: tmpdir(), timeoutMs: 60_000, lowPriority: true })).code).toBe(code);
  }, 130_000);

  it.runIf(isWin)("keeps the exit code of a .cmd target run through runShell (Windows-only: .cmd is a Windows batch file)", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "t.cmd"), `@echo off\r\n${node} -e "process.exit(3)"\r\nexit /b %ERRORLEVEL%\r\n`);
    const r = await runShell(`"${join(dir, "t.cmd")}"`, { cwd: dir, timeoutMs: 60_000, lowPriority: true });
    expect(r.code).toBe(3);
    const ok = await runShell("npm.cmd --version", { cwd: dir, timeoutMs: 60000, lowPriority: true });
    expect(ok.code).toBe(0);
  }, 130_000);
});
