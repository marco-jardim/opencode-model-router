/**
 * test/unit/verify.criteria.test.ts — plan P1.5 (T1.5.3, T1.5.3a, T1.5.4).
 *
 * §2.9 E8: verification never cuts a criterion (whole criteria within the
 * budget, the rest omitted and not graded), router directives — the dispatch
 * header (R6/P-15, v1 and v2-translated forms) and the CAP/VERIFY/route lines —
 * never become gradable criteria, and a progress-note return is `incomplete`,
 * not `fail`. T1.5.3a: the header's working-directory line names the route
 * line's `root=`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CRITERIA_BUDGET_CHARS,
  codePointLength,
  fitCriteria,
  inferDoD,
  omittedCriteriaText,
  summarizeDispatch,
} from "../../src/verify/dod";
import {
  INCOMPLETE_REASON,
  buildGradingPrompt,
  isProgressNote,
  runChecker,
} from "../../src/verify/checker";
import type { CheckerInput, GraderDispatch } from "../../src/verify/checker";
import { buildDelegationDoD, buildForcingNote } from "../../src/verify/dispatch";
import { gateResult } from "../../src/verify/gate";
import {
  DISPATCH_HEADER_SEPARATOR,
  buildDispatchHeader,
  routeLineRoot,
  stripDispatchHeader,
} from "../../src/router/dispatch-header";
import { v2Instructions } from "../../src/compat/v2-hooks";

const ORIGINAL = [
  "Add the reader guard profile to src/guard/guards.ts and cover it with unit tests.",
  "",
  "Keep the producer profile unchanged.",
].join("\n");

// @medium: the tier whose 120-character cut gives the "…re-dispa" criterion of the E8 evidence.
const header = (tier = "medium", cap: number | "none" = 5) =>
  buildDispatchHeader({ tier, cap, projectDirectory: "D:\\git\\opencode-model-router" });

/** index.ts:1732-1733 (v1): header + separator + the orchestrator's prompt. */
const v1Form = (prompt: string, tier = "medium") => header(tier) + DISPATCH_HEADER_SEPARATOR + prompt;

/** v2-hooks.ts translateAdded (:79-86, :524-527): only the ADDED text goes through v2Instructions. */
const v2Form = (prompt: string, tier = "medium") => v2Instructions(header(tier) + DISPATCH_HEADER_SEPARATOR) + prompt;

/** The criterion the old summarizeDispatch produced for a header-prefixed prompt (dod.ts:62 `slice(0, 120)`). */
const OLD_CUT = header().split("\n")[0]!.slice(0, 120);

function checkerInput(criteria: string[], finalReturnText = "DONE: implemented, tests pass"): CheckerInput {
  return {
    criteria,
    artefact: { finalReturnText, changedFiles: [{ path: "src/guard/guards.ts", status: "modified" }], changeBaseline: "available", declaredOutputs: [] },
    producerTier: "medium",
    producerSessionID: "producer",
  };
}

/** A grader that fails any criterion cut mid-word — the E8 false negative. */
const strictGrader: GraderDispatch = async (req) => ({
  sessionID: "grader",
  text: req.prompt.includes("re-dispa\n") || /re-dispa$/m.test(req.prompt)
    ? JSON.stringify({ pass: false, reasons: [`criterion 1 is truncated: "${OLD_CUT}"`] })
    : JSON.stringify({ pass: true, reasons: [] }),
});

// ---------------------------------------------------------------------------
// E8 reproduction
// ---------------------------------------------------------------------------

