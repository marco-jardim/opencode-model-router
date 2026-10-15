import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLECT_RETRY_BASE_MS, COLLECT_RETRY_MAX_MS, GC_TAG_PENDING, createExecutorRuntime, nextCollectDelay, planTagsSettled, realCollaborators,
  type ExecutorRuntimeHandle, type RuntimeDeps, type CollaboratorInput,
} from "../../src/executor/runtime";
import { phaseTagName } from "../../src/executor/git";
import type { ReconcileFeed } from "../../src/executor/recovery";
import { createLedgerStore, createNodeClock } from "../../src/executor/ledger";
import { createCapacityController } from "../../src/executor/capacity";
import { createScheduler } from "../../src/executor/schedule";
import { defaultSlotsDir } from "../../src/executor/slots/pool";
import { planDir } from "../../src/executor/paths";
import { ExecutorError, isLedgerV1, ledgerViolations, reviewTaskId, type LedgerV1, type SlotPool, type IntegrationQueue } from "../../src/executor/types";
import { buildDraft, holderOf, openAttempt, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const runtimes: ExecutorRuntimeHandle[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await removeDirWhenReleased(root);
}, 30_000);

const REPO = "C:/executor-slots-repo";
const SHA = "c".repeat(40);

function pool(planId: string) {
  return {
    acquire: vi.fn<SlotPool["acquire"]>(async (id, owner, commit) => ({ slot: "slot-1", path: `C:/slots/${planId}/slot-1`, planId: id, owner, commit })),
    acquireSpecial: vi.fn<SlotPool["acquireSpecial"]>(async (id, kind) => ({ slot: kind, path: `C:/slots/${planId}/${kind}`, planId: id, owner: kind, commit: SHA })),
    reset: vi.fn<SlotPool["reset"]>(async () => {}),
    noteCommit: vi.fn<SlotPool["noteCommit"]>(async () => {}),
    cleanForChecks: vi.fn<SlotPool["cleanForChecks"]>(async () => ({ drifted: false })),
    release: vi.fn<SlotPool["release"]>(async () => {}),
    get: vi.fn<SlotPool["get"]>(async () => null),
    list: vi.fn<SlotPool["list"]>(async () => []),
    gc: vi.fn<SlotPool["gc"]>(async () => ({ removed: [], reported: [] })),
  } satisfies SlotPool;
}

function draft(id: string, status: LedgerV1["status"] = "awaiting-approval"): LedgerV1 {
  const value = buildDraft(0, id);
  value.status = status;
  value.repo = { ...value.repo, toplevel: REPO, baseCommit: SHA };
  value.orchestrator.sessionID = `owner-${id}`;
  value.config = { ...value.config, slotsDir: `C:/slots/${id}`, land: "manual", phaseSuite: "off" };
  return value;
}

function queueDouble() {
  const pending: string[] = [];
  return { enqueue: vi.fn<IntegrationQueue["enqueue"]>(ids => { for (const id of ids) if (!pending.includes(id)) pending.push(id); }),
    resume: vi.fn<IntegrationQueue["resume"]>(async () => ({ completed: [], rolledBack: [], halted: false, entries: [] })),
    checkPhase: vi.fn<IntegrationQueue["checkPhase"]>(async () => {}), land: vi.fn<IntegrationQueue["land"]>(async () => ({ landed: false, inbox: null })),
    abort: vi.fn<IntegrationQueue["abort"]>(async () => {}), queued: () => pending.slice(), dispose: async () => {} };
}

