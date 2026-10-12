import { describe, expect, it } from "vitest";
import {
  Reach,
  buildEdges,
  conflictEdges,
  contractEdges,
  explicitEdges,
  graphEdges,
  minimalCycle,
  structuralEdges,
  structuralWarnings,
  type EdgeTask,
} from "../../src/executor/compile/edges";
import { UNKNOWN_WRITES } from "../../src/executor/compile/footprint";
import type { ExplicitPhrase, GraphBlock, ParsedPhase, ParsedPlan, ParsedWave } from "../../src/executor/compile/parse";
import { ExecutorError, type Edge, type TaskKind } from "../../src/executor/types";

function T(id: string, phase: string | null, o: Partial<EdgeTask> = {}): EdgeTask {
  return { id, phase, kind: "task" as TaskKind, planIndex: 0, writes: [], reads: [], confidence: "explicit", isContract: false, ...o };
}

function indexed(list: EdgeTask[]): EdgeTask[] {
  return list.map((t, i) => ({ ...t, planIndex: t.planIndex === 0 ? i : t.planIndex }));
}

function phase(id: string, o: Partial<ParsedPhase> = {}): ParsedPhase {
  return {
    id, title: id, wave: `w-${id}`, span: { line: 1, endLine: 2 }, dogfood: false, synthetic: false,
    dependsOn: [], order: null, fixTemplate: null, intro: "", newTests: null, ...o,
  };
}

function wave(id: string, phases: string[], line = 1): ParsedWave {
  return { id, title: id, line, phases };
}

function plan(o: { phases?: ParsedPhase[]; waves?: ParsedWave[]; graphs?: GraphBlock[]; phrases?: ExplicitPhrase[] } = {}): ParsedPlan {
  return {
    waves: o.waves ?? [], phases: o.phases ?? [], tasks: [], graphs: o.graphs ?? [], ownership: [], phrases: o.phrases ?? [],
    sharedContextRaw: "", sharedContextSource: "preamble", warnings: [],
  };
}

function g(...pairs: Array<[string, string]>): GraphBlock {
  return { line: 1, edges: pairs.map(([from, to], i) => ({ from, to, line: 10 + i, raw: `${from} -> ${to}` })) };
}

function phr(subject: ExplicitPhrase["subject"], verb: string, refs: string[], excerpt = "text", line = 7): ExplicitPhrase {
  return { subject, verb, refs, line, excerpt };
}

const keys = (es: readonly Edge[]): string[] => es.map((e) => `${e.from}>${e.to}`);

describe("Reach", () => {
  it("closes transitively and reports concurrency", () => {
    const r = new Reach(["a", "b", "c", "d"], () => null, []);
    r.add("a", "b");
    r.add("b", "c");
    expect(r.reaches("a", "c")).toBe(true);
    expect(r.reaches("c", "a")).toBe(false);
    expect(r.concurrent("a", "d")).toBe(true);
    expect(r.concurrent("a", "c")).toBe(false);
    expect(r.concurrent("a", "a")).toBe(false);
    r.add("a", "b");
    r.add("a", "a");
    r.add("c", "d");
    expect(r.reaches("a", "d")).toBe(true);
  });

  it("lets every task reach the gate of its phase", () => {
    const r = new Reach(["a", "b"], (id) => (id === "a" ? "P" : id === "b" ? "unknown-phase" : null), ["P"]);
    expect(r.reaches("a", "gate:P")).toBe(true);
    expect(r.reaches("b", "gate:P")).toBe(false);
    r.add("gate:P", "b");
    expect(r.reaches("a", "b")).toBe(true);
  });

  it("rejects unknown nodes and handles more than 32 nodes", () => {
    const ids = Array.from({ length: 70 }, (_, i) => `n${i}`);
    const r = new Reach([...ids, "n0"], () => null, ["P", "P"]);
    for (let i = 0; i + 1 < ids.length; i += 1) r.add(`n${i}`, `n${i + 1}`);
    expect(r.reaches("n0", "n69")).toBe(true);
    expect(r.reaches("n69", "n0")).toBe(false);
    expect(() => r.add("n0", "ghost")).toThrow(ExecutorError);
    expect(() => r.reaches("ghost", "n0")).toThrow(/unknown node/);
  });

  it("works with no nodes at all", () => {
    expect(() => new Reach([], () => null, [])).not.toThrow();
  });
});

