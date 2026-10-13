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
import { taskBranchName } from "../../src/executor/git.js";
import type { PlanBindInput, PlanRoleBindings } from "../../src/executor/launch.js";
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
  type ReconcileAction,
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

/** Wall-clock bound of `until`, below the 30 s test timeout so a wait that never ends fails with its state. */
const UNTIL_MS = 20_000;

async function until(pred: () => boolean | Promise<boolean>, what: string, state?: () => unknown): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await pause(2);
  }
  let seen = "";
  if (state !== undefined) {
    try {
      seen = `; state: ${JSON.stringify(state())}`;
    } catch (e) {
      seen = `; state unreadable: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(`timed out waiting for ${what}${seen}`);
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
  /** QA-4.2-3: `dispose` calls; a disposed queue's lanes stop (no enqueue is recorded any more). */
  disposed = 0;
  constructor(
    private readonly log: CallLog,
    private readonly writer: LedgerWriter,
    private readonly cfg: QueueCfg,
    private readonly clock: Clock,
  ) {}
  enqueue(ids: readonly TaskId[]): void {
    if (this.disposed > 0) {
      this.log.push(`queue.enqueue-after-dispose:${ids.join(",")}`);
      return;
    }
    this.enqueued.push([...ids]);
    this.log.push(`queue.enqueue:${ids.join(",")}`);
  }
  async resume(): Promise<ResumeReport> {
    this.resumes += 1;
    this.log.push(`queue.resume:${this.resumes}`);
    if (this.cfg.reject) throw new Error("integration slot unavailable");
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
  /** When set, `dispose` waits for it (a same-process adopt's re-attach window stays open meanwhile). */
  disposeGate: Promise<void> | null = null;
  async dispose(): Promise<void> {
    this.disposed += 1;
    this.log.push("queue.dispose");
    if (this.disposeGate !== null) await this.disposeGate;
  }
}

/** Queue double switches: `halt` halts `resume` (A2-5), `reject` makes it reject (QA-4.2-6). */
interface QueueCfg {
  halt: boolean;
  reject: boolean;
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
  /** The runtime call site of each `recordAttempt` (its runtime.ts frames), for assertion messages. */
  readonly sites: string[] = [];
  async recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }> {
    const frames = (new Error("site").stack ?? "")
      .split("\n")
      .slice(1)
      .map((s) => s.trim())
      .filter((s) => s.includes("runtime.ts"));
    this.sites.push(frames.slice(0, 3).join(" <- ") || "unknown");
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
  /** QA-4.2-13: what `git log --all --grep=<trailer>` finds (a commit id, or "" for none). */
  trailerCommit = "";
  async run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> {
    this.calls.push({ args: [...args], cwd: o.cwd });
    const verb = args[0] ?? "";
    const ok = (stdout = ""): ProcessResult => ({ code: 0, signal: null, stdout, stderr: "", truncated: false, durationMs: 0 });
    if (verb === "worktree") return ok(`worktree ${REPO}\nHEAD ${SHA}\nbranch refs/heads/main\n`);
    if (verb === "config") return { ...ok(), code: 1 };
    if (verb === "status") return ok(this.dirty(o.cwd) ? " M src/a.ts\n" : "");
    if (verb === "log" && args.includes("--all")) return ok(this.trailerCommit === "" ? "" : `${this.trailerCommit}\n`);
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
  queueCfg: QueueCfg;
  /** The launcher's binding port (QA-4.2-18/-23): every bind and evict the runtime made. */
  bindings: BindingsDouble;
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
  const queueCfg: QueueCfg = { halt: false, reject: false };
  const bindings = new BindingsDouble();
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
    bindings,
    toplevel: REPO,
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
    bindings,
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
      await until(
        () => h.launcher.runOf(id, n) !== undefined,
        `launch of ${id}#${n}`,
        () => {
          const t = st.parts === null ? undefined : st.parts.writer.ledger.tasks[id];
          return {
            status: st.parts?.writer.ledger.status ?? null,
            state: t?.state ?? null,
            slot: t?.slot ?? null,
            attempts: t?.attempts.map((a) => `${a.n}:${a.outcome ?? "open"}:${a.context}`) ?? [],
            runs: h.launcher.runs.map((r) => `${r.req.taskId}#${r.req.attempt}`),
            inbox: st.parts?.writer.ledger.inbox.filter((i) => i.answer === null).map((i) => i.text) ?? [],
          };
        },
      );
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
      // QA-4.2-21: the process's toplevel is the engine's (a foreign-plan test passes another one).
      deps.toplevel = toplevel;
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

/** QA-4.2 round 3: coverage of the held-slot R2 path, binding eviction on abort/close and a failed same-process re-attach. */
describe("QA-4.2 round 3: held-slot R2, binding eviction, failed re-attach", () => {
  it("a held completed task whose slot record vanished checks its attempt's trailer first (slotVanished): none -> 'slot lost before commit', never re-provisioned", async () => {
    const plan = planOf([task("T1")]);
    plan.config = { ...plan.config, maxAttempts: 3 }; // the retry (attempt 2) is awaited below
    const h = await mk(plan);
    await completedThenCrash(h);
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("completed");
    const old = need(h.task("T1").slot, "slot of T1");
    h.slots.records.delete(old);
    dropSlotMarker(h, old);
    h.git.trailerCommit = ""; // no commit carries attempt 1's trailer
    const mark = h.git.calls.length;
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await until(
      () => h.task("T1").attempts[0]?.context === "slot lost before commit",
      "T1#1 failed as slot lost before commit",
      () => ({ state: h.state("T1"), slot: h.task("T1").slot, logs: h.logs }),
    );
    // Retried (as for any commit failure): attempt 2 is launched. Never `settled()` here: the relaunched child is live,
    // so its tracked wait never settles.
    await h.runOf("T1", 2);
    const calls = h.git.calls.slice(mark);
    expect(calls.some((c) => c.args[0] === "log" && c.args.includes("--all"))).toBe(true);
    expect(calls.some((c) => c.args[0] === "switch" || c.args[0] === "commit")).toBe(false);
    const ev = await h.events();
    expect(ev.filter((e) => e.type === "task-transition" && e.taskId === "T1" && e.from === "completed" && e.to === "failed")).toHaveLength(1);
    expect(h.verifier.calls).toEqual([]);
  }, 10_000);

  it("a held verifying task whose slot record vanished is re-provisioned without the trailer check and verified (slotVanished)", async () => {
    const h = await mk(planOf([task("T1")]));
    await completedThenCrash(h);
    // Row 21 landed (the commit's batch), the process died before the verdict.
    const slot = need(h.task("T1").slot, "slot of T1");
    await h.parts().writer.append([
      { type: "task-slot", taskId: "T1", slot, branch: taskBranchName(PLAN_ID, "T1") },
      tr("T1", "completed", "verifying", "committed"),
    ]);
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("verifying");
    const old = need(h.task("T1").slot, "slot of T1");
    h.slots.records.delete(old);
    dropSlotMarker(h, old);
    h.git.trailerCommit = ""; // a trailer check would find no commit and fail the attempt
    const mark = h.git.calls.length;
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await until(
      () => h.parts().queue.enqueued.some((ids) => ids.includes("T1")),
      "T1 re-provisioned, verified and enqueued",
      () => ({ state: h.state("T1"), slot: h.task("T1").slot, raised: h.parts().policy.raised.map((i) => i.text), logs: h.logs }),
    );
    expect(h.task("T1").slot).not.toBe(old);
    expect(h.state("T1")).toBe("verified");
    expect(h.verifier.calls).toEqual(["T1#1"]);
    // A trailer check would have found no commit (trailerCommit "") and failed the attempt instead.
    expect(h.task("T1").attempts[0]?.context).not.toBe("slot lost before commit");
    expect(h.git.calls.slice(mark).some((c) => c.args[0] === "log" && c.args.includes("--all"))).toBe(false);
  });

  it("an adopt that fails after the old attachment closed, with the plan taken by a live holder meanwhile: the re-attach fails, logged, nothing attached here", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    const e = h.engine();
    const other: { writer: LedgerWriter | null } = { writer: null };
    e.adopt = async () => {
      // Another live process opens the plan between the close of the old attachment and the re-attach.
      other.writer = await h.otherHolder(4242);
      throw new ExecutorError("E_LOCK_HELD", "held by a live process");
    };
    await expect(h.runtime.adopt(PLAN_ID, "ses-new")).rejects.toMatchObject({ code: "E_LOCK_HELD" });
    // Never `settled()` here: the T1 child is live and its tracked wait (no attachment processes its end) never settles.
    const failed = `error: plan ${PLAN_ID} could not be attached again after a failed adopt`;
    await until(() => h.logs.some((l) => l.startsWith(failed)), "the failed re-attach logged", () => ({ logs: h.logs }));
    expect(h.logs.filter((l) => l.startsWith(failed))).toHaveLength(1);
    expect(h.logs.filter((l) => l.includes(`adopt of ${PLAN_ID} failed; the plan is attached again`))).toEqual([]);
    expect(h.runtime.planLine(ORCH) ?? "").not.toContain(`plan ${PLAN_ID}:`);
    // The ledger stays with the live holder, under its previous orchestrator.
    expect(need(other.writer, "the other holder's writer").ledger.orchestrator.sessionID).toBe(ORCH);
  }, 10_000);

  it("abort evicts the binding of a child recovery adopted and re-bound", async () => {
    const h = await adoptedAndRebound();
    expect(h.bindings.evicted).toEqual([]);
    await h.runtime.abort(PLAN_ID, ORCH);
    expect(h.ledger().status).toBe("aborted");
    expect(h.bindings.evicted).toEqual(["ses-c1"]);
  });

  it("closing the plan (dispose) evicts the binding of a child recovery adopted and re-bound", async () => {
    const h = await adoptedAndRebound();
    expect(h.bindings.evicted).toEqual([]);
    // The process goes away with the child still running: the runtime is disposed, which closes the plan.
    await h.crash();
    expect(h.bindings.evicted).toEqual(["ses-c1"]);
  });

  it("a held task whose slot lookup throws stays held (logged) and resumes on a later retry (retryHeldLeases)", async () => {
    const h = await mk(planOf([task("T1")]));
    await completedThenCrash(h);
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("completed");
    const slot = need(h.task("T1").slot, "slot of T1");
    const get = h.slots.get.bind(h.slots);
    h.slots.get = async (s) => {
      if (s === slot) throw new Error("pool unreadable");
      return get(s);
    };
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await until(() => h.logs.some((l) => l.startsWith("warn: slot lookup of held T1 failed; retried next tick")), "the failed held lookup logged");
    await h.runtime.settled();
    expect(h.state("T1")).toBe("completed");
    expect(h.task("T1").slot).toBe(slot);
    expect(h.git.calls.some((c) => c.args[0] === "commit")).toBe(false);
    expect(h.verifier.calls).toEqual([]);
    expect(h.parts().queue.enqueued).toEqual([]);
    // The lookup works again: the next retry rebuilds the leases and the held step (commit-and-verify) runs.
    h.slots.get = get;
    h.runtime.onLeaseReleased();
    await untilEnqueued(h, "T1");
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(h.task("T1").slot).toBe(slot);
  });
});

