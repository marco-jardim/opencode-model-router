// ---------------------------------------------------------------------------
// Outcome signals of role/tier assurance (plan §2.6, invariants I6 and I7) — pure functions.
//
// Every input is injected (the child's final text, router-observed runs, edit timestamps, grader verdicts,
// earlier dispatches); the hook call sites belong to P2.1. Nothing here does I/O, reads a clock or touches the
// store. Runnable under Node type stripping, like every module of src/routing/outcomes/.
//
// Weights (§2.6): success — deterministic pass, or a router-observed acceptance run (exit 0) that started after the
// child's last edit: 1; an independent grader pass (grader tier ≥ producer tier AND another model): 0.5.
// Failure — deterministic fail: 1; independent grader fail: 0.5; an unfinished return (`NEED MORE`, `ESCALATE`, a
// progress note) without budget exhaustion or an authority request: 0.5; the same task dispatched again to a HIGHER
// tier within 30 min: 0.5 on the previous attempt. `DONE` alone: no signal (I6). Budget exhaustion and authority
// requests: recorded with no mass (I7).
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
// Return contract of the child's final text
// ---------------------------------------------------------------------------

export type ReturnPrefix = "done" | "need-more" | "escalate" | "none";

export interface ReturnContract {
  readonly prefix: ReturnPrefix;
  /** `NEED MORE: budget` / `ESCALATE: authority` (either prefix, either word). */
  readonly claim: "budget" | "authority" | null;
}

/** Leading markdown a model may wrap the prefix in (`**DONE:**`, `> DONE:`, `## DONE:`, `` `DONE:` ``). */
const DECORATION_RE = /^[\s>#*_`]+/;
const PREFIX_RE = /^(DONE|NEED[\s_-]*MORE|ESCALATE)[*_`\s]*:[*_`\s]*(.*)$/i;
const CLAIM_RE = /^(budget|authority)\b/i;

/**
 * The return contract of a child's final text: its first non-empty line. `null` when there is no text at all
 * (nothing to judge). A first line without a contract prefix is a progress note (`none`).
 */
export function parseReturnPrefix(text: string | null | undefined): ReturnContract | null {
  if (typeof text !== "string") return null;
  const first = text.split(/\r?\n/).find((line) => line.trim() !== "");
  if (first === undefined) return null;
  const match = PREFIX_RE.exec(first.replace(DECORATION_RE, ""));
  if (match === null) return { prefix: "none", claim: null };
  const word = (match[1] as string).toUpperCase();
  const prefix: ReturnPrefix = word === "DONE" ? "done" : word === "ESCALATE" ? "escalate" : "need-more";
  const claim = prefix === "done" ? null : CLAIM_RE.exec((match[2] as string).trim());
  return { prefix, claim: claim === null ? null : ((claim[1] as string).toLowerCase() as "budget" | "authority") };
}

export interface ReturnSignalInput {
  /** The child's final text (the parent's `subagent` result). */
  readonly text: string | null | undefined;
  /**
   * The guard observed the child's budget exhausted (P1.5). `true` records `budget` whatever the text says; `false`
   * refuses a `NEED MORE: budget` claim (it becomes `incomplete`); absent = not observed, the claim is taken.
   */
  readonly budgetExhausted?: boolean;
  /** The child called `router_request_authority` (P1.6). Same three states as `budgetExhausted`. */
  readonly authorityRequested?: boolean;
}

/**
 * Signal of the child's return: `authority` / `budget` (recorded, no mass, I7), `incomplete` (failure 0.5) for an
 * unfinished return or a progress note, or `null` for `DONE` (no positive mass from self-report, I6) and for no text.
 */
export function returnSignal(input: ReturnSignalInput): SignalObservation | null {
  if (input.authorityRequested === true) return observe("authority", "none", SIGNAL_WEIGHTS.recorded);
  if (input.budgetExhausted === true) return observe("budget", "none", SIGNAL_WEIGHTS.recorded);
  const contract = parseReturnPrefix(input.text);
  if (contract === null || contract.prefix === "done") return null;
  if (contract.claim === "authority" && input.authorityRequested !== false) return observe("authority", "none", SIGNAL_WEIGHTS.recorded);
  if (contract.claim === "budget" && input.budgetExhausted !== false) return observe("budget", "none", SIGNAL_WEIGHTS.recorded);
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

/** `provider/model` without its `#variant`, case-folded: two variants of one model are the same model. */
function modelIdentity(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const hash = model.lastIndexOf("#");
  const bare = (hash >= 0 ? model.slice(0, hash) : model).trim().toLowerCase();
  return bare === "" ? null : bare;
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
 * and its model differs. Unknown tiers or models cannot prove independence: no signal.
 */
export function graderSignal(input: GraderVerdictInput, tiers: readonly string[]): SignalObservation | null {
  if (input.outcome === "unverifiable") return null;
  const graderRank = tierRank(input.graderTier, tiers);
  const producerRank = tierRank(input.producerTier, tiers);
  if (graderRank === null || producerRank === null || graderRank < producerRank) return null;
  const grader = modelIdentity(input.graderModel);
  const producer = modelIdentity(input.producerModel);
  if (grader === null || producer === null || grader === producer) return null;
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
  /** Epoch ms of the child's edits. */
  readonly edits: readonly number[];
  /** The dispatch's acceptance commands (`routing.run` names). Empty → no run signal. */
  readonly acceptance: readonly string[];
}

/**
 * Success weight 1 when EVERY acceptance command has a run by the child that started strictly after its last edit,
 * and the latest such run of each exited 0. A run that started before (or at) the last edit does not cover it. A
 * failing run is no signal (the deterministic verdict owns failures).
 */
export function runSignal(input: RunSignalInput): SignalObservation | null {
  const acceptance = [...new Set(input.acceptance)];
  if (acceptance.length === 0) return null;
  let lastEdit = Number.NEGATIVE_INFINITY;
  for (const t of input.edits) if (Number.isFinite(t) && t > lastEdit) lastEdit = t;
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

export const REDISPATCH_WINDOW_MS = 30 * 60_000;
/** Dice coefficient over word sets at or above which two task texts are the same task. */
export const REDISPATCH_SIMILARITY = 0.6;
/** Texts with fewer distinct words than this never match (too little to tell tasks apart). */
export const REDISPATCH_MIN_TOKENS = 3;
/** Fallback de-boilerplating: a line present in at least this many sibling dispatches is boilerplate. */
export const SIBLING_SHARED_MIN = 2;

export interface DispatchText {
  readonly decisionID: string;
  readonly parentSessionID: string;
  readonly childSessionID: string | null;
  readonly prompt: string;
  readonly tier: string | null;
  /** Epoch ms of the dispatch. */
  readonly at: number;
  /** The dispatch resumed an existing child (`task_id`/`sessionID`, the authority ladder): never a re-dispatch. */
  readonly resume?: boolean;
  /** How the attempt ended, when known: an attempt that stopped on budget or authority is never penalised (I7). */
  readonly returned?: SignalKind | null;
}

export interface RedispatchMatch {
  /** The earlier attempt the failure belongs to. */
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
const COMPARED_SECTIONS: ReadonlySet<string> = new Set(["TASK", "EXPECTED OUTCOME"]);

/** TASK + EXPECTED OUTCOME of a 7-section dispatch prompt, or null when the prompt names neither section. */
export function taskSections(prompt: string): string | null {
  let current: string | null = null;
  let found = false;
  const kept: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const header = SECTION_RE.exec(line);
    if (header !== null) {
      current = header[1] as string;
      if (COMPARED_SECTIONS.has(current)) {
        found = true;
        kept.push(header[2] as string);
      }
      continue;
    }
    if (current !== null && COMPARED_SECTIONS.has(current)) kept.push(line);
  }
  return found ? kept.join("\n") : null;
}

const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, " ");

/** `prompt` without the lines shared with at least {@link SIBLING_SHARED_MIN} of `siblings` (boilerplate). */
export function withoutSharedLines(prompt: string, siblings: readonly string[]): string {
  const siblingLines = siblings.map((s) => new Set(s.split(/\r?\n/).map(normalizeLine).filter((l) => l !== "")));
  return prompt
    .split(/\r?\n/)
    .filter((line) => {
      const l = normalizeLine(line);
      if (l === "") return false;
      let shared = 0;
      for (const set of siblingLines) if (set.has(l)) shared += 1;
      return shared < SIBLING_SHARED_MIN;
    })
    .join("\n");
}

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) if (match[0].length >= 2) out.add(match[0]);
  return out;
}

/** Dice coefficient of the two texts' word sets; 0 when either has fewer than {@link REDISPATCH_MIN_TOKENS} words. */
export function taskSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size < REDISPATCH_MIN_TOKENS || wb.size < REDISPATCH_MIN_TOKENS) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return (2 * shared) / (wa.size + wb.size);
}

