// src/verify/dod.ts
// Pure DoD (Definition of Done) schema, parser, and auto-inference.
// PURE: no imports from Node fs/os/path, no network, no SDK, no other project modules.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckKind = "run" | "fileExists" | "schemaMatch" | "testsPass" | "buildPasses" | "lintClean";

export interface Check {
  kind: CheckKind;
  command?: string;   // run/testsPass/buildPasses/lintClean (optional; runner supplies a default later)
  expect?: string;    // run: expected substring in output (optional)
  path?: string;      // fileExists/schemaMatch
  schema?: string;    // schemaMatch: inline JSON or a path
}

export type DoDKind = "deterministic" | "checker" | "none";
export type DoDSource = "explicit" | "inferred" | "annotation" | "none";

export interface DoD {
  kind: DoDKind;
  checks: Check[];        // [] when none/checker-only
  criteria: string[];     // [] when none
  deliverable: string | null;
  source: DoDSource;
  cwd?: string;
}

export interface InferHints {
  testCommand?: string | null;
  buildCommand?: string | null;
  lintCommand?: string | null;
  declaredPath?: string | null;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const VALID_CHECK_KINDS: ReadonlySet<string> = new Set<string>([
  "run", "fileExists", "schemaMatch", "testsPass", "buildPasses", "lintClean",
]);

const VALID_DOD_KINDS: ReadonlySet<string> = new Set<string>([
  "deterministic", "checker", "none",
]);

const OPEN_TAG_RE = /^\s*\[(acceptance|dod)\]\s*$/i;
const CLOSE_TAG_RE = /^\s*\[\/(acceptance|dod)\]\s*$/i;

// ---------------------------------------------------------------------------
// summarizeDispatch
// ---------------------------------------------------------------------------

/**
 * Router-protocol lines (§2.9 E8, QA-P15-1-8): a `[router]` / `[route …]` line and
 * the whole-line directives `CAP:<n|none>`, `VERIFY:<word>`, `VERIFY_WAIT:<value>`;
 * `reason:` only when a CAP line is present. They steer the router, they are
 * never the task's outcome. "Verify: …" / "Reason: …" task lines stay criteria.
 */
const ROUTER_LINE_RE = /^(?:\[router\]|\[route(?:\s[^\]]*)?\]$)/i;
const CAP_LINE_RE = /^CAP\s*:\s*(?:\d+|none)\s*$/i;
const VERIFY_LINE_RE = /^VERIFY:\s*\w+\s*$/;
const VERIFY_WAIT_LINE_RE = /^VERIFY_WAIT:\s*\S+\s*$/;
const REASON_LINE_RE = /^reason\s*:/i;

const WRAPPERS = new Set(["*", "_", "`"]);
const TRAILING_PUNCTUATION = new Set([".", ",", ";", "!"]);

/**
 * QA-P15-2-10: a directive wrapped in markdown (`**VERIFY:required**`,
 * `` `CAP:8` ``) or ending in punctuation (`VERIFY:required.`) is still a
 * directive. Linear scans, no backtracking.
 */
function unwrapDirective(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && WRAPPERS.has(line[start]!)) start++;
  while (end > start && (WRAPPERS.has(line[end - 1]!) || TRAILING_PUNCTUATION.has(line[end - 1]!))) end--;
  return line.slice(start, end).trim();
}

function isCapLine(line: string): boolean {
  return CAP_LINE_RE.test(unwrapDirective(line));
}

function isDirectiveLine(line: string, hasCap: boolean): boolean {
  const bare = unwrapDirective(line);
  return (
    ROUTER_LINE_RE.test(bare) ||
    CAP_LINE_RE.test(bare) ||
    VERIFY_LINE_RE.test(bare) ||
    VERIFY_WAIT_LINE_RE.test(bare) ||
    (hasCap && REASON_LINE_RE.test(bare))
  );
}

const SENTENCE_ENDS = new Set([".", "!", "?", "\u2026"]);

/**
 * QA-P15-1-7: a line over the budget keeps its leading WHOLE sentences that fit
 * (cut only between sentences: a sentence end followed by a space); "" when even
 * the first sentence does not fit.
 */
function leadingSentences(line: string, budget: number): string {
  if (codePointLength(line) <= budget) return line;
  let kept = 0;
  let points = 0;
  let segment = 0;
  for (let i = 0; i < line.length; i++) {
    if (!SENTENCE_ENDS.has(line[i]!) || line[i + 1] !== " ") continue;
    points += codePointLength(line.slice(segment, i + 1));
    if (points > budget) break;
    kept = i + 1;
    segment = i + 1;
  }
  return line.slice(0, kept);
}

