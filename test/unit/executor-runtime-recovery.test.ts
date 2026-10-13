// Runtime-harness tests of the phase-4.2 memo §10 (plan task 4.2.5): start and locks (L2), R1a probation, the D11
// commit trailer, the approve-path integration resume (§9), same-process adopt (D12) and the breaker evaluated at
// activation (B5). The harness is a trimmed copy of test/unit/executor-runtime.test.ts: the real LedgerStore in a temp
// dir, the real Scheduler, CapacityController and RecoveryService; typed doubles for everything else. All time comes
// from TestClock; a "restart" disposes the runtime and builds a new one with a fresh launcher (a new process).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapacityController } from "../../src/executor/capacity.js";
import { createLedgerStore } from "../../src/executor/ledger.js";
import { createRecoveryService, type RecoveryEngine } from "../../src/executor/recovery.js";
import {
  attemptTrailer,
  commitTaskInSlot,
  createExecutorRuntime,
  realCollaborators,
  type ExecutorRuntimeHandle,
  type LeaseRegistryPort,
  type PlanCollaborators,
  type RuntimeDeps,
} from "../../src/executor/runtime.js";
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
  type ExecutorEvent,
  type ExecutorEventInput,
  type FindingsReport,
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
const HEAD_SHA = "e".repeat(40);
const SLOT_ROOT = "C:/omr-rt";
const ORCH = "ses-0";
const PROVIDER = "prov";
const REPO = "C:/repo";
const HALT_TEXT = "integration branch tip does not match integration.head; fix it, then resume";
const POLL_MS = 10_000;
const LIVENESS_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Clock and small helpers
// ---------------------------------------------------------------------------------------------------------------

/** Manual clock: time moves only with `advance`; due timers run in order, each at its own due time. */
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

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve: (v) => resolve(v) };
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

function planOf(tasks: TaskNode[], edges: Edge[] = []): LedgerV1 {
  const d = buildDraft(0);
  d.config = { ...d.config, wakeDebounceMs: 1000, capacityCooldownMs: 10_000 };
  d.integration = { ...d.integration, head: SHA };
  d.repo = { ...d.repo, toplevel: REPO };
  d.sharedContext = "shared notes";
  for (const t of tasks) d.tasks[t.id] = t;
  d.edges = edges;
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
// Doubles
// ---------------------------------------------------------------------------------------------------------------

class SlotPoolDouble implements SlotPool {
  readonly byOwner = new Map<string, SlotLease>();
  readonly records = new Map<string, SlotRecord>();
  readonly released: string[] = [];
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
    return lease;
  }
  async acquireSpecial(): Promise<SlotLease> {
    throw new Error("acquireSpecial is not used by the runtime");
  }
  async reset(slot: string): Promise<void> {
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
  /** The slot marker (R2): the plan and task the slot is leased to. */
  marker(slot: string): { planId: string; taskId: TaskId } | null {
    for (const l of this.byOwner.values()) {
      if (l.slot !== slot && l.path !== slot) continue;
      const taskId = l.owner.split(":")[2];
      return taskId === undefined ? null : { planId: l.planId, taskId };
    }
    return null;
  }
}

class RegistryDouble implements LeaseRegistryPort {
  readonly held = new Map<string, { holderID: string; taskRef: string | null }>();
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
    return { ok: true };
  }
  releaseTask(taskRef: string): void {
    for (const [p, h] of [...this.held]) if (h.taskRef === taskRef) this.held.delete(p);
  }
  holderOf(path: string): { holderID: string; taskRef: string | null } | null {
    return this.held.get(path) ?? null;
  }
}