/** A running T1 whose child (`ses-c1`) recovery adopted after a restart and re-bound through the binding port. */
async function adoptedAndRebound(): Promise<Harness> {
  const h = await mk(planOf([task("T1")]));
  await h.begin();
  await h.running("T1", 1, "ses-c1");
  await h.crash();
  h.hosts.activityValue = "active";
  h.engine();
  await h.runtime.start();
  await h.runtime.settled();
  expect(h.state("T1")).toBe("running");
  expect(h.bindings.binds.map((b) => b.childSessionID)).toEqual(["ses-c1"]);
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

  it("a plan of another toplevel is never taken over: attached read-only, never opened, even with a stale lock", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    await h.otherHolder(200); // stale, but the plan is not this process's toplevel
    h.engine("C:/elsewhere");
    h.deps.toplevel = "C:/elsewhere";
    const before = await h.store.exportPlan(PLAN_ID), open = vi.spyOn(h.store, "open");
    await h.runtime.start();
    await h.runtime.settled();

    // Phase 5.1 (A2): a foreign plan is decided before any open, so the stale lock is neither contended nor taken.
    expect(open).not.toHaveBeenCalled();
    expect(await h.store.exportPlan(PLAN_ID)).toEqual(before);
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

describe("same-process adopt: launch hooks resolve the live attachment", () => {
  it("a child created after the adopt for an in-flight launch is bound and confirmed on the new attachment, processed once", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    await until(() => h.state("T1") === "dispatched", "T1 dispatched");
    const before = h.parts().writer;
    h.engine();
    await h.runtime.adopt(PLAN_ID, "ses-new");
    await until(() => h.ledger().orchestrator.sessionID === "ses-new", "the new orchestrator");
    await pause(20);
    expect(h.parts().writer).not.toBe(before);
    expect(h.state("T1")).toBe("dispatched");
    expect(h.hosts.interrupts).toEqual([]);
    // the child comes only now: onChildCreated must bind it through the live writer, not refuse it on the closed one
    h.hosts.contexts.set("ses-c1", { messages: [{ role: "user", text: run.req.prompt, outcome: null }] });
    await run.child("ses-c1");
    await pause(20);
    expect(h.state("T1")).toBe("running");
    expect(h.task("T1").attempts[0]?.childSessionID).toBe("ses-c1");
    run.complete("done");
    await untilEnqueued(h, "T1");
    await h.runtime.settled();
    const ev = await h.events();
    expect(ev.filter((e) => e.type === "attempt-child" && e.taskId === "T1")).toHaveLength(1);
    expect(endsOf(ev, "T1")).toHaveLength(1);
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(h.launcher.runs).toHaveLength(1);
    expect(h.logs.filter((l) => /child refused|task vanished/.test(l))).toEqual([]);
  });

  it("a launch confirmation that fails after the adopt journals row 11 on the new attachment", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.runOf("T1", 1);
    await until(() => h.state("T1") === "dispatched", "T1 dispatched");
    h.engine();
    await h.runtime.adopt(PLAN_ID, "ses-new");
    await until(() => h.ledger().orchestrator.sessionID === "ses-new", "the new orchestrator");
    await pause(20);
    expect(h.state("T1")).toBe("dispatched");
    h.launcher.gateValue = DISPOSED_GATE; // no relaunch: only the confirmation's row 11 is under test
    // onConfirmation (L7) runs against the live writer; on the closed one row 11 would fail and T1 stay dispatched
    run.confirmation.resolve({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("T1") === "ready", "T1 requeued by row 11");
    await pause(20);
    const a = need(h.task("T1").attempts[0], "attempt 1");
    expect(a.outcome).toBe("lost");
    expect(endsOf(await h.events(), "T1")).toHaveLength(1);
    expect(h.logs.filter((l) => /row 11 failed/.test(l))).toEqual([]);
  });
});

describe("R2: a completed/verifying/verified task whose slot lost its marker", () => {
  const BRANCH = taskBranchName(PLAN_ID, "T1");
  const verifyRef = `refs/heads/${BRANCH}^{commit}`;

  /** The slot `name` carries no marker any more (missing): the pool forgets its owner. */
  function dropMarker(h: Harness, name: string): void {
    for (const [owner, l] of [...h.slots.byOwner]) if (l.slot === name) h.slots.byOwner.delete(owner);
  }

  /** The slot `name` now belongs to another task (foreign marker and pool record). */
  function foreignMarker(h: Harness, name: string): void {
    const rec = need(h.slots.records.get(name), `record of ${name}`);
    const owner = `omr:${PLAN_ID}:T9`;
    dropMarker(h, name);
    h.slots.byOwner.set(owner, { slot: name, path: rec.path, planId: PLAN_ID, owner, commit: SHA });
    h.slots.records.set(name, { ...rec, owner });
  }

  /** The task branch does not exist: `rev-parse --verify` of it fails. */
  function noBranch(h: Harness): void {
    const run = h.git.run.bind(h.git);
    h.git.run = async (args, o) => {
      if (args[0] === "rev-parse" && args.includes(verifyRef)) {
        h.git.calls.push({ args: [...args], cwd: o.cwd });
        return { code: 1, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0 };
      }
      return run(args, o);
    };
  }

  const openFailures = (h: Harness): InboxItem[] => h.ledger().inbox.filter((i) => i.taskId === "T1" && i.kind === "failure" && i.answer === null);

  it("completed, marker missing: re-provisioned from omr/<planId>/t/<taskId> (slot, checkout, leases), then committed and verified", async () => {
    const h = await mk(planOf([task("T1")]));
    const a = await completedThenCrash(h);
    const old = need(h.task("T1").slot, "slot of T1");
    h.git.dirty = () => false;
    h.git.headBody = `T1: task (attempt 1)\n\n${attemptTrailer(PLAN_ID, "T1", 1, a.nonce)}\n`;
    // QA-4.2-20: the attempt's commit is found by its trailer before the slot is re-provisioned from the branch.
    h.git.trailerCommit = HEAD_SHA;
    dropMarker(h, old);
    const mark = h.git.calls.length;
    const logMark = h.log.length;
    await h.restart();
    await untilEnqueued(h, "T1");

    const t = h.task("T1");
    expect(t.slot).not.toBeNull();
    expect(t.slot).not.toBe(old);
    expect(t.branch).toBe(BRANCH);
    const fresh = need(t.slot, "new slot");
    const calls = h.git.calls.slice(mark);
    expect(calls.some((c) => c.args[0] === "rev-parse" && c.args.includes(verifyRef) && c.cwd === REPO)).toBe(true);
    expect(calls.some((c) => c.args.join(" ") === `switch --detach ${HEAD_SHA}` && c.cwd === slotPathOf(fresh))).toBe(true);
    expect(h.log.slice(logMark)).toContain(`slots.reset:${fresh}`);
    expect(h.slots.released).toContain(old);
    // its leases are taken again on the new tree
    for (const w of t.footprint.writes) expect(h.parts().leases.holder(w)?.taskId).toBe("T1");
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(openFailures(h)).toEqual([]);
    // the new slot is journaled before row 21 commits on it (which journals the slot again with the branch)
    const ev = await h.events();
    const slotAt = ev.findIndex((e) => e.type === "task-slot" && e.taskId === "T1" && e.slot === fresh);
    const committedAt = ev.findIndex((e) => e.type === "task-transition" && e.taskId === "T1" && e.to === "verifying");
    expect(slotAt).toBeGreaterThanOrEqual(0);
    expect(slotAt).toBeLessThan(committedAt);
  });

  it("verified, marker foreign: re-provisioned from the task branch (the foreign slot is not released) and re-enqueued", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await untilEnqueued(h, "T1");
    const old = need(h.task("T1").slot, "slot of T1");
    foreignMarker(h, old);
    const mark = h.git.calls.length;
    await h.restart();
    await untilEnqueued(h, "T1");

    const t = h.task("T1");
    expect(t.state).toBe("verified");
    const fresh = need(t.slot, "new slot");
    expect(fresh).not.toBe(old);
    expect(h.slots.released).not.toContain(old);
    expect(h.git.calls.slice(mark).some((c) => c.args.join(" ") === `switch --detach ${HEAD_SHA}` && c.cwd === slotPathOf(fresh))).toBe(true);
    expect(openFailures(h)).toEqual([]);
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });

  it("QA-4.2-13: completed, marker missing, no task branch, no commit with the attempt's trailer: failed ('slot lost before commit'), counted, retried on a fresh slot", async () => {
    const h = await mk(planOf([task("T1")]));
    await completedThenCrash(h);
    const old = need(h.task("T1").slot, "slot of T1");
    dropMarker(h, old);
    noBranch(h);
    h.git.trailerCommit = "";
    const mark = h.git.calls.length;
    await h.restart();
    // T1#2 is a live child of this process: `settled()` would wait for its end, so the test stops at its launch.
    await h.runOf("T1", 2);

    const a1 = need(h.task("T1").attempts[0], "attempt 1");
    expect(a1).toMatchObject({ outcome: "succeeded", context: "slot lost before commit" });
    const ev = await h.events();
    const moved = ev.filter((e) => e.type === "task-transition" && e.taskId === "T1" && e.from === "completed" && e.to === "failed");
    expect(moved).toHaveLength(1);
    expect(JSON.stringify(moved[0])).toContain("slot lost before commit");
    // the search for this attempt's trailer ran in the repository
    expect(h.git.calls.slice(mark).some((c) => c.args[0] === "log" && c.args.includes("--all") && c.cwd === REPO)).toBe(true);
    expect(h.parts().policy.counted.map((c) => c.n)).toContain(1);
    expect(openFailures(h)).toEqual([]);
    expect(h.slots.released).toContain(old);
    expect(h.git.calls.slice(mark).some((c) => c.args[0] === "commit")).toBe(false);
    expect(h.verifier.calls).toEqual([]);
  });

  it("completed, marker missing, no task branch, but a commit carries the attempt's trailer: nothing is re-provisioned and one blocking item is raised", async () => {
    const h = await mk(planOf([task("T1")]));
    await completedThenCrash(h);
    const old = need(h.task("T1").slot, "slot of T1");
    dropMarker(h, old);
    noBranch(h);
    h.git.trailerCommit = "f".repeat(40);
    const mark = h.git.calls.length;
    const logMark = h.log.length;
    await h.restart();
    await until(() => openFailures(h).length > 0, "the blocking item");
    await h.runtime.settled();

    expect(h.state("T1")).toBe("completed");
    expect(h.task("T1").slot).toBe(old);
    expect(h.log.slice(logMark).filter((l) => l.startsWith("slots.acquire:"))).toEqual([]);
    expect(h.git.calls.slice(mark).some((c) => c.args[0] === "switch" || c.args[0] === "commit")).toBe(false);
    expect(h.verifier.calls).toEqual([]);
    const items = openFailures(h);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: "blocking", options: [] });
    expect(items[0]?.text).toContain("marker");
    expect(items[0]?.text).toContain(BRANCH);
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

// ---------------------------------------------------------------------------------------------------------------
// QA-4.2 round 1 (runtime findings)
// ---------------------------------------------------------------------------------------------------------------

/** The plan's T1 write path is held by another plan in the shared registry (a failed lease rebuild, QA-4.2-16). */
function foreignLease(h: Harness): RegistryDouble {
  const reg = h.deps.leaseRegistry;
  if (!(reg instanceof RegistryDouble)) throw new Error("registry double expected");
  reg.held.set("src/T1.ts", { holderID: "omr:other-plan:T9", taskRef: "other-plan:T9" });
  return reg;
}

describe("QA-4.2-3: the integration queue is disposed with its attachment", () => {
  it("a same-process adopt disposes the old queue before the new one resumes; the old one gets nothing after", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const oldQueue = h.parts().queue;
    h.hosts.activityValue = "active";
    h.engine();
    await h.runtime.adopt(PLAN_ID, "ses-new");
    await until(() => h.ledger().orchestrator.sessionID === "ses-new", "the new orchestrator");
    expect(oldQueue.disposed).toBe(1);
    expect(h.parts().queue).not.toBe(oldQueue);
    expect(h.parts().queue.disposed).toBe(0);
    expect(h.log.indexOf("queue.dispose")).toBeLessThan(h.log.lastIndexOf("queue.resume:1"));

    run.complete("Done. Implemented it.");
    await untilEnqueued(h, "T1");
    expect(oldQueue.enqueued).toEqual([]);
    expect(h.log.filter((l) => l.startsWith("queue.enqueue-after-dispose"))).toEqual([]);
  });

  it("dispose disposes the queue of every attached plan (its lanes and repo lock go)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const q = h.parts().queue;
    // `settled()` waits for live children too (their completion is tracked), so it is never called while T1 runs; the
    // child is created first so its launch confirmation settled (dispose waits for every non-child wait).
    await h.running("T1", 1, "ses-c1");
    await h.runtime.dispose();
    expect(q.disposed).toBe(1);
    expect(h.log.filter((l) => l === "queue.dispose")).toHaveLength(1);
  });
});

