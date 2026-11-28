/**
 * A machine-wide process sampler for the Phase 3.1 e2e suite.
 *
 * One long-lived helper process takes a snapshot of every process on the machine each interval
 * and writes it to stdout as one line; the test process parses them. A single long-lived sampler
 * (rather than one `ps`/CIM query per tick) keeps the sampler's own cost, and its own pid, stable.
 *
 * - win32: `powershell.exe` looping over `Get-CimInstance Win32_Process`, one compact JSON line
 *   per snapshot. `Priority` is the base priority: 6 is below normal, 8 normal.
 * - POSIX: `sh -c` looping over `ps -eo pid=,ppid=,ni=,args=`, framed by a timestamp line and a
 *   separator. `nice >= 10` counts as low priority. On Linux each frame also carries every
 *   `/proc/<pid>/stat` line, for the processes' start ticks (parsePosixFrame).
 *
 * The pure helpers below (descendantsOf, peak, seen, priorityViolations) work on the snapshots.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

export interface ProcSample {
  pid: number;
  ppid: number;
  lowPriority: boolean | undefined;
  priority: number | undefined /* win32 base priority or POSIX nice */;
  args: string;
  createdMs?: number;
  /**
   * Linux: the start time from `/proc/<pid>/stat` (field 22, clock ticks since boot). It only
   * orders processes (which fork came first, #175) and is never compared with wall-clock times:
   * converting it needs the boot time, which /proc/stat gives in whole seconds.
   */
  startTicks?: number;
}

export interface Snapshot {
  t: number /* Date.now() */;
  procs: ProcSample[];
}

export interface Sampler {
  stop(): Promise<Snapshot[]>;
  /** Snapshots collected so far. */
  count(): number;
  pid: number /* sampler process pid */;
}

/** Windows base priority at or below this is "below normal" (6); normal is 8. */
const WIN_LOW_PRIORITY_MAX = 6;
/** POSIX nice at or above this is low priority. */
const POSIX_LOW_NICE_MIN = 10;
const STOP_WAIT_MS = 3000;

/**
 * QA-3.1-5: the median snapshot interval a test may accept. The plan's 100 ms is reachable on
 * POSIX (`ps`; CI 107-112 ms, the sleep adds to the query) but not on win32: one Get-CimInstance
 * Win32_Process query costs ~250 ms on an idle 16-core Windows 11 host with ~550 processes (10
 * queries measured: 250 ms full, 240 ms with a `ProcessId=` WQL filter, 244 ms without
 * CommandLine), so a WQL filter does not buy rate, and a `Name`/`CreationDate` filter would also
 * drop parent-chain processes (cmd.exe, uv, python, git, the long-lived test process) and orphans
 * started before the sampler. Under 20 parallel dispatches the median measured 291-429 ms. This is
 * the documented deviation: a worker that lives shorter than one interval can be missed, so counts
 * are lower bounds (lifetimePeak narrows that), and the zero-runner checks also rely on the
 * runner probes (fixture-repo.ts installRunnerProbe), which do not sample.
 */
export const SAMPLER_MEDIAN_INTERVAL_MAX_MS = process.platform === "win32" ? 500 : 250;

/**
 * The real profile and temp dirs, captured when this module loads (before any plugin instance
 * points HOME/USERPROFILE at a fake home or a test redirects TEMP). With USERPROFILE at a fake home,
 * powershell.exe's Get-CimInstance loop emits no snapshot at all (measured: 0 snapshots in 6 s).
 */
const REAL_PROFILE_ENV: Record<string, string> = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.userInfo().homedir;
  const tmp = process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  return {
    USERPROFILE: process.env.USERPROFILE ?? home,
    HOME: process.env.HOME ?? home,
    APPDATA: process.env.APPDATA ?? join(home, "AppData", "Roaming"),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
    TEMP: tmp,
    TMP: process.env.TMP ?? tmp,
  };
})();

/** process.env with the profile/temp keys restored to their values at module load. */
function samplerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...REAL_PROFILE_ENV };
}

