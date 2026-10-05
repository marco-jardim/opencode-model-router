import { nextEffort } from "../router/agent-options";
import type { EffortLevel, RouterConfig } from "../router/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EffortBumpPolicy {
  perTier: Record<string, { base: EffortLevel; bound: EffortLevel }>;
}

export interface EscalatePolicy {
  ladder: string[];
  floorTier?: string | null;
  maxAttemptsPerTier: number;
  maxTotalAttempts: number;
  costMultiple?: number | null;
  effortBump?: EffortBumpPolicy | null;
}

export interface LadderState {
  currentTier: string;
  attemptsThisTier: number;
  totalAttempts: number;
  escalations: number;
  firstAttemptCost: number | null;
  cumulativeCost: number;
  currentEffort?: EffortLevel | null;
}

export type LadderActionKind = "accept" | "retry" | "escalate" | "give_up";

export interface LadderAction {
  action: LadderActionKind;
  tier?: string;
  forcingMessage?: string;
  reason?: string;
  effort?: EffortLevel;
}

export interface LadderVerdict {
  pass: boolean;
  outcome?: "pass" | "fail" | "unverifiable";
  reasons?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tierRank(tier: string, ladder: string[]): number {
  return ladder.indexOf(tier);
}

export function resolveStartTier(
  producerTier: string,
  policy: EscalatePolicy,
): string {
  const pi = tierRank(producerTier, policy.ladder);
  const fi =
    policy.floorTier != null ? tierRank(policy.floorTier, policy.ladder) : -1;
  const startIdx = Math.max(pi >= 0 ? pi : 0, fi >= 0 ? fi : 0);
  return policy.ladder[startIdx] ?? producerTier;
}

export function newLadderState(
  producerTier: string,
  policy: EscalatePolicy,
): LadderState {
  const state: LadderState = {
    currentTier: resolveStartTier(producerTier, policy),
    attemptsThisTier: 0,
    totalAttempts: 0,
    escalations: 0,
    firstAttemptCost: null,
    cumulativeCost: 0,
  };
  if (policy.effortBump) state.currentEffort = null;
  return state;
}

export function recordAttempt(
  state: LadderState,
  costUnits = 0,
): LadderState {
  return {
    ...state,
    totalAttempts: state.totalAttempts + 1,
    cumulativeCost: state.cumulativeCost + costUnits,
    firstAttemptCost:
      state.firstAttemptCost == null ? costUnits : state.firstAttemptCost,
  };
}

export function nextTierAfter(
  currentTier: string,
  policy: EscalatePolicy,
): string | null {
  const ci = tierRank(currentTier, policy.ladder);
  if (ci >= 0 && ci + 1 <= policy.ladder.length - 1) {
    return policy.ladder[ci + 1]!;
  }
  return null;
}

export function buildLadderForcingMessage(reasons: string[]): string {
  const list =
    reasons.length === 0
      ? "- (no reasons provided)"
      : reasons.map((r) => `- ${r}`).join("\n");
  return (
    `[router escalation] previous attempt did not pass verification:\n` +
    list +
    `\nNEXT: retry with these failures addressed.`
  );
}

export function nextAction(
  state: LadderState,
  verdict: LadderVerdict | null | undefined,
  policy: EscalatePolicy,
): LadderAction {
  // (1) pass
  if (verdict?.pass === true) {
    return { action: "accept" };
  }
  // Strict policy may reject an unavailable check, but paying another producer
  // cannot repair the verifier. Only actual failures enter the retry ladder.
  if (verdict?.outcome === "unverifiable") {
    return { action: "give_up", reason: "verification unavailable; no producer escalation" };
  }

  // (2) cost check
  const costExceeded =
    policy.costMultiple != null &&
    state.firstAttemptCost != null &&
    state.cumulativeCost > state.firstAttemptCost * policy.costMultiple;

  // (3) max total attempts
  if (state.totalAttempts >= policy.maxTotalAttempts) {
    return {
      action: "give_up",
      reason: `max total attempts (${policy.maxTotalAttempts}) reached`,
    };
  }

  // (4) cost ceiling
  if (costExceeded) {
    return { action: "give_up", reason: "cost ceiling exceeded" };
  }

  // (5) retry within tier
  if (state.attemptsThisTier < policy.maxAttemptsPerTier) {
    const action: LadderAction = {
      action: "retry",
      tier: state.currentTier,
      forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
    };
    const perTier = policy.effortBump?.perTier;
    const bump = perTier && Object.prototype.hasOwnProperty.call(perTier, state.currentTier)
      ? perTier[state.currentTier] : undefined;
    if (bump) {
      const effort = nextEffort(state.currentEffort ?? bump.base, bump.bound) ?? state.currentEffort ?? undefined;
      if (effort !== undefined) action.effort = effort;
    }
    return action;
  }

  // (6) escalate or give_up
  const next = nextTierAfter(state.currentTier, policy);
  if (next == null) {
    return {
      action: "give_up",
      reason: "no higher tier (already at top of ladder)",
    };
  }
  return {
    action: "escalate",
    tier: next,
    forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
  };
}

export function advance(state: LadderState, action: LadderAction): LadderState {
  if (action.action === "retry") {
    const next = { ...state, attemptsThisTier: state.attemptsThisTier + 1 };
    if (action.effort !== undefined) next.currentEffort = action.effort;
    return next;
  }
  if (action.action === "escalate") {
    const next = {
      ...state,
      currentTier: action.tier!,
      attemptsThisTier: 0,
      escalations: state.escalations + 1,
    };
    if (next.currentEffort !== undefined) next.currentEffort = null;
    return next;
  }
  // accept / give_up — terminal, return unchanged
  return state;
}

export function buildEscalatePolicy(cfg: RouterConfig): EscalatePolicy {
  const esc = cfg.enforcement?.escalate;
  return {
    ladder: esc?.ladder ?? ["fast", "medium", "heavy"],
    floorTier: esc?.floorTier ?? null,
    maxAttemptsPerTier: esc?.maxAttemptsPerTier ?? 1,
    maxTotalAttempts: esc?.maxTotalAttempts ?? 4,
    costMultiple: esc?.costCeiling?.multiple ?? 4,
  };
}

/**
 * One-line, secret-free scorecard for a finished delegation (counts only).
 */
export function formatLadderScorecard(
  state: LadderState,
  accepted: boolean,
  method: string,
): string {
  return (
    `[router delegate scorecard | final_tier=${state.currentTier}${state.currentEffort ? `@${state.currentEffort}` : ""} | ` +
    `attempts=${state.totalAttempts} | escalations=${state.escalations} | ` +
    `cost=${state.cumulativeCost} | verdict=${accepted ? "PASS" : "UNMET"} | ` +
    `method=${method}]`
  );
}
