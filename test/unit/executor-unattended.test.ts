// Phase 4.2 task 4.2.2: UnattendedPolicy (src/executor/unattended.ts) over the real LedgerStore in a temp dir, with doubles for the
// LeaseService, Waker, QaLoop and Clock (memo phase-4.2.md §1-§3, §10 "unattended").
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLedgerStore } from "../../src/executor/ledger.js";
import {
  BREAKER_FED,
  breakerSamples,
  breakerTrips,
  boundInboxText,
  createUnattendedPolicy,
  INBOX_TEXT_MAX,
  isCommitFailure,
  parkItemKind,
  pendingDependentsClosure,
} from "../../src/executor/unattended.js";
import {
  ExecutorError,
  type Attempt,
  type InboxItem,
  type LedgerV1,
  type LedgerWriter,
  type QaCapChoice,
  type TaskNode,
  type TaskState,
  type UnattendedPolicy,
  type WakeReason,
} from "../../src/executor/types.js";
import { PLAN_ID, buildDraft, holderOf, nonceFor, taskNode } from "../fixtures/cpx/ledger/builders.js";
import { FakeClock, FakeProc } from "../fixtures/cpx/ledger/fakes.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

// ---------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------

const roots: string[] = [];
const openWriters: LedgerWriter[] = [];

afterEach(async () => {
  for (const w of openWriters.splice(0)) await w.close().catch(() => undefined);
  for (const r of roots.splice(0)) await removeDirWhenReleased(r, { deadlineMs: 20_000 });
}, 60_000);

const BASE_MS = Date.parse("2026-10-11T00:00:00.000Z");
/** An ISO time `sec` seconds after the fixture epoch. */
const at = (sec: number): string => new Date(BASE_MS + sec * 1000).toISOString();

let nonceSeq = 0;
/** A closed attempt ending at second `endSec` (unique nonce; a verdict needs a succeeded outcome). */
function closed(n: number, o: Partial<Attempt> & { endSec: number }): Attempt {
  const { endSec, ...rest } = o;
  nonceSeq += 1;
  return {
    n, nonce: nonceFor(nonceSeq + 5000), callID: null, childSessionID: null, startedAt: at(endSec - 1), endedAt: at(endSec),
    outcome: "succeeded", verdict: "pass", context: "", ...rest,
  };
}
/** A failed attempt ending at second `endSec`. */
function failed(n: number, endSec: number, patch: Partial<Attempt> = {}): Attempt {
  return closed(n, { endSec, outcome: "failed", verdict: null, ...patch });
}
/** A running attempt (open, with a child session as a running task requires). */
function open(n: number, nonce = nonceFor(n)): Attempt {
  return { n, nonce, callID: null, childSessionID: "child-1", startedAt: at(0), endedAt: null, outcome: null, verdict: null, context: "" };
}
function edge(from: string, to: string): LedgerV1["edges"][number] {
  return { from, to, kind: "explicit", confidence: "high", evidence: "test" };
}
function task(id: string, state: TaskState, patch: Partial<TaskNode> = {}): TaskNode {
  return taskNode(id, { state, ...patch });
}
/** A running task holding a slot and an open attempt. */
function running(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return task(id, "running", { slot: "slot-1", branch: `omr/${PLAN_ID}/t/${id}`, attempts: [open(1, nonceFor(77))], ...patch });
}

class Waker2 {
  readonly calls: Array<{ reason: WakeReason; key: string }> = [];
  readonly burned = new Set<string>();
  async wake(reason: WakeReason, stateKey: string): Promise<"sent" | "duplicate"> {
    this.calls.push({ reason, key: stateKey });
    if (this.burned.has(stateKey)) return "duplicate";
    this.burned.add(stateKey);
    return "sent";
  }
}

/** Delegates to the real writer; can fail the next append and records the order of append / release. */
class TestWriter implements LedgerWriter {
  failNext = false;
  /** Runs once, on the next append, against the real writer before the batch is applied (a concurrent writer). */
  beforeNext: (() => Promise<unknown>) | null = null;
  readonly journal: string[];
  constructor(private readonly inner: LedgerWriter, journal: string[]) {
    this.journal = journal;
  }
  get planId(): string { return this.inner.planId; }
  get ledger(): Readonly<LedgerV1> { return this.inner.ledger; }
  /** Fails every append whose batch (an event array) matches. */
  failOn: ((batch: unknown) => boolean) | null = null;
  /** Every event-array batch handed to append, in order. */
  readonly batches: unknown[] = [];
  async append(batch: Parameters<LedgerWriter["append"]>[0]): Promise<Readonly<LedgerV1>> {
    if (typeof batch !== "function") {
      this.batches.push(batch);
      if (this.failOn?.(batch) === true) throw new ExecutorError("E_LOCK_LOST", "injected append failure");
    }
    const pre = this.beforeNext;
    if (pre !== null) {
      this.beforeNext = null;
      await pre();
    }
    if (this.failNext) {
      this.failNext = false;
      throw new ExecutorError("E_LOCK_LOST", "injected append failure");
    }
    const before = this.inner.ledger.seq;
    const out = await this.inner.append(batch);
    if (out.seq !== before) this.journal.push("append");
    return out;
  }
  openIntegration(): ReturnType<LedgerWriter["openIntegration"]> { return this.inner.openIntegration(); }
  wakeKeys(): ReadonlySet<string> { return this.inner.wakeKeys(); }
  snapshot(): Promise<void> { return this.inner.snapshot(); }
  close(): Promise<void> { return this.inner.close(); }
}

interface Env {
  writer: TestWriter;
  policy: UnattendedPolicy;
  clock: FakeClock;
  waker: Waker2;
  released: string[];
  journal: string[];
  capCalls: Array<{ id: string; choice: QaCapChoice }>;
  logs: string[];
  l(): Readonly<LedgerV1>;
  state(id: string): TaskState;
  /** Closes the writer and reopens the plan from disk (a restart); returns the rebuilt ledger. */
  reopen(): Promise<Readonly<LedgerV1>>;
}

interface Setup {
  tasks?: TaskNode[];
  edges?: Array<[string, string]>;
  inbox?: InboxItem[];
  gate?: LedgerV1["phases"][number]["gate"];
  paused?: boolean;
  qaRound?: number;
  config?: Partial<LedgerV1["config"]["circuitBreaker"]>;
  maxAttempts?: number;
  /** Start the clock at this many seconds after the fixture epoch. */
  nowSec?: number;
}

async function setup(o: Setup = {}): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "omr-unattended-"));
  roots.push(root);
  const clock = new FakeClock(at(o.nowSec ?? 100));
  const proc = new FakeProc(100, "host-a");
  const store = createLedgerStore({
    home: join(root, "omr-executor"), clock, proc, warn: () => undefined, heartbeatMs: 10_000, staleMs: 60_000, snapshotEvery: 200,
  });
  const draft = buildDraft(0);
  draft.edges = (o.edges ?? []).map(([a, b]) => edge(a, b));
  for (const t of o.tasks ?? []) draft.tasks[t.id] = t;
  draft.inbox = o.inbox ?? [];
  const ph = draft.phases[0];
  if (ph === undefined) throw new Error("no phase");
  ph.gate = o.gate ?? "pending";
  ph.paused = o.paused ?? false;
  ph.qaRound = o.qaRound ?? 1;
  draft.config.circuitBreaker = { ...draft.config.circuitBreaker, ...o.config };
  if (o.maxAttempts !== undefined) draft.config.maxAttempts = o.maxAttempts;
  const inner = await store.create(draft, holderOf("s1", proc.pid, proc.hostname, clock.iso()));
  openWriters.push(inner);
  const journal: string[] = [];
  const writer = new TestWriter(inner, journal);
  const waker = new Waker2();
  const released: string[] = [];
  const capCalls: Array<{ id: string; choice: QaCapChoice }> = [];
  const logs: string[] = [];
  const policy = createUnattendedPolicy({
    writer,
    leases: { releaseTask: (id) => { released.push(id); journal.push(`release:${id}`); } },
    waker: { wake: async (reason, key) => { journal.push(`wake:${key}`); return waker.wake(reason, key); } },
    qa: { onCapAnswer: async (id, choice) => { capCalls.push({ id, choice }); return "passed"; } },
    clock,
    log: (_level, msg) => { logs.push(msg); },
  });
  return {
    writer, policy, clock, waker, released, journal, capCalls, logs,
    l: () => writer.ledger,
    state: (id) => {
      const t = writer.ledger.tasks[id];
      if (t === undefined) throw new Error(`no task ${id}`);
      return t.state;
    },
    reopen: async () => {
      await writer.close();
      const again = await store.open(PLAN_ID, holderOf("s2", proc.pid, proc.hostname, clock.iso()));
      const l = again.ledger;
      await again.close();
      return l;
    },
  };
}

