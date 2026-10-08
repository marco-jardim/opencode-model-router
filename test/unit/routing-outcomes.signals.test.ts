// P1.4 (issue #84): outcome signals of role/tier assurance (§2.6, I6, I7), the ingest signal API and role × tier
// statistics. Temp directories only: every outcomes directory is a fresh mkdtemp under the OS temp dir, injected through
// the settings; the real trajectory directory is never touched.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireOutcomes,
  DEFAULT_OUTCOME_TUNING,
  nodePersistDeps,
  type AcquireOutcomesOptions,
  type FlushScheduler,
  type OutcomesBundle,
} from "../../src/routing/outcomes";
import {
  REDISPATCH_WINDOW_MS,
  SAME_TASK_LINE_SHARE,
  SIGNAL_MASS_CAPS,
  SIGNAL_WEIGHTS,
  detectRedispatch,
  graderSignal,
  isSignalObservation,
  parseReturnPrefix,
  returnSignal,
  runSignal,
  sameModel,
  sharedLines,
  signalMass,
  signalRow,
  signedWeight,
  taskSection,
  taskSimilarity,
  tierRank,
  verdictSignal,
  type DispatchText,
  type ReturnSignalInput,
  type RunRecord,
  type SignalObservation,
} from "../../src/routing/outcomes/signals";
import { renderMarkdown, summarize, summarizeRoles } from "../../src/routing/outcomes/stats";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import { parseLogLine } from "../../src/routing/outcomes/persist";
import { createIngest, NOOP_INGEST, resetIngestState, type IngestSettings } from "../../src/routing/outcomes/ingest";
import { rememberDispatch, resetDispatchRegistry, type DispatchInput } from "../../src/router/sessions";
import {
  ANNOTATION_REASON,
  SIGNAL_KINDS,
  SIGNAL_REASON,
  isAnnotationRow,
  makeKey,
  type DecisionRow,
  type LogRow,
  type OutcomeKey,
  type SignalKind,
  type VerdictRow,
} from "../../src/routing/outcomes/types";

const TIERS = ["fast", "medium", "heavy"] as const;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000;

const obs = (kind: SignalKind, outcome: SignalObservation["outcome"], weight: number): SignalObservation => ({ kind, outcome, weight });

// ---------------------------------------------------------------------------
// Return contract
// ---------------------------------------------------------------------------

describe("parseReturnPrefix", () => {
  it("reads the first non-empty line only", () => {
    expect(parseReturnPrefix("\n\n   \nDONE: all green\nNEED MORE: ignored")).toEqual({ prefix: "done", claim: null });
    expect(parseReturnPrefix("Working on it...\nDONE: later line")).toEqual({ prefix: "none", claim: null });
    expect(parseReturnPrefix("NEED MORE: budget\r\nprogress: 3 of 5 files")).toEqual({ prefix: "need-more", claim: "budget" });
  });

  it("tolerates markdown, list markers, emoji, numbering, case and NEED MORE spellings (QA-P14-1-2)", () => {
    for (const text of ["**DONE:** shipped", "> done: shipped", "- DONE: shipped", "* DONE: shipped", "✅ DONE: shipped", "1. DONE: shipped", "### DONE: shipped", "DONE.", "DONE", "DONE!", "Done — shipped", "`DONE`: shipped"]) {
      expect(parseReturnPrefix(text)?.prefix, text).toBe("done");
    }
    expect(parseReturnPrefix("## ESCALATE: authority")).toEqual({ prefix: "escalate", claim: "authority" });
    expect(parseReturnPrefix("`NEED_MORE`: Budget exhausted")).toEqual({ prefix: "need-more", claim: "budget" });
    expect(parseReturnPrefix("2) NEED-MORE: more context")).toEqual({ prefix: "need-more", claim: null });
    expect(parseReturnPrefix("ESCALATE: budget")).toEqual({ prefix: "escalate", claim: "budget" });
  });

  it("unwraps the task tool output: <task_result> and leading task_id lines (QA-P14-1-2)", () => {
    const wrapped = "task_id: ses_abc123 (for resuming to continue this task if needed)\n\n<task_result>\nDONE: shipped\n</task_result>";
    expect(parseReturnPrefix(wrapped)?.prefix).toBe("done");
    expect(parseReturnPrefix("<task_result>\n\nNEED MORE: the schema")?.prefix).toBe("need-more");
    expect(parseReturnPrefix("task_id: ses_1\nDONE: shipped")?.prefix).toBe("done");
    expect(parseReturnPrefix("task_id: ses_1\n")).toBeNull();
    expect(parseReturnPrefix("task_id: ses_1\r\n<task_result>\r\nDONE: shipped\r\n</task_result>\r\n")?.prefix).toBe("done");
  });

  it("unwraps only a LEADING wrapper: a <task_result> mentioned in the body is the child's text (QA-P14-2-4)", () => {
    expect(parseReturnPrefix("DONE: fixed the parser\nIt now handles <task_result> tags in tool output.")?.prefix).toBe("done");
    expect(parseReturnPrefix("I looked at <task_result>\nDONE: x")?.prefix).toBe("none");
    expect(parseReturnPrefix("<task_result>\nDONE: it mentions </task_result> here\nmore\n</task_result>")?.prefix).toBe("done");
  });

  it("DONE never carries a claim; prose is `none`; no text is null", () => {
    expect(parseReturnPrefix("DONE: budget left over")).toEqual({ prefix: "done", claim: null });
    expect(parseReturnPrefix("Done with the first file, moving on")).toEqual({ prefix: "none", claim: null });
    expect(parseReturnPrefix("DONEZO: x")).toEqual({ prefix: "none", claim: null });
    expect(parseReturnPrefix("ESCALATE: authorityish")).toEqual({ prefix: "escalate", claim: null });
    expect(parseReturnPrefix("")).toBeNull();
    expect(parseReturnPrefix("  \n\t\n")).toBeNull();
    expect(parseReturnPrefix(null)).toBeNull();
    expect(parseReturnPrefix(undefined)).toBeNull();
  });
});

describe("returnSignal (I6, I7)", () => {
  const ret = (text: string | undefined, over: Partial<ReturnSignalInput> = {}): ReturnSignalInput => ({
    text,
    budgetExhausted: false,
    authorityRequested: false,
    ...over,
  });
  const incomplete = obs("incomplete", "fail", 0.5);

  it("DONE alone → no signal and no positive mass (I6)", () => {
    expect(returnSignal(ret("DONE: implemented and tested"))).toBeNull();
    expect(returnSignal(ret("DONE: x", { budgetExhausted: "unobserved", authorityRequested: "unobserved" }))).toBeNull();
  });

  it("a return without a contract prefix (progress note, prose, §2.9 E8) or no text → no signal (QA-P14-1-2)", () => {
    expect(returnSignal(ret("I have read the files and will now edit them."))).toBeNull();
    expect(returnSignal(ret("Done with the first file, moving on"))).toBeNull();
    expect(returnSignal(ret(undefined))).toBeNull();
    expect(returnSignal(ret("\n"))).toBeNull();
  });

  it("explicit NEED MORE / ESCALATE with both guards observed false → incomplete, failure 0.5", () => {
    expect(returnSignal(ret("NEED MORE: the schema file"))).toEqual(incomplete);
    expect(returnSignal(ret("ESCALATE: needs a design decision"))).toEqual(incomplete);
    expect(returnSignal(ret("task_id: ses_1\n<task_result>\n- NEED MORE: x\n</task_result>"))).toEqual(incomplete);
  });

  it("the child's own budget/authority claim is no exemption when the guard says otherwise (QA-P14-1-10)", () => {
    expect(returnSignal(ret("NEED MORE: budget"))).toEqual(incomplete);
    expect(returnSignal(ret("ESCALATE: authority"))).toEqual(incomplete);
  });

  it("without guard state an unfinished return is no signal: never a penalty that could be budget or authority (QA-P14-1-10)", () => {
    for (const text of ["NEED MORE: budget", "NEED MORE: the schema", "ESCALATE: authority", "ESCALATE: other"]) {
      expect(returnSignal(ret(text, { budgetExhausted: "unobserved" }))).toBeNull();
      expect(returnSignal(ret(text, { authorityRequested: "unobserved" }))).toBeNull();
    }
  });

  it("NEED MORE after an observed budget exhaustion → budget, no mass (I7), whatever the text says", () => {
    const budget = obs("budget", "none", 0);
    expect(returnSignal(ret("NEED MORE: budget\nprogress summary", { budgetExhausted: true }))).toEqual(budget);
    expect(returnSignal(ret("NEED MORE: still reading", { budgetExhausted: true }))).toEqual(budget);
    expect(returnSignal(ret("DONE: partial", { budgetExhausted: true }))).toEqual(budget);
  });

  it("an observed authority request → authority, never a failure (I7)", () => {
    const authority = obs("authority", "none", 0);
    expect(returnSignal(ret("ESCALATE: authority (edit denied)", { authorityRequested: true }))).toEqual(authority);
    expect(returnSignal(ret("anything", { authorityRequested: true, budgetExhausted: true }))).toEqual(authority);
    expect(signalMass(authority.kind, signedWeight(authority))).toEqual({ positive: 0, negative: 0 });
  });
});

// ---------------------------------------------------------------------------
// Deterministic, grader and run signals
// ---------------------------------------------------------------------------

describe("verdictSignal", () => {
  it("deterministic pass/fail weigh 1; unverifiable is no signal", () => {
    expect(verdictSignal("pass")).toEqual(obs("verdict", "pass", 1));
    expect(verdictSignal("fail")).toEqual(obs("verdict", "fail", 1));
    expect(verdictSignal("unverifiable")).toBeNull();
  });
});

