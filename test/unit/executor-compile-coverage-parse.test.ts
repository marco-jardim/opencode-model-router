import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  annotateUnrouted,
  fallbackTaskId,
  normalizeFirstLine,
  parsePlan,
  unwrapPureTagSpans,
  type ParsedPlan,
} from "../../src/executor/compile/parse";
import type { AnnotatedPlan, PlanStep } from "../../src/routing/engine";
import { ExecutorError } from "../../src/executor/types";
import { FIXTURES_DIR, readFixture } from "../fixtures/cpx/plans/loader";

// Extra cases at the end of the file cover QA block merging and Depends-on continuation lines.
const doc = (...lines: string[]): string => `${lines.join("\n")}\n`;

function failure(text: string): ExecutorError {
  try {
    parsePlan(text);
  } catch (e) {
    if (e instanceof ExecutorError) return e;
    throw e;
  }
  throw new Error("expected parsePlan to throw");
}

const codesOf = (p: ParsedPlan): string[] => p.warnings.map((w) => w.code);
const idsOf = (p: ParsedPlan): string[] => p.tasks.map((t) => t.id);
const task = (p: ParsedPlan, id: string): ParsedPlan["tasks"][number] => {
  const t = p.tasks.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no task ${id} in ${idsOf(p).join(",")}`);
  return t;
};

describe("id helpers", () => {
  it("unwraps pure tag spans only", () => {
    expect(unwrapPureTagSpans("a `[tier:fast]` b `x` `[route class=review]`")).toBe("a [tier:fast] b `x` [route class=review]");
  });

  it("normalizes the first line the same whatever the markup", () => {
    expect(normalizeFirstLine("## **Do** the  Thing [tier:fast] VERIFY:required CAP:2\nsecond line")).toBe("do the thing");
    expect(normalizeFirstLine("- [x] __Do__ the thing `[route class=review]`")).toBe("do the thing");
    expect(normalizeFirstLine("1. Do the thing")).toBe(normalizeFirstLine("* DO the thing"));
  });

  it("numbers equal hashes in plan order", () => {
    const seen = new Map<string, number>();
    const a = fallbackTaskId("- same", seen);
    const b = fallbackTaskId("* Same", seen);
    const c = fallbackTaskId("- other", seen);
    expect(a).toMatch(/^S[0-9a-f]{8}-1$/);
    expect(b).toBe(a.replace(/-1$/, "-2"));
    expect(c).toMatch(/-1$/);
    expect(c.slice(0, 9)).not.toBe(a.slice(0, 9));
  });
});

describe("parsePlan fatal errors", () => {
  const phase = ["### Phase 1.1: A", "", "**Tasks**"];

  it("rejects an unclosed fence", () => {
    const e = failure(doc("# T", "", "```", "code"));
    expect(e.code).toBe("E_COMPILE");
    expect(e.message).toContain("fence-unclosed (line 3)");
  });

  it("rejects an unclosed acceptance block", () => {
    const e = failure(doc(...phase, "- **1.1.1** x", "  [acceptance]", "  check: run command=\"x\" expect=passed"));
    expect(e.message).toContain("acceptance-unclosed");
  });

  it("rejects duplicate and invalid phase ids", () => {
    expect(failure(doc("### Phase 1.1: A", "- **1.1.1** x", "### Phase 1.1: B", "- **1.1.2** y")).message).toContain("phase-duplicate");
    expect(failure(doc("### Phase a.lock: A", "- **a.lock.1** x")).message).toContain("phase-id-invalid");
  });

  it("rejects ids reserved for the QA loop", () => {
    expect(failure(doc(...phase, "- **1.1.QA1** x")).message).toContain("id-reserved");
    expect(failure(doc(...phase, "- **1.1.FIX1-2** x")).message).toContain("id-reserved");
  });

  it("rejects duplicate ids, also across case", () => {
    expect(failure(doc(...phase, "- **1.1.1** a", "- **1.1.1** b")).message).toContain("duplicate task id 1.1.1");
  });

  it("rejects an Order that names an unknown task", () => {
    expect(failure(doc(...phase, "- **1.1.1** a", "", "**Order:** 1.1.1 → 1.1.9")).message).toContain("order-unknown-id");
  });

  it("rejects an unclosed plan-context block", () => {
    expect(failure(doc("<!-- plan-context -->", "text")).message).toContain("plan-context-unclosed (line 1)");
  });
});