/** IntegrationQueue: records calls; `resume` halts like the real queue (A2-5) while `cfg.halt` is set. */
class QueueDouble implements IntegrationQueue {
  readonly enqueued: TaskId[][] = [];
  resumes = 0;
  constructor(
    private readonly log: CallLog,
    private readonly writer: LedgerWriter,
    private readonly cfg: { halt: boolean },
    private readonly clock: Clock,
  ) {}
  enqueue(ids: readonly TaskId[]): void {
    this.enqueued.push([...ids]);
    this.log.push(`queue.enqueue:${ids.join(",")}`);
  }
  async resume(): Promise<ResumeReport> {
    this.resumes += 1;
    this.log.push(`queue.resume:${this.resumes}`);
    if (!this.cfg.halt) return { completed: [], rolledBack: [], halted: false, entries: [] };
    await this.writer.append((l) => {
      const ev: ExecutorEventInput[] = [];
      if (l.status === "running") ev.push({ type: "status-changed", from: "running", to: "paused", reason: "integration-halt" });
      if (!l.inbox.some((i) => i.answer === null && i.text === HALT_TEXT)) {
        const item: InboxItem = {
          id: formatInboxId("failure", nextInboxNumber(l)),
          kind: "failure",
          severity: "blocking",
          taskId: null,
          text: HALT_TEXT,
          options: [],
          answer: null,
          createdAt: this.clock.iso(),
        };
        ev.push({ type: "inbox-added", item });
      }
      return ev;
    });
    return { completed: [], rolledBack: [], halted: true, entries: [] };
  }
  async checkPhase(): Promise<void> {}
  async land(): Promise<{ landed: boolean; inbox: InboxItem | null }> {
    return { landed: true, inbox: null };
  }
  async abort(): Promise<void> {}
  queued(): readonly TaskId[] {
    return this.enqueued.flat();
  }
  async dispose(): Promise<void> {}
}

/** UnattendedPolicy over the real writer (as in executor-runtime.test.ts): park journals the P rows. */
class PolicyDouble implements UnattendedPolicy {
  readonly raised: Array<Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string }> = [];
  readonly counted: Array<{ phaseId: PhaseId; taskId: TaskId | null; n: number; outcome: Attempt["outcome"] }> = [];
  constructor(
    private readonly writer: LedgerWriter,
    private readonly clock: Clock,
  ) {}
  async raise(i: Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string }): Promise<InboxItem> {
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
  async park(taskId: TaskId, cause: "escalate" | "ambiguity" | "qa-unparsable" | "exhausted", text: string): Promise<InboxItem> {
    return this.raise({ kind: "failure", severity: "blocking", taskId, text: `${cause}: ${text}`, options: [] });
  }
  async answer(): Promise<{ resumed: TaskId | null }> {
    return { resumed: null };
  }
  async unblock(): Promise<TaskId[]> {
    return [];
  }
  async recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }> {
    const owner = Object.values(this.writer.ledger.tasks).find((t) => t.attempts.some((x) => x.nonce === a.nonce));
    this.counted.push({ phaseId, taskId: owner?.id ?? null, n: a.n, outcome: a.outcome });
    return { tripped: false };
  }
}

class QaDouble implements QaLoop {
  parse(text: string): { ok: true; report: FindingsReport } | { ok: false; error: string } {
    try {
      const v: unknown = JSON.parse(text);
      return isFindingsReport(v) ? { ok: true, report: v } : { ok: false, error: "does not match the findings schema" };
    } catch {
      return { ok: false, error: "not JSON" };
    }
  }
  async onQaResult(): Promise<"passed" | "next-round" | "cap-reached"> {
    return "passed";
  }
  async onAwaitingQa(): Promise<void> {}
  async onCapAnswer(): Promise<"passed" | "next-round"> {
    return "passed";
  }
}

