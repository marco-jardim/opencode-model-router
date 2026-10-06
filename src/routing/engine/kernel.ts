/**
 * Decision kernel (M4) — expected cost of the whole cascade per candidate and the margin rule.
 *
 * Design: `docs/qa/cost-aware-routing/phase-1.4.md` → "Design (1.4.1)" §2.
 * Plan #74 §1.5: D5 (unit rule), D7 (rank priors), D8 (cascade cost), D9 (margin rule, amended by
 * A16: strict `<`, boundary kept, `best == chosen` never a switch), D13 (`pin`); amendments A1 (every
 * live candidate compares in `costRatio` units today) and A11 (permissions come from the caller).
 *
 * D8, for candidate k with successor next(k) on its ladder (terminal successor = give up at cost U):
 *
 *     C(k) = c_k + tax_k + (1 − p_k) · [ d · C(next(k)) + (1 − d) · U ]
 *
 *  - c_k   attempt cost in the decision unit: `costRatio` (ratio) or `expectedAttemptUSD` (usd);
 *  - tax_k orchestrator re-read cost of k's final message (`taxUSD`); 0 until measured, always 0 in
 *          ratio units (there is no USD→ratio exchange rate, so it is never invented);
 *  - p_k   Beta posterior mean of the key, prior `priorForRankOffset(rank(k) − rank(static tier))`;
 *  - d     `routing.detection[detection]`;
 *  - U     `GIVE_UP_COST[profile][risk]` (fast = 1), times the USD value of one ratio unit in usd.
 *
 * What "k fails and the failure is detected" leads to (A25): for a rung with a simulated runner path
 * (`Ladder.paths`, built by `ladders.ts` from `nextAction`/`advance` of the 1.5 runner) the same recurrence
 * runs over the attempts the runner really makes — retries, variant steps, covered-tier skips, the
 * `maxTotalAttempts` and the cost ceiling included — and ends in `U`. Rungs without a path (role chains,
 * hand-built ladders) use the static `next` pointer; a chain that reaches a router rung continues with that
 * rung's path as if it were a fresh dispatch (the runner state of the chain is not carried over).
 *
 * Caveat of the USD unit (QA-1.4-14): `U` is a ratio-unit constant, converted to USD with the price of ONE
 * ratio unit measured on the cheapest-ratio candidate (D8 "fast = 1"). That candidate's USD estimate is the
 * only anchor, so a noisy or stale estimate for it rescales `U` for the whole decision; when it cannot be
 * derived the decision falls back to ratio units for every candidate instead of mixing units (D5).
 *
 * Pure: no I/O, no clock, no module state. The only reads are the injected store view's
 * `posterior`/`cost`/`classTokenProfile`. Memoisation lives in arrays local to one `decide` call.
 * Every runtime import is a pure module (`outcomes/beta`, `outcomes/cost`, `outcomes/types`).
 */

