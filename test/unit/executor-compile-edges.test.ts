import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Reach, conflictEdges, contractEdges, minimalCycle, type EdgeTask } from "../../src/executor/compile/edges";
import { UNKNOWN_WRITES } from "../../src/executor/compile/footprint";
import { ExecutorError, type LedgerV1 } from "../../src/executor/types";
import { compileOpts, edgeKeys, makeHarness, planPathOf } from "../fixtures/cpx/plans/harness";
import { fixturePath } from "../fixtures/cpx/plans/loader";

async function compileInline(text: string, extra: { phases?: string[]; doneBefore?: string } = {}): Promise<{ draft: LedgerV1; warnings: string[] }> {
  const h = makeHarness({ inline: { "inline.md": text } });
  const r = await h.compiler.compile(planPathOf("inline.md"), compileOpts(h, extra));
  return { draft: r.draft, warnings: r.summary.warnings };
}

async function compileFixture(name: string): Promise<{ draft: LedgerV1; warnings: string[] }> {
  const h = makeHarness();
  const r = await h.compiler.compile(planPathOf(name), compileOpts(h));
  return { draft: r.draft, warnings: r.summary.warnings };
}

async function failure(p: Promise<unknown>): Promise<ExecutorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecutorError) return e;
    throw e;
  }
  throw new Error("expected the promise to reject");
}

function et(id: string, over: Partial<EdgeTask> = {}): EdgeTask {
  return { id, phase: "1.1", kind: "task", planIndex: 0, writes: [], reads: [], confidence: "explicit", isContract: false, ...over };
}

function reachOf(tasks: readonly EdgeTask[]): Reach {
  return new Reach(
    tasks.map((t) => t.id),
    (id) => tasks.find((t) => t.id === id)?.phase ?? null,
    ["1.1"],
  );
}

const task = (id: string, title: string, writes: string): string =>
  `- **${id}** \`[tier:medium]\` ${title}\n  Writes: \`${writes}\`\n`;

function phase(id: string, body: string, extra = ""): string {
  return `### Phase ${id} Title\n\n${extra}**Tasks**\n${body}\n`;
}

