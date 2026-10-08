// ---------------------------------------------------------------------------
// Outcome signals of role/tier assurance (plan §2.6, invariants I6 and I7) — pure functions.
//
// Every input is injected (the child's final assistant text, router-observed runs, edit timestamps, grader verdicts,
// earlier dispatches); the hook call sites belong to P2.1. Nothing here does I/O, reads a clock or touches the
// store. Runnable under Node type stripping, like every module of src/routing/outcomes/.
//
// Weights (§2.6): success — deterministic pass, or a router-observed acceptance run (exit 0) that started after the
// child's last edit: 1; an independent grader pass (grader tier ≥ producer tier AND another model): 0.5.
// Failure — deterministic fail: 1; independent grader fail: 0.5; an explicit `NEED MORE`/`ESCALATE` return without
// budget exhaustion or an authority request: 0.5; the same task dispatched again to a HIGHER tier within 30 min of the
// previous attempt: 0.5 on that attempt. `DONE` alone and a return without a contract prefix: no signal (I6, §2.9
// E8). Budget exhaustion and authority requests: recorded with no mass (I7). Self-report never moves evidence: the
// child's own `NEED MORE: budget` / `ESCALATE: authority` claim is not an exemption, only the guard's state is.
// ---------------------------------------------------------------------------

import type {
  DecisionFacts,
  DecisionRow,
  LadderStepKind,
  LoggedRoutingMode,
  RouteChoice,
  SignalKind,
  Verdict,
} from "./types";
import { LOG_ROW_VERSION, SIGNAL_REASON } from "./types";

// ---------------------------------------------------------------------------
// Observations and weights
// ---------------------------------------------------------------------------

/** Direction of a signal: success, failure, or recorded without evidence mass. */
export type SignalOutcome = "pass" | "fail" | "none";

/** One signal about one attempt. `weight` is the magnitude (≥ 0); the direction is `outcome`. */
export interface SignalObservation {
  readonly kind: SignalKind;
  readonly outcome: SignalOutcome;
  readonly weight: number;
}

/** §2.6 weights. */
export const SIGNAL_WEIGHTS = Object.freeze({
  deterministic: 1,
  run: 1,
  grader: 0.5,
  incomplete: 0.5,
  redispatch: 0.5,
  recorded: 0,
} as const);

/**
 * The largest success and failure mass a row of each kind may carry. Readers clamp rows to it, so a malformed or
 * forged row can neither create positive evidence from self-report (I6) nor a penalty for budget or authority (I7).
 */
export const SIGNAL_MASS_CAPS: Readonly<Record<SignalKind, { readonly positive: number; readonly negative: number }>> = Object.freeze({
  verdict: { positive: SIGNAL_WEIGHTS.deterministic, negative: SIGNAL_WEIGHTS.deterministic },
  run: { positive: SIGNAL_WEIGHTS.run, negative: 0 },
  grader: { positive: SIGNAL_WEIGHTS.grader, negative: SIGNAL_WEIGHTS.grader },
  incomplete: { positive: 0, negative: SIGNAL_WEIGHTS.incomplete },
  budget: { positive: 0, negative: 0 },
  authority: { positive: 0, negative: 0 },
  redispatch: { positive: 0, negative: SIGNAL_WEIGHTS.redispatch },
});

const KINDS: readonly string[] = Object.keys(SIGNAL_MASS_CAPS);

/** Structural check of an observation handed in by a caller (the ingest API validates before writing). */
export function isSignalObservation(x: unknown): x is SignalObservation {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.kind === "string" &&
    KINDS.includes(o.kind) &&
    (o.outcome === "pass" || o.outcome === "fail" || o.outcome === "none") &&
    typeof o.weight === "number" &&
    Number.isFinite(o.weight) &&
    o.weight >= 0
  );
}

/** Signed mass as written to a row: + success, − failure, 0 recorded only. */
export function signedWeight(observation: SignalObservation): number {
  if (observation.outcome === "none" || observation.weight === 0) return 0;
  return observation.outcome === "pass" ? observation.weight : -observation.weight;
}

