import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type { RouteLine } from "../../routing/classify/types";
import type { AnnotatedPlan, PlanStep } from "../../routing/engine";
import type { DurationModel } from "../../routing/outcomes/durations";
import {
  EXECUTOR_LIMITS,
  ExecutorError,
  LAUNCH_HEADER_PATTERN,
  PLAN_ID_PATTERN,
  ledgerViolations,
  type CompileSummary,
  type Edge,
  type ExecutorConfig,
  type JsonValue,
  type LedgerV1,
  type PhaseRecord,
  type PlanCompiler,
  type PlanId,
  type TaskId,
  type TaskNode,
  type TaskState,
  type Tier,
} from "../types";
import { Reach, buildEdges, conflictEdges, type EdgeTask } from "./edges";
import { formatSummary, planEstimate, taskEstimate } from "./estimate";
import {
  UNKNOWN_WRITES,
  extractFootprint,
  loadRepoView,
  repoViewFrom,
  type OwnershipInput,
  type RepoGit,
  type RepoView,
  type TaskFootprint,
} from "./footprint";
import { annotateUnrouted, parsePlan, type CompileIssue, type ParsedPhase, type ParsedPlan, type ParsedTask } from "./parse";
import {
  mergeResidueInto,
  parseResidue,
  residueOverflow,
  residueRequestOf,
  validateResidue,
  type ResidueCandidate,
} from "./residue";
import { isTopNode, validateLedger } from "./validate";

export { formatSummary };

// Plan compiler (memo 2.3.1 sections 1 and 9). No I/O except through `CompilerDeps`.

const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function baseName(p: string): string {
  const seg = p.split(/[\\/]/).filter((x) => x !== "");
  const last = seg[seg.length - 1] ?? "plan";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

/** Slug of the plan file name (plus the selected phases); at most 41 chars, else cut to 34 plus `-` and 6 hex of its sha1. */
export function planIdOf(planPath: string, phases: readonly string[] | undefined, doneBefore?: string): PlanId {
  let id = slug(baseName(planPath));
  // QA-2.3-17: `--` cannot occur inside a slugged phase id, so ["1.1.2"] and ["1.1","2"] stay distinct; doneBefore is part of the id.
  if (phases !== undefined && phases.length > 0) id = `${id}-${phases.map(slug).join("--")}`;
  if (doneBefore !== undefined) id = `${id}-db-${slug(doneBefore)}`;
  if (id === "") id = "plan";
  if (id.length > 41) id = `${id.slice(0, 34).replace(/-+$/, "")}-${sha1Hex(id).slice(0, 6)}`;
  if (!PLAN_ID_PATTERN.test(id)) id = `p-${sha1Hex(id).slice(0, 8)}`;
  return id;
}

function isAbsolutePlanPath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(p);
}

function inRangeOf(v: unknown, r: readonly [number, number], integer: boolean): boolean {
  return typeof v === "number" && Number.isFinite(v) && (!integer || Number.isInteger(v)) && v >= r[0] && v <= r[1];
}

