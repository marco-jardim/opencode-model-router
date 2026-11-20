/** Windows process-tree tracking and kill shared by the smoke hosts (`tui-pty.ts` since QA P21-1, `routing-host.ts` since #95).
 *
 * No `taskkill /T`: with pid reuse, `/T` walks parent pids and can end processes that are not ours. A process belongs to a
 * tree only if it descends from the spawned root AND was created after the spawn and after its parent (Win32_Process
 * CreationDate), and is not in the baseline taken before the spawn (pid + creation time). {@link stopTree} kills children
 * first, then the root, one `taskkill /F /PID` each, after re-reading that process and skipping it when its name or
 * creation time changed; collect → kill repeats up to 3 times. Every taskkill output is kept.
 *
 * This module imports nothing from the hosts (`tui-pty.ts` imports `routing-host.ts`, which imports this).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Every process-table / taskkill call is bounded by this. */
export const PROCESS_CALL_TIMEOUT_MS = 15_000;
/** Kernel process creation times are coarser than Date.now(): a child counts as "after the spawn" within this slack. */
export const CLOCK_SLACK_MS = 250;
/** Collect → kill rounds of {@link stopTree}, and the pause after each. */
export const KILL_ROUNDS = 3;
export const KILL_ROUND_PAUSE_MS = 1_000;

/** One Win32_Process row; `CreationDate` in epoch milliseconds (0 when unreadable). */
export interface ProcessRow { ProcessId: number; ParentProcessId: number; Name: string; CreationDate: number }
export const identity = (p: ProcessRow): string => `${p.ProcessId}@${p.CreationDate}`;

async function queryProcesses(filter?: string): Promise<ProcessRow[]> {
  const where = filter === undefined ? "" : ` -Filter "${filter}"`;
  // The querying pwsh never reports itself (it is a fresh child of the caller, R2-2).
  const script = "$ErrorActionPreference='Stop'; $rows = @(Get-CimInstance Win32_Process" + where + " | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; Name = [string]$_.Name; CreationDate = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } }); ConvertTo-Json -Compress -Depth 2 -InputObject $rows";
  const { stdout } = await execFileAsync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: PROCESS_CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed as ProcessRow[] : [];
}
/** Every process; empty on failure (callers that need it throw). */
export async function processTable(): Promise<ProcessRow[]> {
  try { return await queryProcesses(); } catch { return []; }
}
/** One process re-read by pid; undefined when it is gone or unreadable. */
export async function processInfo(pid: number): Promise<ProcessRow | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try { return (await queryProcesses(`ProcessId=${pid}`))[0]; } catch { return undefined; }
}

export interface KillRecord { round: number; pid: number; name: string; created: number; role: "root" | "child"; action: "killed" | "gone" | "mismatch" | "failed"; output: string }