/** Success and failure mass of a signal of `kind` with signed weight `weight`, clamped to {@link SIGNAL_MASS_CAPS}. */
export function signalMass(kind: SignalKind, weight: number | undefined): { readonly positive: number; readonly negative: number } {
  const caps = SIGNAL_MASS_CAPS[kind];
  if (caps === undefined || weight === undefined || !Number.isFinite(weight) || weight === 0) return { positive: 0, negative: 0 };
  return weight > 0
    ? { positive: Math.min(weight, caps.positive), negative: 0 }
    : { positive: 0, negative: Math.min(-weight, caps.negative) };
}

const observe = (kind: SignalKind, outcome: SignalOutcome, weight: number): SignalObservation => ({ kind, outcome, weight });

// ---------------------------------------------------------------------------
// Return contract of the child's final assistant text
// ---------------------------------------------------------------------------

export type ReturnPrefix = "done" | "need-more" | "escalate" | "none";

export interface ReturnContract {
  readonly prefix: ReturnPrefix;
  /** `NEED MORE: budget` / `ESCALATE: authority` (either prefix, either word). Informational: never an exemption. */
  readonly claim: "budget" | "authority" | null;
}

/** The host's `task` tool output wraps the child's text: `task_id: … <task_result> … </task_result>`. */
const TASK_RESULT_RE = /<task_result>([\s\S]*?)(?:<\/task_result>|$)/i;
const TASK_ID_RE = /^\s*task_id\s*:/i;
/** Leading decoration: markdown marks, list bullets, quotes, emoji, punctuation (anything but a letter or a digit). */
const LEAD_RE = /^[^\p{L}\p{N}]+/u;
const LIST_NUMBER_RE = /^\d+[.)]\s+/;
const PREFIX_RE = /^(DONE|NEED[\s_-]*MORE|ESCALATE)\b[*_`\s]*(?:[:.!\-\u2013\u2014]|$)[*_`\s]*(.*)$/i;
const CLAIM_RE = /^(budget|authority)\b/i;

/**
 * The return contract of a child's final assistant text (the unwrapped `subagent` result: a `<task_result>` wrapper and
 * leading `task_id:` lines are skipped): its first non-empty line, with leading markdown, list markers and emoji
 * stripped. `null` when there is no text at all. A first line without a contract prefix is `none`.
 */
export function parseReturnPrefix(text: string | null | undefined): ReturnContract | null {
  if (typeof text !== "string") return null;
  const wrapped = TASK_RESULT_RE.exec(text);
  const body = wrapped === null ? text : (wrapped[1] as string);
  const first = body.split(/\r?\n/).find((line) => line.trim() !== "" && !TASK_ID_RE.test(line));
  if (first === undefined) return null;
  const match = PREFIX_RE.exec(first.replace(LEAD_RE, "").replace(LIST_NUMBER_RE, ""));
  if (match === null) return { prefix: "none", claim: null };
  const word = (match[1] as string).toUpperCase();
  const prefix: ReturnPrefix = word === "DONE" ? "done" : word === "ESCALATE" ? "escalate" : "need-more";
  const claim = prefix === "done" ? null : CLAIM_RE.exec((match[2] as string).trim());
  return { prefix, claim: claim === null ? null : ((claim[1] as string).toLowerCase() as "budget" | "authority") };
}

/** A guard state as P2.1 hands it in: observed true/false, or not observed at all. */
export type GuardObservation = boolean | "unobserved";

export interface ReturnSignalInput {
  /** The child's final assistant text (see {@link parseReturnPrefix}). */
  readonly text: string | null | undefined;
  /** The guard observed the child's budget exhausted (P1.5). P2.1 must pass the guard's real state. */
  readonly budgetExhausted: GuardObservation;
  /** The child called `router_request_authority` (P1.6). P2.1 must pass the real state. */
  readonly authorityRequested: GuardObservation;
}

/**
 * Signal of the child's return:
 * - an observed authority request → `authority`, an observed budget exhaustion → `budget` (no mass, I7), whatever the text;
 * - `DONE`, no text, or no contract prefix (a progress note, §2.9 E8) → no signal (I6);
 * - an explicit `NEED MORE`/`ESCALATE` with both guards observed false → `incomplete` (failure 0.5). The child's own
 *   budget/authority claim does not exempt it (self-report never moves evidence);
 * - the same with either guard `unobserved` → no signal: it cannot be told apart from budget or authority (I7).
 */
