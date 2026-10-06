/**
 * Runner simulation (A25, QA-1.4-2) — the attempts the 1.5 escalation runner makes after a rung fails.
 *
 * D8 prices a candidate as "attempt it; if it fails and the failure is detected, the cascade continues". The
 * cascade of a router rung is not a fixed chain: it is whatever `nextAction` decides from the attempt count,
 * the cumulative cost, the cost ceiling, `maxAttemptsPerTier`, variant steps and the covered-tier skips of
 * the policy. This module replays exactly that loop (`newLadderState` → `recordAttempt` → `nextAction` →
 * `advance`) with a failing verdict after every attempt and returns the rungs it ran, so the kernel never
 * prices an escalation the runner would not perform (e.g. a tier covered by a rung already tried, or a tier
 * beyond the cost ceiling).
 *
 * Costs are in `costRatio` units, as the runner charges them (`action.costRatio ?? tier.costRatio`), whatever
 * unit the kernel later prices in. Pure: no I/O, no clock, no randomness, no module state.
 */

import {
  advance,
  newLadderState,
  nextAction,
  recordAttempt,
  startCostRatio,
  type EscalatePolicy,
  type LadderState,
  type LadderVerdict,
} from "../../escalate/ladder";
import { DEFAULT_VARIANT } from "../../escalate/variants";

/** One rung the runner runs: a tier on `model#variant`, charged `costRatio`. */
export interface RunnerRung {
  readonly tier: string;
  readonly model: string;
  /** `null` = the model's default variant. */
  readonly variant: string | null;
  readonly costRatio: number;
}

/** The base rung of a tier (its own `model`, `variant`, `costRatio`), or `undefined` for an unknown tier. */
export type TierBase = (tier: string) => RunnerRung | undefined;

/**
 * Upper bound on simulated attempts. `maxTotalAttempts` ends every real path (default 4); the bound only
 * protects against an absurd configured value.
 */
export const MAX_SIMULATED_ATTEMPTS = 64;

const FAILED: LadderVerdict = { pass: false, outcome: "fail", reasons: [] };

function ownVariantInfo(policy: EscalatePolicy, tier: string) {
  const perTier = policy.variants?.perTier;
  return perTier !== undefined && Object.prototype.hasOwnProperty.call(perTier, tier) ? perTier[tier] : undefined;
}

/**
 * Rungs the runner runs when it is started on `start` and every attempt fails with a detected failure, in
 * order (the first is `start` itself, unless `floorTier` lifts the start tier: QA-1.4-17, the first attempt is
 * then the floor tier's base). Ends when the runner gives up, when it would enter a tier the preset does not
 * define, or after {@link MAX_SIMULATED_ATTEMPTS}.
 *
 * A start on a rung other than the tier's base is modelled as a delegation that already stepped there (its
 * variant is recorded as tried, so the ladder never re-runs it).
 */
export function simulateRunner(policy: EscalatePolicy, tierBase: TierBase, start: RunnerRung): RunnerRung[] {
  let state = newLadderState(start.tier, policy);
  let first: RunnerRung;
  if (state.currentTier === start.tier) {
    const info = ownVariantInfo(policy, start.tier);
    const variant = start.variant ?? DEFAULT_VARIANT;
    if (info !== undefined && !info.effortConfigured && variant !== info.base) {
      state = advance(state, {
        action: "retry",
        tier: start.tier,
        variantStep: true,
        model: info.model,
        variant,
        rung: { model: info.model, variant },
      });
    }
    first = start;
  } else {
    // floorTier lifts the start: the first attempt runs the floor tier's base, whatever rung was asked for.
    const base = tierBase(state.currentTier);
    if (base === undefined) return [];
    first = { ...base, costRatio: startCostRatio(policy, state) ?? base.costRatio };
  }
  return walk(policy, tierBase, state, first);
}

/**
 * QA-1.4-16: the rungs the runner runs AFTER a native agent has already made `seed.attempts` (its own-model
 * rung and the owning tier's rungs) on tier `seed.tier`. The escalation out of a role chain continues the same
 * delegation, so the attempts and the cost already spent count against `maxTotalAttempts` and the cost
 * ceiling, the chain's tier has used its per-tier retries, and the models the chain ran are recorded as tried
 * (a later tier on one of them is skipped like any covered tier). Returns the continuation only.
 */
export function simulateAfter(
  policy: EscalatePolicy,
  tierBase: TierBase,
  seed: { readonly tier: string; readonly attempts: readonly RunnerRung[] },
): RunnerRung[] {
  if (seed.attempts.length === 0) return [];
  const spent = seed.attempts.reduce((sum, rung) => sum + rung.costRatio, 0);
  let state = newLadderState(seed.tier, policy);
  const info = ownVariantInfo(policy, seed.tier);
  if (info !== undefined && !info.effortConfigured) {
    // Record every rung the chain ran (raises `triedByModel`); `advance` of a variant step does exactly that.
    for (const rung of seed.attempts) {
      const variant = rung.variant ?? DEFAULT_VARIANT;
      state = advance(state, {
        action: "retry",
        tier: seed.tier,
        variantStep: true,
        model: rung.model,
        variant,
        rung: { model: rung.model, variant },
      });
    }
    const lastOwn = [...seed.attempts].reverse().find((rung) => rung.model === info.model);
    state = { ...state, currentVariant: lastOwn === undefined ? null : (lastOwn.variant ?? DEFAULT_VARIANT) };
  }
  state = {
    ...state,
    currentTier: seed.tier,
    // The chain was this tier's retries: only a variant step or an escalation is left.
    attemptsThisTier: Math.max(policy.maxAttemptsPerTier, state.attemptsThisTier),
    totalAttempts: seed.attempts.length,
    cumulativeCost: spent,
    firstAttemptCost: seed.attempts[0]!.costRatio,
  };
  return walk(policy, tierBase, state, null);
}

/**
 * The shared loop: record the attempt just made (`current`; none for a seeded state), ask `nextAction` what
 * the runner does after a detected failure, advance, and read the rung it lands on.
 */
function walk(policy: EscalatePolicy, tierBase: TierBase, start: LadderState, first: RunnerRung | null): RunnerRung[] {
  let state = start;
  let current = first;
  const rungs: RunnerRung[] = [];
  for (let attempt = 0; attempt < MAX_SIMULATED_ATTEMPTS; attempt++) {
    if (current !== null) {
      rungs.push(current);
      state = recordAttempt(state, current.costRatio);
    }
    const action = nextAction(state, FAILED, policy);
    if (action.action !== "retry" && action.action !== "escalate") break;
    state = advance(state, action);
    const base = tierBase(state.currentTier);
    if (base === undefined) break;
    if (current !== null && action.action === "retry" && action.variantStep !== true && state.currentVariant === undefined) {
      // No variant info in the policy: a plain retry re-runs the rung it just ran (the runner still charges
      // the tier's own ratio, A17).
      current = { ...current, costRatio: action.costRatio ?? base.costRatio };
      continue;
    }
    const info = ownVariantInfo(policy, state.currentTier);
    const variant = state.currentVariant ?? info?.base ?? base.variant ?? DEFAULT_VARIANT;
    current = {
      tier: state.currentTier,
      model: info?.model ?? base.model,
      variant: variant === DEFAULT_VARIANT ? null : variant,
      // A17: the runner charges the action's rung ratio, else the tier's own.
      costRatio: action.costRatio ?? base.costRatio,
    };
  }
  return rungs;
}