/** GitRunner: a commit becomes the slot's HEAD message (`log -1 --format=%B`); `rev-parse` answers `head`. */
class GitDouble implements GitRunner {
  readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];
  dirty: (cwd: string) => boolean = () => true;
  headBody = "base\n";
  head = HEAD_SHA;
  async run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> {
    this.calls.push({ args: [...args], cwd: o.cwd });
    const verb = args[0] ?? "";
    const ok = (stdout = ""): ProcessResult => ({ code: 0, signal: null, stdout, stderr: "", truncated: false, durationMs: 0 });
    if (verb === "worktree") return ok(`worktree ${REPO}\nHEAD ${SHA}\nbranch refs/heads/main\n`);
    if (verb === "config") return { ...ok(), code: 1 };
    if (verb === "status") return ok(this.dirty(o.cwd) ? " M src/a.ts\n" : "");
    if (verb === "log") return ok(this.headBody);
    if (verb === "rev-parse") return ok(`${this.head}\n`);
    if (verb === "commit") this.headBody = `${args.filter((_, i) => args[i - 1] === "-m").join("\n\n")}\n`;
    return ok();
  }
  verbsSince(mark: number): string[] {
    return this.calls.slice(mark).map((c) => c.args.join(" "));
  }
}

class HostsDouble implements HostSessions {
  readonly contexts = new Map<string, HostSessionContext>();
  readonly gone = new Set<string>();
  activityValue: "active" | "inactive" | "unknown" = "unknown";
  readonly interrupts: string[] = [];
  interruptImpl: (sessionID: string) => Promise<void> = async () => undefined;
  readonly listeners = new Set<(e: HostSessionEvent) => void>();
  async get(sessionID: string): Promise<{ id: string; parentID: string | null } | null> {
    return this.gone.has(sessionID) ? null : { id: sessionID, parentID: ORCH };
  }
  async context(sessionID: string): Promise<HostSessionContext> {
    return this.contexts.get(sessionID) ?? { messages: [] };
  }
  async activity(): Promise<"active" | "inactive" | "unknown"> {
    return this.activityValue;
  }
  async interrupt(sessionID: string): Promise<void> {
    this.interrupts.push(sessionID);
    await this.interruptImpl(sessionID);
  }
  async synthetic(): Promise<void> {}
  async move(): Promise<void> {}
  onEvent(listener: (e: HostSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(e: HostSessionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
  /** Appends messages to a child's context (what a poll sees). */
  say(sessionID: string, ...messages: HostSessionContext["messages"]): void {
    const cur = this.contexts.get(sessionID) ?? { messages: [] };
    this.contexts.set(sessionID, { messages: [...cur.messages, ...messages] });
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
  route: (t) => ({ agent: t.route.role, model: { providerID: PROVIDER, modelID: "model-1", variant: null }, provider: PROVIDER, heavy: false }),
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
  readonly runs: RunDouble[] = [];
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
    const run = this.runs.find((r) => r.req.taskId === taskId && r.req.attempt === attempt);
    run?.end({ kind: "interrupted", childSessionID: run.childSessionID, reason, endedAt: this.clock.iso() });
  }
  inFlight(): ReadonlyArray<{ taskId: TaskId; attempt: number; childSessionID: string | null; startedAt: string }> {
    return this.runs.filter((r) => !r.settled).map((r) => ({ taskId: r.req.taskId, attempt: r.req.attempt, childSessionID: r.childSessionID, startedAt: T0 }));
  }
  async dispose(): Promise<void> {}
  runOf(taskId: TaskId, attempt: number): RunDouble | undefined {
    return this.runs.find((r) => r.req.taskId === taskId && r.req.attempt === attempt);
  }
  /** Settles every run without journaling anything (test end). */
  releaseAll(): void {
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
}

interface Harness {
  root: string;
  clock: TestClock;
  proc: FakeProc;
  log: CallLog;
  logs: string[];
  store: LedgerStore;
  slots: SlotPoolDouble;
  launcher: LauncherDouble;
  verifier: VerifierDouble;
  git: GitDouble;
  hosts: HostsDouble;
  queueCfg: { halt: boolean };
  deps: RuntimeDeps;
  runtime: ExecutorRuntimeHandle;
  parts(): PlanParts;
  ledger(): Readonly<LedgerV1>;
  task(id: TaskId): TaskNode;
  state(id: TaskId): TaskState;
  begin(): Promise<void>;
  runOf(id: TaskId, n: number): Promise<RunDouble>;
  /** Waits for the launch, creates the child (its context carries the launch prompt as the host stores it). */
  running(id: TaskId, n: number, sessionID: string): Promise<RunDouble>;
  events(): Promise<ExecutorEvent[]>;
  /** A fresh RecoveryService (a new process) as `deps.recovery`. */
  engine(toplevel?: string): RecoveryEngine;
  /** The process dies: the runtime is disposed with its children still running, the next one gets a fresh launcher. */
  crash(): Promise<void>;
  /** `crash`, a fresh recovery engine, then `start()`. */
  restart(): Promise<void>;
  /** A writer of another process (pid) on the same host holding the plan's lock. */
  otherHolder(pid: number): Promise<LedgerWriter>;
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
  const root = await mkdtemp(join(tmpdir(), "omr-rt-recovery-"));
  const home = join(root, "omr-executor");
  const clock = new TestClock();
  const proc = new FakeProc(100, "host-a");
  const log: CallLog = [];
  const logs: string[] = [];
  const st: { parts: PlanParts | null } = { parts: null };
  const storeOf = (p: FakeProc): LedgerStore =>
    createLedgerStore({
      home,
      clock,
      proc: p,
      warn: (m: string) => {
        logs.push(`store-warn: ${m}`);
      },
      heartbeatMs: 3_600_000,
      staleMs: 7_200_000,
      snapshotEvery: 200,
    });
  const store = storeOf(proc);
  const slots = new SlotPoolDouble(log);
  const git = new GitDouble();
  const hosts = new HostsDouble();
  const verifier = new VerifierDouble();
  const queueCfg = { halt: false };
  const others: LedgerWriter[] = [];
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
    leaseRegistry: new RegistryDouble(),
    recovery: null,
    holder,
    capacity: (o) => createCapacityController(o),
    collaborators: (i) => {
      const queue = new QueueDouble(log, i.writer, queueCfg, clock);
      const policy = new PolicyDouble(i.writer, clock);
      st.parts = { writer: i.writer, leases: i.leases, waker: i.waker, listener: i.listener, queue, policy };
      const c: PlanCollaborators = { queue, policy, qa: new QaDouble() };
      return c;
    },
    pinOrchestrator: () => () => undefined,
    log: (level, msg, detail) => {
      logs.push(`${level}: ${msg}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    },
    config: () => draft.config,
  };
  let closed = false;
  const h: Harness = {
    root,
    clock,
    proc,
    log,
    logs,
    store,
    slots,
    launcher: deps.launcher as LauncherDouble,
    verifier,
    git,
    hosts,
    queueCfg,
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
      hosts.contexts.set(sessionID, { messages: [{ role: "user", text: run.req.prompt, outcome: null }] });
      await run.child(sessionID);
      return run;
    },
    async events() {
      return (await store.exportPlan(PLAN_ID)).events;
    },
    engine(toplevel = REPO) {
      const e = createRecoveryService({
        store,
        host: hosts,
        toplevel,
        holder,
        slotMarker: async (s) => slots.marker(s),
        clock,
        log: (level, msg, detail) => {
          logs.push(`${level}: ${msg}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
        },
        livenessMs: LIVENESS_MS,
        pollMs: POLL_MS,
      });
      deps.recovery = e;
      return e;
    },
    async crash() {
      await h.runtime.dispose();
      const launcher = new LauncherDouble(log, clock);
      deps.launcher = launcher;
      h.launcher = launcher;
      h.runtime = createExecutorRuntime(deps);
    },
    async restart() {
      await h.crash();
      h.engine();
      await h.runtime.start();
    },
    async otherHolder(pid) {
      const p = new FakeProc(pid, proc.hostname);
      const w = await storeOf(p).open(PLAN_ID, holderOf(ORCH, pid, proc.hostname, clock.iso()));
      others.push(w);
      return w;
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
      for (const w of others) {
        try {
          await w.close();
        } catch {
          // a fenced writer (taken over) cannot close cleanly
        }
      }
    },
  };
  harnesses.push(h);
  return h;
}

/** Moves the clock in poll steps, letting each poll finish (only while no child of this process is alive). */
async function advance(h: Harness, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += POLL_MS) {
    h.clock.advance(Math.min(POLL_MS, ms - t));
    await h.runtime.settled();
  }
}

