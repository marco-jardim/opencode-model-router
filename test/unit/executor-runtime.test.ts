// Tests for src/executor/runtime.ts (plan task 3.1.8, runtime half; memo phase-3.1.md section 8).
// Real LedgerStore in a temp dir (removed after the runtime closed it), the real Scheduler, CapacityController and expand;
// typed doubles for IntegrationQueue, UnattendedPolicy, QaLoop, SlotPool, TaskLauncher, SlotVerifier, GitRunner,
// HostSessions, LeaseRegistryPort and RouteResolver. All time comes from TestClock: nothing here reads the wall clock
// or waits on a real timer (the `until` poll only yields to the event loop while the real ledger files are written).
// Handles of the launcher double stay pending until a test settles them, so tests poll `until(...)` instead of
// runtime.settled() while a child is alive; `settled()` is used once every handle is done.
// Ledger invariants the Q/P doubles respect: git ids are 40 hex, parked/done/integrated hold no slot, verified+ hold
// slot and branch, an open attempt exists only in dispatched/running (types.ts taskInvariantViolations).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkV2ObservationStream, createV2Observations, type ObservationRecord, type V2Observations } from "../../src/compat/v2-observations";
import { createCapacityController } from "../../src/executor/capacity.js";
import { phaseIntegrated } from "../../src/executor/integrate/queue.js";
import { taskBranchName, type GitOps } from "../../src/executor/git.js";
import { createLedgerStore, createNodeFileSystem } from "../../src/executor/ledger.js";
import {
  commitTaskInSlot,
  createExecutorRuntime,
  createLeaseService,
  createWaker,
  type ExecutorRuntimeHandle,
  type LeaseRegistryPort,
  type PlanCollaborators,
  type RuntimeDeps,
} from "../../src/executor/runtime.js";
import { createScheduler } from "../../src/executor/schedule.js";
import { createSlotPool, defaultSlotsDir } from "../../src/executor/slots/pool.js";
import {
  ExecutorError,
  QA_UNPARSABLE_CONTEXT_PREFIX,
  countsTowardMaxAttempts,
  formatInboxId,
  isFindingsReport,
  nextInboxNumber,
  type Attempt,
  type ChildEnd,
  type Clock,
  type Edge,
  type ExecutorConfig,
  type ExecutorEvent,
  type ExecutorEventInput,
  type FindingsReport,
  type GateState,
  type GitRunner,
  type HostSessionContext,
  type HostSessionEvent,
  type HostSessions,
  type InboxItem,
  type IntegrationListener,
  type IntegrationQueue,
  type LaunchConfirmation,
  type LaunchGate,
  type LaunchHandle,
  type LaunchHooks,
  type LaunchRequest,
  type LeaseService,
  type LedgerStore,
  type LedgerV1,
  type LedgerWriter,
  type MetricPayload,
  type PhaseId,
  type PlanCompiler,
  type ProcOpts,
  type ProcessResult,
  type QaLoop,
  type RecoveryService,
  type ResumeReport,
  type RetainedContextInfo,
  type RouteResolver,
  type SlotLease,
  type SlotPool,
  type SlotRecord,
  type SlotVerifier,
  type TaskId,
  type TaskLauncher,
  type TaskNode,
  type TaskState,
  type TransitionTrigger,
  type UnattendedPolicy,
  type Verdict,
  type Waker,
} from "../../src/executor/types.js";
import { PLAN_ID, T0, buildDraft, holderOf, taskNode } from "../fixtures/cpx/ledger/builders.js";
import { FakeProc } from "../fixtures/cpx/ledger/fakes.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

vi.setConfig({ testTimeout: 30_000 });

const SHA = "c".repeat(40);
const SHA2 = "d".repeat(40);
const SLOT_ROOT = "C:/omr-rt";
const ORCH = "ses-0";
const PROVIDER = "prov";
const REPO = "C:/repo";
const QA_OK_TEXT = JSON.stringify({ findings: [] });

// ---------------------------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------------------------

/** Manual clock: time moves only with `advance`; due timers run in order, each at its own due time. */
class TestClock implements Clock {
  private ms = Date.parse(T0);
  private nextId = 1;
  private rand = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  readonly randoms: string[] = [];