export function returnSignal(input: ReturnSignalInput): SignalObservation | null {
  if (input.authorityRequested === true) return observe("authority", "none", SIGNAL_WEIGHTS.recorded);
  if (input.budgetExhausted === true) return observe("budget", "none", SIGNAL_WEIGHTS.recorded);
  const contract = parseReturnPrefix(input.text);
  if (contract === null || contract.prefix === "done" || contract.prefix === "none") return null;
  if (input.authorityRequested === "unobserved" || input.budgetExhausted === "unobserved") return null;
  return observe("incomplete", "fail", SIGNAL_WEIGHTS.incomplete);
}

// ---------------------------------------------------------------------------
// Deterministic verdicts, graders and router-observed runs
// ---------------------------------------------------------------------------

/** A deterministic verifier verdict: pass/fail weight 1; `unverifiable` is no signal. */
export function verdictSignal(outcome: Verdict): SignalObservation | null {
  if (outcome === "unverifiable") return null;
  return observe("verdict", outcome, SIGNAL_WEIGHTS.deterministic);
}

/** Rank of `tier` in `tiers` (cheapest first, the escalate ladder's order); null when absent. */
export function tierRank(tier: string | null | undefined, tiers: readonly string[]): number | null {
  if (typeof tier !== "string") return null;
  const rank = tiers.indexOf(tier);
  return rank < 0 ? null : rank;
}

interface ModelIds {
  /** `provider/model` without `#variant`, lowercased. */
  readonly full: string;
  /** Last path segment, `.`/`_`/`:` folded to `-` (`anthropic.claude-sonnet-4-5-v1:0` → `anthropic-claude-sonnet-4-5-v1-0`). */
  readonly bare: string;
}

function modelIds(model: string | null | undefined): ModelIds | null {
  if (typeof model !== "string") return null;
  const hash = model.lastIndexOf("#");
  const full = (hash >= 0 ? model.slice(0, hash) : model).trim().toLowerCase();
  const bare = full.slice(full.lastIndexOf("/") + 1).replace(/[._:]/g, "-");
  return full === "" || bare === "" ? null : { full, bare };
}

/**
 * Could the two ids name the same model? Same full id, same bare id across providers, or one bare id contained in the
 * other on `-` boundaries (a vendor prefix, a date or version suffix, a size suffix): ambiguous counts as the same.
 */
export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = modelIds(a);
  const y = modelIds(b);
  if (x === null || y === null) return true;
  if (x.full === y.full || x.bare === y.bare) return true;
  const bx = `-${x.bare}-`;
  const by = `-${y.bare}-`;
  return bx.includes(by) || by.includes(bx);
}

export interface GraderVerdictInput {
  readonly outcome: Verdict;
  readonly graderTier: string | null;
  readonly graderModel: string | null;
  readonly producerTier: string | null;
  readonly producerModel: string | null;
}

/**
 * An LLM grader's verdict counts (weight 0.5) only when the grader is independent: its tier is at least the producer's
 * and it is certainly another model ({@link sameModel} false). Unknown tiers or models cannot prove it: no signal.
 */
export function graderSignal(input: GraderVerdictInput, tiers: readonly string[]): SignalObservation | null {
  if (input.outcome === "unverifiable") return null;
  const graderRank = tierRank(input.graderTier, tiers);
  const producerRank = tierRank(input.producerTier, tiers);
  if (graderRank === null || producerRank === null || graderRank < producerRank) return null;
  if (sameModel(input.graderModel, input.producerModel)) return null;
  return observe("grader", input.outcome, SIGNAL_WEIGHTS.grader);
}

/** One router-observed `router_run` (P1.3). `at` is the run's START (epoch ms). `exitCode` null = killed or timed out. */
export interface RunRecord {
  readonly sessionID: string;
  readonly script: string;
  readonly exitCode: number | null;
  readonly at: number;
}

