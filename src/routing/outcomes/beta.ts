// ---------------------------------------------------------------------------
// Beta posteriors (M3): D4 observations, D7 rank priors, time decay, effective-sample cap.
//
// Design: docs/qa/cost-aware-routing/phase-1.3.md "Design (1.3.1)" §2.
// Pure module: no I/O, no clock of its own (every function takes `now`). Must stay runnable under
// Node type stripping (type-only imports use `import type`).
//
// Stored state is *evidence only* (prior excluded) expressed at `updatedAt`. The D7 prior is added on
// read, so changing a rank never rewrites evidence and old evidence decays toward the prior.
// ---------------------------------------------------------------------------

import type { BetaPrior, BetaState, OutcomeTuning, Posterior } from "./types";
import { DEFAULT_OUTCOME_TUNING } from "./types";

/** `alpha + beta` of every D7 prior. */
export const PRIOR_STRENGTH = 5;
/** Evidence totals below this are flushed to 0 so subnormals never reach storage. */
export const MIN_TINY = 1e-12;
export const DAY_MS = 86_400_000;

const MAX_PRIOR_OFFSET_CENTI = 95;
const MIN_PRIOR_OFFSET_CENTI = 30;

/**
 * D7: prior for a candidate whose capability rank differs from the static tier of the class by `offset`
 * (`rank(candidate) − rank(static tier)`). Means: ≤ −2 → 0.30 (floor), −1 → 0.55, 0 → 0.80, +1 → 0.85,
 * +2 → 0.90, ≥ +3 → 0.95 (cap). Integer hundredths keep every value exact in binary.
 */
export function priorForRankOffset(offset: number): BetaPrior {
  const o = Number.isFinite(offset) ? Math.round(offset) : 0;
  const centi =
    o >= 0
      ? Math.min(MAX_PRIOR_OFFSET_CENTI, 80 + 5 * o)
      : Math.max(MIN_PRIOR_OFFSET_CENTI, 80 + 25 * o);
  const alpha = centi / 20;
  return { alpha, beta: PRIOR_STRENGTH - alpha };
}

/** Same-rank prior, `Beta(4, 1)` (mean 0.80). */
export const SAME_RANK_PRIOR: BetaPrior = Object.freeze(priorForRankOffset(0));

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Defensive normalisation of `routing.outcomes` tuning (1.1 validates the same ranges). */
export function sanitizeTuning(tuning: Partial<OutcomeTuning> | null | undefined): OutcomeTuning {
  const half = tuning?.halfLifeDays;
  const cap = tuning?.maxEffectiveSamples;
  return {
    halfLifeDays: typeof half === "number" && Number.isFinite(half) ? clamp(half, 1, 365) : DEFAULT_OUTCOME_TUNING.halfLifeDays,
    maxEffectiveSamples:
      typeof cap === "number" && Number.isFinite(cap)
        ? clamp(Math.round(cap), 5, 1000)
        : DEFAULT_OUTCOME_TUNING.maxEffectiveSamples,
  };
}

/**
 * `2 ** (−dt / (halfLifeDays · DAY_MS))` ∈ [0, 1]. A negative, NaN or non-finite `dt` counts as 0, so a
 * clock going backwards gives factor 1 and counts never inflate.
 */
export function decayFactor(dtMs: number, halfLifeDays: number): number {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const half = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_OUTCOME_TUNING.halfLifeDays;
  return 2 ** (-dt / (half * DAY_MS));
}

/**
 * Express `state` at `now`. Pure and multiplicative (materialising at t1 then t2 equals materialising at
 * t2 directly). `updatedAt` never moves backwards by less than a day (clock jitter); further back it is
 * re-stamped at `now` with the counts untouched (QA-1.3-7). A NaN `now` means "no time passed".
 */
export function decayTo(state: BetaState, now: number, tuning: OutcomeTuning): BetaState {
  const t = Number.isFinite(now) ? now : state.updatedAt;
  // QA-1.3-7: more than a day behind the stored instant is a clock correction, not jitter: re-stamp the
  // evidence at `t` (counts untouched, so nothing inflates) instead of leaving it frozen in the "future".
  if (t < state.updatedAt - DAY_MS) return { alpha: state.alpha, beta: state.beta, updatedAt: t };
  const f = decayFactor(t - state.updatedAt, tuning.halfLifeDays);
  let alpha = state.alpha * f;
  let beta = state.beta * f;
  if (alpha + beta < MIN_TINY) {
    alpha = 0;
    beta = 0;
  }
  return { alpha, beta, updatedAt: Math.max(state.updatedAt, t) };
}

/** Scale the evidence down to `maxEffectiveSamples` total, preserving the evidence mean (≤ 1e-15). */
export function capEvidence(state: BetaState, maxEffectiveSamples: number): BetaState {
  const n = state.alpha + state.beta;
  if (!(n > maxEffectiveSamples)) return state;
  const scale = maxEffectiveSamples / n;
  return { alpha: state.alpha * scale, beta: state.beta * scale, updatedAt: state.updatedAt };
}

/** D4: one observation. Decays the stored evidence to `now`, adds +1 to alpha (success) or beta, then caps. */
export function observe(state: BetaState | undefined, success: boolean, now: number, tuning: OutcomeTuning): BetaState {
  const at = Number.isFinite(now) ? now : (state?.updatedAt ?? 0);
  const base = decayTo(state ?? { alpha: 0, beta: 0, updatedAt: at }, at, tuning);
  const next: BetaState = success
    ? { alpha: base.alpha + 1, beta: base.beta, updatedAt: base.updatedAt }
    : { alpha: base.alpha, beta: base.beta + 1, updatedAt: base.updatedAt };
  return capEvidence(next, tuning.maxEffectiveSamples);
}

function usablePrior(prior: BetaPrior): BetaPrior {
  const ok = Number.isFinite(prior.alpha) && Number.isFinite(prior.beta) && prior.alpha > 0 && prior.beta > 0;
  return ok ? prior : SAME_RANK_PRIOR;
}

/**
 * Posterior at read time: prior + evidence decayed to `now` and capped. A read only: it never writes
 * back, so reads cannot drift the stored state. Unknown evidence → exactly the prior.
 */
export function posteriorOf(
  state: BetaState | undefined,
  prior: BetaPrior,
  now: number,
  tuning: OutcomeTuning,
): Posterior {
  const p = usablePrior(prior);
  const e = state ? capEvidence(decayTo(state, now, tuning), tuning.maxEffectiveSamples) : { alpha: 0, beta: 0 };
  const alpha = p.alpha + e.alpha;
  const beta = p.beta + e.beta;
  return { alpha, beta, mean: alpha / (alpha + beta), n: e.alpha + e.beta, prior: p };
}

/**
 * Add two evidence states (loading a disk snapshot into a live store). Both are decayed to a common
 * instant `max(a.updatedAt, b.updatedAt, now)` (forward only), summed, and capped.
 */
export function mergeBeta(a: BetaState, b: BetaState, now: number, tuning: OutcomeTuning): BetaState {
  const newest = Math.max(a.updatedAt, b.updatedAt);
  // A clock more than a day behind both states is a correction (QA-1.3-7): express the sum at `now`.
  const t = !Number.isFinite(now) ? newest : newest - now > DAY_MS ? now : Math.max(newest, now);
  const da = decayTo(a, t, tuning);
  const db = decayTo(b, t, tuning);
  const sum: BetaState = { alpha: da.alpha + db.alpha, beta: da.beta + db.beta, updatedAt: t };
  return capEvidence(sum, tuning.maxEffectiveSamples);
}
