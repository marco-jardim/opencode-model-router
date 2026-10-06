/**
 * Deterministic task classifier (M2, rules layer) — design R1–R14 of
 * `docs/qa/cost-aware-routing/phase-1.2.md`.
 *
 * Pure: no I/O, no clock, no randomness. Every regex is compiled once at module
 * load (a `gi` copy of the `i` regexes of the `types.ts` table); the only
 * per-call allocations are strings, sets and the result object.
 *
 * Two regex-state rules keep this module safe to call repeatedly:
 *  - the compiled `gi` copies are private to this module and every scan resets
 *    `lastIndex` before and after use (the loops below are synchronous);
 *  - the GLOBAL `SHAPE_GATES.pathToken` / `bareFilename` regexes that
 *    `classifyTrivial` also uses are touched only through `String#match`.
 */

import type { RouterConfig } from "../../router/config";
import { normTaskKw } from "../../router/sessions";
import {
  ACCEPTANCE_BLOCK_RE,
  CLASS_BASE_RISK,
  CLASS_COST_RANK,
  CLASS_EXCLUDED_SECTIONS,
  CLASS_IMPLIED_NEEDS,
  CONFIDENCE,
  CWD_LINE_RE,
  DIRECTIVE_LINE_RES,
  ENGLISH_MARKERS,
  HIGH_RISK_CASE_SENSITIVE_TERMS,
  HIGH_RISK_TERMS,
  KEYWORD_RULES,
  MEDIUM_RISK_TERMS,
  NEED_RULES,
  NEEDS,
  NEEDS_EXCLUDED_SECTIONS,
  NEGATION_PREFIX_RE,
  NEGATION_WINDOW_CHARS,
  NON_ASCII_LETTER_SHARE,
  NON_ENGLISH_MARKERS,
  NON_ENGLISH_MIN_LETTERS,
  NON_ENGLISH_MIN_WORDS,
  POSIX_ABS_PATH_RE,
  REPO_SCOPE_TERMS,
  RISKS,
  RULES_MAX_CHARS,
  SECTION_HEADER_RE,
  SHAPE_GATES,
  TEMPLATE_MIN_SECTIONS,
  TEMPLATE_SECTION_LABELS,
  TIER_DEFAULT_CLASS,
  WINDOWS_ABS_PATH_RE,
  type Need,
  type Risk,
  type RulesAnalysis,
  type Scope,
  type ShapeFacts,
  type StaticTier,
  type TaskClass,
  type TaskFacts,
} from "./types";

type RulesConfig = Pick<RouterConfig, "taskPatterns">;

// ---------------------------------------------------------------------------
// Module-load compilation
// ---------------------------------------------------------------------------

