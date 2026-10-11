import { beforeAll, describe, expect, it } from "vitest";

import {
  RESIDUE_SCHEMA,
  mergeResidueInto,
  parseResidue,
  residueDigestOf,
  residueOverflow,
  residueRequestOf,
  residueTaskIds,
  validateResidue,
} from "../../src/executor/compile/residue";
import { ExecutorError, isLedgerV1, type JsonValue, type LedgerV1 } from "../../src/executor/types";
import { compileOpts, makeHarness, planPathOf, type Harness } from "../fixtures/cpx/plans/harness";
import { readFixture } from "../fixtures/cpx/plans/loader";

// Residue fixtures: `residue-valid.json` is frozen with a `$DIGEST` placeholder (the digest depends on the draft);
// the other cases are derived from it by one small mutation each, so every case differs from the valid one in one thing.

const BASE = [
  "# Residue base",
  "",
  "## Wave 1",
  "",
  "### Phase 1.1 Mixed",
  "",
  "**Tasks**",
  "- **1.1.1** `[tier:medium]` Implement the core.",
  "  Writes: `src/alpha/core.ts`",
  "- **1.1.2** `[tier:medium]` Make it better somehow.",
  "- **1.1.3** `[tier:medium]` Improve things.",
  "  Reads: `src/alpha/types.ts`",
  "",
].join("\n");

let h: Harness;
let draft: LedgerV1;
let digest: string;
let request: { prompt: string; schema: JsonValue; taskIds: string[] } | undefined;

type Rec = Record<string, unknown>;

function valid(): Rec {
  return JSON.parse(readFixture("residue-valid.json").replace("$DIGEST", digest)) as Rec;
}

function variant(mutate: (r: Rec) => void): string {
  const r = valid();
  mutate(r);
  return JSON.stringify(r);
}

function entries(r: Rec, key: "footprints" | "edges"): Rec[] {
  return r[key] as Rec[];
}

async function rejection(text: string): Promise<{ code: string; detail: { code: string; at?: string } }> {
  try {
    h.compiler.mergeResidue(draft, text);
  } catch (e) {
    if (e instanceof ExecutorError) {
      expect(e.code).toBe("E_RESIDUE");
      const detail = e.detail as { code: string; at?: string };
      return { code: e.code, detail };
    }
    throw e;
  }
  throw new Error("expected mergeResidue to reject");
}

beforeAll(async () => {
  h = makeHarness({ inline: { "residue-base.md": BASE } });
  const r = await h.compiler.compile(planPathOf("residue-base.md"), compileOpts(h));
  draft = r.draft;
  request = r.residueRequest;
  digest = residueDigestOf(draft.planDigest, request?.taskIds ?? []);
});

