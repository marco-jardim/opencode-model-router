/** #90 P2.1: drives a real OpenCode v2 TUI (`opencode.exe --standalone`) in a pseudo terminal and reads its screen.
 *
 * Method from the P1.3 A9 harness: a ConPTY (`@lydell/node-pty`, 150x45) feeds `@xterm/headless`, whose replies to the
 * host's terminal queries are written back to the pty; the screen is read from the xterm buffer.
 *
 * Isolation (QA P21-5): the host gets an ALLOWLISTED environment — a few Windows system variables, the private
 * HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/XDG/APPDATA/LOCALAPPDATA/TEMP of the temp home, the OpenCode settings set here
 * and the harness's own variables — and a leak check rejects any credential-shaped name.
 *
 * Process safety (QA P21-1): no `taskkill /T`. A process belongs to the session only if it descends from the spawned
 * root AND was created after the spawn and after its parent (Win32_Process CreationDate), and is not in the baseline
 * taken before the spawn (pid + creation time). Teardown kills children first, then the root (whose pty still holds its
 * handle; `pty.kill()` follows), one `taskkill /F /PID` each, after re-reading that process and skipping it when its
 * name or creation time changed; collect → kill repeats up to 3 times. Every taskkill output is kept.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT, delay } from "./routing-host";

type PtyModule = typeof import("@lydell/node-pty");
type XtermModule = typeof import("@xterm/headless");
type Pty = ReturnType<PtyModule["spawn"]>;
type Term = InstanceType<XtermModule["Terminal"]>;

// Both packages are CommonJS (one native); loaded with require so their named exports resolve under any loader.
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const loadPty = (): PtyModule => requireFromRoot("@lydell/node-pty") as PtyModule;
const loadXterm = (): XtermModule => requireFromRoot("@xterm/headless") as XtermModule;
const execFileAsync = promisify(execFile);

export const TUI_COLS = 150;
export const TUI_ROWS = 45;
/** Keys as a legacy xterm sends them. */
export const KEY = { enter: "\r", up: "\x1b[A", down: "\x1b[B", escape: "\x1b", ctrlT: "\x14", ctrlX: "\x18", ctrlA: "\x01" } as const;
/** Every process-table / taskkill call is bounded by this. */
export const PROCESS_CALL_TIMEOUT_MS = 15_000;
/** Kernel process creation times are coarser than Date.now(): a child counts as "after the spawn" within this slack. */
export const CLOCK_SLACK_MS = 250;

