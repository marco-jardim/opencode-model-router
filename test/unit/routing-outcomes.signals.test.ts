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
  SIGNAL_MASS_CAPS,
  SIGNAL_WEIGHTS,
  detectRedispatch,
  graderSignal,
  isSignalObservation,
  parseReturnPrefix,
  returnSignal,
  runSignal,
  signalMass,
  signalRow,
  signedWeight,
  taskSections,
  taskSimilarity,
  tierRank,
  verdictSignal,
  withoutSharedLines,
  type DispatchText,
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

  it("tolerates markdown decoration, case and NEED MORE spellings", () => {
    expect(parseReturnPrefix("**DONE:** shipped")?.prefix).toBe("done");
    expect(parseReturnPrefix("> done: shipped")?.prefix).toBe("done");
    expect(parseReturnPrefix("## ESCALATE: authority")).toEqual({ prefix: "escalate", claim: "authority" });
    expect(parseReturnPrefix("`NEED_MORE`: Budget exhausted")).toEqual({ prefix: "need-more", claim: "budget" });
    expect(parseReturnPrefix("NEED-MORE: more context")).toEqual({ prefix: "need-more", claim: null });
    expect(parseReturnPrefix("ESCALATE: budget")).toEqual({ prefix: "escalate", claim: "budget" });
  });

  it("DONE never carries a claim; a prefix without a colon is a progress note; no text is null", () => {
    expect(parseReturnPrefix("DONE: budget left over")).toEqual({ prefix: "done", claim: null });
    expect(parseReturnPrefix("DONE.")).toEqual({ prefix: "none", claim: null });
    expect(parseReturnPrefix("ESCALATE: authorityish")).toEqual({ prefix: "escalate", claim: null });
    expect(parseReturnPrefix("")).toBeNull();
    expect(parseReturnPrefix("  \n\t\n")).toBeNull();
    expect(parseReturnPrefix(null)).toBeNull();
    expect(parseReturnPrefix(undefined)).toBeNull();
  });
});