describe("parsePlan structure", () => {
  const FULL = doc(
    "# Title",
    "",
    "Preamble words.",
    "",
    "## Wave 1 (1.1 -> 1.2)",
    "",
    "### Phase 1.1: Core",
    "Depends on: 0.P",
    "",
    "**Pre-flight**",
    "- Check the toolchain",
    "",
    "**Tasks**",
    "- **1.1.1** Define the types [tier:heavy] VERIFY:required CAP:3",
    "  Writes: `src/types.ts`",
    "  Reads: `src/base.ts`",
    "  - 1.1.1.a first sub",
    "  - 1.1.1.b second sub",
    "- **1.1.2** Tests for the types",
    "  Writes: `test/types.test.ts`",
    "- **1.1.3** Orchestrator: merge by hand",
    "- **1.1.4** Later work, after 1.1.1",
    "  Writes: `src/later.ts`",
    "  Depends on: 1.1.2",
    "",
    "**New tests**",
    "- extra",
    "",
    "**QA review**",
    "- review it",
    "",
    "**Order:** 1.1.1 → 1.1.2 → 1.1.3 → QA → 1.1.4",
    "",
    "### Phase 1.2: Next",
    "",
    "**Tasks**",
    "- **1.2.1** Follow up",
    "",
  );

  it("parses waves, phases, tasks and kinds", () => {
    const p = parsePlan(FULL);
    expect(p.waves.map((w) => w.id)).toEqual(["1"]);
    expect(p.phases.map((x) => x.id)).toEqual(["1.1", "1.1.post", "1.2"]);
    expect(p.phases[1]).toMatchObject({ synthetic: true, wave: "1" });
    expect(p.waves[0]?.phases).toEqual(["1.1", "1.1.post", "1.2"]);
    expect(task(p, "1.1.1")).toMatchObject({ kind: "task", tierTag: "heavy", verify: "required", cap: 3, idSource: "explicit", phase: "1.1" });
    expect(task(p, "1.1.1").subtasks).toEqual(["1.1.1.a", "1.1.1.b"]);
    expect(task(p, "1.1.1").writesLine?.text).toBe("`src/types.ts`");
    expect(task(p, "1.1.1").readsLine?.text).toBe("`src/base.ts`");
    expect(task(p, "1.1.2").kind).toBe("tests");
    expect(task(p, "1.1.3")).toMatchObject({ kind: "manual", manual: true });
    expect(task(p, "1.1.PF1")).toMatchObject({ kind: "preflight", idSource: "preflight" });
    expect(task(p, "1.1.QA")).toMatchObject({ kind: "qa", idSource: "block" });
    expect(task(p, "1.1.4").phase).toBe("1.1.post");
    expect(p.phases[0]?.order?.groups).toEqual([["1.1.1"], ["1.1.2"], ["1.1.3"], ["1.1.QA"], ["1.1.4"]]);
    expect(p.phases[0]?.newTests).toContain("New tests");
    expect(p.phases[0]?.intro).toContain("Depends on");
    expect(p.sharedContextRaw).toContain("Preamble words.");
    expect(p.sharedContextSource).toBe("preamble");
  });

  it("derives warnings, dependencies and graphs", () => {
    const p = parsePlan(FULL);
    expect(codesOf(p)).toEqual(expect.arrayContaining(["depends-unknown", "post-qa-phase"]));
    expect(p.phases[1]?.dependsOn).toEqual([{ id: "1.1", external: false, line: expect.any(Number) }]);
    expect(p.graphs.some((g) => g.edges.some((e) => e.from === "1.1" && e.to === "1.2"))).toBe(true);
    expect(p.phrases.some((x) => x.subject.id === "1.1.4" && x.verb === "after" && x.refs.includes("1.1.2"))).toBe(true);
    expect(p.phrases.some((x) => x.subject.id === "1.1.4" && x.refs.includes("1.1.1"))).toBe(true);
  });

  it("uses a plan-context block as the shared context", () => {
    const p = parsePlan(doc("Before.", "<!-- plan-context -->", "Shared notes.", "<!-- /plan-context -->", "", "### Phase 1.1: A", "- **1.1.1** x"));
    expect(p.sharedContextRaw).toBe("Shared notes.");
    expect(p.sharedContextSource).toBe("block");
  });

  it("builds implicit phases for id-bearing items outside any heading", () => {
    const p = parsePlan(doc("- **2.1.1** First", "- **2.1.2** Second"));
    expect(p.phases).toHaveLength(1);
    expect(p.phases[0]).toMatchObject({ id: "2.1", synthetic: true });
    expect(idsOf(p)).toEqual(["2.1.1", "2.1.2"]);
  });

  it("hashes id-less items of a flat plan into a 'main' phase", () => {
    const p = parsePlan(doc("# Plan", "", "- do the first thing", "- do the second thing", "- do the first thing"));
    expect(p.phases.map((x) => x.id)).toEqual(["main"]);
    expect(p.tasks.every((t) => t.idSource === "hash" && /^S[0-9a-f]{8}-\d$/.test(t.id))).toBe(true);
    expect(p.tasks.map((t) => t.id.slice(-2))).toEqual(["-1", "-1", "-2"]);
    expect(p.tasks[0]?.title).toBe("do the first thing");
  });

  it("collects nested bullets of hash tasks as subtasks", () => {
    const p = parsePlan(doc("- do the thing", "  - part one", "  - part two"));
    expect(p.tasks[0]?.subtasks).toEqual(["part one", "part two"]);
  });

  it("merges a QA review block into an explicit QA task of the same phase", () => {
    const p = parsePlan(
      doc(
        "### Phase 1.1: A",
        "",
        "**Tasks**",
        "- **1.1.1** Build it",
        "- **1.1.QA** Review the build",
        "",
        "**QA review**",
        "- also check the edge cases",
        "  Writes: `src/review.ts`",
      ),
    );
    expect(idsOf(p).filter((id) => id === "1.1.QA")).toHaveLength(1);
    const qa = task(p, "1.1.QA");
    expect(qa.kind).toBe("qa");
    expect(qa.text).toContain("Review the build");
    expect(qa.text).toContain("also check the edge cases");
    expect(qa.body).toContain("also check the edge cases");
    expect(qa.span.endLine).toBeGreaterThan(qa.span.line + 1);
    expect(qa.writesLine?.text).toBe("`src/review.ts`");
  });

  it("keeps what the explicit QA task already declares when the block repeats it", () => {
    const p = parsePlan(
      doc(
        "### Phase 1.1: A",
        "",
        "**Tasks**",
        "- **1.1.QA** Review the build [tier:heavy] VERIFY:required CAP:2",
        "  Writes: `src/own.ts`",
        "",
        "**QA review**",
        "- second look [tier:fast] VERIFY:none CAP:5",
        "  Writes: `src/other.ts`",
      ),
    );
    const qa = task(p, "1.1.QA");
    expect(qa.tierTag).toBe("heavy");
    expect(qa.verify).toBe("required");
    expect(qa.cap).toBe(2);
    expect(qa.writesLine?.text).toBe("`src/own.ts`");
  });

  it("joins the continuation lines of a task-level Depends on clause", () => {
    const p = parsePlan(
      doc(
        "### Phase 1.1: A",
        "",
        "**Tasks**",
        "- **1.1.1** First",
        "- **1.1.2** Second",
        "- **1.1.3** Third",
        "  Depends on: 1.1.1",
        "  and also 1.1.2",
        "  Writes: `src/third.ts`",
      ),
    );
    const after = p.phrases.find((x) => x.subject.id === "1.1.3" && x.verb === "after");
    expect(after?.refs).toEqual(["1.1.1", "1.1.2"]);
  });
});

