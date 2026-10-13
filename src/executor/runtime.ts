// ExecutorRuntime (plan task 3.1.6): per-plan tick, per-task pipeline, lifecycle rows, liveness, metrics.
import {
  capacityRestoreFromEvents,
  capacityView,
  type CapacityOptions,
  type CapacityProviderState,
} from "./capacity";
import { expandTask, loadExpansionEnv, type ExpandedTask } from "./expand";
import { taskBranchName } from "./git";
import { defaultSlotsDir } from "./slots/pool";
import {
  ABSOLUTE_PATH_PATTERN,
  ExecutorError,
  QA_UNPARSABLE_CONTEXT_PREFIX,
  canonicalFindingsJson,
  executionFailureOutcome,
  formatInboxId,
  hasAttemptsLeft,
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
  type ExecutorEventInput,
  type ExecutorRuntime,
  type FindingsReport,
  type Footprint,
  type GitRunner,
  type HostError,
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
  type RecoveryService,
  type RouteResolver,
  type ScheduledTask,
  type Scheduler,
  type SlotLease,
  type SlotPool,
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

type ChildTextClass =
  | { kind: "lease"; path: string | null }
  | { kind: "escalate" }
  | { kind: "ambiguity" }
  | { kind: "ordinary" };

/** Child text classification (first line, §6 of the memo). */
function classifyChildText(text: string): ChildTextClass {
  const line = firstLine(text);
  const lease = /^NEED MORE:\s*lease\s+(.+)$/i.exec(line);
  if (lease !== null && lease[1] !== undefined) return { kind: "lease", path: normalizeLeasePath(lease[1]) };
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

/**
 * M38: commit the slot's changes on the task branch. `{changed: false}` when the tree is clean.
 * Throws `E_IDENTITY` (no git identity) or `E_GIT`.
 */
export async function commitTaskInSlot(
  git: GitRunner,
  i: { slot: SlotLease; branch: string; message: string; timeoutMs: number },
): Promise<{ changed: false } | { changed: true; commit: string }> {
  const o = { cwd: i.slot.path, timeoutMs: i.timeoutMs };
  const step = async (args: readonly string[]): Promise<string> => {
    const r = await git.run(args, o);
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
  if (status.trim() === "") return { changed: false };
  await step(["switch", "-C", i.branch]);
  await step(["add", "-A"]);
  await step(["commit", "-m", i.message]);
  const head = (await step(["rev-parse", "HEAD"])).trim();
  return { changed: true, commit: head };
}

// ---- runtime

export interface PlanCollaborators {
  queue: IntegrationQueue;
  policy: UnattendedPolicy;
  qa: QaLoop;
}

export interface RuntimeDeps {
  store: LedgerStore;
  compiler: PlanCompiler;
  slots: SlotPool;
  scheduler: Scheduler;
  launcher: TaskLauncher;
  routes: RouteResolver;
  verifier: SlotVerifier;
  git: GitRunner;
  hosts: HostSessions;
  clock: Clock;
  leaseRegistry: LeaseRegistryPort;
  recovery: RecoveryService | null;
  holder(sessionID: string): LockHolder;
  capacity(o: CapacityOptions): CapacityController;
  collaborators(i: {
    writer: LedgerWriter;
    leases: LeaseService;
    waker: Waker;
    listener: IntegrationListener;
  }): PlanCollaborators;
  pinOrchestrator(sessionID: string): () => void;
  log(level: "info" | "warn" | "error", msg: string, detail?: JsonValue): void;
  /** Resolved executor configuration used by `compile` (the memo's RuntimeDeps left its source open). */
  config(): ExecutorConfig;
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
const LOST_STREAK = 3;
const STREAK_DETAILS: readonly string[] = ["unrequested-interrupt", "runner-error"];
/** Consecutive pre-confirmation losses (distinct router calls) that pause the plan (QA-3.1-4). */
const PRECONFIRM_STREAK = 3;
/** Consecutive provisioning failures that raise one inbox item (QA-3.1-6). */
const PROVISION_STREAK = 5;
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

interface PlanRt {
  readonly planId: PlanId;
  writer: LedgerWriter;
  leases: LeaseService;
  waker: RuntimeWaker;
  collab: PlanCollaborators;
  capacity: CapacityController;
  tokens: Map<string, TokenRef>;
  inFlight: Set<TaskId>;
  handles: Map<TaskId, HandleRef>;
  slotLeases: Map<TaskId, SlotLease>;
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
}

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
  const plans = new Map<PlanId, PlanRt>();
  const mutex = new KeyedMutex();
  const pending = new Set<Promise<unknown>>();
  const providerBySession = new Map<string, string>();
  /** Fallback step counter per session (QA-3.1-8: `e.stepKey` wins); bounded, and dropped when the session ends. */
  const stepState = new Map<string, { k: number; open: boolean }>();
  let disposed = false;
  /** Unsubscribes `onHostEvent` from `hosts.onEvent` (subscribed in `start`, QA-3.1-1). */
  let offEvents: (() => void) | null = null;

  // ---------- plumbing

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

  function bg(label: string, fn: () => Promise<void>): void {
    void track(
      fn().catch((e: unknown) => {
        d.log("error", `${label} failed`, errorText(e));
      }),
    );
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

  function counter(p: PlanRt, key: string, labels: Record<string, string> = {}): void {
    metric(p, { name: "counter", key, value: 1, labels });
  }

  async function appendIf(p: PlanRt, build: BatchBuilder): Promise<boolean> {
    let applied = false;
    await p.writer.append((l) => {
      const ev = build(l);
      applied = ev.length > 0;
      return ev;
    });
    return applied;
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
    } catch (e) {
      d.log("warn", "capacity release failed", errorText(e));
    }
  }

  /** Called by the module that wrote TS(null), after the fsync of that batch (A3). */
  async function releaseResources(p: PlanRt, taskId: TaskId, slotName: string | null): Promise<void> {
    releaseLeases(p, taskId);
    const s = slotName ?? p.slotLeases.get(taskId)?.slot ?? null;
    p.slotLeases.delete(taskId);
    if (s !== null) {
      try {
        await d.slots.release(s);
      } catch (e) {
        d.log("warn", "slot release failed", errorText(e));
      }
    }
  }

  /** Releases the task's leases; a throwing registry is logged so the slot release behind it still runs (QA-3.1-12). */
  function releaseLeases(p: PlanRt, taskId: TaskId): void {
    try {
      p.leases.releaseTask(taskId);
    } catch (e) {
      d.log("warn", "lease release failed", errorText(e));
    }
  }

  async function slotLeaseOf(p: PlanRt, t: TaskNode): Promise<SlotLease> {
    const cached = p.slotLeases.get(t.id);
    if (cached !== undefined) return cached;
    if (t.slot === null) throw new ExecutorError("E_PLAN_STATE", "task holds no slot", t.id);
    const rec = await d.slots.get(t.slot);
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

  /**
   * Capacity view built per tick over the current controller (QA-3.1-11). A task the RouteResolver throws on gets a
   * placeholder route without free capacity (never scheduled) and its error is recorded in `failed` (row 4b).
   */
  function viewOf(p: PlanRt, failed: Map<TaskId, string> | null): CapacityView {
    const base = capacityView(p.capacity, d.routes);
    return {
      routeOf(task: TaskNode): TaskRoute {
        try {
          return base.routeOf(task);
        } catch (e) {
          failed?.set(task.id, errorText(e));
          return { agent: task.route.role, model: { providerID: UNROUTABLE, modelID: UNROUTABLE, variant: null }, provider: UNROUTABLE, heavy: false };
        }
      },
      free(provider: string, heavy: boolean): number {
        return provider === UNROUTABLE ? 0 : base.free(provider, heavy);
      },
    };
  }

  function readyOf(p: PlanRt, l: Readonly<LedgerV1>, failed: Map<TaskId, string> | null): ScheduledTask[] {
    return d.scheduler.readySet(l, p.inFlight, p.leases, viewOf(p, failed));
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

  /** A launch went out: the skip backoff and the provisioning streak start over. */
  function launchSucceeded(p: PlanRt): void {
    p.skipStreak = 0;
    p.provisionFails = 0;
    p.provisionRaised = false;
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
      p.idle = { fromMs: d.clock.now(), fromAt: d.clock.iso(), ids: ready.map((r) => r.taskId), free };
    } else if (!hold && p.idle !== null) closeIdle(p);
  }

  function closeIdle(p: PlanRt): void {
    const o = p.idle;
    if (o === null) return;
    p.idle = null;
    const ms = Math.max(0, d.clock.now() - o.fromMs);
    p.counters.idleMs += ms;
    metric(p, { name: "idle-with-ready", fromAt: o.fromAt, toAt: d.clock.iso(), ms, readyTaskIds: o.ids, free: o.free });
  }

  // ---------- tick

  function schedule(p: PlanRt): void {
    if (p.disposed || disposed) return;
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
      }
    });
  }

  async function tickOnce(p: PlanRt): Promise<void> {
    if (p.latch || p.disposed) return;
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
      if (l.status === "completed" || l.status === "aborted") unpinPlan(p);
      // A plan-completed wake that was debounced or failed is retried by the tick wakeOnce re-armed (M32); idempotent per key.
      if (l.status === "completed") await wakeOnce(p, "plan-completed", `plan-completed:${p.planId}`);
      return;
    }
    const unroutable = new Map<TaskId, string>();
    const ready = readyOf(p, l, unroutable);
    for (const [taskId, msg] of unroutable) {
      if (!p.inFlight.has(taskId)) void startStep(p, taskId, () => routeFailed(p, taskId, msg));
    }
    const gate = d.launcher.gate(l.orchestrator.sessionID);
    if (ready.length === 0 || !gate.ok) {
      if (ready.length > 0 && !gate.ok && gate.wake !== null) await wakeOnce(p, gate.wake.reason, gate.wake.stateKey);
      updateIdle(p, ready, 0);
      return;
    }
    // The steps run on their own (a slot acquire may run an install): the tick never awaits them (QA-3.1-14); `inFlight`
    // keeps a second tick off a task whose step is running, and `settled()` tracks every step.
    const steps = ready.map((item) => startStep(p, item.taskId, () => launchStep(p, item)));
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
   * arms the backoff tick instead, so skips never re-tick each other.
   */
  function startStep(p: PlanRt, taskId: TaskId, fn: () => Promise<"launched" | "skipped">): Promise<"launched" | "skipped"> {
    p.inFlight.add(taskId);
    const attemptsOf = (): number => own(p.writer.ledger, taskId)?.attempts.length ?? 0;
    const before = attemptsOf();
    const run = async (): Promise<"launched" | "skipped"> => {
      let r: "launched" | "skipped" = "skipped";
      try {
        r = await fn();
      } catch (e) {
        d.log("error", "launch step failed", errorText(e));
      } finally {
        p.inFlight.delete(taskId);
      }
      if (r === "launched") launchSucceeded(p);
      else if (attemptsOf() !== before) schedule(p);
      else armBackoff(p);
      return r;
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

  /** QA-3.1-11: a RouteResolver error is row 4b for that task (a failed, counted attempt), never a broken tick. */
  async function routeFailed(p: PlanRt, taskId: TaskId, msg: string): Promise<"launched" | "skipped"> {
    return withTask(p, taskId, async (): Promise<"launched" | "skipped"> => {
      const t = own(p.writer.ledger, taskId);
      if (t === null || t.state !== "ready" || p.writer.ledger.status !== "running" || p.latch) return "skipped";
      const n = t.attempts.length + 1;
      await launchPrepFailed(p, t, n, d.clock.randomHex(16), null, new ExecutorError("E_LAUNCH_TASK", `route: ${msg}`, taskId), async () => undefined);
      return "skipped";
    });
  }

  // ---------- launch step (M37)

  async function launchStep(p: PlanRt, item: ScheduledTask): Promise<"launched" | "skipped"> {
    return withTask(p, item.taskId, async () => {
      const taskId = item.taskId;
      let l = p.writer.ledger;
      const t0 = own(l, taskId);
      if (t0 === null || t0.state !== "ready" || l.status !== "running" || p.latch) return "skipped";
      const n = t0.attempts.length + 1;
      const fresh = t0.slot === null;
      const route = item.route;
      // 1. capacity
      let token: TokenRef;
      try {
        token = p.capacity.acquire(route.provider, route.heavy, taskId, n);
      } catch {
        counter(p, "launch-skipped", { reason: "capacity-race" });
        return "skipped";
      }
      p.tokens.set(tokenKey(taskId, n), token);
      let slot: SlotLease | null = null;
      const abandon = async (): Promise<void> => {
        releaseToken(p, taskId, n, "other");
        if (fresh) {
          releaseLeases(p, taskId);
          if (slot !== null) await releaseResources(p, taskId, slot.slot);
        }
      };
      // 2. slot
      try {
        slot = await d.slots.acquire(p.planId, leaseHolderID(p.planId, taskId), l.integration.head);
        p.slotLeases.set(taskId, slot);
        await d.slots.reset(slot.slot, l.integration.head);
      } catch (e) {
        const unavailable = errorCode(e) === "E_SLOT_UNAVAILABLE";
        counter(p, "launch-skipped", { reason: unavailable ? "slot-unavailable" : "provision" });
        await abandon();
        if (!unavailable) await provisionFailed(p, taskId, e);
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
      const nonce = d.clock.randomHex(16);
      let expanded: ExpandedTask;
      try {
        const env = await loadExpansionEnv(d.git, { toplevel: l.repo.toplevel, slotPath: slot.path, timeoutMs: GIT_TIMEOUT_MS });
        expanded = expandTask({ ledger: p.writer.ledger, taskId, attempt: n, nonce, slot, env });
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
        workRoot: expanded.workRoot,
        prompt: expanded.prompt,
      };
      let handle: LaunchHandle;
      try {
        handle = d.launcher.launch(req, launchHooks(p, taskId, n, route));
      } catch (e) {
        const code = errorCode(e);
        counter(p, "launch-failed", { row: code === "E_LAUNCH_TASK" ? "L2" : code === "E_NO_CONTEXT" ? "L3" : "L4" });
        if (code === "E_LAUNCH_TASK") await rowLaunchFailed(p, taskId, n, errorText(e));
        else if (code === "E_DISPOSED") releaseToken(p, taskId, n, "other");
        else await rowLost(p, taskId, n, code === "E_NO_CONTEXT" ? "no-context" : "launch-error");
        return "skipped";
      }
      const ref: HandleRef = { n, settled: false, completion: handle.completion };
      p.handles.set(taskId, ref);
      // The wait for the child is a child wait (dispose never waits for it); processing its end, once it came, is ordinary work.
      void trackChild(
        handle.completion.then((end) => {
          ref.settled = true;
          return track(processEnd(p, taskId, n, end));
        }),
      );
      void track(
        handle.confirmation.then(
          (c) => onConfirmation(p, taskId, n, c),
          (e: unknown) => {
            d.log("warn", "confirmation rejected", errorText(e));
          },
        ),
      );
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

  function launchHooks(p: PlanRt, taskId: TaskId, n: number, route: TaskRoute): LaunchHooks {
    return {
      async onLateChild(): Promise<"adopt" | "refuse"> {
        const l = p.writer.ledger;
        const c = own(l, taskId);
        const a = c === null ? undefined : c.attempts[c.attempts.length - 1];
        const ok =
          c !== null && a !== undefined && a.n === n && a.outcome === "lost" && c.state === "ready" && c.slot !== null && l.status !== "aborted" && !p.latch;
        if (!ok) counter(p, "launch-failed", { row: "L11" });
        return ok ? "adopt" : "refuse";
      },
      async onChildCreated(childSessionID: string): Promise<void> {
        await withTask(p, taskId, async () => {
          const c = own(p.writer.ledger, taskId);
          if (c === null) throw new ExecutorError("E_PLAN_STATE", "task vanished", taskId);
          const adopting = c.state === "ready";
          if (adopting) {
            try {
              p.tokens.set(tokenKey(taskId, n), p.capacity.acquire(route.provider, route.heavy, taskId, n, { force: true }));
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
        });
      },
    };
  }

  async function onConfirmation(p: PlanRt, taskId: TaskId, n: number, c: LaunchConfirmation): Promise<void> {
    if (c.kind === "confirmed") {
      p.preConfirmLosses = 0;
      return;
    }
    await withTask(p, taskId, async () => {
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
    if (applied) await preConfirmLost(p, taskId, reason);
    schedule(p);
  }

  /**
   * QA-3.1-4: every row 11 is a loss before the launch was confirmed; it is uncounted, so a failure that repeats on each
   * relaunch (or on each new capture: tick -> wake -> new router call -> same failure) would loop forever. At
   * PRECONFIRM_STREAK consecutive losses the plan pauses (no more launches, so no more stale-context wakes) and ONE
   * blocking item is raised. A confirmed launch, and a resume, reset the count.
   */
  async function preConfirmLost(p: PlanRt, taskId: TaskId, reason: string): Promise<void> {
    p.preConfirmLosses += 1;
    if (p.preConfirmLosses < PRECONFIRM_STREAK) return;
    p.preConfirmLosses = 0;
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
      await p.collab.policy.park(taskId, "exhausted", text);
    }
    schedule(p);
  }

  // ---------- completion processing

  function processEnd(p: PlanRt, taskId: TaskId, n: number, end: ChildEnd): Promise<void> {
    return withTask(p, taskId, async () => {
      try {
        await handleEnd(p, taskId, n, end);
      } catch (e) {
        d.log("error", "child end processing failed", errorText(e));
      } finally {
        releaseToken(p, taskId, n, "other");
        const still = own(p.writer.ledger, taskId);
        if (end.childSessionID !== null && (still === null || openAttempt(still, n) === null)) {
          p.capacityStopped.delete(end.childSessionID);
          forgetSession(end.childSessionID);
        }
        schedule(p);
      }
    });
  }

  async function handleEnd(p: PlanRt, taskId: TaskId, n: number, end: ChildEnd): Promise<void> {
    // Nit 7: rows L16 (cancel) and L17 (dispose) are journaled before the cancel or by recovery; only counted here.
    if (end.kind === "interrupted") {
      if (!p.disposed) counter(p, "launch-failed", { row: end.reason === "dispose" ? "L17" : "L16" });
      return;
    }
    const t = own(p.writer.ledger, taskId);
    if (t === null) return;
    const a = openAttempt(t, n);
    if (a === null) return; // ignores closed attempts
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
        if (t.state === "running") await onCompleted(p, t, a, end.text, end.endedAt);
        return;
      case "failed":
        if (t.state !== "running") return;
        if (stopped) await rowChildLost(p, t, a, "capacity", "capacity-stop", end.endedAt, end.error.message);
        else await rowChildFailed(p, t, a, `${end.error.type}: ${end.error.message}`, end.endedAt, "child-failed");
        return;
      case "capacity":
        if (t.state === "running") await rowChildLost(p, t, a, "capacity", "capacity-stop", end.endedAt, end.error.message);
        return;
      case "lost":
        if (t.state === "dispatched") {
          await rowLost(p, taskId, n, end.reason);
        } else if (t.state === "running") {
          await rowChildLost(p, t, a, "lost", "child-lost", end.endedAt, end.reason);
          await lostStreakCheck(p, taskId, end.reason);
        }
        return;
    }
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

  async function onCompleted(p: PlanRt, t: TaskNode, a: Attempt, text: string, at: IsoTime): Promise<void> {
    const cls = classifyChildText(text);
    if (t.kind === "qa") {
      const parsed = p.collab.qa.parse(text);
      if (parsed.ok) {
        await qaSuccess(p, t, a, parsed.report, at);
        return;
      }
      if (cls.kind === "ordinary") {
        await qaUnparsable(p, t, a, parsed.error, at);
        return;
      }
    }
    if (cls.kind === "lease") {
      await leaseNeeded(p, t, a, cls.path, text, at);
      return;
    }
    if (cls.kind === "escalate" || cls.kind === "ambiguity") {
      await p.collab.policy.park(t.id, cls.kind, text);
      releaseToken(p, t.id, a.n, "other");
      return;
    }
    // row 15
    const applied = await appendIf(p, (cur) => {
      const c = own(cur, t.id);
      if (c === null || c.state !== "running" || openAttempt(c, a.n) === null) return [];
      return [ae(t.id, a.n, "succeeded", clampEnd(a, at), null), tt(t.id, "running", "completed", "child-ended")];
    });
    if (!applied) return;
    releaseToken(p, t.id, a.n, "success");
    await commitAndVerify(p, t.id, a.n);
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
      await p.collab.policy.park(t.id, "qa-unparsable", ctx);
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
        ax(t.id, a.n, evidence),
        tt(t.id, "running", "ready", "lease-needed", path),
        { type: "task-footprint", taskId: t.id, footprint: fp },
      ];
      if (learned !== null) ev.push({ type: "edge-added", edge: learned }, tt(t.id, "ready", "pending", "dep-added", path));
      ev.push(ts(t.id, null, null), ...gateRequeue(cur, c));
      return ev;
    });
    releaseToken(p, t.id, a.n, "other");
    if (!applied) return;
    await releaseResources(p, t.id, slotName);
  }

  /** M38: commit in the slot, then verify; PASS enqueues, FAIL goes to the retry decision. */
  async function commitAndVerify(p: PlanRt, taskId: TaskId, n: number): Promise<void> {
    const t = own(p.writer.ledger, taskId);
    if (t === null || t.state !== "completed" || t.slot === null) return;
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
      r = await commitTaskInSlot(d.git, {
        slot: lease,
        branch,
        message: `${taskId}: ${t.title} (attempt ${n})`,
        timeoutMs: GIT_TIMEOUT_MS,
      });
    } catch (e) {
      await commitFailed(errorText(e));
      return;
    }
    if (!r.changed) {
      if (t.footprint.writes.length > 0 && t.verify === "required") {
        await commitFailed("no changes");
        return;
      }
      const applied = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        return c === null || c.state !== "completed" ? [] : [tt(taskId, "completed", "done", "no-changes"), ts(taskId, null, null)];
      });
      if (applied) await releaseResources(p, taskId, slotName);
      return;
    }
    const verifying = await appendIf(p, (cur) => {
      const c = own(cur, taskId);
      return c === null || c.state !== "completed" ? [] : [ts(taskId, slotName, branch), tt(taskId, "completed", "verifying", "committed")];
    });
    if (!verifying) return;
    let verdict: Verdict;
    let findings: string;
    let ref: string | null;
    try {
      await d.slots.cleanForChecks(lease.slot);
      const cur = own(p.writer.ledger, taskId);
      const att = cur === null ? undefined : cur.attempts.find((x) => x.n === n);
      if (cur === null || att === undefined) return;
      const v = await d.verifier.verify(cur, lease, att);
      verdict = v.verdict;
      findings = v.findings;
      ref = v.ref;
    } catch (e) {
      verdict = "unverifiable";
      findings = errorText(e);
      ref = null;
    }
    if (verdict === "pass") {
      const ok = await appendIf(p, (cur) => {
        const c = own(cur, taskId);
        if (c === null || c.state !== "verifying") return [];
        return [{ type: "attempt-verdict", taskId, n, verdict: "pass", ref }, tt(taskId, "verifying", "verified", "verify-pass")];
      });
      if (!ok) return;
      await countAttempt(p, taskId, n);
      if (!p.latch) p.collab.queue.enqueue([taskId]);
      return;
    }
    const failed = await appendIf(p, (cur) => {
      const c = own(cur, taskId);
      if (c === null || c.state !== "verifying") return [];
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
      onIntegrated: () => run("onIntegrated", async (p) => schedule(p)),
      onConflict: (id) =>
        run("onConflict", (p) =>
          withTask(p, id, async () => {
            const t = own(p.writer.ledger, id);
            if (t !== null && t.slot !== null) {
              try {
                await d.slots.reset(t.slot, p.writer.ledger.integration.head);
              } catch (e) {
                d.log("warn", "slot reset after conflict failed", errorText(e));
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

  async function makeCapacity(p: PlanRt | null, writer: LedgerWriter, planId: PlanId, restore: boolean): Promise<CapacityController> {
    const cfg = writer.ledger.config;
    let seed: Record<string, CapacityProviderState> | undefined;
    if (restore) {
      try {
        const exp = await d.store.exportPlan(planId);
        seed = capacityRestoreFromEvents(exp.events, { maxParallel: cfg.maxParallel, nowMs: d.clock.now() });
      } catch (e) {
        d.log("warn", "capacity restore failed", errorText(e));
      }
    }
    return d.capacity({
      maxParallel: cfg.maxParallel,
      cooldownMs: cfg.capacityCooldownMs,
      pauseMs: cfg.capacityPauseMs,
      clock: d.clock,
      onMetric: (m) => {
        const target = p ?? plans.get(planId) ?? null;
        if (target !== null) metric(target, m);
      },
      ...(seed === undefined ? {} : { restore: seed }),
    });
  }

  /**
   * Single plan per process (memo M20, amendment A-3.1-1): at most one attached plan is running or paused. The capacity
   * controller, the orchestrator pin, the per-session maps and the host-event feed are process-wide, so a second active
   * plan would share (and starve) them. The plan that holds the slot, if any, other than `planId`.
   */
  function activePlanOtherThan(planId: PlanId): PlanRt | null {
    for (const q of plans.values()) {
      if (q.planId === planId || q.disposed) continue;
      const s = q.writer.ledger.status;
      if (s === "running" || s === "paused") return q;
    }
    return null;
  }

  /** Refuses `writer`'s plan (A-3.1-1): one blocking inbox item on it (deduplicated), then E_PLAN_STATE. */
  async function refuseSecondPlan(writer: LedgerWriter, other: PlanId, closeWriter: boolean): Promise<never> {
    const text =
      `plan ${writer.planId} cannot run: plan ${other} is already running or paused in this process ` +
      `(one active plan per process, memo M20 / A-3.1-1); complete or abort ${other} first`;
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
    if (closeWriter) {
      try {
        await writer.close();
      } catch (e) {
        d.log("warn", "refused plan close failed", errorText(e));
      }
    }
    throw new ExecutorError("E_PLAN_STATE", text, { planId: writer.planId, active: other });
  }

  async function attach(writer: LedgerWriter): Promise<PlanRt> {
    const existing = plans.get(writer.planId);
    if (existing !== undefined) return existing;
    const planId = writer.planId;
    const st0 = writer.ledger.status;
    if (st0 === "running" || st0 === "paused") {
      const other = activePlanOtherThan(planId);
      if (other !== null) await refuseSecondPlan(writer, other.planId, true);
    }
    const ref: { p: PlanRt | null } = { p: null };
    const leases = createLeaseService(planId, d.leaseRegistry);
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
    const collab = d.collaborators({ writer, leases, waker, listener: makeListener(ref) });
    const capacity = await makeCapacity(null, writer, planId, true);
    const p: PlanRt = {
      planId,
      writer,
      leases,
      waker,
      collab,
      capacity,
      tokens: new Map(),
      inFlight: new Set(),
      handles: new Map(),
      slotLeases: new Map(),
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
    };
    ref.p = p;
    plans.set(planId, p);
    const st = writer.ledger.status;
    if (st === "running" || st === "paused") await activate(p);
    return p;
  }

  /** Pins the orchestrator, rebuilds the leases (A3) and starts ticking. */
  async function activate(p: PlanRt): Promise<void> {
    const l = p.writer.ledger;
    p.unpin?.();
    p.unpin = d.pinOrchestrator(l.orchestrator.sessionID);
    const rows: Array<{ id: TaskId; slot: string | null; tree: string | null; footprint: Footprint }> = [];
    for (const t of Object.values(l.tasks)) {
      let tree: string | null = null;
      if (t.slot !== null) {
        try {
          tree = (await d.slots.get(t.slot))?.path ?? null;
        } catch (e) {
          d.log("warn", "slot lookup failed", errorText(e));
        }
      }
      rows.push({ id: t.id, slot: t.slot, tree, footprint: t.footprint });
    }
    for (const f of p.leases.rebuild(rows)) {
      counter(p, "lease-rebuild-failed", { taskId: f.taskId });
      try {
        await p.collab.policy.raise({
          kind: "failure",
          severity: "blocking",
          taskId: f.taskId,
          text: `could not re-take the leases of ${f.taskId} after restart; held by ${f.holders.map((h) => h.holderID).join(", ")}`,
          options: [],
        });
      } catch (e) {
        d.log("warn", "lease rebuild inbox failed", errorText(e));
      }
    }
    schedule(p);
  }

  async function closePlan(p: PlanRt): Promise<void> {
    p.disposed = true;
    p.latch = true;
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
    p.lostStreak.clear();
    p.capacityStopped.clear();
    p.wakeRetry.clear();
    await p.writer.close();
  }

  async function planFor(planId: PlanId, sessionID: string): Promise<PlanRt> {
    const have = plans.get(planId);
    if (have !== undefined) return have;
    const writer = await d.store.open(planId, d.holder(sessionID));
    return attach(writer);
  }

  function owned(p: PlanRt, sessionID: string): PlanRt {
    if (p.writer.ledger.orchestrator.sessionID !== sessionID) {
      throw new ExecutorError("E_NOT_OWNER", `plan ${p.planId} belongs to another session`, p.writer.ledger.orchestrator.sessionID);
    }
    return p;
  }

  async function mine(planId: PlanId, sessionID: string): Promise<PlanRt> {
    return owned(await planFor(planId, sessionID), sessionID);
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
        if (p.disposed) continue;
        const isOrch = p.writer.ledger.orchestrator.sessionID === sid;
        if (isOrch) {
          if (e.type === "step.started") p.orchIdle = false;
          else if (e.type === "execution.completed" || e.type === "execution.failed" || e.type === "execution.interrupted") p.orchIdle = true;
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
      if (e.type === "step.failed" || e.type === "execution.failed" || e.type === "execution.completed" || e.type === "execution.interrupted") {
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
        if (p.disposed) continue;
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

  function renderBoard(l: Readonly<LedgerV1>, p: PlanRt | null): string {
    const by = new Map<TaskState, number>();
    for (const t of Object.values(l.tasks)) by.set(t.state, (by.get(t.state) ?? 0) + 1);
    const out: string[] = [`Plan ${l.planId} [${l.status}] ${l.planPath}`];
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
      const writer = await d.store.create(r.draft, d.holder(i.sessionID));
      await attach(writer);
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
      // Single plan per process (memo M20, amendment A-3.1-1): never a second running or paused plan.
      const other = activePlanOtherThan(planId);
      if (other !== null) await refuseSecondPlan(p.writer, other.planId, false);
      const l = p.writer.ledger;
      const config: ExecutorConfig = { ...l.config, slotsDir: l.config.slotsDir ?? defaultSlotsDir(l.repo.toplevel, planId) };
      await p.writer.append([
        { type: "plan-approved", config, by: sessionID },
        { type: "status-changed", from: "awaiting-approval", to: "running", reason: "approved" },
      ]);
      // The capacity view is built per tick from `p.capacity` (QA-3.1-11), so replacing the controller is enough.
      p.capacity = await makeCapacity(p, p.writer, planId, false);
      await activate(p);
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
      const added = d.compiler.addTasks(p.writer.ledger, text);
      const slots = new Map<TaskId, string>();
      await p.writer.append((cur) => {
        slots.clear();
        const ev: ExecutorEventInput[] = [];
        for (const t of added.tasks) ev.push({ type: "task-created", task: t });
        for (const e of added.edges) ev.push({ type: "edge-added", edge: e });
        for (const id of added.reopened) {
          const c = own(cur, id);
          if (c === null || c.state !== "ready") continue;
          ev.push(tt(id, "ready", "pending", "dep-added"));
          if (c.slot !== null) {
            slots.set(id, c.slot);
            ev.push(ts(id, null, null));
          }
        }
        return ev;
      });
      for (const [id, slot] of slots) await releaseResources(p, id, slot);
      schedule(p);
      return { added: added.tasks.map((t) => t.id), reopened: [...added.reopened] };
    },

    async answer(planId, inboxId, text, sessionID) {
      const p = await mine(planId, sessionID);
      await p.collab.policy.answer(inboxId, text);
      schedule(p);
    },

    async done(planId, taskId, sessionID) {
      const p = await mine(planId, sessionID);
      const ok = await appendIf(p, (cur) => {
        const t = own(cur, taskId);
        if (t === null || t.state !== "ready" || (t.kind !== "manual" && t.kind !== "preflight")) return [];
        return [tt(taskId, "ready", "done", "reported-done")];
      });
      if (!ok) throw new ExecutorError("E_INVALID_INPUT", `${taskId} is not a ready manual or preflight task`, taskId);
      schedule(p);
    },

    async pause(planId, sessionID) {
      const p = await mine(planId, sessionID);
      await setStatus(p, "running", "paused", "user-pause");
    },

    async resume(planId, sessionID) {
      const p = await mine(planId, sessionID);
      await setStatus(p, "paused", "running", "user-resume");
      // A resume is the user's answer to the streak pauses: they start over (QA-3.1-4, QA-3.1-6).
      p.preConfirmLosses = 0;
      p.skipStreak = 0;
      p.provisionFails = 0;
      p.provisionRaised = false;
      for (const ph of p.writer.ledger.phases) {
        try {
          await p.collab.queue.checkPhase(ph.id);
        } catch (e) {
          d.log("warn", `checkPhase ${ph.id} failed`, errorText(e));
        }
      }
      const verified = Object.values(p.writer.ledger.tasks).filter((t) => t.state === "verified").map((t) => t.id);
      if (verified.length > 0) p.collab.queue.enqueue(verified);
      schedule(p);
    },

    async abort(planId, sessionID) {
      const p = await mine(planId, sessionID);
      requireStatus(p, ["compiling", "awaiting-residue", "awaiting-approval", "running", "paused"]);
      p.latch = true;
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
      const live = new Set<TaskId>();
      for (const f of d.launcher.inFlight()) {
        const h = p.handles.get(f.taskId);
        if (!cancelled.has(f.taskId) || h === undefined || h.n !== f.attempt) continue;
        live.add(f.taskId);
        const slotName = cancelled.get(f.taskId) ?? null;
        bg("abort cancel", async () => {
          await d.launcher.cancel(f.taskId, f.attempt, "abort");
          await h.completion;
          await releaseResources(p, f.taskId, slotName);
          releaseToken(p, f.taskId, f.attempt, "other");
        });
      }
      for (const [id, slotName] of cancelled) {
        if (live.has(id)) continue;
        if (slotName !== null) await releaseResources(p, id, slotName);
        else p.leases.releaseTask(id);
      }
    },

    async land(planId, sessionID) {
      const p = await mine(planId, sessionID);
      await p.collab.queue.land();
    },

    async adopt(planId, sessionID) {
      if (d.recovery === null) throw new ExecutorError("E_PLAN_STATE", "recovery is not available", planId);
      const old = plans.get(planId);
      if (old !== undefined) await closePlan(old);
      await d.recovery.adopt(planId, sessionID);
      let writer: LedgerWriter;
      try {
        writer = await d.store.open(planId, d.holder(sessionID));
      } catch (e) {
        if (errorCode(e) !== "E_LOCK_HELD") throw e;
        writer = await d.store.takeover(planId, d.holder(sessionID), "adopt");
      }
      await attach(writer);
    },

    async gc() {
      return d.slots.gc(async (planId) => {
        const known = plans.get(planId);
        if (known !== undefined) return known.writer.ledger.status === "completed" || known.writer.ledger.status === "aborted";
        try {
          const l = await d.store.read(planId);
          return l.status === "completed" || l.status === "aborted";
        } catch (e) {
          if (errorCode(e) === "E_LEDGER_NOT_FOUND") return null;
          throw e;
        }
      });
    },

    async exportPlan(planId) {
      const x = await d.store.exportPlan(planId);
      return JSON.stringify({ snapshot: x.snapshot, events: x.events }, null, 2);
    },

    async purge(planId, sessionID) {
      const p = await mine(planId, sessionID);
      requireStatus(p, ["completed", "aborted"]);
      const toplevel = p.writer.ledger.repo.toplevel;
      await closePlan(p);
      await d.slots.gc(async (id) => (id === planId ? true : null));
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
      let target: PlanRt | null = null;
      for (const p of plans.values()) {
        const t = own(p.writer.ledger, taskId);
        if (t === null) continue;
        if (openAttempt(t, attempt) !== null) {
          target = p;
          break;
        }
        target ??= p;
      }
      if (target !== null) await processEnd(target, taskId, attempt, end);
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
      if (d.recovery !== null) {
        try {
          await d.recovery.recover();
        } catch (e) {
          d.log("error", "recovery failed", errorText(e));
        }
      }
      for (const e of await d.store.list()) {
        if ((e.status !== "running" && e.status !== "paused") || plans.has(e.planId)) continue;
        try {
          await attach(await d.store.open(e.planId, d.holder(e.orchestratorSessionID)));
        } catch (err) {
          d.log("warn", `plan ${e.planId} not attached`, errorText(err));
        }
      }
    },

    async dispose() {
      disposed = true;
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
        p.disposed = true;
        for (const h of p.timers) d.clock.clearTimer(h);
        p.timers.clear();
        p.backoff = null;
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
        for (const p of plans.values()) schedule(p);
      } catch (e) {
        d.log("error", "lease release feed failed", errorText(e));
      }
    },
  };

  return handle;
}