async function rejects(p: Promise<unknown>): Promise<ExecutorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecutorError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

function item(id: string, patch: Partial<InboxItem> = {}): InboxItem {
  return { id, kind: "question", severity: "blocking", taskId: null, text: "t", options: [], answer: null, createdAt: at(1), ...patch };
}

function T(env: Env, id: string): TaskNode {
  const t = env.l().tasks[id];
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
}
function lastAttempt(t: TaskNode): Attempt {
  const a = t.attempts[t.attempts.length - 1];
  if (a === undefined) throw new Error(`task ${t.id} has no attempt`);
  return a;
}
function itemOf(env: Env, id: string): InboxItem {
  const it = env.l().inbox.find((x) => x.id === id);
  if (it === undefined) throw new Error(`no inbox item ${id}`);
  return it;
}
function phaseOf(env: Env): LedgerV1["phases"][number] {
  const p = env.l().phases[0];
  if (p === undefined) throw new Error("no phase");
  return p;
}
const SHA = "c".repeat(40);

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

describe("boundInboxText / parkItemKind (U1, U3)", () => {
  it("keeps INBOX_TEXT_MAX characters then an ellipsis", () => {
    expect(INBOX_TEXT_MAX).toBe(4000);
    expect(boundInboxText("a".repeat(4000))).toBe("a".repeat(4000));
    const long = boundInboxText("b".repeat(5000));
    expect(long).toBe(`${"b".repeat(4000)}…`);
    expect(long.length).toBe(4001);
  });

  it("maps causes to kinds, always blocking", () => {
    expect(parkItemKind("escalate")).toEqual({ kind: "question", severity: "blocking" });
    expect(parkItemKind("ambiguity")).toEqual({ kind: "question", severity: "blocking" });
    expect(parkItemKind("qa-unparsable")).toEqual({ kind: "failure", severity: "blocking" });
    expect(parkItemKind("exhausted")).toEqual({ kind: "failure", severity: "blocking" });
  });
});

describe("pendingDependentsClosure (P2)", () => {
  function ledgerOf(tasks: TaskNode[], edges: Array<[string, string]>): LedgerV1 {
    const l = buildDraft(0);
    for (const t of tasks) l.tasks[t.id] = t;
    l.edges = edges.map(([a, b]) => edge(a, b));
    return l;
  }

  it("diamond: direct dependents dep-parked, deeper dep-blocked, sorted per level", () => {
    const l = ledgerOf(
      [task("A", "running"), task("C", "pending"), task("B", "pending"), task("D", "pending")],
      [["A", "C"], ["A", "B"], ["B", "D"], ["C", "D"]],
    );
    expect(pendingDependentsClosure(l, "A")).toEqual([
      { id: "B", trigger: "dep-parked" }, { id: "C", trigger: "dep-parked" }, { id: "D", trigger: "dep-blocked" },
    ]);
  });

  it("a task that is also a direct dependent is dep-parked, not dep-blocked", () => {
    const l = ledgerOf([task("A", "running"), task("B", "pending"), task("D", "pending")], [["A", "B"], ["B", "D"], ["A", "D"]]);
    expect(pendingDependentsClosure(l, "A")).toEqual([{ id: "B", trigger: "dep-parked" }, { id: "D", trigger: "dep-parked" }]);
  });

  it("includes and traverses pending tasks only; gate edges are ignored", () => {
    const l = ledgerOf(
      [task("A", "running"), task("E", "ready"), task("F", "pending"), task("G", "done"), task("X", "pending")],
      [["A", "E"], ["E", "F"], ["A", "G"], ["gate:p1", "X"]],
    );
    expect(pendingDependentsClosure(l, "A")).toEqual([]);
  });

  it("a cycle-free chain returns every pending link once", () => {
    const l = ledgerOf([task("A", "failed"), task("B", "pending"), task("C", "pending"), task("D", "pending")], [["A", "B"], ["B", "C"], ["C", "D"]]);
    expect(pendingDependentsClosure(l, "A").map((x) => x.id)).toEqual(["B", "C", "D"]);
  });
});