describe("executor compile: residue (2.3.5)", () => {
  describe("request", () => {
    it("asks about exactly the editing tasks of unknown footprint", () => {
      expect(draft.status).toBe("awaiting-residue");
      expect(residueTaskIds(draft)).toEqual(["1.1.2", "1.1.3"]);
      expect(request?.taskIds).toEqual(["1.1.2", "1.1.3"]);
      expect(residueOverflow(draft)).toBe(0);
    });

    it("starts the prompt with a design route line and carries the digest, schema and rules", () => {
      const prompt = request?.prompt ?? "";
      expect(prompt.split("\n")[0]).toMatch(/^\[route class=design .*tier=heavy.*pin\]$/);
      expect(prompt).toContain("Writes: none.");
      expect(prompt).toContain(digest);
      expect(request?.schema).toEqual(RESIDUE_SCHEMA);
    });

    it("builds a request only when something needs it", async () => {
      const clean = makeHarness();
      const r = await clean.compiler.compile(planPathOf("synthetic/contract-first.md"), compileOpts(clean));
      expect(r.residueRequest).toBeUndefined();
      expect(r.draft.status).toBe("awaiting-approval");
      expect(residueRequestOf(r.draft, [])).toBeUndefined();
    });

    it("recomputes the digest from the draft", () => {
      expect(digest).toMatch(/^[0-9a-f]{16}$/);
      expect(residueDigestOf(draft.planDigest, ["1.1.2", "1.1.3"])).toBe(digest);
      expect(residueDigestOf(draft.planDigest, ["1.1.3"])).not.toBe(digest);
    });
  });

  describe("round-1 regressions (batch A)", () => {
    it("QA-2.3-1: a write path that does not exist is kept, and the two tasks get a conflict edge", async () => {
      const gap = [
        "# Gap", "", "## Wave 1", "", "### Phase 1.1 Gap", "", "**Tasks**",
        "- **1.1.1** `[tier:medium]` Create the shared file.", "  Writes: `src/gen/shared.ts`",
        "- **1.1.2** `[tier:medium]` Also create the shared file.", "  Writes: `src/gen/shared.ts`", "",
      ].join("\n");
      const g = makeHarness({ inline: { "gap.md": gap } });
      const r = await g.compiler.compile(planPathOf("gap.md"), compileOpts(g));
      for (const id of ["1.1.1", "1.1.2"]) {
        expect(r.draft.tasks[id]?.footprint.writes).toEqual(["src/gen/shared.ts"]);
        expect(r.draft.tasks[id]?.footprint.confidence).toBe("explicit");
      }
      expect(r.draft.edges.some((e) => e.kind === "conflict" && e.from === "1.1.1" && e.to === "1.1.2")).toBe(true);
      expect(g.compiler.validate(r.draft)).toEqual([]);
    });

    it("QA-2.3-6: with 61 unknown tasks only the first 60 may be listed", async () => {
      const lines = ["# Many", "", "## Wave 1", "", "### Phase 1.1 Many", "", "**Tasks**"];
      for (let i = 1; i <= 61; i += 1) lines.push(`- **1.1.${i}** \`[tier:medium]\` Make it better somehow ${i}.`);
      const m = makeHarness({ inline: { "many.md": lines.join("\n") } });
      const r = await m.compiler.compile(planPathOf("many.md"), compileOpts(m));
      expect(r.residueRequest?.taskIds).toHaveLength(60);
      const body = JSON.stringify({
        requestDigest: residueDigestOf(r.draft.planDigest, r.residueRequest?.taskIds ?? []),
        footprints: [{ taskId: "1.1.61", writes: ["src/x.ts"], reads: [], evidence: "e" }],
        edges: [],
      });
      const res = validateResidue(r.draft, JSON.parse(body) as unknown);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("residue-unknown-task");
    });

    function codeOf(fn: () => unknown): string {
      try {
        fn();
      } catch (e) {
        if (e instanceof ExecutorError) return e.code;
        throw e;
      }
      return "none";
    }

    it("QA-2.3-3: addTasks rejects a task for a phase whose gate has passed", () => {
      const closed: LedgerV1 = { ...draft, phases: draft.phases.map((p) => ({ ...p, gate: "passed" as const })) };
      const frag = "- **1.1.9** `[tier:medium]` Add a helper.\n  Writes: `src/alpha/helper.ts`\n";
      expect(codeOf(() => h.compiler.addTasks(closed, frag))).toBe("E_INVALID_INPUT");
      expect(codeOf(() => h.compiler.addTasks(draft, frag))).toBe("none");
    });

    it("QA-2.3-2: addTasks rejects a write outside the repository and a broken fragment with E_INVALID_INPUT", () => {
      const outside = "- **1.1.9** `[tier:medium]` Add a helper.\n  Writes: `Z:\\elsewhere\\x\\helper.ts`\n";
      expect(codeOf(() => h.compiler.addTasks(draft, outside))).toBe("E_INVALID_INPUT");
      const dup = "- **1.1.9** `[tier:medium]` One.\n  Writes: `src/alpha/a1.ts`\n- **1.1.9** `[tier:medium]` Two.\n  Writes: `src/alpha/a2.ts`\n";
      expect(codeOf(() => h.compiler.addTasks(draft, dup))).toBe("E_INVALID_INPUT");
    });

    it("QA-2.3-2: a fragment may order a new task before an existing one (reference to the ledger)", () => {
      const frag = "- **1.1.9** `[tier:medium]` Add a helper.\n  1.1.9 must run before 1.1.2.\n  Writes: `src/alpha/helper.ts`\n";
      const added = h.compiler.addTasks(draft, frag);
      expect(added.edges.some((e) => e.from === "1.1.9" && e.to === "1.1.2")).toBe(true);
    });

    const PHASED = [
      "# Phased", "", "## Wave 1", "", "### Phase 1.1 First", "", "**Tasks**",
      "- **1.1.1** `[tier:medium]` One.", "  Writes: `src/alpha/one.ts`", "",
      "### Phase 1.2 Second", "", "**Depends on:** 1.1", "", "**Pre-flight**",
      "- Check the branch is clean.", "", "**Tasks**",
      "- **1.2.1** `[tier:medium]` Two.", "  Writes: `src/alpha/two.ts`", "",
      "**QA review**",
      "- Review phase 1.2.", "",
    ].join("\n");

    it("QA-2.3-19: a task added to a pending phase waits for its pre-flight and dependency gate, and the phase QA waits for it", async () => {
      const p = makeHarness({ inline: { "phased.md": PHASED } });
      const r = await p.compiler.compile(planPathOf("phased.md"), compileOpts(p));
      const nodes = Object.values(r.draft.tasks);
      const pre = nodes.find((t) => t.kind === "preflight" && t.phase === "1.2");
      const qa = nodes.find((t) => t.kind === "qa" && t.phase === "1.2");
      expect(pre).toBeDefined();
      expect(qa).toBeDefined();
      const added = p.compiler.addTasks(r.draft, "- **1.2.9** `[tier:medium]` Three.\n  Writes: `src/alpha/three.ts`\n");
      const has = (from: string, to: string): boolean => added.edges.some((e) => e.from === from && e.to === to);
      expect(has(pre?.id ?? "", "1.2.9")).toBe(true);
      expect(has("1.2.9", qa?.id ?? "")).toBe(true);
      // the dependency gate of 1.2 is reached through the pre-flight, which already waits for gate:1.1
      expect(r.draft.edges.some((e) => e.from === "gate:1.1" && e.to === pre?.id)).toBe(true);
    });

    it("QA-2.3-19: without a pre-flight a new task of a dependent phase gets the gate edge itself", async () => {
      const text = PHASED.replace("**Pre-flight**\n- Check the branch is clean.\n\n", "");
      const p = makeHarness({ inline: { "phased2.md": text } });
      const r = await p.compiler.compile(planPathOf("phased2.md"), compileOpts(p));
      const added = p.compiler.addTasks(r.draft, "- **1.2.9** `[tier:medium]` Three.\n  Writes: `src/alpha/three.ts`\n");
      expect(added.edges.some((e) => e.from === "gate:1.1" && e.to === "1.2.9")).toBe(true);
    });

    it("QA-2.3-22: addTasks fails closed on an unknown reference, subject or Depends on id", () => {
      const refs = [
        "- **1.1.9** `[tier:medium]` Add a helper.\n  1.1.9 must run before 7.7.7.\n  Writes: `src/alpha/helper.ts`\n",
        "- **1.1.9** `[tier:medium]` Add a helper.\n  Depends on: 7.7.7\n  Writes: `src/alpha/helper.ts`\n",
      ];
      for (const frag of refs) expect(codeOf(() => h.compiler.addTasks(draft, frag)), frag).toBe("E_INVALID_INPUT");
      expect(codeOf(() => h.compiler.addTasks(draft, "- **1.1.9** `[tier:medium]` Add a helper.\n  Depends on: 1.1.1\n  Writes: `src/alpha/helper.ts`\n"))).toBe("none");
    });

    it("QA-2.3-28: the residue-capped message also covers ownership-assumed tasks", async () => {
      const lines = ["# Many", "", "## Wave 1", "", "### Phase 1.1 Many", "", "**Tasks**"];
      for (let i = 1; i <= 61; i += 1) lines.push(`- **1.1.${i}** \`[tier:medium]\` Make it better somehow ${i}.`);
      const m = makeHarness({ inline: { "many2.md": lines.join("\n") } });
      const r = await m.compiler.compile(planPathOf("many2.md"), compileOpts(m));
      const capped = r.summary.warnings.find((w) => w.startsWith("residue-capped"));
      expect(capped).toContain("ownership-assumed");
      expect(capped).toContain("unknown ones stay top");
    });

    it("QA-2.3-10: an external dependency needs doneBefore", async () => {
      const ext = [
        "# Ext", "", "## Wave 1", "", "### Phase 1.1 First", "", "**Tasks**",
        "- **1.1.1** `[tier:medium]` One.", "  Writes: `src/alpha/one.ts`", "",
        "### Phase 1.2 Second", "", "**Depends on:** DF-9", "", "**Tasks**",
        "- **1.2.1** `[tier:medium]` Two.", "  Writes: `src/alpha/two.ts`", "",
      ].join("\n");
      const x = makeHarness({ inline: { "ext.md": ext } });
      let code = "none";
      try {
        await x.compiler.compile(planPathOf("ext.md"), compileOpts(x));
      } catch (e) {
        code = e instanceof ExecutorError ? e.code : "other";
      }
      expect(code).toBe("E_INVALID_INPUT");
      const ok = await x.compiler.compile(planPathOf("ext.md"), compileOpts(x, { doneBefore: "1.2" }));
      expect(ok.summary.warnings.some((w) => w.startsWith("depends-external-unknown"))).toBe(true);
    });

    it("QA-2.3-15: a response may respell the case of an existing path", () => {
      const old = draft.tasks["1.1.3"]?.footprint.reads ?? [];
      const res = validateResidue(draft, {
        requestDigest: digest,
        footprints: [{ taskId: "1.1.3", writes: [], reads: old.map((p) => p.toUpperCase()), evidence: "e" }],
        edges: [],
      });
      expect(res.ok).toBe(true);
    });
  });

  describe("parsing", () => {
    it("takes the last json block of an answer, else the whole text", () => {
      expect(parseResidue('DONE:\n```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
      expect(parseResidue('{"a":3}')).toEqual({ a: 3 });
    });
  });

  describe("rejections (exact E_RESIDUE codes)", () => {
    it.each([
      ["ESCALATE: need more context", "residue-json"],
      ["not json at all", "residue-json"],
    ])("%s -> %s", async (text, code) => {
      expect((await rejection(text)).detail.code).toBe(code);
    });

    it("residue-delete: a delete-like key anywhere", async () => {
      expect((await rejection(variant((r) => { r["remove"] = []; }))).detail.code).toBe("residue-delete");
    });

    it("residue-delete: an op field on an edge", async () => {
      expect((await rejection(variant((r) => { entries(r, "edges")[0]!["op"] = "drop"; }))).detail.code).toBe("residue-delete");
    });

    it("residue-schema: a missing evidence field carries its JSON path", async () => {
      const res = await rejection(variant((r) => { delete entries(r, "footprints")[0]!["evidence"]; }));
      expect(res.detail.code).toBe("residue-schema");
      expect(res.detail.at).toMatch(/footprints/);
    });

    it("residue-schema: an unknown property is refused", async () => {
      expect((await rejection(variant((r) => { r["extra"] = 1; }))).detail.code).toBe("residue-schema");
    });

    it("residue-digest: a stale digest", async () => {
      expect((await rejection(variant((r) => { r["requestDigest"] = "0000000000000000"; }))).detail.code).toBe("residue-digest");
    });

    it("residue-unknown-task: an id that is not in the draft", async () => {
      expect((await rejection(variant((r) => { entries(r, "footprints")[0]!["taskId"] = "9.9.9"; }))).detail.code).toBe("residue-unknown-task");
    });

    it("residue-unknown-task: an explicit task was not asked about, so it cannot be listed (QA-2.3-6)", async () => {
      const text = variant((r) => {
        entries(r, "footprints").push({ taskId: "1.1.1", writes: ["src/alpha/other.ts"], reads: [], evidence: "wrong" });
      });
      expect((await rejection(text)).detail.code).toBe("residue-unknown-task");
      const noChange = variant((r) => { r["noChange"] = ["1.1.1"]; });
      expect((await rejection(noChange)).detail.code).toBe("residue-unknown-task");
    });

    it("residue-weaken: omitting an existing path", async () => {
      const text = variant((r) => { entries(r, "footprints")[1]!["reads"] = []; });
      expect((await rejection(text)).detail.code).toBe("residue-weaken");
    });

    it.each([
      ["escape-dotdot", "../x.ts"],
      ["other-drive", "E:\\x\\y.ts"],
      ["unc", "\\\\host\\share\\x.ts"],
      ["device", "\\\\?\\C:\\x.ts"],
      ["url", "https://example.com/x.ts"],
    ])("residue-path: %s", async (_name, path) => {
      const text = variant((r) => { entries(r, "footprints")[0]!["writes"] = [path]; });
      expect((await rejection(text)).detail.code).toBe("residue-path");
    });

    it("residue-cycle: an edge against the plan order closes a cycle", async () => {
      const text = variant((r) => {
        r["edges"] = [{ from: "1.1.3", to: "1.1.1", confidence: "low", evidence: "wrong way" }];
      });
      expect((await rejection(text)).detail.code).toBe("residue-cycle");
    });

    it("validateResidue reports the code, JSON path and detail without throwing", () => {
      const res = validateResidue(draft, { requestDigest: "bad" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("residue-schema");
        expect(typeof res.at).toBe("string");
      }
    });
  });

  describe("valid residue", () => {
    it("is accepted by validateResidue", () => {
      const res = validateResidue(draft, valid());
      expect(res.ok).toBe(true);
    });

    it("merges monotonically and turns the top element into concrete writes", () => {
      const out = h.compiler.mergeResidue(draft, JSON.stringify(valid()));
      const merged = out.draft;
      expect(merged.status).toBe("awaiting-approval");
      expect(isLedgerV1(merged)).toBe(true);
      for (const [id, before] of Object.entries(draft.tasks)) {
        const after = merged.tasks[id];
        for (const p of before.footprint.writes) expect(after?.footprint.writes).toContain(p);
        for (const p of before.footprint.reads) expect(after?.footprint.reads).toContain(p);
      }
      expect(merged.tasks["1.1.2"]?.footprint.writes).toEqual(["src/alpha/helpers.ts"]);
      expect(merged.tasks["1.1.2"]?.footprint.confidence).toBe("inferred");
      expect(merged.tasks["1.1.2"]?.footprint.sources).toContain("llm");
      expect(merged.tasks["1.1.3"]?.footprint.writes).toEqual(["src/beta/util.ts"]);
      expect(merged.tasks["1.1.1"]).toEqual(draft.tasks["1.1.1"]);
      expect(merged.edges.length).toBeGreaterThanOrEqual(draft.edges.length - 3);
    });

    it("re-validates cleanly (the closure holds on the merged footprints)", () => {
      const merged = h.compiler.mergeResidue(draft, JSON.stringify(valid())).draft;
      expect(h.compiler.validate(merged)).toEqual([]);
      // `inferred` stays in the residue task set by design (memo section 6: unknown or inferred), so a second round is possible.
      expect(residueTaskIds(merged)).toEqual(["1.1.2", "1.1.3"]);
    });

    it("keeps the unknown confidence rule: noChange confirms a non-writing task", () => {
      const text = variant((r) => {
        r["footprints"] = [entries(r, "footprints")[0]];
        r["edges"] = [];
        r["noChange"] = ["1.1.3"];
      });
      const merged = h.compiler.mergeResidue(draft, text).draft;
      expect(merged.tasks["1.1.3"]?.footprint.confidence).toBe("inferred");
      expect(merged.tasks["1.1.3"]?.footprint.writes).toEqual([]);
    });

    it("mergeResidueInto is pure with respect to its input", () => {
      const before = JSON.stringify(draft);
      const res = validateResidue(draft, valid());
      if (!res.ok) throw new Error("residue should be valid");
      mergeResidueInto(draft, res.value);
      expect(JSON.stringify(draft)).toBe(before);
    });
  });
});