async function rig(checkSlotsDir?: RuntimeDeps["checkSlotsDir"], realAnswers = false) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-runtime-slots-"))); roots.push(root);
  const store = createLedgerStore({ home: root });
  const facade = pool("facade"), pools = new Map<string, ReturnType<typeof pool>>();
  const parts = new Map<string, CollaboratorInput>();
  const queues = new Map<string, ReturnType<typeof queueDouble>>();
  const clock = createNodeClock();
  const slotsFor = vi.fn((id: string) => {
    let result = pools.get(id);
    if (result === undefined) { result = pool(id); pools.set(id, result); }
    return result;
  });
  let next = draft("plan-a");
  const unexpected = async (): Promise<never> => { throw new Error("unexpected collaborator call"); };
  const deps: RuntimeDeps = {
    store, slots: facade, slotsFor, ...(checkSlotsDir ? { checkSlotsDir } : {}),
    compiler: { compile: async () => ({ draft: structuredClone(next), summary: { tasks: 0, phases: 1, edges: 0,
      workMs: 0, criticalPathMs: 0, width: 0, expectedMakespanMs: 0, manual: [], warnings: [] } }),
      mergeResidue: () => { throw new Error("unexpected residue"); }, addTasks: () => { throw new Error("unexpected addTasks"); }, validate: () => [] },
    scheduler: createScheduler(),
    launcher: { gate: () => ({ ok: false, reason: "disposed", wake: null }), launch: () => { throw new Error("unexpected launch"); },
      cancel: async () => {}, inFlight: () => [], dispose: async () => {} },
    routes: { route: () => ({ agent: "implementer", model: { providerID: "test", modelID: "test", variant: null }, provider: "test", heavy: false }) },
    verifier: { verify: async () => ({ verdict: "pass", findings: "", ref: "proof" }) },
    git: { run: async (args) => ({ code: args[0] === "config" ? 1 : 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0 }) },
    hosts: { get: async (id) => ({ id, parentID: null }), context: async () => ({ messages: [] }), activity: async () => "inactive",
      interrupt: async () => {}, synthetic: async () => {}, move: async () => {}, onEvent: () => () => {} },
    clock, leaseRegistry: { acquireWrite: () => ({ ok: true }), holderOf: () => null, releaseTask: () => {} },
    recovery: null, holder: (sessionID) => holderOf(sessionID, process.pid, hostname()), capacity: createCapacityController,
    collaborators: (input) => {
      parts.set(input.writer.planId, input);
      const queue = queueDouble(); queues.set(input.writer.planId, queue);
      if (realAnswers) return realCollaborators({ queue: () => queue, clock, log() {} })(input);
      return { queue,
        policy: { raise: unexpected, park: unexpected, answer: async () => ({ resumed: null }), unblock: async () => [], recordAttempt: async () => ({ tripped: false }) },
        qa: { parse: () => ({ ok: false, error: "unused" }), onQaResult: unexpected, onAwaitingQa: async () => {}, onCapAnswer: unexpected } };
    },
    pinOrchestrator: () => () => {}, log() {}, config: () => next.config, bindings: { bind() {}, evict() {} }, toplevel: REPO,
  };
  const runtime = createExecutorRuntime(deps); runtimes.push(runtime);
  return { runtime, store, facade, pools, slotsFor, parts, queues, deps, root, async compile(value: LedgerV1) {
    expect(ledgerViolations(value)).toEqual([]);
    expect(isLedgerV1(value)).toBe(true);
    next = value;
    await runtime.compile({ path: value.planPath, sessionID: value.orchestrator.sessionID });
  } };
}

async function queuedAnswerRig(kind: "breaker" | "qa-cap") {
  const h = await rig(undefined, true), value = draft("plan-a");
  value.phases[0]!.paused = true;
  if (kind === "qa-cap") { value.phases[0]!.gate = "awaiting-qa"; value.config.qaMaxRounds = 1; }
  value.phases.push({ ...value.phases[0]!, id: "p2", title: "Still paused", gate: "pending" });
  value.waves[0]!.phases.push("p2");
  value.tasks.M = taskNode("M", { kind: "manual", state: "ready" });
  // `task-created` admits only pending/done tasks without attempts or slot, so the slot-holding verified tasks ship in
  // the draft, as in "routes identical slot names to their plan pool" below.
  const verified = (id: string, phase: string) => taskNode(id, { phase, state: "verified", slot: `slot-${phase === "p1" ? 1 : 2}`, branch: `omr/plan-a/t/${id}`,
    attempts: [{ ...openAttempt(1), outcome: "succeeded", verdict: "pass", endedAt: "2026-10-11T00:00:01.000Z" }],
    footprint: { writes: [`${id}.ts`], reads: [], confidence: "explicit", sources: ["path"] } });
  value.tasks.T1 = verified("T1", "p1"); value.tasks.T2 = verified("T2", "p2");
  // The first-round review id is `<phase>.QA` (reviewTaskId covers rounds 2-999 only).
  const qaId = "p1.QA", inboxId = kind === "breaker" ? "B-1" : "R-1";
  const capReport = { findings: [{ id: "F1", severity: "major", files: ["T1.ts"], problem: "still wrong", fix: "fix it" }] };
  // `task-created` also refuses attempts, so the finished first QA round (with its report) ships in the draft too.
  if (kind === "qa-cap") value.tasks[qaId] = taskNode(qaId, { kind: "qa", state: "done",
    attempts: [{ ...openAttempt(1), outcome: "succeeded", endedAt: "2026-10-11T00:00:01.000Z", context: JSON.stringify(capReport) }] });
  await h.compile(value); await h.runtime.approve(value.planId, value.orchestrator.sessionID); await h.runtime.settled();
  const input = h.parts.get(value.planId), queue = h.queues.get(value.planId);
  if (input === undefined || queue === undefined) throw new Error("answer collaborators missing");
  await input.writer.append([
    { type: "inbox-added", item: { id: inboxId, kind, severity: "critical", taskId: kind === "breaker" ? "T1" : qaId,
      text: "paused phase", options: kind === "breaker" ? ["continue"] : ["accept", "fix"], answer: null, createdAt: h.deps.clock.iso() } },
  ]);
  // Simulate entries retained in the FIFO when the queue last found only paused phases.
  queue.enqueue(["T1", "T2"]); queue.enqueue.mockClear();
  return { ...h, input, queue, inboxId, qaId };
}