describe("returnSignal (I6, I7)", () => {
  it("DONE alone → no signal and no positive mass (I6)", () => {
    expect(returnSignal({ text: "DONE: implemented and tested" })).toBeNull();
    expect(returnSignal({ text: "DONE: x", budgetExhausted: false, authorityRequested: false })).toBeNull();
  });

  it("no text → no signal", () => {
    expect(returnSignal({ text: undefined })).toBeNull();
    expect(returnSignal({ text: "\n" })).toBeNull();
  });

  it("NEED MORE / ESCALATE / a progress note without budget or authority → incomplete, failure 0.5", () => {
    const incomplete = obs("incomplete", "fail", 0.5);
    expect(returnSignal({ text: "NEED MORE: the schema file" })).toEqual(incomplete);
    expect(returnSignal({ text: "ESCALATE: needs a design decision" })).toEqual(incomplete);
    expect(returnSignal({ text: "I have read the files and will now edit them." })).toEqual(incomplete);
  });

  it("NEED MORE after budget exhaustion → budget, no mass (I7), whatever the text says", () => {
    const budget = obs("budget", "none", 0);
    expect(returnSignal({ text: "NEED MORE: budget\nprogress summary", budgetExhausted: true })).toEqual(budget);
    expect(returnSignal({ text: "NEED MORE: still reading", budgetExhausted: true })).toEqual(budget);
    expect(returnSignal({ text: "DONE: partial", budgetExhausted: true })).toEqual(budget);
    // Not observed: the contract claim is taken.
    expect(returnSignal({ text: "NEED MORE: budget" })).toEqual(budget);
  });

  it("a budget claim the guard refutes is incomplete", () => {
    expect(returnSignal({ text: "NEED MORE: budget", budgetExhausted: false })).toEqual(obs("incomplete", "fail", 0.5));
  });

  it("authority request → authority, never a failure (I7)", () => {
    const authority = obs("authority", "none", 0);
    expect(returnSignal({ text: "ESCALATE: authority (edit denied)", authorityRequested: true })).toEqual(authority);
    expect(returnSignal({ text: "ESCALATE: authority" })).toEqual(authority);
    expect(returnSignal({ text: "anything", authorityRequested: true, budgetExhausted: true })).toEqual(authority);
    expect(returnSignal({ text: "ESCALATE: authority", authorityRequested: false })).toEqual(obs("incomplete", "fail", 0.5));
    for (const text of ["ESCALATE: authority", "NEED MORE: authority"]) {
      const s = returnSignal({ text });
      expect(s?.outcome).not.toBe("fail");
      expect(signalMass(s!.kind, signedWeight(s!))).toEqual({ positive: 0, negative: 0 });
    }
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

  it("a grader on the producer's model is ignored (variant and case do not make it another model)", () => {
    const same = { ...base, graderModel: "anthropic/claude-sonnet-5-5" };
    expect(graderSignal({ ...same, outcome: "pass" }, TIERS)).toBeNull();
    expect(graderSignal({ ...same, graderModel: "anthropic/claude-sonnet-5-5#high", outcome: "fail" }, TIERS)).toBeNull();
    expect(graderSignal({ ...same, graderModel: "Anthropic/Claude-Sonnet-5-5", outcome: "pass" }, TIERS)).toBeNull();
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
  const input = (runs: RunRecord[], edits: number[] = [T0], acceptance: string[] = ["test"]) => ({ childSessionID: "c1", runs, edits, acceptance });

  it("router_run exit 0 of the acceptance command started after the last edit → success 1", () => {
    expect(runSignal(input([run("test", 0, T0 + 1)]))).toEqual(obs("run", "pass", 1));
  });

  it("router_run exit 0 before (or at) the last edit is ignored: `at` is the run START", () => {
    expect(runSignal(input([run("test", 0, T0 - 1)], [T0 - 10, T0]))).toBeNull();
    expect(runSignal(input([run("test", 0, T0)], [T0]))).toBeNull();
    // A run that started before an edit made during it does not cover that edit.
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

  it("no edits (a runner) → any acceptance run counts; non-finite timestamps are ignored", () => {
    expect(runSignal(input([run("test", 0, T0)], []))).toEqual(obs("run", "pass", 1));
    expect(runSignal(input([run("test", 0, T0)], [Number.NaN]))).toEqual(obs("run", "pass", 1));
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
  return { decisionID: id, parentSessionID: "p1", childSessionID: `c-${id}`, prompt, tier, at, ...over };
}

describe("taskSections / withoutSharedLines / taskSimilarity", () => {
  it("extracts TASK + EXPECTED OUTCOME and drops the other sections", () => {
    const text = taskSections(PROMPT_A) ?? "";
    expect(text).toContain("off-by-one");
    expect(text).toContain("regression test");
    expect(text).not.toContain("ENVIRONMENT");
    expect(text).not.toContain("no new dependencies");
    expect(text).not.toContain("[router]");
  });

  it("accepts bold, heading and parenthesised headers; null without either section", () => {
    const md = ["**1. TASK:** do X", "multi-line task body", "## 2) EXPECTED OUTCOME (strict): Y", "3. REQUIRED TOOLS: read", "tool line"].join("\n");
    expect(taskSections(md)).toBe([" do X", "multi-line task body", " Y"].join("\n"));
    expect(taskSections("just a free-form request\nwith two lines")).toBeNull();
  });

  it("removes lines shared with at least two siblings", () => {
    const sib = (unique: string) => ["shared header", "shared footer", unique].join("\n");
    const out = withoutSharedLines(sib("mine"), [sib("one"), sib("two"), "shared header only"]);
    expect(out).toBe("mine");
    // Shared with one sibling only: kept.
    expect(withoutSharedLines("a line\nb line", ["a line"])).toBe("a line\nb line");
  });

  it("taskSimilarity is a word-set Dice; short texts never match", () => {
    expect(taskSimilarity("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(taskSimilarity("alpha beta", "alpha beta")).toBe(0);
    expect(taskSimilarity("alpha beta gamma delta", "epsilon zeta eta theta")).toBe(0);
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

  it("re-dispatch to a lower or the same tier → no signal", () => {
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "fast", T0 + MIN), [d("D1", PROMPT_A, "medium", T0)], TIERS)).toBeNull();
    expect(detectRedispatch(d("D2", PROMPT_A_AGAIN, "medium", T0 + MIN), [d("D1", PROMPT_A, "medium", T0)], TIERS)).toBeNull();
  });

  it("outside 30 min, simultaneous or later, another parent, the same child, a resume, an unknown tier → no signal", () => {
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
    expect(detectRedispatch(cur(), [{ ...prev, childSessionID: null }], TIERS)).not.toBeNull();
    expect(detectRedispatch(cur(), [prev, { ...prev }], TIERS, { windowMs: MIN })).toBeNull();
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
    // The latest same-task attempt already ran at the same tier: nothing, even though an older one ran lower.
    const m = d("M", PROMPT_A, "medium", T0 + 2 * MIN);
    expect(detectRedispatch(d("C", PROMPT_A_AGAIN, "medium", T0 + 3 * MIN), [a, m], TIERS)).toBeNull();
  });

  it("without sections: compares what is left after removing lines shared with ≥ 2 siblings", () => {
    const wrap = (body: string) => ["You are a helper subagent.", "Follow the repository conventions strictly.", body, "Report file:line evidence."].join("\n");
    const sibling1 = d("S1", wrap("Rename the logger helper in src/log/index.ts to createLogger everywhere."), "fast", T0 - 3 * MIN);
    const sibling2 = d("S2", wrap("Translate the README introduction to Portuguese keeping the badges."), "fast", T0 - 2 * MIN);
    const prev = d("P", wrap("Add retry with exponential backoff to src/net/fetch.ts and cover it with tests."), "fast", T0);
    const same = d("N", wrap("Add retry with exponential backoff to src/net/fetch.ts and cover it with tests please."), "medium", T0 + MIN);
    const different = d("N", wrap("Delete the unused feature flags from src/flags/registry.ts and their docs."), "medium", T0 + MIN);
    expect(detectRedispatch(same, [sibling1, sibling2, prev], TIERS)?.previous).toBe(prev);
    expect(detectRedispatch(different, [sibling1, sibling2, prev], TIERS)).toBeNull();
    // One prompt with sections, the other without: both fall back.
    expect(detectRedispatch(d("N", PROMPT_A_AGAIN, "medium", T0 + MIN), [d("P", "Fix lexer", "fast", T0)], TIERS)).toBeNull();
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

describe("signalRow and parseLogLine", () => {
  it("a signal row is an annotation that round-trips through the log", () => {
    const r = signalRow(
      { ts: "2026-10-06T12:00:00.000Z", sessionID: "p1", decisionID: "D1", mode: "shadow", childSessionID: "c1", facts: row("D1", "x").facts, chosen: choiceOf(R_MED, "implementer"), step: "dispatch", role: "implementer", tier: "medium" },
      obs("grader", "fail", 0.5),
    );
    expect(r.reason).toBe(`${SIGNAL_REASON}grader:fail`);
    expect(r.reason.startsWith(ANNOTATION_REASON)).toBe(true);
    expect(r).toMatchObject({ signal: "grader", signalWeight: -0.5, role: "implementer", tier: "medium", best: null, resume: false, confidence: 0.9 });
    expect(isAnnotationRow(r)).toBe(true);
    expect(parseLogLine(JSON.stringify(r))).toEqual(r);
    const bare = signalRow({ ts: r.ts, sessionID: "p1", decisionID: "D1", mode: "shadow", childSessionID: null, facts: r.facts, chosen: r.chosen, step: "variant" }, obs("budget", "none", 0));
    expect(bare).not.toHaveProperty("role");
    expect(bare).not.toHaveProperty("tier");
    expect(bare.signalWeight).toBe(0);
  });

  it("round-trips the eight contract fields of DecisionRow (plus tier, signalWeight and a role-origin key)", () => {
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

  it("malformed extension fields are dropped, never the row; old rows parse without them", () => {
    const bad = { ...row("D9", "2026-10-06T12:00:00.000Z"), role: 7, grant: ["read", 1], boundsReasons: "x", budgetUsed: "37", signal: "bogus", explore: "yes", propensity: Number.NaN, binding: "maybe", tier: 3, signalWeight: "1" };
    const parsed = parseLogLine(JSON.stringify(bad)) as DecisionRow;
    expect(parsed).not.toBeNull();
    for (const field of ["role", "grant", "boundsReasons", "budgetUsed", "signal", "explore", "propensity", "binding", "tier", "signalWeight"]) {
      expect(parsed).not.toHaveProperty(field);
    }
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
      sig(D3, obs("budget", "none", 0), "2026-10-06T11:10:00.000Z"),
      sig(D3, obs("authority", "none", 0), "2026-10-06T11:11:00.000Z"),
      sig(D4, obs("budget", "none", 0), "2026-10-06T11:40:00.000Z"),
      // A forged row: self-report trying to create positive mass, and a penalty for an authority request.
      sig(D3, obs("incomplete", "pass", 1), "2026-10-06T11:12:00.000Z"),
      sig(D3, obs("authority", "fail", 1), "2026-10-06T11:13:00.000Z"),
      // A tier-mode dispatch's signal and a signal without any dispatch row and without a role: unattributed.
      sig(TIERED, obs("verdict", "pass", 1), "2026-10-06T10:30:00.000Z"),
      sig({ ...D1, decisionID: "ghost", role: undefined }, obs("run", "pass", 1), "2026-10-06T10:31:00.000Z"),
      // A signal of a dispatch decided before the window joins it all the same; its own role/tier fill a missing join.
      sig({ ...D1, decisionID: "ghost-role" }, obs("verdict", "pass", 1), "2026-10-06T10:32:00.000Z", { role: "reviewer", tier: "heavy" }),
      // Unknown bindings: one on the dispatch row (D3), one annotation row attributed by its own role, one unattributed.
      { ...D4, reason: `${ANNOTATION_REASON}binding:unknown`, binding: "unknown", ts: "2026-10-06T11:41:00.000Z" },
      { ...D4, decisionID: "nobody", role: undefined, reason: `${ANNOTATION_REASON}binding:unknown`, binding: "unknown", ts: "2026-10-06T11:42:00.000Z" },
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
    expect(medium.positiveMass).toBe(1.5);
    expect(medium.negativeMass).toBe(1);
    expect(medium.costUnits).toEqual([{ unit: "usd", total: 0.12, rows: 1 }]);

    const explorer = bucket(t, "explorer", "unknown");
    expect(explorer).toMatchObject({ dispatches: 1, budgetExhaustions: 1, unknownBindings: 1, costUnits: [] });

    expect(bucket(t, "reviewer", "heavy")).toMatchObject({ dispatches: 0, positiveMass: 1 });
    expect(t.unattributed).toEqual({ signals: 2, unknownBindings: 1 });
  });

  it("duplicated rows count once (C7)", () => {
    const rows = log();
    expect(summarizeRoles(null, [...rows, ...rows], WINDOW)).toEqual(summarizeRoles(null, rows, WINDOW));
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

describe("ingest.onSignal", () => {
  it("appends one role signal row per attempt, kind and outcome (C7); the store, its Beta and decay are untouched", async () => {
    const h = ingestHarness();
    register("c1");
    expect(h.ingest.onSignal?.("c1", obs("redispatch", "fail", 0.5))).toBe(true);
    const store = h.bundles[0]!.store;
    const before = { revision: store.revision, snapshot: JSON.stringify(store.snapshot()), posterior: store.posterior(R_FAST) };
    expect(h.ingest.onSignal?.("c1", obs("redispatch", "fail", 0.5))).toBe(false);
    expect(h.ingest.onSignal?.("c1", obs("run", "pass", 1))).toBe(true);
    expect(h.ingest.onSignal?.("c1", obs("verdict", "fail", 1))).toBe(true);
    expect(h.ingest.onSignal?.("c1", obs("verdict", "pass", 1))).toBe(true);
    expect(store.revision).toBe(before.revision);
    expect(JSON.stringify(store.snapshot())).toBe(before.snapshot);
    expect(store.posterior(R_FAST)).toEqual(before.posterior);
    expect(store.keys()).toEqual([]);

    const rows = (await h.rows()) as DecisionRow[];
    expect(rows.map((r) => r.reason)).toEqual(["note:signal:redispatch:fail", "note:signal:run:pass", "note:signal:verdict:fail", "note:signal:verdict:pass"]);
    expect(rows[0]).toMatchObject({
      kind: "decision",
      decisionID: "dec-1",
      sessionID: "root",
      childSessionID: "c1",
      mode: "enforce",
      role: "implementer",
      tier: "fast",
      signal: "redispatch",
      signalWeight: -0.5,
      step: "dispatch",
      chosen: { key: R_FAST, agent: "implementer", origin: "role", model: "anthropic/claude-haiku-4-5", variant: "default" },
    });
    expect(rows.every((r) => isAnnotationRow(r))).toBe(true);
  });

  it("a new attempt of the same child is a new identity", async () => {
    const h = ingestHarness();
    register("c1");
    expect(h.ingest.onSignal?.("c1", obs("incomplete", "fail", 0.5))).toBe(true);
    register("c1");
    expect(h.ingest.onSignal?.("c1", obs("incomplete", "fail", 0.5))).toBe(true);
    expect(await h.rows()).toHaveLength(2);
  });

  it("tier-mode agents keep router/host keys and carry no role; a registration without a decision gets its own id", async () => {
    const h = ingestHarness({ roleAgentIds: undefined });
    register("c1", { agent: "medium", model: "anthropic/claude-sonnet-5-5#high", tier: null, decisionID: null });
    expect(h.ingest.onSignal?.("c1", obs("budget", "none", 0))).toBe(true);
    const [r] = (await h.rows()) as DecisionRow[];
    expect(r?.chosen.origin).toBe("router");
    expect(r?.chosen.variant).toBe("high");
    expect(r?.decisionID.startsWith("attempt:")).toBe(true);
    expect(r).not.toHaveProperty("role");
    expect(r).not.toHaveProperty("tier");
    expect(r?.signalWeight).toBe(0);
  });

  it("records nothing for an unregistered, untrusted or unkeyable child, an invalid observation, or with ingestion off", async () => {
    const h = ingestHarness();
    expect(h.ingest.onSignal?.("nobody", obs("run", "pass", 1))).toBe(false);
    register("low", { facts: { ...FACTS, confidence: 0.2 } });
    expect(h.ingest.onSignal?.("low", obs("run", "pass", 1))).toBe(false);
    register("nomodel", { model: null });
    expect(h.ingest.onSignal?.("nomodel", obs("run", "pass", 1))).toBe(false);
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
