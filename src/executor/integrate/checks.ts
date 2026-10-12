// src/executor/integrate/checks.ts
// Phase 3.2.2 (design memo 3.2.1, section 6 and decisions M8-M12, M30). Prepares slots (reset and clean), selects the
// integration checks, runs them under the machine-wide verification slot and holds the extra git operations of the
// integration queue. It journals nothing and registers nothing; 5.1 wires the resolver, the spawner and the guard.

import { readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import * as nodePath from "node:path";
import { hardeningArgs } from "../../router/git-tools";
import {
  detectRunner, isNoAffected, isScopedSpec, isUnverifiable, planRerun, planScopedRun, readResult,
  type ChangedPath, type RunnerFs, type TestSearchSeam,
} from "../../verify/runner";
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
  /** Extra environment for the child (scoped test specs). */
  env?: Readonly<Record<string, string>>;
  /** Working directory override (scoped test specs); default: the check's cwd. */
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
}
export interface CommandRunResult {
  verdict: "pass" | "fail" | "error"; ids: string[]; files: string[]; idsUnparsed: boolean;
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

export function createIntegrateGit(run: GitRunner, guard: WriteGuard): IntegrateGit {
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
      const specs = new Set<string>();
      for (const p of paths) {
        specs.add(`:(literal)${p}`);
        for (let dir = nodePath.posix.dirname(p); dir !== "." && dir !== "/" && dir !== ""; dir = nodePath.posix.dirname(dir)) specs.add(`:(literal)${dir}`);
      }
      if (specs.size === 0) return [];
      return splitNul(await ok(cwd, "ls-files", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", ...specs]));
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

/** In-process background (suite) runs that a foreground check may preempt, each at most `budget` times. */
export class BackgroundRuns {
  private readonly runs = new Set<{ c: AbortController; left: number }>();
  register(c: AbortController, budget: number): () => void {
    const entry = { c, left: budget };
    this.runs.add(entry);
    return () => { this.runs.delete(entry); };
  }
  preemptOne(): boolean {
    for (const entry of this.runs) {
      if (entry.left > 0 && !entry.c.signal.aborted) {
        entry.left -= 1;
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
}

const nodeFs: RunnerFs = {
  async fileExists(p) {
    try { await stat(p); return true; } catch { return false; }
  },
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

type Held<T> = { ok: true; value: T } | { ok: false; reason: CheckErrorReason; message: string };

interface TestOutcome {
  comp: ComponentResult;
  failing: { ids: string[]; files: string[]; output: string } | null;
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
    o: { signal: AbortSignal; priority: "foreground" | "background"; cwd: string; command: string },
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<Held<T>> {
    const lost = new AbortController();
    const own = new AbortController();
    const unregister = o.priority === "background" ? d.background.register(own, 3) : () => undefined;
    const signal = AbortSignal.any([o.signal, lost.signal, own.signal]);
    let handle: SlotHandle | null = null;
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
      if (handle === null) return why(o.signal, own.signal, lost.signal, false);
      const value = await body(signal);
      return handle.lost || lost.signal.aborted ? why(o.signal, own.signal, lost.signal, true) : own.signal.aborted && !o.signal.aborted
        ? why(o.signal, own.signal, lost.signal, true) : { ok: true, value };
    } finally {
      unregister();
      if (handle !== null) await handle.release();
    }
  }

  function why(outer: AbortSignal, own: AbortSignal, lostSignal: AbortSignal, held: boolean): Held<never> {
    if (lostSignal.aborted) return { ok: false, reason: "slot-lost", message: "the verification slot was reclaimed while held" };
    if (own.aborted && !outer.aborted) return { ok: false, reason: "preempted", message: "a foreground check preempted this background run" };
    return { ok: false, reason: "interrupted", message: held ? "the run was aborted" : "aborted while waiting for a verification slot" };
  }

  async function exec(c: ResolvedCommand, cwd: string, signal: AbortSignal, low: boolean): Promise<CommandOutput> {
    return d.spawn(c, { cwd: c.cwd ?? cwd, signal, lowPriority: low });
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

  /** M10/M11: one tests component, scoped to the affected tests, with one confirmation rerun of the failing files. */
  async function runTests(
    t: TestComponent, cwd: string, changed: readonly ChangedPath[], signal: AbortSignal, low: boolean,
  ): Promise<TestOutcome> {
    const command = t.framework === "node" ? "npm test" : t.full.label;
    const plan = await planScopedRun({
      command, cwd, changedFiles: changed, budget: { maxWorkers: MAX_WORKERS }, fs: nodeFs, search: search(cwd, signal),
    });
    if (isNoAffected(plan)) {
      const none: CommandOutput = { exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 0 };
      return { comp: component("tests", { ...t.full, label: "no affected tests" }, none, "no-affected"), failing: null };
    }
    if (!isScopedSpec(plan)) {
      // Unverifiable never counts as verified without a run: run the full command.
      const out = await exec(t.full, cwd, signal, low);
      const pass = out.exitCode === 0 && !out.timedOut;
      return { comp: component("tests", t.full, out, "full"), failing: pass ? null : { ids: [], files: [], output: tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES) } };
    }
    const spec: ResolvedCommand = { label: t.full.label, file: plan.file, args: plan.args, source: t.full.source, ref: t.full.ref, env: plan.env, cwd: plan.cwd };
    const out = await exec(spec, cwd, signal, low);
    const result = await readResult(plan, asExec(out), nodeFs);
    const text = tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES);
    if (out.exitCode === 0 && !out.timedOut && !result.collectionError && result.complete) {
      return { comp: component("tests", spec, out, "spec"), failing: null };
    }
    const ids = [...result.failingIds];
    if (out.timedOut || result.collectionError || ids.length === 0 || result.failingFiles.length === 0) {
      return { comp: component("tests", spec, out, "spec"), failing: { ids, files: [...result.failingFiles], output: text } };
    }
    // M11: one confirmation rerun of the failing files.
    const runner = await detectRunner(command, cwd, nodeFs);
    if (isUnverifiable(runner)) return { comp: component("tests", spec, out, "spec"), failing: { ids, files: [...result.failingFiles], output: text } };
    const again = await planRerun(runner, result.failingFiles, cwd, { maxWorkers: MAX_WORKERS }, { fs: nodeFs });
    if (!isScopedSpec(again)) return { comp: component("tests", spec, out, "spec"), failing: { ids, files: [...result.failingFiles], output: text } };
    const rerunSpec: ResolvedCommand = { label: t.full.label, file: again.file, args: again.args, source: t.full.source, ref: t.full.ref, env: again.env, cwd: again.cwd };
    const out2 = await exec(rerunSpec, cwd, signal, low);
    const result2 = await readResult(again, asExec(out2), nodeFs);
    const stillFailing = new Set(result2.failingIds);
    const confirmed = out2.exitCode === 0 && !out2.timedOut && !result2.collectionError ? [] : ids.filter(id => stillFailing.has(id));
    const unknown = confirmed.length === 0 && out2.exitCode !== 0;
    const failingNow = unknown ? ids : confirmed;
    const flaky = ids.filter(id => !failingNow.includes(id));
    const comp = component("tests", rerunSpec, out2, "rerun", flaky);
    if (failingNow.length === 0) return { comp, failing: null };
    return {
      comp,
      failing: { ids: failingNow, files: [...new Set(failingNow.map(fileOfId))].length > 0 ? [...result2.failingFiles] : [...result.failingFiles], output: tail(out2.stdout + out2.stderr, OUTPUT_TAIL_BYTES) },
    };
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
    try {
      selection = await select(cwd, req.candidate);
      changed = (await d.igit.diffNameStatus(cwd, req.base, req.candidate)).map(n => ({ path: nodePath.join(cwd, n.path), status: n.status }));
      for (const f of req.extra?.files ?? []) changed.push({ path: nodePath.join(cwd, f) });
    } catch (e) {
      return err(e instanceof CheckResolveError ? "resolve" : "prepare", errText(e));
    }
    const regression = req.extra?.commands ?? [];
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
        const r = await simple("regression", c);
        if (r !== null) return r;
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
    const base = { ids: [] as string[], files: [] as string[], idsUnparsed: false, output: "", durationMs: 0, error: null };
    const done = (r: Partial<CommandRunResult> & { verdict: CommandRunResult["verdict"] }): CommandRunResult => ({ ...base, ...r, durationMs: d.clock.now() - started });
    if (req.prepare) {
      try {
        await prepare(req.slot, req.commit);
      } catch (e) {
        return done({ verdict: "error", error: { reason: "prepare", message: errText(e) } });
      }
    }
    const low = req.priority === "background";
    const held = await underSlot({ signal: req.signal, priority: req.priority, cwd, command: "integration commands" }, async (signal): Promise<CommandRunResult> => {
      const ids = new Set<string>();
      const files = new Set<string>();
      let output = "";
      let unparsed = false;
      let failed = false;
      for (const c of req.commands) {
        const isTest = c.source === "pytest" || c.ref?.script === "test";
        if (typeof req.mode !== "string" && isTest) {
          const wanted = [...new Set(req.mode.rerun.map(fileOfId))].map(f => nodePath.resolve(cwd, f));
          const command = c.source === "pytest" ? c.label : "npm test";
          const runner = await detectRunner(command, cwd, nodeFs);
          const plan = isUnverifiable(runner) ? runner : await planRerun(runner, wanted, cwd, { maxWorkers: MAX_WORKERS }, { fs: nodeFs });
          if (isNoAffected(plan)) continue;
          if (isScopedSpec(plan)) {
            const spec: ResolvedCommand = { ...c, file: plan.file, args: plan.args, env: plan.env, cwd: plan.cwd };
            const out = await exec(spec, cwd, signal, low);
            const result = await readResult(plan, asExec(out), nodeFs);
            if (out.exitCode !== 0 || out.timedOut) {
              failed = true;
              output = tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES);
              for (const id of result.failingIds) ids.add(id);
              for (const f of result.failingFiles) files.add(f);
              if (!result.complete) unparsed = true;
            }
            continue;
          }
        }
        const out = await exec(c, cwd, signal, low);
        if (out.exitCode !== 0 || out.timedOut) {
          failed = true;
          unparsed = true;
          output = tail(out.stdout + out.stderr, OUTPUT_TAIL_BYTES);
          break;
        }
      }
      return done({ verdict: failed ? "fail" : "pass", ids: [...ids].sort(), files: [...files].sort(), idsUnparsed: failed && (unparsed || ids.size === 0), output });
    }).catch((e: unknown): Held<CommandRunResult> => ({ ok: false, reason: "spawn", message: errText(e) }));
    if (!held.ok) return done({ verdict: "error", error: { reason: held.reason, message: held.message } });
    return held.value;
  }

  return { prepare, select, run, runCommands };
}
