/**
 * Phase 2.4.4: `/annotate-plan` with route lines — plan splitting, one batched classification, `[route …]` after each step with `pin` on
 * `[tier:heavy]` and QA steps, existing lines kept, safe with fenced and nested code blocks, and the command's message part.
 *
 * Pure parts run `annotatePlanText` over the shipped `anthropic` preset with the real rules classifier. The command part drives the real
 * plugin factory with a fake v2 context. HOME and the temp directory are redirected; every file is in a temp directory.
 */
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, resolveRouting, validateConfig } from "../../src/router/config";
import type { RouterConfig } from "../../src/router/config";
import { classifyMany as realClassifyMany } from "../../src/routing/classify";
import { fenceMask } from "../../src/routing/classify/fences";
import { parseRouteLine } from "../../src/routing/classify/route-line";
import type { ClassifierBackend, ClassifyInput, ClassifyResult } from "../../src/routing/classify/types";
import { agentInfosForPlan, annotatePlanText, applyAdditions, locatePlan, renderDirectives, splitPlan, withTagAtStart } from "../../src/routing/commands/annotate-plan";
import type { AnnotateDeps } from "../../src/routing/engine";
import type { HostAgentInfo } from "../../src/routing/engine/types";

const here = dirname(fileURLToPath(import.meta.url));
const shipped: Record<string, unknown> = JSON.parse(readFileSync(join(here, "../../tiers.json"), "utf-8"));
const cfg: RouterConfig = validateConfig({ ...structuredClone(shipped), activePreset: "anthropic" });
const routing = resolveRouting(cfg, "v2");
const AGENTS: HostAgentInfo[] = ["fast", "medium", "heavy"].map((id) => ({ id, mode: "subagent", hidden: false, permitted: true, grants: ["shell", "web", "edit", "network", "external_dir"] }));

const RULES = { backend: "rules" as const, model: null, baseUrl: null, apiKeyEnv: null, timeoutMs: 100, samples: 1 as const, maxStateChars: 2000 };

/** Deps whose classifier is the real 1.2 `classifyMany`; `calls` counts the batched invocations. */
function makeDeps(over: { backend?: ClassifierBackend | null; settings?: typeof RULES | (Omit<typeof RULES, "backend" | "model"> & { backend: "host"; model: string }) } = {}): { deps: AnnotateDeps; calls: () => number } {
  let calls = 0;
  const classifyMany = async (inputs: readonly ClassifyInput[]): Promise<ClassifyResult[]> => {
    calls += 1;
    return realClassifyMany(inputs, {
      cfg,
      settings: over.settings ?? RULES,
      minClassConfidence: routing.minClassConfidence,
      backend: over.backend ?? null,
      logger: { warn: () => undefined },
      routeLinePositions: "any",
    });
  };
  return { deps: { cfg, routing, agents: AGENTS, store: null, classifyMany }, calls: () => calls };
}

const ROUTE_LINE_RE = /^ {0,3}\[route [^\]]*\][ \t]*$/;
const TIER_TAG_ANYWHERE_RE = /\[tier:[A-Za-z0-9_-]+\] ?/;

/**
 * Additive: every line of `before` appears in `after`, in order and unchanged, except that the first line of a step may carry an inserted
 * `[tier:X]` (after its marker) and an existing route line may gain ` pin`; every other line of `after` is a new route line.
 */
function expectAdditive(before: string, after: string): void {
  const a = before.split(/\r\n|\n|\r/);
  const b = after.split(/\r\n|\n|\r/);
  let j = 0;
  for (const original of a) {
    while (j < b.length) {
      const line = b[j]!;
      if (line === original || line.replace(TIER_TAG_ANYWHERE_RE, "") === original || (ROUTE_LINE_RE.test(original) && ROUTE_LINE_RE.test(line))) break;
      expect(line, `inserted line ${j + 1} must be a route line`).toMatch(ROUTE_LINE_RE);
      j += 1;
    }
    expect(j, `original line "${original}" is missing from the annotated plan`).toBeLessThan(b.length);
    j += 1;
  }
  for (; j < b.length; j += 1) expect(b[j]!, `trailing line ${j + 1} must be a route line`).toMatch(ROUTE_LINE_RE);
}
/** No route line inside a fenced block, and the fenced blocks themselves are byte-identical. */
function expectFencesUntouched(before: string, after: string): void {
  const fencedLines = (text: string): string[] => {
    const lines = text.split(/\r\n|\n|\r/);
    const mask = fenceMask(lines);
    return lines.filter((_, index) => mask[index] === true);
  };
  expect(fencedLines(after)).toEqual(fencedLines(before));
}

// ---------------------------------------------------------------------------
// The three plans
// ---------------------------------------------------------------------------

const README_PLAN = [
  "1. Find all API endpoints in the codebase",
  "2. Add rate limiting middleware to each endpoint",
  "3. Write integration tests for rate limiting",
  "4. Design a token bucket algorithm for advanced rate limiting",
  "",
].join("\n");