function windowsScript(intervalMs: number): string {
  // The stdin read is started once and polled: a raw-stream ReadAsync never blocks the loop
  // (Console.In.ReadLineAsync would: .NET Framework's synchronized reader runs it synchronously),
  // and a closed stdin (the test process died) completes it too, so the sampler cannot outlive
  // its parent.
  return [
    "$ErrorActionPreference = 'Continue'",
    `$iv = ${intervalMs}`,
    "$sin = [Console]::OpenStandardInput()",
    "$buf = New-Object byte[] 1",
    "$rd = $sin.ReadAsync($buf, 0, 1)",
    "while ($true) {",
    "  if ($rd.IsCompleted) { break }",
    "  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Priority,CommandLine,CreationDate | ForEach-Object {",
    "    $c = $null",
    "    if ($_.CreationDate -ne $null) { $c = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }",
    "    [pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; r = $_.Priority; c = $c; a = [string]$_.CommandLine }",
    "  })",
    "  $json = ConvertTo-Json -Compress -Depth 2 -InputObject $rows",
    "  [Console]::Out.WriteLine('{\"t\":' + $t + ',\"procs\":' + $json + '}')",
    "  [Console]::Out.Flush()",
    "  $el = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t",
    "  if ($el -lt $iv) { Start-Sleep -Milliseconds ($iv - $el) }",
    "}",
  ].join("\n");
}

function posixScript(intervalMs: number): string {
  const secs = (intervalMs / 1000).toFixed(3);
  // Linux: also every process's /proc/<pid>/stat (start ticks, parseProcStat). A process gone
  // between the glob and the read is skipped (cat's error is discarded); without /proc, no section.
  const stat = `if [ -r /proc/self/stat ]; then echo "@@STAT"; cat /proc/[0-9]*/stat 2>/dev/null; fi`;
  return `while :; do echo "@@T"; ps -eo pid=,ppid=,ni=,args=; ${stat}; echo "@@END"; sleep ${secs}; done`;
}

interface WinRow {
  p: number;
  q: number;
  r: number | null;
  c: number | null;
  a: string | null;
}

function parseWinLine(line: string): Snapshot | undefined {
  const raw = JSON.parse(line) as { t: number; procs: WinRow[] | WinRow | null };
  const rows = raw.procs === null ? [] : Array.isArray(raw.procs) ? raw.procs : [raw.procs];
  return {
    t: raw.t,
    procs: rows.map(r => {
      const priority = typeof r.r === "number" ? r.r : undefined;
      const sample: ProcSample = {
        pid: r.p,
        ppid: r.q,
        priority,
        lowPriority: priority === undefined ? undefined : priority <= WIN_LOW_PRIORITY_MAX,
        args: r.a ?? "",
      };
      if (typeof r.c === "number") sample.createdMs = r.c;
      return sample;
    }),
  };
}

function parsePsLine(line: string): ProcSample | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
  if (m === null) return undefined;
  const nice = /^-?\d+$/.test(m[3]) ? Number(m[3]) : undefined;
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    priority: nice,
    lowPriority: nice === undefined ? undefined : nice >= POSIX_LOW_NICE_MIN,
    args: m[4] ?? "",
  };
}

/**
 * One `/proc/<pid>/stat` line, `pid (comm) state ppid ...`: the pid and field 22, the start time
 * in clock ticks since boot. comm may hold spaces and parentheses, so the fields after it are
 * counted from the last `)`. undefined for a line that is not one.
 */
