import { describe, expect, it } from "vitest";
import { INTEGRATION_ESTIMATE_MS, formatSummary, planEstimate, taskEstimate } from "../../src/executor/compile/estimate";
import type { DurationEstimate, DurationModel, DurationQuery } from "../../src/routing/outcomes/durations";
import type { CompileSummary, Edge, PhaseRecord, TaskKind, TaskNode, TaskState } from "../../src/executor/types";

function node(id: string, p50: number, o: { kind?: TaskKind; state?: TaskState; phase?: string | null } = {}): TaskNode {
  return {
    id,
    title: id,
    phase: o.phase ?? null,
    kind: o.kind ?? "task",
    text: "",
    subtasks: [],
    route: { line: "", role: "implementer", tier: "fast", pin: false },
    verify: "none",
    acceptance: null,
    footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] },
    estimate: { p50, p90: p50 * 2, source: "test" },
    state: o.state ?? "pending",
    attempts: [],
    slot: null,
    branch: null,
    integrated: null,
  };
}

function phase(id: string): PhaseRecord {
  return { id, title: id, wave: "w", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null };
}

function edge(from: string, to: string): Edge {
  return { from, to, kind: "explicit", confidence: "high", evidence: "t" };
}

function plan(tasks: TaskNode[], edges: Edge[] = [], phases: PhaseRecord[] = []): { tasks: Record<string, TaskNode>; edges: Edge[]; phases: PhaseRecord[] } {
  const rec: Record<string, TaskNode> = {};
  for (const t of tasks) rec[t.id] = t;
  return { tasks: rec, edges, phases };
}

const H = 3_600_000;

describe("planEstimate coverage", () => {
  it("is all zero for an empty plan", () => {
    expect(planEstimate(plan([]), 4)).toEqual({ workMs: 0, criticalPathMs: 0, width: 0, expectedMakespanMs: 0 });
  });

  it("sums a chain and takes the critical path over it", () => {
    const r = planEstimate(plan([node("A", H), node("B", 2 * H)], [edge("A", "B")]), 4);
    expect(r.workMs).toBe(3 * H);
    expect(r.criticalPathMs).toBe(3 * H);
    expect(r.width).toBe(1);
    expect(r.expectedMakespanMs).toBe(3 * H);
  });

  it("measures width of parallel tasks and divides work by effective parallelism", () => {
    const r = planEstimate(plan([node("A", H), node("B", H), node("C", H), node("D", H)]), 2);
    expect(r.width).toBe(4);
    expect(r.workMs).toBe(4 * H);
    expect(r.criticalPathMs).toBe(H);
    expect(r.expectedMakespanMs).toBe(2 * H);
  });

  it("clamps maxParallel below one to one", () => {
    const r = planEstimate(plan([node("A", H), node("B", H)]), 0);
    expect(r.expectedMakespanMs).toBe(2 * H);
  });

  it("does not count touching intervals as overlapping", () => {
    const r = planEstimate(plan([node("A", H), node("B", H)], [edge("A", "B")]), 8);
    expect(r.width).toBe(1);
  });

  it("charges the integration prior per launchable task when work is tiny", () => {
    const r = planEstimate(plan([node("A", 1), node("B", 1)]), 4);
    expect(r.expectedMakespanMs).toBe(2 * INTEGRATION_ESTIMATE_MS);
  });

  it("gives width 1 when launchable tasks all cost zero", () => {
    const r = planEstimate(plan([node("A", 0)]), 4);
    expect(r.width).toBe(1);
    expect(r.workMs).toBe(0);
    expect(r.expectedMakespanMs).toBe(INTEGRATION_ESTIMATE_MS);
  });

  it("excludes manual, preflight and finished tasks from cost and count", () => {
    const r = planEstimate(
      plan([
        node("M", H, { kind: "manual" }),
        node("P", H, { kind: "preflight" }),
        node("D", H, { state: "done" }),
        node("X", H, { state: "cancelled" }),
        node("I", H, { state: "integrated" }),
      ]),
      4,
    );
    expect(r).toEqual({ workMs: 0, criticalPathMs: 0, width: 0, expectedMakespanMs: 0 });
  });

  it("routes tasks through their phase gate and honours gate edges", () => {
    const r = planEstimate(
      plan([node("A", H, { phase: "p1" }), node("B", H, { phase: "p2" })], [edge("gate:p1", "B")], [phase("p1"), phase("p2")]),
      4,
    );
    expect(r.criticalPathMs).toBe(2 * H);
    expect(r.width).toBe(1);
  });

  it("ignores self edges, duplicate edges and edges to unknown nodes", () => {
    const r = planEstimate(
      plan([node("A", H), node("B", H)], [edge("A", "A"), edge("A", "B"), edge("A", "B"), edge("A", "ghost"), edge("ghost", "B")]),
      4,
    );
    expect(r.criticalPathMs).toBe(2 * H);
  });

  it("stays total on a cycle", () => {
    const r = planEstimate(plan([node("A", H), node("B", H), node("C", H)], [edge("A", "B"), edge("B", "A")]), 4);
    expect(r.workMs).toBe(3 * H);
    expect(r.criticalPathMs).toBe(H);
    expect(Number.isFinite(r.expectedMakespanMs)).toBe(true);
  });

  it("rounds fractional milliseconds", () => {
    const r = planEstimate(plan([node("A", 100000.4), node("B", 100000.4)], [edge("A", "B")]), 4);
    expect(r.workMs).toBe(200001);
    expect(r.criticalPathMs).toBe(200001);
  });
});