describe("QA-4.2-4: a child that ends inside a same-process adopt's window", () => {
  it("waits for the new attachment: the end is processed once, through the live writer, never stranded", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    h.hosts.activityValue = "active";
    const e = h.engine();
    // The window: the old attachment is closed (writer too) and recovery.adopt has not returned yet.
    const inWindow = deferred<void>();
    const gate = deferred<void>();
    const adopt0 = e.adopt.bind(e);
    e.adopt = async (planId, sessionID) => {
      inWindow.resolve();
      await gate.promise;
      await adopt0(planId, sessionID);
    };
    const adopting = h.runtime.adopt(PLAN_ID, "ses-new");
    await inWindow.promise;
    run.complete("Done. Implemented it.");
    await pause(30);
    gate.resolve();
    await adopting;
    await untilEnqueued(h, "T1");
    await h.runtime.settled();

    expect(h.ledger().orchestrator.sessionID).toBe("ses-new");
    expect(endsOf(await h.events(), "T1")).toHaveLength(1);
    expect(h.verifier.calls).toEqual(["T1#1"]);
    expect(h.logs.filter((l) => /child end processing failed|E_DISPOSED/.test(l))).toEqual([]);
  });
});

describe("QA-4.2-6: a rejected queue.resume()", () => {
  function awaitingApproval(): LedgerV1 {
    const d = planOf([task("T1")]);
    d.status = "awaiting-approval";
    return d;
  }

  it("pauses the plan with one critical item and launches nothing; the user's resume retries it", async () => {
    const h = await mk(awaitingApproval());
    h.queueCfg.reject = true;
    await h.begin();
    await h.runtime.approve(PLAN_ID, ORCH);
    await h.runtime.settled();
    expect(h.ledger().status).toBe("paused");
    const critical = h.ledger().inbox.filter((i) => i.answer === null && i.severity === "critical");
    expect(critical).toHaveLength(1);
    expect(critical[0]?.text).toContain("could not resume");
    expect(h.launcher.runs).toEqual([]);

    h.queueCfg.reject = false;
    await h.runtime.resume(PLAN_ID, ORCH);
    expect(h.parts().queue.resumes).toBe(2);
    await h.runOf("T1", 1);
  });

  it("a running plan whose integration resume failed is resumed again by the user's resume (no E_PLAN_STATE)", async () => {
    const h = await mk(awaitingApproval());
    h.queueCfg.reject = true;
    await h.begin();
    await h.runtime.approve(PLAN_ID, ORCH);
    await h.runtime.settled();
    // The plan runs again by another path while the queue is still not resumed.
    await h.parts().writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "test" }]);
    h.queueCfg.reject = false;
    await h.runtime.resume(PLAN_ID, ORCH);
    expect(h.parts().queue.resumes).toBe(2);
    expect(h.ledger().status).toBe("running");
    await h.runOf("T1", 1);
    // Once it resumed, a resume of the running plan is refused as before.
    await expect(h.runtime.resume(PLAN_ID, ORCH)).rejects.toThrow(/is running/);
  });
});

