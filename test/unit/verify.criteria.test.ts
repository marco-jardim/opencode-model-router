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
  BUDGET_INCOMPLETE_REASON,
  INCOMPLETE_REASON,
  buildGradingPrompt,
  incompleteVerdict,
  isIncompleteVerdict,
  isProgressNote,
  runChecker,
} from "../../src/verify/checker";
import type { CheckerInput, GraderDispatch } from "../../src/verify/checker";
import { buildDelegationDoD, buildForcingNote } from "../../src/verify/dispatch";
import { accept, gateResult } from "../../src/verify/gate";
import { applyDispatchCaveats } from "../../src/verify/wiring";
import { INCOMPLETE_GIVE_UP_REASON, nextAction } from "../../src/escalate/ladder";
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
    "Partial work so far. Let me continue with the remaining criteria.",
    "Changes staged — I\u2019m going to finish the commit after typecheck.",
    "Read the three files; I will continue with enforce.ts",
  ])("%s", (text) => {
    expect(isProgressNote(text)).toBe(true);
  });

  // QA-P15-1-1: ordinary finished wording is not a progress note.
  it.each([
    "",
    "The full suite is now working.",
    "Still working as designed: all 33 tests pass.",
    "Read the three files; continuing with the enforce.ts changes.",
    "Changes staged — I\u2019m going to complete the commit after typecheck.",
    "Implemented and tested. I'll finish the docs in a follow-up.",
    "I'll finish the docs in a follow-up. All tests pass.",
    "Work in progress notes are in NOTES.md.",
    "DONE: implemented; I'll continue to monitor nothing.",
    "**NEED MORE:** budget — I'll finish after a resume.",
    "> ESCALATE: authority. I'll continue once granted.",
    "Summary\n\nDONE: all tests pass",
    "Implemented the reader profile. All 33 tests pass.",
    `I'll finish the tests next.${" Evidence line.".repeat(40)}`, // not the final sentence
  ])("not a progress note: %j", (text) => {
    expect(isProgressNote(text)).toBe(false);
  });

  it("a contract follower's progress note: no grading, NOT accepted, no next-tier hint", async () => {
    const grader = vi.fn<GraderDispatch>();
    const v = await runChecker(checkerInput(["the guard has a reader profile"], "I'll finish the tests next."), { dispatchGrader: grader });
    expect(grader).not.toHaveBeenCalled();
    expect(v).toEqual({ pass: false, outcome: "unverifiable", method: "checker", reasons: [INCOMPLETE_REASON], caveats: [INCOMPLETE_REASON], incomplete: true });
    expect(isIncompleteVerdict(v)).toBe(true);
    // QA-P15-1-1 before: accepted with a caveat; after: never accepted, still not a failure.
    for (const strict of [false, true]) {
      const g = gateResult(v, "inferred", strict);
      expect(g.accepted).toBe(false);
      expect(g.verdict.outcome).toBe("unverifiable"); // index.ts gives no next tier to unverifiable
    }
  });

  it("an agent outside the return contract is graded, never classified by wording", async () => {
    const grader = vi.fn<GraderDispatch>(async () => ({ sessionID: "g", text: '{"pass":true,"reasons":[]}' }));
    const builtIn = { ...checkerInput(["docs written"], "I'll finish the tests next."), producerTier: "general" };
    expect(await runChecker(builtIn, { dispatchGrader: grader })).toMatchObject({ outcome: "pass" });
    expect(grader).toHaveBeenCalledTimes(1);
    // A role agent follows the contract when the caller says so (P2.1).
    const role = { ...builtIn, producerTier: "explorer", returnContract: true };
    expect((await runChecker(role, { dispatchGrader: grader })).reasons).toEqual([INCOMPLETE_REASON]);
  });

  it("QA-P15-1-6: a grader reason starting with 'incomplete:' stays a failure", () => {
    const graderFail = { pass: false, outcome: "fail" as const, method: "checker" as const, reasons: ["incomplete: tests missing"] };
    expect(isIncompleteVerdict(graderFail)).toBe(false);
    expect(isIncompleteVerdict({ outcome: "unverifiable", reasons: ["incomplete: tests missing"] })).toBe(false);
    expect(gateResult(graderFail, "inferred")).toMatchObject({ accepted: false, verdict: { outcome: "fail" } });
    expect(buildForcingNote(["incomplete: tests missing"], { producerTier: "medium", nextTier: "heavy" })).toContain("[router \u26a0 NOT ACCEPTED]");
    expect(buildForcingNote(["incomplete: tests missing"], { producerTier: "medium", nextTier: "heavy" })).toContain('Task(subagent_type="heavy")');
  });

  it("renders as INCOMPLETE with resume guidance, not NOT ACCEPTED", () => {
    for (const reason of [INCOMPLETE_REASON, BUDGET_INCOMPLETE_REASON]) {
      const note = buildForcingNote([reason], { producerTier: "medium", nextTier: "heavy" });
      expect(note.startsWith("[router \u26a0 INCOMPLETE] The delegate stopped before a final result:\n- incomplete: ")).toBe(true);
      expect(note).toContain("NEXT: resume the same delegation so it can finish");
      expect(note).not.toContain("NOT ACCEPTED");
      expect(note).not.toContain("heavy");
    }
    // Any other verdict keeps the existing rendering (golden).
    expect(buildForcingNote(["check failed"])).toBe(
      `[router \u26a0 NOT ACCEPTED] The delegated result was not accepted by independent verification:\n- check failed\nNEXT: address the above and re-run the delegation; do not treat the prior result as complete.`,
    );
    // QA-P15-2-4: the structured flag alone renders INCOMPLETE.
    expect(buildForcingNote(["anything"], { incomplete: true })).toContain("[router \u26a0 INCOMPLETE]");
  });

  it("QA-P15-2-4: the flag survives a caveat appended by applyDispatchCaveats", () => {
    const v = incompleteVerdict(
      { finalReturnText: "I'll finish the tests next.", producerSessionID: "", producerTier: "medium" },
      { progressNotes: true },
    )!;
    const gated = applyDispatchCaveats(gateResult(v, "inferred"), { contaminatedBy: "bash" });
    expect(gated.verdict.reasons).toHaveLength(2); // before: every(isIncompleteReason) failed here
    expect(isIncompleteVerdict(gated.verdict)).toBe(true);
    expect(gated.accepted).toBe(false);
    expect(buildForcingNote(gated.verdict.reasons)).toContain("[router \u26a0 INCOMPLETE]");
    expect(buildForcingNote(gated.verdict.reasons, { incomplete: isIncompleteVerdict(gated.verdict) })).toContain("[router \u26a0 INCOMPLETE]");
    // A reason-only lookalike without the flag is not incomplete for the gate.
    expect(isIncompleteVerdict({ pass: false, outcome: "unverifiable", method: "checker", reasons: [INCOMPLETE_REASON] })).toBe(false);
  });
});