function globalCopy(re: RegExp): RegExp {
  return new RegExp(re.source, "gi");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledRule {
  readonly pattern: string;
  readonly class: TaskClass;
  readonly res: readonly RegExp[];
}

/**
 * One compiled rule per `KEYWORD_RULES` entry: its terms plus the pattern's
 * stem. Two entries share the pattern `read` (search and recon); the stem
 * belongs to the FIRST one only, otherwise every "read X" would also credit
 * `recon` and a single lookup could never be classified `search`.
 */
const COMPILED_RULES: readonly CompiledRule[] = (() => {
  const stemmed = new Set<string>();
  return KEYWORD_RULES.map((rule): CompiledRule => {
    const res = rule.terms.map(globalCopy);
    const stem = normTaskKw(rule.pattern);
    if (stem.length >= 3 && !stemmed.has(rule.pattern)) {
      res.push(new RegExp("\\b" + escapeRegExp(stem) + "\\b", "gi"));
    }
    stemmed.add(rule.pattern);
    return { pattern: rule.pattern, class: rule.class, res };
  });
})();

interface CompiledNeed {
  readonly need: Need;
  readonly implies: readonly Need[];
  readonly res: readonly RegExp[];
}

const COMPILED_NEEDS: readonly CompiledNeed[] = NEED_RULES.map((rule) => ({
  need: rule.need,
  implies: rule.implies ?? [],
  res: rule.terms.map(globalCopy),
}));

const HIGH_RISK_RES: readonly RegExp[] = [
  ...HIGH_RISK_TERMS.map(globalCopy),
  ...HIGH_RISK_CASE_SENSITIVE_TERMS.map((re) => new RegExp(re.source, "g")),
];
const MEDIUM_RISK_RES: readonly RegExp[] = MEDIUM_RISK_TERMS.map(globalCopy);
const REPO_SCOPE_RES: readonly RegExp[] = REPO_SCOPE_TERMS.map(globalCopy);
const ABS_PATH_RES: readonly RegExp[] = [WINDOWS_ABS_PATH_RE, POSIX_ABS_PATH_RE].map(globalCopy);
const ACCEPTANCE_ALL_RE = new RegExp(ACCEPTANCE_BLOCK_RE.source, "gi");

/**
 * Path-like tokens, removed before the needs vocabulary runs (external_dir is
 * the exception: it reads paths). `D:\git\repo` and `~/git/x` are places, not
 * the `git` tool; "read/search/write" is a list, not a write (QA-1.2-5). URLs
 * are left alone: a candidate may not start right after `:` or `/`.
 */
const PATHLIKE_RES: readonly RegExp[] = [
  globalCopy(WINDOWS_ABS_PATH_RE),
  /(?<![\w:/.~-])\/[\w.@+-]+(?:\/[\w.@+-]*)*/g,
  /(?<!\w)~[\\/][^\s"'`]*/g,
  /(?<![\w:/\\.~-])[\w.@+-]+(?:[\\/][\w.@+-]*)+/g,
];

function withoutPaths(text: string): string {
  let out = text;
  for (const re of PATHLIKE_RES) out = out.replace(re, " ");
  return out;
}

const TEMPLATE_LABELS: ReadonlySet<string> = new Set(TEMPLATE_SECTION_LABELS);
const CLASS_EXCLUDED: ReadonlySet<string> = new Set(CLASS_EXCLUDED_SECTIONS);
const NEEDS_EXCLUDED: ReadonlySet<string> = new Set(NEEDS_EXCLUDED_SECTIONS);
const ENGLISH_WORDS: ReadonlySet<string> = new Set(ENGLISH_MARKERS);
const NON_ENGLISH_WORDS: ReadonlySet<string> = new Set(NON_ENGLISH_MARKERS);

/** `tier:pattern` pairs of the table; a user entry equal to one of them is a built-in. */
const BUILTIN_PAIRS: ReadonlySet<string> = new Set(
  KEYWORD_RULES.map((rule) => `${rule.tier}\u0000${rule.pattern}`),
);

// ---------------------------------------------------------------------------
// Matching and negation (R5)
// ---------------------------------------------------------------------------

function isClauseBoundary(code: number): boolean {
  // . ; : ! ? , \n
  return (
    code === 46 || code === 59 || code === 58 || code === 33 || code === 63 || code === 44 || code === 10
  );
}

/** R5: is the occurrence of a term at `index` of `s` preceded by a negator in its clause? */
function isNegatedAt(s: string, index: number): boolean {
  let start = index - NEGATION_WINDOW_CHARS;
  if (start < 0) start = 0;
  for (let k = index - 1; k >= start; k--) {
    if (isClauseBoundary(s.charCodeAt(k))) {
      start = k + 1;
      break;
    }
  }
  if (start >= index) return false;
  return NEGATION_PREFIX_RE.test(s.slice(start, index));
}

/**
 * Visit every occurrence of `re` (a private `g` regex) in `s` until `visit`
 * returns true. Resets `lastIndex` on every exit so no state leaks between calls.
 */
function scan(re: RegExp, s: string, visit: (match: RegExpExecArray) => boolean): boolean {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (visit(m)) {
      re.lastIndex = 0;
      return true;
    }
  }
  re.lastIndex = 0;
  return false;
}

/** True when at least one term has an occurrence (not negated, unless `negation` is false). */
function hasHit(res: readonly RegExp[], s: string, negation: boolean): boolean {
  for (const re of res) {
    if (scan(re, s, (m) => !negation || !isNegatedAt(s, m.index))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// User taskPatterns not in the table (R6)
// ---------------------------------------------------------------------------

interface CustomPattern {
  readonly re: RegExp;
  readonly class: TaskClass;
  readonly anchor: string;
}

const CUSTOM_TIERS: readonly StaticTier[] = ["fast", "medium", "heavy"];
const NO_CUSTOM: readonly CustomPattern[] = [];
const CUSTOM_CACHE = new WeakMap<object, readonly CustomPattern[]>();

function customPatterns(taskPatterns: RulesConfig["taskPatterns"]): readonly CustomPattern[] {
  if (typeof taskPatterns !== "object" || taskPatterns === null) return NO_CUSTOM;
  const cached = CUSTOM_CACHE.get(taskPatterns);
  if (cached) return cached;
  const out: CustomPattern[] = [];
  for (const tier of CUSTOM_TIERS) {
    const list: unknown = taskPatterns[tier];
    if (!Array.isArray(list)) continue;
    for (const kw of list) {
      if (typeof kw !== "string") continue;
      if (BUILTIN_PAIRS.has(`${tier}\u0000${kw}`)) continue;
      const stem = normTaskKw(kw);
      if (stem.length < 3) continue;
      out.push({
        re: new RegExp("\\b" + escapeRegExp(stem) + "\\b", "gi"),
        class: TIER_DEFAULT_CLASS[tier],
        anchor: `custom:${tier}:${kw}`,
      });
    }
  }
  CUSTOM_CACHE.set(taskPatterns, out);
  return out;
}

// ---------------------------------------------------------------------------
// R4 — shape gates
// ---------------------------------------------------------------------------

/** classifyTrivial's shape clauses 5–7, on the string given (R4). Length is reported, never a class signal. */
export function shapeOf(raw: string): ShapeFacts {
  const lower = raw.toLowerCase();
  const paths = new Set<string>((lower.match(SHAPE_GATES.pathToken) ?? []).map((p) => p.trim()));
  for (const bare of raw.match(SHAPE_GATES.bareFilename) ?? []) paths.add(bare.toLowerCase());
  const multiStep = SHAPE_GATES.multiStep.test(raw);
  const enumeration = SHAPE_GATES.enumeration.test(raw);
  const distributive = SHAPE_GATES.distributive.test(raw);
  const imperativeLines = raw
    .split(/\r?\n/)
    .filter((line) => SHAPE_GATES.imperativeLine.test(line)).length;
  const breadth =
    multiStep ||
    enumeration ||
    distributive ||
    imperativeLines > 1 ||
    paths.size > SHAPE_GATES.maxSingleShotPaths;
  return {
    chars: raw.length,
    paths: paths.size,
    multiStep,
    enumeration,
    distributive,
    imperativeLines,
    breadth,
    singleShot: !breadth && raw.length <= SHAPE_GATES.maxSingleShotChars,
  };
}

// ---------------------------------------------------------------------------
// R1–R3 — text preparation, sections, cwd
// ---------------------------------------------------------------------------

/** R1: drop directive lines, then every `[acceptance]` block. */
function prepareBody(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (DIRECTIVE_LINE_RES.some((re) => re.test(line))) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(ACCEPTANCE_ALL_RE, "\n");
}

interface Sections {
  readonly templated: boolean;
  readonly focusText: string;
  readonly needsText: string;
}

/**
 * R2: split a dispatch template into sections; text outside templates is used
 * whole. Excluded sections hide only their own paragraph: the text after the
 * first blank line of such a section is included again.
 */
function splitSections(body: string): Sections {
  const lines = body.split("\n");
  const headers: Array<{ line: number; label: string; prefixLength: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_HEADER_RE.exec(lines[i]!);
    if (m === null) continue;
    const label = (m[1] ?? "").trim();
    if (TEMPLATE_LABELS.has(label)) headers.push({ line: i, label, prefixLength: m[0].length });
  }
  if (headers.length < TEMPLATE_MIN_SECTIONS) {
    return { templated: false, focusText: body, needsText: body };
  }
  const focus: string[] = [];
  const needs: string[] = [];
  const first = headers[0]!.line;
  if (first > 0) {
    const preamble = lines.slice(0, first).join("\n");
    focus.push(preamble);
    needs.push(preamble);
  }
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h]!;
    const end = h + 1 < headers.length ? headers[h + 1]!.line : lines.length;
    const content = [lines[header.line]!.slice(header.prefixLength), ...lines.slice(header.line + 1, end)];
    // An excluded section ends at its first blank line: whatever follows is task text again (QA-1.2-4).
    const blank = content.findIndex((line, i) => i > 0 && line.trim() === "");
    const afterBlank = blank === -1 ? "" : content.slice(blank + 1).join("\n");
    const whole = content.join("\n");
    focus.push(CLASS_EXCLUDED.has(header.label) ? afterBlank : whole);
    needs.push(NEEDS_EXCLUDED.has(header.label) ? afterBlank : whole);
  }
  return { templated: true, focusText: focus.join("\n"), needsText: needs.join("\n") };
}

function trimPathTail(path: string): string {
  return path.replace(/[.,;:)]+$/, "");
}

/** R3: the dispatch working directory, from the caller or the `Working directory:` line. */
function resolveCwd(body: string, ctx: { cwd?: string } | undefined): string | null {
  const given = ctx?.cwd;
  if (typeof given === "string" && given.trim() !== "") return given.trim();
  const m = CWD_LINE_RE.exec(body);
  if (m?.[1]) {
    const found = trimPathTail(m[1]);
    if (found !== "") return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// R9 helpers — external_dir from absolute paths
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function hasExternalPath(needsText: string, cwd: string): boolean {
  const base = normalizePath(cwd);
  for (const re of ABS_PATH_RES) {
    const found = scan(re, needsText, (m) => {
      if (isNegatedAt(needsText, m.index)) return false;
      const path = normalizePath(trimPathTail(m[0]));
      return !(path === base || path.startsWith(base + "/"));
    });
    if (found) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// R13 — language gate
// ---------------------------------------------------------------------------

function isNonEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu);
  if (letters !== null && letters.length >= NON_ENGLISH_MIN_LETTERS) {
    let nonAscii = 0;
    for (const letter of letters) {
      if ((letter.codePointAt(0) ?? 0) > 0x7f) nonAscii++;
    }
    if (nonAscii / letters.length > NON_ASCII_LETTER_SHARE) return true;
  }
  const words = text.toLowerCase().match(/\p{L}+/gu);
  if (words !== null && words.length >= NON_ENGLISH_MIN_WORDS) {
    let english = 0;
    let other = 0;
    for (const word of words) {
      if (ENGLISH_WORDS.has(word)) english++;
      else if (NON_ENGLISH_WORDS.has(word)) other++;
    }
    return other > english;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function orderedNeeds(set: ReadonlySet<Need>): Need[] {
  return NEEDS.filter((need) => set.has(need));
}

function maxRisk(a: Risk, b: Risk): Risk {
  return RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// analyzeRules / classifyByRules
// ---------------------------------------------------------------------------

export function analyzeRules(
  text: string,
  cfg: RulesConfig,
  ctx?: { cwd?: string },
): RulesAnalysis {
  const raw = String(text ?? "").slice(0, RULES_MAX_CHARS);
  const body = prepareBody(raw);
  const cwd = resolveCwd(body, ctx);
  const { templated, focusText, needsText } = splitSections(body);
  const shape = shapeOf(focusText);
  const nonEnglish = isNonEnglish(focusText);

  // R6 — class candidates
  const candidates = new Set<TaskClass>();
  const anchors = new Set<string>();
  for (const rule of COMPILED_RULES) {
    if (hasHit(rule.res, focusText, true)) {
      candidates.add(rule.class);
      anchors.add(rule.pattern);
    }
  }
  for (const custom of customPatterns(cfg?.taskPatterns)) {
    if (hasHit([custom.re], focusText, true)) {
      candidates.add(custom.class);
      anchors.add(custom.anchor);
    }
  }

  // R7 — lookup family: search and recon are one family resolved by shape
  if (candidates.has("search") || candidates.has("recon")) {
    const recon = candidates.has("recon");
    candidates.delete("search");
    candidates.delete("recon");
    candidates.add(recon || shape.breadth ? "recon" : "search");
  }
  const matched = [...candidates].sort((a, b) => CLASS_COST_RANK[b] - CLASS_COST_RANK[a]);
  const taskClass: TaskClass = matched[0] ?? "other";

  // R8 — confidence
  let confidence: number =
    matched.length === 0
      ? CONFIDENCE.rulesNone
      : matched.length === 1
        ? CONFIDENCE.rulesSingle
        : CONFIDENCE.rulesMultiple;

  // R9 — needs
  const needs = new Set<Need>();
  const pathFreeText = withoutPaths(needsText);
  for (const rule of COMPILED_NEEDS) {
    if (hasHit(rule.res, rule.need === "external_dir" ? needsText : pathFreeText, true)) {
      needs.add(rule.need);
      for (const implied of rule.implies) needs.add(implied);
    }
  }
  if (cwd !== null && !needs.has("external_dir") && hasExternalPath(needsText, cwd)) {
    needs.add("external_dir");
  }
  for (const implied of CLASS_IMPLIED_NEEDS[taskClass]) needs.add(implied);

  // R10 — scope
  const scope: Scope = hasHit(REPO_SCOPE_RES, focusText, true)
    ? "repo"
    : shape.breadth
      ? "multi"
      : "single";

  // R11 — risk (negation ignored for the high-risk vocabulary)
  let risk: Risk = CLASS_BASE_RISK[taskClass];
  // Risk vocabulary is scanned over the WHOLE body, every section included: a section header must
  // not hide "production", "credentials" or "deploy" from the risk estimate (QA-1.2-4).
  if (hasHit(HIGH_RISK_RES, body, false)) risk = "high";
  else if (hasHit(MEDIUM_RISK_RES, body, false)) risk = maxRisk(risk, "medium");
  if (
    (scope === "repo" && needs.has("edit")) ||
    (needs.has("external_dir") && needs.has("edit")) ||
    needs.has("network")
  ) {
    risk = maxRisk(risk, "medium");
  }

  // R12 — caps and output
  if (nonEnglish) confidence = Math.min(confidence, CONFIDENCE.nonEnglishCap);
  if (taskClass === "mechanical" && risk === "high") {
    confidence = Math.min(confidence, CONFIDENCE.mechanicalHighRiskCap);
  }

  const facts: TaskFacts = Object.freeze({
    class: taskClass,
    risk,
    scope,
    needs: Object.freeze(orderedNeeds(needs)),
    confidence: round2(confidence),
    source: "rules" as const,
  });
  return { facts, matched, anchors: [...anchors], shape, nonEnglish, templated };
}

export function classifyByRules(text: string, cfg: RulesConfig, ctx?: { cwd?: string }): TaskFacts {
  return analyzeRules(text, cfg, ctx).facts;
}
