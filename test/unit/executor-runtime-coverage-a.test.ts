// Coverage tests for src/executor/runtime.ts, lines 493-2310 (guards, park/retry arms, held leases, route streaks).
// The harness is a minimal copy of the one in executor-runtime-coverage.test.ts (that file exports nothing): real
// LedgerStore in a temp dir, the real Scheduler, CapacityController and expand; typed doubles for every other seam. All
// time comes from TestClock; `until` only yields to the event loop while the real ledger files are written. Handles of
// the launcher double stay pending until a test settles them, so tests poll `until(...)` instead of runtime.settled()
// while a child is alive.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapacityController } from "../../src/executor/capacity.js";
import { createLedgerStore } from "../../src/executor/ledger.js";
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

vi.setConfig({ testTimeout: 30_000 });

const SHA = "c".repeat(40);
const SLOT_ROOT = "C:/omr-rt";
const ORCH = "ses-0";
const PROVIDER = "prov";
const REPO = "C:/repo";
const T15 = 15_000;

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
  pendingTimers(): number {
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
  planId?: PlanId;
}

function planOf(tasks: TaskNode[], o: PlanOpts = {}): LedgerV1 {
  const d = buildDraft(0, o.planId ?? PLAN_ID);
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
// Doubles (copied from executor-runtime-coverage.test.ts)
// ---------------------------------------------------------------------------------------------------------------

class SlotPoolDouble implements SlotPool {
  readonly byOwner = new Map<string, SlotLease>();
  readonly records = new Map<string, SlotRecord>();
  readonly released: string[] = [];
  readonly resets: Array<{ slot: string; commit: string }> = [];
  resetFailure: Error | null = null;
  releaseFailure: Error | null = null;
  cleanFailure: Error | null = null;
  /** When set, `acquire` throws it (every call). */
  acquireFailure: Error | null = null;
  /** When set, `get` throws it (every call). */
  getFailure: Error | null = null;
  private n = 0;
  constructor(private readonly log: CallLog) {}
  /** When set, `acquire` waits for it before answering (a slow provisioning step). */
  acquireGate: Promise<void> | null = null;
  /** Calls of `acquire` so far (counted on entry, before the gate). */
  acquireStarted = 0;
  async acquire(planId: string, owner: string, baseCommit: string): Promise<SlotLease> {
    this.acquireStarted += 1;
    if (this.acquireGate !== null) await this.acquireGate;
    if (this.acquireFailure !== null) throw this.acquireFailure;
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
    if (this.getFailure !== null) throw this.getFailure;
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
  /** When set, `releaseTask` throws it (every call). */
  releaseFailure: Error | null = null;
  constructor(private readonly log: CallLog) {}
  plant(path: string, holderID: string, taskRef: string | null): void {
    this.held.set(path, { holderID, taskRef });
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
    if (this.releaseFailure !== null) throw this.releaseFailure;
    for (const [p, h] of [...this.held]) if (h.taskRef === taskRef) this.held.delete(p);
  }
  /** Runs on every `holderOf` lookup (a test hook; it may journal a concurrent batch). */
  onHolderOf: ((path: string) => void) | null = null;
  holderOf(path: string): { holderID: string; taskRef: string | null } | null {
    this.onHolderOf?.(path);
    return this.held.get(path) ?? null;
  }
}

class QueueDouble implements IntegrationQueue {
  readonly enqueued: TaskId[][] = [];
  readonly checked: string[] = [];
  aborted = 0;
  disposed = 0;
  enqueueFailure: Error | null = null;
  checkFailure: Error | null = null;
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
  trip = false;
  recordFailure: Error | null = null;
  parkFailure: Error | null = null;
  raiseFailure: Error | null = null;
  unblockFailure: Error | null = null;
  /** When true, `park` journals nothing (a no-op park: the task keeps its state and slot). */
  parkNoop = false;
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
    if (this.parkNoop) return this.add({ kind: "question", severity: "blocking", taskId, text, options: [] });
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
  /** Runs inside `recordAttempt` (a test hook; it may journal a concurrent batch). */
  onRecord: ((a: Attempt) => void) | null = null;
  async recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }> {
    this.counted.push({ phaseId, n: a.n, outcome: a.outcome, verdict: a.verdict });
    this.onRecord?.(a);
    if (this.recordFailure !== null) throw this.recordFailure;
    return { tripped: this.trip };
  }
}

class QaDouble implements QaLoop {
  readonly results: Array<{ taskId: TaskId; report: FindingsReport }> = [];
  readonly awaiting: PhaseId[] = [];
  outcome: "passed" | "next-round" | "cap-reached" = "passed";
  resultFailure: Error | null = null;
  awaitingFailure: Error | null = null;
  /** Runs inside `parse` (a test hook; it may journal a concurrent batch). */
  onParse: ((text: string) => void) | null = null;
  parse(text: string): { ok: true; report: FindingsReport } | { ok: false; error: string } {
    this.onParse?.(text);
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
  throwOn: { verb: string; error: Error } | null = null;
  refs: string[] = [];
  logOut = "";
  private commits = 0;
  /** Runs first on every call (a test hook; it may journal a concurrent batch or throw). */
  onRun: ((args: readonly string[], cwd: string) => void) | null = null;
  async run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> {
    this.calls.push({ args: [...args], cwd: o.cwd });
    this.onRun?.(args, o.cwd);
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
}

class VerifierDouble implements SlotVerifier {
  readonly calls: string[] = [];
  readonly queue: Array<{ verdict: Verdict; findings: string }> = [];
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

/** Route resolver double: throws for the task ids in `failing` (a RouteResolver error, QA-3.1-22). */
class RoutesDouble implements RouteResolver {
  readonly failing = new Set<TaskId>();
  route(t: TaskNode): ReturnType<RouteResolver["route"]> {
    if (this.failing.has(t.id)) throw new Error(`no route for ${t.id}`);
    return {
      agent: t.route.role,
      model: { providerID: PROVIDER, modelID: "model-1", variant: null },
      provider: PROVIDER,
      heavy: false,
    };
  }
}

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
  /** Runs at the start of every open-launcher `launch` (a test hook; it may journal a concurrent batch). */
  beforeLaunch: ((req: LaunchRequest) => void) | null = null;
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
    this.beforeLaunch?.(req);
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
  /** Drafts the next compiles answer (in order) before falling back to the harness draft. */
  readonly nextDrafts: LedgerV1[] = [];
  constructor(private readonly draft: LedgerV1) {}
  async compile(_planPath: string, opts: { orchestratorSessionID: string }): ReturnType<PlanCompiler["compile"]> {
    const draft: LedgerV1 = JSON.parse(JSON.stringify(this.nextDrafts.shift() ?? this.draft)) as LedgerV1;
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
  routes: RoutesDouble;
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

interface MkOpts {
  /** Runs on the plan's collaborators as soon as the runtime builds them (before the first launch). */
  prep?: (p: PlanParts) => void;
  /** Patches the deps before the runtime is built. */
  deps?: (d: RuntimeDeps) => RuntimeDeps;
}

async function mk(draft: LedgerV1, o: MkOpts = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "omr-rt-cova-"));
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
  const routes = new RoutesDouble();
  const base: RuntimeDeps = {
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
    capacity: (c) => createCapacityController(c),
    collaborators: (i) => {
      const queue = new QueueDouble(log, snap);
      const policy = new PolicyDouble(i.writer, i.leases, slots, clock);
      const qa = new QaDouble();
      st.parts = { writer: i.writer, leases: i.leases, waker: i.waker, listener: i.listener, queue, policy, qa };
      o.prep?.(st.parts);
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
  const deps = o.deps === undefined ? base : o.deps(base);
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
    routes,
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

const hasLog = (h: Harness, part: string): boolean => h.logs.some((l) => l.includes(part));

/** RecoveryService + reconcile double: `reconcile` answers the feeds `feeds` builds from the ledger it is given. */
class RecoveryDouble {
  feeds: (l: Readonly<LedgerV1>) => ReconcileFeed[] = () => [];
  reconcileFailure: Error | null = null;
  readonly tracked: string[][] = [];
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

/** Labels of every `counter` metric with `key` journaled so far. */
async function counterLabels(h: Harness, key: string): Promise<Array<Record<string, string>>> {
  const out: Array<Record<string, string>> = [];
  for (const e of await h.events()) {
    if (e.type === "metric" && e.metric.name === "counter" && e.metric.key === key) out.push(e.metric.labels);
  }
  return out;
}

async function untilCounter(h: Harness, key: string, pred: (labels: Record<string, string>) => boolean, what: string): Promise<void> {
  await until(async () => (await counterLabels(h, key)).some(pred), what);
}

const gateWith = (callID: string): LaunchGate => ({ ok: true, context: { ...GATE_CONTEXT, callID }, ageMs: 0 });

// ---------------------------------------------------------------------------------------------------------------
// Tick: route streak, backoff, launch-step guards
// ---------------------------------------------------------------------------------------------------------------

describe("runtime tick: route failures and backoff", () => {
  it("raises one blocking item after ROUTE_STREAK backoff rounds of a failing RouteResolver (lines 958-970)", async () => {
    const h = await mk(planOf([task("T1")]));
    h.routes.failing.add("T1");
    await h.begin();
    await until(() => {
      h.clock.advance(60_000);
      return h.parts().policy.raised.length > 0;
    }, "route streak raise");
    const raised = need(h.parts().policy.raised[0], "raise");
    expect(raised.kind).toBe("failure");
    expect(raised.severity).toBe("blocking");
    expect(raised.taskId).toBe("T1");
    expect(raised.text).toContain("5 consecutive ticks could not resolve a route (last: T1: no route for T1)");
    await untilCounter(h, "route-streak", (l) => l.taskId === "T1", "route-streak counter");
    expect(h.launcher.runs).toHaveLength(0);
    // The streak raises once: further rounds stay silent (the `routeRaised` arm of line 961).
    for (let i = 0; i < 6; i++) {
      h.clock.advance(60_000);
      await pause(5);
    }
    expect(h.parts().policy.raised).toHaveLength(1);
  }, T15);

  // The qa gate is moved by a batch journaled here (as a concurrent writer would) while the step waits for its slot.
  it("row 4 refuses a qa dispatch whose gate moved while its slot was provisioned (line 1343)", async () => {
    const h = await mk(planOf([task("Q1", { kind: "qa" })], { gate: "awaiting-qa" }));
    const slow = deferred<void>();
    h.slots.acquireGate = slow.promise;
    await h.begin();
    await until(() => h.slots.acquireStarted === 1, "slot acquire entered");
    const ph = need(h.ledger().phases[0], "phase");
    await h.parts().writer.append([{ type: "gate-changed", phaseId: ph.id, from: "awaiting-qa", to: "passed", trigger: "no-open-qa", qaRound: ph.qaRound }]);
    const releasesBefore = h.registry.releases.length;
    slow.resolve();
    await until(() => h.slots.released.includes("slot-1"), "fresh slot abandoned");
    // The registry keys releases `<planId>:<taskId>`. `abandon` releases the task's leases itself (line 1273) and again
    // through `releaseResources` (line 778); `releaseTask` is idempotent, so the repeated key is by design.
    expect(h.registry.releases.slice(releasesBefore)).toContain(`${PLAN_ID}:Q1`);
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("Q1")).toBe("ready");
    expect(h.task("Q1").attempts).toHaveLength(0);
    expect(h.task("Q1").slot).toBeNull();
  }, T15);

  it("a skip while the backoff tick is already armed keeps the one timer (line 930)", async () => {
    const h = await mk(planOf([task("T1"), task("T2")]));
    // T1 cannot be routed (arms the backoff in the tick), T2's slot is unavailable (its skip finds the timer armed).
    h.routes.failing.add("T1");
    h.slots.acquireFailure = new ExecutorError("E_SLOT_UNAVAILABLE", "no free slot");
    await h.begin();
    await untilCounter(h, "launch-skipped", (l) => l.reason === "slot-unavailable", "slot-unavailable skip");
    await untilCounter(h, "launch-skipped", (l) => l.reason === "route" && l.taskId === "T1", "route skip");
    expect(h.launcher.runs).toHaveLength(0);
    expect(h.state("T2")).toBe("ready");
    await until(() => h.registry.releases.includes(`${PLAN_ID}:T2`), "T2 step abandoned");
    // The armed backoff tick retries T2 once the pool has a slot again.
    h.slots.acquireFailure = null;
    await until(() => {
      h.clock.advance(1000);
      return h.launcher.runOf("T2", 1) !== undefined;
    }, "T2 relaunched by the backoff tick");
    expect(h.launcher.runOf("T1", 1)).toBeUndefined();
  }, T15);
});

describe("runtime: park without journaling and late children", () => {
  it("a park the policy did not journal keeps the slot (line 991 taken arm)", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 1 } }), {
      prep: (p) => {
        p.policy.parkNoop = true;
      },
    });
    await h.begin();
    const run = await h.running("T1", 1, "ses-1");
    run.end({ kind: "failed", childSessionID: "ses-1", error: { type: "boom", status: null, message: "it broke" }, endedAt: h.clock.iso() });
    await until(() => h.parts().policy.parks.length === 1, "park");
    await until(() => h.ledger().inbox.length === 1, "park inbox item");
    expect(h.parts().policy.parks[0]).toMatchObject({ taskId: "T1", cause: "exhausted" });
    expect(h.state("T1")).toBe("failed");
    expect(h.task("T1").slot).toBe("slot-1");
    expect(h.slots.released).not.toContain("slot-1");
  }, T15);

  it("a late child of an older attempt on a ready task is refused and counted L11 (line 1548 L11 arm)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run1 = await h.runOf("T1", 1);
    run1.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    const run2 = await h.runOf("T1", 2);
    // No relaunch after attempt 2 is lost: the task stays ready with attempt 2 as its last.
    h.launcher.gateValue = DISPOSED_GATE;
    run2.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("T1") === "ready" && h.task("T1").attempts[1]?.outcome === "lost", "attempt 2 lost");
    const err = await run1.hooks.onChildCreated("ses-late").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err instanceof ExecutorError ? err.code : null).toBe("E_PLAN_STATE");
    await untilCounter(h, "launch-failed", (l) => l.row === "L11", "L11 counter");
    expect(h.state("T1")).toBe("ready");
    expect(h.task("T1").attempts).toHaveLength(2);
    expect(h.launcher.runOf("T1", 3)).toBeUndefined();
  }, T15);

  it("a late child of a lost qa attempt is refused while its phase gate is not awaiting-qa (line 1540)", async () => {
    const h = await mk(planOf([task("Q1", { kind: "qa" })], { gate: "awaiting-qa" }));
    await h.begin();
    const run1 = await h.runOf("Q1", 1);
    const ph = need(h.ledger().phases[0], "phase");
    expect(ph.gate).toBe("qa-running");
    h.launcher.gateValue = DISPOSED_GATE;
    run1.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.state("Q1") === "ready" && h.task("Q1").attempts[0]?.outcome === "lost", "attempt 1 lost");
    await until(() => h.ledger().phases[0]?.gate === "awaiting-qa", "gate requeued");
    // The gate moved on (it left awaiting-qa) before the late child showed up.
    const round = need(h.ledger().phases[0], "phase").qaRound;
    await h.parts().writer.append([{ type: "gate-changed", phaseId: ph.id, from: "awaiting-qa", to: "passed", trigger: "no-open-qa", qaRound: round }]);
    const err = await run1.hooks.onChildCreated("ses-late").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err instanceof ExecutorError ? err.code : null).toBe("E_PLAN_STATE");
    await untilCounter(h, "launch-failed", (l) => l.row === "L11", "L11 counter");
    expect(h.state("Q1")).toBe("ready");
    expect(h.task("Q1").attempts[0]?.childSessionID).toBeNull();
  }, T15);

  it("superseded losses under a newer capture never count toward the pre-confirmation streak (line 1608)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    for (let n = 1; n <= 3; n++) {
      const run = await h.runOf("T1", n);
      h.launcher.gateValue = gateWith(`call-${n + 1}`);
      run.confirm({ kind: "unconfirmed", reason: "superseded", error: null });
      await until(() => h.task("T1").attempts[n - 1]?.outcome === "lost", `attempt ${n} lost`);
    }
    await h.runOf("T1", 4);
    expect(h.ledger().status).toBe("running");
    expect(h.parts().policy.raised).toHaveLength(0);
    expect(h.task("T1").attempts.slice(0, 3).map((a) => a.callID)).toEqual(["call-1", "call-2", "call-3"]);
  }, T15);

  it("a pre-confirmation streak reached while the plan is paused neither pauses nor raises (lines 1636, 1641)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    for (let n = 1; n <= 2; n++) {
      const run = await h.runOf("T1", n);
      run.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
      await until(() => h.task("T1").attempts[n - 1]?.outcome === "lost", `attempt ${n} lost`);
    }
    const run3 = await h.runOf("T1", 3);
    await h.runtime.pause(PLAN_ID, ORCH);
    await until(() => h.ledger().status === "paused", "plan paused");
    run3.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await until(() => h.task("T1").attempts[2]?.outcome === "lost" && h.state("T1") === "ready", "attempt 3 lost");
    await pause(20);
    expect(h.ledger().status).toBe("paused");
    expect(h.parts().policy.raised).toHaveLength(0);
    expect(await counterLabels(h, "launch-lost-pause")).toHaveLength(0);
    expect(h.launcher.runOf("T1", 4)).toBeUndefined();
  }, T15);
});