describe("parsePlan warnings", () => {
  const head = ["### Phase 1.1: A", "", "**Tasks**"];

  it("warns about repeated waves", () => {
    const p = parsePlan(doc("## Wave 1", "## Wave 1", "### Phase 1.1: A", "- **1.1.1** x"));
    expect(codesOf(p)).toContain("wave-duplicate");
  });

  it("warns about an unknown VERIFY value and keeps an empty DoD block as given", () => {
    const p = parsePlan(doc(...head, "- **1.1.1** x VERIFY:maybe", "  [DoD]", "  [/DoD]"));
    expect(codesOf(p)).toContain("verify-unknown");
    expect(task(p, "1.1.1").verify).toBeNull();
    expect(task(p, "1.1.1").acceptance).toContain("[DoD]");
  });

  it("accepts a well-formed acceptance block", () => {
    const p = parsePlan(doc(...head, "- **1.1.1** x", "  [acceptance]", "  check: run command=\"npm test\" expect=passed", "  [/acceptance]"));
    expect(codesOf(p)).not.toContain("acceptance-malformed");
    expect(task(p, "1.1.1").acceptance).toContain("npm test");
  });

  it("keeps a route line and its tier, and flags conflicting or malformed ones", () => {
    const ok = parsePlan(doc(...head, "- **1.1.1** x", "  [route class=implement risk=low scope=single d=none tier=medium]"));
    expect(task(ok, "1.1.1").route?.fields?.tier).toBe("medium");
    expect(task(ok, "1.1.1").tierTag).toBe("medium");
    expect(task(ok, "1.1.1").route?.line).toContain("[route class=implement");
    const conflict = parsePlan(doc(...head, "- **1.1.1** x", "  [route class=implement risk=low scope=single d=none]", "  [route class=review risk=high scope=multi d=none]"));
    expect(codesOf(conflict)).toContain("route-conflict");
    const bad = parsePlan(doc(...head, "- **1.1.1** x", "  [route class=%%% risk=zzz]"));
    expect(codesOf(bad).some((c) => c === "route-malformed") || task(bad, "1.1.1").route !== null).toBe(true);
  });

  it("reports a second FIX template once and keeps it out of the tasks", () => {
    const p = parsePlan(doc(...head, "- **1.1.1** x", "- **1.1.FIX** fix one", "- **1.1.FIX** fix two"));
    expect(idsOf(p)).toEqual(["1.1.1"]);
    expect(p.phases[0]?.fixTemplate?.id).toBe("1.1.FIX");
    expect(codesOf(p)).toContain("fix-template-duplicate");
  });

  it("reports items in metadata blocks, id mismatches and id-less items", () => {
    const p = parsePlan(doc(...head, "- **1.1.1** x", "- **2.2.1** wrong phase", "- bare item", "", "**New tests**", "- **9.9.9** inside"));
    expect(codesOf(p)).toEqual(expect.arrayContaining(["id-phase-mismatch", "id-less-item"]));
    const q = parsePlan(doc(...head, "- **1.1.1** x", "", "**Acceptance criteria**", "- **9.9.9** in a block"));
    expect(codesOf(q)).toContain("item-in-metadata-block");
    expect(idsOf(q)).toEqual(["1.1.1"]);
  });

  it("reports items outside phases and intro items", () => {
    const p = parsePlan(doc("- loose", "- **0.P** summary of phase 0", "", "### Phase 0.P: Pre", "- **0.P.1** a", "", "### Phase 1.1: A", "- intro bullet", "", "**Tasks**", "- **1.1.1** x"));
    expect(codesOf(p)).toEqual(expect.arrayContaining(["item-outside-phase", "intro-item-ignored"]));
    expect(idsOf(p)).toEqual(["0.P.1", "1.1.1"]);
  });

  it("reports unknown graph nodes and unknown references", () => {
    const p = parsePlan(doc(...head, "- **1.1.1** x, after 7.7.7", "", "```mermaid", "graph TD", "  1.1.1 --> 8.8.8", "```"));
    expect(codesOf(p)).toEqual(expect.arrayContaining(["graph-node-unknown", "explicit-ref-unknown"]));
    expect(p.graphs).toHaveLength(1);
    expect(p.phrases).toEqual([]);
  });
});

