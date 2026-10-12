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
import { createCapacityController } from "../../src/executor/capacity.js";
import { taskBranchName } from "../../src/executor/git.js";
import { createLedgerStore } from "../../src/executor/ledger.js";
import {
  commitTaskInSlot,
  createExecutorRuntime,
  createLeaseService,
  type ExecutorRuntimeHandle,
  type LeaseRegistryPort,
  type PlanCollaborators,
  type RuntimeDeps,
} from "../../src/executor/runtime.js";
import { createScheduler } from "../../src/executor/schedule.js";
import {
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

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: (v) => resolve(v) };
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
  async gc(): Promise<{ removed: string[]; reported: string[] }> {
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
  async answer(): Promise<{ resumed: TaskId | null }> {
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
  private commits = 0;
  async run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> {
    this.calls.push({ args: [...args], cwd: o.cwd });
    const verb = args[0] ?? "";
    const ok = (stdout = ""): ProcessResult => ({ code: 0, signal: null, stdout, stderr: "", truncated: false, durationMs: 0 });
    if (this.failOn !== null && this.failOn.verb === verb) return { ...ok(), code: 1, stderr: this.failOn.stderr };
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
  onEvent(): () => void {
    return () => undefined;
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
  constructor(
    readonly req: LaunchRequest,
    readonly hooks: LaunchHooks,
    /** The ledger already held `req.nonce` as the open attempt's nonce when `launch` was called. */
    readonly durableNonce: boolean,
    private readonly clock: Clock,
  ) {}
  /** The child session appears: the hook journals it (dispatched -> running), then the launch is confirmed. */
  async child(sessionID: string): Promise<void> {
    this.childSessionID = sessionID;
    await this.hooks.onChildCreated(sessionID);
    this.confirm({ kind: "confirmed", childSessionID: sessionID, latencyMs: 1 });
  }
  confirm(c: LaunchConfirmation): void {
    this.confirmation.resolve(c);
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
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
  runOf(taskId: TaskId, attempt: number): RunDouble | undefined {
    return this.runs.find((r) => r.req.taskId === taskId && r.req.attempt === attempt);
  }
  /** Ends every live handle without journaling anything (used at test end, after the gate is closed). */
  releaseAll(): void {
    for (const r of this.runs) {
      if (r.settled) continue;
      r.confirm({ kind: "confirmed", childSessionID: r.childSessionID ?? "ses-none", latencyMs: 0 });
      r.end({ kind: "interrupted", childSessionID: r.childSessionID, reason: "dispose", endedAt: this.clock.iso() });
    }
  }
}

class CompilerDouble implements PlanCompiler {
  readonly compiled: string[] = [];
  constructor(private readonly draft: LedgerV1) {}
  async compile(planPath: string, opts: { orchestratorSessionID: string }): ReturnType<PlanCompiler["compile"]> {
    this.compiled.push(planPath);
    const draft: LedgerV1 = JSON.parse(JSON.stringify(this.draft)) as LedgerV1;
    draft.orchestrator = { sessionID: opts.orchestratorSessionID, boundAt: T0 };
    return {
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
  mergeResidue(): never {
    throw new Error("mergeResidue is not used here");
  }
  addTasks(): never {
    throw new Error("addTasks is not used here");
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

async function mk(draft: LedgerV1): Promise<Harness> {
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
  const deps: RuntimeDeps = {
    store,
    compiler: new CompilerDouble(draft),
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

  it("a task with nothing to commit and no declared writes goes straight to done and frees its resources", async () => {
    const h = await mk(planOf([task("T1", { footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] } })]));
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

  it("M39: a required, writing task that produced no changes fails 'no changes' (counted) and is retried", async () => {
    const h = await mk(planOf([task("T1")]));
    h.git.dirty = () => false;
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done, I think.");
    await h.runOf("T1", 2);

    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1.outcome).toBe("succeeded");
    expect(a1.context).toBe("no changes");
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1]);
    expect((await h.events()).some((e) => e.type === "task-transition" && e.trigger === "commit-failed")).toBe(true);
    expect(h.state("T1")).toBe("dispatched");
  });

  it("M39 variant: with verify 'deferred' the same no-change task is done, not failed", async () => {
    const h = await mk(planOf([task("T1", { verify: "deferred" })]));
    h.git.dirty = () => false;
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await until(() => h.state("T1") === "done", "T1 done");
    expect(h.task("T1").attempts).toHaveLength(1);
    expect(h.parts().policy.counted).toEqual([]);
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
    expect((await h.metrics()).some((m) => m.name === "wake" && m.stateKey === "stale-context:boot:2" && m.result === "debounced")).toBe(true);

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

  it("a lost launch whose child shows up late, with no relaunch yet, is adopted and finishes normally", async () => {
    const h = await mk(planOf([task("T1")]));
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

    run.complete("Done after all.");
    await untilEnqueued(h, "T1");
    expect(h.parts().queue.enqueued).toEqual([["T1"]]);
  });

  it("after a relaunch the late child of the old attempt is refused and the old launch was cancelled as superseded", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const old = await h.runOf("T1", 1);
    unconfirmed(old);
    const fresh = await h.runOf("T1", 2);

    expectOrdered(h.log, ["launcher.launch:T1#1", "launcher.cancel:T1#1:superseded", "launcher.launch:T1#2"]);
    expect(old.cancelReasons).toEqual(["superseded"]);
    expect(await old.hooks.onLateChild("ses-late")).toBe("refuse");
    await expect(old.hooks.onChildCreated("ses-late")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(h.state("T1")).toBe("dispatched");
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost", null]);
    expect(h.task("T1").attempts[1]?.nonce).toBe(fresh.req.nonce);
    expect(h.task("T1").attempts[1]?.childSessionID).toBeNull();
  });
});

describe("metrics", () => {
  it("emits every metric variant: launch, wake (sent and debounced), idle-with-ready, capacity, counter, context-age", async () => {
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = staleGate("stale-context:boot:1");
    await h.begin();
    await until(() => h.hosts.delivered.length === 1, "first wake");

    // The orchestrator goes idle while T1 is ready but the gate is closed: the idle-with-ready window opens at T0.
    h.runtime.onHostEvent({ type: "execution.completed", sessionID: ORCH, at: h.clock.iso() });
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
    expect(wakes).toContain("stale-context:boot:2:debounced");
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

  it("recordMetric for a plan that is not attached journals nothing", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    h.runtime.recordMetric("no-such-plan", { name: "counter", key: "unknown-plan", value: 1, labels: {} });
    h.runtime.recordMetric(PLAN_ID, { name: "counter", key: "known-plan", value: 1, labels: {} });
    h.launcher.gateValue = DISPOSED_GATE;
    h.launcher.releaseAll();
    await h.settled();
    expect((await h.counters()).map((c) => c.key)).toEqual(["known-plan"]);
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