describe("QA-5.1 runtime fixes", () => {
  it("QA-5.1-9: an enqueue that throws after the answer is journaled still resolves the answer and schedules the plan", async () => {
    const h = await queuedAnswerRig("breaker");
    h.queue.enqueue.mockImplementation(() => { throw new ExecutorError("E_PLAN_STATE", "integration queue refused", { planId: "plan-a" }); });
    const calls: string[] = [];
    const scheduler = h.deps.scheduler as unknown as Record<string, unknown>;
    for (const [key, fn] of Object.entries(scheduler)) {
      if (typeof fn === "function") scheduler[key] = (...args: unknown[]) => { calls.push(key); return (fn as (...a: unknown[]) => unknown).apply(h.deps.scheduler, args); };
    }
    const gate = h.deps.launcher.gate;
    h.deps.launcher.gate = (sessionID) => { calls.push("gate"); return gate(sessionID); };
    await expect(h.runtime.answer("plan-a", h.inboxId, "continue", "owner-plan-a")).resolves.toBeUndefined();
    expect(h.queue.enqueue).toHaveBeenCalledOnce();
    expect(h.input.writer.ledger.inbox.find(item => item.id === h.inboxId)?.answer).toBe("continue");
    await h.runtime.settled();
    expect(calls.length).toBeGreaterThan(0);
  }, 15_000);

  it("QA-5.1-7: settled phase tags: an aborted plan needs none; a completed one counts tagged, exists-other and gave-up tags", () => {
    const l = draft("plan-a", "completed");
    expect(planTagsSettled(l)).toBe(true); // no passed phase: nothing to tag
    l.phases[0]!.gate = "passed";
    expect(planTagsSettled(l)).toBe(false);
    expect(planTagsSettled({ ...l, status: "aborted" })).toBe(true);
    expect(planTagsSettled({ ...l, phases: [{ ...l.phases[0]!, tag: "omr/plan-a/p1" }] })).toBe(true);
    const name = phaseTagName("plan-a", l.phases[0]!.id);
    const item = (text: string, taskId: string | null = null) => ({ id: "F-1", kind: "failure" as const, severity: "info" as const, taskId, text,
      options: [], answer: null, createdAt: "2026-10-13T00:00:00.000Z" });
    expect(planTagsSettled({ ...l, inbox: [item(`The phase tag ${name} already exists at ${SHA}, not at x; it is never moved.`)] })).toBe(true);
    expect(planTagsSettled({ ...l, inbox: [item(`The phase tag ${name} could not be created after 4 rounds of 3 tries (boom). Create it by hand.`)] })).toBe(true);
    // Another phase's tag, or a task's failure item, settles nothing.
    expect(planTagsSettled({ ...l, inbox: [item(`The phase tag ${phaseTagName("plan-a", "other")} already exists at x`)] })).toBe(false);
    expect(planTagsSettled({ ...l, inbox: [item(`The phase tag ${name} already exists at x`, "T1")] })).toBe(false);
  });

  it("QA-5.1-7: the collection re-check backs off from 100 ms, doubling, capped at 30 s", () => {
    const seq: number[] = [];
    let delay = COLLECT_RETRY_BASE_MS;
    for (let i = 0; i < 12; i++) { seq.push(delay); delay = nextCollectDelay(delay); }
    expect(seq.slice(0, 4)).toEqual([100, 200, 400, 800]);
    expect(COLLECT_RETRY_MAX_MS).toBe(30_000);
    expect(Math.max(...seq)).toBe(30_000);
    expect(seq.slice(-3)).toEqual([30_000, 30_000, 30_000]);
  });

  it("QA-5.1-7: an aborted plan with an untagged passed phase is collected, and a manual gc collects it without tag quiescence", async () => {
    const h = await rig(), value = draft("plan-b");
    value.phases[0]!.gate = "passed";
    await h.compile(value);
    await h.runtime.abort("plan-b", "owner-plan-b");
    await h.runtime.settled();
    expect(h.pools.get("plan-b")?.gc).toHaveBeenCalledOnce();
    await h.runtime.gc();
    const predicate = h.facade.gc.mock.calls[0]?.[0];
    if (predicate === undefined) throw new Error("missing manual gc predicate");
    expect(await predicate("plan-b")).toBe(true);
  }, 15_000);

  it("QA-5.1-19: a manual gc keeps an idle completed plan's slots while a phase tag is pending, and says so", async () => {
    const h = await rig(), value = draft("plan-c");
    // No task and a passed phase: approval completes the plan at once, with its phase tag still to be created.
    value.phases[0]!.gate = "passed";
    await h.compile(value);
    await h.runtime.approve("plan-c", "owner-plan-c");
    await h.runtime.settled();
    const writer = h.parts.get("plan-c")?.writer;
    if (writer === undefined) throw new Error("missing writer");
    expect(writer.ledger.status).toBe("completed");
    expect(writer.ledger.phases[0]?.tag).toBeNull();
    expect(writer.openIntegration()).toEqual([]); // idle: between tag retries the queue rolled its entry back
    h.facade.gc.mockImplementation(async (isFinished) =>
      ((await isFinished("plan-c")) === true ? { removed: ["C:/slots/plan-c/integration"], reported: [] } : { removed: [], reported: [] }));
    const refused = await h.runtime.gc();
    expect(refused.removed).toEqual([]);
    expect(refused.reported).toEqual([`plan plan-c: ${GC_TAG_PENDING}`]);
    // Once the queue settled the tag (here: it gave up, which leaves its failure item), the manual gc collects the plan.
    const name = phaseTagName("plan-c", value.phases[0]!.id);
    await writer.append([{ type: "inbox-added", item: { id: "F-1", kind: "failure", severity: "info", taskId: null,
      text: `The phase tag ${name} could not be created after 4 rounds of 3 tries (boom). Create it by hand.`, options: [], answer: null,
      createdAt: h.deps.clock.iso() } }]);
    const collected = await h.runtime.gc();
    expect(collected).toEqual({ removed: ["C:/slots/plan-c/integration"], reported: [] });
  }, 15_000);

  it("QA-5.1-4: dispose cuts the verifier first, before the launcher and the wait for running work", async () => {
    const h = await rig();
    const order: string[] = [];
    h.deps.verifier.dispose = async () => { order.push("verifier"); };
    h.deps.launcher.dispose = async () => { order.push("launcher"); };
    await h.runtime.dispose();
    expect(order).toEqual(["verifier", "launcher"]);
  }, 15_000);

  it("QA-5.1-4: a verify cut by dispose leaves the task verifying, uses no attempt and no breaker sample; the next start re-verifies it", async () => {
    const h = await rig();
    const value = draft("plan-a", "running");
    value.tasks.T1 = taskNode("T1", { state: "verifying", slot: "slot-1", branch: "omr/plan-a/t/T1",
      attempts: [{ ...openAttempt(1), outcome: "succeeded", endedAt: "2026-10-11T00:00:01.000Z" }],
      footprint: { writes: ["T1.ts"], reads: [], confidence: "explicit", sources: ["path"] } });
    expect(ledgerViolations(value)).toEqual([]);
    const created = await h.store.create(value, holderOf(value.orchestrator.sessionID, process.pid, hostname())); await created.close();
    // The slot's marker (slotLeaseOf reads its slot, path and commit).
    h.slotsFor("plan-a").get.mockResolvedValue({ slot: "slot-1", path: "C:/slots/plan-a/slot-1", commit: SHA } as unknown as NonNullable<Awaited<ReturnType<SlotPool["get"]>>>);
    const recordAttempt = vi.fn(async () => ({ tripped: false }));
    const collaborators = h.deps.collaborators;
    h.deps.collaborators = (input) => { const c = collaborators(input); c.policy.recordAttempt = recordAttempt; return c; };
    // A verifier whose gate hangs until dispose cuts it, as plan-task's does (unverifiable "the plugin is shutting down").
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let cut: (() => void) | null = null;
    const hanging = {
      disposing: false,
      verify: vi.fn(() => new Promise<{ verdict: "unverifiable"; findings: string; ref: string; cut: true }>((resolve) => {
        cut = () => resolve({ verdict: "unverifiable", findings: "the plugin is shutting down", ref: "none", cut: true });
        entered();
      })),
      async dispose() { hanging.disposing = true; cut?.(); },
    };
    h.deps.verifier = hanging;
    // R2: recovery classifies the `verifying` task for a re-verification at every start.
    const feed = { taskId: "T1", from: "verifying", action: "reverify", n: 1, slotValid: true, orphans: [], probation: null, context: null } as unknown as ReconcileFeed;
    // L2: only a plan recover() reports is reconciled; its report's feeds are the first activation's classification.
    const reports = [{ planId: "plan-a", actions: [feed] }] as unknown as Awaited<ReturnType<NonNullable<RuntimeDeps["recovery"]>["recover"]>>;
    h.deps.recovery = { recover: async () => reports, adopt: async () => {}, reconcile: async () => [feed] };
    // start awaits the recovery, which awaits the hanging verify: only dispose can end it.
    const starting = h.runtime.start();
    await started;
    const t0 = Date.now();
    await h.runtime.dispose();
    await starting.catch(() => {});
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(hanging.verify).toHaveBeenCalledOnce();
    const after = await h.store.read("plan-a");
    expect(after.tasks.T1?.state).toBe("verifying");
    expect(after.tasks.T1?.attempts).toHaveLength(1);
    expect(after.tasks.T1?.attempts[0]?.verdict).toBeNull();
    expect((await h.store.exportPlan("plan-a")).events.some((e) => e.type === "attempt-verdict")).toBe(false);
    expect(recordAttempt).not.toHaveBeenCalled();
    // The next start re-verifies the task (R2) and its verdict is journaled then.
    const verify = vi.fn(async () => ({ verdict: "pass" as const, findings: "", ref: "proof" }));
    const next = createExecutorRuntime({ ...h.deps, verifier: { verify } }); runtimes.push(next);
    await next.start();
    await next.settled();
    expect(verify).toHaveBeenCalledOnce();
    const reverified = await h.store.read("plan-a");
    expect(reverified.tasks.T1?.attempts[0]?.verdict).toBe("pass");
    expect(reverified.tasks.T1?.state).not.toBe("verifying");
    expect(reverified.tasks.T1?.state).not.toBe("failed");
  }, 30_000);

  it("QA-5.1-21: a real verdict that resolves after dispose began (decided before it) is journaled; only a cut is discarded", async () => {
    const h = await rig();
    const value = draft("plan-a", "running");
    value.tasks.T1 = taskNode("T1", { state: "verifying", slot: "slot-1", branch: "omr/plan-a/t/T1",
      attempts: [{ ...openAttempt(1), outcome: "succeeded", endedAt: "2026-10-11T00:00:01.000Z" }],
      footprint: { writes: ["T1.ts"], reads: [], confidence: "explicit", sources: ["path"] } });
    const created = await h.store.create(value, holderOf(value.orchestrator.sessionID, process.pid, hostname())); await created.close();
    h.slotsFor("plan-a").get.mockResolvedValue({ slot: "slot-1", path: "C:/slots/plan-a/slot-1", commit: SHA } as unknown as NonNullable<Awaited<ReturnType<SlotPool["get"]>>>);
    // The verdict was decided (and handed to onVerdict) before dispose; its promise settles only after dispose began.
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let settle: (() => void) | null = null;
    const late = {
      disposing: false,
      verify: vi.fn(() => new Promise<{ verdict: "pass"; findings: string; ref: string }>((resolve) => {
        settle = () => resolve({ verdict: "pass", findings: "", ref: "proof" });
        entered();
      })),
      async dispose() { late.disposing = true; settle?.(); },
    };
    h.deps.verifier = late;
    const feed = { taskId: "T1", from: "verifying", action: "reverify", n: 1, slotValid: true, orphans: [], probation: null, context: null } as unknown as ReconcileFeed;
    const reports = [{ planId: "plan-a", actions: [feed] }] as unknown as Awaited<ReturnType<NonNullable<RuntimeDeps["recovery"]>["recover"]>>;
    h.deps.recovery = { recover: async () => reports, adopt: async () => {}, reconcile: async () => [feed] };
    const starting = h.runtime.start();
    await started;
    await h.runtime.dispose();
    await starting.catch(() => {});
    expect(late.verify).toHaveBeenCalledOnce();
    const after = await h.store.read("plan-a");
    expect(after.tasks.T1?.attempts[0]?.verdict).toBe("pass");
    expect(after.tasks.T1?.state).toBe("verified");
    expect((await h.store.exportPlan("plan-a")).events.filter((e) => e.type === "attempt-verdict")).toHaveLength(1);
  }, 30_000);
});