describe("E8 reproduction — the dispatch header never becomes a criterion", () => {
  it("before: the header's first 120 characters were the criterion, cut mid-word", () => {
    expect(OLD_CUT).toBe("[router] You are @medium. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispa");
  });

  it("after (v1 form): the criterion is the orchestrator's first line, whole", () => {
    const dod = buildDelegationDoD({ prompt: v1Form(ORIGINAL) });
    expect(dod).toMatchObject({ kind: "checker", source: "inferred", criteria: [ORIGINAL.split("\n")[0]] });
    expect(dod.criteria.join("\n")).not.toContain("[router]");
  });

  it("after (v2-translated form): the same DoD as v1", () => {
    expect(v2Form(ORIGINAL)).toBe(v1Form(ORIGINAL)); // today's header carries no v1 tool words
    expect(buildDelegationDoD({ prompt: v2Form(ORIGINAL) })).toEqual(buildDelegationDoD({ prompt: v1Form(ORIGINAL) }));
  });

  it("a header edit that v2Instructions rewrites still strips (prefix and separator are untouched)", () => {
    const edited = header().replace("Execute this dispatch yourself", "Use the Task tool only via Task(subagent_type)");
    const translated = v2Instructions(edited + DISPATCH_HEADER_SEPARATOR) + ORIGINAL;
    expect(translated).toContain("subagent tool");
    expect(stripDispatchHeader(translated)).toBe(ORIGINAL);
    expect(buildDelegationDoD({ prompt: translated }).criteria).toEqual([ORIGINAL.split("\n")[0]]);
  });

  it("truncated criterion → no FAIL: the grader sees whole criteria and passes", async () => {
    const before = await runChecker(checkerInput([OLD_CUT]), { dispatchGrader: strictGrader });
    expect(before.outcome).toBe("fail");
    const dod = buildDelegationDoD({ prompt: v1Form(ORIGINAL) });
    const after = await runChecker(checkerInput(dod.criteria), { dispatchGrader: strictGrader });
    expect(after).toMatchObject({ pass: true, outcome: "pass" });
  });

  it("an [acceptance] block behind the header is parsed as the explicit DoD", () => {
    const prompt = v1Form(["Do it.", "[acceptance]", "criteria: the guard has a reader profile", "[/acceptance]"].join("\n"));
    expect(buildDelegationDoD({ prompt })).toMatchObject({ source: "explicit", criteria: ["the guard has a reader profile"] });
  });

  it("a long first line is kept whole (not cut at 120)", () => {
    const long = `Implement ${"the reader guard profile and ".repeat(8)}done.`;
    expect(codePointLength(long)).toBeGreaterThan(120);
    expect(buildDelegationDoD({ prompt: v2Form(long) }).criteria).toEqual([long]);
  });
});

describe("stripDispatchHeader", () => {
  it("drops through the FIRST separator only", () => {
    const prompt = `body\n\n---\n\nsecond part`;
    expect(stripDispatchHeader(v1Form(prompt))).toBe(prompt);
  });

  it("leaves a prompt without the header prefix unchanged", () => {
    for (const p of [ORIGINAL, `x${v1Form(ORIGINAL)}`, " [router] You are @fast.\n\n---\n\nbody"]) {
      expect(stripDispatchHeader(p)).toBe(p);
    }
  });

  it("without a separator the header ends at its last paragraph; without that, nothing is stripped", () => {
    expect(stripDispatchHeader(`${header()}\n\nTask text`)).toBe("Task text");
    expect(stripDispatchHeader(header())).toBe("");
    const forged = "[router] You are @fast. Do the task.";
    expect(stripDispatchHeader(forged)).toBe(forged);
  });
});

// ---------------------------------------------------------------------------
// Router directives are not criteria
// ---------------------------------------------------------------------------

describe("router directives never become gradable criteria", () => {
  it("CAP / reason / VERIFY / VERIFY_WAIT / [route …] / [router] lines are skipped", () => {
    const text = [
      "[route class=review risk=high pin]",
      "CAP:none",
      "reason: whole-repo review",
      "VERIFY: required",
      "VERIFY_WAIT: 0s",
      "[router] You are @heavy.",
      "Review the guard module for budget escapes.",
    ].join("\n");
    expect(summarizeDispatch(text)).toBe("Review the guard module for budget escapes.");
    expect(inferDoD(text, "", {}).criteria).toEqual(["Review the guard module for budget escapes."]);
  });

  it("only-directive text falls back to the generic criterion", () => {
    expect(summarizeDispatch("CAP:8\nreason: x")).toBe("");
    expect(inferDoD("CAP:8\nreason: x", "", {}).criteria).toEqual(["the delegated task is completed as described in the dispatch"]);
  });

  it("a line that only mentions a directive mid-text is a criterion", () => {
    expect(summarizeDispatch("Explain why CAP:none needs a reason")).toBe("Explain why CAP:none needs a reason");
    expect(summarizeDispatch("[routes] are documented")).toBe("[routes] are documented");
  });
});

// ---------------------------------------------------------------------------
// The verification text budget
// ---------------------------------------------------------------------------

