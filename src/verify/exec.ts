/**
 * The single process layer for verification: every command runs through
 * `runShell` (a shell string) or `runArgv` (argv, no shell), which share one
 * implementation of the deadline, abort, output cap and tree kill.
 *
 * `child_process.exec` with `timeout` (or `signal`) only signals the shell it
 * spawned. Test commands are process trees — `cmd /c npm test` -> npm -> vitest
 * -> one worker per core — so killing the shell orphans everything below it,
 * and the "aborted" baseline keeps every core busy until the suite finishes on
 * its own. On a timeout or abort this kills the whole tree instead: `taskkill
 * /T` on Windows, the process group on POSIX.
 *
 * Lifecycle guarantees (G4, docs/qa/verification-resource-budget/phase-1.2.md):
 * - The promise always resolves, never rejects, and settles at most
 *   KILL_GRACE_MS after a kill even when a descendant that escaped the kill
 *   still holds the output pipes (they are then force-closed).
 * - A deadline or abort that arrives after the direct child exited still
 *   reaches what it left running (POSIX: its process group; Windows: a
 *   creation-time-bounded sweep of its children, see `armSweeper`), without
 *   ever signalling a PID that may have been recycled.
 * - `timedOut` is true when the deadline or abort fired while something still
 *   held the run (the command, a descendant it left running, or the held
 *   pipes), so a kill was attempted. A case that cannot be told apart counts as
 *   a kill (fail-closed): on Windows, the grace settling the run while a sweep
 *   that pinned trees is still reporting, even if the leftover exited on its
 *   own during the grace (QA-1.2-24, QA-1.2-28). An abort that finds nothing
 *   left running is a no-op: the natural result stands.
 * - POSIX: when a run settles, whatever the command left in its process group
 *   (a background job, an unref'd child) is killed, so a normal exit leaves
 *   nothing running outside the slot either (QA-G-5). A `setsid` escapee is
 *   not reached. Windows sweeps only for a deadline or abort (the sweep costs a
 *   PowerShell start per run), so there a normal exit's leftovers survive
 *   (a documented limit, docs/VERIFICATION.md "Process limits").
 * - Runs still in flight when opencode exits are killed from one
 *   `process.once("exit")` hook: on POSIX their process groups (QA-1.2-6), on
 *   Windows the tree of each direct child that has not exited (QA-1.2-18).
 *   libuv's kill-on-close job does not do this on Windows: its job allows
 *   silent breakaway, so it holds only the processes libuv spawned itself. It
 *   ends the direct child (cmd.exe) but not the tree below it (npm, vitest).
 *   Not covered: death by an unhandled signal (the host's SIGTERM/SIGHUP/Ctrl-C
 *   policy), which skips `exit` hooks and remains opencode's concern, and on
 *   Windows what an already-exited direct child left running (only the sweep
 *   reaches that).
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants as osConstants, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotEnv } from "../executor/slots/env";
import type { ArgvSeam, ExecOptions, ExecSeam } from "./types";

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * True when the deadline or the abort signal fired while something still
   * held the run and a kill was attempted. Fail-closed: a leftover that exited
   * on its own during the kill grace, while a sweep that pinned trees was still
   * reporting, also counts (see the header's G4 bullet).
   */
  timedOut: boolean;
}