export function parseProcStat(line: string): { pid: number; startTicks: number } | undefined {
  const head = /^(\d+) \(/.exec(line);
  const close = line.lastIndexOf(")");
  if (head === null || close < head[0].length) return undefined;
  // The fields after comm start at field 3, so field 22 is the 20th of them.
  const start = line.slice(close + 1).trim().split(/\s+/)[22 - 3];
  if (start === undefined || !/^\d+$/.test(start)) return undefined;
  return { pid: Number(head[1]), startTicks: Number(start) };
}

/**
 * One POSIX snapshot from the lines between `@@T` and `@@END`: the `ps` rows, then on Linux
 * `@@STAT` and one /proc/<pid>/stat line per process, whose start ticks go to the ps row of the
 * same pid. A process that exited between `ps` and the /proc read has no start ticks.
 */
export function parsePosixFrame(t: number, lines: readonly string[]): Snapshot {
  const procs: ProcSample[] = [];
  const ticks = new Map<number, number>();
  let inStat = false;
  for (const line of lines) {
    if (line === "@@STAT") {
      inStat = true;
    } else if (inStat) {
      const s = parseProcStat(line);
      if (s !== undefined) ticks.set(s.pid, s.startTicks);
    } else {
      const p = parsePsLine(line);
      if (p !== undefined) procs.push(p);
    }
  }
  for (const p of procs) {
    const startTicks = ticks.get(p.pid);
    if (startTicks !== undefined) p.startTicks = startTicks;
  }
  return { t, procs };
}

export function startSampler(opts?: {
  intervalMs?: number /* default 100 */;
  /** The sampler child's environment; default: process.env with the real profile/temp dirs (see REAL_PROFILE_ENV). */
  env?: NodeJS.ProcessEnv;
}): Sampler {
  const intervalMs = Math.max(1, Math.floor(opts?.intervalMs ?? 100));
  const env = opts?.env ?? samplerEnv();
  const isWin = process.platform === "win32";
  const snapshots: Snapshot[] = [];
  let parseErrors = 0;
  let buffer = "";
  let posixCurrent: { t: number; lines: string[] } | undefined;

  let child: ChildProcess;
  if (isWin) {
    const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // -EncodedCommand rather than -Command: the script carries double quotes, which Windows argv
    // quoting would otherwise mangle on the way into powershell.exe.
    const encoded = Buffer.from(windowsScript(intervalMs), "utf16le").toString("base64");
    child = spawn(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
  } else {
    child = spawn("sh", ["-c", posixScript(intervalMs)], { stdio: ["pipe", "pipe", "pipe"], env });
  }

  const onLine = (line: string): void => {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") return;
    if (isWin) {
      try {
        const snap = parseWinLine(trimmed);
        if (snap !== undefined) snapshots.push(snap);
      } catch (error) {
        parseErrors++;
        if (parseErrors === 1) process.stderr.write(`[sampler] unparsable line: ${String(error)}\n`);
      }
      return;
    }
    if (trimmed === "@@T") {
      posixCurrent = { t: Date.now(), lines: [] };
    } else if (trimmed === "@@END") {
      if (posixCurrent !== undefined) snapshots.push(parsePosixFrame(posixCurrent.t, posixCurrent.lines));
      posixCurrent = undefined;
    } else if (posixCurrent !== undefined) {
      posixCurrent.lines.push(trimmed);
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  });
  // Drain stderr so the pipe never fills; the sampler's diagnostics are not the test's concern.
  child.stderr?.resume();
  // A dead sampler (or a stdin write after it exited) must not crash the test process.
  child.on("error", (error: Error) => process.stderr.write(`[sampler] process error: ${error.message}\n`));
  child.stdin?.on("error", (error: Error) => process.stderr.write(`[sampler] stdin error: ${error.message}\n`));

  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitPromise = new Promise<void>(resolve => {
    if (exited) resolve();
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  });

  let stopping: Promise<Snapshot[]> | undefined;
  const stop = (): Promise<Snapshot[]> => {
    stopping ??= (async () => {
      try {
        if (!exited) {
          if (isWin && child.stdin?.writable === true) child.stdin.end("stop\n");
          else child.kill();
          const timer = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), STOP_WAIT_MS).unref());
          if ((await Promise.race([exitPromise.then(() => "exit" as const), timer])) === "timeout") {
            child.kill();
            await Promise.race([exitPromise, new Promise<void>(resolve => setTimeout(resolve, STOP_WAIT_MS).unref())]);
          }
        }
        if (buffer !== "") {
          onLine(buffer);
          buffer = "";
        }
      } catch (error) {
        process.stderr.write(`[sampler] stop failed; returning what was collected: ${String(error)}\n`);
      }
      return snapshots.slice();
    })();
    return stopping;
  };

  return { stop, count: () => snapshots.length, pid: child.pid ?? -1 };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Whether `child`, whose ppid names `parent`'s pid, is really `parent`'s child. Windows never
 * reparents: a process whose parent exited keeps the dead parent's pid as its ppid, and once that
 * pid is reused by a newer process the stale ppid points at an unrelated one. A process cannot be
 * created before its parent, so a child older than the process holding its ppid is not its child
 * (CI round 1: the CI job's own `npx` -> `cmd` -> `vitest` chain showed up as descendants of the
 * test process once a short-lived plugin child reused the pid of npx's exited parent). Without
 * creation times (POSIX samples, where orphans are reparented) the ppid is taken as is.
 */
export function isChildOf(child: ProcSample, parent: ProcSample | undefined): boolean {
  if (parent === undefined || child.createdMs === undefined || parent.createdMs === undefined) return true;
  return child.createdMs >= parent.createdMs;
}

/** Every transitive descendant of rootPid within one snapshot (via ppid), minus excludePids and their subtrees. */
export function descendantsOf(snapshot: Snapshot, rootPid: number, excludePids: number[]): ProcSample[] {
  const exclude = new Set(excludePids);
  const byPid = new Map<number, ProcSample>();
  const byParent = new Map<number, ProcSample[]>();
  for (const p of snapshot.procs) {
    byPid.set(p.pid, p);
    const list = byParent.get(p.ppid);
    if (list === undefined) byParent.set(p.ppid, [p]);
    else list.push(p);
  }
  const out: ProcSample[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of byParent.get(parent) ?? []) {
      // pid reuse can make a ppid chain cyclic; visit each pid once.
      if (visited.has(child.pid) || exclude.has(child.pid)) continue;
      // ... and on Windows a stale ppid can name a newer, unrelated process.
      if (!isChildOf(child, byPid.get(parent))) continue;
      visited.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** rootPid's own ancestors in one snapshot (parent first), following ppid while isChildOf holds. */
export function ancestorsOf(snapshot: Snapshot, rootPid: number): ProcSample[] {
  const byPid = new Map(snapshot.procs.map(p => [p.pid, p] as const));
  const out: ProcSample[] = [];
  const visited = new Set<number>([rootPid]);
  let current = byPid.get(rootPid);
  while (current !== undefined) {
    const parent = byPid.get(current.ppid);
    if (parent === undefined || visited.has(parent.pid) || !isChildOf(current, parent)) break;
    visited.add(parent.pid);
    out.push(parent);
    current = parent;
  }
  return out;
}

/** The largest number of matching descendants seen in any single snapshot. */
export function peak(snapshots: Snapshot[], rootPid: number, exclude: number[], predicate: (p: ProcSample) => boolean): number {
  let max = 0;
  for (const s of snapshots) max = Math.max(max, descendantsOf(s, rootPid, exclude).filter(predicate).length);
  return max;
}

/** Matching descendants, distinct by pid, as first sighted. */
export function seen(snapshots: Snapshot[], rootPid: number, exclude: number[], predicate: (p: ProcSample) => boolean): ProcSample[] {
  const first = new Map<number, ProcSample>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!first.has(p.pid) && predicate(p)) first.set(p.pid, p);
    }
  }
  return [...first.values()];
}