export interface RunSignalInput {
  readonly childSessionID: string;
  readonly runs: readonly RunRecord[];
  /** The child's edits were tracked for this attempt. `false` (not tracked) is not "no edits": no run signal. */
  readonly editsObserved: boolean;
  /** Epoch ms of the child's edits. One non-finite time makes the last edit unknown: no run signal. */
  readonly edits: readonly number[];
  /** The dispatch's acceptance commands (`routing.run` names). Empty → no run signal. */
  readonly acceptance: readonly string[];
}

/**
 * Success weight 1 when edits were tracked, EVERY acceptance command has a run by the child that started strictly after
 * its last edit, and the latest such run of each exited 0. A run that started before (or at) the last edit does not
 * cover it. A failing run is no signal (the deterministic verdict owns failures).
 */
export function runSignal(input: RunSignalInput): SignalObservation | null {
  if (input.editsObserved !== true) return null;
  const acceptance = [...new Set(input.acceptance)];
  if (acceptance.length === 0) return null;
  let lastEdit = Number.NEGATIVE_INFINITY;
  for (const t of input.edits) {
    if (!Number.isFinite(t)) return null;
    if (t > lastEdit) lastEdit = t;
  }
  for (const script of acceptance) {
    let latest: RunRecord | null = null;
    let latestFailed = false;
    for (const run of input.runs) {
      if (run.sessionID !== input.childSessionID || run.script !== script || !Number.isFinite(run.at) || run.at <= lastEdit) continue;
      if (latest === null || run.at > latest.at) {
        latest = run;
        latestFailed = run.exitCode !== 0;
      } else if (run.at === latest.at && run.exitCode !== 0) {
        latestFailed = true; // simultaneous runs: any failure wins
      }
    }
    if (latest === null || latestFailed) return null;
  }
  return observe("run", "pass", SIGNAL_WEIGHTS.run);
}

// ---------------------------------------------------------------------------
// Re-dispatch of the same task to a higher tier
// ---------------------------------------------------------------------------

/** Measured from the previous attempt's end when known, else from its start. */
export const REDISPATCH_WINDOW_MS = 30 * 60_000;
/** Dice coefficient over TASK words (and over identifier words, when any) at or above which two tasks are the same. */
export const REDISPATCH_SIMILARITY = 0.6;
/** Texts with fewer distinct words than this never match (too little to tell tasks apart). */
export const REDISPATCH_MIN_TOKENS = 3;
/** A line present in at least this many sibling dispatches (other tasks of the same parent) is boilerplate. */
export const SIBLING_SHARED_MIN = 2;
/** A sibling whose compared lines lie at least this much inside the compared pair is an earlier attempt of the same task. */
export const SAME_TASK_LINE_SHARE = 0.8;

export interface DispatchText {
  readonly decisionID: string;
  readonly parentSessionID: string;
  /** The attempt's child session; an attempt without one cannot be addressed and is never penalised. */
  readonly childSessionID: string | null;
  /** Task class (classifier facts). Must match; null (unknown) never matches. */
  readonly class: string | null;
  /** Role agent of the dispatch (roles mode). Must match (absent ≡ null). */
  readonly role?: string | null;
  readonly prompt: string;
  readonly tier: string | null;
  /** Epoch ms of the dispatch. */
  readonly at: number;
  /** Epoch ms the attempt ended (the parent's `subagent` call returned), when known. */
  readonly endedAt?: number | null;
  /** The dispatch resumed an existing child (`task_id`/`sessionID`, the authority ladder): never a re-dispatch. */
  readonly resume?: boolean;
  /** How the attempt ended, when known: an attempt that stopped on budget or authority is never penalised (I7). */
  readonly returned?: SignalKind | null;
}

export interface RedispatchMatch {
  /** The earlier attempt the failure belongs to (address it by `decisionID`, ingest `expectDecisionID`). */
  readonly previous: DispatchText;
  readonly similarity: number;
  readonly observation: SignalObservation;
}

export interface RedispatchOptions {
  readonly windowMs?: number;
  readonly threshold?: number;
}

const SECTION_RE =
  /^[\s>#*_]*(?:\d+\s*[.)]\s*)?[*_]*\s*(TASK|EXPECTED OUTCOME|REQUIRED TOOLS|TOOLS|MUST DO|MUST NOT DO|CONTEXT|ENVIRONMENT)(?:\s*\([^)\n]*\))?\s*[*_]*\s*:[*_]*(.*)$/;

interface PromptLines {
  /** Normalized non-empty content lines with their section (a header's inline content belongs to its section). */
  readonly lines: ReadonlyArray<{ readonly section: string | null; readonly text: string }>;
  /** The prompt has a TASK header. */
  readonly hasTask: boolean;
}

const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, " ");