  now(): number {
    return this.ms;
  }
  iso(ms?: number): string {
    return new Date(ms ?? this.ms).toISOString();
  }
  setTimer(ms: number, fn: () => void): { readonly id: number } {
    const id = this.nextId++;
    this.timers.set(id, { at: this.ms + Math.max(0, ms), fn });
    return { id };
  }
  clearTimer(h: { readonly id: number }): void {
    this.timers.delete(h.id);
  }
  randomHex(bytes: number): string {
    this.rand += 1;
    const v = (0xabc000 + this.rand).toString(16).padStart(bytes * 2, "0");
    this.randoms.push(v);
    return v;
  }
  /** Moves time forward, firing every timer that falls due on the way, earliest first. */
  advance(ms: number): void {
    const target = this.ms + ms;
    for (;;) {
      let pick: number | null = null;
      let pickAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < pickAt) {
          pick = id;
          pickAt = t.at;
        }
      }
      if (pick === null) break;
      const t = this.timers.get(pick);
      this.timers.delete(pick);
      if (t === undefined) break;
      this.ms = Math.max(this.ms, t.at);
      t.fn();
    }
    this.ms = target;
  }
  pendingTimers(): number {
    return this.timers.size;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

/** Ordered call log shared by the doubles: `"<seam>.<method>:<arg> [snapshot]"`. */
type CallLog = string[];
type Snap = () => string;

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: (v) => resolve(v), reject: (e) => reject(e) };
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/** Polls (yielding to the event loop, never advancing the fake clock) until `pred` holds. */
async function until(pred: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 2400; i++) {
    if (await pred()) return;
    await pause(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const slotPathOf = (slot: string): string => `${SLOT_ROOT}/slots/${slot}`;

const tr = (taskId: TaskId, from: TaskState, to: TaskState, trigger: TransitionTrigger, detail: string | null = null): ExecutorEventInput => ({
  type: "task-transition",
  taskId,
  from,
  to,
  trigger,
  detail,
});

function task(id: TaskId, patch: Partial<TaskNode> = {}): TaskNode {
  return taskNode(id, {
    route: { line: "", role: "implementer", tier: "fast", pin: false },
    footprint: { writes: [`src/${id}.ts`], reads: [], confidence: "explicit", sources: ["path"] },
    ...patch,
  });
}

const edge = (from: TaskId, to: TaskId): Edge => ({ from, to, kind: "structural", confidence: "high", evidence: "test" });

interface PlanOpts {
  edges?: Edge[];
  config?: Partial<ExecutorConfig>;
  gate?: GateState;
}

function planOf(tasks: TaskNode[], o: PlanOpts = {}): LedgerV1 {
  const d = buildDraft(0);
  d.config = { ...d.config, wakeDebounceMs: 1000, capacityCooldownMs: 10_000, ...(o.config ?? {}) };
  d.integration = { ...d.integration, head: SHA };
  d.repo = { ...d.repo, toplevel: REPO };
  d.sharedContext = "shared notes";
  for (const t of tasks) d.tasks[t.id] = t;
  d.edges = o.edges ?? [];
  const ph = d.phases[0];
  if (ph !== undefined && o.gate !== undefined) ph.gate = o.gate;
  return d;
}

const GATE_CONTEXT: RetainedContextInfo = {
  sessionID: ORCH,
  callID: "call-1",
  messageID: "msg-1",
  agent: "orchestrator",
  capturedAt: T0,
  bootID: "0123456789abcdef",
  epoch: 1,
};
const OK_GATE: LaunchGate = { ok: true, context: GATE_CONTEXT, ageMs: 0 };
const DISPOSED_GATE: LaunchGate = { ok: false, reason: "disposed", wake: null };
const staleGate = (stateKey: string): LaunchGate => ({
  ok: false,
  reason: "context-stale",
  wake: { reason: "stale-context", stateKey },
});

// ---------------------------------------------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------------------------------------------

/** SlotPool: a task that already holds a slot gets the same slot back. */
class SlotPoolDouble implements SlotPool {
  readonly byOwner = new Map<string, SlotLease>();
  readonly records = new Map<string, SlotRecord>();
  readonly released: string[] = [];
  readonly resets: Array<{ slot: string; commit: string }> = [];
  /** Runs inside `acquire`, after the slot is chosen (used to plant a lease race). */
  onAcquire: (() => void) | null = null;
  private n = 0;
  constructor(private readonly log: CallLog) {}
  async acquire(planId: string, owner: string, baseCommit: string): Promise<SlotLease> {
    const have = this.byOwner.get(owner);
    if (have !== undefined) return have;
    this.n += 1;
    const slot = `slot-${this.n}`;
    const lease: SlotLease = { slot, path: slotPathOf(slot), planId, owner, commit: baseCommit };
    this.byOwner.set(owner, lease);
    this.records.set(slot, {
      schema: 1,
      slot,
      path: lease.path,
      kind: "task",
      planId,
      repoKey: "repo-key",
      state: "leased",
      owner,
      commit: baseCommit,
      managers: [],
      manifests: {},
      createdAt: T0,
      updatedAt: T0,
    });
    this.log.push(`slots.acquire:${owner}`);
    this.onAcquire?.();
    return lease;
  }
  async acquireSpecial(): Promise<SlotLease> {
    throw new Error("acquireSpecial is not used by the runtime");
  }
  async reset(slot: string, commit: string): Promise<void> {
    this.resets.push({ slot, commit });
    this.log.push(`slots.reset:${slot}`);
  }
  async cleanForChecks(slot: string): Promise<void> {
    this.log.push(`slots.cleanForChecks:${slot}`);
  }
  async release(slot: string): Promise<void> {
    this.released.push(slot);
    this.log.push(`slots.release:${slot}`);
    for (const [owner, l] of this.byOwner) if (l.slot === slot) this.byOwner.delete(owner);
  }
  async get(slot: string): Promise<SlotRecord | null> {
    return this.records.get(slot) ?? null;
  }
  async list(): Promise<SlotRecord[]> {
    return [...this.records.values()];
  }
  /** The predicate the runtime handed to the last `gc` call. */
  gcPredicate: Parameters<SlotPool["gc"]>[0] | null = null;
  async gc(isDone?: Parameters<SlotPool["gc"]>[0]): Promise<{ removed: string[]; reported: string[] }> {
    this.gcPredicate = isDone ?? null;
    return { removed: [], reported: [] };
  }
}

/** LeaseRegistryPort: all-or-nothing acquire, re-entrant per taskRef; a foreign holder can be planted. */
class RegistryDouble implements LeaseRegistryPort {
  readonly held = new Map<string, { holderID: string; taskRef: string | null }>();
  readonly acquires: Array<{ taskRef: string; tree: string; writes: string[] }> = [];
  readonly releases: string[] = [];
  constructor(private readonly log: CallLog) {}
  plant(path: string, holderID: string, taskRef: string | null): void {
    this.held.set(path, { holderID, taskRef });
  }
  heldBy(taskRef: string): string[] {
    return [...this.held].filter(([, h]) => h.taskRef === taskRef).map(([p]) => p);
  }
  acquireWrite(
    holder: { holderID: string; tree: string; isChild: true; taskRef: string; scope: "until-integrated" },
    writes: readonly string[],
  ): ReturnType<LeaseRegistryPort["acquireWrite"]> {
    const blockers: Array<{ holderID: string; taskRef: string | null }> = [];
    for (const w of writes) {
      const h = this.held.get(w);
      if (h !== undefined && h.taskRef !== holder.taskRef) blockers.push({ ...h });
    }
    if (blockers.length > 0) return { ok: false, reason: "held", holders: blockers };
    for (const w of writes) this.held.set(w, { holderID: holder.holderID, taskRef: holder.taskRef });
    this.acquires.push({ taskRef: holder.taskRef, tree: holder.tree, writes: [...writes] });
    this.log.push(`leases.acquire:${holder.taskRef}`);
    return { ok: true };
  }
  releaseTask(taskRef: string): void {
    this.releases.push(taskRef);
    this.log.push(`leases.release:${taskRef}`);
    for (const [p, h] of [...this.held]) if (h.taskRef === taskRef) this.held.delete(p);
  }
  holderOf(path: string): { holderID: string; taskRef: string | null } | null {
    return this.held.get(path) ?? null;
  }
}

/** IntegrationQueue: records calls; Q's results are played by the test (see qIntegrate / qConflict). */
class QueueDouble implements IntegrationQueue {
  readonly enqueued: TaskId[][] = [];
  readonly checked: string[] = [];
  landed = 0;
  aborted = 0;
  disposed = 0;
  constructor(
    private readonly log: CallLog,
    private readonly snap: Snap,
  ) {}
  enqueue(ids: readonly TaskId[]): void {
    this.enqueued.push([...ids]);
    this.log.push(`queue.enqueue:${ids.join(",")}`);
  }
  async resume(): Promise<ResumeReport> {
    return { completed: [], rolledBack: [], halted: false, entries: [] };
  }
  async checkPhase(phaseId: string): Promise<void> {
    this.checked.push(phaseId);
  }
  async land(): Promise<{ landed: boolean; inbox: InboxItem | null }> {
    this.landed += 1;
    return { landed: true, inbox: null };
  }
  async abort(): Promise<void> {
    this.aborted += 1;
    this.log.push(`queue.abort ${this.snap()}`);
  }
  queued(): readonly TaskId[] {
    return this.enqueued.flat();
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

/** UnattendedPolicy over the real writer: park journals the P rows (attempt closed, slot freed, leases released). */
class PolicyDouble implements UnattendedPolicy {
  readonly raised: Array<Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string }> = [];
  readonly parks: Array<{ taskId: TaskId; cause: string; text: string }> = [];
  readonly counted: Array<{ phaseId: PhaseId; n: number; outcome: Attempt["outcome"]; verdict: Attempt["verdict"] }> = [];
  unblocks = 0;
  constructor(
    private readonly writer: LedgerWriter,
    private readonly leases: LeaseService,
    private readonly slots: SlotPoolDouble,
    private readonly clock: Clock,
  ) {}
  private async add(i: Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string }): Promise<InboxItem> {
    const out: { item: InboxItem | null } = { item: null };
    await this.writer.append((l) => {
      const item: InboxItem = {
        kind: i.kind,
        severity: i.severity,
        taskId: i.taskId,
        text: i.text,
        options: i.options,
        answer: i.answer ?? null,
        id: formatInboxId(i.kind, nextInboxNumber(l)),
        createdAt: this.clock.iso(),
      };
      out.item = item;
      return [{ type: "inbox-added", item }];
    });
    return need(out.item, "inbox item");
  }
  async raise(i: Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string }): Promise<InboxItem> {
    this.raised.push(i);
    return this.add(i);
  }
  async park(taskId: TaskId, cause: "escalate" | "ambiguity" | "qa-unparsable" | "exhausted", text: string): Promise<InboxItem> {
    this.parks.push({ taskId, cause, text });
    const before = need(this.writer.ledger.tasks[taskId], `task ${taskId}`);
    const slot = before.slot;
    await this.writer.append((cur) => {
      const c = cur.tasks[taskId];
      if (c === undefined) return [];
      const a = c.attempts[c.attempts.length - 1];
      const ev: ExecutorEventInput[] = [];
      if (c.state === "running" && a !== undefined && a.outcome === null) {
        ev.push({ type: "attempt-ended", taskId, n: a.n, outcome: "interrupted", endedAt: this.clock.iso(), detail: cause });
        ev.push({ type: "attempt-context", taskId, n: a.n, context: text });
      }
      ev.push(tr(taskId, c.state, "parked", cause, cause));
      ev.push({ type: "task-slot", taskId, slot: null, branch: null });
      const ph = c.phase === null ? undefined : cur.phases.find((p) => p.id === c.phase);
      if (c.kind === "qa" && ph !== undefined && ph.gate === "qa-running") {
        ev.push({ type: "gate-changed", phaseId: ph.id, from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued", qaRound: ph.qaRound });
      }
      return ev;
    });
    this.leases.releaseTask(taskId);
    if (slot !== null) await this.slots.release(slot);
    return this.add({ kind: cause === "exhausted" ? "failure" : "question", severity: "blocking", taskId, text, options: [] });
  }
  async answer(_inboxId?: string, _text?: string): Promise<{ resumed: TaskId | null }> {
    return { resumed: null };
  }
  async unblock(): Promise<TaskId[]> {
    this.unblocks += 1;
    return [];
  }
  async recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }> {
    this.counted.push({ phaseId, n: a.n, outcome: a.outcome, verdict: a.verdict });
    return { tripped: false };
  }
}

/** QaLoop: parse accepts a bare findings JSON document; results are recorded. */
class QaDouble implements QaLoop {
  readonly results: Array<{ taskId: TaskId; report: FindingsReport }> = [];
  readonly awaiting: PhaseId[] = [];
  parse(text: string): { ok: true; report: FindingsReport } | { ok: false; error: string } {
    try {
      const v: unknown = JSON.parse(text);
      return isFindingsReport(v) ? { ok: true, report: v } : { ok: false, error: "does not match the findings schema" };
    } catch {
      return { ok: false, error: "not JSON" };
    }
  }
  async onQaResult(taskId: TaskId, report: FindingsReport): Promise<"passed" | "next-round" | "cap-reached"> {
    this.results.push({ taskId, report });
    return "passed";
  }
  async onAwaitingQa(phaseId: PhaseId): Promise<void> {
    this.awaiting.push(phaseId);
  }
  async onCapAnswer(): Promise<"passed" | "next-round"> {
    return "passed";
  }
}

/** GitRunner: answers the commands the runtime and expand issue; `dirty(cwd)` decides `status --porcelain`. */
class GitDouble implements GitRunner {
  readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];
  dirty: (cwd: string) => boolean = () => true;
  failOn: { verb: string; stderr: string } | null = null;
  /** Every ref `for-each-ref` lists, whatever prefix was asked for. */
  refs: string[] = [];
  private commits = 0;
  async run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> {
    this.calls.push({ args: [...args], cwd: o.cwd });
    const verb = args[0] ?? "";
    const ok = (stdout = ""): ProcessResult => ({ code: 0, signal: null, stdout, stderr: "", truncated: false, durationMs: 0 });
    if (this.failOn !== null && this.failOn.verb === verb) return { ...ok(), code: 1, stderr: this.failOn.stderr };
    if (verb === "for-each-ref") return ok(this.refs.join("\n"));
    if (verb === "worktree") return ok(`worktree ${REPO}\nHEAD ${SHA}\nbranch refs/heads/main\n`);
    if (verb === "config") return { ...ok(), code: 1 };
    if (verb === "status") return ok(this.dirty(o.cwd) ? " M src/a.ts\n" : "");
    if (verb === "rev-parse") {
      this.commits += 1;
      return ok(`${this.commits.toString(16).padStart(40, "e")}\n`);
    }
    return ok();
  }
}

/** HostSessions: `synthetic` can be made to throw N times; delivered messages are recorded by state key. */
class HostsDouble implements HostSessions {
  readonly attempted: string[] = [];
  readonly delivered: Array<Parameters<HostSessions["synthetic"]>[0]> = [];
  failures = 0;
  readonly contexts = new Map<string, HostSessionContext>();
  async get(sessionID: string): Promise<{ id: string; parentID: string | null } | null> {
    return { id: sessionID, parentID: null };
  }
  async context(sessionID: string): Promise<HostSessionContext> {
    return this.contexts.get(sessionID) ?? { messages: [] };
  }
  async activity(): Promise<"active" | "inactive" | "unknown"> {
    return "inactive";
  }
  async interrupt(): Promise<void> {}
  async synthetic(i: Parameters<HostSessions["synthetic"]>[0]): Promise<void> {
    this.attempted.push(String(i.metadata.stateKey));
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("host unavailable");
    }
    this.delivered.push(i);
  }
  async move(): Promise<void> {}
  /** Listeners subscribed through `onEvent` (the runtime subscribes in `start`, QA-3.1-1). */
  readonly listeners = new Set<(e: HostSessionEvent) => void>();
  onEvent(listener: (e: HostSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Delivers a host session event to every subscriber, as the host's event stream does. */
  emit(e: HostSessionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
  keys(): string[] {
    return this.delivered.map((d) => String(d.metadata.stateKey));
  }
}

/** SlotVerifier: verdicts are consumed in order; an empty queue means pass. */
class VerifierDouble implements SlotVerifier {
  readonly calls: string[] = [];
  readonly queue: Array<{ verdict: Verdict; findings: string }> = [];
  async verify(t: TaskNode, _slot: SlotLease, attempt: Attempt): Promise<{ verdict: Verdict; findings: string; ref: string }> {
    this.calls.push(`${t.id}#${attempt.n}`);
    const v = this.queue.shift() ?? { verdict: "pass" as const, findings: "" };
    return { verdict: v.verdict, findings: v.findings, ref: `ref-${t.id}-${attempt.n}` };
  }
}

const routes: RouteResolver = {
  route: (t) => ({
    agent: t.route.role,
    model: { providerID: PROVIDER, modelID: "model-1", variant: null },
    provider: PROVIDER,
    heavy: false,
  }),
};

/** One launch of the launcher double; the test drives its confirmation and its end. */
class RunDouble {
  childSessionID: string | null = null;
  settled = false;
  readonly cancelReasons: string[] = [];
  readonly confirmation = deferred<LaunchConfirmation>();
  readonly completion = deferred<ChildEnd>();
  /** The runtime's hooks, wrapped so the run knows whether the child hook was entered (as launch.ts `hookEntered`). */
  readonly hooks: LaunchHooks;
  private hookEntered = false;
  constructor(
    readonly req: LaunchRequest,
    hooks: LaunchHooks,
    /** The ledger already held `req.nonce` as the open attempt's nonce when `launch` was called. */
    readonly durableNonce: boolean,
    private readonly clock: Clock,
  ) {
    this.hooks = {
      onLateChild: (child) => hooks.onLateChild(child),
      onChildCreated: async (child) => {
        this.hookEntered = true;
        await hooks.onChildCreated(child);
        this.childSessionID = child;
      },
    };
  }
  /** The child session appears: the hook journals it (dispatched -> running), then the launch is confirmed. */
  async child(sessionID: string): Promise<void> {
    this.childSessionID = sessionID;
    await this.hooks.onChildCreated(sessionID);
    this.confirm({ kind: "confirmed", childSessionID: sessionID, latencyMs: 1 });
  }
  /**
   * Settles the confirmation. A `timeout` before the child hook was entered also settles the completion as
   * `lost/unconfirmed`, as the real launcher does (launch.ts confirm timer): a child that shows up later (L12) can then
   * only end through host events.
   */
  confirm(c: LaunchConfirmation): void {
    this.confirmation.resolve(c);
    if (c.kind === "unconfirmed" && c.reason === "timeout" && !this.hookEntered && !this.settled) {
      this.end({ kind: "lost", childSessionID: null, reason: "unconfirmed", endedAt: this.clock.iso() });
    }
  }
  end(e: ChildEnd): void {
    this.settled = true;
    this.completion.resolve(e);
  }
  complete(text: string): void {
    this.end({ kind: "completed", childSessionID: this.childSessionID ?? "ses-unknown", text, endedAt: this.clock.iso() });
  }
}

class LauncherDouble implements TaskLauncher {
  gateValue: LaunchGate = OK_GATE;
  /** When set, the next `launch` throws it (one shot). */
  launchFailure: Error | null = null;
  /** Set by `releaseAll`. */
  closed = false;
  readonly runs: RunDouble[] = [];
  disposed = 0;
  constructor(
    private readonly log: CallLog,
    private readonly clock: Clock,
    private readonly ledgerOf: () => Readonly<LedgerV1> | null,
    private readonly snap: Snap,
  ) {}
  gate(): LaunchGate {
    return this.gateValue;
  }
  launch(req: LaunchRequest, hooks: LaunchHooks): LaunchHandle {
    if (this.closed) {
      // Teardown already ran `releaseAll`: a launch that raced it is settled at once so dispose never waits for it.
      const late = new RunDouble(req, hooks, false, this.clock);
      this.runs.push(late);
      late.confirm({ kind: "confirmed", childSessionID: "ses-none", latencyMs: 0 });
      late.end({ kind: "interrupted", childSessionID: null, reason: "dispose", endedAt: this.clock.iso() });
      return {
        taskId: req.taskId,
        attempt: req.attempt,
        nonce: req.nonce,
        context: req.context,
        contextAgeMs: 0,
        startedAt: this.clock.iso(),
        confirmation: late.confirmation.promise,
        completion: late.completion.promise,
      };
    }
    if (this.launchFailure !== null) {
      const failure = this.launchFailure;
      this.launchFailure = null;
      throw failure;
    }
    const t = this.ledgerOf()?.tasks[req.taskId];
    const a = t?.attempts[t.attempts.length - 1];
    const durable = a !== undefined && a.n === req.attempt && a.nonce === req.nonce && a.outcome === null;
    this.log.push(`launcher.launch:${req.taskId}#${req.attempt} nonceDurable=${String(durable)}`);
    const run = new RunDouble(req, hooks, durable, this.clock);
    this.runs.push(run);
    return {
      taskId: req.taskId,
      attempt: req.attempt,
      nonce: req.nonce,
      context: req.context,
      contextAgeMs: 0,
      startedAt: this.clock.iso(),
      confirmation: run.confirmation.promise,
      completion: run.completion.promise,
    };
  }
  async cancel(taskId: TaskId, attempt: number, reason: "abort" | "blocked" | "superseded" | "dispose"): Promise<void> {
    const run = this.runOf(taskId, attempt);
    this.log.push(`launcher.cancel:${taskId}#${attempt}:${reason} ${this.snap()}`);
    if (run === undefined) return;
    run.cancelReasons.push(reason);
    run.end({ kind: "interrupted", childSessionID: run.childSessionID, reason, endedAt: this.clock.iso() });
    run.confirm({ kind: "unconfirmed", reason: "superseded", error: null });
  }
  inFlight(): ReadonlyArray<{ taskId: TaskId; attempt: number; childSessionID: string | null; startedAt: string }> {
    return this.runs
      .filter((r) => !r.settled)
      .map((r) => ({ taskId: r.req.taskId, attempt: r.req.attempt, childSessionID: r.childSessionID, startedAt: T0 }));
  }
  /**
   * When set, `dispose` aborts every owned child as the real launcher does (QA-3.1-25): each unsettled run ends
   * `interrupted/dispose`, AFTER the runtime marked its plans disposed. Off by default: most tests keep the child alive.
   */
  abortOnDispose = false;
  async dispose(): Promise<void> {
    this.disposed += 1;
    if (!this.abortOnDispose) return;
    for (const r of this.runs) {
      if (r.settled) continue;
      r.end({ kind: "interrupted", childSessionID: r.childSessionID, reason: "dispose", endedAt: this.clock.iso() });
    }
  }
  runOf(taskId: TaskId, attempt: number): RunDouble | undefined {
    return this.runs.find((r) => r.req.taskId === taskId && r.req.attempt === attempt);
  }
  /**
   * Settles every handle without journaling anything (used at test end, after the gate is closed): every confirmation
   * (a run a test ended without confirming would otherwise keep `dispose` waiting) and every completion still open.
   * Later launches settle at once (`closed`).
   */
  releaseAll(): void {
    this.closed = true;
    for (const r of this.runs) {
      r.confirm({ kind: "confirmed", childSessionID: r.childSessionID ?? "ses-none", latencyMs: 0 });
      if (r.settled) continue;
      r.end({ kind: "interrupted", childSessionID: r.childSessionID, reason: "dispose", endedAt: this.clock.iso() });
    }
  }
}

class CompilerDouble implements PlanCompiler {
  readonly compiled: string[] = [];
  readonly compileOpts: Array<Record<string, unknown>> = [];
  /** When set, `compile` also answers a residue request with this prompt. */
  residuePrompt: string | null = null;
  /** The draft `mergeResidue` returns (null: it throws like the real compiler on a bad answer). */
  merged: LedgerV1 | null = null;
  readonly residueTexts: string[] = [];
  /** What `addTasks` returns (null: it throws like the real compiler on a cycle). */
  added: { tasks: TaskNode[]; edges: Edge[]; reopened: TaskId[] } | null = null;
  readonly addTexts: string[] = [];
  constructor(private readonly draft: LedgerV1) {}
  async compile(planPath: string, opts: { orchestratorSessionID: string }): ReturnType<PlanCompiler["compile"]> {
    this.compiled.push(planPath);
    this.compileOpts.push({ ...opts });
    const draft: LedgerV1 = JSON.parse(JSON.stringify(this.draft)) as LedgerV1;
    draft.orchestrator = { sessionID: opts.orchestratorSessionID, boundAt: T0 };
    return {
      ...(this.residuePrompt === null ? {} : { residueRequest: { prompt: this.residuePrompt, schema: {}, taskIds: [] } }),
      draft,
      summary: {
        tasks: Object.keys(draft.tasks).length,
        phases: draft.phases.length,
        edges: draft.edges.length,
        workMs: 0,
        criticalPathMs: 0,
        width: 1,
        expectedMakespanMs: 0,
        manual: [],
        warnings: [],
      },
    };
  }
  mergeResidue(_draft: LedgerV1, responseText: string): ReturnType<PlanCompiler["mergeResidue"]> {
    this.residueTexts.push(responseText);
    if (this.merged === null) throw new ExecutorError("E_RESIDUE", "answer does not match the schema");
    return {
      draft: this.merged,
      summary: {
        tasks: Object.keys(this.merged.tasks).length,
        phases: this.merged.phases.length,
        edges: this.merged.edges.length,
        workMs: 0,
        criticalPathMs: 0,
        width: 1,
        expectedMakespanMs: 0,
        manual: [],
        warnings: ["merged"],
      },
    };
  }
  addTasks(_ledger: LedgerV1, text: string): ReturnType<PlanCompiler["addTasks"]> {
    this.addTexts.push(text);
    if (this.added === null) throw new ExecutorError("E_CYCLE", "cycle");
    return this.added;
  }
  validate(): Array<{ code: string; message: string; taskIds: TaskId[] }> {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------

interface PlanParts {
  writer: LedgerWriter;
  leases: LeaseService;
  waker: Waker;
  listener: IntegrationListener;
  queue: QueueDouble;
  policy: PolicyDouble;
  qa: QaDouble;
}

interface Harness {
  root: string;
  clock: TestClock;
  log: CallLog;
  logs: string[];
  store: LedgerStore;
  slots: SlotPoolDouble;
  registry: RegistryDouble;
  launcher: LauncherDouble;
  verifier: VerifierDouble;
  git: GitDouble;
  hosts: HostsDouble;
  pins: string[];
  unpins: string[];
  compiler: CompilerDouble;
  deps: RuntimeDeps;
  runtime: ExecutorRuntimeHandle;
  parts(): PlanParts;
  ledger(): Readonly<LedgerV1>;
  task(id: TaskId): TaskNode;
  state(id: TaskId): TaskState;
  begin(): Promise<void>;
  runOf(id: TaskId, n: number): Promise<RunDouble>;
  /** Waits for the launch, creates the child session (dispatched -> running) and returns the run. */
  running(id: TaskId, n: number, sessionID: string): Promise<RunDouble>;
  settled(): Promise<void>;
  events(): Promise<ExecutorEvent[]>;
  metrics(): Promise<MetricPayload[]>;
  counters(): Promise<Array<{ key: string; labels: Record<string, string> }>>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    await removeDirWhenReleased(h.root, { deadlineMs: 20_000 });
  }
}, 60_000);

async function mk(draft: LedgerV1, observations?: V2Observations): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "omr-rt-unit-"));
  const clock = new TestClock();
  const proc = new FakeProc(100, "host-a");
  const log: CallLog = [];
  const logs: string[] = [];
  const st: { parts: PlanParts | null } = { parts: null };
  const snap: Snap = () => {
    const l = st.parts?.writer.ledger;
    return l === undefined ? "none" : `${l.status}:${Object.values(l.tasks).map((t) => `${t.id}=${t.state}`).join(",")}`;
  };
  const store = createLedgerStore({
    observations,
    home: join(root, "omr-executor"),
    clock,
    proc,
    warn: (m: string) => {
      logs.push(`store-warn: ${m}`);
    },
    heartbeatMs: 3_600_000,
    staleMs: 7_200_000,
    snapshotEvery: 200,
  });
  const slots = new SlotPoolDouble(log);
  const registry = new RegistryDouble(log);
  const git = new GitDouble();
  const hosts = new HostsDouble();
  const verifier = new VerifierDouble();
  const launcher = new LauncherDouble(log, clock, () => st.parts?.writer.ledger ?? null, snap);
  const pins: string[] = [];
  const unpins: string[] = [];
  const compiler = new CompilerDouble(draft);
  const deps: RuntimeDeps = {
    observations,
    store,
    compiler,
    slots,
    scheduler: createScheduler(),
    launcher,
    routes,
    verifier,
    git,
    hosts,
    clock,
    leaseRegistry: registry,
    recovery: null,
    holder: (sessionID) => holderOf(sessionID, proc.pid, proc.hostname, clock.iso()),
    capacity: (o) => createCapacityController(o),
    collaborators: (i) => {
      const queue = new QueueDouble(log, snap);
      const policy = new PolicyDouble(i.writer, i.leases, slots, clock);
      const qa = new QaDouble();
      st.parts = { writer: i.writer, leases: i.leases, waker: i.waker, listener: i.listener, queue, policy, qa };
      const c: PlanCollaborators = { queue, policy, qa };
      return c;
    },
    pinOrchestrator: (sessionID) => {
      pins.push(sessionID);
      return () => {
        unpins.push(sessionID);
      };
    },
    log: (level, msg, detail) => {
      logs.push(`${level}: ${msg}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    },
    config: () => draft.config,
    // QA-4.2-23: the binding port is required; this harness never adopts through recovery, so it only records.
    bindings: { bind: () => undefined, evict: () => undefined },
    // QA-4.2 NEW-1: the process toplevel is required; every plan of this harness is of this repository.
    toplevel: REPO,
  };
  let closed = false;
  const h: Harness = {
    root,
    clock,
    log,
    logs,
    store,
    slots,
    registry,
    launcher,
    verifier,
    git,
    hosts,
    pins,
    unpins,
    compiler,
    deps,
    runtime: createExecutorRuntime(deps),
    parts: () => need(st.parts, "plan collaborators"),
    ledger: () => need(st.parts, "plan collaborators").writer.ledger,
    task: (id) => need(h.ledger().tasks[id], `task ${id}`),
    state: (id) => h.task(id).state,
    async begin() {
      await h.runtime.compile({ path: `${REPO}/PLAN.md`, sessionID: ORCH });
    },
    async runOf(id, n) {
      await until(() => launcher.runOf(id, n) !== undefined, `launch of ${id}#${n}`);
      return need(launcher.runOf(id, n), `run ${id}#${n}`);
    },
    async running(id, n, sessionID) {
      const run = await h.runOf(id, n);
      await run.child(sessionID);
      return run;
    },
    async settled() {
      await h.runtime.settled();
    },
    async events() {
      return (await store.exportPlan(PLAN_ID)).events;
    },
    async metrics() {
      return (await h.events()).flatMap((e) => (e.type === "metric" ? [e.metric] : []));
    },
    async counters() {
      return (await h.metrics()).flatMap((m) => (m.name === "counter" ? [{ key: m.key, labels: m.labels }] : []));
    },
    async restart() {
      await h.runtime.dispose();
      h.runtime = createExecutorRuntime(deps);
      await h.runtime.start();
    },
    async close() {
      if (closed) return;
      closed = true;
      launcher.gateValue = DISPOSED_GATE;
      launcher.releaseAll();
      try {
        await h.runtime.dispose();
      } catch (e) {
        logs.push(`close failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
  harnesses.push(h);
  return h;
}

/** Q rows 5 + 30 for a verified task: dequeued, then fast-forwarded (slot cleared); Q's own release of leases/slot is separate. */
async function qIntegrate(h: Harness, id: TaskId): Promise<void> {
  await h.parts().writer.append((l) => {
    const t = l.tasks[id];
    if (t === undefined) return [];
    return [
      tr(id, "verified", "integrating", "dequeued"),
      { type: "task-integrated", taskId: id, from: l.integration.head, to: SHA2 },
      tr(id, "integrating", "integrated", "fast-forwarded"),
      { type: "integration-head", head: SHA2 },
      { type: "task-slot", taskId: id, slot: null, branch: t.branch },
    ];
  });
  h.parts().listener.onIntegrated(id);
}

/** Q row 19 + conflict: the rebase conflicts; the attempt context carries the conflict text. */
async function qConflict(h: Harness, id: TaskId, context: string): Promise<void> {
  await h.parts().writer.append((l) => {
    const t = l.tasks[id];
    if (t === undefined) return [];
    return [
      tr(id, "verified", "integrating", "dequeued"),
      { type: "attempt-context", taskId: id, n: t.attempts.length, context },
      tr(id, "integrating", "conflict", "rebase-conflict"),
    ];
  });
  h.parts().listener.onConflict(id);
}

/**
 * Waits for the end of the PASS path of M38: `writer.ledger` shows `verified` as soon as the main journal line is applied,
 * but `appendIf` resolves only after the history copy of `attempt-verdict` (ledger.ts flushHistory), and then the runtime
 * still awaits `countAttempt` before `queue.enqueue` (runtime.ts commitAndVerify). Polling the queue double's log is the
 * observable end of that step.
 */
async function untilEnqueued(h: Harness, id: TaskId): Promise<void> {
  await until(() => h.state(id) === "verified", `${id} verified`);
  await until(() => h.parts().queue.enqueued.some((ids) => ids.includes(id)), `${id} enqueued`);
}

/** Runs the first attempt of `id` through child, completion, commit and verification to `verified` and the enqueue. */
async function toVerified(h: Harness, id: TaskId): Promise<RunDouble> {
  const run = await h.running(id, 1, "ses-c1");
  run.complete("Done. Implemented it.");
  await untilEnqueued(h, id);
  return run;
}

const at = (log: CallLog, prefix: string): number => log.findIndex((l) => l.startsWith(prefix));

function expectOrdered(log: CallLog, prefixes: string[]): void {
  const idx = prefixes.map((p) => at(log, p));
  expect(idx.every((i) => i >= 0), `missing in ${JSON.stringify(log)}: ${JSON.stringify(prefixes)}`).toBe(true);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
}

const ERR_RATE_LIMIT = { type: "provider.rate-limit", status: 429, message: "slow down" };

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe("lifecycle to integrated and done", () => {
  it.each(["required", "deferred", "none"] as const)("opens the phase gate and launches QA when the last read-only task finishes with no changes (%s), without an orchestrator turn", async (verify) => {
    const rows: ObservationRecord[] = [];
    const draft = planOf([
      task("T1"),
      task("T2", { verify, footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } }),
      task("QA", { kind: "qa", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } }),
      task("QA2", { phase: "p2", kind: "qa", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } }),
    ], { edges: [edge("T1", "T2")] });
    draft.phases.push({ ...need(draft.phases[0], "phase"), id: "p2", dependsOn: ["p1"] });
    need(draft.waves[0], "wave").phases.push("p2");
    const h = await mk(draft, createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } }));
    await h.begin();
    const phaseId = need(h.task("T2").phase, "task phase");
    // Play Q's no-suite gate reconciliation on the real ledger; all other queue-double semantics stay unchanged.
    const checked = vi.spyOn(h.parts().queue, "checkPhase").mockImplementation(async (id) => {
      const ph = h.ledger().phases.find((p) => p.id === id);
      if (ph?.gate !== "pending" || !phaseIntegrated(h.ledger(), id)) return;
      if (h.state("T2") === "done") {
        expect(h.task("T2").slot).toBeNull();
        expect(h.slots.byOwner.has(`plan:${PLAN_ID}:T2`)).toBe(false);
        expect(h.registry.heldBy(`${PLAN_ID}:T2`)).toEqual([]);
      }
      await h.parts().writer.append(() => [{
        type: "gate-changed", phaseId: id, from: "pending", to: "awaiting-qa", trigger: "phase-integrated", qaRound: ph.qaRound,
      }]);
      h.parts().listener.onGate(id, "awaiting-qa");
    });
    await toVerified(h, "T1");
    await qIntegrate(h, "T1");
    h.parts().leases.releaseTask("T1");
    await h.slots.release("slot-1");
    await h.parts().queue.checkPhase(phaseId);
    expect(h.ledger().phases.find((p) => p.id === phaseId)?.gate).toBe("pending");
    expect(h.launcher.runOf("QA", 1)).toBeUndefined();
    h.git.dirty = () => false;
    const last = await h.running("T2", 1, "ses-last");
    last.complete("DONE: nothing to change");
    await until(() => h.state("T2") === "done", "last task done");
    const qa = await h.runOf("QA", 1);
    expect((await h.events()).some((e) => e.type === "gate-changed" && e.phaseId === phaseId && e.to === "awaiting-qa")).toBe(true);
    expect(h.ledger().phases.find((p) => p.id === phaseId)?.gate).toBe("qa-running");
    expect(qa.req.attempt).toBe(1);
    await h.runOf("QA2", 1);
    expect((await h.events()).some((e) => e.type === "gate-changed" && e.phaseId === "p2" && e.to === "awaiting-qa")).toBe(true);
    expect(checked.mock.calls.map(([id]) => id)).toEqual(["p1", "p1", "p2"]);
    expect(h.hosts.delivered).toEqual([]);
    expect(rows.filter((r) => r.family === "scheduler" && r.action === "ledger")).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: expect.objectContaining({ edges: expect.arrayContaining([{ from: "T1", to: "T2" }]),
        phases: expect.arrayContaining([expect.objectContaining({ id: phaseId, gate: "awaiting-qa" })]),
        tasks: expect.arrayContaining([expect.objectContaining({ id: "T2", state: "done" })]),
      }) }),
    ]));
  });

  it("launches with a durable nonce, a slot and a lease, then commits, verifies and enqueues (to verified)", async () => {
    const h = await mk(planOf([task("T1", { route: { line: "[route needs=shell,edit]", role: "implementer", tier: "fast", pin: false } })]));
    await h.begin();
    const run = await h.runOf("T1", 1);

    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(h.state("T1")).toBe("dispatched");
    expect(run.durableNonce).toBe(true);
    expect(a1.nonce).toBe(run.req.nonce);
    expect(a1.callID).toBe("call-1");
    expect(h.clock.randoms).toContain(run.req.nonce);
    expect(run.req.context).toEqual({ bootID: GATE_CONTEXT.bootID, epoch: 1, callID: "call-1" });
    expect(run.req.workRoot).toBe(slotPathOf("slot-1"));
    expect(run.req.role).toBe("implementer");
    expect(run.req.route.agent).toBe("implementer");
    expect([...run.req.grant].sort()).toEqual(["edit", "shell"]);
    expect(run.req.prompt).toContain(run.req.nonce);
    expectOrdered(h.log, [
      "slots.acquire:plan:plan-one:T1",
      "slots.reset:slot-1",
      "leases.acquire:plan-one:T1",
      "launcher.launch:T1#1 nonceDurable=true",
    ]);
    expect(h.pins).toEqual([ORCH]);

    await run.child("ses-c1");
    expect(h.state("T1")).toBe("running");
    expect(h.task("T1").attempts[0]?.childSessionID).toBe("ses-c1");
    run.complete("Done. Implemented src/T1.ts.");
    await untilEnqueued(h, "T1");

    const t = h.task("T1");
    expect(t.slot).toBe("slot-1");
    expect(t.branch).toBe(taskBranchName(PLAN_ID, "T1"));
    expect(t.attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "pass" });
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(h.parts().queue.enqueued).toEqual([["T1"]]);
    expect(h.git.calls.map((c) => c.args[0])).toEqual(["worktree", "config", "status", "switch", "add", "commit", "rev-parse"]);
    expect(h.git.calls[2]?.cwd).toBe(slotPathOf("slot-1"));
    expectOrdered(h.log, ["slots.cleanForChecks:slot-1", "queue.enqueue:T1"]);
    expect(h.slots.released).toEqual([]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual(["src/T1.ts"]);
  });

  it("holds leases and the slot until Q's row 30; Rt never releases them on onIntegrated", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await toVerified(h, "T1");
    const mark = h.registry.releases.length;

    await qIntegrate(h, "T1");
    await h.settled();
    expect(h.state("T1")).toBe("integrated");
    expect(h.registry.releases.slice(mark)).toEqual([]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual(["src/T1.ts"]);
    expect(h.slots.released).toEqual([]);

    // Q's own release, after the fsync of its batch.
    h.parts().leases.releaseTask("T1");
    await h.slots.release("slot-1");
    expect(h.registry.releases.slice(mark)).toEqual(["plan-one:T1"]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it.each(["required", "deferred", "none"] as const)("a task with nothing to commit and no declared writes goes straight to done and frees its resources (%s)", async (verify) => {
    const h = await mk(planOf([task("T1", { verify, footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } })]));
    h.git.dirty = () => false;
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Nothing to change.");
    await until(() => h.state("T1") === "done", "T1 done");

    const t = h.task("T1");
    expect(t.slot).toBeNull();
    expect(t.attempts[0]).toMatchObject({ outcome: "succeeded", verdict: null });
    expect(h.parts().queue.enqueued).toEqual([]);
    expect(h.verifier.calls).toEqual([]);
    await until(() => h.slots.released.length === 1, "slot released");
    expect(h.slots.released).toEqual(["slot-1"]);
    expect(h.registry.releases.at(-1)).toBe("plan-one:T1");
    expect((await h.events()).some((e) => e.type === "task-transition" && e.to === "done" && e.trigger === "no-changes")).toBe(true);
  });

  it.each(["manual", "preflight"] as const)("reporting a %s task done checks its phase and transitive QA-only dependent phases", async (kind) => {
    const draft = planOf([
      task("M1", { kind, verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } }),
      task("Q2", { phase: "p2", kind: "qa", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } }),
      task("Q3", { phase: "p3", kind: "qa", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } }),
    ]);
    const phase = need(draft.phases[0], "phase");
    draft.phases.push({ ...phase, id: "p2", dependsOn: [phase.id] }, { ...phase, id: "p3", dependsOn: ["p2"] });
    need(draft.waves[0], "wave").phases.push("p2", "p3");
    const h = await mk(draft);
    await h.begin();
    await until(() => h.state("M1") === "ready", "manual/preflight ready");
    const checked = vi.spyOn(h.parts().queue, "checkPhase").mockImplementation(async (id) => {
      const ph = need(h.ledger().phases.find((p) => p.id === id), "phase");
      if (ph.gate !== "pending" || !phaseIntegrated(h.ledger(), id)) return;
      await h.parts().writer.append(() => [{
        type: "gate-changed", phaseId: id, from: "pending", to: "awaiting-qa", trigger: "phase-integrated", qaRound: ph.qaRound,
      }]);
      h.parts().listener.onGate(id, "awaiting-qa");
    });
    await h.runtime.done(PLAN_ID, "M1", ORCH);
    expect(checked.mock.calls.map(([id]) => id)).toEqual(["p1", "p2", "p3"]);
    await h.runOf("Q2", 1);
    await h.runOf("Q3", 1);
    expect((await h.events()).flatMap((e) => e.type === "gate-changed" && e.to === "awaiting-qa" ? [e.phaseId] : [])).toEqual(["p1", "p2", "p3"]);
  });

  it("a slot release that throws is logged as a warning and the task still ends done", async () => {
    const h = await mk(planOf([task("T1", { footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } })]));
    h.git.dirty = () => false;
    h.slots.release = async () => {
      throw new Error("release boom");
    };
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Nothing to change.");
    await until(() => h.state("T1") === "done", "T1 done");
    await until(() => h.logs.some((l) => l.startsWith("warn: slot release failed")), "slot release warning");
    expect(h.logs.find((l) => l.startsWith("warn: slot release failed"))).toContain("release boom");
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it.each(["required", "deferred", "none"] as const)("M39 amended: a writing task with no diff fails, counts, retries and parks at the attempt bound (%s)", async (verify) => {
    const h = await mk(planOf([task("T1", { verify })], { config: { maxAttempts: 2 } }));
    h.git.dirty = () => false;
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done, I think.");
    const second = await h.running("T1", 2, "ses-c2");

    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1.outcome).toBe("succeeded");
    expect(a1.context).toBe("no changes");
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
    expect((await h.events()).some((e) => e.type === "task-transition" && e.trigger === "commit-failed")).toBe(true);
    expect(second.req.prompt).toContain("no changes");

    second.complete("DONE: already implemented; nothing to change.");
    await until(() => h.state("T1") === "parked", "T1 parked");
    await until(() => h.ledger().inbox.length === 1, "park inbox item");
    await h.settled();
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1, 2]);
    expect(h.parts().policy.parks).toEqual([{ taskId: "T1", cause: "exhausted", text: "no changes" }]);
    expect(h.launcher.runs).toHaveLength(2);
    expect(h.task("T1").attempts.map((a) => a.context)).toEqual(["no changes", "no changes"]);
    expect(h.task("T1").slot).toBeNull();
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
    expect(h.parts().queue.enqueued).toEqual([]);
    expect(h.verifier.calls).toEqual([]);
    const events = await h.events();
    expect(events.filter((e) => e.type === "task-transition" && e.from === "completed" && e.to === "failed" && e.trigger === "commit-failed")).toHaveLength(2);
    expect(events.some((e) => e.type === "task-transition" && e.to === "done")).toBe(false);
  });

  it("a qa task whose report parses goes to QaLoop, ends done and frees its slot", async () => {
    const qa = task("Q1", {
      kind: "qa",
      verify: "none",
      footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] },
    });
    const h = await mk(planOf([qa], { gate: "awaiting-qa" }));
    await h.begin();
    const run = await h.running("Q1", 1, "ses-q");
    expect(h.ledger().phases[0]?.gate).toBe("qa-running");
    run.complete(QA_OK_TEXT);
    await until(() => h.state("Q1") === "done", "Q1 done");
    // qaSuccess: append, then await releaseResources, then QaLoop.onQaResult: wait for the last step.
    await until(() => h.parts().qa.results.length === 1, "QaLoop.onQaResult");

    expect(h.parts().qa.results).toEqual([{ taskId: "Q1", report: { findings: [] } }]);
    expect(h.task("Q1").attempts[0]?.context).toBe(QA_OK_TEXT);
    expect(h.task("Q1").slot).toBeNull();
    await until(() => h.slots.released.length === 1, "qa slot released");
    expect(h.parts().queue.enqueued).toEqual([]);
  });

  it("unparsable qa output fails the first attempt (counted) and parks the second", async () => {
    const qa = task("Q1", {
      kind: "qa",
      verify: "none",
      footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] },
    });
    const h = await mk(planOf([qa], { gate: "awaiting-qa" }));
    await h.begin();
    const first = await h.running("Q1", 1, "ses-q1");
    first.complete("I could not produce the findings document.");
    const second = await h.running("Q1", 2, "ses-q2");
    expect(h.task("Q1").attempts[0]?.context.startsWith(QA_UNPARSABLE_CONTEXT_PREFIX)).toBe(true);
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
    second.complete("Still prose, no JSON.");
    await until(() => h.state("Q1") === "parked", "Q1 parked");

    const park = need(h.parts().policy.parks[0], "park");
    expect(park.cause).toBe("qa-unparsable");
    expect(park.text.startsWith(QA_UNPARSABLE_CONTEXT_PREFIX)).toBe(true);
    expect(h.parts().qa.results).toEqual([]);
  });
});

describe("failure, retry, conflict and commit failure", () => {
  it("a FAIL verdict with attempts left keeps slot and leases, records the findings and relaunches", async () => {
    const h = await mk(planOf([task("T1")]));
    h.verifier.queue.push({ verdict: "fail", findings: "lint failed in src/T1.ts" });
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const mark = h.registry.releases.length;
    run.complete("Done.");
    const second = await h.runOf("T1", 2);

    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1).toMatchObject({ outcome: "succeeded", verdict: "fail", context: "lint failed in src/T1.ts" });
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
    expect(h.parts().policy.parks).toEqual([]);
    expect(h.parts().queue.enqueued).toEqual([]);
    expect(h.registry.releases.slice(mark)).toEqual([]);
    expect(h.slots.released).toEqual([]);
    expect(second.req.attempt).toBe(2);
    expect(second.req.prompt).toContain("lint failed in src/T1.ts");
    expect(second.durableNonce).toBe(true);
    expect(second.req.nonce).not.toBe(run.req.nonce);
    expect((await h.events()).some((e) => e.type === "task-transition" && e.from === "failed" && e.to === "ready" && e.trigger === "retry")).toBe(true);
  });

  it("a FAIL verdict with attempts exhausted parks through the policy with the findings", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 1 } }));
    h.verifier.queue.push({ verdict: "fail", findings: "tests failed" });
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await until(() => h.state("T1") === "parked", "T1 parked");
    // PolicyDouble.park appends the park batch first and the inbox item second: wait for the second append too.
    await until(() => h.ledger().inbox.length === 1, "park inbox item");

    expect(h.parts().policy.parks).toEqual([{ taskId: "T1", cause: "exhausted", text: "tests failed" }]);
    expect(h.launcher.runs).toHaveLength(1);
    expect(h.task("T1").slot).toBeNull();
    expect(h.ledger().inbox.map((i) => ({ kind: i.kind, taskId: i.taskId }))).toEqual([{ kind: "failure", taskId: "T1" }]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it("a conflict resets the slot to the integration head, then the task is ready again with the conflict as context", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await toVerified(h, "T1");
    const resetsBefore = h.slots.resets.length;

    await qConflict(h, "T1", "CONFLICT (content): src/T1.ts");
    const second = await h.runOf("T1", 2);

    expect(h.slots.resets.slice(resetsBefore)[0]).toEqual({ slot: "slot-1", commit: SHA });
    expect(h.task("T1").attempts[0]?.context).toBe("CONFLICT (content): src/T1.ts");
    expect(h.state("T1")).toBe("dispatched");
    expect(second.req.attempt).toBe(2);
    expect(second.req.prompt).toContain("CONFLICT (content): src/T1.ts");
    const ev = await h.events();
    const back = ev.findIndex((e) => e.type === "task-transition" && e.from === "conflict" && e.to === "ready" && e.trigger === "retry");
    expect(back).toBeGreaterThan(-1);
    expect(h.registry.heldBy("plan-one:T1")).toEqual(["src/T1.ts"]);
    expect(h.slots.released).toEqual([]);
  });

  it.each([
    ["a plain git failure", "fatal: something broke"],
    ["a missing git identity", "Author identity unknown"],
  ])("commit failure (%s) fails the attempt with the git message and retries", async (_name, stderr) => {
    const h = await mk(planOf([task("T1")]));
    h.git.failOn = { verb: "commit", stderr };
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await h.runOf("T1", 2);

    expect(h.task("T1").attempts[0]?.context).toBe("git commit failed");
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().queue.enqueued).toEqual([]);
    expect((await h.events()).some((e) => e.type === "task-transition" && e.from === "completed" && e.to === "failed" && e.trigger === "commit-failed")).toBe(true);
  });

  it("row 4b: a malformed route line fails the attempt without a launch and parks when no attempt is left", async () => {
    const h = await mk(
      planOf([task("T1", { route: { line: "task: do it", role: "implementer", tier: "fast", pin: false } })], {
        config: { maxAttempts: 1 },
      }),
    );
    await h.begin();
    await until(() => h.state("T1") === "parked", "T1 parked");

    expect(h.launcher.runs).toHaveLength(0);
    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1.outcome).toBe("failed");
    expect(a1.context.length).toBeGreaterThan(0);
    expect(h.parts().policy.parks[0]).toMatchObject({ taskId: "T1", cause: "exhausted", text: a1.context });
    await until(async () => (await h.counters()).some((c) => c.key === "launch-failed" && c.labels.row === "L1"), "launch-failed L1");
  });

  it("a lease race at launch releases only what the step acquired and skips the task", async () => {
    const h = await mk(planOf([task("T1")]));
    h.slots.onAcquire = () => {
      h.slots.onAcquire = null;
      h.registry.plant("src/T1.ts", "ses-foreign", null);
    };
    await h.begin();
    await until(async () => (await h.counters()).some((c) => c.key === "launch-skipped" && c.labels.reason === "lease-race"), "lease-race counter");

    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("T1")).toBe("ready");
    expect(h.slots.released).toEqual(["slot-1"]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
    expect(h.registry.holderOf("src/T1.ts")).toEqual({ holderID: "ses-foreign", taskRef: null });
  });
});

describe("wakes (D15, M32)", () => {
  const wakeEvents = async (h: Harness): Promise<Array<{ reason: string; stateKey: string }>> =>
    (await h.events()).flatMap((e) => (e.type === "wake" ? [{ reason: e.reason, stateKey: e.stateKey }] : []));
  const manual = (): TaskNode =>
    task("M1", { kind: "manual", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } });

  it("a manual task that becomes ready wakes the orchestrator once, and not again after a restart", async () => {
    const h = await mk(planOf([manual()]));
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "manual-ready wake");

    expect(h.hosts.delivered[0]).toMatchObject({
      sessionID: ORCH,
      resume: true,
      metadata: { planId: PLAN_ID, reason: "manual-ready", stateKey: "manual-ready:M1:0" },
    });
    expect(h.runtime.manualReady(ORCH)).toEqual([{ taskId: "M1", kind: "manual" }]);
    expect(await h.runtime.ready(PLAN_ID)).toEqual({ launchable: [], manual: ["M1"] });
    h.runtime.onRouterToolCall(ORCH);
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.keys()).toEqual(["manual-ready:M1:0"]);

    await h.restart();
    await h.settled();
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.keys()).toEqual(["manual-ready:M1:0"]);
    expect(await wakeEvents(h)).toEqual([{ reason: "manual-ready", stateKey: "manual-ready:M1:0" }]);
    expect(h.runtime.manualReady(ORCH)).toEqual([{ taskId: "M1", kind: "manual" }]);

    await h.runtime.done(PLAN_ID, "M1", ORCH);
    expect(h.state("M1")).toBe("done");
    expect(h.runtime.manualReady(ORCH)).toEqual([]);
  });

  it("a stale context wakes exactly once per state key; a new key inside the debounce is retried after it", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "first stale-context wake");
    h.runtime.onRouterToolCall(ORCH);
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.keys()).toEqual(["stale-context:boot:1"]);
    expect(h.launcher.runs).toHaveLength(0);

    h.launcher.gateValue = staleGate("stale-context:boot:2");
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.keys()).toEqual(["stale-context:boot:1"]);
    expect(h.clock.pendingTimers()).toBeGreaterThan(0);
    // QA-3.1-5: a debounced wake is not an attempt and is not journaled.
    expect((await h.metrics()).some((m) => m.name === "wake" && m.stateKey === "stale-context:boot:2")).toBe(false);

    h.clock.advance(1000);
    await until(() => h.hosts.delivered.length === 2, "debounced retry");
    expect(h.hosts.keys()).toEqual(["stale-context:boot:1", "stale-context:boot:2"]);
    await h.settled();
    expect((await wakeEvents(h)).map((w) => w.stateKey)).toEqual(["stale-context:boot:1", "stale-context:boot:2"]);
  });

  it("a failed delivery is retried at least a debounce later as #2, then #3, and then stops", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    h.hosts.failures = 2;
    await h.begin();
    await until(() => h.hosts.attempted.length === 1, "first attempt");
    expect(h.hosts.attempted).toEqual(["stale-context:boot:1"]);

    h.clock.advance(1000);
    await until(() => h.hosts.attempted.length === 2, "retry #2");
    h.clock.advance(1000);
    await until(() => h.hosts.attempted.length === 3, "retry #3");
    expect(h.hosts.attempted).toEqual(["stale-context:boot:1", "stale-context:boot:1#2", "stale-context:boot:1#3"]);
    expect(h.hosts.keys()).toEqual(["stale-context:boot:1#3"]);

    h.runtime.onRouterToolCall(ORCH);
    h.clock.advance(5000);
    await h.settled();
    expect(h.hosts.attempted).toHaveLength(3);
  });

  it("three failed deliveries give up and count wake-failed", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    h.hosts.failures = 3;
    await h.begin();
    await until(() => h.hosts.attempted.length === 1, "first attempt");
    h.clock.advance(1000);
    await until(() => h.hosts.attempted.length === 2, "retry #2");
    h.clock.advance(1000);
    await until(() => h.hosts.attempted.length === 3, "retry #3");
    await until(async () => (await h.counters()).some((c) => c.key === "wake-failed" && c.labels.reason === "stale-context"), "wake-failed counter");

    h.runtime.onRouterToolCall(ORCH);
    h.clock.advance(5000);
    await h.settled();
    expect(h.hosts.attempted).toHaveLength(3);
    expect(h.hosts.delivered).toEqual([]);
  });
});

describe("launch step edges (M37)", () => {
  const counterWith = async (h: Harness, key: string, label: string, value: string): Promise<boolean> =>
    (await h.counters()).some((c) => c.key === key && c.labels[label] === value);

  it("a slot pool without a free slot skips the launch as 'slot-unavailable' and leaves the task ready", async () => {
    const h = await mk(planOf([task("T1")]));
    h.slots.acquire = async () => {
      throw new ExecutorError("E_SLOT_UNAVAILABLE", "no slot");
    };
    await h.begin();
    await until(() => counterWith(h, "launch-skipped", "reason", "slot-unavailable"), "slot-unavailable counter");
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("T1")).toBe("ready");
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it("any other slot error skips the launch as 'provision'", async () => {
    const h = await mk(planOf([task("T1")]));
    h.slots.acquire = async () => {
      throw new Error("disk gone");
    };
    await h.begin();
    await until(() => counterWith(h, "launch-skipped", "reason", "provision"), "provision counter");
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("T1")).toBe("ready");
  });

  it("a context that goes stale between the tick and the launch abandons the step and frees what it took", async () => {
    const h = await mk(planOf([task("T1")]));
    h.slots.onAcquire = () => {
      h.slots.onAcquire = null;
      h.launcher.gateValue = DISPOSED_GATE;
    };
    await h.begin();
    await until(() => h.slots.released.length === 1, "slot released by the abandoned step");
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("T1")).toBe("ready");
    expect(h.task("T1").attempts).toEqual([]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it("a phase paused between the tick and the dispatch batch makes row 4 write nothing; the step frees what it took", async () => {
    const h = await mk(planOf([task("T1")]));
    h.slots.onAcquire = () => {
      h.slots.onAcquire = null;
      // Queued on the writer before row 4's batch, so the batch sees the phase paused.
      void h.parts().writer.append([{ type: "phase-paused", phaseId: "p1", paused: true, reason: "test" }]);
    };
    await h.begin();
    await until(() => h.slots.released.length === 1, "slot released by the abandoned step");
    expect(h.ledger().phases[0]?.paused).toBe(true);
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.task("T1").attempts).toEqual([]);
    expect(h.state("T1")).toBe("ready");
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it("a git failure while preparing the prompt skips the launch as 'provision' and frees the fresh slot", async () => {
    const h = await mk(planOf([task("T1")]));
    h.git.failOn = { verb: "worktree", stderr: "fatal: not a git repository" };
    await h.begin();
    await until(() => h.slots.released.length === 1, "slot released");
    expect(h.slots.released).toEqual(["slot-1"]);
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.task("T1").attempts).toEqual([]);
    await until(async () => (await h.counters()).some((c) => c.key === "launch-skipped" && c.labels.reason === "provision"), "provision counter");
  });

  it("a launcher that throws E_LAUNCH_TASK (L2) fails the attempt and counts it", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.launchFailure = new ExecutorError("E_LAUNCH_TASK", "bad route");
    await h.begin();
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "failed" });
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
    expect(await counterWith(h, "launch-failed", "row", "L2")).toBe(true);
  });

  it("a launcher that throws E_NO_CONTEXT (L3) loses the attempt with 'no-context' and relaunches", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.launchFailure = new ExecutorError("E_NO_CONTEXT", "no context");
    await h.begin();
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
    expect(h.parts().policy.counted).toEqual([]);
    expect(await counterWith(h, "launch-failed", "row", "L3")).toBe(true);
  });

  it("a launcher that throws an unknown error (L4) loses the attempt as 'launch-error'", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.launchFailure = new Error("spawn failed");
    await h.begin();
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
    expect(await counterWith(h, "launch-failed", "row", "L4")).toBe(true);
  });

  it("a launcher that is disposed (E_DISPOSED) releases only the capacity token", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.launchFailure = new ExecutorError("E_DISPOSED", "disposed");
    await h.begin();
    await until(async () => (await counterWith(h, "launch-failed", "row", "L4")), "launch-failed counter");
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("T1")).toBe("dispatched");
  });
});

describe("confirmations and child ends (rows 11, 12, 16, 18)", () => {
  const counterWith = async (h: Harness, key: string, label: string, value: string): Promise<boolean> =>
    (await h.counters()).some((c) => c.key === key && c.labels[label] === value);

  it("a task-error confirmation fails the attempt (counted) with the launcher's message and retries", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    run.confirm({ kind: "unconfirmed", reason: "task-error", error: "unknown model" });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "failed", context: "unknown model" });
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
    expect(await counterWith(h, "launch-failed", "row", "L8")).toBe(true);
  });

  it("a task-error confirmation without a message falls back to 'task error'", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    run.confirm({ kind: "unconfirmed", reason: "task-error", error: null });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]?.context).toBe("task error");
  });

  it.each([
    ["superseded", "L5"],
    ["threw", "L6"],
    ["timeout", "L7"],
    ["hook-failed", "L9"],
  ] as const)("a '%s' confirmation loses the dispatched attempt uncounted (%s) and relaunches", async (reason, row) => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    run.confirm({ kind: "unconfirmed", reason, error: null });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
    expect(h.parts().policy.counted).toEqual([]);
    expect(await counterWith(h, "launch-failed", "row", row)).toBe(true);
  });

  it("a confirmation that arrives after the child started changes nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    await run.hooks.onChildCreated("ses-c1");
    run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await pause(30);
    expect(h.state("T1")).toBe("running");
    expect(h.task("T1").attempts[0]?.outcome).toBeNull();
    expect(h.launcher.runs).toHaveLength(1);
  });

  it("a child that ends 'lost' while still dispatched is uncounted and relaunched (row 11)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    run.end({ kind: "lost", childSessionID: null, reason: "restart", endedAt: h.clock.iso() });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
    expect(h.parts().policy.counted).toEqual([]);
  });

  it("an end of kind 'capacity' returns the running task to ready, uncounted", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.end({ kind: "capacity", childSessionID: "ses-c1", error: ERR_RATE_LIMIT, endedAt: h.clock.iso() });
    await h.runOf("T1", 2);
    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1.outcome).toBe("capacity");
    expect(countsTowardMaxAttempts(a1)).toBe(false);
    expect(h.parts().policy.counted).toEqual([]);
  });

  it("an end of a task that is not running (here: still dispatched, 'completed') is ignored", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    run.complete("Done before the child was journaled.");
    await pause(30);
    expect(h.state("T1")).toBe("dispatched");
    expect(h.task("T1").attempts[0]?.outcome).toBeNull();
    expect(h.verifier.calls).toEqual([]);
  });

  it.each([
    ["ESCALATE: need a decision\nplease advise", "escalate"],
    ["NEED CONTEXT: which API?", "ambiguity"],
    ["SCOPE GROWTH: this is bigger than planned", "ambiguity"],
    ["NEED MORE: something else entirely", "ambiguity"],
  ] as const)("child text %j parks the task through the policy as '%s'", async (text, cause) => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete(text);
    await until(() => h.state("T1") === "parked", "T1 parked");
    expect(h.parts().policy.parks).toEqual([{ taskId: "T1", cause, text }]);
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().queue.enqueued).toEqual([]);
  });

  it("a qa task whose unparsable output starts with a lease request is treated as a lease request, not as bad output", async () => {
    const qa = task("Q1", {
      kind: "qa",
      verify: "none",
      footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] },
    });
    const h = await mk(planOf([qa], { gate: "awaiting-qa" }));
    await h.begin();
    const run = await h.running("Q1", 1, "ses-q1");
    run.complete("NEED MORE: lease src/extra.ts\nI need to write a file.");
    await h.runOf("Q1", 2);
    expect(h.task("Q1").footprint.writes).toEqual(["src/extra.ts"]);
    expect(h.task("Q1").attempts[0]).toMatchObject({ outcome: "interrupted" });
    expect(h.parts().qa.results).toEqual([]);
  });

  it("a stale end for an attempt that is no longer open does nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const old = await h.runOf("T1", 1);
    old.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    const fresh = await h.runOf("T1", 2);
    const before = h.task("T1").attempts.map((a) => a.outcome);
    old.complete("late");
    await pause(30);
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(before);
    expect(fresh.settled).toBe(false);
  });
});

describe("verification outcomes", () => {
  it("a verifier that throws counts as 'unverifiable': the attempt fails with the error text and retries", async () => {
    const h = await mk(planOf([task("T1")]));
    h.verifier.verify = async () => {
      throw new Error("checks crashed");
    };
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "unverifiable", context: "checks crashed" });
    expect(h.parts().queue.enqueued).toEqual([]);
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
  });

  it("an 'unverifiable' verdict from the verifier is a failure like 'fail'", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 1 } }));
    h.verifier.queue.push({ verdict: "unverifiable", findings: "no test runner" });
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await until(() => h.state("T1") === "parked", "T1 parked");
    expect(h.parts().policy.parks).toEqual([{ taskId: "T1", cause: "exhausted", text: "no test runner" }]);
  });

  it("an attempt context that is empty parks with the 'attempts exhausted' text", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 1 } }));
    h.verifier.queue.push({ verdict: "fail", findings: "" });
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await until(() => h.state("T1") === "parked", "T1 parked");
    expect(h.parts().policy.parks).toEqual([{ taskId: "T1", cause: "exhausted", text: "attempts exhausted (1)" }]);
  });

  it("a git failure while inspecting the slot fails the attempt with the git message instead of throwing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    h.git.failOn = { verb: "status", stderr: "fatal: not a git repository" };
    run.complete("Done.");
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]?.context).toBe("git status failed");
    expect(h.verifier.calls).toEqual([]);
  });
});

describe("integration listener (Q -> Rt)", () => {
  it("onFailed counts the last attempt and retries the task Q failed", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await toVerified(h, "T1");
    await h.parts().writer.append([tr("T1", "verified", "integrating", "dequeued"), tr("T1", "integrating", "failed", "checks-failed")]);
    h.parts().listener.onFailed("T1");
    await h.runOf("T1", 2);
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1, 1]);
    expect((await h.events()).some((e) => e.type === "task-transition" && e.from === "failed" && e.to === "ready" && e.trigger === "retry")).toBe(true);
  });

  it("onGate 'awaiting-qa' tells the QA loop; any other gate only re-ticks", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    h.parts().listener.onGate("p1", "awaiting-qa");
    await until(() => h.parts().qa.awaiting.length === 1, "onAwaitingQa");
    expect(h.parts().qa.awaiting).toEqual(["p1"]);
    h.parts().listener.onGate("p1", "qa-running");
    await pause(30);
    expect(h.parts().qa.awaiting).toEqual(["p1"]);
  });

  it("onInbox wakes the orchestrator once per inbox id", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    const item: InboxItem = {
      id: formatInboxId("question", 1),
      kind: "question",
      severity: "blocking",
      taskId: "T1",
      text: "which one?",
      options: [],
      answer: null,
      createdAt: T0,
    };
    const key = `inbox:${item.id}`;
    h.parts().listener.onInbox(item);
    await until(() => h.hosts.keys().includes(key), "inbox wake");
    h.parts().listener.onInbox(item);
    await pause(30);
    expect(h.hosts.keys().filter((k) => k === key)).toHaveLength(1);
  });

  it("a listener call after dispose is ignored", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1"); // confirmed: dispose waits for an unconfirmed launch, never for a live child
    const listener = h.parts().listener;
    await h.runtime.dispose();
    const launches = h.launcher.runs.length;
    listener.onIntegrated("T1");
    listener.onFailed("T1");
    await pause(30);
    expect(h.launcher.runs).toHaveLength(launches);
  });
});

describe("restart: lease rebuild, slot lookup and capacity restore", () => {
  it("a lease that cannot be re-taken after restart is counted and raised as a blocking item", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    const release = h.registry.releaseTask.bind(h.registry);
    h.registry.releaseTask = (ref: string): void => {
      release(ref);
      h.registry.plant("src/T1.ts", "ses-foreign", null);
    };
    await h.restart();
    await until(() => h.parts().policy.raised.length === 1, "lease rebuild item");
    const raised = need(h.parts().policy.raised[0], "raised item");
    expect(raised).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T1" });
    // QA-4.2-26: the item also says the task is held and what ends the hold.
    expect(raised.text).toBe(
      "could not re-take the leases of T1 after restart; held by ses-foreign. " +
        "T1 is held (no adopt, commit, verify or enqueue) until its leases are free: finish or abort the holder " +
        "(or abort T1); it resumes on its own once the leases are released",
    );
    await until(async () => (await h.counters()).some((c) => c.key === "lease-rebuild-failed" && c.labels.taskId === "T1"), "lease-rebuild-failed counter");
  });

  it("after a restart the slot of a finishing child is looked up again and the task is verified", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.restart();
    await h.runtime.onChildEnd("T1", 1, { kind: "completed", childSessionID: "ses-c1", text: "Done.", endedAt: h.clock.iso() });
    await untilEnqueued(h, "T1");
    expect(h.task("T1").slot).toBe("slot-1");
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(h.git.calls.some((c) => c.args[0] === "commit" && c.cwd === slotPathOf("slot-1"))).toBe(true);
  });

  it("after a restart a slot whose record is gone fails the commit step and the task is retried", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.restart();
    h.slots.records.clear();
    await h.runtime.onChildEnd("T1", 1, { kind: "completed", childSessionID: "ses-c1", text: "Done.", endedAt: h.clock.iso() });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", context: "slot record missing" });
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
  });

  it("a slot lookup that throws on restart is logged and the task is rebuilt without a tree", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.slots.get = async () => {
      throw new Error("registry unreadable");
    };
    await h.restart();
    expect(h.logs.some((l) => l.startsWith("warn: slot lookup failed") && l.includes("registry unreadable"))).toBe(true);
    expect(h.parts().policy.raised).toEqual([]);
  });

  it("a capacity restore that fails on restart is logged and the plan still attaches", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1"); // confirmed, so the restart's dispose does not wait for the launch
    const real = h.store.exportPlan.bind(h.store);
    h.store.exportPlan = async () => {
      throw new Error("history unreadable");
    };
    await h.restart();
    expect(h.logs.some((l) => l.startsWith("warn: capacity restore failed") && l.includes("history unreadable"))).toBe(true);
    h.store.exportPlan = real;
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);
  });
});

describe("learned edge and lease needs (M13: rows 18b, 18b', R6)", () => {
  const needMore = (path: string): string => `NEED MORE: lease ${path}\nI must also edit it.`;

  it("18b: the holder is a plan task -> learned edge, footprint grows, the task goes back to pending and frees its slot", async () => {
    const h = await mk(planOf([task("T1"), task("T2")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    const run2 = await h.running("T2", 1, "ses-c2");
    const slot2 = need(h.task("T2").slot, "T2 slot");
    run2.complete(needMore("src/T1.ts"));
    await until(() => h.state("T2") === "pending", "T2 pending");

    expect(h.ledger().edges.filter((e) => e.kind === "learned")).toEqual([
      { from: "T1", to: "T2", kind: "learned", confidence: expect.any(String) as unknown as Edge["confidence"], evidence: "NEED MORE: lease src/T1.ts" },
    ]);
    const t2 = h.task("T2");
    expect(t2.footprint.writes).toEqual(["src/T2.ts", "src/T1.ts"]);
    expect(t2.footprint.sources).toContain("learned");
    expect(t2.slot).toBeNull();
    expect(t2.attempts[0]).toMatchObject({ outcome: "interrupted", context: "NEED MORE: lease src/T1.ts" });
    await until(() => h.slots.released.includes(slot2), "T2 slot released");
    expect(h.registry.heldBy("plan-one:T2")).toEqual([]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual(["src/T1.ts"]);
    expect(h.state("T1")).toBe("running");
    await until(async () => (await h.counters()).some((c) => c.key === "learned-edge" && c.labels.result === "added"), "learned-edge added");
  });

  it("18b': the path is free -> the footprint grows and the task is relaunched with the new lease", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete(needMore("src/extra.ts"));
    const second = await h.runOf("T1", 2);

    expect(h.ledger().edges).toEqual([]);
    expect(h.task("T1").footprint.writes).toEqual(["src/T1.ts", "src/extra.ts"]);
    expect(h.task("T1").footprint.sources).toContain("learned");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "interrupted" });
    expect(second.req.attempt).toBe(2);
    const last = need(h.registry.acquires.at(-1), "last acquire");
    expect(last).toMatchObject({ taskRef: "plan-one:T1", writes: ["src/T1.ts", "src/extra.ts"] });
    expect(h.slots.released).toEqual(["slot-1"]);
    await until(async () => (await h.counters()).some((c) => c.key === "learned-edge" && c.labels.result === "free"), "learned-edge free");
  });

  it("R6: a holder outside the plan makes the request unresolvable; the attempt fails (counted) and retries", async () => {
    const h = await mk(planOf([task("T1")]));
    h.registry.plant("src/other.ts", "ses-foreign-child", null);
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete(needMore("src/other.ts"));
    await h.runOf("T1", 2);

    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1.outcome).toBe("failed");
    expect(a1.context).toBe("lease-unresolvable: NEED MORE: lease src/other.ts");
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
    expect(h.ledger().edges).toEqual([]);
    expect((await h.events()).some((e) => e.type === "task-transition" && e.trigger === "lease-unresolvable")).toBe(true);
    await until(async () => (await h.counters()).some((c) => c.key === "learned-edge" && c.labels.result === "foreign"), "learned-edge foreign");
  });

  it("R6: an illegal path (absolute) is unresolvable too", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete(needMore("C:/elsewhere/file.ts"));
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]?.outcome).toBe("failed");
    expect(h.task("T1").footprint.writes).toEqual(["src/T1.ts"]);
  });

  it("R6: an edge that already exists is not added again (exists), the attempt fails", async () => {
    const h = await mk(planOf([task("T1", { state: "done" }), task("T2")], { edges: [edge("T1", "T2")] }));
    await h.begin();
    h.registry.plant("src/stale.ts", "plan:plan-one:T1", "plan-one:T1"); // after attach: rebuild releases the plan's refs
    const run = await h.running("T2", 1, "ses-c2");
    run.complete(needMore("src/stale.ts"));
    await h.runOf("T2", 2);

    expect(h.task("T2").attempts[0]?.outcome).toBe("failed");
    expect(h.ledger().edges).toHaveLength(1);
    await until(async () => (await h.counters()).some((c) => c.key === "learned-edge" && c.labels.result === "exists"), "learned-edge exists");
  });

  it("R6: an edge that would close a cycle is refused (cycle), the attempt fails", async () => {
    const h = await mk(planOf([task("T1"), task("T2")], { edges: [edge("T2", "T1")] }));
    await h.begin();
    h.registry.plant("src/stale.ts", "plan:plan-one:T1", "plan-one:T1");
    const run = await h.running("T2", 1, "ses-c2");
    run.complete(needMore("src/stale.ts"));
    await h.runOf("T2", 2);

    expect(h.task("T2").attempts[0]?.outcome).toBe("failed");
    expect(h.ledger().edges).toEqual([edge("T2", "T1")]);
    await until(async () => (await h.counters()).some((c) => c.key === "learned-edge" && c.labels.result === "cycle"), "learned-edge cycle");
  });
});

describe("dispose with a live child (3.1.8 regression)", () => {
  it("dispose returns while a confirmed child still runs: the launcher is disposed first and the child's end is never awaited", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-live");
    // `settled()` is not awaited here: it includes the wait for this live child, which ends only with the child
    await until(() => h.state("T1") === "running", "T1 running");
    expect(run.settled).toBe(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((resolve) => {
      timer = setTimeout(() => resolve("hung"), 5_000);
    });
    try {
      const outcome = await Promise.race([h.runtime.dispose().then(() => "disposed" as const), hung]);
      expect(outcome).toBe("disposed");
    } finally {
      clearTimeout(timer);
    }
    expect(h.launcher.disposed).toBe(1);
    expect(run.settled).toBe(false); // the runtime ended nothing itself: the launcher's dispose aborts the child
  });
});

describe("capacity, lost streak and abort", () => {
  it("a capacity stop is uncounted (outcome capacity, no recordAttempt); a non-plan session's retry is untouched", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const step = (sessionID: string): void =>
      h.runtime.onHostEvent({ type: "step.started", sessionID, providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    step("ses-c1");
    step("ses-other");

    // First signal of the step: it only registers; nothing is stopped yet.
    expect(h.runtime.onRetryHook({ sessionID: "ses-c1", stepKey: "s1", error: ERR_RATE_LIMIT })).toEqual({ stop: false });
    h.clock.advance(11_000);
    expect(h.runtime.onRetryHook({ sessionID: "ses-c1", stepKey: "s1", error: ERR_RATE_LIMIT })).toEqual({ stop: true });

    // A session that is not a plan child keeps its own retry, even past the cooldown.
    expect(h.runtime.isPlanChild("ses-c1")).toBe(true);
    expect(h.runtime.isPlanChild("ses-other")).toBe(false);
    expect(h.runtime.onRetryHook({ sessionID: "ses-other", stepKey: "o1", error: ERR_RATE_LIMIT })).toEqual({ stop: false });
    h.clock.advance(11_000);
    expect(h.runtime.onRetryHook({ sessionID: "ses-other", stepKey: "o1", error: ERR_RATE_LIMIT })).toEqual({ stop: false });

    run.end({ kind: "failed", childSessionID: "ses-c1", error: ERR_RATE_LIMIT, endedAt: h.clock.iso() });
    await h.runOf("T1", 2);

    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1.outcome).toBe("capacity");
    expect(countsTowardMaxAttempts(a1)).toBe(false);
    expect(h.parts().policy.counted).toEqual([]);
    expect(h.slots.released).toEqual([]);
    const ev = await h.events();
    expect(ev.some((e) => e.type === "task-transition" && e.from === "running" && e.to === "ready" && e.trigger === "capacity-stop")).toBe(true);
    expect((await h.metrics()).some((m) => m.name === "capacity" && m.provider === PROVIDER && m.change === "decrease")).toBe(true);
  });

  it("a non-capacity failure of a plan child fails the attempt (counted) and a plain retry follows", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.end({ kind: "failed", childSessionID: "ses-c1", error: { type: "provider.internal", status: 500, message: "boom" }, endedAt: h.clock.iso() });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "failed", context: "provider.internal: boom" });
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
  });

  it("three consecutive lost children pause the plan, raise one blocking item and count nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    for (let n = 1; n <= 3; n++) {
      const run = await h.running("T1", n, `ses-c${n}`);
      run.end({ kind: "lost", childSessionID: `ses-c${n}`, reason: "unrequested-interrupt", endedAt: h.clock.iso() });
      if (n < 3) await h.runOf("T1", n + 1);
    }
    await until(() => h.ledger().status === "paused" && h.parts().policy.raised.length === 1, "plan paused with an inbox item");

    const raised = need(h.parts().policy.raised[0], "raised item");
    expect(raised).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T1" });
    expect(raised.text).toContain("lost 3 consecutive attempts");
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost", "lost", "lost"]);
    expect(h.task("T1").attempts.some(countsTowardMaxAttempts)).toBe(false);
    expect(h.launcher.runs).toHaveLength(3);
    expect(h.state("T1")).toBe("ready");
    await until(async () => (await h.counters()).some((c) => c.key === "lost-streak-pause" && c.labels.taskId === "T1"), "lost-streak-pause counter");
  });

  it("a different loss reason resets the streak", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const reasons = ["unrequested-interrupt", "unrequested-interrupt", "restart", "unrequested-interrupt", "unrequested-interrupt"] as const;
    for (let i = 0; i < reasons.length; i++) {
      const run = await h.running("T1", i + 1, `ses-c${i + 1}`);
      run.end({ kind: "lost", childSessionID: `ses-c${i + 1}`, reason: reasons[i] ?? "restart", endedAt: h.clock.iso() });
      await h.runOf("T1", i + 2);
    }
    expect(h.ledger().status).toBe("running");
    expect(h.parts().policy.raised).toEqual([]);
  });

  it("abort follows A1-8: latch, queue.abort first, one batch ending in aborted, then cancel of live children", async () => {
    const h = await mk(planOf([task("T1"), task("T2")], { edges: [edge("T1", "T2")] }));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const slot1 = need(h.task("T1").slot, "T1 slot");

    await h.runtime.abort(PLAN_ID, ORCH);
    await until(() => h.slots.released.includes(slot1), "T1 slot released after the cancel settled");

    expect(h.log.find((l) => l.startsWith("queue.abort"))).toBe("queue.abort running:T1=running,T2=pending");
    expect(h.log.find((l) => l.startsWith("launcher.cancel"))).toBe("launcher.cancel:T1#1:abort aborted:T1=cancelled,T2=cancelled");
    expectOrdered(h.log, ["queue.abort", "launcher.cancel:T1#1:abort", `slots.release:${slot1}`]);
    expect(run.cancelReasons).toEqual(["abort"]);
    expect(h.ledger().status).toBe("aborted");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "interrupted" });
    expect(h.task("T1").slot).toBeNull();
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
    expect(h.registry.releases).toContain("plan-one:T2");

    const ev = await h.events();
    const abortedSeq = need(ev.find((e) => e.type === "status-changed" && e.to === "aborted"), "aborted event").seq;
    const cancels = ev.filter((e) => e.type === "task-transition" && e.trigger === "abort");
    expect(cancels).toHaveLength(2);
    expect(cancels.every((e) => e.seq < abortedSeq)).toBe(true);

    // The latch holds: nothing is launched or enqueued afterwards.
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.launcher.runs).toHaveLength(1);
  });
});

describe("late child adoption and the launch race (M27)", () => {
  const unconfirmed = (run: RunDouble): void => run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });

  it("QA-3.1-1 (L12): a lost launch whose child shows up late is adopted and finishes through host events delivered by hosts.onEvent", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.runtime.start();
    await h.begin();
    const run = await h.runOf("T1", 1);
    h.launcher.gateValue = staleGate("stale-context:boot:1"); // the timeout marked the context stale: no relaunch
    unconfirmed(run);
    await until(() => h.state("T1") === "ready", "T1 back to ready (row 11)");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost", endedAt: expect.any(String) as unknown as string });
    expect(h.task("T1").slot).toBe("slot-1");

    expect(await run.hooks.onLateChild("ses-late")).toBe("adopt");
    await run.hooks.onChildCreated("ses-late");
    expect(h.state("T1")).toBe("running");
    expect(h.task("T1").attempts[0]).toMatchObject({ n: 1, childSessionID: "ses-late", outcome: null, endedAt: null });
    expect((await h.events()).some((e) => e.type === "attempt-adopted" && e.taskId === "T1")).toBe(true);
    expect(h.launcher.runs).toHaveLength(1);
    // The timeout already settled the launch completion (lost/unconfirmed): only host events can end this child.
    expect(run.settled).toBe(true);
    await until(async () => (await h.counters()).some((c) => c.key === "launch-failed" && c.labels.row === "L12"), "launch-failed L12");

    h.hosts.contexts.set("ses-late", { messages: [{ role: "assistant", text: "Done after all.", outcome: null }] });
    h.hosts.emit({ type: "execution.completed", sessionID: "ses-late", at: h.clock.iso() });
    await untilEnqueued(h, "T1");
    expect(h.parts().queue.enqueued).toEqual([["T1"]]);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "pass" });
  });

  it("after a relaunch the late child of the old attempt is refused; a timed-out launch is settled, so not cancelled", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const old = await h.runOf("T1", 1);
    unconfirmed(old);
    const fresh = await h.runOf("T1", 2);

    expectOrdered(h.log, ["launcher.launch:T1#1", "launcher.launch:T1#2"]);
    expect(old.settled).toBe(true);
    expect(await old.hooks.onLateChild("ses-late")).toBe("refuse");
    await until(async () => (await h.counters()).some((c) => c.key === "launch-failed" && c.labels.row === "L11"), "launch-failed L11");
    await expect(old.hooks.onChildCreated("ses-late")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(h.state("T1")).toBe("dispatched");
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost", null]);
    expect(h.task("T1").attempts[1]?.nonce).toBe(fresh.req.nonce);
    expect(h.task("T1").attempts[1]?.childSessionID).toBeNull();
  });
});

/** Real pool/marker transitions; only git and provisioning are doubles. No diagnostic pool queries in the runtime. */
async function physicalPool(h: Harness, maxParallel: number) {
  const fs = createNodeFileSystem(), heads = new Map<string, string>();
  // Windows temp roots can contain an 8.3 alias; the real pool deliberately rejects non-canonical roots.
  const root = await fs.realpath(h.root);
  const unused = async (): Promise<never> => { throw new Error("unexpected pool git operation"); };
  const git: GitOps = {
    planId: PLAN_ID, version: unused, checkRefFormat: unused, worktreeList: unused, worktreeRemove: unused,
    addAll: unused, commit: unused, rebaseOnto: unused, rebaseAbort: unused, cherryPick: unused, revert: unused,
    mergeFfOnly: unused, isAncestor: unused, tag: unused, deleteRefs: unused, branchForce: unused,
    async worktreeAdd(path, commit) { await fs.mkdir(path); heads.set(path, commit); },
    async verifySlotPointers() { return { gitdir: "unused", common: "unused" }; },
    async checkoutDetach(path, commit) { heads.set(path, commit); },
    async revParse(path, rev) { return rev === "HEAD" ? heads.get(path) ?? SHA : rev; },
    async cleanTracked() {}, async cleanForChecks() {}, async cleanPreview() { return []; },
    async trackedLinks() { return []; }, async lsFiles() { return []; }, async statusPorcelain() { return []; },
    async diffNames() { return []; },
  };
  const pool = createSlotPool({ planId: PLAN_ID, repoKey: "repo-key", toplevel: REPO,
    slotsDir: join(root, "physical-slots"), markersDir: join(root, "markers"), executorHome: root,
    maxParallel, fs, git, clock: h.clock,
    provisioner: { detect: async () => ({ managers: [], manifests: {}, yarnBerry: false, editable: false, python: null }), provision: async () => {} } });
  await pool.open();
  h.deps.slots = pool;
  return { pool, fs, git };
}

describe("launch slot preparation", () => {
  it.each([false, true])("resets a reused ready slot exactly once before launch (observations=%s)", async (observed) => {
    const rows: ObservationRecord[] = [];
    const sink = observed ? createV2Observations({ write: line => { rows.push(JSON.parse(line)); } }) : undefined;
    const h = await mk(planOf([task("T1")], { config: { maxParallel: 1 } }), sink);
    const { pool, git } = await physicalPool(h, 1);
    try {
      const ready = await pool.acquire(PLAN_ID, `plan:${PLAN_ID}:previous`, SHA2);
      await pool.release(ready.slot);
      expect(await pool.get(ready.slot)).toMatchObject({ state: "ready", commit: SHA2 });
      const checkout = vi.spyOn(git, "checkoutDetach"), clean = vi.spyOn(git, "cleanTracked");
      const pointers = vi.spyOn(git, "verifySlotPointers"), status = vi.spyOn(git, "statusPorcelain");
      await h.begin();
      const run = await h.runOf("T1", 1);

      expect(run.req.workRoot).toBe(ready.path);
      expect(checkout).toHaveBeenCalledTimes(1);
      expect(checkout).toHaveBeenCalledWith(ready.path, SHA);
      expect(clean).toHaveBeenCalledTimes(1);
      expect(pointers).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledTimes(1);
      expect(await pool.get(ready.slot)).toMatchObject({ state: "leased", owner: `plan:${PLAN_ID}:T1`, commit: SHA });
      sink?.flush();
      if (observed) {
        expect(rows.filter(r => r.family === "scheduler" && r.action === "slot-reset-start")).toHaveLength(1);
        expect(rows.filter(r => r.family === "scheduler" && r.action === "slot-reset-end")).toHaveLength(1);
        expect(rows.filter(r => r.family === "scheduler" && r.action === "slot-acquire-result")).toContainEqual(expect.objectContaining({
          state: expect.objectContaining({ detail: expect.objectContaining({ taskId: "T1", mode: "reset", result: "reused" }) }),
        }));
      } else expect(rows).toEqual([]);
    } finally {
      await h.close(); sink?.close(); pool.close();
    }
  });

  it("resets again to the current integration head when it moved during acquisition", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxParallel: 1 } }));
    const { pool, git } = await physicalPool(h, 1);
    try {
      const ready = await pool.acquire(PLAN_ID, `plan:${PLAN_ID}:previous`, SHA);
      await pool.release(ready.slot);
      const checkout = vi.spyOn(git, "checkoutDetach");
      const acquire = pool.acquire.bind(pool);
      vi.spyOn(pool, "acquire").mockImplementation(async (...args) => {
        const lease = await acquire(...args);
        await h.parts().writer.append([{ type: "integration-head", head: SHA2 }]);
        return lease;
      });
      await h.begin();
      await h.runOf("T1", 1);

      expect(checkout.mock.calls).toEqual([[ready.path, SHA], [ready.path, SHA2]]);
      expect(await pool.get(ready.slot)).toMatchObject({ state: "leased", commit: SHA2 });
    } finally {
      await h.close(); pool.close();
    }
  });

  it("still resets a same-owner lease even when an earlier acquisition reset it to the same base", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxParallel: 1 } }));
    const { pool, git } = await physicalPool(h, 1);
    try {
      const ready = await pool.acquire(PLAN_ID, `plan:${PLAN_ID}:previous`, SHA2);
      await pool.release(ready.slot);
      const held = await pool.acquire(PLAN_ID, `plan:${PLAN_ID}:T1`, SHA);
      const checkout = vi.spyOn(git, "checkoutDetach"), reset = vi.spyOn(pool, "reset");
      await h.begin();
      const run = await h.runOf("T1", 1);

      expect(run.req.workRoot).toBe(held.path);
      expect(reset.mock.calls).toEqual([[held.slot, SHA]]);
      expect(checkout.mock.calls).toEqual([[held.path, SHA]]);
    } finally {
      await h.close(); pool.close();
    }
  });
});

describe("physical slot observations", () => {
  it("G8: provider-free is not slot-launchable while verifying/integrating tasks retain every slot", async () => {
    const lines: string[] = [], rows: ObservationRecord[] = [];
    const sink = createV2Observations({ write: line => { lines.push(line); rows.push(JSON.parse(line)); } });
    const h = await mk(planOf([task("T1"), task("T2"), task("T3")], { config: { maxParallel: 2 } }), sink);
    const { pool, fs } = await physicalPool(h, 2);
    const verifying = deferred<void>(), releasing = deferred<void>();
    const verify = h.verifier.verify.bind(h.verifier);
    h.verifier.verify = async (t, slot, attempt) => {
      if (t.id === "T1") await verifying.promise;
      return verify(t, slot, attempt);
    };
    const events = (action: string) => {
      sink.flush(); // Test barrier only: production captures synchronously and drains writes later.
      return rows.filter(r => r.family === "scheduler" && r.action === action);
    };
    try {
      await h.begin();
      const first = await h.running("T1", 1, "child-1"), second = await h.running("T2", 1, "child-2");
      first.complete("Done."); second.complete("Done.");
      await until(() => h.state("T1") === "verifying", "T1 verifying with its slot retained");
      await untilEnqueued(h, "T2");
      // Q opens its history entry in the same batch as verified -> integrating (A1-3a).
      await h.parts().writer.append(l => [
        { type: "integration-step", edge: "start", step: "rebase", result: null, detail: null, failingIds: [], closes: false,
          entry: { id: `i-${l.seq + 1}`, kind: "task", phaseId: "p1", taskIds: ["T2"], slot: "slot-2",
            baseHead: l.integration.head, candidate: null } },
        tr("T2", "verified", "integrating", "dequeued"),
      ]);
      const entry = need(h.parts().writer.openIntegration().find(open => open.entry.taskIds.includes("T2")), "T2 integration entry").entry;
      h.runtime.onRouterToolCall(ORCH);
      await until(async () => (await h.counters()).some(c => c.key === "launch-skipped" && c.labels.reason === "slot-unavailable"), "slot-unavailable skip");
      expect(h.state("T3")).toBe("ready");
      expect(h.launcher.runs).toHaveLength(2);
      expect(events("capacity-release").filter(r => r.family === "scheduler" && JSON.stringify(r.state).includes('"result":"success"'))).toHaveLength(2);
      // Red before the fix: the stream only had launch-step-end result=skipped, with no physical-slot reason.
      expect(events("slot-acquire-result")).toContainEqual(expect.objectContaining({ state: expect.objectContaining({
        maxParallel: 2, detail: expect.objectContaining({ taskId: "T3", result: "unavailable", slot: null }),
        slots: expect.arrayContaining([
          expect.objectContaining({ slot: "slot-1", state: "leased", taskId: "T1" }),
          expect.objectContaining({ slot: "slot-2", state: "leased", taskId: "T2" }),
        ]),
      }) }));
      expect(events("ledger")).toContainEqual(expect.objectContaining({ state: expect.objectContaining({ tasks: expect.arrayContaining([
        expect.objectContaining({ id: "T1", state: "verifying", slot: "slot-1" }),
        expect.objectContaining({ id: "T2", state: "integrating", slot: "slot-2" }),
        expect.objectContaining({ id: "T3", state: "ready", slot: null }),
      ]) }) }));

      // Q clears task.slot and the write lease before awaiting the actual marker release.
      await h.parts().writer.append([
        { type: "integration-step", edge: "end", entry, step: "rebase", result: "ok", detail: null, failingIds: [], closes: false },
        { type: "integration-step", edge: "start", entry: { ...entry, candidate: SHA2 }, step: "fast-forward",
          result: null, detail: null, failingIds: [], closes: false },
        { type: "integration-step", edge: "end", entry: { ...entry, candidate: SHA2 }, step: "fast-forward",
          result: "ok", detail: null, failingIds: [], closes: true },
        { type: "task-integrated", taskId: "T2", from: SHA, to: SHA2 },
        tr("T2", "integrating", "integrated", "fast-forwarded"),
        { type: "integration-head", head: SHA2 }, { type: "task-slot", taskId: "T2", slot: null, branch: h.task("T2").branch },
      ]);
      expect(h.parts().writer.openIntegration()).toEqual([]);
      h.parts().leases.releaseTask("T2");
      const fsync = fs.fsyncDir.bind(fs);
      fs.fsyncDir = async path => { await releasing.promise; await fsync(path); };
      const release = pool.release("slot-2");
      await until(() => events("slot-release-start").length === 1, "physical release started");
      expect(events("slot-release-complete")).toEqual([]);
      await expect(pool.acquire(PLAN_ID, `plan:${PLAN_ID}:T3`, SHA2)).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
      releasing.resolve(); await release;
      expect(events("slot-release-complete")).toContainEqual(expect.objectContaining({ state: expect.objectContaining({
        detail: expect.objectContaining({ slot: "slot-2", result: "released" }),
        slots: expect.arrayContaining([expect.objectContaining({ slot: "slot-2", state: "ready", taskId: null })]),
      }) }));
      h.runtime.onLeaseReleased();
      await h.runOf("T3", 1);
      expect(events("slot-acquire-result")).toContainEqual(expect.objectContaining({ state: expect.objectContaining({
        detail: expect.objectContaining({ taskId: "T3", slot: "slot-2", result: "reused" }),
      }) }));
      const releaseSeq = events("slot-release-complete")[0]!.seq;
      expect(events("lease-release").some(r => r.seq < releaseSeq)).toBe(true);
      expect(events("launch").at(-1)!.seq).toBeGreaterThan(releaseSeq);
    } finally {
      verifying.resolve(); releasing.resolve();
      await h.close(); sink.close(); pool.close();
    }
    expect(checkV2ObservationStream(lines).length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain("physical-slots");
  });

  it("reports a failed physical release without announcing availability (even after the write lease is gone)", async () => {
    const rows: ObservationRecord[] = [];
    const sink = createV2Observations({ write: line => { rows.push(JSON.parse(line)); } });
    const h = await mk(planOf([task("T1", { footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } })],
      { config: { maxParallel: 1 } }), sink);
    const { pool, fs } = await physicalPool(h, 1);
    h.git.dirty = () => false;
    await h.begin();
    const run = await h.running("T1", 1, "child-1");
    fs.fsyncDir = async () => { throw new Error("private marker path: cannot flush"); };
    run.complete("Done."); await h.settled();
    sink.flush();
    expect(h.registry.releases).toContain(`${PLAN_ID}:T1`);
    expect(h.logs.some(line => line.includes("slot release failed"))).toBe(true);
    expect(rows.filter(r => r.family === "scheduler" && r.action === "slot-release-failed")).toContainEqual(expect.objectContaining({
      state: expect.objectContaining({ maxParallel: 1, detail: expect.objectContaining({ slot: "slot-1" }),
        slots: expect.arrayContaining([expect.objectContaining({ slot: "slot-1", state: "leased" })]) }),
    }));
    expect(rows.some(r => r.family === "scheduler" && r.action === "slot-release-complete")).toBe(false);
    await expect(pool.acquire(PLAN_ID, `plan:${PLAN_ID}:T2`, SHA)).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
    sink.flush();
    expect(JSON.stringify(rows)).not.toContain("private marker path");
  });

  it("keeps physical pool operations and ledger bytes identical off/on/with a throwing observer", async () => {
    const results: string[] = [];
    for (const mode of ["off", "on", "broken"] as const) {
      const rows: ObservationRecord[] = [];
      const sink = mode === "off" ? undefined : createV2Observations({ write: line => { rows.push(JSON.parse(line)); } });
      if (mode === "broken" && sink !== undefined) sink.record = () => { throw new Error("broken observer"); };
      const h = await mk(planOf([task("T1", { footprint: { writes: [], reads: [], confidence: "explicit", sources: [] } })],
        { config: { maxParallel: 1 } }), sink);
      const { pool, fs } = await physicalPool(h, 1);
      const get = vi.spyOn(pool, "get"), list = vi.spyOn(pool, "list"), writes = vi.spyOn(fs, "writeText");
      h.git.dirty = () => false;
      await h.begin();
      const run = await h.running("T1", 1, "child-1");
      run.complete("Done."); await h.settled();
      // Observation hooks must not ask the pool extra questions, perform extra I/O, consume clock randomness,
      // mutate the journal, or change the launch. Compare before the test itself asks for the final record.
      const calls = { get: [...get.mock.calls], list: [...list.mock.calls], writes: writes.mock.calls.length };
      const record = await pool.get("slot-1");
      expect(record).toMatchObject({ state: "ready", owner: null });
      const req = h.launcher.runs[0]!.req;
      results.push(JSON.stringify({ task: h.task("T1"), events: await h.events(), calls,
        record: { ...record, path: "<slot>" }, request: { ...req, workRoot: "<slot>", prompt: req.prompt.replaceAll(req.workRoot, "<slot>") } }));
      sink?.flush();
      if (mode === "on") {
        for (const action of ["slot-acquire-start", "slot-claim", "slot-acquire-result", "slot-state",
          "slot-provision-start", "slot-provision-end", "slot-reset-start", "slot-reset-end", "slot-release-start", "slot-release-complete"]) {
          expect(rows.some(r => r.family === "scheduler" && r.action === action), action).toBe(true);
        }
        expect(rows.filter(r => r.family === "scheduler" && r.action === "slot-acquire-result")).toContainEqual(expect.objectContaining({
          state: expect.objectContaining({ detail: { slot: "slot-1", kind: "task", taskId: "T1", mode: "create", result: "created" } }),
        }));
      } else expect(rows).toEqual([]);
      await h.close(); sink?.close(); pool.close();
    }
    expect(new Set(results).size).toBe(1);
  });
});

describe("metrics", () => {
  it("observations do not change native launches or ledger bytes, including a throwing sink", async () => {
    const results: string[] = [];
    for (const mode of ["off", "on", "broken"] as const) {
      const rows: ObservationRecord[] = [];
      const observations = mode === "off" ? undefined : createV2Observations({ write: (line) => {
        if (mode === "broken") throw new Error("sink failed");
        rows.push(JSON.parse(line));
      } });
      const h = await mk(planOf([task("T1")]), observations);
      await h.begin();
      await toVerified(h, "T1");
      await h.settled();
      results.push(JSON.stringify({ requests: h.launcher.runs.map((r) => r.req), task: h.task("T1"), log: h.log }));
      observations?.flush();
      if (mode === "on") {
        const actions = rows.flatMap((r) => r.family === "scheduler" ? [r.action] : []);
        for (const action of ["attach", "ledger", "lease-eligibility", "lease-acquire", "route", "capacity-free", "capacity-reserve", "capacity-release", "launch-prepare", "launch"]) {
          expect(actions).toContain(action);
        }
        expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
        expect(JSON.stringify(rows)).not.toContain(SLOT_ROOT);
        expect(JSON.stringify(rows)).not.toContain("Done. Implemented it.");
      } else expect(rows).toEqual([]);
      await h.close();
    }
    expect(new Set(results).size).toBe(1);
  });

  it("emits every metric variant: launch, wake (sent and debounced), idle-with-ready, capacity, counter, context-age", async () => {
    const rows: ObservationRecord[] = [];
    const observations = createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } });
    const h = await mk(planOf([task("T1")]), observations);
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "first wake");

    // The orchestrator goes idle while T1 is ready but the gate is closed: the idle-with-ready window opens at T0.
    h.runtime.onHostEvent({ type: "execution.completed", sessionID: ORCH, at: h.clock.iso() });
    // Synchronous raw host transition, before any tick/updateIdle can run or journal a metric.
    observations.flush();
    expect(rows.filter((r) => r.family === "scheduler" && r.action === "orchestrator").at(-1)).toMatchObject({ state: { orchIdle: true, clockMs: Date.parse(T0) } });
    await h.settled();

    // A new state key inside the debounce is not sent; the runtime re-arms a tick for the end of the window.
    h.launcher.gateValue = staleGate("stale-context:boot:2");
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    h.clock.advance(1000);
    await until(() => h.hosts.delivered.length === 2, "second wake after the debounce");
    await h.settled();

    // The context is fresh again: the launch closes the window (1000 + 4000 ms after it opened).
    h.clock.advance(4000);
    h.launcher.gateValue = OK_GATE;
    h.runtime.onRouterToolCall(ORCH);
    await h.runOf("T1", 1);

    observations.flush();
    expect(rows.find((r) => r.family === "scheduler" && r.action === "launch-gate")).toMatchObject({ state: { detail: { ok: false, ready: ["T1"] } } });
    expect(rows.find((r) => r.family === "scheduler" && r.action === "launch-prepare")).toMatchObject({ state: { clockMs: Date.parse(T0) + 5000 } });

    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    h.runtime.onHostEvent({ type: "retry", sessionID: "ses-x", stepKey: "k1", source: "scheduled", error: ERR_RATE_LIMIT, at: h.clock.iso() });
    h.runtime.recordMetric(PLAN_ID, {
      name: "context-age",
      taskId: "T1",
      attempt: 1,
      bootID: GATE_CONTEXT.bootID,
      epoch: 1,
      callID: "call-1",
      capturedAt: T0,
      ageMs: 5000,
      result: "confirmed",
    });
    h.runtime.recordMetric(PLAN_ID, { name: "counter", key: "custom", value: 1, labels: { k: "v" } });

    h.launcher.gateValue = DISPOSED_GATE;
    h.launcher.releaseAll();
    await h.settled();

    const ms = await h.metrics();
    expect(new Set(ms.map((m) => m.name))).toEqual(new Set(["launch", "wake", "idle-with-ready", "capacity", "counter", "context-age"]));
    const wakes = ms.map((m) => (m.name === "wake" ? `${m.stateKey}:${m.result}` : "")).filter((s) => s !== "");
    expect(wakes[0]).toBe("stale-context:boot:1:sent");
    expect(wakes).not.toContain("stale-context:boot:2:debounced"); // QA-3.1-5: only sent/failed are journaled
    expect(wakes.at(-1)).toBe("stale-context:boot:2:sent");
    expect(wakes.filter((w) => w.endsWith(":sent"))).toHaveLength(2);
    const idle = need(ms.find((m) => m.name === "idle-with-ready"), "idle-with-ready metric");
    expect(idle).toMatchObject({ name: "idle-with-ready", fromAt: T0, ms: 5000, readyTaskIds: ["T1"] });
    expect(ms.find((m) => m.name === "launch")).toEqual({
      name: "launch",
      taskId: "T1",
      attempt: 1,
      agent: "implementer",
      model: `${PROVIDER}/model-1`,
      provider: PROVIDER,
      heavy: false,
    });
    expect(ms.find((m) => m.name === "capacity")).toMatchObject({ provider: PROVIDER, change: "decrease" });
    expect(ms.find((m) => m.name === "counter")).toMatchObject({ key: "custom", labels: { k: "v" } });
    expect(ms.find((m) => m.name === "context-age")).toMatchObject({ taskId: "T1", ageMs: 5000, result: "confirmed" });
    expect(await h.runtime.status(PLAN_ID, ORCH)).toContain("Metrics: launches 1, wakes 2, idle-with-ready 5000 ms");
  });

  it("keeps idle-with-ready duration equal to its endpoints with an advancing clock", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "first wake");

    // A millisecond can tick between two reads. Model that without moving the test timers: every now() lands one more
    // ms later, while a bare iso() keeps the timer time. Separate reads for an endpoint's ms and ISO time then
    // disagree by a different amount at each endpoint, as the run-13 smoke observed (1,060 vs 1,061 ms).
    const readNow = h.clock.now.bind(h.clock);
    let reads = 0;
    vi.spyOn(h.clock, "now").mockImplementation(() => readNow() + ++reads);
    vi.spyOn(h.clock, "iso").mockImplementation((ms) => new Date(ms ?? readNow()).toISOString());

    // Same window as the metrics test: idle orchestrator with a stale context, a debounced second wake, then a launch.
    h.runtime.onHostEvent({ type: "execution.completed", sessionID: ORCH, at: h.clock.iso() });
    await h.settled();
    h.launcher.gateValue = staleGate("stale-context:boot:2");
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    h.clock.advance(1000);
    await until(() => h.hosts.delivered.length === 2, "second wake after the debounce");
    await h.settled();
    h.clock.advance(4000);
    h.launcher.gateValue = OK_GATE;
    h.runtime.onRouterToolCall(ORCH);
    await h.runOf("T1", 1);
    h.launcher.gateValue = DISPOSED_GATE;
    h.launcher.releaseAll();
    await h.settled();

    const idle = need((await h.metrics()).find((m) => m.name === "idle-with-ready"), "idle-with-ready metric");
    expect(idle.readyTaskIds).toEqual(["T1"]);
    expect(idle.ms).toBeGreaterThan(0);
    expect(Date.parse(idle.toAt) - Date.parse(idle.fromAt)).toBe(idle.ms);
  });

  it("recordMetric for a plan that is not attached journals nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    h.runtime.recordMetric("no-such-plan", { name: "counter", key: "unknown-plan", value: 1, labels: {} });
    h.runtime.recordMetric(PLAN_ID, { name: "counter", key: "known-plan", value: 1, labels: {} });
    h.launcher.gateValue = DISPOSED_GATE;
    h.launcher.releaseAll();
    await h.settled();
    // releaseAll ends the launch as interrupted/dispose, counted as launch-failed L17 (nit 7).
    expect((await h.counters()).map((c) => c.key).filter((k) => k !== "launch-failed")).toEqual(["known-plan"]);
  });
});

describe("public surface", () => {
  it("compile attaches a running plan; another session cannot act on it (E_NOT_OWNER)", async () => {
    const h = await mk(planOf([task("M1", { kind: "manual", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } })]));
    const r = await h.runtime.compile({ path: `${REPO}/PLAN.md`, sessionID: ORCH });
    expect(r).toMatchObject({ planId: PLAN_ID, residuePrompt: null });
    expect(r.summary.tasks).toBe(1);
    await expect(h.runtime.pause(PLAN_ID, "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);
    expect(h.runtime.planLine("ses-intruder")).toBeNull();
  });

  it("resume and abort by another session are refused with E_NOT_OWNER and change nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    await expect(h.runtime.resume(PLAN_ID, "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    await expect(h.runtime.abort(PLAN_ID, "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    expect(h.ledger().status).toBe("running");
    expect(h.parts().queue.aborted).toBe(0);
  });

  it("pause stops launching; resume re-checks every phase suite (A2-1) and relaunches", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    await h.runtime.pause(PLAN_ID, ORCH);
    expect(h.ledger().status).toBe("paused");
    expect(h.runtime.planLine(ORCH)).toContain("paused");
    await expect(h.runtime.pause(PLAN_ID, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });

    await h.runtime.resume(PLAN_ID, ORCH);
    expect(h.ledger().status).toBe("running");
    expect(h.parts().queue.checked).toEqual(["p1"]);
    expect(run.req.attempt).toBe(1);
  });
});

/** LedgerWriter double for createWaker: keeps the wake keys it was given and can fail its append. */
class WakeWriter implements LedgerWriter {
  readonly planId = PLAN_ID;
  readonly ledger: Readonly<LedgerV1> = planOf([]);
  readonly keys = new Set<string>();
  failAppend = false;
  openIntegration(): never[] {
    return [];
  }
  wakeKeys(): ReadonlySet<string> {
    return this.keys;
  }
  async append(batch: Parameters<LedgerWriter["append"]>[0]): Promise<Readonly<LedgerV1>> {
    if (this.failAppend) throw new Error("disk full");
    if (typeof batch !== "function") {
      for (const e of batch) if (e.type === "wake") this.keys.add(e.stateKey);
    }
    return this.ledger;
  }
  async snapshot(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("createWaker", () => {
  const mkWaker = (debounceMs: number, onMetric: (m: { result: string }) => void = () => undefined) => {
    const clock = new TestClock();
    const hosts = new HostsDouble();
    const writer = new WakeWriter();
    const waker = createWaker({
      writer,
      hosts,
      clock,
      debounceMs,
      text: (reason, key) => `wake ${reason} ${key}`,
      onMetric,
    });
    return { clock, hosts, writer, waker };
  };

  it("sends once per key, answers duplicate for a journaled key, and debounces a different key inside the window", async () => {
    const results: string[] = [];
    const w = mkWaker(1000, (m) => results.push(m.result));
    expect(await w.waker.wake("stale-context", "k1")).toBe("sent");
    expect(w.hosts.delivered[0]).toMatchObject({ sessionID: ORCH, text: "wake stale-context k1", resume: true });
    expect(await w.waker.wake("stale-context", "k1")).toBe("duplicate");
    expect(await w.waker.wake("manual-ready", "k2")).toBe("debounced");
    w.clock.advance(1000);
    expect(await w.waker.wake("manual-ready", "k2")).toBe("sent");
    expect(w.hosts.keys()).toEqual(["k1", "k2"]);
    expect(results).toEqual(["sent", "duplicate", "debounced", "sent"]);
  });

  it("a failing journal append is 'failed' and nothing is delivered; a failing delivery is 'failed' too", async () => {
    const w = mkWaker(1000);
    w.writer.failAppend = true;
    expect(await w.waker.wake("stale-context", "k1")).toBe("failed");
    expect(w.hosts.attempted).toEqual([]);
    w.writer.failAppend = false;
    w.hosts.failures = 1;
    expect(await w.waker.wake("stale-context", "k1")).toBe("failed");
    expect(w.hosts.attempted).toEqual(["k1"]);
  });

  it("a wake whose key lookup throws rejects, and the chain behind it still runs", async () => {
    const w = mkWaker(0);
    const keys = w.writer.wakeKeys.bind(w.writer);
    let fail = true;
    w.writer.wakeKeys = (): ReadonlySet<string> => {
      if (fail) {
        fail = false;
        throw new Error("keys unreadable");
      }
      return keys();
    };
    await expect(w.waker.wake("stale-context", "k1")).rejects.toThrow("keys unreadable");
    expect(await w.waker.wake("stale-context", "k1")).toBe("sent");
    expect(w.hosts.keys()).toEqual(["k1"]);
  });

  it("a throwing metric sink never breaks the wake path or the chain behind it", async () => {
    const w = mkWaker(0, () => {
      throw new Error("sink down");
    });
    expect(await w.waker.wake("stale-context", "k1")).toBe("sent");
    expect(await w.waker.wake("manual-ready", "k2")).toBe("sent");
    expect(w.hosts.keys()).toEqual(["k1", "k2"]);
  });
});

describe("plan lifecycle methods (status, ready, done, land, answer, gc, exportPlan, purge)", () => {
  const manualTask = (id: TaskId): TaskNode =>
    task(id, { kind: "manual", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } });

  it("status renders the board: counts, phases, running tasks, manual waits, the open inbox and the metrics line", async () => {
    const h = await mk(planOf([task("T1"), manualTask("M1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await until(() => h.hosts.delivered.length === 1, "manual-ready wake"); // keeps the wake counter still while the board is read
    await until(async () => (await h.metrics()).some((m) => m.name === "wake" && m.result === "sent"), "wake metric journaled");
    await h.parts().policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "which db?", options: [] });
    await h.parts().policy.raise({ kind: "flaky", severity: "blocking", taskId: null, text: "FYI", options: [] });

    const board = await h.runtime.status(PLAN_ID, ORCH);
    expect(board).toContain(`Plan ${PLAN_ID} [running] `);
    expect(board).toMatch(/Tasks: .*running 1/);
    expect(board).toMatch(/Phase p1: gate \S+ - /);
    expect(board).toContain("Ready:");
    expect(board).toContain("  M1 manual (manual) - waiting for router_plan action=done");
    expect(board).toContain("Running: T1 attempt 1");
    expect(board).toMatch(/Inbox:\n {2}\S+ question\/blocking T1: which db\?\n {2}\S+ flaky\/blocking: FYI/);
    expect(board).toContain("Metrics: launches 1, wakes");
    expect(await h.runtime.status(null, ORCH)).toBe(board);
  });

  it("status and ready of a plan that is not attached read the stored ledger; an unknown session has no plan", async () => {
    const h = await mk(planOf([manualTask("M1")]));
    await h.begin();
    await h.runtime.dispose();

    const byId = await h.runtime.status(PLAN_ID, ORCH);
    expect(byId).toContain(`Plan ${PLAN_ID} [running] `);
    expect(byId).not.toContain("Metrics:");
    expect(await h.runtime.status(null, ORCH)).toBe(byId);
    await expect(h.runtime.status(null, "ses-nobody")).rejects.toMatchObject({ code: "E_LEDGER_NOT_FOUND" });
    expect(await h.runtime.ready(PLAN_ID)).toEqual({ launchable: [], manual: ["M1"] });
  });

  it("done refuses a task that is not a ready manual or preflight task", async () => {
    const h = await mk(planOf([task("T1"), manualTask("M1")]));
    await h.begin();
    await h.runOf("T1", 1);
    await expect(h.runtime.done(PLAN_ID, "T1", ORCH)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.runtime.done(PLAN_ID, "T-missing", ORCH)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.runtime.done(PLAN_ID, "M1", "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    expect(h.state("M1")).toBe("ready");
    await h.runtime.done(PLAN_ID, "M1", ORCH);
    expect(h.state("M1")).toBe("done");
  });

  it("the plan line says why launching is blocked, but not when the host is merely disposed", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "stale-context wake");
    expect(h.runtime.planLine(ORCH)).toBe(`plan ${PLAN_ID}: 0/1 done, 0 running, 1 ready (launch blocked: context-stale)`);
    h.launcher.gateValue = DISPOSED_GATE;
    expect(h.runtime.planLine(ORCH)).toBe(`plan ${PLAN_ID}: 0/1 done, 0 running, 1 ready`);
  });

  it("land runs the integration queue's land for the owner only", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await expect(h.runtime.land(PLAN_ID, "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    expect(h.parts().queue.landed).toBe(0);
    await h.runtime.land(PLAN_ID, ORCH);
    expect(h.parts().queue.landed).toBe(1);
  });

  it("answer forwards to the policy and re-ticks; another session is refused", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    const answers: string[] = [];
    h.parts().policy.answer = async (id: string, text: string) => {
      answers.push(`${id}=${text}`);
      return { resumed: null };
    };
    await expect(h.runtime.answer(PLAN_ID, "Q-1", "yes", "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    await h.runtime.answer(PLAN_ID, "Q-1", "yes", ORCH);
    expect(answers).toEqual(["Q-1=yes"]);
  });

  it("gc hands the slot pool a predicate: attached plans by status, stored plans by ledger, unknown plans as null", async () => {
    const h = await mk(planOf([manualTask("M1")]));
    await h.begin();
    expect(await h.runtime.gc()).toEqual({ removed: [], reported: [] });
    const isDone = need(h.slots.gcPredicate, "gc predicate");
    expect(await isDone(PLAN_ID)).toBe(false);
    expect(await isDone("no-such-plan")).toBeNull();

    await h.runtime.abort(PLAN_ID, ORCH);
    expect(await isDone(PLAN_ID)).toBe(true);
    await h.runtime.dispose();
    expect(await isDone(PLAN_ID)).toBe(true); // not attached any more: read from the store

    h.store.read = async () => {
      throw new Error("io failure");
    };
    await expect(isDone(PLAN_ID)).rejects.toThrow("io failure");
  });

  it("exportPlan returns the snapshot and the merged events as JSON", async () => {
    const h = await mk(planOf([manualTask("M1")]));
    await h.begin();
    const parsed = JSON.parse(await h.runtime.exportPlan(PLAN_ID)) as { snapshot: LedgerV1; events: ExecutorEvent[] };
    expect(parsed.snapshot.planId).toBe(PLAN_ID);
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.events.map((e) => e.seq)).toEqual([...parsed.events.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it("purge refuses a running plan and a foreign session; on an aborted plan it deletes its refs and the plan directory", async () => {
    const h = await mk(planOf([manualTask("M1")]));
    await h.begin();
    await expect(h.runtime.purge(PLAN_ID, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(h.runtime.purge(PLAN_ID, "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    await h.runtime.abort(PLAN_ID, ORCH);

    h.git.refs = [
      `refs/heads/omr/${PLAN_ID}/t/M1`,
      `refs/tags/omr/${PLAN_ID}/p1`,
      "refs/heads/omr/other-plan/t/X",
      "",
    ];
    await h.runtime.purge(PLAN_ID, ORCH);

    const calls = h.git.calls.filter((c) => c.args[0] === "for-each-ref" || c.args[0] === "update-ref");
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      `for-each-ref --format=%(refname) refs/heads/omr/${PLAN_ID}/`,
      `update-ref -d refs/heads/omr/${PLAN_ID}/t/M1`,
      `for-each-ref --format=%(refname) refs/tags/omr/${PLAN_ID}/`,
      `update-ref -d refs/tags/omr/${PLAN_ID}/p1`,
    ]);
    expect(calls.every((c) => c.cwd === REPO)).toBe(true);
    expect(need(h.slots.gcPredicate, "gc predicate")).toBeTypeOf("function");
    expect(await need(h.slots.gcPredicate, "gc predicate")(PLAN_ID)).toBe(true);
    expect(await need(h.slots.gcPredicate, "gc predicate")("other")).toBeNull();
    await expect(h.store.read(PLAN_ID)).rejects.toMatchObject({ code: "E_LEDGER_NOT_FOUND" });
    expect(h.runtime.planLine(ORCH)).toBeNull();
  });

  it("purge keeps going when listing refs fails", async () => {
    const h = await mk(planOf([manualTask("M1")]));
    await h.begin();
    await h.runtime.abort(PLAN_ID, ORCH);
    h.git.failOn = { verb: "for-each-ref", stderr: "fatal: bad" };
    h.git.refs = [`refs/heads/omr/${PLAN_ID}/t/M1`];
    await h.runtime.purge(PLAN_ID, ORCH);
    expect(h.git.calls.some((c) => c.args[0] === "update-ref")).toBe(false);
    await expect(h.store.read(PLAN_ID)).rejects.toMatchObject({ code: "E_LEDGER_NOT_FOUND" });
  });

  it("a second abort, and a resume of a running plan, are E_PLAN_STATE", async () => {
    const h = await mk(planOf([manualTask("M1")]));
    await h.begin();
    await expect(h.runtime.resume(PLAN_ID, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await h.runtime.abort(PLAN_ID, ORCH);
    await expect(h.runtime.abort(PLAN_ID, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(h.parts().queue.aborted).toBe(1);
  });

  it("abort goes on when the queue's abort throws, and still ends in aborted", async () => {
    const h = await mk(planOf([manualTask("M1")]));
    await h.begin();
    h.parts().queue.abort = async () => {
      throw new Error("queue down");
    };
    await h.runtime.abort(PLAN_ID, ORCH);
    expect(h.ledger().status).toBe("aborted");
    expect(h.state("M1")).toBe("cancelled");
    expect(h.logs.some((l) => l.startsWith("error: queue abort failed") && l.includes("queue down"))).toBe(true);
  });

  it("resume re-enqueues verified tasks and logs a phase re-check that throws", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await toVerified(h, "T1");
    await h.runtime.pause(PLAN_ID, ORCH);
    h.parts().queue.checkPhase = async () => {
      throw new Error("suite crashed");
    };
    await h.runtime.resume(PLAN_ID, ORCH);
    expect(h.parts().queue.enqueued).toEqual([["T1"], ["T1"]]);
    expect(h.logs.some((l) => l.startsWith("warn: checkPhase p1 failed") && l.includes("suite crashed"))).toBe(true);
  });

  it("addTasks journals the new tasks and edges, sends a reopened task back to pending and frees its slot", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("T1") === "ready", "T1 back to ready");
    expect(h.task("T1").slot).toBe("slot-1");

    h.compiler.added = { tasks: [task("T2", { state: "pending" })], edges: [edge("T2", "T1")], reopened: ["T1", "T-gone"] };
    await expect(h.runtime.addTasks(PLAN_ID, "more", "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    const r = await h.runtime.addTasks(PLAN_ID, "T2: do more", ORCH);

    expect(r).toEqual({ added: ["T2"], reopened: ["T1", "T-gone"] });
    expect(h.compiler.addTexts).toEqual(["T2: do more"]);
    expect(h.state("T1")).toBe("pending");
    expect(h.task("T1").slot).toBeNull();
    expect(["pending", "ready"]).toContain(h.state("T2"));
    expect(h.ledger().edges).toContainEqual(edge("T2", "T1"));
    expect(h.slots.released).toEqual(["slot-1"]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it("addTasks surfaces the compiler's refusal and writes nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    const seq = h.ledger().seq;
    await expect(h.runtime.addTasks(PLAN_ID, "bad", ORCH)).rejects.toMatchObject({ code: "E_CYCLE" });
    expect(h.ledger().seq).toBe(seq);
  });

  it("onChildEnd routes an end to the plan that owns the task and ignores unknown tasks", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.runtime.onChildEnd("T-unknown", 1, { kind: "lost", childSessionID: null, reason: "restart", endedAt: h.clock.iso() });
    expect(h.state("T1")).toBe("running");

    await h.runtime.onChildEnd("T1", 9, { kind: "lost", childSessionID: "ses-c1", reason: "restart", endedAt: h.clock.iso() });
    expect(h.state("T1")).toBe("running"); // attempt 9 is not open: ignored

    await h.runtime.onChildEnd("T1", 1, { kind: "failed", childSessionID: "ses-c1", error: { type: "provider.internal", status: 500, message: "boom" }, endedAt: h.clock.iso() });
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "failed", context: "provider.internal: boom" });
    const second = await h.runOf("T1", 2); // the retry relaunches; wait for it so teardown never races the launch
    expect(second.req.prompt).toContain("provider.internal: boom");
  });
});

describe("residue, approval, completion and recovery wiring", () => {
  const manualOnly = (id: TaskId): TaskNode =>
    task(id, { kind: "manual", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } });

  it("compile passes the phase selection through and returns the residue prompt; residue merges and moves to awaiting-approval", async () => {
    const draft = planOf([task("T1")]);
    draft.status = "awaiting-residue";
    const h = await mk(draft);
    h.compiler.residuePrompt = "Please answer the residue.";
    const r = await h.runtime.compile({ path: `${REPO}/PLAN.md`, sessionID: ORCH, phases: ["p1"], doneBefore: "p1" });

    expect(r.residuePrompt).toBe("Please answer the residue.");
    expect(h.compiler.compileOpts[0]).toMatchObject({ phases: ["p1"], doneBefore: "p1", orchestratorSessionID: ORCH });
    expect(h.ledger().status).toBe("awaiting-residue");
    expect(h.pins).toEqual([]);
    expect(h.runtime.planLine(ORCH)).toBeNull();

    await expect(h.runtime.residue(PLAN_ID, "answer", "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    await expect(h.runtime.residue(PLAN_ID, "garbage", ORCH)).rejects.toMatchObject({ code: "E_RESIDUE" });
    expect(h.ledger().status).toBe("awaiting-residue");

    h.compiler.merged = planOf([task("T1"), task("T2")]);
    const summary = await h.runtime.residue(PLAN_ID, "answer", ORCH);
    expect(summary).toMatchObject({ tasks: 2, warnings: ["merged"] });
    expect(h.compiler.residueTexts).toEqual(["garbage", "answer"]);
    expect(h.ledger().status).toBe("awaiting-approval");
    expect(Object.keys(h.ledger().tasks).sort()).toEqual(["T1", "T2"]);
    await expect(h.runtime.residue(PLAN_ID, "again", ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
  });

  it("approve resolves the slots directory, starts the plan and pins the orchestrator; a second approve is E_PLAN_STATE", async () => {
    const draft = planOf([task("T1")]);
    draft.status = "awaiting-approval";
    draft.config = { ...draft.config, slotsDir: null };
    const h = await mk(draft);
    await h.begin();
    expect(h.launcher.runs).toHaveLength(0);
    await expect(h.runtime.approve(PLAN_ID, "ses-intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });

    await h.runtime.approve(PLAN_ID, ORCH);
    expect(h.ledger().status).toBe("running");
    expect(h.ledger().config.slotsDir).toBe(defaultSlotsDir(REPO, PLAN_ID));
    expect(h.pins).toEqual([ORCH]);
    await h.runOf("T1", 1);
    await expect(h.runtime.approve(PLAN_ID, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
  });

  it("approve keeps a slots directory that was already resolved", async () => {
    const draft = planOf([task("T1")]);
    draft.status = "awaiting-approval";
    const h = await mk(draft);
    await h.begin();
    await h.runtime.approve(PLAN_ID, ORCH);
    expect(h.ledger().config.slotsDir).toBe("C:/slots");
  });

  it("a plan that is aborted while awaiting approval cancels its tasks and launches nothing", async () => {
    const draft = planOf([task("T1"), task("T2")]);
    draft.status = "awaiting-approval";
    const h = await mk(draft);
    await h.begin();
    await h.runtime.abort(PLAN_ID, ORCH);
    expect(h.ledger().status).toBe("aborted");
    expect(h.state("T1")).toBe("cancelled");
    expect(h.state("T2")).toBe("cancelled");
    expect(h.launcher.runs).toHaveLength(0);
  });

  it("when every task is complete and every gate passed the plan completes and lands (ff-when-clean)", async () => {
    const h = await mk(planOf([manualOnly("M1")], { gate: "passed" }));
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "manual-ready wake");
    h.clock.advance(1000); // past the debounce of the manual-ready wake
    await h.runtime.done(PLAN_ID, "M1", ORCH);
    await until(() => h.ledger().status === "completed", "plan completed");
    await until(() => h.hosts.keys().includes(`plan-completed:${PLAN_ID}`), "plan-completed wake");
    await until(() => h.parts().queue.landed === 1, "queue.land");
    expect(h.hosts.keys()).toEqual(["manual-ready:M1:0", `plan-completed:${PLAN_ID}`]);
    expect(h.runtime.planLine(ORCH)).toBeNull();
    expect((await h.events()).some((e) => e.type === "status-changed" && e.to === "completed" && e.reason === "all-tasks-complete")).toBe(true);
  });

  it("a plan-completed wake debounced by an earlier wake is sent once the debounce ends (M32 re-armed tick)", async () => {
    const h = await mk(planOf([manualOnly("M1")], { gate: "passed" }));
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "manual-ready wake");
    await h.runtime.done(PLAN_ID, "M1", ORCH); // inside the debounce window of the manual-ready wake
    await until(() => h.ledger().status === "completed", "plan completed");
    await until(() => h.parts().queue.landed === 1, "queue.land");
    await h.settled();
    expect(h.hosts.keys()).toEqual(["manual-ready:M1:0"]);
    expect(h.clock.pendingTimers()).toBeGreaterThan(0);

    h.clock.advance(1000);
    await until(() => h.hosts.keys().includes(`plan-completed:${PLAN_ID}`), "plan-completed wake after the debounce");
    await h.settled();
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.keys()).toEqual(["manual-ready:M1:0", `plan-completed:${PLAN_ID}`]);
  });

  it("with land 'manual' a completed plan does not land by itself", async () => {
    const h = await mk(planOf([manualOnly("M1")], { gate: "passed", config: { land: "manual" } }));
    await h.begin();
    await h.runtime.done(PLAN_ID, "M1", ORCH);
    await until(() => h.ledger().status === "completed", "plan completed");
    await h.settled();
    expect(h.parts().queue.landed).toBe(0);
  });

  it("adopt without recovery is E_PLAN_STATE", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await expect(h.runtime.adopt(PLAN_ID, "ses-new")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
  });

  it("adopt closes the attached plan, lets recovery take it over and attaches the reopened ledger", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    const calls: string[] = [];
    const recovery: RecoveryService = {
      async recover() {
        return [];
      },
      async adopt(planId, sessionID) {
        calls.push(`${planId}/${sessionID}/attached=${String(h.runtime.planLine(ORCH) !== null)}`);
      },
    };
    h.deps.recovery = recovery;
    const before = h.parts();
    await h.runtime.adopt(PLAN_ID, ORCH);
    expect(calls).toEqual([`${PLAN_ID}/${ORCH}/attached=false`]); // the old attachment was closed before recovery ran
    expect(h.parts()).not.toBe(before);
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);
  });

  it("QA-3.1-19: adopt checks the single-plan rule BEFORE recovery.adopt: a refused adopt leaves the other plan untouched", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    const d2 = planOf([task("T9")]);
    d2.planId = "plan-two";
    const w = await h.store.create(d2, h.deps.holder("ses-9"));
    await w.close();
    const calls: string[] = [];
    h.deps.recovery = {
      async recover() {
        return [];
      },
      async adopt(planId) {
        calls.push(String(planId));
      },
    };
    await expect(h.runtime.adopt("plan-two", ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(calls).toEqual([]);
    expect((await h.store.read("plan-two")).status).toBe("running");
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);
  });

  it("adopt takes the lock over when the plan is still locked, and rethrows any other open failure", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    h.deps.recovery = {
      async recover() {
        return [];
      },
      async adopt() {},
    };
    await h.runtime.dispose();

    const reasons: string[] = [];
    const open = h.store.open.bind(h.store);
    h.store.takeover = async (planId, holder, reason) => {
      reasons.push(reason);
      return open(planId, holder);
    };
    h.store.open = async () => {
      throw new ExecutorError("E_LOCK_HELD", "locked");
    };
    await h.runtime.adopt(PLAN_ID, ORCH);
    expect(reasons).toEqual(["adopt"]);
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);

    h.store.open = async () => {
      throw new Error("disk unreadable");
    };
    await expect(h.runtime.adopt(PLAN_ID, ORCH)).rejects.toThrow("disk unreadable");
    h.store.open = open;
  });

  it("start runs recovery once, logs a failing recovery, and logs a plan it cannot open without stopping", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    const recovered: number[] = [];
    h.deps.recovery = {
      async recover() {
        recovered.push(1);
        throw new Error("recovery exploded");
      },
      async adopt() {},
    };
    h.store.open = async () => {
      throw new Error("lock busy");
    };
    await h.restart();
    expect(recovered).toEqual([1]);
    expect(h.logs.some((l) => l.startsWith("error: recovery failed") && l.includes("recovery exploded"))).toBe(true);
    expect(h.logs.some((l) => l.startsWith(`warn: plan ${PLAN_ID} not attached`) && l.includes("lock busy"))).toBe(true);
    expect(h.runtime.planLine(ORCH)).toBeNull();
  });
});

describe("Q results that touch live children and the integration listener's edge paths", () => {
  it("a conflict whose slot reset fails is logged and the task is still retried", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await toVerified(h, "T1");
    const reset = h.slots.reset.bind(h.slots);
    h.slots.reset = async () => {
      h.slots.reset = reset; // one shot: the relaunch resets the slot again and must succeed
      throw new Error("reset boom");
    };
    await qConflict(h, "T1", "CONFLICT (content): src/T1.ts");
    await h.runOf("T1", 2);
    expect(h.logs.some((l) => l.startsWith("warn: slot reset after conflict failed") && l.includes("reset boom"))).toBe(true);
    expect(h.task("T1").attempts[0]?.context).toBe("CONFLICT (content): src/T1.ts");
  });

  it("onReverted cancels the live child of a task Q moved to blocked and releases its slot once the child is gone (M8)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const slot = need(h.task("T1").slot, "T1 slot");
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "interrupted", endedAt: h.clock.iso(), detail: "dep-reverted" },
      tr("T1", "running", "blocked", "dep-reverted"),
      { type: "task-slot", taskId: "T1", slot: null, branch: null },
    ]);
    h.parts().listener.onReverted("T1");
    await until(() => h.slots.released.includes(slot), "slot released after the blocked cancel");

    expect(run.cancelReasons).toEqual(["blocked"]);
    expect(h.log.some((l) => l.startsWith("launcher.cancel:T1#1:blocked"))).toBe(true);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
    expect(h.state("T1")).toBe("blocked");
  });

  it("a listener callback that throws is logged by name and never escapes", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    h.parts().qa.onAwaitingQa = async () => {
      throw new Error("qa down");
    };
    h.parts().listener.onGate("p1", "awaiting-qa");
    await until(() => h.logs.some((l) => l.startsWith("error: onGate failed") && l.includes("qa down")), "onGate failure logged");
  });

  it("a launch step that throws is logged and the task stays ready; the next tick launches it", async () => {
    const h = await mk(planOf([task("T1")]));
    const acquire = h.registry.acquireWrite.bind(h.registry);
    h.registry.acquireWrite = () => {
      throw new Error("registry down");
    };
    await h.begin();
    await until(() => h.logs.some((l) => l.startsWith("error: launch step failed") && l.includes("registry down")), "launch step failure logged");
    expect(h.state("T1")).toBe("ready");
    expect(h.launcher.runs).toHaveLength(0);

    h.registry.acquireWrite = acquire;
    h.runtime.onRouterToolCall(ORCH);
    await h.runOf("T1", 1);
    expect(h.state("T1")).toBe("dispatched");
  });

  it("a failure while processing a child's end is logged and does not stop later work", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 1 } }));
    await h.begin();
    h.parts().policy.park = async () => {
      throw new Error("park boom");
    };
    h.verifier.queue.push({ verdict: "fail", findings: "tests failed" });
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await until(() => h.logs.some((l) => l.startsWith("error: child end processing failed") && l.includes("park boom")), "end failure logged");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "fail" });
  });

  it("status lists a launchable task under 'Ready:' even while the launch gate is closed", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "stale-context wake");
    expect(await h.runtime.status(PLAN_ID, ORCH)).toContain("Ready:\n  T1");
  });

  it("onReverted does not cancel a child whose task is not blocked", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    h.parts().listener.onReverted("T1");
    await pause(30);
    expect(h.log.some((l) => l.startsWith("launcher.cancel"))).toBe(false);
  });

  it("a blocked task whose dependencies are done is handed to the policy to unblock", async () => {
    const h = await mk(planOf([task("T1", { state: "done" }), task("T2", { state: "blocked" })], { edges: [edge("T1", "T2")] }));
    await h.begin();
    await until(() => h.parts().policy.unblocks > 0, "policy.unblock");
    expect(h.launcher.runs).toHaveLength(0);
  });

  it("a failing cancel of the superseded launch is logged and the relaunch goes ahead", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.cancel = async () => {
      throw new Error("cancel boom");
    };
    await h.begin();
    const old = await h.runOf("T1", 1);
    // "threw" leaves the double's completion open (a timeout settles it, as launch.ts does), so R4 must cancel it.
    old.confirm({ kind: "unconfirmed", reason: "threw", error: null });
    await h.runOf("T1", 2);
    expect(h.logs.some((l) => l.startsWith("warn: cancel superseded failed") && l.includes("cancel boom"))).toBe(true);
  });

  it("a rejected launch confirmation is logged and changes nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    run.confirmation.reject(new Error("confirm boom"));
    await until(() => h.logs.some((l) => l.startsWith("warn: confirmation rejected") && l.includes("confirm boom")), "rejection logged");
    expect(h.state("T1")).toBe("dispatched");
  });

  it("the late-child hook refuses once the plan is aborted", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("T1") === "ready", "T1 back to ready");
    expect(await run.hooks.onLateChild("ses-late")).toBe("adopt");
    await h.runtime.abort(PLAN_ID, ORCH);
    expect(await run.hooks.onLateChild("ses-late")).toBe("refuse");
    await expect(run.hooks.onChildCreated("ses-late")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
  });
});

describe("usage-limit pauses and paused phases", () => {
  const QUOTA = { type: "provider.quota", status: 402, message: "usage limit reached" };

  it("a quota failure pauses the provider, raises one usage-limit item and re-arms the tick; a repeat raises nothing", async () => {
    const rows: ObservationRecord[] = [];
    const observations = createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } });
    const h = await mk(planOf([task("T1")]), observations);
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-c1", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-c1", error: QUOTA, at: h.clock.iso() });
    observations.flush();
    expect(rows.find((r) => r.family === "scheduler" && r.action === "provider")).toMatchObject({ state: { change: "pause", provider: expect.stringMatching(/^provider:[a-f0-9]{64}$/) } });
    await until(() => h.parts().policy.raised.length === 1, "usage-limit item");

    expect(h.parts().policy.raised[0]).toMatchObject({ kind: "usage-limit" });
    expect(h.clock.pendingTimers()).toBeGreaterThan(0);
    await until(async () => (await h.metrics()).some((m) => m.name === "capacity" && m.change === "pause"), "capacity pause metric");

    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-c1", error: QUOTA, at: h.clock.iso() });
    await pause(30);
    expect(h.parts().policy.raised).toHaveLength(1);
    // Advancing time alone must NOT query the controller on behalf of diagnostics. Resume is lazy.
    h.clock.advance(h.ledger().config.capacityPauseMs + 1);
    observations.flush();
    expect(rows.filter((r) => r.family === "scheduler" && r.action === "provider" && JSON.stringify(r.state).includes('"resume"'))).toHaveLength(0);
    // The running child's retry hook queries capacity even with no ready task. A non-capacity
    // error does not start another quota pause, so this query observes only the expired pause's resume.
    expect(h.runtime.onRetryHook({ sessionID: "ses-c1", stepKey: "after-pause",
      error: { type: "provider.timeout", status: null, message: "transient timeout" } })).toEqual({ stop: false });
    observations.flush();
    expect(rows.filter((r) => r.family === "scheduler" && r.action === "provider" && JSON.stringify(r.state).includes('"resume"'))).toHaveLength(1);
  });

  it("while the provider is paused the retry hook stops a plan child's retries, and not another session's", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-c1", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    h.runtime.onHostEvent({ type: "execution.failed", sessionID: "ses-other", error: QUOTA, at: h.clock.iso() });
    await until(() => h.parts().policy.raised.length === 1, "usage-limit item");

    expect(h.runtime.onRetryHook({ sessionID: "ses-c1", stepKey: "k1", error: QUOTA })).toEqual({ stop: true });
    expect(h.runtime.onRetryHook({ sessionID: "ses-other", stepKey: "k2", error: QUOTA })).toEqual({ stop: false });

    run.end({ kind: "failed", childSessionID: "ses-c1", error: QUOTA, endedAt: h.clock.iso() });
    await until(() => h.task("T1").attempts[0]?.outcome === "capacity", "capacity outcome");
    expect(h.parts().policy.counted).toEqual([]);
  });

  it("a retry event that was not scheduled by the host is not a capacity signal", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    h.runtime.onHostEvent({ type: "retry", sessionID: "ses-x", stepKey: "k1", source: "hook", error: ERR_RATE_LIMIT, at: h.clock.iso() });
    await pause(30);
    expect((await h.metrics()).some((m) => m.name === "capacity")).toBe(false);
  });

  it("a paused phase wakes the orchestrator once per anchor and launches none of its tasks", async () => {
    const draft = planOf([task("T1")]);
    need(draft.phases[0], "phase").paused = true;
    const h = await mk(draft);
    await h.begin();
    await until(() => h.hosts.keys().includes("phase-paused:p1:none"), "phase-paused wake");
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.keys()).toEqual(["phase-paused:p1:none"]);
    expect(h.launcher.runs).toHaveLength(0);
  });

  it("a paused phase whose newest inbox item was already woken for does not wake again", async () => {
    const draft = planOf([task("T1")]);
    need(draft.phases[0], "phase").paused = true;
    const h = await mk(draft);
    await h.begin();
    await until(() => h.hosts.keys().includes("phase-paused:p1:none"), "first phase-paused wake");
    await h.settled();
    h.clock.advance(1000); // past the debounce of the first wake

    const item = await h.parts().policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "why?", options: [] });
    h.parts().listener.onInbox(item);
    await until(() => h.hosts.keys().includes(`inbox:${item.id}`), "inbox wake");
    // A newer item that names no task is skipped when the anchor is searched: the anchor stays the T1 item.
    await h.parts().policy.raise({ kind: "flaky", severity: "blocking", taskId: null, text: "flaky check", options: [] });
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.keys()).toEqual(["phase-paused:p1:none", `inbox:${item.id}`]);
  });
});

describe("QA-3.1 round 1 regressions (runtime)", () => {
  const QUOTA = { type: "provider.quota", status: 402, message: "usage limit reached" };
  const counted = async (h: Harness, key: string, row: string): Promise<boolean> =>
    (await h.counters()).some((c) => c.key === key && c.labels.row === row);

  it("QA-3.1-1: start() subscribes onHostEvent through hosts.onEvent; idle-with-ready comes from the orchestrator's events; dispose unsubscribes", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.runtime.start();
    expect(h.hosts.listeners.size).toBe(1);
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "stale-context wake");
    h.hosts.emit({ type: "execution.completed", sessionID: ORCH, at: h.clock.iso() });
    await h.settled();
    h.clock.advance(3000);
    h.hosts.emit({ type: "step.started", sessionID: ORCH, providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    await h.settled();
    const idle = need((await h.metrics()).find((m) => m.name === "idle-with-ready"), "idle-with-ready metric");
    expect(idle).toMatchObject({ ms: 3000, readyTaskIds: ["T1"] });
    await h.runtime.dispose();
    expect(h.hosts.listeners.size).toBe(0);
  });

  it("QA-3.1-1 / nit 2: a quota error of a plan child pauses its provider, names its task, and the capacity end is not relaunched into the pause", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.runtime.start();
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    h.hosts.emit({ type: "step.started", sessionID: "ses-c1", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    h.hosts.emit({ type: "step.failed", sessionID: "ses-c1", error: QUOTA, at: h.clock.iso() });
    await until(() => h.parts().policy.raised.length === 1, "usage-limit item");
    expect(h.parts().policy.raised[0]).toMatchObject({ kind: "usage-limit", taskId: "T1" });

    run.end({ kind: "capacity", childSessionID: "ses-c1", error: QUOTA, endedAt: h.clock.iso() });
    await until(() => h.state("T1") === "ready", "T1 back to ready (row 18)");
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.launcher.runs).toHaveLength(1);
    expect((await h.runtime.ready(PLAN_ID)).launchable).toEqual([]);
    expect(await counted(h, "launch-failed", "L15")).toBe(true);
  });

  it("QA-3.1-4: three consecutive losses before confirmation pause the plan and raise one blocking item; nothing relaunches", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    for (let n = 1; n <= 3; n++) {
      const run = await h.runOf("T1", n);
      run.confirm({ kind: "unconfirmed", reason: "threw", error: "runner crashed" });
    }
    await until(() => h.ledger().status === "paused", "plan paused");
    await until(() => h.parts().policy.raised.length === 1, "one blocking item");
    expect(h.parts().policy.raised[0]).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T1" });
    h.runtime.onRouterToolCall(ORCH);
    await pause(30);
    expect(h.launcher.runs).toHaveLength(3);
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost", "lost", "lost"]);
    expect(h.parts().policy.counted).toEqual([]);
  });

  it("QA-3.1-17: three parallel launches lost under ONE capture count once: the plan keeps running and relaunches them", async () => {
    const h = await mk(planOf([task("T1"), task("T2"), task("T3")]));
    await h.begin();
    const first = [await h.runOf("T1", 1), await h.runOf("T2", 1), await h.runOf("T3", 1)];
    expect(first.map((r) => r.req.context.callID)).toEqual(["call-1", "call-1", "call-1"]);
    for (const run of first) run.confirm({ kind: "unconfirmed", reason: "threw", error: "runner crashed" });
    for (const id of ["T1", "T2", "T3"]) await h.runOf(id, 2);
    expect(h.ledger().status).toBe("running");
    expect(h.parts().policy.raised).toEqual([]);
  });

  it("QA-3.1-17: three losses under three distinct captures still pause the plan (one blocking item)", async () => {
    const h = await mk(planOf([task("T1")]));
    const capture = (n: number): LaunchGate => ({ ok: true, context: { ...GATE_CONTEXT, callID: `call-${n}` }, ageMs: 0 });
    await h.begin();
    for (let n = 1; n <= 3; n++) {
      const run = await h.runOf("T1", n);
      h.launcher.gateValue = capture(n + 1);
      run.confirm({ kind: "unconfirmed", reason: "threw", error: "runner crashed" });
    }
    await until(() => h.ledger().status === "paused", "plan paused");
    await until(() => h.parts().policy.raised.length === 1, "one blocking item");
    expect(h.task("T1").attempts.map((a) => a.callID)).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("QA-3.1-5: a debounced wake after a failed delivery re-arms for the end of the window and journals no 'debounced' metric", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    h.hosts.failures = 1;
    await h.begin();
    await until(() => h.hosts.attempted.length === 1, "first attempt (fails)");
    await h.settled();
    h.launcher.gateValue = staleGate("stale-context:boot:2");
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    const wakes = (await h.metrics()).flatMap((m) => (m.name === "wake" ? [`${m.stateKey}:${m.result}`] : []));
    expect(wakes).toEqual(["stale-context:boot:1:failed"]);
    expect(h.hosts.attempted).toEqual(["stale-context:boot:1"]);
    h.clock.advance(1000);
    await until(() => h.hosts.keys().includes("stale-context:boot:2"), "boot:2 sent after the window");
  });

  it("QA-3.1-6: a skipped launch arms a backoff tick (1 s, 2 s, 4 s, ...); five provisioning failures raise one item; onLeaseReleased ticks", async () => {
    const h = await mk(planOf([task("T1")]));
    let calls = 0;
    const acquire = h.slots.acquire.bind(h.slots);
    h.slots.acquire = async (planId, owner, base) => {
      calls += 1;
      if (calls <= 5) throw new Error("install failed");
      return acquire(planId, owner, base);
    };
    await h.begin();
    for (let k = 0; k < 4; k++) {
      await until(() => calls === k + 1, `provisioning failure ${k + 1}`);
      await h.settled();
      expect(calls).toBe(k + 1); // nothing re-ticks before the backoff
      h.clock.advance(1000 * 2 ** k);
    }
    await until(() => calls === 5, "fifth provisioning failure");
    await until(() => h.parts().policy.raised.length === 1, "provisioning item");
    expect(h.parts().policy.raised[0]).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T1" });
    await h.settled();
    h.runtime.onLeaseReleased();
    await h.runOf("T1", 1);
    expect(h.parts().policy.raised).toHaveLength(1);
  });

  it("QA-3.1-26: resume drops a backoff armed before the pause: the next skip backs off from 1 s again", async () => {
    const h = await mk(planOf([task("T1")]));
    let calls = 0;
    let failing = true;
    const acquire = h.slots.acquire.bind(h.slots);
    h.slots.acquire = async (planId, owner, base) => {
      calls += 1;
      if (failing) throw new Error("install failed");
      return acquire(planId, owner, base);
    };
    await h.begin();
    for (let k = 0; k < 3; k++) {
      await until(() => calls === k + 1, `provisioning failure ${k + 1}`);
      await h.settled();
      h.clock.advance(1000 * 2 ** k);
    }
    await until(() => calls === 4, "fourth provisioning failure");
    await h.settled(); // the backoff is now armed for 8 s
    await h.runtime.pause(PLAN_ID, ORCH);
    await h.runtime.resume(PLAN_ID, ORCH);
    await until(() => calls === 5, "the resume tick retries at once");
    await h.settled(); // that skip armed a fresh 1 s backoff: the 8 s timer was cleared, not kept
    failing = false;
    h.clock.advance(1000);
    await h.runOf("T1", 1);
    expect(calls).toBe(6);
  });

  it("QA-3.1-23: a step queued behind its task mutex already holds its token: the next tick schedules nothing over capacity (no capacity-race)", async () => {
    const manual = task("M1", { kind: "manual", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } });
    const h = await mk(planOf([task("T1"), manual, task("T2")], { edges: [edge("M1", "T2")], config: { maxParallel: 1 } }));
    await h.begin();
    const r1 = await h.running("T1", 1, "ses-c1");
    // The lease-needed end (18b') frees T1's token and sends it back to ready, then holds T1's mutex in the slot release.
    const hold = deferred<void>();
    let entered = false;
    const release = h.slots.release.bind(h.slots);
    h.slots.release = async (slot) => {
      entered = true;
      await hold.promise;
      return release(slot);
    };
    r1.complete("NEED MORE: lease src/extra.ts");
    await until(() => entered && h.state("T1") === "ready", "T1 ready, its mutex held by the slot release");
    h.runtime.onRouterToolCall(ORCH); // tick A: T1's step queues behind the mutex
    await pause(30);
    await h.runtime.done(PLAN_ID, "M1", ORCH); // tick B, back to back: T2 becomes ready
    await until(() => h.state("T2") === "ready", "T2 ready");
    await pause(30);
    expect(h.launcher.runOf("T2", 1)).toBeUndefined();
    hold.resolve();
    await h.runOf("T1", 2);
    expect(h.launcher.runOf("T2", 1)).toBeUndefined();
    const races = (await h.counters()).filter((c) => c.key === "launch-skipped" && c.labels.reason === "capacity-race");
    expect(races).toEqual([]);
  });

  it("QA-3.1-7 / QA-3.1-19: one active plan per process: approving a second plan is E_PLAN_STATE; a second running plan attaches passively (inbox item, one wake) and can still be paused", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    const second = (planId: string, status: LedgerV1["status"]): LedgerV1 => {
      const d2 = planOf([task("T9")]);
      d2.planId = planId;
      d2.status = status;
      return d2;
    };
    for (const [id, status] of [["plan-two", "awaiting-approval"], ["plan-three", "running"]] as const) {
      const w = await h.store.create(second(id, status), h.deps.holder(ORCH));
      await w.close();
    }
    await expect(h.runtime.approve("plan-two", ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    // QA-3.1-19: the refused plan is attached passively, so pause (the escape hatch) reaches it instead of E_PLAN_STATE.
    await h.runtime.pause("plan-three", ORCH);
    expect((await h.store.read("plan-three")).status).toBe("paused");
    for (const id of ["plan-two", "plan-three"]) {
      const l = await h.store.read(id);
      expect(l.inbox.filter((i) => i.severity === "blocking" && i.text.includes(`plan ${PLAN_ID} is already running`))).toHaveLength(1);
    }
    expect((await h.store.read("plan-two")).status).toBe("awaiting-approval");
    expect(h.hosts.keys().filter((k) => k === `plan-refused:plan-three:${PLAN_ID}`)).toHaveLength(1);
    // Never activated, pinned or ticked: one pin (plan one), one launch (T1), and T9 is not launched.
    expect(h.pins).toEqual([ORCH]);
    h.runtime.onRouterToolCall(ORCH);
    await pause(30);
    expect(h.launcher.runs).toHaveLength(1);
  });

  const storedPlan = async (h: Harness, planId: string, status: LedgerV1["status"]): Promise<void> => {
    const d2 = planOf([task("T9")]);
    d2.planId = planId;
    d2.status = status;
    const w = await h.store.create(d2, h.deps.holder(ORCH));
    await w.close();
  };

  it("QA-3.1-18: two concurrent approves never both start: the activation reservation is taken before the first await", async () => {
    const h = await mk(planOf([task("T1")]));
    await storedPlan(h, "plan-a", "awaiting-approval");
    await storedPlan(h, "plan-b", "awaiting-approval");
    const results = await Promise.allSettled([h.runtime.approve("plan-a", ORCH), h.runtime.approve("plan-b", ORCH)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = need(results.find((r): r is PromiseRejectedResult => r.status === "rejected"), "refused approve");
    expect(refused.reason).toMatchObject({ code: "E_PLAN_STATE" });
    const statuses = [(await h.store.read("plan-a")).status, (await h.store.read("plan-b")).status].sort();
    expect(statuses).toEqual(["awaiting-approval", "running"]);
    expect(h.pins).toEqual([ORCH]);
  });

  it("QA-3.1-19: start() prefers a running plan over a paused one; the paused one attaches passively (woken once) and keeps abort, answer, status and gc", async () => {
    const h = await mk(planOf([task("T1")]));
    await storedPlan(h, "plan-a", "paused");
    await storedPlan(h, "plan-b", "running");
    await h.runtime.start();
    expect(h.pins).toEqual([ORCH]);
    await h.runOf("T9", 1); // plan-b (running) is the active plan, although plan-a sorts first by id
    const refusal = (await h.store.read("plan-a")).inbox.filter((i) => i.text.includes("plan plan-b is already running"));
    expect(refusal).toHaveLength(1);
    expect((await h.store.read("plan-b")).inbox).toEqual([]);
    await expect(h.runtime.status("plan-a", ORCH)).resolves.toContain("Plan plan-a [paused]");
    await expect(h.runtime.status("plan-a", ORCH)).resolves.toContain("Refused: another plan holds this process's active slot");
    await expect(h.runtime.status("plan-b", ORCH)).resolves.not.toContain("Refused:");
    expect(h.hosts.keys().filter((k) => k === "plan-refused:plan-a:plan-b")).toHaveLength(1);
    // A resume would make it a second active plan: refused; an answer reaches it.
    await expect(h.runtime.resume("plan-a", ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await h.runtime.answer("plan-a", need(refusal[0], "refusal item").id, "ok", ORCH);
    // gc keeps the refused plan's slots until it is aborted.
    await h.runtime.gc();
    const isDone = need(h.slots.gcPredicate, "gc predicate");
    await expect(isDone("plan-a")).resolves.toBe(false);
    await h.runtime.abort("plan-a", ORCH);
    expect((await h.store.read("plan-a")).status).toBe("aborted");
    await expect(isDone("plan-a")).resolves.toBe(true);
    expect(h.launcher.runs).toHaveLength(1);
  });

  it("QA-3.1-11 / QA-3.1-22: a RouteResolver error is uncounted and retried by the backoff tick (never a broken tick, status or ready); five failing rounds raise one item", async () => {
    const h = await mk(planOf([task("T1"), task("T2")], { config: { maxAttempts: 1 } }));
    let failing = true;
    h.deps.routes = {
      route: (t) => {
        if (t.id === "T2" && failing) throw new Error("no model for T2");
        return routes.route(t);
      },
    };
    const routeSkips = async (): Promise<number> =>
      (await h.counters()).filter((c) => c.key === "launch-skipped" && c.labels.reason === "route" && c.labels.taskId === "T2").length;
    // Backoff arms (the ledger heartbeat timer is hours long and never counted here).
    const arms: number[] = [];
    const setTimer = h.clock.setTimer.bind(h.clock);
    h.clock.setTimer = (ms, fn) => {
      if (ms <= 60_000) arms.push(ms);
      return setTimer(ms, fn);
    };
    await h.begin();
    // Right after compile the first tick may not have promoted T1/T2 to ready yet: status and ready only must not throw.
    await expect(h.runtime.status(PLAN_ID, ORCH)).resolves.toContain(`Plan ${PLAN_ID}`);
    await expect(h.runtime.ready(PLAN_ID)).resolves.toMatchObject({ manual: [] });
    const r1 = await h.running("T1", 1, "ses-c1");
    r1.complete("Done.");
    await untilEnqueued(h, "T1");
    await until(async () => (await routeSkips()) >= 1, "route skip counted");
    // T2 is ready now: the board lists it as unroutable with the resolver's message (QA-3.1-11), and ready() still answers.
    expect(h.state("T2")).toBe("ready");
    await expect(h.runtime.status(PLAN_ID, ORCH)).resolves.toContain("T2 unroutable - no model for T2");
    await expect(h.runtime.ready(PLAN_ID)).resolves.toMatchObject({ launchable: [], manual: [] });
    // Round 1 (the first tick) armed the backoff once; the ticks behind it inside the round armed nothing more. Nothing
    // was journaled for T2 and nothing counted.
    expect(arms).toHaveLength(1);
    expect(h.task("T2").attempts).toEqual([]);
    expect(h.state("T2")).toBe("ready");
    expect(await counted(h, "launch-failed", "L1")).toBe(false);
    for (let round = 2; round <= 5; round++) {
      expect(h.parts().policy.raised).toEqual([]);
      h.clock.advance(60_000);
      await until(() => arms.length === round, `round ${round} re-armed the backoff`);
    }
    await until(() => h.parts().policy.raised.length === 1, "one route-streak item");
    expect(h.parts().policy.raised[0]).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T2" });
    expect(h.parts().policy.raised[0]?.text).toContain("no model for T2");
    h.clock.advance(60_000);
    await until(() => arms.length === 6, "round 6 re-armed the backoff");
    await h.settled();
    expect(h.parts().policy.raised).toHaveLength(1);
    expect(h.task("T2").attempts).toEqual([]);
    // The resolver recovers: the next backoff tick launches T2's FIRST attempt (no attempt was burnt).
    failing = false;
    h.clock.advance(60_000);
    await h.runOf("T2", 1);
    expect(h.parts().policy.counted.filter((c) => c.n !== 1 || c.outcome !== "succeeded")).toEqual([]);
  });

  it("QA-3.1-12: a row 4b batch that writes nothing frees the fresh slot and its leases", async () => {
    const h = await mk(planOf([task("T1", { route: { line: "task: do it", role: "implementer", tier: "fast", pin: false } })]));
    h.slots.onAcquire = () => {
      h.slots.onAcquire = null;
      void h.parts().writer.append([{ type: "status-changed", from: "running", to: "paused", reason: "user-pause" }]);
    };
    await h.begin();
    await until(() => h.slots.released.length === 1, "fresh slot released");
    expect(h.slots.released).toEqual(["slot-1"]);
    expect(h.task("T1").attempts).toEqual([]);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it("QA-3.1-12: a throwing lease registry frees the fresh slot and skips the launch", async () => {
    const h = await mk(planOf([task("T1")]));
    h.registry.acquireWrite = () => {
      throw new Error("registry down");
    };
    await h.begin();
    await until(() => h.slots.released.length === 1, "fresh slot released");
    expect(h.slots.released).toEqual(["slot-1"]);
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("T1")).toBe("ready");
  });

  it("QA-3.1-14: a slow slot acquire does not hold the tick: another task fails, retries and relaunches meanwhile", async () => {
    const h = await mk(planOf([task("T1"), task("T2")]));
    const hold = deferred<void>();
    const acquire = h.slots.acquire.bind(h.slots);
    h.slots.acquire = async (planId, owner, base) => {
      if (owner.endsWith(":T1")) await hold.promise;
      return acquire(planId, owner, base);
    };
    await h.begin();
    const run = await h.running("T2", 1, "ses-c2");
    run.end({ kind: "failed", childSessionID: "ses-c2", error: { type: "provider.internal", status: 500, message: "boom" }, endedAt: h.clock.iso() });
    await h.runOf("T2", 2);
    expect(h.launcher.runOf("T1", 1)).toBeUndefined();
    hold.resolve();
    await h.runOf("T1", 1);
  });

  it("nit 7: launch-failed counts L16 (superseded cancel), L13 (runner error), L14 (unrequested interrupt) and L17 (dispose)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    // "threw" leaves the double's completion open, so the relaunch cancels it as superseded (R4): L16.
    (await h.runOf("T1", 1)).confirm({ kind: "unconfirmed", reason: "threw", error: null });
    const r2 = await h.running("T1", 2, "ses-c2");
    r2.end({ kind: "lost", childSessionID: "ses-c2", reason: "runner-error", endedAt: h.clock.iso() });
    const r3 = await h.running("T1", 3, "ses-c3");
    r3.end({ kind: "lost", childSessionID: "ses-c3", reason: "unrequested-interrupt", endedAt: h.clock.iso() });
    const r4 = await h.running("T1", 4, "ses-c4");
    for (const row of ["L6", "L16", "L13", "L14"]) {
      await until(() => counted(h, "launch-failed", row), `launch-failed ${row}`);
    }
    // QA-3.1-25: a real dispose. The launcher aborts the live child only after the runtime marked the plan disposed, so
    // L17 is counted by dispose itself for each live launch (once), never by the end that follows.
    h.launcher.abortOnDispose = true;
    await h.runtime.dispose();
    expect(r4.settled).toBe(true);
    const l17 = (await h.counters()).filter((c) => c.key === "launch-failed" && c.labels.row === "L17");
    expect(l17).toHaveLength(1);
    expect(h.ledger().status).toBe("running");
  });

  it("QA-3.1-8: a step event's adapter stepKey wins over the runtime's own step counter, which stays the fallback", async () => {
    const seen: string[] = [];
    const h = await mk(planOf([task("T1")]));
    h.deps.capacity = (o) => {
      const c = createCapacityController(o);
      const onSignal = c.onSignal.bind(c);
      c.onSignal = (s) => {
        seen.push(`${s.source}:${s.stepKey}`);
        return onSignal(s);
      };
      return c;
    };
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    const E500 = { type: "provider.internal", status: 500, message: "x" };
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    const keyedStep = { type: "step.failed" as const, sessionID: "ses-x", error: E500, at: h.clock.iso(), stepKey: "adapter-7" };
    h.runtime.onHostEvent(keyedStep);
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-x", error: E500, at: h.clock.iso() });
    const keyedEnd = { type: "execution.failed" as const, sessionID: "ses-x", error: E500, at: h.clock.iso(), stepKey: "adapter-8" };
    h.runtime.onHostEvent(keyedEnd);
    expect(seen).toEqual(["step-failed:adapter-7", "step-failed:ses-x:1", "execution-failed:adapter-8"]);
  });

  it("QA-3.1-15: the orchestrator is unpinned when its plan completes", async () => {
    const h = await mk(
      planOf([task("M1", { kind: "manual", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } })], {
        gate: "passed",
      }),
    );
    await h.begin();
    expect(h.pins).toEqual([ORCH]);
    await h.runtime.done(PLAN_ID, "M1", ORCH);
    await until(() => h.ledger().status === "completed", "plan completed");
    await until(() => h.unpins.length === 1, "orchestrator unpinned");
    expect(h.unpins).toEqual([ORCH]);
  });
});

describe("late child end synthesized from host events", () => {
  /** The launch completion settles as 'interrupted' (ignored by the runtime) while the child session keeps running. */
  const detach = async (h: Harness, sessionID: string): Promise<RunDouble> => {
    const run = await h.running("T1", 1, sessionID);
    run.end({ kind: "interrupted", childSessionID: sessionID, reason: "dispose", endedAt: h.clock.iso() });
    await pause(20);
    expect(h.state("T1")).toBe("running");
    return run;
  };
  const hostEvent = (h: Harness, type: "execution.completed" | "execution.interrupted", sessionID: string): void =>
    h.runtime.onHostEvent({ type, sessionID, at: h.clock.iso() });

  it("execution.completed takes the child's last assistant message as its result and the task moves on to verified", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await detach(h, "ses-c1");
    h.hosts.contexts.set("ses-c1", {
      messages: [
        { role: "assistant", text: "Done. Implemented it.", outcome: null },
        { role: "assistant", text: null, outcome: null },
        { role: "user", text: "thanks", outcome: null },
      ],
    });
    hostEvent(h, "execution.completed", "ses-c1");
    await untilEnqueued(h, "T1");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "pass" });
  });

  it("the last assistant message decides how the result is classified", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await detach(h, "ses-c1");
    h.hosts.contexts.set("ses-c1", { messages: [{ role: "assistant", text: "NEED CONTEXT: which API?", outcome: null }] });
    hostEvent(h, "execution.completed", "ses-c1");
    await until(() => h.state("T1") === "parked", "T1 parked");
    expect(h.parts().policy.parks).toEqual([{ taskId: "T1", cause: "ambiguity", text: "NEED CONTEXT: which API?" }]);
  });

  it("an unreadable child context is logged and the result counts as an empty ordinary completion", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await detach(h, "ses-c1");
    h.hosts.context = async () => {
      throw new Error("session gone");
    };
    hostEvent(h, "execution.completed", "ses-c1");
    await untilEnqueued(h, "T1");
    expect(h.logs.some((l) => l.startsWith("warn: child context read failed") && l.includes("session gone"))).toBe(true);
  });

  it("execution.failed with an ordinary error fails the attempt; with a capacity error it is uncounted", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await detach(h, "ses-c1");
    h.runtime.onHostEvent({
      type: "execution.failed",
      sessionID: "ses-c1",
      error: { type: "provider.internal", status: 500, message: "boom" },
      at: h.clock.iso(),
    });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "failed", context: "provider.internal: boom" });

    await h.running("T1", 2, "ses-c2").then((run) => run.end({ kind: "interrupted", childSessionID: "ses-c2", reason: "dispose", endedAt: h.clock.iso() }));
    await pause(20);
    h.runtime.onHostEvent({ type: "execution.failed", sessionID: "ses-c2", error: ERR_RATE_LIMIT, at: h.clock.iso() });
    await h.runOf("T1", 3);
    const a2 = need(h.task("T1").attempts[1], "attempt 2");
    expect(a2.outcome).toBe("capacity");
    expect(countsTowardMaxAttempts(a2)).toBe(false);
  });

  it("execution.interrupted loses the running attempt without counting it", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await detach(h, "ses-c1");
    hostEvent(h, "execution.interrupted", "ses-c1");
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
    expect(h.parts().policy.counted).toEqual([]);
  });

  it("a terminal event for a child whose launch is still pending is left to the launcher", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    hostEvent(h, "execution.completed", "ses-c1");
    hostEvent(h, "execution.completed", "ses-unrelated");
    await pause(30);
    expect(h.state("T1")).toBe("running");
    expect(h.launcher.runs).toHaveLength(1);
  });

  it("events of other kinds for the child do nothing and the orchestrator's own events flip the idle flag", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await detach(h, "ses-c1");
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-c1", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    h.runtime.onHostEvent({ type: "step.started", sessionID: ORCH, providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    h.runtime.onHostEvent({ type: "execution.failed", sessionID: ORCH, error: { type: "provider.internal", status: 500, message: "x" }, at: h.clock.iso() });
    await pause(30);
    expect(h.state("T1")).toBe("running");
  });
});

describe("capacity, metric, dispose and restart failure paths", () => {
  const manualOnly = (id: TaskId): TaskNode =>
    task(id, { kind: "manual", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } });
  const logged = (h: Harness, prefix: string, text: string): boolean => h.logs.some((l) => l.startsWith(prefix) && l.includes(text));

  it("a capacity token that cannot be taken at launch skips the task as 'capacity-race' before any slot is taken", async () => {
    const h = await mk(planOf([task("T1")]));
    h.deps.capacity = (o) => {
      const c = createCapacityController(o);
      c.acquire = () => {
        throw new ExecutorError("E_CAPACITY", "no token");
      };
      return c;
    };
    await h.begin();
    await until(async () => (await h.counters()).some((c) => c.key === "launch-skipped" && c.labels.reason === "capacity-race"), "capacity-race counter");
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.log.some((l) => l.startsWith("slots.acquire"))).toBe(false);
    expect(h.state("T1")).toBe("ready");
  });

  it("adopting a late child when no capacity token can be forced refuses it with E_CAPACITY and keeps the task ready", async () => {
    const h = await mk(planOf([task("T1")]));
    h.deps.capacity = (o) => {
      const c = createCapacityController(o);
      const acquire = c.acquire.bind(c);
      c.acquire = (provider, heavy, taskId, attempt, opts) => {
        if (opts?.force === true) throw new Error("capacity exhausted");
        return acquire(provider, heavy, taskId, attempt, opts);
      };
      return c;
    };
    await h.begin();
    const run = await h.runOf("T1", 1);
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("T1") === "ready", "T1 back to ready");
    expect(await run.hooks.onLateChild("ses-late")).toBe("adopt");
    await expect(run.hooks.onChildCreated("ses-late")).rejects.toMatchObject({ code: "E_CAPACITY" });
    expect(h.state("T1")).toBe("ready");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost", childSessionID: null });
  });

  it("capacity errors never escape: a failing signal feed is logged and stops no retry, a failing release is a warning", async () => {
    const h = await mk(planOf([task("T1")]));
    h.deps.capacity = (o) => {
      const c = createCapacityController(o);
      c.release = () => {
        throw new Error("release boom");
      };
      c.onSignal = () => {
        throw new Error("signal boom");
      };
      return c;
    };
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    expect(h.runtime.onRetryHook({ sessionID: "ses-c1", stepKey: "s1", error: ERR_RATE_LIMIT })).toEqual({ stop: false });
    expect(logged(h, "error: retry hook failed", "signal boom")).toBe(true);
    h.runtime.onHostEvent({ type: "retry", sessionID: "ses-c1", stepKey: "s1", source: "scheduled", error: ERR_RATE_LIMIT, at: h.clock.iso() });
    expect(logged(h, "error: host event handling failed", "signal boom")).toBe(true);

    run.complete("Done.");
    await untilEnqueued(h, "T1");
    expect(logged(h, "warn: capacity release failed", "release boom")).toBe(true);
  });

  it("each new step of a session is a new step key: only the first rate-limit signal of a step decreases capacity", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    const at = h.clock.iso();
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-x", error: ERR_RATE_LIMIT, at });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-x", error: ERR_RATE_LIMIT, at }); // same step: no second decrease
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-x", error: ERR_RATE_LIMIT, at });
    await h.settled();
    const decreases = (await h.metrics()).filter((m) => m.name === "capacity" && m.change === "decrease");
    expect(decreases).toHaveLength(2);
  });

  it("QA-3.1-27: a step that ended (step.ended) closes the fallback step: the next step.started opens a new step key", async () => {
    const seen: string[] = [];
    const h = await mk(planOf([manualOnly("M1")]));
    h.deps.capacity = (o) => {
      const c = createCapacityController(o);
      const onSignal = c.onSignal.bind(c);
      c.onSignal = (s) => {
        seen.push(`${s.source}:${s.stepKey}`);
        return onSignal(s);
      };
      return c;
    };
    await h.begin();
    const at = h.clock.iso();
    const E500 = { type: "provider.internal", status: 500, message: "x" };
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at });
    h.runtime.onHostEvent({ type: "step.ended", sessionID: "ses-x", at });
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-x", error: E500, at });
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-x", error: E500, at });
    expect(seen).toEqual(["step-failed:ses-x:2", "step-failed:ses-x:3"]);
    await h.settled();
  });

  it("a metric that cannot be journaled is a warning, and the metrics after it still land", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    await h.settled();
    const w = h.parts().writer;
    const append = w.append.bind(w);
    w.append = async (b) => {
      if (typeof b !== "function" && JSON.stringify(b).includes('"key":"lost-metric"')) throw new Error("disk full");
      return append(b);
    };
    h.runtime.recordMetric(PLAN_ID, { name: "counter", key: "lost-metric", value: 1, labels: {} });
    h.runtime.recordMetric(PLAN_ID, { name: "counter", key: "kept-metric", value: 1, labels: {} });
    await h.settled();
    expect(logged(h, "warn: metric append failed", "disk full")).toBe(true);
    const keys = (await h.counters()).map((c) => c.key);
    expect(keys).toContain("kept-metric");
    expect(keys).not.toContain("lost-metric");
  });

  it("dispose logs a launcher that fails to dispose and a plan that fails to close, and still detaches the plan", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    h.launcher.dispose = async () => {
      throw new Error("launcher boom");
    };
    const w = h.parts().writer;
    const close = w.close.bind(w);
    w.close = async () => {
      await close();
      throw new Error("close boom");
    };
    await h.runtime.dispose();
    expect(logged(h, "warn: launcher dispose failed", "launcher boom")).toBe(true);
    expect(logged(h, "warn: plan close failed", "close boom")).toBe(true);
    expect(h.runtime.planLine(ORCH)).toBeNull();
    expect(h.unpins).toEqual([ORCH]);
  });

  it("a lease rebuild item that cannot be raised is a warning and the plan still attaches", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    const release = h.registry.releaseTask.bind(h.registry);
    h.registry.releaseTask = (ref: string): void => {
      release(ref);
      h.registry.plant("src/T1.ts", "ses-foreign", null);
    };
    const collaborators = h.deps.collaborators;
    h.deps.collaborators = (i) => {
      const c = collaborators(i);
      c.policy.raise = async () => {
        throw new Error("inbox down");
      };
      return c;
    };
    await h.restart();
    expect(logged(h, "warn: lease rebuild inbox failed", "inbox down")).toBe(true);
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);
  });

  it("a tick before a failed wake's retry is due re-arms instead of sending early", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    h.hosts.failures = 1;
    await h.begin();
    await until(() => h.hosts.attempted.length === 1, "first attempt");
    await h.settled();
    h.clock.advance(500);
    h.runtime.onRouterToolCall(ORCH);
    await h.settled();
    expect(h.hosts.attempted).toEqual(["stale-context:boot:1"]);

    h.clock.advance(500);
    await until(() => h.hosts.attempted.length === 2, "retry when due");
    expect(h.hosts.keys()).toEqual(["stale-context:boot:1#2"]);
  });

  it("start attaches only running or paused plans that are not attached yet", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    const parts = h.parts();
    await h.runtime.start();
    expect(h.parts()).toBe(parts);
    expect(h.pins).toEqual([ORCH]);

    await h.runtime.abort(PLAN_ID, ORCH);
    await h.restart();
    expect(h.parts()).toBe(parts); // the aborted plan was not attached again
    expect(h.runtime.planLine(ORCH)).toBeNull();
    expect(h.runtime.manualReady(ORCH)).toEqual([]);
  });

  it("manualReady lists only the plans of the asking session", async () => {
    const h = await mk(planOf([manualOnly("M1")]));
    await h.begin();
    await until(() => h.runtime.manualReady(ORCH).length === 1, "M1 ready");
    expect(h.runtime.manualReady("ses-other")).toEqual([]);
  });
});

describe("qa gates, own-path leases and abort leftovers", () => {
  const qaTask = (patch: Partial<TaskNode> = {}): TaskNode =>
    task("Q1", { kind: "qa", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] }, ...patch });

  it("a qa launch that is lost puts the phase gate back to awaiting-qa (G2)", async () => {
    const h = await mk(planOf([qaTask()], { gate: "awaiting-qa" }));
    await h.begin();
    const run = await h.runOf("Q1", 1);
    expect(h.ledger().phases[0]?.gate).toBe("qa-running");
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("Q1") === "ready", "Q1 back to ready");
    expect(h.ledger().phases[0]?.gate).toBe("awaiting-qa");
    expect(h.task("Q1").attempts[0]?.outcome).toBe("lost");
  });

  it("a qa child that is lost while running puts the gate back to awaiting-qa", async () => {
    const h = await mk(planOf([qaTask()], { gate: "awaiting-qa" }));
    await h.begin();
    const run = await h.running("Q1", 1, "ses-q1");
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    run.end({ kind: "lost", childSessionID: "ses-q1", reason: "restart", endedAt: h.clock.iso() });
    await until(() => h.state("Q1") === "ready", "Q1 back to ready");
    expect(h.ledger().phases[0]?.gate).toBe("awaiting-qa");
  });

  it("a qa task with a malformed route line fails at prep (row 4b) and leaves the gate awaiting-qa", async () => {
    const h = await mk(
      planOf([qaTask({ route: { line: "task: do it", role: "implementer", tier: "fast", pin: false } })], {
        gate: "awaiting-qa",
        config: { maxAttempts: 1 },
      }),
    );
    await h.begin();
    await until(() => h.state("Q1") === "parked", "Q1 parked");
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.task("Q1").attempts[0]?.outcome).toBe("failed");
    expect(h.ledger().phases[0]?.gate).toBe("awaiting-qa");
    const gates = (await h.events()).flatMap((e) => (e.type === "gate-changed" ? [`${e.from}>${e.to}:${e.trigger}`] : []));
    expect(gates).toEqual(["awaiting-qa>qa-running:qa-dispatched", "qa-running>awaiting-qa:qa-requeued"]);
  });

  it("R6: a lease request for a path the task already holds itself is unresolvable", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("NEED MORE: lease src/T1.ts\nagain");
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "failed", context: "lease-unresolvable: NEED MORE: lease src/T1.ts" });
    expect(h.task("T1").footprint.writes).toEqual(["src/T1.ts"]);
  });

  it("abort frees the slots of a verified task and of a ready task with no live child, cancelling no launch", async () => {
    const h = await mk(planOf([task("T1"), task("T2")]));
    await h.begin();
    const r2 = await h.runOf("T2", 1);
    await toVerified(h, "T1");
    const slot1 = need(h.task("T1").slot, "T1 slot");
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    r2.end({ kind: "lost", childSessionID: null, reason: "restart", endedAt: h.clock.iso() });
    await until(() => h.state("T2") === "ready", "T2 ready");
    const slot2 = need(h.task("T2").slot, "T2 slot");
    expect(h.slots.released).toEqual([]);

    await h.runtime.abort(PLAN_ID, ORCH);
    expect(h.ledger().status).toBe("aborted");
    expect(h.state("T1")).toBe("cancelled");
    expect(h.state("T2")).toBe("cancelled");
    expect(h.task("T1").slot).toBeNull();
    expect(h.task("T2").slot).toBeNull();
    expect([...h.slots.released].sort()).toEqual([slot1, slot2].sort());
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
    expect(h.registry.heldBy("plan-one:T2")).toEqual([]);
    expect(h.log.some((l) => l.startsWith("launcher.cancel"))).toBe(false);
  });
});

describe("small rules: end clamping, model labels, lease path normalization", () => {
  it("an end reported before the attempt started is clamped to the start (A2-6)", async () => {
    const h = await mk(planOf([task("T1")]));
    h.clock.advance(5000);
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.end({ kind: "failed", childSessionID: "ses-c1", error: { type: "provider.internal", status: 500, message: "boom" }, endedAt: T0 });
    await h.runOf("T1", 2);
    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(Date.parse(a1.startedAt)).toBe(Date.parse(T0) + 5000);
    expect(a1.endedAt).toBe(a1.startedAt);
  });

  it("the launch metric names the model variant when the route has one", async () => {
    const h = await mk(planOf([task("T1")]));
    h.deps.routes = {
      route: (t) => ({ ...routes.route(t), model: { providerID: PROVIDER, modelID: "model-1", variant: "high" } }),
    };
    await h.begin();
    await h.runOf("T1", 1);
    await until(async () => (await h.metrics()).some((m) => m.name === "launch"), "launch metric");
    expect((await h.metrics()).find((m) => m.name === "launch")).toMatchObject({ model: `${PROVIDER}/model-1#high` });
  });

  it("a lease request path is normalized: backticks, a leading ./ and a trailing / are dropped", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("NEED MORE: lease `./src/extra.ts/`\nplease");
    await h.runOf("T1", 2);
    expect(h.task("T1").footprint.writes).toEqual(["src/T1.ts", "src/extra.ts"]);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "interrupted" });
  });

  it.each([["src/../secret.ts"], ["./"], ["src//x.ts"]])("a lease request for %j is not a legal path and is unresolvable", async (path) => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete(`NEED MORE: lease ${path}`);
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "failed", context: `lease-unresolvable: NEED MORE: lease ${path}` });
    expect(h.task("T1").footprint.writes).toEqual(["src/T1.ts"]);
  });
});