function stubModel(e: Partial<DurationEstimate>): { model: DurationModel; queries: DurationQuery[] } {
  const queries: DurationQuery[] = [];
  const model: DurationModel = {
    estimate: (q) => {
      queries.push(q);
      return { p50: 10, p90: 20, n: 0, source: "prior", p90Source: "prior", p90N: 0, ...e };
    },
    observe: () => undefined,
    load: () => Promise.resolve(),
  };
  return { model, queries };
}

describe("taskEstimate coverage", () => {
  const base = { kind: "task" as TaskKind, state: "pending" as TaskState, role: "implementer", tier: null, route: null };

  it("costs manual and preflight tasks nothing without asking the model", () => {
    const { model, queries } = stubModel({});
    expect(taskEstimate(model, { ...base, kind: "manual" })).toEqual({ p50: 0, p90: 0, source: "manual" });
    expect(taskEstimate(model, { ...base, kind: "preflight" })).toEqual({ p50: 0, p90: 0, source: "manual" });
    expect(queries).toEqual([]);
  });

  it("costs done tasks nothing", () => {
    const { model, queries } = stubModel({});
    const r = taskEstimate(model, { ...base, state: "done" });
    expect(r.p50).toBe(0);
    expect(r.p90).toBe(0);
    expect(r.source).toContain("done");
    expect(queries).toEqual([]);
  });

  it("queries by role with default class and scope", () => {
    const { model, queries } = stubModel({});
    expect(taskEstimate(model, base)).toEqual({ p50: 10, p90: 20, source: "prior" });
    expect(queries).toEqual([{ role: "implementer", class: "other", scope: "single" }]);
  });

  it("falls back to the tier, then to unknown, when the role is empty", () => {
    const { model, queries } = stubModel({});
    taskEstimate(model, { ...base, role: "", tier: "heavy" });
    taskEstimate(model, { ...base, role: "", tier: null });
    expect(queries.map((q) => q.role)).toEqual(["heavy", "unknown"]);
  });

  it("takes class and scope from the route line", () => {
    const { model, queries } = stubModel({});
    taskEstimate(model, { ...base, route: { class: "other", scope: "single", pin: false, ignored: [] } });
    taskEstimate(model, { ...base, route: { pin: false, ignored: [] } });
    expect(queries.map((q) => [q.class, q.scope])).toEqual([["other", "single"], ["other", "single"]]);
  });

  it("names both levels when the p90 comes from elsewhere", () => {
    const { model } = stubModel({ source: "exact", p90Source: "role" });
    expect(taskEstimate(model, base).source).toBe("exact/p90:role");
  });

  it("clamps negative p50 to zero and raises p90 to at least p50", () => {
    expect(taskEstimate(stubModel({ p50: -5, p90: -9 }).model, base)).toMatchObject({ p50: 0, p90: 0 });
    expect(taskEstimate(stubModel({ p50: 50, p90: 20 }).model, base)).toMatchObject({ p50: 50, p90: 50 });
  });
});

describe("formatSummary coverage", () => {
  const s: CompileSummary = {
    tasks: 3,
    phases: 2,
    edges: 1,
    workMs: 2 * H,
    criticalPathMs: H,
    width: 4,
    expectedMakespanMs: 1.5 * H,
    manual: ["M"],
    warnings: ["w1", "w2"],
  };

  it("renders every field with defaults when no context is given", () => {
    expect(formatSummary(s)).toBe("plan ?: 3 tasks · 2 phases · 1 edges · W 2.0h · CP 1.0h · width 4 · ≈1.5h (p=4) · manual 1 · 2 warnings");
  });

  it("uses plan id and caps parallelism by width", () => {
    expect(formatSummary(s, { planId: "demo", maxParallel: 2 })).toContain("plan demo:");
    expect(formatSummary(s, { maxParallel: 2 })).toContain("(p=2)");
    expect(formatSummary(s, { maxParallel: 9 })).toContain("(p=4)");
    expect(formatSummary(s, { maxParallel: 0 })).toContain("(p=1)");
  });

  it("falls back to one when width is zero", () => {
    expect(formatSummary({ ...s, width: 0 })).toContain("(p=1)");
  });
});