describe("QA-P15-1-2: NEED MORE: budget and a guard stop are incomplete (I7)", () => {
  const passing: GraderDispatch = async () => ({ sessionID: "g", text: '{"pass":true,"reasons":[]}' });

  it.each([
    "NEED MORE: budget\nDone: guards.ts. Remaining: tests.",
    "**NEED MORE:** `budget` — done: X; remaining: Y",
    "> need more: budget",
    "task_id: ses_1\n<task_result>\n- **NEED MORE: budget** — done: X\n</task_result>",
  ])("%j → incomplete for any agent, the grader is not dispatched", async (text) => {
    const grader = vi.fn<GraderDispatch>();
    const input = { ...checkerInput(["x"], text), producerTier: "general" };
    const v = await runChecker(input, { dispatchGrader: grader });
    expect(grader).not.toHaveBeenCalled();
    expect(v.reasons).toEqual([BUDGET_INCOMPLETE_REASON]);
    expect(gateResult(v, "explicit")).toMatchObject({ accepted: false, verdict: { outcome: "unverifiable" } });
  });

  it("NEED MORE for anything but budget is graded", async () => {
    const grader = vi.fn(passing);
    await runChecker(checkerInput(["x"], "NEED MORE: context — which file holds the cap?"), { dispatchGrader: grader });
    expect(grader).toHaveBeenCalledTimes(1);
  });

  it("a guard stop without a contract marker is a budget stop; DONE:/ESCALATE: are graded", async () => {
    const stoppedSnap = (sid: string) => ({ tracked: true, stopped: sid === "producer", usedUp: true });
    const grader = vi.fn(passing);
    const stop = await runChecker(checkerInput(["x"], "Partial summary of the work so far"), { dispatchGrader: grader, budgetSnapshot: stoppedSnap });
    expect(stop.reasons).toEqual([BUDGET_INCOMPLETE_REASON]);
    expect(grader).not.toHaveBeenCalled();
    for (const text of ["DONE: finished on the last call", "ESCALATE: authority"]) {
      await runChecker(checkerInput(["x"], text), { dispatchGrader: grader, budgetSnapshot: stoppedSnap });
    }
    expect(grader).toHaveBeenCalledTimes(2);
  });

  it("the gate classifies a budget stop before the deterministic checks too", async () => {
    const dod = { kind: "deterministic" as const, checks: [{ kind: "testsPass" as const, command: "npm test" }], criteria: [], deliverable: null, source: "explicit" as const };
    const artefact = { changedFiles: [], finalReturnText: "NEED MORE: budget — tests not run yet", declaredOutputs: [], producerSessionID: "p", producerTier: "medium" };
    const res = await accept({ dod }, artefact, { deterministic: {} as never, checker: { dispatchGrader: vi.fn<GraderDispatch>() } });
    expect(res).toMatchObject({ accepted: false, verdict: { outcome: "unverifiable", reasons: [BUDGET_INCOMPLETE_REASON] } });
  });

  it("incompleteVerdict without progress-note classification ignores wording", () => {
    const input = { finalReturnText: "I'll finish the tests next.", producerSessionID: "p", producerTier: "medium" };
    const room = () => ({ tracked: true, stopped: false, usedUp: false });
    expect(incompleteVerdict(input, { progressNotes: false, budgetSnapshot: room })).toBeNull();
    expect(incompleteVerdict(input, { progressNotes: true, budgetSnapshot: room })?.reasons).toEqual([INCOMPLETE_REASON]);
    expect(incompleteVerdict({ ...input, producerSessionID: "" }, { progressNotes: false })).toBeNull();
  });
});