describe("fitCriteria — whole criteria only", () => {
  it("criteria list over the budget: whole criteria dropped, counted, never cut", () => {
    const fitted = fitCriteria(["aaaa", "bbbb", "cccc"], 10);
    expect(fitted).toEqual({ criteria: ["aaaa", "bbbb"], omitted: 1 });
  });

  it("one criterion longer than the budget is omitted, not cut; later ones that fit are kept", () => {
    expect(fitCriteria(["x".repeat(11)], 10)).toEqual({ criteria: [], omitted: 1 });
    expect(fitCriteria(["short", "y".repeat(50), "tiny"], 10)).toEqual({ criteria: ["short", "tiny"], omitted: 1 });
  });

  it("multi-byte text at the boundary counts code points", () => {
    const exact = "\u{1F600}".repeat(5); // 5 code points, 10 UTF-16 units
    expect(exact.length).toBe(10);
    expect(codePointLength(exact)).toBe(5);
    expect(fitCriteria([exact], 5)).toEqual({ criteria: [exact], omitted: 0 });
    expect(fitCriteria([`${exact}é`], 5)).toEqual({ criteria: [], omitted: 1 });
    expect(fitCriteria(["日本語テキスト"], 7).criteria).toEqual(["日本語テキスト"]);
  });

  it("the default budget and the omission wording", () => {
    expect(CRITERIA_BUDGET_CHARS).toBe(4000);
    expect(fitCriteria(["a"]).omitted).toBe(0);
    expect(omittedCriteriaText(1)).toBe("1 criterion omitted");
    expect(omittedCriteriaText(3)).toBe("3 criteria omitted");
  });
});

