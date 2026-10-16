// Plan-task verification over the dispatch verification engine (Phase 5.1, D8-D11, A-5.1-4/-8/-9/-12/-13).
import { realpathSync } from "node:fs";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import type { PlanTaskContext, PlanTaskVerdict, PlanTaskVerifier } from "../executor/runtime";
import { stripOrchestratorShell, leaseHolderID, type Attempt, type SlotLease, type TaskNode, type Verdict as SlotVerdict } from "../executor/types";
import { createGitRunner } from "../executor/git";
import { hardeningArgs } from "../router/git-tools";
import type { HeadState } from "./head";
import { snapshotTree } from "./tree";
import type { Artefact, Delegation, GateDeps, GateResult } from "./gate";
import { accept, unverifiableGateResult } from "./gate";
import { applyDispatchCaveats, isRetryableVerdict, parseNameStatusZ, type PreparedVerification, type VerificationWiring } from "./wiring";
import { normalizeDoD, type DoD } from "./dod";
import { buildDelegationDoD } from "./dispatch";
import { atLeastProducerTier, isIncompleteVerdict } from "./checker";
import { createDeadline } from "./deterministic";
import { graderTimeoutMs, RouterTimeoutError, withTimeout } from "./timeout";
import { neutralizeDirectives } from "./pending";
import { scrubText } from "../guard/scrub";
import type { BudgetSnapshot } from "../guard/enforce";
import { resolveRolesRouting, resolveVerifyBudget, type RouterConfig } from "../router/config";
import { PLAN_TASK_PERIMETER_ID, planPerimeter } from "./perimeter";
import { resolveRoles } from "../router/roles";
import { verificationScope } from "../routing/roles/work-root";
import { resolveCheckPlacements } from "../routing/roles/check-placement";

/** The change store the wiring's begin/prepare share with the dispatch path (index.ts `changedFileStore`). */
type ChangeStore = Parameters<VerificationWiring["prepareVerification"]>[0];