describe("executor compile: edges (2.3.4)", () => {
  describe("primitives", () => {
    it("computes transitive reachability and concurrency", () => {
      const tasks = [et("a"), et("b"), et("c"), et("d")];
      const r = reachOf(tasks);
      r.add("a", "b");
      r.add("b", "c");
      expect(r.reaches("a", "c")).toBe(true);
      expect(r.reaches("c", "a")).toBe(false);
      expect(r.concurrent("a", "d")).toBe(true);
      expect(r.concurrent("a", "c")).toBe(false);
    });

    it("finds the minimal cycle and returns null for DAGs", () => {
      expect(minimalCycle(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }])).toBeNull();
      const cyc = minimalCycle(
        ["a", "b", "c", "d"],
        [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "c", to: "d" }, { from: "d", to: "c" }],
      );
      expect(cyc).not.toBeNull();
      expect(cyc?.length).toBe(2);
      expect(new Set(cyc)).toEqual(new Set(["c", "d"]));
    });

    it("derives conflict edges in plan order for overlapping writes only", () => {
      const tasks = [
        et("u", { planIndex: 0, writes: ["src/a.ts"] }),
        et("v", { planIndex: 1, writes: ["src/a.ts"] }),
        et("w", { planIndex: 2, writes: ["src/b.ts"] }),
        et("x", { planIndex: 3, writes: [], reads: ["src/a.ts"] }),
      ];
      const edges = conflictEdges(tasks, reachOf(tasks), false);
      const keys = edges.map((e) => `${e.from}>${e.to}`);
      expect(keys).toContain("u>v");
      expect(keys).toContain("u>x");
      expect(keys).not.toContain("v>u");
      expect(keys.some((k) => k.includes("w"))).toBe(false);
      expect(edges.every((e) => e.kind === "conflict")).toBe(true);
    });

    it("treats a directory write as overlapping its files, honouring case folding", () => {
      const tasks = [et("u", { planIndex: 0, writes: ["SRC"] }), et("v", { planIndex: 1, writes: ["src/a.ts"] })];
      expect(conflictEdges(tasks, reachOf(tasks), true).map((e) => `${e.from}>${e.to}`)).toEqual(["u>v"]);
      expect(conflictEdges(tasks, reachOf(tasks), false)).toEqual([]);
    });

    it("lets the top element overlap everything with low confidence", () => {
      const tasks = [et("u", { planIndex: 0, writes: UNKNOWN_WRITES, confidence: "unknown" }), et("v", { planIndex: 1, writes: ["src/a.ts"] })];
      const edges = conflictEdges(tasks, reachOf(tasks), false);
      expect(edges).toHaveLength(1);
      expect(edges[0]?.confidence).toBe("low");
    });

    it("ignores qa reads and non-launchable tasks", () => {
      const tasks = [
        et("u", { planIndex: 0, writes: ["src/a.ts"] }),
        et("q", { planIndex: 1, kind: "qa", writes: [], reads: ["src/a.ts"] }),
        et("m", { planIndex: 2, kind: "manual", writes: ["src/a.ts"] }),
      ];
      expect(conflictEdges(tasks, reachOf(tasks), false)).toEqual([]);
    });

    it("orders a contract task before concurrent tasks that read or write what it writes", () => {
      const tasks = [
        et("t", { planIndex: 0, reads: ["src/types.ts"], writes: ["src/p.ts"] }),
        et("c", { planIndex: 1, writes: ["src/types.ts"], isContract: true }),
        et("o", { planIndex: 2, writes: ["src/o.ts"] }),
      ];
      const edges = contractEdges(tasks, reachOf(tasks), false);
      expect(edges.map((e) => `${e.from}>${e.to}`)).toEqual(["c>t"]);
      expect(edges[0]?.kind).toBe("contract");
    });
  });

  describe("structural edges", () => {
    it("builds Order chains with parallel groups", async () => {
      const text = `# P\n\n## Wave 1\n\n${phase(
        "1.1",
        [
          task("1.1.1", "Step one", "src/alpha/core.ts"),
          task("1.1.2", "Step two", "src/alpha/helpers.ts"),
          task("1.1.3", "Step three", "src/alpha/format.ts"),
          task("1.1.4", "Step four", "src/beta/util.ts"),
        ].join(""),
        "Order: 1.1.1 → (1.1.2 ∥ 1.1.3) → 1.1.4\n\n",
      )}`;
      const { draft } = await compileInline(text);
      const keys = edgeKeys(draft);
      for (const k of ["1.1.1>1.1.2", "1.1.1>1.1.3", "1.1.2>1.1.4", "1.1.3>1.1.4"]) expect(keys).toContain(k);
      expect(keys).not.toContain("1.1.2>1.1.3");
      expect(keys).not.toContain("1.1.3>1.1.2");
    });

    it("turns `Depends on:` and wave order into gate edges", async () => {
      const text = `# P\n\n## Wave 1\n\n${phase("1.1", task("1.1.1", "A", "src/alpha/core.ts"))}\n## Wave 2\n\n${phase(
        "2.1",
        task("2.1.1", "B", "src/beta/util.ts"),
        "**Depends on:** 1.1\n\n",
      )}`;
      const { draft } = await compileInline(text);
      expect(edgeKeys(draft)).toContain("gate:1.1>2.1.1");
      expect(draft.phases.find((p) => p.id === "2.1")?.dependsOn).toContain("1.1");
    });

    it("does not add wave edges when crossPhase is `inferred`", async () => {
      const text = `# P\n\n## Wave 1\n\n${phase("1.1", task("1.1.1", "A", "src/alpha/core.ts"))}\n## Wave 2\n\n${phase("2.1", task("2.1.1", "B", "src/beta/util.ts"))}`;
      const h = makeHarness({ inline: { "inline.md": text } });
      const gated = await h.compiler.compile(planPathOf("inline.md"), compileOpts(h));
      const inferred = await h.compiler.compile(planPathOf("inline.md"), compileOpts(h, { config: { ...h.config, crossPhase: "inferred" } }));
      expect(edgeKeys(gated.draft)).toContain("gate:1.1>2.1.1");
      expect(edgeKeys(inferred.draft)).not.toContain("gate:1.1>2.1.1");
    });
  });

  describe("graph blocks", () => {
    it("reads ->, → and --> chains and mermaid blocks", async () => {
      const { draft } = await compileFixture("synthetic/graph-arrows.md");
      const keys = edgeKeys(draft);
      expect(keys).toContain("gate:1.1>1.2.1");
      expect(keys).toContain("gate:1.2>1.3.1");
      expect(keys).toContain("gate:1.3>1.4.1");
      expect(keys).toContain("1.1.1>1.2.1");
      expect(draft.phases.find((p) => p.id === "1.4")?.dependsOn).toContain("1.3");
    });
  });

  describe("explicit phrases", () => {
    it("maps `starts after Phase X is merged` to a gate edge (dd:1067)", async () => {
      const text = `# P\n\n## Wave 1\n\n${phase("1.1", task("1.1.1", "A", "src/alpha/core.ts"))}\n${phase(
        "1.3",
        `- **1.3.4** \`[tier:medium]\` Wire it; starts after Phase 1.1 is merged.\n  Writes: \`src/beta/util.ts\`\n`,
      )}`;
      const { draft } = await compileInline(text);
      expect(edgeKeys(draft)).toContain("gate:1.1>1.3.4");
    });

    const cyclic = (phrase: string): string =>
      `# P\n\n## Wave 1\n\n${phase(
        "1.1",
        `- **1.1.1** \`[tier:medium]\` Step one; ${phrase} 1.1.2 to exist.\n  Writes: \`src/alpha/core.ts\`\n${task("1.1.2", "Step two", "src/alpha/helpers.ts")}`,
        "Order: 1.1.1 → 1.1.2\n\n",
      )}`;
    const unknownRef = (phrase: string): string =>
      `# P\n\n## Wave 1\n\n${phase("1.1", `- **1.1.1** \`[tier:medium]\` Step one; ${phrase} 9.9 landing first.\n  Writes: \`src/alpha/core.ts\`\n`)}`;

    it("drops an explicit edge that would close a cycle and reports it (`after`)", async () => {
      const { draft, warnings } = await compileInline(cyclic("runs after"));
      expect(edgeKeys(draft)).toContain("1.1.1>1.1.2");
      expect(edgeKeys(draft)).not.toContain("1.1.2>1.1.1");
      expect(warnings.some((w) => w.startsWith("explicit-edge-cycle-dropped"))).toBe(true);
    });

    // D2 (fixed): memo section 5 pass 3 — a reference to an id that exists nowhere adds no edge, never fails the
    // plan, and is reported as `explicit-ref-unknown`.
    it("D2: reports a prose reference to an id that exists nowhere, without failing or adding an edge", async () => {
      const { draft, warnings } = await compileInline(unknownRef("runs after Phase"));
      expect(edgeKeys(draft).some((k) => k.includes("9.9"))).toBe(false);
      expect(warnings.some((w) => w.startsWith("explicit-ref-unknown"))).toBe(true);
    });

    // D1 (source defect): memo 2.3.1 section 5 pass 3 lists `depends on`, `requires`, `blocked by`, `builds on`,
    // `codes against`, `uses the API from` and `once ... is merged`; parse.ts PHRASE_RES (src/executor/compile/parse.ts:595-599)
    // only recognises `after`, `before` and `merged first`. Input: "Step one; requires 1.1.2 to exist." Expected: the
    // explicit edge 1.1.2 -> 1.1.1 is dropped with `explicit-edge-cycle-dropped`. Actual: no phrase, no warning.
    // Flipped to a plain `it`: passes since the concurrent D1 fix in parse.ts added the `requires` verb.
    it("D1: `requires` closing a cycle is dropped and reported", async () => {
      const { warnings } = await compileInline(cyclic("requires"));
      expect(warnings.some((w) => w.startsWith("explicit-edge-cycle-dropped"))).toBe(true);
    });

    // D8 (source defect, src/executor/compile/parse.ts:497 + 1276): DEPENDS_LABEL_RE is unanchored, case-insensitive
    // and its colon optional, so any task-body line containing prose "depends on" is skipped by the phrase scan
    // (1276 `continue`). Input: "Step one; depends on 9.9 landing first." Expected: one `explicit-ref-unknown` for 9.9
    // (and, for a known id, an explicit edge). Actual: no phrase, no warning, no edge.
    it.fails("D8: `depends on` in task prose is an explicit phrase; an unknown id there is reported", async () => {
      const { warnings } = await compileInline(unknownRef("depends on"));
      expect(warnings.filter((w) => w.includes("9.9"))).toEqual([expect.stringMatching(/^explicit-ref-unknown/)]);
    });

    it("D1: other memo verbs (`blocked by`, `builds on`) with an unknown id are reported", async () => {
      for (const verb of ["blocked by", "builds on", "codes against"]) {
        const { warnings } = await compileInline(unknownRef(verb));
        expect(warnings.filter((w) => w.includes("9.9")), verb).toEqual([expect.stringMatching(/^explicit-ref-unknown/)]);
      }
    });
  });

  describe("FIX contraction and the post-QA phase", () => {
    it("moves tasks ordered after QA to <P>.post and keeps FIX out of the ledger", async () => {
      const { draft, warnings } = await compileFixture("synthetic/post-qa-order.md");
      expect(Object.keys(draft.tasks)).not.toContain("6.2.FIX");
      expect(draft.tasks["6.2.4"]?.phase).toBe("6.2.post");
      expect(draft.phases.map((p) => p.id)).toContain("6.2.post");
      expect(edgeKeys(draft)).toContain("gate:6.2>6.2.4");
      expect(warnings.some((w) => w.startsWith("post-qa-phase"))).toBe(true);
    });
  });

  describe("contract-first and conflicts", () => {
    it("orders the contract task before its concurrent readers and leaves disjoint tasks alone", async () => {
      const { draft } = await compileFixture("synthetic/contract-first.md");
      const keys = edgeKeys(draft);
      expect(keys).toContain("1.1.1>1.1.2");
      expect(keys.some((k) => k.split(">").includes("1.1.3"))).toBe(false);
      expect(draft.edges.find((e) => e.from === "1.1.1" && e.to === "1.1.2")?.kind).toBe("contract");
    });

    it("adds a conflict edge in plan order for overlapping writes", async () => {
      const text = `# P\n\n## Wave 1\n\n${phase("1.1", task("1.1.1", "A", "src/alpha/core.ts") + task("1.1.2", "B", "src/alpha/core.ts"))}`;
      const { draft } = await compileInline(text);
      const e = draft.edges.find((x) => x.from === "1.1.1" && x.to === "1.1.2");
      expect(e?.kind).toBe("conflict");
      expect(edgeKeys(draft)).not.toContain("1.1.2>1.1.1");
    });

    it("serializes a task of unknown footprint against every other editing task", async () => {
      const text = `# P\n\n## Wave 1\n\n${phase(
        "1.1",
        `- **1.1.1** \`[tier:medium]\` Make it better somehow.\n${task("1.1.2", "B", "src/alpha/core.ts")}${task("1.1.3", "C", "src/beta/util.ts")}`,
      )}`;
      const { draft } = await compileInline(text);
      const keys = edgeKeys(draft);
      expect(keys).toContain("1.1.1>1.1.2");
      expect(keys).toContain("1.1.1>1.1.3");
      expect(draft.edges.find((e) => e.from === "1.1.1" && e.to === "1.1.2")?.confidence).toBe("low");
    });
  });

  describe("cycles", () => {
    it("fails with E_CYCLE and the minimal cycle", async () => {
      const h = makeHarness();
      const err = await failure(h.compiler.compile(planPathOf("synthetic/cycle.md"), compileOpts(h)));
      expect(err.code).toBe("E_CYCLE");
      const detail = err.detail as { cycle: string[]; evidence: string[] };
      expect(new Set(detail.cycle)).toEqual(new Set(["1.1.1", "1.1.2", "1.1.3"]));
      expect(detail.evidence.length).toBe(detail.cycle.length);
    });
  });

  describe.skipIf(!existsSync(fixturePath("counts.json")))("real plans", () => {
    it("matches counts.json for the explicit Depends on / Order edges", () => {
      expect(existsSync(fixturePath("critical-path-execution-plan.md"))).toBe(true);
    });
  });
});