describe("QA-4.2-7: adopt never takes a plan awaiting residue or approval", () => {
  it("refuses a plan awaiting approval with E_PLAN_STATE before recovery runs, and writes nothing", async () => {
    const d = planOf([task("T1")]);
    d.status = "awaiting-approval";
    const h = await mk(d);
    await h.begin();
    const e = h.engine();
    const adopted: string[] = [];
    const adopt0 = e.adopt.bind(e);
    e.adopt = async (planId, sessionID) => {
      adopted.push(sessionID);
      await adopt0(planId, sessionID);
    };
    const before = (await h.events()).length;
    await expect(h.runtime.adopt(PLAN_ID, "ses-new")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(h.runtime.adopt(PLAN_ID, "ses-new")).rejects.toThrow(/never adopted/);
    expect(adopted).toEqual([]);
    expect(h.ledger().orchestrator.sessionID).toBe(ORCH);
    expect(h.ledger().status).toBe("awaiting-approval");
    expect((await h.events()).length).toBe(before);
    // the plan stays its session's to approve
    await h.runtime.approve(PLAN_ID, ORCH);
    await h.runOf("T1", 1);
  });
});

describe("QA-4.2-14: the breaker at activation reads only failures it has not evaluated", () => {
  it("a failure fed live while the phase was paused is not fed again at a restart after the unpause", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const phaseId = need(h.task("T1").phase, "phase of T1");
    await h.parts().writer.append([{ type: "phase-paused", phaseId, paused: true, reason: "breaker" }]);
    // Row 16 while the phase is paused: fed live (B4: it cannot trip a paused phase), retried, not relaunched (paused).
    // (The first version of this test journaled the failure directly, i.e. a feed missed by a crash: B5 feeds that one.)
    run.end({ kind: "failed", childSessionID: "ses-c1", error: { type: "execution.failed", status: null, message: "boom" }, endedAt: h.clock.iso() });
    const livePolicy = h.parts().policy;
    await until(
      () => livePolicy.counted.length === 1 && h.state("T1") === "ready",
      "the live feed of T1#1",
      () => ({ counted: livePolicy.counted, state: h.state("T1") }),
    );
    h.launcher.gateValue = DISPOSED_GATE; // nothing relaunches in this process once the phase runs again
    await h.parts().writer.append([{ type: "phase-paused", phaseId, paused: false, reason: "answered" }]);
    await h.restart();
    // The relaunch comes after the activation (breakers at step 8, the first tick last); T1#2 stays live, so no `settled()`.
    await h.runOf("T1", 2);
    const pol = h.parts().policy;
    const evidence = JSON.stringify({
      counted: pol.counted,
      sites: pol.sites,
      logs: h.logs.filter((l) => /breaker|journal|recordAttempt|capacity restore/.test(l)),
      journal: (await h.events())
        .filter((e) => e.type === "phase-paused" || e.type === "attempt-ended" || (e.type === "metric" && e.metric.name === "counter" && e.metric.key === "breaker-fed"))
        .map((e) => `${e.seq}:${e.type}${e.type === "phase-paused" ? `:${String(e.paused)}` : ""}${e.type === "metric" ? `:${JSON.stringify(e.metric)}` : ""}`),
    });
    expect(pol.counted, evidence).toEqual([]);
  });

  it("a failure whose live feed a crash missed is fed once at the next activation, never again at a later one", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    // Row 16 landed, the process died before `recordAttempt` (no breaker-fed marker).
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "failed", endedAt: h.clock.iso(), detail: "boom" },
      { type: "attempt-context", taskId: "T1", n: 1, context: "boom" },
      tr("T1", "running", "failed", "child-failed", "boom"),
    ]);
    await h.restart();
    expect(h.parts().policy.counted).toEqual([expect.objectContaining({ taskId: "T1", n: 1, outcome: "failed" })]);
    // T1#2 gets a child so the next crash's dispose has no unconfirmed launch to wait for.
    await h.running("T1", 2, "ses-c2");
    await h.restart();
    const pol = h.parts().policy;
    expect(pol.counted, JSON.stringify({ counted: pol.counted, sites: pol.sites })).toEqual([]);
  });
});