/**
 * Matching descendants observed at normal-or-higher priority (lowPriority === false) in a snapshot
 * taken more than graceMs after their first sighting. Windows applies setPriority just after spawn,
 * so a process may legitimately be sampled at normal priority in that window (a documented race).
 */
export function priorityViolations(
  snapshots: Snapshot[],
  rootPid: number,
  exclude: number[],
  predicate: (p: ProcSample) => boolean,
  graceMs = 250,
): ProcSample[] {
  const firstAt = new Map<number, number>();
  const violations = new Map<number, ProcSample>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!predicate(p)) continue;
      const first = firstAt.get(p.pid);
      if (first === undefined) {
        firstAt.set(p.pid, s.t);
        continue;
      }
      if (p.lowPriority === false && s.t - first > graceMs && !violations.has(p.pid)) violations.set(p.pid, p);
    }
  }
  return [...violations.values()];
}

export interface WorkerCensus {
  snapshot: Snapshot;
  workers: ProcSample[];
  /** Finished forks still exiting, excused from `running` (see workerCensus). */
  retiring: Set<number>;
  running: number;
  /** First and last sighting per process, keyed by workerKey (pid reuse on Windows keeps two lives apart). */
  sightings: Map<string, { first: number; last: number }>;
}

/** A process identity across snapshots: the pid, plus the creation time where it is known. */
export function workerKey(p: ProcSample): string {
  return `${p.pid}@${p.createdMs ?? "?"}`;
}