/** A git invocation in the slot through the router's hardened argv (index.ts supplies it). */
export type PlanTaskGit = (args: readonly string[], cwd: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The ports of the dispatch verification engine one plugin instance hands to its plan-task verifier (D8). */
export interface PlanTaskVerifierDeps {
  changedFileStore: ChangeStore;
  beginVerificationBounded: VerificationWiring["beginVerificationBounded"];
  prepareVerification: VerificationWiring["prepareVerification"];
  buildGateDeps: VerificationWiring["buildGateDeps"];
  /** Handoff 24: the producer's guard budget when the task returned. */
  captureBudget(childSessionID: string, capReached: boolean | undefined): BudgetSnapshot | undefined;
  readCapReached(childSessionID: string): boolean | undefined;
  /** M6: a real verdict of the task's child feeds the outcome store, as a dispatch verdict does. */
  onVerdict?(childSessionID: string, verdict: GateResult["verdict"]): void;
  /** Best-effort abort of a grader session after a gate timeout. */
  abortSession(sessionID: string): Promise<void>;
  getConfig(): RouterConfig;
  git: PlanTaskGit;
  exemptions: LeaseSelfExemptions;
  /** Restart fallback: whether a perimeter would be planned for this id in the slot (index.ts: perimeter.ts planPerimeter). */
  perimeterPlanned?(id: string, slotPath: string): boolean | Promise<boolean>;
  /** A-5.1-9 backoff; injectable for tests. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
  log?(message: string, detail?: unknown): void;
}

/** A-5.1-9: the checks pass of a plan-task gate gets at least ten minutes. */
export const PLAN_TASK_CHECKS_MIN_MS = 600_000;
/** A-5.1-9: the grader pass gets the grader timeout plus one minute of slack. */
export const PLAN_TASK_GRADER_SLACK_MS = 60_000;
/** A-5.1-9: at most two internal re-runs of a transient unverifiable. */
export const PLAN_TASK_TRANSIENT_RERUNS = 2;
/** A-5.1-9: backoff before the first and the second re-run. */
export const PLAN_TASK_RERUN_BACKOFF_MS: readonly number[] = [30_000, 60_000];
/** Findings returned to the runtime are capped. */
export const PLAN_TASK_FINDINGS_MAX = 4000;
/** The child's final text handed to the grader as its return text is capped (the grader prompt scrubs it again). */
export const PLAN_TASK_RETURN_TEXT_MAX = 32_000;

/**
 * Phase 5.1 (a): the artefact's `finalReturnText`: the child's own final text (trimmed as a dispatch's `<task_result>` is,
 * scrubbed, capped at PLAN_TASK_RETURN_TEXT_MAX), else the fixed description of the router's commit.
 */
export function planTaskReturnText(finalText: string | undefined, fallback: string): string {
  const text = finalText === undefined ? "" : scrubText(finalText.trim());
  if (text === "") return fallback;
  return text.length > PLAN_TASK_RETURN_TEXT_MAX ? `${text.slice(0, PLAN_TASK_RETURN_TEXT_MAX - 1)}…` : text;
}

/**
 * D8: a gate result as the runtime's slot verdict. Only an accepted pass passes; a fail fails; everything else (unverifiable,
 * accepted or not, an incomplete return, a pass strict-rejected for its caveats, a skip without a checkable DoD) is unverifiable.
 * Findings: reasons, then caveats, then notes (deduplicated, scrubbed, directive-neutralized), capped at PLAN_TASK_FINDINGS_MAX.
 * Ref: the verdict's method, with the grader tier when a grader judged.
 */
export function slotVerdictOf(res: GateResult): { verdict: SlotVerdict; findings: string; ref: string } {
  const v = res.verdict;
  const outcome = v.outcome ?? (v.pass ? "pass" : "fail");
  const verdict: SlotVerdict = v.skipped === true
    ? "unverifiable"
    : outcome === "fail"
      ? "fail"
      : outcome === "pass" && res.accepted && !isIncompleteVerdict(v)
        ? "pass"
        : "unverifiable";
  const lines: string[] = [];
  for (const line of [...v.reasons, ...(v.caveats ?? []), ...(v.notes ?? [])]) {
    const text = neutralizeDirectives(scrubText(line)).trim();
    if (text !== "" && !lines.includes(text)) lines.push(text);
  }
  if (verdict === "unverifiable" && outcome === "pass" && !res.accepted && v.skipped !== true) {
    lines.push("the pass carries caveats and enforcement.verify.strictUnverifiable rejects it");
  }
  let findings = lines.join("\n");
  if (findings.length > PLAN_TASK_FINDINGS_MAX) findings = `${findings.slice(0, PLAN_TASK_FINDINGS_MAX - 1)}…`;
  const ref = v.grader !== undefined ? `${v.method}:${v.grader.tier}` : v.method;
  return { verdict, findings, ref };
}

/** `plan:<orchestratorSessionID>:<planId>/<taskId>#<n>`: the change-store and perimeter id of one plan-task attempt. */
export function planTaskVerificationID(orchestratorSessionID: string, planId: string, taskId: string, attempt: number): string {
  return `plan:${orchestratorSessionID}:${planId}/${taskId}#${attempt}`;
}

/** Whether `id` is a plan-task verification id (A-5.1-12). */
export function isPlanTaskVerificationID(id: string): boolean {
  return PLAN_TASK_PERIMETER_ID.test(id);
}

/**
 * D11: during a plan-task gate, the task's own lease holders (its child and `plan:<plan>:<task>`) are excluded from the
 * testsPass lease wait for that slot tree only. index.ts's `leaseGate` wrapper reads this registry; holders of other plans,
 * and every holder of any other tree, are still waited for.
 */
export interface LeaseSelfExemptions {
  /** Exempts `holders` for the tree `root` until the returned release is called (idempotent). */
  exempt(root: string, holders: readonly string[]): () => void;
  /** The holders currently exempt for exactly the tree `root`; empty for any other tree. */
  exemptFor(root: string): ReadonlySet<string>;
}

/** The comparison key of a tree path: resolved, no trailing separator, case-folded on Windows (git reports `D:/x`, the pool `D:\x`). */
export function planTreeKey(root: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = (platform === "win32" ? win32.resolve(root) : posix.resolve(root)).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** `keyOf` canonicalizes a tree path (index.ts: `planTreeKey`). */
export function createLeaseSelfExemptions(keyOf: (root: string) => string): LeaseSelfExemptions {
  const byRoot = new Map<string, Map<symbol, readonly string[]>>();
  const empty: ReadonlySet<string> = new Set<string>();
  return {
    exempt(root, holders) {
      const key = keyOf(root);
      const token = Symbol("plan-task gate");
      const entries = byRoot.get(key) ?? new Map<symbol, readonly string[]>();
      entries.set(token, holders.filter((holder) => holder !== ""));
      byRoot.set(key, entries);
      return () => {
        const current = byRoot.get(key);
        if (current === undefined) return;
        current.delete(token);
        if (current.size === 0) byRoot.delete(key);
      };
    },
    exemptFor(root) {
      const entries = byRoot.get(keyOf(root));
      if (entries === undefined) return empty;
      return new Set([...entries.values()].flat());
    },
  };
}

/** The DoD of a plan task: its child-checkable acceptance, else the dispatch DoD inference over its text (A-5.1-4). */
export function planTaskDoD(task: Pick<TaskNode, "text" | "acceptance" | "title">): DoD {
  const acceptance = task.acceptance !== null && task.acceptance.trim() !== ""
    ? (/\[acceptance\]/i.test(task.acceptance) ? task.acceptance : `[acceptance]\n${task.acceptance}\n[/acceptance]`)
    : undefined;
  const dod = buildDelegationDoD({ prompt: task.text, description: task.title, ...(acceptance !== undefined ? { acceptance } : {}) });
  const criteria = dod.criteria.flatMap((line) => {
    const { kept } = stripOrchestratorShell(line);
    return kept === null ? [] : [kept];
  });
  const stripped = normalizeDoD({ ...dod, criteria });
  if (stripped.criteria.length > 0 || stripped.checks.length > 0) return stripped;
  // An empty child-checkable block is not a free pass. Remove embedded blocks too so inference cannot parse
  // the same shell-only block again; judge the dispatch exactly as a task with no acceptance block.
  const prompt = task.text.replace(/^\s*\[(acceptance|dod)\]\s*\r?\n[\s\S]*?^\s*\[\/\1\]\s*$/gim, "").trim();
  return buildDelegationDoD({ prompt, description: task.title });
}

/** The router's hardened git argv (no hooks, no user config side effects), run in `cwd`. */
export function planTaskGit(): PlanTaskGit {
  return async (args, cwd, timeoutMs) => {
    const result = await createGitRunner({ mode: "hardened", toplevel: cwd }).run([...hardeningArgs(), ...args], { cwd, timeoutMs });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}

/** QA-5.1-4: the reason of every verification cut by `dispose`. */
export const PLAN_TASK_SHUTDOWN_REASON = "the plugin is shutting down";
/** QA-5.1-4: how long `dispose` waits for the abort of one grader session. */
export const PLAN_TASK_ABORT_MS = 5_000;

/** QA-5.1-4: a wait cut by the verifier's `dispose`. */
class PlanTaskShutdownError extends Error {
  constructor() {
    super(PLAN_TASK_SHUTDOWN_REASON);
    this.name = "PlanTaskShutdownError";
  }
}

/** A-5.1-9: the checks pass deadline. */
export function planTaskChecksBudgetMs(gateBudgetMs: number): number {
  return Math.max(gateBudgetMs, PLAN_TASK_CHECKS_MIN_MS);
}

/** A-5.1-9: the grader pass deadline. */
export function planTaskGraderBudgetMs(gateBudgetMs: number, graderTier: string, override?: number): number {
  return Math.max(gateBudgetMs, graderTimeoutMs(graderTier, override) + PLAN_TASK_GRADER_SLACK_MS);
}

/** The grader ladder buildGateDeps hands the checker. */
const GRADER_LADDER = ["fast", "medium", "heavy"];

/**
 * The artefact's `producerTier` of a plan task: its role agent's name, as a role dispatch names its `subagent_type`. A role
 * producer is not on the grader ladder, so it ranks unknown and the grader is the top tier (checker.ts tierRank); the routed
 * tier would lower the grader. An unresolvable role keeps its role name (also unknown to the ladder).
 */
export function planTaskProducerTier(task: Pick<TaskNode, "route">, cfg: RouterConfig): string {
  try {
    const role = resolveRoles(cfg, "v2").get(task.route.role);
    if (role !== undefined && role.agent !== "") return role.agent;
  } catch {
    // The role name stands in.
  }
  return task.route.role;
}

/** The tier the checker grades a plan task on (checker.ts atLeastProducerTier: never below the producer or minGraderTier). */
export function graderTierFor(producerTier: string, cfg: RouterConfig): string {
  return atLeastProducerTier(producerTier, { ladder: GRADER_LADDER, minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null });
}

/** A-5.1-9: a transient unverifiable, re-run internally (never a fail, never a pass). */
export function isTransientPlanTaskResult(res: GateResult, cut = false): boolean {
  const v = res.verdict;
  if ((v.outcome ?? (v.pass ? "pass" : "fail")) !== "unverifiable" || v.skipped === true) return false;
  return isRetryableVerdict(v, cut) || [...v.reasons, ...(v.caveats ?? [])].some((reason) => reason.startsWith("grader dispatch failed:"));
}

/** D9: two passes of a mixed block combine to the stricter result; a pass needs both. */
export function combineMixedPasses(checks: GateResult, grader: GateResult): GateResult {
  // A skipped pass judged nothing: never a fail (gate.ts skips carry no outcome), never a pass.
  const outcome = (r: GateResult): string => r.verdict.skipped === true ? "unverifiable" : r.verdict.outcome ?? (r.verdict.pass ? "pass" : "fail");
  if (outcome(checks) === "fail" || checks.verdict.skipped === true) return checks;
  if (outcome(grader) === "fail") return grader;
  const reasons = [...checks.verdict.reasons, ...grader.verdict.reasons];
  const caveats = [...(checks.verdict.caveats ?? []), ...(grader.verdict.caveats ?? [])];
  const notes = [...(checks.verdict.notes ?? []), ...(grader.verdict.notes ?? [])];
  const passed = outcome(checks) === "pass" && outcome(grader) === "pass";
  const verdict: GateResult["verdict"] = {
    ...grader.verdict,
    pass: passed,
    outcome: passed ? "pass" : "unverifiable",
    reasons,
    ...(caveats.length > 0 ? { caveats } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(grader.verdict.skipped === true ? { skipped: true } : {}),
  };
  return { accepted: checks.accepted && grader.accepted, verdict, dodSource: checks.dodSource };
}

/** One attempt's observation state (begin, then observe before the router's commit). */
interface AttemptRecord {
  readonly id: string;
  readonly planId: string;
  readonly taskId: string;
  readonly n: number;
  readonly orchestratorSessionID: string;
  readonly base: string;
  readonly slotPath: string;
  readonly dod: DoD;
  readonly startedAt: number;
  observed?: Promise<{ ok: true; prepared: PreparedVerification } | { ok: false; reason: string }>;
}

const GIT_MS = 30_000;

/** D8: the plan-task verifier over one plugin instance's dispatch verification engine. */
export function createPlanTaskVerifier(deps: PlanTaskVerifierDeps): PlanTaskVerifier {
  const records = new Map<string, AttemptRecord>();
  /** The child's final text `observe` received per attempt (the latest non-empty one); independent of a begin record. */
  const finalTexts = new Map<string, string>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }));
  const now = deps.now ?? Date.now;
  const keyOf = (planId: string, taskId: string, n: number): string => `${planId}/${taskId}#${n}`;
  const warn = (message: string, detail?: unknown): void => { try { deps.log?.(message, detail); } catch { /* logging never fails a gate */ } };
  const git = async (args: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    try { return await deps.git(args, cwd, GIT_MS); }
    catch (error) { return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
  };
  const revParse = async (rev: string, cwd: string): Promise<string | null> => {
    const r = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd);
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
  };
  const clearIds = (id: string, child: string | null): void => {
    try { if (child !== null && child !== "") deps.changedFileStore.clear(child); } catch { /* best effort */ }
    try { deps.changedFileStore.clear(id); } catch { /* best effort */ }
  };
  /** QA-5.1-6/-14: the plan's orchestrator as the runtime read it from its ledger for this call; "" when unknown. */
  const orchestrator = (ctx: PlanTaskContext | undefined): string => {
    const id: unknown = ctx?.orchestratorSessionID;
    return typeof id === "string" ? id : "";
  };
  // QA-5.1-4: dispose cuts every in-flight deadline (prepare and gate passes), grader session and backoff sleep.
  let disposing = false;
  const shutdown = new AbortController();
  const live = new Set<{ deadline: ReturnType<typeof createDeadline>; graders: ReadonlySet<string> }>();
  /** Races `work` against dispose: rejects with PlanTaskShutdownError once dispose is called (already called: at once). */
  const untilStopped = async <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
    let onAbort = (): void => {};
    const stop = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new PlanTaskShutdownError());
      if (shutdown.signal.aborted || signal?.aborted) onAbort();
      else {
        shutdown.signal.addEventListener("abort", onAbort, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([work, stop]);
    } finally {
      shutdown.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  const unverifiable = (reason: string, dod?: DoD): { verdict: SlotVerdict; findings: string; ref: string } =>
    slotVerdictOf(unverifiableGateResult(reason, dod?.source ?? "inferred", false));
  /** QA-5.1-21: a verification dispose cut before it decided anything; the runtime discards it (never journaled). */
  const cutVerdict = (dod?: DoD): PlanTaskVerdict => ({ ...unverifiable(PLAN_TASK_SHUTDOWN_REASON, dod), cut: true });
  /** The wiring's own planning rule (A-5.1-12) under the current config; a planning error counts as planned (fail closed). */
  const perimeterWouldBePlanned = (id: string, slotPath: string): boolean => {
    try {
      return planPerimeter(id, slotPath, () => {
        const routing = resolveRolesRouting(deps.getConfig(), "v2");
        return { parents: routing.repoParents, depth: routing.repoDepth, exclude: routing.repoExclude };
      }) !== undefined;
    } catch {
      return true;
    }
  };

  async function prepare(record: AttemptRecord, attempt: Attempt, restoredHead?: Parameters<VerificationWiring["prepareVerification"]>[6], signal?: AbortSignal): Promise<{ ok: true; prepared: PreparedVerification } | { ok: false; reason: string }> {
    const deadline = createDeadline(resolveVerifyBudget(deps.getConfig()).gateBudgetMs);
    const entry = { deadline, graders: new Set<string>() };
    live.add(entry);
    const abort = (): void => deadline.abort(PLAN_TASK_SHUTDOWN_REASON);
    signal?.addEventListener("abort", abort, { once: true });
    if (disposing || signal?.aborted) abort();
    try {
      const prepared = await untilStopped(deps.prepareVerification(
        deps.changedFileStore, record.id, attempt.childSessionID ?? "", record.slotPath, deadline, record.startedAt, restoredHead,
        record.orchestratorSessionID, () => ({ source: "plan-task-change", callID: attempt.callID ?? record.id }),
        () => ({ planId: record.planId, taskId: record.taskId, attempt: record.n, phaseId: null, entryId: null,
          taskIds: [record.taskId], component: "verify", candidate: restoredHead?.head ?? null }),
      ), signal);
      return { ok: true, prepared };
    } catch (error) {
      return { ok: false, reason: `the change observation failed: ${scrubText(error instanceof Error ? error.message : String(error))}` };
    } finally {
      live.delete(entry);
      signal?.removeEventListener("abort", abort);
      deadline.dispose();
    }
  }

  async function begin(task: TaskNode, slot: SlotLease, attempt: Attempt, ctx?: PlanTaskContext): Promise<void> {
    const key = keyOf(slot.planId, task.id, attempt.n);
    const stale = records.get(key);
    if (stale !== undefined) clearIds(stale.id, null);
    records.delete(key);
    finalTexts.delete(key);
    // Never rejects: the runtime launches right after begin, and a missing record only means verify's fail-closed fallback.
    try {
      // The change-store and perimeter id of the attempt names the orchestrator at begin; verify reads the current one.
      const orchestratorSessionID = orchestrator(ctx);
      const id = planTaskVerificationID(orchestratorSessionID, slot.planId, task.id, attempt.n);
      const dod = planTaskDoD(task);
      const base = (await revParse("HEAD", slot.path)) ?? slot.commit;
      const startedAt = now();
      const record: AttemptRecord = { id, planId: slot.planId, taskId: task.id, n: attempt.n, orchestratorSessionID, base, slotPath: slot.path, dod, startedAt };
      records.set(key, record);
      // Reference capture under captureDepsFor's rules (wiring); bounded; never rejects.
      await deps.beginVerificationBounded(deps.changedFileStore, id, slot.path, dod);
    } catch (error) {
      records.delete(key);
      warn("plan-task verification could not begin; the attempt is verified fail closed", error);
    }
  }

  async function observe(task: TaskNode, slot: SlotLease, attempt: Attempt, finalText?: string, ctx?: PlanTaskContext): Promise<void> {
    const key = keyOf(slot.planId, task.id, attempt.n);
    // The child's claim is kept even without a begin record: verify's restart fallback grades it too.
    if (finalText !== undefined && finalText.trim() !== "") finalTexts.set(key, finalText);
    const record = records.get(key);
    // No begin record (a restart): verify takes the fail-closed fallback.
    if (record === undefined || record.observed !== undefined) return;
    // The cached observation is process-wide (it outlives an attachment): only its WAIT is bound to the attachment, never
    // the observation itself, so an attachment cut cannot cache a failed observation that the next attachment would grade.
    record.observed = prepare(record, attempt);
    // QA-5.1-4: dispose never waits for an observation (its deadline is aborted; verify then cuts).
    try { await untilStopped(record.observed, ctx?.signal); } catch { /* cut by dispose or attachment change */ }
  }

  async function forget(planId: string, taskId: string, n: number): Promise<void> {
    const key = keyOf(planId, taskId, n);
    const record = records.get(key);
    records.delete(key);
    finalTexts.delete(key);
    if (record !== undefined) clearIds(record.id, null);
  }

  /** D8 pre-checks and the change set between base and candidate. */
  async function candidateOf(task: TaskNode, slotPath: string, base: string): Promise<{ ok: true; candidate: string } | { ok: false; reason: string }> {
    if (task.branch === null) return { ok: false, reason: `task ${task.id} has no branch; the router's commit cannot be verified` };
    const head = await git(["symbolic-ref", "--quiet", "HEAD"], slotPath);
    if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${task.branch}`) {
      return { ok: false, reason: `the slot ${slotPath} is not on the task branch ${task.branch}; nothing ran` };
    }
    const candidate = await revParse("HEAD", slotPath);
    if (candidate === null) return { ok: false, reason: `the slot ${slotPath} has no readable HEAD; nothing ran` };
    const ancestor = await git(["merge-base", "--is-ancestor", base, candidate], slotPath);
    if (ancestor.code !== 0) return { ok: false, reason: `the slot reset commit ${base} is not an ancestor of ${candidate}; nothing ran` };
    return { ok: true, candidate };
  }

  async function committedFiles(slotPath: string, root: string, base: string, candidate: string): Promise<PreparedVerification["changedFiles"] | undefined> {
    const diff = await git(["diff", "--name-status", "-z", "-M", base, candidate, "--"], slotPath);
    if (diff.code !== 0) return undefined;
    return parseNameStatusZ(diff.stdout, root);
  }

  /** The restart fallback (no begin/observe record): fail closed, never a weaker gate. */
  async function fallback(task: TaskNode, slot: SlotLease, attempt: Attempt, orchestratorSessionID: string, signal?: AbortSignal): Promise<{ ok: true; record: AttemptRecord; prepared: PreparedVerification; trusted: false } | { ok: false; reason: string; dod: DoD }> {
    const dod = planTaskDoD(task);
    const id = planTaskVerificationID(orchestratorSessionID, slot.planId, task.id, attempt.n);
    const head = await revParse("HEAD", slot.path);
    if (head === null) return { ok: false, reason: `the slot ${slot.path} has no readable HEAD after a restart; nothing ran`, dod };
    // 1. The attempt trailer: the router's own commit of this attempt (runtime D11) is HEAD.
    const message = await git(["log", "-1", "--format=%B", head], slot.path);
    const trailer = message.code === 0 && attempt.nonce !== "" && message.stdout.includes(attempt.nonce);
    // 2. HEAD^1 == base: the router's commit sits directly on the reset commit, so the child committed nothing of its own.
    const base = slot.commit;
    const preCommit = trailer ? await revParse(`${head}^1`, slot.path) : head;
    if (preCommit === null || preCommit !== base) {
      return { ok: false, reason: `the attempt's observation was lost in a restart and the slot holds commits other than the router's (${preCommit ?? "unknown"} is not the reset commit ${base}); unverifiable`, dod };
    }
    // 3. Otherwise the restored head: the tree as the router left it is the dispatch-time head (the router's own switch is no switch).
    const top = await git(["rev-parse", "--show-toplevel"], slot.path);
    let root = slot.path;
    try { if (top.code === 0 && top.stdout.trim() !== "") root = realpathSync.native(top.stdout.trim()); } catch { /* the slot path stands in */ }
    const restoredHead: HeadState = { root, head, branch: task.branch };
    const record: AttemptRecord = { id, planId: slot.planId, taskId: task.id, n: attempt.n, orchestratorSessionID, base, slotPath: slot.path, dod, startedAt: Date.parse(attempt.startedAt) || now() };
    if (await (deps.perimeterPlanned ?? perimeterWouldBePlanned)(id, slot.path)) {
      return { ok: false, reason: "the attempt's observation was lost in a restart and its perimeter would be planned; the other repositories cannot be judged; unverifiable", dod };
    }
    const observed = await prepare(record, attempt, restoredHead, signal);
    if (!observed.ok) return { ok: false, reason: observed.reason, dod };
    if (observed.prepared.perimeter !== undefined && observed.prepared.perimeter.roots.length > 0) {
      return { ok: false, reason: "the attempt's observation was lost in a restart and its perimeter would be planned; the other repositories cannot be judged; unverifiable", dod };
    }
    // The observed files are lost; the commit diff (unioned by verify) is the whole change of a single router commit.
    return { ok: true, record, prepared: { ...observed.prepared, changedFiles: [], changeBaseline: "available" }, trusted: false };
  }

  async function runPass(
    passDoD: DoD, budgetMs: number, record: AttemptRecord, task: TaskNode, slot: SlotLease, attempt: Attempt,
    artefact: Artefact, prepared: PreparedVerification, parent: string, signal?: AbortSignal,
  ): Promise<{ res: GateResult; cut: boolean }> {
    // Bind this pass's wait to its attachment as well as plugin shutdown; the gate remains directly awaited.
    const untilShutdown = <T>(work: Promise<T>): Promise<T> => untilStopped(work, signal);
    const cfg = deps.getConfig();
    const strict = cfg.enforcement?.verify?.strictUnverifiable;
    const scope = verificationScope(passDoD.cwd, slot.path);
    const placement = resolveCheckPlacements(passDoD, scope, {});
    const deadline = createDeadline(budgetMs);
    const graders = new Set<string>();
    const entry = { deadline, graders };
    live.add(entry);
    const abort = (): void => deadline.abort(PLAN_TASK_SHUTDOWN_REASON);
    signal?.addEventListener("abort", abort, { once: true });
    const completedFailures: string[] = [];
    const child = attempt.childSessionID ?? "";
    const tree = prepared.snapshot?.root ?? slot.path;
    const releases = [tree, slot.path].map((root) => deps.exemptions.exempt(root, [child, leaseHolderID(record.planId, task.id)]));
    try {
      // QA-5.1-14: the grader is parented to the plan's CURRENT orchestrator, as the runtime read it for this verify (an
      // adopt moves the plan; verify refused an unknown one before any gate ran).
      // The verify service observer rides on `prepared.service`, bound to this attempt's checked candidate.
      const gateDeps = deps.buildGateDeps(parent, graders, prepared, deadline, false, parent);
      gateDeps.deterministic.onFailure = (reason) => completedFailures.push(reason);
      const delegation: Delegation = {
        dod: passDoD,
        trivial: false,
        mode: "modeA",
        ...(scope.requested ? { cwd: scope.requested } : {}),
        ...(scope.workRoot !== undefined ? { workRoot: scope.workRoot } : {}),
        ...(scope.refused !== undefined ? { refusedCwd: scope.refused, cwdSource: "acceptance" as const } : {}),
        ...(placement.placements !== undefined ? { checkPlacements: placement.placements } : {}),
        ...(placement.refused !== undefined ? { refusedCheck: placement.refused } : {}),
      };
      if (disposing || signal?.aborted) throw new PlanTaskShutdownError();
      const res = await untilShutdown(withTimeout(accept(delegation, artefact, gateDeps), deadline.remaining(), "verification gate"));
      return { res, cut: false };
    } catch (error) {
      if (error instanceof PlanTaskShutdownError || disposing || signal?.aborted) {
        // QA-5.1-4: dispose aborted the deadline and owns the grader aborts; the pass judged nothing and is never re-run.
        deadline.abort(PLAN_TASK_SHUTDOWN_REASON);
        if (signal?.aborted && !disposing) await Promise.allSettled([...graders].map((sessionID) =>
          withTimeout(deps.abortSession(sessionID), PLAN_TASK_ABORT_MS, "grader abort")));
        return { res: unverifiableGateResult(PLAN_TASK_SHUTDOWN_REASON, passDoD.source, strict), cut: false };
      }
      const timedOut = error instanceof RouterTimeoutError;
      deadline.abort(timedOut ? "verification gate timed out" : "verification gate failed");
      for (const sessionID of graders) {
        try { await deps.abortSession(sessionID); } catch { /* best effort: the gate result stands either way */ }
      }
      return {
        res: unverifiableGateResult(
          timedOut ? `verification gate timed out after ${budgetMs}ms` : `verification unavailable: ${scrubText(String(error))}`,
          passDoD.source, strict, completedFailures,
        ),
        cut: timedOut,
      };
    } finally {
      live.delete(entry);
      signal?.removeEventListener("abort", abort);
      deadline.dispose();
      for (const release of releases) release();
    }
  }

  async function verifyWithAttachment(signal: AbortSignal | undefined, task: TaskNode, slot: SlotLease, attempt: Attempt, parent: string,
    onDecided: (decided: PlanTaskVerdict) => void): Promise<PlanTaskVerdict> {
    const untilShutdown = <T>(work: Promise<T>): Promise<T> => untilStopped(work, signal);
    const key = keyOf(slot.planId, task.id, attempt.n);
    let record = records.get(key);
    let prepared: PreparedVerification;
    try {
      if (record?.observed !== undefined) {
        const observed = await untilShutdown(record.observed);
        if (!observed.ok) return unverifiable(observed.reason, record.dod);
        prepared = observed.prepared;
      } else {
        const restored = await fallback(task, slot, attempt, parent, signal);
        if (!restored.ok) return unverifiable(restored.reason, restored.dod);
        record = restored.record;
        prepared = restored.prepared;
      }
      // Fail closed: without the plan's orchestrator the id names no working set, so the perimeter could not be planned; and
      // without its current orchestrator the grader has no parent.
      if (record.orchestratorSessionID === "" || parent === "") return unverifiable(`the orchestrator of plan ${record.planId} could not be read; nothing ran`, record.dod);
      const checked = await candidateOf(task, slot.path, record.base);
      if (!checked.ok) return unverifiable(checked.reason, record.dod);
      const cfg = deps.getConfig();
      const budget = resolveVerifyBudget(cfg);
      if (disposing || signal?.aborted) return cutVerdict(record.dod);
      // A fresh snapshot after cleanForChecks: the tree the checks run on (materialize's drift check, the lease wait's tree).
      const controller = new AbortController();
      let fresh: PreparedVerification["snapshot"];
      let snapshotReason: string | undefined;
      const preparation = prepared.service?.start("service-prep", "slot-snapshot", checked.candidate);
      try {
        fresh = await withTimeout(snapshotTree(slot.path, AbortSignal.any([controller.signal, ...(signal === undefined ? [] : [signal])]), {
          lowPriority: budget.lowPriority,
          onError: (reason) => { snapshotReason = reason; },
        }), GIT_MS, "slot snapshot");
        preparation?.end("completed");
      } catch (error) {
        snapshotReason = error instanceof Error ? error.message : String(error);
        fresh = undefined;
      } finally {
        preparation?.end("error");
        controller.abort();
      }
      if (fresh === undefined) {
        const reason = snapshotReason === undefined ? "" : ` (${scrubText(snapshotReason).replace(/\s+/g, " ").trim().slice(0, 200)})`;
        return unverifiable(`the slot ${slot.path} could not be snapshotted after cleanForChecks${reason}; nothing ran`, record.dod);
      }
      const root = fresh.root ?? prepared.snapshot?.root ?? slot.path;
      const committed = await committedFiles(slot.path, root, record.base, checked.candidate);
      if (committed === undefined) return unverifiable(`the change between ${record.base} and ${checked.candidate} could not be read; nothing ran`, record.dod);
      const seen = new Set<string>();
      const changedFiles: PreparedVerification["changedFiles"] = [];
      for (const file of [...prepared.changedFiles, ...committed]) {
        const k = planTreeKey(isAbsolute(file.path) ? file.path : resolve(root, file.path));
        if (seen.has(k)) continue;
        seen.add(k);
        changedFiles.push(file);
      }
      const service = prepared.service;
      const boundService: PreparedVerification["service"] = service === undefined ? undefined : {
        start: (kind, stage, candidate = checked.candidate) => service.start(kind, stage, candidate),
        execution: (stage, candidate = checked.candidate) => service.execution(stage, candidate),
      };
      const gatePrepared: PreparedVerification = {
        ...prepared,
        graderDispatchLabel: `${task.id}#${attempt.n}`,
        ...(boundService === undefined ? {} : { service: boundService }),
        changedFiles,
        // The union is complete: the observed files and every path the candidate commits over the reset commit.
        changeBaseline: prepared.branchSwitch !== undefined ? "unavailable" : "available",
        snapshot: fresh,
      };
      const child = attempt.childSessionID ?? "";
      const producerTier = planTaskProducerTier(task, cfg);
      const childText = finalTexts.get(key);
      // QA-5.1-3: the child's own final text is held to the return contract, as a role dispatch's is (a progress note is
      // incomplete, never graded to a pass); the router's commit description is not a child return.
      const fromChild = childText !== undefined && planTaskReturnText(childText, "") !== "";
      const artefact: Artefact = {
        changedFiles: gatePrepared.changedFiles,
        changeBaseline: gatePrepared.changeBaseline,
        changeRoot: root,
        ...(prepared.branchSwitch !== undefined ? { branchSwitch: prepared.branchSwitch } : {}),
        ...(prepared.unattributedWriters !== undefined && prepared.unattributedWriters.length > 0 ? { unattributedWriters: prepared.unattributedWriters } : {}),
        ...(prepared.perimeter !== undefined ? { perimeter: prepared.perimeter } : {}),
        // Phase 5.1 (a): the grader judges the child's own claim, as a dispatch grader does; the commit description otherwise.
        finalReturnText: planTaskReturnText(childText,
          `plan task ${task.id} attempt ${attempt.n}: the router committed the slot's change as ${checked.candidate} over ${record.base}`),
        ...(fromChild ? { returnContract: true } : {}),
        declaredOutputs: record.dod.deliverable ? [record.dod.deliverable] : [],
        producerSessionID: child,
        producerTier,
        ...(child !== "" ? (() => { const b = deps.captureBudget(child, deps.readCapReached(child)); return b === undefined ? {} : { budget: b }; })() : {}),
      };
      const override = cfg.enforcement?.verify?.graderTimeoutMs;
      const graderTier = graderTierFor(producerTier, cfg);
      let reruns = 0;
      const current = record;
      const withReruns = async (passDoD: DoD, budgetMs: number): Promise<GateResult> => {
        for (;;) {
          const { res, cut } = await runPass(passDoD, budgetMs, current, task, slot, attempt, artefact, gatePrepared, parent, signal);
          if (signal?.aborted) return res;
          if (disposing || !isTransientPlanTaskResult(res, cut) || reruns >= PLAN_TASK_TRANSIENT_RERUNS) return res;
          const reason = scrubText([...new Set([...res.verdict.reasons, ...(res.verdict.caveats ?? [])])].join("; "))
            .replace(/\s+/g, " ").trim().slice(0, 200);
          const label = scrubText(`${task.id}#${attempt.n}`).replace(/\s+/g, " ").trim().slice(0, 200);
          warn(`plan-task verification retry ${reruns + 1} for ${label}: ${reason}`);
          // QA-5.1-4: dispose cancels the backoff (the transient result stands; verify already resolved as cut).
          const backoff = prepared.service?.start("service-wait", "retry-backoff", checked.candidate);
          let interrupted = true;
          try {
            try { await untilShutdown(sleep(PLAN_TASK_RERUN_BACKOFF_MS[reruns])); } catch { return res; }
            interrupted = false;
          } finally { backoff?.end(interrupted ? "interrupted" : "completed"); }
          reruns += 1;
        }
      };
      const dod = record.dod;
      let res: GateResult;
      if (dod.kind === "deterministic" && dod.checks.length > 0) {
        res = await withReruns(dod, planTaskChecksBudgetMs(budget.gateBudgetMs));
        // D9: checks first; on a pass, the grader judges the criteria; a check fail dispatches no grader.
        const outcome = res.verdict.outcome ?? (res.verdict.pass ? "pass" : "fail");
        if (dod.criteria.length > 0 && outcome === "pass" && res.verdict.skipped !== true) {
          const graded = await withReruns(normalizeDoD({ ...dod, checks: [] }), planTaskGraderBudgetMs(budget.gateBudgetMs, graderTier, override));
          res = combineMixedPasses(res, graded);
        }
      } else {
        res = await withReruns(dod, planTaskGraderBudgetMs(budget.gateBudgetMs, graderTier, override));
      }
      // QA-5.1-4: a gate cut by dispose judged nothing: no verdict reaches the outcome store.
      // QA-5.1-21: it is marked as a cut, which the runtime discards; nothing below runs for it (no `onVerdict`).
      if (disposing || signal?.aborted) return cutVerdict(record.dod);
      // D10 (A-5.1-13): no R11 lineage. QA-3.1-2 / QA-3.1-3 caveats as on a dispatch.
      res = applyDispatchCaveats(res, gatePrepared);
      // QA-5.1-21: from here the verdict is decided: `verify` returns it even when dispose cuts its wait afterwards.
      const decided = slotVerdictOf(res);
      onDecided(decided);
      if (child !== "" && res.verdict.skipped !== true) {
        try { deps.onVerdict?.(child, res.verdict); } catch (error) { warn("plan-task verdict not ingested", error); }
      }
      return decided;
    } catch (error) {
      return unverifiable(`verification unavailable: ${scrubText(error instanceof Error ? error.message : String(error))}`, record?.dod);
    } finally {
      records.delete(key);
      finalTexts.delete(key);
      if (record !== undefined) clearIds(record.id, attempt.childSessionID);
    }
  }

  /** QA-5.1-6/-14: the orchestrator is the one the runtime read for THIS call (the grader's parent after an adopt too). */
  async function verify(task: TaskNode, slot: SlotLease, attempt: Attempt, ctx?: PlanTaskContext): Promise<PlanTaskVerdict> {
    const cut = (): PlanTaskVerdict => cutVerdict(records.get(keyOf(slot.planId, task.id, attempt.n))?.dod);
    if (disposing || ctx?.signal?.aborted) return cut();
    // QA-5.1-21: a verdict decided before dispose cut the wait (and already handed to `onVerdict`) is returned, never a cut.
    let decided: PlanTaskVerdict | null = null;
    try {
      // Attachment cuts are handled inside the pipeline, including bounded grader abort/cleanup, before a new
      // attachment can verify this identity. Global dispose retains its prompt outer cut semantics.
      const verifyNow = verifyWithAttachment.bind(undefined, ctx?.signal);
      const result = await untilStopped(verifyNow(task, slot, attempt, orchestrator(ctx), (v) => { decided = v; }));
      return ctx?.signal?.aborted && decided === null ? cut() : result;
    } catch (error) {
      if (error instanceof PlanTaskShutdownError) return decided ?? cut();
      throw error;
    }
  }

  /**
   * QA-5.1-4: cuts every in-flight verification at once (synchronously, before the first await): each pending `verify` and
   * `observe` resolves, every gate and observation deadline is aborted and every backoff sleep cancelled; then the grader
   * sessions of the cut gates are aborted, each bounded by PLAN_TASK_ABORT_MS. Idempotent.
   */
  async function dispose(): Promise<void> {
    if (disposing) return;
    disposing = true;
    shutdown.abort();
    const sessions = new Set<string>();
    for (const entry of live) {
      entry.deadline.abort(PLAN_TASK_SHUTDOWN_REASON);
      for (const sessionID of entry.graders) sessions.add(sessionID);
    }
    await Promise.allSettled([...sessions].map((sessionID) =>
      withTimeout(deps.abortSession(sessionID), PLAN_TASK_ABORT_MS, "grader abort").catch((error: unknown) => {
        warn("grader abort on dispose failed", error);
      })));
  }

  return {
    begin, observe, forget, verify, dispose,
    get disposing() { return disposing; },
  };
}