function promptLines(prompt: string): PromptLines {
  let section: string | null = null;
  let hasTask = false;
  const lines: Array<{ section: string | null; text: string }> = [];
  for (const raw of prompt.split(/\r?\n/)) {
    const header = SECTION_RE.exec(raw);
    let content = raw;
    if (header !== null) {
      section = header[1] as string;
      if (section === "TASK") hasTask = true;
      content = header[2] as string;
    }
    const text = normalizeLine(content);
    if (text !== "") lines.push({ section, text });
  }
  return { lines, hasTask };
}

/** TASK section of a 7-section dispatch prompt (normalized lines), or null without a TASK header. */
export function taskSection(prompt: string): string | null {
  const parsed = promptLines(prompt);
  return parsed.hasTask ? parsed.lines.filter((l) => l.section === "TASK").map((l) => l.text).join("\n") : null;
}

/** Normalized lines shared with at least {@link SIBLING_SHARED_MIN} of `siblings` (boilerplate). */
export function sharedLines(siblings: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const sibling of siblings) {
    for (const text of new Set(promptLines(sibling).lines.map((l) => l.text))) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= SIBLING_SHARED_MIN).map(([text]) => text));
}

const TOKEN_RE = /[\p{L}\p{N}_]+(?:[.\-][\p{L}\p{N}_]+)*/gu;

/** Lowercased words; dotted/hyphenated identifiers stay one word (`p1.4`, `signals.ts`); 1-char words only when numeric. */
function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN_RE)) {
    const w = match[0];
    if (w.length >= 2 || /^\p{N}$/u.test(w)) out.add(w);
  }
  return out;
}

function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Dice coefficient of the two texts' word sets, capped by the Dice of their identifier words (words with a digit or a
 * dot: plan steps, versions, files) when either text has any: `P1.4` and `P1.5` are different tasks. 0 when either text
 * has fewer than {@link REDISPATCH_MIN_TOKENS} words.
 */
export function taskSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size < REDISPATCH_MIN_TOKENS || wb.size < REDISPATCH_MIN_TOKENS) return 0;
  const isIdentifier = (w: string): boolean => /[\p{N}.]/u.test(w);
  const ia = new Set([...wa].filter(isIdentifier));
  const ib = new Set([...wb].filter(isIdentifier));
  const all = dice(wa, wb);
  return ia.size + ib.size === 0 ? all : Math.min(all, dice(ia, ib));
}

/**
 * Has `current` dispatched again the task of an earlier attempt, to a higher tier, within the window? Candidates: the
 * same parent, class and role, another addressable child, dispatched before `current` and (when known) ended before it,
 * at most `windowMs` after the previous attempt's end (else its start). For each candidate, most recent first:
 * 1. siblings = the parent's other dispatches, minus earlier attempts of the same task (their compared lines lie
 *    ≥ {@link SAME_TASK_LINE_SHARE} inside the pair's), so a third dispatch is not judged against its own history;
 * 2. lines shared with ≥ {@link SIBLING_SHARED_MIN} siblings are boilerplate and removed BEFORE comparing;
 * 3. the TASK sections alone are compared (the whole remaining text when either prompt has no TASK header).
 * The most recent earlier attempt of the same task decides: a lower tier gets a failure (0.5); the same or a higher
 * tier, a resume, an unknown tier, or an attempt that ended on budget or authority gets nothing.
 */