describe("QA-4.2-15: the probation interrupt's own end", () => {
  it("is not a proof of life nor an unrequested interrupt: lost 'restart', slot reset, no streak", async () => {
    const h = await onProbation();
    h.hosts.interruptImpl = async (sid) => {
      h.hosts.emit({ type: "execution.interrupted", sessionID: sid, at: h.clock.iso() });
    };
    const mark = h.git.calls.length;
    // `advance` settles after each step, which waits for live children: the step at the deadline relaunches T1, so it is
    // taken by the clock alone (as in the deadline test above).
    await advance(h, LIVENESS_MS - POLL_MS);
    expect(h.hosts.interrupts).toEqual([]);
    h.clock.advance(POLL_MS);
    await h.runOf("T1", 2);
    const ends = endsOf(await h.events(), "T1");
    expect(ends).toHaveLength(1);
    expect(JSON.stringify(ends[0])).toContain('"restart"');
    expect(JSON.stringify(ends[0])).not.toContain("unrequested-interrupt");
    expect(h.hosts.interrupts).toEqual(["ses-c1"]);
    expect(h.git.verbsSince(mark)).toContain("reset --hard HEAD");
    expect(h.parts().policy.counted).toEqual([]);
  });
});

describe("QA-4.2-16: a failed lease rebuild holds the task until its leases are back", () => {
  it("a live child of a task without its leases is interrupted and requeued, not adopted; the relaunch waits for the lease", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    const reg = foreignLease(h);
    h.hosts.activityValue = "active";
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();

    expect(h.parts().policy.raised.filter((i) => i.text.includes("could not re-take the leases of T1"))).toHaveLength(1);
    expect(h.hosts.interrupts).toEqual(["ses-c1"]);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
    expect(JSON.stringify(endsOf(await h.events(), "T1")[0])).toContain('"restart"');
    expect(h.state("T1")).toBe("ready");
    expect(h.launcher.runs).toEqual([]);

    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await h.runOf("T1", 2);
  });

  it("a verified task without its leases is not enqueued until a lease release lets the rebuild retry succeed", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await untilEnqueued(h, "T1");
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("verified");
    expect(h.parts().queue.enqueued).toEqual([]);

    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await until(() => h.parts().queue.enqueued.some((ids) => ids.includes("T1")), "T1 enqueued once its leases are back");
    expect(h.parts().leases.holder("src/T1.ts")?.taskId).toBe("T1");
  });
});

describe("QA-4.2-17: a plan of another toplevel that start() can open", () => {
  it("is attached passively: no reconcile, no integration resume, no tick, and resume never promotes it", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.hosts.activityValue = "inactive"; // a reconcile would requeue T1
    h.engine("C:/elsewhere");
    const logMark = h.log.length;
    await h.runtime.start();
    await h.runtime.settled();

    expect(h.state("T1")).toBe("running");
    expect(h.hosts.interrupts).toEqual([]);
    expect(h.log.slice(logMark).filter((l) => l.startsWith("queue.resume"))).toEqual([]);
    expect(h.launcher.runs).toEqual([]);
    expect(endsOf(await h.events(), "T1")).toHaveLength(0);
    await expect(h.runtime.resume(PLAN_ID, ORCH)).rejects.toThrow(/another repository/);
  });
});

describe("QA-4.2-18: an adopted child is bound again", () => {
  it("recovery re-binds it through the launcher's binding port with its task's role, grant and work root", async () => {
    const h = await mk(planOf([task("T1")]));
    const binds = h.bindings.binds;
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    h.hosts.activityValue = "active";
    await h.restart();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("running");
    expect(h.bindings.evicted).toEqual([]);
    expect(binds).toEqual([
      expect.objectContaining({
        planId: PLAN_ID,
        taskId: "T1",
        attempt: 1,
        childSessionID: "ses-c1",
        role: "implementer",
        agent: "implementer",
        workRoot: run.req.workRoot,
        grant: run.req.grant,
      }),
    ]);

    // QA-4.2-23: the re-bound child's binding is evicted once its attempt closes.
    h.hosts.say("ses-c1", { role: "assistant", text: "Done. Implemented it.", outcome: null });
    h.hosts.emit({ type: "execution.completed", sessionID: "ses-c1", at: h.clock.iso() });
    await untilEnqueued(h, "T1");
    await h.runtime.settled();
    expect(h.bindings.evicted).toEqual(["ses-c1"]);
  });
});

describe("nit: one reconcile per plan at start", () => {
  it("recoverPlan reuses the recover() report instead of reconciling the ledger a second time", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.hosts.activityValue = "active";
    const e = h.engine();
    const st = { inRecover: false, outside: 0 };
    const recover0 = e.recover.bind(e);
    const reconcile0 = e.reconcile.bind(e);
    e.recover = async () => {
      st.inRecover = true;
      try {
        return await recover0();
      } finally {
        st.inRecover = false;
      }
    };
    e.reconcile = async (l, tracked) => {
      if (!st.inRecover) st.outside += 1;
      return reconcile0(l, tracked);
    };
    await h.runtime.start();
    await h.runtime.settled();
    expect(st.outside).toBe(0);
    expect(h.state("T1")).toBe("running");
  });
});