function endsOf(events: readonly ExecutorEvent[], taskId: TaskId): ExecutorEvent[] {
  return events.filter((e) => e.type === "attempt-ended" && e.taskId === taskId);
}

async function untilEnqueued(h: Harness, id: TaskId): Promise<void> {
  await until(() => h.state(id) === "verified", `${id} verified`);
  await until(() => h.parts().queue.enqueued.some((ids) => ids.includes(id)), `${id} enqueued`);
}

/** T1 runs in `ses-c1`; then the process dies and restarts with the child's liveness unknown (R1a probation). */
async function onProbation(): Promise<Harness> {
  const h = await mk(planOf([task("T1")]));
  await h.begin();
  await h.running("T1", 1, "ses-c1");
  h.hosts.activityValue = "unknown";
  await h.restart();
  await h.runtime.settled();
  expect(h.state("T1")).toBe("running");
  return h;
}

/** Row 15 is journaled (the child finished), then the process dies before row 21 (the commit's batch). */
async function completedThenCrash(h: Harness): Promise<Attempt> {
  await h.begin();
  await h.running("T1", 1, "ses-c1");
  const a = need(h.task("T1").attempts[0], "attempt 1");
  await h.parts().writer.append([
    { type: "attempt-ended", taskId: "T1", n: 1, outcome: "succeeded", endedAt: h.clock.iso(), detail: null },
    tr("T1", "running", "completed", "child-ended"),
  ]);
  return a;
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe("start and locks (L2)", () => {
  it("a stale holder (dead pid, same host) is taken over with reason 'recover' and the plan is reconciled", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    await h.otherHolder(200); // another process took the lock and died (pid 200 is not alive)
    h.hosts.activityValue = "active";
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();

    const takeovers = (await h.events()).filter((e) => JSON.stringify(e).includes("lock-takeover"));
    expect(takeovers.length).toBe(1);
    expect(JSON.stringify(takeovers[0])).toContain('"recover"');
    // Reconciled: the alive child is adopted without a batch and registered, so its host end finishes the task.
    expect(h.state("T1")).toBe("running");
    expect(h.hosts.interrupts).toEqual([]);
    h.hosts.say("ses-c1", { role: "assistant", text: "Done. Implemented it.", outcome: null });
    h.hosts.emit({ type: "execution.completed", sessionID: "ses-c1", at: h.clock.iso() });
    await untilEnqueued(h, "T1");
    expect(endsOf(await h.events(), "T1")).toHaveLength(1);
  });

  it("a live holder is skipped and logged: nothing is taken over, attached or interrupted", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    await h.otherHolder(200);
    h.proc.alive.add(200); // the holder is alive
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();

    expect(h.logs.some((l) => l.startsWith(`warn: plan ${PLAN_ID} not attached`))).toBe(true);
    expect(h.runtime.planLine(ORCH)).toBeNull();
    expect(h.hosts.interrupts).toEqual([]);
    expect((await h.events()).some((e) => JSON.stringify(e).includes("lock-takeover"))).toBe(false);
  });

  it("a plan of another toplevel is never taken over (open as in 3.1, skipped while locked)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    await h.otherHolder(200); // stale, but the plan is not this process's toplevel
    h.engine("C:/elsewhere");
    await h.runtime.start();
    await h.runtime.settled();

    expect(h.logs.some((l) => l.startsWith(`warn: plan ${PLAN_ID} not attached`))).toBe(true);
    expect((await h.events()).some((e) => JSON.stringify(e).includes("lock-takeover"))).toBe(false);
    expect(h.hosts.interrupts).toEqual([]);
  });
});

