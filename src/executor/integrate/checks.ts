// src/executor/integrate/checks.ts
// Phase 3.2.2 (design memo 3.2.1, section 6 and decisions M8-M12, M30). Prepares slots (reset and clean), selects the
// integration checks, runs them under the machine-wide verification slot and holds the extra git operations of the
// integration queue. It journals nothing and registers nothing; 5.1 wires the resolver, the spawner and the guard.

import { lstat, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import * as nodePath from "node:path";
import { hardeningArgs } from "../../router/git-tools";
import {
  detectRunner, isNoAffected, isScopedSpec, isUnverifiable, planRerun, planScopedRun, readResult,
  type ChangedPath, type RunnerFs, type TestSearchSeam,
} from "../../verify/runner";
import { observeTests } from "../../verify/baseline";
import { acquireSlot, type SlotHandle } from "../../verify/slot";
import type { ExecResult } from "../../verify/types";
import type { GitOps } from "../git";
import {
  ExecutorError,
  type Clock, type GitRunner, type LedgerV1, type RunCommandRef, type SlotLease, type SlotPool,
} from "../types";

// ---------------------------------------------------------------------------------------------------------------
// Constants and small types
// ---------------------------------------------------------------------------------------------------------------

export const CHECK_TRIES = 3, OUTPUT_TAIL_BYTES = 4096, DETAIL_MAX_BYTES = 16384, AX_MAX_CHARS = 4000;

const GIT_READ_TIMEOUT_MS = 120_000;
const SEARCH_TIMEOUT_MS = 30_000;
const SLOT_WAIT_MS = 2000;
const DEFAULT_SLOT_MAX = 2;
const MAX_WORKERS = 2;

/** The one logging method the executor modules use (structural, as in slots/pool.ts). */
export interface Logger { warn(m: string): void }

export interface ResolvedCommand {
  label: string; file: string; args: readonly string[];
  source: "package-script" | "run-command" | "pytest"; ref: RunCommandRef | null;
  /** Inherited router plan, not explicit overrides. Re-resolve `ref` after preparing the execution checkout. */
  resolution?: { cwd: string; env: Readonly<Record<string, string>> };
  /** Extra environment for the child (scoped test specs). */
  env?: Readonly<Record<string, string>>;
  /** Explicit working directory override (for example scoped test specs); default: the check's cwd. */
  cwd?: string;
}
export interface CommandOutput { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; durationMs: number }
export type CommandRunner = (c: ResolvedCommand, o: { cwd: string; signal: AbortSignal; lowPriority: boolean }) => Promise<CommandOutput>;
export interface RunResolver {
  resolve(ref: RunCommandRef, cwd: string): Promise<{ ok: true; command: ResolvedCommand } | { ok: false; reason: string }>;
}
export interface TestComponent { framework: "node" | "pytest"; full: ResolvedCommand }
export interface CheckSelection { typecheck: ResolvedCommand | null; tests: TestComponent[]; extras: ResolvedCommand[] }
export type CheckErrorReason = "prepare" | "slot-lost" | "spawn" | "resolve" | "preempted" | "interrupted";
export interface ComponentResult {
  name: "typecheck" | "tests" | "extra" | "regression"; label: string;
  exitCode: number | null; timedOut: boolean; durationMs: number; scope: "spec" | "no-affected" | "full" | "rerun"; flakyIds: string[];
}
export type CheckResult =
  | { verdict: "pass"; components: ComponentResult[]; flakyIds: string[]; note: "no-checks" | null; durationMs: number }
  | { verdict: "fail"; components: ComponentResult[]; failingIds: string[]; failingFiles: string[]; flakyIds: string[]; output: string; durationMs: number }
  | { verdict: "error"; reason: CheckErrorReason; message: string; components: ComponentResult[]; durationMs: number };
export interface CheckRequest {
  slot: SlotLease; base: string; candidate: string; priority: "foreground" | "background";
  extra?: { ids: string[]; files: string[]; commands: ResolvedCommand[] } | null; signal: AbortSignal;
}
export interface CommandRunRequest {
  slot: SlotLease; commit: string; commands: readonly ResolvedCommand[];
  mode: "full" | { rerun: readonly string[] }; priority: "foreground" | "background"; signal: AbortSignal; prepare: boolean;
  /** M38: the preemption budget of the suite entry, shared by all of its runs (default: a fresh PREEMPT_BUDGET per run). */
  preempt?: PreemptBudget;
  /**
   * QA-3.2-22: a rerun that runs nothing (its files map to no test) is a failure, unparsed, never a pass. Set for the
   * reruns at the commit where the failure was observed: its failing files must exist there.
   */
  requireRun?: boolean;
}
export interface CommandRunResult {
  verdict: "pass" | "fail" | "error"; ids: string[]; files: string[]; idsUnparsed: boolean;
  /** Effective scope, not the requested mode: any full-command execution (including a mixed run) makes this full. */
  scope: "full" | "rerun";
  output: string; durationMs: number; error: { reason: CheckErrorReason; message: string } | null;
}
export interface IntegrationChecks {
  prepare(slot: SlotLease, commit: string): Promise<void>;
  select(cwd: string, commit: string): Promise<CheckSelection>;
  run(req: CheckRequest): Promise<CheckResult>;
  runCommands(req: CommandRunRequest): Promise<CommandRunResult>;
}

export class CheckPrepareError extends Error {
  override readonly name = "CheckPrepareError" as const;
}

/** A check command the resolver refused (reason "resolve"). */
class CheckResolveError extends Error {
  override readonly name = "CheckResolveError" as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Write guard (M30) and IntegrateGit
// ---------------------------------------------------------------------------------------------------------------

export type WritePurpose = "slot" | "integration" | "tag" | "land";
export interface WriteGuard { assertWriteCwd(cwd: string, purpose: WritePurpose): Promise<void> }
export interface NameStatus { status: "A" | "M" | "D" | "T"; path: string }
export type CreateRefOutcome = "created" | "exists-same" | { kind: "exists-other"; at: string };
export interface IntegrateGit {
  diffNameStatus(cwd: string, from: string, to: string): Promise<NameStatus[]>;
  logPaths(cwd: string, from: string, to: string, path: string, max: number): Promise<Array<{ sha: string; subject: string }>>;
  revList(cwd: string, from: string, to: string): Promise<string[]>;
  createRef(cwd: string, ref: string, commit: string): Promise<CreateRefOutcome>;
  mergeBase(cwd: string, a: string, b: string): Promise<string>;
  isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean>;
  showFile(cwd: string, commit: string, path: string): Promise<string | null>;
  subject(cwd: string, commit: string): Promise<string>;
  readRef(cwd: string, ref: string): Promise<string | null>;
  ignoredAt(cwd: string, paths: readonly string[]): Promise<string[]>;
  revertAbort(cwd: string): Promise<void>;
}

function foldPath(p: string, platform: NodeJS.Platform): string {
  const lexical = platform === "win32" ? nodePath.win32.resolve(p).replace(/\//g, "\\").toLowerCase() : nodePath.posix.resolve(p);
  return lexical.length > 1 && /[\\/]$/.test(lexical) && !/^[a-z]:\\$/.test(lexical) ? lexical.slice(0, -1) : lexical;
}

export function createWriteGuard(o: {
  ledger: () => Readonly<LedgerV1>; pool: SlotPool; realpath: (p: string) => Promise<string>; platform: NodeJS.Platform;
}): WriteGuard {
  return {
    async assertWriteCwd(cwd, purpose) {
      const here = foldPath(await o.realpath(cwd), o.platform);
      const l = o.ledger();
      if (purpose === "land") {
        if (here !== foldPath(await o.realpath(l.repo.toplevel), o.platform)) {
          throw new ExecutorError("E_INVALID_INPUT", "a landing write must run in the repository toplevel", { purpose, cwd: cwd.slice(0, 200) });
        }
        return;
      }
      const allowed: string[] = [l.integration.worktree];
      for (const rec of await o.pool.list(l.planId)) allowed.push(rec.path);
      for (const candidate of allowed) {
        try {
          if (foldPath(await o.realpath(candidate), o.platform) === here) return;
        } catch {
          // A slot path that does not resolve cannot be the cwd.
        }
      }
      throw new ExecutorError("E_INVALID_INPUT", "git write outside the slots and the integration worktree", { purpose, cwd: cwd.slice(0, 200) });
    },
  };
}

function splitNul(text: string): string[] {
  return text.split("\0").filter(part => part !== "");
}

/** The `lstat` seam of `ignoredAt` (default: node:fs/promises). */
export type LstatFn = (p: string) => Promise<{ isDirectory(): boolean }>;

export function createIntegrateGit(run: GitRunner, guard: WriteGuard, lstatOf: LstatFn = lstat): IntegrateGit {
  const prefix = ["--no-optional-locks", ...hardeningArgs()];
  async function exec(cwd: string, args: readonly string[]) {
    return run.run([...prefix, ...args], { cwd, timeoutMs: GIT_READ_TIMEOUT_MS });
  }
  async function ok(cwd: string, op: string, args: readonly string[]): Promise<string> {
    const r = await exec(cwd, args);
    if (r.code !== 0) {
      throw new ExecutorError("E_GIT", `git ${op} failed (exit ${r.code ?? r.signal ?? "unknown"})`, { op, code: r.code, stderr: r.stderr.slice(-2048) });
    }
    return r.stdout;
  }
  async function readRef(cwd: string, ref: string): Promise<string | null> {
    const r = await exec(cwd, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`]);
    if (r.code === 0) return r.stdout.trim();
    if (r.code === 1) return null;
    throw new ExecutorError("E_GIT", "git rev-parse failed", { op: "rev-parse", code: r.code, stderr: r.stderr.slice(-2048) });
  }
  return {
    async diffNameStatus(cwd, from, to) {
      const parts = splitNul(await ok(cwd, "diff", ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", from, to, "--"]));
      const out: NameStatus[] = [];
      for (let n = 0; n + 1 < parts.length; n += 2) {
        const code = (parts[n] ?? "").charAt(0);
        const status: NameStatus["status"] = code === "A" || code === "D" || code === "T" ? code : "M";
        out.push({ status, path: parts[n + 1] ?? "" });
      }
      return out;
    },
    async logPaths(cwd, from, to, path, max) {
      const parts = (await ok(cwd, "log", ["log", "-z", "--format=%H%x00%s", "-n", String(max), `${from}..${to}`, "--", `:(literal)${path}`])).split("\0");
      const out: Array<{ sha: string; subject: string }> = [];
      for (let n = 0; n + 1 < parts.length; n += 2) {
        const sha = (parts[n] ?? "").trim();
        if (sha !== "") out.push({ sha, subject: parts[n + 1] ?? "" });
      }
      return out;
    },
    async revList(cwd, from, to) {
      return (await ok(cwd, "rev-list", ["rev-list", "--reverse", "--topo-order", `${from}..${to}`])).split("\n").map(s => s.trim()).filter(s => s !== "");
    },
    async createRef(cwd, ref, commit) {
      await guard.assertWriteCwd(cwd, "tag");
      const r = await exec(cwd, ["update-ref", ref, commit, "0".repeat(commit.length)]);
      if (r.code === 0) return "created";
      const at = await readRef(cwd, ref);
      if (at === null) throw new ExecutorError("E_GIT", "git update-ref failed", { op: "update-ref", code: r.code, stderr: r.stderr.slice(-2048) });
      return at === commit ? "exists-same" : { kind: "exists-other", at };
    },
    async mergeBase(cwd, a, b) {
      return (await ok(cwd, "merge-base", ["merge-base", a, b])).trim();
    },
    async isAncestor(cwd, ancestor, descendant) {
      const r = await exec(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
      if (r.code === 0) return true;
      if (r.code === 1) return false;
      throw new ExecutorError("E_GIT", "git merge-base failed", { op: "merge-base", code: r.code, stderr: r.stderr.slice(-2048) });
    },
    async showFile(cwd, commit, path) {
      const r = await exec(cwd, ["show", `${commit}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    },
    async subject(cwd, commit) {
      return (await ok(cwd, "log", ["log", "-1", "--format=%s", commit, "--"])).replace(/\r?\n$/, "");
    },
    readRef,
    async ignoredAt(cwd, paths) {
      // M29.5 (QA-3.2-12): only the exact changed paths are listed, file by file (no `--directory`, which would report
      // every ignored file under a parent directory). A parent directory counts only when that path exists in the
      // checkout as a non-directory (a file or a symlink git would replace by a directory).
      const specs = new Set<string>();
      const parents = new Set<string>();
      for (const p of paths) {
        specs.add(`:(literal)${p}`);
        for (let dir = nodePath.posix.dirname(p); dir !== "." && dir !== "/" && dir !== ""; dir = nodePath.posix.dirname(dir)) parents.add(dir);
      }
      for (const dir of parents) {
        if (specs.has(`:(literal)${dir}`)) continue;
        try {
          if (!(await lstatOf(nodePath.join(cwd, dir))).isDirectory()) specs.add(`:(literal)${dir}`);
        } catch {
          // Absent: nothing can be overwritten there.
        }
      }
      if (specs.size === 0) return [];
      return splitNul(await ok(cwd, "ls-files", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...specs]));
    },
    async revertAbort(cwd) {
      await guard.assertWriteCwd(cwd, "slot");
      if ((await exec(cwd, ["rev-parse", "--verify", "-q", "REVERT_HEAD"])).code !== 0) return;
      await ok(cwd, "revert --abort", ["revert", "--abort"]);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Check selection (M9)
// ---------------------------------------------------------------------------------------------------------------

/** npm's `npm init` placeholder test script. */
export function isPlaceholderTestScript(s: string): boolean {
  return /^echo\s+["']?error:\s*no test specified["']?\s*&&\s*exit\s+1$/i.test(s.trim());
}

function scriptsOf(packageJson: string | null): Record<string, unknown> {
  if (packageJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (typeof parsed !== "object" || parsed === null) return {};
    const scripts: unknown = Reflect.get(parsed, "scripts");
    return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function selectFromFiles(
  f: { packageJson: string | null; pytestIni: boolean; conftest: boolean; pyproject: string | null; setupCfg: string | null; toxIni: string | null },
  extras: readonly RunCommandRef[] | "auto",
): { typecheck: boolean; node: boolean; pytest: boolean; extras: RunCommandRef[] } {
  const scripts = scriptsOf(f.packageJson);
  const test = scripts["test"];
  return {
    typecheck: typeof scripts["typecheck"] === "string",
    node: typeof test === "string" && !isPlaceholderTestScript(test),
    pytest: f.pytestIni || f.conftest || (f.pyproject?.includes("[tool.pytest") ?? false)
      || (f.setupCfg?.includes("[tool:pytest]") ?? false) || (f.toxIni?.includes("[pytest]") ?? false),
    extras: extras === "auto" ? [] : extras.map(e => ({ script: e.script, args: [...e.args] })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Background runs (M12)
// ---------------------------------------------------------------------------------------------------------------

/** Preemptions a suite entry may still take (M38). Shared by every run of the entry, so the cap spans the entry. */
export interface PreemptBudget { left: number }

/** M38: preemptions per suite entry. */
export const PREEMPT_BUDGET = 3;

/**
 * In-process background (suite) runs that a foreground check may preempt. A number budget is private to the run; a
 * `PreemptBudget` object is shared, so a run registered after the entry's budget is spent is never preempted.
 */
export class BackgroundRuns {
  private readonly runs = new Set<{ c: AbortController; budget: PreemptBudget }>();
  register(c: AbortController, budget: number | PreemptBudget): () => void {
    const entry = { c, budget: typeof budget === "number" ? { left: budget } : budget };
    this.runs.add(entry);
    return () => { this.runs.delete(entry); };
  }
  preemptOne(): boolean {
    for (const entry of this.runs) {
      if (entry.budget.left > 0 && !entry.c.signal.aborted) {
        entry.budget.left -= 1;
        entry.c.abort();
        return true;
      }
    }
    return false;
  }
  get active(): number {
    return this.runs.size;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------------------

export interface IntegrationChecksDeps {
  ledger: () => Readonly<LedgerV1>; pool: SlotPool; git: GitOps; igit: IntegrateGit;
  resolver: RunResolver; spawn: CommandRunner; guard: WriteGuard; background: BackgroundRuns; clock: Clock; logger: Logger;
  /** Default: wiring.preemptBackgroundVerification. */
  preemptForeground?: () => Promise<void>;
  /** Default: slot.ts acquireSlot. */
  acquire?: typeof acquireSlot;
  /** Machine-wide verification slots (default 2). */
  slotMax?: number;
  /** `isCommandAllowed` for the pytest command (default: allowed). */
  allowCommand?: (command: string) => boolean;
  /** Whether a test file exists (default: node:fs). A failing id names a rerunnable file only when it does (QA-3.2-22/-24). */
  fileExists?: (p: string) => Promise<boolean>;
}

async function fileExistsOnDisk(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

const nodeFs: RunnerFs = {
  fileExists: fileExistsOnDisk,
  readFile: p => readFile(p, "utf8"),
  realpath: p => realpath(p),
  async stat(p) {
    const s = await stat(p, { bigint: true });
    return { isFile: s.isFile(), size: s.size, dev: s.dev, ino: s.ino };
  },
  readdir: p => readdir(p),
  async unlink(p) {
    try {
      await unlink(p);
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
  },
};

function tail(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= max ? text : bytes.subarray(bytes.length - max).toString("utf8");
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The test file part of a stable failing id (`<file> > a > b`, `<file>::Cls::test`, or a bare file). */
function fileOfId(id: string): string {
  const gt = id.indexOf(" > ");
  const cc = id.indexOf("::");
  const cut = [gt, cc].filter(n => n >= 0);
  return cut.length === 0 ? id : id.slice(0, Math.min(...cut));
}

/** A vitest workspace line names its project first (` FAIL  |proj| test/a.test.ts > …`): the id is what follows. */
function stripProject(id: string): string {
  return id.replace(/^\|[^|]*\|\s+/, "");
}

function field(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null ? Reflect.get(o, key) : undefined;
}

/**
 * QA-3.2-26: a jest/vitest JSON report on stdout, with its failing ids in `readResult`'s form
 * (`<cwd-relative file> > <ancestor titles> > <title>`). `raw` are the same failures in `observeTests`' form
 * (`<absolute suite name> > <fullName>`), to drop. `errors`: a runtime-error suite or a failed suite without a failed
 * test (an import or collection error, QA-3.2-23).
 */
function jsonReport(stdout: string, cwd: string): { ids: string[]; raw: string[]; errors: boolean } | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const results = field(json, "testResults");
  if (!Array.isArray(results)) return null;
  const suites: unknown[] = results;
  const ids: string[] = [];
  const raw: string[] = [];
  let errors = Number(field(json, "numRuntimeErrorTestSuites") ?? 0) > 0;
  for (const suite of suites) {
    const name = String(field(suite, "name") ?? "");
    const rel = (nodePath.isAbsolute(name) ? nodePath.relative(cwd, name) : name).replace(/\\/g, "/");
    const asserts = field(suite, "assertionResults");
    let failed = 0;
    for (const a of Array.isArray(asserts) ? (asserts as unknown[]) : []) {
      if (field(a, "status") !== "failed") continue;
      failed++;
      const fullName = field(a, "fullName");
      if (typeof fullName === "string") raw.push(`${name} > ${fullName}`);
      const ancestors = field(a, "ancestorTitles");
      const title = field(a, "title");
      const parts = [...(Array.isArray(ancestors) ? (ancestors as unknown[]).map(String) : []), String(title ?? fullName ?? "")];
      ids.push(`${rel} > ${parts.join(" > ")}`);
    }
    if (field(suite, "status") === "failed" && failed === 0) errors = true;
  }
  return { ids, raw, errors };
}

/**
 * QA-3.2-23: output that reports errors outside the test inventory, so its failing ids cannot be the whole failure:
 * a file-level FAIL (vitest's failed suite ` FAIL  f.ts [ f.ts ]`, jest's file header), vitest's `Errors  N error`,
 * pytest's `ERROR …` lines, an `N error` count in pytest's summary, or an error during collection.
 */
function reportsErrors(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (/^FAIL\s/.test(line) && !/\s>\s/.test(line)) return true;
    if (/^Errors?\s+\d+\s+errors?\b/i.test(line) || /^ERROR\b/.test(line)) return true;
    if (/^=+\s.*\b\d+\s+errors?\b/.test(line) || /\berrors? during collection\b/i.test(line)) return true;
  }
  return false;
}

/**
 * QA-3.2-1: the failing ids of a full run, read from its output (`observeTests`, verify/baseline.ts), in one form
 * (QA-3.2-26: `readResult`'s; no vitest project prefix, no absolute jest-JSON ids). `files` are the test files of the
 * ids resolved against `cwd`. `complete` is false when the output also reports errors outside the tests (QA-3.2-23).
 * Null when the output names no id.
 */
export function observeFull(o: CommandOutput, cwd: string): { ids: string[]; files: string[]; complete: boolean } | null {
  const seen = observeTests({ code: o.exitCode ?? -1, stdout: o.stdout, stderr: o.stderr, timedOut: o.timedOut });
  const json = jsonReport(o.stdout, cwd);
  const raw = new Set(json?.raw ?? []);
  const ids = [...new Set([...seen.failures.filter(id => !raw.has(id)).map(stripProject), ...(json?.ids ?? [])])].sort();
  if (ids.length === 0) return null;
  const files = [...new Set(ids.map(id => nodePath.resolve(cwd, fileOfId(id))))].sort();
  const complete = seen.complete && !(json?.errors ?? false) && !reportsErrors(`${o.stdout}\n${o.stderr}`);
  return { ids, files, complete };
}

type Held<T> = { ok: true; value: T } | { ok: false; reason: CheckErrorReason; message: string };

interface Failing { ids: string[]; files: string[]; output: string }

interface TestOutcome {
  comp: ComponentResult;
  failing: Failing | null;
}

export function createIntegrationChecks(d: IntegrationChecksDeps): IntegrationChecks {
  async function prepare(slot: SlotLease, commit: string): Promise<void> {
    try {
      await d.pool.reset(slot.slot, commit);
      await d.pool.cleanForChecks(slot.slot);
      const head = await d.git.revParse(slot.path, "HEAD");
      if (head !== commit) throw new CheckPrepareError(`slot ${slot.slot} is at ${head.slice(0, 12)}, not ${commit.slice(0, 12)}`);
    } catch (e) {
      if (e instanceof CheckPrepareError) throw e;
      throw new CheckPrepareError(`could not prepare slot ${slot.slot}: ${errText(e)}`);
    }
  }

  async function resolveRef(ref: RunCommandRef, cwd: string): Promise<ResolvedCommand> {
    const r = await d.resolver.resolve(ref, cwd);
    if (!r.ok) throw new CheckResolveError(`${ref.script}: ${r.reason}`);
    return r.command;
  }

  async function resolveForSlot(c: ResolvedCommand, cwd: string): Promise<ResolvedCommand> {
    if (c.resolution === undefined || c.ref === null) return c;
    // Executable, environment and checkout-dependent authorization all belong to the prepared slot, even when
    // its path is unchanged (base/bisect/revert). Only explicit overrides survive; never reuse the inherited plan.
    return { ...await resolveRef(c.ref, c.cwd ?? cwd),
      ...(c.cwd === undefined ? {} : { cwd: c.cwd }), ...(c.env === undefined ? {} : { env: c.env }) };
  }

  async function select(cwd: string, commit: string): Promise<CheckSelection> {
    const read = (p: string) => d.igit.showFile(cwd, commit, p);
    const [packageJson, pytestIni, conftest, pyproject, setupCfg, toxIni] = await Promise.all([
      read("package.json"), read("pytest.ini"), read("conftest.py"), read("pyproject.toml"), read("setup.cfg"), read("tox.ini"),
    ]);
    const cfg = d.ledger().config;
    const sel = selectFromFiles(
      { packageJson, pytestIni: pytestIni !== null, conftest: conftest !== null, pyproject, setupCfg, toxIni }, cfg.integrationChecks,
    );
    const typecheck = sel.typecheck ? await resolveRef({ script: "typecheck", args: [] }, cwd) : null;
    const tests: TestComponent[] = [];
    if (sel.node) tests.push({ framework: "node", full: await resolveRef({ script: "test", args: [] }, cwd) });
    if (sel.pytest) {
      const python = cfg.python === "auto" ? "python" : cfg.python;
      const label = `${python} -m pytest`;
      if (d.allowCommand === undefined || d.allowCommand(label)) {
        tests.push({ framework: "pytest", full: { label, file: python, args: ["-m", "pytest"], source: "pytest", ref: null } });
      }
    }
    const extras: ResolvedCommand[] = [];
    for (const ref of sel.extras) extras.push(await resolveRef(ref, cwd));
    return { typecheck, tests, extras };
  }

  /** M12: holds one machine-wide verification slot around `body`, which gets a signal for abort, preemption and a lost slot. */
  async function underSlot<T>(
    o: { signal: AbortSignal; priority: "foreground" | "background"; cwd: string; command: string; budget?: PreemptBudget | undefined },
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<Held<T>> {
    const lost = new AbortController();
    const own = new AbortController();
    // QA-3.2-8 (M38): a shared budget carries the preemptions of one suite entry across its runs.
    const unregister = o.priority === "background" ? d.background.register(own, o.budget ?? PREEMPT_BUDGET) : () => undefined;
    const signal = AbortSignal.any([o.signal, lost.signal, own.signal]);
    let handle: SlotHandle | null = null;
    let held: Held<T>;
    try {
      if (o.priority === "foreground") {
        const preempt = d.preemptForeground ?? (async () => { await (await import("../../verify/wiring")).preemptBackgroundVerification(); });
        await preempt();
      }
      const acquire = d.acquire ?? acquireSlot;
      while (handle === null) {
        if (signal.aborted) break;
        const r = await acquire({
          max: d.slotMax ?? DEFAULT_SLOT_MAX, waitMs: SLOT_WAIT_MS, signal, meta: { cwd: o.cwd, command: o.command }, onLost: () => lost.abort(),
        });
        if (!("busy" in r)) handle = r;
        else if (o.priority === "foreground") d.background.preemptOne();
      }
      if (handle === null) return why(o.signal, lost.signal.aborted, false);
      try {
        const value = await body(signal);
        // QA-3.2-13: whatever the body returned, a run whose signal fired (abort, preemption, lost slot) is no result.
        held = signal.aborted || handle.lost ? why(o.signal, lost.signal.aborted || handle.lost, true) : { ok: true, value };
      } catch (e) {
        // A child killed by the signal rejects: that is the signal's outcome, not a spawn error.
        if (!signal.aborted && !handle.lost) throw e;
        held = why(o.signal, lost.signal.aborted || handle.lost, true);
      }
    } finally {
      unregister();
      if (handle !== null) await handle.release();
    }
    // QA-3.2-36: an abort that fired while the slot was being released still wins over the result.
    return held.ok && o.signal.aborted ? why(o.signal, false, true) : held;
  }

  /**
   * The outcome of a run some signal stopped. The outer signal (abort, dispose) wins: the caller asked for the stop, so
   * it is `interrupted`, never a verdict. Then a lost slot; else only the preemption signal is left.
   */
  function why(outer: AbortSignal, lostSlot: boolean, held: boolean): Held<never> {
    if (outer.aborted) return { ok: false, reason: "interrupted", message: held ? "the run was aborted" : "aborted while waiting for a verification slot" };
    if (lostSlot) return { ok: false, reason: "slot-lost", message: "the verification slot was reclaimed while held" };
    return { ok: false, reason: "preempted", message: "a foreground check preempted this background run" };
  }

  async function exec(c: ResolvedCommand, cwd: string, signal: AbortSignal, low: boolean): Promise<CommandOutput> {
    if (c.resolution === undefined) return d.spawn(c, { cwd: c.cwd ?? cwd, signal, lowPriority: low });
    const env = { ...c.resolution.env };
    for (const [key, value] of Object.entries(c.env ?? {})) {
      // Node keeps only one spelling on Windows; an explicit Path must replace an inherited PATH too.
      if (process.platform === "win32") for (const inherited of Object.keys(env)) {
        if (inherited.toUpperCase() === key.toUpperCase()) delete env[inherited];
      }
      env[key] = value;
    }
    return d.spawn({ ...c, env }, { cwd: c.cwd ?? cwd, signal, lowPriority: low });
  }

  function asExec(o: CommandOutput): ExecResult {
    return { code: o.exitCode ?? -1, stdout: o.stdout, stderr: o.stderr, timedOut: o.timedOut };
  }

  function search(cwd: string, signal: AbortSignal): TestSearchSeam {
    const git = async (root: string, args: readonly string[]) => {
      try {
        const r = await d.spawn(
          { label: "git", file: "git", args: ["--no-optional-locks", "-C", root, ...args], source: "run-command", ref: null, cwd },
          { cwd, signal, lowPriority: true },
        );
        return r.timedOut ? undefined : r;
      } catch {
        return undefined;
      }
    };
    const abs = (root: string, text: string) => splitNul(text).map(rel => nodePath.resolve(root, rel));
    const lit = (n: string) => n.replace(/[*?[\]\\]/g, c => (c === "\\" ? "[\\\\]" : `[${c}]`));
    return {
      async findByName(gitRoot, names) {
        const r = await git(gitRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...names.map(n => `:(glob)**/${lit(n)}`)]);
        return r !== undefined && r.exitCode === 0 ? abs(gitRoot, r.stdout) : undefined;
      },
      async findByContent(gitRoot, needle, globs, options) {
        const r = await git(gitRoot, ["grep", "-l", "-z", "-F", ...(options?.word === true ? ["-w"] : []), "--untracked", "-e", needle, "--", ...globs]);
        if (r === undefined) return undefined;
        if (r.exitCode === 1) return [];
        return r.exitCode === 0 ? abs(gitRoot, r.stdout) : undefined;
      },
    };
  }

  function component(name: ComponentResult["name"], c: ResolvedCommand, o: CommandOutput, scope: ComponentResult["scope"], flakyIds: string[] = []): ComponentResult {
    return { name, label: c.label, exitCode: o.exitCode, timedOut: o.timedOut, durationMs: o.durationMs, scope, flakyIds };
  }

  /** Only scope a known invocation. A ref named `test` can resolve to an unrelated configured command. */
  function scopedCommand(c: ResolvedCommand): string | null {
    // The planner derives its own cwd/environment; it cannot prove equivalence with explicit overrides.
    if (c.cwd !== undefined || c.env !== undefined) return null;
    if (c.source === "package-script" && c.ref?.script === "test" && c.ref.args.length === 0) return "npm test";
    return c.source === "pytest" ? c.label : null;
  }

  /** M10/M11: one tests component, scoped to the affected tests, with one confirmation rerun of the failing files. */
  async function runTests(
    t: TestComponent, cwd: string, changed: readonly ChangedPath[], signal: AbortSignal, low: boolean,
  ): Promise<TestOutcome> {
    const command = scopedCommand(t.full);
    if (command === null) return fullTests(t, command, cwd, signal, low);
    const plan = await planScopedRun({
      command, cwd, changedFiles: changed, budget: { maxWorkers: MAX_WORKERS }, fs: nodeFs, search: search(cwd, signal),
    });
    if (isNoAffected(plan)) {
      const none: CommandOutput = { exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 0 };
      return { comp: component("tests", { ...t.full, label: "no affected tests" }, none, "no-affected"), failing: null };
    }
    // Unscoped or unverifiable: never counted as verified without a run, so the full command decides.
    if (!isScopedSpec(plan)) return fullTests(t, command, cwd, signal, low);
    const spec: ResolvedCommand = { ...t.full, file: plan.file, args: plan.args, env: plan.env, cwd: plan.cwd };
    const out = await exec(spec, cwd, signal, low);
    const result = await readResult(plan, asExec(out), nodeFs);
    const comp = component("tests", spec, out, "spec");
    if (out.exitCode === 0 && !out.timedOut && !result.collectionError && result.complete) return { comp, failing: null };
    const first: Failing = { ids: [...result.failingIds], files: [...result.failingFiles], output: tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES) };
    // M10/M11: a timeout or a collection error is a final failure.
    if (out.timedOut || result.collectionError) return { comp, failing: first };
    // QA-3.2-7: an incomplete report (exit 0 or not), or a failure that names no id, is no evidence either way: the
    // full command decides, the partial report never blames (and an id-less failure is never confirmed away).
    if (!result.complete || first.ids.length === 0) return fullTests(t, command, cwd, signal, low);
    return confirm(t, command, cwd, signal, low, comp, first);
  }

  /** QA-3.2-22/-24: the files of `files` that exist; a test id names a rerunnable file only then. */
  async function existing(files: readonly string[]): Promise<string[]> {
    const exists = d.fileExists ?? fileExistsOnDisk;
    const out: string[] = [];
    for (const f of files) if (await exists(f)) out.push(f);
    return out;
  }

  /** The full test command: exit 0 without a timeout passes; a failure names the ids its output lists (QA-3.2-1). */
  async function runFull(c: ResolvedCommand, cwd: string, signal: AbortSignal, low: boolean) {
    const out = await exec(c, cwd, signal, low);
    const pass = out.exitCode === 0 && !out.timedOut;
    return { out, pass, seen: pass || out.timedOut ? null : observeFull(out, c.cwd ?? cwd), output: tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES) };
  }

  async function fullTests(t: TestComponent, command: string | null, cwd: string, signal: AbortSignal, low: boolean): Promise<TestOutcome> {
    const f = await runFull(t.full, cwd, signal, low);
    const comp = component("tests", t.full, f.out, "full");
    if (f.pass) return { comp, failing: null };
    // M11 calls an id flaky only against a complete id inventory whose files all exist (QA-3.2-22: a file the rerun
    // planner drops would leave its ids unrun, and an unrun id must never read as flaky).
    const seen = f.seen;
    const failing: Failing = { ids: seen?.ids ?? [], files: seen?.files ?? [], output: f.output };
    if (command === null || seen === null || !seen.complete || (await existing(seen.files)).length < seen.files.length) return { comp, failing };
    return confirm(t, command, cwd, signal, low, comp, failing);
  }

  /**
   * M11: one confirmation rerun of the failing files. Only a passing run with a complete report clears an id
   * (QA-3.2-7); an incomplete rerun clears nothing and the full command is the second observation instead.
   */
  async function confirm(t: TestComponent, command: string, cwd: string, signal: AbortSignal, low: boolean, comp: ComponentResult, first: Failing): Promise<TestOutcome> {
    const runner = await detectRunner(command, cwd, nodeFs);
    if (isUnverifiable(runner)) return { comp, failing: first };
    const again = await planRerun(runner, first.files, cwd, { maxWorkers: MAX_WORKERS }, { fs: nodeFs });
    if (!isScopedSpec(again)) return { comp, failing: first };
    const rerunSpec: ResolvedCommand = { ...t.full, file: again.file, args: again.args, env: again.env, cwd: again.cwd };
    const out = await exec(rerunSpec, cwd, signal, low);
    const result = await readResult(again, asExec(out), nodeFs);
    const sure = !out.timedOut && !result.collectionError;
    if (!sure || result.complete) {
      const seen = sure ? { ids: result.failingIds, complete: true } : null;
      return settle(component("tests", rerunSpec, out, "rerun"), first, confirmedOf(first.ids, sure && out.exitCode === 0, seen), tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES));
    }
    const f = await runFull(t.full, cwd, signal, low);
    return settle(component("tests", t.full, f.out, "full"), first, confirmedOf(first.ids, f.pass, f.seen), f.output);
  }

  /** M11: the original ids a second observation confirms. Only a pass clears them; a second failure naming none keeps them all. */
  function confirmedOf(ids: readonly string[], pass: boolean, seen: { ids: readonly string[]; complete: boolean } | null): string[] {
    if (pass) return [];
    const hit = seen !== null && seen.complete ? ids.filter(id => seen.ids.includes(id)) : [];
    return hit.length > 0 ? hit : [...ids];
  }

  function settle(comp: ComponentResult, first: Failing, failingNow: string[], output: string): TestOutcome {
    const judged: ComponentResult = { ...comp, flakyIds: first.ids.filter(id => !failingNow.includes(id)) };
    return { comp: judged, failing: failingNow.length === 0 ? null : { ids: failingNow, files: first.files, output } };
  }

  /**
   * QA-3.2-6: regression files come from the slot that observed them (the `ci` slot, absolute). Each is re-rooted under
   * `cwd`: the part below the plan slot (or integration worktree) that holds it, else the path as given if relative.
   * An absolute path under no known root is kept; the rerun then cannot map it and does not pass.
   */
  async function reroot(files: readonly string[], cwd: string): Promise<string[]> {
    if (files.length === 0) return [];
    const l = d.ledger();
    const roots = [l.integration.worktree, ...(await d.pool.list(l.planId)).map(r => r.path)];
    return files.map(f => {
      if (!nodePath.isAbsolute(f)) return nodePath.join(cwd, f);
      for (const root of roots) {
        const rel = nodePath.relative(root, f);
        if (rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel)) return nodePath.join(cwd, rel);
      }
      return f;
    });
  }

  /**
   * QA-3.2-6/-24/-26: the regression of a revert, judged on its own ids. A test command reruns the regression files
   * that exist here. With none (no file given, a file `reroot` could not map, the culprit's own test file reverted
   * away), an unscoped run, a non-test command or an incomplete report, the whole command runs instead: a run that
   * ran nothing never passes the regression. A passing run passes. A failing run fails with the regression ids it
   * names, and with every regression id when it names none of them (fail closed: another id form, or another failure
   * hiding them, cannot clear the regression).
   */
  async function regressionTests(
    c: ResolvedCommand, ids: readonly string[], files: readonly string[], cwd: string, signal: AbortSignal, low: boolean,
  ): Promise<TestOutcome> {
    const fail = (named: readonly string[], output: string): Failing => {
      const still = ids.filter(id => named.includes(id));
      return { ids: still.length > 0 ? still : [...ids], files: [...files], output };
    };
    const present = await existing(files);
    const command = scopedCommand(c);
    if (present.length > 0 && command !== null) {
      const runner = await detectRunner(command, cwd, nodeFs);
      const plan = isUnverifiable(runner) ? runner : await planRerun(runner, present, cwd, { maxWorkers: MAX_WORKERS }, { fs: nodeFs });
      if (isScopedSpec(plan)) {
        const spec: ResolvedCommand = { ...c, file: plan.file, args: plan.args, env: plan.env, cwd: plan.cwd };
        const out = await exec(spec, cwd, signal, low);
        const result = await readResult(plan, asExec(out), nodeFs);
        const comp = component("regression", spec, out, "rerun");
        const output = tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES);
        if (out.timedOut || result.collectionError) return { comp, failing: fail([], output) };
        if (result.complete) return { comp, failing: out.exitCode === 0 ? null : fail(result.failingIds, output) };
      }
    }
    const f = await runFull(c, cwd, signal, low);
    return { comp: component("regression", c, f.out, "full"), failing: f.pass ? null : fail(f.seen?.ids ?? [], f.output) };
  }

  async function run(req: CheckRequest): Promise<CheckResult> {
    const started = d.clock.now();
    const components: ComponentResult[] = [];
    const elapsed = () => d.clock.now() - started;
    const err = (reason: CheckErrorReason, message: string): CheckResult => ({ verdict: "error", reason, message, components, durationMs: elapsed() });
    const cwd = req.slot.path;
    let selection: CheckSelection;
    let changed: ChangedPath[];
    try {
      await prepare(req.slot, req.candidate);
    } catch (e) {
      return err("prepare", errText(e));
    }
    let extraFiles: string[];
    try {
      selection = await select(cwd, req.candidate);
      changed = (await d.igit.diffNameStatus(cwd, req.base, req.candidate)).map(n => ({ path: nodePath.join(cwd, n.path), status: n.status }));
      extraFiles = await reroot(req.extra?.files ?? [], cwd);
    } catch (e) {
      return err(e instanceof CheckResolveError ? "resolve" : "prepare", errText(e));
    }
    const extraIds = req.extra?.ids ?? [];
    // QA-3.2-6: regression ids need test commands to rerun them; without the suite's, this commit's tests serve.
    let regression = extraIds.length > 0 && (req.extra?.commands ?? []).length === 0 ? selection.tests.map(t => t.full) : req.extra?.commands ?? [];
    try {
      regression = await Promise.all(regression.map(c => resolveForSlot(c, cwd)));
    } catch (e) {
      return err("resolve", errText(e));
    }
    if (extraIds.length > 0 && regression.length === 0) return err("resolve", "the regression ids have no test command to rerun them");
    if (selection.typecheck === null && selection.tests.length === 0 && selection.extras.length === 0 && regression.length === 0) {
      return { verdict: "pass", components, flakyIds: [], note: "no-checks", durationMs: elapsed() };
    }
    const low = req.priority === "background";
    const held = await underSlot({ signal: req.signal, priority: req.priority, cwd, command: "integration checks" }, async (signal): Promise<CheckResult | null> => {
      const simple = async (name: "typecheck" | "extra" | "regression", c: ResolvedCommand): Promise<CheckResult | null> => {
        const out = await exec(c, cwd, signal, low);
        components.push(component(name, c, out, "full"));
        if (out.exitCode === 0 && !out.timedOut) return null;
        return {
          verdict: "fail", components, failingIds: [], failingFiles: [], flakyIds: [], output: tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES), durationMs: elapsed(),
        };
      };
      if (selection.typecheck !== null) {
        const r = await simple("typecheck", selection.typecheck);
        if (r !== null) return r;
      }
      for (const t of selection.tests) {
        const o = await runTests(t, cwd, changed, signal, low);
        components.push(o.comp);
        if (o.failing !== null) {
          return { verdict: "fail", components, failingIds: o.failing.ids, failingFiles: o.failing.files, flakyIds: o.comp.flakyIds, output: o.failing.output, durationMs: elapsed() };
        }
      }
      for (const c of selection.extras) {
        const r = await simple("extra", c);
        if (r !== null) return r;
      }
      for (const c of regression) {
        // Without ids the regression is the whole command (an unattributed failure that passed at the phase base).
        if (extraIds.length === 0) {
          const r = await simple("regression", c);
          if (r !== null) return r;
          continue;
        }
        const o = await regressionTests(c, extraIds, extraFiles, cwd, signal, low);
        components.push(o.comp);
        if (o.failing !== null) {
          return { verdict: "fail", components, failingIds: o.failing.ids, failingFiles: o.failing.files, flakyIds: [], output: o.failing.output, durationMs: elapsed() };
        }
      }
      return null;
    }).catch((e: unknown): Held<CheckResult | null> => ({ ok: false, reason: "spawn", message: errText(e) }));
    if (!held.ok) return err(held.reason, held.message);
    if (held.value !== null) return held.value;
    return { verdict: "pass", components, flakyIds: components.flatMap(c => c.flakyIds), note: null, durationMs: elapsed() };
  }

  async function runCommands(req: CommandRunRequest): Promise<CommandRunResult> {
    const started = d.clock.now();
    const cwd = req.slot.path;
    const base = { ids: [] as string[], files: [] as string[], idsUnparsed: false, scope: "full" as const, output: "", durationMs: 0, error: null };
    const done = (r: Partial<CommandRunResult> & { verdict: CommandRunResult["verdict"] }): CommandRunResult => ({ ...base, ...r, durationMs: d.clock.now() - started });
    if (req.prepare) {
      try {
        await prepare(req.slot, req.commit);
      } catch (e) {
        return done({ verdict: "error", error: { reason: "prepare", message: errText(e) } });
      }
    }
    let commands: ResolvedCommand[];
    try {
      commands = await Promise.all(req.commands.map(c => resolveForSlot(c, cwd)));
    } catch (e) {
      return done({ verdict: "error", error: { reason: "resolve", message: errText(e) } });
    }
    const low = req.priority === "background";
    const held = await underSlot({ signal: req.signal, priority: req.priority, cwd, command: "integration commands", budget: req.preempt }, async (signal): Promise<CommandRunResult> => {
      const ids = new Set<string>();
      const files = new Set<string>();
      let output = "";
      let unparsed = false;
      let failed = false;
      let scope: CommandRunResult["scope"] = req.mode === "full" ? "full" : "rerun";
      for (const c of commands) {
        const command = scopedCommand(c);
        if (typeof req.mode !== "string" && command !== null) {
          const wanted = [...new Set(req.mode.rerun.map(fileOfId))].map(f => nodePath.resolve(cwd, f));
          const runner = await detectRunner(command, cwd, nodeFs);
          const plan = isUnverifiable(runner) ? runner : await planRerun(runner, wanted, cwd, { maxWorkers: MAX_WORKERS }, { fs: nodeFs });
          if (isNoAffected(plan)) {
            // QA-3.2-22: where the failure was observed, a rerun that maps to no test ran nothing: a failure, never a pass.
            if (req.requireRun === true) {
              failed = true;
              unparsed = true;
              output = `the rerun ran no test: ${wanted.length} failing file(s) map to no test file`;
            }
            continue;
          }
          if (isScopedSpec(plan)) {
            const spec: ResolvedCommand = { ...c, file: plan.file, args: plan.args, env: plan.env, cwd: plan.cwd };
            const out = await exec(spec, cwd, signal, low);
            const result = await readResult(plan, asExec(out), nodeFs);
            // QA-3.2-1 (3): a rerun passes only on a complete result; exit 0 alone is not evidence.
            if (out.exitCode === 0 && !out.timedOut && result.complete && !result.collectionError) continue;
            if (out.timedOut || (out.exitCode !== 0 && result.failingIds.length > 0)) {
              failed = true;
              output = tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES);
              for (const id of result.failingIds) ids.add(id);
              for (const f of result.failingFiles) files.add(f);
              if (!result.complete || result.collectionError || out.timedOut) unparsed = true;
              continue;
            }
            // An incomplete result (or a failure without ids): fall back to the full command below.
          }
        }
        scope = "full";
        const out = await exec(c, cwd, signal, low);
        if (out.exitCode !== 0 || out.timedOut) {
          failed = true;
          output = tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES);
          // QA-3.2-1 (1): the failing ids of a full test run come from its output (vitest/jest `FAIL <file> > …`,
          // pytest `FAILED <file>::…`, a jest JSON report). An incomplete inventory, a timeout or output without ids
          // leaves the failure unattributable.
          const seen = out.timedOut ? null : observeFull(out, c.cwd ?? cwd);
          if (seen === null) {
            unparsed = true;
            break;
          }
          for (const id of seen.ids) ids.add(id);
          for (const f of seen.files) files.add(f);
          // QA-3.2-22: ids whose files do not exist here (a vitest root or a delegating script elsewhere) cannot be rerun
          // by file: the failure is unattributable, so reruns and probes run the full commands.
          if (!seen.complete || (await existing(seen.files)).length < seen.files.length) unparsed = true;
        }
      }
      // Every failure path without ids sets `unparsed`, so a parsed failure always names at least one id.
      return done({ verdict: failed ? "fail" : "pass", ids: [...ids].sort(), files: [...files].sort(), idsUnparsed: failed && unparsed, scope, output });
    }).catch((e: unknown): Held<CommandRunResult> => ({ ok: false, reason: "spawn", message: errText(e) }));
    if (!held.ok) return done({ verdict: "error", error: { reason: held.reason, message: held.message } });
    return held.value;
  }

  return { prepare, select, run, runCommands };
}