describe("nit: a refused row 7", () => {
  it("interrupts the live child as an orphan instead of leaving it running while the task relaunches", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.launcher.gateValue = DISPOSED_GATE; // no relaunch in this process
    // Row 18 (lost): ready, latest attempt lost, slot kept, child recorded; the child itself still runs.
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "lost", endedAt: h.clock.iso(), detail: "runner-error" },
      tr("T1", "running", "ready", "child-lost", "runner-error"),
    ]);
    await h.crash();
    h.hosts.activityValue = "active";
    const e = h.engine();
    const recover0 = e.recover.bind(e);
    e.recover = async () => {
      const r = await recover0();
      // Between the report (adopt: row 7) and the activation the task loses its slot, so row 7 is refused.
      const w = await h.store.open(PLAN_ID, h.deps.holder(ORCH));
      await w.append([{ type: "task-slot", taskId: "T1", slot: null, branch: null }]);
      await w.close();
      return r;
    };
    await h.runtime.start();
    // T1#2 is live: no `settled()` (it would wait for the child's end).
    await h.runOf("T1", 2);
    expect(h.hosts.interrupts).toContain("ses-c1");
    expect((await h.events()).some((x) => x.type === "attempt-adopted")).toBe(false);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
  });
});

describe("QA-4.2-8: a commit failure is fed to the breaker after its batch", () => {
  /** Records T1's state each time the attachment's policy is fed an attempt. */
  function feedStates(h: Harness): TaskState[] {
    const pol = h.parts().policy;
    const states: TaskState[] = [];
    const record0 = pol.recordAttempt.bind(pol);
    pol.recordAttempt = async (phaseId, a) => {
      states.push(h.state("T1"));
      return record0(phaseId, a);
    };
    return states;
  }

  it("'no changes' (completed -> failed, commit-failed) calls recordAttempt with the attempt once the batch landed", async () => {
    const h = await mk(planOf([task("T1", { verify: "required" })]));
    await h.begin();
    const states = feedStates(h);
    h.git.dirty = () => false;
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded", context: "no changes" });
    expect(h.parts().policy.counted).toEqual([expect.objectContaining({ taskId: "T1", n: 1, outcome: "succeeded" })]);
    expect(states).toEqual(["failed"]);
    const ev = await h.events();
    expect(ev.some((e) => e.type === "task-transition" && e.taskId === "T1" && e.trigger === "commit-failed")).toBe(true);
  });

  it("a failing git commit (completed -> failed, commit-failed) calls recordAttempt once the batch landed", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const states = feedStates(h);
    const run0 = h.git.run.bind(h.git);
    h.git.run = async (args, o) => {
      if (args[0] !== "commit") return run0(args, o);
      h.git.calls.push({ args: [...args], cwd: o.cwd });
      return { code: 1, signal: null, stdout: "", stderr: "fatal: unable to write new index file", truncated: false, durationMs: 0 };
    };
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]?.context).toContain("git commit failed");
    expect(h.parts().policy.counted).toEqual([expect.objectContaining({ taskId: "T1", n: 1, outcome: "succeeded" })]);
    expect(states).toEqual(["failed"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// QA-4.2 round 2 (runtime findings)
// ---------------------------------------------------------------------------------------------------------------

/** The slot `name` vanished from the pool (no marker: R2 sees it invalid). */
function dropSlotMarker(h: Harness, name: string): void {
  for (const [owner, l] of [...h.slots.byOwner]) if (l.slot === name) h.slots.byOwner.delete(owner);
}

/** `git log --all --grep=<trailer>` fails (git cannot tell whether the attempt committed). */
function trailerSearchFails(h: Harness): void {
  const run0 = h.git.run.bind(h.git);
  h.git.run = async (args, o) => {
    if (args[0] !== "log" || !args.includes("--all")) return run0(args, o);
    h.git.calls.push({ args: [...args], cwd: o.cwd });
    return { code: 128, signal: null, stdout: "", stderr: "fatal: bad object", truncated: false, durationMs: 0 };
  };
}

/** The breaker-fed markers in the journal, as `<taskId>#<n>`. */
async function fedMarkers(h: Harness): Promise<string[]> {
  const out: string[] = [];
  for (const e of await h.events()) {
    if (e.type === "metric" && e.metric.name === "counter" && e.metric.key === "breaker-fed") out.push(`${e.metric.labels["taskId"] ?? "?"}#${e.metric.labels["n"] ?? "?"}`);
  }
  return out;
}

describe("QA-4.2-20: R2 of a completed attempt n > 1 whose task branch holds an earlier attempt's commit", () => {
  it("checks this attempt's trailer first: none -> failed 'slot lost before commit' and retried, never re-provisioned from the old tip", async () => {
    const plan = planOf([task("T1")]);
    plan.config = { ...plan.config, maxAttempts: 5 };
    const h = await mk(plan);
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    // Attempt 1 failed after its commit landed on the task branch (the branch tip is attempt 1's), then retried.
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "failed", endedAt: h.clock.iso(), detail: "boom" },
      tr("T1", "running", "failed", "child-failed", "boom"),
      tr("T1", "failed", "ready", "retry"),
    ]);
    h.runtime.onRouterToolCall(ORCH);
    await h.running("T1", 2, "ses-c2");
    // Attempt 2 completed (row 15), the process died before its commit; then its slot lost the marker.
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 2, outcome: "succeeded", endedAt: h.clock.iso(), detail: null },
      tr("T1", "running", "completed", "child-ended"),
    ]);
    dropSlotMarker(h, need(h.task("T1").slot, "slot of T1"));
    h.git.dirty = () => false; // a slot re-provisioned at the branch tip would be clean: "no changes"
    h.git.trailerCommit = ""; // no commit carries attempt 2's trailer
    const mark = h.git.calls.length;
    await h.restart();
    await h.runOf("T1", 3);
    expect(h.task("T1").attempts[1]).toMatchObject({ n: 2, outcome: "succeeded", context: "slot lost before commit" });
    expect(h.git.calls.slice(mark).some((c) => c.args[0] === "switch")).toBe(false);
    const ev = await h.events();
    expect(ev.some((e) => e.type === "task-transition" && e.taskId === "T1" && e.to === "done")).toBe(false);
    expect(ev.filter((e) => e.type === "task-transition" && e.taskId === "T1" && e.from === "completed" && e.to === "failed")).toHaveLength(1);
  });

  it("git cannot tell whether the attempt committed: one blocking item, nothing moves or is re-provisioned", async () => {
    const h = await mk(planOf([task("T1")]));
    await completedThenCrash(h);
    const old = need(h.task("T1").slot, "slot of T1");
    dropSlotMarker(h, old);
    trailerSearchFails(h);
    const mark = h.git.calls.length;
    await h.restart();
    await until(() => h.ledger().inbox.some((i) => i.taskId === "T1" && i.answer === null), "the blocking item");
    expect(h.state("T1")).toBe("completed");
    expect(h.task("T1").slot).toBe(old);
    expect(h.git.calls.slice(mark).some((c) => c.args[0] === "switch" || c.args[0] === "commit")).toBe(false);
  });
});

