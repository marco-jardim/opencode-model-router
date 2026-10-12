// test/unit/executor-schedule.test.ts
// Critical-path scheduler (3.1.2, memo phase-3.1 M9-M13). Deterministic: seeded PRNG, no wall clock.
// The reference list scheduler at the bottom is independent: plain arrays, its own levels, no import of bottomLevels.
import { describe, expect, it } from "vitest";
import {
  bottomLevels,
  createScheduler,
  edgeSatisfied,
  pathsOverlap,
  planOrder,
  taskDurationMs,
} from "../../src/executor/schedule.js";
import type {
  CapacityView,
  Edge,
  LeaseHolderInfo,
  LeaseView,
  LedgerV1,
  PhaseRecord,
  ScheduledTask,
  TaskNode,
  TaskRoute,
} from "../../src/executor/types.js";
import { buildDraft, PLAN_ID, taskNode } from "../fixtures/cpx/ledger/builders.js";

const sched = createScheduler();

// ---- builders --------------------------------------------------------------------------------------------------

function phase(id: string, patch: Partial<PhaseRecord> = {}): PhaseRecord {
  return { id, title: `Phase ${id}`, wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null, ...patch };
}

function edge(from: string, to: string, kind: Edge["kind"] = "structural"): Edge {
  return { from, to, kind, confidence: "high", evidence: "test" };
}

/** A task with p50 = `p50`, no phase, state ready, writing `src/<id>.ts`. */
function task(id: string, p50: number, patch: Partial<TaskNode> = {}): TaskNode {
  return taskNode(id, {
    phase: null,
    state: "ready",
    estimate: { p50, p90: p50 * 2, source: "test" },
    footprint: { writes: [`src/${id}.ts`], reads: [], confidence: "explicit", sources: ["path"] },
    ...patch,
  });
}

interface Spec {
  tasks: TaskNode[];
  edges?: Edge[];
  phases?: PhaseRecord[];
  status?: LedgerV1["status"];
}

function ledgerOf(s: Spec): LedgerV1 {
  const l = buildDraft(0);
  l.tasks = {};
  for (const t of s.tasks) l.tasks[t.id] = t;
  l.edges = s.edges ?? [];
  l.phases = s.phases ?? [phase("p1")];
  l.waves = [{ id: "w1", phases: l.phases.map((p) => p.id) }];
  if (s.status !== undefined) l.status = s.status;
  return l;
}

function at(l: LedgerV1, id: string): TaskNode {
  const t = Object.hasOwn(l.tasks, id) ? l.tasks[id] : undefined;
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
}

