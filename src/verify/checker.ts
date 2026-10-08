// src/verify/checker.ts
//
// Temperature pinning is a WIRING concern (chat.params keyed to the grader session),
// out of scope for this pure module.
// Producer != grader is enforced structurally (GraderDispatch MUST create a FRESH session
// each call) AND defensively here by sessionID inequality check (step 5).

import type { Verdict } from "./types";
import { scrubText } from "../guard/scrub";
import { CRITERIA_BUDGET_CHARS, fitCriteria, omittedCriteriaText } from "./dod";
import { captureBudget } from "../guard/enforce";
import type { BudgetSnapshot } from "../guard/enforce";

// ---------------------------------------------------------------------------
// Incomplete returns (§2.9 E8, I7)
// ---------------------------------------------------------------------------

/** Verdict reason: the return is a progress note. Matched exactly, never by prefix (QA-P15-1-6). */
export const INCOMPLETE_REASON =
  "incomplete: the delegate returned a progress note (no DONE:, NEED MORE: or ESCALATE:), not a result; resume the same delegation to let it finish";

/** Verdict reason: the producer stopped at its tool-call budget (I7: never a tier failure). */
export const BUDGET_INCOMPLETE_REASON =
  "incomplete: the delegate stopped at its tool-call budget (NEED MORE: budget), not with a result; resume the same delegation to let it finish";

const INCOMPLETE_REASONS: ReadonlySet<string> = new Set([INCOMPLETE_REASON, BUDGET_INCOMPLETE_REASON]);

/** One of the router's own incomplete reasons (a grader reason "incomplete: …" is not). */
export function isIncompleteReason(reason: string): boolean {
  return INCOMPLETE_REASONS.has(reason);
}

/**
 * QA-P15-2-4: a verdict carries `incomplete: true` structurally (set only by
 * incompleteVerdict), so caveats appended later (wiring.ts applyDispatchCaveats)
 * never turn it back into an ordinary unverifiable result.
 */
export type IncompleteFlag = { incomplete?: boolean };

/** An incomplete verdict (the structured flag). Never accepted (gate.ts gateResult). */
export function isIncompleteVerdict(verdict: object): boolean {
  return (verdict as IncompleteFlag).incomplete === true;
}