describe("graderSignal", () => {
  const base = { graderTier: "heavy", graderModel: "openai/gpt-5", producerTier: "medium", producerModel: "anthropic/claude-sonnet-5-5" };

  it("an independent grader (tier ≥ producer, another model) weighs 0.5 either way", () => {
    expect(graderSignal({ ...base, outcome: "pass" }, TIERS)).toEqual(obs("grader", "pass", 0.5));
    expect(graderSignal({ ...base, outcome: "fail" }, TIERS)).toEqual(obs("grader", "fail", 0.5));
    expect(graderSignal({ ...base, graderTier: "medium", outcome: "pass" }, TIERS)).toEqual(obs("grader", "pass", 0.5));
  });

  it("a grader on the producer's model is ignored, also through another provider or id spelling (QA-P14-1-4)", () => {
    for (const graderModel of [
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-sonnet-5-5#high",
      "Anthropic/Claude-Sonnet-5-5",
      "openrouter/anthropic/claude-sonnet-5-5",
      "anthropic/claude-sonnet-5.5",
      "amazon-bedrock/anthropic.claude-sonnet-5-5-v1:0",
      "anthropic/claude-sonnet-5-5-20260101",
      // Residual QA-P14-1-4: Vertex ids carry `@<date>`.
      "google-vertex-anthropic/claude-sonnet-5-5@20260101",
      "google-vertex-anthropic/claude-sonnet-5.5@20260101",
    ]) {
      expect(graderSignal({ ...base, graderModel, outcome: "pass" }, TIERS), graderModel).toBeNull();
    }
  });

  it("an ambiguous pair (one id inside the other) is no signal", () => {
    expect(graderSignal({ ...base, graderModel: "openai/gpt-5-mini", producerModel: "openai/gpt-5", outcome: "pass" }, TIERS)).toBeNull();
    expect(sameModel("openai/gpt-5", "openai/gpt-5-mini")).toBe(true);
    expect(sameModel("openai/gpt-5", "anthropic/claude-opus-5")).toBe(false);
    expect(sameModel(null, "openai/gpt-5")).toBe(true);
    expect(sameModel("openai/", "openai/gpt-5")).toBe(true);
  });

  it("a lower-tier, unknown-tier or unknown-model grader is ignored; unverifiable is no signal", () => {
    expect(graderSignal({ ...base, graderTier: "fast", outcome: "pass" }, TIERS)).toBeNull();
    expect(graderSignal({ ...base, graderTier: "ultra", outcome: "pass" }, TIERS)).toBeNull();
    expect(graderSignal({ ...base, producerTier: null, outcome: "pass" }, TIERS)).toBeNull();
    expect(graderSignal({ ...base, graderModel: null, outcome: "pass" }, TIERS)).toBeNull();
    expect(graderSignal({ ...base, producerModel: "  ", outcome: "pass" }, TIERS)).toBeNull();
    expect(graderSignal({ ...base, outcome: "unverifiable" }, TIERS)).toBeNull();
  });

  it("tierRank", () => {
    expect(tierRank("heavy", TIERS)).toBe(2);
    expect(tierRank("nope", TIERS)).toBeNull();
    expect(tierRank(null, TIERS)).toBeNull();
    expect(tierRank(undefined, TIERS)).toBeNull();
  });
});