/**
 * Per snapshot: the matching workers alive under rootPid, and how many of them are running a test
 * file. vitest 4 starts a finished fork's termination and forks the next file's worker without
 * awaiting it ("Runner terminations are started but not awaited until the end of full run",
 * vitest/dist/chunks/cli-api.*.js), so a sampler can see a run's `perRunCap` running forks plus
 * finished ones still exiting (CI round 1: 3 workers against a bound of 2).
 *
 * Only that excess is excused. Under one parent main with more than `perRunCap` workers alive,
 * up to (alive - perRunCap) of them retire, oldest first, and only workers that are (a) in their
 * last sighting, never the final snapshot's, since a worker seen again later was not exiting, and
 * (b) replaced: older than a sibling under the same main (by creation time on win32, start ticks
 * on Linux, else first sighting), or seen in this snapshot only while the same main has a worker
 * in the next one, whose pool went on without it (#175: without an order, a fork and its
 * successor born within one interval are first seen together and tie). A fork with no successor
 * was not replaced. A main never counts fewer than min(alive, perRunCap) running workers, so two
 * runs at once still add up.
 */
export function workerCensus(
  snapshots: Snapshot[],
  rootPid: number,
  exclude: number[],
  isWorker: (p: ProcSample) => boolean,
  perRunCap: number,
): WorkerCensus[] {
  const sightings = new Map<string, { first: number; last: number }>();
  /** Start ticks per life, from any snapshot that has them (a process gone before the /proc read has none there). */
  const ticks = new Map<string, number>();
  const perSnapshot = snapshots.map(s => ({ snapshot: s, workers: descendantsOf(s, rootPid, exclude).filter(isWorker) }));
  for (const { snapshot, workers } of perSnapshot) {
    for (const w of workers) {
      const key = workerKey(w);
      const x = sightings.get(key);
      if (x === undefined) sightings.set(key, { first: snapshot.t, last: snapshot.t });
      else x.last = snapshot.t;
      if (w.startTicks !== undefined && !ticks.has(key)) ticks.set(key, w.startTicks);
    }
  }
  const firstSeen = (p: ProcSample): number => sightings.get(workerKey(p))?.first ?? 0;
  /** Creation order, < 0 when `a` is older: creation times (win32), else start ticks (Linux), else first sightings. */
  const order = (a: ProcSample, b: ProcSample): number => {
    if (a.createdMs !== undefined && b.createdMs !== undefined) return a.createdMs - b.createdMs;
    const ta = ticks.get(workerKey(a));
    const tb = ticks.get(workerKey(b));
    if (ta !== undefined && tb !== undefined) return ta - tb;
    return firstSeen(a) - firstSeen(b);
  };
  const final = snapshots[snapshots.length - 1];
  return perSnapshot.map(({ snapshot, workers }, i) => {
    const retiring = new Set<number>();
    const byMain = new Map<number, ProcSample[]>();
    for (const w of workers) byMain.set(w.ppid, [...(byMain.get(w.ppid) ?? []), w]);
    const next = perSnapshot[i + 1]?.workers ?? [];
    for (const [main, siblings] of byMain) {
      const excess = siblings.length - perRunCap;
      if (excess <= 0 || snapshot === final) continue;
      const mainGoesOn = next.some(o => o.ppid === main);
      siblings
        .filter(w => sightings.get(workerKey(w))?.last === snapshot.t)
        .filter(w => siblings.some(o => o.pid !== w.pid && order(o, w) > 0) || (firstSeen(w) === snapshot.t && mainGoesOn))
        .sort(order)
        .slice(0, excess)
        .forEach(w => retiring.add(w.pid));
    }
    return { snapshot, workers, retiring, running: workers.length - retiring.size, sightings };
  });
}

