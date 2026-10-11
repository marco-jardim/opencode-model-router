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

    it("residue-weaken: changing the write set of an explicit task", async () => {
      const text = variant((r) => {
        entries(r, "footprints").push({ taskId: "1.1.1", writes: ["src/alpha/other.ts"], reads: [], evidence: "wrong" });
      });
      expect((await rejection(text)).detail.code).toBe("residue-weaken");
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