describe("R1a probation", () => {
  it("a host event of the child proves it alive: no interrupt after the deadline", async () => {
    const h = await onProbation();
    h.hosts.emit({ type: "step.started", sessionID: "ses-c1", providerID: PROVIDER, modelID: "model-1", at: h.clock.iso() });
    await advance(h, LIVENESS_MS + 3 * POLL_MS);
    expect(h.hosts.interrupts).toEqual([]);
    expect(h.state("T1")).toBe("running");
    expect(endsOf(await h.events(), "T1")).toHaveLength(0);
  });

  it("a context change seen by a poll proves it alive", async () => {
    const h = await onProbation();
    h.hosts.say("ses-c1", { role: "assistant", text: "still working", outcome: null });
    await advance(h, POLL_MS);
    await advance(h, LIVENESS_MS + 3 * POLL_MS);
    expect(h.hosts.interrupts).toEqual([]);
    expect(h.state("T1")).toBe("running");
  });

  it("a child that goes idle during probation is processed once (poll and host event)", async () => {
    const h = await onProbation();
    h.hosts.say("ses-c1", { role: "assistant", text: "Done. Implemented it.", outcome: null }, { role: "idle", text: null, outcome: "completed" });
    await advance(h, POLL_MS);
    await untilEnqueued(h, "T1");
    h.hosts.emit({ type: "execution.completed", sessionID: "ses-c1", at: h.clock.iso() });
    await h.runtime.settled();

    expect(endsOf(await h.events(), "T1")).toHaveLength(1);
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "pass" });
    expect(h.hosts.interrupts).toEqual([]);
  });

  it("no sign of life by the deadline: interrupt, slot reset, row 18 uncounted, relaunch only once the interrupt resolved", async () => {
    const h = await onProbation();
    const gate = deferred<void>();
    h.hosts.interruptImpl = () => gate.promise;
    await advance(h, LIVENESS_MS - POLL_MS); // five polls before the deadline
    expect(h.hosts.interrupts).toEqual([]);
    const mark = h.git.calls.length;
    h.clock.advance(POLL_MS); // the poll at the deadline interrupts
    await until(() => h.hosts.interrupts.length === 1, "the interrupt");
    await pause(20);
    expect(h.state("T1")).toBe("running");
    expect(h.launcher.runOf("T1", 2)).toBeUndefined();

    gate.resolve();
    await h.runOf("T1", 2);
    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1).toMatchObject({ outcome: "lost" });
    expect(JSON.stringify(endsOf(await h.events(), "T1")[0])).toContain('"restart"');
    expect(h.parts().policy.counted).toEqual([]);
    const verbs = h.git.verbsSince(mark);
    expect(verbs).toContain("reset --hard HEAD");
    expect(verbs).toContain("clean -fd");
    expect(h.git.calls.slice(mark).find((c) => c.args[0] === "reset")?.cwd).toBe(slotPathOf("slot-1"));
  });

  it("an interrupt that keeps failing never relaunches and raises one blocking item after five failures", async () => {
    const h = await onProbation();
    h.hosts.interruptImpl = async () => {
      throw new Error("server unreachable");
    };
    const stuck = (): number => h.parts().policy.raised.filter((i) => i.text.includes("could not be interrupted")).length;
    await advance(h, LIVENESS_MS + 3 * POLL_MS); // failures 1..4
    expect(h.hosts.interrupts.length).toBe(4);
    expect(stuck()).toBe(0);
    await advance(h, POLL_MS); // failure 5
    expect(stuck()).toBe(1);
    await advance(h, 3 * POLL_MS);
    expect(stuck()).toBe(1);
    expect(h.hosts.interrupts.length).toBe(8);
    expect(h.state("T1")).toBe("running");
    expect(h.launcher.runs).toEqual([]);
    expect(endsOf(await h.events(), "T1")).toHaveLength(0);
  });

  it("an interrupt answering 'not found' counts as done: the task is requeued and relaunched", async () => {
    const h = await onProbation();
    h.hosts.interruptImpl = async () => {
      throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
    };
    await advance(h, LIVENESS_MS - POLL_MS);
    h.clock.advance(POLL_MS);
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
  });
});

