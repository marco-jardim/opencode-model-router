import { describe, expect, it } from "vitest";
import {
  RESIDUE_EVIDENCE_MAX,
  RESIDUE_EXCERPT_CHARS,
  RESIDUE_MAX_CANDIDATES,
  RESIDUE_MAX_TASKS,
  RESIDUE_SCHEMA,
  mergeResidueInto,
  parseResidue,
  residueDigestOf,
  residueOverflow,
  residueRequestOf,
  residueTaskIds,
  validateResidue,
  type ResidueResponse,
  type ResidueValidation,
} from "../../src/executor/compile/residue";
import {
  executorDefaults,
  type Edge,
  type LedgerV1,
  type PhaseRecord,
  type TaskKind,
  type TaskNode,
} from "../../src/executor/types";

type Conf = TaskNode["footprint"]["confidence"];

function node(
  id: string,
  o: { kind?: TaskKind; conf?: Conf; writes?: string[]; reads?: string[]; line?: string; phase?: string | null; text?: string; sources?: TaskNode["footprint"]["sources"] } = {},
): TaskNode {
  return {
    id,
    title: `title ${id}`,
    phase: o.phase ?? null,
    kind: o.kind ?? "task",
    text: o.text ?? "do it",
    subtasks: [],
    route: { line: o.line ?? "", role: "implementer", tier: "fast", pin: false },
    verify: "none",
    acceptance: null,
    footprint: { writes: o.writes ?? [], reads: o.reads ?? [], confidence: o.conf ?? "unknown", sources: o.sources ?? ["path"] },
    estimate: { p50: 1, p90: 2, source: "t" },
    state: "pending",
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
  return { from, to, kind: "explicit", confidence: "high", evidence: "t" };
}

function draftOf(tasks: TaskNode[], o: { edges?: Edge[]; phases?: PhaseRecord[]; toplevel?: string; worktree?: string } = {}): LedgerV1 {
  const rec: Record<string, TaskNode> = {};
  for (const t of tasks) rec[t.id] = t;
  const phases = o.phases ?? [];
  return {
    schema: 1,
    planId: "plan-one",
    planPath: "/p/plan.md",
    planDigest: "f".repeat(64),
    repo: { key: "k", toplevel: o.toplevel ?? "/repo", baseBranch: "main", baseCommit: "a".repeat(40) },
    integration: { branch: "omr/plan-one/integration", worktree: o.worktree ?? "/wt", head: "a".repeat(40) },
    launcher: "A",
    status: "awaiting-residue",
    orchestrator: { sessionID: "s", boundAt: "2026-01-01T00:00:00.000Z" },
    config: executorDefaults(),
    sharedContext: "",
    waves: [{ id: "w1", phases: phases.map((p) => p.id) }],
    phases,
    tasks: rec,
    edges: o.edges ?? [],
    inbox: [],
    seq: 0,
  };
}

function respFor(d: LedgerV1, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestDigest: residueDigestOf(d.planDigest, residueTaskIds(d)), footprints: [], edges: [], ...over };
}

function fp(taskId: string, writes: string[], reads: string[] = [], evidence = "because"): Record<string, unknown> {
  return { taskId, writes, reads, evidence };
}

function bad(r: ResidueValidation): { code: string; at: string; detail: unknown } {
  if (r.ok) throw new Error("expected a failure");
  return r;
}

function good(r: ResidueValidation): ResidueResponse {
  if (!r.ok) throw new Error(`expected success, got ${r.code} at ${r.at}: ${JSON.stringify(r.detail)}`);
  return r.value;
}

