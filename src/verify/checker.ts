// src/verify/checker.ts
//
// Temperature pinning is a WIRING concern (chat.params keyed to the grader session),
// out of scope for this pure module.
// Producer != grader is enforced structurally (GraderDispatch MUST create a FRESH session
// each call) AND defensively here by sessionID inequality check (step 5).

import type { Verdict } from "./types";
import { scrubText } from "../guard/scrub";
import { CRITERIA_BUDGET_CHARS, fitCriteria, omittedCriteriaText } from "./dod";

// ---------------------------------------------------------------------------
// Progress notes (§2.9 E8)
// ---------------------------------------------------------------------------

/** Reason prefix of a verdict that classifies the return as a progress note. */
export const INCOMPLETE_REASON_PREFIX = "incomplete:";

export const INCOMPLETE_REASON =
  `${INCOMPLETE_REASON_PREFIX} the delegate returned a progress note (no DONE:, NEED MORE: or ESCALATE:), not a result; resume the same delegation to let it finish`;

/** A return-contract marker at the start of a line (markdown emphasis and quotes allowed). */
const CONTRACT_MARKER_RE = /^[ \t>*_#`-]*(?:DONE|NEED MORE|NEED CONTEXT|SCOPE GROWTH|ESCALATE)[*_]*\s*:/m;

/** Wording of a return that announces more work instead of reporting a result. */
const PROGRESS_RE =
  /\b(?:I(?:'|\u2019)ll|I will|let me|I(?:'|\u2019)m going to|I am going to)\s+(?:now\s+|then\s+|next\s+)?(?:finish|continue|complete|proceed|keep going|wrap up)\b|\bcontinuing\b|\b(?:still|now) working\b|\bwork in progress\b/i;

/** Only the end of a return decides: a progress note ends by announcing the next step. */
const PROGRESS_TAIL_CHARS = 400;

/**
 * A progress-note return: no return-contract marker (DONE:, NEED MORE:,
 * ESCALATE:, …) on any line, and its last PROGRESS_TAIL_CHARS characters
 * announce further work ("I'll finish …", "continuing …"). Classified
 * `incomplete`, not `fail` (§2.9 E8).
 */
export function isProgressNote(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || CONTRACT_MARKER_RE.test(trimmed)) return false;
  return PROGRESS_RE.test(trimmed.slice(-PROGRESS_TAIL_CHARS));
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
}

export interface CheckerInput {
  criteria: string[];
  artefact: ArtefactView;
  producerTier: string;
  producerSessionID: string;
  /** Effective producer working directory; scopes the grader + informs its prompt. */
  workingDir?: string;
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

  // 1b. §2.9 E8: a progress note is incomplete, not a failure (unverifiable
  // never moves outcome evidence and never escalates the tier).
  if (isProgressNote(input.artefact.finalReturnText)) {
    return {
      pass: false,
      outcome: "unverifiable",
      method: "checker",
      reasons: [INCOMPLETE_REASON],
      caveats: [INCOMPLETE_REASON],
    };
  }

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