/** Shape plus `EXECUTOR_LIMITS` check of a config; the first problem as text, else null. */
function configProblem(c: ExecutorConfig): string | null {
  const L = EXECUTOR_LIMITS;
  const checks: Array<[string, unknown, readonly [number, number], boolean]> = [
    ["maxParallel", c.maxParallel, L.maxParallel, true],
    ["batchMax", c.batchMax, L.batchMax, true],
    ["maxAttempts", c.maxAttempts, L.maxAttempts, true],
    ["qaMaxRounds", c.qaMaxRounds, L.qaMaxRounds, true],
    ["sharedContextChars", c.sharedContextChars, L.sharedContextChars, true],
    ["capacityCooldownMs", c.capacityCooldownMs, L.capacityCooldownMs, true],
    ["capacityPauseMs", c.capacityPauseMs, L.capacityPauseMs, true],
    ["wakeDebounceMs", c.wakeDebounceMs, L.wakeDebounceMs, true],
    ["circuitBreaker.failureRatio", c.circuitBreaker?.failureRatio, L.failureRatio, false],
    ["circuitBreaker.minAttempts", c.circuitBreaker?.minAttempts, L.minAttempts, true],
    ["circuitBreaker.consecutiveFailures", c.circuitBreaker?.consecutiveFailures, L.consecutiveFailures, true],
  ];
  for (const [name, v, r, integer] of checks) {
    if (!inRangeOf(v, r, integer)) return `config.${name} must be ${integer ? "an integer" : "a number"} in ${r[0]}..${r[1]}`;
  }
  if (c.approve !== "ask" && c.approve !== "auto") return "config.approve must be ask or auto";
  if (c.crossPhase !== "gate" && c.crossPhase !== "inferred") return "config.crossPhase must be gate or inferred";
  if (c.land !== "ff-when-clean" && c.land !== "manual") return "config.land must be ff-when-clean or manual";
  if (c.slotsDir !== null && typeof c.slotsDir !== "string") return "config.slotsDir must be a string or null";
  if (typeof c.python !== "string") return "config.python must be a string";
  // QA-2.3-17: the command-valued settings are checked here too, so a bad draft is rejected at the input.
  if (!(c.integrationChecks === "auto" || isRunCommandRefs(c.integrationChecks))) {
    return "config.integrationChecks must be \"auto\" or a list of {script, args}";
  }
  if (!(c.phaseSuite === "auto" || c.phaseSuite === "off" || isRunCommandRefs(c.phaseSuite))) {
    return "config.phaseSuite must be \"auto\", \"off\" or a list of {script, args}";
  }
  const prov: unknown = c.provision;
  const provOk = prov === "auto" || (typeof prov === "object" && prov !== null && !Array.isArray(prov)
    && Object.values(prov).every((m: unknown) => Array.isArray(m) && m.every(isStringArray)));
  if (!provOk) return "config.provision must be \"auto\" or a map of string[][]";
  return null;
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isRunCommandRefs(v: unknown): boolean {
  return Array.isArray(v) && v.every((r: unknown) => {
    if (typeof r !== "object" || r === null) return false;
    const o = r as { script?: unknown; args?: unknown };
    return typeof o.script === "string" && isStringArray(o.args);
  });
}

/** Deep copy of a JSON-shaped config. */
function cloneConfig(c: ExecutorConfig): ExecutorConfig {
  return JSON.parse(JSON.stringify(c)) as ExecutorConfig;
}

function checkInputs(
  planPath: string,
  opts: { config: ExecutorConfig; now: string; orchestratorSessionID: string },
): ExecutorConfig {
  if (typeof planPath !== "string" || !isAbsolutePlanPath(planPath)) {
    throw new ExecutorError("E_INVALID_INPUT", "planPath must be an absolute path", { planPath });
  }
  if (typeof opts.now !== "string" || !ISO_MS_RE.test(opts.now) || !Number.isFinite(Date.parse(opts.now))) {
    throw new ExecutorError("E_INVALID_INPUT", "now must be an ISO time with milliseconds", { now: String(opts.now) });
  }
  if (typeof opts.orchestratorSessionID !== "string" || opts.orchestratorSessionID === "") {
    throw new ExecutorError("E_INVALID_INPUT", "orchestratorSessionID must be a non-empty string", null);
  }
  if (typeof opts.config !== "object" || opts.config === null) {
    throw new ExecutorError("E_INVALID_INPUT", "config must be an object", null);
  }
  const problem = configProblem(opts.config);
  if (problem !== null) throw new ExecutorError("E_INVALID_INPUT", problem, null);
  return cloneConfig(opts.config);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared context (D2): worktree paths -> <worktree>, header-shaped lines removed, cap at the last newline.

const HEADER_REPLACEMENT = "[header-shaped line removed]";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rootRegex(root: string, ci: boolean): RegExp | null {
  const parts = root.split(/[\\/]+/).filter((x) => x !== "");
  if (parts.length === 0) return null;
  const lead = /^[\\/]{2}/.test(root) ? "[\\\\/]{2}" : /^[\\/]/.test(root) ? "[\\\\/]" : "";
  const body = parts.map(escapeRe).join("[\\\\/]+");
  return new RegExp(`${lead}${body}(?![A-Za-z0-9_.-])[\\\\/]*`, ci ? "gi" : "g");
}

function cutAtNewline(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const nl = text.lastIndexOf("\n", cap);
  if (nl > 0) return text.slice(0, nl).replace(/\s+$/, "");
  let end = cap;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function sharedContextOf(
  raw: string,
  roots: readonly string[],
  ci: boolean,
  cap: number,
  warnings: CompileIssue[],
): string {
  let text = raw;
  const ordered = [...new Set(roots)].sort((a, b) => b.length - a.length);
  for (const root of ordered) {
    const re = rootRegex(root, ci);
    if (re !== null) text = text.replace(re, (m) => (/[\\/]$/.test(m) ? `<worktree>${m.includes("/") && !m.includes("\\") ? "/" : "\\"}` : "<worktree>"));
  }
  const headerRe = new RegExp(LAUNCH_HEADER_PATTERN.source, LAUNCH_HEADER_PATTERN.flags.replace(/[gy]/g, ""));
  const lines = text.split(/\r\n|\n|\r/);
  let removed = 0;
  const kept = lines.map((l) => {
    if (!headerRe.test(l)) return l;
    removed += 1;
    return HEADER_REPLACEMENT;
  });
  if (removed > 0) {
    warnings.push({ code: "shared-context-header", line: 0, message: `${removed} header-shaped line(s) in the shared context were removed` });
  }
  text = kept.join("\n");
  const cut = cutAtNewline(text, cap);
  if (cut.length < text.length) {
    warnings.push({ code: "shared-context-truncated", line: 0, message: `shared context cut to ${cut.length} of ${text.length} chars` });
  }
  return cut;
}

// ---------------------------------------------------------------------------------------------------------------
// Edge-task helpers

const CONTRACT_TITLE_RE = /\b(?:contract|interface|types?|schema)\b/i;
const CONTRACT_VERB_RE = /\b(?:define|implement|create|add|write|extend|introduce|declare|export|update|modify|specify)\b/i;
const CONTRACT_FILE_RE = /(?:^|\/)(?:types\.ts|[^/]*\.d\.ts|schema[^/]*|contract[^/]*)$/i;

function isContractTask(title: string, writes: readonly string[]): boolean {
  if (CONTRACT_TITLE_RE.test(title) && CONTRACT_VERB_RE.test(title)) return true;
  // QA-2.3-32: a directory write also keeps its directory key (QA-2.3-16); that key (a prefix of another write) is not a file.
  const dirs = new Set<string>();
  for (const w of writes) {
    for (let cut = w.lastIndexOf("/"); cut > 0; cut = w.lastIndexOf("/", cut - 1)) dirs.add(w.slice(0, cut).toLowerCase());
  }
  return writes.some((w) => !dirs.has(w.toLowerCase()) && CONTRACT_FILE_RE.test(w));
}

function formatIssue(i: CompileIssue): string {
  return i.line > 0 ? `${i.code} L${i.line}: ${i.message}` : `${i.code}: ${i.message}`;
}

function edgeTaskOf(t: TaskNode, planIndex: number): EdgeTask {
  const top = isTopNode(t);
  return {
    id: t.id,
    phase: t.phase,
    kind: t.kind,
    planIndex,
    writes: top ? UNKNOWN_WRITES : t.footprint.writes,
    reads: t.footprint.reads,
    confidence: t.footprint.confidence,
    isContract: isContractTask(t.title, t.footprint.writes),
  };
}

function gateRef(phase: string): string {
  return `gate:${phase}`;
}

/** Phase gate dependencies derived from `gate:P -> task` edges (D7), in phase order. */
function dependsOnFrom(phases: readonly PhaseRecord[], tasks: Readonly<Record<string, TaskNode>>, edges: readonly Edge[]): void {
  const deps = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!e.from.startsWith("gate:")) continue;
    const from = e.from.slice("gate:".length);
    const to = tasks[e.to]?.phase ?? null;
    if (to === null || to === from) continue;
    const s = deps.get(to);
    if (s === undefined) deps.set(to, new Set([from]));
    else s.add(from);
  }
  const order = new Map(phases.map((p, i) => [p.id, i] as const));
  for (const p of phases) {
    const s = deps.get(p.id);
    p.dependsOn = s === undefined ? [] : [...s].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
}

function countPrior(tasks: readonly TaskNode[]): number {
  return tasks.filter((t) => t.kind !== "manual" && t.kind !== "preflight" && t.estimate.source === "prior").length;
}

// ---------------------------------------------------------------------------------------------------------------
// Dependencies

/** Everything the compiler touches outside memory; stubbed in tests. */
export interface CompilerDeps {
  fs: {
    readText(absPath: string): Promise<string>;
    /** Optional seam (QA-2.3-17): the real path of the common git dir, used as `repo.key`. */
    realpath?(absPath: string): Promise<string>;
  };
  git: RepoGit;
  /**
   * Optional seam (QA-2.3-3): the tracked files (repo-relative, '/'-separated) of the repository at `toplevel`, for
   * `addTasks`, which is synchronous. When absent, `addTasks` uses the files recorded by the last `compile` of the same
   * repository (`repo.key`) and, failing that, only the paths the ledger already knows.
   */
  listTrackedFiles?: (toplevel: string) => readonly string[];
  durations: DurationModel;
  /** Bound to `annotateSteps`. */
  annotate: (steps: readonly PlanStep[]) => Promise<AnnotatedPlan>;
  /** Roles policy class -> role (docs/ROLES.md); stubbed in tests. */
  roleOf: (route: RouteLine | null, tier: Tier | null) => string;
  /** `<defaultSlotsDir(toplevel, planId)>\integration` (O1). */
  integrationWorktree: (planId: PlanId, repo: LedgerV1["repo"]) => string;
}

const SETTLED: ReadonlySet<TaskState> = new Set<TaskState>(["done", "cancelled", "integrated"]);

/**
 * `PathOutcome` reasons for a spelling that leaves the repository (a write there is rejected by `addTasks`). A URL is not
 * among them (QA-2.3-23): it is never a write target, so it is ignored like a read.
 */
const OUTSIDE_REASONS: ReadonlySet<string> = new Set(["outside", "other-drive", "unc", "device", "escape"]);

function defaultCi(): boolean {
  return process.platform === "win32";
}

function dirOf(p: string): string {
  return /^(?:[A-Za-z]:|\\\\)/.test(p) ? win32.dirname(p) : posix.dirname(p);
}

function isTier(v: unknown): v is Tier {
  return v === "fast" || v === "medium" || v === "heavy";
}

async function gitText(git: RepoGit, args: readonly string[], cwd: string): Promise<string> {
  const r = await git.run(args, cwd);
  if (r.code !== 0) throw new ExecutorError("E_GIT", `git ${args.join(" ")} failed (exit ${r.code})`, { args: [...args], code: r.code });
  return r.stdout.trim();
}

async function readRepo(deps: CompilerDeps, toplevel: string): Promise<LedgerV1["repo"]> {
  const git = deps.git;
  const common = await gitText(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], toplevel);
  const branch = await git.run(["symbolic-ref", "--short", "HEAD"], toplevel);
  if (branch.code !== 0 || branch.stdout.trim() === "") {
    throw new ExecutorError("E_INVALID_INPUT", "check out the base branch before compiling a plan (detached HEAD)", null);
  }
  const baseBranch = branch.stdout.trim();
  // Resolve the branch ref afresh on every compile, never the plan directory's HEAD or a cached base.
  const baseCommit = await gitText(git, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`], toplevel);
  const abs = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(common) ? common : (/^[A-Za-z]:/.test(toplevel) ? win32.resolve(toplevel, common) : posix.resolve(toplevel, common));
  // QA-2.3-17: the key is the real path of the common git dir, so two spellings of one repository get one key.
  const key = deps.fs.realpath === undefined ? abs : await deps.fs.realpath(abs);
  return { key, toplevel, baseBranch, baseCommit };
}

// ---------------------------------------------------------------------------------------------------------------
// Selection

interface Selection {
  included: ParsedPhase[];
  selected: ReadonlySet<string>;
  earlier: ReadonlySet<string>;
}

function selectPhases(parsed: ParsedPlan, opts: { phases?: readonly string[]; doneBefore?: string }, warnings: CompileIssue[]): Selection {
  const byId = new Map(parsed.phases.map((p) => [p.id, p] as const));
  const order = new Map(parsed.phases.map((p, i) => [p.id, i] as const));
  const selected = new Set<string>();
  if (opts.phases === undefined) {
    for (const p of parsed.phases) selected.add(p.id);
  } else {
    if (opts.phases.length === 0) throw new ExecutorError("E_INVALID_INPUT", "phases must not be empty", null);
    for (const id of opts.phases) {
      const p = byId.get(id);
      if (p === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown phase ${id}`, { phase: id });
      if (p.dogfood) throw new ExecutorError("E_INVALID_INPUT", `phase ${id} is a dogfood phase and cannot be selected`, { phase: id });
      selected.add(id);
    }
    for (const p of parsed.phases) {
      if (p.synthetic && p.id.endsWith(".post") && selected.has(p.id.slice(0, -".post".length))) selected.add(p.id);
    }
  }
  const earlier = new Set<string>();
  if (opts.doneBefore !== undefined) {
    const at = order.get(opts.doneBefore);
    if (at === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown doneBefore phase ${opts.doneBefore}`, { phase: opts.doneBefore });
    for (const p of parsed.phases) if ((order.get(p.id) ?? 0) < at) earlier.add(p.id);
  }
  const included = parsed.phases.filter((p) => selected.has(p.id) || earlier.has(p.id));
  const includedIds = new Set(included.map((p) => p.id));
  for (const p of included) {
    if (!selected.has(p.id)) continue;
    for (const d of p.dependsOn) {
      if (includedIds.has(d.id)) continue;
      if (d.external && !byId.has(d.id)) {
        // QA-2.3-10: an external (dogfood) dependency cannot be checked here; the caller must vouch for it with doneBefore.
        if (opts.doneBefore === undefined) {
          throw new ExecutorError(
            "E_INVALID_INPUT",
            `phase ${p.id} depends on ${d.id}, which is not in this plan; pass doneBefore to run without it`,
            { phase: p.id, dependsOn: d.id },
          );
        }
        warnings.push({ code: "depends-external-unknown", line: d.line, message: `phase ${p.id} depends on ${d.id}, which is not in this plan; ignored (doneBefore is set)` });
        continue;
      }
      throw new ExecutorError(
        "E_INVALID_INPUT",
        `phase ${p.id} depends on ${d.id}, which is neither selected nor earlier than doneBefore`,
        { phase: p.id, dependsOn: d.id },
      );
    }
  }
  // QA-2.3-25: the same dependency rule for graph edges: an edge from a phase (or a task of a phase) that is neither
  // selected nor earlier than doneBefore into a selected phase would be dropped silently, so the run is refused.
  if (opts.phases !== undefined) {
    const taskPhase = new Map(parsed.tasks.map((t) => [t.id, t.phase] as const));
    const waveById = new Map(parsed.waves.map((w) => [w.id, w] as const));
    const phasesOf = (id: string): string[] => {
      if (byId.has(id)) return [id];
      const w = waveById.get(id);
      if (w !== undefined) return [...w.phases];
      const ph = taskPhase.get(id);
      return ph === undefined || ph === null ? [] : [ph];
    };
    for (const g of parsed.graphs) {
      for (const e of g.edges) {
        const into = phasesOf(e.to).filter((id) => selected.has(id));
        if (into.length === 0) continue;
        const outside = phasesOf(e.from).find((id) => !includedIds.has(id) && byId.get(id)?.dogfood !== true);
        if (outside === undefined) continue;
        throw new ExecutorError(
          "E_INVALID_INPUT",
          `graph edge ${e.raw.trim()} (line ${e.line}) comes from phase ${outside}, which is neither selected nor earlier than doneBefore`,
          { phase: into[0] ?? null, dependsOn: outside, line: e.line },
        );
      }
    }
  }
  return { included, selected, earlier };
}

// ---------------------------------------------------------------------------------------------------------------
// Node assembly

function ownershipOf(parsed: ParsedPlan, phase: string | null): OwnershipInput[] {
  if (phase === null) return [];
  return parsed.ownership.filter((r) => r.owners.includes(phase)).map((r) => ({ path: r.path, owners: r.owners, line: r.line }));
}

function nodeOf(
  deps: CompilerDeps,
  t: ParsedTask,
  phase: string | null,
  fp: TaskFootprint,
  state: TaskState,
  warnings: CompileIssue[],
): TaskNode {
  const manual = t.kind === "manual" || t.kind === "preflight";
  const fields = t.route?.fields ?? null;
  const tier: Tier | null = t.tierTag ?? (isTier(fields?.tier) ? fields.tier : null);
  const role = manual ? "" : deps.roleOf(fields, tier);
  const route: TaskNode["route"] = manual
    ? { line: "", role: "", tier: null, pin: false }
    : { line: t.route?.line ?? "", role, tier, pin: fields?.pin ?? false };
  let verify: TaskNode["verify"];
  if (manual) verify = "none";
  else if (t.verify !== null) verify = t.verify;
  else if (t.kind === "qa") verify = "none";
  else if (t.acceptance !== null || (fields?.detection !== undefined && fields.detection !== "none")) verify = "required";
  else {
    verify = "none";
    warnings.push({ code: "unverified-task", line: t.span.line, message: `task ${t.id} has no acceptance block or detection; it will not be verified` });
  }
  return {
    id: t.id,
    title: t.title,
    phase,
    kind: t.kind,
    text: t.text,
    subtasks: [...t.subtasks],
    route,
    verify,
    acceptance: t.acceptance,
    footprint: fp.footprint,
    estimate: taskEstimate(deps.durations, { kind: t.kind, state, role, tier, route: fields }),
    state,
    attempts: [],
    slot: null,
    branch: null,
    integrated: null,
  };
}

function footprintWarnings(t: ParsedTask, fp: TaskFootprint, out: CompileIssue[]): void {
  for (const i of fp.ignored) {
    out.push({ code: "path-ignored", line: i.line, message: `${t.id}: ${JSON.stringify(i.raw)} ignored (${i.reason})` });
  }
  for (const r of fp.foreignRoots) {
    out.push({ code: "foreign-root", line: t.span.line, message: `${t.id}: paths under ${r} were mapped into this repository` });
  }
  if (fp.ownershipAssumed) {
    out.push({
      code: "ownership-assumed",
      line: t.span.line,
      message: `${t.id}: no write evidence; assumed to write everything its phase owns (confidence inferred)`,
    });
  }
}

function summaryOf(l: LedgerV1, warnings: readonly string[]): CompileSummary {
  const tasks = Object.values(l.tasks);
  return {
    tasks: tasks.length,
    phases: l.phases.length,
    edges: l.edges.length,
    ...planEstimate(l, l.config.maxParallel),
    manual: tasks.filter((t) => t.kind === "manual" || t.kind === "preflight").map((t) => t.id),
    warnings: [...warnings],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Residue candidates

const UNRESOLVED_CODES: ReadonlySet<string> = new Set(["graph-node-unknown", "explicit-ref-unknown", "explicit-merged-first-unresolved"]);

function lexical(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function residueCandidates(a: {
  parsedTasks: ReadonlyMap<string, ParsedTask>;
  nodes: readonly TaskNode[];
  edges: readonly Edge[];
  phases: readonly PhaseRecord[];
  issues: readonly CompileIssue[];
  parsed: ParsedPlan;
  repo: RepoView;
}): ResidueCandidate[] {
  const out: ResidueCandidate[] = [];
  const byPhase = new Map<string, TaskNode[]>();
  for (const n of a.nodes) {
    if (n.phase === null || (n.kind !== "task" && n.kind !== "tests" && n.kind !== "fix")) continue;
    const l = byPhase.get(n.phase);
    if (l === undefined) byPhase.set(n.phase, [n]);
    else l.push(n);
  }
  // 1. consecutive hash-id steps (unannotated plans)
  for (const list of byPhase.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const u = list[i - 1] as TaskNode;
      const v = list[i] as TaskNode;
      if (a.parsedTasks.get(u.id)?.idSource === "hash" && a.parsedTasks.get(v.id)?.idSource === "hash") {
        out.push({ from: u.id, to: v.id, why: "consecutive steps without ids; the order between them is not stated" });
      }
    }
  }
  // 2. unresolved phrase / graph references
  for (const i of a.issues) {
    if (UNRESOLVED_CODES.has(i.code)) out.push({ from: "?", to: "?", why: formatIssue(i) });
  }
  // 3. ownership rows that no task of an owner phase mentions
  for (const row of a.parsed.ownership) {
    const p = lexical(row.path);
    for (const owner of row.owners) {
      if (!a.phases.some((ph) => ph.id === owner)) continue;
      const mine = a.nodes.filter((n) => n.phase === owner);
      const mentioned = mine.some((n) => [...n.footprint.writes, ...n.footprint.reads].some((x) => x === p || x.startsWith(`${p}/`) || p.startsWith(`${x}/`)));
      if (!mentioned) out.push({ from: owner, to: p, why: `ownership-unmatched L${row.line}: no task of ${owner} mentions ${p}` });
    }
  }
  // 4. concurrent same-phase pairs where v mentions u's id or a file u creates, without a Reads line
  const ids = a.nodes.map((n) => n.id);
  const phaseOf = new Map(a.nodes.map((n) => [n.id, n.phase] as const));
  const reach = new Reach(ids, (id) => phaseOf.get(id) ?? null, a.phases.map((p) => p.id));
  for (const e of a.edges) {
    if (phaseOf.has(e.to) && (phaseOf.has(e.from) || e.from.startsWith("gate:"))) {
      if (e.from.startsWith("gate:") && !a.phases.some((p) => `gate:${p.id}` === e.from)) continue;
      reach.add(e.from, e.to);
    }
  }
  for (const list of byPhase.values()) {
    for (let j = 1; j < list.length; j += 1) {
      const v = list[j] as TaskNode;
      const pv = a.parsedTasks.get(v.id);
      if (pv === undefined) continue;
      for (let i = 0; i < j; i += 1) {
        const u = list[i] as TaskNode;
        if (!reach.concurrent(u.id, v.id)) continue;
        const mentionsId = pv.body.includes(u.id);
        const created = u.footprint.writes.filter((w) => !a.repo.files.has(w) && !a.repo.dirs.has(w));
        const mentionsFile = pv.readsLine === null && created.some((w) => pv.body.includes(w));
        if (mentionsId || mentionsFile) {
          out.push({ from: u.id, to: v.id, why: mentionsId ? `${v.id} mentions ${u.id} but no order is stated` : `${v.id} mentions a file ${u.id} creates` });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Compiler

function draftInvalid(errors: ReadonlyArray<{ code: string; message: string; taskIds: readonly string[] }>, extra: readonly string[]): ExecutorError {
  const detail: JsonValue = {
    code: "draft-invalid",
    line: 0,
    violations: errors.map((e) => ({ code: e.code, message: e.message, taskIds: [...e.taskIds] })),
    ledger: [...extra],
  };
  const first = errors[0];
  return new ExecutorError("E_COMPILE", `compiled draft is invalid: ${first === undefined ? (extra[0] ?? "unknown") : `${first.code}: ${first.message}`}`, detail);
}

/** QA-2.3-22: warnings that make `addTasks` refuse a fragment (a reference it cannot resolve would be lost silently). */
const FAIL_CLOSED_CODES: ReadonlySet<string> = new Set(["explicit-ref-unknown", "graph-node-unknown", "depends-unknown"]);

/**
 * QA-2.3-2: `parsePlan` keeps a phrase or graph reference only when it names a node of the same text, so a fragment's
 * `before 1.1.2` to a ledger task would be dropped. The fragment is parsed a second time with one stub item per ledger
 * task appended (after a blank line, so the fragment's own items are untouched); only the phrases and graph blocks of
 * that second parse are used, the tasks, phases and ownership stay those of the fragment alone.
 */
function fragmentWithLedgerRefs(frag: ParsedPlan, text: string, ledger: LedgerV1): ParsedPlan {
  const ids = Object.keys(ledger.tasks).filter((id) => /^(?:T|P)?\d+(?:\.(?:\d+|[A-Z]{1,4}))+[a-z]?$/.test(id));
  if (ids.length === 0) return frag;
  const stubbed = `${text.replace(/\s+$/, "")}\n\n**Tasks**\n${ids.map((id) => `- **${id}** (ledger task)`).join("\n")}\n`;
  const withStubs = parsePlan(stubbed);
  const own = new Set(frag.tasks.map((t) => t.id));
  const fromLedger = (id: string): boolean => !own.has(id) && ids.includes(id);
  return {
    ...frag,
    phrases: withStubs.phrases.filter((p) => !fromLedger(p.subject.id)),
    graphs: withStubs.graphs,
    warnings: [
      ...frag.warnings.filter((w) => !FAIL_CLOSED_CODES.has(w.code)),
      ...withStubs.warnings.filter((w) => FAIL_CLOSED_CODES.has(w.code)),
    ],
  };
}

export function createPlanCompiler(deps: CompilerDeps): PlanCompiler {
  // Per-instance state (QA-2.3-13, QA-2.3-3), keyed by `repo.key`: the case flag (`core.ignorecase`) and the tracked files
  // read by `compile`. `mergeResidue`, `addTasks` and `validate` use them; a repository this instance never compiled
  // (a ledger resumed in a new process) falls back to the platform default and to the paths the ledger knows.
  const ciByRepo = new Map<string, boolean>();
  const filesByRepo = new Map<string, readonly string[]>();
  const ciFor = (repo: LedgerV1["repo"]): boolean => ciByRepo.get(repo.key) ?? defaultCi();

  async function compile(
    planPath: string,
    opts: { phases?: string[]; doneBefore?: string; config: ExecutorConfig; orchestratorSessionID: string; now: string },
  ): Promise<{ draft: LedgerV1; residueRequest?: { prompt: string; schema: JsonValue; taskIds: TaskId[] }; summary: CompileSummary }> {
    const config = checkInputs(planPath, opts);
    const text = await deps.fs.readText(planPath);
    const planDigest = sha256Hex(text);
    const cwd = dirOf(planPath);
    const view = await loadRepoView(deps.git, cwd);
    const ci = view.caseInsensitive;
    await deps.durations.load();

    const issues: CompileIssue[] = [];
    const parsed = await annotateUnrouted(parsePlan(text), deps.annotate);
    issues.push(...parsed.warnings);

    const sel = selectPhases(parsed, opts, issues);
    const includedIds = new Set(sel.included.map((p) => p.id));
    const wholePlan = opts.phases === undefined;
    const universe = parsed.tasks.filter((t) => (t.phase === null ? wholePlan : includedIds.has(t.phase)));
    const pp: ParsedPlan = {
      ...parsed,
      phases: sel.included,
      waves: parsed.waves.map((w) => ({ ...w, phases: w.phases.filter((id) => includedIds.has(id)) })).filter((w) => w.phases.length > 0),
      tasks: universe,
    };

    // footprints in plan order, then edges
    const created = new Set<string>();
    const fps = new Map<string, TaskFootprint>();
    const edgeTasks: EdgeTask[] = [];
    universe.forEach((t, i) => {
      const fp = extractFootprint(t, ownershipOf(parsed, t.phase), view, created);
      fps.set(t.id, fp);
      footprintWarnings(t, fp, issues);
      const top = fp.editing && fp.footprint.confidence === "unknown";
      edgeTasks.push({
        id: t.id,
        phase: t.phase,
        kind: t.kind,
        planIndex: i,
        writes: top ? UNKNOWN_WRITES : fp.footprint.writes,
        reads: fp.footprint.reads,
        confidence: fp.footprint.confidence,
        isContract: isContractTask(t.title, fp.footprint.writes),
      });
    });
    // QA-2.3-10 / QA-2.3-21: a prose reference to a phase, wave or task of the plan that is outside this run is not an
    // unresolved reference; it gets its own warning and does not feed the residue.
    const planNodes = new Set([...parsed.phases.map((p) => p.id), ...parsed.waves.map((w) => w.id), ...parsed.tasks.map((t) => t.id)]);
    const runNodes = new Set([...includedIds, ...pp.waves.map((w) => w.id), ...universe.map((t) => t.id)]);
    const built = buildEdges(pp, edgeTasks, { crossPhase: config.crossPhase, ci, planNodes });
    for (const w of built.warnings) {
      const ref = w.code === "explicit-ref-unknown" ? /^unknown (?:reference|subject) (\S+?):/.exec(w.message)?.[1] : undefined;
      if (ref !== undefined && planNodes.has(ref) && !runNodes.has(ref)) {
        issues.push({ code: "ref-outside-run", line: w.line, message: `${ref} is not part of this run: ${w.message}` });
      } else issues.push(w);
    }

    // doneBefore projection
    const materialized = new Set(universe.filter((t) => t.phase === null || sel.selected.has(t.phase)).map((t) => t.id));
    const phaseOfTask = new Map(universe.map((t) => [t.id, t.phase] as const));
    const edges: Edge[] = [];
    const seen = new Set<string>();
    for (const e of built.edges) {
      let from: string = e.from;
      let evidence = e.evidence;
      // buildEdges only knows the included phases, so every `gate:` source is part of this run.
      if (!from.startsWith("gate:") && !materialized.has(from)) {
        const ph = phaseOfTask.get(from) ?? null;
        if (ph === null || !includedIds.has(ph)) continue;
        from = `gate:${ph}`;
        evidence = `via ${from}; ${evidence}`;
      }
      if (!materialized.has(e.to)) continue;
      const key = `${from}>${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to: e.to, kind: e.kind, confidence: e.confidence, evidence });
    }

    // tasks
    const tasks: Record<string, TaskNode> = {};
    const parsedById = new Map<string, ParsedTask>();
    for (const t of universe) {
      if (!materialized.has(t.id)) continue;
      parsedById.set(t.id, t);
      const state: TaskState = t.phase !== null && sel.earlier.has(t.phase) ? "done" : "pending";
      tasks[t.id] = nodeOf(deps, t, t.phase, fps.get(t.id) as TaskFootprint, state, issues);
    }
    const nodes = Object.values(tasks);
    const qaCount = new Map<string, number>();
    for (const n of nodes) if (n.kind === "qa" && n.phase !== null) qaCount.set(n.phase, (qaCount.get(n.phase) ?? 0) + 1);

    // phases and waves
    const phases: PhaseRecord[] = sel.included.map((p) => ({
      id: p.id,
      title: p.title,
      wave: p.wave,
      dependsOn: [],
      gate: sel.earlier.has(p.id) ? "passed" : "pending",
      qaRound: 1,
      paused: false,
      tag: null,
    }));
    dependsOnFrom(phases, tasks, edges);
    const waves: LedgerV1["waves"] = [];
    for (const w of pp.waves) {
      const ids = phases.filter((p) => p.wave === w.id).map((p) => p.id);
      if (ids.length > 0) waves.push({ id: w.id, phases: ids });
    }
    for (const p of phases) {
      if (!waves.some((w) => w.id === p.wave)) waves.push({ id: p.wave, phases: phases.filter((q) => q.wave === p.wave).map((q) => q.id) });
    }

    const planId = planIdOf(planPath, opts.phases, opts.doneBefore);
    const repo = await readRepo(deps, view.toplevel);
    // QA-2.3-13 / QA-2.3-3: remember the case flag and the tracked files of this repository for the later calls.
    ciByRepo.set(repo.key, ci);
    filesByRepo.set(repo.key, [...view.files]);
    const roots = [view.toplevel, ...view.worktrees];
    const sharedContext = sharedContextOf(parsed.sharedContextRaw, roots, ci, config.sharedContextChars, issues);

    const draft: LedgerV1 = {
      schema: 1,
      planId,
      planPath,
      planDigest,
      repo,
      integration: { branch: `omr/${planId}/integration`, worktree: deps.integrationWorktree(planId, repo), head: repo.baseCommit },
      launcher: "A",
      status: "awaiting-approval",
      orchestrator: { sessionID: opts.orchestratorSessionID, boundAt: opts.now },
      config,
      sharedContext,
      waves,
      phases,
      tasks,
      edges,
      inbox: [],
      seq: 1,
    };

    // self-check: both validators must pass (bug guard)
    const errors = validateLedger(draft, { ci });
    const lv = ledgerViolations(draft);
    if (errors.length > 0 || lv.length > 0 || draft.seq !== 1) {
      throw draftInvalid(errors, lv.map((v) => `${v.code} at ${v.at}`));
    }

    // residue
    const overflow = residueOverflow(draft);
    if (overflow > 0) issues.push({ code: "residue-capped", line: 0, message: `${overflow} editing task(s) over the residue cap keep their write set unrefined (unknown ones stay top; ownership-assumed ones keep the paths their phase owns)` });
    const candidates = residueCandidates({ parsedTasks: parsedById, nodes, edges, phases, issues, parsed: pp, repo: view });
    const residueRequest = residueRequestOf(draft, candidates);
    if (residueRequest !== undefined) draft.status = "awaiting-residue";

    if (nodes.length > 0 && countPrior(nodes) * 2 > nodes.filter((n) => n.kind !== "manual" && n.kind !== "preflight").length) {
      issues.push({ code: "estimate-prior", line: 0, message: "most estimates come from the 8-minute prior (no timing history)" });
    }
    const summary = summaryOf(draft, issues.map(formatIssue));
    return residueRequest === undefined ? { draft, summary } : { draft, residueRequest, summary };
  }

  function mergeResidue(draft: LedgerV1, responseText: string): { draft: LedgerV1; summary: CompileSummary } {
    const ci = ciFor(draft.repo);
    const checked = validateResidue(draft, parseResidue(responseText), { ci });
    if (!checked.ok) {
      throw new ExecutorError("E_RESIDUE", `residue rejected (${checked.code} at ${checked.at})`, { code: checked.code, at: checked.at, detail: checked.detail });
    }
    const merged = mergeResidueInto(draft, checked.value, { ci });
    const rest = merged.edges.filter((e) => e.kind !== "conflict");
    const all = Object.values(merged.tasks);
    const phaseOf = new Map(all.map((t) => [t.id, t.phase] as const));
    const reach = new Reach(all.map((t) => t.id), (id) => phaseOf.get(id) ?? null, merged.phases.map((p) => p.id));
    for (const e of rest) {
      if (phaseOf.has(e.to) && (phaseOf.has(e.from) || merged.phases.some((p) => `gate:${p.id}` === e.from))) reach.add(e.from, e.to);
    }
    const live = all.map((t, i) => edgeTaskOf(t, i)).filter((t) => !SETTLED.has(merged.tasks[t.id]?.state ?? "pending"));
    const conflicts = conflictEdges(live, reach, ci);
    const next: LedgerV1 = { ...merged, edges: [...rest, ...conflicts], status: "awaiting-approval" };
    const errors = validateLedger(next, { ci });
    const lv = ledgerViolations(next);
    if (errors.length > 0 || lv.length > 0) {
      throw new ExecutorError("E_RESIDUE", "the merged residue leaves an invalid plan", {
        code: "residue-invalid",
        violations: errors.map((e) => ({ code: e.code, message: e.message, taskIds: [...e.taskIds] })),
        ledger: lv.map((v) => `${v.code} at ${v.at}`),
      });
    }
    return { draft: next, summary: summaryOf(next, []) };
  }

  /**
   * The contract allows only E_CYCLE and E_INVALID_INPUT: a parse failure (E_COMPILE) becomes E_INVALID_INPUT.
   * QA-2.3-22: a reference the fragment cannot resolve (`explicit-ref-unknown`, `graph-node-unknown`, `depends-unknown`)
   * fails closed with E_INVALID_INPUT; every other warning is dropped, because the contract returns no warnings.
   */
  function addTasks(ledger: LedgerV1, text: string): { tasks: TaskNode[]; edges: Edge[]; reopened: TaskId[] } {
    try {
      return addTasksChecked(ledger, text);
    } catch (e) {
      if (e instanceof ExecutorError && e.code === "E_COMPILE") {
        throw new ExecutorError("E_INVALID_INPUT", e.message, e.detail ?? null);
      }
      throw e;
    }
  }

  function addTasksChecked(ledger: LedgerV1, text: string): { tasks: TaskNode[]; edges: Edge[]; reopened: TaskId[] } {
    const frag = fragmentWithLedgerRefs(parsePlan(text), text, ledger);
    if (frag.tasks.length === 0) throw new ExecutorError("E_INVALID_INPUT", "the fragment contains no tasks", null);
    const ci = ciFor(ledger.repo);
    const phaseIds = new Set(ledger.phases.map((p) => p.id));
    const taken = new Set(Object.keys(ledger.tasks).map((k) => k.toLowerCase()));

    // repo view: the tracked files (seam, else the files recorded at compile); only when neither exists, the paths the
    // ledger already knows (this method is synchronous, so no git here)
    const tracked = deps.listTrackedFiles?.(ledger.repo.toplevel) ?? filesByRepo.get(ledger.repo.key);
    const known = new Set<string>(tracked ?? []);
    if (tracked === undefined) {
      for (const t of Object.values(ledger.tasks)) for (const p of [...t.footprint.writes, ...t.footprint.reads]) known.add(p);
    }
    const view = repoViewFrom({
      toplevel: ledger.repo.toplevel,
      worktrees: [ledger.repo.toplevel, ledger.integration.worktree],
      files: [...known],
      caseInsensitive: ci,
    });

    const created = new Set<string>();
    const issues: CompileIssue[] = [];
    const base = Object.keys(ledger.tasks).length;
    const newNodes: TaskNode[] = [];
    const edgeTasks: EdgeTask[] = [];
    frag.tasks.forEach((t, i) => {
      const folded = t.id.toLowerCase();
      if (taken.has(folded)) throw new ExecutorError("E_INVALID_INPUT", `task id ${t.id} already exists in the ledger`, { taskId: t.id });
      taken.add(folded);
      const prefix = t.id.includes(".") ? t.id.slice(0, t.id.lastIndexOf(".")) : null;
      const phase = t.phase !== null && phaseIds.has(t.phase) ? t.phase : prefix !== null && phaseIds.has(prefix) ? prefix : null;
      if (phase === null) throw new ExecutorError("E_INVALID_INPUT", `task ${t.id} belongs to no phase of the ledger`, { taskId: t.id, phase: t.phase });
      // QA-2.3-3: a phase whose gate has passed is closed; a task added there would never be waited for.
      if (ledger.phases.find((p) => p.id === phase)?.gate === "passed") {
        throw new ExecutorError("E_INVALID_INPUT", `phase ${phase} has already passed its gate; task ${t.id} cannot be added to it`, { taskId: t.id, phase });
      }
      // QA-2.3-33: the phase's QA reviews every task of the phase, so it must still be able to wait for a new one.
      const phaseQa = Object.values(ledger.tasks).find((x) => x.phase === phase && x.id.toLowerCase() === `${phase}.qa`.toLowerCase());
      if (phaseQa !== undefined && phaseQa.state !== "pending" && phaseQa.state !== "ready") {
        throw new ExecutorError("E_INVALID_INPUT", `the phase's QA has already started (${phaseQa.id} is ${phaseQa.state}); add task ${t.id} to a later phase`, { taskId: t.id, phase, qa: phaseQa.id });
      }
      const fp = extractFootprint(t, ownershipOf(frag, t.phase), view, created);
      // QA-2.3-2: a write path that leaves the repository is rejected here, not silently dropped.
      const outside = fp.ignored.find((x) => x.write === true && OUTSIDE_REASONS.has(x.reason));
      if (outside !== undefined) {
        throw new ExecutorError("E_INVALID_INPUT", `task ${t.id} writes ${JSON.stringify(outside.raw)}, which is outside the repository (${outside.reason})`, { taskId: t.id, path: outside.raw, reason: outside.reason });
      }
      footprintWarnings(t, fp, issues);
      const node = nodeOf(deps, t, phase, fp, "pending", issues);
      newNodes.push(node);
      edgeTasks.push({ ...edgeTaskOf(node, base + i), writes: fp.editing && fp.footprint.confidence === "unknown" ? UNKNOWN_WRITES : fp.footprint.writes });
    });
    const newIds = new Set(newNodes.map((n) => n.id));

    // QA-2.3-2: references of the fragment resolve against the ledger and the fragment together. The ledger's tasks
    // and phases are passed to the edge passes (earlier in plan order) so `before X`, `Depends on:` and graph blocks can
    // name them; only the edges that involve a new task are kept.
    const existing = Object.values(ledger.tasks);
    const fragPhaseIds = new Set(frag.phases.map((p) => p.id));
    // QA-2.3-19: the phase view comes from the ledger (`dependsOn`, `waves`), so a new task gets the gate edges of its phase.
    const ledgerDeps = (id: string): Array<{ id: string; external: boolean; line: number }> =>
      (ledger.phases.find((q) => q.id === id)?.dependsOn ?? []).map((d) => ({ id: d, external: false, line: 0 }));
    const fragView: ParsedPlan = {
      ...frag,
      phases: [
        ...ledger.phases.filter((p) => !fragPhaseIds.has(p.id)).map((p): ParsedPhase => ({
          id: p.id, title: p.title, wave: p.wave, span: { line: 0, endLine: 0 }, dogfood: false, synthetic: false,
          dependsOn: ledgerDeps(p.id), order: null, fixTemplate: null, intro: "", newTests: null,
        })),
        ...frag.phases.map((p): ParsedPhase => (phaseIds.has(p.id) ? { ...p, dependsOn: [...ledgerDeps(p.id), ...p.dependsOn.filter((d) => !ledger.phases.some((q) => q.id === p.id && q.dependsOn.includes(d.id)))] } : p)),
      ],
      // the fragment's own wave headings are not used: its tasks must belong to phases of the ledger
      waves: ledger.waves.map((w, i) => ({ id: w.id, title: "", line: i + 1, phases: [...w.phases] })),
    };
    const built = buildEdges(fragView, [...existing.map((t, i) => edgeTaskOf(t, i)), ...edgeTasks], { crossPhase: ledger.config.crossPhase, ci });
    // QA-2.3-22: a reference the fragment cannot resolve fails closed instead of being dropped silently.
    const unresolved = [...frag.warnings, ...built.warnings].find((w) => FAIL_CLOSED_CODES.has(w.code));
    if (unresolved !== undefined) {
      throw new ExecutorError("E_INVALID_INPUT", `the fragment has an unresolved reference: ${formatIssue(unresolved)}`, { code: unresolved.code, line: unresolved.line });
    }
    const newEdges: Edge[] = [];
    const seen = new Set(ledger.edges.map((e) => `${e.from}>${e.to}`));
    const push = (e: Edge): void => {
      const key = `${e.from}>${e.to}`;
      if (seen.has(key)) return;
      seen.add(key);
      newEdges.push(e);
    };
    for (const e of built.edges) {
      if (e.from.startsWith("gate:") && !phaseIds.has(e.from.slice("gate:".length))) {
        throw new ExecutorError("E_INVALID_INPUT", `edge ${e.from} -> ${e.to} names a phase that is not in the ledger`, { from: e.from, to: e.to });
      }
      const fromNew = newIds.has(e.from);
      const toNew = newIds.has(e.to);
      if (!fromNew && !toNew) continue;
      if (e.kind === "structural") {
        // QA-2.3-19: existing -> new (pre-flight, gates, earlier stages) and new -> existing while that task can still wait.
        if (!toNew) {
          const state = ledger.tasks[e.to]?.state;
          if (state !== "pending" && state !== "ready") {
            // QA-2.3-33: the target is past ready (e.g. `<phase>.TESTS` done); the new task is linked to the target's
            // successors instead, transitively, until a task that can still wait (as D3 contracts a virtual item).
            if (fromNew) {
              const visited = new Set<string>([e.to]);
              const queue: string[] = [e.to];
              for (const cur of queue) {
                for (const s of ledger.edges) {
                  if (s.kind !== "structural" || s.from !== cur || visited.has(s.to)) continue;
                  visited.add(s.to);
                  const sState = ledger.tasks[s.to]?.state;
                  if (sState === "pending" || sState === "ready") push({ ...e, to: s.to });
                  else if (ledger.tasks[s.to] !== undefined) queue.push(s.to);
                }
              }
            }
            continue;
          }
        }
      }
      // conflicts and contracts are recomputed below with the whole ledger's reach; keep the new-to-new ones only
      if ((e.kind === "conflict" || e.kind === "contract") && !(fromNew && toNew)) continue;
      if (fromNew && !toNew) {
        const state = ledger.tasks[e.to]?.state;
        if (state !== "pending" && state !== "ready") {
          throw new ExecutorError("E_INVALID_INPUT", `edge ${e.from} -> ${e.to}: ${e.to} is ${state ?? "unknown"} and cannot wait for a new task`, { from: e.from, to: e.to });
        }
      }
      push(e);
    }

    // conflicts against the live tasks of the ledger (existing tasks come first in plan order)
    const allTasks = [...Object.values(ledger.tasks), ...newNodes];
    const phaseOf = new Map(allTasks.map((t) => [t.id, t.phase] as const));
    const reach = new Reach(allTasks.map((t) => t.id), (id) => phaseOf.get(id) ?? null, ledger.phases.map((p) => p.id));
    for (const e of [...ledger.edges, ...newEdges]) {
      const fromKnown = e.from.startsWith("gate:") ? phaseIds.has(e.from.slice("gate:".length)) : phaseOf.has(e.from);
      if (phaseOf.has(e.to) && fromKnown) reach.add(e.from, e.to);
    }
    const live = [
      ...Object.values(ledger.tasks).filter((t) => !SETTLED.has(t.state)).map((t, i) => edgeTaskOf(t, i)),
      ...edgeTasks,
    ];
    for (const e of conflictEdges(live, reach, ci)) if (newIds.has(e.to)) push(e);

    // the extended ledger must stay acyclic and closed for every new task
    const trialTasks: Record<string, TaskNode> = { ...ledger.tasks };
    for (const n of newNodes) trialTasks[n.id] = n;
    const trial: LedgerV1 = { ...ledger, tasks: trialTasks, edges: [...ledger.edges, ...newEdges] };
    const problems = validateLedger(trial, { ci }).filter((e) => e.code === "cycle" || e.taskIds.some((id) => newIds.has(id)));
    const cycle = problems.find((e) => e.code === "cycle");
    if (cycle !== undefined) throw new ExecutorError("E_CYCLE", cycle.message, { cycle: [...cycle.taskIds], evidence: [] });
    if (problems.length > 0) {
      throw new ExecutorError("E_INVALID_INPUT", `added tasks are invalid: ${problems[0]?.message ?? ""}`, {
        violations: problems.map((e) => ({ code: e.code, message: e.message, taskIds: [...e.taskIds] })),
      });
    }

    const reopened: TaskId[] = [];
    for (const e of newEdges) {
      const target = ledger.tasks[e.to];
      if (target === undefined || target.state !== "ready" || reopened.includes(e.to)) continue;
      // every reopen candidate comes from a new task (still pending), so a ready target always has to wait for it
      reopened.push(e.to);
    }
    return { tasks: newNodes, edges: newEdges, reopened };
  }

  return { compile, mergeResidue, addTasks, validate: (ledger) => validateLedger(ledger, { ci: ciFor(ledger.repo) }) };
}