describe("grading prompt and verdict under the budget", () => {
  const big = (n: number, ch: string) => ch.repeat(n);

  it("within the budget the prompt is unchanged (golden)", () => {
    const { prompt } = buildGradingPrompt(checkerInput(["first", "second"]));
    expect(prompt).toContain("## Acceptance criteria (ALL must be satisfied)\n1. first\n2. second\n\n## Artefact to evaluate");
    expect(prompt).not.toContain("omitted");
  });

  it("over the budget the prompt lists whole criteria and names the omission", () => {
    const { prompt } = buildGradingPrompt(checkerInput(["keep me", big(4000, "z"), big(3000, "w")]));
    expect(prompt).toContain("1. keep me\n2. ");
    expect(prompt).toContain(`2. ${big(3000, "w")}\n(1 criterion omitted: over the 4000-character verification budget; not graded)`);
    expect(prompt).not.toContain(big(4000, "z"));
  });

  it("no criterion fits → unverifiable, the grader is not dispatched", async () => {
    const grader = vi.fn<GraderDispatch>();
    const v = await runChecker(checkerInput([big(4001, "q"), big(4500, "r")]), { dispatchGrader: grader });
    expect(grader).not.toHaveBeenCalled();
    expect(v).toMatchObject({ pass: false, outcome: "unverifiable", method: "checker" });
    expect(v.reasons[0]).toContain("2 criteria omitted");
  });

  it("a pass on partially graded criteria is unverifiable with a caveat; a fail stays a fail", async () => {
    const passing: GraderDispatch = async () => ({ sessionID: "g", text: '{"pass":true,"reasons":[]}' });
    const failing: GraderDispatch = async () => ({ sessionID: "g", text: '{"pass":false,"reasons":["missing"]}' });
    const criteria = ["keep me", big(4001, "z")];
    const partialPass = await runChecker(checkerInput(criteria), { dispatchGrader: passing });
    expect(partialPass).toMatchObject({ pass: false, outcome: "unverifiable", caveats: ["(1 criterion omitted: over the 4000-character verification budget; not graded)"] });
    const partialFail = await runChecker(checkerInput(criteria), { dispatchGrader: failing });
    expect(partialFail).toMatchObject({ pass: false, outcome: "fail", reasons: ["missing"] });
    expect(partialFail.caveats).toHaveLength(1);
    const full = await runChecker(checkerInput(["keep me"]), { dispatchGrader: passing });
    expect(full).toMatchObject({ pass: true, outcome: "pass" });
    expect(full.caveats).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Progress notes are incomplete, not fail
// ---------------------------------------------------------------------------

describe("progress-note return → incomplete, not fail", () => {
  it.each([
    "I've updated guards.ts. I'll finish the tests next.",
    "Read the three files; continuing with the enforce.ts changes.",
    "Partial work so far. Let me continue with the remaining criteria.",
    "Still working on the header strip.",
    "Changes staged — I\u2019m going to complete the commit after typecheck.",
  ])("%s", (text) => {
    expect(isProgressNote(text)).toBe(true);
  });

  it.each([
    "",
    "DONE: implemented; I'll continue to monitor nothing.",
    "**NEED MORE:** budget — I'll finish after a resume.",
    "> ESCALATE: authority. Continuing is impossible.",
    "Summary\n\nDONE: all tests pass",
    "Implemented the reader profile. All 33 tests pass.",
    `I'll finish the tests next.${" Evidence line.".repeat(40)}`, // the announcement is not at the end
  ])("not a progress note: %j", (text) => {
    expect(isProgressNote(text)).toBe(false);
  });

  it("the checker classifies it without dispatching the grader", async () => {
    const grader = vi.fn<GraderDispatch>();
    const v = await runChecker(checkerInput(["the guard has a reader profile"], "I'll finish the tests next."), { dispatchGrader: grader });
    expect(grader).not.toHaveBeenCalled();
    expect(v).toEqual({ pass: false, outcome: "unverifiable", method: "checker", reasons: [INCOMPLETE_REASON], caveats: [INCOMPLETE_REASON] });
    expect(INCOMPLETE_REASON.startsWith("incomplete:")).toBe(true);
    // Never a failure: accepted with a caveat by default, refused only under strictUnverifiable.
    expect(gateResult(v, "inferred").accepted).toBe(true);
    expect(gateResult(v, "inferred", true).accepted).toBe(false);
    expect(gateResult(v, "inferred", true).verdict.outcome).toBe("unverifiable");
  });

  it("renders as INCOMPLETE with resume guidance, not NOT ACCEPTED", () => {
    const note = buildForcingNote([INCOMPLETE_REASON], { producerTier: "medium", nextTier: "heavy" });
    expect(note.startsWith("[router \u26a0 INCOMPLETE] The delegate returned a progress note, not a result:\n- incomplete: ")).toBe(true);
    expect(note).toContain("NEXT: resume the same delegation so it can finish");
    expect(note).not.toContain("NOT ACCEPTED");
    expect(note).not.toContain("heavy");
    // Any other reason keeps the existing rendering (golden).
    expect(buildForcingNote(["check failed", INCOMPLETE_REASON])).toBe(
      `[router \u26a0 NOT ACCEPTED] The delegated result was not accepted by independent verification:\n- check failed\n- ${INCOMPLETE_REASON}\nNEXT: address the above and re-run the delegation; do not treat the prior result as complete.`,
    );
  });
});

// ---------------------------------------------------------------------------
// T1.5.3a — the work-root line of the dispatch header
// ---------------------------------------------------------------------------

describe("dispatch header working directory (T1.5.3a)", () => {
  const base = { tier: "heavy", cap: 3, projectDirectory: "D:\\git\\opencode-model-router" } as const;
  const golden = `[router] You are @heavy. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispatched.

Working directory: D:\\git\\opencode-model-router. You are already there — do not ask permission to read or write inside it.

Tool names mentioned in this dispatch are descriptive and vary by provider; your own tool schema is the authority on what you can do. Never refuse or hand back work because a named tool looks unfamiliar or missing — attempt it, and if you cannot finish, name the specific step that failed.

An empty result is a result. Search tools honour .gitignore, so a "no matches" answer inside an ignored path means the filter applied, not that your tools are broken; use a shell ripgrep with --no-ignore there before concluding anything is absent.

Read-only budget: 3 calls. The runtime appends [cap: N/MAX] and [⚠ REDUNDANT] to results. Reading a different region of a file you have already opened is NOT a redundant read.

CAP:3

To change the budget, put CAP:N or CAP:none accompanied by a reason: line in the dispatch.

A hand-back with zero tool calls is recorded as a false refusal.`;

  it("without a root the header is byte-identical", () => {
    expect(buildDispatchHeader(base)).toBe(golden);
    for (const root of [undefined, null, ""]) expect(buildDispatchHeader({ ...base, root })).toBe(golden);
  });

  it("with a root= the working-directory line names it", () => {
    expect(buildDispatchHeader({ ...base, root: "D:\\git\\omr-rta-p15" })).toBe(
      golden.replace("Working directory: D:\\git\\opencode-model-router.", "Working directory: D:\\git\\omr-rta-p15."),
    );
    // A root also fills the line when the project directory is unknown.
    expect(buildDispatchHeader({ ...base, projectDirectory: undefined, root: "/srv/work" })).toContain("\n\nWorking directory: /srv/work. You are already there");
  });

  it("routeLineRoot reads root= from the prompt's first-line route line only", () => {
    expect(routeLineRoot("[route class=implement root=D:\\git\\omr-rta-p15]\nDo it.")).toBe("D:\\git\\omr-rta-p15");
    expect(routeLineRoot('[route root="D:\\my dir\\wt" class=review]\nDo it.')).toBe("D:\\my dir\\wt");
    expect(routeLineRoot("[route root=relative/dir]\nDo it.")).toBeUndefined();
    expect(routeLineRoot("Do it.\n[route root=D:\\git\\x]")).toBeUndefined();
    expect(routeLineRoot("[route class=review]\nDo it.")).toBeUndefined();
    expect(routeLineRoot("Do it.")).toBeUndefined();
    const prompt = "[route class=implement root=/srv/wt]\nDo it.";
    expect(buildDispatchHeader({ ...base, root: routeLineRoot(prompt) })).toContain("Working directory: /srv/wt.");
  });
});