/** A return-contract marker at the start of a line (markdown emphasis and quotes allowed). */
const CONTRACT_MARKER_RE = /^[ \t>*_#`-]*(?:DONE|NEED MORE|NEED CONTEXT|SCOPE GROWTH|ESCALATE)[*_]*[ \t]*:/m;

/** `NEED MORE: budget` at the start of a line (QA-P15-1-2). */
const NEED_MORE_BUDGET_RE = /^[ \t>*_#`-]*NEED MORE[*_]*[ \t]*:[ \t*_`]*budget\b/im;

/** A first-person announcement of finishing or continuing the work (QA-P15-1-1). */
const ANNOUNCE_RE = /\b(?:I(?:'|\u2019)ll|I will|let me|I(?:'|\u2019)m going to|I am going to)\s+(?:now\s+|then\s+|next\s+)?(?:finish|continue)\b/i;

/**
 * Deferral to separate work, or a conditional offer ("If you'd like, I'll
 * continue…", "I'll continue once you confirm…", QA-P15-2-7): a finished
 * result, not a progress note.
 */
const DEFERRAL_RE = /\b(?:follow[- ]?up|later|separately|another (?:PR|change|task)|next (?:PR|release)|if|once|when|unless|would|want)\b/i;

const SENTENCE_END = new Set([".", "!", "?", "\u2026"]);

/** The last sentence of a text: after the last sentence end or line break that is followed by more text. */
function finalSentence(text: string): string {
  let end = text.length;
  while (end > 0 && (SENTENCE_END.has(text[end - 1]!) || /\s/.test(text[end - 1]!))) end--;
  let start = end;
  while (start > 0) {
    const ch = text[start - 1]!;
    if (ch === "\n" || (/\s/.test(ch) && start >= 2 && SENTENCE_END.has(text[start - 2]!))) break;
    start--;
  }
  return text.slice(start, end);
}

/**
 * A progress-note return (QA-P15-1-1): no return-contract marker on any line,
 * and its FINAL sentence is a first-person announcement of finishing or
 * continuing ("I'll finish the tests next", "let me continue with …") that is
 * not a deferral to separate work. Applied only to agents that follow the
 * return contract (runChecker), never in place of grading for others.
 */
export function isProgressNote(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || CONTRACT_MARKER_RE.test(trimmed)) return false;
  // QA-P15-2-7: a final question ("Shall I continue?") asks; it does not announce.
  if (trimmed.endsWith("?")) return false;
  const last = finalSentence(trimmed);
  return ANNOUNCE_RE.test(last) && !DEFERRAL_RE.test(last);
}

const DEFAULT_LADDER = ["fast", "medium", "heavy"];

function incomplete(reason: string): Verdict {
  const verdict: Verdict & IncompleteFlag = {
    pass: false, outcome: "unverifiable", method: "checker", reasons: [reason], caveats: [reason], incomplete: true,
  };
  return verdict;
}

/**
 * The guard state a `NEED MORE: budget` claim is checked against (QA-P15-2-2):
 * honoured when the guard did not track the session (enforcement off: nothing
 * can be checked), or the budget/refusals were used up, or the read-only cap
 * was reached. Any other claim is graded normally (P1.4 §2.6 scores it).
 */
function claimHonoured(snapshot: BudgetSnapshot): boolean {
  return !snapshot.tracked || snapshot.usedUp || snapshot.readCapReached === true;
}

/**
 * The incomplete verdict of a return, or null (§2.9 E8, I7), judged on the
 * budget snapshot captured when the task returned (`budget`, QA-P15-2-5; absent
 * → read now through `budgetSnapshot`, default the live guard):
 * - budget: the guard STOPPED the producer in that round (enforced) and it
 *   returned no contract marker, or a `NEED MORE: budget` line the snapshot
 *   backs (claimHonoured) — for every agent;
 * - progress note (only when `progressNotes`): for an agent that follows the
 *   return contract — `returnContract`, else a router tier of the ladder.
 * Incomplete is never accepted, never escalates and never moves evidence.
 */
export function incompleteVerdict(
  input: {
    finalReturnText: string;
    producerSessionID: string;
    producerTier: string;
    returnContract?: boolean;
    budget?: BudgetSnapshot;
  },
  opts: { progressNotes: boolean; ladder?: readonly string[]; budgetSnapshot?: (sessionID: string) => BudgetSnapshot },
): Verdict | null {
  const text = input.finalReturnText;
  const snapshot = input.budget ?? (opts.budgetSnapshot ?? captureBudget)(input.producerSessionID);
  if (
    (snapshot.stopped && !CONTRACT_MARKER_RE.test(text)) ||
    (NEED_MORE_BUDGET_RE.test(text) && claimHonoured(snapshot))
  ) {
    return incomplete(BUDGET_INCOMPLETE_REASON);
  }
  const contract = input.returnContract ?? (opts.ladder ?? DEFAULT_LADDER).includes(input.producerTier);
  if (opts.progressNotes && contract && isProgressNote(text)) return incomplete(INCOMPLETE_REASON);
  return null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArtefactView {
  finalReturnText: string;
  changedFiles: { path: string; status: string }[];
  changeBaseline?: "available" | "unavailable";
  declaredOutputs: string[];
}

export interface GraderRequest {
  tier: string;
  system: string;
  prompt: string;
  /**
   * Producer working directory. When present, the grader session MUST be scoped
   * to this directory so any file-existence / command claims the grader verifies
   * are checked against the producer's cwd, not the grader's own session cwd.
   */
  cwd?: string;
}

export interface GraderResult {
  sessionID: string;
  text: string;
}

/** MUST create a FRESH session each call */
export interface GraderDispatch {
  (req: GraderRequest): Promise<GraderResult>;
}

export interface CheckerDeps {
  dispatchGrader: GraderDispatch;
  ladder?: string[];             // default ["fast","medium","heavy"]
  minGraderTier?: string | null; // optional floor
  /** The guard's budget state of a producer session when no snapshot was captured. Default: the live guard (captureBudget). */
  budgetSnapshot?: (sessionID: string) => BudgetSnapshot;
}

export interface CheckerInput {
  criteria: string[];
  artefact: ArtefactView;
  producerTier: string;
  producerSessionID: string;
  /** Effective producer working directory; scopes the grader + informs its prompt. */
  workingDir?: string;
  /** The producer follows the DONE:/NEED MORE:/ESCALATE: return contract (role agents); absent = a router tier of the ladder. */
  returnContract?: boolean;
  /** The producer's budget state captured when its task returned (QA-P15-2-5). */
  budget?: BudgetSnapshot;
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

export function tierRank(tier: string, ladder: string[]): number {
  const i = ladder.indexOf(tier);
  return i < 0 ? ladder.length : i; // unknown tier ranks highest = safe
}

export function atLeastProducerTier(
  producerTier: string,
  opts?: { ladder?: string[]; minGraderTier?: string | null }
): string {
  const ladder = opts?.ladder ?? ["fast", "medium", "heavy"];
  let idx = tierRank(producerTier, ladder);
  if (opts?.minGraderTier != null) {
    idx = Math.max(idx, tierRank(opts.minGraderTier, ladder));
  }
  const clamped = Math.min(idx, ladder.length - 1);
  return ladder[clamped] ?? producerTier;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export const GRADER_SYSTEM =
  'You are an independent, skeptical verification grader. You did NOT produce this work and have no stake in it. Evaluate ONLY whether the artefact satisfies EACH acceptance criterion below. For every criterion, cite concrete evidence from the artefact. If the evidence is missing, ambiguous, partial, or you are uncertain for ANY reason, you MUST fail that criterion. Default to FAIL. Do not give the benefit of the doubt. Output ONLY a single JSON object on one line: {"pass": boolean, "reasons": string[]}. Set pass=true ONLY if every criterion is satisfied with cited evidence; otherwise pass=false with a reason per failed criterion.';

/** Upper bound on the working-directory string interpolated into the prompt. */
const MAX_WORKING_DIR_CHARS = 512;

/**
 * Make an attacker-influenced value safe to interpolate into a single prompt
 * line. The working directory reaches us from a delegate tool argument, i.e.
 * from model output, so it is untrusted text: scrubText strips secrets, and
 * collapsing newlines and control characters stops a crafted path from ending
 * the line and forging further instructions to the grader.
 */
function sanitizeOneLine(value: string): string {
  const cleaned = scrubText(value)
    // C0 controls, DEL, the C1 block, and the Unicode LINE/PARAGRAPH
    // SEPARATORS. U+2028 and U+2029 matter as much as \n here: plenty of
    // renderers and tokenizers treat them as line breaks, so leaving them in
    // would reopen the forged-instruction hole that stripping \n closes.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .trim();
  // A path has no legitimate reason to be long, and an unbounded one lets a
  // caller push the real criteria out of the grader's attention.
  return cleaned.length > MAX_WORKING_DIR_CHARS
    ? cleaned.slice(0, MAX_WORKING_DIR_CHARS) + "…(truncated)"
    : cleaned;
}

/** The note for criteria over the verification budget (prompt line and verdict caveat). */
function omittedNote(omitted: number): string {
  return `(${omittedCriteriaText(omitted)}: over the ${CRITERIA_BUDGET_CHARS}-character verification budget; not graded)`;
}

export function buildGradingPrompt(input: CheckerInput): { system: string; prompt: string } {
  const lines: string[] = [];

  if (input.workingDir) {
    lines.push(
      `Producer working directory: ${sanitizeOneLine(input.workingDir)}. Any file-existence or command claims MUST be verified against THIS directory, not your own session directory.`,
    );
    lines.push("");
  }

  lines.push("## Acceptance criteria (ALL must be satisfied)");
  // §2.9 E8: whole criteria only; those over the budget are named as omitted, not graded.
  const { criteria, omitted } = fitCriteria(input.criteria);
  for (let i = 0; i < criteria.length; i++) {
    lines.push(`${i + 1}. ${criteria[i]}`);
  }
  if (omitted > 0) lines.push(omittedNote(omitted));

  lines.push("");
  lines.push("## Artefact to evaluate");
  lines.push("### Final return text");
  lines.push(scrubText(input.artefact.finalReturnText) || "(empty)");

  lines.push("");
  lines.push(input.artefact.changeBaseline === "available"
    ? "Producer delta only: child editing-tool paths union newly changed paths since dispatch. Files outside this delta predate the dispatch and are not the producer's work. An empty delta is valid for a read-only task; require edits only if an acceptance criterion requires them."
    : "Dispatch-time changed-file snapshot unavailable (or current tree unavailable). Listed files are child editing-tool observations only, NOT an unqualified dirty tree. Do not attribute other dirty files to the producer or infer failure from an empty edit log for a read-only task.");
  lines.push("### Changed files");
  if (input.artefact.changedFiles.length > 0) {
    for (const f of input.artefact.changedFiles) {
      lines.push(`- ${f.status} ${scrubText(f.path)}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("");
  lines.push("### Declared outputs");
  if (input.artefact.declaredOutputs.length > 0) {
    for (const o of input.artefact.declaredOutputs) {
      lines.push(`- ${scrubText(o)}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("");
  lines.push("Respond with the JSON verdict now.");

  return { system: GRADER_SYSTEM, prompt: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Verdict parser
// ---------------------------------------------------------------------------

export function parseGraderVerdict(text: string): { pass: boolean; reasons: string[] } | null {
  try {
    let raw: string | null = null;

    // Try fenced ```json ... ``` first
    const fenced = /```json\s*([\s\S]*?)\s*```/.exec(text);
    if (fenced) {
      raw = fenced[1] ?? null;
    } else {
      // First "{" to last "}"
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        raw = text.slice(start, end + 1);
      }
    }

    if (raw === null) return null;

    const result = JSON.parse(raw) as unknown;
    if (typeof result !== "object" || result === null) return null;

    const r = result as Record<string, unknown>;
    if (typeof r["pass"] !== "boolean") return null;

    if (!("reasons" in r) || r["reasons"] === undefined) {
      return { pass: r["pass"] as boolean, reasons: [] };
    }

    if (!Array.isArray(r["reasons"])) return null;
    for (const item of r["reasons"]) {
      if (typeof item !== "string") return null;
    }

    return { pass: r["pass"] as boolean, reasons: r["reasons"] as string[] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runChecker(input: CheckerInput, deps: CheckerDeps): Promise<Verdict> {
  // 1. Empty criteria
  if (input.criteria.length === 0) {
    return { pass: false, method: "none", skipped: true, reasons: ["no criteria to grade"] };
  }

  // 1b. §2.9 E8 / I7: a budget stop, or a contract follower's progress note, is
  // incomplete — never accepted, never escalated, never outcome evidence.
  const stopped = incompleteVerdict(
    { ...input, finalReturnText: input.artefact.finalReturnText },
    { progressNotes: true, ladder: deps.ladder, budgetSnapshot: deps.budgetSnapshot },
  );
  if (stopped) return stopped;

  // 1c. §2.9 E8: every criterion is over the verification budget — nothing gradable.
  const { criteria: gradable, omitted } = fitCriteria(input.criteria);
  if (gradable.length === 0) {
    const reason = `no criterion fits the verification budget ${omittedNote(omitted)}`;
    return { pass: false, outcome: "unverifiable", method: "checker", reasons: [reason], caveats: [reason] };
  }

  // 2. Determine grader tier
  const graderTier = atLeastProducerTier(input.producerTier, {
    ladder: deps.ladder,
    minGraderTier: deps.minGraderTier,
  });

  // 3. Build prompt
  const { system, prompt } = buildGradingPrompt(input);

  // 4. Dispatch grader
  let res: GraderResult;
  try {
    res = await deps.dispatchGrader({
      tier: graderTier,
      system,
      prompt,
      ...(input.workingDir ? { cwd: input.workingDir } : {}),
    });
  } catch (err) {
    return {
      pass: false,
      outcome: "unverifiable",
      method: "checker",
      reasons: [scrubText("grader dispatch failed: " + String(err))],
    };
  }

  // 5. Independence check (fail-closed)
  if (res.sessionID === input.producerSessionID || !res.sessionID) {
    return {
      pass: false,
      method: "checker",
      reasons: [
        "grader session is not independent of the producer (producer=grader); refusing to accept",
      ],
    };
  }

  // 6. Parse verdict
  const parsed = parseGraderVerdict(res.text);
  if (parsed === null) {
    return {
      pass: false,
      method: "checker",
      reasons: [
        "could not parse grader verdict; defaulting to FAIL",
        scrubText(res.text.slice(0, 300)),
      ],
    };
  }

  // 7. Return verdict. Criteria omitted from grading (§2.9 E8) make a pass
  // unverifiable with a caveat: what was not graded is not verified.
  const partial = omitted > 0;
  return {
    pass: parsed.pass === true && !partial,
    outcome: parsed.pass ? (partial ? "unverifiable" : "pass") : "fail",
    method: "checker",
    reasons: parsed.reasons.map(scrubText),
    evidence: scrubText("grader=" + graderTier),
    ...(partial ? { caveats: [omittedNote(omitted)] } : {}),
  };
}
