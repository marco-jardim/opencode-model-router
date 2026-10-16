// ExecutorRuntime (plan task 3.1.6): per-plan tick, per-task pipeline, lifecycle rows, liveness, metrics.
// Plan task 4.2.5: restart recovery (`recoverPlan`), R1a probation watch, integration resume per activation, D11 trailer.
import { lstatSync as slotLstatSync, readdirSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../router/prompts";
import { observeV2, type ObservationValue, type V2Observations } from "../compat/v2-observations";
import { attachSlotObservations, detachSlotObservations, observeSchedulerLedger } from "./observations";
import {
  capacityRestoreFromEvents,
  capacityView,
  type CapacityOptions,
  type CapacityProviderState,
} from "./capacity";
import { gitPointers } from "../router/git-tools";
import { expandTask, loadExpansionEnv, type ExpandedTask } from "./expand";
import {
  deleteSlotRef,
  listSlotRefs,
  orphanRefName,
  phaseTagName,
  planRefPrefix,
  restoreSlotWork,
  snapshotSlotWork,
  taskBranchName,
  wipRefName,
  wipTrailer,
  type WipRestore,
} from "./git";
import { dependentPhases } from "./integrate/queue";
import type { PlanRoleBindings } from "./launch";
import type { ProcessIdentity } from "./process-identity";
import { createQaLoop } from "./qa-loop";
import {
  RECOVER_TAKEOVER_REASON,
  RECOVERY_POLL_MS,
  sameToplevel,
  type ReconcileFeed,
  type RecoveryEngine,
} from "./recovery";
import { defaultSlotsDir, SLOT_NAME_PATTERN } from "./slots/pool";
import { BREAKER_FED, breakerSamples, createUnattendedPolicy, isCommitFailure, pendingDependentsClosure } from "./unattended";
import {
  ABSOLUTE_PATH_PATTERN,
  BUDGET_RESUMES,
  ExecutorError,
  WIP_TRAILER,
  QA_UNPARSABLE_CONTEXT_PREFIX,
  canonicalFindingsJson,
  executionFailureOutcome,
  formatInboxId,
  hasAttemptsLeft,
  isBreakerFailure,
  leaseHolderID,
  nextInboxNumber,
  leaseTaskRef,
  qaUnparsableCount,
  type Attempt,
  type AttemptOutcome,
  type BatchBuilder,
  type CapacityController,
  type CapacityView,
  type ChildEnd,
  type Clock,
  type Edge,
  type ExecutorConfig,
  type ExecutorEvent,
  type ExecutorEventInput,
  type ExecutorRuntime,
  type FindingsReport,
  type Footprint,
  type GitRunner,
  type HostError,
  type HostSessionContext,
  type HostSessionEvent,
  type HostSessions,
  type InboxItem,
  type IntegrationListener,
  type IntegrationQueue,
  type IsoTime,
  type JsonValue,
  type LaunchConfirmation,
  type LaunchHandle,
  type LaunchHooks,
  type LaunchRequest,
  type LeaseHolderInfo,
  type LeaseService,
  type LedgerStatus,
  type LedgerStore,
  type LedgerV1,
  type LedgerWriter,
  type LockHolder,
  type MetricPayload,
  type PhaseRecord,
  type PlanCompiler,
  type PlanId,
  type ProviderSignal,
  type QaLoop,
  type ReconcileAction,
  type RecoveryService,
  type ResumeReport,
  type RouteResolver,
  type ScheduledTask,
  type Scheduler,
  type SlotLease,
  type SlotPool,
  type SlotRecord,
  type SlotVerifier,
  type TaskId,
  type TaskLauncher,
  type TaskNode,
  type TaskRoute,
  type TaskState,
  type TransitionTrigger,
  type UnattendedPolicy,
  type Verdict,
  type WakeReason,
  type Waker,
} from "./types";

/** Narrow view of the process-wide Phase 1.3 lease registry (A3). */
export interface LeaseRegistryPort {
  acquireWrite(
    holder: { holderID: string; tree: string; isChild: true; taskRef: string; scope: "until-integrated" },
    writes: readonly string[],
  ):
    | { ok: true }
    | { ok: false; reason: "held" | "unknown-target"; holders: Array<{ holderID: string; taskRef: string | null }> }
    | { ok: false; reason: "cap" | "invalid"; message: string };
  releaseTask(taskRef: string): void;
  /** 5.1 wires this to `LeaseRegistry.planHolderOf(<plan toplevel>, path)`: write keys are per checkout (DF-1.1-4). */
  holderOf(path: string): { holderID: string; taskRef: string | null } | null;
}

function holderInfo(h: { holderID: string; taskRef: string | null }): LeaseHolderInfo {
  const ref = h.taskRef;
  const cut = ref === null ? -1 : ref.indexOf(":");
  if (ref === null || cut <= 0 || cut === ref.length - 1) return { planId: null, taskId: null, holderID: h.holderID };
  return { planId: ref.slice(0, cut) as PlanId, taskId: ref.slice(cut + 1) as TaskId, holderID: h.holderID };
}

/** Per-plan lease seam over the shared registry (A3). Never restores the registry. */
export function createLeaseService(planId: PlanId, registry: LeaseRegistryPort): LeaseService {
  const acquireTask: LeaseService["acquireTask"] = (i) => {
    if (i.writes.length === 0) return { ok: true };
    const r = registry.acquireWrite(
      {
        holderID: leaseHolderID(planId, i.taskId),
        tree: i.tree,
        isChild: true,
        taskRef: leaseTaskRef(planId, i.taskId),
        scope: "until-integrated",
      },
      i.writes,
    );
    if (r.ok) return { ok: true };
    if ("holders" in r) {
      const holders = r.holders.map(holderInfo);
      if (holders.length === 0) holders.push({ planId: null, taskId: null, holderID: "unknown" });
      return { ok: false, reason: "held", holders };
    }
    return { ok: false, reason: r.reason, message: r.message };
  };
  return {
    planId,
    holder(path: string): LeaseHolderInfo | null {
      const h = registry.holderOf(path);
      return h === null ? null : holderInfo(h);
    },
    acquireTask,
    releaseTask(taskId: TaskId): void {
      registry.releaseTask(leaseTaskRef(planId, taskId));
    },
    rebuild(tasks: ReadonlyArray<{ id: TaskId; slot: string | null; tree: string | null; footprint: Footprint }>) {
      const failed: Array<{ taskId: TaskId; holders: LeaseHolderInfo[] }> = [];
      for (const t of tasks) registry.releaseTask(leaseTaskRef(planId, t.id));
      for (const t of tasks) {
        if (t.slot === null || t.tree === null || t.footprint.writes.length === 0) continue;
        const r = acquireTask({ taskId: t.id, tree: t.tree, writes: t.footprint.writes });
        if (r.ok) continue;
        failed.push({
          taskId: t.id,
          holders: r.reason === "held" ? r.holders : [{ planId: null, taskId: null, holderID: `lease-${r.reason}` }],
        });
      }
      return failed;
    },
  };
}

export interface WakerDeps {
  writer: LedgerWriter;
  hosts: HostSessions;
  clock: Clock;
  debounceMs: number;
  text(reason: WakeReason, stateKey: string): string;
  onMetric(m: Extract<MetricPayload, { name: "wake" }>): void;
}

/** The runtime's waker: a `Waker` that also exposes the time of its last journaled attempt (QA-3.1-5). */
export interface RuntimeWaker extends Waker {
  /** Clock time of the last attempt that passed the debounce (journaled, then sent or failed); null before the first. */
  lastAttemptMs(): number | null;
}

/** One waker per plan (M32): journal `wake` (durable), then a synthetic message to the orchestrator. */
export function createWaker(d: WakerDeps): RuntimeWaker {
  let lastSentMs: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const run = async (reason: WakeReason, stateKey: string): Promise<"sent" | "debounced" | "duplicate" | "failed"> => {
    if (d.writer.wakeKeys().has(stateKey)) return "duplicate";
    if (lastSentMs !== null && d.clock.now() - lastSentMs < d.debounceMs) return "debounced";
    try {
      await d.writer.append([{ type: "wake", reason, stateKey }]);
    } catch {
      return "failed";
    }
    lastSentMs = d.clock.now();
    try {
      await d.hosts.synthetic({
        sessionID: d.writer.ledger.orchestrator.sessionID,
        text: d.text(reason, stateKey),
        description: `plan ${d.writer.planId}`,
        metadata: { planId: d.writer.planId, reason, stateKey },
        resume: true,
      });
      return "sent";
    } catch {
      return "failed";
    }
  };
  return {
    wake(reason, stateKey) {
      const next = chain.then(async () => {
        const result = await run(reason, stateKey);
        try {
          d.onMetric({ name: "wake", reason, stateKey, result });
        } catch {
          // metrics never throw into the wake path
        }
        return result;
      });
      chain = next.catch(() => undefined);
      return next;
    },
    lastAttemptMs() {
      return lastSentMs;
    },
  };
}

// ---- small pure helpers used by the runtime below

/** Async mutex keyed by string (M4: one pipeline per task id). */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** First line of a child's final text, trimmed. */
function firstLine(text: string): string {
  const t = text.replace(/^\s+/, "");
  const cut = t.search(/\r?\n/);
  return (cut < 0 ? t : t.slice(0, cut)).trim();
}

export type ChildTextClass =
  | { kind: "lease"; path: string | null }
  | { kind: "budget" }
  | { kind: "escalate" }
  | { kind: "ambiguity" }
  | { kind: "ordinary" };

/** Child text classification (first line, §6 of the memo). pdf2-1 (a): `NEED MORE: budget` and the router budget note resume. */
export function classifyChildText(text: string): ChildTextClass {
  const line = firstLine(text);
  const lease = /^NEED MORE:\s*lease\s+(.+)$/i.exec(line);
  if (lease !== null && lease[1] !== undefined) return { kind: "lease", path: normalizeLeasePath(lease[1]) };
  if (/^NEED MORE:\s*budget\b/i.test(line) || line.startsWith(ROUTER_BUDGET_NOTE_PREFIX)) return { kind: "budget" };
  if (/^ESCALATE:/i.test(line)) return { kind: "escalate" };
  if (/^(?:NEED CONTEXT|SCOPE GROWTH|NEED MORE):/i.test(line)) return { kind: "ambiguity" };
  return { kind: "ordinary" };
}

/** Repo-relative, `/`-separated path of a `NEED MORE: lease` request, or null when it is not a legal footprint path. */
function normalizeLeasePath(raw: string): string | null {
  let p = raw.trim().replace(/^`+|`+$/g, "").replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  if (p === "" || p === "." || ABSOLUTE_PATH_PATTERN.test(p)) return null;
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}

function modelLabel(r: TaskRoute): string {
  const v = r.model.variant;
  return `${r.model.providerID}/${r.model.modelID}${v === null ? "" : `#${v}`}`;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}

function errorCode(e: unknown): string | null {
  if (typeof e === "object" && e !== null) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return null;
}

const IDENTITY_PATTERN = /please tell me who you are|unable to auto-detect|empty ident|author identity unknown/i;

/** A git step that failed on a leftover `index.lock` (a git killed mid-commit, D11). */
const INDEX_LOCK_PATTERN = /index\.lock/i;

/** D11: the trailer line of attempt `n` (nonce `nonce`) of `taskId`. */
export function attemptTrailer(planId: PlanId, taskId: TaskId, n: number, nonce: string): string {
  return `${ATTEMPT_TRAILER}: ${planId}/${taskId}/${n}/${nonce}`;
}

/** D11: whether a commit message carries `trailer` as one of its lines. */
function hasTrailer(body: string, trailer: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() === trailer);
}

/** D11: removes the slot's leftover `index.lock`; false when its path is not known. Never throws. */
async function removeIndexLock(git: GitRunner, o: { cwd: string; timeoutMs: number }): Promise<boolean> {
  try {
    const r = await git.run(["rev-parse", "--git-path", "index.lock"], o);
    const rel = r.stdout.trim();
    if (r.code !== 0 || rel === "") return false;
    await rm(isAbsolute(rel) ? rel : join(o.cwd, rel), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * M38: commit the slot's changes on the task branch. `{changed: false}` when the tree is clean.
 * D11: with `trailer` every commit carries it as its own paragraph, and a clean tree whose HEAD carries this attempt's
 * trailer (a crash after the commit, before row 21) returns that commit instead of `{changed: false}`. A step that fails
 * on a leftover `index.lock` removes it once and is retried (the caller holds the plan's lock).
 * Throws `E_IDENTITY` (no git identity) or `E_GIT`.
 */
export async function commitTaskInSlot(
  git: GitRunner,
  i: { slot: SlotLease; branch: string; message: string; timeoutMs: number; trailer?: string },
): Promise<{ changed: false } | { changed: true; commit: string }> {
  const o = { cwd: i.slot.path, timeoutMs: i.timeoutMs };
  let lockRemoved = false;
  const step = async (args: readonly string[]): Promise<string> => {
    let r = await git.run(args, o);
    if (r.code !== 0 && !lockRemoved && INDEX_LOCK_PATTERN.test(`${r.stderr}\n${r.stdout}`)) {
      lockRemoved = true;
      if (await removeIndexLock(git, o)) r = await git.run(args, o);
    }
    if (r.code !== 0) {
      const text = `${r.stderr}\n${r.stdout}`;
      throw new ExecutorError(IDENTITY_PATTERN.test(text) ? "E_IDENTITY" : "E_GIT", `git ${args[0] ?? ""} failed`, {
        args: [...args],
        code: r.code,
        stderr: r.stderr.slice(0, 2000),
      });
    }
    return r.stdout;
  };
  const status = await step(["status", "--porcelain"]);
  if (status.trim() === "") {
    if (i.trailer === undefined) return { changed: false };
    // D11: the commit of this very attempt landed before the crash; any other HEAD (a base, an older attempt's commit
    // on a reused slot) is not this attempt's and the clean tree keeps its old meaning.
    const body = await git.run(["log", "-1", "--format=%B"], o);
    if (body.code !== 0 || !hasTrailer(body.stdout, i.trailer)) return { changed: false };
    const head = await git.run(["rev-parse", "HEAD"], o);
    const commit = head.stdout.trim();
    return head.code === 0 && commit !== "" ? { changed: true, commit } : { changed: false };
  }
  await step(["switch", "-C", i.branch]);
  await step(["add", "-A"]);
  await step(["commit", "-m", i.message, ...(i.trailer === undefined ? [] : ["-m", i.trailer])]);
  const head = (await step(["rev-parse", "HEAD"])).trim();
  return { changed: true, commit: head };
}

// ---- runtime

export interface PlanCollaborators {
  queue: IntegrationQueue;
  policy: UnattendedPolicy;
  qa: QaLoop;
}

/**
 * QA-5.1-6/-14: what the runtime hands the plan-task verifier with each hook call: the plan's orchestrator session as its
 * ledger names it at that call ("" when unknown). An adopt moves a plan to another orchestrator, so it is read per call.
 */
export interface PlanTaskContext {
  orchestratorSessionID: string;
  /** An attachment change cuts old work without disposing the process-wide verifier. */
  signal?: AbortSignal;
}

/**
 * QA-5.1-21: a plan-task verdict. `cut: true` marks a verification that dispose, or an attachment cut (`closePlan` on
 * adopt/dispose through `PlanTaskContext.signal`), cut before it decided anything (it judged nothing: the runtime discards
 * it, and the verifier never hands it to `onVerdict`). Any other result is a real verdict, journaled even when it resolves
 * after dispose or the attachment cut began.
 */
export type PlanTaskVerdict = Awaited<ReturnType<SlotVerifier["verify"]>> & { readonly cut?: true };

/** Optional attempt observations used by the dispatch-backed plan-task verifier. */
export interface PlanTaskVerifier extends SlotVerifier {
  begin?(task: TaskNode, slot: SlotLease, attempt: Attempt, ctx?: PlanTaskContext): void | Promise<void>;
  /** `finalText`: the child's final text when the runtime holds it (the row-15 result text, else the last assistant text). */
  observe?(task: TaskNode, slot: SlotLease, attempt: Attempt, finalText?: string, ctx?: PlanTaskContext): void | Promise<void>;
  verify(task: TaskNode, slot: SlotLease, attempt: Attempt, ctx?: PlanTaskContext): Promise<PlanTaskVerdict>;
  forget?(planId: PlanId, taskId: TaskId, attempt: number): void | Promise<void>;
  /**
   * QA-5.1-4: called FIRST by `runtime.dispose`. Cuts every in-flight verification (gate deadlines, grader sessions, backoff
   * sleeps); each pending `verify` resolves promptly as unverifiable. A verdict cut this way is never journaled. An
   * attachment cut (`PlanTaskContext.signal` aborted by `closePlan`) cuts only that attachment's verifications the same way
   * (graders aborted, verdict marked `cut`) without disposing the process-wide verifier.
   */
  dispose?(): Promise<void>;
  /** QA-5.1-4: whether `dispose` has been called (a verdict returned after it is a cut, never journaled). */
  readonly disposing?: boolean;
}

export interface RuntimeDeps {
  observations?: V2Observations;
  /** The process that creates this runtime's children (v2 assembly only). */
  self?: ProcessIdentity;
  store: LedgerStore;
  /** Executor storage root; metadata-less slot directories are preserved here, outside the pool. */
  executorHome?: string;
  compiler: PlanCompiler;
  slots: SlotPool;
  /** Per-plan pools; legacy callers keep using `slots`. */
  slotsFor?(planId: PlanId): SlotPool;
  /**
   * QA-5.1-22: the purge's full gc of a finished plan (create.ts `PlanSlotPools.purge`: a gc-only handle that creates no
   * directory and removes the plan's empty slots directory). Without it, purge runs `slotsFor(planId).gc`.
   */
  purgeSlots?(planId: PlanId, finished: Parameters<SlotPool["gc"]>[0]): ReturnType<SlotPool["gc"]>;
  /** Revalidate the fixed slots directory before approval has any side effects. */
  /** Approve-time validation of the resolved slots root; `planId` names the plan being approved (its ledger, its base). */
  checkSlotsDir?(slotsDir: string, toplevel: string, planId: PlanId): void | Promise<void>;
  scheduler: Scheduler;
  launcher: TaskLauncher;
  routes: RouteResolver;
  verifier: PlanTaskVerifier;
  git: GitRunner;
  hosts: HostSessions;
  clock: Clock;
  leaseRegistry: LeaseRegistryPort;
  /**
   * Restart recovery (4.2.5). `reconcile` is the engine's read-only classification (`createRecoveryService`); a service
   * without it recovers locks only, every activation still runs the other `recoverPlan` steps.
   */
  recovery: (RecoveryService & Partial<Pick<RecoveryEngine, "reconcile">>) | null;
  holder(sessionID: string): LockHolder;
  capacity(o: CapacityOptions): CapacityController;
  collaborators(i: {
    writer: LedgerWriter;
    leases: LeaseService;
    waker: Waker;
    listener: IntegrationListener;
    /**
     * pdf2-1 (b): the policy's park calls it before clearing a slot the task still holds (saves the slot's work).
     * QA-PDF21-3: `false` when the work could not be saved; the park then keeps the slot on the task.
     */
    beforeSlotRelease?: (taskId: TaskId, slot: string, cause: Parameters<UnattendedPolicy["park"]>[1]) => Promise<boolean | void>;
    /** QA-PDF21-7: the options of a park item (`discard-wip`/`keep-wip` after a restore conflict). */
    parkOptions?: (taskId: TaskId, cause: Parameters<UnattendedPolicy["park"]>[1]) => readonly string[];
  }): PlanCollaborators;
  pinOrchestrator(sessionID: string): () => void;
  log(level: "info" | "warn" | "error", msg: string, detail?: JsonValue): void;
  /** Resolved executor configuration used by `compile` (the memo's RuntimeDeps left its source open). */
  config(): ExecutorConfig;
  /**
   * QA-4.2-18/-23: the launcher's binding port (the same `PlanRoleBindings` the launcher binds its children through). A
   * child adopted by recovery is re-bound through it with its task's role, grant and work root, and evicted once its
   * attempt closes.
   */
  bindings: PlanRoleBindings;
  /**
   * QA-4.2-21: this process's repository toplevel. A plan whose `repo.toplevel` differs (`sameToplevel`) is foreign:
   * attached passively, never recovered, resumed, ticked or adopted here. Required: an omitted toplevel would let a
   * foreign plan whose lock is free be driven actively (QA-4.2 NEW-1).
   */
  toplevel: string;
}

/** What `RuntimeDeps.collaborators` receives for one plan. */
export type CollaboratorInput = Parameters<RuntimeDeps["collaborators"]>[0];

export interface RealCollaboratorDeps {
  /**
   * Builds the plan's integration queue (no production assembly exists before 5.1, V7). It receives the plan's policy and
   * QA loop too, built before it.
   */
  queue(i: CollaboratorInput & { policy: UnattendedPolicy; qa: QaLoop }): IntegrationQueue;
  clock: Clock;
  log: RuntimeDeps["log"];
}

/**
 * 4.2.5: the real per-plan collaborators, as a `RuntimeDeps.collaborators` implementation: the QA loop first, then the
 * unattended policy over it, then the queue (memo §8).
 */
export function realCollaborators(r: RealCollaboratorDeps): RuntimeDeps["collaborators"] {
  return (i) => {
    const qa = createQaLoop({ writer: i.writer, waker: i.waker, clock: r.clock, log: { warn: (msg) => r.log("warn", msg) } });
    const policy = createUnattendedPolicy({
      writer: i.writer, leases: i.leases, waker: i.waker, qa, clock: r.clock, log: r.log,
      ...(i.beforeSlotRelease === undefined ? {} : { beforeSlotRelease: i.beforeSlotRelease }),
      ...(i.parkOptions === undefined ? {} : { parkOptions: i.parkOptions }),
    });
    return { queue: r.queue({ ...i, policy, qa }), policy, qa };
  };
}

export interface ExecutorRuntimeHandle extends ExecutorRuntime {
  /** No tick, pipeline or metric append pending. */
  settled(): Promise<void>;
  manualReady(sessionID: string): Array<{ taskId: TaskId; kind: string }>;
  isPlanChild(sessionID: string): boolean;
  /** Journals a metric the launcher emitted through `TaskLauncherDeps.onMetric` (the launcher never journals). */
  recordMetric(planId: PlanId, m: MetricPayload): void;
  /**
   * The adapter calls this when the process-wide lease registry released a lease (QA-3.1-6): a launch step skipped on a
   * held lease is retried by a tick of every attached plan, not only by the backoff tick.
   */
  onLeaseReleased(): void;
}

const GIT_TIMEOUT_MS = 60_000;
/** Phase 5.1 (a): the bound on reading a child's final text when the runtime no longer holds it (after a restart). */
export const FINAL_TEXT_READ_MS = 5_000;
const LOST_STREAK = 3;
const STREAK_DETAILS: readonly string[] = ["unrequested-interrupt", "runner-error"];
/** Consecutive pre-confirmation losses (distinct router calls) that pause the plan (QA-3.1-4). */
const PRECONFIRM_STREAK = 3;
/** Consecutive provisioning failures that raise one inbox item (QA-3.1-6). */
const PROVISION_STREAK = 5;
/**
 * QA-PDF21-7: the options of the park item a restore conflict raises. `discard-wip` deletes the task's WIP ref before it
 * relaunches clean; `keep-wip` (or any other answer) keeps the ref and the next attempt restores it again.
 */
export const WIP_PARK_OPTIONS: readonly string[] = ["discard-wip", "keep-wip"];
/** QA-PDF21-15: the start of the item a failed save raises (`wipHold`); `answer` reads the slot name back from it. */
export const WIP_HOLD_PREFIX = "the work in slot ";

/** QA-PDF21-15: the slot a wip-hold item names, null for any other item. */
function wipHoldSlotOf(text: string): string | null {
  if (!text.startsWith(WIP_HOLD_PREFIX)) return null;
  const m = /^(\S+) could not be saved before /.exec(text.slice(WIP_HOLD_PREFIX.length));
  return m?.[1] ?? null;
}

/** QA-PDF21-10: a process-wide sequence; with the pid it keeps orphan ref names of one slot in one millisecond apart. */
let orphanSeq = 0;
function orphanTag(): string {
  orphanSeq += 1;
  return `${process.pid.toString(36)}${orphanSeq.toString(36)}`;
}

/**
 * QA-PDF21-12: the lease of a slot just reset to `head`. A cached lease keeps the commit `acquire` returned, which for a
 * re-acquired slot is the base before the reset; every reset refreshes the cache through this so no later save is parented
 * at the stale base (and pulls the integration delta into the WIP tree).
 */
function leaseAt(lease: SlotLease, head: string): SlotLease {
  return { ...lease, commit: head };
}
/** Consecutive RouteResolver failures (backoff rounds) that raise one inbox item (QA-3.1-22). */
const ROUTE_STREAK = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Bound of the per-session maps (provider of the last step, fallback step counter); oldest entries go first. */
const SESSION_MAP_CAP = 1024;
/** Provider of the placeholder route of a task the RouteResolver throws on; it never has free capacity (QA-3.1-11). */
const UNROUTABLE = "\u0000unroutable";

/** The step key the adapter put on a retry/step event (QA-3.1-8), when it did. */
function eventStepKey(e: HostSessionEvent): string | null {
  const k: unknown = "stepKey" in e ? e.stepKey : undefined;
  return typeof k === "string" && k !== "" ? k : null;
}

/** Inserts into a map bounded at SESSION_MAP_CAP entries (insertion order; the oldest entry is evicted). */
function boundedSet<V>(m: Map<string, V>, k: string, v: V): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > SESSION_MAP_CAP) {
    const first = m.keys().next();
    if (first.done === true) break;
    m.delete(first.value);
  }
}

interface TokenRef {
  id: string;
}

interface HandleRef {
  n: number;
  settled: boolean;
  completion: Promise<ChildEnd>;
}

type LaunchStepResult = "launched" | "skipped" | "slot-unavailable";

/** Recovery registers pipelines in feed order; independent pipelines complete outside the activation barrier. */
interface RecoveredWork {
  readonly taskId: TaskId;
  readonly n: number;
  readonly nonce: string;
  readonly state: TaskState;
  readonly work: { kind: "reverify"; slotValid: boolean | null } | { kind: "end"; end: ChildEnd };
  started: boolean;
}

interface PlanRt {
  readonly planId: PlanId;
  writer: LedgerWriter;
  leases: LeaseService;
  waker: RuntimeWaker;
  collab: PlanCollaborators;
  capacity: CapacityController;
  tokens: Map<string, TokenRef>;
  inFlight: Set<TaskId>;
  /** Launch steps that have not relinquished their physical-slot reservation (unlike steps finishing cleanup). */
  slotReservations: Set<TaskId>;
  handles: Map<TaskId, HandleRef>;
  slotLeases: Map<TaskId, SlotLease>;
  offSlotRelease: (() => void) | null;
  slotWaiting: boolean;
  slotReleaseGeneration: number;
  capacityStopped: Set<string>;
  lostStreak: Map<TaskId, number>;
  latch: boolean;
  ticking: boolean;
  again: boolean;
  disposed: boolean;
  metricChain: Promise<void>;
  lastWakeMs: number | null;
  wakeRetry: Map<string, { attempts: number; nextAt: number; done: boolean }>;
  timers: Set<{ readonly id: number }>;
  idle: { fromMs: number; fromAt: IsoTime; ids: TaskId[]; free: number } | null;
  orchIdle: boolean;
  unpin: (() => void) | null;
  counters: { launches: number; wakes: number; idleMs: number };
  /** Consecutive skipped launch steps; drives the backoff tick (QA-3.1-6), reset on a launch. */
  skipStreak: number;
  backoff: { readonly id: number } | null;
  /** Consecutive provisioning failures; one inbox item at PROVISION_STREAK (QA-3.1-6), reset on a launch. */
  provisionFails: number;
  provisionRaised: boolean;
  /** Consecutive pre-confirmation losses (row 11, QA-3.1-4); reset on a confirmed launch and on resume. */
  preConfirmLosses: number;
  /**
   * Capture (router call) of the last counted pre-confirmation loss and the tasks lost under it (QA-3.1-17): parallel
   * launches lost under one capture count once; a task relaunched and lost again under the same capture counts again.
   */
  preConfirmCapture: { key: string; tasks: Set<TaskId> } | null;
  /** Consecutive RouteResolver failures (QA-3.1-22); one inbox item at ROUTE_STREAK, reset by a tick that resolved cleanly. */
  routeFails: number;
  routeRaised: boolean;
  /**
   * Attached while another plan held the active slot (QA-3.1-19): never activated, pinned or ticked and fed no host
   * event; abort, answer, status, pause and purge reach it, a resume promotes it once the slot is free.
   */
  passive: boolean;
  /** 4.2.5: `recoverPlan` is running; `schedule` is a no-op until it finishes (step 11). */
  recovering: boolean;
  /** Attachment-local identities; waiting for context retains the task's slot and leases. */
  recoveredWork: Map<TaskId, RecoveredWork>;
  /** Work that must observe an attachment cut before its writer closes (including already-decided verdicts). */
  attachmentWork: Set<Promise<void>>;
  attachment: AbortController;
  /** §9: `queue.resume()` ran in this activation and did not halt; a user `resume` retries while false. */
  integrationResumed: boolean;
  /** R1a: children adopted on probation, keyed by child session id. */
  probation: Map<string, ProbationWatch>;
  /** R1a: the poll timer of the probation watch (one per plan), null when no child is on probation. */
  probationTimer: { readonly id: number } | null;
  /**
   * QA-4.2-15: child sessions the runtime itself is interrupting (probation deadline, the live child of a lease-held
   * task); their end is a `lost "restart"` end with the slot reset, never an `unrequested-interrupt` nor a proof of life.
   */
  interrupting: Set<string>;
  /**
   * QA-4.2-16: tasks whose lease rebuild failed; held (no adopt, commit, verify or enqueue) until a rebuild retry on a
   * tick or a lease release re-acquires their leases.
   */
  leaseHeld: Set<TaskId>;
  /** QA-4.2-23: children `rebindChild` bound, by task; evicted once their attempt closes (or the plan detaches). */
  rebound: Map<TaskId, { n: number; childSessionID: string }>;
  /**
   * Attempts (`tokenKey(taskId, n)`) whose child recovery adopted in this attachment, whether or not `rebindChild`
   * succeeded: their end after the barrier waits for a root context like any other recovered work.
   */
  adoptedByRecovery: Set<string>;
  /**
   * QA-4.2-29: the history export this activation read once (capacity restore, then the breaker step); null when it
   * failed or after the breaker step used it.
   */
  history: ExecutorEvent[] | null;
  /** QA-4.2-14: breaker-fed markers this process journaled (an export read earlier in the activation misses them). */
  fed: Set<string>;
}

/** R1a: one child adopted on probation (unknown liveness after a restart). */
interface ProbationWatch {
  taskId: TaskId;
  n: number;
  /** Clock ms after which a child without a sign of life is interrupted. */
  deadlineAt: number;
  pollMs: number;
  /** Signature of the child's context (message count and last message) seen by the last poll; null before the first. */
  lastSig: string | null;
  /** Consecutive failed interrupts; one blocking item at PROBATION_INTERRUPT_FAILS. */
  interruptFails: number;
  raised: boolean;
  /** A poll step of this watch is running (never two at once). */
  busy: boolean;
}

/** R1a: failed interrupts of a silent child on probation that raise one blocking item (the task keeps waiting). */
const PROBATION_INTERRUPT_FAILS = 5;
/** D11: the trailer every task commit carries: `Omr-Attempt: <planId>/<taskId>/<n>/<nonce>`. */
const ATTEMPT_TRAILER = "Omr-Attempt";
/** pdf2-1 (a): the prompt of a budget resume of the same child session. */
export const RESUME_PROMPT = "continue and finish";
/** QA-4.2-16: states a failed lease rebuild holds (no commit, verify or enqueue until the leases are back). */
const LEASE_HELD_STATES: readonly TaskState[] = ["running", "completed", "verifying", "verified"];
/** QA-4.2-3: how long closing a plan waits for its integration queue to dispose (a hung queue never blocks a close). */
const QUEUE_DISPOSE_MS = 10_000;
/** QA-5.1-7: the first re-check of a finished plan that is not quiescent yet; it doubles up to COLLECT_RETRY_MAX_MS. */
export const COLLECT_RETRY_BASE_MS = 100;
/** QA-5.1-7: the cap of the finished-plan collection backoff. */
export const COLLECT_RETRY_MAX_MS = 30_000;
/** QA-5.1-19: what a manual gc reports for a completed plan whose phase tag is still pending (its slots are kept). */
export const GC_TAG_PENDING = "a phase tag is still pending; retry later";

/** QA-5.1-7: the delay of the re-check after one of `delay`: doubled, capped at COLLECT_RETRY_MAX_MS. */
export function nextCollectDelay(delay: number): number {
  return Math.min(Math.max(delay, COLLECT_RETRY_BASE_MS) * 2, COLLECT_RETRY_MAX_MS);
}

/**
 * QA-5.1-7: whether a finished plan's phase tags are settled. An aborted plan tags nothing: settled. A completed plan's passed
 * phase is settled once tagged, or once the queue settled its tag without one: the tag name exists at another commit
 * (queue.ts finishTag `exists-other`), or the queue gave up after TAG_RETRY_LIMIT rounds (retryTagLater). Both leave a
 * `failure` inbox item naming the phase's tag (`The phase tag <name> ...`), the only ledger record of either. The queue tags
 * every passed phase (no setting turns tagging off), so there is no untagged-by-configuration case.
 */
export function planTagsSettled(l: Readonly<LedgerV1>): boolean {
  if (l.status === "aborted") return true;
  return l.phases.every((ph) => {
    if (ph.gate !== "passed" || ph.tag !== null) return true;
    let name: string;
    try {
      name = phaseTagName(l.planId, ph.id);
    } catch {
      return false;
    }
    return l.inbox.some((item) => item.kind === "failure" && item.taskId === null
      && (item.text.startsWith(`The phase tag ${name} already exists at `) || item.text.startsWith(`The phase tag ${name} could not be created after `)));
  });
}
/** QA-4.2-13: context of a `completed` task whose slot was lost before its commit (R2 re-provision failed). */
const SLOT_LOST_BEFORE_COMMIT = "slot lost before commit";

/**
 * Wake reason of the refused plan's one wake (QA-3.1-19). `WakeReason` (types.ts, owned elsewhere) has no `plan-refused`
 * member yet; the wake goes out as an inbox wake under the state key `plan-refused:<planId>:<active>` until it does.
 */
const PLAN_REFUSED_WAKE: WakeReason = "inbox";

function own(l: Readonly<LedgerV1>, id: TaskId): TaskNode | null {
  return Object.hasOwn(l.tasks, id) ? (l.tasks[id] ?? null) : null;
}

const TERMINAL_OK: readonly TaskState[] = ["done", "cancelled", "integrated"];

function planFinished(l: Readonly<LedgerV1>): boolean {
  for (const t of Object.values(l.tasks)) if (!TERMINAL_OK.includes(t.state)) return false;
  return l.phases.every((ph) => ph.gate === "passed");
}

function tt(taskId: TaskId, from: TaskState, to: TaskState, trigger: TransitionTrigger, detail: string | null = null): ExecutorEventInput {
  return { type: "task-transition", taskId, from, to, trigger, detail };
}
function ae(taskId: TaskId, n: number, outcome: AttemptOutcome, endedAt: IsoTime, detail: string | null): ExecutorEventInput {
  return { type: "attempt-ended", taskId, n, outcome, endedAt, detail };
}
function ax(taskId: TaskId, n: number, context: string): ExecutorEventInput {
  return { type: "attempt-context", taskId, n, context };
}
function ts(taskId: TaskId, slot: string | null, branch: string | null): ExecutorEventInput {
  return { type: "task-slot", taskId, slot, branch };
}

/** `endedAt = max(end.endedAt, attempt.startedAt)` (A2-6). */
function clampEnd(a: Attempt, at: IsoTime): IsoTime {
  const e = Date.parse(at);
  const s = Date.parse(a.startedAt);
  return Number.isFinite(e) && Number.isFinite(s) && e < s ? a.startedAt : at;
}

/** Attempt `n` of `taskId`, which the caller knows exists (a breaker sample); E_PLAN_STATE otherwise (an invariant). */
function attemptOf(l: Readonly<LedgerV1>, taskId: TaskId, n: number): Attempt {
  const a = own(l, taskId)?.attempts.find((x) => x.n === n);
  if (a === undefined) throw new ExecutorError("E_PLAN_STATE", "attempt missing", { taskId, n });
  return a;
}

function openAttempt(t: TaskNode, n: number): Attempt | null {
  const a = t.attempts[t.attempts.length - 1];
  return a !== undefined && a.n === n && a.outcome === null ? a : null;
}

function phaseOf(l: Readonly<LedgerV1>, t: TaskNode): PhaseRecord | null {
  return t.phase === null ? null : (l.phases.find((ph) => ph.id === t.phase) ?? null);
}

/** G1 for a qa task (awaiting-qa -> qa-running); [] otherwise. */
function gateOpen(l: Readonly<LedgerV1>, t: TaskNode): ExecutorEventInput[] {
  const ph = phaseOf(l, t);
  if (t.kind !== "qa" || ph === null || ph.gate !== "awaiting-qa") return [];
  return [{ type: "gate-changed", phaseId: ph.id, from: "awaiting-qa", to: "qa-running", trigger: "qa-dispatched", qaRound: ph.qaRound }];
}

/** G2 for a qa task leaving flight without success (qa-running -> awaiting-qa); [] otherwise. */
function gateRequeue(l: Readonly<LedgerV1>, t: TaskNode): ExecutorEventInput[] {
  const ph = phaseOf(l, t);
  if (t.kind !== "qa" || ph === null || ph.gate !== "qa-running") return [];
  return [{ type: "gate-changed", phaseId: ph.id, from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued", qaRound: ph.qaRound }];
}

function needsOf(routeLine: string): string[] {
  const m = /\bneeds=([^\s\]]*)/.exec(routeLine);
  const v = m?.[1];
  return v === undefined || v === "" ? [] : v.split(/[,+]/).filter((s) => s !== "");
}

export function createExecutorRuntime(d: RuntimeDeps): ExecutorRuntimeHandle {
  const slotsFor = d.slotsFor ?? (() => d.slots);
  const plans = new Map<PlanId, PlanRt>();
  const mutex = new KeyedMutex();
  const pending = new Set<Promise<unknown>>();
  const providerBySession = new Map<string, string>();
  /** Fallback step counter per session (QA-3.1-8: `e.stepKey` wins); bounded, and dropped when the session ends. */
  const stepState = new Map<string, { k: number; open: boolean }>();
  let disposed = false;
  const collected = new Set<PlanId>();
  const forgotten = new Set<string>();
  /** The child's final text of a completed attempt (row 15), by `<plan>/<task>#<n>`, for the plan-task verifier's `observe`. */
  const finalTexts = new Map<string, string>();
  const collecting = new Set<PlanId>();
  const collectionTimers = new Map<PlanId, { readonly id: number }>();
  /** QA-5.1-7: the next re-check delay of a finished plan that is not quiescent yet. */
  const collectionDelays = new Map<PlanId, number>();
  /** The process-level activation reservation (QA-3.1-18): the plan whose activation is under way, and its holds. */
  let activating: { planId: PlanId; holds: number } | null = null;
  /** Unsubscribes `onHostEvent` from `hosts.onEvent` (subscribed in `start`, QA-3.1-1). */
  let offEvents: (() => void) | null = null;

  // ---------- plumbing

  // Only copies existing facts. In particular NO readySet, gate, route, lease or capacity query here:
  // capacity.snapshot/limit/free can lazily resume providers. Observing must never do that itself.
  function observe(p: PlanRt, action: string, detail: () => ObservationValue = () => null, clockMs?: number): void {
    observeV2(d.observations, () => ({ family: "scheduler", planId: p.planId, parentSessionID: p.writer.ledger.orchestrator.sessionID, action,
      state: { clockMs: clockMs ?? d.clock.now(), ledgerSeq: p.writer.ledger.seq, orchIdle: p.orchIdle, passive: p.passive,
        recovering: p.recovering, disposed: p.disposed, latch: p.latch, inFlight: [...p.inFlight], tokens: [...p.tokens.keys()], detail: detail() } }));
  }

  function track<T>(pr: Promise<T>): Promise<T> {
    pending.add(pr);
    const done = (): void => {
      pending.delete(pr);
    };
    pr.then(done, done);
    return pr;
  }

  /** Waits for a live child's end (settles only when the child ends); tracked, but `dispose` never waits for it. */
  const childWaits = new Set<Promise<unknown>>();
  function trackChild<T>(pr: Promise<T>): Promise<T> {
    childWaits.add(pr);
    const done = (): void => {
      childWaits.delete(pr);
    };
    pr.then(done, done);
    return track(pr);
  }

  function bg(label: string, fn: () => Promise<void>): Promise<void> {
    return track(
      fn().catch((e: unknown) => {
        d.log("error", `${label} failed`, errorText(e));
      }),
    );
  }

  function holdAttachment(p: PlanRt, work: Promise<void>): Promise<void> {
    p.attachmentWork.add(work);
    const done = (): void => { p.attachmentWork.delete(work); };
    void work.then(done, done);
    return work;
  }

  function metric(p: PlanRt, m: MetricPayload): void {
    const next = p.metricChain.then(async () => {
      try {
        await p.writer.append([{ type: "metric", metric: m }]);
      } catch (e) {
        d.log("warn", "metric append failed", errorText(e));
      }
    });
    p.metricChain = next;
    void track(next);
  }

  function counter(p: PlanRt, key: string, labels: Record<string, string> = {}, deferred?: MetricPayload[]): void {
    const m: MetricPayload = { name: "counter", key, value: 1, labels };
    if (deferred === undefined) metric(p, m);
    else deferred.push(m);
  }

  async function appendIf(p: PlanRt, build: BatchBuilder): Promise<boolean> {
    let applied = false;
    await p.writer.append((l) => {
      const ev = build(l);
      applied = ev.length > 0;
      return ev;
    });
    if (applied) await forgetClosed(p);
    return applied;
  }

  async function forgetAttempt(p: PlanRt, taskId: TaskId, n: number): Promise<void> {
    const key = `${p.planId}/${taskId}#${n}`;
    finalTexts.delete(key);
    if (forgotten.has(key)) return;
    try { await d.verifier.forget?.(p.planId, taskId, n); }
    catch (e) { d.log("warn", "verifier forget failed", errorText(e)); }
    forgotten.add(key);
  }

  async function forgetClosed(p: PlanRt): Promise<void> {
    if (d.verifier.forget === undefined) return;
    for (const task of Object.values(p.writer.ledger.tasks)) {
      const a = task.attempts[task.attempts.length - 1];
      if (a !== undefined && a.outcome !== null && a.verdict === null && task.state !== "completed" && task.state !== "verifying") {
        await forgetAttempt(p, task.id, a.n);
      }
    }
  }

  /** QA-5.1-6/-14: the plan's orchestrator as its ledger names it now (an adopt moves it), handed to each verifier hook. */
  function planTaskContext(p: PlanRt): PlanTaskContext {
    return { orchestratorSessionID: p.writer.ledger.orchestrator.sessionID, signal: p.attachment.signal };
  }

  /**
   * QA-PDF21-15: the abort's releases still running, by plan: a cancelled child's settled launch is followed by its slot's save,
   * then its reset and release, or its hold when the save fails. Until that ends the slot is neither collectable nor known held.
   */
  const abortReleases = new WeakMap<PlanRt, Set<TaskId>>();

  /**
   * No live child, no task in flight, no abort release running and no open integration entry: nothing of the plan still
   * writes its slots.
   */
  function idle(p: PlanRt): boolean {
    return p.inFlight.size === 0 && ![...p.handles.values()].some((h) => !h.settled) && (abortReleases.get(p)?.size ?? 0) === 0
      && p.attachmentWork.size === 0 && p.writer.openIntegration().length === 0;
  }

  /**
   * QA-5.1-7: idle, and every phase's tag is settled. An aborted plan tags nothing, so it waits for no tag. A completed plan's
   * passed phase is settled once tagged, or once the queue settled its tag otherwise (`phaseTagSettled`).
   */
  function quiescent(p: PlanRt): boolean {
    return idle(p) && planTagsSettled(p.writer.ledger);
  }

  /** Finished status is not sufficient: the queue must have closed its entries and phase tags. */
  async function collectFinished(p: PlanRt): Promise<void> {
    const status = p.writer.ledger.status;
    if (disposed || p.disposed || foreignPlans.has(p.planId) || collected.has(p.planId) || collecting.has(p.planId)
      || (status !== "completed" && status !== "aborted")) return;
    if (!quiescent(p)) {
      if (!collectionTimers.has(p.planId)) {
        // QA-5.1-7: the re-check backs off (doubling from COLLECT_RETRY_BASE_MS, capped at COLLECT_RETRY_MAX_MS); it stops
        // once the plan is collected or the runtime (or the plan) is disposed (the early return above, dispose's clear).
        const delay = collectionDelays.get(p.planId) ?? COLLECT_RETRY_BASE_MS;
        collectionDelays.set(p.planId, nextCollectDelay(delay));
        const timer = d.clock.setTimer(delay, () => {
          collectionTimers.delete(p.planId);
          bg("finished slot collection", () => collectFinished(p));
        });
        collectionTimers.set(p.planId, timer);
      }
      return;
    }
    collecting.add(p.planId);
    try {
      // pdf2-1 (b): the WIP refs of integrated and done tasks go before the slots (QA-PDF21-4: a cancelled task's stays).
      await sweepWip(p);
      // QA-PDF21-3: a slot whose work could not be saved is never collected; its item is open. QA-PDF21-15: each collection
      // (at most one per tick) retries the save of each such slot once, then waits for the next tick or the item's answer.
      for (const slotName of heldSlotsOf(p)) await retryHeldSave(p, slotName, "collect");
      if (heldSlotsOf(p).length > 0) {
        d.log("warn", `plan ${p.planId}: a slot holds unsaved work; its slots are not collected`);
        return;
      }
      await slotsFor(p.planId).gc(async (id) => id === p.planId);
      collected.add(p.planId);
      collectionDelays.delete(p.planId);
    } finally { collecting.delete(p.planId); }
  }

  function arm(p: PlanRt, ms: number): void {
    const h = d.clock.setTimer(Math.max(0, ms), () => {
      p.timers.delete(h);
      schedule(p);
    });
    p.timers.add(h);
  }

  function tokenKey(taskId: TaskId, n: number): string {
    return `${taskId}#${n}`;
  }

  function releaseToken(p: PlanRt, taskId: TaskId, n: number, result: "success" | "other"): void {
    const k = tokenKey(taskId, n);
    const tok = p.tokens.get(k);
    if (tok === undefined) return;
    p.tokens.delete(k);
    try {
      p.capacity.release(tok, result);
      observe(p, "capacity-release", () => ({ taskId, attempt: n, token: tok.id, result }));
    } catch (e) {
      d.log("warn", "capacity release failed", errorText(e));
    }
  }

  /**
   * Called by the module that wrote TS(null), after the fsync of that batch (A3).
   * QA-PDF21-4: the slot's work is saved before EVERY release (the pool's `acquire` resets a ready slot, so a slot
   * released dirty loses its work): at the task's WIP ref while the pool still leases it to the task, else at an orphan
   * ref. An integrated or done task's slot holds nothing to keep. `presaved` is the result of a save the caller ran
   * already. QA-PDF21-3: a failed save never releases the slot: it stays leased and one blocking item names it.
   * Returns whether the slot went back to the pool (true when there was none).
   */
  async function releaseResources(p: PlanRt, taskId: TaskId, slotName: string | null, outcome = "released", presaved: SaveResult | null = null): Promise<boolean> {
    releaseLeases(p, taskId);
    const s = slotName ?? p.slotLeases.get(taskId)?.slot ?? null;
    if (s === null) {
      p.slotLeases.delete(taskId);
      return true;
    }
    const released = await releaseSlotSaved(p, taskId, s, outcome, presaved);
    if (released) p.slotLeases.delete(taskId);
    return released;
  }

  /**
   * QA-PDF21-4: the one way a slot of the plan goes back to the pool: its work is saved first (`presaved`: the save the
   * caller ran already); an integrated or done task's slot holds nothing to keep. QA-PDF21-3: a failed save keeps the
   * slot leased (never released, its lease cache kept) and raises the item that names it. Never throws.
   */
  async function releaseSlotSaved(p: PlanRt, taskId: TaskId, s: string, outcome: string, presaved: SaveResult | null = null): Promise<boolean> {
    const state = own(p.writer.ledger, taskId)?.state;
    const saved = presaved ?? (state === "integrated" || state === "done" ? "clean" : await snapshotTaskSlot(p, taskId, s, outcome));
    if (saved === "failed") {
      await wipHold(p, taskId, s, `its release (${outcome})`);
      return false;
    }
    // Reconstructed holds also cover clean/presaved slots. Those paths need not enter saveSlotWork (which clears
    // holds after a git snapshot); end the hold here too, before collection can retry this completed release.
    wipFailRaised.delete(`${p.planId}/${s}`);
    if (p.slotLeases.get(taskId)?.slot === s) p.slotLeases.delete(taskId);
    try {
      await slotsFor(p.planId).release(s);
    } catch (e) {
      d.log("warn", "slot release failed", errorText(e));
    }
    return true;
  }

  /** Releases the task's leases; a throwing registry is logged so the slot release behind it still runs (QA-3.1-12). */
  function releaseLeases(p: PlanRt, taskId: TaskId): void {
    try {
      p.leases.releaseTask(taskId);
    } catch (e) {
      d.log("warn", "lease release failed", errorText(e));
    }
  }

  /**
   * QA-4.2-16: retries the lease rebuild of the tasks a failed rebuild holds (each tick, each lease release). A task whose
   * leases are back leaves the hold and its held recovery step runs (commit-and-verify, re-verify or enqueue); a task that
   * left its held states (or its slot) leaves the hold without one.
   */
  async function retryHeldLeases(p: PlanRt): Promise<void> {
    if (p.leaseHeld.size === 0 || p.disposed || p.passive) return;
    const l = p.writer.ledger;
    const tasks: Array<{ id: TaskId; slot: string | null; tree: string | null; footprint: Footprint }> = [];
    for (const id of [...p.leaseHeld].sort()) {
      const t = own(l, id);
      if (t === null || t.slot === null || !LEASE_HELD_STATES.includes(t.state)) {
        p.leaseHeld.delete(id);
        continue;
      }
      // QA-4.2-26: the pool's record itself, never the cached lease (`slotLeaseOf` caches it on the first retry, which
      // would hide a record that vanished since). A lookup error is retried next tick.
      let tree: string | null;
      try {
        tree = (await slotsFor(p.planId).get(t.slot))?.path ?? null;
      } catch (e) {
        d.log("warn", `slot lookup of held ${id} failed; retried next tick`, errorText(e));
        continue;
      }
      if (tree === null) {
        // A vanished slot record never comes back, so no retry could succeed: the task leaves the hold at once and goes
        // through R2 (re-provisioning from its branch).
        p.leaseHeld.delete(id);
        counter(p, "lease-held-slot-lost", { taskId: id });
        slotVanished(p, id);
        continue;
      }
      tasks.push({ id, slot: t.slot, tree, footprint: t.footprint });
    }
    if (tasks.length === 0) return;
    let failed: ReadonlyArray<{ taskId: TaskId }>;
    try {
      failed = p.leases.rebuild(tasks);
    } catch (e) {
      d.log("warn", "lease rebuild retry failed", errorText(e));
      return;
    }
    const still = new Set(failed.map((f) => f.taskId));
    for (const t of tasks) {
      if (still.has(t.id)) continue;
      p.leaseHeld.delete(t.id);
      counter(p, "lease-rebuilt", { taskId: t.id });
      resumeHeldTask(p, t.id);
    }
  }

  /**
   * QA-4.2-26: R2 for a held task whose slot record vanished: `completed`/`verifying` re-verify with an invalid slot
   * (QA-4.2-13/-20 included), `verified` is re-provisioned from its branch and re-enqueued; a `running` task needs
   * nothing here (its end is processed as usual and a commit without a slot fails, counted).
   */
  function slotVanished(p: PlanRt, taskId: TaskId): void {
    p.slotLeases.delete(taskId);
    const waiting = p.recoveredWork.get(taskId);
    if (waiting?.work.kind === "reverify" && !waiting.started) {
      waiting.work.slotValid = false;
      schedule(p);
      return;
    }
    bg("held task slot lost", () =>
      withTask(p, taskId, async () => {
        const t = own(p.writer.ledger, taskId);
        if (t === null || p.disposed) return;
        if (t.state === "completed" || t.state === "verifying") await reverify(p, taskId, false);
        else if (t.state === "verified" && (await reprovisionOrRaise(p, t)) && !p.latch) p.collab.queue.enqueue([taskId]);
      }),
    );
  }

  /** QA-4.2-16: the step a lease hold deferred: commit-and-verify, the verifier again, or the queue. */
  function resumeHeldTask(p: PlanRt, taskId: TaskId): void {
    if (p.recoveredWork.has(taskId)) {
      schedule(p);
      return;
    }
    bg("held task resume", () =>
      withTask(p, taskId, async () => {
        if (p.disposed || p.leaseHeld.has(taskId)) return;
        const t = own(p.writer.ledger, taskId);
        const n = t === null ? undefined : t.attempts[t.attempts.length - 1]?.n;
        if (t === null || n === undefined || t.slot === null) return;
        if (t.state === "completed") await commitAndVerify(p, taskId, n);
        else if (t.state === "verifying") await verifyAttempt(p, taskId, n, await slotLeaseOf(p, t));
        else if (t.state === "verified" && !p.latch) p.collab.queue.enqueue([taskId]);
      }),
    );
  }

  async function slotLeaseOf(p: PlanRt, t: TaskNode): Promise<SlotLease> {
    const cached = p.slotLeases.get(t.id);
    if (cached !== undefined) return cached;
    if (t.slot === null) throw new ExecutorError("E_PLAN_STATE", "task holds no slot", t.id);
    const rec = await slotsFor(p.planId).get(t.slot);
    if (rec === null) throw new ExecutorError("E_SLOT_BROKEN", "slot record missing", t.slot);
    const lease: SlotLease = {
      slot: rec.slot,
      path: rec.path,
      planId: p.planId,
      owner: leaseHolderID(p.planId, t.id),
      commit: rec.commit ?? p.writer.ledger.integration.head,
    };
    p.slotLeases.set(t.id, lease);
    return lease;
  }

  function withTask<T>(p: PlanRt, taskId: TaskId, fn: () => Promise<T>): Promise<T> {
    return mutex.run(`${p.planId}/${taskId}`, fn);
  }

  function registerRecoveredWork(p: PlanRt, t: TaskNode, work: RecoveredWork["work"]): void {
    const a = t.attempts[t.attempts.length - 1];
    if (a === undefined || p.disposed || disposed || p.recoveredWork.has(t.id)) return;
    p.recoveredWork.set(t.id, { taskId: t.id, n: a.n, nonce: a.nonce, state: t.state, work, started: false });
    schedule(p);
  }

  /** The launcher's live context gate is also the admission gate for recovered verification (D14). */
  function admitRecoveredWork(p: PlanRt): void {
    if (p.recovering || p.disposed || disposed || p.passive) return;
    for (const w of p.recoveredWork.values()) {
      // R2 must still try to recover an invalid slot even when the old tree's lease rebuild failed. Re-provisioning
      // performs its own lease acquisition/undo; only commit/check/verify remains held until leases are back: a
      // re-verify of a valid slot and a completed child's end (commit then verify). An end that needs no verification
      // (a failed, lost, capacity-stopped or interrupted child) is recorded at once and releases its token.
      const held = (): boolean => p.leaseHeld.has(w.taskId)
        && (w.work.kind === "reverify" ? w.work.slotValid !== false : w.work.end.kind === "completed");
      if (w.started || held()) continue;
      if (!d.launcher.gate(p.writer.ledger.orchestrator.sessionID).ok) return;
      w.started = true; // synchronous reservation: repeated ticks/captures cannot queue a second pipeline
      holdAttachment(p, bg("recovered task work", () => withTask(p, w.taskId, async () => {
        let parked = false;
        try {
          const t = own(p.writer.ledger, w.taskId);
          const a = t?.attempts[t.attempts.length - 1];
          if (disposed || p.disposed || plans.get(p.planId) !== p || p.recoveredWork.get(w.taskId) !== w
            || t === null || a === undefined || t.state !== w.state || a.n !== w.n || a.nonce !== w.nonce) return;
          // Context/leases may have changed while this task waited for its mutex. Never spend a grader rerun on admission.
          if (held() || !d.launcher.gate(p.writer.ledger.orchestrator.sessionID).ok) {
            parked = true;
            return;
          }
          if (w.work.kind === "reverify") await reverify(p, w.taskId, w.work.slotValid);
          else await processEndNow(p, w.taskId, w.n, w.work.end);
        } finally {
          if (p.recoveredWork.get(w.taskId) === w) {
            if (parked) w.started = false;
            else p.recoveredWork.delete(w.taskId);
          }
          schedule(p);
        }
      })));
    }
  }

  /**
   * Capacity view built per tick over the current controller (QA-3.1-11). A task the RouteResolver throws on gets a
   * placeholder route without free capacity (never scheduled) and its error is recorded in `failed` (row 4b).
   */
  function viewOf(p: PlanRt, failed: Map<TaskId, string> | null): CapacityView {
    const base = capacityView(p.capacity, d.routes);
    return {
      routeOf(task: TaskNode): TaskRoute {
        try {
          const route = base.routeOf(task);
          observe(p, "route", () => ({ taskId: task.id, provider: route.provider, heavy: route.heavy }));
          return route;
        } catch (e) {
          failed?.set(task.id, errorText(e));
          observe(p, "route-unavailable", () => ({ taskId: task.id }));
          return { agent: task.route.role, model: { providerID: UNROUTABLE, modelID: UNROUTABLE, variant: null }, provider: UNROUTABLE, heavy: false };
        }
      },
      free(provider: string, heavy: boolean): number {
        const free = provider === UNROUTABLE ? 0 : base.free(provider, heavy);
        observe(p, "capacity-free", () => ({ provider, heavy, free }));
        return free;
      },
    };
  }

  function readyOf(p: PlanRt, l: Readonly<LedgerV1>, failed: Map<TaskId, string> | null): ScheduledTask[] {
    const leases = d.observations === undefined ? p.leases : { holder(path: string) {
      const holder = p.leases.holder(path);
      observe(p, "lease-eligibility", () => ({
        writers: Object.values(l.tasks).filter((t) => t.footprint.writes.includes(path)).map((t) => t.id),
        holder: holder === null ? null : { planId: holder.planId, taskId: holder.taskId },
      }));
      return holder;
    } };
    return d.scheduler.readySet(l, p.inFlight, leases, viewOf(p, failed));
  }

  /** One backoff tick after a skipped launch step (QA-3.1-6): min(2^k * 1 s, 60 s), one timer per plan. */
  function armBackoff(p: PlanRt): void {
    if (p.backoff !== null || p.disposed || disposed) return;
    const ms = Math.min(BACKOFF_BASE_MS * 2 ** p.skipStreak, BACKOFF_MAX_MS);
    p.skipStreak = Math.min(p.skipStreak + 1, 16);
    const h = d.clock.setTimer(ms, () => {
      p.timers.delete(h);
      if (p.backoff === h) p.backoff = null;
      schedule(p);
    });
    p.timers.add(h);
    p.backoff = h;
  }

  /** Drops an armed backoff tick (QA-3.1-26). */
  function clearBackoff(p: PlanRt): void {
    const h = p.backoff;
    if (h === null) return;
    p.backoff = null;
    p.timers.delete(h);
    d.clock.clearTimer(h);
  }

  /** The pool notifies only after the physical task slot's release is durable (never at TS(null)). */
  function taskSlotReleased(p: PlanRt): void {
    p.slotReleaseGeneration += 1;
    // A skipped launch returning its own fresh slot must not spin by waking itself. Wake physical waiters only.
    if (!p.slotWaiting || p.disposed || disposed) return;
    p.slotWaiting = false;
    p.skipStreak = 0;
    clearBackoff(p);
    schedule(p);
  }

  /**
   * QA-3.1-22: a RouteResolver error is the resolver's, not the task's: uncounted, nothing journaled, retried by the
   * backoff tick. One failure is counted per backoff round (the round that arms the timer), so a burst of ticks inside
   * one round counts once; ROUTE_STREAK consecutive rounds raise ONE blocking inbox item (reset by a clean resolve).
   */
  async function routeFailures(p: PlanRt, failed: ReadonlyMap<TaskId, string>): Promise<void> {
    for (const taskId of failed.keys()) counter(p, "launch-skipped", { reason: "route", taskId });
    if (p.backoff !== null) return;
    armBackoff(p);
    p.routeFails += 1;
    if (p.routeFails < ROUTE_STREAK || p.routeRaised) return;
    p.routeRaised = true;
    const [first] = failed;
    const taskId = first?.[0] ?? null;
    counter(p, "route-streak", taskId === null ? {} : { taskId });
    await raiseSafe(p, {
      kind: "failure",
      severity: "blocking",
      taskId,
      text: `${ROUTE_STREAK} consecutive ticks could not resolve a route (last: ${first?.[0] ?? "?"}: ${first?.[1] ?? "unknown error"}); fix the route resolver, then answer`,
      options: [],
    });
  }

  /** A launch went out: the skip backoff and the provisioning streak start over. */
  function launchSucceeded(p: PlanRt): void {
    p.skipStreak = 0;
    p.provisionFails = 0;
    p.provisionRaised = false;
  }

  /**
   * Parks through the policy (P1). After the fsync the policy released the leases (P3); the runtime returns the slot the
   * park batch cleared to the pool (4.2.5) and forgets its lease. A park that wrote nothing keeps the slot.
   */
  async function parkTask(p: PlanRt, taskId: TaskId, cause: Parameters<UnattendedPolicy["park"]>[1], text: string, presaved: SaveResult | null = null): Promise<void> {
    const before = own(p.writer.ledger, taskId);
    const slotName = before?.slot ?? null;
    // pdf2-1 (b): the slot's work is saved at the task's WIP ref before the park releases it (the policy's own hook,
    // `beforeSlotRelease`, skips a park this saved already). `presaved`: the caller knows the slot holds nothing to save.
    const key = `${p.planId}/${taskId}`;
    const saved: SaveResult = presaved ?? (slotName === null ? "clean" : await snapshotTaskSlot(p, taskId, slotName, cause));
    parkSaved.set(key, saved);
    try {
      await p.collab.policy.park(taskId, cause, text);
    } finally {
      parkSaved.delete(key);
    }
    if (saved === "failed" && slotName !== null) {
      // QA-PDF21-3: the work has no ref: the slot is never released here (the policy's hook kept it on the task) and one
      // blocking item names it.
      await wipHold(p, taskId, slotName, "the park released it");
      return;
    }
    const after = own(p.writer.ledger, taskId);
    if (slotName === null || after === null || after.state !== "parked" || after.slot !== null) return;
    p.slotLeases.delete(taskId);
    if (await slotHeldBy(p, taskId, slotName)) {
      try {
        await slotsFor(p.planId).release(slotName);
      } catch (e) {
        d.log("warn", "slot release failed", errorText(e));
      }
    }
  }

  /**
   * QA-PDF21-14: whether the pool's record of `slotName` leases it to an owner other than `taskId` (the slot's worktree is
   * someone else's). False when the record is gone, not leased, or cannot be read.
   */
  async function leasedToOther(p: PlanRt, taskId: TaskId, slotName: string): Promise<boolean> {
    try {
      const rec = await slotsFor(p.planId).get(slotName);
      return rec !== null && rec.state === "leased" && rec.owner !== null && rec.owner !== leaseHolderID(p.planId, taskId);
    } catch {
      return false;
    }
  }

  /**
   * Only a missing slot directory is gone. Missing repository metadata is not evidence that its files are disposable.
   */
  function slotGone(path: string): boolean {
    if (path === "") return false;
    try {
      slotLstatSync(path);
      return false;
    } catch (e) {
      return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
    }
  }

  /** Whether the pool still leases `slotName` to `taskId` (a policy that already returned it leaves nothing to do). */
  async function slotHeldBy(p: PlanRt, taskId: TaskId, slotName: string): Promise<boolean> {
    try {
      const rec = await slotsFor(p.planId).get(slotName);
      return rec !== null && rec.owner === leaseHolderID(p.planId, taskId) && rec.state === "leased";
    } catch {
      return true;
    }
  }

  // ---------- pdf2-1 (b): no lost work

  /** Plans whose repository is a git checkout on disk (WIP refs live in its common directory), by plan id. */
  const wipRepos = new Map<PlanId, boolean>();
  /** `<plan>/<task>` of the parks `parkTask` is running -> the result of the save it ran before (QA-PDF21-3). */
  const parkSaved = new Map<string, SaveResult>();
  /** QA-PDF21-7: `<plan>/<task>` of the restore-conflict parks running now: their item offers `WIP_PARK_OPTIONS`. */
  const restoreParks = new Set<string>();
  /** pdf2-1 (a): the launch request of each open attempt, by `<plan>/<task>#<n>`; a budget resume reuses it. */
  const launchRequests = new Map<string, LaunchRequest>();

  /** Whether the plan's toplevel is a git checkout on disk; WIP refs are never written or read otherwise. */
  function wipCapable(p: PlanRt): boolean {
    const known = wipRepos.get(p.planId);
    if (known !== undefined) return known;
    let capable = false;
    try {
      capable = gitPointers(p.writer.ledger.repo.toplevel) !== undefined;
    } catch {
      capable = false;
    }
    wipRepos.set(p.planId, capable);
    return capable;
  }

  /**
   * QA-PDF21-3: the result of a save before a reset or a release. `saved` (the work has a ref, or already had it) and
   * `clean` (nothing to save) let the caller go ahead; `failed` forbids both: the work has no ref of its own.
   */
  type SaveResult = "saved" | "clean" | "failed";
  /** QA-PDF21-6: `<plan>/<task>` -> the attempt whose slot holds the task's restored WIP (an undone restore drops the ref). */
  const wipRestored = new Map<string, number>();
  /** QA-PDF21-3: `<plan>/<slot>` of the slots whose failed save raised its blocking item already (cleared by a save). */
  const wipFailRaised = new Set<string>();

  /** The quarantine directory is durable even if the process dies between the rename and journaling its item. */
  function quarantinedSlots(p: PlanRt): string[] {
    if (d.executorHome === undefined) return [];
    try {
      return readdirSync(join(d.executorHome, "quarantine", p.planId)).flatMap((name) => {
        const match = /^(slot-\d+|integration|ci)-\d+$/.exec(name);
        return match?.[1] === undefined ? [] : [match[1]];
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  function quarantineHeld(p: PlanRt, slot: string): boolean {
    try { return quarantinedSlots(p).includes(slot); }
    catch (error) {
      d.log("warn", "quarantine cannot be inspected; slot kept", errorText(error));
      return true;
    }
  }

  /**
   * Saves the work in `slot` at `ref` (a WIP commit with the `Omr-Wip` trailer, never `Omr-Attempt`), parented at
   * `slot.base` when given (QA-PDF21-6: the lease base, so committed work is saved too), then resets the slot to its HEAD.
   * QA-PDF21-3: a leftover `index.lock` is removed and the step retried once; an `update-ref` that fails twice leaves the
     * commit at a unique orphan ref and the slot unreset. Never throws: a failure is logged and counted, and `failed` is
     * returned (the caller must neither reset nor release the slot).
     * `deferredMetrics` buffers diagnostics for a preflight whose refusal must not write to the ledger.
   */
  async function saveSlotWork(p: PlanRt, slot: { slot: string; path: string; base?: string | null }, ref: string, message: string, trailer: string, taskId: TaskId | null, deferredMetrics?: MetricPayload[]): Promise<SaveResult> {
    if (quarantineHeld(p, slot.slot)) return "failed";
    if (!wipCapable(p)) return "clean";
    const o = { cwd: slot.path, timeoutMs: GIT_TIMEOUT_MS };
    // Never let git climb from a metadata-less slot into an enclosing repository.
    if (slotGone(slot.path)) {
      wipFailRaised.delete(`${p.planId}/${slot.slot}`);
      counter(p, "wip-slot-gone", taskId === null ? { slot: slot.slot } : { taskId, slot: slot.slot }, deferredMetrics);
      return "clean";
    }
    try {
      if (gitPointers(slot.path) === undefined) {
        if (d.executorHome === undefined) throw new Error("cannot quarantine a slot without the executor home");
        const root = join(d.executorHome, "quarantine", p.planId);
        const destination = join(root, `${slot.slot}-${d.clock.now()}`);
        await mkdir(root, { recursive: true });
        await rename(slot.path, destination);
        d.log("warn", `slot ${slot.slot} quarantined at ${destination}; repository metadata is missing`);
        await wipHold(p, taskId, slot.slot, `it was quarantined at ${destination} (repository metadata missing)`);
        return "failed";
      }
      const r = await snapshotSlotWork(d.git, {
        cwd: slot.path,
        ref,
        message,
        trailer,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(slot.base === undefined || slot.base === null ? {} : { base: slot.base }),
        fallbackRef: orphanRefName(p.planId, slot.slot, d.clock.now(), orphanTag()),
        removeIndexLock: () => removeIndexLock(d.git, o),
      });
      wipFailRaised.delete(`${p.planId}/${slot.slot}`);
      if (r.saved) counter(p, "wip-saved", taskId === null ? { slot: slot.slot, ref } : { taskId, slot: slot.slot, ref }, deferredMetrics);
      return r.saved || r.reason === "unchanged" ? "saved" : "clean";
    } catch (e) {
      d.log("error", `saving the work in slot ${slot.slot} failed; the slot is kept as it is`, errorText(e));
      counter(p, "wip-failed", taskId === null ? { slot: slot.slot } : { taskId, slot: slot.slot }, deferredMetrics);
      return "failed";
    }
  }

  /**
   * pdf2-1 (b): `snapshotWip(slot, plan, task, n, nonce, outcome)` at `refs/heads/omr/<plan>/wip/<task>`.
   * QA-PDF21-6: a slot that held the restored WIP and is clean now (the child undid it all) drops the ref, so the stale
   * work is never restored again.
   */
  async function snapshotWip(p: PlanRt, slot: { slot: string; path: string; base?: string | null }, taskId: TaskId, n: number, nonce: string, outcome: string, deferredMetrics?: MetricPayload[]): Promise<SaveResult> {
    const key = `${p.planId}/${taskId}`;
    const r = await saveSlotWork(p, slot, wipRefName(p.planId, taskId), `wip(${taskId}): attempt ${n} ${outcome}`, wipTrailer(p.planId, taskId, n, nonce), taskId, deferredMetrics);
    if (r === "saved") wipRestored.delete(key);
    else if (r === "clean" && wipRestored.has(key)) {
      wipRestored.delete(key);
      await dropWip(p, taskId);
    }
    return r;
  }

  /**
   * pdf2-1 (b): a dirty slot no task of the plan holds any more goes to `omr/<plan>/orphan/<slot>-<ts>-<nonce>`, never
   * restored (QA-PDF21-10: the nonce keeps two saves of one slot in one millisecond apart).
   */
  async function snapshotOrphan(p: PlanRt, slot: { slot: string; path: string }, deferredMetrics?: MetricPayload[]): Promise<SaveResult> {
    const ms = d.clock.now();
    const tag = orphanTag();
    return saveSlotWork(p, slot, orphanRefName(p.planId, slot.slot, ms, tag), `wip(orphan): slot ${slot.slot}`, `${WIP_TRAILER}: ${p.planId}/orphan/0/${ms}-${tag}`, null, deferredMetrics);
  }

  /**
   * The path of `slotName` and its lease base (the commit it was reset to): the task's cached lease, else the pool's
   * record; null when neither knows it.
   */
  async function slotPathOf(p: PlanRt, taskId: TaskId, slotName: string): Promise<{ path: string; base: string | null } | null> {
    const cached = p.slotLeases.get(taskId);
    if (cached !== undefined && cached.slot === slotName) return { path: cached.path, base: cached.commit };
    try {
      const rec = await slotsFor(p.planId).get(slotName);
      return rec === null ? null : { path: rec.path, base: rec.commit ?? null };
    } catch (e) {
      d.log("warn", `slot lookup of ${slotName} failed`, errorText(e));
      return null;
    }
  }

  /**
   * pdf2-1 (b): before a reset or a release of `slotName`, which `taskId` still holds: its latest attempt's work goes to the
   * task's WIP ref (QA-PDF21-6: parented at the lease base, committed work included). A slot the pool no longer leases to
   * the task is saved as an orphan instead. Never throws; `failed` forbids the reset or release (QA-PDF21-3).
   */
  async function snapshotTaskSlot(p: PlanRt, taskId: TaskId, slotName: string, outcome: string, deferredMetrics?: MetricPayload[]): Promise<SaveResult> {
    if (!wipCapable(p)) return "clean";
    const at = await slotPathOf(p, taskId, slotName);
    if (at === null) return "clean";
    const t = own(p.writer.ledger, taskId);
    const a = t?.attempts[t.attempts.length - 1];
    // QA-PDF21-14: a worktree the pool leases to another owner is never touched (no `add -A`, no `reset --hard` in it):
    // nothing in it is this task's, so there is nothing to save.
    if (await leasedToOther(p, taskId, slotName)) {
      counter(p, "wip-foreign-slot", { taskId, slot: slotName }, deferredMetrics);
      return "clean";
    }
    if (t === null || a === undefined || !(await slotHeldBy(p, taskId, slotName))) return snapshotOrphan(p, { slot: slotName, path: at.path }, deferredMetrics);
    return snapshotWip(p, { slot: slotName, path: at.path, base: at.base }, taskId, a.n, a.nonce, outcome, deferredMetrics);
  }

  /**
   * QA-PDF21-3: a slot whose work could not be saved is neither reset nor released: it stays leased (to `taskId` when one
   * holds it) and one blocking item names it, once per slot until a save of it succeeds. Never throws.
   */
  async function wipHold(p: PlanRt, taskId: TaskId | null, slotName: string, what: string): Promise<string | null> {
    const key = `${p.planId}/${slotName}`;
    counter(p, "wip-hold", taskId === null ? { slot: slotName } : { taskId, slot: slotName });
    wipFailRaised.add(key);
    const existing = openWipHoldItem(p, slotName);
    if (existing !== null) return existing;
    try {
      const item = await p.collab.policy.raise({
        kind: "failure",
        severity: "blocking",
        taskId,
        text: wipHoldText(slotName, what, taskId),
        options: [],
      });
      return item.id;
    } catch (e) {
      d.log("warn", "inbox raise failed", errorText(e));
      return openWipHoldItem(p, slotName);
    }
  }

  /** QA-PDF21-13: the open item a failed save of `slotName` raised, if any (the newest). */
  function openWipHoldItem(p: PlanRt, slotName: string): string | null {
    const inbox = p.writer.ledger.inbox;
    for (let i = inbox.length - 1; i >= 0; i--) {
      const x = inbox[i];
      if (x !== undefined && x.answer === null && wipHoldSlotOf(x.text) === slotName) return x.id;
    }
    return null;
  }

  /** QA-PDF21-15: the slots of the plan whose failed save holds them (their `wipHold` item is raised). */
  function heldSlotsOf(p: PlanRt): string[] {
    const prefix = `${p.planId}/`;
    return [...wipFailRaised].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  }

  /** Holds survive process restarts: the journal and still-leased pool markers are the authority, not this cache. */
  async function rebuildHeldSlots(p: PlanRt): Promise<void> {
    for (const slot of quarantinedSlots(p)) wipFailRaised.add(`${p.planId}/${slot}`);
    for (const item of p.writer.ledger.inbox) {
      const slot = item.answer === null ? wipHoldSlotOf(item.text) : null;
      if (slot !== null) wipFailRaised.add(`${p.planId}/${slot}`);
    }
    for (const task of Object.values(p.writer.ledger.tasks)) {
      if (task.slot !== null) wipFailRaised.add(`${p.planId}/${task.slot}`);
    }
    if (isForeign(p.writer.ledger.repo.toplevel) || !["running", "paused", "completed", "aborted"].includes(p.writer.ledger.status)) return;
    const terminal = p.writer.ledger.status === "completed" || p.writer.ledger.status === "aborted";
    let markers: Awaited<ReturnType<SlotPool["list"]>>;
    try { markers = await slotsFor(p.planId).list(); }
    catch (error) { throw new ExecutorError("E_PLAN_STATE", `plan ${p.planId}: unsaved slot markers could not be read (${errorText(error)})`, { planId: p.planId }); }
    for (const marker of markers) {
      if (marker.planId === p.planId && (terminal || marker.state === "leased")) wipFailRaised.add(`${p.planId}/${marker.slot}`);
    }
  }

  /**
   * QA-PDF21-15: one more save of a slot a failed save holds (the answer to its item, a collection, a purge, a manual gc).
   * The task the ledger gives the slot to, else the one the pool leases it to, saves it at its WIP ref under its task
   * mutex (`snapshotTaskSlot`; an orphan ref when no task of the plan holds it). A save that succeeds clears the hold
   * (`saveSlotWork`); a slot no task holds in the ledger any more then goes back to the pool, the release that failed
   * before. A slot the pool no longer knows holds nothing: its hold ends. Never throws; returns the save's result.
   */
  async function retryHeldSave(p: PlanRt, slotName: string, outcome: string): Promise<SaveResult> {
    const key = `${p.planId}/${slotName}`;
    if (!SLOT_NAME_PATTERN.test(slotName) || quarantineHeld(p, slotName)) return "failed";
    let owner: string | null = null;
    let path: string;
    try {
      const rec = await slotsFor(p.planId).get(slotName);
      if (rec === null) {
        const path = join(p.writer.ledger.config.slotsDir ?? defaultSlotsDir(p.writer.ledger.repo.toplevel, p.planId), slotName);
        if (!slotGone(path)) return snapshotOrphan(p, { slot: slotName, path });
        wipFailRaised.delete(key);
        return "clean";
      }
      owner = rec.state === "leased" ? rec.owner : null;
      path = rec.path;
    } catch (e) {
      d.log("warn", `slot lookup of the held slot ${slotName} failed`, errorText(e));
      return "failed";
    }
    const tasks = Object.values(p.writer.ledger.tasks);
    const inLedger = tasks.find((t) => t.slot === slotName) ?? null;
    const holder = inLedger ?? tasks.find((t) => leaseHolderID(p.planId, t.id) === owner) ?? null;
    if (holder === null) {
      const result = await snapshotOrphan(p, { slot: slotName, path });
      if (result !== "failed") wipFailRaised.delete(key);
      return result;
    }
    return withTask(p, holder.id, async () => {
      const r = await snapshotTaskSlot(p, holder.id, slotName, outcome);
      if (r === "failed") return r;
      wipFailRaised.delete(key);
      const now = own(p.writer.ledger, holder.id);
      if ((now === null || now.slot !== slotName) && (await slotHeldBy(p, holder.id, slotName))) {
        if (p.slotLeases.get(holder.id)?.slot === slotName) p.slotLeases.delete(holder.id);
        try {
          await slotsFor(p.planId).release(slotName);
        } catch (e) {
          d.log("warn", "slot release failed", errorText(e));
        }
      }
      return r;
    });
  }

  /**
   * QA-PDF21-15: before a purge or a manual gc deletes the plan's slots: every slot a failed save holds is saved again;
   * one that still fails refuses the action (E_PLAN_STATE naming the slot) and its item stays open.
   */
  async function refuseUnsaved(p: PlanRt, action: "purge" | "gc"): Promise<void> {
    await rebuildHeldSlots(p);
    const failed: string[] = [];
    for (const slotName of heldSlotsOf(p)) {
      if ((await retryHeldSave(p, slotName, action)) !== "failed") continue;
      failed.push(slotName);
      await wipHold(p, null, slotName, action);
    }
    if (failed.length === 0) return;
    throw new ExecutorError(
      "E_PLAN_STATE",
      `plan ${p.planId}: the work in slot ${failed.join(", ")} could not be saved; ${action} refused (fix the slot's git state, then answer its item and retry)`,
      { planId: p.planId, slots: failed },
    );
  }

  /** The text of `wipHold`'s item; `answer` reads the slot back from it (`wipHoldSlotOf`, QA-PDF21-15). */
  function wipHoldText(slotName: string, what: string, taskId: TaskId | null): string {
    return `${WIP_HOLD_PREFIX}${slotName} could not be saved before ${what}; the slot keeps its work and stays leased${taskId === null ? "" : ` to ${taskId}`} (see the log). Fix the slot's git state, then answer`;
  }

  /**
   * pdf2-1 (b): drops the WIP refs of the plan's integrated and done tasks. Never throws. QA-PDF21-4: a cancelled task's
   * WIP ref is kept (an abort cancels tasks whose work it just saved); only purge deletes it.
   */
  async function sweepWip(p: PlanRt): Promise<void> {
    if (!wipCapable(p)) return;
    let names: string[];
    try {
      names = await listSlotRefs(d.git, { cwd: p.writer.ledger.repo.toplevel, prefix: `${planRefPrefix(p.planId)}wip/`, timeoutMs: GIT_TIMEOUT_MS });
    } catch (e) {
      d.log("warn", "listing the WIP refs failed", errorText(e));
      return;
    }
    if (names.length === 0) return;
    const present = new Set(names);
    for (const t of Object.values(p.writer.ledger.tasks)) {
      if (t.state !== "integrated" && t.state !== "done") continue;
      let ref: string;
      try {
        ref = wipRefName(p.planId, t.id);
      } catch {
        continue;
      }
      if (present.has(ref)) await dropWip(p, t.id);
    }
  }

  /** QA-PDF21-6: the task's final commit landed in its slot: its WIP ref (and the restored marker) go. Never throws. */
  async function finalCommitWip(p: PlanRt, taskId: TaskId): Promise<void> {
    wipRestored.delete(`${p.planId}/${taskId}`);
    await dropWip(p, taskId);
  }

  /** pdf2-1 (b): drops the task's WIP ref once its own commit landed, is integrated, or the task is done. Never throws. */
  async function dropWip(p: PlanRt, taskId: TaskId): Promise<void> {
    if (!wipCapable(p)) return;
    try {
      if (await deleteSlotRef(d.git, { cwd: p.writer.ledger.repo.toplevel, ref: wipRefName(p.planId, taskId), timeoutMs: GIT_TIMEOUT_MS })) {
        counter(p, "wip-dropped", { taskId });
      }
    } catch (e) {
      d.log("warn", `dropping the WIP ref of ${taskId} failed`, errorText(e));
    }
  }

  /**
   * pdf2-1 (b): restores the task's WIP ref into its freshly reset slot (`cherry-pick --no-commit`, HEAD stays the
   * integration head). Never throws: a git error is returned as `error` (the slot is reset again by the caller).
   */
  async function restoreWip(p: PlanRt, slot: SlotLease, taskId: TaskId): Promise<WipRestore | { kind: "error"; text: string }> {
    if (!wipCapable(p)) return { kind: "none" };
    try {
      const r = await restoreSlotWork(d.git, { cwd: slot.path, ref: wipRefName(p.planId, taskId), timeoutMs: GIT_TIMEOUT_MS });
      if (r.kind === "restored") counter(p, "wip-restored", { taskId, slot: slot.slot, files: String(r.files) });
      else if (r.kind === "conflict") counter(p, "wip-conflict", { taskId, slot: slot.slot });
      return r;
    } catch (e) {
      d.log("error", `restoring the work of ${taskId} in ${slot.slot} failed`, errorText(e));
      return { kind: "error", text: errorText(e) };
    }
  }

  /**
   * pdf2-1 (b): before `launchStep` resets the slot it acquired. The slot this task held (`acquire` gives it back
   * unreset): its latest attempt's work goes to the task's WIP ref, parented at `base` (QA-PDF21-6: the commit the slot
   * was reset to for that lease, so a committed attempt is carried over). Any other dirty slot: an orphan ref, never
   * restored. QA-PDF21-4: a released slot is saved before its release (`releaseSlotSaved`), since the pool's `acquire`
   * resets a ready slot before this runs. `failed` forbids the reset (QA-PDF21-3).
   */
  async function saveBeforeLaunchReset(p: PlanRt, t: TaskNode, slot: SlotLease, base: string | null): Promise<SaveResult> {
    if (!wipCapable(p)) return "clean";
    const a = t.attempts[t.attempts.length - 1];
    if (t.slot === slot.slot && a !== undefined) return snapshotWip(p, { slot: slot.slot, path: slot.path, base }, t.id, a.n, a.nonce, a.outcome ?? "interrupted");
    return snapshotOrphan(p, slot);
  }

  /**
   * pdf2-1 (b): the saved work does not apply on the integration head. The slot is reset again, the attempt is journaled
   * as dispatched and failed in one batch (row 4b's shape), then the task parks; the WIP ref is kept.
   */
  async function restoreConflicted(p: PlanRt, t: TaskNode, n: number, slot: SlotLease, why: string, abandon: () => Promise<void>): Promise<void> {
    const head = p.writer.ledger.integration.head;
    try {
      await slotsFor(p.planId).reset(slot.slot, head);
      // QA-PDF21-12: the cached lease names the commit the slot is at now, never the base before the reset.
      if (p.slotLeases.get(t.id)?.slot === slot.slot) p.slotLeases.set(t.id, leaseAt(slot, head));
    } catch (e) {
      d.log("warn", `slot reset after a restore conflict failed`, errorText(e));
    }
    const msg = `previous work conflicts with ${head}; wip ref kept (${wipRefName(p.planId, t.id)}): ${why}`;
    const gate = d.launcher.gate(p.writer.ledger.orchestrator.sessionID);
    const callID = gate.ok ? gate.context.callID : null;
    const nonce = d.clock.randomHex(16);
    const at = d.clock.iso();
    let applied = false;
    try {
      applied = await appendIf(p, (cur) => {
        const c = own(cur, t.id);
        if (c === null || c.state !== "ready" || c.attempts.length + 1 !== n || cur.status !== "running") return [];
        const ev: ExecutorEventInput[] = [];
        if (c.slot !== slot.slot) ev.push(ts(t.id, slot.slot, null));
        ev.push({
          type: "attempt-started",
          taskId: t.id,
          attempt: { n, nonce, callID, childSessionID: null, startedAt: at, endedAt: null, outcome: null, verdict: null, context: "" },
        });
        ev.push(tt(t.id, "ready", "dispatched", "launch"));
        ev.push(ae(t.id, n, "failed", at, msg), ax(t.id, n, msg), tt(t.id, "dispatched", "failed", "launch-task-error", msg));
        return ev;
      });
    } catch (e) {
      d.log("error", "restore conflict batch failed", errorText(e));
    }
    releaseToken(p, t.id, n, "other");
    if (!applied) {
      await abandon();
      return;
    }
    // QA-PDF21-7: the item offers a way out (`discard-wip` drops the ref on the answer, see `answer`).
    const key = `${p.planId}/${t.id}`;
    restoreParks.add(key);
    try {
      // QA-PDF21-12: no save: the slot holds only the aborted pick of the WIP ref itself, reset again above. A save there
      // (at a stale base) would replace the WIP ref through its compare-and-swap.
      await parkTask(p, t.id, "exhausted", `${msg}; answer discard-wip to relaunch without it, keep-wip to retry it`, "clean");
    } finally {
      restoreParks.delete(key);
    }
  }

  /** Raises one inbox item through the policy; never throws. */
  async function raiseSafe(p: PlanRt, item: Omit<InboxItem, "id" | "createdAt" | "answer">): Promise<void> {
    try {
      await p.collab.policy.raise(item);
    } catch (e) {
      d.log("warn", "inbox raise failed", errorText(e));
    }
  }

  // ---------- liveness (D15)

  function wakeText(planId: PlanId, reason: WakeReason, stateKey: string): string {
    return `[plan ${planId}] ${reason} (${stateKey}). Call router_plan action=status to see what needs you.`;
  }

  /** Wakes once per state key; retries `failed` as `<key>#2`, `<key>#3`; re-arms a tick on `debounced` (M32). */
  async function wakeOnce(p: PlanRt, reason: WakeReason, baseKey: string): Promise<void> {
    const st = p.wakeRetry.get(baseKey);
    let key = baseKey;
    if (st !== undefined) {
      if (st.done) return;
      const wait = st.nextAt - d.clock.now();
      if (wait > 0) {
        arm(p, wait);
        return;
      }
      key = `${baseKey}#${st.attempts + 1}`;
    }
    if (p.writer.wakeKeys().has(key)) return;
    if (st === undefined && p.writer.wakeKeys().has(baseKey)) return;
    const r = await p.waker.wake(reason, key);
    if (r === "debounced") {
      // Armed from the waker's own last attempt (sent or failed), never below 1 ms: no re-tick spin (QA-3.1-5).
      const last = p.waker.lastAttemptMs() ?? p.lastWakeMs ?? d.clock.now();
      arm(p, Math.max(1, last + p.writer.ledger.config.wakeDebounceMs - d.clock.now()));
      return;
    }
    if (r === "failed") {
      const attempts = (st?.attempts ?? 0) + 1;
      if (attempts >= 3) {
        p.wakeRetry.set(baseKey, { attempts, nextAt: 0, done: true });
        counter(p, "wake-failed", { reason });
      } else {
        const wait = p.writer.ledger.config.wakeDebounceMs;
        p.wakeRetry.set(baseKey, { attempts, nextAt: d.clock.now() + wait, done: false });
        arm(p, wait);
      }
    }
  }

  async function wakeChecks(p: PlanRt): Promise<void> {
    const l = p.writer.ledger;
    if (l.status !== "running" && l.status !== "paused") return;
    if (l.status === "running") {
      for (const id of d.scheduler.manualReady(l)) {
        const incoming = l.edges.filter((e) => e.to === id).length;
        await wakeOnce(p, "manual-ready", `manual-ready:${id}:${incoming}`);
      }
    }
    for (const ph of l.phases) {
      if (!ph.paused) continue;
      let anchor = "none";
      for (let i = l.inbox.length - 1; i >= 0; i--) {
        const item = l.inbox[i];
        if (item === undefined || item.taskId === null) continue;
        const t = own(l, item.taskId);
        if (t !== null && t.phase === ph.id) {
          anchor = item.id;
          break;
        }
      }
      if (anchor !== "none" && p.writer.wakeKeys().has(`inbox:${anchor}`)) continue;
      await wakeOnce(p, "phase-paused", `phase-paused:${ph.id}:${anchor}`);
    }
  }

  // ---------- metrics: idle-with-ready (M35)

  function updateIdle(p: PlanRt, ready: readonly ScheduledTask[], launched: number): void {
    const l = p.writer.ledger;
    const hold = p.orchIdle && l.status === "running" && ready.length > 0 && launched === 0;
    if (hold && p.idle === null) {
      let free = 0;
      const view = viewOf(p, null);
      for (const prov of new Set(ready.map((r) => r.route.provider))) free += p.capacity.limit(prov) > 0 ? view.free(prov, false) : 0;
      const t = d.clock.now();
      p.idle = { fromMs: t, fromAt: d.clock.iso(t), ids: ready.map((r) => r.taskId), free };
    } else if (!hold && p.idle !== null) closeIdle(p);
  }

  function closeIdle(p: PlanRt): void {
    const o = p.idle;
    if (o === null) return;
    p.idle = null;
    const t = d.clock.now();
    const ms = Math.max(0, t - o.fromMs);
    p.counters.idleMs += ms;
    const m: MetricPayload = { name: "idle-with-ready", fromAt: o.fromAt, toAt: d.clock.iso(t), ms, readyTaskIds: o.ids, free: o.free };
    metric(p, m);
    // Observe this continuation, not the host input or the later append; reuse the metric's one clock sample.
    observe(p, "idle-close", () => ({ fromMs: o.fromMs, toMs: t, ms, metric: { ...m, readyTaskIds: [...m.readyTaskIds] } }), t);
  }

  // ---------- tick

  function schedule(p: PlanRt): void {
    observe(p, "schedule");
    // A passively attached (refused) plan never ticks (QA-3.1-19); an activation under way neither (4.2.5: recovery and
    // the integration resume come before the first tick, which `recoverPlan`/`activate` schedule themselves).
    if (p.disposed || disposed || p.passive || p.recovering) return;
    if (p.ticking) {
      p.again = true;
      return;
    }
    p.ticking = true;
    bg("tick", async () => {
      try {
        do {
          p.again = false;
          await tickOnce(p);
        } while (p.again && !p.disposed);
      } finally {
        p.ticking = false;
        await collectFinished(p);
      }
    });
  }

  async function tickOnce(p: PlanRt): Promise<void> {
    if (p.latch || p.disposed) return;
    // QA-4.2-16: each tick (and so each lease release, which ticks every plan) retries a failed lease rebuild.
    if (p.leaseHeld.size > 0) await retryHeldLeases(p);
    admitRecoveredWork(p);
    let l = p.writer.ledger;
    if (l.status === "running") {
      const prom = d.scheduler.promotable(l);
      if (prom.toReady.length > 0) {
        const want = new Set(prom.toReady);
        await appendIf(p, (cur) => {
          if (cur.status !== "running" || p.latch) return [];
          const ok = new Set(d.scheduler.promotable(cur).toReady);
          const ev: ExecutorEventInput[] = [];
          for (const id of want) if (ok.has(id)) ev.push(tt(id, "pending", "ready", "deps-satisfied"));
          return ev;
        });
      }
      if (prom.unblock.length > 0) await p.collab.policy.unblock();
    }
    await wakeChecks(p);
    l = p.writer.ledger;
    if (l.status === "running" && planFinished(l)) {
      const done = await appendIf(p, (cur) =>
        cur.status === "running" && planFinished(cur)
          ? [{ type: "status-changed", from: "running", to: "completed", reason: "all-tasks-complete" }]
          : [],
      );
      if (done) {
        closeIdle(p);
        unpinPlan(p);
        await wakeOnce(p, "plan-completed", `plan-completed:${p.planId}`);
        if (p.writer.ledger.config.land === "ff-when-clean") await p.collab.queue.land();
        return;
      }
    }
    l = p.writer.ledger;
    if (l.status !== "running") {
      closeIdle(p);
      // Recovery also re-verifies paused plans. Their pending work needs a root context even without launchable work.
      if ([...p.recoveredWork.values()].some((w) => !w.started)) {
        const gate = d.launcher.gate(l.orchestrator.sessionID);
        if (!gate.ok && gate.wake !== null) await wakeOnce(p, gate.wake.reason, gate.wake.stateKey);
      }
      if (l.status === "completed" || l.status === "aborted") unpinPlan(p);
      // A plan-completed wake that was debounced or failed is retried by the tick wakeOnce re-armed (M32); idempotent per key.
      if (l.status === "completed") await wakeOnce(p, "plan-completed", `plan-completed:${p.planId}`);
      return;
    }
    const unroutable = new Map<TaskId, string>();
    let ready = readyOf(p, l, unroutable);
    const gate = d.launcher.gate(l.orchestrator.sessionID);
    let taskSlots: SlotRecord[] = [];
    if (ready.length > 0 && gate.ok) {
      const slotGeneration = p.slotReleaseGeneration;
      try {
        taskSlots = (await slotsFor(p.planId).list(p.planId))
          .filter((s) => s.kind === "task" && s.planId === p.planId && s.state !== "retired");
      } catch (e) {
        counter(p, "launch-skipped", { reason: "provision" });
        armBackoff(p);
        await provisionFailed(p, ready[0]!.taskId, e);
        return;
      }
      // A release/integration can happen during the snapshot. Re-read priority, dependencies, leases and capacity
      // before reserving anything; launchStep still rechecks the retained context and durable launch gates.
      l = p.writer.ledger;
      if (p.disposed || p.latch || l.status !== "running") return;
      // A wake during the snapshot may have newly satisfied a pending dependent. Let the next pass promote it
      // before admitting an already-ready, lower-priority task into the released slot.
      if (p.again || slotGeneration !== p.slotReleaseGeneration) {
        p.again = true;
        return;
      }
      unroutable.clear();
      ready = readyOf(p, l, unroutable);
    }
    for (const taskId of [...unroutable.keys()]) if (p.inFlight.has(taskId)) unroutable.delete(taskId);
    // Synchronous up to the raise (counting and the backoff arm happen before its first await): the ready set stays fresh.
    if (unroutable.size > 0) void track(routeFailures(p, unroutable));
    else if (ready.length > 0) {
      p.routeFails = 0;
      p.routeRaised = false;
    }
    observe(p, "launch-gate", () => ({ ok: gate.ok, ready: ready.map((r) => r.taskId) }));
    if (ready.length === 0 || !gate.ok) {
      if ((ready.length > 0 || [...p.recoveredWork.values()].some((w) => !w.started)) && !gate.ok && gate.wake !== null) {
        await wakeOnce(p, gate.wake.reason, gate.wake.stateKey);
      }
      updateIdle(p, ready, 0);
      return;
    }
    // The steps run on their own (a slot acquire may run an install): the tick never awaits them (QA-3.1-14); `inFlight`
    // keeps a second tick off a task whose step is running, and `settled()` tracks every step. Each step's capacity token
    // is taken here, synchronously, before the step queues on its task mutex (QA-3.1-23): the next tick's ready set
    // already sees it, so two ticks back to back never schedule more launches than the capacity allows.
    // Mirror claimTask: reuse ready slots, create up to maxParallel, or replace broken slots. Same-owner retries
    // keep their existing slot and consume no free slot. An admitted step may still be waiting on its task mutex or
    // git before claiming: subtract those reservations so a second tick cannot admit a lower-priority competitor.
    // A step that relinquished its slot keeps only its inFlight guard, not a physical reservation during cleanup.
    const owners = new Set(taskSlots.flatMap((s) => s.owner === null ? [] : [s.owner]));
    let freeSlots = Math.max(0, l.config.maxParallel - taskSlots.length)
      + taskSlots.filter((s) => s.state === "ready" || s.state === "broken").length;
    for (const id of p.slotReservations) if (!owners.has(leaseHolderID(p.planId, id))) freeSlots -= 1;
    p.slotWaiting = false;
    const steps: Array<Promise<"launched" | "skipped">> = [];
    for (const item of ready) {
      const heldSlot = owners.has(leaseHolderID(p.planId, item.taskId));
      if (!heldSlot && freeSlots <= 0) {
        p.slotWaiting = true;
        counter(p, "launch-skipped", { reason: "slot-unavailable" });
        observe(p, "slot-admission", () => ({ taskId: item.taskId, result: "unavailable", free: Math.max(0, freeSlots) }));
        armBackoff(p);
        continue;
      }
      const n = (own(l, item.taskId)?.attempts.length ?? 0) + 1;
      try {
        p.tokens.set(tokenKey(item.taskId, n), p.capacity.acquire(item.route.provider, item.route.heavy, item.taskId, n));
        observe(p, "capacity-reserve", () => ({ taskId: item.taskId, attempt: n, provider: item.route.provider, heavy: item.route.heavy,
          token: p.tokens.get(tokenKey(item.taskId, n))?.id ?? null, force: false }));
      } catch {
        counter(p, "launch-skipped", { reason: "capacity-race" });
        armBackoff(p);
        continue;
      }
      if (!heldSlot) freeSlots -= 1;
      steps.push(startStep(p, item.taskId, () => launchStep(p, item, n), n));
    }
    void track(
      Promise.all(steps).then((results) => {
        updateIdle(p, ready, results.filter((r) => r === "launched").length);
      }),
    );
  }

  /**
   * Starts one launch step under the `inFlight` guard; a launch resets the skip backoff (QA-3.1-6). A step that journaled
   * an attempt without launching (rows 4b, 11, 12: L1-L4) re-ticks once its guard is gone: the tick its own row asked for
   * ran while the task was still in `inFlight` and so could not relaunch it. A step that journaled nothing is a skip and
   * arms the backoff tick instead, so skips never re-tick each other. The capacity token the tick took for attempt `n`
   * (QA-3.1-23) is released by every step that did not launch, also one that threw (release is idempotent).
   */
  function startStep(p: PlanRt, taskId: TaskId, fn: () => Promise<LaunchStepResult>, n: number): Promise<"launched" | "skipped"> {
    p.inFlight.add(taskId);
    p.slotReservations.add(taskId);
    observe(p, "launch-prepare", () => ({ taskId, attempt: n }));
    const attemptsOf = (): number => own(p.writer.ledger, taskId)?.attempts.length ?? 0;
    const before = attemptsOf();
    const slotGeneration = p.slotReleaseGeneration;
    const run = async (): Promise<"launched" | "skipped"> => {
      let r: LaunchStepResult = "skipped";
      try {
        r = await fn();
      } catch (e) {
        d.log("error", "launch step failed", errorText(e));
      } finally {
        p.slotReservations.delete(taskId);
        if (r !== "launched") releaseToken(p, taskId, n, "other");
        p.inFlight.delete(taskId);
        observe(p, "launch-step-end", () => ({ taskId, attempt: n, result: r === "launched" ? "launched" : "skipped" }));
      }
      if (r === "launched") launchSucceeded(p);
      else if (attemptsOf() !== before) schedule(p);
      else if (r === "slot-unavailable" && slotGeneration !== p.slotReleaseGeneration) {
        // The release tick may have seen this task still inFlight. Retry now that its guard is gone, not after backoff.
        p.skipStreak = 0;
        clearBackoff(p);
        schedule(p);
      } else armBackoff(p);
      return r === "launched" ? "launched" : "skipped";
    };
    return track(run());
  }

  /** QA-3.1-15: the orchestrator is pinned only while its plan runs or is paused. */
  function unpinPlan(p: PlanRt): void {
    const u = p.unpin;
    p.unpin = null;
    if (u === null) return;
    try {
      u();
    } catch (e) {
      d.log("warn", "orchestrator unpin failed", errorText(e));
    }
  }

  // ---------- launch step (M37)

  /** Step 1 (capacity) ran in the tick: the token of attempt `n` is held (QA-3.1-23); `startStep` frees it on a skip. */
  async function launchStep(p: PlanRt, item: ScheduledTask, n: number): Promise<LaunchStepResult> {
    return withTask(p, item.taskId, async () => {
      const taskId = item.taskId;
      let l = p.writer.ledger;
      const t0 = own(l, taskId);
      if (t0 === null || t0.state !== "ready" || l.status !== "running" || p.latch) return "skipped";
      // The task moved on while the step queued (an adopted late child, a retry): the token is not this attempt's.
      if (t0.attempts.length + 1 !== n) return "skipped";
      const fresh = t0.slot === null;
      const route = item.route;
      let slot: SlotLease | null = null;
      const abandon = async (): Promise<void> => {
        // No further acquire in this step. Drop its reservation BEFORE release can durably notify waiters;
        // inFlight still prevents this failed task from waking itself while release/cleanup is pending.
        p.slotReservations.delete(taskId);
        releaseToken(p, taskId, n, "other");
        if (fresh) {
          releaseLeases(p, taskId);
          if (slot !== null) await releaseResources(p, taskId, slot.slot);
        }
      };
      // 2. slot
      // QA-PDF21-6: the commit the task's slot was reset to for its last lease (the WIP base), read before `acquire`.
      const priorBase = t0.slot === null || !wipCapable(p) ? null : ((await slotPathOf(p, taskId, t0.slot))?.base ?? null);
      let saved: SaveResult = "clean";
      try {
        const { verifiedResetBase, ...acquired } = await slotsFor(p.planId).acquire(p.planId, leaseHolderID(p.planId, taskId), l.integration.head);
        slot = acquired;
        p.slotLeases.set(taskId, slot);
        // pdf2-1 (b): the work left in the slot is saved before the reset (this task's -> its WIP ref, else an orphan ref).
        // A verified full reset needs no snapshot; a same-owner lease has no such proof and must save first.
        if (verifiedResetBase === undefined) saved = await saveBeforeLaunchReset(p, t0, slot, priorBase);
        if (saved !== "failed") {
          // Provisioning/saving may await while integration advances. Only a full reset at the current head is proof.
          const head = p.writer.ledger.integration.head;
          if (verifiedResetBase !== head) await slotsFor(p.planId).reset(slot.slot, head);
          slot = leaseAt(slot, head);
          p.slotLeases.set(taskId, slot);
        }
      } catch (e) {
        const unavailable = errorCode(e) === "E_SLOT_UNAVAILABLE";
        if (unavailable) p.slotWaiting = true;
        counter(p, "launch-skipped", { reason: unavailable ? "slot-unavailable" : "provision" });
        await abandon();
        if (!unavailable) await provisionFailed(p, taskId, e);
        return unavailable ? "slot-unavailable" : "skipped";
      }
      if (saved === "failed") {
        // QA-PDF21-3: the slot's work has no ref: it is neither reset nor released and stays leased to the task; the
        // launch is skipped (backoff) and PROVISION_STREAK such skips in a row raise one blocking item naming the slot.
        counter(p, "launch-skipped", { reason: "wip-save" });
        releaseToken(p, taskId, n, "other");
        await provisionFailed(p, taskId, `the work in slot ${slot.slot} could not be saved before its reset; the slot keeps it and stays leased to ${taskId}`);
        return "skipped";
      }
      // 3. leases (a throwing registry must not leak the token and the fresh slot, QA-3.1-12)
      let got: ReturnType<LeaseService["acquireTask"]>;
      try {
        got = p.leases.acquireTask({ taskId, tree: slot.path, writes: t0.footprint.writes });
      } catch (e) {
        d.log("error", "launch step failed", errorText(e));
        counter(p, "launch-skipped", { reason: "lease-error" });
        await abandon();
        return "skipped";
      }
      if (!got.ok) {
        counter(p, "launch-skipped", { reason: "lease-race" });
        await abandon();
        return "skipped";
      }
      // 4. prep
      l = p.writer.ledger;
      const t1 = own(l, taskId);
      if (t1 === null || t1.state !== "ready" || t1.attempts.length + 1 !== n) {
        await abandon();
        return "skipped";
      }
      // QA-PDF21-5: the verifier's dispatch reference is captured first, at the clean reset commit: a check the restored
      // work breaks is then this attempt's failure, never a pre-existing one. A begin that throws fails the launch below
      // (row L4), as it did when it ran there.
      const nonce = d.clock.randomHex(16);
      let beginError: { e: unknown } | null = null;
      try {
        forgotten.delete(`${p.planId}/${taskId}#${n}`);
        const gate0 = d.launcher.gate(l.orchestrator.sessionID);
        const draft: Attempt = {
          n, nonce, callID: gate0.ok ? gate0.context.callID : null, childSessionID: null, startedAt: d.clock.iso(), endedAt: null,
          outcome: null, verdict: null, context: "",
        };
        await d.verifier.begin?.(t1, slot, draft, planTaskContext(p));
      } catch (e) {
        beginError = { e };
      }
      // pdf2-1 (b): the work of an earlier attempt (the task's WIP ref) comes back as uncommitted changes on the
      // integration head; a conflict resets the slot again and parks the task with the ref kept.
      const back = await restoreWip(p, slot, taskId);
      if (back.kind === "restored") wipRestored.set(`${p.planId}/${taskId}`, n);
      if (back.kind === "error") {
        // QA-PDF21-7: a transient git error is no conflict: the slot (only the ref's copy in it) is reset again and the
        // launch is skipped with the backoff; the ref is kept and the next tick retries the restore.
        try {
          await slotsFor(p.planId).reset(slot.slot, l.integration.head);
          if (p.slotLeases.get(taskId)?.slot === slot.slot) p.slotLeases.set(taskId, leaseAt(slot, l.integration.head));
        } catch (e) {
          d.log("warn", "slot reset after a failed restore failed", errorText(e));
        }
        counter(p, "launch-skipped", { reason: "wip-restore", taskId });
        await abandon();
        // QA-PDF21-16: a restore error that persists counts toward the provisioning streak, which raises one item.
        await provisionFailed(p, taskId, `restoring the work of ${taskId} (${wipRefName(p.planId, taskId)}) in slot ${slot.slot} failed: ${back.text}`);
        return "skipped";
      }
      if (back.kind === "conflict") {
        await restoreConflicted(p, t1, n, slot, back.conflicts.slice(0, 20).join(", "), abandon);
        return "skipped";
      }
      const restored = back.kind === "restored" && back.files > 0 ? { attempt: back.attempt, files: back.files } : null;
      let expanded: ExpandedTask;
      try {
        const env = await loadExpansionEnv(d.git, { toplevel: l.repo.toplevel, slotPath: slot.path, timeoutMs: GIT_TIMEOUT_MS });
        expanded = expandTask({ ledger: p.writer.ledger, taskId, attempt: n, nonce, slot, env, ...(restored === null ? {} : { restored }) });
      } catch (e) {
        if (errorCode(e) === "E_LAUNCH_TASK") {
          await launchPrepFailed(p, t1, n, nonce, slot, e, abandon);
          return "skipped";
        }
        counter(p, "launch-skipped", { reason: "provision" });
        await abandon();
        await provisionFailed(p, taskId, e);
        return "skipped";
      }
      // 5. gate re-read (M29)
      const gate = d.launcher.gate(l.orchestrator.sessionID);
      observe(p, "launch-gate", () => ({ taskId, attempt: n, ok: gate.ok }));
      if (!gate.ok) {
        await abandon();
        return "skipped";
      }
      const ctx = gate.context;
      // 6. row 4
      const startedAt = d.clock.iso();
      const leased = slot;
      let applied = false;
      try {
        applied = await appendIf(p, (cur) => {
          const c = own(cur, taskId);
          if (c === null || c.state !== "ready" || c.attempts.length + 1 !== n || cur.status !== "running" || p.latch) return [];
          const ph = phaseOf(cur, c);
          if (ph !== null && ph.paused) return [];
          if (c.kind === "qa" && (ph === null || ph.gate !== "awaiting-qa")) return [];
          const ev: ExecutorEventInput[] = [];
          if (c.slot !== leased.slot) ev.push(ts(taskId, leased.slot, null));
          ev.push({
            type: "attempt-started",
            taskId,
            attempt: { n, nonce, callID: ctx.callID, childSessionID: null, startedAt, endedAt: null, outcome: null, verdict: null, context: "" },
          });
          ev.push(tt(taskId, "ready", "dispatched", "launch"));
          ev.push(...gateOpen(cur, c));
          return ev;
        });
      } catch (e) {
        d.log("error", "launch batch failed", errorText(e));
      }
      if (!applied) {
        await abandon();
        return "skipped";
      }
      // 7. R4
      const old = p.handles.get(taskId);
      if (old !== undefined && !old.settled) {
        try {
          await d.launcher.cancel(taskId, old.n, "superseded");
        } catch (e) {
          d.log("warn", "cancel superseded failed", errorText(e));
        }
      }
      // 8. launch
      const req: LaunchRequest = {
        planId: p.planId,
        taskId,
        attempt: n,
        nonce,
        orchestratorSessionID: l.orchestrator.sessionID,
        context: { bootID: ctx.bootID, epoch: ctx.epoch, callID: ctx.callID },
        route,
        role: t1.route.role,
        grant: needsOf(expanded.routeLine),
        routeBudget: expanded.routeBudget ?? null,
        workRoot: expanded.workRoot,
        prompt: expanded.prompt,
      };
      let handle: LaunchHandle;
      try {
        forgotten.delete(`${p.planId}/${taskId}#${n}`);
        // QA-PDF21-5: `begin` ran before the restore (above); its error fails the launch here.
        if (beginError !== null) throw beginError.e;
        // A tick that reaches here after dispose began never hands the launcher a new child: the launcher's dispose
        // settled only the launches it knew, so a later one would keep its confirmation, and dispose, waiting forever.
        if (p.disposed) throw new ExecutorError("E_DISPOSED", "the runtime is disposing; no new launch");
        observe(p, "launch", () => ({ taskId, attempt: n, callID: ctx.callID, provider: route.provider, heavy: route.heavy }));
        handle = d.launcher.launch(req, launchHooks(p, taskId, n, route));
      } catch (e) {
        const code = errorCode(e);
        counter(p, "launch-failed", { row: code === "E_LAUNCH_TASK" ? "L2" : code === "E_NO_CONTEXT" ? "L3" : "L4" });
        if (code === "E_LAUNCH_TASK") await rowLaunchFailed(p, taskId, n, errorText(e));
        else if (code === "E_DISPOSED") releaseToken(p, taskId, n, "other");
        else await rowLost(p, taskId, n, code === "E_NO_CONTEXT" ? "no-context" : "launch-error");
        return "skipped";
      }
      launchRequests.set(requestKey(p, taskId, n), req);
      wireLaunch(p, taskId, n, handle, (q, c) => onConfirmation(q, taskId, n, c));
      p.counters.launches += 1;
      metric(p, {
        name: "launch",
        taskId,
        attempt: n,
        agent: route.agent,
        model: modelLabel(route),
        provider: route.provider,
        heavy: route.heavy,
      });
      return "launched";
    });
  }

  /**
   * The end and confirmation wiring of a launch (and of a budget resume, pdf2-1 (a)): the wait for the child is a child
   * wait (dispose never waits for it); processing its end, once it came, is ordinary work.
   */
  function wireLaunch(
    p: PlanRt,
    taskId: TaskId,
    n: number,
    handle: LaunchHandle,
    confirm: (q: PlanRt, c: LaunchConfirmation) => Promise<void>,
  ): void {
    const ref: HandleRef = { n, settled: false, completion: handle.completion };
    p.handles.set(taskId, ref);
    void trackChild(
      handle.completion.then((end) => {
        ref.settled = true;
        // QA-4.2-4: an end inside a same-process adopt's window waits for the new attachment.
        return track(live(p).then((q) => processEnd(q, taskId, n, end), (e: unknown) => {
          // pdf2-1 (a): no attachment processes this end, so no resume takes over the binding its completion held.
          releaseChildBinding(end);
          throw e;
        }));
      }),
    );
    void track(
      handle.confirmation.then(
        (c) => live(p).then((q) => confirm(q, c)),
        (e: unknown) => {
          d.log("warn", "confirmation rejected", errorText(e));
        },
      ),
    );
  }

  /**
   * Row 4b: a task-class prep error journals the dispatch and the failure in one batch. The token is always released;
   * when the batch is not applied (or throws) `abandon` frees a fresh slot and its leases too (QA-3.1-12).
   */
  async function launchPrepFailed(
    p: PlanRt,
    t: TaskNode,
    n: number,
    nonce: string,
    slot: SlotLease | null,
    e: unknown,
    abandon: () => Promise<void>,
  ): Promise<void> {
    const msg = errorText(e);
    const gate = d.launcher.gate(p.writer.ledger.orchestrator.sessionID);
    const callID = gate.ok ? gate.context.callID : null;
    const at = d.clock.iso();
    counter(p, "launch-failed", { row: "L1" });
    let applied = false;
    try {
      applied = await appendIf(p, (cur) => {
        const c = own(cur, t.id);
        if (c === null || c.state !== "ready" || c.attempts.length + 1 !== n || cur.status !== "running") return [];
        const ev: ExecutorEventInput[] = [];
        if (slot !== null && c.slot !== slot.slot) ev.push(ts(t.id, slot.slot, null));
        ev.push({
          type: "attempt-started",
          taskId: t.id,
          attempt: { n, nonce, callID, childSessionID: null, startedAt: at, endedAt: null, outcome: null, verdict: null, context: "" },
        });
        ev.push(tt(t.id, "ready", "dispatched", "launch"));
        const g1 = gateOpen(cur, c);
        ev.push(...g1);
        ev.push(ae(t.id, n, "failed", at, msg), ax(t.id, n, msg), tt(t.id, "dispatched", "failed", "launch-task-error", msg));
        const ph = phaseOf(cur, c);
        if (g1.length > 0 && ph !== null) {
          ev.push({ type: "gate-changed", phaseId: ph.id, from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued", qaRound: ph.qaRound });
        }
        return ev;
      });
    } finally {
      releaseToken(p, t.id, n, "other");
      // Not applied (task left ready) or the append threw: the slot and leases this step took are not the task's.
      if (!applied) await abandon();
    }
    if (!applied) return;
    await countAttempt(p, t.id, n);
    await retryDecision(p, t.id);
  }

  /** QA-3.1-6: PROVISION_STREAK consecutive provisioning failures raise one blocking inbox item (reset on a launch). */
  async function provisionFailed(p: PlanRt, taskId: TaskId, e: unknown): Promise<void> {
    p.provisionFails += 1;
    if (p.provisionFails < PROVISION_STREAK || p.provisionRaised) return;
    p.provisionRaised = true;
    counter(p, "provision-streak", { taskId });
    await raiseSafe(p, {
      kind: "failure",
      severity: "blocking",
      taskId,
      text: `${PROVISION_STREAK} consecutive launches could not provision a slot (last: ${errorText(e)}); fix the slot environment, then answer`,
      options: [],
    });
  }

  /**
   * The hooks resolve the plan's LIVE attachment at call time (`current(p0)`), as the launch-end path does: a same-process
   * adopt replaces the attachment while a launch is in flight, and a child created afterwards must be bound against the
   * new writer, not refused by the closed one.
   */
  function launchHooks(p0: PlanRt, taskId: TaskId, n: number, route: TaskRoute): LaunchHooks {
    return {
      // pdf2-1 (a): a completed child keeps its binding until `processEnd` decided on a budget resume of that child.
      holdCompletedBinding: true,
      async onLateChild(): Promise<"adopt" | "refuse"> {
        const p = await live(p0);
        const l = p.writer.ledger;
        const c = own(l, taskId);
        const a = c === null ? undefined : c.attempts[c.attempts.length - 1];
        const ok =
          c !== null && a !== undefined && a.n === n && a.outcome === "lost" && c.state === "ready" && c.slot !== null && l.status !== "aborted" && !p.latch;
        if (!ok) counter(p, "launch-failed", { row: "L11" });
        return ok ? "adopt" : "refuse";
      },
      async onChildCreated(childSessionID: string): Promise<void> {
        // The task mutex is keyed by plan and task, so it spans attachments; resolve again once it is held. A creation
        // inside a same-process adopt's window waits for the new attachment first (QA-4.2-4).
        await withTask(await live(p0), taskId, async () => {
          const p = current(p0);
          const c = own(p.writer.ledger, taskId);
          if (c === null) throw new ExecutorError("E_PLAN_STATE", "task vanished", taskId);
          const adopting = c.state === "ready";
          if (adopting) {
            try {
              p.tokens.set(tokenKey(taskId, n), p.capacity.acquire(route.provider, route.heavy, taskId, n, { force: true }));
              observe(p, "capacity-reserve", () => ({ taskId, attempt: n, provider: route.provider, heavy: route.heavy,
                token: p.tokens.get(tokenKey(taskId, n))?.id ?? null, force: true }));
            } catch (e) {
              throw new ExecutorError("E_CAPACITY", errorText(e), taskId);
            }
          }
          let applied = false;
          try {
            applied = await appendIf(p, (cur) => {
              const x = own(cur, taskId);
              if (x === null || cur.status === "aborted" || p.latch) return [];
              const last = x.attempts[x.attempts.length - 1];
              if (last === undefined || last.n !== n) return [];
              if (x.state === "dispatched" && last.outcome === null && last.childSessionID === null) {
                return [
                  { type: "attempt-child", taskId, n, childSessionID },
                  tt(taskId, "dispatched", "running", "child-created"),
                ];
              }
              if (x.state === "ready" && last.outcome === "lost" && x.slot !== null) {
                const g1 = gateOpen(cur, x);
                if (x.kind === "qa" && g1.length === 0) return [];
                return [{ type: "attempt-adopted", taskId, n, childSessionID }, tt(taskId, "ready", "running", "adopt"), ...g1];
              }
              return [];
            });
          } finally {
            if (!applied && adopting) releaseToken(p, taskId, n, "other");
          }
          if (adopting) counter(p, "launch-failed", { row: applied ? "L12" : "L11" });
          if (!applied) throw new ExecutorError("E_PLAN_STATE", "child refused", { taskId, n });
          recordChildProcess(p, taskId, n, childSessionID);
        });
      },
    };
  }

  /** A resumed child has the same attempt identity, but its launcher may be a new process after recovery. */
  function recordChildProcess(p: PlanRt, taskId: TaskId, n: number, childSessionID: string): void {
    const a = own(p.writer.ledger, taskId)?.attempts.find((a) => a.n === n);
    if (d.self !== undefined && a !== undefined) {
      counter(p, "child-process", { taskId, n: String(n), nonce: a.nonce, child: childSessionID,
        resumes: String(a.resumes ?? 0), pid: String(d.self.pid), hostname: d.self.hostname, token: d.self.token });
    }
  }

  /** `p0` may be an attachment a same-process adopt closed since the launch: the live one is resolved at call time. */
  async function onConfirmation(p0: PlanRt, taskId: TaskId, n: number, c: LaunchConfirmation): Promise<void> {
    if (c.kind === "confirmed") {
      const p = current(p0);
      p.preConfirmLosses = 0;
      p.preConfirmCapture = null;
      return;
    }
    await withTask(current(p0), taskId, async () => {
      const p = current(p0);
      const t = own(p.writer.ledger, taskId);
      if (t === null || t.state !== "dispatched" || openAttempt(t, n) === null) return;
      counter(p, "launch-failed", { row: c.reason === "task-error" ? "L8" : c.reason === "timeout" ? "L7" : c.reason === "threw" ? "L6" : c.reason === "superseded" ? "L5" : "L9" });
      if (c.reason === "task-error") await rowLaunchFailed(p, taskId, n, c.error ?? "task error");
      else await rowLost(p, taskId, n, c.reason);
    });
  }

  /** Row 11: dispatched -> ready, uncounted; slot and leases are kept (R4). */
  async function rowLost(p: PlanRt, taskId: TaskId, n: number, reason: string): Promise<void> {
    const at = d.clock.iso();
    let applied = false;
    try {
      applied = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        if (c === null || c.state !== "dispatched" || openAttempt(c, n) === null) return [];
        const a = openAttempt(c, n);
        return [
          ae(taskId, n, "lost", a === null ? at : clampEnd(a, at), reason),
          tt(taskId, "dispatched", "ready", "launch-lost", reason),
          ...gateRequeue(cur, c),
        ];
      });
    } catch (e) {
      d.log("error", "row 11 failed", errorText(e));
    }
    releaseToken(p, taskId, n, "other");
    if (applied) await preConfirmLost(p, taskId, n, reason);
    schedule(p);
  }

  /**
   * QA-3.1-17: whether a row 11 counts toward the pre-confirmation streak. A loss counts once per capture (the attempt's
   * `callID`): N parallel launches lost under one capture change (E_NO_CONTEXT, superseded: the expected uncounted L3/L5
   * race) are one loss, not N. A `superseded`/`no-context` loss is ignored outright when a newer capture is already
   * current (the relaunch goes out under it). Within one capture a task lost AGAIN (a relaunch that failed the same way)
   * counts again, so a failure that repeats on each relaunch still pauses (QA-3.1-4).
   */
  function preConfirmCounts(p: PlanRt, taskId: TaskId, n: number, reason: string): boolean {
    const l = p.writer.ledger;
    const callID = own(l, taskId)?.attempts.find((a) => a.n === n)?.callID ?? null;
    if ((reason === "superseded" || reason === "no-context") && callID !== null) {
      const g = d.launcher.gate(l.orchestrator.sessionID);
      if (g.ok && g.context.callID !== callID) return false;
    }
    const key = callID ?? `\u0000${taskId}#${n}`;
    const cap = p.preConfirmCapture;
    if (cap === null || cap.key !== key) {
      p.preConfirmCapture = { key, tasks: new Set([taskId]) };
      return true;
    }
    if (cap.tasks.has(taskId)) return true;
    cap.tasks.add(taskId);
    return false;
  }

  /**
   * QA-3.1-4: every row 11 is a loss before the launch was confirmed; it is uncounted, so a failure that repeats on each
   * relaunch (or on each new capture: tick -> wake -> new router call -> same failure) would loop forever. At
   * PRECONFIRM_STREAK consecutive counted losses (`preConfirmCounts`, QA-3.1-17) the plan pauses (no more launches, so
   * no more stale-context wakes) and ONE blocking item is raised. A confirmed launch, and a resume, reset the count.
   */
  async function preConfirmLost(p: PlanRt, taskId: TaskId, n: number, reason: string): Promise<void> {
    if (!preConfirmCounts(p, taskId, n, reason)) return;
    p.preConfirmLosses += 1;
    if (p.preConfirmLosses < PRECONFIRM_STREAK) return;
    p.preConfirmLosses = 0;
    p.preConfirmCapture = null;
    let paused = false;
    try {
      paused = await appendIf(p, (cur) =>
        cur.status === "running" ? [{ type: "status-changed", from: "running", to: "paused", reason: `launch-lost-streak:${taskId}` }] : [],
      );
    } catch (e) {
      d.log("error", "launch-lost pause failed", errorText(e));
    }
    if (!paused) return;
    closeIdle(p);
    counter(p, "launch-lost-pause", { taskId, reason });
    await raiseSafe(p, {
      kind: "failure",
      severity: "blocking",
      taskId,
      text: `${PRECONFIRM_STREAK} consecutive launches were lost before their child started (last: ${taskId}, ${reason}); the plan is paused, resume it once the cause is fixed`,
      options: [],
    });
  }

  /** Row 12: dispatched -> failed (counts), then the retry decision. */
  async function rowLaunchFailed(p: PlanRt, taskId: TaskId, n: number, msg: string): Promise<void> {
    const at = d.clock.iso();
    let applied = false;
    try {
      applied = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        if (c === null || c.state !== "dispatched" || openAttempt(c, n) === null) return [];
        const a = openAttempt(c, n);
        return [
          ae(taskId, n, "failed", a === null ? at : clampEnd(a, at), msg),
          ax(taskId, n, msg),
          tt(taskId, "dispatched", "failed", "launch-task-error", msg),
          ...gateRequeue(cur, c),
        ];
      });
    } catch (e) {
      d.log("error", "row 12 failed", errorText(e));
    }
    releaseToken(p, taskId, n, "other");
    if (!applied) return;
    await countAttempt(p, taskId, n);
    await retryDecision(p, taskId);
  }

  // ---------- retry decision, counting

  async function countAttempt(p: PlanRt, taskId: TaskId, n: number): Promise<void> {
    const t = own(p.writer.ledger, taskId);
    if (t === null || t.phase === null) return;
    const a = t.attempts.find((x) => x.n === n);
    if (a === undefined) return;
    try {
      await p.collab.policy.recordAttempt(t.phase, a);
      // QA-4.2-14/-22: this failure is evaluated; an activation never feeds it again. A commit failure (`completed ->
      // failed`, commit-failed, the attempt itself `succeeded`) is a breaker failure too (A-4.2-2), read on the ledger
      // after its batch.
      if (isBreakerFailure(a) || isCommitFailure(t, a)) markFed(p, t.phase, taskId, n);
    } catch (e) {
      d.log("warn", "recordAttempt failed", errorText(e));
    }
  }

  /** Rows 35/35b (retry) or 36 (park through policy), right after a counted failure. */
  async function retryDecision(p: PlanRt, taskId: TaskId): Promise<void> {
    const l = p.writer.ledger;
    const t = own(l, taskId);
    if (t === null || (t.state !== "failed" && t.state !== "conflict" && t.state !== "reverted")) return;
    if (hasAttemptsLeft(t, l.config.maxAttempts)) {
      await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        if (c === null || (c.state !== "failed" && c.state !== "conflict" && c.state !== "reverted")) return [];
        return [tt(taskId, c.state, "ready", "retry")];
      });
    } else {
      const last = t.attempts[t.attempts.length - 1];
      const text = last !== undefined && last.context !== "" ? last.context : `attempts exhausted (${l.config.maxAttempts})`;
      await parkTask(p, taskId, "exhausted", text);
    }
    schedule(p);
  }

  // ---------- completion processing

  function processEnd(p: PlanRt, taskId: TaskId, n: number, end: ChildEnd): Promise<void> {
    // A recovered FINISHED child (or a terminal event racing its feed) must not run commit/verify in the global barrier.
    // Only an OPEN attempt's end is diverted, and only once a registered end of that attempt carries it: any other end
    // (closed attempt, another task work already registered) takes the normal path, whose bookkeeping releases its token,
    // evicts its binding and forgets its session.
    const t = own(p.writer.ledger, taskId);
    if (t !== null && openAttempt(t, n) !== null) {
      const recoveredWithoutContext = p.adoptedByRecovery.has(tokenKey(taskId, n)) && !d.launcher.gate(p.writer.ledger.orchestrator.sessionID).ok;
      if (p.recovering || p.recoveredWork.has(taskId) || recoveredWithoutContext) {
        registerRecoveredWork(p, t, { kind: "end", end });
        const w = p.recoveredWork.get(taskId);
        if (w !== undefined && w.work.kind === "end" && w.n === n) return Promise.resolve();
      }
    }
    // An admitted recovered pipeline of this task holds its mutex for a whole verification: the end's bookkeeping queues
    // behind it (tracked: `settled` and dispose wait for it) without making the caller wait for that verification.
    if (p.recoveredWork.get(taskId)?.started === true) {
      void bg("child end processing", () => withTask(p, taskId, () => processEndNow(p, taskId, n, end)));
      return Promise.resolve();
    }
    return withTask(p, taskId, () => processEndNow(p, taskId, n, end));
  }

  async function processEndNow(p: PlanRt, taskId: TaskId, n: number, end: ChildEnd): Promise<void> {
    // A budget resume retains this attempt's capacity token and the completed child's binding.
    let resumed = false;
    try {
      resumed = await handleEnd(p, taskId, n, end);
    } catch (e) {
      d.log("error", "child end processing failed", errorText(e));
    } finally {
      if (!resumed) releaseToken(p, taskId, n, "other");
      if (!resumed) releaseChildBinding(end);
      const still = own(p.writer.ledger, taskId);
      const closed = still === null || openAttempt(still, n) === null;
      // QA-4.2-23: the binding of an adopted child goes with its attempt.
      if (closed) evictRebound(p, taskId, n);
      if (closed) p.adoptedByRecovery.delete(tokenKey(taskId, n));
      if (closed) launchRequests.delete(requestKey(p, taskId, n));
      if (closed) await forgetClosed(p);
      if (end.childSessionID !== null && closed) {
        p.capacityStopped.delete(end.childSessionID);
        forgetSession(end.childSessionID);
      }
      schedule(p);
    }
  }

  /**
   * pdf2-1 (a): drops the binding the launcher held for a `completed` end (`LaunchHooks.holdCompletedBinding`) once no
   * budget resume takes it over. Idempotent (a launcher that holds nothing for the child ignores it); never throws.
   */
  function releaseChildBinding(end: ChildEnd): void {
    if (end.kind !== "completed") return;
    try {
      d.launcher.releaseBinding?.(end.childSessionID);
    } catch (e) {
      d.log("warn", "binding release failed", errorText(e));
    }
  }

  /** Processes one child end; true when a budget end resumed the same attempt (pdf2-1 (a): token, slot and leases kept). */
  async function handleEnd(p: PlanRt, taskId: TaskId, n: number, end: ChildEnd): Promise<boolean> {
    // Nit 7: rows L16 (cancel) and L17 (dispose) are journaled before the cancel or by recovery; only counted. L17 is
    // counted by `dispose` for each live launch BEFORE the plan is marked disposed (QA-3.1-25): the dispose ends arrive
    // after that mark, so counting them here never happened.
    if (end.kind === "interrupted") {
      if (!p.disposed && end.reason !== "dispose") counter(p, "launch-failed", { row: "L16" });
      return false;
    }
    const t = own(p.writer.ledger, taskId);
    if (t === null) return false;
    const a = openAttempt(t, n);
    if (a === null) return false; // ignores closed attempts
    // Nit 7: rows L13 (runner error), L14 (unrequested interrupt) and L15 (execution failed) of a running child.
    if (t.state === "running") {
      const row =
        end.kind === "failed" || end.kind === "capacity"
          ? "L15"
          : end.kind === "lost" && end.reason === "runner-error"
            ? "L13"
            : end.kind === "lost" && end.reason === "unrequested-interrupt"
              ? "L14"
              : null;
      if (row !== null) counter(p, "launch-failed", { row });
    }
    const stopped = end.childSessionID !== null && p.capacityStopped.has(end.childSessionID);
    switch (end.kind) {
      case "completed":
        if (t.state === "running") return onCompleted(p, t, a, end, end.text, end.endedAt);
        return false;
      case "failed":
        if (t.state !== "running") return false;
        if (stopped) await rowChildLost(p, t, a, "capacity", "capacity-stop", end.endedAt, end.error.message);
        else await rowChildFailed(p, t, a, `${end.error.type}: ${end.error.message}`, end.endedAt, "child-failed");
        return false;
      case "capacity":
        if (t.state === "running") await rowChildLost(p, t, a, "capacity", "capacity-stop", end.endedAt, end.error.message);
        return false;
      case "lost":
        if (t.state === "dispatched") {
          await rowLost(p, taskId, n, end.reason);
        } else if (t.state === "running") {
          await rowChildLost(p, t, a, "lost", "child-lost", end.endedAt, end.reason);
          await lostStreakCheck(p, taskId, end.reason);
        }
        return false;
    }
    return false;
  }

  /** Row 18: running -> ready, uncounted; slot and leases kept. */
  async function rowChildLost(
    p: PlanRt,
    t: TaskNode,
    a: Attempt,
    outcome: "lost" | "capacity",
    trigger: "child-lost" | "capacity-stop",
    at: IsoTime,
    detail: string,
  ): Promise<void> {
    await appendIf(p, (cur) => {
      const c = own(cur, t.id);
      if (c === null || c.state !== "running" || openAttempt(c, a.n) === null) return [];
      return [
        ae(t.id, a.n, outcome, clampEnd(a, at), detail),
        tt(t.id, "running", "ready", trigger, detail),
        ...gateRequeue(cur, c),
      ];
    });
    if (outcome === "capacity" || !STREAK_DETAILS.includes(detail)) p.lostStreak.delete(t.id);
  }

  async function lostStreakCheck(p: PlanRt, taskId: TaskId, detail: string): Promise<void> {
    if (!STREAK_DETAILS.includes(detail)) {
      p.lostStreak.delete(taskId);
      return;
    }
    const k = (p.lostStreak.get(taskId) ?? 0) + 1;
    p.lostStreak.set(taskId, k);
    if (k < LOST_STREAK) return;
    p.lostStreak.delete(taskId);
    const paused = await appendIf(p, (cur) =>
      cur.status === "running" ? [{ type: "status-changed", from: "running", to: "paused", reason: `lost-streak:${taskId}` }] : [],
    );
    if (!paused) return;
    counter(p, "lost-streak-pause", { taskId });
    await p.collab.policy.raise({
      kind: "failure",
      severity: "blocking",
      taskId,
      text: `task ${taskId} lost ${LOST_STREAK} consecutive attempts (${detail}); the plan is paused`,
      options: [],
    });
  }

  /** Row 16: running -> failed (counts), then the retry decision. */
  async function rowChildFailed(p: PlanRt, t: TaskNode, a: Attempt, msg: string, at: IsoTime, trigger: "child-failed" | "lease-unresolvable"): Promise<void> {
    const applied = await appendIf(p, (cur) => {
      const c = own(cur, t.id);
      if (c === null || c.state !== "running" || openAttempt(c, a.n) === null) return [];
      return [ae(t.id, a.n, "failed", clampEnd(a, at), msg), ax(t.id, a.n, msg), tt(t.id, "running", "failed", trigger, msg), ...gateRequeue(cur, c)];
    });
    releaseToken(p, t.id, a.n, "other");
    if (!applied) return;
    await countAttempt(p, t.id, a.n);
    await retryDecision(p, t.id);
  }

  /** Row 15 and its alternatives; true when a budget end resumed the same attempt (pdf2-1 (a)). */
  async function onCompleted(p: PlanRt, t: TaskNode, a: Attempt, end: ChildEnd, text: string, at: IsoTime): Promise<boolean> {
    const cls = classifyChildText(text);
    // pdf2-1 (a): only a budget end may resume this child; every other end drops its binding before it touches the slot.
    if (cls.kind !== "budget") releaseChildBinding(end);
    if (t.kind === "qa") {
      const parsed = p.collab.qa.parse(text);
      if (parsed.ok) {
        await qaSuccess(p, t, a, parsed.report, at);
        return false;
      }
      if (cls.kind === "ordinary") {
        await qaUnparsable(p, t, a, parsed.error, at);
        return false;
      }
    }
    if (cls.kind === "lease") {
      await leaseNeeded(p, t, a, cls.path, text, at);
      return false;
    }
    // pdf2-1 (a): decided before the end releases the token or the slot (processEnd's `finally`, parkTask).
    if (cls.kind === "budget") return budgetEnd(p, t, a, end, text);
    if (cls.kind === "escalate" || cls.kind === "ambiguity") {
      await parkTask(p, t.id, cls.kind, text);
      releaseToken(p, t.id, a.n, "other");
      return false;
    }
    // row 15
    const applied = await appendIf(p, (cur) => {
      const c = own(cur, t.id);
      if (c === null || c.state !== "running" || openAttempt(c, a.n) === null) return [];
      return [ae(t.id, a.n, "succeeded", clampEnd(a, at), null), tt(t.id, "running", "completed", "child-ended")];
    });
    if (!applied) return false;
    // Phase 5.1 (a): the child's claim, as a dispatch grader judges it; kept only while a verifier observes attempts.
    if (d.verifier.observe !== undefined && text !== "") finalTexts.set(`${p.planId}/${t.id}#${a.n}`, text);
    releaseToken(p, t.id, a.n, "success");
    await commitAndVerify(p, t.id, a.n);
    return false;
  }

  // ---------- pdf2-1 (a): budget resume

  /**
   * A budget end resumes the same child session while the attempt has resumes left (`BUDGET_RESUMES`), its child is
   * known, the plan runs unlatched and a QA task's gate is still `qa-running`. Otherwise, and when the resume cannot go
   * out, the task parks with `budget-cap`; the slot's work is kept at the task's WIP ref and restored on the next attempt.
   * Runs inside the end's task mutex, before the end releases the token or the slot.
   */
  async function budgetEnd(p: PlanRt, t: TaskNode, a: Attempt, end: ChildEnd, text: string): Promise<boolean> {
    const l = p.writer.ledger;
    const resumes = a.resumes ?? 0;
    const ph = phaseOf(l, t);
    const gateSame = t.kind !== "qa" || (ph !== null && ph.gate === "qa-running");
    const child = a.childSessionID;
    const kept = `the work of attempt ${a.n} is kept and restored on the next attempt`;
    if (resumes < BUDGET_RESUMES && child !== null && l.status === "running" && !p.latch && !p.disposed && gateSame) {
      // pdf2-1 (a): the binding the end held stays live for this resume; the launcher's resume takes it over.
      const r = await resumeAttempt(p, t, a, child, resumes + 1);
      if (r === "resumed") {
        // Only the resumed child's binding is taken over; an end of another session never keeps its binding.
        if (end.kind === "completed" && end.childSessionID !== child) releaseChildBinding(end);
        return true;
      }
      releaseChildBinding(end);
      if (r === "gone") return false;
      await parkBudget(p, t.id, a.n, `${firstLine(text)}: the resume of attempt ${a.n} failed (${r.why}); ${kept}`);
      return false;
    }
    releaseChildBinding(end);
    const why = resumes >= BUDGET_RESUMES
      ? `budget cap reached after ${resumes} resume(s)`
      : child === null ? "no child session to resume" : "the plan or the phase gate changed";
    await parkBudget(p, t.id, a.n, `${firstLine(text)}: ${why}; ${kept}`);
    return false;
  }

  async function parkBudget(p: PlanRt, taskId: TaskId, n: number, text: string): Promise<void> {
    counter(p, "budget-park", { taskId });
    await parkTask(p, taskId, "budget-cap", text);
    releaseToken(p, taskId, n, "other");
  }

  function requestKey(p: PlanRt, taskId: TaskId, n: number): string {
    return `${p.planId}/${taskId}#${n}`;
  }

  /** The launch request of attempt `n` (kept since its launch, else rebuilt with the attempt's nonce after a restart). */
  async function requestOf(p: PlanRt, t: TaskNode, a: Attempt): Promise<LaunchRequest> {
    const kept = launchRequests.get(requestKey(p, t.id, a.n));
    if (kept !== undefined) return kept;
    const l = p.writer.ledger;
    const slot = await slotLeaseOf(p, t);
    const env = await loadExpansionEnv(d.git, { toplevel: l.repo.toplevel, slotPath: slot.path, timeoutMs: GIT_TIMEOUT_MS });
    const expanded = expandTask({ ledger: l, taskId: t.id, attempt: a.n, nonce: a.nonce, slot, env });
    const route = viewOf(p, null).routeOf(t);
    if (route.provider === UNROUTABLE) throw new ExecutorError("E_PLAN_STATE", "the task has no route", t.id);
    return {
      planId: p.planId,
      taskId: t.id,
      attempt: a.n,
      nonce: a.nonce,
      orchestratorSessionID: l.orchestrator.sessionID,
      context: { bootID: "", epoch: 0, callID: a.callID ?? "" },
      route,
      role: t.route.role,
      grant: needsOf(expanded.routeLine),
      routeBudget: expanded.routeBudget ?? null,
      workRoot: expanded.workRoot,
      prompt: expanded.prompt,
    };
  }

  /**
   * `resumeAttempt` (inside the task mutex): slot, leases and branch are kept, the capacity token too (re-taken forced
   * when it is gone, as `onChildCreated` does), `attempt-resumed` is journaled in one batch, then the launcher resumes the
   * same child with "continue and finish" under the same attempt and nonce. No `verifier.begin`. "gone": the task left
   * the attempt meanwhile; `{why}`: the resume did not go out (the caller parks).
   */
  async function resumeAttempt(p: PlanRt, t: TaskNode, a: Attempt, childSessionID: string, resumes: number): Promise<"resumed" | "gone" | { why: string }> {
    const taskId = t.id;
    const n = a.n;
    const l = p.writer.ledger;
    const gate = d.launcher.gate(l.orchestrator.sessionID);
    if (!gate.ok) return { why: "no launch context (E_NO_CONTEXT)" };
    let base: LaunchRequest;
    try {
      base = await requestOf(p, t, a);
    } catch (e) {
      return { why: errorText(e) };
    }
    const k = tokenKey(taskId, n);
    if (!p.tokens.has(k)) {
      try {
        p.tokens.set(k, p.capacity.acquire(base.route.provider, base.route.heavy, taskId, n, { force: true }));
        observe(p, "capacity-reserve", () => ({ taskId, attempt: n, provider: base.route.provider, heavy: base.route.heavy,
          token: p.tokens.get(k)?.id ?? null, force: true }));
      } catch (e) {
        return { why: `capacity: ${errorText(e)}` };
      }
    }
    let applied = false;
    try {
      applied = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        const o = c === null ? null : openAttempt(c, n);
        if (c === null || o === null || c.state !== "running" || cur.status !== "running" || p.latch) return [];
        if ((o.resumes ?? 0) + 1 !== resumes) return [];
        return [{ type: "attempt-resumed", taskId, n, resumes }];
      });
    } catch (e) {
      d.log("error", "attempt-resumed batch failed", errorText(e));
      return { why: errorText(e) };
    }
    if (!applied) {
      const c = own(p.writer.ledger, taskId);
      return c !== null && c.state === "running" && openAttempt(c, n) !== null ? { why: "the plan stopped running" } : "gone";
    }
    const ctx = gate.context;
    const req: LaunchRequest = {
      ...base,
      orchestratorSessionID: l.orchestrator.sessionID,
      context: { bootID: ctx.bootID, epoch: ctx.epoch, callID: ctx.callID },
      prompt: RESUME_PROMPT,
      resume: { childSessionID },
    };
    let handle: LaunchHandle;
    try {
      // As for a fresh launch: never a new child once dispose began (its confirmation would hold dispose forever); the
      // real launcher refuses one with E_DISPOSED too.
      if (p.disposed) throw new ExecutorError("E_DISPOSED", "the runtime is disposing; no budget resume");
      handle = d.launcher.launch(req, launchHooks(p, taskId, n, req.route));
    } catch (e) {
      const code = errorCode(e);
      counter(p, "resume-failed", { taskId, reason: code ?? "error" });
      return { why: code === "E_NO_CONTEXT" ? "no launch context (E_NO_CONTEXT)" : errorText(e) };
    }
    recordChildProcess(p, taskId, n, childSessionID);
    // The real launcher now owns the resumed binding/handle. It is no longer an unlaunched recovery adoption;
    // later ends follow the normal budget/E_NO_CONTEXT rules, and closing this attachment must not evict it as rebound.
    p.rebound.delete(taskId);
    p.adoptedByRecovery.delete(tokenKey(taskId, n));
    wireLaunch(p, taskId, n, handle, (q, c) => onResumeConfirmation(q, taskId, n, resumes, c));
    counter(p, "attempt-resumed", { taskId, n: String(n), resumes: String(resumes) });
    return "resumed";
  }

  /** An unconfirmed resume parks the task (`budget-cap`); its work is kept at the WIP ref. */
  async function onResumeConfirmation(p0: PlanRt, taskId: TaskId, n: number, resumes: number, c: LaunchConfirmation): Promise<void> {
    if (c.kind === "confirmed") return;
    await withTask(current(p0), taskId, async () => {
      const p = current(p0);
      const t = own(p.writer.ledger, taskId);
      const a = t === null ? null : openAttempt(t, n);
      if (t === null || a === null || t.state !== "running" || (a.resumes ?? 0) !== resumes) return;
      counter(p, "resume-failed", { taskId, reason: c.reason });
      try {
        await d.launcher.cancel(taskId, n, "superseded");
      } catch (e) {
        d.log("warn", "cancel of an unconfirmed resume failed", errorText(e));
      }
      await parkBudget(p, taskId, n, `NEED MORE: budget: the resume of attempt ${n} was not confirmed (${c.reason}${c.error === null ? "" : `: ${c.error}`}); the work of attempt ${n} is kept and restored on the next attempt`);
    });
  }

  /** QA5: the report is the attempt context; the qa task is done and its resources are released. */
  async function qaSuccess(p: PlanRt, t: TaskNode, a: Attempt, report: FindingsReport, at: IsoTime): Promise<void> {
    const slotName = t.slot;
    const applied = await appendIf(p, (cur) => {
      const c = own(cur, t.id);
      if (c === null || c.state !== "running" || openAttempt(c, a.n) === null) return [];
      return [
        ae(t.id, a.n, "succeeded", clampEnd(a, at), null),
        ax(t.id, a.n, canonicalFindingsJson(report)),
        tt(t.id, "running", "completed", "child-ended"),
        tt(t.id, "completed", "done", "no-changes"),
        ts(t.id, null, null),
      ];
    });
    if (!applied) return;
    await releaseResources(p, t.id, slotName);
    releaseToken(p, t.id, a.n, "success");
    await p.collab.qa.onQaResult(t.id, report);
  }

  /** QA6: the first unparsable output fails the attempt (counts); the second parks. */
  async function qaUnparsable(p: PlanRt, t: TaskNode, a: Attempt, error: string, at: IsoTime): Promise<void> {
    const ctx = `${QA_UNPARSABLE_CONTEXT_PREFIX}${error}`;
    if (qaUnparsableCount(t) >= 1) {
      await parkTask(p, t.id, "qa-unparsable", ctx);
      releaseToken(p, t.id, a.n, "other");
      return;
    }
    await rowChildFailed(p, t, a, ctx, at, "child-failed");
  }

  /** M13: `NEED MORE: lease <path>` -> rows 18b / 18b' / R6. */
  async function leaseNeeded(p: PlanRt, t: TaskNode, a: Attempt, path: string | null, text: string, at: IsoTime): Promise<void> {
    const evidence = firstLine(text);
    if (path === null) {
      counter(p, "learned-edge", { result: "foreign" });
      await rowChildFailed(p, t, a, `lease-unresolvable: ${evidence}`, at, "lease-unresolvable");
      return;
    }
    const l = p.writer.ledger;
    const h = p.leases.holder(path);
    let edge: Edge | null = null;
    if (h !== null) {
      if (h.planId !== p.planId || h.taskId === null || h.taskId === t.id) {
        counter(p, "learned-edge", { result: "foreign" });
        await rowChildFailed(p, t, a, `lease-unresolvable: ${evidence}`, at, "lease-unresolvable");
        return;
      }
      const holderTask = h.taskId;
      edge = d.scheduler.addLearnedEdge(l, holderTask, t.id, `NEED MORE: lease ${path}`);
      if (edge === null) {
        const exists = l.edges.some((e) => e.from === holderTask && e.to === t.id);
        counter(p, "learned-edge", { result: exists ? "exists" : "cycle" });
        await rowChildFailed(p, t, a, `lease-unresolvable: ${evidence}`, at, "lease-unresolvable");
        return;
      }
      counter(p, "learned-edge", { result: "added" });
    } else {
      counter(p, "learned-edge", { result: "free" });
    }
    const slotName = t.slot;
    const learned = edge;
    // pdf2-1 (b), QA-PDF21-10: the interrupted attempt's work is saved first, while the task still holds its slot; a
    // failed save (QA-PDF21-3) parks with the slot kept: pending/blocked cannot hold unsaved work.
    const saved: SaveResult = slotName === null ? "clean" : await snapshotTaskSlot(p, t.id, slotName, "lease-needed");
    // QA-PDF21-19: the park of an unsaved slot is a park like `parkTask`'s: the attempt context is its item's text (so
    // `parkItemOf` picks that item on the answer), its pending dependents are blocked and its file leases are kept with
    // the slot (as the policy's park keeps them for a kept slot, and `rebuildLeases` rebuilds them after a restart).
    const holdWhat = "its release (lease-needed)";
    const holdText = saved === "failed" && slotName !== null ? wipHoldText(slotName, holdWhat, t.id) : null;
    const applied = await appendIf(p, (cur) => {
      const c = own(cur, t.id);
      if (c === null || c.state !== "running" || openAttempt(c, a.n) === null) return [];
      const fp: Footprint = {
        ...c.footprint,
        writes: c.footprint.writes.includes(path) ? c.footprint.writes : [...c.footprint.writes, path],
        sources: c.footprint.sources.includes("learned") ? c.footprint.sources : [...c.footprint.sources, "learned"],
      };
      const ev: ExecutorEventInput[] = [
        ae(t.id, a.n, "interrupted", clampEnd(a, at), `lease-needed:${path}`),
        ax(t.id, a.n, holdText ?? evidence),
        saved === "failed"
          ? tt(t.id, "running", "parked", "ambiguity", "unsaved-slot")
          : tt(t.id, "running", "ready", "lease-needed", path),
        { type: "task-footprint", taskId: t.id, footprint: fp },
      ];
      if (learned !== null) ev.push({ type: "edge-added", edge: learned });
      if (saved !== "failed") {
        ev.push(ts(t.id, null, null));
        if (learned !== null) ev.push(tt(t.id, "ready", "pending", "dep-added", path));
      } else {
        for (const dep of pendingDependentsClosure(cur, t.id)) ev.push(tt(dep.id, "pending", "blocked", dep.trigger, t.id));
      }
      ev.push(...gateRequeue(cur, c));
      return ev;
    });
    releaseToken(p, t.id, a.n, "other");
    if (!applied) return;
    if (saved === "failed" && slotName !== null) {
      // The park's own item (an item of this slot raised before has another text; the policy dedupes an equal open one).
      wipFailRaised.delete(`${p.planId}/${slotName}`);
      await wipHold(p, t.id, slotName, holdWhat);
      return;
    }
    await releaseResources(p, t.id, slotName, "lease-needed", saved);
  }

  /** Non-integrating completions must wake the same phase gates as Q's row 30. */
  async function checkTaskPhase(p: PlanRt, taskId: TaskId): Promise<void> {
    const t = own(p.writer.ledger, taskId);
    if (t === null || t.kind === "qa" || t.phase === null) return;
    for (const id of [t.phase, ...dependentPhases(p.writer.ledger, [t.phase])]) {
      try {
        await p.collab.queue.checkPhase(id);
      } catch (e) {
        d.log("warn", `checkPhase ${id} failed`, errorText(e));
      }
    }
  }

  /** M38: commit in the slot, then verify; PASS enqueues, FAIL goes to the retry decision. */
  async function commitAndVerify(p: PlanRt, taskId: TaskId, n: number): Promise<void> {
    const t = own(p.writer.ledger, taskId);
    if (t === null || t.state !== "completed" || t.slot === null) return;
    // QA-4.2-16: held until the leases are back (`retryHeldLeases` resumes it).
    if (p.leaseHeld.has(taskId)) return;
    const slotName = t.slot;
    const commitFailed = async (msg: string): Promise<void> => {
      const applied = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        if (c === null || c.state !== "completed") return [];
        return [ax(taskId, n, msg), tt(taskId, "completed", "failed", "commit-failed", msg)];
      });
      if (!applied) return;
      await countAttempt(p, taskId, n);
      await retryDecision(p, taskId);
    };
    let lease: SlotLease;
    let r: { changed: false } | { changed: true; commit: string };
    const branch = taskBranchName(p.planId, taskId);
    try {
      lease = await slotLeaseOf(p, t);
      // D11: the attempt's trailer makes the commit idempotent across a crash between the commit and row 21.
      const att = t.attempts.find((x) => x.n === n);
      if (att !== undefined && d.verifier.observe !== undefined) await d.verifier.observe(t, lease, att, await finalTextOf(p, taskId, att), planTaskContext(p));
      if (p.disposed) return;
      r = await commitTaskInSlot(d.git, {
        slot: lease,
        branch,
        message: `${taskId}: ${t.title} (attempt ${n})`,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(att === undefined ? {} : { trailer: attemptTrailer(p.planId, taskId, n, att.nonce) }),
      });
    } catch (e) {
      if (p.disposed) return;
      await commitFailed(errorText(e));
      return;
    }
    if (p.disposed) return;
    if (!r.changed) {
      // M39 owner amendment: verification policy never makes a declared writer's missing diff a success.
      if (t.footprint.writes.length > 0) {
        await commitFailed("no changes");
        return;
      }
      const applied = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        return c === null || c.state !== "completed" ? [] : [tt(taskId, "completed", "done", "no-changes"), ts(taskId, null, null)];
      });
      if (applied) {
        // QA-PDF21-6: the task finished without changes: a saved WIP (undone by the child) is never restored again.
        await finalCommitWip(p, taskId);
        await releaseResources(p, taskId, slotName);
        await checkTaskPhase(p, taskId);
      }
      return;
    }
    // QA-PDF21-6: the task's final commit holds every attempt's work now; the WIP ref is dropped (a later save of this
    // slot is parented at the lease base again, so the commit is carried over if this attempt fails its verification).
    await finalCommitWip(p, taskId);
    const verifying = await appendIf(p, (cur) => {
      const c = own(cur, taskId);
      return c === null || c.state !== "completed" ? [] : [ts(taskId, slotName, branch), tt(taskId, "completed", "verifying", "committed")];
    });
    if (!verifying) return;
    await verifyAttempt(p, taskId, n, lease);
  }

  /**
   * M38, second half: the verifier on a `verifying` task; PASS enqueues, FAIL goes to the retry decision. Recovery reruns
   * it for a task left `verifying` (the verdict batch re-checks the state, so the verdict is written once).
   */
  function verifyAttempt(p: PlanRt, taskId: TaskId, n: number, lease: SlotLease): Promise<void> {
    // QA-5.1-21: tracked on every path (a recovery re-verify too, not only an end's processing), so dispose's wait for running
    // work covers the journaling of a verdict that settles after the verifier was cut; `closePlan` runs after that wait.
    return holdAttachment(p, track(verifyAttemptNow(p, taskId, n, lease)));
  }

  async function verifyAttemptNow(p: PlanRt, taskId: TaskId, n: number, lease: SlotLease): Promise<void> {
    // QA-4.2-16: held until the leases are back (`retryHeldLeases` resumes it).
    if (p.leaseHeld.has(taskId)) return;
    // A context can expire during commit/observation. Re-park this same identity, not a transient grader failure.
    const parkWithoutContext = (): boolean => {
      if (!p.recoveredWork.has(taskId) || d.launcher.gate(p.writer.ledger.orchestrator.sessionID).ok) return false;
      p.recoveredWork.delete(taskId);
      const t = own(p.writer.ledger, taskId);
      if (t !== null) registerRecoveredWork(p, t, { kind: "reverify", slotValid: true });
      return true;
    };
    if (p.disposed || parkWithoutContext()) return;
    let verdict: Verdict;
    let findings: string;
    let ref: string | null;
    let cut: boolean;
    let nonce: string | undefined;
    try {
      const cur = own(p.writer.ledger, taskId);
      const att = cur === null ? undefined : cur.attempts[cur.attempts.length - 1];
      if (cur === null || cur.state !== "verifying" || att === undefined || att.n !== n || att.verdict !== null) return;
      nonce = att.nonce;
      forgotten.delete(`${p.planId}/${taskId}#${n}`);
      if (d.verifier.observe !== undefined) await d.verifier.observe(cur, lease, att, await finalTextOf(p, taskId, att), planTaskContext(p));
      await slotsFor(p.planId).cleanForChecks(lease.slot);
      if (p.disposed || parkWithoutContext()) return;
      const v = await d.verifier.verify(cur, lease, att, planTaskContext(p));
      verdict = v.verdict;
      findings = v.findings;
      ref = v.ref;
      cut = v.cut === true;
    } catch (e) {
      verdict = "unverifiable";
      findings = errorText(e);
      ref = null;
      // A throw decided no verdict either: under dispose (a closed pool, a cut check) it is a cut.
      cut = disposed || p.disposed || d.verifier.disposing === true;
    }
    finalTexts.delete(`${p.planId}/${taskId}#${n}`);
    // QA-5.1-4: a verification cut by dispose (or by an adopt's attachment cut) judged nothing. Nothing is journaled: the
    // task stays `verifying`, which recovery re-verifies (R2); no failed transition, no attempt used, no breaker sample.
    // QA-5.1-21: only an explicit cut (`cut: true`) is discarded. A real verdict decided before dispose began, and already
    // handed to the verifier's `onVerdict`, is journaled: the writer stays open until `closePlan`, which dispose runs after
    // the wait for this work.
    if (cut) {
      d.log("info", `verification of ${p.planId}/${taskId}#${n} cut by dispose or adopt; recovery re-verifies it`);
      return;
    }
    if (verdict === "pass") {
      const ok = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        const a = c?.attempts[c.attempts.length - 1];
        if (c === null || c.state !== "verifying" || a?.n !== n || a.nonce !== nonce || a.verdict !== null) return [];
        return [{ type: "attempt-verdict", taskId, n, verdict: "pass", ref }, tt(taskId, "verifying", "verified", "verify-pass")];
      });
      if (!ok) return;
      await countAttempt(p, taskId, n);
      if (!p.latch && !p.leaseHeld.has(taskId)) p.collab.queue.enqueue([taskId]);
      return;
    }
    const failed = await appendIf(p, (cur) => {
      const c = own(cur, taskId);
      const a = c?.attempts[c.attempts.length - 1];
      if (c === null || c.state !== "verifying" || a?.n !== n || a.nonce !== nonce || a.verdict !== null) return [];
      return [
        { type: "attempt-verdict", taskId, n, verdict, ref },
        ax(taskId, n, findings),
        tt(taskId, "verifying", "failed", "verify-fail", verdict),
      ];
    });
    if (!failed) return;
    await countAttempt(p, taskId, n);
    await retryDecision(p, taskId);
  }

  // ---------- integration results (Q -> Rt)

  /** M8: a child whose task Q moved to blocked is cancelled; resources are released once its completion settles. */
  function sweepBlocked(p: PlanRt): void {
    for (const f of d.launcher.inFlight()) {
      const t = own(p.writer.ledger, f.taskId);
      if (t === null || t.state !== "blocked" || t.slot !== null) continue;
      const h = p.handles.get(f.taskId);
      if (h === undefined || h.n !== f.attempt) continue;
      const slotName = p.slotLeases.get(f.taskId)?.slot ?? null;
      bg("blocked cancel", async () => {
        await d.launcher.cancel(f.taskId, f.attempt, "blocked");
        await h.completion;
        await releaseResources(p, f.taskId, slotName);
        releaseToken(p, f.taskId, f.attempt, "other");
      });
    }
  }

  function makeListener(ref: { p: PlanRt | null }): IntegrationListener {
    const run = (label: string, fn: (p: PlanRt) => Promise<void>): void => {
      const p = ref.p;
      if (p === null || p.disposed) return;
      bg(label, () => fn(p));
    };
    const settleCounted = async (p: PlanRt, id: TaskId): Promise<void> => {
      const t = own(p.writer.ledger, id);
      const a = t === null ? undefined : t.attempts[t.attempts.length - 1];
      if (a !== undefined) await countAttempt(p, id, a.n);
      await retryDecision(p, id);
    };
    return {
      onIntegrated: () =>
        run("onIntegrated", async (p) => {
          schedule(p);
          // pdf2-1 (b): an integrated (or finished) task's WIP ref is dropped: its own commit holds that work now.
          await sweepWip(p);
        }),
      onConflict: (id) =>
        run("onConflict", (p) =>
          withTask(p, id, async () => {
            const t = own(p.writer.ledger, id);
            if (t !== null && t.slot !== null) {
              // QA-PDF21-3: a failed save keeps the slot as it is (no reset) and raises the item that names it.
              if ((await snapshotTaskSlot(p, id, t.slot, "conflict")) === "failed") await wipHold(p, id, t.slot, "its reset after a conflict");
              else {
                const head = p.writer.ledger.integration.head;
                try {
                  await slotsFor(p.planId).reset(t.slot, head);
                  // QA-PDF21-12: the cached lease follows the reset (a later save is parented at `head`).
                  const cached = p.slotLeases.get(id);
                  if (cached !== undefined && cached.slot === t.slot) p.slotLeases.set(id, leaseAt(cached, head));
                } catch (e) {
                  d.log("warn", "slot reset after conflict failed", errorText(e));
                }
              }
            }
            await settleCounted(p, id);
          }),
        ),
      onFailed: (id) => run("onFailed", (p) => withTask(p, id, () => settleCounted(p, id))),
      onReverted: (id) =>
        run("onReverted", async (p) => {
          sweepBlocked(p);
          await withTask(p, id, () => retryDecision(p, id));
        }),
      onGate: (phaseId, gate) =>
        run("onGate", async (p) => {
          if (gate === "awaiting-qa") await p.collab.qa.onAwaitingQa(phaseId);
          schedule(p);
        }),
      onInbox: (item) => run("onInbox", (p) => wakeOnce(p, "inbox", `inbox:${item.id}`)),
    };
  }

  // ---------- plan lifecycle in this process

  /** QA-4.2-29: the plan's history export, read once per attachment (capacity restore, breaker step); null on failure. */
  async function exportHistory(planId: PlanId, failure: string): Promise<ExecutorEvent[] | null> {
    try {
      return (await d.store.exportPlan(planId)).events;
    } catch (e) {
      d.log("warn", failure, errorText(e));
      return null;
    }
  }

  /** The plan's capacity controller, seeded from `events` (the history export) when given. */
  function makeCapacity(p: PlanRt | null, writer: LedgerWriter, planId: PlanId, events: readonly ExecutorEvent[] | null): CapacityController {
    const cfg = writer.ledger.config;
    const seed: Record<string, CapacityProviderState> | undefined =
      events === null ? undefined : capacityRestoreFromEvents(events, { maxParallel: cfg.maxParallel, nowMs: d.clock.now() });
    observeV2(d.observations, () => ({ family: "scheduler", planId, parentSessionID: writer.ledger.orchestrator.sessionID,
      action: "capacity-init", state: { maxParallel: cfg.maxParallel, providers: Object.entries(seed ?? {}).map(([provider, s]) => ({ provider, ...s })) } }));
    return d.capacity({
      maxParallel: cfg.maxParallel,
      cooldownMs: cfg.capacityCooldownMs,
      pauseMs: cfg.capacityPauseMs,
      clock: d.clock,
      onMetric: (m) => {
        observeV2(d.observations, () => ({ family: "scheduler", planId, parentSessionID: writer.ledger.orchestrator.sessionID,
          action: "provider", state: { provider: m.provider, change: m.change, from: m.from, to: m.to, until: m.until } }));
        const target = p ?? plans.get(planId) ?? null;
        if (target !== null) metric(target, m);
      },
      ...(seed === undefined ? {} : { restore: seed }),
    });
  }

  /**
   * Single plan per process (memo M20, amendment A-3.1-1): at most one attached plan is running or paused. The capacity
   * controller, the orchestrator pin, the per-session maps and the host-event feed are process-wide, so a second active
   * plan would share (and starve) them. The plan that holds the slot, if any, other than `planId`: an attached active
   * plan (a passive one never holds it, QA-3.1-19) or the plan whose activation is under way (QA-3.1-18).
   */
  function activePlanOtherThan(planId: PlanId): PlanId | null {
    if (activating !== null && activating.planId !== planId) return activating.planId;
    for (const q of plans.values()) {
      if (q.planId === planId || q.disposed || q.passive) continue;
      const s = q.writer.ledger.status;
      if (s === "running" || s === "paused") return q.planId;
    }
    return null;
  }

  /**
   * QA-3.1-18: takes the process-level activation reservation for `planId` synchronously (check and act in one step,
   * before the activation's first await). Returns the plan that holds the slot instead, if any. Every successful
   * reservation is paired with `unreserve`, also on failure; once the activation landed the plan itself holds the slot.
   */
  function reserve(planId: PlanId): PlanId | null {
    const other = activePlanOtherThan(planId);
    if (other !== null) return other;
    if (activating === null) activating = { planId, holds: 0 };
    activating.holds += 1;
    return null;
  }

  function unreserve(planId: PlanId): void {
    if (activating === null || activating.planId !== planId) return;
    activating.holds -= 1;
    if (activating.holds <= 0) activating = null;
  }

  function refusalText(planId: PlanId, other: PlanId): string {
    return (
      `plan ${planId} cannot run: plan ${other} is already running or paused in this process ` +
      `(one active plan per process, memo M20 / A-3.1-1); complete or abort ${other} first`
    );
  }

  /** QA-3.1-19: actions that would run a passively attached (refused) plan are refused; abort, answer, status, pause and purge are not. */
  function activeOnly(p: PlanRt): void {
    if (!p.passive) return;
    const other = activePlanOtherThan(p.planId);
    throw new ExecutorError(
      "E_PLAN_STATE",
      `plan ${p.planId} is attached passively (refused: ${other ?? "another plan"} held the active slot); only abort, answer, status, pause, resume and purge apply`,
      { planId: p.planId, active: other },
    );
  }

  /** Refuses `writer`'s plan (A-3.1-1): one blocking inbox item on it (deduplicated), then E_PLAN_STATE. */
  async function refuseSecondPlan(writer: LedgerWriter, other: PlanId): Promise<never> {
    const text = refusalText(writer.planId, other);
    await journalRefusal(writer, text);
    throw new ExecutorError("E_PLAN_STATE", text, { planId: writer.planId, active: other });
  }

  /** The refusal's blocking inbox item on the refused plan, deduplicated on its open items; never throws. */
  async function journalRefusal(writer: LedgerWriter, text: string): Promise<void> {
    try {
      await writer.append((l) => {
        if (l.inbox.some((i) => i.answer === null && i.text === text)) return [];
        const item: InboxItem = {
          id: formatInboxId("failure", nextInboxNumber(l)),
          kind: "failure",
          severity: "blocking",
          taskId: null,
          text,
          options: [],
          answer: null,
          createdAt: d.clock.iso(),
        };
        return [{ type: "inbox-added", item }];
      });
    } catch (e) {
      d.log("warn", "refused plan inbox failed", errorText(e));
    }
  }

  /**
   * Attaches `writer`'s plan. A running or paused plan takes the activation reservation before the first await
   * (QA-3.1-18); when another plan holds the active slot it is attached PASSIVELY (QA-3.1-19): never activated, pinned
   * or ticked, its refusal journaled (one inbox item) and its orchestrator woken once, so abort, answer, status, pause,
   * purge (and resume, once the slot is free) still reach it.
   */
  async function attach(
    writer: LedgerWriter,
    existingLedger = true,
    onRegistered: () => void = () => undefined,
    o: { foreign?: boolean } = {},
  ): Promise<PlanRt> {
    const existing = plans.get(writer.planId);
    if (existing !== undefined) {
      onRegistered();
      return existing;
    }
    const planId = writer.planId;
    // QA-4.2-17: a plan of another toplevel (not reported eligible by `recover()`) is attached passively: no recovery, no
    // integration resume, no tick, no refusal item (it is not refused, it is not this process's to run, A-3.1-1).
    if (o.foreign === true) {
      const p = await build(writer, true);
      foreignPlans.add(planId);
      onRegistered();
      return p;
    }
    const st0 = writer.ledger.status;
    const refusedBy = st0 === "running" || st0 === "paused" ? reserve(planId) : null;
    const reserved = (st0 === "running" || st0 === "paused") && refusedBy === null;
    try {
      const p = await build(writer, refusedBy !== null);
      onRegistered();
      if (refusedBy !== null) {
        await refusePassive(p, refusedBy);
        return p;
      }
      const st = writer.ledger.status;
      // An existing ledger (start, adopt, a plan opened by an action) is recovered; a just-created one is not (4.2.5).
      if (st === "running" || st === "paused") await activate(p, existingLedger);
      return p;
    } finally {
      if (reserved) unreserve(planId);
    }
  }

  /** QA-3.1-19: the refused plan's inbox item and ONE wake of its orchestrator (state key per refusing plan). */
  async function refusePassive(p: PlanRt, other: PlanId): Promise<void> {
    await journalRefusal(p.writer, refusalText(p.planId, other));
    counter(p, "plan-refused", { active: other });
    try {
      await wakeOnce(p, PLAN_REFUSED_WAKE, `plan-refused:${p.planId}:${other}`);
    } catch (e) {
      d.log("warn", "refused plan wake failed", errorText(e));
    }
  }

  /** A foreign attachment owns only a snapshot: even opening a real writer rotates its journal and takes a lock. */
  function readOnlyWriter(ledger: Readonly<LedgerV1>): LedgerWriter {
    const snapshot = structuredClone(ledger);
    const refuse = async (): Promise<never> => {
      throw new ExecutorError("E_PLAN_STATE", `plan ${ledger.planId} belongs to another repository; its attachment is read-only`, { planId: ledger.planId });
    };
    return { planId: snapshot.planId, ledger: snapshot, append: refuse, snapshot: refuse,
      openIntegration: () => [], wakeKeys: () => new Set<string>(), close: async () => {} };
  }

  /** Builds and registers the plan's runtime state (no activation). */
  async function build(writer: LedgerWriter, passive: boolean): Promise<PlanRt> {
    const planId = writer.planId;
    const ref: { p: PlanRt | null } = { p: null };
    const registry = d.leaseRegistry;
    const leases = createLeaseService(planId, d.observations === undefined ? registry : {
      holderOf: (path) => registry.holderOf(path),
      acquireWrite(holder, writes) {
        const result = registry.acquireWrite(holder, writes);
        observeV2(d.observations, () => ({ family: "scheduler", planId, parentSessionID: writer.ledger.orchestrator.sessionID,
          action: "lease-acquire", state: { taskRef: holder.taskRef, ok: result.ok } }));
        return result;
      },
      releaseTask(taskRef) {
        registry.releaseTask(taskRef);
        observeV2(d.observations, () => ({ family: "scheduler", planId, parentSessionID: writer.ledger.orchestrator.sessionID,
          action: "lease-release", state: { taskRef } }));
      },
    });
    const waker = createWaker({
      writer,
      hosts: d.hosts,
      clock: d.clock,
      debounceMs: writer.ledger.config.wakeDebounceMs,
      text: (reason, key) => wakeText(planId, reason, key),
      onMetric: (m) => {
        const p = ref.p;
        if (p === null) return;
        if (m.result === "sent") {
          p.lastWakeMs = d.clock.now();
          p.counters.wakes += 1;
        }
        // Only attempts are journaled (QA-3.1-5): a debounced or duplicate wake is not an event, and journaling it made
        // every re-tick inside the debounce window append a metric.
        if (m.result === "sent" || m.result === "failed") metric(p, m);
      },
    });
    const collab = d.collaborators({
      writer,
      leases,
      waker,
      listener: makeListener(ref),
      // pdf2-1 (b): a park the runtime did not start (the queue's, the QA loop's) saves the slot's work too.
      // QA-PDF21-3: `false` when the work could not be saved: the park keeps the slot on the task and one item names it.
      beforeSlotRelease: async (taskId, slot, cause) => {
        const p = ref.p;
        if (p === null || p.disposed) return;
        const done = parkSaved.get(`${planId}/${taskId}`);
        if (done !== undefined) return done !== "failed";
        if ((await snapshotTaskSlot(p, taskId, slot, cause)) !== "failed") return true;
        await wipHold(p, taskId, slot, "the park released it");
        return false;
      },
      // QA-PDF21-7: the park after a restore conflict offers to discard the saved work or to keep it.
      parkOptions: (taskId) => (restoreParks.has(`${planId}/${taskId}`) ? [...WIP_PARK_OPTIONS] : []),
    });
    // QA-4.2-29: one history export per attachment, shared by the capacity restore and the breaker step.
    const history = await exportHistory(planId, "capacity restore failed");
    const capacity = makeCapacity(null, writer, planId, history);
    const p: PlanRt = {
      planId,
      writer,
      leases,
      waker,
      collab,
      capacity,
      tokens: new Map(),
      inFlight: new Set(),
      slotReservations: new Set(),
      handles: new Map(),
      slotLeases: new Map(),
      offSlotRelease: null,
      slotWaiting: false,
      slotReleaseGeneration: 0,
      capacityStopped: new Set(),
      lostStreak: new Map(),
      latch: false,
      ticking: false,
      again: false,
      disposed: false,
      metricChain: Promise.resolve(),
      lastWakeMs: null,
      wakeRetry: new Map(),
      timers: new Set(),
      idle: null,
      orchIdle: false,
      unpin: null,
      counters: { launches: 0, wakes: 0, idleMs: 0 },
      skipStreak: 0,
      backoff: null,
      provisionFails: 0,
      provisionRaised: false,
      preConfirmLosses: 0,
      preConfirmCapture: null,
      routeFails: 0,
      routeRaised: false,
      passive,
      recovering: false,
      recoveredWork: new Map(),
      attachmentWork: new Set(),
      attachment: new AbortController(),
      integrationResumed: false,
      probation: new Map(),
      probationTimer: null,
      interrupting: new Set(),
      leaseHeld: new Set(),
      rebound: new Map(),
      adoptedByRecovery: new Set(),
      // A passive attachment may never activate: it keeps no export (a later activation reads its own).
      history: passive ? null : history,
      fed: new Set(),
    };
    // Same-process adopt: the launches of the closed attachment stay this plan's (D12; their ends reach `current`). A
    // handle that settled in the re-attach window is not carried (QA-4.2-4): its end is processed after the re-attach,
    // and `reconcile` classifies its task like any other, so it is never counted as tracked.
    for (const [taskId, h] of carriedHandles.get(planId) ?? []) if (!h.settled) p.handles.set(taskId, h);
    carriedHandles.delete(planId);
    ref.p = p;
    try { await rebuildHeldSlots(p); }
    catch (error) { d.log("warn", "slot holds will be rechecked before collection", errorText(error)); }
    plans.set(planId, p);
    attachSlotObservations(d.observations, d.clock, writer);
    observeSchedulerLedger(d.observations, writer.ledger, "attach");
    observe(p, "runtime-attach");
    return p;
  }

  /**
   * Activation of a running or paused plan: pins the orchestrator, rebuilds the leases (A3; `recoverPlan` step 1), then
   * either resumes the integration queue (a fresh ledger: approve, compile; §9) or runs `recoverPlan` (an existing
   * ledger: start, adopt, promotion of a passive plan). `p.recovering` holds every tick until the first one, scheduled
   * last (step 11).
   */
  async function activate(p: PlanRt, existing: boolean): Promise<void> {
    p.recovering = true;
    observe(p, "activation");
    try {
      p.offSlotRelease ??= slotsFor(p.planId).onTaskSlotReleased?.(() => taskSlotReleased(p)) ?? null;
      const l = p.writer.ledger;
      p.unpin?.();
      p.unpin = d.pinOrchestrator(l.orchestrator.sessionID);
      await rebuildLeases(p);
      if (existing) await recoverPlan(p);
      else await resumeIntegration(p);
    } finally {
      p.recovering = false;
      observe(p, "activation-end");
    }
    schedule(p);
  }

  /**
   * §9: `queue.resume()` once per activation, before the first dequeue. A halt (A2-5) is the queue's to journal (plan
   * paused, one item); the runtime only remembers it, so a user `resume` calls it again. A double resolving `undefined`
   * counts as resumed.
   */
  async function resumeIntegration(p: PlanRt): Promise<void> {
    let report: ResumeReport | undefined;
    try {
      report = await p.collab.queue.resume();
    } catch (e) {
      d.log("warn", "integration resume failed", errorText(e));
      p.integrationResumed = false;
      await integrationResumeFailed(p, e);
      return;
    }
    p.integrationResumed = report?.halted !== true;
  }

  /**
   * QA-4.2-6: a rejected `queue.resume()` leaves the lanes latched, so integration would be silently off. As a halt does,
   * the plan is paused and ONE critical item raised (deduplicated on its text); a user `resume` retries the queue resume.
   */
  async function integrationResumeFailed(p: PlanRt, e: unknown): Promise<void> {
    let paused = false;
    try {
      paused = await appendIf(p, (cur) =>
        cur.status === "running" ? [{ type: "status-changed", from: "running", to: "paused", reason: "integration-resume-failed" }] : [],
      );
    } catch (e2) {
      d.log("error", "integration resume pause failed", errorText(e2));
    }
    if (paused) closeIdle(p);
    counter(p, "integration-resume-failed");
    await raiseSafe(p, {
      kind: "failure",
      severity: "critical",
      taskId: null,
      text: `the integration queue of plan ${p.planId} could not resume (${errorText(e).slice(0, 500)}); the plan is paused, resume it once the cause is fixed`,
      options: [],
    });
  }

  /** Plans `recover()` reported eligible (same toplevel) or adopted here: only these may be taken over by `start()`. */
  const recoverable = new Set<PlanId>();
  /** QA-4.2-17: plans of another toplevel `start()` attached passively; never recovered, resumed or ticked here. */
  const foreignPlans = new Set<PlanId>();
  /**
   * Nit (QA-4.2): the `recover()` report of an eligible plan, when it carries the engine's full feeds; its first
   * `recoverPlan` (in `start`) consumes it instead of reconciling the same ledger a second time.
   */
  const recoverReports = new Map<PlanId, ReconcileFeed[]>();

  /** A `recover()` action that is a full engine feed (`createRecoveryService` reports `ReconcileFeed`s). */
  function isFeed(a: ReconcileAction): a is ReconcileFeed {
    return "orphans" in a && "probation" in a && "slotValid" in a && "context" in a;
  }

  /**
   * QA-4.2-21: a plan of another repository, decided by the plan's own toplevel (never by its absence from a `recover()`
   * report, which also skips a plan on a transient error).
   */
  function isForeign(toplevel: string): boolean {
    return !sameToplevel(toplevel, d.toplevel);
  }

  /** Whether `reconcile` may classify `p`: a plan of this repository. */
  function reconcilable(p: PlanRt): boolean {
    return !isForeign(p.writer.ledger.repo.toplevel);
  }

  /** Same-process adopt: the unsettled launch handles of the closed attachment, handed to the new one (D12). */
  const carriedHandles = new Map<PlanId, Array<[TaskId, HandleRef]>>();
  /** Same-process adopt: the closed attachment of a plan under re-attach (`onChildEnd` still finds its tasks there). */
  const closing = new Map<PlanId, PlanRt>();

  /** The live attachment of `p`'s plan: a launch made before a same-process adopt reports to the new one. */
  function current(p: PlanRt): PlanRt {
    return p.disposed ? (plans.get(p.planId) ?? p) : p;
  }

  /**
   * QA-4.2-4: a same-process adopt between `closePlan(old)` and the new attachment. The promise settles once the new
   * attachment is registered (or the adopt failed); child ends, creations and confirmations wait on it, so none goes
   * through the closed writer.
   */
  const reattaching = new Map<PlanId, Promise<void>>();
  /** The opener of each waiting point in `reattaching`; `dispose` opens them all, so no waiter outlives the runtime. */
  const reattachOpeners = new Map<PlanId, () => void>();

  /** Opens (and forgets) the re-attach waiting point of `planId`, if any; idempotent. */
  function openReattach(planId: PlanId): void {
    const open = reattachOpeners.get(planId);
    reattachOpeners.delete(planId);
    reattaching.delete(planId);
    closing.delete(planId);
    open?.();
  }

  /** The live attachment of `p0`'s plan once no re-attach is under way (QA-4.2-4; the waiting points never reject). */
  async function live(p0: PlanRt): Promise<PlanRt> {
    let seen: Promise<void> | undefined;
    for (let r = reattaching.get(p0.planId); r !== undefined && r !== seen; r = reattaching.get(p0.planId)) {
      seen = r;
      await r;
    }
    return current(p0);
  }

  /**
   * 4.2.5 `recoverPlan`, steps 2-10 (step 1 ran in `activate`; the slot markers are read by `reconcile`, R2; step 11 is
   * `activate`'s). It feeds the runtime's own handlers and never opens an attempt (R5, D4).
   */
  async function recoverPlan(p: PlanRt): Promise<void> {
    // (2) classification, read-only; launches this process tracks are never reconciled (D12)
    const feeds = await reconcileFeeds(p);
    // (3) orphans, best effort
    for (const f of feeds) for (const s of f.orphans) await interruptQuiet(s);
    // (4) the integration queue, before any dequeue (D7)
    await resumeIntegration(p);
    // (5) the matrix, in task-id order
    for (const f of feeds) {
      try {
        await applyFeed(p, f);
      } catch (e) {
        d.log("warn", `recovery of ${f.taskId} failed`, errorText(e));
      }
    }
    // (6) retry or exhausted decisions left behind
    for (const id of Object.keys(p.writer.ledger.tasks).sort() as TaskId[]) {
      const s = own(p.writer.ledger, id)?.state;
      if (s !== "failed" && s !== "conflict" && s !== "reverted") continue;
      try {
        await withTask(p, id, () => retryDecision(p, id));
      } catch (e) {
        d.log("warn", `retry decision of ${id} failed`, errorText(e));
      }
    }
    // (7) gates, (8) the breaker of a phase whose failure feed may have been missed
    await recoverGates(p);
    await evaluateBreakers(p);
    // (9) verified tasks go back to the queue (it dedupes); a task held by a failed lease rebuild waits for its leases
    const verified = Object.values(p.writer.ledger.tasks)
      .filter((t) => t.state === "verified" && !p.leaseHeld.has(t.id))
      .map((t) => t.id);
    if (verified.length > 0 && !p.latch) p.collab.queue.enqueue(verified);
    // (10)
    try {
      await p.collab.policy.unblock();
    } catch (e) {
      d.log("warn", "unblock after recovery failed", errorText(e));
    }
  }

  async function reconcileFeeds(p: PlanRt): Promise<ReconcileFeed[]> {
    const rec = d.recovery;
    const l = p.writer.ledger;
    const tracked = new Set<string>();
    for (const f of d.launcher.inFlight()) {
      const a = own(l, f.taskId)?.attempts.find((x) => x.n === f.attempt);
      if (a !== undefined) tracked.add(a.nonce);
    }
    for (const [taskId, h] of p.handles) {
      const a = own(l, taskId)?.attempts.find((x) => x.n === h.n);
      if (a === undefined) continue;
      tracked.add(a.nonce);
      // A launch carried over a same-process adopt keeps its capacity token on the new controller.
      if (!h.settled) forceToken(p, own(l, taskId), h.n);
    }
    // Nit (QA-4.2): `start` already reconciled this ledger in `recover()` (no launch of this process was tracked then);
    // that report is used once instead of a second classification. Any tracked launch makes it stale.
    const reported = recoverReports.get(p.planId);
    recoverReports.delete(p.planId);
    if (reported !== undefined && tracked.size === 0) {
      return [...reported].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    }
    // QA-4.2-21: a plan of this repository missing from the recover() report (a transient error there) is reconciled here.
    if (rec === null || rec.reconcile === undefined || !reconcilable(p)) return [];
    try {
      return await rec.reconcile(l, tracked);
    } catch (e) {
      d.log("error", "reconcile failed", errorText(e));
      return [];
    }
  }

  /** A1-5: the forced capacity token of an adopted or carried child; never throws. */
  function forceToken(p: PlanRt, t: TaskNode | null, n: number): void {
    if (t === null || p.tokens.has(tokenKey(t.id, n))) return;
    try {
      const route = viewOf(p, null).routeOf(t);
      p.tokens.set(tokenKey(t.id, n), p.capacity.acquire(route.provider, route.heavy, t.id, n, { force: true }));
      observe(p, "capacity-reserve", () => ({ taskId: t.id, attempt: n, provider: route.provider, heavy: route.heavy,
        token: p.tokens.get(tokenKey(t.id, n))?.id ?? null, force: true }));
    } catch (e) {
      d.log("warn", "forced capacity token failed", errorText(e));
    }
  }

  async function interruptQuiet(sessionID: string): Promise<void> {
    try {
      await d.hosts.interrupt(sessionID);
    } catch (e) {
      d.log("warn", `interrupt of ${sessionID} failed`, errorText(e));
    }
  }

  /** §5 matrix, one feed. A task that moved since the classification is left alone (D2). */
  async function applyFeed(p: PlanRt, f: ReconcileFeed): Promise<void> {
    const t = own(p.writer.ledger, f.taskId);
    if (t === null || t.state !== f.from) return;
    switch (f.action) {
      case "adopt":
      case "process-result":
        await adoptChild(p, t, f);
        return;
      case "requeue-lost":
        // A terminal event received during the barrier is newer evidence than the read-only classification. Do not
        // reset its completed work out from under the registered completion pipeline.
        if (p.recoveredWork.get(t.id)?.work.kind === "end") return;
        await requeueLost(p, t, f);
        return;
      case "reverify":
        if (t.attempts[t.attempts.length - 1]?.n !== f.n) return;
        registerRecoveredWork(p, t, { kind: "reverify", slotValid: f.slotValid });
        return;
      case "re-enqueue":
        // R2: a verified task whose slot lost its marker gets its slot back before step 9 re-enqueues it.
        if (f.slotValid === false && t.slot !== null) {
          await withTask(p, t.id, async () => {
            const x = own(p.writer.ledger, t.id);
            if (x !== null && x.state === "verified") await reprovisionOrRaise(p, x);
          });
        }
        return;
      default:
        // re-enqueue: step 9; resume-integration: step 4; interrupt-orphan: step 3; none.
        return;
    }
  }

  /**
   * Matrix: `ready` (latest lost) -> row 7 (attempt-adopted, ready -> running, G1); `running` -> no batch. Then the
   * child is registered (a host event's end reaches `lateChildEnd`), its token forced, and a finished child's result
   * processed, an unknown one put on probation (R1a).
   */
  async function adoptChild(p: PlanRt, t: TaskNode, f: ReconcileFeed): Promise<void> {
    const a = t.attempts.find((x) => x.n === f.n);
    const child = f.childSessionID;
    if (a === undefined || child === null) return;
    const n = a.n;
    const live = f.evidence !== "finished";
    // QA-4.2-16: a task whose leases could not be re-taken never adopts a live child (it would write without leases):
    // the child is interrupted and the task requeued. Only an interrupt that fails keeps it (adopted, still held).
    if (live && p.leaseHeld.has(t.id) && (await refuseHeldChild(p, t, f, child))) return;
    forceToken(p, t, n);
    if (t.state === "ready") {
      let applied = false;
      try {
        applied = await appendIf(p, (cur) => {
          const x = own(cur, t.id);
          if (x === null || x.state !== "ready" || x.slot === null || cur.status === "aborted" || p.latch) return [];
          const last = x.attempts[x.attempts.length - 1];
          if (last === undefined || last.n !== n || last.outcome !== "lost") return [];
          const g1 = gateOpen(cur, x);
          if (x.kind === "qa" && g1.length === 0) return [];
          return [{ type: "attempt-adopted", taskId: t.id, n, childSessionID: child }, tt(t.id, "ready", "running", "adopt"), ...g1];
        });
      } finally {
        if (!applied) releaseToken(p, t.id, n, "other");
      }
      if (!applied) {
        // Nit (QA-4.2): row 7 refused: a live (or unknown) child must not keep writing in the slot while the task
        // relaunches; it is interrupted as an orphan.
        if (live) await interruptQuiet(child);
        return;
      }
    }
    restoreHandle(p, t.id, n, child);
    // Marked before the re-bind: a failed re-bind (only logged) must not let this child's end run without a root context.
    p.adoptedByRecovery.add(tokenKey(t.id, n));
    // QA-4.2-18: a fresh plugin instance has no binding for the adopted child; re-bind it as the launcher did.
    await rebindChild(p, t, a, child);
    if (f.evidence === "finished") {
      await processEnd(p, t.id, n, endFromContext(child, f.context));
      return;
    }
    if (f.probation !== null && p.recoveredWork.get(t.id)?.work.kind !== "end") startProbation(p, child, t.id, n, f.probation, f.context);
  }

  /** Registers an adopted child that no launch of this process tracks: its terminal host event ends it (L12 mapper). */
  function restoreHandle(p: PlanRt, taskId: TaskId, n: number, childSessionID: string): void {
    const have = p.handles.get(taskId);
    if (have !== undefined && have.n === n && !have.settled) return;
    const gone: ChildEnd = { kind: "lost", childSessionID, reason: "restart", endedAt: d.clock.iso() };
    p.handles.set(taskId, { n, settled: true, completion: Promise.resolve(gone) });
  }

  /**
   * QA-4.2-16: the live child of a task held by a failed lease rebuild is interrupted instead of adopted; then the slot's
   * contents are reset (R4) and a `running` task is requeued (row 18, `lost "restart"`, uncounted), a `ready` one stays
   * ready. Its relaunch re-takes the leases (launch step 3), so the hold ends. False when the interrupt failed: the child
   * may still run, so the caller adopts it after all (the task stays held: no commit, verify or enqueue).
   */
  async function refuseHeldChild(p: PlanRt, t: TaskNode, f: ReconcileFeed, child: string): Promise<boolean> {
    p.interrupting.add(child);
    try {
      try {
        await d.hosts.interrupt(child);
      } catch (e) {
        if (!interruptSettled(e)) {
          d.log("warn", `interrupt of the lease-held child ${child} of ${t.id} failed; adopted, still held`, errorText(e));
          return false;
        }
      }
      counter(p, "lease-held-interrupt", { taskId: t.id });
      await withTask(p, t.id, async () => {
        const x = own(p.writer.ledger, t.id);
        if (x === null || x.state !== t.state) return;
        if (x.state === "running") await requeueLost(p, x, f);
        else await resetSlotContents(p, x);
      });
      if (own(p.writer.ledger, t.id)?.state === "ready") p.leaseHeld.delete(t.id);
      return true;
    } finally {
      p.interrupting.delete(child);
    }
  }

  /** QA-4.2-18: binds an adopted child through the launcher's binding port, with its task's role, grant and work root. */
  async function rebindChild(p: PlanRt, t: TaskNode, a: Attempt, childSessionID: string): Promise<void> {
    try {
      const l = p.writer.ledger;
      const slot = await slotLeaseOf(p, t);
      const env = await loadExpansionEnv(d.git, { toplevel: l.repo.toplevel, slotPath: slot.path, timeoutMs: GIT_TIMEOUT_MS });
      const x = expandTask({ ledger: l, taskId: t.id, attempt: a.n, nonce: a.nonce, slot, env });
      const route = viewOf(p, null).routeOf(t);
      d.bindings.bind({
        planId: p.planId,
        taskId: t.id,
        attempt: a.n,
        childSessionID,
        role: t.route.role,
        agent: route.agent,
        ...(route.tier === undefined ? {} : { tier: route.tier }),
        prompt: x.prompt,
        budget: x.routeBudget ?? null,
        workRoot: x.workRoot,
        grant: needsOf(x.routeLine),
      });
      p.rebound.set(t.id, { n: a.n, childSessionID });
      counter(p, "child-rebound", { taskId: t.id });
    } catch (e) {
      d.log("warn", `re-binding the adopted child of ${t.id} failed`, errorText(e));
    }
  }

  /** QA-4.2-23: evicts the binding `rebindChild` made for `taskId` (only for attempt `n` when given); never throws. */
  function evictRebound(p: PlanRt, taskId: TaskId, n: number | null): void {
    const r = p.rebound.get(taskId);
    if (r === undefined || (n !== null && r.n !== n)) return;
    p.rebound.delete(taskId);
    try {
      d.bindings.evict(r.childSessionID);
    } catch (e) {
      d.log("warn", `evicting the binding of ${r.childSessionID} failed`, errorText(e));
    }
  }

  /** R1 rule 5: the end of a child whose last message is `idle`; the result is its last assistant message. */
  function endFromContext(childSessionID: string, ctx: HostSessionContext | null): ChildEnd {
    const at = d.clock.iso();
    const msgs = ctx?.messages ?? [];
    const outcome = msgs[msgs.length - 1]?.outcome ?? null;
    if (outcome !== null && /interrupt|abort/i.test(outcome)) return { kind: "lost", childSessionID, reason: "unrequested-interrupt", endedAt: at };
    if (outcome !== null && /fail|error/i.test(outcome)) {
      const error: HostError = { type: "execution.failed", status: null, message: outcome };
      return { kind: "failed", childSessionID, error, endedAt: at };
    }
    let text = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.role === "assistant" && m.text !== null) {
        text = m.text;
        break;
      }
    }
    return { kind: "completed", childSessionID, text, endedAt: at };
  }

  /**
   * Matrix requeue-lost: reset the slot's contents (R4) before row 11 (`dispatched`) or row 18 (`running`), both
   * `lost "restart"`, uncounted; slot and leases kept. R2: a missing or foreign slot marker is never reset; a separate
   * batch then clears the slot of the now ready task.
   */
  async function requeueLost(p: PlanRt, t: TaskNode, f: ReconcileFeed): Promise<void> {
    if (t.slot !== null && f.slotValid !== false) await resetSlotContents(p, t);
    if (t.state === "dispatched" || t.state === "running") {
      const from = t.state;
      const at = d.clock.iso();
      await appendIf(p, (cur) => {
        const c = own(cur, t.id);
        if (c === null || c.state !== from) return [];
        const a = f.n === null ? null : openAttempt(c, f.n);
        const ev: ExecutorEventInput[] = [];
        if (a !== null) ev.push(ae(t.id, a.n, "lost", clampEnd(a, at), "restart"));
        ev.push(from === "dispatched" ? tt(t.id, "dispatched", "ready", "launch-lost", "restart") : tt(t.id, "running", "ready", "child-lost", "restart"));
        ev.push(...gateRequeue(cur, c));
        return ev;
      });
    }
    if (f.slotValid === false) await clearBadSlot(p, t.id);
  }

  /**
   * R2: clears the slot of a ready task whose slot marker is missing or foreign; leases go, the slot only if ours.
   * An owned slot is saved before the batch clears it; a failed save keeps its slot and hold. Foreign owners are
   * never touched, and only a missing directory (not missing repository metadata) is disposable without a snapshot.
   */
  async function clearBadSlot(p: PlanRt, taskId: TaskId): Promise<void> {
    const task = own(p.writer.ledger, taskId);
    if (task === null || task.state !== "ready") return;
    const slotName = task.slot;
    if (slotName !== null && !(await releaseGoneSlot(p, taskId, slotName))) return;
    const applied = await appendIf(p, (cur) => {
      const c = own(cur, taskId);
      return c === null || c.state !== "ready" || c.slot === null ? [] : [ts(taskId, null, null)];
    });
    if (!applied) return;
    releaseLeases(p, taskId);
    p.slotLeases.delete(taskId);
  }

  /**
   * R2: a foreign slot is untouched. An owned slot with a missing/invalid marker can still hold work: save it before
   * returning it to the pool, or retain its lease and durable hold. Metadata-less directories are quarantined, not lost.
   */
  async function releaseGoneSlot(p: PlanRt, taskId: TaskId, slotName: string): Promise<boolean> {
    let held = false;
    try {
      const rec = await slotsFor(p.planId).get(slotName);
      held = rec !== null && rec.owner === leaseHolderID(p.planId, taskId) && rec.state === "leased";
    } catch (e) {
      d.log("warn", `slot lookup of the bad slot ${slotName} failed`, errorText(e));
      await wipHold(p, taskId, slotName, "its recovery release");
      return false;
    }
    if (!held) return true;
    const saved = await snapshotTaskSlot(p, taskId, slotName, "recovery-release");
    if (saved === "failed") {
      await wipHold(p, taskId, slotName, "its recovery release");
      return false;
    }
    if (p.slotLeases.get(taskId)?.slot === slotName) p.slotLeases.delete(taskId);
    wipFailRaised.delete(`${p.planId}/${slotName}`);
    try {
      await slotsFor(p.planId).release(slotName);
      counter(p, "bad-slot-released", { taskId, slot: slotName });
    } catch (e) {
      d.log("warn", `releasing the bad slot ${slotName} of ${taskId} failed`, errorText(e));
      return false;
    }
    return true;
  }

  /**
   * R2: a `completed`/`verifying`/`verified` task whose slot marker is missing or foreign gets a slot again from its task
   * branch `omr/<planId>/t/<taskId>`: the stale slot goes back to the pool (only if the pool still records it as ours), a
   * slot is acquired, reset to the branch tip and checked out (detached) at it, the task's leases move to the new tree
   * (released and re-taken, as `rebuild` does) and the slot is journaled (state re-checked, D2). False when the branch
   * does not exist (nothing touched) or a later step fails (the new slot is returned); the caller raises the blocking item.
   */
  async function reprovisionSlot(p: PlanRt, taskId: TaskId): Promise<boolean> {
    const t0 = own(p.writer.ledger, taskId);
    if (t0 === null || (t0.state !== "completed" && t0.state !== "verifying" && t0.state !== "verified")) return false;
    const from = t0.state;
    const branch = taskBranchName(p.planId, taskId);
    const o = { cwd: p.writer.ledger.repo.toplevel, timeoutMs: GIT_TIMEOUT_MS };
    let tip = "";
    try {
      const r = await d.git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], o);
      tip = r.code === 0 ? r.stdout.trim() : "";
    } catch (e) {
      d.log("warn", `task branch of ${taskId} unreadable`, errorText(e));
    }
    if (tip === "") return false;
    const stale = t0.slot;
    // Missing marker evidence is not permission to discard an owned tree. A failed save stops re-provisioning.
    if (stale !== null && !(await releaseGoneSlot(p, taskId, stale))) return false;
    p.slotLeases.delete(taskId);
    let slot: SlotLease | null = null;
    const undo = async (why: string, e?: unknown): Promise<false> => {
      d.log("warn", `re-provisioning ${taskId} from ${branch}: ${why}`, e === undefined ? "" : errorText(e));
      const s = slot;
      if (s !== null && !(await releaseSlotSaved(p, taskId, s.slot, "reprovision-undo"))) return false;
      p.slotLeases.delete(taskId);
      return false;
    };
    try {
      const { verifiedResetBase, ...acquired } = await slotsFor(p.planId).acquire(p.planId, leaseHolderID(p.planId, taskId), tip);
      slot = acquired;
      p.slotLeases.set(taskId, slot);
      if (verifiedResetBase === undefined) {
        const saved = await saveBeforeLaunchReset(p, t0, slot, slot.commit);
        if (saved === "failed") {
          await wipHold(p, taskId, slot.slot, "its re-provisioning reset");
          return false;
        }
      }
      if (verifiedResetBase !== tip) await slotsFor(p.planId).reset(slot.slot, tip);
      // QA-PDF21-12: the cached lease follows the reset (a re-acquired slot's lease names its pre-reset commit).
      slot = leaseAt(slot, tip);
      p.slotLeases.set(taskId, slot);
      // Detached at the tip: the branch may still be checked out in the stale worktree, and the ref itself stays put.
      const r = await d.git.run(["switch", "--detach", tip], { cwd: slot.path, timeoutMs: GIT_TIMEOUT_MS });
      if (r.code !== 0) return await undo("checkout failed", r.stderr.slice(0, 2000));
    } catch (e) {
      return await undo("slot unavailable", e);
    }
    const lease = slot;
    releaseLeases(p, taskId);
    try {
      const got = p.leases.acquireTask({ taskId, tree: lease.path, writes: t0.footprint.writes });
      if (!got.ok) return await undo("leases held elsewhere");
      // QA-4.2-16: the leases are back on the new tree; a hold from the failed rebuild ends here.
      p.leaseHeld.delete(taskId);
    } catch (e) {
      return await undo("lease error", e);
    }
    try {
      await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        if (c === null || c.state !== from) return [];
        return c.slot === lease.slot && c.branch === branch ? [] : [ts(taskId, lease.slot, branch)];
      });
    } catch (e) {
      return await undo("journal failed", e);
    }
    const now = own(p.writer.ledger, taskId);
    if (now === null || now.slot !== lease.slot) return await undo("the task moved");
    counter(p, "slot-reprovisioned", { taskId });
    return true;
  }

  /**
   * R2 for `completed`/`verifying`/`verified`: re-provision from the task branch; when that is impossible (no branch, a
   * failed step) the slot is not this task's any more and its work cannot be trusted: one blocking item, a human decides.
   */
  async function reprovisionOrRaise(p: PlanRt, t: TaskNode): Promise<boolean> {
    if (await reprovisionSlot(p, t.id)) return true;
    await raiseSlotLost(p, t);
    return false;
  }

  /**
   * QA-4.2-13: whether a commit of the repository carries attempt `n`'s trailer (D11); null when git cannot tell. On
   * attempt 1 the task branch is created by the commit itself, so a missing branch usually means "never committed".
   */
  async function attemptCommitted(p: PlanRt, taskId: TaskId, a: Attempt): Promise<boolean | null> {
    const trailer = attemptTrailer(p.planId, taskId, a.n, a.nonce);
    try {
      const r = await d.git.run(["log", "--all", "--fixed-strings", `--grep=${trailer}`, "--format=%H", "-n", "1"], {
        cwd: p.writer.ledger.repo.toplevel,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      return r.code === 0 ? r.stdout.trim() !== "" : null;
    } catch (e) {
      d.log("warn", `trailer search for ${taskId} failed`, errorText(e));
      return null;
    }
  }

  /**
   * QA-4.2-13: a `completed` task whose slot was lost before its commit (R2 re-provisioning impossible, no commit with
   * this attempt's trailer): its work is gone. `completed -> failed` (`commit-failed`, context "slot lost before commit")
   * and the retry decision, as for any commit failure. Counted: the attempt already closed `succeeded` at row 15, so it
   * counts toward maxAttempts whatever happens next (an attempt outcome is never rewritten), and as a commit failure it
   * IS a counted breaker failure (A-4.2-2, `isCommitFailure`): `countAttempt` feeds and marks it. The stale slot is then
   * given up (R2, as for a ready task).
   */
  async function slotLostBeforeCommit(p: PlanRt, taskId: TaskId, n: number): Promise<void> {
    const applied = await appendIf(p, (cur) => {
      const c = own(cur, taskId);
      if (c === null || c.state !== "completed") return [];
      return [ax(taskId, n, SLOT_LOST_BEFORE_COMMIT), tt(taskId, "completed", "failed", "commit-failed", SLOT_LOST_BEFORE_COMMIT)];
    });
    if (!applied) return;
    p.leaseHeld.delete(taskId);
    counter(p, "slot-lost-before-commit", { taskId });
    await countAttempt(p, taskId, n);
    await retryDecision(p, taskId);
    await clearBadSlot(p, taskId);
  }

  /** R2: the blocking item of a task whose slot cannot be re-provisioned and whose work may exist (a human decides). */
  async function raiseSlotLost(p: PlanRt, t: TaskNode): Promise<void> {
    await raiseSafe(p, {
      kind: "failure",
      severity: "blocking",
      taskId: t.id,
      text: `the slot of ${t.id} (${t.slot ?? "none"}) no longer carries its marker after a restart and it could not be re-provisioned from ${taskBranchName(p.planId, t.id)}; restore the task branch or abort the task`,
      options: [],
    });
  }

  /** R4: `reset --hard HEAD` + `clean -fd` in the task's slot (ignored files kept); idempotent, never throws. */
  async function resetSlotContents(p: PlanRt, t: TaskNode): Promise<void> {
    // pdf2-1 (b): the slot's work is saved at the task's WIP ref before the reset. QA-PDF21-3: a failed save keeps the
    // slot as it is (no reset) and raises the item that names it.
    if (t.slot !== null && (await snapshotTaskSlot(p, t.id, t.slot, "restart")) === "failed") {
      await wipHold(p, t.id, t.slot, "its reset (restart)");
      return;
    }
    try {
      const lease = await slotLeaseOf(p, t);
      const o = { cwd: lease.path, timeoutMs: GIT_TIMEOUT_MS };
      await d.git.run(["reset", "--hard", "HEAD"], o);
      await d.git.run(["clean", "-fd"], o);
    } catch (e) {
      d.log("warn", `slot reset of ${t.id} failed`, errorText(e));
    }
  }

  /** `completed` -> commit-and-verify (D11 finds a commit made before the crash); `verifying` -> the verifier again. */
  async function reverify(p: PlanRt, taskId: TaskId, slotValid: boolean | null): Promise<void> {
    const t0 = own(p.writer.ledger, taskId);
    const a = t0 === null ? undefined : t0.attempts[t0.attempts.length - 1];
    if (t0 === null || a === undefined || t0.slot === null) return;
    const n = a.n;
    if (slotValid === false) {
      // QA-4.2-20: the branch tip may hold an EARLIER attempt's commit, so a `completed` task is re-provisioned only once
      // this attempt's own commit is known to exist. QA-4.2-13: none -> its work went with the slot: failed, retried.
      // git cannot tell -> the blocking item (a human decides).
      if (t0.state === "completed") {
        const committed = await attemptCommitted(p, taskId, a);
        if (committed === false) {
          await slotLostBeforeCommit(p, taskId, n);
          return;
        }
        if (committed === null) {
          await raiseSlotLost(p, t0);
          return;
        }
      }
      if (!(await reprovisionSlot(p, taskId))) {
        await raiseSlotLost(p, t0);
        return;
      }
    }
    // Re-read: a re-provisioned task has a new slot.
    const t = own(p.writer.ledger, taskId);
    if (t === null || t.slot === null) return;
    if (t.state === "completed") {
      await commitAndVerify(p, taskId, n);
      return;
    }
    if (t.state !== "verifying") return;
    let lease: SlotLease;
    try {
      lease = await slotLeaseOf(p, t);
    } catch (e) {
      d.log("warn", `reverify of ${taskId}: slot unavailable`, errorText(e));
      return;
    }
    await verifyAttempt(p, taskId, n, lease);
  }

  /** Step 7: `qa-running` with no QA task in flight -> the latest done QA task's report; `awaiting-qa` -> onAwaitingQa. */
  async function recoverGates(p: PlanRt): Promise<void> {
    for (const { id } of p.writer.ledger.phases) {
      try {
        const l = p.writer.ledger;
        const ph = l.phases.find((x) => x.id === id);
        if (ph === undefined) continue;
        if (ph.gate === "awaiting-qa") {
          await p.collab.qa.onAwaitingQa(id);
          continue;
        }
        if (ph.gate !== "qa-running") continue;
        const qas = Object.values(l.tasks).filter((t) => t.kind === "qa" && t.phase === id);
        if (qas.some((t) => t.state === "dispatched" || t.state === "running")) continue;
        let best: { t: TaskNode; a: Attempt } | null = null;
        for (const t of qas) {
          const a = t.attempts[t.attempts.length - 1];
          if (t.state !== "done" || a === undefined) continue;
          if (best === null || (a.endedAt ?? "") > (best.a.endedAt ?? "")) best = { t, a };
        }
        if (best === null) continue;
        const parsed = p.collab.qa.parse(best.a.context);
        if (parsed.ok) await p.collab.qa.onQaResult(best.t.id, parsed.report);
      } catch (e) {
        d.log("warn", `gate recovery of ${id} failed`, errorText(e));
      }
    }
  }

  /**
   * Step 8 (B5): each unpaused phase with a NEW failure in its breaker window is evaluated once, by its latest failure.
   * QA-4.2-14: only failures no feed has evaluated yet are new: every feed (`countAttempt`, and this step) journals a
   * BREAKER_FED counter per failure it fed. A failure that settled while the phase was paused was fed live and could not
   * trip (B4); evaluating it again after the unpause would trip at a restart with no new failure. A failure whose batch
   * landed but whose feed a crash missed carries no marker and is fed here. The marker is a metric because the exported
   * journal keeps only history events (`isHistoryEvent`: metric, integration-step, attempt-verdict, wake) across
   * snapshots; `attempt-ended` and `phase-paused` are gone once the main journal rotates (the first fix read those).
   */
  async function evaluateBreakers(p: PlanRt): Promise<void> {
    const l = p.writer.ledger;
    if (!l.phases.some((ph) => !ph.paused)) return;
    // QA-4.2-29: the activation's one history export (read by `build` for the capacity restore), else a fresh one.
    const events = p.history ?? (await exportHistory(p.planId, "breaker journal read failed; no breaker evaluated at activation"));
    p.history = null;
    // Without the journal a failure cannot be told new or already fed: no phase is fed (a missed trip is caught by the
    // next live failure feed, which evaluates the whole window; a spurious trip would pause the phase for nothing).
    if (events === null) return;
    // Markers journaled after the export (a feed earlier in this activation) are in `p.fed`.
    const fed = new Set<string>(p.fed);
    for (const e of events) {
      if (e.type !== "metric" || e.metric.name !== "counter" || e.metric.key !== BREAKER_FED) continue;
      fed.add(`${e.metric.labels["taskId"] ?? ""}#${e.metric.labels["n"] ?? ""}`);
    }
    for (const ph of l.phases) {
      if (ph.paused) continue;
      const fresh = breakerSamples(l, ph.id).filter((s) => s.failure && !fed.has(`${s.taskId}#${s.n}`));
      const hit = fresh[fresh.length - 1];
      if (hit === undefined) continue;
      try {
        await p.collab.policy.recordAttempt(ph.id, attemptOf(l, hit.taskId, hit.n));
      } catch (e) {
        d.log("warn", "recordAttempt failed", errorText(e));
        continue;
      }
      // One evaluation covers the phase's whole window: every failure it read is fed now.
      for (const s of fresh) markFed(p, ph.id, s.taskId, s.n);
    }
  }

  /**
   * QA-4.2-14/-22: journals that attempt `n` of `taskId` (a breaker failure) was fed to `recordAttempt`: a `counter`
   * metric, key BREAKER_FED ("breaker-fed", shared with unattended.ts), labels `{phaseId, taskId, n}` (n as a decimal
   * string). A metric is a history event (`isHistoryEvent`), so it survives snapshots.
   */
  function markFed(p: PlanRt, phaseId: string, taskId: TaskId, n: number): void {
    p.fed.add(`${taskId}#${n}`);
    counter(p, BREAKER_FED, { phaseId, taskId, n: String(n) });
  }

  // ---------- R1a probation watch

  function contextSig(ctx: HostSessionContext): string {
    const last = ctx.messages[ctx.messages.length - 1];
    return `${ctx.messages.length}|${last?.role ?? ""}|${last?.outcome ?? ""}|${last?.text ?? ""}`;
  }

  function startProbation(
    p: PlanRt,
    sessionID: string,
    taskId: TaskId,
    n: number,
    o: { deadlineAt: number; pollMs: number },
    ctx: HostSessionContext | null,
  ): void {
    p.probation.set(sessionID, {
      taskId,
      n,
      deadlineAt: o.deadlineAt,
      pollMs: Math.max(1, o.pollMs),
      lastSig: ctx === null ? null : contextSig(ctx),
      interruptFails: 0,
      raised: false,
      busy: false,
    });
    armProbation(p);
  }

  function armProbation(p: PlanRt): void {
    if (p.probationTimer !== null || p.probation.size === 0 || p.disposed || disposed) return;
    let ms = RECOVERY_POLL_MS;
    for (const w of p.probation.values()) ms = Math.min(ms, w.pollMs);
    const h = d.clock.setTimer(ms, () => {
      p.timers.delete(h);
      if (p.probationTimer === h) p.probationTimer = null;
      bg("probation poll", () => pollProbation(p));
    });
    p.timers.add(h);
    p.probationTimer = h;
  }

  /** A sign of life (host event, context change): the child stays adopted and leaves probation. */
  function provedAlive(p: PlanRt, sessionID: string): void {
    if (!p.probation.delete(sessionID) || p.probation.size > 0) return;
    const h = p.probationTimer;
    p.probationTimer = null;
    if (h === null) return;
    p.timers.delete(h);
    d.clock.clearTimer(h);
  }

  async function pollProbation(p: PlanRt): Promise<void> {
    for (const [sid, w] of [...p.probation]) {
      if (p.disposed || disposed) return;
      if (w.busy || p.probation.get(sid) !== w) continue;
      w.busy = true;
      try {
        await probeChild(p, sid, w);
      } finally {
        w.busy = false;
      }
    }
    armProbation(p);
  }

  /** One R1a poll of a child on probation: idle -> result; changed -> alive; past the deadline -> interrupt, row 18. */
  async function probeChild(p: PlanRt, sid: string, w: ProbationWatch): Promise<void> {
    const t = own(p.writer.ledger, w.taskId);
    if (t === null || t.state !== "running" || openAttempt(t, w.n)?.childSessionID !== sid) {
      p.probation.delete(sid);
      return;
    }
    let ctx: HostSessionContext | null = null;
    try {
      ctx = await d.hosts.context(sid);
    } catch (e) {
      d.log("warn", `probation poll of ${sid} failed`, errorText(e));
    }
    if (p.probation.get(sid) !== w) return;
    if (ctx !== null) {
      const last = ctx.messages[ctx.messages.length - 1];
      // QA-4.2-28 (the QA-4.2-2 rule): an `idle` entry is an end only with an outcome; one without is no end yet.
      if (last !== undefined && last.role === "idle" && last.outcome !== null) {
        p.probation.delete(sid);
        await processEnd(p, w.taskId, w.n, endFromContext(sid, ctx));
        return;
      }
      const sig = contextSig(ctx);
      if (w.lastSig !== null && sig !== w.lastSig) {
        provedAlive(p, sid);
        return;
      }
      w.lastSig = sig;
    }
    if (d.clock.now() < w.deadlineAt) return;
    // QA-4.2-15: the interrupt's own `execution.interrupted` is neither a proof of life nor an unrequested interrupt; this
    // poll step maps it to `lost "restart"` with the slot reset below.
    p.interrupting.add(sid);
    try {
      await d.hosts.interrupt(sid);
    } catch (e) {
      if (!interruptSettled(e)) {
        p.interrupting.delete(sid);
        w.interruptFails += 1;
        d.log("warn", `probation interrupt of ${sid} failed (${w.interruptFails})`, errorText(e));
        if (w.interruptFails >= PROBATION_INTERRUPT_FAILS && !w.raised) {
          w.raised = true;
          await raiseSafe(p, {
            kind: "failure",
            severity: "blocking",
            taskId: w.taskId,
            text: `the child ${sid} of ${w.taskId} showed no sign of life after a restart and could not be interrupted (${PROBATION_INTERRUPT_FAILS} attempts: ${errorText(e)}); the task waits until it ends or is interrupted`,
            options: [],
          });
        }
        return;
      }
    }
    if (p.probation.get(sid) !== w) {
      p.interrupting.delete(sid);
      return;
    }
    p.probation.delete(sid);
    try {
      await withTask(p, w.taskId, async () => {
        const cur = own(p.writer.ledger, w.taskId);
        if (cur !== null && cur.state === "running" && openAttempt(cur, w.n)?.childSessionID === sid) await resetSlotContents(p, cur);
      });
      await processEnd(p, w.taskId, w.n, { kind: "lost", childSessionID: sid, reason: "restart", endedAt: d.clock.iso() });
    } finally {
      p.interrupting.delete(sid);
    }
  }

  /** Step 1 (A3): every task's leases re-taken from its slot; one blocking item per task that cannot get them back. */
  async function rebuildLeases(p: PlanRt): Promise<void> {
    const l = p.writer.ledger;
    const rows: Array<{ id: TaskId; slot: string | null; tree: string | null; footprint: Footprint }> = [];
    for (const t of Object.values(l.tasks)) {
      let tree: string | null = null;
      if (t.slot !== null) {
        try {
          tree = (await slotsFor(p.planId).get(t.slot))?.path ?? null;
        } catch (e) {
          d.log("warn", "slot lookup failed", errorText(e));
        }
      }
      rows.push({ id: t.id, slot: t.slot, tree, footprint: t.footprint });
    }
    for (const f of p.leases.rebuild(rows)) {
      counter(p, "lease-rebuild-failed", { taskId: f.taskId });
      // QA-4.2-16: the task is held (no adopt, commit, verify or enqueue) until a retry gets its leases back.
      // A ready task is held only for the recovery's adopt decision (its relaunch re-takes the leases itself); the first
      // retry drops it.
      const st = own(l, f.taskId)?.state;
      if (st !== undefined && (st === "ready" || LEASE_HELD_STATES.includes(st))) p.leaseHeld.add(f.taskId);
      try {
        await p.collab.policy.raise({
          kind: "failure",
          severity: "blocking",
          taskId: f.taskId,
          // QA-4.2-26: the item says the task is held and what ends the hold.
          text:
            `could not re-take the leases of ${f.taskId} after restart; held by ${f.holders.map((h) => h.holderID).join(", ")}. ` +
            `${f.taskId} is held (no adopt, commit, verify or enqueue) until its leases are free: finish or abort the holder ` +
            `(or abort ${f.taskId}); it resumes on its own once the leases are released`,
          options: [],
        });
      } catch (e) {
        d.log("warn", "lease rebuild inbox failed", errorText(e));
      }
    }
  }

  /** R1a: a rejected interrupt that still means "nothing runs any more" (not found / not busy) is a success. */
  function interruptSettled(e: unknown): boolean {
    return /not[-_ ]?found|not[-_ ]?busy|no such session/i.test(`${errorCode(e) ?? ""} ${errorText(e)}`);
  }

  async function closePlan(p: PlanRt): Promise<void> {
    p.disposed = true;
    p.latch = true;
    p.attachment.abort();
    p.recoveredWork.clear();
    // An adopt closes this writer only after old-attachment pipelines have observed their cut.
    await Promise.allSettled([...p.attachmentWork]);
    p.offSlotRelease?.();
    p.offSlotRelease = null;
    observe(p, "detach");
    for (const h of p.timers) d.clock.clearTimer(h);
    p.timers.clear();
    p.backoff = null;
    unpinPlan(p);
    closeIdle(p);
    await p.metricChain;
    plans.delete(p.planId);
    // QA-3.1-15: the plan detaches, so do the per-session entries of its orchestrator and children.
    const l = p.writer.ledger;
    forgetSession(l.orchestrator.sessionID);
    for (const t of Object.values(l.tasks)) for (const a of t.attempts) if (a.childSessionID !== null) forgetSession(a.childSessionID);
    p.handles.clear();
    p.probation.clear();
    p.probationTimer = null;
    p.lostStreak.clear();
    p.capacityStopped.clear();
    p.wakeRetry.clear();
    p.interrupting.clear();
    p.leaseHeld.clear();
    // QA-4.2-23: the plan detaches, so do the bindings of the children recovery adopted (a new attachment re-binds them).
    for (const id of [...p.rebound.keys()]) evictRebound(p, id, null);
    p.history = null;
    // QA-4.2-3: the queue's lanes stop and its repo lock goes before the writer closes (adopt, dispose, purge).
    await disposeQueue(p);
    detachSlotObservations(d.clock, p.writer);
    await p.writer.close();
  }

  /** QA-4.2-3: `queue.dispose()`, bounded by QUEUE_DISPOSE_MS (a hung queue is logged, never blocks the close). */
  async function disposeQueue(p: PlanRt): Promise<void> {
    const fire: { timeout: () => void } = { timeout: () => undefined };
    const timeout = new Promise<"timeout">((resolve) => {
      fire.timeout = () => resolve("timeout");
    });
    // The injected clock: a fake clock bounds it in tests, and `clearTimer` below releases it on every path.
    const h = d.clock.setTimer(QUEUE_DISPOSE_MS, () => fire.timeout());
    try {
      const done = Promise.resolve()
        .then(() => p.collab.queue.dispose())
        .then(() => "disposed" as const);
      if ((await Promise.race([done, timeout])) === "timeout") d.log("warn", `integration queue of ${p.planId} did not dispose in ${QUEUE_DISPOSE_MS} ms`);
    } catch (e) {
      d.log("warn", "integration queue dispose failed", errorText(e));
    } finally {
      d.clock.clearTimer(h);
    }
  }

  async function planFor(planId: PlanId, sessionID: string): Promise<PlanRt> {
    const have = plans.get(planId);
    if (have !== undefined) return have;
    const ledger = await d.store.read(planId);
    if (isForeign(ledger.repo.toplevel)) return attach(readOnlyWriter(ledger), true, undefined, { foreign: true });
    const writer = await d.store.open(planId, d.holder(sessionID));
    return attach(writer, true);
  }

  /**
   * QA-4.2-25: after an adopt that failed once the old attachment was closed, the plan is opened again for its previous
   * orchestrator and attached (recovered as any existing ledger; the carried launches stay tracked). Never throws: a
   * plan that cannot be opened (a live holder took it) is logged and left to that holder.
   */
  async function reattachAfterFailedAdopt(planId: PlanId, orchestrator: string, onRegistered: () => void): Promise<void> {
    try {
      const ledger = await d.store.read(planId);
      if (isForeign(ledger.repo.toplevel)) {
        await attach(readOnlyWriter(ledger), true, onRegistered, { foreign: true });
        return;
      }
      const writer = await d.store.open(planId, d.holder(orchestrator));
      await attach(writer, true, onRegistered);
      d.log("warn", `adopt of ${planId} failed; the plan is attached again for ${orchestrator}`);
    } catch (e) {
      d.log("error", `plan ${planId} could not be attached again after a failed adopt`, errorText(e));
    }
  }

  function owned(p: PlanRt, sessionID: string): PlanRt {
    if (p.writer.ledger.orchestrator.sessionID !== sessionID) {
      throw new ExecutorError("E_NOT_OWNER", `plan ${p.planId} belongs to another session`, p.writer.ledger.orchestrator.sessionID);
    }
    return p;
  }

  async function mine(planId: PlanId, sessionID: string): Promise<PlanRt> {
    const ledger = plans.get(planId)?.writer.ledger ?? await d.store.read(planId);
    if (ledger.orchestrator.sessionID !== sessionID) {
      throw new ExecutorError("E_NOT_OWNER", `plan ${planId} belongs to another session`, ledger.orchestrator.sessionID);
    }
    const p = owned(await planFor(planId, sessionID), sessionID);
    // A read-only attachment is safe, but mutation collaborators (abort/answer/purge included) must not run.
    // planFor re-reads before attachment, so this also covers a snapshot that became foreign between the reads.
    if (isForeign(p.writer.ledger.repo.toplevel)) {
      throw new ExecutorError("E_PLAN_STATE", `plan ${planId} belongs to another repository; its attachment is read-only`, { planId });
    }
    return p;
  }

  function requireStatus(p: PlanRt, ok: readonly LedgerStatus[]): void {
    const s = p.writer.ledger.status;
    if (!ok.includes(s)) throw new ExecutorError("E_PLAN_STATE", `plan ${p.planId} is ${s}`, s);
  }

  function ownsChild(p: PlanRt, sessionID: string): boolean {
    for (const t of Object.values(p.writer.ledger.tasks)) {
      const a = t.attempts[t.attempts.length - 1];
      if (a !== undefined && a.outcome === null && a.childSessionID === sessionID) return true;
    }
    return false;
  }

  // ---------- host feeds

  /** The task whose latest attempt runs in `sessionID`, if that session is a child of this plan. */
  function childTaskOf(p: PlanRt, sessionID: string): TaskId | null {
    for (const t of Object.values(p.writer.ledger.tasks)) {
      const a = t.attempts[t.attempts.length - 1];
      if (a !== undefined && a.childSessionID === sessionID) return t.id;
    }
    return null;
  }

  function feedSignal(p: PlanRt, s: ProviderSignal): void {
    const r = p.capacity.onSignal(s);
    if (r.inbox !== null) {
      // M15 (nit 2): the usage-limit item names the plan child's task when the signal came from one.
      const item = { ...r.inbox, taskId: r.inbox.taskId ?? childTaskOf(p, s.sessionID) };
      bg("usage-limit inbox", async () => {
        await p.collab.policy.raise(item);
      });
    }
    if (r.pausedUntil !== null) arm(p, Math.max(1, Date.parse(r.pausedUntil) - d.clock.now()));
  }

  /** QA-3.1-8: the adapter owns step keys (`e.stepKey`); the own per-session counter is only the fallback. */
  function stepKeyOf(e: HostSessionEvent): string {
    return eventStepKey(e) ?? `${e.sessionID}:${stepState.get(e.sessionID)?.k ?? 0}`;
  }

  /** QA-3.1-15: drops the per-session entries of a session that ended or whose plan detached. */
  function forgetSession(sessionID: string): void {
    providerBySession.delete(sessionID);
    stepState.delete(sessionID);
  }

  function isOrchestrator(sessionID: string): boolean {
    for (const p of plans.values()) if (p.writer.ledger.orchestrator.sessionID === sessionID) return true;
    return false;
  }

  /**
   * Phase 5.1 (a): the child's final text for the plan-task verifier's `observe`: the row-15 result text this process
   * holds, else (e.g. a task left `completed`/`verifying` across a restart) the child's last assistant text, read once
   * through the existing `hosts.context` read and bounded by FINAL_TEXT_READ_MS; undefined when neither has any.
   */
  async function finalTextOf(p: PlanRt, taskId: TaskId, att: Attempt): Promise<string | undefined> {
    const held = finalTexts.get(`${p.planId}/${taskId}#${att.n}`);
    if (held !== undefined) return held;
    if (att.childSessionID === null) return undefined;
    const timer: { h: { readonly id: number } | null } = { h: null };
    const text = await Promise.race([
      lastAssistantText(att.childSessionID),
      new Promise<string>((resolve) => { timer.h = d.clock.setTimer(FINAL_TEXT_READ_MS, () => resolve("")); }),
    ]);
    if (timer.h !== null) d.clock.clearTimer(timer.h);
    return text === "" ? undefined : text;
  }

  async function lastAssistantText(sessionID: string): Promise<string> {
    try {
      const ctx = await d.hosts.context(sessionID);
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (m !== undefined && m.role === "assistant" && m.text !== null) return m.text;
      }
    } catch (e) {
      d.log("warn", "child context read failed", errorText(e));
    }
    return "";
  }

  /** Terminal event of a child whose launch completion already settled (late adopt): synthesize its end. */
  function lateChildEnd(p: PlanRt, e: HostSessionEvent): void {
    if (e.type !== "execution.completed" && e.type !== "execution.failed" && e.type !== "execution.interrupted") return;
    // QA-4.2-15/-24: the interrupt the runtime sent ends its child through the step that sent it (`lost "restart"`,
    // slot reset), never as an `unrequested-interrupt`. Only that `execution.interrupted` is skipped: a real completion
    // or failure that raced the interrupt is processed as what it is (`onHostEvent` ended the probation watch for it).
    if (e.type === "execution.interrupted" && p.interrupting.has(e.sessionID)) return;
    for (const t of Object.values(p.writer.ledger.tasks)) {
      const a = t.attempts[t.attempts.length - 1];
      if (a === undefined || a.outcome !== null || a.childSessionID !== e.sessionID) continue;
      const h = p.handles.get(t.id);
      if (h === undefined || h.n !== a.n || !h.settled) continue;
      const taskId = t.id;
      const n = a.n;
      bg("late child end", async () => {
        let end: ChildEnd;
        if (e.type === "execution.completed") {
          end = { kind: "completed", childSessionID: e.sessionID, text: await lastAssistantText(e.sessionID), endedAt: e.at };
        } else if (e.type === "execution.failed") {
          end =
            executionFailureOutcome(e.error) === "capacity"
              ? { kind: "capacity", childSessionID: e.sessionID, error: e.error, endedAt: e.at }
              : { kind: "failed", childSessionID: e.sessionID, error: e.error, endedAt: e.at };
        } else {
          end = { kind: "lost", childSessionID: e.sessionID, reason: "unrequested-interrupt", endedAt: e.at };
        }
        await processEnd(p, taskId, n, end);
      });
    }
  }

  function onHostEvent(e: HostSessionEvent): void {
    try {
      const sid = e.sessionID;
      if (e.type === "step.started") {
        boundedSet(providerBySession, sid, e.providerID);
        const st = stepState.get(sid);
        if (st === undefined) boundedSet(stepState, sid, { k: 1, open: true });
        else if (!st.open) {
          st.k += 1;
          st.open = true;
        }
      }
      for (const p of plans.values()) {
        if (p.disposed || p.passive) continue;
        // R1a: any host event of a child on probation proves it alive, except the events of an interrupt the runtime sent
        // itself (QA-4.2-15).
        // QA-4.2-24: a real end (completed/failed) racing that interrupt ends the watch too, so the interrupting poll step
        // stands down (no slot reset over the child's work) and `lateChildEnd` processes the end.
        const realEnd = e.type === "execution.completed" || e.type === "execution.failed";
        if (p.probation.has(sid) && (!p.interrupting.has(sid) || realEnd)) provedAlive(p, sid);
        const isOrch = p.writer.ledger.orchestrator.sessionID === sid;
        if (isOrch) {
          if (e.type === "step.started") p.orchIdle = false;
          else if (e.type === "execution.completed" || e.type === "execution.failed" || e.type === "execution.interrupted") p.orchIdle = true;
          observe(p, "orchestrator", () => ({ event: e.type }));
          schedule(p);
        }
        const provider = providerBySession.get(sid) ?? "unknown";
        if (e.type === "retry" && e.source === "scheduled") {
          feedSignal(p, { source: "retry-scheduled", sessionID: sid, stepKey: e.stepKey, provider, error: e.error, at: e.at });
        } else if (e.type === "step.failed") {
          feedSignal(p, { source: "step-failed", sessionID: sid, stepKey: stepKeyOf(e), provider, error: e.error, at: e.at });
        } else if (e.type === "execution.failed") {
          feedSignal(p, { source: "execution-failed", sessionID: sid, stepKey: stepKeyOf(e), provider, error: e.error, at: e.at });
        }
        lateChildEnd(p, e);
      }
      // QA-3.1-27: a step that ended (successfully, `step.ended`) closes too, so the next `step.started` opens a new key.
      if (
        e.type === "step.ended" ||
        e.type === "step.failed" ||
        e.type === "execution.failed" ||
        e.type === "execution.completed" ||
        e.type === "execution.interrupted"
      ) {
        const st = stepState.get(sid);
        if (st !== undefined) st.open = false;
      }
      // QA-3.1-15: a session that is not an orchestrator ends with its execution; its signals were fed above.
      if (e.type === "execution.failed" || e.type === "execution.completed" || e.type === "execution.interrupted") {
        if (!isOrchestrator(sid)) forgetSession(sid);
      }
    } catch (err) {
      d.log("error", "host event handling failed", errorText(err));
    }
  }

  function onRetryHook(i: { sessionID: string; stepKey: string; error: HostError }): { stop: boolean } {
    try {
      const provider = providerBySession.get(i.sessionID) ?? "unknown";
      let stop = false;
      for (const p of plans.values()) {
        if (p.disposed || p.passive) continue;
        feedSignal(p, { source: "retry-hook", sessionID: i.sessionID, stepKey: i.stepKey, provider, error: i.error, at: d.clock.iso() });
        if (ownsChild(p, i.sessionID) && p.capacity.shouldStopRetry({ sessionID: i.sessionID, stepKey: i.stepKey, provider, planChild: true })) {
          p.capacityStopped.add(i.sessionID);
          stop = true;
        }
      }
      return { stop };
    } catch (err) {
      d.log("error", "retry hook failed", errorText(err));
      return { stop: false };
    }
  }

  function isPlanChild(sessionID: string): boolean {
    return d.launcher.inFlight().some((f) => f.childSessionID === sessionID);
  }

  // ---------- rendering

  /** The status board of `l`; `p` is its attachment in this process, or null when the board is read from the store. */
  function renderBoard(l: Readonly<LedgerV1>, p: PlanRt | null): string {
    const by = new Map<TaskState, number>();
    for (const t of Object.values(l.tasks)) by.set(t.state, (by.get(t.state) ?? 0) + 1);
    const out: string[] = [`Plan ${l.planId} [${l.status}] ${l.planPath}`];
    // QA-3.1-19: a passively attached (refused) plan says why nothing launches. QA-4.2-21: a plan of another toplevel says
    // so on a board read from the store too (its attachment still in progress, or none), not only once it is attached.
    const foreign = (p === null || p.passive) && (foreignPlans.has(l.planId) || isForeign(l.repo.toplevel));
    if (foreign) {
      // QA-4.2-17: a plan of another toplevel is attached passively, never run by this process.
      out.push(`Foreign: this plan belongs to ${l.repo.toplevel}; read-only here; mutate it from a session in that repository`);
    } else if (p !== null && p.passive) {
      out.push("Refused: another plan holds this process's active slot; only abort, answer, status, pause, resume and purge apply");
    }
    out.push(`Tasks: ${[...by.entries()].map(([s, c]) => `${s} ${c}`).join(", ") || "none"}`);
    for (const ph of l.phases) out.push(`Phase ${ph.id}: gate ${ph.gate}${ph.paused ? " PAUSED" : ""} - ${ph.title}`);
    // A RouteResolver error never breaks the board (QA-3.1-11): that task is listed as unroutable instead.
    const unroutable = new Map<TaskId, string>();
    const launchable = p === null ? [] : readyOf(p, l, unroutable).map((r) => r.taskId);
    out.push("Ready:");
    for (const [id, msg] of unroutable) out.push(`  ${id} unroutable - ${msg}`);
    for (const id of launchable) out.push(`  ${id}`);
    for (const t of Object.values(l.tasks)) {
      if (t.state === "ready" && (t.kind === "manual" || t.kind === "preflight")) {
        out.push(`  ${t.id} manual (${t.kind}) - waiting for router_plan action=done`);
      }
    }
    for (const t of Object.values(l.tasks)) {
      if (t.state === "dispatched" || t.state === "running") out.push(`Running: ${t.id} attempt ${t.attempts.length}`);
    }
    const open = l.inbox.filter((i) => i.answer === null);
    if (open.length > 0) {
      out.push("Inbox:");
      for (const i of open) out.push(`  ${i.id} ${i.kind}/${i.severity}${i.taskId === null ? "" : ` ${i.taskId}`}: ${i.text}`);
    }
    if (p !== null) {
      out.push(`Metrics: launches ${p.counters.launches}, wakes ${p.counters.wakes}, idle-with-ready ${p.counters.idleMs} ms`);
    }
    return out.join("\n");
  }

  // ---------- public surface

  function pickDraft(x: Readonly<LedgerV1>): Pick<LedgerV1, "planDigest" | "sharedContext" | "waves" | "phases" | "tasks" | "edges"> {
    return { planDigest: x.planDigest, sharedContext: x.sharedContext, waves: x.waves, phases: x.phases, tasks: x.tasks, edges: x.edges };
  }

  async function setStatus(p: PlanRt, from: LedgerStatus, to: LedgerStatus, reason: string): Promise<void> {
    const ok = await appendIf(p, (cur) => (cur.status === from ? [{ type: "status-changed", from, to, reason }] : []));
    if (!ok) throw new ExecutorError("E_PLAN_STATE", `plan ${p.planId} is ${p.writer.ledger.status}`, p.writer.ledger.status);
  }

  const handle: ExecutorRuntimeHandle = {
    async compile(i) {
      const r = await d.compiler.compile(i.path, {
        ...(i.phases === undefined ? {} : { phases: i.phases }),
        ...(i.doneBefore === undefined ? {} : { doneBefore: i.doneBefore }),
        config: d.config(),
        orchestratorSessionID: i.sessionID,
        now: d.clock.iso(),
      });
      if (isForeign(r.draft.repo.toplevel)) throw new ExecutorError("E_INVALID_INPUT", "the plan belongs to another repository");
      const writer = await d.store.create(r.draft, d.holder(i.sessionID));
      await attach(writer, false);
      return { planId: r.draft.planId, summary: r.summary, residuePrompt: r.residueRequest?.prompt ?? null };
    },

    async residue(planId, text, sessionID) {
      const p = await mine(planId, sessionID);
      requireStatus(p, ["awaiting-residue"]);
      const merged = d.compiler.mergeResidue(p.writer.ledger, text);
      await p.writer.append([
        { type: "draft-replaced", draft: pickDraft(merged.draft) },
        { type: "status-changed", from: "awaiting-residue", to: "awaiting-approval", reason: "residue-merged" },
      ]);
      return merged.summary;
    },

    async approve(planId, sessionID) {
      const p = await mine(planId, sessionID);
      requireStatus(p, ["awaiting-approval"]);
      // Single plan per process (memo M20, amendment A-3.1-1): never a second running or paused plan. The check and the
      // reservation are one synchronous step before the first await (QA-3.1-18): two concurrent approves never both pass.
      const other = reserve(planId);
      if (other !== null) await refuseSecondPlan(p.writer, other);
      try {
        const l = p.writer.ledger;
        const config: ExecutorConfig = { ...l.config, slotsDir: l.config.slotsDir ?? defaultSlotsDir(l.repo.toplevel, planId) };
        await d.checkSlotsDir?.(config.slotsDir ?? defaultSlotsDir(l.repo.toplevel, planId), l.repo.toplevel, planId);
        await p.writer.append([
          { type: "plan-approved", config, by: sessionID },
          { type: "status-changed", from: "awaiting-approval", to: "running", reason: "approved" },
        ]);
        // The capacity view is built per tick from `p.capacity` (QA-3.1-11), so replacing the controller is enough.
        p.capacity = makeCapacity(p, p.writer, planId, null);
        // §9: `queue.resume()` once, after the approval batch and before the first tick (activate's fresh path).
        await activate(p, false);
      } finally {
        unreserve(planId);
      }
    },

    async status(planId, sessionID) {
      if (planId !== null) {
        const p = plans.get(planId) ?? null;
        return renderBoard(p === null ? await d.store.read(planId) : p.writer.ledger, p);
      }
      for (const p of plans.values()) if (p.writer.ledger.orchestrator.sessionID === sessionID) return renderBoard(p.writer.ledger, p);
      const found = (await d.store.list()).find((e) => e.orchestratorSessionID === sessionID);
      if (found === undefined) throw new ExecutorError("E_LEDGER_NOT_FOUND", "no plan for this session", sessionID);
      return renderBoard(await d.store.read(found.planId), plans.get(found.planId) ?? null);
    },

    async ready(planId) {
      const p = plans.get(planId) ?? null;
      const l = p === null ? await d.store.read(planId) : p.writer.ledger;
      const launchable = p === null ? [] : readyOf(p, l, null).map((r) => r.taskId);
      return { launchable, manual: d.scheduler.manualReady(l) };
    },

    async addTasks(planId, text, sessionID) {
      const p = await mine(planId, sessionID);
      requireStatus(p, ["running", "paused"]);
      activeOnly(p);
      const added = d.compiler.addTasks(p.writer.ledger, text);
      // A ready task cannot park. Refuse the whole fragment if any reopened slot has unsaved work, before journaling
      // its tasks, edges or transitions; the orchestrator can retry after the task's blocking item is answered.
      const presaved = new Map<TaskId, { slot: string; saved: SaveResult }>();
      // Even diagnostic metrics wait until the fragment is accepted: a refusal journals nothing of the fragment, only the
      // unsaved-work item it points at (QA-PDF21-13).
      const deferredMetrics: MetricPayload[] = [];
      for (const id of added.reopened) {
        // QA-PDF21-13: the state check and the save run under the task's mutex, so neither lands between a launch step's
        // restore and its attempt-started batch (the save's reset would wipe the restored work under the new child).
        const pre = await withTask(p, id, async () => {
          const c = own(p.writer.ledger, id);
          if (c === null || c.state !== "ready" || c.slot === null) return null;
          return { slot: c.slot, saved: await snapshotTaskSlot(p, id, c.slot, "reopened", deferredMetrics) };
        });
        if (pre === null) continue;
        if (pre.saved === "failed") {
          // QA-PDF21-13: the item the refusal points at is raised first (the fragment itself journals nothing).
          const inboxId = await wipHold(p, id, pre.slot, "its release (reopened)");
          throw new ExecutorError("E_PLAN_STATE", `task ${id} holds unsaved work in slot ${pre.slot}; answer its item first`, { taskId: id, slot: pre.slot, inboxId });
        }
        presaved.set(id, pre);
      }
      const slots = new Map<TaskId, string>();
      await p.writer.append((cur) => {
        slots.clear();
        const ev: ExecutorEventInput[] = [];
        for (const t of added.tasks) ev.push({ type: "task-created", task: t });
        for (const e of added.edges) ev.push({ type: "edge-added", edge: e });
        for (const id of added.reopened) {
          const c = own(cur, id);
          if (c === null || c.state !== "ready") continue;
          if (c.slot !== null) {
            const pre = presaved.get(id);
            if (pre === undefined || pre.slot !== c.slot || pre.saved === "failed") {
              throw new ExecutorError("E_PLAN_STATE", `task ${id} holds unsaved work in slot ${c.slot}; answer its item first`);
            }
            slots.set(id, c.slot);
            ev.push(ts(id, null, null));
          }
          ev.push(tt(id, "ready", "pending", "dep-added"));
        }
        return ev;
      });
      for (const m of deferredMetrics) metric(p, m);
      for (const [id, slot] of slots) {
        const pre = presaved.get(id);
        // QA-PDF21-13: under the task's mutex too: a launch step already past its checks finishes (its batch is refused,
        // the task is pending now) before the slot goes back.
        await withTask(p, id, () => releaseResources(p, id, slot, "reopened", pre !== undefined && pre.slot === slot ? pre.saved : null));
      }
      schedule(p);
      return { added: added.tasks.map((t) => t.id), reopened: [...added.reopened] };
    },

    async answer(planId, inboxId, text, sessionID) {
      const p = await mine(planId, sessionID);
      const paused = new Set(p.writer.ledger.phases.filter((ph) => ph.paused).map((ph) => ph.id));
      // QA-PDF21-7: `discard-wip` on a restore-conflict park drops the task's WIP ref before the answer readies the task, so
      // its next attempt starts clean (no launch can restore the ref in between).
      const item = p.writer.ledger.inbox.find((x) => x.id === inboxId);
      if (item !== undefined && item.answer === null && item.taskId !== null && item.options.includes("discard-wip")
        && text.trim().toLowerCase() === "discard-wip") {
        const taskId = item.taskId;
        await withTask(p, taskId, async () => {
          wipRestored.delete(`${p.planId}/${taskId}`);
          await dropWip(p, taskId);
        });
        counter(p, "wip-discarded", { taskId });
      }
      // QA-PDF21-15: the answer to a failed save's item saves the slot again (a success ends its hold); a save that fails
      // again raises a fresh item once this one is answered, so a held slot always has an open item.
      const heldSlot = item !== undefined && item.answer === null ? wipHoldSlotOf(item.text) : null;
      const retried: SaveResult | null = heldSlot === null || !wipFailRaised.has(`${p.planId}/${heldSlot}`) ? null : await retryHeldSave(p, heldSlot, "answer");
      await p.collab.policy.answer(inboxId, text);
      if (heldSlot !== null && retried === "failed") {
        wipFailRaised.delete(`${p.planId}/${heldSlot}`);
        await wipHold(p, item?.taskId ?? null, heldSlot, "the answer to its item");
      }
      const ledger = p.writer.ledger;
      const unpaused = new Set(ledger.phases.filter((ph) => paused.has(ph.id) && !ph.paused).map((ph) => ph.id));
      if (unpaused.size > 0 && !p.passive && !p.latch && ledger.status === "running") {
        // checkPhase can return before kicking when a phase still has verified work. enqueue dedupes its FIFO
        // but always kicks the lanes, including when the resumed phase has only pending integration entries.
        // QA-5.1-9: the answer is journaled already; a queue that refuses the kick (E_PLAN_STATE, E_DISPOSED) never
        // fails the answer nor skips the schedule below.
        try {
          p.collab.queue.enqueue(Object.values(ledger.tasks)
            .filter((t) => t.state === "verified" && t.phase !== null && unpaused.has(t.phase) && !p.leaseHeld.has(t.id))
            .map((t) => t.id));
        } catch (e) {
          d.log("warn", `integration kick after the answer to ${inboxId} failed`, errorText(e));
        }
      }
      schedule(p);
    },

    async done(planId, taskId, sessionID) {
      const p = await mine(planId, sessionID);
      activeOnly(p);
      const ok = await appendIf(p, (cur) => {
        const t = own(cur, taskId);
        if (t === null || t.state !== "ready" || (t.kind !== "manual" && t.kind !== "preflight")) return [];
        return [tt(taskId, "ready", "done", "reported-done")];
      });
      if (!ok) throw new ExecutorError("E_INVALID_INPUT", `${taskId} is not a ready manual or preflight task`, taskId);
      await checkTaskPhase(p, taskId);
      schedule(p);
    },

    async pause(planId, sessionID) {
      const p = await mine(planId, sessionID);
      await setStatus(p, "running", "paused", "user-pause");
    },

    async resume(planId, sessionID) {
      const p = await mine(planId, sessionID);
      // QA-3.1-19: a passively attached (refused) plan is promoted by a resume once the active slot is free.
      const promote = p.passive;
      if (promote && foreignPlans.has(planId)) {
        // QA-4.2-17: a plan of another toplevel is never recovered or run by this process.
        throw new ExecutorError(
          "E_PLAN_STATE",
          `plan ${planId} belongs to another repository (${p.writer.ledger.repo.toplevel}); resume it from a session in that repository`,
          { planId },
        );
      }
      if (promote) {
        const other = reserve(planId);
        if (other !== null) await refuseSecondPlan(p.writer, other);
      }
      // QA-4.2-6: a running plan whose integration resume failed (or halted) is resumed again by the user's `resume`.
      const retryOnly = !promote && p.writer.ledger.status === "running" && !p.integrationResumed;
      try {
        if (!retryOnly) await setStatus(p, "paused", "running", "user-resume");
        if (promote) {
          p.passive = false;
          observe(p, "promote");
          await activate(p, true);
        } else if (!p.integrationResumed) {
          // §9: a halted (or failed) integration resume is retried by the user's resume.
          await resumeIntegration(p);
        }
      } finally {
        if (promote) unreserve(planId);
      }
      // A resume is the user's answer to the streak pauses: they start over (QA-3.1-4, QA-3.1-6, QA-3.1-22).
      p.preConfirmLosses = 0;
      p.preConfirmCapture = null;
      p.skipStreak = 0;
      p.provisionFails = 0;
      p.provisionRaised = false;
      p.routeFails = 0;
      p.routeRaised = false;
      // QA-3.1-26: a backoff armed before the pause would tick at the old (long) delay; the tick below replaces it.
      clearBackoff(p);
      for (const ph of p.writer.ledger.phases) {
        try {
          await p.collab.queue.checkPhase(ph.id);
        } catch (e) {
          d.log("warn", `checkPhase ${ph.id} failed`, errorText(e));
        }
      }
      // QA-4.2-16: a task held by a failed lease rebuild is enqueued once its leases are back, not here.
      const verified = Object.values(p.writer.ledger.tasks)
        .filter((t) => t.state === "verified" && !p.leaseHeld.has(t.id))
        .map((t) => t.id);
      if (verified.length > 0) p.collab.queue.enqueue(verified);
      schedule(p);
    },

    async abort(planId, sessionID) {
      const p = await mine(planId, sessionID);
      requireStatus(p, ["compiling", "awaiting-residue", "awaiting-approval", "running", "paused"]);
      const cleanup = abortReleases.get(p) ?? new Set<TaskId>();
      abortReleases.set(p, cleanup);
      // Covers the interval between the terminal ledger batch and registering live-child releases, and saves of
      // already-ended children too. No real task id contains NUL.
      cleanup.add("\0abort");
      try {
      // Whole-plan cancellation stops progression; unlike a done task, it must not reopen gates or launch QA.
      p.latch = true;
      observe(p, "abort");
      // Request the cut, but never wait for an external verifier before queue abort and durable cancellation. Slot
      // cleanup below waits in the background instead, so a verifier that ignores the cut cannot deadlock abort.
      p.attachment.abort();
      p.recoveredWork.clear();
      try {
        await p.collab.queue.abort();
      } catch (e) {
        d.log("error", "queue abort failed", errorText(e));
      }
      const cancelled = new Map<TaskId, string | null>();
      const at = d.clock.iso();
      await p.writer.append((cur) => {
        cancelled.clear();
        const ev: ExecutorEventInput[] = [];
        for (const t of Object.values(cur.tasks)) {
          if (t.state === "done" || t.state === "cancelled" || t.state === "integrated" || t.state === "integrating") continue;
          const a = t.attempts[t.attempts.length - 1];
          if ((t.state === "dispatched" || t.state === "running") && a !== undefined && a.outcome === null) {
            ev.push(ae(t.id, a.n, "interrupted", clampEnd(a, at), "abort"));
          }
          ev.push(tt(t.id, t.state, "cancelled", "abort"));
          if (t.slot !== null) ev.push(ts(t.id, null, null));
          cancelled.set(t.id, t.slot);
        }
        ev.push({ type: "status-changed", from: cur.status, to: "aborted", reason: "user-abort" });
        return ev;
      });
      closeIdle(p);
      unpinPlan(p);
      const attachmentWork = [...p.attachmentWork];
      const attachmentsSettled = Promise.allSettled(attachmentWork);
      // QA-4.2-23: the abort closed every attempt, the adopted children's bindings go with them.
      for (const id of [...p.rebound.keys()]) evictRebound(p, id, null);
      const live = new Set<TaskId>();
      for (const f of d.launcher.inFlight()) {
        const h = p.handles.get(f.taskId);
        if (!cancelled.has(f.taskId) || h === undefined || h.n !== f.attempt) continue;
        live.add(f.taskId);
        const slotName = cancelled.get(f.taskId) ?? null;
        // QA-PDF21-15: the plan is not idle until this release ends (`idle`): a collection between the launch's settling and
        // the slot's save would remove the worktree with work whose save then fails, before its hold names the slot.
        const releasing = abortReleases.get(p) ?? new Set<TaskId>();
        abortReleases.set(p, releasing);
        releasing.add(f.taskId);
        bg("abort cancel", async () => {
          try {
            await d.launcher.cancel(f.taskId, f.attempt, "abort");
            await h.completion;
            await attachmentsSettled;
            await releaseResources(p, f.taskId, slotName);
            releaseToken(p, f.taskId, f.attempt, "other");
          } finally {
            releasing.delete(f.taskId);
            // The finished plan's collection runs now (a held slot is retried there and refuses it), not at the next backoff.
            bg("finished slot collection", () => collectFinished(p));
          }
        });
      }
      for (const [id, slotName] of cancelled) {
        if (live.has(id)) continue;
        if (slotName !== null && attachmentWork.length > 0) {
          // Keep the unsaved slot leased while its pipeline settles. The abort-cleanup marker keeps purge/gc out
          // until this save/release (or durable WIP hold) finishes, without making abort wait for a verdict.
          cleanup.add(id);
          bg("abort release", async () => {
            try {
              await attachmentsSettled;
              await releaseResources(p, id, slotName);
            } finally {
              cleanup.delete(id);
              bg("finished slot collection", () => collectFinished(p));
            }
          });
        } else if (slotName !== null) await releaseResources(p, id, slotName);
        else p.leases.releaseTask(id);
      }
      await forgetClosed(p);
      cleanup.delete("\0abort");
      await collectFinished(p);
      } finally {
        cleanup.delete("\0abort");
      }
    },

    async land(planId, sessionID) {
      const p = await mine(planId, sessionID);
      activeOnly(p);
      await p.collab.queue.land();
    },

    async adopt(planId, sessionID) {
      const recovery = d.recovery;
      if (recovery === null) throw new ExecutorError("E_PLAN_STATE", "recovery is not available", planId);
      // QA-3.1-19 / QA-4.2-25: every cheap refusal (state, foreign repository, single-plan rule, with the slot reserved,
      // QA-3.1-18) comes BEFORE the old attachment is closed and `recovery.adopt` rewrites the plan: a refused adopt
      // leaves the plan (and its attachment) untouched. An unreadable ledger is left to recovery (and to attach).
      const old = plans.get(planId);
      let seen: Readonly<LedgerV1> | null = old === undefined ? null : old.writer.ledger;
      if (seen === null) {
        try {
          seen = await d.store.read(planId);
        } catch (e) {
          d.log("warn", `adopt: ledger of ${planId} not readable before recovery`, errorText(e));
        }
      }
      const st: LedgerStatus | null = seen === null ? null : seen.status;
      // QA-4.2-7 (amendment A-4.2-1): a plan awaiting residue or approval is never adopted.
      if (st === "awaiting-residue" || st === "awaiting-approval") {
        throw new ExecutorError(
          "E_PLAN_STATE",
          `plan ${planId} is ${st}: a plan awaiting approval is never adopted; the user approves it in its own session or compiles it again`,
          st,
        );
      }
      // QA-4.2-21: a plan of another repository is never adopted here; its passive attachment stays as it is.
      if (seen !== null && isForeign(seen.repo.toplevel)) {
        throw new ExecutorError(
          "E_PLAN_STATE",
          `plan ${planId} belongs to another repository (${seen.repo.toplevel}); adopt it from a session in that repository`,
          { planId, toplevel: seen.repo.toplevel },
        );
      }
      const reserved = st === "running" || st === "paused";
      if (reserved) {
        const other = reserve(planId);
        if (other !== null) throw new ExecutorError("E_PLAN_STATE", refusalText(planId, other), { planId, active: other });
      }
      // QA-4.2-4: from the close of the old attachment until the new one is attached, child ends, creations and
      // confirmations wait on this gate instead of reaching the closed writer.
      // `dispose` opens it too (`reattachOpeners`), so a stuck adopt never keeps a waiter (or `dispose`) waiting.
      let gated = false;
      const openGate = (): void => {
        if (!gated) return;
        gated = false;
        openReattach(planId);
      };
      const oldOrchestrator = old === undefined ? null : old.writer.ledger.orchestrator.sessionID;
      try {
        if (old !== undefined) {
          if (!reattaching.has(planId)) {
            const gate: { open: () => void } = { open: () => undefined };
            reattaching.set(planId, new Promise<void>((resolve) => (gate.open = resolve)));
            reattachOpeners.set(planId, gate.open);
            closing.set(planId, old);
            gated = true;
          }
          // D12: launches this process tracks stay untouched; the new attachment takes their handles over (only the ones
          // still unsettled when it is built, see `build`).
          const carried = [...old.handles].filter(([, h]) => !h.settled);
          if (carried.length > 0) carriedHandles.set(planId, carried);
          await closePlan(old);
        }
        try {
          await recovery.adopt(planId, sessionID);
          // Re-check before opening too: an injected/failed recovery or an external snapshot replacement may change it.
          const adopted = await d.store.read(planId);
          if (isForeign(adopted.repo.toplevel)) {
            throw new ExecutorError("E_PLAN_STATE", `plan ${planId} belongs to another repository; its attachment is read-only`, { planId });
          }
          // L3: the reopened local ledger is reconciled on activation.
          recoverable.add(planId);
          let writer: LedgerWriter;
          try {
            writer = await d.store.open(planId, d.holder(sessionID));
          } catch (e) {
            if (errorCode(e) !== "E_LOCK_HELD") throw e;
            writer = await d.store.takeover(planId, d.holder(sessionID), "adopt");
          }
          // The gate opens once the new attachment is registered (before its recovery runs: recovery takes task mutexes).
          await attach(writer, true, openGate);
        } catch (e) {
          // QA-4.2-25: the old attachment is closed and the adopt failed: the plan is attached again under its own
          // orchestrator, so it is not stranded and the ends waiting on the gate are processed.
          if (oldOrchestrator !== null && !plans.has(planId)) await reattachAfterFailedAdopt(planId, oldOrchestrator, openGate);
          throw e;
        }
      } finally {
        openGate();
        if (reserved) unreserve(planId);
      }
    },

    async gc() {
      // A restarted runtime has not attached terminal plans. Open them before entering the pool's gc so failures
      // propagate as E_PLAN_STATE (and no pool mutex is held while a save consults its markers).
      for (const entry of await d.store.list()) {
        if (entry.status !== "completed" && entry.status !== "aborted") continue;
        if (plans.has(entry.planId)) continue;
        const ledger = await d.store.read(entry.planId);
        if (isForeign(ledger.repo.toplevel)) continue;
        await attach(await d.store.open(entry.planId, d.holder(ledger.orchestrator.sessionID)));
      }
      // QA-PDF21-15: a finished plan's slot whose work could not be saved is saved again first; a save that fails again
      // refuses the gc (its worktree would be deleted with the work).
      for (const known of [...plans.values()]) {
        const st = known.writer.ledger.status;
        if ((st === "completed" || st === "aborted") && !known.disposed && idle(known)) await refuseUnsaved(known, "gc");
      }
      // A plan's answer may be asked more than once in one gc (the pool, then its facade): reported once.
      const tagPending = new Set<PlanId>();
      const report = await d.slots.gc(async (planId) => {
        const known = plans.get(planId);
        // QA-5.1-7 (EXECUTOR.md): a manual gc collects a finished plan once nothing writes its slots (no live child, no task
        // in flight, no open integration entry). QA-5.1-19: a completed plan also waits for its phase tags: between tag
        // retries the integration entry is rolled back (it reads as idle) while the retry still tags in the integration
        // worktree. An aborted plan tags nothing (planTagsSettled).
        if (known !== undefined) {
          const st = known.writer.ledger.status;
          if (st !== "completed" && st !== "aborted") return false;
          // The pool may retain/recheck this predicate after preflight. A later failed save or a reconstructed hold
          // must not turn into permission to delete merely because the plan has since reached a terminal status.
          if (!idle(known) || heldSlotsOf(known).length > 0) return false;
          if (!planTagsSettled(known.writer.ledger)) {
            tagPending.add(planId);
            return false;
          }
          return true;
        }
        try {
          await d.store.read(planId);
          // A plan not included in the preflight must wait for the next gc, never bypass its unsaved-work check.
          return false;
        } catch (e) {
          if (errorCode(e) === "E_LEDGER_NOT_FOUND") return null;
          throw e;
        }
      });
      if (tagPending.size === 0) return report;
      // QA-5.1-19: the refusal is reported, not silent: the user retries once the queue settled the tag.
      return { ...report, reported: [...report.reported, ...[...tagPending].map((id) => `plan ${id}: ${GC_TAG_PENDING}`)] };
    },

    async exportPlan(planId) {
      const x = await d.store.exportPlan(planId);
      return JSON.stringify({ snapshot: x.snapshot, events: x.events }, null, 2);
    },

    async purge(planId, sessionID) {
      const p = await mine(planId, sessionID);
      requireStatus(p, ["completed", "aborted"]);
      // Abort publishes its terminal status before its children and their saves settle. Never close the writer or
      // remove refs/worktrees underneath that cleanup. The runtime clock also bounds a stuck child/save.
      const deadline = d.clock.now() + 30_000;
      while ((!idle(p) || collecting.has(planId)) && d.clock.now() < deadline) {
        await new Promise<void>((resolve) => { d.clock.setTimer(Math.min(50, deadline - d.clock.now()), resolve); });
      }
      if (!idle(p) || collecting.has(planId)) throw new ExecutorError("E_PLAN_STATE", `plan ${planId}: cleanup is still pending; purge refused`, { planId });
      requireStatus(p, ["completed", "aborted"]);
      // QA-PDF21-15: a slot whose work could not be saved is saved again first; a save that fails again refuses the purge
      // before anything is removed (its worktree would go with the work).
      await refuseUnsaved(p, "purge");
      const toplevel = p.writer.ledger.repo.toplevel;
      await closePlan(p);
      // QA-5.1-11: the full gc runs before the ledger is removed; a pool that collection already closed still answers it
      // through a gc-only handle (create.ts PlanSlotPools), so a slot a partial gc could not remove is retried here.
      const purged = async (id: PlanId): Promise<boolean | null> => (id === planId ? true : null);
      // QA-5.1-22: an invalid slotsDir with slot markers refuses here, before any ref or the ledger is removed.
      const report = d.purgeSlots !== undefined ? await d.purgeSlots(planId, purged) : await slotsFor(planId).gc(purged);
      if (report.reported.some((note) => /uncommitted changes|unsaved work/.test(note))) {
        throw new ExecutorError("E_PLAN_STATE", `plan ${planId}: pool refused unsaved work; purge refused`, { planId, reported: report.reported });
      }
      for (const ns of ["heads", "tags"]) {
        const prefix = `refs/${ns}/omr/${planId}/`;
        const r = await d.git.run(["for-each-ref", "--format=%(refname)", prefix], { cwd: toplevel, timeoutMs: GIT_TIMEOUT_MS });
        if (r.code !== 0) continue;
        for (const ref of r.stdout.split(/\r?\n/).filter((s) => s.startsWith(prefix))) {
          await d.git.run(["update-ref", "-d", ref], { cwd: toplevel, timeoutMs: GIT_TIMEOUT_MS });
        }
      }
      await d.store.remove(planId);
    },

    onRouterToolCall(sessionID) {
      try {
        for (const p of plans.values()) if (p.writer.ledger.orchestrator.sessionID === sessionID) schedule(p);
      } catch (e) {
        d.log("error", "router tool call feed failed", errorText(e));
      }
    },

    onHostEvent,
    onRetryHook,

    async onChildEnd(taskId, attempt, end) {
      // The closed attachment of a plan under a same-process adopt still names its tasks (`closing`).
      let target: PlanRt | null = null;
      for (const p of [...plans.values(), ...closing.values()]) {
        const t = own(p.writer.ledger, taskId);
        if (t === null) continue;
        if (openAttempt(t, attempt) !== null) {
          target = p;
          break;
        }
        target ??= p;
      }
      // QA-4.2-4/-29: only an end of the plan under re-attach waits, and only for that plan's new attachment.
      if (target !== null) await processEnd(await live(target), taskId, attempt, end);
    },

    planLine(sessionID) {
      for (const p of plans.values()) {
        const l = p.writer.ledger;
        if (l.orchestrator.sessionID !== sessionID || (l.status !== "running" && l.status !== "paused")) continue;
        const ts2 = Object.values(l.tasks);
        const done = ts2.filter((t) => t.state === "done" || t.state === "integrated").length;
        const running = ts2.filter((t) => t.state === "dispatched" || t.state === "running").length;
        const ready = ts2.filter((t) => t.state === "ready").length;
        let line = `plan ${l.planId}: ${done}/${ts2.length} done, ${running} running, ${ready} ready${l.status === "paused" ? ", paused" : ""}`;
        const g = d.launcher.gate(sessionID);
        if (!g.ok && g.reason !== "disposed") line += ` (launch blocked: ${g.reason})`;
        return line;
      }
      return null;
    },

    async start() {
      // QA-3.1-1 (memo M46): the runtime feeds itself from the host's session events: provider of each step, capacity
      // signals, the orchestrator's idle flag and the end of a late-adopted child (L12) all come from here.
      if (offEvents === null && !disposed) offEvents = d.hosts.onEvent(onHostEvent);
      // QA-4.2-17/-21: a running or paused plan of another repository (its own toplevel, never its absence from the
      // recover() report) is attached passively.
      if (d.recovery !== null) {
        try {
          // L2: only the plans recover() reports (same toplevel, running or paused) may be taken over and reconciled.
          for (const r of await d.recovery.recover()) {
            recoverable.add(r.planId);
            // Nit: the engine's report carries full feeds; the plan's first recoverPlan reuses it (one reconcile, not two).
            const feeds: ReconcileFeed[] = [];
            for (const a of r.actions) if (isFeed(a)) feeds.push(a);
            if (d.recovery.reconcile !== undefined && feeds.length === r.actions.length) recoverReports.set(r.planId, feeds);
          }
        } catch (e) {
          d.log("error", "recovery failed", errorText(e));
        }
      }
      // QA-3.1-19: deterministic single-plan pick: a running plan before a paused one, then by plan id; the others attach
      // passively (refused, woken once) instead of not at all.
      const rank = (s: LedgerStatus): number => (s === "running" ? 0 : 1);
      const entries = (await d.store.list())
        .filter((e) => e.status === "running" || e.status === "paused")
        .sort((a, b) => rank(a.status) - rank(b.status) || (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0));
      for (const e of entries) {
        if (plans.has(e.planId)) continue;
        try {
          const ledger = await d.store.read(e.planId);
          if (isForeign(ledger.repo.toplevel)) {
            await attach(readOnlyWriter(ledger), true, undefined, { foreign: true });
            continue;
          }
          const holder = d.holder(e.orchestratorSessionID);
          let writer: LedgerWriter;
          try {
            writer = await d.store.open(e.planId, holder);
          } catch (err) {
            // L2: `open` never takes over; a stale holder of an eligible plan is (the store refuses a live one with
            // E_LOCK_HELD: skipped and logged below, nothing interrupted). Plans of another toplevel are never taken over.
            if (errorCode(err) !== "E_LOCK_HELD" || !recoverable.has(e.planId)) throw err;
            writer = await d.store.takeover(e.planId, holder, RECOVER_TAKEOVER_REASON);
          }
          // A same-repo plan the report missed still attaches actively and recoverPlan reconciles it.
          await attach(writer, true);
        } catch (err) {
          d.log("warn", `plan ${e.planId} not attached`, errorText(err));
        }
      }
      // A report no activation consumed (a refused or failed attach) is stale for any later activation.
      recoverReports.clear();
    },

    async dispose() {
      disposed = true;
      // QA-5.1-4: the verifier is cut FIRST (gate deadlines, grader sessions, backoff sleeps), so no pending verify keeps the
      // wait for running work below (and the process claim) for the length of a gate. Its synchronous part runs now; it is
      // awaited after the plans are detached. A cut verdict is never journaled (`verifyAttempt`); QA-5.1-21: a real verdict
      // that settles now is, before `closePlan` below.
      let verifierCut: Promise<void> = Promise.resolve();
      if (d.verifier.dispose !== undefined) {
        try {
          verifierCut = d.verifier.dispose().catch((e: unknown) => { d.log("warn", "verifier dispose failed", errorText(e)); });
        } catch (e) {
          d.log("warn", "verifier dispose failed", errorText(e));
        }
      }
      for (const timer of collectionTimers.values()) d.clock.clearTimer(timer);
      collectionTimers.clear();
      collectionDelays.clear();
      finalTexts.clear();
      // QA-4.2-4: no waiter of a same-process adopt's window outlives the runtime (dispose waits for their work below).
      for (const planId of [...reattachOpeners.keys()]) openReattach(planId);
      const off = offEvents;
      offEvents = null;
      if (off !== null) {
        try {
          off();
        } catch (e) {
          d.log("warn", "host event unsubscribe failed", errorText(e));
        }
      }
      for (const p of plans.values()) {
        // QA-3.1-25: L17 for every live launch the launcher is about to abort, counted while the plan is still live.
        if (!p.disposed) for (const h of p.handles.values()) if (!h.settled) counter(p, "launch-failed", { row: "L17" });
        p.disposed = true;
        p.attachment.abort();
        p.recoveredWork.clear();
        observe(p, "dispose");
        for (const h of p.timers) d.clock.clearTimer(h);
        p.timers.clear();
        p.backoff = null;
        // R1a: the probation poll timer was one of `p.timers`; no poll re-arms after dispose.
        p.probationTimer = null;
      }
      await verifierCut;
      // Detach every plan from host feeds synchronously, before any optional verifier hook can yield.
      if (d.verifier.forget !== undefined) {
        for (const p of plans.values()) {
          for (const task of Object.values(p.writer.ledger.tasks)) {
            for (const attempt of task.attempts) await forgetAttempt(p, task.id, attempt.n);
          }
        }
      }
      // A live child's completion settles only when the child ends, so dispose never waits for it: the launcher aborts every
      // owned child first (journals nothing; recovery closes those attempts as lost), then only the work already running is
      // awaited (ticks, appends, the processing of ends that came), never a child wait.
      try {
        await d.launcher.dispose();
      } catch (e) {
        d.log("warn", "launcher dispose failed", errorText(e));
      }
      for (;;) {
        const work = [...pending].filter((pr) => !childWaits.has(pr));
        if (work.length === 0) break;
        await Promise.allSettled(work);
      }
      for (const p of [...plans.values()]) {
        try {
          await closePlan(p);
        } catch (e) {
          d.log("warn", "plan close failed", errorText(e));
        }
      }
    },

    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    manualReady(sessionID) {
      const out: Array<{ taskId: TaskId; kind: string }> = [];
      for (const p of plans.values()) {
        const l = p.writer.ledger;
        if (l.orchestrator.sessionID !== sessionID) continue;
        for (const id of d.scheduler.manualReady(l)) {
          const t = own(l, id);
          if (t !== null) out.push({ taskId: id, kind: t.kind });
        }
      }
      return out;
    },

    isPlanChild,

    recordMetric(planId, m) {
      const p = plans.get(planId);
      if (p !== undefined) metric(p, m);
    },

    onLeaseReleased() {
      try {
        for (const p of plans.values()) {
          observe(p, "lease-released-notification");
          schedule(p);
        }
      } catch (e) {
        d.log("error", "lease release feed failed", errorText(e));
      }
    },
  };

  return handle;
}