describe("runtime: integration results", () => {
  it("sweepBlocked skips an in-flight entry without a handle and releases a slotless blocked task (lines 779, 2074, 2075)", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 1 } }));
    await h.begin();
    // T1: one failed attempt, parked (the runtime forgets its slot lease), its settled handle kept.
    const run = await h.running("T1", 1, "ses-1");
    run.end({ kind: "failed", childSessionID: "ses-1", error: { type: "boom", status: null, message: "it broke" }, endedAt: h.clock.iso() });
    await until(() => h.state("T1") === "parked", "T1 parked");
    await until(() => h.slots.released.includes("slot-1"), "slot-1 released");
    h.launcher.gateValue = DISPOSED_GATE;
    // Q moved T1 to blocked (its slot is gone); the launcher still reports attempt 1 and an attempt the runtime holds no
    // handle for.
    await h.parts().writer.append([tr("T1", "parked", "ready", "answered"), tr("T1", "ready", "blocked", "dep-reverted", "T0")]);
    h.launcher.extraInFlight.push({ taskId: "T1", attempt: 1, childSessionID: "ses-1", startedAt: T0 });
    h.launcher.extraInFlight.push({ taskId: "T1", attempt: 7, childSessionID: null, startedAt: T0 });
    const releasesBefore = h.registry.releases.length;
    const slotReleasesBefore = h.slots.released.length;
    h.parts().listener.onReverted("T1");
    await until(() => h.launcher.cancels.includes("T1#1:blocked"), "blocked cancel");
    await until(() => h.registry.releases.length > releasesBefore, "lease release of the blocked task");
    expect(h.registry.releases.slice(releasesBefore)).toContain(`${PLAN_ID}:T1`);
    // Only the attempt the runtime holds a handle for is cancelled (T1#7 is skipped); no slot is left to release.
    expect(h.launcher.cancels.filter((c) => c.endsWith(":blocked"))).toEqual(["T1#1:blocked"]);
    await pause(20);
    expect(h.slots.released.length).toBe(slotReleasesBefore);
    expect(h.state("T1")).toBe("blocked");
  }, T15);

  it("an exhausted slotless task parks without a slot to return (lines 988, 991 slotName arm)", async () => {
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 1 } }));
    await h.begin();
    const run = await h.running("T1", 1, "ses-1");
    run.end({ kind: "failed", childSessionID: "ses-1", error: { type: "boom", status: null, message: "it broke" }, endedAt: h.clock.iso() });
    await until(() => h.state("T1") === "parked", "T1 parked");
    await until(() => h.slots.released.includes("slot-1"), "slot-1 released");
    h.launcher.gateValue = DISPOSED_GATE;
    // A second, slotless attempt of T1 failed (journaled here with legal rows only: answered, launch, launch-task-error;
    // the slot rules are checked at batch end and `failed` neither requires nor forbids one): onFailed counts it and
    // parks T1.
    const at = h.clock.iso();
    await h.parts().writer.append([
      tr("T1", "parked", "ready", "answered"),
      {
        type: "attempt-started",
        taskId: "T1",
        attempt: { n: 2, nonce: "f".repeat(32), callID: null, childSessionID: null, startedAt: at, endedAt: null, outcome: null, verdict: null, context: "" },
      },
      tr("T1", "ready", "dispatched", "launch"),
      { type: "attempt-ended", taskId: "T1", n: 2, outcome: "failed", endedAt: at, detail: "queue failure" },
      { type: "attempt-context", taskId: "T1", n: 2, context: "queue failure" },
      tr("T1", "dispatched", "failed", "launch-task-error", "queue failure"),
    ]);
    expect(h.task("T1").slot).toBeNull();
    const releasedBefore = h.slots.released.length;
    h.parts().listener.onFailed("T1");
    await until(() => h.parts().policy.parks.length === 2, "second park");
    await until(() => h.state("T1") === "parked", "T1 parked again");
    expect(h.parts().policy.parks[1]).toEqual({ taskId: "T1", cause: "exhausted", text: "queue failure" });
    expect(h.parts().policy.counted.map((c) => c.n)).toEqual([1, 2]);
    await pause(20);
    expect(h.slots.released.length).toBe(releasedBefore);
  }, T15);
});