describe("U1: runtime plan-scoped slots", () => {
  it("a breaker answer re-enqueues only the newly unpaused phase, after the answer is durable", async () => {
    const h = await queuedAnswerRig("breaker");
    const enqueue = h.queue.enqueue.getMockImplementation()!;
    h.queue.enqueue.mockImplementation(ids => {
      expect(h.input.writer.ledger.phases[0]?.paused).toBe(false);
      expect(h.input.writer.ledger.inbox.find(item => item.id === h.inboxId)?.answer).toBe("continue");
      enqueue(ids);
    });
    await h.runtime.answer("plan-a", h.inboxId, "continue", "owner-plan-a");
    expect(h.queue.enqueue).toHaveBeenCalledExactlyOnceWith(["T1"]);
    expect(h.queue.queued()).toEqual(["T1", "T2"]); // Idempotent kick: no duplicated FIFO entry.
    expect(h.input.writer.ledger.phases[1]?.paused).toBe(true);
    expect(h.input.writer.ledger.tasks.T1?.state).toBe("verified");
  }, 15_000);

  it.each(["accept", "fix"] as const)("a real QA-cap %s answer restarts already-queued work of its unpaused phase", async choice => {
    const h = await queuedAnswerRig("qa-cap");
    await h.runtime.answer("plan-a", h.inboxId, choice, "owner-plan-a");
    expect(h.input.writer.ledger.phases[0]).toMatchObject({ paused: false, gate: choice === "accept" ? "passed" : "pending",
      qaRound: choice === "accept" ? 1 : 2 });
    expect(h.queue.enqueue).toHaveBeenCalledExactlyOnceWith(["T1"]);
    expect(h.queue.queued()).toEqual(["T1", "T2"]);
    expect(h.input.writer.ledger.phases[1]?.paused).toBe(true);
    expect(h.input.writer.ledger.inbox.find(item => item.id === h.inboxId)?.answer).toBe(choice);
    if (choice === "fix") expect(h.input.writer.ledger.tasks["p1.FIX1-1"]).toBeDefined();
  }, 15_000);

  it("an answer while the plan is paused leaves integration stopped; user resume already kicks the queued work", async () => {
    const h = await queuedAnswerRig("breaker");
    await h.runtime.pause("plan-a", "owner-plan-a");
    await h.runtime.answer("plan-a", h.inboxId, "continue", "owner-plan-a");
    expect(h.input.writer.ledger.phases[0]?.paused).toBe(false);
    expect(h.input.writer.ledger.status).toBe("paused");
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    await h.runtime.resume("plan-a", "owner-plan-a");
    expect(h.input.writer.ledger.status).toBe("running");
    expect(h.queue.checkPhase.mock.calls.map(([id]) => id)).toEqual(["p1", "p2"]);
    expect(h.queue.enqueue).toHaveBeenCalledExactlyOnceWith(["T1", "T2"]);
    expect(h.queue.queued()).toEqual(["T1", "T2"]);
    expect(h.input.writer.ledger.phases[1]?.paused).toBe(true);
  }, 15_000);

  it.each(["breaker", "qa-cap"] as const)("a %s answer does not kick a phase still paused by another critical item", async kind => {
    const h = await queuedAnswerRig(kind);
    await h.input.writer.append([{ type: "inbox-added", item: { id: "F-2", kind: "failure", severity: "critical", taskId: "T1",
      text: "another phase blocker", options: [], answer: null, createdAt: h.deps.clock.iso() } }]);
    await h.runtime.answer("plan-a", h.inboxId, kind === "breaker" ? "continue" : "accept", "owner-plan-a");
    expect(h.input.writer.ledger.phases[0]?.paused).toBe(true);
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.queue.queued()).toEqual(["T1", "T2"]);
  }, 15_000);

  it.each(["running", "paused"] as const)("foreign %s startup is read-only: no lock, epoch, journal, mtime or status change", async status => {
    const h = await rig(), value = draft("foreign-plan", status);
    value.repo.toplevel = "C:/another-repository";
    value.tasks.T1 = taskNode("T1", { kind: "manual", state: "ready" });
    expect(isLedgerV1(value)).toBe(true);
    const writer = await h.store.create(value, holderOf(value.orchestrator.sessionID, process.pid, hostname())); await writer.close();
    const directory = planDir(h.root, value.planId);
    const inventory = async () => Promise.all(["", ...(await readdir(directory, { recursive: true })).sort()].map(async name => {
      const info = await stat(join(directory, name));
      return { name, mtimeMs: info.mtimeMs, size: info.size };
    }));
    const before = await inventory(), exported = await h.store.exportPlan(value.planId);
    const open = vi.spyOn(h.store, "open"), takeover = vi.spyOn(h.store, "takeover");
    await h.runtime.start();
    expect(await h.runtime.status(value.planId, value.orchestrator.sessionID)).toContain("Foreign:");
    expect(h.runtime.planLine(value.orchestrator.sessionID)).toContain(value.planId);
    expect(open).not.toHaveBeenCalled(); expect(takeover).not.toHaveBeenCalled();
    await expect(stat(join(directory, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inventory()).toEqual(before);
    expect(await h.store.exportPlan(value.planId)).toEqual(exported);
    const view = h.parts.get(value.planId)?.writer;
    if (view === undefined) throw new Error("foreign read-only attachment missing");
    await expect(view.append([])).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(view.snapshot()).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(h.runtime.abort(value.planId, value.orchestrator.sessionID)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await h.runtime.dispose();
    expect(await inventory()).toEqual(before);
    expect(await h.store.exportPlan(value.planId)).toEqual(exported);
  }, 15_000);

  it.each([false, true])("foreign adopt refuses before recovery or writer opening (attached=%s)", async attached => {
    const h = await rig(), value = draft("foreign-plan", "running"); value.repo.toplevel = "C:/another-repository";
    const writer = await h.store.create(value, holderOf(value.orchestrator.sessionID, process.pid, hostname())); await writer.close();
    const adopt = vi.fn(async () => {});
    h.deps.recovery = { recover: async () => [], adopt };
    const open = vi.spyOn(h.store, "open"), takeover = vi.spyOn(h.store, "takeover");
    if (attached) await h.runtime.start();
    await expect(h.runtime.adopt(value.planId, "new-owner")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(adopt).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(takeover).not.toHaveBeenCalled();
    await expect(stat(join(planDir(h.root, value.planId), "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("a foreign compiled draft is refused before creating a writer or plan directory", async () => {
    const h = await rig(), value = draft("foreign-plan"); value.repo.toplevel = "C:/another-repository";
    const create = vi.spyOn(h.store, "create");
    await expect(h.compile(value)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(create).not.toHaveBeenCalled(); expect(h.parts.size).toBe(0);
    await expect(stat(planDir(h.root, value.planId))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("planFor re-reads before opening and a newly foreign snapshot cannot reach mutation collaborators", async () => {
    const h = await rig(), foreign = draft("foreign-plan"); foreign.repo.toplevel = "C:/another-repository";
    const writer = await h.store.create(foreign, holderOf(foreign.orchestrator.sessionID, process.pid, hostname())); await writer.close();
    const local = structuredClone(foreign); local.repo.toplevel = REPO;
    vi.spyOn(h.store, "read").mockResolvedValueOnce(local).mockResolvedValue(foreign);
    const open = vi.spyOn(h.store, "open");
    await expect(h.runtime.approve(foreign.planId, foreign.orchestrator.sessionID)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(open).not.toHaveBeenCalled();
    expect(await h.runtime.status(foreign.planId, foreign.orchestrator.sessionID)).toContain("Foreign:");
    expect(h.parts.get(foreign.planId)?.writer.ledger.repo.toplevel).toBe(foreign.repo.toplevel);
    await expect(stat(join(planDir(h.root, foreign.planId), "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it.each(["throws", "returns"] as const)("adopt recovery that %s with a foreign snapshot reattaches read-only without opening (QA-4.2-35)", async outcome => {
    const h = await rig(), value = draft("plan-a", "paused");
    await h.compile(value);
    const foreign = structuredClone(value); foreign.repo.toplevel = "C:/another-repository";
    h.deps.recovery = { recover: async () => [], adopt: async () => {
      vi.spyOn(h.store, "read").mockResolvedValue(foreign);
      if (outcome === "throws") throw new Error("adoption failed");
    } };
    const open = vi.spyOn(h.store, "open"), takeover = vi.spyOn(h.store, "takeover");
    await expect(h.runtime.adopt(value.planId, value.orchestrator.sessionID)).rejects.toThrow(outcome === "throws" ? "adoption failed" : "another repository");
    expect(open).not.toHaveBeenCalled(); expect(takeover).not.toHaveBeenCalled();
    expect(await h.runtime.status(value.planId, value.orchestrator.sessionID)).toContain("Foreign:");
    expect(h.parts.get(value.planId)?.writer.ledger.repo.toplevel).toBe(foreign.repo.toplevel);
    await expect(stat(join(planDir(h.root, value.planId), "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("routes identical slot names to their plan pool and collects only that plan, once", async () => {
    const h = await rig();
    for (const id of ["plan-a", "plan-b"]) {
      const value = draft(id);
      value.tasks.T1 = taskNode("T1", { state: "verified", slot: "slot-1", branch: `omr/${id}/t/T1`,
        attempts: [{ ...openAttempt(1), endedAt: "2026-10-11T00:00:01.000Z", outcome: "succeeded", verdict: "pass" }] });
      await h.compile(value);
    }
    const aPool = h.slotsFor("plan-a");
    await h.runtime.abort("plan-b", "owner-plan-b");
    const b = h.pools.get("plan-b");
    if (b === undefined) throw new Error("B pool was not selected");
    expect(b.release).toHaveBeenCalledExactlyOnceWith("slot-1");
    expect(aPool.release).not.toHaveBeenCalled();
    expect(h.facade.release).not.toHaveBeenCalled();
    expect(b.gc).toHaveBeenCalledOnce();
    const predicate = b.gc.mock.calls[0]?.[0];
    if (predicate === undefined) throw new Error("missing collection predicate");
    expect(await predicate("plan-b")).toBe(true);
    expect(await predicate("plan-a")).toBe(false);
    expect(await predicate("unknown")).toBe(false);
    await h.runtime.abort("plan-a", "owner-plan-a");
    const a = h.pools.get("plan-a");
    if (a === undefined) throw new Error("A pool was not selected");
    expect(a.release).toHaveBeenCalledExactlyOnceWith("slot-1");
    expect(a.gc).toHaveBeenCalledOnce();
    for (let tick = 0; tick < 3; tick++) {
      h.runtime.onRouterToolCall("owner-plan-a"); h.runtime.onRouterToolCall("owner-plan-b");
      await h.runtime.settled();
    }
    expect(a.gc).toHaveBeenCalledOnce();
    expect(b.gc).toHaveBeenCalledOnce();
    expect(h.facade.gc).not.toHaveBeenCalled();
  }, 15_000);

  it("checks slotsDir at approval before journaling approval or resuming integration", async () => {
    const check = vi.fn<NonNullable<RuntimeDeps["checkSlotsDir"]>>(() => { throw new ExecutorError("E_INVALID_INPUT", "invalid slots root"); });
    const h = await rig(check);
    await h.compile(draft("plan-a"));
    await expect(h.runtime.approve("plan-a", "owner-plan-a")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(check).toHaveBeenCalledWith("C:/slots/plan-a", REPO);
    expect((await h.store.exportPlan("plan-a")).events.some(event => event.type === "plan-approved")).toBe(false);
    expect((await h.store.read("plan-a")).status).toBe("awaiting-approval");
    expect(h.slotsFor).not.toHaveBeenCalled();
  }, 15_000);

  it("waits for approve-time validation of the resolved default root before writing plan-approved", async () => {
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const check = vi.fn<NonNullable<RuntimeDeps["checkSlotsDir"]>>(() => hold);
    const h = await rig(check), value = draft("plan-a");
    value.config.slotsDir = null;
    await h.compile(value);
    const approving = h.runtime.approve("plan-a", "owner-plan-a");
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(check).toHaveBeenCalledWith(defaultSlotsDir(REPO, "plan-a"), REPO);
    expect((await h.store.exportPlan("plan-a")).events.some(event => event.type === "plan-approved")).toBe(false);
    release(); await approving;
    expect((await h.store.exportPlan("plan-a")).events.filter(event => event.type === "plan-approved")).toHaveLength(1);
    expect((await h.store.read("plan-a")).config.slotsDir).toBe(defaultSlotsDir(REPO, "plan-a"));
  }, 15_000);

  it("checks ownership before store.open, attachment, pool lookup or pinning", async () => {
    const h = await rig();
    const value = draft("plan-a");
    expect(isLedgerV1(value)).toBe(true);
    const writer = await h.store.create(value, holderOf("owner-plan-a", process.pid, hostname()));
    await writer.close();
    const open = vi.spyOn(h.store, "open");
    await expect(h.runtime.approve("plan-a", "intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    await expect(h.runtime.abort("plan-a", "intruder")).rejects.toMatchObject({ code: "E_NOT_OWNER" });
    expect(open).not.toHaveBeenCalled();
    expect(h.parts.size).toBe(0);
    expect(h.slotsFor).not.toHaveBeenCalled();
    expect((await h.store.read("plan-a")).orchestrator.sessionID).toBe("owner-plan-a");
  }, 15_000);
});