export function detectRedispatch(
  current: DispatchText,
  earlier: readonly DispatchText[],
  tiers: readonly string[],
  options: RedispatchOptions = {},
): RedispatchMatch | null {
  if (current.resume === true || !Number.isFinite(current.at) || current.class === null) return null;
  const windowMs = options.windowMs ?? REDISPATCH_WINDOW_MS;
  const threshold = options.threshold ?? REDISPATCH_SIMILARITY;
  const family = earlier.filter((d) => d.parentSessionID === current.parentSessionID && d.decisionID !== current.decisionID);
  const role = current.role ?? null;

  const candidates = family
    .filter((d) => {
      if (d.childSessionID === null || d.childSessionID === current.childSessionID) return false;
      if (d.class !== current.class || (d.role ?? null) !== role || !(current.at > d.at)) return false;
      const ended = typeof d.endedAt === "number" && Number.isFinite(d.endedAt) ? d.endedAt : null;
      if (ended !== null && current.at < ended) return false; // still running: a parallel dispatch, not a re-dispatch
      return current.at - (ended ?? d.at) <= windowMs;
    })
    .sort((x, y) => y.at - x.at);

  const currentLines = promptLines(current.prompt);
  for (const previous of candidates) {
    const previousLines = promptLines(previous.prompt);
    const sectionMode = currentLines.hasTask && previousLines.hasTask;
    const compared = (p: PromptLines): string[] => p.lines.filter((l) => !sectionMode || l.section === "TASK").map((l) => l.text);
    const pair = new Set([...compared(currentLines), ...compared(previousLines)]);
    const siblings = family.filter((d) => {
      if (d === previous) return false;
      const own = compared(promptLines(d.prompt));
      if (own.length === 0) return false;
      return own.filter((t) => pair.has(t)).length / own.length < SAME_TASK_LINE_SHARE;
    });
    const boilerplate = sharedLines(siblings.map((d) => d.prompt));
    const text = (p: PromptLines): string => compared(p).filter((t) => !boilerplate.has(t)).join("\n");
    const similarity = taskSimilarity(text(currentLines), text(previousLines));
    if (similarity < threshold) continue;
    // The most recent earlier attempt of the same task decides.
    const from = tierRank(previous.tier, tiers);
    const to = tierRank(current.tier, tiers);
    if (from === null || to === null || to <= from) return null;
    if (previous.returned === "budget" || previous.returned === "authority") return null;
    return { previous, similarity, observation: observe("redispatch", "fail", SIGNAL_WEIGHTS.redispatch) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal rows
// ---------------------------------------------------------------------------

export interface SignalRowInput {
  /** ISO-8601 UTC. */
  readonly ts: string;
  /** Parent (orchestrator) session. */
  readonly sessionID: string;
  /** The annotated attempt's decision id (the row joins its dispatch row on it). */
  readonly decisionID: string;
  readonly mode: LoggedRoutingMode;
  readonly childSessionID: string | null;
  readonly facts: DecisionFacts;
  /** The attempt's dispatched key. */
  readonly chosen: RouteChoice;
  readonly step: LadderStepKind;
  /** The annotated attempt (ingest's dedupe identity; statistics dedupe on it too). */
  readonly attemptID?: string;
  readonly role?: string;
  readonly tier?: string;
}

/** Reason of a signal row: `note:signal:<kind>:<outcome>`. */
export function signalReason(observation: SignalObservation): string {
  return `${SIGNAL_REASON}${observation.kind}:${observation.outcome}`;
}

/**
 * A signal row: a decision row that annotates the attempt (reason `note:signal:…`, `signal`, `signalWeight`). It is never
 * a dispatch: `summarize` leaves it out, `summarizeRoles` counts it under the dispatch it joins. Readers before P1.4
 * drop it only through the C7 decision-id dedupe (it shares its dispatch's id): downgrading is unsupported.
 */
export function signalRow(input: SignalRowInput, observation: SignalObservation): DecisionRow {
  return {
    v: LOG_ROW_VERSION,
    kind: "decision",
    ts: input.ts,
    sessionID: input.sessionID,
    decisionID: input.decisionID,
    mode: input.mode,
    childSessionID: input.childSessionID,
    facts: input.facts,
    chosen: input.chosen,
    best: null,
    switched: false,
    pinned: false,
    unit: "ratio",
    costs: {},
    confidence: input.facts.confidence,
    reason: signalReason(observation),
    step: input.step,
    resume: false,
    ...(input.attemptID === undefined ? {} : { attemptID: input.attemptID }),
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.tier === undefined ? {} : { tier: input.tier }),
    signal: observation.kind,
    signalWeight: signedWeight(observation),
  };
}
