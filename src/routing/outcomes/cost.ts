// ---------------------------------------------------------------------------
// Cost accounting (M3): pricing state (A1), step USD (D6), tiered price lookup (A10), per-attempt
// running means, the D5 unit rule and the D8 expected cost / tax inputs.
//
// Design: docs/qa/cost-aware-routing/phase-1.3.md "Design (1.3.1)" §3.
// Pure module: no I/O, no clock. Must stay runnable under Node type stripping.
// ---------------------------------------------------------------------------

import type {
  CostStats,
  CostUnit,
  MeanStat,
  ModelPriceEntry,
  ModelPricing,
  OpenAttempt,
  PricingState,
  StepEndedTokens,
  TokenMeans,
  TokenSample,
  UnitCandidate,
} from "./types";

/** D5: a candidate is USD-comparable on measured data once it has this many measured attempts. */
export const MIN_MEASURED_USD_SAMPLES = 3;

const PER_MILLION = 1e6;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function isNonNegativeFinite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function isValidEntry(entry: unknown): entry is ModelPriceEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Partial<Record<keyof ModelPriceEntry, unknown>>;
  if (!isNonNegativeFinite(e.input) || !isNonNegativeFinite(e.output)) return false;
  if (e.cache !== undefined) {
    if (typeof e.cache !== "object" || e.cache === null) return false;
    const cache = e.cache as { read?: unknown; write?: unknown };
    if (cache.read !== undefined && !isNonNegativeFinite(cache.read)) return false;
    if (cache.write !== undefined && !isNonNegativeFinite(cache.write)) return false;
  }
  if (e.tier !== undefined) {
    if (typeof e.tier !== "object" || e.tier === null) return false;
    const tier = e.tier as { type?: unknown; size?: unknown };
    if (tier.type !== "context") return false;
    if (typeof tier.size !== "number" || !Number.isFinite(tier.size) || tier.size <= 0) return false;
  }
  return true;
}

/**
 * Valid price entries of a catalog `cost` (absent → `[]`, one object → `[obj]`, array → a filtered
 * copy). An entry is kept only if input/output (and cache read/write when present) are finite and
 * ≥ 0 and its `tier`, when present, is `{ type: "context", size > 0 }`.
 */
export function normalizePricing(pricing: ModelPricing): ModelPriceEntry[] {
  if (pricing === null || pricing === undefined) return [];
  const list: readonly unknown[] = Array.isArray(pricing) ? (pricing as readonly unknown[]) : [pricing];
  return list.filter(isValidEntry);
}

/** A1: unpriced = no valid entry, or every price field of every entry is 0 (absent from the catalog counts too). */
export function isUnpriced(pricing: ModelPricing): boolean {
  const entries = normalizePricing(pricing);
  if (entries.length === 0) return true;
  return entries.every(
    (e) => e.input === 0 && e.output === 0 && (e.cache?.read ?? 0) === 0 && (e.cache?.write ?? 0) === 0,
  );
}

export function pricingState(pricing: ModelPricing): PricingState {
  return isUnpriced(pricing) ? "unpriced" : "priced";
}

/**
 * D6 + A1: USD of one step. `null` = no usable measurement: an invalid raw cost, or a `0` reported for
 * an unpriced model (the host's default, not a measurement). A priced model's 0 stays 0, and an
 * unpriced model's positive cost is kept (a host measurement). Tokens are always kept elsewhere.
 */
export function stepUSD(rawCost: number, pricing: PricingState): number | null {
  if (typeof rawCost !== "number" || !Number.isFinite(rawCost) || rawCost < 0) return null;
  if (rawCost === 0 && pricing === "unpriced") return null;
  return rawCost;
}

/**
 * A10: price entry for a request of `inputTokens` context. Tiered entries (`context over N`) apply
 * strictly above their size; the largest matching tier wins, else the base (untiered) entry, else the
 * smallest tier (closest published price). `null` when the model has no valid entry.
 */
export function selectPriceEntry(pricing: ModelPricing, inputTokens: number): ModelPriceEntry | null {
  const entries = normalizePricing(pricing);
  if (entries.length === 0) return null;
  const input = Number.isFinite(inputTokens) ? inputTokens : 0;
  const tiered = entries
    .filter((e): e is ModelPriceEntry & { tier: { type: "context"; size: number } } => e.tier !== undefined)
    .sort((a, b) => a.tier.size - b.tier.size);
  const base = entries.filter((e) => e.tier === undefined);
  let best: ModelPriceEntry | null = null;
  for (const e of tiered) if (input > e.tier.size) best = e;
  return best ?? base[0] ?? tiered[0] ?? null;
}