/** An excerpt of this plan's own §3 (Phase 2.2): tags in inline code, a QA bullet, paragraphs and headings between the steps. */
const SECTION_PLAN = [
  "#### Phase 2.2 — Dispatch-time routing on v2 (M7) `[tier:heavy]` hook design + `[tier:medium]` implementation",
  "",
  "**Goal.** `shadow`, `advise`, `enforce` live in `execute.before` and the context hook; `[route …]` parsed and stripped.",
  "",
  "**Tasks.**",
  "- 2.2.1 `[tier:heavy]` Design `src\\routing\\wire\\dispatch.ts`: `routeDispatch(event, cfg, store, catalog)` composing M2 → ladders → M4; ordering relative to the existing `subagentTiers` override.",
  "- 2.2.2 `[tier:medium]` Implement `dispatch.ts`, `hint.ts`; wire in `v2-hooks.ts` `execute.before` and the context hook.",
  "- 2.2.3 `[tier:medium]` Protocol text for `advise`/`enforce`: one paragraph instructing the orchestrator to add the `[route …]` line (D13).",
  "- 2.2.4 `[tier:medium]` Decision log rows per §0.11 \"What is measured\".",
  "- QA `[tier:heavy]` adversarial review of the phase diff.",
  "",
  "**Tests (`test\\integration\\routing-dispatch.test.ts`).** Fake v2 ctx: `static` → input untouched, no log.",
  "",
  "**Acceptance criteria.** All four modes behave as specified.",
  "",
  "#### Checkpoint DF2 — after Phase 2.2 is merged (orchestrator only)",
  "",
  "Sync `master` ← `car/main`; liveness probe; set `routing.engine: shadow`.",
  "",
].join("\n");

/** No `[acceptance]` blocks; fenced blocks that look like plans, a nested fence, a QA step, an existing tag and CRLF-free text. */
const FENCED_PLAN = [
  "# Release plan",
  "",
  "1. Audit the config loader for security issues",
  "   ```ts",
  "   // 1. fake step inside a fence",
  "   - not a step",
  "   [tier:fast] not a tag, [route class=search] not a route line",
  "   ```",
  "2. Update the changelog",
  "   - nested bullet detail",
  "3. Run QA on the release branch",
  "4. [tier:medium] Refactor the helper",
  "   ````markdown",
  "   ```bash",
  "   npm test",
  "   ```",
  "   ````",
  "",
  "Notes after the list stay untouched.",
  "",
].join("\n");

