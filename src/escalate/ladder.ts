import { effortCeilingFor, effortRank, minEffort, nextEffort } from "../router/agent-options";
import { resolveEffortBump, type EffortLevel, type RouterConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import {
  DEFAULT_VARIANT,
  buildVariantLadder,
  catalogVariantIds,
  estimateTokensFromChars,
  inputBudget,
  nextVariant,
  resumeDecision,
  variantPosition,
  type CatalogModel,
  type ResumeDecision,
  type VariantLadder,
} from "./variants";

// The resume decision lives in variants.ts; re-exported so the plan's API
// location (`ladder.ts`) holds.
export { resumeDecision, type ResumeDecision } from "./variants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EffortBumpPolicy {
  perTier: Record<string, { base: EffortLevel; bound: EffortLevel }>;
}

/** Per-tier variant data; built only on v2 with variantSteps "auto" and a catalog entry. */
export interface TierVariantInfo {
  /** "provider/model" of the tier. */
  model: string;
  /** tier.variant (a catalog member) or DEFAULT_VARIANT. */
  base: string;
  /** buildVariantLadder(...) for that model. */
  ladder: VariantLadder;
  /** inputBudget(catalogEntry.limit) (A5/A10). */
  inputBudget: number | null;
}

export interface VariantPolicy {
  /** routing.sessionReuse.maxContextFraction (default 0.6). */
  maxContextFraction: number;
  perTier: Record<string, TierVariantInfo>;
}

export interface EscalatePolicy {
  ladder: string[];
  floorTier?: string | null;
  maxAttemptsPerTier: number;
  maxTotalAttempts: number;
  costMultiple?: number | null;
  effortBump?: EffortBumpPolicy | null;
  variants?: VariantPolicy | null;
}

export interface LadderState {
  currentTier: string;
  attemptsThisTier: number;
  totalAttempts: number;
  escalations: number;
  firstAttemptCost: number | null;
  cumulativeCost: number;
  currentEffort?: EffortLevel | null;
  /** Variant reached by variant steps on the current tier; null = the tier's base. */
  currentVariant?: string | null;
  /** Variant steps taken in this delegation (never reset). */
  variantSteps?: number;
  /** Child of the latest attempt; null = none, or a fresh start is pending. */
  childSessionID?: string | null;
  /** stepContextTokens() of that child's last step; null = unknown. */
  lastStepTokens?: number | null;
  /** inputBudget of the model the next attempt runs on. */
  nextModelContext?: number | null;
}

export type LadderActionKind = "accept" | "retry" | "escalate" | "give_up";

export interface LadderAction {
  action: LadderActionKind;
  tier?: string;
  forcingMessage?: string;
  reason?: string;
  effort?: EffortLevel;
  /** Present only on a D10 variant step (action is "retry"). */
  variantStep?: true;
  /** Escalate only: target agent id (= tier name for router tiers). */
  agent?: string;
  /** "provider/model" of the target, when it has TierVariantInfo. */
  model?: string;
  /** Catalog-validated target variant; absent = default / leave unchanged. */
  variant?: string;
  /** Present on every retry/escalate when policy.variants is set. */
  resume?: boolean;
  /** D11 "decision and both numbers are logged"; present iff resume is. */
  resumeBasis?: ResumeDecision;
}

/** Fourth, optional argument of nextAction. */
export interface LadderSessionInput {
  dispatchPromptChars: number;
}

/** Child observation passed to recordAttempt after an attempt on a session-aware policy. */
export interface LadderChildObservation {
  sessionID: string;
  lastStepTokens: number | null;
}

/** Second, optional argument of buildEscalatePolicy (filled by Phase 2.3 from 1.1's resolved config). */
export interface LadderSessionPolicyInput {
  host: "v1" | "v2";
  /** Default "auto" (D10). */
  variantSteps?: "auto" | "none";
  /** Default 0.6 (§1.4). */
  maxContextFraction?: number;
  /** Catalog lookup for a "provider/model" id; must not throw. */
  catalog: (model: string) => CatalogModel | null | undefined;
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
  if (policy.variants) {
    state.currentVariant = null;
    state.variantSteps = 0;
    state.childSessionID = null;
    state.lastStepTokens = null;
    // Budget of the start tier (after floorTier).
    state.nextModelContext = ownTierInfo(policy, state.currentTier)?.inputBudget ?? null;
  }
  return state;
}

export function recordAttempt(
  state: LadderState,
  costUnits = 0,
  child?: LadderChildObservation,
): LadderState {
  const next: LadderState = {
    ...state,
    totalAttempts: state.totalAttempts + 1,
    cumulativeCost: state.cumulativeCost + costUnits,
    firstAttemptCost:
      state.firstAttemptCost == null ? costUnits : state.firstAttemptCost,
  };
  // Only a session-aware state records its child; otherwise the shape is unchanged.
  if (child && state.childSessionID !== undefined) {
    next.childSessionID = child.sessionID;
    next.lastStepTokens = child.lastStepTokens;
  }
  return next;
}