describe("QA round 2 — verification", () => {
  const passing: GraderDispatch = async () => ({ sessionID: "g", text: '{"pass":true,"reasons":[]}' });
  const claim = "NEED MORE: budget\nDone: A. Remaining: B.";

  it("2-2: a NEED MORE: budget claim is honoured only when the snapshot backs it", async () => {
    const cases: Array<[{ tracked: boolean; stopped: boolean; usedUp: boolean; readCapReached?: boolean }, boolean]> = [
      [{ tracked: false, stopped: false, usedUp: false }, true], // enforcement off: cannot be checked
      [{ tracked: true, stopped: false, usedUp: true }, true], // budget or refusals used up
      [{ tracked: true, stopped: false, usedUp: false, readCapReached: true }, true], // read-only cap reached
      [{ tracked: true, stopped: false, usedUp: false }, false], // room left: graded normally
      [{ tracked: true, stopped: false, usedUp: false, readCapReached: false }, false],
    ];
    for (const [budget, honoured] of cases) {
      const grader = vi.fn(passing);
      const v = await runChecker({ ...checkerInput(["x"], claim), budget }, { dispatchGrader: grader });
      expect(v.reasons[0] === BUDGET_INCOMPLETE_REASON).toBe(honoured);
      expect(grader).toHaveBeenCalledTimes(honoured ? 0 : 1);
    }
  });

  it("2-5: the gate judges the snapshot captured at return, not the live guard", async () => {
    const dod = { kind: "checker" as const, checks: [], criteria: ["x"], deliverable: null, source: "explicit" as const };
    const base = { changedFiles: [], declaredOutputs: [], producerSessionID: "p", producerTier: "medium" };
    const live = vi.fn(() => ({ tracked: true, stopped: true, usedUp: true }));
    // Captured "stopped": incomplete, though the live guard is never asked.
    const stopped = await accept(
      { dod },
      { ...base, finalReturnText: "Partial summary", budget: { tracked: true, stopped: true, usedUp: true } },
      { deterministic: {} as never, checker: { dispatchGrader: passing, budgetSnapshot: live } },
    );
    expect(stopped).toMatchObject({ accepted: false, verdict: { reasons: [BUDGET_INCOMPLETE_REASON], incomplete: true } });
    // Captured "room left": graded, although the live guard now says stopped (a later round).
    const graded = await accept(
      { dod },
      { ...base, finalReturnText: "Partial summary", budget: { tracked: true, stopped: false, usedUp: false } },
      { deterministic: {} as never, checker: { dispatchGrader: passing, budgetSnapshot: live } },
    );
    expect(graded).toMatchObject({ accepted: true, verdict: { outcome: "pass" } });
    expect(live).not.toHaveBeenCalled();
    // No snapshot: the gate reads the guard when it runs.
    const fallback = await accept({ dod }, { ...base, finalReturnText: "Partial summary" }, { deterministic: {} as never, checker: { dispatchGrader: passing, budgetSnapshot: live } });
    expect(fallback.verdict.reasons).toEqual([BUDGET_INCOMPLETE_REASON]);
    expect(live).toHaveBeenCalledWith("p");
  });

  it("2-6: a contract follower's progress note under a deterministic DoD is incomplete, checks not run", async () => {
    const dod = { kind: "deterministic" as const, checks: [{ kind: "testsPass" as const, command: "npm test" }], criteria: [], deliverable: null, source: "explicit" as const };
    const artefact = { changedFiles: [], finalReturnText: "Edited guards.ts. I'll finish the tests next.", declaredOutputs: [], producerSessionID: "", producerTier: "medium" };
    const res = await accept({ dod }, artefact, { deterministic: {} as never, checker: { dispatchGrader: vi.fn<GraderDispatch>() } });
    expect(res).toMatchObject({ accepted: false, verdict: { outcome: "unverifiable", reasons: [INCOMPLETE_REASON], incomplete: true } });
  });

  it.each([
    "If you'd like, I'll continue with the docs.",
    "I'll continue once you confirm the scope.",
    "Let me know when you want me to continue; I'll continue when asked.",
    "I would continue with the refactor next.",
    "Unless told otherwise, I'll finish the docs.",
    "Shall I continue?",
    "Done with the guard. Should I finish the docs too?",
  ])("2-7: conditional offer or question is not a progress note: %j", (text) => {
    expect(isProgressNote(text)).toBe(false);
  });

  it("2-9: the delegate ladder gives up on an incomplete return with its own reason", () => {
    const policy = { ladder: ["fast", "medium", "heavy"], maxTotalAttempts: 3, maxRetriesPerTier: 1 } as never;
    const state = { currentTier: "medium", totalAttempts: 1, escalations: 0, retriesAtTier: 0, cumulativeCost: 1, firstAttemptCost: 1 } as never;
    const byFlag = nextAction(state, { pass: false, outcome: "unverifiable", reasons: ["x"], incomplete: true }, policy);
    expect(byFlag).toEqual({ action: "give_up", reason: INCOMPLETE_GIVE_UP_REASON });
    expect(INCOMPLETE_GIVE_UP_REASON).toContain("resume the same session");
    const byReason = nextAction(state, { pass: false, outcome: "unverifiable", reasons: [BUDGET_INCOMPLETE_REASON] }, policy);
    expect(byReason.reason).toBe(INCOMPLETE_GIVE_UP_REASON);
    const unavailable = nextAction(state, { pass: false, outcome: "unverifiable", reasons: ["grader timed out"] }, policy);
    expect(unavailable.reason).toBe("verification unavailable; no producer escalation");
    expect(nextAction(state, { pass: false, outcome: "unverifiable" }, policy).reason).toBe("verification unavailable; no producer escalation");
  });

  it.each([
    ["**VERIFY:required**\nDo it.", "Do it."],
    ["`CAP:8`\nDo it.", "Do it."],
    ["VERIFY:required.\nDo it.", "Do it."],
    ["_VERIFY_WAIT: 30s_\nDo it.", "Do it."],
    ["**CAP: none**\n**Reason:** whole repo\nDo it.", "Do it."],
    ["**Verify** the output.\nNext.", "**Verify** the output."],
  ])("2-10: wrapped or punctuated directive %j is skipped", (text, criterion) => {
    expect(summarizeDispatch(text)).toBe(criterion);
  });

  it("2-11: a first sentence over the budget yields no graded criterion (unverifiable), not the generic text", async () => {
    const line = `${"word ".repeat(900)}end. Short tail.`;
    const [criterion] = inferDoD(line, "", {}).criteria;
    expect(criterion).toBe(line);
    expect(criterion).not.toBe("the delegated task is completed as described in the dispatch");
    const grader = vi.fn<GraderDispatch>();
    const v = await runChecker(checkerInput([criterion!]), { dispatchGrader: grader });
    expect(grader).not.toHaveBeenCalled();
    expect(v).toMatchObject({ pass: false, outcome: "unverifiable" });
    expect(v.reasons[0]).toContain("1 criterion omitted");
  });
});