describe("breakerTrips (B2)", () => {
  const cfg = { failureRatio: 0.4, minAttempts: 5, consecutiveFailures: 3 };
  const samples = (pattern: string): Parameters<typeof breakerTrips>[0] =>
    [...pattern].map((c, i) => ({ taskId: `T${i}`, n: 1, endedAt: at(i), failure: c === "F" }));

  it.each([
    ["SSSFF", false, null], // 2/5 = 0.4 exactly: the ratio rule is strict (X11)
    ["FSFSF", true, "ratio"], // 3/5
    ["FSSSS", false, null],
    ["SSFF", false, null],
    ["FFF", true, "consecutive"],
    ["FFSFF", false, null],
    ["FFSFFF", true, "ratio"],
    ["FSSFSSFSSFSSFSF", false, null], // 6/15 = 0.4 exactly
    ["FSSFSSFSSFSFFSF", true, "ratio"], // 7/15
    ["FSSFSSFSSFSSF", false, null],
  ])("%s -> tripped %s (%s)", (pattern, tripped, reason) => {
    const r = breakerTrips(samples(pattern), pattern === "FFSFF" ? { ...cfg, minAttempts: 50 } : cfg);
    expect(r.tripped).toBe(tripped);
    expect(r.reason).toBe(reason);
  });

  it("counts failures, attempts and the trailing run; a success resets the run", () => {
    const r = breakerTrips(samples("FFSFF"), { ...cfg, minAttempts: 50 });
    expect(r).toEqual({ tripped: false, reason: null, failures: 4, attempts: 5, consecutive: 2 });
    expect(breakerTrips(samples("FFFS"), { ...cfg, minAttempts: 50 }).consecutive).toBe(0);
    expect(breakerTrips([], cfg)).toEqual({ tripped: false, reason: null, failures: 0, attempts: 0, consecutive: 0 });
  });

  it("the ratio rule is strict: 6/15 at exactly 0.4 does not trip (the epsilon absorbs float noise), 7/15 does", () => {
    expect(breakerTrips(samples("FSSFSSFSSFSSFSF"), cfg)).toMatchObject({ failures: 6, attempts: 15, tripped: false, reason: null });
    expect(breakerTrips(samples("FSSFSSFSSFSFFSF"), cfg)).toMatchObject({ failures: 7, attempts: 15, tripped: true, reason: "ratio" });
    expect(breakerTrips(samples("SSSFF"), cfg).tripped).toBe(false);
    expect(breakerTrips(samples("SSFFF"), cfg)).toMatchObject({ tripped: true, reason: "ratio" });
  });

  it("the consecutive rule stays C >= consecutiveFailures", () => {
    expect(breakerTrips(samples("SFF"), cfg).tripped).toBe(false);
    expect(breakerTrips(samples("SFFF"), cfg)).toMatchObject({ tripped: true, reason: "consecutive", consecutive: 3 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// raise (U1-U3)
// ---------------------------------------------------------------------------------------------------------------

describe("raise", () => {
  it("allocates ids by kind prefix from one counter and wakes once per item", async () => {
    const env = await setup({ tasks: [task("T1", "ready")] });
    const q = await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "which db?", options: [] });
    const f = await env.policy.raise({ kind: "failure", severity: "blocking", taskId: null, text: "lease rebuild failed", options: [] });
    const b = await env.policy.raise({ kind: "breaker", severity: "critical", taskId: "T1", text: "tripped", options: [] });
    const r = await env.policy.raise({ kind: "qa-cap", severity: "critical", taskId: "T1", text: "cap", options: ["accept", "fix"] });
    expect([q.id, f.id, b.id, r.id]).toEqual(["Q-1", "F-2", "B-3", "R-4"]);
    expect(env.l().inbox.map((x) => x.id)).toEqual(["Q-1", "F-2", "B-3", "R-4"]);
    expect(q).toMatchObject({ kind: "question", severity: "blocking", taskId: "T1", text: "which db?", options: [], answer: null });
    expect(q.createdAt).toBe(env.clock.iso());
    expect(env.waker.calls).toEqual([
      { reason: "inbox", key: "inbox:Q-1" }, { reason: "inbox", key: "inbox:F-2" },
      { reason: "inbox", key: "inbox:B-3" }, { reason: "inbox", key: "inbox:R-4" },
    ]);
  });

  it("the id follows the largest existing number across prefixes", async () => {
    const env = await setup({ inbox: [item("F-7", { kind: "failure" })] });
    const q = await env.policy.raise({ kind: "question", severity: "blocking", taskId: null, text: "x", options: [] });
    expect(q.id).toBe("Q-8");
  });

  it("dedupes an open item with the same kind, task and text: nothing is written, no second wake", async () => {
    const env = await setup({ tasks: [task("T1", "ready")] });
    const a = await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "same", options: [] });
    const seq = env.l().seq;
    const b = await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "same", options: [] });
    expect(b).toEqual(a);
    expect(env.l().seq).toBe(seq);
    expect(env.l().inbox).toHaveLength(1);
    expect(env.waker.calls).toHaveLength(1);
  });

  it("different kind, task or text is a new item", async () => {
    const env = await setup({ tasks: [task("T1", "ready"), task("T2", "ready")] });
    await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "same", options: [] });
    await env.policy.raise({ kind: "failure", severity: "blocking", taskId: "T1", text: "same", options: [] });
    await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T2", text: "same", options: [] });
    await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "other", options: [] });
    expect(env.l().inbox).toHaveLength(4);
  });

  it("a reopened situation (the first item answered) gets a new item and a new wake key", async () => {
    const env = await setup({ tasks: [task("T1", "ready")] });
    const a = await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "again", options: [] });
    await env.policy.answer(a.id, "done");
    const b = await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "again", options: [] });
    expect(b.id).toBe("Q-2");
    expect(env.waker.calls.map((c) => c.key)).toEqual(["inbox:Q-1", "inbox:Q-2"]);
  });

  it("an item closed at creation is stored answered and wakes nobody", async () => {
    const env = await setup({ tasks: [task("T1", "ready")] });
    const d = await env.policy.raise({
      kind: "qa-cap", severity: "info", taskId: "T1", text: "deferred nit F1: naming [src/a.ts]", options: [], answer: "deferred",
    });
    expect(d).toMatchObject({ kind: "qa-cap", severity: "info", answer: "deferred" });
    expect(itemOf(env, d.id).answer).toBe("deferred");
    expect(env.waker.calls).toEqual([]);
  });

  it("bounds the text to 4000 characters plus an ellipsis and dedupes on the bounded text", async () => {
    const env = await setup({ tasks: [task("T1", "ready")] });
    const a = await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "x".repeat(5000), options: [] });
    expect(a.text).toBe(`${"x".repeat(4000)}…`);
    const b = await env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: `${"x".repeat(4000)}${"y".repeat(10)}`, options: [] });
    expect(b.id).toBe(a.id);
    expect(env.l().inbox).toHaveLength(1);
  });

  it("writes nothing and wakes nobody when the append fails", async () => {
    const env = await setup({ tasks: [task("T1", "ready")] });
    env.writer.failNext = true;
    await rejects(env.policy.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "x", options: [] }));
    expect(env.l().inbox).toEqual([]);
    expect(env.waker.calls).toEqual([]);
  });

  it("a wake that throws is logged and does not fail the raise", async () => {
    const env = await setup({ tasks: [task("T1", "ready")] });
    const failing = createUnattendedPolicy({
      writer: env.writer, leases: { releaseTask: () => undefined },
      waker: { wake: async () => { throw new Error("host down"); } },
      qa: { onCapAnswer: async () => "passed" }, clock: env.clock, log: (_l, msg) => { env.logs.push(msg); },
    });
    const a = await failing.raise({ kind: "question", severity: "blocking", taskId: "T1", text: "x", options: [] });
    expect(a.id).toBe("Q-1");
    expect(env.logs).toContain("inbox wake failed");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// park (P1-P4, U5-U6)
// ---------------------------------------------------------------------------------------------------------------

describe("park", () => {
  const RUNNING_CAUSES = ["escalate", "ambiguity", "qa-unparsable"] as const;

  it.each(RUNNING_CAUSES)("%s from running: row 17 (attempt closed, context, parked, slot cleared, one item, release, wake)", async (cause) => {
    const env = await setup({ tasks: [running("T1")] });
    const it1 = await env.policy.park("T1", cause, `child says ${cause}`);
    const t = T(env, "T1");
    expect(t.state).toBe("parked");
    expect(t.slot).toBeNull();
    expect(t.branch).toBe(`omr/${PLAN_ID}/t/T1`);
    const a = lastAttempt(t);
    expect(a.outcome).toBe(cause === "qa-unparsable" ? "failed" : "interrupted");
    expect(a.endedAt).toBe(env.clock.iso());
    expect(a.context).toBe(`child says ${cause}`);
    expect(it1).toMatchObject({
      kind: cause === "qa-unparsable" ? "failure" : "question", severity: "blocking", taskId: "T1", text: `child says ${cause}`,
      options: [], answer: null,
    });
    expect(env.l().inbox).toEqual([it1]);
    expect(env.released).toEqual(["T1"]);
    expect(env.waker.calls).toEqual([{ reason: "inbox", key: `inbox:${it1.id}` }]);
    // P3: released only after the park batch is durable, then the wake; qa-unparsable then feeds the breaker and marks it.
    expect(env.journal).toEqual([
      "append", "release:T1", `wake:inbox:${it1.id}`, ...(cause === "qa-unparsable" ? ["append"] : []),
    ]);
  });

  it.each([
    ["failed", true],
    ["failed", false],
    ["conflict", false],
    ["reverted", false],
  ] as const)("exhausted from %s (slot held: %s): row 36", async (from, withSlot) => {
    const attempt = from === "failed" ? failed(1, 5) : closed(1, { endSec: 5 });
    const env = await setup({
      tasks: [task("T1", from, { attempts: [attempt], ...(withSlot ? { slot: "slot-2", branch: `omr/${PLAN_ID}/t/T1` } : {}) })],
    });
    const it1 = await env.policy.park("T1", "exhausted", "3 attempts used");
    const t = T(env, "T1");
    expect(t.state).toBe("parked");
    expect(t.slot).toBeNull();
    expect(lastAttempt(t)).toEqual({ ...attempt, context: "3 attempts used" }); // the park marker (QA-4.2-5)
    expect(it1).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T1", text: "3 attempts used" });
    expect(env.released).toEqual(withSlot ? ["T1"] : []);
  });

  it("bounds the item text", async () => {
    const env = await setup({ tasks: [running("T1")] });
    const it1 = await env.policy.park("T1", "escalate", "z".repeat(4500));
    expect(it1.text).toBe(`${"z".repeat(4000)}…`);
  });

  it("does not pause the phase or the plan (P4)", async () => {
    const env = await setup({ tasks: [running("T1")] });
    await env.policy.park("T1", "ambiguity", "which?");
    expect(phaseOf(env).paused).toBe(false);
    expect(env.l().status).toBe("running");
  });

  it("from any other state it writes nothing and returns the task's open item", async () => {
    const states: TaskNode[] = [
      task("P1", "pending"), task("R1", "ready"), task("D1", "done"), task("PK", "parked"),
      task("FL", "failed", { attempts: [failed(1, 5)] }),
    ];
    const inbox = states.map((t, i) => item(`Q-${i + 1}`, { taskId: t.id, text: `open ${t.id}` }));
    const env = await setup({ tasks: states, inbox });
    const seq = env.l().seq;
    for (const t of states) {
      const got = await env.policy.park(t.id, "escalate", "late");
      expect(got.text).toBe(`open ${t.id}`);
    }
    // exhausted needs conflict|failed|reverted; escalate-class causes need running
    expect((await env.policy.park("FL", "escalate", "late")).text).toBe("open FL");
    expect((await env.policy.park("PK", "exhausted", "late")).text).toBe("open PK");
    expect(env.l().seq).toBe(seq);
    expect(env.released).toEqual([]);
    expect(env.waker.calls).toEqual([]);
    expect(T(env, "FL").state).toBe("failed");
  });

  it("a running task asked to park as exhausted is left alone", async () => {
    const env = await setup({ tasks: [running("T1")], inbox: [item("Q-1", { taskId: "T1" })] });
    const seq = env.l().seq;
    expect((await env.policy.park("T1", "exhausted", "x")).id).toBe("Q-1");
    expect(env.l().seq).toBe(seq);
    expect(T(env, "T1").state).toBe("running");
  });

  it("illegal state without an open item is E_PLAN_STATE; an unknown task is E_INVALID_INPUT", async () => {
    const env = await setup({ tasks: [task("R1", "ready")] });
    expect((await rejects(env.policy.park("R1", "escalate", "x"))).code).toBe("E_PLAN_STATE");
    expect((await rejects(env.policy.park("NOPE", "escalate", "x"))).code).toBe("E_INVALID_INPUT");
  });

  it("blocks exactly the pending transitive dependents (diamond); others are untouched", async () => {
    const env = await setup({
      tasks: [
        running("A"), task("B", "pending"), task("C", "pending"), task("D", "pending"),
        task("E", "ready"), task("F", "pending"), task("X", "pending"), task("Y", "ready"),
      ],
      edges: [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"], ["A", "E"], ["E", "F"]],
    });
    await env.policy.park("A", "escalate", "q");
    expect(["A", "B", "C", "D", "E", "F", "X", "Y"].map((id) => env.state(id))).toEqual([
      "parked", "blocked", "blocked", "blocked", "ready", "pending", "pending", "ready",
    ]);
  });

  it("blocks a chain; an independent ready task stays ready", async () => {
    const env = await setup({
      tasks: [task("A", "failed", { attempts: [failed(1, 5)] }), task("B", "pending"), task("C", "pending"), task("I", "ready")],
      edges: [["A", "B"], ["B", "C"]],
    });
    await env.policy.park("A", "exhausted", "out of attempts");
    expect([env.state("B"), env.state("C"), env.state("I")]).toEqual(["blocked", "blocked", "ready"]);
  });

  it("requeues the QA gate when a qa task parks, with the round unchanged", async () => {
    const env = await setup({ tasks: [running("Q1", { kind: "qa" })], gate: "qa-running", qaRound: 2 });
    await env.policy.park("Q1", "escalate", "reviewer asks");
    expect(phaseOf(env)).toMatchObject({ gate: "awaiting-qa", qaRound: 2 });
    expect(env.state("Q1")).toBe("parked");
  });

  it("an exhausted qa task leaves the gate alone", async () => {
    const env = await setup({ tasks: [task("Q1", "failed", { kind: "qa", attempts: [failed(1, 5)] })], gate: "awaiting-qa" });
    await env.policy.park("Q1", "exhausted", "x");
    expect(phaseOf(env).gate).toBe("awaiting-qa");
  });

  it("does not release and leaves everything unchanged when the append fails", async () => {
    const env = await setup({ tasks: [running("T1"), task("B", "pending")], edges: [["T1", "B"]] });
    env.writer.failNext = true;
    await rejects(env.policy.park("T1", "escalate", "q"));
    expect(env.state("T1")).toBe("running");
    expect(env.state("B")).toBe("pending");
    expect(env.l().inbox).toEqual([]);
    expect(env.released).toEqual([]);
    expect(env.waker.calls).toEqual([]);
  });

  it("a release or wake that throws is logged and does not fail the park", async () => {
    const env = await setup({ tasks: [running("T1")] });
    const p = createUnattendedPolicy({
      writer: env.writer, leases: { releaseTask: () => { throw new Error("registry gone"); } },
      waker: { wake: async () => { throw new Error("host down"); } },
      qa: { onCapAnswer: async () => "passed" }, clock: env.clock, log: (_l, msg) => { env.logs.push(msg); },
    });
    const got = await p.park("T1", "escalate", "q");
    expect(got.id).toBe("Q-1");
    expect(env.logs).toEqual(["lease release failed", "inbox wake failed"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// answer (U4)
// ---------------------------------------------------------------------------------------------------------------

describe("answer", () => {
  it("parked -> ready in one batch: inbox answered, context replaced by the answer, resumed task returned", async () => {
    const env = await setup({ tasks: [running("T1")] });
    const q = await env.policy.park("T1", "escalate", "which db?");
    const attemptsBefore = T(env, "T1").attempts.length;
    const out = await env.policy.answer(q.id, "use postgres");
    expect(out).toEqual({ resumed: "T1" });
    expect(env.state("T1")).toBe("ready");
    expect(itemOf(env, q.id).answer).toBe("use postgres");
    const t = T(env, "T1");
    expect(t.attempts).toHaveLength(attemptsBefore);
    expect(lastAttempt(t).context).toBe("use postgres");
    expect(t.slot).toBeNull();
  });

  it("an exhausted task gets no fresh attempt count: exactly one more attempt per answer", async () => {
    const attempts = [failed(1, 3), failed(2, 4), failed(3, 5, { context: "old feedback" })];
    const env = await setup({ tasks: [task("T1", "failed", { attempts })], config: {} });
    const q = await env.policy.park("T1", "exhausted", "3 attempts failed");
    await env.policy.answer(q.id, "try the other approach");
    const t = T(env, "T1");
    expect(t.state).toBe("ready");
    expect(t.attempts).toHaveLength(3);
    expect(t.attempts.filter((a) => a.outcome === "failed")).toHaveLength(3);
    expect(t.attempts.map((a) => a.context)).toEqual(["", "", "try the other approach"]);
    expect(t.attempts.map((a) => a.n)).toEqual([1, 2, 3]);
  });

  it("the dependents stay blocked until the task integrates", async () => {
    const env = await setup({ tasks: [running("A"), task("B", "pending")], edges: [["A", "B"]] });
    const q = await env.policy.park("A", "ambiguity", "which?");
    expect(env.state("B")).toBe("blocked");
    await env.policy.answer(q.id, "this one");
    expect(env.state("A")).toBe("ready");
    expect(env.state("B")).toBe("blocked");
  });

  it("case and whitespace do not matter for a qa-cap option; the answer goes to QaLoop.onCapAnswer", async () => {
    const env = await setup({
      tasks: [task("Q1", "done", { kind: "qa" })],
      inbox: [item("R-1", { kind: "qa-cap", severity: "critical", taskId: "Q1", options: ["accept", "fix"] })],
    });
    const seq = env.l().seq;
    expect(await env.policy.answer("R-1", "  FiX \n")).toEqual({ resumed: null });
    expect(env.capCalls).toEqual([{ id: "R-1", choice: "fix" }]);
    expect(env.l().seq).toBe(seq); // QaLoop writes the answer batch, the policy writes nothing
  });

  it("a qa-cap answer outside the item's options is E_INVALID_INPUT and reaches nobody", async () => {
    const env = await setup({
      tasks: [task("Q1", "done", { kind: "qa" })],
      inbox: [
        item("R-1", { kind: "qa-cap", severity: "critical", taskId: "Q1", options: ["accept", "fix"] }),
        item("R-2", { kind: "qa-cap", severity: "critical", taskId: "Q1", options: ["accept"] }),
      ],
    });
    const seq = env.l().seq;
    expect((await rejects(env.policy.answer("R-1", "maybe"))).code).toBe("E_INVALID_INPUT");
    expect((await rejects(env.policy.answer("R-1", ""))).code).toBe("E_INVALID_INPUT");
    expect((await rejects(env.policy.answer("R-2", "fix"))).code).toBe("E_INVALID_INPUT");
    expect(env.capCalls).toEqual([]);
    expect(env.l().seq).toBe(seq);
    expect(env.l().inbox.every((x) => x.answer === null)).toBe(true);
  });

  it("an unknown or already answered item is E_INVALID_INPUT and nothing is written", async () => {
    const env = await setup({
      tasks: [task("T1", "ready")],
      inbox: [item("Q-1", { taskId: "T1", answer: "earlier" }), item("R-2", { kind: "qa-cap", severity: "critical", taskId: "T1", options: ["accept"], answer: "accept" })],
    });
    const seq = env.l().seq;
    expect((await rejects(env.policy.answer("Q-9", "x"))).code).toBe("E_INVALID_INPUT");
    expect((await rejects(env.policy.answer("Q-1", "x"))).code).toBe("E_INVALID_INPUT");
    expect((await rejects(env.policy.answer("R-2", "accept"))).code).toBe("E_INVALID_INPUT");
    expect(env.capCalls).toEqual([]);
    expect(env.l().seq).toBe(seq);
    expect(itemOf(env, "Q-1").answer).toBe("earlier");
  });

  it("answering the same item twice fails the second time", async () => {
    const env = await setup({ tasks: [running("T1")] });
    const q = await env.policy.park("T1", "escalate", "q");
    await env.policy.answer(q.id, "a");
    expect((await rejects(env.policy.answer(q.id, "b"))).code).toBe("E_INVALID_INPUT");
    expect(lastAttempt(T(env, "T1")).context).toBe("a");
  });

  it("an item without a parked task is only answered", async () => {
    const env = await setup({
      tasks: [task("R1", "ready")],
      inbox: [item("Q-1", { taskId: "R1" }), item("Q-2")],
    });
    expect(await env.policy.answer("Q-1", "fyi")).toEqual({ resumed: null });
    expect(await env.policy.answer("Q-2", "fyi")).toEqual({ resumed: null });
    expect(itemOf(env, "Q-1").answer).toBe("fyi");
    expect(env.state("R1")).toBe("ready");
  });

  it("a breaker answer (any text) unpauses the phase", async () => {
    const env = await setup({
      tasks: [task("T1", "failed", { attempts: [failed(1, 5)] })], paused: true,
      inbox: [item("B-1", { kind: "breaker", severity: "critical", taskId: "T1", text: "phase p1 circuit breaker" })],
    });
    expect(await env.policy.answer("B-1", "ok, continue")).toEqual({ resumed: null });
    expect(phaseOf(env).paused).toBe(false);
    expect(itemOf(env, "B-1").answer).toBe("ok, continue");
    expect(env.state("T1")).toBe("failed");
  });

  it("a breaker answer keeps the phase paused while another critical item is open on it", async () => {
    const env = await setup({
      tasks: [task("T1", "failed", { attempts: [failed(1, 5)] }), task("Q1", "done", { kind: "qa" })], paused: true,
      inbox: [
        item("B-1", { kind: "breaker", severity: "critical", taskId: "T1" }),
        item("R-2", { kind: "qa-cap", severity: "critical", taskId: "Q1", options: ["accept", "fix"] }),
      ],
    });
    await env.policy.answer("B-1", "go");
    expect(phaseOf(env).paused).toBe(true);
    expect(itemOf(env, "B-1").answer).toBe("go");
  });

  it("a breaker answer on a phase that is not paused only answers", async () => {
    const env = await setup({
      tasks: [task("T1", "failed", { attempts: [failed(1, 5)] })],
      inbox: [item("B-1", { kind: "breaker", severity: "critical", taskId: "T1" })],
    });
    await env.policy.answer("B-1", "go");
    expect(phaseOf(env).paused).toBe(false);
    expect(itemOf(env, "B-1").answer).toBe("go");
  });

  it("QA-4.2-5: answering an unrelated item of a parked task only answers it; the park item still resumes", async () => {
    const env = await setup({ tasks: [running("T1")] });
    const before = await env.policy.raise({ kind: "failure", severity: "blocking", taskId: "T1", text: "route failed", options: [] });
    const q = await env.policy.park("T1", "escalate", "which db?");
    const after = await env.policy.raise({ kind: "failure", severity: "blocking", taskId: "T1", text: "lease rebuild failed", options: [] });
    const landing = await env.policy.raise({ kind: "landing", severity: "blocking", taskId: "T1", text: "landing paused", options: [] });
    for (const other of [after, before, landing]) {
      expect(await env.policy.answer(other.id, "noted")).toEqual({ resumed: null });
      expect(env.state("T1")).toBe("parked");
      expect(lastAttempt(T(env, "T1")).context).toBe("which db?");
      expect(itemOf(env, other.id).answer).toBe("noted");
    }
    expect(await env.policy.answer(q.id, "use postgres")).toEqual({ resumed: "T1" });
    expect(env.state("T1")).toBe("ready");
    expect(lastAttempt(T(env, "T1")).context).toBe("use postgres");
  });

  it("QA-4.2-5: an exhausted park is found by the same marker among later failure items", async () => {
    const env = await setup({ tasks: [task("T1", "failed", { attempts: [failed(1, 3), failed(2, 4)] })] });
    const park = await env.policy.park("T1", "exhausted", "2 attempts failed");
    expect(lastAttempt(T(env, "T1")).context).toBe("2 attempts failed");
    const later = await env.policy.raise({ kind: "failure", severity: "blocking", taskId: "T1", text: "probation interrupted", options: [] });
    expect(await env.policy.answer(later.id, "ack")).toEqual({ resumed: null });
    expect(env.state("T1")).toBe("parked");
    expect(lastAttempt(T(env, "T1")).context).toBe("2 attempts failed");
    expect(await env.policy.answer(park.id, "retry")).toEqual({ resumed: "T1" });
    expect(env.state("T1")).toBe("ready");
  });

  it("QA-4.2-5: when no item matches the context the oldest open question or failure item is the park item", async () => {
    const env = await setup({
      tasks: [task("PK", "parked", { attempts: [failed(1, 5, { context: "rewritten by someone" })] })],
      inbox: [
        item("Q-1", { taskId: "PK", text: "original question" }),
        item("F-2", { kind: "failure", taskId: "PK", text: "later failure" }),
        item("L-3", { kind: "landing", taskId: "PK", text: "landing" }),
      ],
    });
    expect(await env.policy.answer("F-2", "x")).toEqual({ resumed: null });
    expect(await env.policy.answer("L-3", "x")).toEqual({ resumed: null });
    expect(env.state("PK")).toBe("parked");
    expect(await env.policy.answer("Q-1", "go")).toEqual({ resumed: "PK" });
    expect(env.state("PK")).toBe("ready");
    expect(lastAttempt(T(env, "PK")).context).toBe("go");
  });

  it("QA-4.2-5 nit: a legacy context longer than 4000 characters still finds its (bounded) park item, not the oldest item", async () => {
    const long = "q".repeat(INBOX_TEXT_MAX + 500);
    const env = await setup({
      tasks: [task("PK", "parked", { attempts: [failed(1, 5, { context: long })] })],
      inbox: [
        item("F-1", { kind: "failure", taskId: "PK", text: "route failed" }),
        item("Q-2", { taskId: "PK", text: boundInboxText(long) }),
        item("F-3", { kind: "failure", taskId: "PK", text: "lease rebuild failed" }),
      ],
    });
    expect(await env.policy.answer("F-1", "x")).toEqual({ resumed: null });
    expect(await env.policy.answer("F-3", "x")).toEqual({ resumed: null });
    expect(env.state("PK")).toBe("parked");
    expect(await env.policy.answer("Q-2", "go")).toEqual({ resumed: "PK" });
    expect(env.state("PK")).toBe("ready");
  });

  it("QA-4.2-5: a parked task without attempts resumes from its only open item", async () => {
    const env = await setup({ tasks: [task("PK", "parked")], inbox: [item("Q-1", { taskId: "PK" })] });
    expect(await env.policy.answer("Q-1", "go")).toEqual({ resumed: "PK" });
    expect(env.state("PK")).toBe("ready");
  });

  it("writes nothing when the append fails", async () => {
    const env = await setup({ tasks: [running("T1")] });
    const q = await env.policy.park("T1", "escalate", "q");
    env.writer.failNext = true;
    await rejects(env.policy.answer(q.id, "a"));
    expect(env.state("T1")).toBe("parked");
    expect(itemOf(env, q.id).answer).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// unblock (P5)
// ---------------------------------------------------------------------------------------------------------------

describe("unblock", () => {
  it("blocked -> ready for every blocked task whose dependencies are all integrated or done", async () => {
    const integrated = task("I1", "integrated", { integrated: { from: SHA, to: SHA } });
    const env = await setup({
      tasks: [
        task("D1", "done"), integrated, task("PK", "parked"),
        task("B1", "blocked"), task("B2", "blocked"), task("B3", "blocked"), task("B4", "blocked"), task("B5", "blocked"),
      ],
      edges: [["D1", "B1"], ["I1", "B2"], ["D1", "B3"], ["I1", "B3"], ["PK", "B4"], ["D1", "B4"], ["B4", "B5"]],
    });
    const ids = await env.policy.unblock();
    expect(ids).toEqual(["B1", "B2", "B3"]);
    expect(["B1", "B2", "B3", "B4", "B5"].map((id) => env.state(id))).toEqual(["ready", "ready", "ready", "blocked", "blocked"]);
  });

  it("a gate edge is judged like the scheduler does (edgeSatisfied): only a passed gate frees the task", async () => {
    const closedGate = await setup({ tasks: [task("B1", "blocked")], edges: [["gate:p1", "B1"]], gate: "awaiting-qa" });
    const seq = closedGate.l().seq;
    expect(await closedGate.policy.unblock()).toEqual([]);
    expect(closedGate.l().seq).toBe(seq);
    expect(closedGate.state("B1")).toBe("blocked");
    const passed = await setup({ tasks: [task("B1", "blocked")], edges: [["gate:p1", "B1"]], gate: "passed" });
    expect(await passed.policy.unblock()).toEqual(["B1"]);
    const mixed = await setup({
      tasks: [task("D1", "done"), task("B1", "blocked")], edges: [["gate:p1", "B1"], ["D1", "B1"]], gate: "passed",
    });
    expect(await mixed.policy.unblock()).toEqual(["B1"]);
  });

  it("writes nothing when there is nothing to unblock", async () => {
    const env = await setup({ tasks: [task("PK", "parked"), task("B1", "blocked")], edges: [["PK", "B1"]] });
    const seq = env.l().seq;
    expect(await env.policy.unblock()).toEqual([]);
    expect(env.l().seq).toBe(seq);
  });

  it("park then recover: dependents unblock after the parked task is integrated", async () => {
    const env = await setup({ tasks: [running("A"), task("B", "pending")], edges: [["A", "B"]] });
    await env.policy.park("A", "escalate", "q");
    expect(await env.policy.unblock()).toEqual([]);
    expect(env.state("B")).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// circuit breaker (B1-B6)
// ---------------------------------------------------------------------------------------------------------------

/**
 * One task `B<i>` of phase p1 per character, each with one attempt ending at second i + 1:
 * F failed | S succeeded+pass (task done) | V succeeded+fail verdict | U succeeded+unverifiable | P succeeded, verification pending
 * | N succeeded, no verdict, task failed (row 23 "no changes") | L lost attempt | I interrupted attempt.
 */
function breakerTasks(pattern: string): TaskNode[] {
  return [...pattern].map((c, i) => {
    const id = `B${i}`;
    const end = i + 1;
    switch (c) {
      case "F": return task(id, "failed", { attempts: [failed(1, end)] });
      case "S": return task(id, "done", { attempts: [closed(1, { endSec: end })] });
      case "V": return task(id, "failed", { attempts: [closed(1, { endSec: end, verdict: "fail" })] });
      case "U": return task(id, "failed", { attempts: [closed(1, { endSec: end, verdict: "unverifiable" })] });
      case "P": return task(id, "completed", { slot: "slot-1", attempts: [closed(1, { endSec: end, verdict: null })] });
      case "N": return task(id, "failed", { attempts: [closed(1, { endSec: end, verdict: null })] });
      case "L": return task(id, "ready", { attempts: [closed(1, { endSec: end, outcome: "lost", verdict: null })] });
      case "I": return task(id, "ready", { attempts: [closed(1, { endSec: end, outcome: "interrupted", verdict: null })] });
      default: throw new Error(`bad pattern char ${c}`);
    }
  });
}

/** Evaluates the breaker the way a feed does: `recordAttempt` with the attempt of task `B<idx>`. */
async function feed(env: Env, idx: number): Promise<{ tripped: boolean }> {
  return env.policy.recordAttempt("p1", lastAttempt(T(env, `B${idx}`)));
}

describe("recordAttempt: when the breaker trips", () => {
  it.each([
    ["FSSSS", 0, false], // 1/5
    ["SSSFF", 4, false], // 2/5: no trip (strict ratio, X11)
    ["SFSFF", 4, true], // 3/5
    ["SSFF", 3, false], // 2/4: below minAttempts, run of 2
    ["SFSS", 1, false], // 1/4
    ["FFF", 2, true], // three in a row at N = 3
    ["SFFF", 3, true], // three in a row below minAttempts
    ["SSSSSSFSSFSSFSF", 14, false], // 4/15 and a run of 1
  ])("%s (feed B%i) -> tripped %s", async (pattern, idx, expected) => {
    const env = await setup({ tasks: breakerTasks(pattern) });
    const samples = breakerSamples(env.l(), "p1");
    const trips = breakerTrips(samples, env.l().config.circuitBreaker);
    expect(trips.tripped).toBe(expected);
    const out = await feed(env, idx);
    expect(out.tripped).toBe(expected);
    expect(phaseOf(env).paused).toBe(expected);
    expect(env.l().inbox.filter((x) => x.kind === "breaker")).toHaveLength(expected ? 1 : 0);
  });

  it("a success resets the consecutive run", async () => {
    const env = await setup({ tasks: breakerTasks("FFSFF"), config: { minAttempts: 50 } });
    expect((await feed(env, 4)).tripped).toBe(false);
    const env2 = await setup({ tasks: breakerTasks("FFSFFF"), config: { minAttempts: 50 } });
    expect((await feed(env2, 5)).tripped).toBe(true);
    expect(itemOf(env2, "B-1").text).toContain("3 consecutive");
  });

  it("7/15 trips; 6/15 and 5/13 do not (strict ratio, no run of three)", async () => {
    const seven = await setup({ tasks: breakerTasks("FSSFSSFSSFSFFSF") });
    expect(breakerSamples(seven.l(), "p1").filter((s) => s.failure)).toHaveLength(7);
    expect((await feed(seven, 14)).tripped).toBe(true);
    const six = await setup({ tasks: breakerTasks("FSSFSSFSSFSSFSF") });
    expect(breakerSamples(six.l(), "p1").filter((s) => s.failure)).toHaveLength(6);
    expect((await feed(six, 14)).tripped).toBe(false);
    const five = await setup({ tasks: breakerTasks("FSSFSSFSSFSSF") });
    expect((await feed(five, 12)).tripped).toBe(false);
    expect(phaseOf(five).paused).toBe(false);
  });

  it("a succeeded attempt whose verification failed counts as a failure", async () => {
    const env = await setup({ tasks: breakerTasks("VUV") });
    expect(breakerSamples(env.l(), "p1").map((s) => s.failure)).toEqual([true, true, true]);
    expect((await feed(env, 2)).tripped).toBe(true);
  });

  it("verification pending, lost and interrupted attempts are not samples; a done task with no verdict is a success", async () => {
    const env = await setup({ tasks: breakerTasks("PLI") });
    expect(breakerSamples(env.l(), "p1")).toEqual([]);
    const done = task("B9", "done", { attempts: [closed(1, { endSec: 20, verdict: null })] });
    const first = task("B8", "failed", { attempts: [closed(1, { endSec: 10, verdict: null }), failed(2, 11)] });
    const env2 = await setup({ tasks: [done, first] });
    // A-4.2-2: the earlier succeeded attempt without a verdict was followed by a retry, so its commit had failed
    expect(breakerSamples(env2.l(), "p1").map((s) => `${s.taskId}#${s.n}:${s.failure}`)).toEqual(["B8#1:true", "B8#2:true", "B9#1:false"]);
  });

  it("A-4.2-2: a succeeded attempt whose task went completed -> failed (commit failure, no changes) is a breaker failure", async () => {
    const env = await setup({ tasks: breakerTasks("NNN") });
    expect(breakerSamples(env.l(), "p1").map((s) => s.failure)).toEqual([true, true, true]);
    expect(breakerTrips(breakerSamples(env.l(), "p1"), env.l().config.circuitBreaker)).toMatchObject({ tripped: true, reason: "consecutive" });
    expect((await feed(env, 2)).tripped).toBe(true);
    expect(phaseOf(env).paused).toBe(true);
    expect(env.l().inbox.filter((x) => x.kind === "breaker")).toHaveLength(1);
  });

  it("A-4.2-2: a missing git identity costs at most the breaker's threshold, not maxAttempts x tasks", async () => {
    // every task commit-fails once (maxAttempts x tasks would be many more); two do not trip, the third pauses the phase
    const two = await setup({ tasks: breakerTasks("NN") });
    expect((await feed(two, 1)).tripped).toBe(false);
    expect(phaseOf(two).paused).toBe(false);
    const three = await setup({ tasks: breakerTasks("NNN") });
    expect((await feed(three, 2)).tripped).toBe(true);
    expect(phaseOf(three).paused).toBe(true);
    expect(three.l().inbox.filter((x) => x.kind === "breaker")).toHaveLength(1);
    expect(three.l().inbox[0]?.text).toContain("3/3 failed");
  });

  it("A-4.2-2: a succeeded no-verdict attempt of a task that is not failed (verification pending, done) is not a failure", async () => {
    const env = await setup({ tasks: [...breakerTasks("PS"), task("B2", "failed", { attempts: [closed(1, { endSec: 3, verdict: null })] })] });
    expect(breakerSamples(env.l(), "p1").map((s) => `${s.taskId}:${s.failure}`)).toEqual(["B1:false", "B2:true"]);
    const p = T(env, "B0");
    expect((await env.policy.recordAttempt("p1", lastAttempt(p))).tripped).toBe(false);
  });

  /** A task whose only attempt succeeded without a verdict and whose commit then failed (`completed -> failed`). */
  const commitFailed = (id: string, endSec: number): TaskNode =>
    task(id, "failed", { attempts: [closed(1, { endSec, verdict: null })] });

  it("QA-4.2-19: the latest verdict-less success counts once the task left completed through failure, in any state", () => {
    const a = closed(1, { endSec: 1, verdict: null });
    const counted: TaskState[] = ["failed", "ready", "parked", "blocked", "pending"];
    const notCounted: TaskState[] = [
      "completed", "verifying", "verified", "integrating", "integrated", "done", "cancelled", "conflict", "reverted",
    ];
    for (const s of counted) expect(isCommitFailure(task("X", s, { attempts: [a] }), a), s).toBe(true);
    for (const s of notCounted) expect(isCommitFailure(task("X", s, { attempts: [a] }), a), s).toBe(false);
    // a non-latest one was followed by a retry, whatever the state is now
    expect(isCommitFailure(task("X", "done", { attempts: [a, closed(2, { endSec: 3 })] }), a)).toBe(true);
    const pass = closed(1, { endSec: 1 });
    const lost = closed(1, { endSec: 1, outcome: "lost", verdict: null });
    expect(isCommitFailure(task("X", "ready", { attempts: [pass] }), pass)).toBe(false);
    expect(isCommitFailure(task("X", "ready", { attempts: [lost] }), lost)).toBe(false);
  });

  it("QA-4.2-19: a commit failure stays a sample after the retry decision moves the task (failed -> ready, failed -> parked)", async () => {
    const env = await setup({ tasks: [commitFailed("C0", 1), commitFailed("C1", 2), commitFailed("C2", 3)], config: { minAttempts: 50 } });
    const before = breakerSamples(env.l(), "p1");
    expect(before.map((s) => `${s.taskId}:${s.failure}`)).toEqual(["C0:true", "C1:true", "C2:true"]);
    await env.writer.append([{ type: "task-transition", taskId: "C0", from: "failed", to: "ready", trigger: "retry", detail: null }]);
    await env.policy.park("C1", "exhausted", "commit failed: no git identity");
    expect([env.state("C0"), env.state("C1"), env.state("C2")]).toEqual(["ready", "parked", "failed"]);
    expect(breakerSamples(env.l(), "p1")).toEqual(before);
    expect(breakerSamples(await env.reopen(), "p1")).toEqual(before);
  });

  it("QA-4.2-19: maxAttempts = 1 and three tasks failing their commit trip the breaker (consecutive 3)", async () => {
    // Only C0's commit has failed yet; C1 and C2 are `completed` (verification pending: not samples). The breaker reads
    // the whole ledger (B1), so a ledger with all three failures already settled would trip at the first feed.
    const pending = (id: string, endSec: number): TaskNode =>
      task(id, "completed", { slot: `slot-${id}`, attempts: [closed(1, { endSec, verdict: null })] });
    const env = await setup({ tasks: [commitFailed("C0", 1), pending("C1", 2), pending("C2", 3)], maxAttempts: 1 });
    expect(env.l().config.maxAttempts).toBe(1);
    const commitFails = async (id: string): Promise<void> => {
      await env.writer.append([
        { type: "task-transition", taskId: id, from: "completed", to: "failed", trigger: "commit-failed", detail: "commit failed: no git identity" },
      ]);
    };
    // the runtime order: the commit-failure batch, the feed, then the retry decision parks the task (no attempt left)
    expect((await env.policy.recordAttempt("p1", lastAttempt(T(env, "C0")))).tripped).toBe(false);
    await env.policy.park("C0", "exhausted", "commit failed: no git identity");
    await commitFails("C1");
    expect((await env.policy.recordAttempt("p1", lastAttempt(T(env, "C1")))).tripped).toBe(false);
    await env.policy.park("C1", "exhausted", "commit failed: no git identity");
    await commitFails("C2");
    expect((await env.policy.recordAttempt("p1", lastAttempt(T(env, "C2")))).tripped).toBe(true);
    expect(phaseOf(env).paused).toBe(true);
    const brk = env.l().inbox.filter((x) => x.kind === "breaker");
    expect(brk).toHaveLength(1);
    expect(brk[0]?.text).toContain("3/3 failed");
    expect(brk[0]?.text).toContain("3 consecutive");
  });

  it("a flaky item between the attempt and the next one excludes the attempt", async () => {
    const tasks = breakerTasks("FFF");
    const flaky = item("K-1", { kind: "flaky", taskId: "B2", createdAt: at(3), answer: "seen" });
    const without = await setup({ tasks });
    expect(breakerSamples(without.l(), "p1")).toHaveLength(3);
    expect((await feed(without, 2)).tripped).toBe(true);
    const withFlaky = await setup({ tasks: breakerTasks("FFF"), inbox: [flaky] });
    expect(breakerSamples(withFlaky.l(), "p1").map((s) => s.taskId)).toEqual(["B0", "B1"]);
    expect((await feed(withFlaky, 2)).tripped).toBe(false);
  });

  it("samples are ordered by endedAt, then task id, then n, and only cover this phase's tasks", async () => {
    const a = task("Z", "failed", { attempts: [failed(1, 5)] });
    const b = task("A", "failed", { attempts: [failed(1, 5)] });
    const c = task("M", "failed", { attempts: [failed(1, 2)] });
    const other = task("O", "failed", { phase: null, attempts: [failed(1, 3)] });
    const env = await setup({ tasks: [a, b, c, other] });
    expect(breakerSamples(env.l(), "p1").map((s) => s.taskId)).toEqual(["M", "A", "Z"]);
  });

  it("evaluates only when the fed attempt is a failure, and only for a known attempt", async () => {
    const env = await setup({ tasks: breakerTasks("FFFS") });
    expect((await feed(env, 3)).tripped).toBe(false);
    const stranger = closed(1, { endSec: 50, outcome: "failed", verdict: null });
    expect((await env.policy.recordAttempt("p1", stranger)).tripped).toBe(false);
    expect(env.l().inbox).toEqual([]);
    expect(phaseOf(env).paused).toBe(false);
    // the trailing success reset the run: 3/4 failed but below minAttempts and no run of three
    expect((await feed(env, 2)).tripped).toBe(false);
    const run = await setup({ tasks: breakerTasks("FFF") });
    expect((await feed(run, 2)).tripped).toBe(true);
  });

  it("trips once: one batch (pause + critical item) and one wake; later failures while paused do nothing", async () => {
    const env = await setup({ tasks: breakerTasks("FFF") });
    const first = await feed(env, 2);
    expect(first).toEqual({ tripped: true });
    const seq = env.l().seq;
    expect(await feed(env, 1)).toEqual({ tripped: false });
    expect(await feed(env, 2)).toEqual({ tripped: false });
    expect(env.l().seq).toBe(seq);
    expect(phaseOf(env).paused).toBe(true);
    const items = env.l().inbox.filter((x) => x.kind === "breaker");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "B-1", kind: "breaker", severity: "critical", taskId: "B2", options: [], answer: null,
    });
    expect(items[0]?.text).toMatch(/^phase p1 circuit breaker: 3\/3 failed.*3 consecutive/);
    expect(env.waker.calls).toEqual([{ reason: "inbox", key: "inbox:B-1" }]);
    expect(env.journal).toEqual(["append", "wake:inbox:B-1"]);
  });

  it("does not trip again while a breaker item is still open, even if the phase was unpaused by hand", async () => {
    const env = await setup({ tasks: breakerTasks("FFF") });
    await feed(env, 2);
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: false, reason: "manual" }]);
    expect(await feed(env, 2)).toEqual({ tripped: false });
    expect(env.l().inbox.filter((x) => x.kind === "breaker")).toHaveLength(1);
  });

  it("is identical after a rebuild from disk (pure function of the ledger)", async () => {
    const plain = await setup({ tasks: breakerTasks("SFFSFFF") });
    const plainSamples = breakerSamples(plain.l(), "p1");
    expect(plainSamples).toHaveLength(7);
    expect(breakerSamples(await plain.reopen(), "p1")).toEqual(plainSamples);
    const env = await setup({ tasks: breakerTasks("SFFSFFF") });
    const before = breakerSamples(env.l(), "p1");
    expect((await feed(env, 6)).tripped).toBe(true);
    const afterTrip = breakerSamples(env.l(), "p1");
    const rebuilt = await env.reopen();
    expect(breakerSamples(rebuilt, "p1")).toEqual(afterTrip);
    expect(breakerTrips(before, rebuilt.config.circuitBreaker)).toMatchObject({ tripped: true, failures: 5, attempts: 7 });
    expect(rebuilt.phases[0]?.paused).toBe(true);
    expect(rebuilt.inbox.filter((x) => x.kind === "breaker")).toHaveLength(1);
  });

  it("the window restarts at the trip time (B6): earlier attempts and an attempt ending at the trip time are excluded", async () => {
    const trip = item("B-1", { kind: "breaker", severity: "critical", taskId: "B0", answer: "go", createdAt: at(10) });
    const tasks = [
      ...breakerTasks("FFFFF"),
      task("L1", "failed", { attempts: [failed(1, 10)] }),
      task("L2", "failed", { attempts: [failed(1, 11)] }),
      task("L3", "failed", { attempts: [failed(1, 12)] }),
    ];
    const env = await setup({ tasks, inbox: [trip] });
    expect(breakerSamples(env.l(), "p1").map((s) => s.taskId)).toEqual(["L2", "L3"]);
    expect((await env.policy.recordAttempt("p1", lastAttempt(T(env, "L3")))).tripped).toBe(false);
    const noBreaker = await setup({ tasks: tasks.map((t) => structuredClone(t)) });
    expect(breakerSamples(noBreaker.l(), "p1")).toHaveLength(8);
  });

  it("after a breaker answer the next trip needs fresh failures", async () => {
    const env = await setup({ tasks: breakerTasks("FFF") });
    await feed(env, 2);
    await env.policy.answer("B-1", "continue");
    expect(phaseOf(env).paused).toBe(false);
    expect(await feed(env, 2)).toEqual({ tripped: false });
    expect(env.l().inbox.filter((x) => x.kind === "breaker")).toHaveLength(1);
  });

  it("a trip whose append fails leaves the phase running and wakes nobody", async () => {
    const env = await setup({ tasks: breakerTasks("FFF") });
    env.writer.failNext = true;
    await rejects(feed(env, 2));
    expect(phaseOf(env).paused).toBe(false);
    expect(env.l().inbox).toEqual([]);
    expect(env.waker.calls).toEqual([]);
  });

  it("park(qa-unparsable) feeds the breaker with the counted failed attempt; escalate and ambiguity do not", async () => {
    const tasks = [...breakerTasks("FF"), running("Q1", { kind: "qa" })];
    const env = await setup({ tasks, gate: "qa-running", config: { consecutiveFailures: 3, minAttempts: 50 } });
    await env.policy.park("Q1", "qa-unparsable", "no json");
    expect(phaseOf(env).paused).toBe(true);
    const brk = env.l().inbox.filter((x) => x.kind === "breaker");
    expect(brk).toHaveLength(1);
    expect(brk[0]).toMatchObject({ taskId: "Q1", severity: "critical" });
    expect(env.waker.calls.map((c) => c.key)).toEqual(["inbox:F-1", "inbox:B-2"]);

    const calm = await setup({ tasks: [...breakerTasks("FF"), running("T9")], config: { consecutiveFailures: 3, minAttempts: 50 } });
    await calm.policy.park("T9", "escalate", "q");
    expect(phaseOf(calm).paused).toBe(false);
    expect(calm.l().inbox.filter((x) => x.kind === "breaker")).toEqual([]);
  });

  it("QA-4.2-22: park(qa-unparsable) journals the runtime's breaker-fed marker after the feed; escalate writes none", async () => {
    expect(BREAKER_FED).toBe("breaker-fed");
    const env = await setup({
      tasks: [...breakerTasks("FF"), running("Q1", { kind: "qa" })], gate: "qa-running",
      config: { consecutiveFailures: 3, minAttempts: 50 },
    });
    await env.policy.park("Q1", "qa-unparsable", "no json");
    const marker = {
      type: "metric", metric: { name: "counter", key: "breaker-fed", value: 1, labels: { phaseId: "p1", taskId: "Q1", n: "1" } },
    };
    expect(env.writer.batches).toEqual([[marker]]);
    // park batch, release, wake; the feed trips (one batch, one wake); then the marker
    expect(env.journal).toEqual(["append", "release:Q1", "wake:inbox:F-1", "append", "wake:inbox:B-2", "append"]);

    const calm = await setup({ tasks: [running("T9")] });
    await calm.policy.park("T9", "escalate", "q");
    expect(calm.writer.batches).toEqual([]);
  });

  it("QA-4.2-22: a marker append that fails is logged and does not fail the park", async () => {
    const env = await setup({ tasks: [running("Q1", { kind: "qa" })], gate: "qa-running" });
    env.writer.failOn = (b) => JSON.stringify(b).includes(BREAKER_FED);
    const got = await env.policy.park("Q1", "qa-unparsable", "no json");
    expect(got).toMatchObject({ kind: "failure", taskId: "Q1" });
    expect(env.state("Q1")).toBe("parked");
    expect(env.logs).toEqual(["breaker-fed marker append failed"]);
  });

  it("a breaker trip then its answer round-trips through the policy", async () => {
    const env = await setup({ tasks: breakerTasks("FFF") });
    await feed(env, 2);
    expect(phaseOf(env).paused).toBe(true);
    expect(await env.policy.answer("B-1", "resume please")).toEqual({ resumed: null });
    expect(phaseOf(env).paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Branch top-up (task 4.2.6)
// ---------------------------------------------------------------------------------------------------------------

describe("branch top-up: pure helpers", () => {
  it("pendingDependentsClosure ignores an edge to a task that does not exist", () => {
    const l = buildDraft(0);
    l.tasks["A"] = task("A", "running");
    l.edges = [edge("A", "GHOST")];
    expect(pendingDependentsClosure(l, "A")).toEqual([]);
  });

  it("two attempts of one task that end at the same instant are ordered by attempt number", async () => {
    const t = task("A", "failed", { attempts: [failed(1, 5), failed(2, 5)] });
    const env = await setup({ tasks: [t] });
    expect(breakerSamples(env.l(), "p1").map((s) => `${s.taskId}#${s.n}`)).toEqual(["A#1", "A#2"]);
  });

  it("the window starts at the newest breaker item of the phase; items of no task, of a task of no phase and older items do not move it", async () => {
    const tasks = [...breakerTasks("FFFFF"), task("O", "failed", { phase: null, attempts: [failed(1, 1)] })];
    const inbox = [
      item("B-1", { kind: "breaker", severity: "critical", taskId: "B0", answer: "go", createdAt: at(3) }),
      item("B-2", { kind: "breaker", severity: "critical", taskId: null, answer: "go", createdAt: at(100) }),
      item("B-3", { kind: "breaker", severity: "critical", taskId: "O", answer: "go", createdAt: at(100) }),
      item("B-4", { kind: "breaker", severity: "critical", taskId: "B1", answer: "go", createdAt: at(2) }),
    ];
    const env = await setup({ tasks, inbox });
    expect(breakerSamples(env.l(), "p1").map((s) => s.taskId)).toEqual(["B3", "B4"]);
  });
});

describe("branch top-up: answer", () => {
  it("an item answered after it was answered by a concurrent writer is E_INVALID_INPUT and keeps the first answer", async () => {
    const env = await setup({ tasks: [running("T1")] });
    const q = await env.policy.park("T1", "escalate", "which?");
    env.writer.beforeNext = async () => { await env.policy.answer(q.id, "first"); };
    expect((await rejects(env.policy.answer(q.id, "late"))).code).toBe("E_INVALID_INPUT");
    expect(itemOf(env, q.id).answer).toBe("first");
    expect(lastAttempt(T(env, "T1")).context).toBe("first");
    expect(env.state("T1")).toBe("ready");
  });

  it("a breaker item that names no task, or a task of no phase, is only answered; the paused phase stays paused", async () => {
    const env = await setup({
      tasks: [task("O", "failed", { phase: null, attempts: [failed(1, 5)] })], paused: true,
      inbox: [
        item("B-1", { kind: "breaker", severity: "critical", taskId: null }),
        item("B-2", { kind: "breaker", severity: "critical", taskId: "O" }),
      ],
    });
    expect(await env.policy.answer("B-1", "ok")).toEqual({ resumed: null });
    expect(await env.policy.answer("B-2", "ok")).toEqual({ resumed: null });
    expect(itemOf(env, "B-1").answer).toBe("ok");
    expect(itemOf(env, "B-2").answer).toBe("ok");
    expect(phaseOf(env).paused).toBe(true);
  });

  it("a critical item that belongs to no phase does not keep the phase paused after a breaker answer", async () => {
    const env = await setup({
      tasks: [task("T1", "failed", { attempts: [failed(1, 5)] })], paused: true,
      inbox: [
        item("B-1", { kind: "breaker", severity: "critical", taskId: "T1" }),
        item("R-2", { kind: "qa-cap", severity: "critical", taskId: null, options: ["accept"] }),
      ],
    });
    await env.policy.answer("B-1", "go");
    expect(phaseOf(env).paused).toBe(false);
    expect(itemOf(env, "R-2").answer).toBeNull();
  });
});

describe("branch top-up: park", () => {
  it("a task of no phase parked as qa-unparsable fails its attempt and feeds no breaker (there is no phase to count it in)", async () => {
    const env = await setup({ tasks: [running("Q9", { phase: null })] });
    const got = await env.policy.park("Q9", "qa-unparsable", "no json");
    expect(got).toMatchObject({ kind: "failure", taskId: "Q9" });
    expect(lastAttempt(T(env, "Q9")).outcome).toBe("failed");
    expect(phaseOf(env)).toMatchObject({ gate: "pending", paused: false });
    expect(env.l().inbox.filter((x) => x.kind === "breaker")).toEqual([]);
    expect(env.waker.calls.map((c) => c.key)).toEqual(["inbox:F-1"]);
  });
});

describe("branch top-up: recordAttempt", () => {
  it("a failure fed for a phase the ledger does not have trips nothing and writes nothing", async () => {
    const env = await setup({ tasks: breakerTasks("FFF") });
    const seq = env.l().seq;
    expect(await env.policy.recordAttempt("nope", lastAttempt(T(env, "B2")))).toEqual({ tripped: false });
    expect(env.l().seq).toBe(seq);
    expect(env.waker.calls).toEqual([]);
  });
});