describe("/annotate-plan: annotating plans (F3, A26)", () => {
  it("README example: every step gets a tier and a route line, additive, and the design step is tagged heavy and pinned", async () => {
    const { deps, calls } = makeDeps();
    const result = await annotatePlanText(README_PLAN, deps);
    expect(calls()).toBe(1); // one batched classification for the whole plan
    expectAdditive(README_PLAN, result.text);
    // The rules decide the class of each step; `other` (no rule above the confidence threshold) maps to the config's default tier.
    expect(result.steps.map((s) => [s.facts.class, s.tier, s.pin])).toMatchInlineSnapshot(`
      [
        [
          "implement",
          "medium",
          false,
        ],
        [
          "implement",
          "medium",
          false,
        ],
        [
          "implement",
          "medium",
          false,
        ],
        [
          "design",
          "heavy",
          true,
        ],
      ]
    `);
    expect(result.steps[3]).toMatchObject({ tier: "heavy", pin: true }); // the design step: heavy, therefore pinned (A26)
    expect(result.steps.filter((s) => s.tier === "heavy").every((s) => s.pin)).toBe(true);
    expect(result.pinnedCount).toBe(1);
    expect(result.text).toMatchInlineSnapshot(`
      "1. [tier:medium] Find all API endpoints in the codebase
      [route class=implement risk=medium scope=multi needs=edit d=none]
      2. [tier:medium] Add rate limiting middleware to each endpoint
      [route class=implement risk=medium scope=multi needs=edit d=none]
      3. [tier:medium] Write integration tests for rate limiting
      [route class=implement risk=medium scope=multi needs=edit d=none]
      4. [tier:heavy] Design a token bucket algorithm for advanced rate limiting
      [route class=design risk=high scope=multi d=none pin]
      "
    `);
    expect(result.text.split("\n").filter((l) => ROUTE_LINE_RE.test(l))).toHaveLength(4);
  });

  it("this plan's §3 excerpt: the heavy and QA steps are pinned, headings and paragraphs are untouched, nothing is lost", async () => {
    const { deps, calls } = makeDeps();
    const result = await annotatePlanText(SECTION_PLAN, deps);
    expect(calls()).toBe(1);
    expectAdditive(SECTION_PLAN, result.text);
    expect(result.placed.map((s) => s.line)).toEqual([6, 7, 8, 9, 10]); // the five bullets; headings, **Tasks.**, **Tests**, … are not steps
    const byLine = new Map(result.steps.map((s, i) => [result.placed[i]!.line, s]));
    expect(byLine.get(6)?.pin).toBe(true); // 2.2.1 names heavy (design)
    expect(byLine.get(10)?.tier).toBe("heavy"); // the QA step
    expect(byLine.get(10)?.pin).toBe(true);
    expect(result.steps.filter((s) => s.tier === "heavy").every((s) => s.pin)).toBe(true); // A26: every final heavy step is pinned
    expect(result.pinnedCount).toBe(result.steps.filter((s) => s.pin && s.changed).length);
    expect(result.text).toMatchInlineSnapshot(`
      "#### Phase 2.2 — Dispatch-time routing on v2 (M7) \`[tier:heavy]\` hook design + \`[tier:medium]\` implementation

      **Goal.** \`shadow\`, \`advise\`, \`enforce\` live in \`execute.before\` and the context hook; \`[route …]\` parsed and stripped.

      **Tasks.**
      - [tier:heavy] 2.2.1 \`[tier:heavy]\` Design \`src\\routing\\wire\\dispatch.ts\`: \`routeDispatch(event, cfg, store, catalog)\` composing M2 → ladders → M4; ordering relative to the existing \`subagentTiers\` override.
      [route class=design risk=high scope=multi d=none pin]
      - [tier:medium] 2.2.2 \`[tier:medium]\` Implement \`dispatch.ts\`, \`hint.ts\`; wire in \`v2-hooks.ts\` \`execute.before\` and the context hook.
      [route class=implement risk=medium scope=multi needs=edit d=none]
      - [tier:medium] 2.2.3 \`[tier:medium]\` Protocol text for \`advise\`/\`enforce\`: one paragraph instructing the orchestrator to add the \`[route …]\` line (D13).
      [route class=other risk=medium scope=multi needs=edit d=none]
      - [tier:medium] 2.2.4 \`[tier:medium]\` Decision log rows per §0.11 "What is measured".
      [route class=other risk=medium scope=multi d=none]
      - [tier:heavy] QA \`[tier:heavy]\` adversarial review of the phase diff.
      [route class=review risk=medium scope=multi d=none pin]

      **Tests (\`test\\integration\\routing-dispatch.test.ts\`).** Fake v2 ctx: \`static\` → input untouched, no log.

      **Acceptance criteria.** All four modes behave as specified.

      #### Checkpoint DF2 — after Phase 2.2 is merged (orchestrator only)

      Sync \`master\` ← \`car/main\`; liveness probe; set \`routing.engine: shadow\`.
      "
    `);
  });

  it("a plan without [acceptance] blocks and with fenced and nested code: fences are never read or written, existing tags are kept", async () => {
    const { deps } = makeDeps();
    const result = await annotatePlanText(FENCED_PLAN, deps);
    expect(result.placed.map((s) => s.line)).toEqual([3, 9, 11, 12]);
    expectAdditive(FENCED_PLAN, result.text);
    expectFencesUntouched(FENCED_PLAN, result.text);
    const [audit, changelog, qa, refactor] = result.steps;
    expect(qa?.tier).toBe("heavy");
    expect(qa?.pin).toBe(true);
    expect(refactor?.tierSource).toBe("existing");
    expect(refactor?.tier).toBe("medium");
    expect(result.text).toContain("4. [tier:medium] Refactor the helper"); // the existing tag, verbatim, not duplicated
    expect(result.text.match(/\[tier:medium\]/g)).toHaveLength(1 + result.steps.filter((s) => s.tier === "medium" && s.tierSource === "engine").length);
    expect(audit?.tierSource).toBe("engine"); // `[tier:fast]` inside the fence was not a tag
    expect(changelog).toBeDefined();
    expect(result.text).toContain("Notes after the list stay untouched.");
    expect(result.text).toMatchInlineSnapshot(`
      "# Release plan

      1. [tier:heavy] Audit the config loader for security issues
      [route class=design risk=high scope=multi d=none pin]
         \`\`\`ts
         // 1. fake step inside a fence
         - not a step
         [tier:fast] not a tag, [route class=search] not a route line
         \`\`\`
      2. [tier:medium] Update the changelog
      [route class=other risk=medium scope=multi needs=edit d=none]
         - nested bullet detail
      3. [tier:heavy] Run QA on the release branch
      [route class=review risk=high scope=multi d=none pin]
      4. [tier:medium] Refactor the helper
      [route class=implement risk=medium scope=multi needs=shell,edit d=none]
         \`\`\`\`markdown
         \`\`\`bash
         npm test
         \`\`\`
         \`\`\`\`

      Notes after the list stay untouched.
      "
    `);
  });

  it("is idempotent: annotating an annotated plan changes nothing and pins nothing new", async () => {
    for (const plan of [README_PLAN, SECTION_PLAN, FENCED_PLAN]) {
      const first = await annotatePlanText(plan, makeDeps().deps);
      const second = await annotatePlanText(first.text, makeDeps().deps);
      expect(second.text).toBe(first.text);
      expect(second.pinnedCount).toBe(0);
      expect(second.steps.every((s) => !s.changed)).toBe(true);
    }
  });

  it("adds ` pin` to an existing route line of a heavy step and reports it, leaving the rest of the line alone", async () => {
    const plan = "1. [tier:heavy] Redesign the storage layer\n   [route class=design risk=high scope=repo d=none]\n";
    const result = await annotatePlanText(plan, makeDeps().deps);
    expect(result.text).toBe("1. [tier:heavy] Redesign the storage layer\n   [route class=design risk=high scope=repo d=none pin]\n");
    expect(result.steps[0]).toMatchObject({ routeEdited: true, pin: true, routeSource: "existing" });
    expect(result.pinnedCount).toBe(1);
  });

  it("handles CRLF plans without mixing line endings, and an empty or step-less text", async () => {
    const crlf = README_PLAN.replace(/\n/g, "\r\n");
    const result = await annotatePlanText(crlf, makeDeps().deps);
    expect(result.text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/); // only CRLF terminators
    expect(result.text.split("\r\n").filter((l) => ROUTE_LINE_RE.test(l))).toHaveLength(4);
    expectAdditive(crlf, result.text);
    for (const text of ["", "just a paragraph\n\nanother one\n", "# Title only\n"]) {
      const out = await annotatePlanText(text, makeDeps().deps);
      expect(out.text).toBe(text);
      expect(out.steps).toEqual([]);
    }
  });

  it("a classifier backend that fails leaves the rules' facts, and the batch is still one call", async () => {
    const failing: ClassifierBackend = {
      id: "host",
      classify: async () => { throw new Error("backend down"); },
      classifyMany: async () => { throw new Error("backend down"); },
    };
    const { deps, calls } = makeDeps({ backend: failing, settings: { ...RULES, backend: "host" as const, model: "opencode-go/deepseek-v4.1-flash" } });
    const plain = await annotatePlanText(README_PLAN, makeDeps().deps);
    const result = await annotatePlanText(README_PLAN, deps);
    expect(calls()).toBe(1);
    expect(result.text).toBe(plain.text); // identical to the rules-only annotation
    expect(result.steps.every((s) => s.facts.source === "rules" || s.facts.source === "unknown")).toBe(true);
  });

  it("a classifyMany that throws leaves every step at the static tier of its class (never an exception)", async () => {
    const deps: AnnotateDeps = { cfg, routing, agents: AGENTS, store: null, classifyMany: async () => { throw new Error("boom"); } };
    const result = await annotatePlanText(README_PLAN, deps);
    expect(result.steps).toHaveLength(4);
    expectAdditive(README_PLAN, result.text);
  });
});

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

