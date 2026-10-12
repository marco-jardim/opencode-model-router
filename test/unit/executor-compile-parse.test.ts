import { describe, expect, it } from "vitest";

import { fallbackTaskId, normalizeFirstLine, parsePlan, unwrapPureTagSpans } from "../../src/executor/compile/parse";
import { ExecutorError } from "../../src/executor/types";
import { readFixture } from "../fixtures/cpx/plans/loader";
import { compileOpts, makeHarness, planPathOf } from "../fixtures/cpx/plans/harness";

function idsOf(text: string): string[] {
  return parsePlan(text).tasks.map((t) => t.id);
}

function phaseDoc(id: string, item: string): string {
  return `# Plan\n\n## Phase ${id} Title\n\n**Tasks**\n${item}\n`;
}

describe("executor compile: parse, QA-2.3 round 1 (batch B)", () => {
  const phases = (...ids: string[]): string => ids.map((id) => `## Phase ${id} T\n\n**Tasks**\n- **${id}.1** \`[tier:fast]\` Do it.\n  Writes: \`src/p${id}.ts\`\n`).join("\n");
  const depsOf = (text: string, id: string): string[] => (parsePlan(text).phases.find((p) => p.id === id)?.dependsOn ?? []).map((d) => d.id);

  it("QA-2.3-7: `Depends on:` keeps ids on both sides of `;` and joins continuation lines before cutting", () => {
    const text = `# Plan\n\n${phases("1.1", "1.3")}\n## Phase 2.1 T\n\n**Depends on:** 1.1 (config); 1.3\n\n**Tasks**\n- **2.1.1** \`[tier:fast]\` Do it.\n`;
    expect(depsOf(text, "2.1")).toEqual(expect.arrayContaining(["1.1", "1.3"]));
    const wrapped = `# Plan\n\n${phases("1.1", "1.3")}\n## Phase 2.1 T\n\n**Depends on:** 1.1,\n  1.3 · **Worktree:** x\n\n**Tasks**\n- **2.1.1** \`[tier:fast]\` Do it.\n`;
    expect(depsOf(wrapped, "2.1")).toEqual(expect.arrayContaining(["1.1", "1.3"]));
  });

  it("QA-2.3-7: ids governed by a `parallel with` phrase are not dependencies", () => {
    const text = `# Plan\n\n${phases("1.1", "1.3")}\n## Phase 2.1 T\n\n**Depends on:** 1.1; runs in parallel with 1.3\n\n**Tasks**\n- **2.1.1** \`[tier:fast]\` Do it.\n`;
    const deps = depsOf(text, "2.1");
    expect(deps).toContain("1.1");
    expect(deps).not.toContain("1.3");
  });

  it("QA-2.3-7: a task-level `Depends on:` line is an explicit phrase", () => {
    const text = `# Plan\n\n${phases("1.1")}\n## Phase 2.1 T\n\n**Tasks**\n- **2.1.1** \`[tier:fast]\` Do it.\n  Depends on: 1.1.1; 1.1\n`;
    const refs = parsePlan(text).phrases.filter((p) => p.subject.id === "2.1.1").flatMap((p) => p.refs);
    expect(refs).toEqual(expect.arrayContaining(["1.1.1", "1.1"]));
  });

  it("QA-2.3-27: a phase-level `Depends on:` clause ends at a sentence boundary unless an id follows", () => {
    const head = `# Plan\n\n${phases("1.1", "1.3")}\n## Phase 2.1 T\n\n`;
    const tail = "\n\n**Tasks**\n- **2.1.1** `[tier:fast]` Do it.\n";
    const ended = depsOf(`${head}**Depends on:** 1.1. Background reading is in 1.3 only.${tail}`, "2.1");
    expect(ended).toContain("1.1");
    expect(ended).not.toContain("1.3");
    const wrapped = depsOf(`${head}**Depends on:** 1.1.\n  1.3${tail}`, "2.1");
    expect(wrapped).toEqual(expect.arrayContaining(["1.1", "1.3"]));
    expect(depsOf(`${head}**Depends on:** 1.1 (config); 1.3${tail}`, "2.1")).toEqual(expect.arrayContaining(["1.1", "1.3"]));
  });

  it("QA-2.3-27: a task-level `Depends on:` join stops at the Writes:, Reads: and [route lines", () => {
    const text = `# Plan\n\n${phases("1.1")}\n## Phase 2.1 T\n\n**Tasks**\n- **2.1.1** \`[tier:fast]\` Do it.\n  Depends on: 1.1.1\n  Writes: \`src/x.ts\` (shares 1.1.2)\n  Reads: \`src/y.ts\` after 1.1.3\n`;
    const refs = parsePlan(text).phrases.filter((p) => p.subject.id === "2.1.1" && p.verb === "after").flatMap((p) => p.refs);
    expect(refs).toEqual(["1.1.1"]);
  });

  it("QA-2.3-31: a block label that is the whole line is accepted without a colon", () => {
    const text = "# Plan\n\n## Phase 1.1 T\n\nPre-flight\n- check the tree\n\n**Tasks**\n- **1.1.1** `[tier:fast]` Real task.\n";
    const p = parsePlan(text);
    expect(p.tasks.filter((t) => t.kind === "preflight")).toHaveLength(1);
    expect(p.tasks.map((t) => t.id)).toContain("1.1.1");
    const prose = "# Plan\n\n## Phase 1.1 T\n\nPre-flight checks are described below.\n\n**Tasks**\n- **1.1.1** `[tier:fast]` Real task.\n";
    expect(parsePlan(prose).tasks.filter((t) => t.kind === "preflight")).toHaveLength(0);
  });

  it("QA-2.3-8: an item with the phase's own id prefix is a task even inside a metadata block", () => {
    const text = `# Plan\n\n## Phase 1.1 T\n\n**Tasks**\n- **1.1.1** \`[tier:fast]\` One.\n\n**Acceptance criteria**\n- a plain bullet\n- **1.1.2** \`[tier:fast]\` Two.\n`;
    expect(idsOf(text)).toEqual(expect.arrayContaining(["1.1.1", "1.1.2"]));
  });

  it("QA-2.3-8: an id'd item of another prefix inside a metadata block is reported, not dropped silently", () => {
    const text = `# Plan\n\n## Phase 1.1 T\n\n**Tasks**\n- **1.1.1** \`[tier:fast]\` One.\n\n**Acceptance criteria**\n- **9.9.1** foreign.\n`;
    const p = parsePlan(text);
    expect(p.tasks.map((t) => t.id)).not.toContain("9.9.1");
    expect(p.warnings.some((w) => w.code === "item-in-metadata-block")).toBe(true);
  });

  it("QA-2.3-8: a Pre-flight block ends at another bold label and an own-prefix id", () => {
    const text = `# Plan\n\n## Phase 1.1 T\n\n**Pre-flight**\n- check the tree\n- **1.1.1** \`[tier:fast]\` Real task.\n\n**Goal:** x\n- stray\n`;
    const p = parsePlan(text);
    expect(p.tasks.filter((t) => t.kind === "preflight")).toHaveLength(1);
    expect(p.tasks.map((t) => t.id)).toContain("1.1.1");
    const text2 = `# Plan\n\n## Phase 1.1 T\n\n**Pre-flight**\n- check the tree\n**Goal:** x\n- stray\n`;
    expect(parsePlan(text2).tasks.filter((t) => t.kind === "preflight")).toHaveLength(1);
  });

  it("QA-2.3-8: prose that merely starts with a block word is not a label", () => {
    const text = `# Plan\n\n## Phase 1.1 T\n\nTasks 1.1.2 and 1.1.3 start after review.\n\n**Tasks**\n- **1.1.1** \`[tier:fast]\` One.\n`;
    expect(idsOf(text)).toEqual(["1.1.1"]);
  });

  it("QA-2.3-11: a `Writes:` inside inline code is not a label", () => {
    const text = phaseDoc("1.1", "- **1.1.1** `[tier:fast]` Document `Writes: nothing` handling.\n  Writes: `src/real.ts`\n");
    const json = JSON.stringify(parsePlan(text).tasks[0]?.writesLine ?? null);
    expect(json).toContain("src/real.ts");
    expect(json).not.toContain("nothing");
  });

  it("QA-2.3-12: a graph block inside an HTML comment is ignored", () => {
    const fence = "```\n1.1 --> 1.2\n```";
    const inComment = `# Plan\n\n${phases("1.1", "1.2")}\n<!--\n${fence}\n-->\n`;
    expect(parsePlan(inComment).graphs).toHaveLength(0);
    const live = `# Plan\n\n${phases("1.1", "1.2")}\n<!-- note -->\n\n${fence}\n`;
    expect(parsePlan(live).graphs).toHaveLength(1);
  });
});

