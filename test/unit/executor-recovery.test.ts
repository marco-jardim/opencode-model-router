// Service-level tests of RecoveryService (plan task 4.2.4): classifyChild, the reconciliation matrix, orphans, eligibility, adopt.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLedgerStore } from "../../src/executor/ledger.js";
import { FakeClock, FakeProc } from "../fixtures/cpx/ledger/fakes.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";
import {
  RECOVERY_LIVENESS_MS, RECOVERY_POLL_MS, classifyChild, createRecoveryService, sameToplevel,
} from "../../src/executor/recovery.js";
import type { ReconcileFeed, RecoveryEngine, RecoveryHost } from "../../src/executor/recovery.js";
import { formatLaunchPrompt } from "../../src/executor/types.js";
import type {
  Attempt, Clock, HostSessionContext, IsoTime, LedgerStore, LedgerV1, LedgerWriter, ReconcileAction, TaskNode, TaskState,
} from "../../src/executor/types.js";
import { PLAN_ID, T0, buildDraft, holderOf, nonceFor, openAttempt, taskNode } from "../fixtures/cpx/ledger/builders.js";

const PLAN = PLAN_ID;
const SHARED = "shared notes";
const NONCE = "a".repeat(32);
const EXPECT = { planId: PLAN, taskId: "T1", n: 1, nonce: NONCE };
const INFO = { id: "ses-c", parentID: "ses-0" };

function promptFor(h: { planId: string; taskId: string; attempt: number; nonce: string }, shared: string = SHARED): string {
  return formatLaunchPrompt(shared, h, "TASK T1\ndo it");
}
function ctxOf(prompt: string | null, tail: Array<"assistant" | "idle"> = []): HostSessionContext {
  const messages: HostSessionContext["messages"] = [];
  if (prompt !== null) messages.push({ role: "user", text: prompt, outcome: null });
  for (const r of tail) messages.push({ role: r, text: r === "assistant" ? "done" : null, outcome: null });
  return { messages };
}
const GOOD = promptFor({ planId: PLAN, taskId: "T1", attempt: 1, nonce: NONCE });