describe("runtime: one active plan per process", () => {
  it("a plan compiled while another is paused attaches passively; activeOnly names the holder, then 'another plan' (lines 2169, 2206)", async () => {
    const PLAN_B = "plan-two";
    const h = await mk(planOf([task("T1")]));
    h.launcher.gateValue = DISPOSED_GATE;
    await h.begin();
    const a = h.parts();
    await h.runtime.pause(PLAN_ID, ORCH);
    expect(a.writer.ledger.status).toBe("paused");
    h.compiler.nextDrafts.push(planOf([task("U1")], { planId: PLAN_B }));
    const out = await h.runtime.compile({ path: `${REPO}/PLAN-B.md`, sessionID: "ses-b" });
    expect(out.planId).toBe(PLAN_B);
    const b = h.parts();
    expect(b.writer.planId).toBe(PLAN_B);
    await until(() => b.writer.ledger.inbox.some((i) => i.text.includes(`plan ${PLAN_B} cannot run: plan ${PLAN_ID}`)), "refusal item");
    const err1 = await h.runtime.addTasks(PLAN_B, "- U2", "ses-b").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err1 instanceof ExecutorError ? err1.message : String(err1)).toContain(`refused: ${PLAN_ID} held the active slot`);
    await h.runtime.abort(PLAN_ID, ORCH);
    await until(() => a.writer.ledger.status === "aborted", "plan A aborted");
    const err2 = await h.runtime.done(PLAN_B, "U1", "ses-b").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err2 instanceof ExecutorError ? err2.message : String(err2)).toContain("refused: another plan held the active slot");
    expect(h.launcher.runs).toHaveLength(0);
  }, T15);
});