describe("structuralEdges", () => {
  it("stages preflight, work, tests and QA when there is no Order", () => {
    const tasks = indexed([T("pf", "P", { kind: "preflight" }), T("a", "P"), T("b", "P"), T("t", "P", { kind: "tests" }), T("q", "P", { kind: "qa" }), T("loose", null)]);
    const e = structuralEdges(plan({ phases: [phase("P")] }), tasks, "inferred");
    expect(keys(e)).toEqual(["pf>a", "pf>b", "a>t", "b>t", "t>q"]);
    expect(e.every((x) => x.kind === "structural" && x.confidence === "high" && x.evidence.startsWith("stage L1:"))).toBe(true);
  });

  it("skips empty stages and post phases", () => {
    const tasks = indexed([T("a", "P"), T("q", "P", { kind: "qa" }), T("x", "P.post"), T("y", "P.post")]);
    const e = structuralEdges(plan({ phases: [phase("P"), phase("P.post", { synthetic: true })] }), tasks, "inferred");
    expect(keys(e)).toEqual(["a>q"]);
  });

  it("follows an Order chain, linking unlisted preflight and QA", () => {
    const order = { groups: [["a"], ["b", "c"]], line: 5, raw: "Order: a → (b ∥ c)" };
    const tasks = indexed([T("pf", "P", { kind: "preflight" }), T("a", "P"), T("b", "P"), T("c", "P"), T("P.QA", "P", { kind: "qa" })]);
    const e = structuralEdges(plan({ phases: [phase("P", { order })] }), tasks, "inferred");
    expect(keys(e).sort()).toEqual(["a>b", "a>c", "b>P.QA", "c>P.QA", "pf>a"].sort());
    expect(e[0]?.evidence.startsWith("order L5:")).toBe(true);
  });

  it("contracts items that are not ledger tasks and warns about unlisted tasks", () => {
    const order = { groups: [["a"], ["P.FIX"], ["b"]], line: 5, raw: "Order: a → FIX → b" };
    const tasks = indexed([T("a", "P"), T("b", "P"), T("extra", "P"), T("xt", "P", { kind: "tests" }), T("q", "P", { kind: "qa" })]);
    const p = plan({ phases: [phase("P", { order })] });
    const e = structuralEdges(p, tasks, "inferred");
    expect(keys(e)).toContain("a>b");
    expect(keys(e)).toContain("extra>xt");
    expect(keys(e)).toContain("xt>q");
    const w = structuralWarnings(p, tasks);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: "order-unlisted", line: 5 });
    expect(w[0]?.message).toContain("extra, xt");
  });

  it("copes with an Order chain that names nothing", () => {
    const order = { groups: [], line: 2, raw: "Order:" };
    const tasks = indexed([T("a", "P")]);
    expect(structuralEdges(plan({ phases: [phase("P", { order })] }), tasks, "inferred")).toEqual([]);
    expect(structuralWarnings(plan({ phases: [phase("P", { order })] }), tasks)).toHaveLength(1);
  });

  it("adds gate edges for Depends on, skipping external, self and unknown phases", () => {
    const deps = [
      { id: "P0", external: false, line: 3 },
      { id: "DF1", external: true, line: 3 },
      { id: "P1", external: false, line: 3 },
      { id: "nope", external: false, line: 3 },
    ];
    const tasks = indexed([T("z", "P0"), T("a", "P1"), T("b", "P1")]);
    const e = structuralEdges(plan({ phases: [phase("P0"), phase("P1", { dependsOn: deps })] }), tasks, "inferred");
    expect(keys(e).sort()).toEqual(["gate:P0>a", "gate:P0>b"]);
    expect(e[0]?.evidence).toContain("depends-on L3");
  });

  it("chains waves through gates, passing over dogfood-only waves", () => {
    const phases = [phase("P0"), phase("DF1", { dogfood: true }), phase("P1")];
    const waves = [wave("w2", ["P1"], 30), wave("w1", ["P0"], 10), wave("wd", ["DF1"], 20)];
    const tasks = indexed([T("a", "P0"), T("d", "DF1"), T("b", "P1")]);
    const gate = structuralEdges(plan({ phases, waves }), tasks, "gate");
    expect(keys(gate)).toEqual(["gate:P0>d", "gate:P0>b"]);
    expect(gate[1]?.evidence).toContain("wave-gate L30");
    expect(structuralEdges(plan({ phases, waves }), tasks, "inferred")).toEqual([]);
  });

  it("ignores waves that name unknown phases", () => {
    const tasks = indexed([T("a", "P0"), T("b", "P1")]);
    const e = structuralEdges(plan({ phases: [phase("P0"), phase("P1")], waves: [wave("w1", ["ghost", "P0"]), wave("w2", ["P1"], 2)] }), tasks, "gate");
    expect(keys(e)).toEqual(["gate:P0>b"]);
  });
});