/**
 * Has `current` dispatched again the task of an earlier attempt, to a higher tier, within the window? Compares the
 * TASK + EXPECTED OUTCOME sections of both prompts; when either prompt has neither section, compares what is left of
 * each after removing the lines shared with ≥ 2 sibling dispatches of the same parent. The most recent earlier
 * dispatch of the same task decides: a lower tier gets a failure (0.5); the same or a higher tier, a resume, an
 * unknown tier, or an attempt that ended on budget or authority gets nothing.
 */
export function detectRedispatch(
  current: DispatchText,
  earlier: readonly DispatchText[],
  tiers: readonly string[],
  options: RedispatchOptions = {},
): RedispatchMatch | null {
  if (current.resume === true || !Number.isFinite(current.at)) return null;
  const windowMs = options.windowMs ?? REDISPATCH_WINDOW_MS;
  const threshold = options.threshold ?? REDISPATCH_SIMILARITY;
  const family = earlier.filter((d) => d.parentSessionID === current.parentSessionID && d.decisionID !== current.decisionID);
  const pool = [...family, current];
  const siblingsOf = (d: DispatchText): string[] => pool.filter((p) => p !== d).map((p) => p.prompt);
  const currentSections = taskSections(current.prompt);

  const candidates = family
    .filter((d) => {
      const dt = current.at - d.at;
      if (!Number.isFinite(dt) || dt <= 0 || dt > windowMs) return false;
      return d.childSessionID === null || d.childSessionID !== current.childSessionID;
    })
    .sort((x, y) => y.at - x.at);

  for (const previous of candidates) {
    const previousSections = taskSections(previous.prompt);
    const [a, b] =
      currentSections !== null && previousSections !== null
        ? [currentSections, previousSections]
        : [withoutSharedLines(current.prompt, siblingsOf(current)), withoutSharedLines(previous.prompt, siblingsOf(previous))];
    const similarity = taskSimilarity(a, b);
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
  readonly role?: string;
  readonly tier?: string;
}

/** Reason of a signal row: `note:signal:<kind>:<outcome>`. */
export function signalReason(observation: SignalObservation): string {
  return `${SIGNAL_REASON}${observation.kind}:${observation.outcome}`;
}

/**
 * A signal row: a decision row that annotates the attempt (`signal`, `signalWeight`, reason `note:signal:…`). It is never
 * a dispatch: `summarize` leaves it out, `summarizeRoles` counts it under the dispatch it joins.
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
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.tier === undefined ? {} : { tier: input.tier }),
    signal: observation.kind,
    signalWeight: signedWeight(observation),
  };
}