describe("branch top-up: error text, phase-less tasks, launch races", () => {
  const malformed = { line: "task: do it", role: "implementer", tier: "fast", pin: false } as const;

  it("a thrown string is logged as that text", async () => {
    const h = await mk(planOf([task("T1")]));
    h.registry.acquireWrite = () => {
      throw "registry offline";
    };
    await h.begin();
    await until(() => h.logs.some((l) => l.startsWith("error: launch step failed")), "launch step failure logged");
    expect(h.logs.find((l) => l.startsWith("error: launch step failed"))).toBe('error: launch step failed "registry offline"');
    expect(h.state("T1")).toBe("ready");
  });

  it("a thrown non-Error object is logged as its JSON", async () => {
    const h = await mk(planOf([task("T1", { footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } })]));
    h.git.dirty = () => false;
    h.slots.release = async () => {
      throw { reason: "pool busy" };
    };
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Nothing to change.");
    await until(() => h.logs.some((l) => l.startsWith("warn: slot release failed")), "slot release warning");
    expect(h.logs.find((l) => l.startsWith("warn: slot release failed"))).toBe(`warn: slot release failed ${JSON.stringify(JSON.stringify({ reason: "pool busy" }))}`);
    expect(h.state("T1")).toBe("done");
  });

  it("a task outside any phase is never fed to the breaker: its counted failure is not recorded with the policy", async () => {
    const h = await mk(planOf([task("T1", { phase: null })]));
    h.verifier.queue.push({ verdict: "fail", findings: "lint failed" });
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    const second = await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "fail", context: "lint failed" });
    expect(h.parts().policy.counted).toEqual([]);
    expect(second.req.prompt).toContain("lint failed");
  });

  it("a task that leaves ready while its slot is being reset is not launched (step 4 re-check) and the step frees what it took", async () => {
    const h = await mk(planOf([task("T1")]));
    let moved: Promise<unknown> | null = null;
    h.slots.onAcquire = () => {
      h.slots.onAcquire = null;
      moved = h.parts().writer.append([tr("T1", "ready", "blocked", "dep-reverted")]);
    };
    const reset = h.slots.reset.bind(h.slots);
    h.slots.reset = async (slot: string, commit: string): Promise<void> => {
      if (moved !== null) await moved;
      await reset(slot, commit);
    };
    await h.begin();
    await until(() => h.slots.released.length === 1, "slot released by the abandoned step");
    expect(h.state("T1")).toBe("blocked");
    expect(h.task("T1").attempts).toEqual([]);
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
  });

  it("a task that leaves ready while the prompt is prepared makes row 4 write nothing; the step frees what it took", async () => {
    const h = await mk(planOf([task("T1")]));
    const run = h.git.run.bind(h.git);
    let once = true;
    h.git.run = async (args: readonly string[], o: ProcOpts): Promise<ProcessResult> => {
      if (once && args[0] === "worktree") {
        once = false;
        await h.parts().writer.append([tr("T1", "ready", "blocked", "dep-reverted")]);
      }
      return run(args, o);
    };
    await h.begin();
    await until(() => h.slots.released.length === 1, "slot released by the abandoned step");
    expect(h.state("T1")).toBe("blocked");
    expect(h.task("T1").attempts).toEqual([]);
    expect(h.launcher.runs).toHaveLength(0);
  });

  it("row 4b with the launch gate closed meanwhile journals the failed attempt without a call id", async () => {
    const h = await mk(planOf([task("T1", { route: malformed })], { config: { maxAttempts: 1 } }));
    h.slots.onAcquire = () => {
      h.slots.onAcquire = null;
      h.launcher.gateValue = staleGate("stale-context:boot:1");
    };
    await h.begin();
    await until(() => h.state("T1") === "parked", "T1 parked");
    expect(h.task("T1").attempts[0]).toMatchObject({ n: 1, outcome: "failed", callID: null });
    expect(h.launcher.runs).toHaveLength(0);
  });

  it("row 4b writes nothing when the task left ready during the prep: no attempt, nothing counted or parked", async () => {
    const h = await mk(planOf([task("T1", { route: malformed })], { config: { maxAttempts: 1 } }));
    const run = h.git.run.bind(h.git);
    let once = true;
    h.git.run = async (args: readonly string[], o: ProcOpts): Promise<ProcessResult> => {
      if (once && args[0] === "worktree") {
        once = false;
        await h.parts().writer.append([tr("T1", "ready", "blocked", "dep-reverted")]);
      }
      return run(args, o);
    };
    await h.begin();
    await until(async () => (await h.counters()).some((c) => c.key === "launch-failed" && c.labels.row === "L1"), "launch-failed L1");
    expect(h.state("T1")).toBe("blocked");
    expect(h.task("T1").attempts).toEqual([]);
    expect(h.parts().policy.counted).toEqual([]);
    expect(h.parts().policy.parks).toEqual([]);
  });
});

