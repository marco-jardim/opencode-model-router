/** #90 P2.1: drives a real OpenCode v2 TUI (`opencode.exe --standalone`) in a pseudo terminal and reads its screen.
 *
 * Method from the P1.3 A9 harness: a ConPTY (`@lydell/node-pty`, 150x45) feeds `@xterm/headless`, whose replies to the
 * host's terminal queries are written back to the pty; the screen is read from the xterm buffer. The host gets an
 * isolated environment (private HOME/XDG/APPDATA/TEMP, no credential-shaped or OPENCODE_* / MODEL_ROUTER_* / OMR_*
 * variable of the caller, a random OPENCODE_PASSWORD). Only processes spawned by this session are killed
 * (`taskkill /T /F`): a process table baseline is taken before the spawn and never touched.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, delay } from "./routing-host";

type PtyModule = typeof import("@lydell/node-pty");
type XtermModule = typeof import("@xterm/headless");
type Pty = ReturnType<PtyModule["spawn"]>;
type Term = InstanceType<XtermModule["Terminal"]>;

// Both packages are CommonJS (one native); loaded with require so their named exports resolve under any loader.
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const loadPty = (): PtyModule => requireFromRoot("@lydell/node-pty") as PtyModule;
const loadXterm = (): XtermModule => requireFromRoot("@xterm/headless") as XtermModule;

export const TUI_COLS = 150;
export const TUI_ROWS = 45;
/** Keys as a legacy xterm sends them. */
export const KEY = { enter: "\r", up: "\x1b[A", down: "\x1b[B", escape: "\x1b", ctrlT: "\x14", ctrlX: "\x18", ctrlA: "\x01" } as const;

const DROP_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
const DROP_PREFIX = /^(OPENCODE|MODEL_ROUTER|OMR|SMOKE|ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|GITHUB|GH|CLAUDE|COPILOT)_/i;

/** The isolated host environment under `home`; `extra` (harness-owned variables) is added last. */
export function isolatedTuiEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || DROP_NAME.test(name) || DROP_PREFIX.test(name)) continue;
    env[name] = value;
  }
  const dirs: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
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
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  Object.assign(env, dirs, {
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_TEST_HOME: home,
    OPENCODE_PASSWORD: randomBytes(18).toString("hex"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }, extra);
  const leaked = Object.keys(env).filter(name => DROP_NAME.test(name) && name !== "OPENCODE_PASSWORD");
  if (leaked.length > 0) throw new Error(`credential-shaped variable(s) would reach the host: ${leaked.join(",")}`);
  return env;
}

export interface ProcessRow { ProcessId: number; ParentProcessId: number; Name: string; CommandLine?: string | null }
/** Every process (Win32_Process); empty on failure. */
export function processTable(): ProcessRow[] {
  try {
    const json = execFileSync("pwsh", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as ProcessRow[] : [];
  } catch {
    return [];
  }
}
export const opencodePids = (table: readonly ProcessRow[]): number[] => table.filter(p => String(p.Name).toLowerCase() === "opencode.exe").map(p => p.ProcessId).sort((a, b) => a - b);
export function alive(pid: number): boolean {
  try {
    return execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true }).includes(`"${pid}"`);
  } catch {
    return false;
  }
}

/** Descendants of one root pid; never a process that existed before the baseline was taken. */
export class ProcessTree {
  readonly pids = new Map<number, string>();
  private readonly baseline: Set<number>;
  constructor(baseline: readonly ProcessRow[]) { this.baseline = new Set(baseline.map(p => p.ProcessId)); }
  add(pid: number, name: string): void { if (pid > 4 && !this.baseline.has(pid)) this.pids.set(pid, name); }
  collect(root: number): void {
    if (!(root > 4)) return;
    const all = processTable();
    const queue = [root, ...this.pids.keys()];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const proc of all) {
        if (proc.ParentProcessId === parent && !seen.has(proc.ProcessId) && !this.baseline.has(proc.ProcessId)) {
          seen.add(proc.ProcessId);
          queue.push(proc.ProcessId);
          this.pids.set(proc.ProcessId, proc.Name);
        }
      }
    }
  }
  kill(): string[] {
    const out: string[] = [];
    for (const pid of this.pids.keys()) {
      if (!alive(pid)) continue;
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { encoding: "utf8", stdio: "pipe", windowsHide: true });
        out.push(`killed ${pid}`);
      } catch (error) {
        out.push(`taskkill ${pid}: ${String(error instanceof Error ? error.message : error).trim().slice(0, 200)}`);
      }
    }
    return out;
  }
  survivors(): number[] { return [...this.pids.keys()].filter(alive); }
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
export interface TuiStop { pid: number; tree: number[]; kill: string[]; survivors: number[] }
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
    const tree = new ProcessTree(processTable());
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
    const session = new TuiSession(start, pty, term, tree, pty.pid);
    tree.add(pty.pid, path.basename(start.executable));
    pty.onExit(e => { session.exited = e; });
    if (exited) session.exited = exited;
    session.note(`spawned ${path.basename(start.executable)} ${start.args.join(" ")} pid=${pty.pid}`);
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

  /** Kills this session's process tree only (taskkill /T /F), then reports survivors. Idempotent. */
  stop(): Promise<TuiStop> { return this.stopped ??= this.doStop(); }
  private async doStop(): Promise<TuiStop> {
    this.tree.collect(this.pid);
    const kill = this.tree.kill();
    try { this.pty.kill(); } catch { /* already gone */ }
    await delay(2_000);
    const survivors = this.tree.survivors();
    const result = { pid: this.pid, tree: [...this.tree.pids.keys()], kill, survivors };
    this.note(`stopped ${JSON.stringify(result)}`);
    return result;
  }
}