// ---------------------------------------------------------------------------------------------------------------
// Re-checks of the runtime's batches: a collaborator journals a concurrent batch (queued first on the serial writer)
// right before the runtime's own batch, which then finds the task moved on and writes nothing.
// ---------------------------------------------------------------------------------------------------------------

/** Queues `build` on the writer now; a failure is logged (never an unhandled rejection). */
function fire(w: LedgerWriter, logs: string[], build: (l: Readonly<LedgerV1>) => ExecutorEventInput[]): Promise<void> {
  return w.append(build).then(
    () => undefined,
    (e: unknown) => {
      logs.push(`concurrent batch failed: ${e instanceof Error ? e.message : String(e)}`);
    },
  );
}

/** The batch rows 11/18 write: the open attempt ends `lost` and the task goes back to ready (qa gate requeued). */
function requeue(id: TaskId, at: string): (l: Readonly<LedgerV1>) => ExecutorEventInput[] {
  return (l) => {
    const t = l.tasks[id];
    const a = t === undefined ? undefined : t.attempts[t.attempts.length - 1];
    if (t === undefined || a === undefined || a.outcome !== null || (t.state !== "dispatched" && t.state !== "running")) return [];
    const ev: ExecutorEventInput[] = [
      { type: "attempt-ended", taskId: id, n: a.n, outcome: "lost", endedAt: at, detail: "concurrent" },
      tr(id, t.state, "ready", t.state === "dispatched" ? "launch-lost" : "child-lost", "concurrent"),
    ];
    const ph = l.phases.find((p) => p.id === t.phase);
    if (t.kind === "qa" && ph !== undefined && ph.gate === "qa-running") {
      ev.push({ type: "gate-changed", phaseId: ph.id, from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued", qaRound: ph.qaRound });
    }
    return ev;
  };
}

const noConcurrentFailure = (h: Harness): void => {
  expect(h.logs.filter((l) => l.includes("concurrent batch failed"))).toEqual([]);
};

describe("runtime: batch re-checks against a concurrent batch", () => {
  for (const c of [
    { code: "E_NO_CONTEXT" as const, row: "L3", line: "1580" },
    { code: "E_LAUNCH_TASK" as const, row: "L2", line: "1660, 1673" },
  ]) {
    it(`a ${c.code} launch throw finds the attempt already requeued and writes nothing (line ${c.line})`, async () => {
      const h = await mk(planOf([task("T1")]));
      const st: { p: Promise<void> | null } = { p: null };
      h.launcher.beforeLaunch = (req) => {
        if (st.p !== null) return;
        st.p = fire(h.parts().writer, h.logs, requeue(req.taskId, h.clock.iso()));
        h.launcher.gateValue = DISPOSED_GATE;
        h.launcher.launchFailure = new ExecutorError(c.code, "launch refused");
      };
      await h.begin();
      await untilCounter(h, "launch-failed", (l) => l.row === c.row, `${c.row} counter`);
      await need(st.p, "concurrent batch");
      await until(() => h.state("T1") === "ready", "T1 ready");
      await pause(20);
      noConcurrentFailure(h);
      const t = h.task("T1");
      expect(t.attempts).toHaveLength(1);
      expect(t.attempts[0]?.outcome).toBe("lost");
      expect(h.parts().policy.counted).toHaveLength(0);
      expect(h.ledger().status).toBe("running");
      expect(h.launcher.runs).toHaveLength(0);
    }, T15);
  }

  it("the retry batch finds the failed task already retried and writes nothing (line 1704 and its reverted arm)", async () => {
    const st: { p: Promise<void> | null } = { p: null };
    const logs: string[] = [];
    const h = await mk(planOf([task("T1")], { config: { maxAttempts: 3 } }), {
      prep: (p) => {
        p.policy.onRecord = (a) => {
          if (a.n !== 1 || st.p !== null) return;
          st.p = fire(p.writer, logs, (l) => (l.tasks.T1?.state === "failed" ? [tr("T1", "failed", "ready", "retry")] : []));
        };
      },
    });
    await h.begin();
    const run = await h.running("T1", 1, "ses-1");
    run.end({ kind: "failed", childSessionID: "ses-1", error: { type: "boom", status: null, message: "it broke" }, endedAt: h.clock.iso() });
    await h.runOf("T1", 2);
    await need(st.p, "concurrent batch");
    expect(logs).toEqual([]);
    const retries = (await h.events()).filter((e) => e.type === "task-transition" && e.taskId === "T1" && e.trigger === "retry");
    expect(retries).toHaveLength(1);
    expect(h.parts().policy.parks).toHaveLength(0);
  }, T15);

  it("an unparsable qa report finds its attempt already requeued and writes nothing (lines 1835, 1839)", async () => {
    const h = await mk(planOf([task("Q1", { kind: "qa" })], { gate: "awaiting-qa" }));
    await h.begin();
    const run = await h.running("Q1", 1, "ses-q");
    const st: { p: Promise<void> | null } = { p: null };
    h.parts().qa.onParse = () => {
      if (st.p !== null) return;
      st.p = fire(h.parts().writer, h.logs, requeue("Q1", h.clock.iso()));
      h.launcher.gateValue = DISPOSED_GATE;
    };
    run.complete("this is not a findings report");
    await until(() => st.p !== null, "parse");
    await need(st.p, "concurrent batch");
    await until(() => h.state("Q1") === "ready", "Q1 requeued");
    await pause(20);
    noConcurrentFailure(h);
    const a = need(h.task("Q1").attempts[0], "attempt 1");
    expect(a.outcome).toBe("lost");
    expect(a.context).toBe("");
    expect(h.parts().policy.counted).toHaveLength(0);
    expect(h.ledger().phases[0]?.gate).toBe("awaiting-qa");
  }, T15);

  it("a parsed qa report finds its attempt already requeued and writes nothing (lines 1882, 1891)", async () => {
    const h = await mk(planOf([task("Q1", { kind: "qa" })], { gate: "awaiting-qa" }));
    await h.begin();
    const run = await h.running("Q1", 1, "ses-q");
    const st: { p: Promise<void> | null } = { p: null };
    h.parts().qa.onParse = () => {
      if (st.p !== null) return;
      st.p = fire(h.parts().writer, h.logs, requeue("Q1", h.clock.iso()));
      h.launcher.gateValue = DISPOSED_GATE;
    };
    run.complete(JSON.stringify({ findings: [] }));
    await until(() => st.p !== null, "parse");
    await need(st.p, "concurrent batch");
    await until(() => h.state("Q1") === "ready", "Q1 requeued");
    await pause(20);
    noConcurrentFailure(h);
    expect(h.task("Q1").attempts[0]?.outcome).toBe("lost");
    expect(h.task("Q1").slot).toBe("slot-1");
    expect(h.parts().qa.results).toHaveLength(0);
    expect(h.slots.released).not.toContain("slot-1");
  }, T15);

  it("a lease request finds its attempt already requeued and writes nothing (lines 1941, 1958)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-1");
    const st: { p: Promise<void> | null } = { p: null };
    h.registry.onHolderOf = (path) => {
      if (st.p !== null || path !== "src/extra.ts") return;
      st.p = fire(h.parts().writer, h.logs, requeue("T1", h.clock.iso()));
      h.launcher.gateValue = DISPOSED_GATE;
    };
    run.complete("NEED MORE: lease src/extra.ts\nthe helper lives there");
    await until(() => st.p !== null, "holder lookup");
    await need(st.p, "concurrent batch");
    await untilCounter(h, "learned-edge", (l) => l.result === "free", "learned-edge counter");
    await until(() => h.state("T1") === "ready", "T1 requeued");
    await pause(20);
    noConcurrentFailure(h);
    const t = h.task("T1");
    expect(t.attempts[0]?.outcome).toBe("lost");
    expect(t.footprint.writes).not.toContain("src/extra.ts");
    // The slot stays with the task (the lease batch, which would have cleared it, wrote nothing).
    expect(t.slot).toBe("slot-1");
    expect(h.slots.released).not.toContain("slot-1");
  }, T15);

  it("row 15 finds the completed attempt already requeued and writes nothing (lines 1869, 1872)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-1");
    // Queued on the writer before the end is processed: the end reads `running`, its batch runs after this one.
    const concurrent = fire(h.parts().writer, h.logs, requeue("T1", h.clock.iso()));
    h.launcher.gateValue = DISPOSED_GATE;
    run.complete("all done");
    await concurrent;
    await until(() => h.state("T1") === "ready", "T1 requeued");
    await pause(20);
    noConcurrentFailure(h);
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost"]);
    expect(h.git.calls.some((c) => c.args[0] === "commit")).toBe(false);
    expect(h.task("T1").slot).toBe("slot-1");
  }, T15);

  it("row 18 finds the lost attempt already requeued and writes nothing (line 1798)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-1");
    const concurrent = fire(h.parts().writer, h.logs, requeue("T1", h.clock.iso()));
    h.launcher.gateValue = DISPOSED_GATE;
    run.end({ kind: "lost", childSessionID: "ses-1", reason: "runner-error", endedAt: h.clock.iso() });
    await concurrent;
    await until(() => h.state("T1") === "ready", "T1 requeued");
    await pause(20);
    noConcurrentFailure(h);
    const ends = (await h.events()).filter((e) => e.type === "attempt-ended" && e.taskId === "T1");
    expect(ends).toHaveLength(1);
    expect(h.task("T1").attempts.map((a) => a.outcome)).toEqual(["lost"]);
    expect(h.ledger().status).toBe("running");
  }, T15);

  it("a commit failure finds the task already settled and writes nothing (lines 1972, 1975)", async () => {
    const h = await mk(planOf([task("T1")]));
    await h.begin();
    const run = await h.running("T1", 1, "ses-1");
    const st: { p: Promise<void> | null } = { p: null };
    h.git.onRun = (args, cwd) => {
      if (st.p !== null || args[0] !== "status" || cwd !== slotPathOf("slot-1")) return;
      st.p = fire(h.parts().writer, h.logs, (l) =>
        l.tasks.T1?.state === "completed" ? [tr("T1", "completed", "done", "no-changes"), { type: "task-slot", taskId: "T1", slot: null, branch: null }] : [],
      );
      throw new Error("git crashed");
    };
    run.complete("all done");
    await until(() => h.state("T1") === "done", "T1 done");
    await need(st.p, "concurrent batch");
    await pause(20);
    noConcurrentFailure(h);
    const ev = await h.events();
    expect(ev.some((e) => e.type === "task-transition" && e.trigger === "commit-failed")).toBe(false);
    expect(h.task("T1").attempts[0]?.outcome).toBe("succeeded");
    expect(h.parts().policy.counted).toHaveLength(0);
  }, T15);
});