/** Case-insensitive on win32 (paths there are), case-sensitive elsewhere. */
function foldCase(s: string): string {
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Every spelling of `dir` a command line may carry: raw and realpath (an 8.3 short os.tmpdir()
 * vs its long form), each with `\` and with `/` separators, case-folded on win32 (QA-3.1-4).
 */
export function pathSpellings(dir: string): string[] {
  const forms = [dir];
  try {
    forms.push(realpathSync.native(dir));
  } catch (e) {
    // A dir that does not exist (yet) has only its raw spelling.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const out = new Set<string>();
  for (const f of forms) {
    out.add(foldCase(f.replace(/\//g, "\\")));
    out.add(foldCase(f.replace(/\\/g, "/")));
  }
  return [...out];
}

/** Whether `text` mentions any of `spellings` (pathSpellings), compared as-is and with separators unified to `/`. */
export function mentionsAny(text: string, spellings: readonly string[]): boolean {
  const raw = foldCase(text);
  const slashed = raw.replace(/\\/g, "/");
  return spellings.some(s => raw.includes(s) || slashed.includes(s.replace(/\\/g, "/")));
}

/** Matching processes anywhere on the machine (not only descendants), distinct by workerKey, as first sighted. */
export function seenAnywhere(snapshots: Snapshot[], exclude: number[], predicate: (p: ProcSample) => boolean): ProcSample[] {
  const skip = new Set(exclude);
  const first = new Map<string, ProcSample>();
  for (const s of snapshots) {
    for (const p of s.procs) {
      if (!skip.has(p.pid) && !first.has(workerKey(p)) && predicate(p)) first.set(workerKey(p), p);
    }
  }
  return [...first.values()];
}

/** The gaps between consecutive snapshots, in ms (QA-3.1-5: the sampler's real rate). */
export function snapshotIntervals(snapshots: Snapshot[]): number[] {
  return snapshots.slice(1).map((s, i) => s.t - snapshots[i].t);
}

/** The median of `values` (NaN when empty). */
export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * QA-3.1-5: the largest number of matching descendants alive at once, from each process's
 * lifetime rather than per-snapshot counts. A lifetime runs from its creation time (win32; POSIX
 * samples have none, so the first sighting) to its last sighting. Two processes sighted in
 * different snapshots still overlap when one was created before the other was last seen, which a
 * per-snapshot count misses when the sampler's interval is longer than a short worker's life. It
 * is still a lower bound for a process created and gone between two snapshots.
 */
export function lifetimePeak(snapshots: Snapshot[], rootPid: number, exclude: number[], predicate: (p: ProcSample) => boolean): number {
  const lives = new Map<string, { start: number; end: number }>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!predicate(p)) continue;
      const k = workerKey(p);
      const x = lives.get(k);
      if (x === undefined) lives.set(k, { start: Math.min(p.createdMs ?? s.t, s.t), end: s.t });
      else x.end = s.t;
    }
  }
  const events = [...lives.values()].flatMap(l => [
    { t: l.start, d: 1 },
    { t: l.end, d: -1 },
  ]);
  // Starts before ends at the same instant: both were alive then.
  events.sort((a, b) => a.t - b.t || b.d - a.d);
  let alive = 0;
  let max = 0;
  for (const e of events) {
    alive += e.d;
    max = Math.max(max, alive);
  }
  return max;
}

/** The largest number of running workers (workerCensus) in any snapshot. */
export function peakRunning(
  snapshots: Snapshot[],
  rootPid: number,
  exclude: number[],
  isWorker: (p: ProcSample) => boolean,
  perRunCap: number,
): number {
  return Math.max(0, ...workerCensus(snapshots, rootPid, exclude, isWorker, perRunCap).map(c => c.running));
}