describe("splitPlan", () => {
  const lines = (text: string): number[] => splitPlan(text).map((s) => s.line);

  it("takes top-level bullets and numbered items, with nested items, continuation lines and indented blocks inside their step", () => {
    const text = ["- one", "  continuation", "  - nested", "- two", "", "  after a blank, indented: still two", "", "Paragraph ends the list", "- three"].join("\n");
    expect(lines(text)).toEqual([1, 4, 9]);
    expect(splitPlan(text)[1]!.text).toBe("- two\n\n  after a blank, indented: still two\n"); // a step ends with its last line's terminator
    expect(lines("1. a\n2) b\n3. c\n   - nested\n* d\n+ e")).toEqual([1, 2, 3, 5, 6]);
    // CommonMark: the content of `10. c` starts at column 4, so a bullet indented 3 is a sibling, not a child
    expect(lines("10. c\n   - sibling\n    - child")).toEqual([1, 2]);
  });

  it("never starts a step from a heading, a thematic break, indented code, a table or a fenced block", () => {
    const text = ["# Title", "---", "- - -", "***", "    - indented code", "| a | b |", "```", "- in a fence", "1. also", "```", "~~~", "- tilde", "~~~", "- real"].join("\n");
    expect(lines(text)).toEqual([14]);
  });

  it("keeps a fenced block with the step it sits in (nested fences of the other kind included) and stops at an unindented one after a blank", () => {
    const joined = ["1. step", "   ```", "   - x", "   ```", "2. next"].join("\n");
    expect(splitPlan(joined)[0]!.text).toBe("1. step\n   ```\n   - x\n   ```\n");
    const nested = ["- step", "  ````md", "  ```", "  - y", "  ```", "  ````", "- next"].join("\n");
    expect(lines(nested)).toEqual([1, 7]);
    expect(splitPlan(nested)[0]!.text.endsWith("  ````\n")).toBe(true);
    const detached = ["- step", "", "```", "- z", "```", "- next"].join("\n");
    expect(splitPlan(detached).map((s) => s.text)).toEqual(["- step\n", "- next"]);
    expect(lines("- unclosed\n```\n- never a step\n")).toEqual([1]);
  });

  it("attaches an [acceptance] block to the step before it, also after a blank line, and never starts a step inside it", () => {
    const text = ["1. build it", "", "[acceptance]", "- check: testsPass", "criteria: it works", "[/acceptance]", "2. ship it"].join("\n");
    const steps = splitPlan(text);
    expect(steps.map((s) => s.line)).toEqual([1, 7]);
    expect(steps[0]!.text).toBe("1. build it\n\n[acceptance]\n- check: testsPass\ncriteria: it works\n[/acceptance]\n");
  });

  it("falls back to Step/Task/Phase headings only when the plan has no list at all", () => {
    const text = ["# Plan", "## Background", "words", "## Step 1: find", "look around", "", "### Task 2 — change", "edit", "```", "## Step 3 in a fence", "```", "## Notes", "more words"].join("\n");
    const steps = splitPlan(text);
    expect(steps.map((s) => s.line)).toEqual([4, 7]);
    expect(steps[1]!.text).toBe("### Task 2 — change\nedit\n```\n## Step 3 in a fence\n```\n");
    expect(lines("## Step 1\n- a list item wins\n")).toEqual([2]);
  });

  it("covers character ranges that can be replaced independently, for LF and CRLF", () => {
    const text = "- a\r\n- b\r\n\r\ntext\r\n- c";
    const steps = splitPlan(text);
    expect(steps.map((s) => text.slice(s.from, s.to))).toEqual(["- a\r\n", "- b\r\n", "- c"]); // each step carries its own terminator
    expect(steps.map((s) => s.id)).toEqual(["L1", "L2", "L5"]);
  });

  it("every step's route-line and tier scan sees only its own text (no route line is ever produced inside a fence)", async () => {
    const plan = ["1. do a thing", "   ```text", "   [route class=debug]", "   ```", "2. then another"].join("\n");
    const result = await annotatePlanText(plan, makeDeps().deps);
    expectFencesUntouched(plan, result.text);
    expect(parseRouteLine(result.text, { positions: "any" }).count).toBe(2); // the two it added; the one in the fence does not count
  });
});