describe("branch top-up: late children, ends, streaks, lease footprints", () => {
  it("the late-child hook refuses while the attempt is still open, and after the runtime is disposed", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    expect(await run.hooks.onLateChild("ses-early")).toBe("refuse"); // nothing was lost yet
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("T1") === "ready", "T1 back to ready");
    expect(await run.hooks.onLateChild("ses-late")).toBe("adopt");

    await h.runtime.dispose();
    expect(await run.hooks.onLateChild("ses-late")).toBe("refuse");
    await expect(run.hooks.onChildCreated("ses-late")).rejects.toThrow();
    expect(h.state("T1")).toBe("ready");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost", childSessionID: null });
  });

  it("adopting a late qa child re-opens the qa gate (G1) with the adoption, and the report then finishes the task", async () => {
    const qa = task("Q1", { kind: "qa", verify: "none", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } });
    const h = await mk(planOf([qa], { gate: "awaiting-qa" }));
    await h.runtime.start();
    await h.begin();
    const run = await h.runOf("Q1", 1);
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("Q1") === "ready", "Q1 back to ready");
    expect(h.ledger().phases[0]?.gate).toBe("awaiting-qa");

    expect(await run.hooks.onLateChild("ses-late")).toBe("adopt");
    await run.hooks.onChildCreated("ses-late");
    expect(h.state("Q1")).toBe("running");
    expect(h.ledger().phases[0]?.gate).toBe("qa-running");
    // The timeout settled the launch completion (lost/unconfirmed, as launch.ts does), so the late child's report comes
    // through the host's events (L12), not through the launch handle.
    expect(run.settled).toBe(true);
    h.hosts.contexts.set("ses-late", { messages: [{ role: "assistant", text: QA_OK_TEXT, outcome: null }] });
    h.hosts.emit({ type: "execution.completed", sessionID: "ses-late", at: h.clock.iso() });
    await until(() => h.parts().qa.results.length === 1, "QaLoop.onQaResult");
    expect(h.state("Q1")).toBe("done");
  });

  it("a 'failed' end of a launch whose child was never journaled is left to the confirmation", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    run.end({ kind: "failed", childSessionID: "ses-ghost", error: { type: "provider.internal", status: 500, message: "boom" }, endedAt: h.clock.iso() });
    await pause(30);
    expect(h.state("T1")).toBe("dispatched");
    expect(h.task("T1").attempts[0]?.outcome).toBeNull();
    expect(h.parts().policy.counted).toEqual([]);
  });

  it("a third lost attempt while the plan is already paused raises nothing and keeps the plan paused", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    for (let n = 1; n <= 2; n++) {
      const run = await h.running("T1", n, `ses-c${n}`);
      run.end({ kind: "lost", childSessionID: `ses-c${n}`, reason: "unrequested-interrupt", endedAt: h.clock.iso() });
      await h.runOf("T1", n + 1);
    }
    const third = await h.running("T1", 3, "ses-c3");
    await h.runtime.pause(PLAN_ID, ORCH);
    third.end({ kind: "lost", childSessionID: "ses-c3", reason: "unrequested-interrupt", endedAt: h.clock.iso() });
    await until(() => h.state("T1") === "ready", "T1 back to ready");
    await pause(30);
    expect(h.ledger().status).toBe("paused");
    expect(h.parts().policy.raised).toEqual([]);
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost", "lost", "lost"]);
    expect((await h.counters()).some((c) => c.key === "lost-streak-pause")).toBe(false);
  });

  it("a lease request for a path the task already declares keeps the footprint and marks it learned only once", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const first = await h.running("T1", 1, "ses-c1");
    h.registry.held.clear(); // the declared path is free again
    first.complete("NEED MORE: lease src/T1.ts");
    const second = await h.running("T1", 2, "ses-c2");
    expect(h.task("T1").footprint.writes).toEqual(["src/T1.ts"]);
    expect(h.task("T1").footprint.sources).toEqual(["path", "learned"]);

    second.complete("NEED MORE: lease src/extra.ts");
    await h.runOf("T1", 3);
    expect(h.task("T1").footprint.writes).toEqual(["src/T1.ts", "src/extra.ts"]);
    expect(h.task("T1").footprint.sources).toEqual(["path", "learned"]);
  });
});