describe("executor compile: parse (2.3.2)", () => {
  describe("id forms (plan:2347)", () => {
    it.each([
      ["1.1", "- **1.1.1** `[tier:medium]` Implement it in `src/alpha/core.ts`.", "1.1.1"],
      ["1.1", "- 1.1.1 `[tier:medium]` Implement it in `src/alpha/core.ts`.", "1.1.1"],
      ["1.1", "- [ ] **1.1.2** `[tier:medium]` Implement it in `src/alpha/core.ts`.", "1.1.2"],
      ["1.1", "- **T1.1.3** `[tier:medium]` Implement it in `src/alpha/core.ts`.", "T1.1.3"],
      ["0.P", "- **0.P.1** `[tier:fast]` Gather context.", "0.P.1"],
      ["1.1", "- **1.1.QA** `[tier:heavy]` Adversarial review.", "1.1.QA"],
      ["6.2", "- **6.2.0** `[tier:medium]` Prepare the base in `src/alpha/core.ts`.", "6.2.0"],
    ])("recognises %s item %s", (phase, item, id) => {
      expect(idsOf(phaseDoc(phase, item))).toContain(id);
    });

    it("keeps the FIX template out of the tasks and exposes it on the phase", () => {
      const p = parsePlan(phaseDoc("1.1", "- **1.1.1** Implement it in `src/alpha/core.ts`.\n- **1.1.FIX** Apply the findings."));
      expect(p.tasks.map((t) => t.id)).toEqual(["1.1.1"]);
      expect(p.phases.find((ph) => ph.id === "1.1")?.fixTemplate?.id).toBe("1.1.FIX");
    });

    it("types a .QA task as qa and records the VERIFY and CAP directives", () => {
      const p = parsePlan(phaseDoc("1.1", "- **1.1.QA** `[tier:heavy]` Review VERIFY:deferred CAP:none"));
      const qa = p.tasks[0];
      expect(qa?.kind).toBe("qa");
      expect(qa?.verify).toBe("deferred");
      expect(qa?.cap).toBe("none");
      expect(qa?.tierTag).toBe("heavy");
    });

    it("rejects duplicate ids with E_COMPILE", () => {
      const text = readFixture("synthetic/duplicate-ids.md");
      expect(() => parsePlan(text)).toThrow(/id-duplicate/);
      try {
        parsePlan(text);
      } catch (e) {
        expect(e).toBeInstanceOf(ExecutorError);
      }
    });

  });

  describe("tags: backticked and plain forms agree (plan:2378)", () => {
    it("gives the same tier, route and id", () => {
      const plain = parsePlan(phaseDoc("1.1", "- **1.1.1** [tier:medium] Implement it in `src/alpha/core.ts`."));
      const wrapped = parsePlan(phaseDoc("1.1", "- **1.1.1** `[tier:medium]` Implement it in `src/alpha/core.ts`."));
      expect(wrapped.tasks[0]?.tierTag).toBe("medium");
      expect(plain.tasks[0]?.tierTag).toBe(wrapped.tasks[0]?.tierTag);
      expect(plain.tasks[0]?.id).toBe(wrapped.tasks[0]?.id);
    });

    it("unwraps pure-tag code spans only", () => {
      expect(unwrapPureTagSpans("`[tier:fast]` do `x`")).toBe("[tier:fast] do `x`");
      expect(unwrapPureTagSpans("`[tier:fast] extra`")).toBe("`[tier:fast] extra`");
      expect(unwrapPureTagSpans("`[route class=design]` go")).toBe("[route class=design] go");
    });
  });

  describe("fences and inline code", () => {
    it("ignores list items inside fences", () => {
      const ids = idsOf(readFixture("synthetic/fences-with-items.md"));
      expect(ids).toEqual(["1.1.1", "1.1.2"]);
    });

    it("throws E_COMPILE fence-unclosed for an unclosed fence", () => {
      const text = readFixture("synthetic/unclosed-fence.md");
      expect(() => parsePlan(text)).toThrow(/fence-unclosed/);
      let caught: unknown = null;
      try {
        parsePlan(text);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ExecutorError);
    });

    it("throws E_COMPILE acceptance-unclosed for an unclosed [acceptance] block", () => {
      const doc = phaseDoc("1.1", "- **1.1.1** Implement it.\n  [acceptance]\n  check: testsPass\n");
      expect(() => parsePlan(doc)).toThrow(/acceptance-unclosed/);
    });
  });

  describe("dogfood sections", () => {
    const df = [
      "# DF plan",
      "",
      "## Wave 1",
      "",
      "### Phase 2.1 Build",
      "",
      "**Tasks**",
      "- **2.1.1** `[tier:medium]` Build it in `src/alpha/core.ts`.",
      "  Writes: `src/alpha/core.ts`",
      "",
      "### Dogfood switch DF-1 — run on the new build",
      "",
      "**Depends on:** 2.1.",
      "",
      "**Pre-flight (in addition to §0.12-3 step 1)**",
      "- [ ] 2.1 is merged and green.",
      "- [ ] The dogfood record exists.",
      "",
      "**Tasks**",
      "- **DF1.1** Orchestrator: tag the build.",
      "- **DF1.2** Planned human action: restart.",
      "- **DF1.QA** [tier:heavy] Senior QA of the switch.",
      "- **DF1.FIX** Every finding is fixed.",
      "",
      "**Acceptance criteria**",
      "- DF1.QA has zero open findings.",
      "",
    ].join("\n");

    it("numbers items of a DF section without a Pre-flight block by ordinal and marks them manual", () => {
      const p = parsePlan(readFixture("synthetic/df-switch.md"));
      const ids = p.tasks.filter((t) => t.phase === "DF1").map((t) => t.id);
      expect(ids).toEqual(["DF1.1", "DF1.2", "DF1.QA"]);
      expect(p.tasks.filter((t) => t.phase === "DF1").every((t) => t.manual)).toBe(true);
      expect(p.phases.find((ph) => ph.id === "DF1")?.dogfood).toBe(true);
    });

    // D4 (fixed): Pre-flight items of a DF section used to get ordinal ids DF1.1, DF1.2 and collide with the authored DF1.1
    // (cpx:2051-2059), and Acceptance/DoD items such as `- DF1.QA has zero open findings.` (cpx:2156) became tasks.
    // Memo section 2 step 6: Pre-flight items are `DF1.PF<k>` (kind preflight); Acceptance/DoD items are metadata.
    it("D4: Pre-flight items of a DF section are DF<n>.PF<k> and metadata blocks are not tasks", () => {
      const p = parsePlan(df);
      const ids = p.tasks.filter((t) => t.phase === "DF1").map((t) => t.id);
      expect(ids).toEqual(["DF1.PF1", "DF1.PF2", "DF1.1", "DF1.2", "DF1.QA"]);
      expect(p.tasks.find((t) => t.id === "DF1.PF1")?.kind).toBe("preflight");
    });
  });

  describe("nested subtasks, headings only, unannotated flat list", () => {
    it("keeps subtasks inside the parent and attributes their Writes", () => {
      const p = parsePlan(readFixture("synthetic/nested-subtasks.md"));
      expect(p.tasks.map((t) => t.id)).toEqual(["1.1.1", "1.1.2"]);
      expect(p.tasks[0]?.subtasks).toEqual(["1.1.1.a", "1.1.1.b"]);
      expect(p.tasks[0]?.writesLine?.text).toContain("src/alpha/core.ts");
      expect(p.tasks[0]?.writesLine?.text).toContain("src/alpha/helpers.ts");
      expect(p.tasks[1]?.writesLine?.text).toContain("docs/core.md");
    });

    it("compiles a headings-only plan into tasks without throwing", () => {
      const p = parsePlan(readFixture("synthetic/headings-only.md"));
      expect(p.tasks.length).toBeGreaterThan(0);
      expect(p.phases.length).toBeGreaterThan(0);
    });

    it("gives every item of an unannotated flat list a hash id in one synthetic phase", () => {
      const p = parsePlan(readFixture("synthetic/unannotated-flat.md"));
      expect(p.tasks).toHaveLength(3);
      for (const t of p.tasks) {
        expect(t.id).toMatch(/^S[0-9a-f]{8}-\d+$/);
        expect(t.idSource).toBe("hash");
        expect(t.phase).toBe("main");
      }
      expect(p.phases.map((ph) => ph.id)).toEqual(["main"]);
    });

    it("calls annotate exactly once, with every unrouted task", async () => {
      const h = makeHarness();
      await h.compiler.compile(planPathOf("synthetic/unannotated-flat.md"), compileOpts(h));
      expect(h.annotateCalls).toHaveLength(1);
      expect(h.annotateCalls[0]).toHaveLength(3);
    });
  });

  describe("id stability", () => {
    const base = readFixture("synthetic/unannotated-flat.md");

    it("keeps ids when lines are inserted above a task", () => {
      const shifted = base.replace("Shared preamble line for every task.", "Shared preamble line for every task.\n\nExtra paragraph.\n\nAnother one.");
      expect(idsOf(shifted)).toEqual(idsOf(base));
    });

    it("keeps ids when the plan is re-annotated with tags", () => {
      const tagged = base.replace(/^- /gm, "- `[tier:fast]` ");
      expect(idsOf(tagged)).toEqual(idsOf(base));
    });

    it("numbers equal first lines by ordinal", () => {
      const seen = new Map<string, number>();
      const a = fallbackTaskId("- Do the thing", seen);
      const b = fallbackTaskId("- [ ] **Do** the thing [tier:fast] VERIFY:required", seen);
      expect(a).toMatch(/^S[0-9a-f]{8}-1$/);
      expect(b.slice(0, 9)).toBe(a.slice(0, 9));
      expect(b.endsWith("-2")).toBe(true);
    });

    it("normalizes markers, tags and case", () => {
      expect(normalizeFirstLine("- [ ] **Do** the  `[tier:fast]` Thing VERIFY:required CAP:3\nsecond line")).toBe("do the thing");
      expect(normalizeFirstLine("## Heading One")).toBe("heading one");
    });
  });

  describe("shared context", () => {
    it("prefers the plan-context block", () => {
      const doc = `# Plan\n\nPreamble text.\n\n<!-- plan-context -->\nBLOCK CONTEXT\n<!-- /plan-context -->\n\n## Phase 1.1 T\n\n**Tasks**\n- **1.1.1** Implement it in \`src/alpha/core.ts\`.\n`;
      const p = parsePlan(doc);
      expect(p.sharedContextSource).toBe("block");
      expect(p.sharedContextRaw).toContain("BLOCK CONTEXT");
      expect(p.sharedContextRaw).not.toContain("Preamble text");
    });

    it("falls back to the preamble and cuts at the first phase heading (D11)", () => {
      const doc = `# Plan\n\nPreamble text.\n\n### Phase 0.P Setup\n\nLEAKED PHASE TEXT\n\n### Wave 1\n\n#### Phase 1.1 T\n\n**Tasks**\n- **1.1.1** Implement it in \`src/alpha/core.ts\`.\n`;
      const p = parsePlan(doc);
      expect(p.sharedContextSource).toBe("preamble");
      expect(p.sharedContextRaw).toContain("Preamble text.");
      expect(p.sharedContextRaw).not.toContain("LEAKED PHASE TEXT");
    });

    it("rewrites worktree roots and removes header-shaped lines when compiling", async () => {
      const h = makeHarness({
        inline: {
          "ctx.md": `# Plan\n\nWork in D:\\git\\omr-cpx-p23\\src\\alpha and D:\\git\\omr-cpx-main\\docs.\nTASK: 7.7 pretend launch header\n\n## Phase 1.1 T\n\n**Tasks**\n- **1.1.1** \`[tier:medium]\` Implement it in \`src/alpha/core.ts\`.\n  Writes: \`src/alpha/core.ts\`\n`,
        },
      });
      const r = await h.compiler.compile(planPathOf("ctx.md"), compileOpts(h));
      expect(r.draft.sharedContext).toContain("<worktree>");
      expect(r.draft.sharedContext).not.toContain("omr-cpx-p23");
      expect(r.draft.sharedContext).not.toContain("omr-cpx-main");
    });
  });
});