import type { RoutingProfile } from "../../router/config";
import type { Need, Risk } from "../classify/types";
import { PRIOR_STRENGTH, priorForRankOffset } from "../outcomes/beta";
import { compareUnit, expectedAttemptUSD, isUnpriced, taxUSD } from "../outcomes/cost";
import type {
  AgentRef,
  CostStats,
  CostUnit,
  MeanStat,
  OutcomeKey,
  RouteChoice,
  TokenMeans,
  UnitCandidate,
} from "../outcomes/types";
import { makeKey, normalizeVariant, splitModelRef } from "../outcomes/types";
import type {
  Candidate,
  Decision,
  DecisionInput,
  DecisionReasonCode,
  IneligibleReason,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** D8 give-up cost `U = profile[risk]`, in cost units where fast = 1. */
export const GIVE_UP_COST: Readonly<Record<RoutingProfile, Readonly<Record<Risk, number>>>> = Object.freeze({
  frugal: Object.freeze({ low: 3, medium: 8, high: 20 }),
  balanced: Object.freeze({ low: 5, medium: 15, high: 40 }),
  safe: Object.freeze({ low: 10, medium: 30, high: 100 }),
});

/** D8 `remainingTurnsEstimate`. */
export const DEFAULT_REMAINING_TURNS = 4;

/**
 * A24 (QA-1.4-6): a switch to a candidate that is cheaper to attempt or ranked lower than the pick (a "down"
 * switch) needs at least this much recorded evidence on the candidate's own key: the strength of a D7 prior,
 * so priors alone never move a dispatch down. Switches up are not gated.
 */
export const MIN_EVIDENCE_TO_SWITCH_DOWN: number = PRIOR_STRENGTH;

/** Decay and floating point make "five outcomes recorded a moment ago" 4.9999999…; this absorbs only that. */
const EVIDENCE_EPSILON = 1e-6;

/** Whether `n` effective outcomes (a posterior's `n`) reach {@link MIN_EVIDENCE_TO_SWITCH_DOWN}. */
export function hasMinEvidence(n: number): boolean {
  return Number.isFinite(n) && n + EVIDENCE_EPSILON >= MIN_EVIDENCE_TO_SWITCH_DOWN;
}

const EMPTY_MEAN: MeanStat = Object.freeze({ mean: 0, n: 0 });

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function clamp01(x: unknown): number {
  return isFiniteNumber(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Compact number for reason texts (≤ 4 decimals, no trailing zeros). */
function fmt(x: number): string {
  return Number.isFinite(x) ? String(Number(x.toFixed(4))) : String(x);
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** D8 `U` for a profile and a risk (balanced/medium semantics for an unknown value). */
export function giveUpCost(profile: RoutingProfile, risk: Risk): number {
  const table = ownValue(GIVE_UP_COST, profile) ?? GIVE_UP_COST.balanced;
  return ownValue(table, risk) ?? table.medium;
}

interface ModelParts {
  /** "" when the ref has no `provider/` prefix (makeKey stores `unknown`). */
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
}

function modelParts(model: string, variant: string | null): ModelParts {
  const ref = splitModelRef(model);
  if (ref === null) return { provider: "", model, variant };
  return { provider: ref.provider, model: ref.model, variant: variant ?? ref.variant };
}

function keyOf(cls: string, agent: AgentRef, parts: ModelParts): OutcomeKey {
  return makeKey(cls, agent, parts.provider, parts.model, parts.variant);
}

function routeChoice(key: OutcomeKey, agent: AgentRef, parts: ModelParts): RouteChoice {
  return Object.freeze({
    key,
    agent: agent.id,
    origin: agent.origin,
    model: parts.provider === "" ? parts.model : `${parts.provider}/${parts.model}`,
    variant: normalizeVariant(parts.variant),
  });
}

/**
 * Outcome key of a candidate (or the chosen dispatch) for class `cls` — the one key format the
 * kernel, the store and the decision log share (`class|origin:agent|provider/model#variant`).
 */
export function candidateKey(
  cls: string,
  candidate: { readonly agent: AgentRef; readonly model: string; readonly variant: string | null },
): OutcomeKey {
  return keyOf(cls, candidate.agent, modelParts(candidate.model, candidate.variant));
}

/** A11: the evaluated permissions cover every need; unknown permissions (`null`) cover none. */
export function coversNeeds(grants: readonly Need[] | null, needs: readonly Need[]): boolean {
  return needs.every((need) => grants !== null && grants.includes(need));
}

/** D5 `tokenSamples`: the key's own token samples, else the class-pooled profile's (1.3, C1). */
function tokenSamples(stats: CostStats | null, profile: TokenMeans | null): number {
  if (stats !== null && stats.tokens.n >= 1) return stats.tokens.n;
  return profile?.n ?? 0;
}

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

/**
 * Decide one dispatch: `C(k)` for every candidate, `best` = argmin over the orchestrator's pick and
 * the eligible candidates, and whether `enforce` would switch (D9 as amended by A16).
 *
 * Switch iff ALL hold: not pinned; the pick is a priced candidate; `best` is another candidate;
 * `facts.confidence ≥ minClassConfidence`; `C(best) < (1 − margin) · C(chosen)` (strict).
 * Eligibility of a candidate as `best` (the pick itself is always eligible — it is the status quo):
 * its permissions cover `facts.needs` (A11), it is not below `floorRank`, and it is not a lower rank
 * than the pick when `risk == high && detection == none` (D9 "never down").
 *
 * Class trust (1.2 → 1.4 handoff): below `minClassConfidence` the store is not read at all — no
 * posterior or cost is taken under an untrusted class; priors are then centred on the pick's rank.
 *
 * Never throws for well-typed input; non-finite numbers degrade to the conservative side
 * (an unusable successor is a give-up, an unusable candidate is ineligible, a bad margin never switches).
 */
export function decide(input: DecisionInput): Decision {
  const { facts, ladder, routing } = input;
  const cls = facts.class;
  const cands = ladder.candidates;
  const n = cands.length;
  const pinned = input.pin === true;

  const chosenParts = modelParts(input.chosen.model, input.chosen.variant);
  const chosenKey = keyOf(cls, input.chosen.agent, chosenParts);
  const chosen = routeChoice(chosenKey, input.chosen.agent, chosenParts);

  const classConfidence = clamp01(facts.confidence);
  const minConfidence = routing.minClassConfidence;
  const margin = routing.margin;
  const trusted = isFiniteNumber(minConfidence) && classConfidence >= minConfidence;
  const store = trusted ? input.store : null;

  if (n === 0) {
    return freezeDecision({
      chosen,
      best: null,
      switched: false,
      pinned,
      confidence: 0,
      reasonCode: "kept:no-candidates",
      reason: "kept: no candidate survived the ladder filters",
      costs: {},
      unit: "ratio",
      ineligible: {},
      target: null,
    });
  }

  // `all` = the dispatchable candidates, then the rungs only the 1.5 runner reaches (A25): the second kind is
  // priced like the first (it can sit on a simulated path) but is never `best`.
  const all: readonly Candidate[] = ladder.reachable === undefined || ladder.reachable.length === 0
    ? cands
    : [...cands, ...ladder.reachable];
  const total = all.length;
  const parts = all.map((c) => modelParts(c.model, c.variant));
  const keys = all.map((c, k) => keyOf(cls, c.agent, parts[k]!));
  let chosenIndex = -1;
  for (let k = 0; k < n; k++) {
    if (keys[k] === chosenKey) {
      chosenIndex = k;
      break;
    }
  }
  const chosenRank = chosenIndex >= 0 ? cands[chosenIndex]!.rank : null;

  // --- p_k: D7 prior by rank offset + evidence (store reads only for a trusted class) ------------
  const referenceRank = trusted
    ? (ladder.classRank ?? chosenRank ?? 0)
    : (chosenRank ?? ladder.classRank ?? 0);
  const p = new Float64Array(total);
  const evidence = new Float64Array(total);
  for (let k = 0; k < total; k++) {
    const prior = priorForRankOffset(all[k]!.rank - referenceRank);
    const priorMean = prior.alpha / (prior.alpha + prior.beta);
    if (store === null) {
      p[k] = priorMean;
      continue;
    }
    const post = store.posterior(keys[k]!, prior);
    p[k] = isFiniteNumber(post.mean) ? clamp01(post.mean) : priorMean;
    evidence[k] = isFiniteNumber(post.n) && post.n > 0 ? post.n : 0;
  }

  // --- unit (D5) and c_k ------------------------------------------------------------------------
  const stats: (CostStats | null)[] = all.map((_, k) => (store === null ? null : store.cost(keys[k]!)));
  const classProfile = store === null ? null : store.classTokenProfile(cls);
  let unit: CostUnit = "ratio";
  let usd: readonly number[] | null = null;
  let usdPerRatioUnit = 1;
  if (store !== null) {
    const unitCandidates: UnitCandidate[] = all.map((c, k) => ({
      key: keys[k]!,
      priced: !isUnpriced(c.pricing),
      measuredUSD: stats[k]?.measuredUSD ?? EMPTY_MEAN,
      tokenSamples: tokenSamples(stats[k] ?? null, classProfile),
    }));
    if (compareUnit(unitCandidates) === "usd") {
      const estimates = all.map((c, k) => expectedAttemptUSD(stats[k]!, c.pricing, classProfile));
      const scale = usdScale(all, estimates);
      if (scale !== null && estimates.every((v) => isFiniteNumber(v) && v >= 0)) {
        unit = "usd";
        usd = estimates as number[];
        usdPerRatioUnit = scale;
      }
    }
  }

  const c = new Float64Array(total);
  const usable = new Uint8Array(total);
  for (let k = 0; k < total; k++) {
    const value = usd !== null ? usd[k]! : all[k]!.costRatio;
    const ok = usd !== null ? isFiniteNumber(value) && value >= 0 : isFiniteNumber(value) && value > 0;
    c[k] = ok ? value : 0;
    usable[k] = ok ? 1 : 0;
  }

  // --- tax_k (D8): measured USD only; 0 in ratio units and until measured ------------------------
  const tax = new Float64Array(total);
  const orchestrator = input.orchestrator ?? null;
  if (unit === "usd" && orchestrator !== null) {
    const turns = isFiniteNumber(input.remainingTurns) && input.remainingTurns >= 0
      ? input.remainingTurns
      : DEFAULT_REMAINING_TURNS;
    for (let k = 0; k < total; k++) {
      const s = stats[k];
      if (s === null || s === undefined) continue;
      const t = taxUSD(s.finalMessageTokens, turns, orchestrator.pricing, orchestrator.contextTokens);
      tax[k] = isFiniteNumber(t) && t > 0 ? t : 0;
    }
  }

  // --- d and U ----------------------------------------------------------------------------------
  const d = clamp01(ownValue(routing.detection as Readonly<Record<string, number>>, input.detection));
  const U = giveUpCost(routing.profile, facts.risk) * usdPerRatioUnit;

  // --- simulated runner paths (A25): the usable prefix of each candidate's attempt list --------------
  const pathCache: (readonly number[] | null)[] = new Array<readonly number[] | null>(n).fill(null);
  for (let k = 0; k < n; k++) {
    const raw = ladder.paths?.[k];
    if (!Array.isArray(raw)) continue;
    const prefix: number[] = [];
    for (const a of raw as readonly unknown[]) {
      if (typeof a !== "number" || !Number.isInteger(a) || a < 0 || a >= total || usable[a] !== 1) break;
      prefix.push(a);
    }
    if (prefix.length > 0) pathCache[k] = prefix;
    else usable[k] = 0; // its first attempt cannot be priced
  }

  // --- C(k): D8 recursion, evaluated iteratively and memoised per call --------------------------------
  //   C(k) = c_k + tax_k + (1 − p_k)·[d·C(next(k)) + (1 − d)·U]        (static `next` chain)
  // A candidate with a simulated path a_1…a_m (a_1 = k) is the same recurrence over the attempts the runner
  // makes (retries and variant steps included), ending in `U` after a_m. Iteration, not recursion: a chain of
  // thousands of rungs must not be able to exhaust the stack (QA-1.4-12).
  const memo = new Float64Array(n);
  const visit = new Uint8Array(n); // 0 = new, 1 = on the current chain, 2 = done
  const next = ladder.next;
  const attemptValue = (a: number, after: number): number =>
    c[a]! + tax[a]! + (1 - p[a]!) * (d * after + (1 - d) * U);
  const cascade = (start: number): number => {
    if (visit[start] === 2) return memo[start]!;
    const stack: number[] = [];
    let tail = U;
    let k = start;
    for (;;) {
      if (visit[k] === 2) {
        tail = memo[k]!;
        break;
      }
      if (visit[k] === 1) {
        tail = U; // defensive: a cycle is a give-up, never an infinite escalation
        break;
      }
      const path = pathCache[k];
      if (path !== null && path !== undefined) {
        let value = U;
        for (let i = path.length - 1; i >= 0; i--) value = attemptValue(path[i]!, value);
        memo[k] = value;
        visit[k] = 2;
        tail = value;
        break;
      }
      visit[k] = 1;
      stack.push(k);
      const j = next[k];
      if (typeof j === "number" && Number.isInteger(j) && j >= 0 && j < n && usable[j] === 1) {
        k = j;
        continue;
      }
      tail = U; // no, out-of-range or unusable successor: give up
      break;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const node = stack[i]!;
      tail = attemptValue(node, tail);
      memo[node] = tail;
      visit[node] = 2;
    }
    return memo[start]!;
  };

  const C = new Float64Array(n).fill(Number.NaN);
  const costs: Record<string, number> = {};
  for (let k = 0; k < n; k++) {
    if (usable[k] !== 1) continue;
    const value = cascade(k);
    C[k] = value;
    if (isFiniteNumber(value) && !Object.prototype.hasOwnProperty.call(costs, keys[k]!)) costs[keys[k]!] = value;
  }
  // --- best: argmin over the pick and the eligible candidates ------------------------------------
  const chosenPriced = chosenIndex >= 0 && usable[chosenIndex] === 1 && isFiniteNumber(C[chosenIndex]);
  const floorRank = isFiniteNumber(input.floorRank) ? input.floorRank : null;
  const neverDown = facts.risk === "high" && input.detection === "none";
  const ineligible: Record<string, IneligibleReason> = {};
  let best = chosenPriced ? chosenIndex : -1;
  for (let k = 0; k < n; k++) {
    if (k === chosenIndex || keys[k] === chosenKey) continue;
    const cand = cands[k]!;
    let why: IneligibleReason | null = null;
    if (usable[k] !== 1 || !isFiniteNumber(C[k])) why = "invalid-cost";
    else if (!coversNeeds(cand.grants, facts.needs)) why = "needs";
    else if (floorRank !== null && cand.rank < floorRank) why = "floor";
    else if (neverDown && chosenRank !== null && cand.rank < chosenRank) why = "never-down";
    if (why !== null) {
      if (!Object.prototype.hasOwnProperty.call(ineligible, keys[k]!)) ineligible[keys[k]!] = why;
      continue;
    }
    // Strict: ties keep the pick (considered first), then the earlier rung.
    if (best < 0 || C[k]! < C[best]!) best = k;
  }

  const bestIndex = best >= 0 ? best : null;
  const bestChoice = bestIndex === null ? null : routeChoice(keys[bestIndex]!, cands[bestIndex]!.agent, parts[bestIndex]!);
  const bestCost = bestIndex === null ? Number.NaN : C[bestIndex]!;
  const chosenCost = chosenPriced ? C[chosenIndex]! : Number.NaN;

  // --- D9 (A16) ---------------------------------------------------------------------------------
  const marginValid = isFiniteNumber(margin) && margin >= 0 && margin < 1;
  const threshold = marginValid ? (1 - margin) * chosenCost : Number.NaN;
  let reasonCode: DecisionReasonCode;
  let reason: string;
  if (bestIndex === null) {
    reasonCode = "kept:no-candidates";
    reason = "kept: no candidate could be priced";
  } else if (pinned) {
    reasonCode = "kept:pinned";
    reason = `kept: pinned dispatch (best ${bestChoice!.key} at ${fmt(bestCost)} ${unit})`;
  } else if (!chosenPriced) {
    reasonCode = "kept:chosen-not-candidate";
    reason = `kept: the chosen ${chosenKey} is not a priced candidate`;
  } else if (bestIndex === chosenIndex) {
    reasonCode = "kept:best-is-chosen";
    reason = `kept: the chosen dispatch is the cheapest (${fmt(chosenCost)} ${unit})`;
  } else if (!marginValid || !isFiniteNumber(minConfidence)) {
    reasonCode = "kept:invalid-config";
    reason = "kept: routing.margin or routing.minClassConfidence is not a usable number";
  } else if (classConfidence < minConfidence) {
    reasonCode = "kept:class-confidence";
    reason = `kept: class confidence ${fmt(classConfidence)} < minClassConfidence ${fmt(minConfidence)}`;
  } else if (!(bestCost < threshold)) {
    reasonCode = "kept:margin";
    reason = `kept: C(best)=${fmt(bestCost)} is not < (1 − ${fmt(margin)})·C(chosen)=${fmt(threshold)} ${unit}`;
  } else if (isDownSwitch(c, cands, bestIndex, chosenIndex) && !hasMinEvidence(evidence[bestIndex]!)) {
    reasonCode = "kept:evidence";
    reason = `kept: moving down to ${bestChoice!.key} needs ≥ ${MIN_EVIDENCE_TO_SWITCH_DOWN} recorded outcomes, it has ${fmt(evidence[bestIndex]!)}`;
  } else {
    reasonCode = "switched";
    reason = `switched: C(best)=${fmt(bestCost)} < (1 − ${fmt(margin)})·C(chosen)=${fmt(threshold)} ${unit}`;
  }

  const bestEvidence = bestIndex === null ? 0 : evidence[bestIndex]!;
  const confidence = bestIndex === null
    ? 0
    : round2(classConfidence * (bestEvidence / (bestEvidence + PRIOR_STRENGTH)));

  return freezeDecision({
    chosen,
    best: bestChoice,
    switched: reasonCode === "switched",
    pinned,
    confidence,
    reasonCode,
    reason,
    costs,
    unit,
    ineligible,
    target: bestIndex === null ? null : cands[bestIndex]!,
  });
}

/** A24: `best` is cheaper to attempt, or ranked lower, than the pick. */
function isDownSwitch(c: Float64Array, cands: readonly Candidate[], best: number, chosen: number): boolean {
  return c[best]! < c[chosen]! || cands[best]!.rank < cands[chosen]!.rank;
}

/**
 * USD value of one `costRatio` unit (D8 "U in cost units where fast = 1", expressed in USD): the
 * USD estimate of the cheapest-ratio candidate divided by its ratio. `null` when it cannot be
 * derived (the decision then falls back to ratio units for every candidate — never mixed).
 */
function usdScale(cands: readonly Candidate[], estimates: readonly (number | null)[]): number | null {
  let ref = -1;
  for (let k = 0; k < cands.length; k++) {
    const r = cands[k]!.costRatio;
    if (!isFiniteNumber(r) || r <= 0) continue;
    if (ref < 0 || r < cands[ref]!.costRatio) ref = k;
  }
  if (ref < 0) return null;
  const e = estimates[ref];
  if (!isFiniteNumber(e) || e <= 0) return null;
  const scale = e / cands[ref]!.costRatio;
  return isFiniteNumber(scale) && scale > 0 ? scale : null;
}

function freezeDecision(d: Decision): Decision {
  Object.freeze(d.costs);
  Object.freeze(d.ineligible);
  return Object.freeze(d);
}