function gateOf(l: LedgerV1, id: string): PhaseRecord {
  const p = l.phases.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no phase ${id}`);
  return p;
}

function route(provider: string, heavy = false): TaskRoute {
  return { agent: heavy ? "heavy" : "fast", model: { providerID: provider, modelID: "m", variant: null }, provider, heavy };
}

interface CapacityDouble extends CapacityView {
  freeCalls: string[];
}

/** `free` per provider ({normal, heavy}); `routes` per task id (default: provider "p", not heavy). */
function capacityOf(
  free: Record<string, { normal: number; heavy?: number }>,
  routes: Record<string, TaskRoute> = {},
): CapacityDouble {
  const freeCalls: string[] = [];
  return {
    freeCalls,
    routeOf: (t) => routes[t.id] ?? route("p"),
    free: (p, heavy) => {
      freeCalls.push(`${p}:${String(heavy)}`);
      const f = free[p];
      if (f === undefined) return 0;
      return heavy ? (f.heavy ?? Math.min(2, f.normal)) : f.normal;
    },
  };
}

const NO_LEASES: LeaseView = { holder: () => null };
const CAP4 = (): CapacityDouble => capacityOf({ p: { normal: 4 } });

function leasesOf(map: Record<string, LeaseHolderInfo>): LeaseView {
  return { holder: (path) => map[path] ?? null };
}

function ids(r: readonly ScheduledTask[]): string[] {
  return r.map((s) => s.taskId);
}

function ready(l: LedgerV1, cap: CapacityView = CAP4(), inFlight: ReadonlySet<string> = new Set(), leases: LeaseView = NO_LEASES): string[] {
  return ids(sched.readySet(l, inFlight, leases, cap));
}

// ---- pure helpers ----------------------------------------------------------------------------------------------

describe("taskDurationMs", () => {
  it("is the p50 of a live task and 0 for a cancelled task or a non-finite or negative estimate", () => {
    expect(taskDurationMs(task("a", 1500))).toBe(1500);
    expect(taskDurationMs(task("a", 1500, { state: "cancelled" }))).toBe(0);
    expect(taskDurationMs(task("a", Number.NaN))).toBe(0);
    expect(taskDurationMs(task("a", -5))).toBe(0);
  });
});

describe("planOrder", () => {
  it("is the insertion order of ledger.tasks and survives a JSON round trip", () => {
    const l = ledgerOf({ tasks: [task("zeta", 1), task("alpha", 1), task("m-1", 1)] });
    const order = planOrder(l);
    expect([...order.entries()]).toEqual([["zeta", 0], ["alpha", 1], ["m-1", 2]]);
    const round = JSON.parse(JSON.stringify(l)) as LedgerV1;
    expect([...planOrder(round).entries()]).toEqual([...order.entries()]);
  });
});

describe("edgeSatisfied", () => {
  const l = ledgerOf({
    tasks: [task("i", 1, { state: "integrated" }), task("d", 1, { state: "done" }), task("v", 1, { state: "verified" }), task("x", 1)],
    phases: [phase("p1", { gate: "passed" }), phase("p2", { gate: "awaiting-qa" })],
  });
  it("accepts a task source that is integrated or done, and nothing else", () => {
    expect(edgeSatisfied(l, edge("i", "x"))).toBe(true);
    expect(edgeSatisfied(l, edge("d", "x"))).toBe(true);
    expect(edgeSatisfied(l, edge("v", "x"))).toBe(false);
    expect(edgeSatisfied(l, edge("missing", "x"))).toBe(false);
    expect(edgeSatisfied(l, edge("constructor", "x"))).toBe(false);
  });
  it("accepts a gate source only when that gate has passed", () => {
    expect(edgeSatisfied(l, edge("gate:p1", "x"))).toBe(true);
    expect(edgeSatisfied(l, edge("gate:p2", "x"))).toBe(false);
    expect(edgeSatisfied(l, edge("gate:nope", "x"))).toBe(false);
  });
});

describe("pathsOverlap", () => {
  it("is true for equal paths and '/'-segment prefixes, after ASCII case folding", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/lib", "src/lib/x.ts")).toBe(true);
    expect(pathsOverlap("src/lib/x.ts", "src/lib")).toBe(true);
    expect(pathsOverlap("SRC/Lib", "src/lib/X.ts")).toBe(true);
  });
  it("is false for a character prefix that is not a segment prefix, and for disjoint paths", () => {
    expect(pathsOverlap("src/a", "src/ab")).toBe(false);
    expect(pathsOverlap("src/a.ts", "test/a.ts")).toBe(false);
  });
  it("folds ASCII only, and treats an empty path as the whole repository", () => {
    expect(pathsOverlap("src/\u00C9", "src/\u00E9")).toBe(false);
    expect(pathsOverlap("", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "")).toBe(true);
  });
});

// ---- bottom levels (M9) ----------------------------------------------------------------------------------------

describe("bottomLevels", () => {
  it("chain: sums the p50 of the tail", () => {
    const l = ledgerOf({ tasks: [task("a", 10), task("b", 20), task("c", 30)], edges: [edge("a", "b"), edge("b", "c")] });
    expect(Object.fromEntries(bottomLevels(l))).toEqual({ a: 60, b: 50, c: 30 });
  });

  it("diamond: takes the longest successor", () => {
    const l = ledgerOf({
      tasks: [task("a", 1), task("b", 5), task("c", 3), task("d", 2)],
      edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    });
    expect(Object.fromEntries(bottomLevels(l))).toEqual({ a: 8, b: 7, c: 5, d: 2 });
  });

  it("a cancelled task contributes 0; edges of every kind count", () => {
    const l = ledgerOf({
      tasks: [task("a", 1), task("b", 100, { state: "cancelled" }), task("c", 7)],
      edges: [edge("a", "b", "learned"), edge("b", "c", "llm")],
    });
    expect(Object.fromEntries(bottomLevels(l))).toEqual({ a: 8, b: 7, c: 7 });
  });

  it("gate successors (M9 b/c): a phase's tasks inherit its qa tasks and the targets of its gate", () => {
    const l = ledgerOf({
      tasks: [
        task("x", 10, { phase: "p1" }),
        task("q", 5, { phase: "p1", kind: "qa" }),
        task("q2", 1, { phase: "p1", kind: "qa" }),
        task("y", 50, { phase: "p2" }),
      ],
      edges: [edge("gate:p1", "y")],
      phases: [phase("p1"), phase("p2")],
    });
    const bl = bottomLevels(l);
    expect(bl.get("y")).toBe(50);
    expect(bl.get("q")).toBe(55); // (c) only: a qa task does not wait for the other qa tasks
    expect(bl.get("q2")).toBe(51);
    expect(bl.get("x")).toBe(65); // 10 + max(bl(q) = 55, bl(q2) = 51, bl(y) = 50)
  });

  it("ignores self edges, unknown endpoints and gate edges to unknown tasks; a cycle cannot hang it", () => {
    const l = ledgerOf({
      tasks: [task("a", 2), task("b", 3)],
      edges: [edge("a", "a"), edge("a", "ghost"), edge("ghost", "b"), edge("gate:p1", "ghost"), edge("a", "b"), edge("b", "a")],
    });
    // The b -> a back edge contributes 0 once a is on the DFS stack.
    expect(Object.fromEntries(bottomLevels(l))).toEqual({ a: 5, b: 3 });
  });

  it("handles a 5000-task chain without recursion", () => {
    const tasks: TaskNode[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < 5000; i++) {
      tasks.push(task(`c${i}`, 1));
      if (i > 0) edges.push(edge(`c${i - 1}`, `c${i}`));
    }
    expect(bottomLevels(ledgerOf({ tasks, edges })).get("c0")).toBe(5000);
  });
});

// ---- readySet (M11) --------------------------------------------------------------------------------------------

const NO_WRITES: TaskNode["footprint"] = { writes: [], reads: [], confidence: "unknown", sources: [] };

function writing(...writes: string[]): TaskNode["footprint"] {
  return { writes, reads: [], confidence: "explicit", sources: ["path"] };
}

describe("readySet", () => {
  it("diamond: the root, then both branches longest first, then the join", () => {
    const l = ledgerOf({
      tasks: [task("a", 1), task("b", 3, { state: "pending" }), task("c", 5, { state: "pending" }), task("d", 2, { state: "pending" })],
      edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    });
    expect(ready(l)).toEqual(["a"]);
    expect(sched.promotable(l).toReady).toEqual([]);
    at(l, "a").state = "done";
    expect(sched.promotable(l).toReady).toEqual(["b", "c"]);
    at(l, "b").state = "ready";
    at(l, "c").state = "ready";
    expect(ready(l)).toEqual(["c", "b"]);
    at(l, "b").state = "integrated";
    expect(sched.promotable(l).toReady).toEqual([]);
    at(l, "c").state = "done";
    expect(sched.promotable(l).toReady).toEqual(["d"]);
  });

  it("chain: only the head is selected, even when the tail is (stale) ready", () => {
    const l = ledgerOf({ tasks: [task("a", 1), task("b", 1), task("c", 1)], edges: [edge("a", "b"), edge("b", "c")] });
    expect(ready(l)).toEqual(["a"]);
    at(l, "a").state = "verified";
    expect(ready(l)).toEqual([]);
    at(l, "a").state = "integrated";
    expect(ready(l)).toEqual(["b"]);
  });

  it("wide fan-out: cut at the free capacity, highest bottom level first", () => {
    const kids = Array.from({ length: 10 }, (_, i) => task(`k${i}`, (i + 1) * 10));
    const l = ledgerOf({ tasks: [task("root", 1, { state: "done" }), ...kids], edges: kids.map((k) => edge("root", k.id)) });
    const r = sched.readySet(l, new Set(), NO_LEASES, CAP4());
    expect(ids(r)).toEqual(["k9", "k8", "k7", "k6"]);
    expect(r.map((s) => s.bottomLevelMs)).toEqual([100, 90, 80, 70]);
    expect(ready(l, capacityOf({ p: { normal: 0 } }))).toEqual([]);
  });

  it("two phases with a gate: the next phase waits until the gate has passed", () => {
    const l = ledgerOf({
      tasks: [task("x", 10, { phase: "p1", state: "done" }), task("y", 10, { phase: "p2", state: "pending" }), task("z", 10, { phase: "p2" })],
      edges: [edge("gate:p1", "y"), edge("gate:p1", "z")],
      phases: [phase("p1", { gate: "awaiting-qa" }), phase("p2")],
    });
    expect(sched.promotable(l).toReady).toEqual([]);
    expect(ready(l)).toEqual([]);
    gateOf(l, "p1").gate = "qa-running";
    expect(sched.promotable(l).toReady).toEqual([]);
    gateOf(l, "p1").gate = "passed";
    expect(sched.promotable(l).toReady).toEqual(["y"]);
    expect(ready(l)).toEqual(["z"]);
  });

  it("crossPhase inferred: an inferred task edge crosses phases without waiting for the gate", () => {
    const l = ledgerOf({
      tasks: [task("x", 10, { phase: "p1" }), task("w", 10, { phase: "p1" }), task("y", 10, { phase: "p2", state: "pending" })],
      edges: [edge("x", "y", "graph")],
      phases: [phase("p1"), phase("p2")],
    });
    l.config.crossPhase = "inferred";
    expect(sched.promotable(l).toReady).toEqual([]);
    at(l, "x").state = "done";
    expect(gateOf(l, "p1").gate).toBe("pending");
    expect(sched.promotable(l).toReady).toEqual(["y"]);
    at(l, "y").state = "ready";
    expect(ready(l)).toEqual(["w", "y"]);
  });

  it("orders by bottom level descending, ties by plan order (not by id)", () => {
    const l = ledgerOf({
      tasks: [task("zeta", 5), task("alpha", 5), task("long", 9), task("mid", 5), task("tail", 4, { state: "pending" })],
      edges: [edge("mid", "tail")],
    });
    expect(ready(l, capacityOf({ p: { normal: 8 } }))).toEqual(["long", "mid", "zeta", "alpha"]);
  });

  it("gate successors (M9 b/c) put a gating task ahead of a longer task with no tail", () => {
    const l = ledgerOf({
      tasks: [
        task("solo", 50),
        task("x", 10, { phase: "p1" }),
        task("q", 5, { phase: "p1", kind: "qa", state: "pending" }),
        task("y", 60, { phase: "p2", state: "pending" }),
      ],
      edges: [edge("gate:p1", "y")],
      phases: [phase("p1"), phase("p2")],
    });
    // bl(x) = 10 + max(bl(q) = 5 + 60, bl(y) = 60) = 75 > bl(solo) = 50
    expect(sched.readySet(l, new Set(), NO_LEASES, capacityOf({ p: { normal: 1 } })))
      .toEqual([{ taskId: "x", route: route("p"), bottomLevelMs: 75 }]);
  });

  it("soft write check: a write held by anyone but the task's own holder excludes it", () => {
    const l = ledgerOf({ tasks: [task("a", 9), task("b", 8), task("c", 7), task("d", 6), task("e", 5, { footprint: NO_WRITES })] });
    const leases = leasesOf({
      "src/a.ts": { planId: PLAN_ID, taskId: "a", holderID: "ses-child-of-a" },
      "src/b.ts": { planId: PLAN_ID, taskId: "other", holderID: `plan:${PLAN_ID}:other` },
      "src/c.ts": { planId: "plan-two", taskId: "c", holderID: "plan:plan-two:c" },
      "src/d.ts": { planId: null, taskId: null, holderID: "ses-adhoc" },
    });
    expect(ready(l, capacityOf({ p: { normal: 8 } }), new Set(), leases)).toEqual(["a", "e"]);
  });

  it("in-selection overlap: a later overlapping candidate is delayed; the others still go", () => {
    const l = ledgerOf({
      tasks: [
        task("dir", 9, { footprint: writing("src/Lib") }),
        task("file", 8, { footprint: writing("src/lib/x.ts") }),
        task("other", 7, { footprint: writing("src/library.ts") }),
      ],
    });
    expect(ready(l)).toEqual(["dir", "other"]);
    expect(ready(l, CAP4(), new Set(["dir", "other"]))).toEqual(["file"]);
  });

  it("excludes manual and preflight tasks, tasks in flight and tasks that are not ready", () => {
    const l = ledgerOf({
      tasks: [
        task("m", 9, { kind: "manual" }),
        task("pf", 9, { kind: "preflight" }),
        task("f", 8),
        task("t", 7, { kind: "tests" }),
        task("fx", 6, { kind: "fix" }),
        task("run", 5, { state: "running" }),
        task("pend", 5, { state: "pending" }),
      ],
    });
    expect(ready(l, capacityOf({ p: { normal: 8 } }), new Set(["f"]))).toEqual(["t", "fx"]);
  });

  it("excludes the tasks of a paused or unknown phase", () => {
    const l = ledgerOf({
      tasks: [task("a", 3, { phase: "p1" }), task("b", 2, { phase: "p2" }), task("c", 1, { phase: "nope" })],
      phases: [phase("p1", { paused: true }), phase("p2")],
    });
    expect(ready(l)).toEqual(["b"]);
    gateOf(l, "p1").paused = false;
    expect(ready(l)).toEqual(["a", "b"]);
  });

  it.each(["compiling", "awaiting-residue", "awaiting-approval", "paused", "completed", "aborted"] as const)(
    "returns [] without asking capacity while the plan is %s",
    (status) => {
      const cap = CAP4();
      expect(ready(ledgerOf({ tasks: [task("a", 1)], status }), cap)).toEqual([]);
      expect(cap.freeCalls).toEqual([]);
    },
  );

  it("R16: a qa task is a candidate only while its phase gate is awaiting-qa", () => {
    const l = ledgerOf({ tasks: [task("q", 5, { phase: "p1", kind: "qa" }), task("q0", 5, { kind: "qa" })] });
    for (const g of ["pending", "suite-running", "suite-failed", "qa-running", "passed"] as const) {
      gateOf(l, "p1").gate = g;
      expect(ready(l), g).toEqual([]);
    }
    gateOf(l, "p1").gate = "awaiting-qa";
    expect(ready(l)).toEqual(["q"]);
  });

  it("heavy cap: a heavy pick takes both counters, a non-heavy pick only the normal one", () => {
    const routes = { h1: route("p", true), h2: route("p", true), h3: route("p", true) };
    const l = ledgerOf({ tasks: [task("h1", 9), task("h2", 8), task("h3", 7), task("n1", 6), task("n2", 5)] });
    expect(ready(l, capacityOf({ p: { normal: 4, heavy: 2 } }, routes))).toEqual(["h1", "h2", "n1", "n2"]);
    expect(ready(l, capacityOf({ p: { normal: 3, heavy: 2 } }, routes))).toEqual(["h1", "h2", "n1"]);
    expect(ready(l, capacityOf({ p: { normal: 4, heavy: 0 } }, routes))).toEqual(["n1", "n2"]);
    expect(ready(l, capacityOf({ p: { normal: 1, heavy: 2 } }, routes))).toEqual(["h1"]);
  });

  it("providers are independent: a full provider skips only its own tasks; free is read once per provider", () => {
    const routes = { a1: route("A"), a2: route("A"), b1: route("B"), b2: route("B", true), c1: route("C") };
    const l = ledgerOf({ tasks: [task("a1", 9), task("b1", 8), task("a2", 7), task("b2", 6), task("c1", 5)] });
    const cap = capacityOf({ A: { normal: 0 }, B: { normal: 2, heavy: 1 } }, routes);
    const r = sched.readySet(l, new Set(), NO_LEASES, cap);
    expect(ids(r)).toEqual(["b1", "b2"]);
    expect(r.map((s) => s.route)).toEqual([route("B"), route("B", true)]);
    expect(cap.freeCalls).toEqual(["A:false", "A:true", "B:false", "B:true", "C:false", "C:true"]);
  });

  it("is deterministic and pure: same output twice and after a JSON round trip; the ledger is untouched", () => {
    const dag = randomDag(42);
    const l = dagLedger(dag);
    for (const t of Object.values(l.tasks)) t.state = "ready";
    l.edges = [];
    const before = JSON.stringify(l);
    const first = sched.readySet(l, new Set(), NO_LEASES, CAP4());
    expect(first).toHaveLength(4);
    expect(sched.readySet(l, new Set(), NO_LEASES, CAP4())).toEqual(first);
    expect(sched.readySet(JSON.parse(before) as LedgerV1, new Set(), NO_LEASES, CAP4())).toEqual(first);
    expect(JSON.stringify(l)).toBe(before);
  });
});

// ---- promotable / manualReady (M12) ----------------------------------------------------------------------------

describe("promotable", () => {
  it("lists pending tasks with every edge satisfied and blocked tasks whose dependencies are integrated or done", () => {
    const l = ledgerOf({
      tasks: [
        task("d", 1, { state: "done" }),
        task("i", 1, { state: "integrated" }),
        task("v", 1, { state: "verified" }),
        task("p-free", 1, { state: "pending" }),
        task("b-ok", 1, { state: "blocked" }),
        task("p-ok", 1, { state: "pending" }),
        task("p-wait", 1, { state: "pending" }),
        task("b-wait", 1, { state: "blocked" }),
        task("p-gate", 1, { state: "pending" }),
        task("p-gate-wait", 1, { state: "pending" }),
        task("r", 1, { state: "ready" }),
        task("f", 1, { state: "failed" }),
      ],
      edges: [
        edge("d", "p-ok"), edge("i", "p-ok"), edge("d", "p-wait"), edge("v", "p-wait"),
        edge("i", "b-ok"), edge("d", "b-ok"), edge("v", "b-wait"),
        edge("gate:p1", "p-gate"), edge("gate:p2", "p-gate-wait"),
      ],
      phases: [phase("p1", { gate: "passed" }), phase("p2", { gate: "awaiting-qa" })],
    });
    expect(sched.promotable(l)).toEqual({ toReady: ["p-free", "p-ok", "p-gate"], unblock: ["b-ok"] });
  });
});

describe("manualReady", () => {
  it("lists the ready manual and preflight tasks in plan order", () => {
    const l = ledgerOf({
      tasks: [
        task("m2", 1, { kind: "manual" }),
        task("t", 1),
        task("pf", 1, { kind: "preflight" }),
        task("m1", 1, { kind: "manual", state: "pending" }),
        task("m3", 1, { kind: "manual" }),
      ],
    });
    expect(sched.manualReady(l)).toEqual(["m2", "pf", "m3"]);
  });
});

describe("done satisfies its dependents", () => {
  it("a done source promotes and admits its dependents like an integrated one", () => {
    const l = ledgerOf({
      tasks: [task("m", 1, { kind: "manual" }), task("n", 4, { state: "pending" }), task("o", 3)],
      edges: [edge("m", "n"), edge("m", "o")],
    });
    expect(sched.manualReady(l)).toEqual(["m"]);
    expect(sched.promotable(l).toReady).toEqual([]);
    expect(ready(l)).toEqual([]);
    at(l, "m").state = "done";
    expect(sched.manualReady(l)).toEqual([]);
    expect(sched.promotable(l).toReady).toEqual(["n"]);
    at(l, "n").state = "ready";
    expect(ready(l)).toEqual(["n", "o"]);
  });
});

// ---- learned edges (M13) ---------------------------------------------------------------------------------------

describe("addLearnedEdge", () => {
  const base = (): LedgerV1 =>
    ledgerOf({
      tasks: [task("h", 5, { state: "running" }), task("t", 5, { state: "running" }), task("u", 5, { state: "pending" }), task("v", 5, { state: "pending" })],
      edges: [edge("t", "u"), edge("u", "v")],
    });

  it("added: a learned edge holder -> blocked carrying the evidence; the ledger is untouched", () => {
    const l = base();
    const before = JSON.stringify(l);
    expect(sched.addLearnedEdge(l, "h", "t", "NEED MORE: lease src/x.ts")).toEqual({
      from: "h", to: "t", kind: "learned", confidence: "high", evidence: "NEED MORE: lease src/x.ts",
    });
    expect(sched.addLearnedEdge(l, "t", "v", "e")).not.toBeNull();
    expect(JSON.stringify(l)).toBe(before);
  });

  it("exists: null when an edge holder -> blocked of any kind is already there", () => {
    const l = base();
    l.edges.push(edge("h", "t", "graph"));
    expect(sched.addLearnedEdge(l, "h", "t", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "t", "u", "e")).toBeNull();
  });

  it("cycle: null when the blocked task already reaches the holder", () => {
    const l = base();
    expect(sched.addLearnedEdge(l, "u", "t", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "v", "t", "e")).toBeNull();
  });

  it("cycle through gate successors (M9 b/c) is a cycle too", () => {
    const l = ledgerOf({
      tasks: [task("x", 1, { phase: "p1" }), task("q", 1, { phase: "p1", kind: "qa" }), task("y", 1, { phase: "p2" })],
      edges: [edge("gate:p1", "y")],
      phases: [phase("p1"), phase("p2")],
    });
    expect(sched.addLearnedEdge(l, "q", "x", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "y", "x", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "y", "q", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "x", "y", "e")).toMatchObject({ from: "x", to: "y", kind: "learned" });
  });

  it("null for a self edge and for unknown tasks", () => {
    const l = base();
    expect(sched.addLearnedEdge(l, "t", "t", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "ghost", "t", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "h", "ghost", "e")).toBeNull();
    expect(sched.addLearnedEdge(l, "h", "constructor", "e")).toBeNull();
  });
});

// ---- 100 seeded random DAGs, p = 4 -----------------------------------------------------------------------------

const P = 4;

function nth<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error(`index ${i} out of range`);
  return v;
}

/** mulberry32: a small seeded PRNG in [0, 1). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Edges always go from a lower to a higher index; `order` is the plan order (a permutation of the indexes). */
interface Dag {
  n: number;
  dur: number[];
  edges: Array<[number, number]>;
  order: number[];
}

function randomDag(seed: number): Dag {
  const rnd = mulberry32(seed);
  const n = 5 + Math.floor(rnd() * 36);
  const density = 0.03 + rnd() * 0.3;
  const dur = Array.from({ length: n }, () => 1000 * (1 + Math.floor(rnd() * 20)));
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rnd() < density) edges.push([i, j]);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = nth(order, i);
    order[i] = nth(order, j);
    order[j] = tmp;
  }
  return { n, dur, edges, order };
}

const nodeId = (i: number): string => `t${i}`;

function dagLedger(dag: Dag): LedgerV1 {
  return ledgerOf({
    tasks: dag.order.map((i) => task(nodeId(i), nth(dag.dur, i), { state: "pending", footprint: NO_WRITES })),
    edges: dag.edges.map(([a, b]) => edge(nodeId(a), nodeId(b))),
  });
}

interface Run {
  makespan: number;
  starts: string[];
}

/** Event simulation driving the scheduler: promote, select, run to the next completion, mark done. */
function runScheduler(dag: Dag): Run {
  const l = dagLedger(dag);
  const ends = new Map<string, number>();
  const cap: CapacityView = { routeOf: () => route("p"), free: () => P - ends.size };
  const starts: string[] = [];
  let now = 0;
  for (;;) {
    for (const id of sched.promotable(l).toReady) at(l, id).state = "ready";
    for (const s of sched.readySet(l, new Set(), NO_LEASES, cap)) {
      at(l, s.taskId).state = "running";
      ends.set(s.taskId, now + taskDurationMs(at(l, s.taskId)));
      starts.push(s.taskId);
    }
    expect(ends.size).toBeLessThanOrEqual(P);
    if (ends.size === 0) break;
    now = Math.min(...ends.values());
    for (const [id, end] of [...ends]) {
      if (end !== now) continue;
      at(l, id).state = "done";
      ends.delete(id);
    }
  }
  expect(Object.values(l.tasks).every((t) => t.state === "done")).toBe(true);
  return { makespan: now, starts };
}

/** Independent reference: highest-level-first list scheduling over plain arrays (ties by plan order). */
function referenceSchedule(dag: Dag): Run & { criticalPath: number } {
  const succ: number[][] = Array.from({ length: dag.n }, () => []);
  const indeg: number[] = new Array<number>(dag.n).fill(0);
  for (const [a, b] of dag.edges) {
    nth(succ, a).push(b);
    indeg[b] = nth(indeg, b) + 1;
  }
  // Every edge goes from a lower to a higher index, so a descending sweep visits successors first.
  const level: number[] = new Array<number>(dag.n).fill(0);
  for (let i = dag.n - 1; i >= 0; i--) {
    let tail = 0;
    for (const s of nth(succ, i)) tail = Math.max(tail, nth(level, s));
    level[i] = nth(dag.dur, i) + tail;
  }
  const rank: number[] = new Array<number>(dag.n).fill(0);
  dag.order.forEach((i, k) => {
    rank[i] = k;
  });
  let waiting = Array.from({ length: dag.n }, (_, i) => i).filter((i) => nth(indeg, i) === 0);
  let running: Array<{ i: number; end: number }> = [];
  const starts: string[] = [];
  let now = 0;
  let finished = 0;
  while (finished < dag.n) {
    waiting.sort((a, b) => nth(level, b) - nth(level, a) || nth(rank, a) - nth(rank, b));
    const take = waiting.slice(0, P - running.length);
    waiting = waiting.slice(take.length);
    for (const i of take) {
      running.push({ i, end: now + nth(dag.dur, i) });
      starts.push(nodeId(i));
    }
    now = Math.min(...running.map((r) => r.end));
    for (const r of running.filter((x) => x.end === now)) {
      finished += 1;
      for (const s of nth(succ, r.i)) {
        indeg[s] = nth(indeg, s) - 1;
        if (indeg[s] === 0) waiting.push(s);
      }
    }
    running = running.filter((x) => x.end !== now);
  }
  return { makespan: now, starts, criticalPath: Math.max(...level) };
}

describe("100 seeded random DAGs with p = 4", () => {
  it("makespan <= (2 - 1/p) * max(CP, W/p), and the order matches an independent reference list scheduler", () => {
    let sizes = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const dag = randomDag(seed);
      sizes += dag.n;
      const ours = runScheduler(dag);
      const ref = referenceSchedule(dag);
      const work = dag.dur.reduce((s, d) => s + d, 0);
      expect(Math.max(...bottomLevels(dagLedger(dag)).values()), `seed ${seed} CP`).toBe(ref.criticalPath);
      const lower = Math.max(ref.criticalPath, work / P);
      expect(ours.makespan, `seed ${seed} lower bound`).toBeGreaterThanOrEqual(lower);
      expect(ours.makespan, `seed ${seed} Graham bound`).toBeLessThanOrEqual((2 - 1 / P) * lower);
      const ratio = ours.makespan / ref.makespan;
      expect(ratio, `seed ${seed} ratio`).toBeGreaterThanOrEqual(1.0);
      expect(ratio, `seed ${seed} ratio`).toBeLessThanOrEqual(1.15);
      expect(ours.starts, `seed ${seed} order`).toEqual(ref.starts);
    }
    expect(sizes).toBeGreaterThan(100 * 5);
  });
});