describe("classifyChild (R1 rules 3-6)", () => {
  it("get null is lost", () => {
    expect(classifyChild(null, null, "unknown", EXPECT)).toBe("lost");
  });

  it.each([
    ["plan", { planId: "plan-two", taskId: "T1", attempt: 1, nonce: NONCE }],
    ["task", { planId: PLAN, taskId: "T2", attempt: 1, nonce: NONCE }],
    ["attempt", { planId: PLAN, taskId: "T1", attempt: 2, nonce: NONCE }],
    ["nonce", { planId: PLAN, taskId: "T1", attempt: 1, nonce: "b".repeat(32) }],
  ])("a header naming another %s is a mismatch", (_f, h) => {
    expect(classifyChild(INFO, ctxOf(promptFor(h)), "active", EXPECT)).toBe("mismatch");
  });

  it("a missing, empty or unparsable first message is a mismatch", () => {
    expect(classifyChild(INFO, null, "active", EXPECT)).toBe("mismatch");
    expect(classifyChild(INFO, ctxOf(null), "active", EXPECT)).toBe("mismatch");
    expect(classifyChild(INFO, ctxOf("hello"), "active", EXPECT)).toBe("mismatch");
    expect(classifyChild(INFO, ctxOf(`note\n\n[plan ${PLAN}:T1#1] nonce=${NONCE}\n\nTASK x`), "active", EXPECT)).toBe("mismatch");
  });

  it("the parent is not checked", () => {
    expect(classifyChild({ id: "ses-c", parentID: null }, ctxOf(GOOD), "active", EXPECT)).toBe("alive");
  });

  it("a last idle message is finished, whatever the activity", () => {
    const c = ctxOf(GOOD, ["assistant", "idle"]);
    for (const a of ["active", "inactive", "unknown"] as const) expect(classifyChild(INFO, c, a, EXPECT)).toBe("finished");
  });

  it("maps active, inactive and unknown activity", () => {
    const c = ctxOf(GOOD, ["assistant"]);
    expect(classifyChild(INFO, c, "active", EXPECT)).toBe("alive");
    expect(classifyChild(INFO, c, "inactive", EXPECT)).toBe("lost");
    expect(classifyChild(INFO, c, "unknown", EXPECT)).toBe("unknown");
  });

  it("uses the supplied shared context when given", () => {
    const p = promptFor({ planId: PLAN, taskId: "T1", attempt: 1, nonce: NONCE }, "other");
    expect(classifyChild(INFO, ctxOf(p), "active", EXPECT, SHARED)).toBe("mismatch");
    expect(classifyChild(INFO, ctxOf(p), "active", EXPECT, "other")).toBe("alive");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// reconcile(): hand-built ledgers (the function reads a ledger value, so illegal-for-the-store shapes such as an
// `integrating` task without a queue entry can be classified), a typed host double and a slot-marker double.
// ---------------------------------------------------------------------------------------------------------------

type Activity = "active" | "inactive" | "unknown";
interface FakeSession { parentID: string | null; ctx: HostSessionContext; activity: Activity }

class FakeHost implements RecoveryHost {
  readonly sessions = new Map<string, FakeSession>();
  readonly calls: string[] = [];
  readonly interrupts: string[] = [];
  add(id: string, s: Partial<FakeSession> & { ctx: HostSessionContext }): void {
    this.sessions.set(id, { parentID: "ses-0", activity: "unknown", ...s });
  }
  async get(id: string): Promise<{ id: string; parentID: string | null } | null> {
    this.calls.push(`get:${id}`);
    const s = this.sessions.get(id);
    return s === undefined ? null : { id, parentID: s.parentID };
  }
  async context(id: string): Promise<HostSessionContext> {
    this.calls.push(`context:${id}`);
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error("not found");
    return s.ctx;
  }
  async activity(id: string): Promise<Activity> {
    this.calls.push(`activity:${id}`);
    return this.sessions.get(id)?.activity ?? "unknown";
  }
  async interrupt(id: string): Promise<void> {
    this.interrupts.push(id);
  }
}

const TOPLEVEL = "C:/repo";
const NOW = 1_000_000;
const clockAt = (ms: number): Clock => ({
  now: () => ms,
  iso: () => T0,
  setTimer: () => ({ id: 1 }),
  clearTimer: () => undefined,
  randomHex: (bytes: number) => "0".repeat(bytes * 2),
});

function childPrompt(taskId: string, n: number, planId: string = PLAN_ID): string {
  return formatLaunchPrompt(SHARED, { planId, taskId, attempt: n, nonce: nonceFor(n) }, `TASK ${taskId}\ndo it`);
}
type ChildKind = "finished" | "alive" | "unknown" | "lost" | "mismatch" | "foreign" | "none";

/** Registers the child `ses-<taskId>-<n>` in `kind` and returns its id (null for `none`). */
function child(host: FakeHost, taskId: string, n: number, kind: ChildKind): string | null {
  const id = `ses-${taskId}-${n}`;
  switch (kind) {
    case "none": return null;
    case "lost": return id;
    case "finished": host.add(id, { ctx: ctxOf(childPrompt(taskId, n), ["assistant", "idle"]) }); return id;
    case "alive": host.add(id, { ctx: ctxOf(childPrompt(taskId, n), ["assistant"]), activity: "active" }); return id;
    case "unknown": host.add(id, { ctx: ctxOf(childPrompt(taskId, n), ["assistant"]), activity: "unknown" }); return id;
    case "mismatch": host.add(id, { ctx: ctxOf(childPrompt(taskId, n + 1), ["assistant"]), activity: "active" }); return id;
    case "foreign": host.add(id, { ctx: ctxOf(childPrompt(taskId, n, "plan-two"), ["assistant"]), activity: "active" }); return id;
  }
}

function attempt(n: number, o: { child?: string | null; outcome?: Attempt["outcome"] } = {}): Attempt {
  const outcome = o.outcome ?? null;
  return {
    ...openAttempt(n), childSessionID: o.child ?? null,
    endedAt: outcome === null ? null : (T0 as IsoTime), outcome,
  };
}

function ledgerOf(...tasks: TaskNode[]): LedgerV1 {
  const l = buildDraft(0);
  l.edges = [];
  l.repo = { ...l.repo, toplevel: TOPLEVEL };
  for (const t of tasks) l.tasks[t.id] = t;
  return l;
}

interface Rig {
  host: FakeHost;
  markers: Map<string, { planId: string; taskId: string } | null>;
  svc: RecoveryEngine;
  logs: string[];
}
function rig(host: FakeHost = new FakeHost(), store?: LedgerStore): Rig {
  const markers = new Map<string, { planId: string; taskId: string } | null>();
  const logs: string[] = [];
  const svc = createRecoveryService({
    store: store ?? (new Proxy({}, { get: () => { throw new Error("store not expected"); } }) as LedgerStore),
    host, toplevel: TOPLEVEL, clock: clockAt(NOW),
    holder: (sessionID) => holderOf(sessionID, 4242, "host-a"),
    slotMarker: async (p) => (markers.has(p) ? (markers.get(p) ?? null) : { planId: PLAN_ID, taskId: p.replace(/^slot-/, "") }),
    log: (level, msg) => { logs.push(`${level}:${msg}`); },
  });
  return { host, markers, svc, logs };
}

async function feedOf(r: Rig, t: TaskNode, tracked: ReadonlySet<string> = new Set()): Promise<ReconcileFeed> {
  const feeds = await r.svc.reconcile(ledgerOf(t), tracked);
  const f = feeds.find((x) => x.taskId === t.id);
  if (f === undefined) throw new Error(`no feed for ${t.id}`);
  return f;
}

const PROBATION = { deadlineAt: NOW + RECOVERY_LIVENESS_MS, pollMs: RECOVERY_POLL_MS };

describe("reconcile: states that can have a child (matrix)", () => {
  describe("ready, latest attempt closed lost, slot set, child recorded", () => {
    const cases: Array<[ChildKind, Partial<ReconcileFeed>]> = [
      ["finished", { evidence: "finished", action: "adopt", probation: null }],
      ["alive", { evidence: "alive", action: "adopt", probation: null }],
      ["unknown", { evidence: "alive", action: "adopt", probation: PROBATION }],
      ["lost", { evidence: "lost", action: "none", probation: null }],
      ["none", { evidence: "none", action: "none", probation: null }],
      ["mismatch", { evidence: "lost", action: "none", mismatch: true, probation: null }],
    ];
    it.each(cases)("%s", async (kind, want) => {
      const r = rig();
      const c = child(r.host, "T1", 1, kind);
      const t = taskNode("T1", { state: "ready", slot: "slot-T1", attempts: [attempt(1, { child: c, outcome: "lost" })] });
      const f = await feedOf(r, t);
      expect(f).toMatchObject({ taskId: "T1", from: "ready", n: 1, childSessionID: c, slotValid: true, ...want });
      expect(f.orphans).toEqual(kind === "mismatch" && c !== null ? [c] : []);
      expect(r.host.interrupts).toEqual([]);
    });

    it("an unknown child carries the probation deadline now + livenessMs and pollMs", async () => {
      const r = rig();
      child(r.host, "T1", 1, "unknown");
      const t = taskNode("T1", { state: "ready", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1", outcome: "lost" })] });
      expect((await feedOf(r, t)).probation).toEqual({ deadlineAt: 1_060_000, pollMs: 10_000 });
    });

    it("a finished child's context is attached for the runtime's result mapper", async () => {
      const r = rig();
      child(r.host, "T1", 1, "finished");
      const t = taskNode("T1", { state: "ready", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1", outcome: "lost" })] });
      const f = await feedOf(r, t);
      expect(f.context?.messages.at(-1)?.role).toBe("idle");
    });
  });

  describe("ready, other (latest attempt not lost, or no slot)", () => {
    const cases: Array<[ChildKind, Partial<ReconcileFeed>, boolean]> = [
      ["finished", { evidence: "finished", action: "none" }, false],
      ["alive", { evidence: "alive", action: "interrupt-orphan" }, true],
      ["unknown", { evidence: "alive", action: "interrupt-orphan", probation: null }, true],
      ["lost", { evidence: "lost", action: "none" }, false],
      ["none", { evidence: "none", action: "none" }, false],
      ["mismatch", { evidence: "lost", action: "none", mismatch: true }, true],
    ];
    it.each(cases)("%s (latest failed, no slot)", async (kind, want, orphan) => {
      const r = rig();
      const c = child(r.host, "T1", 1, kind);
      const t = taskNode("T1", { state: "ready", attempts: [attempt(1, { child: c, outcome: "failed" })] });
      const f = await feedOf(r, t);
      expect(f).toMatchObject({ from: "ready", childSessionID: c, slotValid: null, ...want });
      expect(f.orphans).toEqual(orphan && c !== null ? [c] : []);
      expect(r.host.interrupts).toEqual([]);
    });

    it("a lost attempt without a slot is `other`: a live child is an orphan, not adopted", async () => {
      const r = rig();
      child(r.host, "T1", 1, "alive");
      const t = taskNode("T1", { state: "ready", attempts: [attempt(1, { child: "ses-T1-1", outcome: "lost" })] });
      expect(await feedOf(r, t)).toMatchObject({ action: "interrupt-orphan", orphans: ["ses-T1-1"] });
    });

    it("a ready task without attempts has no evidence", async () => {
      const f = await feedOf(rig(), taskNode("T1", { state: "ready" }));
      expect(f).toMatchObject({ evidence: "none", action: "none", n: null, childSessionID: null, orphans: [] });
    });
  });

  describe("dispatched", () => {
    it("is requeued at once, uncounted, whatever the host says (no child id yet)", async () => {
      const r = rig();
      const t = taskNode("T1", { state: "dispatched", slot: "slot-T1", attempts: [attempt(1)] });
      const f = await feedOf(r, t);
      expect(f).toMatchObject({ from: "dispatched", evidence: "none", action: "requeue-lost", n: 1, childSessionID: null, slotValid: true });
      expect(r.host.calls).toEqual([]);
    });
  });

  describe("running", () => {
    const cases: Array<[ChildKind, Partial<ReconcileFeed>]> = [
      ["finished", { evidence: "finished", action: "process-result", probation: null }],
      ["alive", { evidence: "alive", action: "adopt", probation: null }],
      ["unknown", { evidence: "alive", action: "adopt", probation: PROBATION }],
      ["lost", { evidence: "lost", action: "requeue-lost", probation: null }],
      ["none", { evidence: "none", action: "requeue-lost", probation: null }],
      ["mismatch", { evidence: "lost", action: "requeue-lost", mismatch: true, probation: null }],
    ];
    it.each(cases)("%s", async (kind, want) => {
      const r = rig();
      const c = child(r.host, "T1", 1, kind);
      const t = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: c })] });
      const f = await feedOf(r, t);
      expect(f).toMatchObject({ from: "running", n: 1, childSessionID: c, slotValid: true, ...want });
      expect(f.orphans).toEqual(kind === "mismatch" && c !== null ? [c] : []);
      expect(r.host.interrupts).toEqual([]);
    });

    it("an inactive child is lost (C12)", async () => {
      const r = rig();
      r.host.add("ses-T1-1", { ctx: ctxOf(childPrompt("T1", 1), ["assistant"]), activity: "inactive" });
      const t = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1" })] });
      expect(await feedOf(r, t)).toMatchObject({ evidence: "lost", action: "requeue-lost" });
    });

    it("a mismatching child that names another plan is requeued but never an orphan", async () => {
      const r = rig();
      child(r.host, "T1", 1, "foreign");
      const t = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1" })] });
      const f = await feedOf(r, t);
      expect(f).toMatchObject({ evidence: "lost", mismatch: true, action: "requeue-lost", orphans: [] });
    });

    it("a host error is unknown evidence (probation), not a lost child", async () => {
      const r = rig();
      r.host.get = async () => { throw new Error("host down"); };
      const t = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1" })] });
      expect(await feedOf(r, t)).toMatchObject({ evidence: "alive", action: "adopt", probation: PROBATION });
      expect(r.logs.some((m) => m.startsWith("warn:"))).toBe(true);
    });
  });
});

describe("reconcile: states without an expected child", () => {
  const cases: Array<[Partial<TaskNode> & { state: TaskState }, ReconcileAction["action"]]> = [
    [{ state: "completed", slot: "slot-T1", attempts: [attempt(1, { child: "c", outcome: "succeeded" })] }, "reverify"],
    [{ state: "verifying", slot: "slot-T1", branch: "omr/plan-one/t/T1", attempts: [attempt(1, { child: "c", outcome: "succeeded" })] }, "reverify"],
    [{ state: "verified", slot: "slot-T1", branch: "omr/plan-one/t/T1", attempts: [attempt(1, { child: "c", outcome: "succeeded" })] }, "re-enqueue"],
    [{ state: "integrating", slot: "slot-T1", branch: "omr/plan-one/t/T1", attempts: [attempt(1, { child: "c", outcome: "succeeded" })] }, "resume-integration"],
    [{ state: "failed", attempts: [attempt(1, { child: "c", outcome: "failed" })] }, "none"],
    [{ state: "conflict", attempts: [attempt(1, { child: "c", outcome: "succeeded" })] }, "none"],
    [{ state: "reverted", attempts: [attempt(1, { child: "c", outcome: "succeeded" })] }, "none"],
  ];
  it.each(cases)("%j", async (patch, action) => {
    const r = rig();
    const f = await feedOf(r, taskNode("T1", patch));
    expect(f).toMatchObject({ from: patch.state, evidence: "none", action, orphans: [], mismatch: false, probation: null });
    expect(r.host.calls).toEqual([]);
  });

  it.each(["pending", "blocked", "parked", "done", "cancelled", "integrated"] as const)("%s has no feed", async (state) => {
    const r = rig();
    const t = taskNode("T1", { state, integrated: state === "integrated" ? { from: "a".repeat(40), to: "b".repeat(40) } : null });
    expect(await r.svc.reconcile(ledgerOf(t), new Set())).toEqual([]);
  });

  it("feeds come back in task-id order", async () => {
    const r = rig();
    const feeds = await r.svc.reconcile(ledgerOf(taskNode("T2", { state: "failed" }), taskNode("T1", { state: "failed" })), new Set());
    expect(feeds.map((f) => f.taskId)).toEqual(["T1", "T2"]);
  });
});

describe("reconcile: R2 slot markers", () => {
  it.each([
    ["missing", null],
    ["foreign task", { planId: PLAN_ID, taskId: "T9" }],
    ["foreign plan", { planId: "plan-two", taskId: "T1" }],
  ])("a running task whose marker is %s is requeued even with a finished child", async (_n, marker) => {
    const r = rig();
    r.markers.set("slot-T1", marker);
    child(r.host, "T1", 1, "finished");
    const t = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1" })] });
    expect(await feedOf(r, t)).toMatchObject({ evidence: "finished", action: "requeue-lost", slotValid: false });
  });

  it("an alive child behind a bad marker is interrupted (orphan) and its task requeued", async () => {
    const r = rig();
    r.markers.set("slot-T1", null);
    child(r.host, "T1", 1, "alive");
    const t = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1" })] });
    expect(await feedOf(r, t)).toMatchObject({ action: "requeue-lost", slotValid: false, orphans: ["ses-T1-1"] });
  });

  it("a dispatched task with a missing marker is requeued", async () => {
    const r = rig();
    r.markers.set("slot-T1", null);
    expect(await feedOf(r, taskNode("T1", { state: "dispatched", slot: "slot-T1", attempts: [attempt(1)] })))
      .toMatchObject({ action: "requeue-lost", slotValid: false });
  });

  it("a ready lost attempt with a bad marker cannot be adopted: slot cleared by the runtime, live child interrupted", async () => {
    const r = rig();
    r.markers.set("slot-T1", null);
    child(r.host, "T1", 1, "alive");
    const t = taskNode("T1", { state: "ready", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1", outcome: "lost" })] });
    expect(await feedOf(r, t)).toMatchObject({ action: "interrupt-orphan", slotValid: false, orphans: ["ses-T1-1"] });
    const r2 = rig();
    r2.markers.set("slot-T1", null);
    child(r2.host, "T1", 1, "lost");
    expect(await feedOf(r2, t)).toMatchObject({ action: "requeue-lost", slotValid: false });
  });

  it.each(["completed", "verifying", "verified"] as const)("%s keeps its action and reports slotValid=false (re-provision)", async (state) => {
    const r = rig();
    r.markers.set("slot-T1", null);
    const t = taskNode("T1", { state, slot: "slot-T1", branch: "omr/plan-one/t/T1", attempts: [attempt(1, { child: "c", outcome: "succeeded" })] });
    const f = await feedOf(r, t);
    expect(f.slotValid).toBe(false);
    expect(f.action).toBe(state === "verified" ? "re-enqueue" : "reverify");
  });

  it("a task without a slot has slotValid null", async () => {
    expect((await feedOf(rig(), taskNode("T1", { state: "failed" }))).slotValid).toBeNull();
  });
});

describe("reconcile: tracked nonces (D12)", () => {
  it("a tracked launch is alive/none and never touches the host", async () => {
    const r = rig();
    child(r.host, "T1", 1, "lost");
    const t = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1" })] });
    const f = await feedOf(r, t, new Set([nonceFor(1)]));
    expect(f).toMatchObject({ evidence: "alive", action: "none", probation: null, mismatch: false, orphans: [] });
    expect(r.host.calls).toEqual([]);
  });

  it("a tracked dispatched launch is not requeued", async () => {
    const r = rig();
    const t = taskNode("T1", { state: "dispatched", slot: "slot-T1", attempts: [attempt(1)] });
    expect(await feedOf(r, t, new Set([nonceFor(1)]))).toMatchObject({ evidence: "alive", action: "none" });
  });

  it("only the tracked nonce is excluded", async () => {
    const r = rig();
    const ts = [
      taskNode("T1", { state: "dispatched", slot: "slot-T1", attempts: [attempt(1)] }),
      taskNode("T2", { state: "dispatched", slot: "slot-T2", attempts: [attempt(1)] }),
    ];
    const feeds = await r.svc.reconcile(ledgerOf(...ts), new Set([nonceFor(1)]));
    expect(feeds.map((f) => f.action)).toEqual(["none", "none"]);
    const feeds2 = await r.svc.reconcile(ledgerOf(...ts), new Set(["f".repeat(32)]));
    expect(feeds2.map((f) => f.action)).toEqual(["requeue-lost", "requeue-lost"]);
  });
});

describe("reconcile: orphans", () => {
  function twoAttempts(outcome1: Attempt["outcome"]): TaskNode {
    return taskNode("T1", { state: "ready", attempts: [attempt(1, { child: "ses-T1-1", outcome: outcome1 }), attempt(2, { child: null, outcome: "failed" })] });
  }
  it.each(["lost", "capacity", "interrupted"] as const)("a still-running child of a closed %s attempt is an orphan", async (o) => {
    const r = rig();
    child(r.host, "T1", 1, "alive");
    expect((await feedOf(r, twoAttempts(o))).orphans).toEqual(["ses-T1-1"]);
  });

  it.each(["succeeded", "failed"] as const)("a closed %s attempt's child is not an orphan", async (o) => {
    const r = rig();
    child(r.host, "T1", 1, "alive");
    expect((await feedOf(r, twoAttempts(o))).orphans).toEqual([]);
  });

  it("a finished child, a gone child and an unparsable child are not orphans", async () => {
    for (const k of ["finished", "lost"] as const) {
      const r = rig();
      child(r.host, "T1", 1, k);
      expect((await feedOf(r, twoAttempts("lost"))).orphans).toEqual([]);
    }
    const r = rig();
    r.host.add("ses-T1-1", { ctx: ctxOf("hello", ["assistant"]), activity: "active" });
    expect((await feedOf(r, twoAttempts("lost"))).orphans).toEqual([]);
  });

  it("orphans never include another plan's sessions", async () => {
    const r = rig();
    child(r.host, "T1", 1, "foreign");
    const f = await feedOf(r, twoAttempts("lost"));
    expect(f.orphans).toEqual([]);
    expect(r.host.interrupts).toEqual([]);
  });

  it("a plain state with an orphan still gets a feed; one without does not", async () => {
    const r = rig();
    child(r.host, "T1", 1, "alive");
    const parked = taskNode("T1", { state: "parked", attempts: [attempt(1, { child: "ses-T1-1", outcome: "lost" })] });
    expect(await r.svc.reconcile(ledgerOf(parked), new Set())).toMatchObject([{ taskId: "T1", action: "none", orphans: ["ses-T1-1"] }]);
    expect(await rig().svc.reconcile(ledgerOf(parked), new Set())).toEqual([]);
  });

  it("the adopted child (latest lost attempt) is not listed as an orphan", async () => {
    const r = rig();
    child(r.host, "T1", 1, "alive");
    child(r.host, "T1", 2, "alive");
    const t = taskNode("T1", {
      state: "ready", slot: "slot-T1",
      attempts: [attempt(1, { child: "ses-T1-1", outcome: "lost" }), attempt(2, { child: "ses-T1-2", outcome: "lost" })],
    });
    const f = await feedOf(r, t);
    expect(f).toMatchObject({ action: "adopt", n: 2, childSessionID: "ses-T1-2", orphans: ["ses-T1-1"] });
  });

  it("reconcile writes nothing: no interrupts and no marker or store access", async () => {
    const r = rig();
    child(r.host, "T1", 1, "alive");
    await r.svc.reconcile(ledgerOf(twoAttempts("lost")), new Set());
    expect(r.host.interrupts).toEqual([]);
    expect(r.host.calls.every((c) => /^(get|context|activity):/.test(c))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// recover() and adopt() against a real LedgerStore in a temp dir; the ledgers are seeded through `create` (legal drafts).
// ---------------------------------------------------------------------------------------------------------------

const roots: string[] = [];
const writers: LedgerWriter[] = [];
afterEach(async () => {
  for (const w of writers.splice(0)) await w.close().catch(() => undefined);
  for (const r of roots.splice(0)) await removeDirWhenReleased(r, { deadlineMs: 20_000 });
});

interface StoreEnv {
  home: string;
  clock: FakeClock;
  /** The process that wrote the ledgers: pid 111 on host "h". */
  seedStore: LedgerStore;
  /** A store as seen from another process. */
  storeFor(proc: FakeProc): LedgerStore;
}
async function storeEnv(): Promise<StoreEnv> {
  const root = await mkdtemp(join(tmpdir(), "omr-recovery-"));
  roots.push(root);
  const home = join(root, "omr-executor");
  const clock = new FakeClock();
  const storeFor = (proc: FakeProc): LedgerStore => createLedgerStore({
    home, clock, proc, warn: () => undefined, heartbeatMs: 10_000, staleMs: 60_000, snapshotEvery: 200,
  });
  return { home, clock, seedStore: storeFor(new FakeProc(111, "h")), storeFor };
}

/** Creates `planId` through the writer's lock holder `ses-0` (pid 111) and leaves the lock held. */
async function seedPlan(env: StoreEnv, planId: string, patch: (l: LedgerV1) => void = () => undefined): Promise<LedgerWriter> {
  const draft = buildDraft(0, planId);
  draft.edges = [];
  draft.repo = { ...draft.repo, toplevel: TOPLEVEL };
  patch(draft);
  const w = await env.seedStore.create(draft, holderOf("ses-0", 111, "h"));
  writers.push(w);
  return w;
}

/** Every lock-taking call and every appended event type the service makes through the store. */
interface StoreCalls { locks: string[]; appended: Array<{ type: string; sessionID?: string; reason?: string }>; closed: number }

function recordingStore(real: LedgerStore, rec: StoreCalls): LedgerStore {
  const wrap = (w: LedgerWriter): LedgerWriter => ({
    planId: w.planId,
    get ledger() { return w.ledger; },
    append: async (b) => {
      if (Array.isArray(b)) {
        for (const e of b) rec.appended.push(e as { type: string; sessionID?: string; reason?: string });
      }
      return w.append(b);
    },
    openIntegration: () => w.openIntegration(),
    wakeKeys: () => w.wakeKeys(),
    snapshot: () => w.snapshot(),
    close: async () => { rec.closed += 1; await w.close(); },
  });
  return {
    ...real,
    open: async (id, h) => { rec.locks.push("open"); return wrap(await real.open(id, h)); },
    takeover: async (id, h, reason) => { rec.locks.push(`takeover:${reason}`); return wrap(await real.takeover(id, h, reason)); },
  };
}

function svcFor(
  env: StoreEnv, proc: FakeProc, host: FakeHost = new FakeHost(), toplevel: string = TOPLEVEL,
  rec: StoreCalls = { locks: [], appended: [], closed: 0 },
): RecoveryEngine {
  return createRecoveryService({
    store: recordingStore(env.storeFor(proc), rec), host, toplevel, clock: env.clock,
    holder: (sessionID) => holderOf(sessionID, proc.pid, proc.hostname),
    slotMarker: async (p) => ({ planId: PLAN_ID, taskId: p.replace(/^slot-/, "") }),
    log: () => undefined,
  });
}

describe("recover(): eligibility (§0 X1, L6)", () => {
  async function seedMany(env: StoreEnv): Promise<void> {
    await seedPlan(env, "plan-run", (l) => { l.status = "running"; });
    await seedPlan(env, "plan-paused", (l) => { l.status = "paused"; });
    await seedPlan(env, "plan-done", (l) => { l.status = "completed"; });
    await seedPlan(env, "plan-aborted", (l) => { l.status = "aborted"; });
    await seedPlan(env, "plan-other", (l) => { l.repo = { ...l.repo, toplevel: "C:/elsewhere" }; });
    await seedPlan(env, "plan-await", (l) => { l.status = "awaiting-approval"; });
  }

  it("reports running and paused plans of this toplevel only", async () => {
    const env = await storeEnv();
    await seedMany(env);
    const out = await svcFor(env, new FakeProc(222, "h")).recover();
    expect(out.map((e) => e.planId).sort()).toEqual(["plan-paused", "plan-run"]);
  });

  it("is latched: the second call is a no-op", async () => {
    const env = await storeEnv();
    await seedMany(env);
    const svc = svcFor(env, new FakeProc(222, "h"));
    expect((await svc.recover()).length).toBe(2);
    expect(await svc.recover()).toEqual([]);
  });

  it("a toplevel that differs only by separators and case (win32) is eligible", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run");
    const svc = svcFor(env, new FakeProc(222, "h"), new FakeHost(), process.platform === "win32" ? "c:\\REPO\\" : "C:/repo/");
    expect((await svc.recover()).map((e) => e.planId)).toEqual(["plan-run"]);
  });

  it("another toplevel gets nothing", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run");
    expect(await svcFor(env, new FakeProc(222, "h"), new FakeHost(), "C:/elsewhere").recover()).toEqual([]);
  });

  it("returns the reconcile actions per plan, reads only, interrupts nothing and writes nothing", async () => {
    const env = await storeEnv();
    const host = new FakeHost();
    child(host, "T1", 1, "alive");
    await seedPlan(env, "plan-one", (l) => {
      l.tasks.T1 = taskNode("T1", { state: "running", slot: "slot-T1", attempts: [attempt(1, { child: "ses-T1-1" })] });
      l.tasks.T2 = taskNode("T2", {
        state: "verified", slot: "slot-T2", branch: "omr/plan-one/t/T2", attempts: [attempt(1, { child: "c2", outcome: "succeeded" })],
      });
      l.tasks.T3 = taskNode("T3", { state: "pending" });
    });
    const before = (await env.seedStore.read("plan-one")).seq;
    const out = await svcFor(env, new FakeProc(222, "h"), host).recover();
    expect(out).toHaveLength(1);
    expect(out[0]?.actions.map((a) => [a.taskId, a.action, a.evidence])).toEqual([
      ["T1", "adopt", "alive"],
      ["T2", "re-enqueue", "none"],
    ]);
    expect(host.interrupts).toEqual([]);
    expect((await env.seedStore.read("plan-one")).seq).toBe(before);
  });

  it("a plan that cannot be read is skipped, the others are still reported", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run");
    await seedPlan(env, "plan-two");
    const real = env.storeFor(new FakeProc(222, "h"));
    const store: LedgerStore = {
      ...real,
      list: () => real.list(),
      read: async (id) => { if (id === "plan-run") throw new Error("boom"); return real.read(id); },
    };
    const svc = createRecoveryService({
      store, host: new FakeHost(), toplevel: TOPLEVEL, clock: env.clock, holder: (s) => holderOf(s, 222, "h"),
      slotMarker: async () => null, log: () => undefined,
    });
    expect((await svc.recover()).map((e) => e.planId)).toEqual(["plan-two"]);
  });
});

describe("adopt() (L3)", () => {
  const newRec = (): StoreCalls => ({ locks: [], appended: [], closed: 0 });
  const BOUND = { type: "orchestrator-bound", sessionID: "ses-new", reason: "adopt" };

  it("takes over a stale lock (dead pid), journals orchestrator-bound(adopt) and releases the lock", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run"); // holder pid 111 is dead for the adopting process
    const proc = new FakeProc(222, "h");
    const rec = newRec();
    await svcFor(env, proc, new FakeHost(), TOPLEVEL, rec).adopt("plan-run", "ses-new");
    expect(rec.locks).toEqual(["open", "takeover:adopt"]);
    expect(rec.appended).toEqual([BOUND]);
    expect(rec.closed).toBe(1);
    expect((await env.seedStore.read("plan-run")).orchestrator.sessionID).toBe("ses-new");
    // the writer was closed: the runtime can open the plan itself now
    const w = await env.storeFor(proc).open("plan-run", holderOf("ses-new", 222, "h"));
    writers.push(w);
    expect(w.ledger.orchestrator.sessionID).toBe("ses-new");
  });

  it("opens a plan nobody holds without a takeover", async () => {
    const env = await storeEnv();
    const w = await seedPlan(env, "plan-run");
    await w.close();
    const rec = newRec();
    await svcFor(env, new FakeProc(222, "h"), new FakeHost(), TOPLEVEL, rec).adopt("plan-run", "ses-new");
    expect(rec.locks).toEqual(["open"]);
    expect(rec.appended).toEqual([BOUND]);
  });

  it("a live holder elsewhere is E_LOCK_HELD and nothing is journaled", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run");
    const proc = new FakeProc(222, "h");
    proc.alive.add(111);
    const rec = newRec();
    await expect(svcFor(env, proc, new FakeHost(), TOPLEVEL, rec).adopt("plan-run", "ses-new")).rejects.toMatchObject({ code: "E_LOCK_HELD" });
    expect(rec.locks).toEqual(["open", "takeover:adopt"]);
    expect(rec.appended).toEqual([]);
    expect((await env.seedStore.read("plan-run")).orchestrator.sessionID).toBe("ses-0");
  });

  it("this process's own lock is taken over (same pid and host)", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run");
    const proc = new FakeProc(111, "h");
    const rec = newRec();
    await svcFor(env, proc, new FakeHost(), TOPLEVEL, rec).adopt("plan-run", "ses-new");
    expect(rec.locks).toEqual(["open", "takeover:adopt"]);
    expect(rec.appended).toEqual([BOUND]);
    expect((await env.seedStore.read("plan-run")).orchestrator.sessionID).toBe("ses-new");
  });

  it("a plan of another toplevel is E_PLAN_STATE", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run");
    await expect(svcFor(env, new FakeProc(222, "h"), new FakeHost(), "C:/elsewhere").adopt("plan-run", "ses-new"))
      .rejects.toMatchObject({ code: "E_PLAN_STATE" });
  });

  it.each(["completed", "aborted"] as const)("a %s plan is E_PLAN_STATE", async (status) => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run", (l) => { l.status = status; });
    await expect(svcFor(env, new FakeProc(222, "h")).adopt("plan-run", "ses-new")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
  });

  it("an unknown plan is E_LEDGER_NOT_FOUND", async () => {
    const env = await storeEnv();
    await expect(svcFor(env, new FakeProc(222, "h")).adopt("plan-zzz", "ses-new")).rejects.toMatchObject({ code: "E_LEDGER_NOT_FOUND" });
  });

  it("recover() never takes a lock over: after recover() the stale holder is still the lock holder", async () => {
    const env = await storeEnv();
    await seedPlan(env, "plan-run");
    const rec = newRec();
    await svcFor(env, new FakeProc(222, "h"), new FakeHost(), TOPLEVEL, rec).recover();
    expect(rec).toEqual({ locks: [], appended: [], closed: 0 });
  });
});

describe("sameToplevel (L5)", () => {
  it("ignores separators and trailing slashes", () => {
    expect(sameToplevel("C:\\no\\such\\repo", "C:/no/such/repo/")).toBe(true);
    expect(sameToplevel("/no/such/a", "/no/such/b")).toBe(false);
  });
});