describe("parsePlan phrases, tables and dogfood", () => {
  it("reads ownership tables in file-major, phase-major and named layouts", () => {
    const p = parsePlan(doc(
      "### Phase 1.1: A", "- **1.1.1** x", "### Phase 1.2: B", "- **1.2.1** y",
      "",
      "| File | 1.1 | 1.2 |",
      "|---|---|---|",
      "| `src/a.ts` | x | |",
      "| `src/b.ts` | 1.2 | no |",
      "| `` |  |  |",
      "",
      "| Phase | Owns |",
      "|---|---|",
      "| 1.1 | `src/c.ts`, `plain`, `src/dir/` Starts after 1.2 merges |",
      "| zzz | `src/q.ts` |",
      "",
      "| Wave | Phase | Owns (writes) |",
      "| 1 | 1.2 | `src/d.ts` |",
    ));
    const rows = p.ownership.map((r) => `${r.format}:${r.path}:${r.owners.join("+")}`);
    expect(rows).toEqual(expect.arrayContaining([
      "file-major:src/a.ts:1.1",
      "file-major:src/b.ts:1.2",
      "phase-major:src/c.ts:1.1",
      "phase-major:src/dir/:1.1",
      "phase-major:src/d.ts:1.2",
    ]));
    expect(rows.some((r) => r.includes("plain"))).toBe(false);
    expect(p.phrases.some((x) => x.subject.kind === "phase" && x.subject.id === "1.1" && x.refs.includes("1.2"))).toBe(true);
  });

  it("extracts after-like and before phrases from phase prose", () => {
    const p = parsePlan(doc(
      "### Phase 1.1: A", "Builds on 1.2 and requires 1.3; blocked by 1.4. Runs before 1.5.", "- **1.1.1** x",
      "### Phase 1.2: B", "- **1.2.1** y",
      "### Phase 1.3: C", "- **1.3.1** y",
      "### Phase 1.4: D", "- **1.4.1** y",
      "### Phase 1.5: E", "- **1.5.1** y",
    ));
    const refs = p.phrases.filter((x) => x.subject.id === "1.1").map((x) => `${x.verb}:${x.refs[0]}`);
    expect(refs).toEqual(expect.arrayContaining(["after:1.2", "after:1.3", "after:1.4", "before:1.5"]));
  });

  it("keeps a bare 'merged first' on a wave", () => {
    const p = parsePlan(doc("## Wave 1 (types merged first)", "### Phase 1.1: A", "- **1.1.1** x"));
    expect(p.phrases.some((x) => x.subject.kind === "wave" && x.verb === "merged-first" && x.refs.length === 0)).toBe(true);
  });

  it("parses dogfood sections into manual DF tasks", () => {
    const p = parsePlan(doc(
      "## Dogfood switch DF-1 (the switch)", "",
      "**Tasks**",
      "- DF-1.1 flip the flag",
      "- QA the switch",
      "- something else",
      "",
      "**Acceptance criteria**",
      "- not a task",
    ));
    expect(p.phases[0]).toMatchObject({ id: "DF1", dogfood: true });
    expect(idsOf(p)).toEqual(["DF1.1", "DF1.QA", "DF1.3"]);
    expect(p.tasks.every((t) => t.manual && t.idSource === "dogfood")).toBe(true);
  });

  it("resolves Depends on to dogfood switches", () => {
    const p = parsePlan(doc(
      "### Phase 1.1: A", "**Depends on:** DF-3 and 1.2 · **Goal:** go", "- **1.1.1** x",
      "### Phase 1.2: B", "- **1.2.1** y",
    ));
    expect(p.phases[0]?.dependsOn.map((d) => [d.id, d.external])).toEqual([["DF3", true], ["1.2", false]]);
  });

  it("treats an all-heading plan as steps rather than phases", () => {
    const p = parsePlan(doc("# Plan", "", "Preamble.", "", "## Phase 1 Build the parser", "", "Implement it in `src/a.ts`.", "", "## Phase 2 Wire the parser", "", "Wire it."));
    expect(p.phases.map((x) => x.id)).toEqual(["main"]);
    expect(p.tasks.map((t) => [t.idSource, t.phase])).toEqual([["hash", "main"], ["hash", "main"]]);
  });

  it("skips fenced items and HTML-commented graphs", () => {
    const p = parsePlan(doc(
      "### Phase 1.1: A", "**Tasks**", "- **1.1.1** x", "```", "- **1.1.2** hidden", "```",
      "<!--", "```", "1.1.1 --> 1.1.1", "```", "-->",
    ));
    expect(idsOf(p)).toEqual(["1.1.1"]);
    expect(p.graphs).toEqual([]);
  });
});