// ---------------------------------------------------------------------------
// Locating the plan, agents, rendering
// ---------------------------------------------------------------------------

describe("locatePlan, agentInfosForPlan, renderDirectives", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "annotate-locate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the named file (quotes stripped; relative to the project), else PLAN.md, plan.md, then the newest *plan*.md", async () => {
    expect(await locatePlan("", [dir])).toBeNull(); // nothing there yet
    writeFileSync(join(dir, "my plan.md"), "- a\n");
    expect((await locatePlan('"my plan.md"', [dir]))?.path).toBe(join(dir, "my plan.md"));
    expect((await locatePlan(join(dir, "my plan.md"), ["/nowhere"]))?.text).toBe("- a\n");
    expect(await locatePlan("missing.md", [dir])).toBeNull();
    writeFileSync(join(dir, "old-plan.md"), "old");
    writeFileSync(join(dir, "notes.md"), "no");
    const stat = await import("node:fs/promises");
    await stat.utimes(join(dir, "old-plan.md"), new Date("2020-01-01"), new Date("2020-01-01"));
    expect((await locatePlan("", [dir]))?.path).toBe(join(dir, "my plan.md")); // newest
    writeFileSync(join(dir, "plan.md"), "lower");
    // PLAN.md is tried first; on a case-insensitive disk it names the same file, hence the case-folded comparison
    expect((await locatePlan("", [dir]))?.path.toLowerCase()).toBe(join(dir, "plan.md").toLowerCase());
    writeFileSync(join(dir, "PLAN.md"), "upper");
    expect((await locatePlan("", [dir]))?.text).toBe("upper"); // PLAN.md wins (and on a case-insensitive disk it is the same file, rewritten)
  });

  it("refuses a directory and a file that is too large, and searches the directories in order", async () => {
    mkdirSync(join(dir, "folder.md"));
    expect(await locatePlan("folder.md", [dir])).toBeNull();
    writeFileSync(join(dir, "huge.md"), "x".repeat(1_048_577));
    expect(await locatePlan("huge.md", [dir])).toBeNull();
    const other = mkdtempSync(join(tmpdir(), "annotate-locate2-"));
    try {
      writeFileSync(join(other, "p.md"), "- z");
      expect((await locatePlan("p.md", [dir, other]))?.path).toBe(join(other, "p.md"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("agentInfosForPlan makes every listed agent dispatchable and reads grants from its own rules", () => {
    const infos = agentInfosForPlan([
      { id: "explore", mode: "subagent", model: { providerID: "anthropic", id: "claude-haiku-4-5" }, permissions: [{ action: "grep", resource: "*", effect: "allow" }] },
      { id: "build", mode: "primary", hidden: false },
      { mode: "subagent" },
      7,
    ]);
    expect(infos.map((i) => [i.id, i.mode, i.permitted, i.model ?? null])).toEqual([
      ["explore", "subagent", true, "anthropic/claude-haiku-4-5"],
      ["build", "primary", true, null],
    ]);
  });

  it("renderDirectives lists only what has to be added, with the tier, the route line, the facts source and the classification report", async () => {
    const result = await annotatePlanText(FENCED_PLAN, makeDeps().deps);
    const text = renderDirectives(result, { path: "/p/plan.md", engine: "shadow", classification: { backend: "host", statuses: { ok: 3, timeout: 1 }, latencyMs: 812, error: "timed out" } });
    expect(text).toContain("## Router route lines (model-router, engine=shadow)");
    expect(text).toContain("4 steps found");
    expect(text).toContain("Classification: backend=host; sources: ");
    expect(text).toContain("backend outcomes: ok 3, timeout 1; backend latency 812 ms; first error: timed out");
    expect(text).toContain("never write a `[route …]` line inside a fenced code block");
    // each instruction is complete and quoted: the line to write, the anchor to write it at, and "outside any code fence"
    expect(text).toContain('- line 11 "3. Run QA on the release branch": rewrite line 11 as "3. [tier:heavy] Run QA on the release branch"; insert directly below line 11 (outside any code fence) the line "[route class=review risk=high scope=multi d=none pin]" [facts source: rules]');
    expect(text).toContain('- line 12 "4. [tier:medium] Refactor the helper": insert directly below line 12 (outside any code fence) the line "[route class=implement risk=medium scope=multi needs=shell,edit d=none]" [facts source: rules]');
    expect(text).not.toContain("rewrite line 12"); // already tagged: no tag instruction
    const annotatedAgain = await annotatePlanText(result.text, makeDeps().deps);
    expect(renderDirectives(annotatedAgain, { path: "p", engine: "shadow", classification: { backend: "rules", statuses: {}, latencyMs: null, error: null } })).toContain("add nothing");
  });
});

// ---------------------------------------------------------------------------
// The directives are the annotation (QA-2.4-4)
// ---------------------------------------------------------------------------

/**
 * The model's side, written independently of `applyAdditions`: read the message part's instructions and carry them out literally on the
 * original plan (bottom to top, so line numbers stay valid), the way the part tells the model to.
 */
function carryOut(plan: string, directives: string): { text: string; anchors: Array<{ line: number; quoted: string }> } {
  const lines = plan.split(/\r\n|\n|\r/);
  const eol = /\r\n|\n|\r/.exec(plan)?.[0] ?? "\n";
  const str = '"((?:[^"\\\\]|\\\\.)*)"';
  const anchors: Array<{ line: number; quoted: string }> = [];
  type Op = { at: number; apply: () => void };
  const ops: Op[] = [];
  for (const entry of directives.split("\n").filter((l) => l.startsWith("- line "))) {
    const head = new RegExp(`^- line (\\d+) ${str}: `).exec(entry)!;
    const line = Number(head[1]);
    const quoted = JSON.parse(`"${head[2]}"`) as string;
    anchors.push({ line, quoted });
    for (const m of entry.matchAll(new RegExp(`rewrite line (\\d+) as ${str}`, "g"))) {
      ops.push({ at: Number(m[1]), apply: () => { lines[Number(m[1]) - 1] = JSON.parse(`"${m[2]}"`) as string; } });
    }
    for (const m of entry.matchAll(new RegExp(`replace line (\\d+) \\(was ${str}\\) with ${str}`, "g"))) {
      ops.push({ at: Number(m[1]), apply: () => { lines[Number(m[1]) - 1] = JSON.parse(`"${m[3]}"`) as string; } });
    }
    for (const m of entry.matchAll(new RegExp(`insert directly below line (\\d+) \\(outside any code fence\\) the line ${str}`, "g"))) {
      ops.push({ at: Number(m[1]) + 0.5, apply: () => { lines.splice(Number(m[1]), 0, JSON.parse(`"${m[2]}"`) as string); } });
    }
  }
  // rewrites and replacements first (they do not move lines), then insertions from the bottom up
  for (const op of ops.filter((o) => Number.isInteger(o.at))) op.apply();
  for (const op of ops.filter((o) => !Number.isInteger(o.at)).sort((a, b) => b.at - a.at)) op.apply();
  return { text: lines.join(eol), anchors };
}

describe("the directives reproduce the annotated text, anchored outside fences (QA-2.4-4)", () => {
  const plans: Array<[string, string]> = [
    ["README example", README_PLAN.trimEnd()],
    ["this plan's §3 excerpt", SECTION_PLAN.trimEnd()],
    ["fenced and nested code", FENCED_PLAN.trimEnd()],
    ["CRLF", FENCED_PLAN.trimEnd().replace(/\n/g, "\r\n")],
    ["a step on the last line, no final newline", "1. one\n2. two"],
    ["checkboxes, headings as steps, tilde fences", ["- [ ] Fix the parser", "  ~~~sh", "  - not a step", "  ~~~", "* Run QA on the build", "  1) nested item"].join("\n")],
  ];

  it.each(plans)("%s: carrying the instructions out literally gives exactly the annotated text", async (_name, plan) => {
    const result = await annotatePlanText(plan, makeDeps().deps);
    const text = renderDirectives(result, { path: "p.md", engine: "shadow", classification: { backend: "rules", statuses: {}, latencyMs: null, error: null } });
    const { text: done, anchors } = carryOut(plan, text);
    expect(done).toBe(result.text);
    expect(done).toBe(applyAdditions(plan, result.additions));
    const original = plan.split(/\r\n|\n|\r/);
    const fenced = fenceMask(original);
    for (const { line, quoted } of anchors) {
      expect(original[line - 1], `anchor of line ${line}`).toBe(quoted); // the quoted text is the line as it is in the file
      expect(fenced[line - 1], `line ${line} is inside a fence`).not.toBe(true); // so is nothing inserted below it
    }
    expectFencesUntouched(plan, done);
  });

  it("the anchors of the nested-fence fixture are the step lines and never a line inside a block", async () => {
    const result = await annotatePlanText(FENCED_PLAN, makeDeps().deps);
    expect(result.additions.map((a) => a.line)).toEqual([3, 9, 11, 12]);
    expect(result.additions.map((a) => a.anchor)).toEqual(["1. Audit the config loader for security issues", "2. Update the changelog", "3. Run QA on the release branch", "4. [tier:medium] Refactor the helper"]);
    // a route line below a step whose block follows it stays above the block
    const lines = result.text.split("\n");
    expect(lines[3]).toMatch(ROUTE_LINE_RE); // directly below "1. [tier:heavy] Audit …", before its fenced block
    expect(lines[4]).toBe("   ```ts");
  });

  it("withTagAtStart: after a list marker, a checkbox or heading hashes; at the start otherwise; nothing doubled", () => {
    expect(withTagAtStart("1. Find it", "fast")).toBe("1. [tier:fast] Find it");
    expect(withTagAtStart("10) Find it", "fast")).toBe("10) [tier:fast] Find it");
    expect(withTagAtStart("  - Find it", "medium")).toBe("  - [tier:medium] Find it");
    expect(withTagAtStart("* [ ] Find it", "fast")).toBe("* [ ] [tier:fast] Find it");
    expect(withTagAtStart("- [x] Done", "fast")).toBe("- [x] [tier:fast] Done");
    expect(withTagAtStart("### Step 2: go", "heavy")).toBe("### [tier:heavy] Step 2: go");
    expect(withTagAtStart("plain text", "fast")).toBe("[tier:fast] plain text");
    expect(withTagAtStart("  plain text", "fast")).toBe("  [tier:fast] plain text");
    expect(withTagAtStart("- ", "fast")).toBe("- [tier:fast]");
  });

  it("applyAdditions keeps the file's line endings, including for a final line without one, and changes nothing without additions", () => {
    const additions = [{ line: 2, anchor: "- b", tag: { tier: "fast", line: "- [tier:fast] b" }, insertRoute: { indent: "", text: "[route class=search d=none]" }, replaceRoute: null, source: "rules" }];
    expect(applyAdditions("- a\r\n- b", additions)).toBe("- a\r\n- [tier:fast] b\r\n[route class=search d=none]");
    expect(applyAdditions("- a\r\n- b\r\n", additions)).toBe("- a\r\n- [tier:fast] b\r\n[route class=search d=none]\r\n");
    expect(applyAdditions("- a\n- b\n", [])).toBe("- a\n- b\n");
  });
});
// ---------------------------------------------------------------------------
// The command in the plugin
// ---------------------------------------------------------------------------

describe("/annotate-plan in the plugin", () => {
  type Hooks = {
    config(config: Record<string, unknown>): Promise<void>;
    "command.execute.before"(input: unknown, output: { parts: Array<{ type: string; text: string }> }): Promise<void>;
    dispose(): Promise<void>;
  };
  let home: string;
  let store: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Hooks[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "annotate-cmd-"));
    store = join(home, "store");
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    invalidateConfigCache();
  });

  afterEach(async () => {
    for (const hooks of instances.splice(0)) await hooks.dispose();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  const model = (ref: string) => {
    const [providerID, ...rest] = ref.split("/");
    return { providerID, id: rest.join("/"), enabled: true, capabilities: { tools: true }, variants: ["low", "medium", "high", "xhigh"].map((id) => ({ id })), cost: [], limit: { context: 1_000_000, output: 64_000 } };
  };

  async function plugin(over: { routing?: Record<string, unknown> | null; host?: "v1" | "v2"; generate?: { text: ReturnType<typeof vi.fn> } }): Promise<{ hooks: Hooks; agentCalls: () => number }> {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "anthropic", ...(over.routing === null || over.routing === undefined ? {} : { routing: over.routing }) }));
    invalidateConfigCache();
    let agentCalls = 0;
    const ctx = {
      directory: home,
      worktree: home,
      client: {},
      ...((over.host ?? "v2") === "v2"
        ? {
            routerHost: "v2" as const,
            routerAgents: async () => { agentCalls += 1; return ["fast", "medium", "heavy"].map((id) => ({ id, mode: "subagent", hidden: false })); },
            routerCatalog: async () => [model("anthropic/claude-sonnet-5-5"), model("anthropic/claude-opus-5-5"), model("opencode-go/deepseek-v4.1-flash")],
            ...(over.generate === undefined ? {} : { routerGenerate: over.generate }),
          }
        : {}),
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as Hooks;
    instances.push(hooks);
    return { hooks, agentCalls: () => agentCalls };
  }

  const run = async (hooks: Hooks, args: string): Promise<Array<{ type: string; text: string }>> => {
    const out = { parts: [] as Array<{ type: string; text: string }> };
    await hooks["command.execute.before"]({ command: "annotate-plan", arguments: args }, out);
    return out.parts;
  };

  beforeEach(() => {
    writeFileSync(join(home, "PLAN.md"), README_PLAN);
  });

  it("the command template is unchanged: today's text, byte for byte (regression snapshot)", async () => {
    const { hooks } = await plugin({ routing: null });
    const config: { command?: Record<string, { template: string; description: string }> } = {};
    await hooks.config(config);
    const registered = config.command?.["annotate-plan"];
    expect(registered?.description).toBe("Annotate a plan with [tier:fast/medium/heavy] delegation tags");
    expect(registered?.template).toMatchInlineSnapshot(`
      "Annotate the plan with tier directives for model delegation.

      Plan file: "$ARGUMENTS"
      If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.

      ## Available tiers
      - \`[tier:fast]\` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.
      - \`[tier:medium]\` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.
      - \`[tier:heavy]\` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.

      ## Annotation rules
      1. Place \`[tier:X]\` at the START of each step, before the description
      2. Research/exploration -> \`[tier:fast]\` (preferred)
      3. Implementation/code -> \`[tier:medium]\` (preferred)
      4. Architecture/security/hard debugging -> \`[tier:heavy]\`
      5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity
      6. Verification (run tests, build) -> \`[tier:medium]\`
      7. Trivial (single grep or file read) -> \`[tier:fast]\`
      8. Final review of the complete plan -> \`[tier:heavy]\`

      ## Output
      Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.

      ## Acceptance blocks (for enforcement)
      For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can verify the work:
      [acceptance]
      check: <testsPass | buildPasses | lintClean | fileExists path=... | run command="..." expect=...>
      criteria: <plain-language success condition, when no deterministic check applies>
      deliverable: <path or short description>
      [/acceptance]
      Prefer deterministic checks (testsPass/buildPasses/fileExists). testsPass means the tests affected by the producer's changes pass (the full suite is CI's job), so prefer it over a hand-written full-suite run command. Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block."
    `);
  });

  it("with a live engine it adds ONE message part with the route lines of the plan, from one batched classification", async () => {
    const { hooks } = await plugin({ routing: { engine: "shadow", outcomes: { path: store } } });
    const parts = await run(hooks, "PLAN.md");
    expect(parts).toHaveLength(1);
    const text = parts[0]!.text;
    expect(parts[0]!.type).toBe("text");
    expect(text).toContain("## Router route lines (model-router, engine=shadow)");
    expect(text).toContain(`Computed by the router for ${join(home, "PLAN.md")}: 4 steps found, 4 need an addition, 1 pinned by this annotation`);
    expect(text).toContain("Classification: backend=rules");
    expect(text).toContain('- line 4 "4. Design a token bucket algorithm for advanced rate limiting": rewrite line 4 as "4. [tier:heavy] Design a token bucket algorithm for advanced rate limiting"; insert directly below line 4 (outside any code fence) the line "[route class=design risk=high scope=multi d=none pin]" [facts source: rules]');
    // with no argument it finds PLAN.md in the project directory, as the template says
    expect((await run(hooks, ""))[0]?.text).toContain("4 steps found");
  });

  it("static, no routing block, v1, a missing plan and a plan with no steps add nothing and touch nothing", async () => {
    const staticOnly = await plugin({ routing: { engine: "static", outcomes: { path: store } } });
    expect(await run(staticOnly.hooks, "PLAN.md")).toEqual([]);
    expect(staticOnly.agentCalls()).toBe(0); // static: no host call at all
    const none = await plugin({ routing: null });
    expect(await run(none.hooks, "PLAN.md")).toEqual([]);
    expect(none.agentCalls()).toBe(0);
    const v1 = await plugin({ routing: { engine: "shadow" }, host: "v1" });
    expect(await run(v1.hooks, "PLAN.md")).toEqual([]);
    const live = await plugin({ routing: { engine: "shadow", outcomes: { path: store } } });
    expect(await run(live.hooks, "missing.md")).toEqual([]);
    writeFileSync(join(home, "empty.md"), "# nothing to do\n\njust prose\n");
    expect(await run(live.hooks, "empty.md")).toEqual([]);
  });

  it("a failing classifier backend is reported in the part (status and verbatim error) and the plan is annotated by rules", async () => {
    const generate = { text: vi.fn(async () => { throw new Error("Model unavailable: opencode-go/deepseek-v4.1-flash"); }) };
    const { hooks } = await plugin({
      routing: { engine: "shadow", outcomes: { path: store }, classifier: { backend: "host", model: "opencode-go/deepseek-v4.1-flash", timeoutMs: 5000 } },
      generate,
    });
    // a step the rules cannot place with confidence, so the backend is consulted
    writeFileSync(join(home, "PLAN.md"), "1. Do the thing with the widget\n2. Handle the other thing\n");
    const text = (await run(hooks, "PLAN.md"))[0]?.text ?? "";
    expect(text).toContain("Classification: backend=host");
    expect(generate.text).toHaveBeenCalledTimes(1); // one batched call for the whole plan, never one per step
    expect(text).toContain("2 steps found");
    expect(text).toContain("backend outcomes: error");
    expect(text).toContain("first error: ");
    expect(text).toMatch(/\[facts source: rules\]/); // the rules' facts stand when the backend fails
  });
});