describe("QA-4.2-21: foreignness is the plan's own toplevel", () => {
  it("a same-repo plan the recover() report missed (a transient error) attaches actively and is reconciled", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.hosts.activityValue = "inactive"; // reconciled: lost -> requeued -> relaunched
    const e = h.engine();
    e.recover = async () => [];
    await h.runtime.start();
    await h.runOf("T1", 2);
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "lost" });
    expect(await h.runtime.status(PLAN_ID, ORCH)).not.toContain("Foreign:");
  });

  it("an action on a plan of another repository attaches a read-only snapshot and refuses mutation (no writer, resume or tick)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.deps.toplevel = "C:/elsewhere";
    const logMark = h.log.length;
    const before = await h.store.exportPlan(PLAN_ID), open = vi.spyOn(h.store, "open");
    await expect(h.runtime.pause(PLAN_ID, ORCH)).rejects.toThrow(/another repository.*read-only/);
    await h.runtime.settled();
    expect(h.log.slice(logMark).filter((l) => l.startsWith("queue.resume"))).toEqual([]);
    expect(h.launcher.runs).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(h.ledger().status).toBe("running");
    expect(await h.store.exportPlan(PLAN_ID)).toEqual(before);
    expect(await h.runtime.status(PLAN_ID, ORCH)).toContain("Foreign:");
  });

  it("adopt refuses a plan of another repository before closing its passive attachment", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.engine("C:/elsewhere");
    await h.runtime.start();
    const logMark = h.log.length;
    await expect(h.runtime.adopt(PLAN_ID, "ses-new")).rejects.toThrow(/another repository/);
    expect(h.log.slice(logMark)).not.toContain("queue.dispose");
    expect(await h.runtime.status(PLAN_ID, ORCH)).toContain("Foreign:");
    expect(h.ledger().orchestrator.sessionID).toBe(ORCH);
  });
});

describe("QA-4.2-22: a commit failure carries the breaker-fed marker", () => {
  it("'no changes' journals breaker-fed for the attempt, so a restart never feeds it again", async () => {
    const h = await mk(planOf([task("T1", { verify: "required" })]));
    await h.begin();
    h.git.dirty = () => false;
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await h.running("T1", 2, "ses-c2");
    await until(async () => (await fedMarkers(h)).includes("T1#1"), "the breaker-fed marker of T1#1");
    await h.restart();
    const pol = h.parts().policy;
    expect(pol.counted, JSON.stringify({ counted: pol.counted, sites: pol.sites })).toEqual([]);
  });
});

describe("QA-4.2-24: a real completion that races the probation interrupt", () => {
  it("is processed as completed (no slot reset, no lost end, no relaunch)", async () => {
    const h = await onProbation();
    h.hosts.interruptImpl = async (sid) => {
      h.hosts.say(sid, { role: "assistant", text: "Done. Implemented it.", outcome: null });
      h.hosts.emit({ type: "execution.completed", sessionID: sid, at: h.clock.iso() });
    };
    const mark = h.git.calls.length;
    await advance(h, LIVENESS_MS - POLL_MS);
    h.clock.advance(POLL_MS);
    await untilEnqueued(h, "T1");
    await h.runtime.settled();
    expect(h.task("T1").attempts[0]).toMatchObject({ outcome: "succeeded" });
    expect(endsOf(await h.events(), "T1")).toHaveLength(1);
    expect(h.git.verbsSince(mark)).not.toContain("reset --hard HEAD");
    expect(h.launcher.runs).toEqual([]);
  });
});

describe("QA-4.2-25: an adopt that fails after the old attachment closed", () => {
  it("attaches the plan again under its orchestrator; a child ending meanwhile is processed once", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    const e = h.engine();
    e.adopt = async () => {
      throw new ExecutorError("E_LOCK_HELD", "held by a live process");
    };
    await expect(h.runtime.adopt(PLAN_ID, "ses-new")).rejects.toMatchObject({ code: "E_LOCK_HELD" });
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);
    expect(h.ledger().orchestrator.sessionID).toBe(ORCH);
    run.complete("Done. Implemented it.");
    await untilEnqueued(h, "T1");
    await h.runtime.settled();
    expect(endsOf(await h.events(), "T1")).toHaveLength(1);
    expect(h.logs.filter((l) => /child end processing failed/.test(l))).toEqual([]);
  });
});

describe("QA-4.2-26: a held task never waits on a vanished slot", () => {
  it("the lease item says the task is held and what ends it; a held verified task whose slot record vanished is re-provisioned (R2) and enqueued", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await untilEnqueued(h, "T1");
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    const item = need(h.parts().policy.raised.find((i) => i.text.includes("could not re-take the leases of T1")), "the lease item");
    expect(item.text).toContain("T1 is held");
    expect(item.text).toContain("released");
    const old = need(h.task("T1").slot, "slot of T1");
    h.slots.records.delete(old);
    dropSlotMarker(h, old);
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await until(
      () => h.parts().queue.enqueued.some((ids) => ids.includes("T1")),
      "T1 re-provisioned and enqueued",
      () => ({ slot: h.task("T1").slot, raised: h.parts().policy.raised.map((i) => i.text), logs: h.logs }),
    );
    expect(h.task("T1").slot).not.toBe(old);
    expect(h.state("T1")).toBe("verified");
  });
});

describe("QA-4.2-28: an idle entry without an outcome is not an end", () => {
  it("the probation poll does not process it (the context change proves the child alive instead)", async () => {
    const h = await onProbation();
    h.hosts.say("ses-c1", { role: "idle", text: null, outcome: null });
    await advance(h, POLL_MS);
    expect(h.state("T1")).toBe("running");
    expect(endsOf(await h.events(), "T1")).toHaveLength(0);
    expect(h.verifier.calls).toEqual([]);
  });
});