describe("D11 commit trailer", () => {
  it("every task commit carries Omr-Attempt: <planId>/<taskId>/<n>/<nonce>", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await untilEnqueued(h, "T1");
    const commit = need(h.git.calls.find((c) => c.args[0] === "commit"), "commit call");
    expect(commit.args).toContain(attemptTrailer(PLAN_ID, "T1", 1, run.req.nonce));
    expect(commit.args.slice(0, 2)).toEqual(["commit", "-m"]);
  });

  it("a crash after the commit, before row 21: the clean slot's HEAD carries the trailer, so the task verifies with that commit", async () => {
    const h = await mk(planOf([task("T1")]));
    const a = await completedThenCrash(h);
    // The commit landed before the crash: clean tree, HEAD is this attempt's commit.
    h.git.dirty = () => false;
    h.git.headBody = `T1: task (attempt 1)\n\n${attemptTrailer(PLAN_ID, "T1", 1, a.nonce)}\n`;
    const mark = h.git.calls.length;
    await h.restart();
    await untilEnqueued(h, "T1");

    expect(h.git.calls.slice(mark).some((c) => c.args[0] === "commit")).toBe(false);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "pass" });
    expect(h.verifier.calls).toEqual(["T1#1"]);
    const committed = (await h.events()).filter((e) => e.type === "task-transition" && e.taskId === "T1" && e.to === "verifying");
    expect(committed).toHaveLength(1);
  });

  it("a clean tree whose HEAD has no trailer keeps the old path ('no changes', counted, retried)", async () => {
    const h = await mk(planOf([task("T1", { verify: "required" })]));
    await completedThenCrash(h);
    h.git.dirty = () => false;
    h.git.headBody = "base commit\n";
    await h.restart();
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", context: "no changes" });
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().policy.counted.map((c) => c.n)).toContain(1);
  });

  it("a HEAD left by another attempt (a retry on the old branch) is not mistaken for this attempt's commit", async () => {
    const h = await mk(planOf([task("T1", { verify: "required" })]));
    await completedThenCrash(h);
    h.git.dirty = () => false;
    h.git.headBody = `T1: task (attempt 1)\n\n${attemptTrailer(PLAN_ID, "T1", 1, "f".repeat(32))}\n`;
    await h.restart();
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ context: "no changes" });
    expect(h.verifier.calls).toEqual([]);
  });

  it("commitTaskInSlot: a clean tree returns HEAD only for the exact trailer; attempt n+1 never matches attempt n", async () => {
    const git = new GitDouble();
    git.dirty = () => false;
    git.headBody = `T1: task (attempt 1)\n\n${attemptTrailer(PLAN_ID, "T1", 1, "aaaa")}\n`;
    const slot: SlotLease = { slot: "slot-1", path: slotPathOf("slot-1"), planId: PLAN_ID, owner: "o", commit: SHA };
    const base = { slot, branch: "omr/plan-one/T1", message: "m", timeoutMs: 1000 };
    await expect(commitTaskInSlot(git, { ...base, trailer: attemptTrailer(PLAN_ID, "T1", 1, "aaaa") })).resolves.toEqual({ changed: true, commit: HEAD_SHA });
    await expect(commitTaskInSlot(git, { ...base, trailer: attemptTrailer(PLAN_ID, "T1", 2, "bbbb") })).resolves.toEqual({ changed: false });
    await expect(commitTaskInSlot(git, base)).resolves.toEqual({ changed: false });
  });
});