export interface RunOptions extends ExecOptions {
  /**
   * Deadline in ms. Callers must bound every run with `timeoutMs` or `signal`;
   * when both are absent the run gets DEFAULT_TIMEOUT_MS (120 s, the same
   * default as `DeterministicDeps.timeoutMs`). `Infinity` explicitly means no
   * deadline, `NaN` counts as absent, values <= 0 expire at once, and values
   * above the 2^31-1 ms timer limit (~24.8 days) are clamped to it.
   */
  timeoutMs?: number;
  /**
   * Per-stream cap in characters (UTF-16 code units). Output past it is
   * dropped and a `[stdout truncated at <n> chars]` line is appended to stderr.
   * Default 10 MB.
   */
  maxBuffer?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
/** After a kill, the longest the result waits for the output pipes to close. */
export const KILL_GRACE_MS = 2000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
/** Windows: pipes still open this long after the child exited arm the orphan sweeper. */
const SWEEP_ARM_MS = 200;
/**
 * Windows: the most the sweeper's kill phase may take before it is abandoned.
 * It only bounds a hung sweeper: by then the kill grace has already settled the
 * run, so a late kill costs the run nothing, while a short limit turned a slow
 * sweep under normal-priority CPU saturation into no kill at all (QA-1.2-14).
 * On a saturated 4-core CI runner, the first sweep of the job (a cold
 * PowerShell start and the first CIM query) killed 28.7 s after the kill was
 * requested, 1.3 s inside the former 30 s limit (phase 3.1, CI round 3).
 * Exported for tests.
 */
export const SWEEP_TIMEOUT_MS = 60_000;
/** Windows: the most `taskkill /T` on a live direct child may take. */
const TASKKILL_TIMEOUT_MS = 5000;
/**
 * Windows: the most the exit hook's single `taskkill /T` may delay opencode's
 * exit, and only when a verification is in flight: with none, the hook spawns
 * nothing, and an idle taskkill takes well under a second. Under normal-priority
 * CPU saturation taskkill took up to 3.4 s, and a 2 s limit left part of a tree
 * running (QA-1.2-21); this is the last chance to reach those trees. A load that
 * slows taskkill past this limit can still leave part of a tree (a G4 known limit).
 */
const EXIT_TASKKILL_TIMEOUT_MS = 10_000;
/** Printed by the sweeper once pinning is done; its absence means the sweep did not run. */
const SWEEP_MARKER = "pinned";
/** Windows: clock tolerance between Date.now() and the kernel's creation times. */
const SWEEP_CLOCK_SLACK_MS = 50;

const isWin = process.platform === "win32";
/**
 * Windows tools by absolute path: a bare name is looked up in the working
 * directory before PATH (libuv), and that directory is the user's project.
 */
const SYSTEM32 = process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : undefined;
const TASKKILL = SYSTEM32 ? join(SYSTEM32, "taskkill.exe") : "taskkill.exe";
const DEFAULT_POWERSHELL = SYSTEM32 ? join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";

/** Run `command` through the platform shell (`cmd.exe` / `/bin/sh`). */
export function runShell(command: string, opts: RunOptions = {}): Promise<ShellResult> {
  // POSIX low priority: `nice -n 10 -- /bin/sh -c <command>` is exactly what
  // `shell: true` would spawn, just prefixed, so the command string keeps its
  // shell semantics and is never re-quoted. niceness is inherited by every
  // descendant from birth, so there is no startup race on POSIX.
  if (opts.lowPriority && !isWin) return run("nice", ["-n", "10", "--", "/bin/sh", "-c", command], false, opts);
  return run(command, [], true, opts);
}

/**
 * Windows: a batch file name, in any case and with the trailing dots and
 * spaces that Windows strips from a file name.
 */
const BATCH_FILE = /\.(cmd|bat)[. ]*$/i;
/** What Node itself returns for a batch file spawned without a shell. */
const BATCH_REFUSED = "exec failed: Error: spawn EINVAL (batch files must run through runShell)";

/**
 * Spawn `file` with `args` and no shell: arguments reach the child
 * byte-for-byte. On Windows a `.cmd`/`.bat` target is refused before anything
 * is spawned, as a spawn error (`code: 1`, `spawn EINVAL` on stderr) — run
 * batch files through `runShell` instead.
 *
 * CreateProcess runs a batch file through cmd.exe, which re-parses the
 * arguments, so `"&calc&"` would run `calc` (BatBadBut, CVE-2024-27980). Node
 * refuses such a spawn with EINVAL; Bun, which opencode loads the plugin in,
 * does not, so the check is made here for both runtimes (QA-1.2-17). A bare
 * name cannot reach a batch file: the runtime resolves it with `.com` and
 * `.exe` only (a bare `probe` beside `probe.cmd` is ENOENT under both), and
 * the argv adapters pass absolute `.js`/`.exe` targets.
 */
export function runArgv(file: string, args: readonly string[], opts: RunOptions = {}): Promise<ShellResult> {
  if (isWin && BATCH_FILE.test(file)) return Promise.resolve({ code: 1, stdout: "", stderr: BATCH_REFUSED, timedOut: false });
  // `--` keeps a target whose name starts with "-" from being read as a nice option.
  if (opts.lowPriority && !isWin) return run("nice", ["-n", "10", "--", file, ...args], false, opts, file);
  return run(file, [...args], false, opts);
}

// Compile-time proof that both entry points satisfy the injection seams.
export const execSeam: ExecSeam = runShell;
export const argvSeam: ArgvSeam = runArgv;

/**
 * @param niceTarget set when `file` is `nice` wrapping this argv target: nice
 *   reports a target it cannot exec as exit 127/126 instead of a spawn error.
 */
function run(file: string, args: string[], shell: boolean, opts: RunOptions, niceTarget?: string): Promise<ShellResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: true });
  const deadline = deadlineOf(opts);
  return new Promise((resolve) => {
    const limit = opts.maxBuffer === undefined || Number.isNaN(opts.maxBuffer) ? DEFAULT_MAX_BUFFER : Math.max(0, opts.maxBuffer);
    const out = capture(limit);
    const err = capture(limit);
    const notes: string[] = [];
    let killRequested = false;
    /** The deadline or abort ended something: the command, a leftover descendant or the pipes. */
    let killed = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitedAt = 0;
    let closed = false;
    let closeCode: number | null = null;
    let settled = false;
    let groupGone = false;
    let sweeper: Sweeper | undefined;
    let swept = false;
    let sweepPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let armTimer: ReturnType<typeof setTimeout> | undefined;
    const spawnedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: mergeEnv(opts.env, opts.cwd),
        shell,
        windowsHide: true,
        // Its own process group on POSIX, so the whole tree can be signalled at once.
        detached: !isWin,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: 1, stdout: "", stderr: `exec failed: ${String(e)}`, timedOut: false });
      return;
    }
    const pid = child.pid;
    if (opts.lowPriority && isWin && pid) {
      // Windows low priority (Spike A, docs/qa/verification-resource-budget/phase-1.2.md):
      // lower the direct child right after spawn; descendants inherit the class
      // when they are created. The `start /BELOWNORMAL` wrapper was rejected
      // because it loses exit codes of `.cmd` targets such as npm.cmd.
      // Startup race: anything the child spawns before this call runs at normal
      // priority. The window is the few microseconds between CreateProcess and
      // this line, before the child has even loaded its runtime, so in practice
      // no grandchild exists yet — but it is not a guarantee.
      try {
        setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch (e) {
        // The child may already have exited; the run itself is unaffected.
        notes.push(`[low priority not applied: ${String(e)}]`);
      }
    }
    // After the priority call, which must follow the spawn as closely as possible.
    const trackToken = Symbol("run");
    if (pid) track(pid, trackToken);
    // A StringDecoder per stream, so a multi-byte character split across two
    // chunks is not turned into U+FFFD.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // Output past the cap is dropped rather than failing the run; the verdict
    // is parsed from the summary lines, which runners print last only when the
    // run completes, so truncation degrades to "unknown output", never a pass.
    child.stdout?.on("data", (s: string) => out.push(s));
    child.stderr?.on("data", (s: string) => err.push(s));

    const finish = (code: number | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(armTimer);
      opts.signal?.removeEventListener("abort", kill);
      // Windows keeps the child tracked until its `exit`: one that outlived
      // the grace is exactly what the exit hook must still end.
      if (!isWin && pid) {
        // QA-G-5: a run that ended normally may have left background members
        // in its group (`cmd &`, an unref'd child). They would keep running
        // outside the slot, so they are ended with the run. The same guards
        // as the late kill: the group was not seen empty and the entry is
        // still ours (QA-1.2-27). A `setsid` escapee is not in the group.
        if (!groupGone && ownsTracked(pid, trackToken) && groupAlive(pid)) signalGroup(pid, "SIGKILL");
        untrack(pid, trackToken);
      }
      // A sweep that is killing must finish, but must not keep opencode alive
      // (QA-1.2-19); one that is only armed is released.
      if (sweeper && sweepPending) sweeper.unref();
      else sweeper?.dispose();
      let finalCode = killed ? code || 1 : code ?? 1;
      let stderr = err.text;
      if (niceTarget && !killed && (code === 126 || code === 127) && stderr.startsWith("nice:")) {
        // The same contract as a direct spawn: code 1 and the errno in stderr.
        stderr = `exec failed: spawn ${niceTarget} ${code === 127 ? "ENOENT" : "EACCES"} (${stderr.trim()})`;
        finalCode = 1;
      }
      if (error) stderr += String(error);
      if (out.truncated) notes.push(`[stdout truncated at ${limit} chars]`);
      if (err.truncated) notes.push(`[stderr truncated at ${limit} chars]`);
      for (const note of notes) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}\n`;
      resolve({ code: finalCode, stdout: out.text, stderr, timedOut: killed });
    };

    const onSwept = (pids: number[], unavailable?: string) => {
      sweepPending = false;
      // Reported only while the run is still pending; after the grace settled
      // it there is no result left to carry the note.
      if (unavailable && !settled) notes.push(`[orphan sweep unavailable: ${unavailable}]`);
      if (pids.length > 0) {
        killed = true;
        notes.push(`[killed ${pids.length} process tree(s) left running by the exited command: pid ${pids.join(", ")}]`);
      }
      if (closed) finish(closeCode);
    };
    /** Windows only: kill what the exited child left running (at most once per run). */
    const sweep = () => {
      if (swept || !pid) return;
      swept = true;
      sweeper ??= armSweeper(pid, spawnedAt, exitedAt);
      sweepPending = true;
      sweeper.kill(onSwept);
    };

    const onGrace = () => {
      if (settled) return;
      if (!closed) {
        // Something that survived the kill still holds the pipes: stop waiting
        // for it so neither the run nor its slot outlives the deadline.
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!exited) child.kill("SIGKILL");
        killed = true;
        const holder = exited ? "a descendant still held them" : "the process did not exit";
        notes.push(`[output streams force-closed ${KILL_GRACE_MS} ms after the kill: ${holder}]`);
      } else if (sweepPending && sweeper && sweeper.pinnedCount() > 0) {
        // The pipes closed while the sweep had not reported yet (QA-1.2-24):
        // with trees pinned, its kill may be what closed them, so the result
        // must not read as a natural exit. A sweep that has pinned nothing
        // cannot have killed anything, and the natural result stands (QA-1.2-10).
        killed = true;
        notes.push("[orphan sweep still reporting at settle: it may have ended what held the pipes]");
      }
      finish(closed ? closeCode : exitCode);
    };

    const kill = () => {
      if (killRequested || settled) return;
      killRequested = true;
      grace = setTimeout(onGrace, KILL_GRACE_MS);
      grace.unref();
      if (!exited) {
        // Also taken when the OS already ended the child but libuv has not
        // delivered `exit` yet: indistinguishable here, so it counts as a kill.
        killed = true;
        killTree(child);
        return;
      }
      // The direct child already exited, so its PID may be recycled: never
      // `taskkill` it. Only what it left running can remain.
      if (isWin) {
        sweep();
      } else if (pid && !groupGone && ownsTracked(pid, trackToken) && signalGroup(pid, "SIGKILL")) {
        // A group id is not reused while any member is alive, and `groupGone`
        // stops us once the group was seen empty. If the group emptied later
        // and a new run's group took the id, that run overwrote our entry, so
        // the ownership check skips its group (QA-1.2-27).
        killed = true;
        notes.push("[killed the process group left running by the exited command]");
      }
    };

    if (deadline !== undefined) timer = setTimeout(kill, deadline);
    opts.signal?.addEventListener("abort", kill, { once: true });

    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      exitedAt = Date.now();
      // Windows: libuv has closed the child's handle, so its PID may be recycled from here on.
      if (isWin && pid) untrack(pid, trackToken);
      if (!isWin && pid && !groupAlive(pid)) {
        groupGone = true;
        untrack(pid, trackToken);
      }
      if (isWin && pid) {
        // Pipes still open shortly after exit mean a descendant holds them.
        // Arm the sweeper now (pinning its candidates) so a later deadline or
        // abort does not pay PowerShell's startup inside the G4 window; a kill
        // that raced the exit (taskkill found no process) is completed here too.
        armTimer = setTimeout(() => {
          if (closed || settled) return;
          if (killRequested) sweep();
          else sweeper ??= armSweeper(pid, spawnedAt, exitedAt);
        }, SWEEP_ARM_MS);
      }
    });
    child.on("error", (e) => finish(1, e));
    child.on("close", (code) => {
      closed = true;
      closeCode = code;
      clearTimeout(armTimer);
      // A sweep in flight decides whether the kill ended anything.
      if (sweepPending) return;
      finish(code);
    });
  });
}

/** The timer to arm, or undefined for none. Exported for tests. */
export function deadlineOf(opts: RunOptions): number | undefined {
  const t = opts.timeoutMs;
  if (t === undefined || Number.isNaN(t)) return opts.signal ? undefined : DEFAULT_TIMEOUT_MS;
  if (t === Infinity) return undefined;
  // setTimeout treats anything above 2^31-1 as 1 ms, which would kill at once.
  return Math.min(Math.max(t, 0), MAX_TIMER_MS);
}

interface SlotEnvHook {
  slotEnvFor(cwd: string, platform: NodeJS.Platform): SlotEnv | null;
  applySlotEnv(env: NodeJS.ProcessEnv, s: SlotEnv | null, platform: NodeJS.Platform): NodeJS.ProcessEnv;
}

/**
 * The slot-environment functions executor/slots/env.ts publishes when it loads. This file
 * is also loaded alone by Node's type stripping (no module resolution beyond node:
 * built-ins), so it reads the hook from globalThis instead of importing the module. Absent
 * (v1, or no executor loaded), nothing changes.
 */
function slotEnvHook(): SlotEnvHook | null {
  const hook: unknown = Reflect.get(globalThis, Symbol.for("omr.executor.slotEnvHook"));
  if (typeof hook !== "object" || hook === null) return null;
  const find: unknown = Reflect.get(hook, "slotEnvFor");
  const apply: unknown = Reflect.get(hook, "applySlotEnv");
  return typeof find === "function" && typeof apply === "function" ? (hook as SlotEnvHook) : null;
}

/**
 * Overrides merged over process.env. Windows environment names are
 * case-insensitive and Node keeps only one of two keys that differ in case
 * (the first in sort order, not the override), so an inherited key that
 * matches an override case-insensitively is dropped first.
 */
function mergeEnv(overrides: Record<string, string> | undefined, cwd?: string): NodeJS.ProcessEnv {
  const hook = cwd === undefined ? null : slotEnvHook();
  const slot = hook === null || cwd === undefined ? null : hook.slotEnvFor(cwd, process.platform);
  if (!slot && !overrides) return process.env;
  const env: NodeJS.ProcessEnv = slot && hook ? hook.applySlotEnv({ ...process.env }, slot, process.platform) : { ...process.env };
  if (!overrides) return env;
  for (const [key, value] of Object.entries(overrides)) {
    if (isWin) {
      const upper = key.toUpperCase();
      for (const existing of Object.keys(env)) if (existing.toUpperCase() === upper) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

interface Capture {
  text: string;
  truncated: boolean;
  push(s: string): void;
}

function capture(limit: number): Capture {
  const c: Capture = {
    text: "",
    truncated: false,
    push(s) {
      if (c.truncated) return;
      const room = limit - c.text.length;
      if (s.length <= room) {
        c.text += s;
        return;
      }
      let cut = Math.max(room, 0);
      // Do not keep half of a surrogate pair.
      const last = s.charCodeAt(cut - 1);
      if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut--;
      c.text += s.slice(0, cut);
      c.truncated = true;
    },
  };
  return c;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    // The spawn failed and its `error` (which settles the run) is still to be
    // emitted on a later tick. Node throws EINVAL for a kill of a process that
    // never started; it must not escape the abort listener or the timer.
    try {
      child.kill("SIGKILL");
    } catch {
      // Nothing is running; the pending `error` settles the run.
    }
    return;
  }
  if (isWin) {
    execFile(TASKKILL, ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, (err) => {
      // taskkill fails when the child exited meanwhile; the direct kill is then
      // a no-op and the exit handler sweeps what it left running.
      if (err) child.kill();
    });
    return;
  }
  // No group (already reaped or never detached): fall back to the direct child.
  if (!signalGroup(pid, "SIGKILL")) child.kill("SIGKILL");
}

// Runs still in flight are killed when opencode exits.
// - POSIX (QA-1.2-6): the process group of each run. Detached children lead
//   their own group and session, so a terminal hang-up or Ctrl-C that ends
//   opencode never reaches them.
// - Windows (QA-1.2-18): the tree of each direct child that has not exited.
//   libuv's kill-on-close job ends the direct child only. Until the child's
//   `exit`, libuv holds its process handle, so its PID cannot be recycled.
// Each entry is owned by the run that tracked it (QA-1.2-23): POSIX untracks a
// group both at `exit` and at settle, and its id may be recycled in between by
// a new run's group. That run overwrites the entry, and the old run's second
// untrack must not delete it, so only the owner's token deletes an entry.
// The same token keeps a run's late kill off a recycled id taken by another
// run of this process (QA-1.2-27). Not fixable without pidfd: if a group
// empties after `exit` and its id is recycled by an unrelated group (not one
// of our runs), the late kill or this hook can signal that group (it needs a
// `setsid` escapee holding the pipes plus PID wrap-around).
const tracked = new Map<number, symbol>();
let exitHookInstalled = false;

function track(pid: number, token: symbol): void {
  tracked.set(pid, token);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killTrackedProcesses);
}

function untrack(pid: number, token: symbol): void {
  if (ownsTracked(pid, token)) tracked.delete(pid);
}

/** The entry for `pid` is still the one `token`'s run tracked. */
function ownsTracked(pid: number, token: symbol): boolean {
  return tracked.get(pid) === token;
}

/** The tracking helpers, for unit tests only (QA-1.2-23, QA-1.2-27). */
export const trackingForTests = {
  track,
  untrack,
  ownsTracked,
  isTracked: (pid: number): boolean => tracked.has(pid),
};

/** The `exit` hook: synchronous, as `exit` listeners must be. */
function killTrackedProcesses(): void {
  const pids = [...tracked.keys()];
  tracked.clear();
  if (!isWin) {
    for (const pgid of pids) signalGroup(pgid, "SIGKILL");
    return;
  }
  if (pids.length === 0) return;
  // One taskkill for every tree, so the hook delays opencode's exit by at most
  // EXIT_TASKKILL_TIMEOUT_MS however many runs are in flight. A tree that is
  // already gone only makes taskkill report it as not found.
  spawnSync(TASKKILL, [...pids.flatMap((pid) => ["/pid", String(pid)]), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: EXIT_TASKKILL_TIMEOUT_MS,
  });
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Sweeper {
  /**
   * Kill the pinned trees; `done` receives the root PIDs taskkill ended and,
   * when the sweep could not run, why. Never throws.
   */
  kill(done: (pids: number[], unavailable?: string) => void): void;
  /** How many trees the sweeper reported pinned; 0 until its marker arrives. */
  pinnedCount(): number;
  /** Release the pins without killing anything. */
  dispose(): void;
  /**
   * The run settled while the kill is in flight: let the sweeper finish, but
   * stop it (its process handle and pipes) from keeping opencode alive.
   */
  unref(): void;
}

/** Node's child pipes are `net.Socket`s with `unref`; another runtime's may lack it. */
function unrefStream(stream: object | null): void {
  if (stream && "unref" in stream && typeof stream.unref === "function") stream.unref();
}

let powershell = DEFAULT_POWERSHELL;

/** Test-only: run the sweeper with another executable; undefined restores the default. */
export function setSweeperExecutableForTests(file: string | undefined): void {
  powershell = file ?? DEFAULT_POWERSHELL;
}

/**
 * Windows: find and kill what an exited child left running, without ever
 * targeting a recycled PID (QA-1.2-1). `taskkill /T` on the dead PID finds
 * nothing, and a recycled PID must never be targeted, so the processes are
 * found by their creation time instead:
 *
 * 1. Roots are processes whose ParentProcessId is the child's PID and whose
 *    creation time lies in [spawnedAt, exitedAt] (± clock slack). The child's
 *    PID stays bound to the child until libuv closes its handle, just before
 *    `exit` is emitted, so a process with that parent created in the window
 *    was created by the child; the children of a later owner of the PID are
 *    created after `exitedAt` and are excluded.
 * 2. Each root is pinned by an open handle and its start time re-checked, so
 *    its own PID cannot be recycled between the query and the kill.
 * 3. On `kill`, each live root is ended with `taskkill /T /F` (its tree). A
 *    pinned root that exited meanwhile is swept the same way, using its exact
 *    lifetime as the window.
 *
 * Descendants whose parent died before being pinned (a detached grandchild of
 * a short-lived middle process) cannot be attributed safely; the kill grace
 * period bounds the run in that case.
 *
 * The sweeper is Windows PowerShell 5.1 (always installed; pwsh 7 is not, and
 * wmic is gone from current Windows 11) at normal priority, spawned directly —
 * not through `run` — with its own kill timeout; every failure degrades to
 * "nothing killed". The script is passed with single quotes only, so Node's
 * argument quoting cannot alter it.
 *
 * It needs PowerShell in FullLanguage mode: under Constrained Language Mode
 * (AppLocker/WDAC) the .NET calls it relies on fail, so it exits 3 at once.
 * After pinning it prints `pinned <n>`. When a kill was requested and that
 * marker is missing (spawn error, non-zero exit, no marker, or the
 * SWEEP_TIMEOUT_MS limit), `kill` reports why, and the run appends
 * `[orphan sweep unavailable: <reason>]` to stderr if it has not settled yet
 * (QA-1.2-15). A failure after the run settled has no result to report to.
 */
function armSweeper(pid: number, spawnedAt: number, exitedAt: number): Sweeper {
  const from = Math.floor(spawnedAt - SWEEP_CLOCK_SLACK_MS);
  const to = Math.ceil(exitedAt + SWEEP_CLOCK_SLACK_MS);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 3 }",
    "function Ms($d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() }",
    "function Pin($ppid, $from, $to) { foreach ($c in @(Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId=' + $ppid))) { try { $t = Ms $c.CreationDate; if ($t -ge $from -and $t -le $to) { $p = [Diagnostics.Process]::GetProcessById([int]$c.ProcessId); $null = $p.Handle; $s = Ms $p.StartTime; if ($s -ge $from -and $s -le $to) { $p } } } catch { $null = $_ } } }",
    "function Stop-Trees($roots) { foreach ($p in $roots) { if (-not $p.HasExited) { & taskkill.exe /pid $p.Id /T /F *> $null; if ($LASTEXITCODE -eq 0) { [Console]::Out.WriteLine([string]$p.Id) } } else { Stop-Trees @(Pin $p.Id (Ms $p.StartTime) (Ms $p.ExitTime)) } } }",
    `$roots = @(Pin ${pid} ${from} ${to})`,
    `[Console]::Out.WriteLine('${SWEEP_MARKER} ' + $roots.Count)`,
    "if ($roots.Count -eq 0) { exit 0 }",
    "if ([Console]::In.ReadLine() -eq 'kill') { Stop-Trees $roots }",
  ].join("; ");
  let output = "";
  let ended = false;
  /** Why the sweep could not run, once known. */
  let failure: string | undefined;
  const waiters: Array<() => void> = [];
  const end = () => {
    if (ended) return;
    ended = true;
    for (const w of waiters.splice(0)) w();
  };
  const lines = () => output.split(/\r?\n/);
  const killedPids = () => lines().filter((l) => /^\d+$/.test(l)).map(Number);
  const pinned = () => lines().some((l) => l.startsWith(`${SWEEP_MARKER} `));
  const pinnedCount = () => {
    const marker = lines().find((l) => l.startsWith(`${SWEEP_MARKER} `));
    const n = marker === undefined ? 0 : Number(marker.slice(SWEEP_MARKER.length + 1));
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  /** Undefined when the sweep ran; otherwise the reason it did not. */
  const unavailable = () => failure ?? (pinned() ? undefined : "no marker");
  let ps: ChildProcess | undefined;
  try {
    ps = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      // QA-G-9: not the host's cwd (the user's project). PowerShell writes its
      // module analysis cache relative to its cwd when LocalAppData is missing.
      cwd: tmpdir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    ps.stdout?.setEncoding("utf8");
    ps.stdout?.on("data", (s: string) => { output += s; });
    // EPIPE: the sweeper exited before reading (it found nothing to pin).
    ps.stdin?.on("error", end);
    ps.on("error", (e) => {
      failure ??= `spawn error: ${e.message}`;
      end();
    });
    ps.on("close", (code, signal) => {
      if (code !== 0 && !pinned()) failure ??= code === null ? `killed by ${signal}` : `exit ${code}`;
      end();
    });
  } catch (e) {
    failure = `spawn error: ${String(e)}`;
    ps = undefined;
    end();
  }
  return {
    kill(done) {
      let called = false;
      let limit: ReturnType<typeof setTimeout> | undefined;
      const report = () => {
        if (called) return;
        called = true;
        clearTimeout(limit);
        done(killedPids(), unavailable());
      };
      if (ended || !ps) {
        report();
        return;
      }
      const sweeperProcess = ps;
      waiters.push(report);
      limit = setTimeout(() => {
        if (!pinned()) failure ??= `timed out after ${SWEEP_TIMEOUT_MS} ms`;
        sweeperProcess.kill();
        report();
      }, SWEEP_TIMEOUT_MS);
      // With `unref()` below, a hung sweeper never keeps opencode alive after
      // the run settled (QA-1.2-19). Being a direct child, it sits in libuv's
      // kill-on-close job and dies with opencode.
      limit.unref();
      // Written, not ended: ending a Windows pipe makes libuv flush it
      // (FlushFileBuffers), which blocks until the sweeper reads, and that
      // pending shutdown would keep opencode alive however much is unref'd
      // (QA-1.2-19). The sweeper's exit closes the pipe.
      sweeperProcess.stdin?.write("kill\n");
    },
    pinnedCount,
    dispose() {
      if (ended || !ps) return;
      ps.stdin?.end();
      ps.kill();
    },
    unref() {
      if (ended || !ps) return;
      ps.unref();
      unrefStream(ps.stdin);
      unrefStream(ps.stdout);
    },
  };
}