/** USD of a token sample (or per-attempt token means) at `entry`'s prices. Reasoning is billed as output. */
export function priceTokens(entry: ModelPriceEntry, t: TokenSample): number {
  return (
    (t.input * entry.input +
      (t.output + t.reasoning) * entry.output +
      t.cacheRead * (entry.cache?.read ?? 0) +
      t.cacheWrite * (entry.cache?.write ?? 0)) /
    PER_MILLION
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function nonNegativeOrZero(x: unknown): number {
  return isNonNegativeFinite(x) ? x : 0;
}

export function emptyTokenSample(): TokenSample {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Replace any non-finite or negative field with 0. */
export function cleanTokenSample(t: TokenSample): TokenSample {
  return {
    input: nonNegativeOrZero(t?.input),
    output: nonNegativeOrZero(t?.output),
    reasoning: nonNegativeOrZero(t?.reasoning),
    cacheRead: nonNegativeOrZero(t?.cacheRead),
    cacheWrite: nonNegativeOrZero(t?.cacheWrite),
  };
}

/** Flatten `session.step.ended` `data.tokens` (S3 shape). Non-finite or negative fields become 0. */
export function tokenSampleFromEvent(t: StepEndedTokens): TokenSample {
  return {
    input: nonNegativeOrZero(t?.input),
    output: nonNegativeOrZero(t?.output),
    reasoning: nonNegativeOrZero(t?.reasoning),
    cacheRead: nonNegativeOrZero(t?.cache?.read),
    cacheWrite: nonNegativeOrZero(t?.cache?.write),
  };
}

export function addTokens(a: TokenSample, b: TokenSample): TokenSample {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

// ---------------------------------------------------------------------------
// Running means
// ---------------------------------------------------------------------------

/**
 * Fold one sample: an exact arithmetic mean while `n + 1 ≤ maxEffectiveSamples`, then an EWMA with
 * weight `1 / maxEffectiveSamples` (bounded memory, follows price and behaviour drift). `n` is the
 * uncapped sample count. Cost statistics are not time-decayed (only Beta evidence is).
 */
export function updateMean(stat: MeanStat, x: number, maxEffectiveSamples: number): MeanStat {
  const n1 = stat.n + 1;
  const w = 1 / Math.min(n1, Math.max(1, maxEffectiveSamples));
  return { mean: stat.mean + (x - stat.mean) * w, n: n1 };
}

/** {@link updateMean} per token field with a shared `n`. */
export function updateTokenMeans(t: TokenMeans, sample: TokenSample, maxEffectiveSamples: number): TokenMeans {
  const n1 = t.n + 1;
  const w = 1 / Math.min(n1, Math.max(1, maxEffectiveSamples));
  return {
    n: n1,
    input: t.input + (sample.input - t.input) * w,
    output: t.output + (sample.output - t.output) * w,
    reasoning: t.reasoning + (sample.reasoning - t.reasoning) * w,
    cacheRead: t.cacheRead + (sample.cacheRead - t.cacheRead) * w,
    cacheWrite: t.cacheWrite + (sample.cacheWrite - t.cacheWrite) * w,
  };
}

export function emptyMeanStat(): MeanStat {
  return { mean: 0, n: 0 };
}

export function emptyTokenMeans(): TokenMeans {
  return { n: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

export function emptyCostStats(): CostStats {
  return {
    measuredUSD: emptyMeanStat(),
    unpricedAttempts: 0,
    tokens: emptyTokenMeans(),
    steps: emptyMeanStat(),
    finalMessageTokens: emptyMeanStat(),
  };
}

/**
 * Fold one finished attempt into a key's cost statistics (one sample = one attempt, C4). Tokens and
 * step counts always count; the USD mean only takes attempts whose every step had a usable cost, the
 * others bump `unpricedAttempts`. `finalMessageTokens` only takes attempts that reached a final step.
 */
export function foldAttempt(stats: CostStats, attempt: OpenAttempt, maxEffectiveSamples: number): CostStats {
  const usdKnown = attempt.usdKnown && attempt.steps > 0;
  return {
    measuredUSD: usdKnown ? updateMean(stats.measuredUSD, attempt.usd, maxEffectiveSamples) : stats.measuredUSD,
    unpricedAttempts: usdKnown ? stats.unpricedAttempts : stats.unpricedAttempts + 1,
    tokens: updateTokenMeans(stats.tokens, attempt.tokens, maxEffectiveSamples),
    steps: updateMean(stats.steps, attempt.steps, maxEffectiveSamples),
    finalMessageTokens:
      attempt.finalOutput !== null
        ? updateMean(stats.finalMessageTokens, attempt.finalOutput, maxEffectiveSamples)
        : stats.finalMessageTokens,
  };
}

function mergeMean(a: MeanStat, b: MeanStat): MeanStat {
  const n = a.n + b.n;
  return { mean: n > 0 ? (a.mean * a.n + b.mean * b.n) / n : 0, n };
}

export function mergeTokenMeans(a: TokenMeans, b: TokenMeans): TokenMeans {
  const n = a.n + b.n;
  if (n === 0) return emptyTokenMeans();
  const mix = (x: number, y: number): number => (x * a.n + y * b.n) / n;
  return {
    n,
    input: mix(a.input, b.input),
    output: mix(a.output, b.output),
    reasoning: mix(a.reasoning, b.reasoning),
    cacheRead: mix(a.cacheRead, b.cacheRead),
    cacheWrite: mix(a.cacheWrite, b.cacheWrite),
  };
}

/** n-weighted merge (loading a disk snapshot into a live store). */
export function mergeCostStats(a: CostStats, b: CostStats): CostStats {
  return {
    measuredUSD: mergeMean(a.measuredUSD, b.measuredUSD),
    unpricedAttempts: a.unpricedAttempts + b.unpricedAttempts,
    tokens: mergeTokenMeans(a.tokens, b.tokens),
    steps: mergeMean(a.steps, b.steps),
    finalMessageTokens: mergeMean(a.finalMessageTokens, b.finalMessageTokens),
  };
}

// ---------------------------------------------------------------------------
// D5 unit rule, D8 expected cost and tax
// ---------------------------------------------------------------------------

/**
 * D5 (+ clarification C1): `usd` iff there is at least one candidate and **every** candidate is
 * USD-comparable, i.e. has ≥ 3 measured attempts, or is priced and has a token profile to price (its
 * own or the class-pooled one). Otherwise `ratio` for all of them. Units are never mixed.
 */
export function compareUnit(candidates: readonly UnitCandidate[]): CostUnit {
  if (candidates.length === 0) return "ratio";
  const allComparable = candidates.every(
    (c) => c.measuredUSD.n >= MIN_MEASURED_USD_SAMPLES || (c.priced && c.tokenSamples >= 1),
  );
  return allComparable ? "usd" : "ratio";
}

/**
 * D8 `c_k` in USD per attempt: the measured mean once ≥ 3 attempts were measured, else (priced models
 * only) the token profile priced at the catalog entry selected by the mean request context (A10), else
 * `null`. Never invented: an unpriced model with fewer than 3 measured attempts has no USD estimate.
 */
export function expectedAttemptUSD(
  stats: CostStats,
  pricing: ModelPricing,
  classProfile: TokenMeans | null,
): number | null {
  if (stats.measuredUSD.n >= MIN_MEASURED_USD_SAMPLES) return stats.measuredUSD.mean;
  if (isUnpriced(pricing)) return null;
  const profile = stats.tokens.n >= 1 ? stats.tokens : classProfile !== null && classProfile.n >= 1 ? classProfile : null;
  if (profile === null) return null;
  const steps = stats.steps.n >= 1 ? stats.steps.mean : 1;
  const ctx = (profile.input + profile.cacheRead + profile.cacheWrite) / Math.max(1, steps);
  const entry = selectPriceEntry(pricing, ctx);
  return entry === null ? null : priceTokens(entry, profile);
}

/**
 * D8 `tax`: USD the orchestrator pays to re-read the child's final message on each remaining turn
 * (cache-read price, else the input price: QA-1.3-14). `null` until a final message was measured, or
 * when the orchestrator model is unpriced; the kernel maps `null` to 0.
 */
export function taxUSD(
  finalMessageTokens: MeanStat,
  remainingTurns: number,
  orchestratorPricing: ModelPricing,
  orchestratorContextTokens: number,
): number | null {
  if (finalMessageTokens.n === 0 || isUnpriced(orchestratorPricing)) return null;
  const entry = selectPriceEntry(orchestratorPricing, orchestratorContextTokens);
  if (entry === null) return null;
  const turns = Number.isFinite(remainingTurns) && remainingTurns > 0 ? remainingTurns : 0;
  // Re-reading the message costs the cache-read price; a model without one is billed at its input price.
  return (finalMessageTokens.mean * turns * (entry.cache?.read ?? entry.input)) / PER_MILLION;
}