describe("branch top-up: verification racing an abort", () => {
  /** Holds the verifier until `release` is called. */
  const holdVerifier = (h: Harness): { release(): void } => {
    const gate = deferred<void>();
    const verify = h.verifier.verify.bind(h.verifier);
    h.verifier.verify = async (t, slot, a) => {
      await gate.promise;
      return verify(t, slot, a);
    };
    return { release: () => gate.resolve() };
  };

  it("a pass verdict that lands while abort waits for the queue is journaled but not enqueued (latch)", async () => {
    const h = await mk(planOf([task("T1")]));
    const held = holdVerifier(h);
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await until(() => h.state("T1") === "verifying", "T1 verifying");

    const queueAbort = deferred<void>();
    let abortCalled = false;
    h.parts().queue.abort = async () => {
      abortCalled = true;
      await queueAbort.promise;
    };
    const aborting = h.runtime.abort(PLAN_ID, ORCH);
    await until(() => abortCalled, "queue.abort called");
    held.release();
    await until(() => h.state("T1") === "verified", "T1 verified");
    await until(() => h.parts().policy.counted.length === 1, "attempt counted");
    await pause(20);
    expect(h.parts().queue.enqueued).toEqual([]);

    queueAbort.resolve();
    await aborting;
    expect(h.state("T1")).toBe("cancelled");
    expect(h.parts().queue.enqueued).toEqual([]);
  });

  it.each([
    ["with changes", true],
    ["without changes", false],
  ] as const)("an abort during the commit step (%s) leaves the cancelled task alone: no verifying, no done", async (_name, dirty) => {
    const noWrites: TaskNode["footprint"] = { writes: [], reads: [], confidence: "explicit", sources: ["path"] };
    const h = await mk(planOf([dirty ? task("T1") : task("T1", { footprint: noWrites })]));
    h.git.dirty = () => dirty;
    const run = h.git.run.bind(h.git);
    let once = true;
    h.git.run = async (args: readonly string[], o: ProcOpts): Promise<ProcessResult> => {
      if (once && args[0] === "status") {
        once = false;
        await h.runtime.abort(PLAN_ID, ORCH);
      }
      return run(args, o);
    };
    await h.begin();
    const child = await h.running("T1", 1, "ses-c1");
    child.complete("Done.");
    await until(() => h.state("T1") === "cancelled", "T1 cancelled");
    await pause(30);
    expect(h.state("T1")).toBe("cancelled");
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().queue.enqueued).toEqual([]);
    expect(h.git.calls.some((c) => c.args[0] === "commit")).toBe(dirty);
    const ev = await h.events();
    expect(ev.some((e) => e.type === "task-transition" && (e.to === "verifying" || e.to === "done"))).toBe(false);
  });

  it.each(["pass", "fail"] as const)("a %s verdict that arrives after abort cancelled the task writes nothing", async (verdict) => {
    const h = await mk(planOf([task("T1")]));
    const held = holdVerifier(h);
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await until(() => h.state("T1") === "verifying", "T1 verifying");
    await h.runtime.abort(PLAN_ID, ORCH);
    expect(h.state("T1")).toBe("cancelled");

    h.verifier.queue.push({ verdict, findings: "late findings" });
    held.release();
    await until(() => h.verifier.calls.length === 1, "verifier answered");
    await pause(30);
    expect(h.state("T1")).toBe("cancelled");
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: null, context: "" });
    expect(h.parts().policy.counted).toEqual([]);
    expect(h.parts().queue.enqueued).toEqual([]);
  });
});

