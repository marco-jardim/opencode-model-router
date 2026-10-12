import { describe, expect, it } from "vitest";
import {
  VALIDATION_CODES,
  isEditingNode,
  isStrictRepoPath,
  isTopNode,
  validateLedger,
  type ValidationError,
} from "../../src/executor/compile/validate";
import {
  LAUNCH_HEADER_PATTERN,
  executorDefaults,
  formatLaunchHeader,
  type Edge,
  type LedgerV1,
  type PhaseRecord,
  type TaskKind,
  type TaskNode,
  type TaskState,
} from "../../src/executor/types";

function node(id: string, o: Partial<TaskNode> & { writes?: string[]; reads?: string[]; conf?: "explicit" | "unknown" } = {}): TaskNode {
  return {
    id,
    title: id,
    phase: o.phase ?? null,
    kind: o.kind ?? "task",
    text: "do it",
    subtasks: [],
    route: { line: "", role: "implementer", tier: "fast", pin: false },
    verify: "none",
    acceptance: null,
    footprint: {
      writes: o.writes ?? [],
      reads: o.reads ?? [],
      confidence: o.conf ?? "explicit",
      sources: ["path"],
    },
    estimate: { p50: 1, p90: 2, source: "test" },
    state: o.state ?? "pending",
    attempts: [],
    slot: null,
    branch: null,
    integrated: null,
  };
}

function phase(id: string): PhaseRecord {
  return { id, title: id, wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null };
}

function edge(from: string, to: string): Edge {
  return { from, to, kind: "explicit", confidence: "high", evidence: "test" };
}

function ledger(tasks: TaskNode[], edges: Edge[] = [], phases: PhaseRecord[] = [], sharedContext = ""): LedgerV1 {
  const rec: Record<string, TaskNode> = {};
  for (const t of tasks) rec[t.id] = t;
  return {
    schema: 1,
    planId: "plan-one",
    planPath: "/p/plan.md",
    planDigest: "0".repeat(64),
    repo: { key: "k", toplevel: "/r", baseBranch: "main", baseCommit: "a".repeat(40) },
    integration: { branch: "omr/plan-one/integration", worktree: "/w", head: "a".repeat(40) },
    launcher: "A",
    status: "awaiting-approval",
    orchestrator: { sessionID: "s", boundAt: "2026-01-01T00:00:00.000Z" },
    config: executorDefaults(),
    sharedContext,
    waves: [{ id: "w1", phases: phases.map((p) => p.id) }],
    phases,
    tasks: rec,
    edges,
    inbox: [],
    seq: 0,
  };
}

const own = (errs: ValidationError[]): ValidationError[] => errs.filter((e) => !e.code.startsWith("ledger:"));
const codes = (errs: ValidationError[]): string[] => errs.map((e) => e.code);

describe("validate coverage: path and node helpers", () => {
  it("accepts plain repo-relative '/' paths", () => {
    expect(isStrictRepoPath("src/a.ts")).toBe(true);
    expect(isStrictRepoPath("a")).toBe(true);
  });

  it.each(["", "a\\b", "a\0b", "/abs", "a//b", "./a", "a/../b", "a/", "C:/x", "a/b:c"])("rejects %j", (p) => {
    expect(isStrictRepoPath(p)).toBe(false);
  });

  it("lists the documented validation codes", () => {
    expect(VALIDATION_CODES).toContain("closure");
    expect(VALIDATION_CODES).toContain("cycle");
  });

  it("only editing kinds with unknown confidence are top", () => {
    const kinds: TaskKind[] = ["task", "tests", "fix", "qa", "manual", "preflight"];
    for (const k of kinds) {
      const t = node("A", { kind: k, conf: "unknown" });
      expect(isEditingNode(t)).toBe(k === "task" || k === "tests" || k === "fix");
      expect(isTopNode(t)).toBe(isEditingNode(t));
      expect(isTopNode(node("B", { kind: k }))).toBe(false);
    }
  });
});