describe("approve-path integration resume (§9)", () => {
  function awaitingApproval(): LedgerV1 {
    const d = planOf([task("T1")]);
    d.status = "awaiting-approval";
    return d;
  }

  it("approve calls queue.resume() once, before the first launch", async () => {
    const h = await mk(awaitingApproval());
    await h.begin();
    expect(h.parts().queue.resumes).toBe(0);
    await h.runtime.approve(PLAN_ID, ORCH);
    await h.runOf("T1", 1);
    expect(h.parts().queue.resumes).toBe(1);
    const at = (p: string): number => h.log.findIndex((l) => l.startsWith(p));
    expect(at("queue.resume:1")).toBeGreaterThanOrEqual(0);
    expect(at("queue.resume:1")).toBeLessThan(at("launcher.launch:T1#1"));
  });

  it("a halted resume leaves the plan paused with one item and launches nothing; the user's resume calls it again", async () => {
    const h = await mk(awaitingApproval());
    h.queueCfg.halt = true;
    await h.begin();
    await h.runtime.approve(PLAN_ID, ORCH);
    await h.runtime.settled();
    expect(h.ledger().status).toBe("paused");
    expect(h.ledger().inbox.filter((i) => i.answer === null && i.text === HALT_TEXT)).toHaveLength(1);
    expect(h.launcher.runs).toEqual([]);

    h.queueCfg.halt = false;
    await h.runtime.resume(PLAN_ID, ORCH);
    expect(h.parts().queue.resumes).toBe(2);
    await h.runOf("T1", 1);
    // Once it succeeded, a later resume does not call it again.
    await h.runtime.pause(PLAN_ID, ORCH);
    await h.runtime.resume(PLAN_ID, ORCH);
    expect(h.parts().queue.resumes).toBe(2);
  });
});