/**
 * The dispatch's first non-empty line that is not a router directive,
 * whitespace-collapsed and never cut mid-sentence (§2.9 E8): whole when it fits
 * the verification budget, else its leading whole sentences that fit.
 */
export function summarizeDispatch(text: string, budget: number = CRITERIA_BUDGET_CHARS): string {
  const line = firstTaskLine(text);
  return line ? leadingSentences(line, budget) : "";
}

/** The dispatch's first non-empty line that is not a router directive, whitespace-collapsed; "" if none. */
function firstTaskLine(text: string): string {
  if (!text) return "";
  const lines = text.split("\n").map((line) => line.trim().replace(/\s+/g, " "));
  const hasCap = lines.some(isCapLine);
  for (const line of lines) {
    if (line && !isDirectiveLine(line, hasCap)) return line;
  }
  return "";
}

// ---------------------------------------------------------------------------
// fitCriteria — the verification text budget (§2.9 E8)
// ---------------------------------------------------------------------------

/** Budget for the criteria text sent to a grader, in code points. */
export const CRITERIA_BUDGET_CHARS = 4000;

/** Length in code points (a surrogate pair counts once), so the budget is multi-byte safe. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Whole criteria only: each criterion, in order, is kept when it fits in what is
 * left of the budget, otherwise omitted (never cut). One criterion longer than
 * the whole budget is omitted. `omitted` criteria are not graded.
 */
export function fitCriteria(
  criteria: readonly string[],
  budget: number = CRITERIA_BUDGET_CHARS,
): { criteria: string[]; omitted: number } {
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const criterion of criteria) {
    const length = codePointLength(criterion);
    if (used + length <= budget) {
      kept.push(criterion);
      used += length;
    } else {
      omitted += 1;
    }
  }
  return { criteria: kept, omitted };
}

/** "1 criterion omitted" / "n criteria omitted". */
export function omittedCriteriaText(omitted: number): string {
  return `${omitted} ${omitted === 1 ? "criterion" : "criteria"} omitted`;
}

// ---------------------------------------------------------------------------
// normalizeDoD
// ---------------------------------------------------------------------------

export function normalizeDoD(d: DoD): DoD {
  const checks: Check[] = Array.isArray(d.checks) ? [...d.checks] : [];
  const criteria: string[] = Array.isArray(d.criteria) ? [...d.criteria] : [];

  let kind: DoDKind;
  if (checks.length > 0) kind = "deterministic";
  else if (criteria.length > 0) kind = "checker";
  else kind = "none";

  const rawDeliverable = typeof d.deliverable === "string" ? d.deliverable.trim() : "";
  const deliverable: string | null = rawDeliverable.length > 0 ? rawDeliverable : null;

  const cwd = typeof d.cwd === "string" ? d.cwd.trim() : "";
  return { kind, checks, criteria, deliverable, source: d.source, ...(cwd ? { cwd } : {}) };
}

// ---------------------------------------------------------------------------
// parseKvPairs — internal helper
// ---------------------------------------------------------------------------