describe("QA-P15-1-7: inferred criteria keep whole sentences; explicit lists (golden)", () => {
  it("a line over the budget keeps its leading whole sentences", () => {
    expect(summarizeDispatch("One two. Three four. Five six.", 20)).toBe("One two. Three four.");
    expect(summarizeDispatch("v1.2 is out. Next step follows.", 14)).toBe("v1.2 is out.");
    expect(summarizeDispatch("A first sentence that is far too long. Short.", 10)).toBe("");
    const emoji = "\u{1F600}".repeat(4);
    expect(summarizeDispatch(`${emoji}. ${emoji}. tail`, 5)).toBe(`${emoji}.`);
  });

  it("an inferred first line over 4000 characters becomes whole sentences that are graded", () => {
    const sentence = "The guard keeps the reader profile for every review dispatch.";
    const line = Array.from({ length: 100 }, () => sentence).join(" ");
    expect(codePointLength(line)).toBeGreaterThan(CRITERIA_BUDGET_CHARS);
    const [criterion] = inferDoD(line, "", {}).criteria;
    expect(codePointLength(criterion!)).toBeLessThanOrEqual(CRITERIA_BUDGET_CHARS);
    expect(criterion!.endsWith(sentence)).toBe(true);
    expect(line.startsWith(criterion!)).toBe(true);
    expect(fitCriteria([criterion!]).omitted).toBe(0);
  });

  it("explicit [acceptance] list over 4000 characters — before: every criterion graded; after: the overflow is omitted, not graded", () => {
    const a = `first ${"a".repeat(2994)}`;
    const b = `second ${"b".repeat(2993)}`;
    const dod = buildDelegationDoD({ prompt: ["Do it.", "[acceptance]", `criteria: ${a}`, `criteria: ${b}`, "[/acceptance]"].join("\n") });
    expect(dod.criteria).toEqual([a, b]); // the DoD itself is unchanged
    const { prompt } = buildGradingPrompt(checkerInput(dod.criteria));
    expect(prompt).toContain(`1. ${a}\n(1 criterion omitted: over the 4000-character verification budget; not graded)`);
    expect(prompt).not.toContain(b);
  });
});