// Arms of 493-2310 left uncovered on purpose (unreachable through the public seams):
// - 805: `retryHeldLeases` is only called by `tickOnce` with a non-empty hold, after its own `disposed` check, and a
//   passive plan never ticks.
// - 1041: when no retry state exists `key === baseKey`, so line 1040 already returned.
// - 1045 #1/#2: the runtime's own waker answers `debounced` only after a journaled attempt, so `lastAttemptMs()` is set.
// - 1178: `readySet` skips in-flight tasks before it resolves a route, so an unroutable id is never in flight.
// - 660 (`?? null`): `phaseAdmits` never schedules a task whose phase record is missing, so no launched task has one.
// - 964 #1, 965 null arm, 970 `??` fallbacks: `routeFailures` only runs with a non-empty `failed` map.
// - 1605/1610 null callID: every dispatched attempt carries the gate context's callID (a string), and only dispatched
//   attempts reach row 11.
// - 2253: `planFor` serialises the opens of one plan and `start` skips attached plans; the re-check is a race guard.
// - 2309: `ref.p` is set before the waker can be called (no wake happens while the plan is being built).
// - 1583, 1663 (`a === null`): the same builder returned [] one line above when the open attempt is missing.
// - 860, 871, 873, 874, 885: guards of the held-lease resume (QA-4.2-16/-26) re-read under the task mutex a state
//   `retryHeldLeases` checked just before (task present, slot set, plan not disposed); 885 is never reached since every
//   caller checks `t.slot` first.
// - 893 (`rec.commit ?? head`), 1096 (provider limit 0 with a ready task), 1158 (plan finished then not, inside one
//   batch), 1965 (row 15 applied, then not completed), 2151 (`?? null`: a capacity metric of an unregistered plan),
//   2188 (unreserve without a reservation): need a restart/recovery or a timing race the public seams do not expose.
// - 1264, 1266: the tick computes `n` and starts the step synchronously under the task's `inFlight` guard; every other
//   writer of a ready task's attempts runs under the same task mutex and re-ticks after it, so the step never sees a
//   stale `n` or a non-ready task without a timing race.
// - 617, 650, 1198, 1224, 1504, 1516, 1684, 1747, 1991, 2030, 2031: lookups of a task or attempt the caller has just
//   read (tasks and attempts are never removed from a ledger).