/** Own-property lookup, like the effort bump's, so a tier named `__proto__` cannot reach Object.prototype. */
function ownTierInfo(policy: EscalatePolicy, tier: string): TierVariantInfo | undefined {
  const perTier = policy.variants?.perTier;
  return perTier && Object.prototype.hasOwnProperty.call(perTier, tier) ? perTier[tier] : undefined;
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

/** A variant may be emitted only when it is the tier's validated base or a ladder member, never default. */
function emittable(info: TierVariantInfo, v: string): string | undefined {
  return v !== DEFAULT_VARIANT && (v === info.base || info.ladder.variants.includes(v)) ? v : undefined;
}

/** D11: the resume decision and both numbers for the attempt this action leads to. */
function sessionFields(
  state: LadderState,
  variants: VariantPolicy,
  target: TierVariantInfo | undefined,
  forcingMessage: string,
  session?: LadderSessionInput,
): Pick<LadderAction, "resume" | "resumeBasis"> {
  const resumeBasis = resumeDecision(
    {
      childSessionID: state.childSessionID,
      lastStepTokens: state.lastStepTokens,
      nextModelContext: target?.inputBudget ?? null, // the NEXT model's budget (A5)
    },
    {
      maxContextFraction: variants.maxContextFraction,
      nextPromptTokens: estimateTokensFromChars(forcingMessage.length + (session?.dispatchPromptChars ?? 0)),
    },
  );
  return { resume: resumeBasis.resume, resumeBasis };
}

/** D10 "escalate the model": skip next tiers on the same model whose base the current tier already covered. */
function skipCoveredTiers(
  next: string | null,
  state: LadderState,
  policy: EscalatePolicy,
  from: TierVariantInfo,
): string | null {
  const reached = variantPosition(state.currentVariant ?? from.base);
  if (reached === null) return next;
  let hops = 0;
  while (next != null) {
    const to = ownTierInfo(policy, next);
    if (!to || to.model !== from.model) return next;
    const position = variantPosition(to.base);
    if (position === null || position > reached) return next;
    if (++hops >= policy.ladder.length) return null; // guard: duplicate ladder entries cannot spin
    next = nextTierAfter(next, policy);
  }
  return null;
}

export function nextAction(
  state: LadderState,
  verdict: LadderVerdict | null | undefined,
  policy: EscalatePolicy,
  session?: LadderSessionInput,
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

  const variants = policy.variants ?? null;
  const info = variants ? ownTierInfo(policy, state.currentTier) : undefined;

  // (5V) variant step (D10): not gated by attemptsThisTier; steps 3 and 4 above
  // already bound it by maxTotalAttempts and the cost ceiling.
  if (variants && info) {
    const variant = nextVariant(info.ladder, state.currentVariant ?? info.base);
    if (variant !== null) {
      const forcingMessage = buildLadderForcingMessage(verdict?.reasons ?? []);
      return {
        action: "retry",
        tier: state.currentTier,
        forcingMessage,
        variantStep: true,
        model: info.model,
        variant,
        ...sessionFields(state, variants, info, forcingMessage, session),
      };
    }
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
      const current = state.currentEffort ?? bump.base;
      const startingEffort = minEffort(
        effortRank(current) < effortRank(bump.base) ? bump.base : current,
        bump.bound,
      );
      const effort = nextEffort(startingEffort, bump.bound)
        ?? (state.currentEffort == null ? undefined : startingEffort);
      if (effort !== undefined) action.effort = effort;
    }
    if (variants) {
      if (info) {
        action.model = info.model;
        const v = emittable(info, state.currentVariant ?? info.base);
        if (v !== undefined) action.variant = v; // keeps the reached variant on a fresh retry
      }
      Object.assign(action, sessionFields(state, variants, info, action.forcingMessage!, session));
    }
    return action;
  }

  // (6) escalate or give_up
  let next = nextTierAfter(state.currentTier, policy);
  if (variants && info) next = skipCoveredTiers(next, state, policy, info);
  if (next == null) {
    return {
      action: "give_up",
      reason: "no higher tier (already at top of ladder)",
    };
  }
  const action: LadderAction = {
    action: "escalate",
    tier: next,
    forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
  };
  if (variants) {
    const target = ownTierInfo(policy, next);
    action.agent = next; // D11: the role changes on escalation
    if (target) {
      action.model = target.model;
      const v = emittable(target, target.base);
      if (v !== undefined) action.variant = v;
    }
    Object.assign(action, sessionFields(state, variants, target, action.forcingMessage!, session));
  }
  return action;
}

/** Session bookkeeping of an advance; a no-op on states that are not session-aware. */
function applySession(next: LadderState, action: LadderAction): void {
  if (next.childSessionID === undefined) return; // not session-aware: shape unchanged
  if (action.resume !== true) next.childSessionID = null; // fresh start: clear the stale child
  next.lastStepTokens = null; // must be re-observed after the next attempt
  next.nextModelContext = action.resumeBasis?.budget ?? null;
}