describe("QA-P15-1-8: only whole-line directives are skipped", () => {
  it.each([
    ["Verify: the output matches the golden", "Verify: the output matches the golden"],
    ["Reason: the cache is stale, rebuild it", "Reason: the cache is stale, rebuild it"],
    ["reason: x\nmore", "reason: x"],
    ["VERIFY: required now please\nnext", "VERIFY: required now please"],
    ["verify: required\nnext", "verify: required"],
    ["CAP:8 and read the file", "CAP:8 and read the file"],
    ["CAP: none\nreason: whole repo\nReview it.", "Review it."],
    ["cap:12\nReason: why\nReview it.", "Review it."],
    ["VERIFY_WAIT: 30s\nVERIFY: required\nDo it.", "Do it."],
  ])("%j → %j", (text, criterion) => {
    expect(summarizeDispatch(text)).toBe(criterion);
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

describe("DF-1 fix: the budget claim is read only from the return prefix", () => {
  const passing: GraderDispatch = async () => ({ sessionID: "g", text: '{"pass":true,"reasons":[]}' });
  const room = () => ({ tracked: true, stopped: false, usedUp: true, readCapReached: true });

  it.each([
    "DONE: implemented.\n\n- `NEED MORE: budget` at the cap → note and `budget` signal",
    "task_id: ses_1\n<task_result>\nDONE: implemented.\n- `NEED MORE: budget` at the cap\n</task_result>",
    "ESCALATE: authority\nNEED MORE: budget",
    "Summary first.\nNEED MORE: budget",
  ])("%j is graded, not incomplete", async (text) => {
    const grader = vi.fn(passing);
    const v = await runChecker(checkerInput(["x"], text), { dispatchGrader: grader, budgetSnapshot: room });
    expect(grader).toHaveBeenCalledTimes(1);
    expect(v.reasons).not.toEqual([BUDGET_INCOMPLETE_REASON]);
    expect(isIncompleteVerdict(v)).toBe(false);
    const input = { finalReturnText: text, producerSessionID: "p", producerTier: "medium" };
    expect(incompleteVerdict(input, { progressNotes: false, budgetSnapshot: room })).toBeNull();
  });

  it("a prefix claim is still incomplete", () => {
    const input = { finalReturnText: "NEED MORE: budget\nDONE: later", producerSessionID: "p", producerTier: "medium" };
    expect(incompleteVerdict(input, { progressNotes: false, budgetSnapshot: room })?.reasons).toEqual([BUDGET_INCOMPLETE_REASON]);
  });
});