function parseKvPairs(s: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([\S]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1];
    const value = m[2] !== undefined ? m[2] : (m[3] ?? "");
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// parseAcceptanceBlock
// ---------------------------------------------------------------------------

export function parseAcceptanceBlock(text: string, source: DoDSource = "explicit"): DoD | null {
  const lines = text.split("\n");

  let openIdx = -1;
  let closeIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (OPEN_TAG_RE.test(lines[i])) {
      openIdx = i;
      break;
    }
  }

  if (openIdx === -1) return null;

  for (let i = openIdx + 1; i < lines.length; i++) {
    if (CLOSE_TAG_RE.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) return null;

  const innerLines = lines.slice(openIdx + 1, closeIdx);
  const checks: Check[] = [];
  const criteria: string[] = [];
  let deliverable: string | null = null;
  let kindHint: DoDKind | null = null;
  let cwd: string | undefined;

  for (const rawLine of innerLines) {
    const line = rawLine.trim();
    if (!line) continue;

    const lline = line.toLowerCase();

    if (lline.startsWith("check:")) {
      const rest = line.slice("check:".length).trim();
      const spaceIdx = rest.search(/\s/);
      const kindStr = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const remainder = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);

      if (!VALID_CHECK_KINDS.has(kindStr)) continue;

      const kvPairs = parseKvPairs(remainder);
      const check: Check = { kind: kindStr as CheckKind };
      if (kvPairs["command"] !== undefined) check.command = kvPairs["command"];
      if (kvPairs["expect"] !== undefined) check.expect = kvPairs["expect"];
      if (kvPairs["path"] !== undefined) check.path = kvPairs["path"];
      if (kvPairs["schema"] !== undefined) check.schema = kvPairs["schema"];
      checks.push(check);
    } else if (lline.startsWith("cwd:")) {
      const rest = line.slice("cwd:".length).trim().replace(/^(["'])(.*)\1$/, "$2").trim();
      if (rest) cwd = rest;
    } else if (lline.startsWith("criteria:")) {
      const rest = line.slice("criteria:".length).trim();
      if (rest) criteria.push(rest);
    } else if (lline.startsWith("deliverable:")) {
      const rest = line.slice("deliverable:".length).trim();
      deliverable = rest.length > 0 ? rest : null;
    } else if (lline.startsWith("kind:")) {
      const rest = line.slice("kind:".length).trim().toLowerCase();
      if (VALID_DOD_KINDS.has(rest)) {
        kindHint = rest as DoDKind;
      }
    }
  }

  return normalizeDoD({
    kind: kindHint !== null ? kindHint : "none",
    checks,
    criteria,
    deliverable,
    source,
    ...(cwd ? { cwd } : {}),
  });
}

// ---------------------------------------------------------------------------
// parseDoDFromDispatch / parseDoDFromAnnotation
// ---------------------------------------------------------------------------

export function parseDoDFromDispatch(dispatchText: string): DoD | null {
  return parseAcceptanceBlock(dispatchText, "explicit");
}

export function parseDoDFromAnnotation(annotationText: string): DoD | null {
  return parseAcceptanceBlock(annotationText, "annotation");
}

// ---------------------------------------------------------------------------
// inferDoD
// ---------------------------------------------------------------------------

export function inferDoD(dispatchText: string, tier: string, hints: InferHints): DoD {
  // tier accepted for forward-compat; not used in phase 2.1
  const lower = dispatchText.toLowerCase();

  // Classify by FIRST matching pattern
  let category: "bugfix" | "refactor" | "writeFile" | "impl" | "test" | "unknown";

  if (/\b(bug|fix|broken|regression|failing)\b/.test(lower)) {
    category = "bugfix";
  } else if (/\b(refactor|rename|extract|restructure|cleanup|clean up)\b/.test(lower)) {
    category = "refactor";
  } else if (
    /\b(write|generate|emit|scaffold)\b/.test(lower) &&
    hints.declaredPath != null &&
    hints.declaredPath.trim().length > 0
  ) {
    category = "writeFile";
  } else if (/\b(implement|add|feature|create|build|endpoint|function|component|fix)\b/.test(lower)) {
    category = "impl";
  } else if (/\b(test|spec|coverage)\b/.test(lower)) {
    category = "test";
  } else {
    category = "unknown";
  }

  const checks: Check[] = [];

  if (category === "bugfix" || category === "impl") {
    if (hints.buildCommand != null && hints.buildCommand.trim().length > 0) {
      checks.push({ kind: "buildPasses", command: hints.buildCommand });
    }
    if (hints.testCommand != null && hints.testCommand.trim().length > 0) {
      checks.push({ kind: "testsPass", command: hints.testCommand });
    }
  } else if (category === "refactor") {
    if (hints.buildCommand != null && hints.buildCommand.trim().length > 0) {
      checks.push({ kind: "buildPasses", command: hints.buildCommand });
    }
    if (hints.lintCommand != null && hints.lintCommand.trim().length > 0) {
      checks.push({ kind: "lintClean", command: hints.lintCommand });
    }
  } else if (category === "writeFile") {
    checks.push({ kind: "fileExists", path: hints.declaredPath!.trim() });
  } else if (category === "test") {
    if (hints.testCommand != null && hints.testCommand.trim().length > 0) {
      checks.push({ kind: "testsPass", command: hints.testCommand });
    }
  }
  // "unknown" and other fallthrough: checks stays empty

  const criteria: string[] = [];

  if (checks.length === 0) {
    const line = firstTaskLine(dispatchText);
    const summary = line ? leadingSentences(line, CRITERIA_BUDGET_CHARS) : "";
    // QA-P15-2-11: a first sentence over the budget is kept whole, never replaced
    // by the generic text; the grader budget (fitCriteria) omits it, so no
    // criterion is graded and the verdict is unverifiable.
    criteria.push(summary || line || "the delegated task is completed as described in the dispatch");
  }

  const rawPath = hints.declaredPath != null ? hints.declaredPath.trim() : "";
  const deliverable: string | null = rawPath.length > 0 ? rawPath : null;

  return normalizeDoD({
    kind: checks.length > 0 ? "deterministic" : "checker",
    checks,
    criteria,
    deliverable,
    source: "inferred",
  });
}

// ---------------------------------------------------------------------------
// isCheckable
// ---------------------------------------------------------------------------

export function isCheckable(d: DoD): boolean {
  return d.kind !== "none" && (d.checks.length > 0 || d.criteria.length > 0);
}