describe("residueTaskIds / residueOverflow", () => {
  it("asks about unknown and inferred editing tasks in plan order", () => {
    const d = draftOf([
      node("A", { conf: "unknown" }),
      node("B", { conf: "explicit", writes: ["b"] }),
      node("C", { conf: "inferred" }),
      node("D", { conf: "ownership", writes: ["d"] }),
    ]);
    expect(residueTaskIds(d)).toEqual(["A", "C"]);
    expect(residueOverflow(d)).toBe(0);
  });

  it("skips manual, preflight and qa tasks", () => {
    const d = draftOf([node("M", { kind: "manual" }), node("P", { kind: "preflight" }), node("Q", { kind: "qa" }), node("T", { kind: "tests" }), node("F", { kind: "fix" })]);
    expect(residueTaskIds(d)).toEqual(["T", "F"]);
  });

  it("treats a task with writes as editing whatever its route says", () => {
    const d = draftOf([node("A", { writes: ["x"], conf: "inferred", line: "[route class=review]" })]);
    expect(residueTaskIds(d)).toEqual(["A"]);
  });

  it("uses the route line class when there are no writes", () => {
    const d = draftOf([
      node("R", { line: "[route class=review]" }),
      node("S", { line: "[route class=design]" }),
      node("E", { line: "[route class=review needs=edit]" }),
      node("N", { line: "[route needs=shell]" }),
      node("U", { line: "[route risk=low]" }),
    ]);
    const ids = residueTaskIds(d);
    expect(ids).not.toContain("R");
    expect(ids).not.toContain("S");
    expect(ids).toContain("E");
    expect(ids).toContain("U");
    expect(ids).not.toContain("N");
  });

  it("caps the request at RESIDUE_MAX_TASKS and reports the overflow", () => {
    const tasks: TaskNode[] = [];
    for (let i = 0; i < RESIDUE_MAX_TASKS + 3; i++) tasks.push(node(`T${i}`));
    const d = draftOf(tasks);
    expect(residueTaskIds(d)).toHaveLength(RESIDUE_MAX_TASKS);
    expect(residueOverflow(d)).toBe(3);
  });

  it("digests the plan digest and the task ids", () => {
    const a = residueDigestOf("x", ["A", "B"]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(residueDigestOf("x", ["A", "B"])).toBe(a);
    expect(residueDigestOf("x", ["B", "A"])).not.toBe(a);
    expect(residueDigestOf("y", ["A", "B"])).not.toBe(a);
  });
});

describe("residueRequestOf", () => {
  const requestJson = (prompt: string): { requestDigest: string; tasks: Array<{ id: string; excerpt: string }>; candidates: unknown[] } => {
    const lines = prompt.split("\n");
    const i = lines.indexOf("Request (JSON):");
    return JSON.parse(lines[i + 1] as string) as { requestDigest: string; tasks: Array<{ id: string; excerpt: string }>; candidates: unknown[] };
  };

  it("is undefined when there is nothing to ask", () => {
    expect(residueRequestOf(draftOf([node("A", { conf: "explicit", writes: ["a"] })]), [])).toBeUndefined();
  });

  it("builds a request from tasks, with the digest, schema and ids", () => {
    const d = draftOf([node("A", { reads: ["r"], phase: "p1" })], { phases: [phase("p1")] });
    const r = residueRequestOf(d, []);
    expect(r?.taskIds).toEqual(["A"]);
    expect(r?.schema).toBe(RESIDUE_SCHEMA);
    const body = requestJson(r?.prompt ?? "");
    expect(body.requestDigest).toBe(residueDigestOf(d.planDigest, ["A"]));
    expect(body.tasks.map((t) => t.id)).toEqual(["A"]);
    expect(r?.prompt.startsWith("[route class=design risk=medium scope=multi d=none root=/repo tier=heavy pin]\nWrites: none.")).toBe(true);
    expect(r?.prompt).toContain(`Copy \`requestDigest\` exactly: ${body.requestDigest}.`);
  });

  it("can ask about candidates alone and caps them", () => {
    const d = draftOf([node("A", { conf: "explicit", writes: ["a"] })]);
    const cands = Array.from({ length: RESIDUE_MAX_CANDIDATES + 5 }, (_, i) => ({ from: `X${i}`, to: "Y", why: "w" }));
    const r = residueRequestOf(d, cands);
    expect(r?.taskIds).toEqual([]);
    expect(requestJson(r?.prompt ?? "").candidates).toHaveLength(RESIDUE_MAX_CANDIDATES);
  });

  it("quotes a work root with whitespace and drops one the route line cannot carry", () => {
    const t = [node("A")];
    expect(residueRequestOf(draftOf(t, { toplevel: "/my repo" }), [])?.prompt).toContain('root="/my repo" tier=heavy');
    expect(residueRequestOf(draftOf(t, { toplevel: "D:\\git\\repo" }), [])?.prompt).toContain("root=D:\\git\\repo tier=heavy");
    for (const top of ["relative/path", "//unc/share", "/a/../b", 'D:\\a"b', "/a]b", "/a\nb", "/a\0b"]) {
      const p = residueRequestOf(draftOf(t, { toplevel: top }), [])?.prompt ?? "";
      expect(p.startsWith("[route class=design risk=medium scope=multi d=none tier=heavy pin]")).toBe(true);
    }
  });

  it("cuts long excerpts and keeps a surrogate pair whole", () => {
    const long = "x".repeat(RESIDUE_EXCERPT_CHARS + 50);
    const pair = `${"y".repeat(RESIDUE_EXCERPT_CHARS - 1)}\u{1F600}tail`;
    const d = draftOf([node("A", { text: long }), node("B", { text: pair }), node("C", { text: "short" })]);
    const body = requestJson(residueRequestOf(d, [])?.prompt ?? "");
    const ex = Object.fromEntries(body.tasks.map((t) => [t.id, t.excerpt]));
    expect(ex.A).toHaveLength(RESIDUE_EXCERPT_CHARS);
    expect(ex.B).toBe("y".repeat(RESIDUE_EXCERPT_CHARS - 1));
    expect(ex.C).toBe("short");
  });
});

describe("parseResidue", () => {
  it("reads a bare JSON document", () => {
    expect(parseResidue(' {"a": 1} ')).toEqual({ a: 1 });
  });

  it("prefers the last json block", () => {
    const text = 'DONE:\n```json\n{"a":1}\n```\nthen\n```json\r\n{"a":2}\r\n```\n';
    expect(parseResidue(text)).toEqual({ a: 2 });
  });

  it("accepts a block that closes on the same line as its content", () => {
    expect(parseResidue('```JSON\n{"a":3}```')).toEqual({ a: 3 });
  });

  it("is undefined for text that is not JSON", () => {
    expect(parseResidue("nothing here")).toBeUndefined();
    expect(parseResidue("```json\n{oops\n```")).toBeUndefined();
  });
});

describe("validateResidue failures", () => {
  const base = (): LedgerV1 => draftOf([node("A"), node("B"), node("X", { conf: "explicit", writes: ["x.ts"], reads: ["xr.ts"] })]);

  it("rejects an unparseable response", () => {
    expect(bad(validateResidue(base(), undefined)).code).toBe("residue-json");
  });

  it("rejects removal keys anywhere, with a JSON path", () => {
    const d = base();
    expect(bad(validateResidue(d, { ...respFor(d), removeEdges: [] })).at).toBe("$.removeEdges");
    expect(bad(validateResidue(d, { ...respFor(d), footprints: [{ a: [{ op: "x" }] }] })).at).toBe("$.footprints[0].a[0].op");
    expect(bad(validateResidue(d, { ...respFor(d), x: { "drop-it": 1 } })).at).toBe('$.x["drop-it"]');
    expect(bad(validateResidue(d, { ...respFor(d), edges: [{ Delete: 1 }] })).code).toBe("residue-delete");
  });

  it("rejects non-objects and missing or extra properties", () => {
    const d = base();
    expect(bad(validateResidue(d, [])).at).toBe("$");
    expect(bad(validateResidue(d, "text")).code).toBe("residue-schema");
    expect(bad(validateResidue(d, { footprints: [], edges: [] })).at).toBe("$.requestDigest");
    expect(bad(validateResidue(d, { ...respFor(d), extra: 1 })).at).toBe("$.extra");
    expect(bad(validateResidue(d, { ...respFor(d), "odd key": 1 })).at).toBe('$["odd key"]');
    expect(bad(validateResidue(d, respFor(d, { requestDigest: 5 }))).at).toBe("$.requestDigest");
    expect(bad(validateResidue(d, respFor(d, { requestDigest: "ABCDEF0123456789" }))).at).toBe("$.requestDigest");
  });

  it("rejects malformed footprint entries", () => {
    const d = base();
    const at = (fps: unknown): string => bad(validateResidue(d, respFor(d, { footprints: fps }))).at;
    expect(at({})).toBe("$.footprints");
    expect(at([1])).toBe("$.footprints[0]");
    expect(at([{ taskId: "A", writes: [], reads: [] }])).toBe("$.footprints[0].evidence");
    expect(at([{ ...fp("A", []), more: 1 }])).toBe("$.footprints[0].more");
    expect(at([{ ...fp("A", []), taskId: 3 }])).toBe("$.footprints[0].taskId");
    expect(at([fp("A", "no" as unknown as string[])])).toBe("$.footprints[0].writes");
    expect(at([fp("A", [""])])).toBe("$.footprints[0].writes[0]");
    expect(at([fp("A", [7 as unknown as string])])).toBe("$.footprints[0].writes[0]");
    expect(at([fp("A", [], "no" as unknown as string[])])).toBe("$.footprints[0].reads");
    expect(at([fp("A", [], [""])])).toBe("$.footprints[0].reads[0]");
    expect(at([{ ...fp("A", []), evidence: 4 }])).toBe("$.footprints[0].evidence");
    expect(at([fp("A", [], [], "")])).toBe("$.footprints[0].evidence");
    expect(at([fp("A", [], [], "e".repeat(RESIDUE_EVIDENCE_MAX + 1))])).toBe("$.footprints[0].evidence");
  });

  it("rejects malformed edge entries and noChange", () => {
    const d = base();
    const edgeAt = (es: unknown): string => bad(validateResidue(d, respFor(d, { edges: es }))).at;
    const ok = { from: "A", to: "B", confidence: "low", evidence: "e" };
    expect(edgeAt("x")).toBe("$.edges");
    expect(edgeAt([null])).toBe("$.edges[0]");
    expect(edgeAt([{ from: "A", to: "B", confidence: "low" }])).toBe("$.edges[0].evidence");
    expect(edgeAt([{ ...ok, more: 1 }])).toBe("$.edges[0].more");
    expect(edgeAt([{ ...ok, from: 1 }])).toBe("$.edges[0].from");
    expect(edgeAt([{ ...ok, to: 1 }])).toBe("$.edges[0].to");
    expect(edgeAt([{ ...ok, confidence: "high" }])).toBe("$.edges[0].confidence");
    expect(edgeAt([{ ...ok, evidence: "" }])).toBe("$.edges[0].evidence");
    expect(bad(validateResidue(d, respFor(d, { noChange: "A" }))).at).toBe("$.noChange");
    expect(bad(validateResidue(d, respFor(d, { noChange: [1] }))).at).toBe("$.noChange[0]");
  });

  it("rejects a digest that does not match the request", () => {
    const d = base();
    const r = bad(validateResidue(d, respFor(d, { requestDigest: "0123456789abcdef" })));
    expect(r.code).toBe("residue-digest");
    expect((r.detail as { expected: string }).expected).toBe(residueDigestOf(d.planDigest, ["A", "B"]));
  });

  it("rejects unknown tasks in footprints, edges and noChange", () => {
    const d = draftOf([node("A"), node("X", { conf: "explicit", writes: ["x"] })], { phases: [phase("p1")] });
    const code = (over: Record<string, unknown>): { code: string; at: string; detail: unknown } => bad(validateResidue(d, respFor(d, over)));
    expect(code({ footprints: [fp("ghost", [])] })).toMatchObject({ code: "residue-unknown-task", at: "$.footprints[0].taskId" });
    expect(code({ footprints: [fp("X", [])] }).detail).toMatchObject({ reason: "not part of the request" });
    const e = (from: string, to: string): unknown[] => [{ from, to, confidence: "low", evidence: "e" }];
    expect(code({ edges: e("ghost", "A") }).at).toBe("$.edges[0].from");
    expect(code({ edges: e("gate:nope", "A") }).at).toBe("$.edges[0].from");
    expect(code({ edges: e("A", "ghost") }).at).toBe("$.edges[0].to");
    expect(code({ noChange: ["ghost"] }).at).toBe("$.noChange[0]");
    expect(code({ noChange: ["X"] }).detail).toMatchObject({ reason: "not part of the request" });
  });

  it("rejects paths that leave the repository", () => {
    const d = base();
    const reason = (p: string, dd: LedgerV1 = d): unknown => (bad(validateResidue(dd, respFor(dd, { footprints: [fp("A", [p])] }))).detail as { reason: string }).reason;
    expect(reason("a\0b")).toBe("nul");
    expect(reason("https://x/y")).toBe("url");
    expect(reason("file:x")).toBe("url");
    expect(reason("//host/share/x")).toBe("unc");
    expect(reason("\\\\host\\share\\x")).toBe("unc");
    expect(reason("//?/C:/x")).toBe("device");
    expect(reason("//./pipe")).toBe("device");
    expect(reason("\\??\\C:\\x")).toBe("device");
    expect(reason("C:/other/x")).toBe("other-drive");
    expect(reason("C:rel")).toBe("drive-relative");
    expect(reason("/etc/passwd")).toBe("outside");
    expect(reason("../x")).toBe("escape");
    expect(reason("a/../../x")).toBe("escape");
    expect(reason("ab/c:d")).toBe("colon");
    expect(reason(".")).toBe("empty");
    expect(reason("/repo")).toBe("outside");
    const win = draftOf([node("A")], { toplevel: "C:\\Repo", worktree: "C:/Wt" });
    expect(reason("/etc/passwd", win)).toBe("drive-less");
    expect(reason("D:/x", win)).toBe("other-drive");
  });

  it("locates a bad read path", () => {
    const d = base();
    const r = bad(validateResidue(d, respFor(d, { footprints: [fp("A", ["ok"], ["../no"])] })));
    expect(r).toMatchObject({ code: "residue-path", at: "$.footprints[0].reads[0]" });
  });

  it("lets an inferred task grow its footprint", () => {
    const d2 = draftOf([node("A", { conf: "inferred", writes: ["a.ts"], reads: ["ar.ts"] })]);
    const v = good(validateResidue(d2, respFor(d2, { footprints: [fp("A", ["a.ts", "extra.ts"], ["ar.ts"])] })));
    expect(v.footprints[0]?.writes).toEqual(["a.ts", "extra.ts"]);
  });

  it("rejects an entry that omits existing paths", () => {
    const d = draftOf([node("A", { conf: "inferred", writes: ["a.ts"], reads: ["ar.ts"] })]);
    const w = bad(validateResidue(d, respFor(d, { footprints: [fp("A", [], ["ar.ts"])] })));
    expect(w.code).toBe("residue-weaken");
    expect(w.detail).toMatchObject({ reason: "omits existing paths", missingWrites: ["a.ts"], missingReads: [] });
    const r = bad(validateResidue(d, respFor(d, { footprints: [fp("A", ["a.ts"], [])] })));
    expect(r.detail).toMatchObject({ missingWrites: [], missingReads: ["ar.ts"] });
  });

  it("compares paths case-insensitively by default and exactly with ci false", () => {
    const d = draftOf([node("A", { conf: "inferred", writes: ["Src/A.ts"] })]);
    const resp = respFor(d, { footprints: [fp("A", ["src/a.ts"])] });
    expect(validateResidue(d, resp).ok).toBe(true);
    expect(bad(validateResidue(d, resp, { ci: false })).code).toBe("residue-weaken");
  });

  it("rejects a response whose edges close a cycle", () => {
    const d = draftOf([node("A"), node("B"), node("C"), node("D")], { edges: [edge("A", "B"), edge("B", "C"), edge("C", "A")] });
    const e = (from: string, to: string): unknown => ({ from, to, confidence: "medium", evidence: "e" });
    const r = bad(validateResidue(d, respFor(d, { edges: [e("A", "C")] })));
    expect(r.code).toBe("residue-cycle");
    expect((r.detail as { cycle: string[] }).cycle).toHaveLength(2);
    const self = bad(validateResidue(draftOf([node("A")]), respFor(draftOf([node("A")]), { edges: [e("A", "A")] })));
    expect((self.detail as { cycle: string[] }).cycle).toEqual(["A"]);
    const longer = draftOf([node("A"), node("B"), node("C"), node("D")], { edges: [edge("A", "B"), edge("B", "C")] });
    const lc = bad(validateResidue(longer, respFor(longer, { edges: [e("C", "A")] })));
    expect((lc.detail as { cycle: string[] }).cycle).toEqual(["A", "B", "C"]);
  });

  it("sees the implicit task -> gate edge", () => {
    const d = draftOf([node("A", { phase: "p1" }), node("B")], { phases: [phase("p1")] });
    const r = bad(validateResidue(d, respFor(d, { edges: [{ from: "gate:p1", to: "A", confidence: "low", evidence: "e" }] })));
    expect(r.code).toBe("residue-cycle");
  });

  it("finds a cycle in a later component after acyclic nodes", () => {
    const d = draftOf([node("A"), node("B"), node("C"), node("D")], { edges: [edge("A", "B"), edge("C", "D")] });
    const r = bad(validateResidue(d, respFor(d, { edges: [{ from: "D", to: "C", confidence: "low", evidence: "e" }] })));
    expect((r.detail as { cycle: string[] }).cycle.slice().sort()).toEqual(["C", "D"]);
  });
});

describe("validateResidue success and normalization", () => {
  it("normalizes paths, absolute roots and duplicates", () => {
    const d = draftOf([node("A")]);
    const v = good(
      validateResidue(
        d,
        respFor(d, {
          footprints: [fp("A", ["a/./b//c.ts", "x/../y.ts", "/repo/src/z.ts", "/wt/w.ts", "Y.ts", "src\\q.ts"], ["/repo/r.ts", "r.ts"])],
        }),
      ),
    );
    expect(v.footprints[0]?.writes).toEqual(["a/b/c.ts", "y.ts", "src/z.ts", "w.ts", "src/q.ts"]);
    expect(v.footprints[0]?.reads).toEqual(["r.ts"]);
    expect(v.noChange).toEqual([]);
  });

  it("accepts roots with drive letters case-insensitively", () => {
    const d = draftOf([node("A")], { toplevel: "C:\\Repo\\", worktree: "" });
    const v = good(validateResidue(d, respFor(d, { footprints: [fp("A", ["c:/repo/src/a.ts"])] })));
    expect(v.footprints[0]?.writes).toEqual(["src/a.ts"]);
  });

  it("accepts equal sets for explicit/ownership tasks via an inferred task, and carries noChange", () => {
    const d = draftOf([node("A", { conf: "inferred", writes: ["a.ts"] }), node("B")]);
    const v = good(validateResidue(d, respFor(d, { footprints: [fp("A", ["a.ts"])], noChange: ["B"] })));
    expect(v.noChange).toEqual(["B"]);
  });

  it("accepts new edges that do not close a cycle, including from a gate", () => {
    const d = draftOf([node("A"), node("B", { phase: "p1" }), node("C")], { phases: [phase("p1")] });
    const v = good(
      validateResidue(d, respFor(d, { edges: [{ from: "A", to: "B", confidence: "low", evidence: "e" }, { from: "gate:p1", to: "C", confidence: "medium", evidence: "e" }] })),
    );
    expect(v.edges).toHaveLength(2);
  });
});

describe("mergeResidueInto", () => {
  const resp = (over: Partial<ResidueResponse>): ResidueResponse => ({ requestDigest: "0".repeat(16), footprints: [], edges: [], noChange: [], ...over });

  it("grows write and read sets, adds llm once and lifts unknown to inferred", () => {
    const d = draftOf([node("A", { writes: ["a.ts"], reads: ["R.ts"], conf: "unknown" }), node("B", { conf: "inferred", sources: ["llm"] }), node("C", { conf: "ownership", writes: ["c"] })]);
    const before = JSON.stringify(d);
    const m = mergeResidueInto(
      d,
      resp({
        footprints: [
          { taskId: "A", writes: ["A.ts", "n.ts"], reads: ["r.ts", "m.ts"], evidence: "e" },
          { taskId: "B", writes: ["b"], reads: [], evidence: "e" },
          { taskId: "C", writes: ["c2"], reads: [], evidence: "e" },
          { taskId: "ghost", writes: ["g"], reads: [], evidence: "e" },
        ],
      }),
    );
    expect(m.tasks.A?.footprint).toMatchObject({ writes: ["a.ts", "n.ts"], reads: ["R.ts", "m.ts"], confidence: "inferred", sources: ["path", "llm"] });
    expect(m.tasks.B?.footprint.sources).toEqual(["llm"]);
    expect(m.tasks.C?.footprint.confidence).toBe("ownership");
    expect(m.tasks.ghost).toBeUndefined();
    expect(JSON.stringify(d)).toBe(before);
  });

  it("is case-sensitive when ci is false", () => {
    const d = draftOf([node("A", { writes: ["a.ts"] })]);
    const m = mergeResidueInto(d, resp({ footprints: [{ taskId: "A", writes: ["A.ts"], reads: [], evidence: "e" }] }), { ci: false });
    expect(m.tasks.A?.footprint.writes).toEqual(["a.ts", "A.ts"]);
  });

  it("marks noChange unknown tasks inferred and leaves the rest alone", () => {
    const d = draftOf([node("A"), node("B", { conf: "explicit", writes: ["b"] })]);
    const m = mergeResidueInto(d, resp({ noChange: ["A", "B", "ghost"] }));
    expect(m.tasks.A?.footprint).toMatchObject({ confidence: "inferred", writes: [], reads: [] });
    expect(m.tasks.B?.footprint.confidence).toBe("explicit");
    expect(m.tasks.ghost).toBeUndefined();
  });

  it("adds new llm edges with capped confidence and skips existing pairs", () => {
    const d = draftOf([node("A"), node("B"), node("C")], { edges: [edge("A", "B")] });
    const m = mergeResidueInto(
      d,
      resp({
        edges: [
          { from: "A", to: "B", confidence: "medium", evidence: "dup" },
          { from: "B", to: "C", confidence: "low", evidence: "one" },
          { from: "B", to: "C", confidence: "medium", evidence: "two" },
          { from: "A", to: "C", confidence: "medium", evidence: "three" },
        ],
      }),
    );
    expect(m.edges).toHaveLength(3);
    expect(m.edges[1]).toMatchObject({ from: "B", to: "C", kind: "llm", confidence: "low", evidence: "residue: one" });
    expect(m.edges[2]).toMatchObject({ from: "A", to: "C", kind: "llm", confidence: "medium" });
    expect(d.edges).toHaveLength(1);
  });
});