describe("validate coverage: ids", () => {
  it("reports invalid, reserved and case-folded duplicate ids", () => {
    const errs = validateLedger(ledger([node("123"), node("Abc"), node("abc")]), { ci: true });
    const byCode = (c: string): ValidationError[] => errs.filter((e) => e.code === c);
    expect(byCode("id-invalid").map((e) => e.taskIds)).toEqual([["123"]]);
    expect(byCode("id-duplicate").map((e) => e.taskIds)).toEqual([["Abc", "abc"]]);
  });

  it("a reserved task id is reported as id-reserved (the branch is shadowed by isTaskId)", () => {
    const errs = validateLedger(ledger([node("constructor")]), { ci: false });
    expect(errs.filter((e) => e.code === "id-reserved").map((e) => e.taskIds)).toEqual([["constructor"]]);
  });

  it("reports unknown edge endpoints and pre-empts the ledger edge-endpoint violation", () => {
    const l = ledger([node("A")], [edge("A", "ghost"), edge("ghost2", "A"), edge("gate:nope", "A"), edge("ghost3", "ghost4")]);
    const errs = validateLedger(l, { ci: false });
    const unknown = errs.filter((e) => e.code === "id-unknown");
    expect(unknown).toHaveLength(4);
    expect(unknown[0]?.taskIds).toEqual(["A"]);
    expect(unknown[1]?.message).toContain("ghost2");
    expect(unknown[2]?.message).toContain("gate:nope");
    expect(unknown[3]?.taskIds).toEqual([]);
    expect(errs.some((e) => e.code === "ledger:edge-endpoint")).toBe(false);
  });

  it("maps ledger violations on edges and tasks back to task ids", () => {
    const a = node("A");
    const b = node("B");
    const bad = { ...b, state: "bogus" as TaskState };
    const errs = validateLedger(ledger([a, bad], [edge("A", "A"), edge("A", "B")]), { ci: false });
    const led = errs.filter((e) => e.code.startsWith("ledger:"));
    expect(led.length).toBeGreaterThan(0);
    expect(led.some((e) => e.taskIds.includes("B"))).toBe(true);
  });
});

describe("validate coverage: paths, cycles, qa", () => {
  it("flags non-repo read and write paths", () => {
    const errs = own(validateLedger(ledger([node("A", { writes: ["/abs"], reads: ["a/../b"] })]), { ci: false }));
    expect(codes(errs)).toEqual(["path-outside", "path-outside"]);
    expect(errs[0]?.message).toContain("write");
    expect(errs[1]?.message).toContain("read");
  });

  it("reports a dependency cycle through explicit edges", () => {
    const errs = own(validateLedger(ledger([node("A"), node("B")], [edge("A", "B"), edge("B", "A")]), { ci: false }));
    const c = errs.find((e) => e.code === "cycle");
    expect(c).toBeDefined();
    expect([...(c?.taskIds ?? [])].sort()).toEqual(["A", "B"]);
  });

  it("reports a cycle through a phase gate", () => {
    const l = ledger([node("A", { phase: "p1" }), node("B", { phase: "p1" })], [edge("gate:p1", "B")], [phase("p1")]);
    expect(codes(own(validateLedger(l, { ci: false })))).toContain("cycle");
  });

  it("flags several live qa tasks in one phase but not dead ones or other phases", () => {
    const l = ledger(
      [
        node("Q1", { kind: "qa", phase: "p1" }),
        node("Q2", { kind: "qa", phase: "p1" }),
        node("Q3", { kind: "qa", phase: "p1", state: "done" }),
        node("Q4", { kind: "qa", phase: "p2" }),
        node("Q5", { kind: "qa", phase: null }),
      ],
      [],
      [phase("p1"), phase("p2")],
    );
    const multi = validateLedger(l, { ci: false }).filter((e) => e.code === "qa-multiple");
    expect(multi).toHaveLength(1);
    expect(multi[0]?.taskIds).toEqual(["Q1", "Q2"]);
  });
});