export function advance(state: LadderState, action: LadderAction): LadderState {
  if (action.action === "retry") {
    const next: LadderState = { ...state };
    if (action.variantStep === true) {
      next.currentVariant = action.variant ?? null;
      next.variantSteps = (state.variantSteps ?? 0) + 1; // does NOT touch attemptsThisTier
    } else {
      next.attemptsThisTier = state.attemptsThisTier + 1;
    }
    if (action.effort !== undefined) next.currentEffort = action.effort;
    applySession(next, action);
    return next;
  }
  if (action.action === "escalate") {
    const next: LadderState = {
      ...state,
      currentTier: action.tier!,
      attemptsThisTier: 0,
      escalations: state.escalations + 1,
    };
    if (next.currentEffort !== undefined) next.currentEffort = null;
    if (next.currentVariant !== undefined) next.currentVariant = null; // new tier starts at its base
    applySession(next, action);
    return next;
  }
  // accept / give_up — terminal, return unchanged
  return state;
}

export function buildEscalatePolicy(
  cfg: RouterConfig,
  session?: LadderSessionPolicyInput,
): EscalatePolicy {
  const esc = cfg.enforcement?.escalate;
  const policy: EscalatePolicy = {
    ladder: esc?.ladder ?? ["fast", "medium", "heavy"],
    floorTier: esc?.floorTier ?? null,
    maxAttemptsPerTier: esc?.maxAttemptsPerTier ?? 1,
    maxTotalAttempts: esc?.maxTotalAttempts ?? 4,
    costMultiple: esc?.costCeiling?.multiple ?? 4,
  };
  const effortBump = buildEffortBump(cfg);
  // Keep bump-off policies byte-identical to the original golden fixture.
  if (effortBump) policy.effortBump = effortBump;
  const variants = buildVariantPolicy(cfg, session);
  // Absent key when off, so policies without session input stay byte-identical.
  if (variants) policy.variants = variants;
  return policy;
}

function buildVariantPolicy(
  cfg: RouterConfig,
  session?: LadderSessionPolicyInput,
): VariantPolicy | null {
  if (!session || session.host !== "v2" || (session.variantSteps ?? "auto") === "none") return null; // D1, D10
  const { max } = resolveEffortBump(cfg); // cap for catalog ladders (F2)
  const entries: Array<[string, TierVariantInfo]> = [];
  for (const [name, tier] of Object.entries(getActiveTiers(cfg) ?? {})) {
    if (tier === null || typeof tier !== "object" || typeof tier.model !== "string" || tier.model.length === 0) continue;
    const configured = typeof tier.variant === "string" && tier.variant.length > 0 ? tier.variant : null;
    // One effort delivery per tier (F3): effort/thinking/reasoning-configured tiers keep the effortBump path.
    if (configured === null && (tier.effort !== undefined || tier.thinking !== undefined || tier.reasoning !== undefined)) continue;
    const entry = session.catalog(tier.model);
    const ids = catalogVariantIds(entry);
    if (ids === null) continue; // no catalog: today's behaviour for this tier
    if (configured !== null && !ids.includes(configured)) continue; // invalid configured variant: never resume-switch it
    const raw = (tier as { candidates?: unknown }).candidates; // raw config, never resolveCandidates() (F11)
    entries.push([name, {
      model: tier.model,
      base: configured ?? DEFAULT_VARIANT,
      ladder: buildVariantLadder({
        model: tier.model,
        catalog: entry,
        candidates: Array.isArray(raw) ? raw : undefined,
        maxEffort: max,
      }),
      inputBudget: inputBudget(entry?.limit),
    }]);
  }
  if (entries.length === 0) return null;
  return { maxContextFraction: session.maxContextFraction ?? 0.6, perTier: Object.fromEntries(entries) };
}

function buildEffortBump(cfg: RouterConfig): EffortBumpPolicy | null {
  const { enabled, max } = resolveEffortBump(cfg);
  if (!enabled) return null;
  const entries: Array<[string, { base: EffortLevel; bound: EffortLevel }]> = [];
  for (const [name, tier] of Object.entries(getActiveTiers(cfg) ?? {})) {
    if (typeof tier?.model !== "string") continue;
    const ceiling = effortCeilingFor(tier);
    // A non-null ceiling also validates the configured effort (D7).
    if (ceiling === null || tier.effort === undefined) continue;
    const base = tier.effort;
    const bound = minEffort(ceiling, max);
    if (effortRank(bound) <= effortRank(base)) continue;
    entries.push([name, { base, bound }]);
  }
  return entries.length > 0 ? { perTier: Object.fromEntries(entries) } : null;
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
    `[router delegate scorecard | final_tier=${state.currentTier}${state.currentEffort ? `@${state.currentEffort}` : state.currentVariant ? `#${state.currentVariant}` : ""} | ` +
    `attempts=${state.totalAttempts} | escalations=${state.escalations} | ` +
    `cost=${state.cumulativeCost} | verdict=${accepted ? "PASS" : "UNMET"} | ` +
    `method=${method}]`
  );
}