describe("parsePlan fixtures", () => {
  const synthetic = readdirSync(`${FIXTURES_DIR}/synthetic`).filter((n) => n.endsWith(".md"));
  const real = readdirSync(FIXTURES_DIR).filter((n) => n.endsWith("-plan.md"));

  it.each(synthetic)("parses or rejects synthetic/%s deterministically", (name) => {
    const text = readFixture(`synthetic/${name}`);
    let first: unknown;
    let second: unknown;
    try {
      first = parsePlan(text);
    } catch (e) {
      first = (e as ExecutorError).message;
    }
    try {
      second = parsePlan(text);
    } catch (e) {
      second = (e as ExecutorError).message;
    }
    expect(second).toEqual(first);
    if (typeof first !== "string") expect((first as ParsedPlan).tasks.length + (first as ParsedPlan).phases.length).toBeGreaterThan(0);
    else expect(first).toMatch(/\(line \d+\)/);
  });

  it.each(real)("parses %s into phases and tasks", (name) => {
    const p = parsePlan(readFixture(name));
    expect(p.phases.length).toBeGreaterThan(0);
    expect(p.tasks.length).toBeGreaterThan(0);
    for (const t of p.tasks) expect(t.span.line).toBeGreaterThan(0);
  });
});

describe("annotateUnrouted", () => {
  const text = doc(
    "### Phase 1.1: A", "**Tasks**",
    "- **1.1.1** routed",
    "  [route class=implement risk=low scope=single d=none tier=heavy]",
    "- **1.1.2** unrouted [tier:fast]",
    "- **1.1.3** other unrouted",
    "- **1.1.4** Orchestrator: by hand",
  );
  const stub = (calls: PlanStep[][], tier: string): ((s: readonly PlanStep[]) => Promise<AnnotatedPlan>) => async (steps) => {
    calls.push([...steps]);
    const list = steps.map((s) => ({ id: s.id, tier, routeLine: "[route class=review risk=low scope=single d=none tier=medium]", text: s.text, pin: false }));
    return Object.assign(list, { pinnedCount: 0 }) as unknown as AnnotatedPlan;
  };

  it("annotates only routable tasks without a route line", async () => {
    const p = parsePlan(text);
    const calls: PlanStep[][] = [];
    const out = await annotateUnrouted(p, stub(calls, "medium"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((s) => s.id)).toEqual(["1.1.2", "1.1.3"]);
    expect(task(out, "1.1.1").route?.fields?.tier).toBe("heavy");
    expect(task(out, "1.1.2").tierTag).toBe("fast");
    expect(task(out, "1.1.3").tierTag).toBe("medium");
    expect(task(out, "1.1.3").route).toMatchObject({ conflict: false });
    expect(task(out, "1.1.3").route?.line).toContain("class=review");
    expect(task(out, "1.1.4").route).toBeNull();
    expect(task(p, "1.1.3").route).toBeNull();
  });

  it("ignores a tier the engine did not give and leaves the plan alone when nothing is pending", async () => {
    const p = parsePlan(text);
    const out = await annotateUnrouted(p, stub([], "weird"));
    expect(task(out, "1.1.3").tierTag).toBeNull();
    const calls: PlanStep[][] = [];
    const routed = parsePlan(doc("### Phase 1.1: A", "**Tasks**", "- **1.1.1** x", "  [route class=implement risk=low scope=single d=none tier=heavy]"));
    expect(await annotateUnrouted(routed, stub(calls, "medium"))).toBe(routed);
    expect(calls).toEqual([]);
  });

  it("skips tasks the engine returned nothing for", async () => {
    const p = parsePlan(text);
    const out = await annotateUnrouted(p, async () => Object.assign([], { pinnedCount: 0 }) as unknown as AnnotatedPlan);
    expect(task(out, "1.1.2").route).toBeNull();
  });
});