describe("validate coverage: shared context header", () => {
  it("reports no header error for an empty sharedContext", () => {
    const errs = validateLedger(ledger([node("A")]), { ci: false });
    expect(errs.filter((e) => e.code.includes("shared-context-header"))).toEqual([]);
  });

  it("flags a sharedContext line shaped like a launch header", () => {
    const header = formatLaunchHeader({ planId: "plan-one", taskId: "A", attempt: 1, nonce: "a".repeat(32) });
    expect(LAUNCH_HEADER_PATTERN.test(header)).toBe(true);
    for (const sep of ["\n", "\r\n", "\r"]) {
      const errs = validateLedger(ledger([node("A")], [], [], `intro${sep}${header}${sep}tail`), { ci: false });
      const hits = errs.filter((e) => e.code === "shared-context-header" || e.code === "ledger:shared-context-header");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });

  it("reports a header after a unicode line separator exactly once", () => {
    const header = formatLaunchHeader({ planId: "plan-one", taskId: "A", attempt: 1, nonce: "a".repeat(32) });
    const errs = validateLedger(ledger([node("A")], [], [], `intro\u2028${header}`), { ci: false });
    const hits = errs.filter((e) => e.code === "shared-context-header" || e.code === "ledger:shared-context-header");
    expect(hits.length).toBe(1);
  });

  it("accepts an ordinary sharedContext", () => {
    const errs = validateLedger(ledger([node("A")], [], [], "hello\nworld"), { ci: false });
    expect(errs.some((e) => e.code === "shared-context-header")).toBe(false);
  });
});

describe("validate coverage: closure", () => {
  const closure = (l: LedgerV1, ci = false): ValidationError[] => validateLedger(l, { ci }).filter((e) => e.code === "closure");

  it("is silent with fewer than two live launchable tasks", () => {
    expect(closure(ledger([node("A", { writes: ["a"] }), node("B", { writes: ["a"], state: "done" })]))).toEqual([]);
    expect(closure(ledger([node("A", { writes: ["a"] }), node("M", { kind: "manual", writes: ["a"] })]))).toEqual([]);
  });

  it("flags concurrent write/write on the same path", () => {
    const errs = closure(ledger([node("A", { writes: ["src/a.ts"] }), node("B", { writes: ["src/a.ts"] })]));
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toContain("write/write");
    expect(errs[0]?.taskIds).toEqual(["A", "B"]);
  });

  it("flags write/read in both directions", () => {
    const wr = closure(ledger([node("A", { writes: ["src/a.ts"] }), node("B", { reads: ["src/a.ts"] })]));
    expect(wr[0]?.message).toContain("write/read");
    const rw = closure(ledger([node("A", { reads: ["src/a.ts"] }), node("B", { writes: ["src/a.ts"] })]));
    expect(rw).toHaveLength(1);
    expect(rw[0]?.message).toMatch(/write\/read|read\/write/);
  });

  it("flags a directory write against a file beneath it and vice versa", () => {
    expect(closure(ledger([node("A", { writes: ["src"] }), node("B", { writes: ["src/a/b.ts"] })]))).toHaveLength(1);
    expect(closure(ledger([node("A", { writes: ["src/a/b.ts"] }), node("B", { writes: ["src"] })]))).toHaveLength(1);
  });

  it("does not flag disjoint paths, two readers, or tasks ordered by an edge", () => {
    expect(closure(ledger([node("A", { writes: ["a"] }), node("B", { writes: ["b"] })]))).toEqual([]);
    expect(closure(ledger([node("A", { reads: ["a"] }), node("B", { reads: ["a"] })]))).toEqual([]);
    expect(closure(ledger([node("A", { writes: ["a"] }), node("B", { writes: ["a"] })], [edge("A", "B")]))).toEqual([]);
  });

  it("orders tasks of different phases through the phase gates", () => {
    const l = ledger(
      [node("A", { writes: ["a"], phase: "p1" }), node("B", { writes: ["a"], phase: "p2" })],
      [edge("gate:p1", "B")],
      [phase("p1"), phase("p2")],
    );
    expect(closure(l)).toEqual([]);
  });

  it("treats an unknown write set as overlapping everything with a footprint", () => {
    const errs = closure(ledger([node("A", { conf: "unknown" }), node("B", { reads: ["x"] })]));
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toContain("top");
    expect(closure(ledger([node("B", { reads: ["x"] }), node("A", { conf: "unknown" })]))).toHaveLength(1);
    expect(closure(ledger([node("A", { conf: "unknown" }), node("B")]))).toEqual([]);
  });

  it("treats a task with a non-repo write path as writing everything", () => {
    const errs = closure(ledger([node("A", { writes: ["/abs"] }), node("B", { writes: ["x"] })]));
    expect(errs).toHaveLength(1);
  });

  it("ignores reads of qa tasks", () => {
    expect(closure(ledger([node("Q", { kind: "qa", reads: ["a"] }), node("B", { writes: ["a"] })]))).toEqual([]);
  });

  it("compares case-insensitively only when ci is set", () => {
    const l = ledger([node("A", { writes: ["Src/A.ts"] }), node("B", { writes: ["src/a.ts"] })]);
    expect(closure(l, true)).toHaveLength(1);
    expect(closure(l, false)).toEqual([]);
  });

  it("uses the platform default when ci is omitted", () => {
    const l = ledger([node("A", { writes: ["Src/A.ts"] }), node("B", { writes: ["src/a.ts"] })]);
    const n = validateLedger(l).filter((e) => e.code === "closure").length;
    expect(n).toBe(process.platform === "win32" ? 1 : 0);
  });

  it("reports each conflicting pair once", () => {
    const errs = closure(ledger([node("A", { writes: ["a", "b"] }), node("B", { writes: ["a", "b"] })]));
    expect(errs).toHaveLength(1);
  });
});
