// Branch coverage for src/executor/runtime.ts, lines 2562-4003 (reconcile feeds, adopt, re-provisioning, gate
// recovery, probation). The harness is a minimal copy of the one in executor-runtime-coverage.test.ts (that file
// exports nothing): the real LedgerStore in a temp dir, the real Scheduler and CapacityController; typed doubles for
// every other seam, and a scripted recovery engine whose `reconcile` answers the feeds a test builds. All time comes
// from TestClock; `until` only yields to the event loop while the real ledger files are written. Handles of the
// launcher double stay pending until a test settles them, so tests poll `until(...)` instead of runtime.settled()
// while a child is alive.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapacityController } from "../../src/executor/capacity.js";
import { taskBranchName } from "../../src/executor/git.js";
import { createLedgerStore } from "../../src/executor/ledger.js";
import type { PlanBindInput, PlanRoleBindings } from "../../src/executor/launch.js";
import {
  createExecutorRuntime,
  type ExecutorRuntimeHandle,
  type LeaseRegistryPort,
  type PlanCollaborators,
  type RuntimeDeps,
} from "../../src/executor/runtime.js";
import type { ReconcileFeed } from "../../src/executor/recovery.js";
import { createScheduler } from "../../src/executor/schedule.js";
import {
  ExecutorError,
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
  type PhaseId,
  type PlanCompiler,
  type PlanId,
  type ReconcileAction,
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

vi.setConfig({ testTimeout: 15_000 });

const SHA = "c".repeat(40);
const SLOT_ROOT = "C:/omr-rt";
const ORCH = "ses-0";
const PROVIDER = "prov";
const REPO = "C:/repo";

// ---------------------------------------------------------------------------------------------------------------
// Clock and small helpers (copied from executor-runtime-coverage.test.ts)
// ---------------------------------------------------------------------------------------------------------------

class TestClock implements Clock {
  private ms = Date.parse(T0);
  private nextId = 1;
  private rand = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
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
    return (0xabc000 + this.rand).toString(16).padStart(bytes * 2, "0");
  }
  pending(): number {
    return this.timers.size;
  }
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
}

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

// ---------------------------------------------------------------------------------------------------------------
// Doubles (copied from executor-runtime-coverage.test.ts, trimmed to the knobs these tests use)
// ---------------------------------------------------------------------------------------------------------------