describe("QA-4.2 round 2: reachable arms (held tasks)", () => {
  it("a held completed task commits and verifies once its leases are back (resumeHeldTask, completed)", async () => {
    const h = await mk(planOf([task("T1")]));
    await completedThenCrash(h);
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("completed");
    expect(h.git.calls.some((c) => c.args[0] === "commit")).toBe(false);
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await untilEnqueued(h, "T1");
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });

  it("a held verifying task is verified once its leases are back (resumeHeldTask, verifying)", async () => {
    const h = await mk(planOf([task("T1")]));
    await completedThenCrash(h);
    // Row 21 landed (the commit's batch), the process died before the verdict.
    const slot = need(h.task("T1").slot, "slot of T1");
    await h.parts().writer.append([
      { type: "task-slot", taskId: "T1", slot, branch: taskBranchName(PLAN_ID, "T1") },
      tr("T1", "completed", "verifying", "committed"),
    ]);
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("verifying");
    expect(h.verifier.calls).toEqual([]);
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await untilEnqueued(h, "T1");
    expect(h.verifier.calls).toEqual(["T1#1"]);
  });

  it("an interrupt of a held task's child that fails adopts it after all, still held: its end commits only once the leases are back", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    const reg = foreignLease(h);
    h.hosts.activityValue = "active";
    h.hosts.interruptImpl = async () => {
      throw new Error("server unreachable");
    };
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.hosts.interrupts).toEqual(["ses-c1"]);
    expect(h.state("T1")).toBe("running");
    expect(endsOf(await h.events(), "T1")).toHaveLength(0);
    h.hosts.say("ses-c1", { role: "assistant", text: "Done. Implemented it.", outcome: null });
    h.hosts.emit({ type: "execution.completed", sessionID: "ses-c1", at: h.clock.iso() });
    await until(() => h.state("T1") === "completed", "T1 completed");
    await h.runtime.settled();
    expect(h.git.calls.some((c) => c.args[0] === "commit")).toBe(false);
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await untilEnqueued(h, "T1");
  });

  it("a held ready task (latest lost) does not adopt its live child: interrupted, slot reset, relaunched once the lease is free", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.launcher.gateValue = DISPOSED_GATE;
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "lost", endedAt: h.clock.iso(), detail: "runner-error" },
      tr("T1", "running", "ready", "child-lost", "runner-error"),
    ]);
    await h.crash();
    const reg = foreignLease(h);
    h.hosts.activityValue = "active";
    h.engine();
    const mark = h.git.calls.length;
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.hosts.interrupts).toContain("ses-c1");
    expect((await h.events()).some((x) => x.type === "attempt-adopted")).toBe(false);
    expect(h.git.verbsSince(mark)).toContain("reset --hard HEAD");
    expect(h.state("T1")).toBe("ready");
    expect(h.launcher.runs).toEqual([]);
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await h.runOf("T1", 2);
  });

  it("a held ready task without a live child leaves the hold at the first retry (not a held state) and relaunches once the lease is free", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.launcher.gateValue = DISPOSED_GATE;
    await h.parts().writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "lost", endedAt: h.clock.iso(), detail: "runner-error" },
      tr("T1", "running", "ready", "child-lost", "runner-error"),
    ]);
    await h.crash();
    const reg = foreignLease(h);
    h.hosts.activityValue = "inactive"; // the child is gone: nothing to adopt, the scheduler relaunches
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.state("T1")).toBe("ready");
    expect(h.launcher.runs).toEqual([]);
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await h.runOf("T1", 2);
    expect((await h.events()).some((x) => x.type === "attempt-adopted")).toBe(false);
  });

  it("a throwing lease rebuild retry is logged, the task stays held and the next retry succeeds", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-c1");
    run.complete("Done.");
    await untilEnqueued(h, "T1");
    await h.crash();
    const reg = foreignLease(h);
    h.engine();
    await h.runtime.start();
    await h.runtime.settled();
    const acquire0 = reg.acquireWrite.bind(reg);
    reg.acquireWrite = () => {
      throw new Error("registry down");
    };
    h.runtime.onLeaseReleased();
    await until(() => h.logs.some((l) => l.includes("lease rebuild retry failed")), "the logged rebuild failure");
    expect(h.parts().queue.enqueued).toEqual([]);
    reg.acquireWrite = acquire0;
    reg.held.delete("src/T1.ts");
    h.runtime.onLeaseReleased();
    await until(() => h.parts().queue.enqueued.some((ids) => ids.includes("T1")), "T1 enqueued");
  });
});

describe("QA-4.2 round 2: reachable arms (close, resume, breaker, adopt, start)", () => {
  it("disposeQueue: a throwing queue dispose is logged and the plan still closes", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.parts().queue.dispose = async () => {
      throw new Error("lanes stuck");
    };
    await h.runtime.dispose();
    expect(h.logs.some((l) => l.includes("integration queue dispose failed") && l.includes("lanes stuck"))).toBe(true);
  });

  it("disposeQueue: a queue that never disposes is abandoned after QUEUE_DISPOSE_MS on the injected clock", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    h.parts().queue.disposeGate = new Promise<void>(() => undefined);
    const disposing = h.runtime.dispose();
    await until(() => h.log.includes("queue.dispose"), "the queue dispose call");
    h.clock.advance(10_000);
    await disposing;
    expect(h.logs.some((l) => l.includes("did not dispose in 10000 ms"))).toBe(true);
  });

  it("a rejected queue.resume() on an already-paused plan raises the critical item (the plan stays paused)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.runtime.pause(PLAN_ID, ORCH);
    h.queueCfg.reject = true;
    await h.restart();
    expect(h.ledger().status).toBe("paused");
    expect(h.ledger().inbox.filter((i) => i.answer === null && i.severity === "critical" && i.text.includes("could not resume"))).toHaveLength(1);
  });

  it("the breaker step feeds nothing when the history export fails, nor when every phase is paused", async () => {
    for (const variant of ["export-fails", "all-paused"] as const) {
      const h = await mk(planOf([task("T1")]));
      await h.begin();
      await h.running("T1", 1, "ses-c1");
      if (variant === "all-paused") {
        const phaseId = need(h.task("T1").phase, "phase of T1");
        await h.parts().writer.append([{ type: "phase-paused", phaseId, paused: true, reason: "breaker" }]);
      }
      // Row 16 landed, the process died before `recordAttempt` (B5 would feed it at the next activation).
      await h.parts().writer.append([
        { type: "attempt-ended", taskId: "T1", n: 1, outcome: "failed", endedAt: h.clock.iso(), detail: "boom" },
        { type: "attempt-context", taskId: "T1", n: 1, context: "boom" },
        tr("T1", "running", "failed", "child-failed", "boom"),
      ]);
      const export0 = h.store.exportPlan.bind(h.store);
      if (variant === "export-fails") {
        h.store.exportPlan = async () => {
          throw new Error("journal unreadable");
        };
      }
      await h.restart();
      h.store.exportPlan = export0;
      expect(h.parts().policy.counted, variant).toEqual([]);
      if (variant === "export-fails") expect(h.logs.some((l) => l.includes("breaker journal read failed"))).toBe(true);
    }
  });

  it("adopt: an unreadable ledger is left to recovery (logged), and a plan awaiting residue is refused", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.engine();
    const read0 = h.store.read.bind(h.store);
    h.store.read = async (id) => ({ ...(await read0(id)), status: "awaiting-residue" as const });
    await expect(h.runtime.adopt(PLAN_ID, "ses-new")).rejects.toThrow(/never adopted/);
    const st = { fail: true };
    h.store.read = async (id) => {
      if (st.fail) {
        st.fail = false;
        throw new Error("disk busy");
      }
      return read0(id);
    };
    await h.runtime.adopt(PLAN_ID, "ses-new");
    h.store.read = read0;
    expect(h.logs.some((l) => l.includes("not readable before recovery"))).toBe(true);
    expect(h.runtime.planLine("ses-new")).toContain(`plan ${PLAN_ID}:`);
  });

  it("start: a recover() report without full feeds is not reused (the runtime reconciles), nor is one from a service without reconcile", async () => {
    const strip = (a: ReconcileAction): ReconcileAction => {
      if (!("orphans" in a)) return a;
      const { orphans, ...rest } = a;
      void orphans;
      return rest;
    };
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    await h.running("T1", 1, "ses-c1");
    await h.crash();
    h.hosts.activityValue = "active";
    const e = h.engine();
    const recover0 = e.recover.bind(e);
    const reconcile0 = e.reconcile.bind(e);
    const calls = { reconcile: 0 };
    e.recover = async () => (await recover0()).map((r) => ({ planId: r.planId, actions: r.actions.map(strip) }));
    e.reconcile = async (l, tracked) => {
      calls.reconcile += 1;
      return reconcile0(l, tracked);
    };
    await h.runtime.start();
    await h.runtime.settled();
    expect(calls.reconcile).toBe(1);
    expect(h.state("T1")).toBe("running");

    await h.crash();
    h.deps.recovery = {
      recover: async () => [{ planId: PLAN_ID, actions: [] }],
      adopt: async () => undefined,
    };
    await h.runtime.start();
    await h.runtime.settled();
    expect(h.runtime.planLine(ORCH)).toContain(`plan ${PLAN_ID}:`);
    expect(h.state("T1")).toBe("running");
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