describe("runSignal", () => {
  const run = (script: string, exitCode: number | null, at: number, sessionID = "c1"): RunRecord => ({ sessionID, script, exitCode, at });
  const input = (runs: RunRecord[], edits: number[] = [T0], acceptance: string[] = ["test"], editsObserved = true) => ({
    childSessionID: "c1",
    runs,
    editsObserved,
    edits,
    acceptance,
  });

  it("router_run exit 0 of the acceptance command started after the last edit → success 1", () => {
    expect(runSignal(input([run("test", 0, T0 + 1)]))).toEqual(obs("run", "pass", 1));
  });

  it("router_run exit 0 before (or at) the last edit is ignored: `at` is the run START", () => {
    expect(runSignal(input([run("test", 0, T0 - 1)], [T0 - 10, T0]))).toBeNull();
    expect(runSignal(input([run("test", 0, T0)], [T0]))).toBeNull();
    expect(runSignal(input([run("test", 0, T0 + 5)], [T0, T0 + 6]))).toBeNull();
  });

  it("the latest post-edit run of each acceptance command decides", () => {
    expect(runSignal(input([run("test", 1, T0 + 1), run("test", 0, T0 + 2)]))).toEqual(obs("run", "pass", 1));
    expect(runSignal(input([run("test", 0, T0 + 1), run("test", 1, T0 + 2)]))).toBeNull();
    expect(runSignal(input([run("test", 0, T0 + 2), run("test", 2, T0 + 2)]))).toBeNull();
    expect(runSignal(input([run("test", 2, T0 + 2), run("test", 0, T0 + 2)]))).toBeNull();
    expect(runSignal(input([run("test", null, T0 + 1)]))).toBeNull();
  });

  it("every acceptance command must have passed; other sessions and scripts do not count", () => {
    const both = ["test", "typecheck", "test"];
    expect(runSignal(input([run("test", 0, T0 + 1)], [T0], both))).toBeNull();
    expect(runSignal(input([run("test", 0, T0 + 1), run("typecheck", 0, T0 + 2)], [T0], both))).toEqual(obs("run", "pass", 1));
    expect(runSignal(input([run("test", 0, T0 + 1, "other")]))).toBeNull();
    expect(runSignal(input([run("lint", 0, T0 + 1)]))).toBeNull();
    expect(runSignal(input([run("test", 0, T0 + 1)], [T0], []))).toBeNull();
  });

  it("observed no edits (a runner) → any acceptance run counts; untracked edits or an unknown edit time → no signal (QA-P14-1-3)", () => {
    expect(runSignal(input([run("test", 0, T0)], []))).toEqual(obs("run", "pass", 1));
    expect(runSignal(input([run("test", 0, T0)], [], ["test"], false))).toBeNull();
    expect(runSignal(input([run("test", 0, T0 + 10)], [Number.NaN]))).toBeNull();
    expect(runSignal(input([run("test", 0, T0 + 10)], [T0, Number.POSITIVE_INFINITY]))).toBeNull();
    expect(runSignal(input([run("test", 0, Number.NaN)], []))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-dispatch
// ---------------------------------------------------------------------------

const BOILERPLATE = [
  "3. TOOLS: read/grep, edit/write, shell. Informational only.",
  "4. MUST DO: run the tests; follow the repository conventions; keep commits small and focused.",
  "5. MUST NOT DO: no new dependencies; never write outside the worktree; no AI attribution.",
  "6. CONTEXT: plan docs/plans/role-tier.md section 2.6; contract commit b5a4e40.",
  "7. ENVIRONMENT: Working directory D:\\git\\omr-rta-p14 (worktree). Platform win32. Shell pwsh 7.",
];

function sevenSection(task: string, expected: string): string {
  return ["[router] You are @medium. Execute this dispatch yourself.", "", `1. TASK: ${task}`, "", `2. EXPECTED OUTCOME: ${expected}`, "", ...BOILERPLATE].join("\n");
}

const PROMPT_A = sevenSection(
  "Fix the off-by-one in src/parser/lexer.ts tokenizer when a comment ends the file.",
  "lexer.ts fixed; a regression test in test/unit/lexer.test.ts; vitest green.",
);
const PROMPT_A_AGAIN = sevenSection(
  "Fix the off-by-one in src/parser/lexer.ts tokenizer when a comment ends the file. The previous attempt left it broken.",
  "lexer.ts fixed; a regression test in test/unit/lexer.test.ts; vitest green.",
);
const PROMPT_B = sevenSection(
  "Document the cache eviction policy of src/cache/lru.ts in docs/CACHE.md with an example.",
  "docs/CACHE.md written; links checked.",
);

function d(id: string, prompt: string, tier: string | null, at: number, over: Partial<DispatchText> = {}): DispatchText {
  return { decisionID: id, parentSessionID: "p1", childSessionID: `c-${id}`, class: "implement", prompt, tier, at, budgetExhausted: false, authorityRequested: false, ...over };
}

describe("taskSection / sharedLines / taskSimilarity", () => {
  it("extracts the TASK section only", () => {
    const text = taskSection(PROMPT_A) ?? "";
    expect(text).toContain("off-by-one");
    expect(text).not.toContain("regression test");
    expect(text).not.toContain("no new dependencies");
    expect(text).not.toContain("[router]");
  });

  it("accepts bold, heading and parenthesised headers; null without a TASK header", () => {
    const md = ["**1. TASK:** do X", "multi-line   task body", "## 2) EXPECTED OUTCOME (strict): Y", "3. REQUIRED TOOLS: read"].join("\n");
    expect(taskSection(md)).toBe(["do X", "multi-line task body"].join("\n"));
    expect(taskSection("2. EXPECTED OUTCOME: only this")).toBeNull();
    expect(taskSection("just a free-form request\nwith two lines")).toBeNull();
  });

  it("sharedLines: normalized lines present in at least two siblings", () => {
    expect(sharedLines(["a  line\nb", "a line\nc", "b\nd"])).toEqual(new Set(["a line", "b"]));
    expect(sharedLines(["only once"])).toEqual(new Set());
  });

  it("taskSimilarity: word-set Dice capped by identifier Dice; dotted identifiers and digits are words (QA-P14-1-1)", () => {
    expect(taskSimilarity("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(taskSimilarity("alpha beta", "alpha beta")).toBe(0);
    expect(taskSimilarity("alpha beta gamma delta", "epsilon zeta eta theta")).toBe(0);
    expect(taskSimilarity("Implement plan step P1.4 of the role tier plan", "Implement plan step P1.5 of the role tier plan")).toBe(0);
    expect(taskSimilarity("Run step 1 of the plan", "Run step 2 of the plan")).toBe(0);
    expect(taskSimilarity("touch signals.ts and stats.ts files", "touch signals stats ts files")).toBeLessThan(0.6);
  });

  it("annotated retries keep their similarity: the identifier cap applies only when both sides have identifiers, as an overlap (QA-P14-2-2)", () => {
    const base = "Fix the flaky retry logic in the network client of the sync service";
    expect(taskSimilarity(base, `${base} (attempt 2)`)).toBeGreaterThanOrEqual(0.6);
    const lexer = "Fix the off-by-one in src/parser/lexer.ts tokenizer when a comment ends the file.";
    expect(taskSimilarity(lexer, `${lexer} Attempt 3: the failure is at lexer.test.ts line 42.`)).toBeGreaterThanOrEqual(0.6);
    expect(taskSimilarity("Implement plan step P1.4 of the role tier plan", "Implement plan step P1.5 of the role tier plan")).toBe(0);
  });
});

describe("detectRedispatch", () => {
  it("the same task re-dispatched to a HIGHER tier within 30 min → failure 0.5 on the previous attempt", () => {
    const prev = d("D1", PROMPT_A, "fast", T0);
    const match = detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + 10 * MIN), [prev], TIERS);
    expect(match?.previous).toBe(prev);
    expect(match?.observation).toEqual(obs("redispatch", "fail", 0.5));
    expect(match?.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it("a different task sharing the 7-section boilerplate → no signal", () => {
    expect(detectRedispatch(d("D2", PROMPT_B, "heavy", T0 + MIN), [d("D1", PROMPT_A, "fast", T0)], TIERS)).toBeNull();
  });

  it("the same EXPECTED OUTCOME template with different short tasks → no signal: TASK alone decides (QA-P14-1-1)", () => {
    const expected = "All edits committed on the branch with a conventional message, the related tests green, typecheck green, no unrelated file touched, a short summary with file:line evidence for every change.";
    const prev = d("D1", sevenSection("Rename parseConfig to loadConfig in src/config.ts.", expected), "fast", T0);
    const cur = d("D2", sevenSection("Bump vitest to 3.2 in package.json.", expected), "medium", T0 + MIN);
    expect(detectRedispatch(cur, [prev], TIERS)).toBeNull();
  });

  it("plan steps P1.4 and P1.5 are different tasks (QA-P14-1-1)", () => {
    const task = (step: string) => sevenSection(`Implement plan step ${step} of the role tier plan in the worktree.`, "Committed and pushed.");
    expect(detectRedispatch(d("D2", task("P1.5"), "heavy", T0 + MIN), [d("D1", task("P1.4"), "fast", T0)], TIERS)).toBeNull();
  });

  it("a template inside TASK is removed when ≥ 2 siblings share it (QA-P14-1-1)", () => {
    const tpl = (specific: string) =>
      [
        "1. TASK: Follow the plan step below exactly and report evidence with file references for every change you make.",
        "Commit each change separately with a conventional commit message and the issue reference in the body.",
        specific,
        "2. EXPECTED OUTCOME: done",
      ].join("\n");
    const s1 = d("S1", tpl("Add a contributing section about release tags."), "fast", T0 - 3 * MIN);
    const s2 = d("S2", tpl("Raise the default timeout of the fetch helper."), "fast", T0 - 2 * MIN);
    const prev = d("P", tpl("Remove the deprecated legacy flag from the command parser."), "fast", T0);
    const cur = d("N", tpl("Rename parseConfig to loadConfig across the config module."), "medium", T0 + MIN);
    expect(detectRedispatch(cur, [s1, s2, prev], TIERS)).toBeNull();
    expect(detectRedispatch(d("N", tpl("Remove the deprecated legacy flag from the command parser, carefully."), "medium", T0 + MIN), [s1, s2, prev], TIERS)?.previous).toBe(prev);
  });

  it("re-dispatch to a lower or the same tier → no signal", () => {
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "fast", T0 + MIN), [d("D1", PROMPT_A, "medium", T0)], TIERS)).toBeNull();
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + MIN), [d("D1", PROMPT_A, "medium", T0)], TIERS)).toBeNull();
  });

  it("window, parent, child, resume, tier, class and role gates", () => {
    const prev = d("D1", PROMPT_A, "fast", T0);
    const cur = (over: Partial<DispatchText> = {}) => d("D2", PROMPT_A_AGAIN, "heavy", T0 + 5 * MIN, over);
    expect(detectRedispatch(cur({ at: T0 + REDISPATCH_WINDOW_MS + 1 }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ at: T0 + REDISPATCH_WINDOW_MS }), [prev], TIERS)).not.toBeNull();
    expect(detectRedispatch(cur({ at: T0 }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ at: Number.NaN }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ parentSessionID: "p2" }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ childSessionID: "c-D1" }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ resume: true }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ tier: null }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur(), [{ ...prev, tier: "ultra" }], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ class: "review" }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ class: null }), [{ ...prev, class: null }], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ role: "implementer" }), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(cur({ role: "implementer" }), [{ ...prev, role: "implementer" }], TIERS)).not.toBeNull();
    expect(detectRedispatch(cur(), [prev, { ...prev }], TIERS, { windowMs: MIN })).toBeNull();
  });

  it("an attempt without a child session cannot be addressed: never a candidate (QA-P14-1-5)", () => {
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + MIN), [d("D1", PROMPT_A, "fast", T0, { childSessionID: null })], TIERS)).toBeNull();
  });

  it("the window runs from the previous attempt's end when known; an attempt still running is not re-dispatched (QA-P14-1-7)", () => {
    const prev = d("D1", PROMPT_A, "fast", T0, { endedAt: T0 + 40 * MIN });
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + 50 * MIN), [prev], TIERS)?.previous).toBe(prev);
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + 20 * MIN), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + 71 * MIN), [prev], TIERS)).toBeNull();
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + 50 * MIN), [{ ...prev, endedAt: Number.NaN }], TIERS)).toBeNull();
  });

  it("an attempt that stopped on budget or authority is never penalised (I7)", () => {
    for (const returned of ["budget", "authority"] as const) {
      expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + MIN), [d("D1", PROMPT_A, "fast", T0, { returned })], TIERS)).toBeNull();
    }
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + MIN), [d("D1", PROMPT_A, "fast", T0, { returned: "incomplete" })], TIERS)).not.toBeNull();
  });

  it("the most recent earlier attempt of the same task decides", () => {
    const a = d("A", PROMPT_A, "fast", T0);
    const b = d("B", PROMPT_A, "fast", T0 + MIN);
    const other = d("X", PROMPT_B, "fast", T0 + 2 * MIN);
    expect(detectRedispatch(d("C", PROMPT_A_AGAIN, "medium", T0 + 3 * MIN), [a, other, b], TIERS)?.previous).toBe(b);
    const m = d("M", PROMPT_A, "medium", T0 + 2 * MIN);
    expect(detectRedispatch(d("C", PROMPT_A_AGAIN, "medium", T0 + 3 * MIN), [a, m], TIERS)).toBeNull();
  });

  const wrap = (body: string) => ["You are a helper subagent.", "Follow the repository conventions strictly.", body, "Report file:line evidence."].join("\n");
  const TASK = "Add retry with exponential backoff to src/net/fetch.ts and cover it with tests.";
  const sibling1 = d("S1", wrap("Rename the logger helper in src/log/index.ts to createLogger everywhere."), "fast", T0 - 3 * MIN);
  const sibling2 = d("S2", wrap("Translate the README introduction to Portuguese keeping the badges."), "fast", T0 - 2 * MIN);

  it("without sections: compares what is left after removing lines shared with ≥ 2 siblings", () => {
    const prev = d("P", wrap(TASK), "fast", T0);
    const same = d("N", wrap(`${TASK} Please.`), "medium", T0 + MIN);
    const different = d("N", wrap("Delete the unused feature flags from src/flags/registry.ts and their docs."), "medium", T0 + MIN);
    expect(detectRedispatch(same, [sibling1, sibling2, prev], TIERS)?.previous).toBe(prev);
    expect(detectRedispatch(different, [sibling1, sibling2, prev], TIERS)).toBeNull();
    expect(detectRedispatch(d("N", PROMPT_A_AGAIN, "medium", T0 + MIN), [d("P", "Fix lexer", "fast", T0)], TIERS)).toBeNull();
  });

  it("third and fourth dispatches of a task still match: earlier attempts are not siblings (QA-P14-1-7)", () => {
    expect(SAME_TASK_LINE_SHARE).toBe(0.8);
    const a1 = d("A1", wrap(TASK), "fast", T0);
    const a2 = d("A2", wrap(`${TASK}\nPrevious attempt left the tests red.`), "fast", T0 + MIN);
    const a3 = d("A3", wrap(`${TASK}\nTwo attempts failed, read the tests first.`), "medium", T0 + 2 * MIN);
    const a4 = d("A4", wrap(`${TASK}\nThird try: the flaky case is the timeout test.`), "heavy", T0 + 3 * MIN);
    expect(detectRedispatch(a3, [sibling1, sibling2, a1, a2], TIERS)?.previous).toBe(a2);
    expect(detectRedispatch(a4, [sibling1, sibling2, a1, a2, a3], TIERS)?.previous).toBe(a3);
  });

  it("a 4-line TASK template with one specific line is learnt from two siblings (QA-P14-2-1)", () => {
    const tpl = (specific: string) =>
      [
        "1. TASK: Follow the plan step below exactly and report evidence with file references for every change you make.",
        "Commit each change separately with a conventional commit message and the issue reference in the body.",
        "Run the related tests and the typecheck before every commit and paste their summary lines.",
        "Never touch files outside the ownership map of the phase and never add dependencies.",
        specific,
        "2. EXPECTED OUTCOME: done",
      ].join("\n");
    const s1 = d("S1", tpl("Add a contributing section about release tags."), "fast", T0 - 3 * MIN);
    const s2 = d("S2", tpl("Raise the default timeout of the fetch helper."), "fast", T0 - 2 * MIN);
    const prev = d("P", tpl("Remove the deprecated legacy flag from the command parser."), "fast", T0);
    expect(detectRedispatch(d("N", tpl("Rename parseConfig to loadConfig across the config module."), "medium", T0 + MIN), [s1, s2, prev], TIERS)).toBeNull();
    expect(detectRedispatch(d("N", tpl("Remove the deprecated legacy flag from the command parser, carefully."), "medium", T0 + MIN), [s1, s2, prev], TIERS)?.previous).toBe(prev);
  });

  it("free-form prompts carrying the router header: the header is learnt from two siblings (QA-P14-2-1)", () => {
    const header = [
      "[router] You are @heavy. Execute this dispatch yourself; do not route it to another tier.",
      "Working directory: D:\\git\\opencode-model-router. You are already there.",
      "Tool names mentioned in this dispatch are descriptive and vary by provider.",
      "An empty result is a result. Search tools honour the ignore file.",
      "Read-only budget: uncapped for this dispatch.",
      "A hand-back with zero tool calls is recorded as a false refusal.",
      "---",
    ];
    const ff = (body: string) => [...header, body].join("\n");
    const s1 = d("S1", ff("Summarize the open issues labelled bug in the tracker and rank them by impact."), "fast", T0 - 3 * MIN);
    const s2 = d("S2", ff("Draft release notes for the next minor version from the merged pull requests."), "fast", T0 - 2 * MIN);
    const prev = d("P", ff("Find every caller of the deprecated cache API and list them with their owners."), "fast", T0);
    expect(detectRedispatch(d("N", ff("Check which workflows still pin the old runner image and propose updates."), "medium", T0 + MIN), [s1, s2, prev], TIERS)).toBeNull();
    expect(detectRedispatch(d("N", ff("Find every caller of the deprecated cache API and list them with their owners. Keep it short."), "medium", T0 + MIN), [s1, s2, prev], TIERS)?.previous).toBe(prev);
  });

  it("an unfinished previous return whose guard state is unknown is never penalised (QA-P14-2-3)", () => {
    const cur = d("D2", PROMPT_A_AGAIN, "medium", T0 + MIN);
    const prev = (over: Partial<DispatchText>) => d("D1", PROMPT_A, "fast", T0, { budgetExhausted: undefined, authorityRequested: undefined, ...over });
    expect(detectRedispatch(cur, [prev({ returnPrefix: "need-more" })], TIERS)).toBeNull();
    expect(detectRedispatch(cur, [prev({ returnPrefix: "escalate", budgetExhausted: "unobserved", authorityRequested: false })], TIERS)).toBeNull();
    expect(detectRedispatch(cur, [prev({})], TIERS)).toBeNull();
    expect(detectRedispatch(cur, [prev({ returnPrefix: "need-more", budgetExhausted: true, authorityRequested: false })], TIERS)).toBeNull();
    expect(detectRedispatch(cur, [prev({ returnPrefix: "done", authorityRequested: true })], TIERS)).toBeNull();
    // Known not to be a budget or authority stop: finished, or both guards observed false.
    expect(detectRedispatch(cur, [prev({ returnPrefix: "done" })], TIERS)).not.toBeNull();
    expect(detectRedispatch(cur, [prev({ returnPrefix: "none" })], TIERS)).not.toBeNull();
    expect(detectRedispatch(cur, [prev({ returnPrefix: "need-more", budgetExhausted: false, authorityRequested: false })], TIERS)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Masses, observations and signal rows
// ---------------------------------------------------------------------------

describe("weights and masses", () => {
  it("the §2.6 table", () => {
    expect(SIGNAL_WEIGHTS).toEqual({ deterministic: 1, run: 1, grader: 0.5, incomplete: 0.5, redispatch: 0.5, recorded: 0 });
    expect(Object.keys(SIGNAL_MASS_CAPS).sort()).toEqual([...SIGNAL_KINDS].sort());
  });

  it("signalMass clamps every row to its kind: no positive mass from self-report (I6), none for budget/authority (I7)", () => {
    expect(signalMass("verdict", 1)).toEqual({ positive: 1, negative: 0 });
    expect(signalMass("verdict", -3)).toEqual({ positive: 0, negative: 1 });
    expect(signalMass("grader", 1)).toEqual({ positive: 0.5, negative: 0 });
    expect(signalMass("run", -1)).toEqual({ positive: 0, negative: 0 });
    expect(signalMass("incomplete", 1)).toEqual({ positive: 0, negative: 0 });
    expect(signalMass("redispatch", -0.5)).toEqual({ positive: 0, negative: 0.5 });
    for (const kind of ["budget", "authority"] as const) {
      expect(signalMass(kind, -1)).toEqual({ positive: 0, negative: 0 });
      expect(signalMass(kind, 1)).toEqual({ positive: 0, negative: 0 });
    }
    expect(signalMass("verdict", undefined)).toEqual({ positive: 0, negative: 0 });
    expect(signalMass("verdict", Number.NaN)).toEqual({ positive: 0, negative: 0 });
    expect(signalMass("verdict", 0)).toEqual({ positive: 0, negative: 0 });
    expect(signalMass("bogus" as SignalKind, 1)).toEqual({ positive: 0, negative: 0 });
  });

  it("signedWeight and isSignalObservation", () => {
    expect(signedWeight(obs("grader", "fail", 0.5))).toBe(-0.5);
    expect(signedWeight(obs("run", "pass", 1))).toBe(1);
    expect(signedWeight(obs("budget", "none", 0))).toBe(0);
    expect(signedWeight(obs("verdict", "pass", 0))).toBe(0);
    expect(isSignalObservation(obs("run", "pass", 1))).toBe(true);
    for (const bad of [null, 3, { kind: "x", outcome: "pass", weight: 1 }, { kind: "run", outcome: "maybe", weight: 1 }, { kind: "run", outcome: "pass", weight: -1 }, { kind: "run", outcome: "pass", weight: Number.POSITIVE_INFINITY }, { kind: "run", outcome: "pass" }]) {
      expect(isSignalObservation(bad)).toBe(false);
    }
  });
});

const R_FAST = makeKey("implement", { origin: "role", id: "implementer" }, "anthropic", "claude-haiku-4-5");
const R_MED = makeKey("implement", { origin: "role", id: "implementer" }, "anthropic", "claude-sonnet-5-5");
const X_KEY = makeKey("search", { origin: "role", id: "explorer" }, "anthropic", "claude-haiku-4-5");
const TIER_KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5");

function choiceOf(key: OutcomeKey, agent: string, origin: "router" | "host" | "role" = "role") {
  const model = key.split("|")[2]?.split("#")[0] ?? "";
  return { key, agent, origin, model, variant: "default" };
}

function row(id: string, ts: string, over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    v: 1,
    kind: "decision",
    ts,
    sessionID: "p1",
    decisionID: id,
    mode: "enforce",
    childSessionID: `c-${id}`,
    facts: { class: "implement", risk: "low", scope: "file", needs: ["edit"], confidence: 0.9, source: "rules" },
    chosen: choiceOf(R_FAST, "implementer"),
    best: choiceOf(R_FAST, "implementer"),
    switched: false,
    pinned: false,
    unit: "ratio",
    costs: { [R_FAST]: 0.3 },
    confidence: 0.8,
    reason: "kept",
    step: "dispatch",
    resume: false,
    role: "implementer",
    tier: "fast",
    ...over,
  };
}

function sig(of: DecisionRow, observation: SignalObservation, ts: string, over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    ...signalRow(
      { ts, sessionID: of.sessionID, decisionID: of.decisionID, mode: of.mode, childSessionID: of.childSessionID, facts: of.facts, chosen: of.chosen, step: of.step },
      observation,
    ),
    ...over,
  };
}

describe("signalRow, isAnnotationRow and parseLogLine", () => {
  it("a signal row is an annotation that round-trips through the log (with its attempt id)", () => {
    const r = signalRow(
      { ts: "2026-10-06T12:00:00.000Z", sessionID: "p1", decisionID: "D1", mode: "shadow", childSessionID: "c1", facts: row("D1", "x").facts, chosen: choiceOf(R_MED, "implementer"), step: "dispatch", attemptID: "c1:0", role: "implementer", tier: "medium" },
      obs("grader", "fail", 0.5),
    );
    expect(r.reason).toBe(`${SIGNAL_REASON}grader:fail`);
    expect(r.reason.startsWith(ANNOTATION_REASON)).toBe(true);
    expect(r).toMatchObject({ signal: "grader", signalWeight: -0.5, attemptID: "c1:0", role: "implementer", tier: "medium", best: null, resume: false, confidence: 0.9 });
    expect(isAnnotationRow(r)).toBe(true);
    expect(parseLogLine(JSON.stringify(r))).toEqual(r);
    const bare = signalRow({ ts: r.ts, sessionID: "p1", decisionID: "D1", mode: "shadow", childSessionID: null, facts: r.facts, chosen: r.chosen, step: "variant" }, obs("budget", "none", 0));
    expect(bare).not.toHaveProperty("role");
    expect(bare).not.toHaveProperty("tier");
    expect(bare).not.toHaveProperty("attemptID");
    expect(bare.signalWeight).toBe(0);
  });

  it("isAnnotationRow keys on the `note:` reason prefix only (QA-P14-1-12)", () => {
    expect(isAnnotationRow(row("D1", "2026-10-06T12:00:00.000Z", { signal: "run" }))).toBe(false);
    expect(isAnnotationRow(row("D1", "2026-10-06T12:00:00.000Z", { reason: `${ANNOTATION_REASON}binding:unknown` }))).toBe(true);
    const verdict: VerdictRow = { v: 1, kind: "verdict", ts: "2026-10-06T12:00:00.000Z", sessionID: "p1", decisionID: "D1", childSessionID: "c1", attemptID: "c1:0", key: R_FAST, verdict: "pass", step: "dispatch" };
    expect(isAnnotationRow(verdict)).toBe(false);
  });

  it("round-trips the eight contract fields of DecisionRow (plus tier, signalWeight, attemptID and a role-origin key)", () => {
    const full = row("D9", "2026-10-06T12:00:00.000Z", {
      chosen: choiceOf(R_MED, "implementer", "role"),
      role: "implementer",
      grant: ["edit", "glob", "grep", "read"],
      boundsReasons: ["lift:authority", "floor:medium"],
      budgetUsed: 37,
      signal: "run",
      explore: true,
      propensity: 0.125,
      binding: "intersection",
      tier: "medium",
      signalWeight: 1,
      attemptID: "c-D9:2",
    });
    const parsed = parseLogLine(JSON.stringify(full));
    expect(parsed).toEqual(full);
    const p = parsed as DecisionRow;
    expect([p.role, p.grant, p.boundsReasons, p.budgetUsed, p.signal, p.explore, p.propensity, p.binding]).toEqual([
      "implementer", ["edit", "glob", "grep", "read"], ["lift:authority", "floor:medium"], 37, "run", true, 0.125, "intersection",
    ]);
    expect(p.chosen.origin).toBe("role");
    for (const kind of SIGNAL_KINDS) expect((parseLogLine(JSON.stringify({ ...full, signal: kind })) as DecisionRow).signal).toBe(kind);
    for (const binding of ["exact", "intersection", "unknown"] as const) {
      expect((parseLogLine(JSON.stringify({ ...full, binding })) as DecisionRow).binding).toBe(binding);
    }
  });

  it("malformed or empty extension fields are dropped, never the row; old rows parse without them (QA-P14-1-13)", () => {
    const bad = { ...row("D9", "2026-10-06T12:00:00.000Z"), role: 7, grant: ["read", 1], boundsReasons: "x", budgetUsed: "37", signal: "bogus", explore: "yes", propensity: Number.NaN, binding: "maybe", tier: 3, signalWeight: "1", attemptID: 4 };
    const parsed = parseLogLine(JSON.stringify(bad)) as DecisionRow;
    expect(parsed).not.toBeNull();
    for (const field of ["role", "grant", "boundsReasons", "budgetUsed", "signal", "explore", "propensity", "binding", "tier", "signalWeight", "attemptID"]) {
      expect(parsed).not.toHaveProperty(field);
    }
    const empty = parseLogLine(JSON.stringify({ ...row("D9", "2026-10-06T12:00:00.000Z"), tier: "", attemptID: "" })) as DecisionRow;
    expect(empty).not.toHaveProperty("tier");
    expect(empty).not.toHaveProperty("attemptID");
    const { role: _role, tier: _tier, ...old } = row("D0", "2026-10-06T12:00:00.000Z", { chosen: choiceOf(TIER_KEY, "medium", "router") });
    const oldParsed = parseLogLine(JSON.stringify(old)) as DecisionRow;
    expect(oldParsed).toEqual(old);
    expect(isAnnotationRow(oldParsed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tier-mode statistics unchanged (golden captured from the base commit 66dcdff, before P1.4)
// ---------------------------------------------------------------------------

const TIER_LOG: LogRow[] = [
{"v":1,"kind":"decision","ts":"2026-10-05T23:00:00.000Z","sessionID":"s1","decisionID":"D0","mode":"shadow","childSessionID":null,"facts":{"class":"implement","risk":"low","scope":"file","needs":["edit"],"confidence":0.9,"source":"rules"},"chosen":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"best":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"switched":false,"pinned":false,"unit":"ratio","costs":{},"confidence":0.8,"reason":"kept","step":"dispatch","resume":false},
{"v":1,"kind":"decision","ts":"2026-10-06T01:00:00.000Z","sessionID":"s1","decisionID":"D1","mode":"shadow","childSessionID":null,"facts":{"class":"implement","risk":"low","scope":"file","needs":["edit"],"confidence":0.9,"source":"rules"},"chosen":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"best":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"switched":false,"pinned":false,"unit":"ratio","costs":{"implement|router:medium|anthropic/claude-sonnet-5-5#default":1,"implement|router:fast|anthropic/claude-haiku-4-5#default":0.4},"confidence":0.8,"reason":"kept:evidence","step":"dispatch","resume":false,"trace":{"routeLines":{"count":1,"conflict":false,"edgeOnly":false},"backend":null,"argmin":{"key":"implement|router:fast|anthropic/claude-haiku-4-5#default","agent":"fast","origin":"router","model":"anthropic/claude-haiku-4-5","variant":"default"}}},
{"v":1,"kind":"decision","ts":"2026-10-06T01:00:00.000Z","sessionID":"s1","decisionID":"D1","mode":"shadow","childSessionID":null,"facts":{"class":"implement","risk":"low","scope":"file","needs":["edit"],"confidence":0.9,"source":"rules"},"chosen":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"best":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"switched":false,"pinned":false,"unit":"ratio","costs":{"implement|router:medium|anthropic/claude-sonnet-5-5#default":1,"implement|router:fast|anthropic/claude-haiku-4-5#default":0.4},"confidence":0.8,"reason":"kept:evidence","step":"dispatch","resume":false},
{"v":1,"kind":"decision","ts":"2026-10-06T02:00:00.000Z","sessionID":"s1","decisionID":"D2","mode":"enforce","childSessionID":null,"facts":{"class":"implement","risk":"medium","scope":"file","needs":["edit"],"confidence":0.9,"source":"rules"},"chosen":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"best":{"key":"implement|router:fast|anthropic/claude-haiku-4-5#default","agent":"fast","origin":"router","model":"anthropic/claude-haiku-4-5","variant":"default"},"switched":true,"pinned":false,"unit":"usd","costs":{"implement|router:medium|anthropic/claude-sonnet-5-5#default":0.6,"implement|router:fast|anthropic/claude-haiku-4-5#default":0.25},"confidence":0.7,"reason":"switch","step":"dispatch","resume":false},
{"v":1,"kind":"decision","ts":"2026-10-06T03:00:00.000Z","sessionID":"s1","decisionID":"D3","mode":"advise","childSessionID":"c-D3","facts":{"class":"search","risk":"low","scope":"repo","needs":[],"confidence":0.95,"source":"rules"},"chosen":{"key":"search|host:explore|anthropic/claude-haiku-4-5#default","agent":"explore","origin":"host","model":"anthropic/claude-haiku-4-5","variant":"default"},"best":{"key":"search|host:explore|anthropic/claude-haiku-4-5#default","agent":"explore","origin":"host","model":"anthropic/claude-haiku-4-5","variant":"default"},"switched":false,"pinned":false,"unit":"ratio","costs":{"search|host:explore|anthropic/claude-haiku-4-5#default":0.2},"confidence":0.9,"reason":"kept:resume","step":"dispatch","resume":true},
{"v":1,"kind":"decision","ts":"2026-10-06T04:00:00.000Z","sessionID":"s1","decisionID":"D4","mode":"enforce","childSessionID":null,"facts":{"class":"implement","risk":"high","scope":"repo","needs":["edit"],"confidence":0.9,"source":"rules"},"chosen":{"key":"implement|router:fast|anthropic/claude-haiku-4-5#default","agent":"fast","origin":"router","model":"anthropic/claude-haiku-4-5","variant":"default"},"best":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"switched":true,"pinned":false,"unit":"usd","costs":{"implement|router:fast|anthropic/claude-haiku-4-5#default":0.2,"implement|router:medium|anthropic/claude-sonnet-5-5#default":0.6},"confidence":0.6,"reason":"lift:floor","step":"dispatch","resume":false},
{"v":1,"kind":"decision","ts":"2026-10-06T05:00:00.000Z","sessionID":"s1","decisionID":"ladder-D5","mode":"enforce","childSessionID":"c-D5","facts":{"class":"implement","risk":"low","scope":"file","needs":["edit"],"confidence":0.9,"source":"rules"},"chosen":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"best":null,"switched":false,"pinned":false,"unit":"ratio","costs":{},"confidence":1,"reason":"ladder","step":"variant","resume":true},
{"v":1,"kind":"decision","ts":"2026-10-06T06:00:00.000Z","sessionID":"s1","decisionID":"D6","mode":"shadow","childSessionID":null,"facts":{"class":"review","risk":"high","scope":"repo","needs":[],"confidence":0.9,"source":"rules"},"chosen":{"key":"search|host:explore|anthropic/claude-haiku-4-5#default","agent":"explore","origin":"host","model":"anthropic/claude-haiku-4-5","variant":"default"},"best":{"key":"search|host:explore|anthropic/claude-haiku-4-5#default","agent":"explore","origin":"host","model":"anthropic/claude-haiku-4-5","variant":"default"},"switched":false,"pinned":true,"unit":"ratio","costs":{},"confidence":0.9,"reason":"pinned","step":"dispatch","resume":false,"detection":{"effective":"none"},"capability":{"pick":2,"dispatched":1}},
{"v":1,"kind":"decision","ts":"2026-10-06T06:30:00.000Z","sessionID":"s1","decisionID":"D7","mode":"enforce","childSessionID":null,"facts":{"class":"review","risk":"high","scope":"repo","needs":[],"confidence":0.9,"source":"rules"},"chosen":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"best":{"key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","agent":"medium","origin":"router","model":"anthropic/claude-sonnet-5-5","variant":"default"},"switched":false,"pinned":false,"unit":"ratio","costs":{"implement|router:medium|anthropic/claude-sonnet-5-5#default":1},"confidence":0.9,"reason":"kept","step":"escalate","resume":false,"detection":{"effective":"none"},"capability":{"pick":1,"dispatched":1}},
{"v":1,"kind":"verdict","ts":"2026-10-06T01:30:00.000Z","sessionID":"s1","decisionID":"D1","childSessionID":"c-D1","attemptID":"c-D1:0","key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","verdict":"pass","step":"dispatch"},
{"v":1,"kind":"verdict","ts":"2026-10-06T01:30:00.000Z","sessionID":"s1","decisionID":"D1","childSessionID":"c-D1","attemptID":"c-D1:0","key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","verdict":"pass","step":"dispatch"},
{"v":1,"kind":"verdict","ts":"2026-10-06T02:30:00.000Z","sessionID":"s1","decisionID":"D2","childSessionID":"c-D2","attemptID":"c-D2:0","key":"implement|router:fast|anthropic/claude-haiku-4-5#default","verdict":"fail","step":"dispatch"},
{"v":1,"kind":"verdict","ts":"2026-10-06T05:10:00.000Z","sessionID":"s1","decisionID":"ladder-D5","childSessionID":"c-D5","attemptID":"c-D5:1","key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","verdict":"unverifiable","step":"variant"},
{"v":1,"kind":"verdict","ts":"2026-10-06T05:20:00.000Z","sessionID":"s1","decisionID":"ladder-D5","childSessionID":"c-D5","attemptID":"c-D5:1","key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","verdict":"pass","step":"variant"},
{"v":1,"kind":"verdict","ts":"2026-10-06T06:10:00.000Z","sessionID":"s1","decisionID":"D6","childSessionID":"c-D6","attemptID":"c-D6:0","key":"search|host:explore|anthropic/claude-haiku-4-5#default","verdict":"pass","step":"dispatch"},
{"v":1,"kind":"refusal","ts":"2026-10-06T06:20:00.000Z","sessionID":"s1","decisionID":"D6","childSessionID":"c-D6","attemptID":"c-D6:0","key":"search|host:explore|anthropic/claude-haiku-4-5#default","step":"dispatch","overrides":"pass"},
{"v":1,"kind":"refusal","ts":"2026-10-06T04:30:00.000Z","sessionID":"s1","decisionID":"D4","childSessionID":"c-D4","attemptID":"c-D4:0","key":"implement|router:medium|anthropic/claude-sonnet-5-5#default","step":"dispatch"}
] as LogRow[];

const GOLDEN_JSON_SHA256 = "e785746dc21086d455bd9e66458c5070ed4d00b0c9165f02b138cb28902ce782";
const GOLDEN_MD_SHA256 = "935fd21b6d1f5cdbff2a8208c0752897a060fba0efb177bc76f101c7e8e323c3";
const WINDOW = { since: Date.parse("2026-10-06T00:00:00.000Z"), until: Date.parse("2026-10-07T00:00:00.000Z") };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("tier-mode statistics unchanged", () => {
  it("summarize/renderMarkdown of a log without role rows equal the pre-P1.4 golden", () => {
    const table = summarize(null, TIER_LOG, WINDOW);
    expect(sha(JSON.stringify(table))).toBe(GOLDEN_JSON_SHA256);
    expect(sha(renderMarkdown(table))).toBe(GOLDEN_MD_SHA256);
    expect(table.dispatches).toBe(5);
  });

  it("annotation rows (signals, bindings) never reach the tier-mode numbers", () => {
    const d1 = TIER_LOG[1] as DecisionRow;
    const d2 = TIER_LOG[3] as DecisionRow;
    const notes: LogRow[] = [
      sig(d1, obs("verdict", "fail", 1), "2026-10-06T01:40:00.000Z"),
      sig(d2, obs("redispatch", "fail", 0.5), "2026-10-06T02:40:00.000Z"),
      sig({ ...d2, decisionID: "never-dispatched" }, obs("run", "pass", 1), "2026-10-06T02:41:00.000Z"),
      { ...d1, decisionID: "binding-only", reason: `${ANNOTATION_REASON}binding:unknown`, binding: "unknown", ts: "2026-10-06T02:42:00.000Z" },
    ];
    const table = summarize(null, [...notes, ...TIER_LOG, ...notes], WINDOW);
    expect(sha(JSON.stringify(table))).toBe(GOLDEN_JSON_SHA256);
    expect(sha(renderMarkdown(table))).toBe(GOLDEN_MD_SHA256);
  });

  it("summarizeRoles of a tier-mode log is empty", () => {
    expect(summarizeRoles(null, TIER_LOG, WINDOW)).toEqual({
      version: 1,
      window: { since: "2026-10-06T00:00:00.000Z", until: "2026-10-07T00:00:00.000Z" },
      byRoleTier: [],
      unattributed: { signals: 0, unknownBindings: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// Role × tier statistics
// ---------------------------------------------------------------------------

describe("summarizeRoles", () => {
  const D1 = row("R1", "2026-10-06T10:00:00.000Z", { costs: { [R_FAST]: 0.3 } });
  const D2 = row("R2", "2026-10-06T10:20:00.000Z", { chosen: choiceOf(R_MED, "implementer"), best: choiceOf(R_MED, "implementer"), tier: "medium", unit: "usd", costs: { [R_MED]: 0.12 } });
  const D3 = row("R3", "2026-10-06T11:00:00.000Z", { explore: true, propensity: 0.1, binding: "unknown", costs: { [R_FAST]: 0.2 } });
  const D4 = row("R4", "2026-10-06T11:30:00.000Z", { role: "explorer", tier: undefined, chosen: choiceOf(X_KEY, "explorer"), best: choiceOf(X_KEY, "explorer"), costs: {} });
  const L1 = row("R1-ladder", "2026-10-06T10:05:00.000Z", { step: "variant" });
  const TIERED = row("T1", "2026-10-06T10:00:00.000Z", { role: undefined, tier: undefined, chosen: choiceOf(TIER_KEY, "medium", "router"), best: choiceOf(TIER_KEY, "medium", "router") });

  function log(): LogRow[] {
    return [
      D1, D2, D3, D4, L1, TIERED,
      sig(D1, obs("incomplete", "fail", 0.5), "2026-10-06T10:10:00.000Z"),
      sig(D1, obs("redispatch", "fail", 0.5), "2026-10-06T10:21:00.000Z"),
      sig(D2, obs("run", "pass", 1), "2026-10-06T10:40:00.000Z"),
      sig(D2, obs("grader", "pass", 0.5), "2026-10-06T10:41:00.000Z"),
      sig(D2, obs("verdict", "fail", 1), "2026-10-06T10:42:00.000Z"),
      // QA-P14-1-8: the dispatch row decides role AND tier; the signal's own role/tier are ignored.
      sig(D2, obs("redispatch", "fail", 0.5), "2026-10-06T10:43:00.000Z", { role: "reviewer", tier: "heavy" }),
      sig(D3, obs("budget", "none", 0), "2026-10-06T11:10:00.000Z"),
      sig(D3, obs("authority", "none", 0), "2026-10-06T11:11:00.000Z"),
      sig(D4, obs("budget", "none", 0), "2026-10-06T11:40:00.000Z"),
      // Forged rows: self-report trying to create positive mass, and a penalty for an authority request (another attempt).
      sig(D3, obs("incomplete", "pass", 1), "2026-10-06T11:12:00.000Z"),
      sig(D3, obs("authority", "fail", 1), "2026-10-06T11:13:00.000Z", { attemptID: "c-R3:1" }),
      // Same attempt and kind again: the first row wins (QA-P14-1-14).
      sig(D3, obs("authority", "fail", 1), "2026-10-06T11:14:00.000Z"),
      // A tier-mode dispatch's signals are unattributed, even when the signal row claims a role; so is a row without
      // any dispatch row and without a role.
      sig(TIERED, obs("verdict", "pass", 1), "2026-10-06T10:30:00.000Z"),
      sig(TIERED, obs("run", "pass", 1), "2026-10-06T10:30:30.000Z", { role: "implementer", tier: "fast" }),
      sig({ ...D1, decisionID: "ghost", role: undefined, chosen: choiceOf(TIER_KEY, "medium", "router") }, obs("run", "pass", 1), "2026-10-06T10:31:00.000Z"),
      // No dispatch row to join: the signal's own role/tier place it.
      sig({ ...D1, decisionID: "ghost-role" }, obs("verdict", "pass", 1), "2026-10-06T10:32:00.000Z", { role: "reviewer", tier: "heavy" }),
      // Unknown bindings: one on the dispatch row (D3), one annotation row attributed by its dispatch, one unattributed.
      { ...D4, reason: `${ANNOTATION_REASON}binding:unknown`, binding: "unknown", ts: "2026-10-06T11:41:00.000Z" },
      { ...D4, decisionID: "nobody", role: undefined, chosen: choiceOf(TIER_KEY, "medium", "router"), reason: `${ANNOTATION_REASON}binding:unknown`, binding: "unknown", ts: "2026-10-06T11:42:00.000Z" },
    ];
  }

  const bucket = (t: ReturnType<typeof summarizeRoles>, role: string, tier: string) => {
    const b = t.byRoleTier.find((r) => r.role === role && r.tier === tier);
    if (b === undefined) throw new Error(`no bucket ${role}/${tier}`);
    return b;
  };
  const kind = (b: ReturnType<typeof bucket>, k: SignalKind) => b.signals.find((s) => s.kind === k);

  it("buckets dispatches, signals, budgets, authority, bindings, exploration and cost units by role × tier", () => {
    const t = summarizeRoles(null, log(), WINDOW);
    expect(t.byRoleTier.map((b) => `${b.role}/${b.tier}`)).toEqual(["explorer/unknown", "implementer/fast", "implementer/medium", "reviewer/heavy"]);

    const fast = bucket(t, "implementer", "fast");
    expect(fast.dispatches).toBe(2); // R1, R3 (the ladder row is an attempt, not a dispatch)
    expect(fast.explored).toBe(1);
    expect(fast.unknownBindings).toBe(1);
    expect(fast.budgetExhaustions).toBe(1);
    expect(fast.authorityRequests).toBe(2);
    expect(kind(fast, "incomplete")).toEqual({ kind: "incomplete", pass: 0, fail: 1, none: 1, positive: 0, negative: 0.5 });
    expect(kind(fast, "redispatch")).toEqual({ kind: "redispatch", pass: 0, fail: 1, none: 0, positive: 0, negative: 0.5 });
    expect(kind(fast, "authority")).toEqual({ kind: "authority", pass: 0, fail: 0, none: 2, positive: 0, negative: 0 });
    expect(fast.positiveMass).toBe(0); // I6: the forged self-report row adds nothing
    expect(fast.negativeMass).toBe(1); // I7: budget/authority add nothing
    expect(fast.costUnits).toEqual([{ unit: "ratio", total: 0.5, rows: 2 }]);
    expect(fast.signals.map((s) => s.kind)).toEqual([...SIGNAL_KINDS]);
    expect(fast.tokensPerDispatch).toBeNull();
    expect(fast.measuredUSD).toBeNull();

    const medium = bucket(t, "implementer", "medium");
    expect(medium.dispatches).toBe(1);
    expect(kind(medium, "run")).toMatchObject({ pass: 1, positive: 1 });
    expect(kind(medium, "grader")).toMatchObject({ pass: 1, positive: 0.5 });
    expect(kind(medium, "verdict")).toMatchObject({ fail: 1, negative: 1 });
    expect(kind(medium, "redispatch")).toMatchObject({ fail: 1, negative: 0.5 });
    expect(medium.positiveMass).toBe(1.5);
    expect(medium.negativeMass).toBe(1.5);
    expect(medium.costUnits).toEqual([{ unit: "usd", total: 0.12, rows: 1 }]);

    const explorer = bucket(t, "explorer", "unknown");
    expect(explorer).toMatchObject({ dispatches: 1, budgetExhaustions: 1, unknownBindings: 1, costUnits: [] });

    expect(bucket(t, "reviewer", "heavy")).toMatchObject({ dispatches: 0, positiveMass: 1, negativeMass: 0 });
    expect(t.unattributed).toEqual({ signals: 3, unknownBindings: 1 });
  });

  it("duplicated rows count once (C7)", () => {
    const rows = log();
    expect(summarizeRoles(null, [...rows, ...rows], WINDOW)).toEqual(summarizeRoles(null, rows, WINDOW));
  });

  it("one signal per attempt and kind, first wins; another attempt id of the same decision is its own (QA-P14-1-14)", () => {
    const at = (m: number) => `2026-10-06T10:${String(m).padStart(2, "0")}:00.000Z`;
    const rows: LogRow[] = [
      D1,
      sig(D1, obs("grader", "pass", 0.5), at(30), { attemptID: "c-R1:0" }),
      sig(D1, obs("grader", "fail", 0.5), at(31), { attemptID: "c-R1:0" }),
      sig(D1, obs("grader", "fail", 0.5), at(32), { attemptID: "c-R1:1" }),
    ];
    expect(kind(bucket(summarizeRoles(null, rows, WINDOW), "implementer", "fast"), "grader")).toEqual({ kind: "grader", pass: 1, fail: 1, none: 0, positive: 0.5, negative: 0.5 });
  });

  it("windows signals by their own ts and joins dispatches outside the window", () => {
    const t = summarizeRoles(null, log(), { since: Date.parse("2026-10-06T10:30:00.000Z"), until: Date.parse("2026-10-06T11:05:00.000Z") });
    const medium = bucket(t, "implementer", "medium");
    expect(medium.dispatches).toBe(0); // R2 dispatched at 10:20
    expect(medium.positiveMass).toBe(1.5); // its signals at 10:40/10:41 still land on implementer/medium
    expect(bucket(t, "implementer", "fast").dispatches).toBe(1); // R3 at 11:00
    expect(summarizeRoles(null, log(), { since: Number.NaN, until: null }).window).toEqual({ since: null, until: null });
    expect(summarizeRoles(null, [{ ...D1, ts: "not a date" }], { since: null, until: null }).byRoleTier).toEqual([]);
  });

  it("tokens and USD per dispatch come from the store, n-weighted over the bucket's keys", () => {
    const store = createOutcomeStore({ now: () => T0 });
    const tokens = (input: number) => ({ input, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    store.recordStep(R_FAST, { attemptID: "a1", cost: 0.02, pricing: "priced", tokens: tokens(1000), final: true });
    store.recordStep(R_FAST, { attemptID: "a2", cost: 0.04, pricing: "priced", tokens: tokens(3000), final: true });
    const t = summarizeRoles(store, log(), WINDOW);
    const fast = bucket(t, "implementer", "fast");
    expect(fast.tokensPerDispatch).toMatchObject({ n: 2, input: 2000, output: 100 });
    expect(fast.measuredUSD?.n).toBe(2);
    expect(fast.measuredUSD?.mean).toBeCloseTo(0.03, 10);
    expect(bucket(t, "implementer", "medium").tokensPerDispatch).toBeNull();
    expect(bucket(t, "implementer", "medium").measuredUSD).toBeNull();
  });

  it("an enforce switch is counted under the dispatched key", () => {
    const switched = row("S1", "2026-10-06T10:00:00.000Z", { switched: true, best: choiceOf(R_MED, "implementer"), costs: { [R_FAST]: 0.3, [R_MED]: 0.1 } });
    expect(bucket(summarizeRoles(null, [switched], WINDOW), "implementer", "fast").costUnits).toEqual([{ unit: "ratio", total: 0.1, rows: 1 }]);
  });

  it("a role dispatch row without `role` is attributed through its role-origin key (QA-P14-2-5)", () => {
    const noRole = row("NR", "2026-10-06T10:00:00.000Z", { role: undefined });
    const routerNoRole = row("RT", "2026-10-06T10:00:00.000Z", { role: undefined, chosen: choiceOf(TIER_KEY, "medium", "router"), best: choiceOf(TIER_KEY, "medium", "router") });
    const t = summarizeRoles(null, [noRole, routerNoRole, sig(noRole, obs("run", "pass", 1), "2026-10-06T10:10:00.000Z"), sig(routerNoRole, obs("run", "pass", 1), "2026-10-06T10:10:00.000Z")], WINDOW);
    expect(bucket(t, "implementer", "fast")).toMatchObject({ dispatches: 1, positiveMass: 1 });
    expect(t.byRoleTier).toHaveLength(1);
    expect(t.unattributed.signals).toBe(1);
  });

  it("a verdict pass later overridden by a false refusal counts as a failure of 1 (residual QA-P14-1-6)", () => {
    const refusal = (attemptID: string, overrides?: "pass"): LogRow => ({
      v: 1, kind: "refusal", ts: "2026-10-07T01:00:00.000Z", sessionID: "p1", decisionID: "R1", childSessionID: "c-R1", attemptID, key: R_FAST, step: "dispatch",
      ...(overrides === undefined ? {} : { overrides }),
    });
    const rows: LogRow[] = [
      D1,
      sig(D1, obs("verdict", "pass", 1), "2026-10-06T10:30:00.000Z", { attemptID: "c-R1:0" }),
      sig(D1, obs("verdict", "pass", 1), "2026-10-06T10:31:00.000Z", { attemptID: "c-R1:1" }),
      sig(D1, obs("verdict", "pass", 1), "2026-10-06T10:32:00.000Z", { attemptID: "c-R1:2" }),
      refusal("c-R1:0", "pass"), // outside the window: converts all the same
      refusal("c-R1:1"), // no override marker: nothing to convert
    ];
    const fast = bucket(summarizeRoles(null, rows, WINDOW), "implementer", "fast");
    expect(kind(fast, "verdict")).toEqual({ kind: "verdict", pass: 2, fail: 1, none: 0, positive: 2, negative: 1 });
  });
});

// ---------------------------------------------------------------------------
// Ingest: the store API (rows only; hook call sites are P2.1's)
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  resetDispatchRegistry();
  resetIngestState();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  resetDispatchRegistry();
  resetIngestState();
});

function ingestHarness(over: Partial<IngestSettings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omr-signals-"));
  dirs.push(dir);
  const warnings: string[] = [];
  const logger = { warn: (message: string) => { warnings.push(message); } };
  const scheduler: FlushScheduler = { setTimer: () => ({}), clearTimer: () => undefined };
  const bundles: OutcomesBundle[] = [];
  const acquire = (options: AcquireOutcomesOptions): OutcomesBundle => {
    const bundle = acquireOutcomes({ ...options, deps: { ...nodePersistDeps(logger), now: () => T0 }, scheduler });
    bundles.push(bundle);
    return bundle;
  };
  let settings: IngestSettings | null = {
    engine: "enforce",
    minClassConfidence: 0.7,
    outcomesDir: dir,
    tuning: DEFAULT_OUTCOME_TUNING,
    routerAgentIds: new Set(["fast", "medium", "heavy"]),
    roleAgentIds: new Set(["implementer"]),
    ...over,
  };
  let throwSettings = false;
  const ingest = createIngest({
    settings: () => {
      if (throwSettings) throw new Error("settings exploded");
      return settings;
    },
    logger,
    now: () => T0,
    acquire,
  });
  cleanups.push(async () => {
    await ingest.dispose();
  });
  return {
    ingest,
    warnings,
    bundles,
    setSettings(next: IngestSettings | null) { settings = next; },
    explode() { throwSettings = true; },
    async rows(): Promise<LogRow[]> {
      const bundle = bundles[0];
      if (bundle === undefined) return [];
      await bundle.flusher.flushNow();
      return (await bundle.persister.readRows()).rows;
    },
  };
}

const FACTS = { class: "implement", risk: "medium", scope: "file", needs: ["edit"], confidence: 0.9, source: "rules" };

function register(child: string, over: Partial<DispatchInput> = {}): void {
  rememberDispatch(child, {
    facts: FACTS,
    agent: "implementer",
    model: "anthropic/claude-haiku-4-5",
    variant: null,
    tier: "fast",
    acceptance: "deterministic",
    parentSessionID: "root",
    decisionID: "dec-1",
    ...over,
  }, T0);
}

const reasonOf = (r: LogRow): string => (r.kind === "verdict" ? `verdict:${r.verdict}` : r.kind === "decision" ? r.reason : r.kind);

describe("ingest.onSignal", () => {
  it("one row per attempt and kind; verdict refused; the store, its Beta and decay untouched (QA-P14-1-6, 1-14)", async () => {
    const h = ingestHarness();
    register("c1");
    expect(h.ingest.onSignal?.("c1", obs("run", "pass", 1))).toBe(true);
    const store = h.bundles[0]!.store;
    const before = { revision: store.revision, snapshot: JSON.stringify(store.snapshot()), posterior: store.posterior(R_FAST) };
    expect(h.ingest.onSignal?.("c1", obs("run", "pass", 1))).toBe(false);
    expect(h.ingest.onSignal?.("c1", obs("grader", "pass", 0.5))).toBe(true);
    expect(h.ingest.onSignal?.("c1", obs("grader", "fail", 0.5))).toBe(false);
    expect(h.ingest.onSignal?.("c1", obs("verdict", "fail", 1))).toBe(false);
    expect(h.ingest.onSignal?.("c1", obs("verdict", "pass", 1))).toBe(false);
    expect(store.revision).toBe(before.revision);
    expect(JSON.stringify(store.snapshot())).toBe(before.snapshot);
    expect(store.posterior(R_FAST)).toEqual(before.posterior);
    expect(store.keys()).toEqual([]);

    const rows = (await h.rows()) as DecisionRow[];
    expect(rows.map(reasonOf)).toEqual(["note:signal:run:pass", "note:signal:grader:pass"]);
    expect(rows[0]).toMatchObject({
      kind: "decision",
      decisionID: "dec-1",
      sessionID: "root",
      childSessionID: "c1",
      mode: "enforce",
      role: "implementer",
      tier: "fast",
      signal: "run",
      signalWeight: 1,
      step: "dispatch",
      attemptID: expect.any(String),
      chosen: { key: R_FAST, agent: "implementer", origin: "role", model: "anthropic/claude-haiku-4-5", variant: "default" },
    });
    expect(rows.every((r) => isAnnotationRow(r))).toBe(true);
  });

  it("a re-dispatch failure needs the previous attempt's decision id, and only that attempt takes it (QA-P14-1-5)", async () => {
    const h = ingestHarness();
    register("c1");
    expect(h.ingest.onSignal?.("c1", obs("redispatch", "fail", 0.5))).toBe(false);
    expect(h.ingest.onSignal?.("c1", obs("redispatch", "fail", 0.5), { expectDecisionID: "dec-other" })).toBe(false);
    // The child was registered again for a new dispatch: the old decision id no longer matches.
    register("c1", { decisionID: "dec-2" });
    expect(h.ingest.onSignal?.("c1", obs("redispatch", "fail", 0.5), { expectDecisionID: "dec-1" })).toBe(false);
    expect(h.ingest.onSignal?.("c1", obs("redispatch", "fail", 0.5), { expectDecisionID: "dec-2" })).toBe(true);
    // Evicted: nothing, and the caller is told.
    expect(h.ingest.onSignal?.("gone", obs("redispatch", "fail", 0.5), { expectDecisionID: "dec-2" })).toBe(false);
    const rows = (await h.rows()) as DecisionRow[];
    expect(rows.map((r) => [r.decisionID, r.reason])).toEqual([["dec-2", "note:signal:redispatch:fail"]]);
  });

  it("onVerdict writes the verdict signal row of a role dispatch only when the store takes the verdict (QA-P14-1-6)", async () => {
    const h = ingestHarness();
    register("c1");
    h.ingest.onVerdict("c1", "unverifiable");
    h.ingest.onVerdict("c1", "fail");
    h.ingest.onVerdict("c1", "pass"); // the store already scored the attempt: no row of either kind
    const rows = await h.rows();
    expect(rows.map(reasonOf)).toEqual(["verdict:unverifiable", "verdict:fail", "note:signal:verdict:fail"]);
    expect((rows[2] as DecisionRow).signalWeight).toBe(-1);
    const roles = summarizeRoles(null, rows, { since: null, until: null });
    expect(roles.unattributed.signals).toBe(0); // dec-1 has no dispatch row here, the signal row's own role places it
    expect(roles.byRoleTier[0]).toMatchObject({ role: "implementer", tier: "fast", negativeMass: 1 });
  });

  it("a pass the store converts on a later false refusal is a failure in the role statistics (residual QA-P14-1-6)", async () => {
    const h = ingestHarness();
    register("c1");
    h.ingest.onVerdict("c1", "pass");
    h.ingest.onFalseRefusal("c1");
    const rows = await h.rows();
    expect(rows.map(reasonOf)).toEqual(["verdict:pass", "note:signal:verdict:pass", "refusal"]);
    const fast = summarizeRoles(null, rows, { since: null, until: null }).byRoleTier[0];
    expect(fast?.signals.find((s) => s.kind === "verdict")).toMatchObject({ pass: 0, fail: 1, positive: 0, negative: 1 });
  });

  it("onVerdict of a tier-mode dispatch writes no signal row", async () => {
    const h = ingestHarness({ roleAgentIds: undefined });
    register("c2", { agent: "medium", model: "anthropic/claude-sonnet-5-5#high", tier: "medium" });
    h.ingest.onVerdict("c2", "pass");
    expect((await h.rows()).map(reasonOf)).toEqual(["verdict:pass"]);
  });

  it("zero-mass kinds are written under class `unknown` when the class is not trusted; others are not (QA-P14-1-9)", async () => {
    const h = ingestHarness();
    register("low", { facts: { ...FACTS, confidence: 0.2 } });
    register("unk", { facts: { ...FACTS, class: "unknown" }, decisionID: "dec-u" });
    expect(h.ingest.onSignal?.("low", obs("incomplete", "fail", 0.5))).toBe(false);
    expect(h.ingest.onSignal?.("low", obs("budget", "none", 0))).toBe(true);
    expect(h.ingest.onSignal?.("unk", obs("authority", "none", 0))).toBe(true);
    const rows = (await h.rows()) as DecisionRow[];
    expect(rows.map((r) => r.chosen.key)).toEqual([
      makeKey("unknown", { origin: "role", id: "implementer" }, "anthropic", "claude-haiku-4-5"),
      makeKey("unknown", { origin: "role", id: "implementer" }, "anthropic", "claude-haiku-4-5"),
    ]);
    expect(h.bundles[0]!.store.keys()).toEqual([]);
  });

  it("a registration without a decision id writes no signal row (QA-P14-1-11)", () => {
    const h = ingestHarness();
    register("c1", { decisionID: null });
    expect(h.ingest.onSignal?.("c1", obs("budget", "none", 0))).toBe(false);
  });

  it("a new attempt of the same child is a new identity", async () => {
    const h = ingestHarness();
    register("c1");
    expect(h.ingest.onSignal?.("c1", obs("incomplete", "fail", 0.5))).toBe(true);
    register("c1");
    expect(h.ingest.onSignal?.("c1", obs("incomplete", "fail", 0.5))).toBe(true);
    const rows = (await h.rows()) as DecisionRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.attemptID).not.toBe(rows[1]?.attemptID);
  });

  it("tier-mode agents keep router keys and carry no role", async () => {
    const h = ingestHarness({ roleAgentIds: undefined });
    register("c1", { agent: "medium", model: "anthropic/claude-sonnet-5-5#high", tier: null });
    expect(h.ingest.onSignal?.("c1", obs("budget", "none", 0))).toBe(true);
    const [r] = (await h.rows()) as DecisionRow[];
    expect(r?.chosen.origin).toBe("router");
    expect(r?.chosen.variant).toBe("high");
    expect(r).not.toHaveProperty("role");
    expect(r).not.toHaveProperty("tier");
    expect(r?.signalWeight).toBe(0);
  });

  it("records nothing for an unregistered or unkeyable child, an invalid observation, or with ingestion off", () => {
    const h = ingestHarness();
    expect(h.ingest.onSignal?.("nobody", obs("run", "pass", 1))).toBe(false);
    register("nomodel", { model: null });
    expect(h.ingest.onSignal?.("nomodel", obs("budget", "none", 0))).toBe(false);
    register("c1");
    expect(h.ingest.onSignal?.("c1", { kind: "run", outcome: "pass", weight: -1 })).toBe(false);
    expect(h.ingest.onSignal?.("c1", { kind: "nope", outcome: "pass", weight: 1 } as unknown as SignalObservation)).toBe(false);
    h.setSettings(null);
    expect(h.ingest.onSignal?.("c1", obs("run", "pass", 1))).toBe(false);
    expect(h.bundles).toHaveLength(0);
  });

  it("never throws: an error is logged and reported as false; a disposed ingest records nothing", async () => {
    const h = ingestHarness();
    register("c1");
    h.explode();
    expect(h.ingest.onSignal?.("c1", obs("run", "pass", 1))).toBe(false);
    expect(h.warnings.some((w) => w.includes("signal failed"))).toBe(true);
    const h2 = ingestHarness();
    register("c2");
    await h2.ingest.dispose();
    expect(h2.ingest.onSignal?.("c2", obs("run", "pass", 1))).toBe(false);
  });

  it("NOOP_INGEST implements it as a no-op", () => {
    expect(NOOP_INGEST.onSignal?.("c1", obs("run", "pass", 1))).toBe(false);
  });
});