class SlotPoolDouble implements SlotPool {
  readonly byOwner = new Map<string, SlotLease>();
  readonly records = new Map<string, SlotRecord>();
  readonly released: string[] = [];
  readonly resets: Array<{ slot: string; commit: string }> = [];
  /** When set, `acquire` throws it (every call). */
  acquireFailure: Error | null = null;
  /** When set, `release` throws it (every call). */
  releaseFailure: Error | null = null;
  private n = 0;
  constructor(private readonly log: CallLog) {}
  async acquire(planId: string, owner: string, baseCommit: string): Promise<SlotLease> {
    if (this.acquireFailure !== null) throw this.acquireFailure;
    const have = this.byOwner.get(owner);
    if (have !== undefined) return have;
    this.n += 1;
    const slot = `slot-${this.n}`;
    const lease: SlotLease = { slot, path: slotPathOf(slot), planId, owner, commit: baseCommit };
    this.byOwner.set(owner, lease);
    this.plant(slot, planId, owner, baseCommit);
    this.log.push(`slots.acquire:${owner}`);
    return lease;
  }
  /** A slot record of the pool (what `get` answers), e.g. for a slot named in a crafted draft. */
  plant(slot: string, planId: string, owner: string, commit: string = SHA): void {
    this.records.set(slot, {
      schema: 1,
      slot,
      path: slotPathOf(slot),
      kind: "task",
      planId,
      repoKey: "repo-key",
      state: "leased",
      owner,
      commit,
      managers: [],
      manifests: {},
      createdAt: T0,
      updatedAt: T0,
    });
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
    this.log.push(`slots.release:${slot}`);
    if (this.releaseFailure !== null) throw this.releaseFailure;
    this.released.push(slot);
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

class RegistryDouble implements LeaseRegistryPort {
  readonly held = new Map<string, { holderID: string; taskRef: string | null }>();
  readonly releases: string[] = [];
  constructor(private readonly log: CallLog) {}
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

class QueueDouble implements IntegrationQueue {
  readonly enqueued: TaskId[][] = [];
  constructor(
    private readonly log: CallLog,
    private readonly snap: Snap,
  ) {}
  enqueue(ids: readonly TaskId[]): void {
    this.log.push(`queue.enqueue:${ids.join(",")}`);
    this.enqueued.push([...ids]);
  }
  async resume(): Promise<ResumeReport> {
    return { completed: [], rolledBack: [], halted: false, entries: [] };
  }
  async checkPhase(): Promise<void> {}
  async land(): Promise<{ landed: boolean; inbox: InboxItem | null }> {
    return { landed: true, inbox: null };
  }
  async abort(): Promise<void> {
    this.log.push(`queue.abort ${this.snap()}`);
  }
  queued(): readonly TaskId[] {
    return this.enqueued.flat();
  }
  async dispose(): Promise<void> {}
}

type RaiseInput = Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string };

class PolicyDouble implements UnattendedPolicy {
  readonly raised: RaiseInput[] = [];
  readonly counted: Array<{ phaseId: PhaseId; n: number; outcome: Attempt["outcome"]; verdict: Attempt["verdict"] }> = [];
  constructor(
    private readonly writer: LedgerWriter,
    private readonly clock: Clock,
  ) {}
  async raise(i: RaiseInput): Promise<InboxItem> {
    this.raised.push(i);
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
  async park(): Promise<InboxItem> {
    throw new Error("park is not used by these tests");
  }
  async answer(): Promise<{ resumed: TaskId | null }> {
    return { resumed: null };
  }
  async unblock(): Promise<TaskId[]> {
    return [];
  }
  async recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }> {
    this.counted.push({ phaseId, n: a.n, outcome: a.outcome, verdict: a.verdict });
    return { tripped: false };
  }
}

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

class GitDouble implements GitRunner {
  readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];
  dirty: (cwd: string) => boolean = () => true;
  /** Per-verb answers that win over the defaults (a function may throw). */
  readonly answers = new Map<string, (args: readonly string[]) => Partial<ProcessResult>>();
  private commits = 0;
  async run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> {
    this.calls.push({ args: [...args], cwd: o.cwd });
    const verb = args[0] ?? "";
    const ok = (stdout = ""): ProcessResult => ({ code: 0, signal: null, stdout, stderr: "", truncated: false, durationMs: 0 });
    const scripted = this.answers.get(verb);
    if (scripted !== undefined) return { ...ok(), ...scripted(args) };
    if (verb === "worktree") return ok(`worktree ${REPO}\nHEAD ${SHA}\nbranch refs/heads/main\n`);
    if (verb === "config") return { ...ok(), code: 1 };
    if (verb === "status") return ok(this.dirty(o.cwd) ? " M src/a.ts\n" : "");
    if (verb === "log") return ok("");
    if (verb === "rev-parse") {
      this.commits += 1;
      return ok(`${this.commits.toString(16).padStart(40, "e")}\n`);
    }
    return ok();
  }
  verbs(): string[] {
    return this.calls.map((c) => c.args.join(" "));
  }
}

class HostsDouble implements HostSessions {
  readonly interrupted: string[] = [];
  readonly contexts = new Map<string, HostSessionContext>();
  activityValue: "active" | "inactive" | "unknown" = "inactive";
  interruptImpl: (sessionID: string) => Promise<void> = async () => undefined;
  contextImpl: ((sessionID: string) => Promise<HostSessionContext>) | null = null;
  async get(sessionID: string): Promise<{ id: string; parentID: string | null } | null> {
    return { id: sessionID, parentID: null };
  }
  async context(sessionID: string): Promise<HostSessionContext> {
    if (this.contextImpl !== null) return this.contextImpl(sessionID);
    return this.contexts.get(sessionID) ?? { messages: [] };
  }
  async activity(): Promise<"active" | "inactive" | "unknown"> {
    return this.activityValue;
  }
  async interrupt(sessionID: string): Promise<void> {
    this.interrupted.push(sessionID);
    await this.interruptImpl(sessionID);
  }
  async synthetic(): Promise<void> {}
  async move(): Promise<void> {}
  readonly listeners = new Set<(e: HostSessionEvent) => void>();
  onEvent(listener: (e: HostSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(e: HostSessionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

/** PlanRoleBindings: records binds and evictions (QA-4.2-18/-23). */
class BindingsDouble implements PlanRoleBindings {
  readonly binds: PlanBindInput[] = [];
  readonly evicted: string[] = [];
  bind(i: PlanBindInput): void {
    this.binds.push(i);
  }
  evict(childSessionID: string): void {
    this.evicted.push(childSessionID);
  }
}

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

class RunDouble {
  childSessionID: string | null = null;
  settled = false;
  readonly confirmation = deferred<LaunchConfirmation>();
  readonly completion = deferred<ChildEnd>();
  constructor(
    readonly req: LaunchRequest,
    readonly hooks: LaunchHooks,
    private readonly clock: Clock,
  ) {}
  async child(sessionID: string): Promise<void> {
    this.childSessionID = sessionID;
    await this.hooks.onChildCreated(sessionID);
    this.confirmation.resolve({ kind: "confirmed", childSessionID: sessionID, latencyMs: 1 });
  }
  end(e: ChildEnd): void {
    if (this.settled) return;
    this.settled = true;
    this.completion.resolve(e);
  }
  complete(text: string): void {
    this.end({ kind: "completed", childSessionID: this.childSessionID ?? "ses-unknown", text, endedAt: this.clock.iso() });
  }
}

class LauncherDouble implements TaskLauncher {
  gateValue: LaunchGate = OK_GATE;
  closed = false;
  readonly runs: RunDouble[] = [];
  readonly cancels: string[] = [];
  constructor(
    private readonly log: CallLog,
    private readonly clock: Clock,
  ) {}
  gate(): LaunchGate {
    return this.gateValue;
  }
  launch(req: LaunchRequest, hooks: LaunchHooks): LaunchHandle {
    this.log.push(`launcher.launch:${req.taskId}#${req.attempt}`);
    const run = new RunDouble(req, hooks, this.clock);
    this.runs.push(run);
    if (this.closed) {
      // A launch that races the test's close settles at once, so dispose never waits on its confirmation.
      run.confirmation.resolve({ kind: "confirmed", childSessionID: "ses-none", latencyMs: 0 });
      run.end({ kind: "interrupted", childSessionID: null, reason: "dispose", endedAt: this.clock.iso() });
    }
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
    this.cancels.push(`${taskId}#${attempt}:${reason}`);
    const run = this.runOf(taskId, attempt);
    run?.end({ kind: "interrupted", childSessionID: run.childSessionID, reason, endedAt: this.clock.iso() });
  }
  inFlight(): ReadonlyArray<{ taskId: TaskId; attempt: number; childSessionID: string | null; startedAt: string }> {
    return this.runs.filter((r) => !r.settled).map((r) => ({ taskId: r.req.taskId, attempt: r.req.attempt, childSessionID: r.childSessionID, startedAt: T0 }));
  }
  /**
   * The process dies (`crash`): a launch still waiting for its confirmation is answered `confirmed`, which journals
   * nothing (an `unconfirmed` answer would journal row 11), so the runtime's dispose does not wait on it and the task
   * stays `dispatched` for recovery. Completions stay pending (dispose never waits on a child).
   */
  async dispose(): Promise<void> {
    for (const r of this.runs) {
      if (!r.settled) r.confirmation.resolve({ kind: "confirmed", childSessionID: r.childSessionID ?? "ses-none", latencyMs: 0 });
    }
  }
  runOf(taskId: TaskId, attempt: number): RunDouble | undefined {
    return this.runs.find((r) => r.req.taskId === taskId && r.req.attempt === attempt);
  }
  /** Settles every run without journaling anything (test end); later launches settle at once. */
  releaseAll(): void {
    this.closed = true;
    this.gateValue = DISPOSED_GATE;
    for (const r of this.runs) {
      r.confirmation.resolve({ kind: "confirmed", childSessionID: r.childSessionID ?? "ses-none", latencyMs: 0 });
      r.end({ kind: "interrupted", childSessionID: r.childSessionID, reason: "dispose", endedAt: this.clock.iso() });
    }
  }
}

class CompilerDouble implements PlanCompiler {
  constructor(private readonly draft: LedgerV1) {}
  async compile(_planPath: string, opts: { orchestratorSessionID: string }): ReturnType<PlanCompiler["compile"]> {
    const draft: LedgerV1 = JSON.parse(JSON.stringify(this.draft)) as LedgerV1;
    draft.orchestrator = { sessionID: opts.orchestratorSessionID, boundAt: T0 };
    return {
      draft,
      summary: { tasks: 0, phases: 0, edges: 0, workMs: 0, criticalPathMs: 0, width: 1, expectedMakespanMs: 0, manual: [], warnings: [] },
    };
  }
  mergeResidue(): ReturnType<PlanCompiler["mergeResidue"]> {
    throw new ExecutorError("E_RESIDUE", "not used");
  }
  addTasks(): ReturnType<PlanCompiler["addTasks"]> {
    throw new ExecutorError("E_CYCLE", "not used");
  }
  validate(): Array<{ code: string; message: string; taskIds: TaskId[] }> {
    return [];
  }
}

/** A scripted recovery engine: `reconcile` answers the feeds `feeds` builds from the ledger it is given. */
class RecoveryDouble {
  feeds: (l: Readonly<LedgerV1>) => ReconcileFeed[] = () => [];
  readonly tracked: string[][] = [];
  /** What `recover` reports. */
  report: Array<{ planId: PlanId; actions: ReconcileAction[] }> = [];
  async recover(): Promise<Array<{ planId: PlanId; actions: ReconcileAction[] }>> {
    return this.report;
  }
  async adopt(): Promise<void> {}
  async reconcile(l: Readonly<LedgerV1>, tracked: ReadonlySet<string>): Promise<ReconcileFeed[]> {
    this.tracked.push([...tracked]);
    return this.feeds(l);
  }
}

function feed(taskId: TaskId, from: TaskState, patch: Partial<ReconcileFeed> = {}): ReconcileFeed {
  return {
    taskId,
    from,
    evidence: "none",
    action: "none",
    n: null,
    childSessionID: null,
    context: null,
    probation: null,
    mismatch: false,
    orphans: [],
    slotValid: null,
    ...patch,
  };
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
  bindings: BindingsDouble;
  rec: RecoveryDouble;
  deps: RuntimeDeps;
  runtime: ExecutorRuntimeHandle;
  parts(): PlanParts;
  ledger(): Readonly<LedgerV1>;
  task(id: TaskId): TaskNode;
  state(id: TaskId): TaskState;
  begin(): Promise<void>;
  runOf(id: TaskId, n: number): Promise<RunDouble>;
  running(id: TaskId, n: number, sessionID: string): Promise<RunDouble>;
  events(): Promise<ExecutorEvent[]>;
  /** The process dies: the runtime is disposed (children of the old launcher stay pending), a new one is built. */
  crash(): Promise<void>;
  /** Appends `ev` to the closed plan's journal through a writer of its own (between a crash and the next attach). */
  journal(ev: ExecutorEventInput[]): Promise<void>;
  /** `adopt` of the plan by its orchestrator: attaches it and runs recovery with the feeds of `rec`. */
  reattach(): Promise<void>;
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
  const root = await mkdtemp(join(tmpdir(), "omr-rt-cov-b-"));
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
  const bindings = new BindingsDouble();
  const rec = new RecoveryDouble();
  const holder = (sessionID: string): ReturnType<RuntimeDeps["holder"]> => holderOf(sessionID, proc.pid, proc.hostname, clock.iso());
  const deps: RuntimeDeps = {
    store,
    compiler: new CompilerDouble(draft),
    slots,
    scheduler: createScheduler(),
    launcher: new LauncherDouble(log, clock),
    routes,
    verifier,
    git,
    hosts,
    clock,
    leaseRegistry: registry,
    recovery: rec,
    holder,
    capacity: (o) => createCapacityController(o),
    collaborators: (i) => {
      const queue = new QueueDouble(log, snap);
      const policy = new PolicyDouble(i.writer, clock);
      const qa = new QaDouble();
      st.parts = { writer: i.writer, leases: i.leases, waker: i.waker, listener: i.listener, queue, policy, qa };
      const c: PlanCollaborators = { queue, policy, qa };
      return c;
    },
    pinOrchestrator: () => () => undefined,
    log: (level, msg, detail) => {
      logs.push(`${level}: ${msg}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    },
    config: () => draft.config,
    bindings,
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
    launcher: deps.launcher as LauncherDouble,
    verifier,
    git,
    hosts,
    bindings,
    rec,
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
      await until(() => h.launcher.runOf(id, n) !== undefined, `launch of ${id}#${n}`);
      return need(h.launcher.runOf(id, n), `run ${id}#${n}`);
    },
    async running(id, n, sessionID) {
      const run = await h.runOf(id, n);
      await run.child(sessionID);
      return run;
    },
    async events() {
      return (await store.exportPlan(PLAN_ID)).events;
    },
    async crash() {
      await h.runtime.dispose();
      const launcher = new LauncherDouble(log, clock);
      deps.launcher = launcher;
      h.launcher = launcher;
      st.parts = null;
      h.runtime = createExecutorRuntime(deps);
    },
    async journal(ev) {
      const w = await store.open(PLAN_ID, holder(ORCH));
      try {
        await w.append(ev);
      } finally {
        await w.close();
      }
    },
    async reattach() {
      await h.runtime.adopt(PLAN_ID, ORCH);
    },
    async close() {
      if (closed) return;
      closed = true;
      h.launcher.releaseAll();
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

const hasLog = (h: Harness, part: string): boolean => h.logs.some((l) => l.includes(part));

function counters(events: readonly ExecutorEvent[], key: string): ExecutorEvent[] {
  return events.filter((e) => e.type === "metric" && e.metric.name === "counter" && e.metric.key === key);
}

/** A findings report the QA double parses: one `nit` finding whose problem is `problem`. */
const REPORT_JSON = (problem: string): string => JSON.stringify({ findings: [{ id: "F1", severity: "nit", files: ["src/a.ts"], problem, fix: "" }] });

// ---------------------------------------------------------------------------------------------------------------
// Step 7 (recoverGates, lines 3017-3043)
// ---------------------------------------------------------------------------------------------------------------

describe("recoverGates at activation", () => {
  it("an awaiting-qa gate calls onAwaitingQa on the new attachment (line 3023)", async () => {
    const h = await mk(planOf([task("Q1", { kind: "qa" })], { gate: "awaiting-qa" }));
    await h.begin();
    await h.running("Q1", 1, "ses-q1");
    await h.crash();
    // Row 18 for a QA task (what rowChildLost journals): the child was lost and the gate is requeued in the same batch.
    await h.journal([
      ...lostRestart(h, "Q1", 1),
      { type: "gate-changed", phaseId: "p1", from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued", qaRound: 1 },
    ]);
    await h.reattach();
    await until(() => h.parts().qa.awaiting.includes("p1"), "onAwaitingQa(p1)");
    expect(h.parts().qa.awaiting).toEqual(["p1"]);
    expect(h.parts().qa.results).toEqual([]);
    expect(h.rec.tracked).toHaveLength(1);
  });

  it("a qa-running gate whose QA task is still in flight is left to that task (line 3029)", async () => {
    const h = await mk(planOf([task("Q1", { kind: "qa" })], { gate: "awaiting-qa" }));
    await h.begin();
    // Launching the QA task moved the gate to qa-running (gateOpen).
    await h.running("Q1", 1, "ses-q1");
    expect(h.ledger().phases[0]?.gate).toBe("qa-running");
    await h.crash();
    await h.reattach();
    expect(h.state("Q1")).toBe("running");
    expect(h.ledger().phases[0]?.gate).toBe("qa-running");
    expect(h.parts().qa.awaiting).toEqual([]);
    expect(h.parts().qa.results).toEqual([]);
  });

  it("a qa-running gate whose QA task finished hands its report to onQaResult again (lines 3028-3038)", async () => {
    const h = await mk(planOf([task("Q1", { kind: "qa" })], { gate: "awaiting-qa" }));
    await h.begin();
    const run = await h.running("Q1", 1, "ses-q1");
    run.complete(REPORT_JSON("round one"));
    await until(() => h.state("Q1") === "done", "Q1 done");
    await until(() => h.parts().qa.results.length === 1, "live onQaResult");
    // The QA double never moves the gate: the restart finds it qa-running with a finished QA task.
    expect(h.ledger().phases[0]?.gate).toBe("qa-running");
    await h.crash();
    await h.reattach();
    const results = h.parts().qa.results;
    expect(results.map((r) => r.taskId)).toEqual(["Q1"]);
    expect(results[0]?.report.findings.map((f) => f.problem)).toEqual(["round one"]);
    expect(h.parts().qa.awaiting).toEqual([]);
  });

});

// ---------------------------------------------------------------------------------------------------------------
// adoptChild / restoreHandle / endFromContext (lines 2638-2775)
// ---------------------------------------------------------------------------------------------------------------

/** The events that requeue a running task whose child was lost at a restart (what requeueLost journals). */
function lostRestart(h: Harness, taskId: TaskId, n: number): ExecutorEventInput[] {
  return [
    { type: "attempt-ended", taskId, n, outcome: "lost", endedAt: h.clock.iso(), detail: "restart" },
    tr(taskId, "running", "ready", "child-lost", "restart"),
  ];
}

describe("adoptChild", () => {
  it("row 7: a ready task whose latest attempt was lost adopts its live child (lines 2653-2658, 2683 have undefined)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    await h.journal(lostRestart(h, "T1", 1));
    h.rec.feeds = () => [feed("T1", "ready", { action: "adopt", evidence: "alive", n: 1, childSessionID: "ses-c1" })];
    await h.reattach();
    expect(h.state("T1")).toBe("running");
    const ev = await h.events();
    const adopted = ev.filter((e) => e.type === "attempt-adopted");
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ taskId: "T1", n: 1, childSessionID: "ses-c1" });
    expect(ev.some((e) => e.type === "task-transition" && e.taskId === "T1" && e.from === "ready" && e.to === "running" && e.trigger === "adopt")).toBe(true);
    expect(h.bindings.binds.map((b) => b.childSessionID)).toEqual(["ses-c1"]);
    expect(h.hosts.interrupted).toEqual([]);
    expect(h.launcher.runs).toEqual([]);
  });

  it("row 7 refused when the latest attempt is not the adopted one: the live child is interrupted as an orphan (line 2655)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    await h.journal(lostRestart(h, "T1", 1));
    await h.reattach();
    // No feed: the ready task relaunches as attempt 2, which is lost at the next restart too.
    await h.running("T1", 2, "ses-c2");
    await h.crash();
    await h.journal(lostRestart(h, "T1", 2));
    h.rec.feeds = () => [feed("T1", "ready", { action: "adopt", evidence: "alive", n: 1, childSessionID: "ses-c1" })];
    await h.reattach();
    expect(h.hosts.interrupted).toEqual(["ses-c1"]);
    expect((await h.events()).filter((e) => e.type === "attempt-adopted")).toEqual([]);
    expect(h.bindings.binds).toEqual([]);
    // The task relaunches instead (attempt 3).
    await h.runOf("T1", 3);
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost", "lost", null]);
  });

  it("a same-process adopt of a tracked child keeps its carried token and handle (lines 2586, 2683)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const nonce = need(h.task("T1").attempts[0], "attempt 1").nonce;
    h.rec.feeds = () => [feed("T1", "running", { action: "adopt", evidence: "alive", n: 1, childSessionID: "ses-c1" })];
    await h.reattach();
    expect(h.rec.tracked).toEqual([[nonce]]);
    expect(h.bindings.binds.map((b) => b.childSessionID)).toEqual(["ses-c1"]);
    await until(async () => counters(await h.events(), "child-rebound").length === 1, "child-rebound counted");
    // The carried handle (not a restored, settled one) still processes the child's end, once.
    run.complete("DONE: ok");
    await until(() => h.state("T1") === "verified", "T1 verified");
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["succeeded"]);
  });

  it("Phase 5.1 (a): observe receives the child's final text (row 15) before the commit and again before verify", async () => {
    const h = await mk(planOf([task("T1")]));
    const seen: Array<string | undefined> = [];
    Object.assign(h.verifier, { observe: (_t: unknown, _s: unknown, _a: unknown, finalText?: string) => { seen.push(finalText); } });
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("DONE: implemented T1 (src/t1.ts:1)");
    await until(() => h.state("T1") === "verified", "T1 verified");
    expect(seen).toEqual(["DONE: implemented T1 (src/t1.ts:1)", "DONE: implemented T1 (src/t1.ts:1)"]);
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });

  it("Phase 5.1 (a): without a verifier observe hook no final text is kept or read", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("DONE: ok");
    await until(() => h.state("T1") === "verified", "T1 verified");
    expect("observe" in h.verifier).toBe(false);
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });

  it("a finished child whose context is unknown ends with an empty result (lines 2673, 2759, 2760)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.rec.feeds = () => [feed("T1", "running", { action: "process-result", evidence: "finished", n: 1, childSessionID: "ses-c1", context: null })];
    await h.reattach();
    await until(() => h.task("T1").attempts[0]?.outcome !== null, "attempt 1 closed");
    expect(h.bindings.binds.map((b) => b.childSessionID)).toEqual(["ses-c1"]);
    const ended = (await h.events()).filter((e) => e.type === "attempt-ended" && e.taskId === "T1" && e.n === 1);
    expect(ended).toHaveLength(1);
  });

  it("a finished child whose last entry says aborted is an unrequested interrupt (line 2761)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    const context: HostSessionContext = {
      messages: [
        { role: "assistant", text: "half way", outcome: null },
        { role: "idle", text: null, outcome: "aborted by user" },
      ],
    };
    h.rec.feeds = () => [feed("T1", "running", { action: "process-result", evidence: "finished", n: 1, childSessionID: "ses-c1", context })];
    await h.reattach();
    await until(() => h.task("T1").attempts[0]?.outcome !== null, "attempt 1 closed");
    expect(h.task("T1").attempts[0]?.outcome).toBe("lost");
    expect(h.verifier.calls).toEqual([]);
  });

