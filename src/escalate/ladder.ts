import { effortCeilingFor, effortRank, minEffort, nextEffort } from "../router/agent-options";
import { resolveEffortBump, type EffortLevel, type RouterConfig, type TierConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import {
  DEFAULT_VARIANT,
  buildVariantLadder,
  catalogVariantIds,
  estimateTokensFromChars,
  inputBudget,
  nextVariant,
  resumeDecision,
  variantCovered,
  variantRange,
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
  /**
   * Rung -> costRatio (A17): the matching candidate's own `costRatio` when the tier configures one,
   * else the tier's `costRatio`. Keyed by variant id; `default` for the bare model. A missing key
   * means the ratio is unknown and the runner charges the tier's `costRatio`.
   */
  costRatios: Record<string, number>;
  /**
   * Set when the tier configures `effort`/`thinking`/`reasoning` (A20, QA-1.5-18): its effort travels
   * on the effort path only, so it has an empty variant ladder, is never treated as covered by another
   * tier and never counts as a coverage source in `triedByModel`.
   */
  effortConfigured?: true;
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
  /**
   * inputBudget of the model the next attempt runs on. Telemetry only (QA-1.5-14): `advance` and
   * `newLadderState` store it so a log or scorecard can show it, but `nextAction` never reads it. The
   * decision uses the budget of the target tier, which `sessionFields` puts into a probe state.
   */
  nextModelContext?: number | null;
  /**
   * A17a (QA-1.5-17): the highest rung run per model in this delegation, `model -> variant`
   * (`default` for the bare model). Session-aware states only. Variant steps and escalations raise it
   * (plain retries repeat a rung and do not); an escalation into a tier whose base it covers enters
   * above it or skips the tier, so the ladder never re-runs a `(model, variant)` that already failed.
   */
  triedByModel?: Record<string, string>;
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
  /**
   * Escalate only: the target tier is covered by a rung already tried on its model (A17a), so it is
   * entered at `variant`, the first rung above that one, instead of at its base; advance seeds currentVariant.
   */
  carryVariant?: true;
  /**
   * The `(model, variant)` rung this action starts, recorded by `advance` into `triedByModel`
   * (`default` for the bare model). On variant steps and escalations only, never on plain retries.
   */
  rung?: { model: string; variant: string };
  /**
   * A17: costRatio of the rung this action runs (`model` + `variant`), on variant steps, plain
   * retries and escalations when it is known. The runner charges `action.costRatio ?? tier.costRatio`.
   */
  costRatio?: number;
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
  /** Catalog lookup for a "provider/model" id. A throwing lookup is treated as no catalog entry (QA-1.5-15). */
  catalog: (model: string) => CatalogModel | null | undefined;
  /** Receives one line per failed catalog lookup; its own failures are swallowed. */
  warn?: (message: string) => void;
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
    const start = ownTierInfo(policy, state.currentTier);
    state.nextModelContext = start?.inputBudget ?? null; // telemetry only
    // The first attempt runs the start tier's base, unless the tier is effort-configured (QA-1.5-18).
    state.triedByModel = start && !start.effortConfigured ? { [start.model]: start.base } : {};
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

/**
 * Record a rung in `triedByModel`, keeping the entry with the higher guaranteed effort (the lowest
 * effort the rung can have, so a `default` rung never outranks a ranked one). Pure: never mutates.
 */
function raiseTried(tried: Record<string, string> | undefined, model: string, variant: string): Record<string, string> {
  const current = tried ?? {};
  if (Object.prototype.hasOwnProperty.call(current, model)) {
    const known = variantRange(current[model]);
    const next = variantRange(variant);
    if (next === null || (known !== null && next.low <= known.low)) return current;
  }
  return { ...current, [model]: variant };
}

/** A variant may be emitted only when it is the tier's validated base or a ladder member, never default. */
function emittable(info: TierVariantInfo, v: string): string | undefined {
  return v !== DEFAULT_VARIANT && (v === info.base || info.ladder.variants.includes(v)) ? v : undefined;
}

/** A17: costRatio of the rung `variant` (default when absent) of a tier; `undefined` when unknown. */
function costFields(info: TierVariantInfo, variant: string | undefined): Pick<LadderAction, "costRatio"> {
  const costRatio = costRatioOf(info, variant);
  return costRatio === undefined ? {} : { costRatio };
}

function costRatioOf(info: TierVariantInfo, variant: string | undefined): number | undefined {
  const ratios = info.costRatios;
  const key = variant ?? DEFAULT_VARIANT;
  return ratios && Object.prototype.hasOwnProperty.call(ratios, key) ? ratios[key] : undefined;
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

/** Ladder tiers above `tier` (A17's H); 0 when the tier is not on the ladder. */
function tiersAbove(policy: EscalatePolicy, tier: string): number {
  const index = tierRank(tier, policy.ladder);
  return index < 0 ? 0 : policy.ladder.length - 1 - index;
}

/** A17: `maxTotalAttempts − totalAttempts − 1 ≥ H`, so every ladder tier above keeps at least one attempt. */
function reserveAllows(policy: EscalatePolicy, state: LadderState): boolean {
  return policy.maxTotalAttempts - state.totalAttempts - 1 >= tiersAbove(policy, state.currentTier);
}

/** Where an escalation lands. `variant` is set when the target tier is covered but has rungs above (A17a). */
interface EscalationTarget {
  tier: string | null;
  variant?: string;
}

/**
 * A17a (QA-1.5-17, QA-1.5-4): the ladder never re-runs a `(model, variant)` that already failed. For each
 * next tier, `reached` is the highest rung tried on THAT tier's model (`triedByModel`, plus the rung the
 * failed attempt just ran), whichever tier ran it. If the tier's base is not covered by `reached` (QA-1.5-3:
 * `default` is a range, see `variantCovered`), it is entered at its base. If it is covered, it is entered at
 * `nextVariant(to.ladder, reached)`, the first rung above `reached`, or skipped when there is none.
 */
function skipCoveredTiers(
  next: string | null,
  state: LadderState,
  policy: EscalatePolicy,
  from: TierVariantInfo,
): EscalationTarget {
  // An effort-configured tier is never a coverage source (QA-1.5-18): its own rung is not recorded.
  const tried = from.effortConfigured
    ? (state.triedByModel ?? {})
    : raiseTried(state.triedByModel, from.model, state.currentVariant ?? from.base);
  let hops = 0;
  while (next != null) {
    const to = ownTierInfo(policy, next);
    // ...and never covered: its effort delivery differs from any variant rung, so it always runs.
    if (!to || to.effortConfigured) return { tier: next };
    const reached = Object.prototype.hasOwnProperty.call(tried, to.model) ? tried[to.model] : undefined;
    if (reached === undefined || !variantCovered(to.base, reached)) return { tier: next };
    const entry = nextVariant(to.ladder, reached);
    if (entry !== null) return { tier: next, variant: entry };
    if (++hops >= policy.ladder.length) return { tier: null }; // guard: duplicate ladder entries cannot spin
    next = nextTierAfter(next, policy);
  }
  return { tier: null };
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
  // A17/A17a budget reserve: whenever variant steps are enabled for the session (`policy.variants`),
  // spending another attempt on any tier (variant step or plain retry, cataloged or not) must leave
  // one attempt for each ladder tier above; otherwise escalate now (QA-1.5-21). Without
  // `policy.variants` the ladder is exactly the 2.2.0 one.
  const mayStay = !variants || reserveAllows(policy, state);

  // (5V) variant step (D10): not gated by attemptsThisTier; steps 3 and 4 above already bound it by
  // maxTotalAttempts and the cost ceiling.
  const variantStep = (): LadderAction | null => {
    if (!variants || !info) return null;
    const variant = nextVariant(info.ladder, state.currentVariant ?? info.base);
    if (variant === null) return null;
    const forcingMessage = buildLadderForcingMessage(verdict?.reasons ?? []);
    return {
      action: "retry",
      tier: state.currentTier,
      forcingMessage,
      variantStep: true,
      model: info.model,
      variant,
      ...costFields(info, variant),
      ...(info.effortConfigured ? {} : { rung: { model: info.model, variant } }),
      ...sessionFields(state, variants, info, forcingMessage, session),
    };
  };

  // (5) retry within tier
  const plainRetry = (): LadderAction | null => {
    if (state.attemptsThisTier >= policy.maxAttemptsPerTier) return null;
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
        Object.assign(action, costFields(info, action.variant));
      }
      Object.assign(action, sessionFields(state, variants, info, action.forcingMessage!, session));
    }
    return action;
  };

  if (mayStay) {
    const stay = variantStep() ?? plainRetry();
    if (stay) return stay;
  }

  // (6) escalate or give_up
  let next = nextTierAfter(state.currentTier, policy);
  const tierAbove = next != null;
  let entry: string | undefined;
  if (variants && info) ({ tier: next, variant: entry } = skipCoveredTiers(next, state, policy, info));
  if (next == null) {
    // QA-1.5-19: the reserve withheld these attempts for tiers above, but none is left to run (every
    // one only repeats a rung already tried), so spend them here instead of giving up with budget left.
    if (!mayStay) {
      const spend = variantStep() ?? plainRetry();
      if (spend) return spend;
    }
    return {
      action: "give_up",
      reason: tierAbove
        ? "no higher tier left to try (the remaining tiers only repeat rungs already tried)"
        : "no higher tier (already at top of ladder)",
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
      // A covered tier is entered above the rung already tried on its model (A17a), always a member of
      // its own ladder; any other tier at its base.
      const v = entry ?? emittable(target, target.base);
      if (v !== undefined) {
        action.variant = v;
        if (entry !== undefined) action.carryVariant = true;
      }
      Object.assign(action, costFields(target, action.variant));
      if (!target.effortConfigured) action.rung = { model: target.model, variant: action.variant ?? DEFAULT_VARIANT };
    }
    Object.assign(action, sessionFields(state, variants, target, action.forcingMessage!, session));
  }
  return action;
}
/** Records the rung an action starts into `triedByModel`; a no-op on states without it. */
function applyRung(next: LadderState, action: LadderAction): void {
  if (next.triedByModel === undefined || action.rung === undefined) return;
  next.triedByModel = raiseTried(next.triedByModel, action.rung.model, action.rung.variant);
}

/** Session bookkeeping of an advance; a no-op on states that are not session-aware. */
function applySession(next: LadderState, action: LadderAction): void {
  if (next.childSessionID === undefined) return; // not session-aware: shape unchanged
  if (action.resume !== true) next.childSessionID = null; // fresh start: clear the stale child
  next.lastStepTokens = null; // must be re-observed after the next attempt
  next.nextModelContext = action.resumeBasis?.budget ?? null; // telemetry only: nextAction never reads it
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
    applyRung(next, action);
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
    // A new tier starts at its base, unless it is entered above a rung already tried on its model (A17a).
    if (next.currentVariant !== undefined) next.currentVariant = action.carryVariant === true ? (action.variant ?? null) : null;
    applyRung(next, action);
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

/** costRatio as 1.1 validates it: a finite number above 0. */
function validCostRatio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A17: the costRatio of every rung a tier can run (its base and its ladder): a candidate of the same
 * model naming that variant (no variant = `default`) with its own `costRatio`, else the tier's.
 * Rungs without any ratio are omitted, so the runner falls back to the tier's `costRatio`.
 */
function rungCostRatios(
  tier: TierConfig,
  rawCandidates: unknown,
  base: string,
  ladder: VariantLadder,
): Record<string, number> {
  const tierRatio = validCostRatio(tier.costRatio);
  const own = new Map<string, number>();
  if (Array.isArray(rawCandidates)) {
    for (const candidate of rawCandidates) {
      if (candidate === null || typeof candidate !== "object") continue;
      const model = typeof candidate.model === "string" && candidate.model.length > 0 ? candidate.model : tier.model;
      const ratio = validCostRatio(candidate.costRatio);
      if (model !== tier.model || ratio === undefined) continue;
      const rung = typeof candidate.variant === "string" && candidate.variant.length > 0 ? candidate.variant : DEFAULT_VARIANT;
      if (!own.has(rung)) own.set(rung, ratio);
    }
  }
  const entries: Array<[string, number]> = [];
  for (const rung of new Set([base, ...ladder.variants])) {
    const ratio = own.get(rung) ?? tierRatio;
    if (ratio !== undefined) entries.push([rung, ratio]);
  }
  return Object.fromEntries(entries);
}

/** QA-1.5-15: a throwing catalog is "no catalog" for that model, logged once per lookup and never raised. */
function lookupCatalog(session: LadderSessionPolicyInput, model: string): CatalogModel | null | undefined {
  try {
    return session.catalog(model);
  } catch (error) {
    try {
      const reason = error instanceof Error ? error.message : String(error);
      session.warn?.(`[router] ladder: catalog lookup for ${model} failed (${reason}); treating it as no catalog entry`);
    } catch {
      // logging must never break policy construction
    }
    return undefined;
  }
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
    // QA-1.5-6: every tier with a catalog entry gets variant info (and its input budget), whether or
    // not it can step; a tier without an entry keeps today's behaviour (no info, fresh start).
    const entry = lookupCatalog(session, tier.model);
    if (entry === null || entry === undefined || typeof entry !== "object") continue;
    const ids = catalogVariantIds(entry);
    const configured = typeof tier.variant === "string" && tier.variant.length > 0 ? tier.variant : null;
    if (configured !== null && !(ids ?? []).includes(configured)) continue; // invalid configured variant: never resume-switch it
    // One effort delivery per tier (F3, A20): a tier that configures effort/thinking/reasoning stays on
    // the effort path only, with or without a `variant`, and gets an empty variant ladder; it still
    // carries its model, base and budget.
    const effortConfigured = tier.effort !== undefined || tier.thinking !== undefined || tier.reasoning !== undefined;
    const raw = (tier as { candidates?: unknown }).candidates; // raw config, never resolveCandidates() (F11)
    const base = configured ?? DEFAULT_VARIANT;
    const ladder = effortConfigured
      ? buildVariantLadder({ model: tier.model, catalog: null })
      : buildVariantLadder({
          model: tier.model,
          catalog: entry,
          candidates: Array.isArray(raw) ? raw : undefined,
          maxEffort: max,
        });
    entries.push([name, {
      model: tier.model,
      base,
      ladder,
      inputBudget: inputBudget(entry.limit),
      costRatios: rungCostRatios(tier, raw, base, ladder),
      ...(effortConfigured ? { effortConfigured: true as const } : {}),
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