describe("same-process adopt (D12)", () => {
  it("launches this process tracks are untouched by the adopt and their end is processed once by the new attachment", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    h.hosts.activityValue = "inactive"; // would be "lost" if it were reconciled
    h.engine();
    await h.runtime.adopt(PLAN_ID, "ses-new");
    await until(() => h.ledger().orchestrator.sessionID === "ses-new", "the new orchestrator");
    await pause(20);
    expect(h.state("T1")).toBe("running");
    expect(h.hosts.interrupts).toEqual([]);
    expect(endsOf(await h.events(), "T1")).toHaveLength(0);

    run.complete("Done. Implemented it.");
    await untilEnqueued(h, "T1");
    expect(endsOf(await h.events(), "T1")).toHaveLength(1);
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });
});

describe("breaker at activation (B5)", () => {
  it("a counted failure whose breaker feed was missed by a crash is fed once when the plan is recovered", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    // Row 16 landed, the process died before `recordAttempt`.
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "failed", endedAt: h.clock.iso(), detail: "boom" },
      { type: "attempt-context", taskId: "T1", n: 1, context: "boom" },
      tr("T1", "running", "failed", "child-failed", "boom"),
    ]);
    expect(h.parts().policy.counted).toEqual([]);
    await h.restart();
    await until(() => h.parts().policy.counted.length > 0, "the breaker feed");
    expect(h.parts().policy.counted).toEqual([expect.objectContaining({ taskId: "T1", n: 1, outcome: "failed" })]);
    await h.runOf("T1", 2); // step 6: the retry decision left behind
  });
});

describe("realCollaborators", () => {
  it("builds the real QA loop and unattended policy around the given queue", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const parts = h.parts();
    let queued: IntegrationQueue | null = null;
    const build = realCollaborators({
      queue: (i) => {
        expect(i.qa).toBeDefined();
        expect(i.policy).toBeDefined();
        queued = new QueueDouble(h.log, i.writer, h.queueCfg, h.clock);
        return queued;
      },
      clock: h.clock,
      log: h.deps.log,
    });
    const c = build({ writer: parts.writer, leases: parts.leases, waker: parts.waker, listener: parts.listener });
    expect(c.queue).toBe(queued);
    expect(c.qa.parse(JSON.stringify({ findings: [] })).ok).toBe(true);
    const item = await c.policy.raise({ kind: "failure", severity: "blocking", taskId: null, text: "note", options: [] });
    expect(h.ledger().inbox.some((i) => i.id === item.id)).toBe(true);
  });
});
