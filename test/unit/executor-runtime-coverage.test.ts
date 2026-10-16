// Coverage tests for src/executor/runtime.ts (phase 4.2 branches: unattended policy, QA loop, recovery).
// The harness is a minimal copy of the one in executor-runtime.test.ts (that file exports nothing): real LedgerStore in
// a temp dir, the real Scheduler, CapacityController and expand; typed doubles for every other seam. All time comes
// from TestClock; `until` only yields to the event loop while the real ledger files are written. Handles of the
// launcher double stay pending until a test settles them, so tests poll `until(...)` instead of runtime.settled()
// while a child is alive.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapacityController } from "../../src/executor/capacity.js";
import { createLedgerStore } from "../../src/executor/ledger.js";
import {
  commitTaskInSlot,
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

vi.setConfig({ testTimeout: 30_000 });

const SHA = "c".repeat(40);
const SHA2 = "d".repeat(40);
const SLOT_ROOT = "C:/omr-rt";
const ORCH = "ses-0";
const PROVIDER = "prov";
const REPO = "C:/repo";

// ---------------------------------------------------------------------------------------------------------------
// Clock and small helpers (copied from executor-runtime.test.ts)
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

// ---------------------------------------------------------------------------------------------------------------
// Doubles (copied from executor-runtime.test.ts, with a few knobs for the arms these tests reach)
// ---------------------------------------------------------------------------------------------------------------

class SlotPoolDouble implements SlotPool {
  readonly byOwner = new Map<string, SlotLease>();
  readonly records = new Map<string, SlotRecord>();
  readonly released: string[] = [];
  readonly resets: Array<{ slot: string; commit: string }> = [];
  /** When set, `reset` throws it (every call). */
  resetFailure: Error | null = null;
  /** When set, `release` throws it (every call). */
  releaseFailure: Error | null = null;
  /** When set, `cleanForChecks` throws it (every call). */
  cleanFailure: Error | null = null;
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
  async reset(slot: string, commit: string): Promise<void> {
    this.resets.push({ slot, commit });
    this.log.push(`slots.reset:${slot}`);
    if (this.resetFailure !== null) throw this.resetFailure;
  }
  async noteCommit(): Promise<void> {}
  async cleanForChecks(slot: string): Promise<{ drifted: boolean }> {
    this.log.push(`slots.cleanForChecks:${slot}`);
    if (this.cleanFailure !== null) throw this.cleanFailure;
    return { drifted: false };
  }
  async release(slot: string): Promise<void> {
    this.log.push(`slots.release:${slot}`);
    if (this.releaseFailure !== null) throw this.releaseFailure;
    this.released.push(slot);
    for (const [owner, l] of this.byOwner) if (l.slot === slot) this.byOwner.delete(owner);
    const rec = this.records.get(slot);
    if (rec?.state === "leased") this.records.set(slot, { ...rec, state: "ready", owner: null });
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
  readonly checked: string[] = [];
  aborted = 0;
  disposed = 0;
  /** When set, `enqueue` throws it (every call). */
  enqueueFailure: Error | null = null;
  /** When set, `checkPhase` rejects with it. */
  checkFailure: Error | null = null;
  /** When set, `abort` rejects with it. */
  abortFailure: Error | null = null;
  constructor(
    private readonly log: CallLog,
    private readonly snap: Snap,
  ) {}
  enqueue(ids: readonly TaskId[]): void {
    this.log.push(`queue.enqueue:${ids.join(",")}`);
    if (this.enqueueFailure !== null) throw this.enqueueFailure;
    this.enqueued.push([...ids]);
  }
  async resume(): Promise<ResumeReport> {
    return { completed: [], rolledBack: [], halted: false, entries: [] };
  }
  async checkPhase(phaseId: string): Promise<void> {
    this.checked.push(phaseId);
    if (this.checkFailure !== null) throw this.checkFailure;
  }
  async land(): Promise<{ landed: boolean; inbox: InboxItem | null }> {
    return { landed: true, inbox: null };
  }
  async abort(): Promise<void> {
    this.aborted += 1;
    this.log.push(`queue.abort ${this.snap()}`);
    if (this.abortFailure !== null) throw this.abortFailure;
  }
  queued(): readonly TaskId[] {
    return this.enqueued.flat();
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

type RaiseInput = Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string };

class PolicyDouble implements UnattendedPolicy {
  readonly raised: RaiseInput[] = [];
  readonly parks: Array<{ taskId: TaskId; cause: string; text: string }> = [];
  readonly counted: Array<{ phaseId: PhaseId; n: number; outcome: Attempt["outcome"]; verdict: Attempt["verdict"] }> = [];
  unblocks = 0;
  /** What `recordAttempt` answers (tripped: the breaker opened). */
  trip = false;
  /** When set, `recordAttempt` rejects with it. */
  recordFailure: Error | null = null;
  /** When set, `park` rejects with it (before journaling anything). */
  parkFailure: Error | null = null;
  /** When set, `raise` rejects with it. */
  raiseFailure: Error | null = null;
  /** When set, `unblock` rejects with it. */
  unblockFailure: Error | null = null;
  /** What `answer` returns. */
  answerResult: { resumed: TaskId | null } = { resumed: null };
  readonly answers: Array<{ inboxId: string | undefined; text: string | undefined }> = [];
  constructor(
    private readonly writer: LedgerWriter,
    private readonly leases: LeaseService,
    private readonly slots: SlotPoolDouble,
    private readonly clock: Clock,
  ) {}
  private async add(i: RaiseInput): Promise<InboxItem> {
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
  async raise(i: RaiseInput): Promise<InboxItem> {
    this.raised.push(i);
    if (this.raiseFailure !== null) throw this.raiseFailure;
    return this.add(i);
  }
  async park(taskId: TaskId, cause: "escalate" | "ambiguity" | "qa-unparsable" | "exhausted", text: string): Promise<InboxItem> {
    this.parks.push({ taskId, cause, text });
    if (this.parkFailure !== null) throw this.parkFailure;
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
  async answer(inboxId?: string, text?: string): Promise<{ resumed: TaskId | null }> {
    this.answers.push({ inboxId, text });
    return this.answerResult;
  }
  async unblock(): Promise<TaskId[]> {
    this.unblocks += 1;
    if (this.unblockFailure !== null) throw this.unblockFailure;
    return [];
  }
  async recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }> {
    this.counted.push({ phaseId, n: a.n, outcome: a.outcome, verdict: a.verdict });
    if (this.recordFailure !== null) throw this.recordFailure;
    return { tripped: this.trip };
  }
}

class QaDouble implements QaLoop {
  readonly results: Array<{ taskId: TaskId; report: FindingsReport }> = [];
  readonly awaiting: PhaseId[] = [];
  /** What `onQaResult` answers. */
  outcome: "passed" | "next-round" | "cap-reached" = "passed";
  /** When set, `onQaResult` rejects with it. */
  resultFailure: Error | null = null;
  /** When set, `onAwaitingQa` rejects with it. */
  awaitingFailure: Error | null = null;
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
    if (this.resultFailure !== null) throw this.resultFailure;
    return this.outcome;
  }
  async onAwaitingQa(phaseId: PhaseId): Promise<void> {
    this.awaiting.push(phaseId);
    if (this.awaitingFailure !== null) throw this.awaitingFailure;
  }
  async onCapAnswer(): Promise<"passed" | "next-round"> {
    return "passed";
  }
}

class GitDouble implements GitRunner {
  readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];
  dirty: (cwd: string) => boolean = () => true;
  failOn: { verb: string; stderr: string; times?: number } | null = null;
  /** When set, `run` rejects with it for this verb. */
  throwOn: { verb: string; error: Error } | null = null;
  refs: string[] = [];
  /** Answer for `log` (trailer search); empty by default. */
  logOut = "";
  private commits = 0;
  async run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> {
    this.calls.push({ args: [...args], cwd: o.cwd });
    const verb = args[0] ?? "";
    const ok = (stdout = ""): ProcessResult => ({ code: 0, signal: null, stdout, stderr: "", truncated: false, durationMs: 0 });
    if (this.throwOn !== null && this.throwOn.verb === verb) throw this.throwOn.error;
    if (this.failOn !== null && this.failOn.verb === verb) {
      const f = this.failOn;
      if (f.times !== undefined) {
        f.times -= 1;
        if (f.times <= 0) this.failOn = null;
      }
      return { ...ok(), code: 1, stderr: f.stderr };
    }
    if (verb === "for-each-ref") return ok(this.refs.join("\n"));
    if (verb === "worktree") return ok(`worktree ${REPO}\nHEAD ${SHA}\nbranch refs/heads/main\n`);
    if (verb === "config") return { ...ok(), code: 1 };
    if (verb === "status") return ok(this.dirty(o.cwd) ? " M src/a.ts\n" : "");
    if (verb === "log") return ok(this.logOut);
    if (verb === "rev-parse") {
      this.commits += 1;
      return ok(`${this.commits.toString(16).padStart(40, "e")}\n`);
    }
    return ok();
  }
}

class HostsDouble implements HostSessions {
  readonly delivered: Array<Parameters<HostSessions["synthetic"]>[0]> = [];
  readonly interrupted: string[] = [];
  failures = 0;
  readonly contexts = new Map<string, HostSessionContext>();
  activityValue: "active" | "inactive" | "unknown" = "inactive";
  async get(sessionID: string): Promise<{ id: string; parentID: string | null } | null> {
    return { id: sessionID, parentID: null };
  }
  async context(sessionID: string): Promise<HostSessionContext> {
    return this.contexts.get(sessionID) ?? { messages: [] };
  }
  async activity(): Promise<"active" | "inactive" | "unknown"> {
    return this.activityValue;
  }
  async interrupt(sessionID: string): Promise<void> {
    this.interrupted.push(sessionID);
  }
  async synthetic(i: Parameters<HostSessions["synthetic"]>[0]): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("host unavailable");
    }
    this.delivered.push(i);
  }
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
  keys(): string[] {
    return this.delivered.map((d) => String(d.metadata.stateKey));
  }
}