describe("branch top-up: board, manual kinds, abort leftovers, restart, host feeds", () => {
  const noWrites = { writes: [], reads: [], confidence: "explicit", sources: ["path"] } as const;
  const manualOnly = (id: TaskId, kind: "manual" | "preflight" = "manual"): TaskNode =>
    task(id, { kind, verify: "none", footprint: { ...noWrites, writes: [], reads: [], sources: ["path"] } });

  it("the manual-ready state key counts the task's incoming edges", async () => {
    const h = await mk(planOf([task("T1", { state: "done" }), manualOnly("M1")], { edges: [edge("T1", "M1")] }));
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "manual-ready wake");
    expect(h.hosts.keys()).toEqual(["manual-ready:M1:1"]);
  });

  it("a ready preflight task is waited on like a manual one and can be reported done", async () => {
    const h = await mk(planOf([manualOnly("P1", "preflight")]));
    await h.begin();
    await until(() => h.runtime.manualReady(ORCH).length === 1, "P1 ready");
    expect(h.runtime.manualReady(ORCH)).toEqual([{ taskId: "P1", kind: "preflight" }]);
    expect(await h.runtime.status(PLAN_ID, ORCH)).toContain("  P1 manual (preflight) - waiting for router_plan action=done");
    await h.runtime.done(PLAN_ID, "P1", ORCH);
    expect(h.state("P1")).toBe("done");
  });

  it("ready() of an attached plan lists the launchable tasks the closed gate holds back", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "stale-context wake");
    expect(await h.runtime.ready(PLAN_ID)).toEqual({ launchable: ["T1"], manual: [] });
  });

  it("the board marks a paused phase", async () => {
    const draft = planOf([task("T1")]);
    need(draft.phases[0], "phase").paused = true;
    const h = await mk(draft);
    await h.begin();
    await until(() => h.hosts.keys().includes("phase-paused:p1:none"), "phase-paused wake");
    expect(await h.runtime.status(PLAN_ID, ORCH)).toContain("Phase p1: gate pending PAUSED - Phase 1");
  });

  it("abort leaves done tasks done and cancels the rest", async () => {
    const h = await mk(planOf([task("T1", { state: "done" }), manualOnly("M1")]));
    await h.begin();
    await h.runtime.abort(PLAN_ID, ORCH);
    expect(h.state("T1")).toBe("done");
    expect(h.state("M1")).toBe("cancelled");
    const cancels = (await h.events()).filter((e) => e.type === "task-transition" && e.trigger === "abort");
    expect(cancels.map((e) => (e.type === "task-transition" ? e.taskId : ""))).toEqual(["M1"]);
  });

  it("Q results for an unknown task change nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    h.parts().listener.onFailed("T-missing");
    h.parts().listener.onConflict("T-missing");
    await pause(30);
    expect(h.parts().policy.counted).toEqual([]);
    expect(h.slots.resets.map((r) => r.slot)).toEqual(["slot-1"]); // only the launch's own reset
    expect(h.logs.filter((l) => l.startsWith("error:"))).toEqual([]);
    expect(h.state("T1")).toBe("dispatched");
  });

  it("after approval the plan's capacity controller journals its metrics", async () => {
    const draft = planOf([manualOnly("M1")]);
    draft.status = "awaiting-approval";
    const h = await mk(draft);
    await h.begin();
    await h.runtime.approve(PLAN_ID, ORCH);
    const at = h.clock.iso();
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-x", providerID: PROVIDER, modelID: "model-1", at });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-x", error: ERR_RATE_LIMIT, at });
    await until(async () => (await h.metrics()).some((m) => m.name === "capacity" && m.change === "decrease"), "capacity decrease metric");
    expect((await h.metrics()).filter((m) => m.name === "capacity")).toHaveLength(1);
  });

  it("after a restart abort does not cancel a launch this runtime never made; the task is cancelled and its slot freed", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.restart();
    await h.runtime.abort(PLAN_ID, ORCH);
    expect(h.state("T1")).toBe("cancelled");
    expect(h.task("T1").slot).toBeNull();
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "interrupted" });
    expect(h.slots.released).toEqual(["slot-1"]);
    expect(h.log.some((l) => l.startsWith("launcher.cancel"))).toBe(false);
  });

  it("a slot record that is gone at restart rebuilds the task without a tree: no lease re-taken, nothing raised", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.slots.records.clear();
    await h.restart();
    expect(h.registry.heldBy("plan-one:T1")).toEqual([]);
    expect(h.parts().policy.raised).toEqual([]);
    await h.runtime.onChildEnd("T1", 1, { kind: "completed", childSessionID: "ses-c1", text: "Done.", endedAt: h.clock.iso() });
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]?.context).toBe("slot record missing");
  });

  it("an interrupted orchestrator opens the idle-with-ready window; a failed step of it does not", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "stale-context wake");
    h.runtime.onHostEvent({ type: "step.failed", sessionID: ORCH, error: { type: "provider.internal", status: 500, message: "x" }, at: h.clock.iso() });
    await h.settled();
    h.clock.advance(1000);
    h.runtime.onHostEvent({ type: "execution.interrupted", sessionID: ORCH, at: h.clock.iso() });
    await h.settled();
    h.clock.advance(3000);
    h.launcher.gateValue = OK_GATE;
    h.runtime.onRouterToolCall(ORCH);
    await h.runOf("T1", 1);
    await until(async () => (await h.metrics()).some((m) => m.name === "idle-with-ready"), "idle-with-ready metric");
    const idle = need((await h.metrics()).find((m) => m.name === "idle-with-ready"), "idle metric");
    expect(idle).toMatchObject({ ms: 3000, readyTaskIds: ["T1"] });
  });

  it("while dispose waits for the launcher, host feeds skip the plan: a plan child's retry is not stopped and nothing is journaled", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.runtime.onHostEvent({ type: "step.started", sessionID: "ses-c1", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    expect(h.runtime.onRetryHook({ sessionID: "ses-c1", stepKey: "s1", error: ERR_RATE_LIMIT })).toEqual({ stop: false });

    const launcherDisposed = deferred<void>();
    h.launcher.dispose = async () => {
      await launcherDisposed.promise;
    };
    const disposing = h.runtime.dispose();
    h.clock.advance(11_000); // past the cooldown: an attached plan would stop this retry now
    expect(h.runtime.onRetryHook({ sessionID: "ses-c1", stepKey: "s1", error: ERR_RATE_LIMIT })).toEqual({ stop: false });
    h.runtime.onHostEvent({ type: "step.failed", sessionID: "ses-c1", error: ERR_RATE_LIMIT, at: h.clock.iso() });
    launcherDisposed.resolve();
    await disposing;

    const capacity = (await h.metrics()).filter((m) => m.name === "capacity");
    expect(capacity.map((m) => (m.name === "capacity" ? m.change : ""))).toEqual(["decrease"]);
  });
});