describe("graphEdges", () => {
  const phases = [phase("P0"), phase("P1")];
  const waves = [wave("w1", ["P0"]), wave("w2", ["P1"])];
  const tasks = indexed([T("a", "P0"), T("b", "P0"), T("c", "P1")]);

  it("links tasks, phases and waves", () => {
    const p = plan({ phases, waves, graphs: [g(["a", "b"], ["P0", "P1"], ["w1", "w2"], ["a", "a"], ["P0", "P0"])] });
    const r = graphEdges(p, tasks);
    expect(keys(r.edges)).toContain("a>b");
    expect(keys(r.edges)).toContain("gate:P0>c");
    expect(r.edges.every((e) => e.kind === "graph" && e.confidence === "high")).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("warns for a node outside the run unless the plan does not know it", () => {
    const p = plan({ phases, waves, graphs: [g(["a", "gone"], ["other", "b"], ["x", "y"])] });
    const all = graphEdges(p, tasks);
    expect(all.edges).toEqual([]);
    expect(all.warnings.map((w) => w.code)).toEqual(["ref-outside-run", "ref-outside-run", "ref-outside-run", "ref-outside-run"]);
    expect(all.warnings[0]?.line).toBe(10);
    const known = graphEdges(p, tasks, new Set(["gone", "other"]));
    expect(known.warnings).toHaveLength(2);
    expect(known.warnings[0]?.message).toContain("gone is not part of this run");
  });

  it("does not resolve dogfood phases to gates", () => {
    const p = plan({ phases: [phase("DF1", { dogfood: true }), phase("P0")], graphs: [g(["DF1", "a"])] });
    expect(graphEdges(p, indexed([T("a", "P0")])).edges).toEqual([]);
  });
});

describe("explicitEdges", () => {
  const phases = [phase("P0"), phase("P1")];
  const waves = [wave("w1", ["P0", "P1"])];
  const base = indexed([T("a", "P0"), T("b", "P0"), T("c", "P1")]);
  const run = (phrases: ExplicitPhrase[], tasks = base, ci = false): ReturnType<typeof explicitEdges> => explicitEdges(plan({ phases, waves, phrases }), tasks, ci);

  it("orders after and before between tasks with high confidence", () => {
    const r = run([phr({ kind: "task", id: "b" }, "after", ["a"], "b after a"), phr({ kind: "task", id: "a" }, "before", ["c"], "a before c")]);
    expect(keys(r.edges)).toEqual(["a>b", "a>c"]);
    expect(r.edges.every((e) => e.confidence === "high" && e.kind === "explicit")).toBe(true);
    expect(r.edges[0]?.evidence).toBe("explicit-after L7: b after a");
  });

  it("uses medium confidence for phase references unless the text says merged", () => {
    const r = run([
      phr({ kind: "phase", id: "P1" }, "after", ["P0"], "after P0"),
      phr({ kind: "phase", id: "P0" }, "before", ["P1"], "P0 before P1 merges"),
    ]);
    expect(r.edges.map((e) => [e.from, e.to, e.confidence])).toEqual([["gate:P0", "c", "medium"]]);
    const merged = run([phr({ kind: "phase", id: "P1" }, "after", ["P0"], "after P0 merges")]);
    expect(merged.edges[0]?.confidence).toBe("high");
  });

  it("reports unknown subjects, references and verbs", () => {
    const r = run([
      phr({ kind: "task", id: "ghost" }, "after", ["a"]),
      phr({ kind: "task", id: "a" }, "after", ["ghost"]),
      phr({ kind: "task", id: "a" }, "sideways", ["b"]),
    ]);
    expect(r.edges).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(["explicit-ref-unknown", "explicit-ref-unknown", "explicit-verb-unknown"]);
  });

  it("resolves merged-first for a wave through contract tasks", () => {
    const tasks = indexed([
      T("c", "P0", { isContract: true, writes: ["src/types.ts"] }),
      T("u", "P1", { reads: ["src/types.ts"] }),
      T("v", "P1", { writes: ["src/other.ts"] }),
      T("w", "P0", { writes: ["src/types.ts"] }),
    ]);
    const r = run([phr({ kind: "wave", id: "w1" }, "merged-first", ["c"], "c merged first")], tasks);
    expect(keys(r.edges).sort()).toEqual(["c>u", "c>w"]);
    expect(r.edges.every((e) => e.confidence === "medium")).toBe(true);
  });

  it("excludes the phases of a phase reference from wave merged-first targets", () => {
    const tasks = indexed([T("c", "P0", { isContract: true, writes: ["x"] }), T("same", "P0", { writes: ["x"] }), T("other", "P1", { writes: ["x"] })]);
    const r = run([phr({ kind: "wave", id: "w1" }, "merged-first", ["P0"], "P0 merged first")], tasks);
    expect(keys(r.edges)).toEqual(["c>other"]);
  });

  it("matches top write sets in wave merged-first", () => {
    const tasks = indexed([
      T("c", "P0", { isContract: true, writes: UNKNOWN_WRITES }),
      T("top", "P1", { writes: UNKNOWN_WRITES }),
      T("empty", "P1"),
      T("some", "P1", { reads: ["f"] }),
    ]);
    const r = run([phr({ kind: "wave", id: "w1" }, "merged-first", ["c"])], tasks);
    expect(keys(r.edges).sort()).toEqual(["c>some", "c>top"]);
    const c2 = indexed([T("c", "P0", { isContract: true, writes: ["f"] }), T("top", "P1", { writes: UNKNOWN_WRITES }), T("rd", "P1", { reads: ["f"], kind: "qa" })]);
    expect(keys(run([phr({ kind: "wave", id: "w1" }, "merged-first", ["c"])], c2).edges)).toEqual(["c>top"]);
  });

  it("warns when merged-first finds no contract, no reference or an unknown one", () => {
    const r = run([
      phr({ kind: "wave", id: "w1" }, "merged-first", [], "merged first"),
      phr({ kind: "wave", id: "w1" }, "merged-first", ["ghost"]),
      phr({ kind: "wave", id: "w1" }, "merged-first", ["a"]),
      phr({ kind: "phase", id: "P0" }, "merged-first", ["a"]),
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual([
      "explicit-merged-first-unresolved",
      "explicit-ref-unknown",
      "explicit-merged-first-unresolved",
    ]);
  });

  it("truncates long excerpts in evidence", () => {
    const r = run([phr({ kind: "task", id: "b" }, "after", ["a"], `${"word ".repeat(60)}end`)]);
    expect(r.edges[0]?.evidence.length).toBeLessThan(160);
  });
});

describe("contractEdges", () => {
  const mk = (list: EdgeTask[]): { tasks: EdgeTask[]; reach: Reach } => {
    const tasks = indexed(list);
    return { tasks, reach: new Reach(tasks.map((t) => t.id), (id) => tasks.find((t) => t.id === id)?.phase ?? null, ["P"]) };
  };

  it("orders a contract task before concurrent tasks that touch its writes", () => {
    const { tasks, reach } = mk([
      T("c", "P", { isContract: true, writes: ["src/types.ts"] }),
      T("r", "P", { reads: ["src/types.ts"] }),
      T("w", "P", { writes: ["src/types.ts/x"] }),
      T("n", "P", { writes: ["elsewhere"] }),
      T("o", "Q", { writes: ["src/types.ts"] }),
    ]);
    const e = contractEdges(tasks, reach, false);
    expect(keys(e)).toEqual(["c>r", "c>w"]);
    expect(e[0]).toMatchObject({ kind: "contract", confidence: "medium", evidence: "contract: c writes src/types.ts" });
    expect(reach.reaches("c", "r")).toBe(true);
  });

  it("handles top write sets and skips ordered or phase-less contracts", () => {
    const { tasks, reach } = mk([
      T("c", "P", { isContract: true, writes: UNKNOWN_WRITES }),
      T("top", "P", { writes: UNKNOWN_WRITES }),
      T("rd", "P", { reads: ["f"] }),
      T("empty", "P"),
    ]);
    const e = contractEdges(tasks, reach, false);
    expect(e.map((x) => x.evidence)).toEqual(["contract: c writes *", "contract: c writes f"]);

    const two = mk([T("c", "P", { isContract: true, writes: ["f"] }), T("top", "P", { writes: UNKNOWN_WRITES }), T("free", null, { isContract: true, writes: ["f"] })]);
    expect(contractEdges(two.tasks, two.reach, false).map((x) => x.evidence)).toEqual(["contract: c writes f"]);

    const ordered = mk([T("c", "P", { isContract: true, writes: ["f"] }), T("t", "P", { writes: ["f"] })]);
    ordered.reach.add("t", "c");
    expect(contractEdges(ordered.tasks, ordered.reach, false)).toEqual([]);
  });

  it("compares case-insensitively when asked", () => {
    const { tasks, reach } = mk([T("c", "P", { isContract: true, writes: ["Src/A.ts"] }), T("t", "P", { writes: ["src/a.ts"] })]);
    expect(contractEdges(tasks, reach, false)).toEqual([]);
    expect(contractEdges(tasks, reach, true)).toHaveLength(1);
  });
});

describe("conflictEdges", () => {
  const run = (list: EdgeTask[], ci = false, pre: Array<[string, string]> = []): Edge[] => {
    const tasks = indexed(list);
    const reach = new Reach(tasks.map((t) => t.id), () => null, []);
    for (const [a, b] of pre) reach.add(a, b);
    return conflictEdges(tasks, reach, ci);
  };

  it("chains concurrent writers of one path through the nearest predecessor", () => {
    const e = run([T("a", null, { writes: ["f"] }), T("b", null, { writes: ["f"] }), T("c", null, { writes: ["f"] })]);
    expect(keys(e)).toEqual(["a>b", "b>c"]);
    expect(e[0]).toMatchObject({ kind: "conflict", confidence: "high", evidence: "conflict: write/write f" });
  });

  it("classifies write/read and read/write", () => {
    expect(run([T("a", null, { writes: ["f"] }), T("b", null, { reads: ["f"] })])[0]?.evidence).toBe("conflict: write/read f");
    expect(run([T("a", null, { reads: ["f"] }), T("b", null, { writes: ["f"] })])[0]?.evidence).toBe("conflict: read/write f");
    expect(run([T("a", null, { reads: ["f"] }), T("b", null, { reads: ["f"] })])).toEqual([]);
  });

  it("ignores QA reads and non-launchable kinds, and respects existing order", () => {
    expect(run([T("a", null, { writes: ["f"] }), T("q", null, { kind: "qa", reads: ["f"] })])).toEqual([]);
    expect(run([T("a", null, { writes: ["f"] }), T("m", null, { kind: "manual", writes: ["f"] })])).toEqual([]);
    expect(run([T("a", null, { writes: ["f"] }), T("b", null, { writes: ["f"] })], false, [["a", "b"]])).toEqual([]);
  });

  it("relates directories to the files beneath them in both directions", () => {
    expect(keys(run([T("a", null, { writes: ["src"] }), T("b", null, { writes: ["src/x/y.ts"] })]))).toEqual(["a>b"]);
    expect(keys(run([T("a", null, { writes: ["src/x/y.ts"] }), T("b", null, { writes: ["src"] })]))).toEqual(["a>b"]);
    expect(keys(run([T("a", null, { writes: ["src/x"] }), T("b", null, { writes: ["lib/x"] })]))).toEqual([]);
  });

  it("gives low confidence to top write sets and medium to weak footprints", () => {
    const top = run([T("a", null, { writes: UNKNOWN_WRITES }), T("b", null, { writes: ["f"] }), T("c", null, { writes: UNKNOWN_WRITES })]);
    expect(top.every((e) => e.confidence === "low")).toBe(true);
    expect(top.map((e) => e.evidence)).toEqual(["conflict: write/write f", "conflict: write/write f"]);
    const weak = run([T("a", null, { writes: ["f"], confidence: "inferred" }), T("b", null, { writes: ["f"] })]);
    expect(weak[0]?.confidence).toBe("medium");
    const owned = run([T("a", null, { writes: ["f"], confidence: "ownership" }), T("b", null, { writes: ["f"] })]);
    expect(owned[0]?.confidence).toBe("high");
  });

  it("matches a top task against reads and against every earlier non-empty task", () => {
    const e = run([T("a", null, { reads: ["f"] }), T("e", null), T("t", null, { writes: UNKNOWN_WRITES })]);
    expect(keys(e)).toEqual(["a>t"]);
    expect(e[0]?.evidence).toBe("conflict: read/write f");
    const later = run([T("t", null, { writes: UNKNOWN_WRITES }), T("b", null, { reads: ["z"] })]);
    expect(later[0]?.evidence).toBe("conflict: write/read z");
  });

  it("folds case only with ci", () => {
    const l = [T("a", null, { writes: ["Dir/File.ts"] }), T("b", null, { writes: ["dir/file.ts"] })];
    expect(run(l, false)).toEqual([]);
    expect(run(l, true)).toHaveLength(1);
  });
});

describe("minimalCycle", () => {
  const E = (...p: Array<[string, string]>): Array<{ from: string; to: string }> => p.map(([from, to]) => ({ from, to }));

  it("finds nothing in an acyclic graph", () => {
    expect(minimalCycle(["a", "b", "c"], E(["a", "b"], ["b", "c"]))).toBeNull();
    expect(minimalCycle([], [])).toBeNull();
  });

  it("returns a self loop alone", () => {
    expect(minimalCycle(["a", "b"], E(["b", "b"]))).toEqual(["b"]);
  });

  it("returns the shortest cycle, rotated to its smallest id, and ignores unknown nodes", () => {
    const edges = E(["c", "a"], ["a", "b"], ["b", "c"], ["a", "x"], ["ghost", "a"], ["b", "ghost"]);
    expect(minimalCycle(["a", "b", "c", "a"], edges)).toEqual(["a", "b", "c"]);
  });

  it("prefers the shorter of two components and the smaller on a tie", () => {
    const nodes = ["a", "b", "c", "x", "y", "z"];
    const edges = E(["a", "b"], ["b", "c"], ["c", "a"], ["x", "y"], ["y", "x"], ["z", "z"]);
    expect(minimalCycle(nodes, edges)).toEqual(["z"]);
    expect(minimalCycle(["x", "y", "p", "q"], E(["x", "y"], ["y", "x"], ["p", "q"], ["q", "p"]))).toEqual(["p", "q"]);
    expect(minimalCycle(["p", "q", "x", "y"], E(["p", "q"], ["q", "p"], ["x", "y"], ["y", "x"]))).toEqual(["p", "q"]);
  });

  it("finds the short cycle inside a larger strongly connected component", () => {
    const edges = E(["a", "b"], ["b", "c"], ["c", "d"], ["d", "a"], ["b", "a"]);
    expect(minimalCycle(["a", "b", "c", "d"], edges)).toEqual(["a", "b"]);
  });
});

describe("buildEdges", () => {
  const phases = [phase("P0"), phase("P1")];

  it("combines every pass in precedence order", () => {
    const tasks = indexed([
      T("a", "P0", { writes: ["f"] }),
      T("b", "P0", { writes: ["f"] }),
      T("c", "P1", { writes: ["g"] }),
    ]);
    const p = plan({ phases, waves: [wave("w1", ["P0"]), wave("w2", ["P1"], 5)], phrases: [phr({ kind: "task", id: "c" }, "after", ["a"], "c after a")] });
    const r = buildEdges(p, tasks, { crossPhase: "gate", ci: false });
    expect(r.warnings).toEqual([]);
    const byKind = Object.fromEntries(r.edges.map((e) => [`${e.from}>${e.to}`, e.kind]));
    expect(byKind["gate:P0>c"]).toBe("structural");
    expect(byKind["a>c"]).toBe("explicit");
    expect(byKind["a>b"]).toBe("conflict");
  });

  it("collects warnings from every pass", () => {
    const order = { groups: [["a"]], line: 3, raw: "Order: a" };
    const p = plan({
      phases: [phase("P0", { order })],
      graphs: [g(["a", "gone"])],
      phrases: [phr({ kind: "task", id: "a" }, "after", ["ghost"])],
    });
    const r = buildEdges(p, indexed([T("a", "P0"), T("b", "P0")]), { crossPhase: "inferred", ci: false, planNodes: new Set(["gone"]) });
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["explicit-ref-unknown", "order-unlisted", "ref-outside-run"]);
  });

  it("throws E_CYCLE with the evidence of each edge of the cycle", () => {
    const p = plan({ phases, graphs: [g(["a", "b"], ["b", "a"])] });
    let err: unknown;
    try {
      buildEdges(p, indexed([T("a", "P0"), T("b", "P0")]), { crossPhase: "inferred", ci: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExecutorError);
    const x = err as ExecutorError;
    expect(x.code).toBe("E_CYCLE");
    expect(x.message).toBe("dependency cycle: a -> b -> a");
    expect((x.detail as { evidence: string[] }).evidence.every((s) => s.startsWith("graph L"))).toBe(true);
  });

  it("explains a cycle that runs through a phase gate", () => {
    const p = plan({ phases, graphs: [g(["P0", "a"])] });
    let err: unknown;
    try {
      buildEdges(p, indexed([T("a", "P0")]), { crossPhase: "inferred", ci: false });
    } catch (e) {
      err = e;
    }
    const evidence = (err as ExecutorError).detail as { cycle: string[]; evidence: string[] };
    expect(evidence.cycle.slice().sort()).toEqual(["a", "gate:P0"]);
    expect(evidence.evidence.some((s) => s.startsWith("phase-gate:"))).toBe(true);
  });

  it("drops an explicit edge that would close a cycle and keeps the structural order", () => {
    const tasks = indexed([T("a", "P0"), T("b", "P0")]);
    const p = plan({
      phases,
      graphs: [g(["a", "b"])],
      phrases: [phr({ kind: "task", id: "a" }, "after", ["b"], "a after b", 9), phr({ kind: "task", id: "b" }, "after", ["a"], "b after a", 11)],
    });
    const r = buildEdges(p, tasks, { crossPhase: "inferred", ci: false });
    expect(keys(r.edges)).toEqual(["a>b"]);
    expect(r.warnings.map((w) => [w.code, w.line])).toEqual([["explicit-edge-cycle-dropped", 9]]);
  });

  it("is deterministic regardless of the order tasks are given in", () => {
    const tasks = [T("b", "P0", { planIndex: 1, writes: ["f"] }), T("a", "P0", { planIndex: 0, writes: ["f"] })];
    const r = buildEdges(plan({ phases }), tasks, { crossPhase: "inferred", ci: false });
    expect(keys(r.edges)).toEqual(["a>b"]);
  });

  it("breaks plan-index ties by id", () => {
    const tasks = [T("z", "P0", { writes: ["f"] }), T("y", "P0", { writes: ["f"] })];
    const r = buildEdges(plan({ phases }), tasks, { crossPhase: "inferred", ci: false });
    expect(keys(r.edges)).toEqual(["y>z"]);
  });
});