  it("a finished child whose last entry says error is a failed attempt (line 2762)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    const context: HostSessionContext = { messages: [{ role: "idle", text: null, outcome: "provider error" }] };
    h.rec.feeds = () => [feed("T1", "running", { action: "process-result", evidence: "finished", n: 1, childSessionID: "ses-c1", context })];
    await h.reattach();
    await until(() => h.task("T1").attempts[0]?.outcome !== null, "attempt 1 closed");
    expect(h.task("T1").attempts[0]?.outcome).toBe("failed");
    expect(h.verifier.calls).toEqual([]);
  });

  it("a finished child's result is its last assistant text, skipping later entries without text (line 2769)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    const context: HostSessionContext = {
      messages: [
        { role: "assistant", text: "DONE: all good", outcome: null },
        { role: "assistant", text: null, outcome: null },
        { role: "idle", text: null, outcome: "completed" },
      ],
    };
    h.rec.feeds = () => [feed("T1", "running", { action: "process-result", evidence: "finished", n: 1, childSessionID: "ses-c1", context })];
    await h.reattach();
    await until(() => h.state("T1") === "verified", "T1 verified");
    expect(h.task("T1").attempts[0]?.outcome).toBe("succeeded");
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// reconcileFeeds / applyFeed (lines 2552-2631)
// ---------------------------------------------------------------------------------------------------------------

describe("reconcileFeeds and applyFeed", () => {
  it("start() reuses the recover() report in task-id order; a feed of an unknown or moved task is skipped (lines 2572, 2606)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    const withOrphan = (taskId: TaskId, from: TaskState, orphan: string): ReconcileFeed =>
      feed(taskId, from, { action: "requeue-lost", evidence: "lost", n: 1, orphans: [orphan] });
    h.rec.report = [
      {
        planId: PLAN_ID,
        actions: [withOrphan("T9", "running", "o-9"), withOrphan("T1", "ready", "o-1"), withOrphan("T8", "running", "o-8a"), withOrphan("T8", "running", "o-8b")],
      },
    ];
    h.rec.feeds = () => {
      throw new Error("reconcile must not run when the report is reused");
    };
    // The launch before the crash provisioned (reset) T1's slot; recovery must not reset it again.
    const resetsBefore = h.slots.resets.length;
    const resetCmdsBefore = h.git.verbs().filter((v) => v === "reset --hard HEAD").length;
    await h.runtime.start();
    await until(() => h.hosts.interrupted.length === 4, "the four orphans interrupted");
    // Step 3 walks the sorted report: T1, T8 (stable), T8, T9.
    expect(h.hosts.interrupted).toEqual(["o-1", "o-8a", "o-8b", "o-9"]);
    expect(h.rec.tracked).toEqual([]);
    // T9 is no task of the plan and T1 moved since the classification (running, not ready): both feeds are skipped.
    expect(h.state("T1")).toBe("running");
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual([null]);
    expect(h.slots.resets).toHaveLength(resetsBefore);
    expect(h.git.verbs().filter((v) => v === "reset --hard HEAD")).toHaveLength(resetCmdsBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R2 re-provisioning (reprovisionSlot, lines 2827-2897), reached through a `reverify` feed of a verifying task
// ---------------------------------------------------------------------------------------------------------------

const SLOT_LOST_TEXT = "no longer carries its marker after a restart and it could not be re-provisioned";

/** T1 committed (row 21 landed) and the process died before the verdict; the next attach gets a reverify feed, slot invalid. */
async function verifyingAfterCrash(h: Harness): Promise<string> {
  await h.begin();
  await h.running("T1", 1, "ses-c1");
  const slot = need(h.task("T1").slot, "slot of T1");
  await h.crash();
  await h.journal([
    { type: "attempt-ended", taskId: "T1", n: 1, outcome: "succeeded", endedAt: h.clock.iso(), detail: null },
    tr("T1", "running", "completed", "child-ended"),
  ]);
  await h.journal([{ type: "task-slot", taskId: "T1", slot, branch: taskBranchName(PLAN_ID, "T1") }, tr("T1", "completed", "verifying", "committed")]);
  h.rec.feeds = () => [feed("T1", "verifying", { action: "reverify", n: 1, slotValid: false })];
  return slot;
}

describe("reprovisionSlot", () => {
  it("a failed checkout returns the new slot and raises the slot-lost item (lines 2852 with a cause, 2855, 2870)", async () => {
    const h = await mk(planOf([task("T1")]));
    const stale = await verifyingAfterCrash(h);
    h.git.answers.set("switch", () => ({ code: 1, stderr: "checkout boom" }));
    await h.reattach();
    expect(h.slots.released).toEqual([stale, "slot-2"]);
    expect(h.logs.filter((l) => l.includes(`re-provisioning T1 from ${taskBranchName(PLAN_ID, "T1")}: checkout failed`) && l.includes("checkout boom"))).toHaveLength(1);
    expect(h.parts().policy.raised.filter((i) => i.text.includes(SLOT_LOST_TEXT)).map((i) => i.taskId)).toEqual(["T1"]);
    expect(h.state("T1")).toBe("verifying");
    expect(h.task("T1").slot).toBe(stale);
    expect(h.verifier.calls).toEqual([]);
  });

  it("an unavailable pool leaves nothing to return (line 2855 without a slot)", async () => {
    const h = await mk(planOf([task("T1")]));
    const stale = await verifyingAfterCrash(h);
    h.slots.acquireFailure = new Error("pool exhausted");
    await h.reattach();
    expect(h.slots.released).toEqual([stale]);
    expect(hasLog(h, `warn: re-provisioning T1 from ${taskBranchName(PLAN_ID, "T1")}: slot unavailable`)).toBe(true);
    expect(h.parts().policy.raised.filter((i) => i.text.includes(SLOT_LOST_TEXT))).toHaveLength(1);
    expect(h.verifier.calls).toEqual([]);
  });

  it("leases held elsewhere undo the re-provisioning without a cause (lines 2852 without a cause, 2878)", async () => {
    const h = await mk(planOf([task("T1")]));
    const stale = await verifyingAfterCrash(h);
    h.registry.held.set("src/T1.ts", { holderID: "holder-x", taskRef: "other-plan/T7" });
    await h.reattach();
    expect(h.logs).toContain(`warn: re-provisioning T1 from ${taskBranchName(PLAN_ID, "T1")}: leases held elsewhere ""`);
    expect(h.slots.released).toEqual([stale, "slot-2"]);
    expect(h.parts().policy.raised.filter((i) => i.text.includes(SLOT_LOST_TEXT))).toHaveLength(1);
    expect(h.verifier.calls).toEqual([]);
  });

  it("a slot the pool hands back unchanged journals nothing and the task verifies (line 2888)", async () => {
    const h = await mk(planOf([task("T1")]));
    const stale = await verifyingAfterCrash(h);
    // The pool no longer records the slot as this task's: it is not released, and acquire hands the same lease back.
    h.slots.records.delete(stale);
    const before = (await h.events()).length;
    await h.reattach();
    await until(() => h.state("T1") === "verified", "T1 verified");
    expect(h.task("T1").slot).toBe(stale);
    expect(h.slots.released).toEqual([]);
    expect(h.verifier.calls).toEqual(["T1#1"]);
    await until(async () => counters((await h.events()).slice(before), "slot-reprovisioned").length === 1, "slot-reprovisioned counted");
    const after = (await h.events()).slice(before);
    expect(after.filter((e) => e.type === "task-slot")).toEqual([]);
  });

  it("Phase 5.1 (a): after a restart observe receives the child's last assistant text, read through hosts.context", async () => {
    const h = await mk(planOf([task("T1")]));
    const seen: Array<string | undefined> = [];
    Object.assign(h.verifier, { observe: (_t: unknown, _s: unknown, _a: unknown, finalText?: string) => { seen.push(finalText); } });
    const stale = await verifyingAfterCrash(h);
    h.slots.records.delete(stale);
    const context: HostSessionContext = { messages: [
      { role: "assistant", text: "DONE: implemented T1 before the restart", outcome: null },
      { role: "idle", text: null, outcome: null },
    ] };
    h.hosts.contexts.set("ses-c1", context);
    await h.reattach();
    await until(() => h.state("T1") === "verified", "T1 verified");
    expect(seen).toEqual(["DONE: implemented T1 before the restart"]);
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });

  it("Phase 5.1 (a): after a restart a child without assistant text gives observe no final text", async () => {
    const h = await mk(planOf([task("T1")]));
    const seen: Array<string | undefined> = [];
    Object.assign(h.verifier, { observe: (_t: unknown, _s: unknown, _a: unknown, finalText?: string) => { seen.push(finalText); } });
    const stale = await verifyingAfterCrash(h);
    h.slots.records.delete(stale);
    await h.reattach();
    await until(() => h.state("T1") === "verified", "T1 verified");
    expect(seen).toEqual([undefined]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R1a probation (startProbation, provedAlive, pollProbation, probeChild: lines 3097-3227)
// ---------------------------------------------------------------------------------------------------------------

const POLL = 500;

function onProbation(h: Harness, taskId: TaskId, child: string, context: HostSessionContext | null, deadlineInMs: number): ReconcileFeed {
  return feed(taskId, "running", {
    action: "adopt",
    evidence: "alive",
    n: 1,
    childSessionID: child,
    context,
    probation: { deadlineAt: h.clock.now() + deadlineInMs, pollMs: POLL },
  });
}

const stepEnded = (h: Harness, sessionID: string): HostSessionEvent => ({ type: "step.ended", sessionID, at: h.clock.iso() });

describe("probation", () => {
  it("a sign of life of one of two children keeps the poll for the other, which is interrupted at its deadline (lines 3099, 3115, 3138)", async () => {
    const h = await mk(planOf([task("T1"), task("T2")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.running("T2", 1, "ses-c2");
    await h.crash();
    // T1's context is unknown (no signature yet); T2's is empty (a signature without a last message).
    h.rec.feeds = () => [onProbation(h, "T1", "ses-c1", null, 1000), onProbation(h, "T2", "ses-c2", { messages: [] }, 1000)];
    await h.reattach();
    h.runtime.onHostEvent(stepEnded(h, "ses-c1"));
    h.clock.advance(1000);
    await until(() => h.hosts.interrupted.includes("ses-c2"), "ses-c2 interrupted at its deadline");
    await h.runOf("T2", 2);
    expect(h.hosts.interrupted).toEqual(["ses-c2"]);
    expect(h.task("T2").attempts[0]?.outcome).toBe("lost");
    expect(h.state("T1")).toBe("running");
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual([null]);
  });

  it("a watch that ends while its poll reads the context is dropped by that poll (line 3173)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.rec.feeds = () => [onProbation(h, "T1", "ses-c1", { messages: [] }, 1000)];
    await h.reattach();
    const read = deferred<HostSessionContext>();
    const reads: string[] = [];
    h.hosts.contextImpl = async (sid) => {
      reads.push(sid);
      return read.promise;
    };
    h.clock.advance(POLL);
    await until(() => reads.length === 1, "the probation poll reading the context");
    h.runtime.onHostEvent(stepEnded(h, "ses-c1"));
    read.resolve({ messages: [] });
    h.clock.advance(5000);
    await pause(50);
    expect(reads).toEqual(["ses-c1"]);
    expect(h.hosts.interrupted).toEqual([]);
    expect(h.state("T1")).toBe("running");
  });

  it("a watch for a child the attempt does not record is dropped without a read or an interrupt (line 3163)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.rec.feeds = () => [onProbation(h, "T1", "ses-x", { messages: [] }, 0)];
    await h.reattach();
    const reads: string[] = [];
    h.hosts.contextImpl = async (sid) => {
      reads.push(sid);
      return { messages: [] };
    };
    h.clock.advance(POLL);
    await pause(50);
    h.clock.advance(5000);
    await pause(50);
    expect(reads).toEqual([]);
    expect(h.hosts.interrupted).toEqual([]);
    expect(h.state("T1")).toBe("running");
    expect(h.bindings.binds.map((b) => b.childSessionID)).toEqual(["ses-x"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Step 8 (evaluateBreakers, lines 3054-3083)
// ---------------------------------------------------------------------------------------------------------------

describe("evaluateBreakers at activation", () => {
  it("skips a paused phase and tolerates a breaker-fed marker without labels (lines 3067, 3070)", async () => {
    const plan = planOf([task("T1")]);
    plan.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: true, tag: null });
    plan.waves[0]?.phases.push("p2");
    const h = await mk(plan);
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    // Row 16 landed, the process died before `recordAttempt`; an older marker carries no labels at all.
    await h.journal([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "failed", endedAt: h.clock.iso(), detail: "boom" },
      { type: "attempt-context", taskId: "T1", n: 1, context: "boom" },
      tr("T1", "running", "failed", "child-failed", "boom"),
    ]);
    await h.journal([{ type: "metric", metric: { name: "counter", key: "breaker-fed", value: 1, labels: {} } }]);
    await h.reattach();
    expect(h.parts().policy.counted).toEqual([{ phaseId: "p1", n: 1, outcome: "failed", verdict: null }]);
    await until(async () => counters(await h.events(), "breaker-fed").length === 2, "the new breaker-fed marker");
    const labels = counters(await h.events(), "breaker-fed").map((e) => (e.type === "metric" && e.metric.name === "counter" ? e.metric.labels : null));
    expect(labels).toEqual([{}, { phaseId: "p1", taskId: "T1", n: "1" }]);
    await h.runOf("T1", 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// start() with several plans (line 4003), the board of an empty plan (3546) and the promotion of a refused one (3728)
// ---------------------------------------------------------------------------------------------------------------

describe("start with several plans", () => {
  it("attaches the running plan actively and the paused ones passively; resume promotes a refused plan once the slot is free", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    for (const id of ["plan-two", "plan-three"]) {
      const draft = buildDraft(0, id);
      draft.status = "paused";
      const w = await h.store.create(draft, holderOf(ORCH, 100, "host-a", h.clock.iso()));
      await w.close();
    }
    await h.runtime.start();
    expect(await h.runtime.status(PLAN_ID, ORCH)).not.toContain("Refused:");
    const two = await h.runtime.status("plan-two", ORCH);
    expect(two).toContain("Refused:");
    expect(two).toContain("Tasks: none");
    expect(await h.runtime.status("plan-three", ORCH)).toContain("Refused:");
    await h.runtime.abort(PLAN_ID, ORCH);
    await h.runtime.resume("plan-two", ORCH);
    expect(await h.runtime.status("plan-two", ORCH)).not.toContain("Refused:");
    const ev = (await h.store.exportPlan("plan-two")).events;
    expect(ev.some((e) => e.type === "status-changed" && e.from === "paused" && e.to === "running" && e.reason === "user-resume")).toBe(true);
    expect(await h.runtime.status("plan-three", ORCH)).toContain("Refused:");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// More applyFeed arms: an adopt feed without a child, a QA row 7, requeue-lost of a dispatched task with a bad slot
// ---------------------------------------------------------------------------------------------------------------

describe("applyFeed: adopt and requeue-lost arms", () => {
  it("an adopt feed that names no child leaves the task alone (line 2641, child null)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.rec.feeds = () => [feed("T1", "running", { action: "adopt", evidence: "alive", n: 1, childSessionID: null })];
    await h.reattach();
    expect(h.rec.tracked).toHaveLength(1);
    expect(h.bindings.binds).toEqual([]);
    expect(h.hosts.interrupted).toEqual([]);
    expect(h.state("T1")).toBe("running");
    expect(counters(await h.events(), "child-rebound")).toEqual([]);
  });

  it("requeue-lost of a dispatched task whose slot lost its marker: row 11, then the slot is cleared (lines 2793, 2798-2808)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.runOf("T1", 1);
    await until(() => h.state("T1") === "dispatched" && h.task("T1").slot !== null, "T1 dispatched in its slot");
    const slot = need(h.task("T1").slot, "slot of T1");
    await h.crash();
    const mark = h.git.calls.length;
    h.rec.feeds = () => [feed("T1", "dispatched", { action: "requeue-lost", evidence: "lost", n: 1, slotValid: false })];
    await h.reattach();
    expect(h.slots.released).toEqual([slot]);
    expect(h.task("T1").attempts[0]?.outcome).toBe("lost");
    const ev = await h.events();
    expect(ev.some((e) => e.type === "task-transition" && e.taskId === "T1" && e.from === "dispatched" && e.to === "ready" && e.trigger === "launch-lost")).toBe(true);
    // The relaunch provisions a fresh slot.
    await h.runOf("T1", 2);
    expect(h.task("T1").slot).not.toBe(slot);
    // R2: the slot whose marker is missing was never reset by recovery.
    const resetsOfOld = h.git.calls.slice(mark).filter((c) => c.args.join(" ") === "reset --hard HEAD" && c.cwd === slotPathOf(slot));
    expect(resetsOfOld).toEqual([]);
  });
});

// Arms in 2562-4003 left uncovered on purpose (defensive re-checks or unreachable):
// 2562 (a tracked handle always names a journaled attempt), 2586 t === null (callers pass a task they just read),
// 2789/2887/2894/2938/2941 (batch re-checks of a state the caller read under the task's own mutex), 2829/2975/2976/3000/3005
// (the engine sends `reverify` only for completed/verifying tasks with a slot and an attempt), 2955 (raiseSlotLost is only
// reached for a task holding a slot), 3022 (phases are never removed), 3034 `?? ""` arms (a done attempt always has
// endedAt), 3148/3149 (a poll racing dispose or a second poll; the timer is single and cleared on close), 3791 (a live
// launch always holds a slot), functions @3306/@3862 (placeholders replaced synchronously by their Promise executors),
// 4003 equal-planId arm (plan ids are unique; store.list() returns them in id order).
// QA gate arms the ledger's qa-gate invariant (batchEndViolation) makes illegal: 2657 true arm (a ready QA task whose
// phase gate is not awaiting-qa), 3033 `state !== "done"` true arm and 3036 (a qa-running phase with no QA task in flight
// and none done), 3034 if-false arm (a second finished QA task of the same phase: a draft with two QA tasks in one phase
// is refused by `create`, E_SCHEMA_INVALID, and the QaLoop double never creates next-round tasks).