/** The spawned root and its descendants created after the spawn; never a process of the baseline. */
export class ProcessTree {
  readonly members = new Map<number, ProcessRow>();
  readonly kills: KillRecord[] = [];
  root: ProcessRow | undefined;
  private readonly baseline: ReadonlySet<string>;
  constructor(baseline: readonly ProcessRow[], readonly spawnAt: number) {
    if (baseline.length === 0) throw new Error("the process table before the spawn is empty: refusing to track a tree without a baseline");
    this.baseline = new Set(baseline.map(identity));
  }
  /** Registers the spawned root after checking its identity (name, created after the spawn, not in the baseline). */
  setRoot(row: ProcessRow, expectedName: string): void {
    if (row.Name.toLowerCase() !== expectedName.toLowerCase()) throw new Error(`root pid ${row.ProcessId} is ${row.Name}, expected ${expectedName}`);
    if (row.CreationDate < this.spawnAt - CLOCK_SLACK_MS) throw new Error(`root pid ${row.ProcessId} was created before the spawn (${row.CreationDate} < ${this.spawnAt})`);
    if (row.CreationDate > Date.now() + 5_000) throw new Error(`root pid ${row.ProcessId} has a creation time in the future (${row.CreationDate} > now + 5 s)`);
    if (this.baseline.has(identity(row))) throw new Error(`root pid ${row.ProcessId} is in the baseline`);
    this.root = row;
    this.members.set(row.ProcessId, row);
  }
  /** Adds descendants (breadth first): a child only if created at/after its parent and the spawn, and not in the baseline. */
  async collect(): Promise<void> {
    if (!this.root) return;
    const all = await processTable();
    if (all.length === 0) throw new Error("process table unreadable during collect");
    const live = new Set(all.map(identity));
    const queue = [...this.members.values()].filter(p => live.has(identity(p)));
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const proc of all) {
        if (proc.ParentProcessId !== parent.ProcessId || this.members.has(proc.ProcessId) || this.baseline.has(identity(proc))) continue;
        if (proc.CreationDate < parent.CreationDate || proc.CreationDate < this.spawnAt - CLOCK_SLACK_MS) continue;
        this.members.set(proc.ProcessId, proc);
        queue.push(proc);
      }
    }
  }
  /**
   * Report only, never killed (R2-3): processes created after the spawn whose parent pid is a member's and that were
   * created after that member, but are not members themselves (e.g. a child that appeared after the last collect).
   */
  async strays(): Promise<ProcessRow[]> {
    const all = await processTable();
    if (all.length === 0) throw new Error("process table unreadable");
    const own = new Set([...this.members.values()].map(identity));
    return all.filter(p => {
      const parent = this.members.get(p.ParentProcessId);
      return parent !== undefined && !own.has(identity(p)) && p.CreationDate >= this.spawnAt - CLOCK_SLACK_MS && p.CreationDate >= parent.CreationDate;
    });
  }
  /** Members whose identity (pid + creation time) still exists. */
  async live(): Promise<ProcessRow[]> {
    const all = await processTable();
    if (all.length === 0) throw new Error("process table unreadable");
    const present = new Set(all.map(identity));
    return [...this.members.values()].filter(p => present.has(identity(p)));
  }
  /** `taskkill /F /PID` of one member, after re-reading it; skipped when gone or when its name or creation time differ. */
  async killOne(member: ProcessRow, role: "root" | "child", round: number): Promise<KillRecord> {
    const base = { round, pid: member.ProcessId, name: member.Name, created: member.CreationDate, role };
    if (!this.members.has(member.ProcessId) || identity(this.members.get(member.ProcessId)!) !== identity(member)) throw new Error(`refusing to kill ${member.ProcessId}: not a tree member`);
    const now = await processInfo(member.ProcessId);
    let record: KillRecord;
    if (now === undefined) record = { ...base, action: "gone", output: "" };
    else if (now.Name !== member.Name || now.CreationDate !== member.CreationDate) record = { ...base, action: "mismatch", output: `now ${now.Name}@${now.CreationDate}` };
    else {
      try {
        const { stdout, stderr } = await execFileAsync("taskkill", ["/F", "/PID", String(member.ProcessId)], { encoding: "utf8", timeout: PROCESS_CALL_TIMEOUT_MS, windowsHide: true });
        record = { ...base, action: "killed", output: `${stdout}${stderr}`.trim() };
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message?: string };
        record = { ...base, action: "failed", output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message ?? error) };
      }
    }
    this.kills.push(record);
    return record;
  }
}

/** What {@link stopTree} did; the kill records themselves stay in `tree.kills`. `strays` are reported, never killed (R2-3). */
export interface TreeStop { rounds: number; survivors: number[]; strays: ProcessRow[]; errors: string[] }

/**
 * Kills `tree` only, up to {@link KILL_ROUNDS} collect → kill rounds: the live children deepest (most recently discovered)
 * first, then the root, each through {@link ProcessTree.killOne}. `afterRound` (the host's own handle-based kill of the
 * root, e.g. `pty.kill()`; it must be idempotent) runs after each round that found live members and once more at the end.
 */
export async function stopTree(tree: ProcessTree, afterRound: () => void = () => undefined): Promise<TreeStop> {
  let rounds = 0;
  const errors: string[] = [];
  const rootPid = tree.root?.ProcessId;
  for (let round = 1; round <= KILL_ROUNDS; round++) {
    try {
      await tree.collect();
      const live = await tree.live();
      if (live.length === 0) break;
      rounds = round;
      for (const child of live.filter(p => p.ProcessId !== rootPid).reverse()) await tree.killOne(child, "child", round);
      const root = live.find(p => p.ProcessId === rootPid);
      if (root) await tree.killOne(root, "root", round);
    } catch (error) {
      errors.push(`round ${round}: ${error instanceof Error ? error.message : String(error)}`);
    }
    afterRound();
    await delay(KILL_ROUND_PAUSE_MS);
  }
  afterRound();
  let survivors: number[] = [];
  try { survivors = (await tree.live()).map(p => p.ProcessId); } catch (error) { errors.push(`survivors: ${error instanceof Error ? error.message : String(error)}`); }
  let strays: ProcessRow[] = [];
  try { strays = await tree.strays(); } catch (error) { errors.push(`strays: ${error instanceof Error ? error.message : String(error)}`); }
  return { rounds, survivors, strays, errors };
}