describe("helpers exported by runtime.ts", () => {
  it("createLeaseService maps the registry's answers and never passes [] to acquireWrite", () => {
    const reg = new RegistryDouble([]);
    const svc = createLeaseService(PLAN_ID, reg);

    expect(svc.acquireTask({ taskId: "T1", tree: "C:/s1", writes: [] })).toEqual({ ok: true });
    expect(reg.acquires).toEqual([]);
    expect(svc.acquireTask({ taskId: "T1", tree: "C:/s1", writes: ["a.ts"] })).toEqual({ ok: true });
    expect(reg.acquires).toEqual([{ taskRef: "plan-one:T1", tree: "C:/s1", writes: ["a.ts"] }]);
    expect(svc.holder("a.ts")).toEqual({ planId: PLAN_ID, taskId: "T1", holderID: "plan:plan-one:T1" });

    reg.plant("b.ts", "ses-x", null);
    expect(svc.acquireTask({ taskId: "T2", tree: "C:/s2", writes: ["b.ts"] })).toEqual({
      ok: false,
      reason: "held",
      holders: [{ planId: null, taskId: null, holderID: "ses-x" }],
    });
    expect(reg.heldBy("plan-one:T2")).toEqual([]);

    svc.releaseTask("T1");
    expect(svc.holder("a.ts")).toBeNull();
  });

  it("createLeaseService: non-held refusals keep their reason; a held answer with no holders names 'unknown'; odd task refs lose their plan", () => {
    const reg = new RegistryDouble([]);
    const svc = createLeaseService(PLAN_ID, reg);
    const refusal = (r: ReturnType<LeaseRegistryPort["acquireWrite"]>) => (): ReturnType<LeaseRegistryPort["acquireWrite"]> => r;

    reg.acquireWrite = refusal({ ok: false, reason: "cap", message: "too many" });
    expect(svc.acquireTask({ taskId: "T1", tree: "C:/s1", writes: ["a.ts"] })).toEqual({ ok: false, reason: "cap", message: "too many" });
    reg.acquireWrite = refusal({ ok: false, reason: "held", holders: [] });
    expect(svc.acquireTask({ taskId: "T1", tree: "C:/s1", writes: ["a.ts"] })).toEqual({
      ok: false,
      reason: "held",
      holders: [{ planId: null, taskId: null, holderID: "unknown" }],
    });

    // taskRef shapes: no colon, leading colon and trailing colon are not plan refs; a proper one splits at the first colon.
    reg.plant("nocolon.ts", "h1", "nocolon");
    reg.plant("lead.ts", "h2", ":T9");
    reg.plant("trail.ts", "h3", "plan-one:");
    reg.plant("ok.ts", "h4", "plan-two:T7");
    expect(svc.holder("nocolon.ts")).toEqual({ planId: null, taskId: null, holderID: "h1" });
    expect(svc.holder("lead.ts")).toEqual({ planId: null, taskId: null, holderID: "h2" });
    expect(svc.holder("trail.ts")).toEqual({ planId: null, taskId: null, holderID: "h3" });
    expect(svc.holder("ok.ts")).toEqual({ planId: "plan-two", taskId: "T7", holderID: "h4" });
  });

  it("createLeaseService.rebuild labels a non-held refusal as lease-<reason>", () => {
    const reg = new RegistryDouble([]);
    reg.acquireWrite = () => ({ ok: false, reason: "invalid", message: "bad path" });
    const svc = createLeaseService(PLAN_ID, reg);
    const failed = svc.rebuild([
      { id: "T1", slot: "slot-1", tree: "C:/s1", footprint: { writes: ["a.ts"], reads: [], confidence: "explicit", sources: ["path"] } },
    ]);
    expect(failed).toEqual([{ taskId: "T1", holders: [{ planId: null, taskId: null, holderID: "lease-invalid" }] }]);
  });

  it("createLeaseService.rebuild re-takes held slots and reports what it cannot", () => {
    const reg = new RegistryDouble([]);
    const svc = createLeaseService(PLAN_ID, reg);
    reg.plant("a.ts", "ses-x", null);
    const fp = (w: string[]): { writes: string[]; reads: string[]; confidence: "explicit"; sources: Array<"path"> } => ({
      writes: w,
      reads: [],
      confidence: "explicit",
      sources: ["path"],
    });
    const failed = svc.rebuild([
      { id: "T1", slot: "slot-1", tree: "C:/s1", footprint: fp(["a.ts"]) },
      { id: "T2", slot: "slot-2", tree: "C:/s2", footprint: fp(["b.ts"]) },
      { id: "T3", slot: null, tree: null, footprint: fp(["c.ts"]) },
    ]);
    expect(failed).toEqual([{ taskId: "T1", holders: [{ planId: null, taskId: null, holderID: "ses-x" }] }]);
    expect(reg.heldBy("plan-one:T2")).toEqual(["b.ts"]);
    expect(reg.heldBy("plan-one:T3")).toEqual([]);
  });

  it("commitTaskInSlot: clean tree -> unchanged; dirty -> branch, add, commit, rev-parse; no identity -> E_IDENTITY", async () => {
    const slot: SlotLease = { slot: "slot-1", path: slotPathOf("slot-1"), planId: PLAN_ID, owner: "o", commit: SHA };
    const input = { slot, branch: "omr/plan-one/t/T1", message: "T1: title (attempt 1)", timeoutMs: 1000 };

    const clean = new GitDouble();
    clean.dirty = () => false;
    expect(await commitTaskInSlot(clean, input)).toEqual({ changed: false });
    expect(clean.calls.map((c) => c.args[0])).toEqual(["status"]);

    const dirty = new GitDouble();
    expect(await commitTaskInSlot(dirty, input)).toEqual({ changed: true, commit: "1".padStart(40, "e") });
    expect(dirty.calls.map((c) => c.args.join(" "))).toEqual([
      "status --porcelain",
      "switch -C omr/plan-one/t/T1",
      "add -A",
      "commit -m T1: title (attempt 1)",
      "rev-parse HEAD",
    ]);
    expect(dirty.calls.every((c) => c.cwd === slot.path)).toBe(true);

    const anon = new GitDouble();
    anon.failOn = { verb: "commit", stderr: "*** Please tell me who you are." };
    await expect(commitTaskInSlot(anon, input)).rejects.toMatchObject({ code: "E_IDENTITY" });
    const broken = new GitDouble();
    broken.failOn = { verb: "add", stderr: "fatal: index locked" };
    await expect(commitTaskInSlot(broken, input)).rejects.toMatchObject({ code: "E_GIT" });
  });
});