class VerifierDouble implements SlotVerifier {
  readonly calls: string[] = [];
  readonly queue: Array<{ verdict: Verdict; findings: string }> = [];
  /** When set, `verify` rejects with it (one shot). */
  failure: Error | null = null;
  async verify(t: TaskNode, _slot: SlotLease, attempt: Attempt): Promise<{ verdict: Verdict; findings: string; ref: string }> {
    this.calls.push(`${t.id}#${attempt.n}`);
    if (this.failure !== null) {
      const f = this.failure;
      this.failure = null;
      throw f;
    }
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
  readonly hooks: LaunchHooks;
  private hookEntered = false;
  constructor(
    readonly req: LaunchRequest,
    hooks: LaunchHooks,
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
  async child(sessionID: string): Promise<void> {
    this.childSessionID = sessionID;
    await this.hooks.onChildCreated(sessionID);
    this.confirm({ kind: "confirmed", childSessionID: sessionID, latencyMs: 1 });
  }
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
  launchFailure: Error | null = null;
  closed = false;
  readonly runs: RunDouble[] = [];
  readonly cancels: string[] = [];
  disposed = 0;
  constructor(
    private readonly log: CallLog,
    private readonly clock: Clock,
  ) {}
  gate(): LaunchGate {
    return this.gateValue;
  }
  launch(req: LaunchRequest, hooks: LaunchHooks): LaunchHandle {
    if (this.closed) {
      const late = new RunDouble(req, hooks, this.clock);
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
    this.cancels.push(`${taskId}#${attempt}:${reason}`);
    const run = this.runOf(taskId, attempt);
    if (run === undefined) return;
    run.end({ kind: "interrupted", childSessionID: run.childSessionID, reason, endedAt: this.clock.iso() });
    run.confirm({ kind: "unconfirmed", reason: "superseded", error: null });
  }
  /** Extra in-flight entries the launcher reports (children the runtime holds no handle for). */
  readonly extraInFlight: Array<{ taskId: TaskId; attempt: number; childSessionID: string | null; startedAt: string }> = [];
  inFlight(): ReadonlyArray<{ taskId: TaskId; attempt: number; childSessionID: string | null; startedAt: string }> {
    return [
      ...this.runs
        .filter((r) => !r.settled)
        .map((r) => ({ taskId: r.req.taskId, attempt: r.req.attempt, childSessionID: r.childSessionID, startedAt: T0 })),
      ...this.extraInFlight,
    ];
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
  runOf(taskId: TaskId, attempt: number): RunDouble | undefined {
    return this.runs.find((r) => r.req.taskId === taskId && r.req.attempt === attempt);
  }
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
  added: { tasks: TaskNode[]; edges: Edge[]; reopened: TaskId[] } | null = null;
  constructor(private readonly draft: LedgerV1) {}
  async compile(_planPath: string, opts: { orchestratorSessionID: string }): ReturnType<PlanCompiler["compile"]> {
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
  mergeResidue(): ReturnType<PlanCompiler["mergeResidue"]> {
    throw new ExecutorError("E_RESIDUE", "not used here");
  }
  addTasks(): ReturnType<PlanCompiler["addTasks"]> {
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
  compiler: CompilerDouble;
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
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    await removeDirWhenReleased(h.root, { deadlineMs: 20_000 });
  }
}, 60_000);

/** `prep` runs on the plan's collaborators as soon as the runtime builds them (before the first launch). */
async function mk(draft: LedgerV1, prep?: (p: PlanParts) => void): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "omr-rt-cov-"));
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
  const launcher = new LauncherDouble(log, clock);
  const compiler = new CompilerDouble(draft);
  const deps: RuntimeDeps = {
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
      prep?.(st.parts);
      const c: PlanCollaborators = { queue, policy, qa };
      return c;
    },
    pinOrchestrator: () => () => undefined,
    log: (level, msg, detail) => {
      logs.push(`${level}: ${msg}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    },
    config: () => draft.config,
    bindings: { bind: () => undefined, evict: () => undefined },
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
    async events() {
      return (await store.exportPlan(PLAN_ID)).events;
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

async function untilEnqueued(h: Harness, id: TaskId): Promise<void> {
  await until(() => h.state(id) === "verified", `${id} verified`);
  await until(() => h.parts().queue.enqueued.some((ids) => ids.includes(id)), `${id} enqueued`);
}

const hasLog = (h: Harness, part: string): boolean => h.logs.some((l) => l.includes(part));

/** RecoveryService + reconcile double: `reconcile` answers the feeds `feeds` builds from the ledger it is given. */
class RecoveryDouble {
  feeds: (l: Readonly<LedgerV1>) => ReconcileFeed[] = () => [];
  reconcileFailure: Error | null = null;
  readonly tracked: string[][] = [];
  /** What `recover` reports. */
  report: Array<{ planId: PlanId; actions: ReconcileAction[] }> = [];
  async recover(): Promise<Array<{ planId: PlanId; actions: ReconcileAction[] }>> {
    return this.report;
  }
  async adopt(): Promise<void> {}
  async reconcile(l: Readonly<LedgerV1>, tracked: ReadonlySet<string>): Promise<ReconcileFeed[]> {
    this.tracked.push([...tracked]);
    if (this.reconcileFailure !== null) throw this.reconcileFailure;
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
// commitTaskInSlot: index.lock recovery (removeIndexLock @316), identity errors and the D11 clean-tree arms
// ---------------------------------------------------------------------------------------------------------------

/** A GitRunner scripted per call: each answer is consumed in order (a function answer may throw). */
class ScriptedGit implements GitRunner {
  readonly calls: string[] = [];
  constructor(private readonly answers: Array<Partial<ProcessResult> | (() => Partial<ProcessResult>)>) {}
  async run(args: readonly string[], _o: ProcOpts): Promise<ProcessResult> {
    this.calls.push(args.join(" "));
    const next = this.answers.shift();
    const a = typeof next === "function" ? next() : (next ?? {});
    return { code: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, ...a };
  }
}

const LOCK_ERR = { code: 128, stderr: "fatal: Unable to create '.git/index.lock': File exists." };

describe("commitTaskInSlot: index.lock and error arms", () => {
  const lease = (path: string): SlotLease => ({ slot: "slot-1", path, planId: PLAN_ID, owner: "o", commit: SHA });

  it("removes a relative index.lock under the slot and retries the step once (lines 320-322, 343-345)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-rt-lock-"));
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "index.lock"), "");
    const git = new ScriptedGit([LOCK_ERR, { stdout: ".git/index.lock\n" }, { stdout: "" }]);
    const out = await commitTaskInSlot(git, { slot: lease(dir), branch: "b", message: "m", timeoutMs: 1000 });
    expect(out).toEqual({ changed: false });
    expect(git.calls).toEqual(["status --porcelain", "rev-parse --git-path index.lock", "status --porcelain"]);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("removes an absolute index.lock path as given (line 321 absolute arm)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-rt-lock-"));
    const lockPath = join(dir, "index.lock");
    await writeFile(lockPath, "");
    const git = new ScriptedGit([LOCK_ERR, { stdout: `${lockPath}\n` }, { stdout: " M a.ts\n" }, {}, {}, {}, { stdout: `${SHA}\n` }]);
    const out = await commitTaskInSlot(git, { slot: lease("C:/elsewhere"), branch: "b", message: "m", timeoutMs: 1000 });
    expect(out).toEqual({ changed: true, commit: SHA });
    expect(existsSync(lockPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not retry when the lock path is unknown (rev-parse fails or prints nothing) and throws E_GIT (line 320 arms)", async () => {
    for (const lockAnswer of [{ code: 1, stdout: "x" }, { stdout: "  \n" }]) {
      const git = new ScriptedGit([LOCK_ERR, lockAnswer]);
      const err = await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ExecutorError);
      expect(err instanceof ExecutorError ? err.code : null).toBe("E_GIT");
      expect(git.calls).toEqual(["status --porcelain", "rev-parse --git-path index.lock"]);
    }
  });

  it("swallows a throwing rev-parse inside the lock removal (line 323 catch) and removes a lock only once", async () => {
    const git = new ScriptedGit([
      LOCK_ERR,
      () => {
        throw new Error("spawn failed");
      },
    ]);
    const err = await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err instanceof ExecutorError ? err.code : null).toBe("E_GIT");
    // A second lock failure after one removal is not retried again (the `!lockRemoved` arm of line 343).
    const dir = await mkdtemp(join(tmpdir(), "omr-rt-lock-"));
    const git2 = new ScriptedGit([LOCK_ERR, { stdout: "index.lock" }, LOCK_ERR]);
    const err2 = await commitTaskInSlot(git2, { slot: lease(dir), branch: "b", message: "m", timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err2 instanceof ExecutorError ? err2.code : null).toBe("E_GIT");
    expect(git2.calls).toEqual(["status --porcelain", "rev-parse --git-path index.lock", "status --porcelain"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies a missing identity as E_IDENTITY (line 349 identity arm)", async () => {
    const git = new ScriptedGit([{ stdout: " M a.ts\n" }, {}, {}, { code: 128, stderr: "Author identity unknown\n" }]);
    const err = await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err instanceof ExecutorError ? err.code : null).toBe("E_IDENTITY");
  });

  it("a clean tree with the trailer on HEAD but a failing or empty rev-parse is unchanged (line 363/366 arms)", async () => {
    const trailer = "Omr-Attempt: plan-one/T1/1/abc";
    const body = { stdout: `subject\n\n${trailer}\n` };
    for (const head of [{ code: 1, stdout: SHA }, { stdout: "\n" }]) {
      const git = new ScriptedGit([{ stdout: "" }, body, head]);
      expect(await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000, trailer })).toEqual({
        changed: false,
      });
    }
    const failedLog = new ScriptedGit([{ stdout: "" }, { code: 1, stdout: trailer }]);
    expect(await commitTaskInSlot(failedLog, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000, trailer })).toEqual({
      changed: false,
    });
    expect(failedLog.calls).toEqual(["status --porcelain", "log -1 --format=%B"]);
  });
});

// Arms left uncovered on purpose (defensive re-checks under the same per-task mutex, invariant throws):
// 493 (boundedSet: a map over its cap is never empty), 650 (attemptOf invariant throw), 1580/1583, 1660/1663/1673,
// 1704, 1798, 1835/1839, 1869/1872, 1882/1891, 1941/1958, 1972/1975, 2030/2031, 2044, 2054 (the batch re-checks a state
// the caller read under the task's own mutex), 1684 and 1991 (an attempt the caller just read always exists).

// TESTS