/** System variables the host may inherit (matched case-insensitively; Windows names are case-insensitive). */
export const ENV_ALLOWLIST = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "COMPUTERNAME"] as const;
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/** The isolated host environment under `home`; `extra` (harness-owned variables) is added last. */
export function isolatedTuiEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set<string>(ENV_ALLOWLIST);
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && allowed.has(name.toUpperCase())) env[name] = value;
  const root = path.parse(home).root; // "C:\"
  const dirs: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: root.replace(/[\\/]+$/, ""),
    HOMEPATH: home.slice(root.length - 1),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    TMPDIR: path.join(home, "tmp"),
  };
  for (const [name, dir] of Object.entries(dirs)) if (name !== "HOMEDRIVE" && name !== "HOMEPATH") mkdirSync(dir, { recursive: true });
  const settings: Record<string, string> = {
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_TEST_HOME: home,
    OPENCODE_PASSWORD: randomBytes(18).toString("hex"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  Object.assign(env, dirs, settings, extra);
  const expected = new Set([...Object.keys(dirs), ...Object.keys(settings), ...Object.keys(extra)]);
  const stray = Object.keys(env).filter(name => !allowed.has(name.toUpperCase()) && !expected.has(name));
  if (stray.length > 0) throw new Error(`variables outside the allowlist would reach the host: ${stray.join(",")}`);
  const leaked = Object.keys(env).filter(name => CREDENTIAL_NAME.test(name) && name !== "OPENCODE_PASSWORD");
  if (leaked.length > 0) throw new Error(`credential-shaped variable(s) would reach the host: ${leaked.join(",")}`);
  return env;
}

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
export const opencodePids = (table: readonly ProcessRow[]): number[] => table.filter(p => String(p.Name).toLowerCase() === "opencode.exe").map(p => p.ProcessId).sort((a, b) => a - b);

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

export interface TuiStart {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Screens (deduplicated) and harness notes are appended here. */
  readonly logFile: string;
}
/** `strays`: descendants of members found after the kill rounds and not killed (R2-3); the teardown test fails on any. */
export interface TuiStop { pid: number; spawnAt: number; tree: ProcessRow[]; kills: KillRecord[]; rounds: number; survivors: number[]; strays: ProcessRow[]; errors: string[] }
export interface ScreenHit<T> { value: T; at: number; lines: string[] }

/** One TUI process in a pty with a headless xterm mirror. */
export class TuiSession {
  readonly t0 = Date.now();
  exited: { exitCode: number; signal?: number } | undefined;
  private lastLogged = "";
  private stopped?: Promise<TuiStop>;

  private constructor(readonly start: TuiStart, private readonly pty: Pty, private readonly term: Term, readonly tree: ProcessTree, readonly pid: number) {}

  static async spawn(start: TuiStart): Promise<TuiSession> {
    const { spawn } = loadPty();
    const { Terminal } = loadXterm();
    const baseline = await processTable();
    const spawnAt = Date.now();
    const tree = new ProcessTree(baseline, spawnAt); // throws on an empty baseline
    const term = new Terminal({ cols: TUI_COLS, rows: TUI_ROWS, allowProposedApi: true, scrollback: 0 });
    const pty = spawn(start.executable, [...start.args], { name: "xterm-256color", cols: TUI_COLS, rows: TUI_ROWS, cwd: start.cwd, env: start.env });
    let exited: { exitCode: number; signal?: number } | undefined;
    pty.onData(data => term.write(data));
    pty.onExit(e => { exited = e; });
    // The host queries the terminal (DA, DSR, …): the xterm mirror answers and the answers go back to the host.
    const reply = (data: string) => { try { pty.write(data); } catch { /* the pty is gone */ } };
    term.onData(reply);
    term.onBinary(reply);
    // ConPTY reports pid 0 at first: wait for a real one before tracking the tree.
    for (let i = 0; i < 100 && !(pty.pid > 4); i++) await delay(100);
    if (!(pty.pid > 4)) {
      try { pty.kill(); } catch { /* nothing to kill */ }
      throw new Error(`the pty reported no real pid after 10 s (pid ${pty.pid})`);
    }
    const root = await processInfo(pty.pid);
    if (root === undefined) {
      try { pty.kill(); } catch { /* already gone */ }
      throw new Error(`spawned pid ${pty.pid} is not in the process table (exited: ${JSON.stringify(exited)})`);
    }
    try { tree.setRoot(root, path.basename(start.executable)); } catch (error) {
      try { pty.kill(); } catch { /* already gone */ }
      throw error;
    }
    const session = new TuiSession(start, pty, term, tree, pty.pid);
    pty.onExit(e => { session.exited = e; });
    if (exited) session.exited = exited;
    session.note(`spawned ${path.basename(start.executable)} ${start.args.join(" ")} pid=${pty.pid} created=${root.CreationDate} spawnAt=${spawnAt}`);
    return session;
  }

  /** Seconds since spawn, one decimal. */
  stamp(): string { return ((Date.now() - this.t0) / 1000).toFixed(1); }
  note(message: string): void { appendFileSync(this.start.logFile, `[${this.start.label} +${this.stamp()}s] ${message}\n`); }

  /** The visible screen, one string per row (trailing blanks trimmed). */
  async screen(): Promise<string[]> {
    await new Promise<void>(resolve => this.term.write("", resolve));
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) lines.push((buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "").replace(/\s+$/, ""));
    return lines;
  }
  /** Logs the screen under `tag` when it differs from the last logged one; returns it. */
  async snap(tag: string): Promise<string[]> {
    const lines = await this.screen();
    const text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    if (text !== this.lastLogged) {
      this.lastLogged = text;
      appendFileSync(this.start.logFile, `----- screen @${tag} (+${this.stamp()}s) -----\n${text}\n`);
    }
    return lines;
  }
  send(data: string): void {
    try { this.pty.write(data); } catch { /* the pty is gone */ }
  }
  /** Types `text` one character at a time. */
  async type(text: string, perCharMs = 12): Promise<void> {
    for (const ch of text) { this.send(ch); await delay(perCharMs); }
  }
  /** Polls the screen until `probe` returns a value; throws with the last screen after `timeoutMs`. */
  async waitScreen<T>(label: string, probe: (lines: string[]) => T | undefined, timeoutMs: number, stepMs = 100): Promise<ScreenHit<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const lines = await this.screen();
      const value = probe(lines);
      if (value !== undefined) { await this.snap(label); return { value, at: Date.now(), lines }; }
      if (this.exited) throw new Error(`${label}: the TUI exited ${JSON.stringify(this.exited)}\n${lines.join("\n")}`);
      if (Date.now() > deadline) { await this.snap(`timeout ${label}`); throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}; last screen:\n${lines.join("\n")}`); }
      await delay(stepMs);
    }
  }

  /** Kills this session's tree only (children first, then the root, then the pty), up to 3 collect→kill rounds. Idempotent. */
  stop(): Promise<TuiStop> { return this.stopped ??= this.doStop(); }
  private async doStop(): Promise<TuiStop> {
    let rounds = 0;
    let ptyKilled = false;
    const errors: string[] = [];
    const killPty = () => { if (ptyKilled) return; ptyKilled = true; try { this.pty.kill(); } catch { /* already gone */ } };
    for (let round = 1; round <= 3; round++) {
      try {
        await this.tree.collect();
        const live = await this.tree.live();
        if (live.length === 0) break;
        rounds = round;
        // Deepest (most recently discovered) children first; the root last.
        for (const child of live.filter(p => p.ProcessId !== this.pid).reverse()) await this.tree.killOne(child, "child", round);
        const root = live.find(p => p.ProcessId === this.pid);
        if (root) await this.tree.killOne(root, "root", round);
      } catch (error) {
        errors.push(`round ${round}: ${error instanceof Error ? error.message : String(error)}`);
      }
      killPty();
      await delay(1_000);
    }
    killPty();
    let survivors: number[] = [];
    try { survivors = (await this.tree.live()).map(p => p.ProcessId); } catch (error) { errors.push(`survivors: ${error instanceof Error ? error.message : String(error)}`); }
    let strays: ProcessRow[] = [];
    try { strays = await this.tree.strays(); } catch (error) { errors.push(`strays: ${error instanceof Error ? error.message : String(error)}`); }
    const result: TuiStop = { pid: this.pid, spawnAt: this.tree.spawnAt, tree: [...this.tree.members.values()], kills: [...this.tree.kills], rounds, survivors, strays, errors };
    this.note(`stopped ${JSON.stringify(result)}`);
    return result;
  }
}
