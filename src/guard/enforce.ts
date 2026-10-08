import {
  evaluateGuards,
  updateState,
  recordBlock,
  recordDenied,
  forcingMessage,
  observationOk,
  guardStopped,
} from "./guards";
import type { GuardPolicy, GuardCall, GuardState } from "./guards";
import { scrubText } from "./scrub";
import { resolveEnforcementMode } from "../router/enforcement";
import type { EnforcementMode } from "../router/enforcement";
import type { RouterConfig } from "../router/config";
import {
  GUARD_CUMULATIVE_MULTIPLIER,
  TIER_GUARD_BUDGET,
  positiveBudget,
  readerReason,
} from "../router/guard-profile";
import type { GuardProfile } from "../router/guard-profile";
import { getActiveTiers } from "../router/protocol";
import { isReadOnlyTier } from "../router/read-only";
import { lookupDispatch } from "../router/sessions";
import type { Cap } from "../router/sessions";

/**
 * Default total tool-call ceiling for an enforced subagent delegation. This is a
 * hard budget (all tool calls), distinct from the read-only cap in tiers.json.
 * Deliberately generous so enforced mode never false-stops ordinary work;
 * tuned with field data in Phase 4.3 (preliminary).
 */
export const DEFAULT_GUARD_BUDGET = TIER_GUARD_BUDGET;

/**
 * The cumulative ceiling spans resumed dispatches: it is this multiple of the
 * effective per-dispatch budget (configured or default), giving resumed
 * subagents bounded room without unbounded same-session loops.
 */
export const CUMULATIVE_BUDGET_MULTIPLIER = GUARD_CUMULATIVE_MULTIPLIER;

/** Default-case cumulative budget, retained for imports/tests. */
export const CUMULATIVE_GUARD_BUDGET =
  DEFAULT_GUARD_BUDGET * CUMULATIVE_BUDGET_MULTIPLIER;

export interface GuardStoreLike {
  ensure(sessionID: string, policy: GuardPolicy): GuardState;
  get(sessionID: string): GuardState | undefined;
  setPendingNote(sessionID: string, note: string): void;
  takePendingNote(sessionID: string): string | undefined;
}

/** Build a GuardPolicy from config for a given subagent tier. deliverableSignal
 * is null in Wave 1 (Mode A/B signal wiring lands in Wave 2/4), which disables
 * the deliverable-first clause — the honest common case (M5).
 *
 * Without `profile` (tier agents) the result is unchanged: the configured or
 * default budget (25) and cumulative ×3. A role `profile` (§2.6) supplies the
 * total and cumulative budgets, the reader/producer kind, and the
 * `NEED MORE: budget` exhaustion instruction; an invalid profile budget falls
 * back to the tier budget, and the cumulative ceiling is never below it. */
export function buildGuardPolicy(
  cfg: RouterConfig,
  tier: string | null,
  profile?: GuardProfile | undefined,
): GuardPolicy {
  const g = cfg.enforcement?.guard ?? {};
  const tierBudget = g.budget ?? DEFAULT_GUARD_BUDGET;
  const budget = profile ? (positiveBudget(profile.budget) ?? tierBudget) : tierBudget;
  const cumulative = profile
    ? Math.max(budget, positiveBudget(profile.cumulative) ?? budget * CUMULATIVE_BUDGET_MULTIPLIER)
    : budget * CUMULATIVE_BUDGET_MULTIPLIER;
  return {
    budget,
    cumulativeBudget: cumulative,
    readDraftCap: g.readDraftCap ?? 3,
    sameOpRetryCap: g.sameOpRetryCap ?? 1,
    blockSelfScript: g.blockSelfScript ?? true,
    deliverableFirst: g.deliverableFirst ?? true,
    blockScriptWrites: g.blockScriptWrites ?? false,
    deliverableSignal: null,
    ...(profile ? { reader: profile.kind === "reader", needMoreOnExhaustion: true } : {}),
  };
}

/**
 * §2.9 E6: does this tier dispatch read rather than produce? A role profile
 * decides alone; otherwise a read-only tier (#78), a routed class
 * review/recon/search (the process-wide dispatch registry), or an uncapped
 * dispatch: `cap` is the CURRENT dispatch round's honoured CAP directive, read by
 * the caller from the session store (sessions.ts getCap), which a resume resets
 * (QA-P15-1-3) — so it is known before the first call and never outlives a round.
 */
function isReaderDispatch(
  cfg: RouterConfig,
  tier: string | null,
  sessionID: string,
  profile: GuardProfile | undefined,
  cap: Cap | null | undefined,
): boolean {
  let readOnlyTier = false;
  if (tier !== null && cfg.presets) {
    const tiers = getActiveTiers(cfg);
    const definition = tiers && Object.prototype.hasOwnProperty.call(tiers, tier) ? tiers[tier] : undefined;
    readOnlyTier = definition !== undefined && isReadOnlyTier(tier, definition);
  }
  return (
    readerReason({
      profile,
      readOnlyTier,
      taskClass: lookupDispatch(sessionID)?.facts.class ?? null,
      cap: cap ?? null,
    }) !== null
  );
}

// budgetExhausted: process-wide (one guard store per plugin instance; every instance
// guards the same child), bounded, most recently guarded sessions kept.
const MAX_TRACKED_BUDGETS = 1000;
const trackedBudgets = new Map<string, { state: GuardState; cumulativeBudget?: number }>();

function trackBudget(sessionID: string, state: GuardState, policy: GuardPolicy): void {
  trackedBudgets.delete(sessionID);
  trackedBudgets.set(sessionID, { state, cumulativeBudget: policy.cumulativeBudget });
  // Re-inserted above, so the first key is the least recently guarded session.
  while (trackedBudgets.size > MAX_TRACKED_BUDGETS) {
    trackedBudgets.delete(trackedBudgets.keys().next().value as string);
  }
}

/** Guards whose ENFORCED refusal is a stop: the child must return now (QA-P15-2-1). */
const STOP_GUARDS: ReadonlySet<string> = new Set(["iteration_cap", "cumulative_iteration_cap", "denied_cap"]);

/**
 * True when the guard really STOPPED the session in its current dispatch round:
 * an enforced refusal by iteration_cap, cumulative_iteration_cap or denied_cap
 * (QA-P15-2-1). Never in advisory mode (nothing is refused), never for a child
 * that merely finished at exactly its budget, false after a resume and for a
 * session never guarded or no longer tracked. P-5: the after-hook annotates the
 * parent's result from this.
 */
export function budgetExhausted(sessionID: string): boolean {
  const tracked = trackedBudgets.get(sessionID);
  return tracked !== undefined && tracked.state.stopped?.round === tracked.state.dispatches;
}

/** What the guard knew about a producer session when its task returned (QA-P15-2-2, 2-5). */
export interface BudgetSnapshot {
  /** The guard tracked the session (false: enforcement off, never guarded, or evicted). */
  tracked: boolean;
  /** budgetExhausted: an enforced stop in the returning round. */
  stopped: boolean;
  /** Budget or refusals used up — validates a `NEED MORE: budget` claim. */
  usedUp: boolean;
  /** The session store's read-only counter reached its cap (calls >= cap). */
  readCapReached?: boolean;
}

/**
 * Capture a producer session's budget state at the moment its task returns
 * (QA-P15-2-5): the gate judges that snapshot, not the live state at
 * verification time. `readCapReached` comes from the session store
 * (sessions.ts readCapReached), which the guard cannot see.
 */
export function captureBudget(sessionID: string, readCapReached?: boolean): BudgetSnapshot {
  const tracked = sessionID === "" ? undefined : trackedBudgets.get(sessionID);
  return {
    tracked: tracked !== undefined,
    stopped: tracked !== undefined && tracked.state.stopped?.round === tracked.state.dispatches,
    usedUp: tracked !== undefined && guardStopped(tracked.state, tracked),
    ...(readCapReached !== undefined ? { readCapReached } : {}),
  };
}

export interface BeforeResult {
  block: boolean;
  message?: string;
  mode: EnforcementMode;
  guard?: string | null;
}

/** Compact per-delegation scorecard, emitted only when enforcement was active. */
export function formatScorecard(state: GuardState, tier: string | null): string {
  const ttfa = state.ttfa == null ? "n/a" : String(state.ttfa);
  return `[router scorecard | tier=${tier ?? "?"} | ttfa=${ttfa} | read:exec=${state.readCount}:${state.execCount} | self_scripts=${state.selfScriptCount} | tool_calls=${state.toolCallCount} | blocks=${state.blockedCount} | stop=${state.lastBlock ?? "none"}]`;
}

/**
 * Decide whether a subagent tool call must be hard-blocked. The caller (the
 * tool.execute.before hook) throws with `message` when block===true. In "off"
 * mode this returns immediately WITHOUT creating guard state, so the after-hook
 * stays a no-op and behaviour is byte-identical (GA-1).
 */
export function guardBeforeCall(params: {
  cfg: RouterConfig;
  tier: string | null;
  sessionID: string;
  tool: string;
  toolArgs: unknown;
  store: GuardStoreLike;
  env: Record<string, string | undefined>;
  trivial?: boolean;
  /** Role dispatch guard profile (§2.6); absent for tier agents. */
  profile?: GuardProfile;
  /** The current dispatch round's honoured CAP directive (sessions.ts getCap); "none" = CAP:none + reason:. */
  cap?: Cap | null;
}): BeforeResult {
  const { cfg, tier, sessionID, tool, toolArgs, store, env, trivial, profile, cap } = params;
  let mode = resolveEnforcementMode({ config: cfg, tier: tier ?? undefined, env }).mode;
  if (
    mode === "enforced" &&
    trivial === true &&
    cfg.enforcement?.proportional?.trivialBypass !== false
  ) {
    mode = "advisory";
  }
  if (mode === "off") return { block: false, mode };

  const policy = buildGuardPolicy(cfg, tier, profile);
  const state = store.ensure(sessionID, policy);
  trackBudget(sessionID, state, policy);
  if (isReaderDispatch(cfg, tier, sessionID, profile, cap)) policy.reader = true;
  const call: GuardCall = { tool, args: (toolArgs ?? {}) as Record<string, unknown> };
  const decision = evaluateGuards(state, call, policy);

  if (decision.allow) return { block: false, mode, guard: null };

  if (mode === "enforced") {
    // §2.9 E6: the refused call never runs, so it is not charged to the budget
    // and not recorded as executed by the repeat check; CLAUSE 3c bounds a loop
    // of refusals instead.
    recordDenied(state, call, policy);
    recordBlock(state, decision);
    if (decision.guard !== null && STOP_GUARDS.has(decision.guard)) {
      state.stopped = { round: state.dispatches, guard: decision.guard };
    }
    const message = scrubText(`${decision.observation}\n${forcingMessage(state, policy)}`);
    return { block: true, mode, message, guard: decision.guard };
  }

  // advisory: never block; record the would-block and stash a banner the
  // after-hook will append to this call's output.
  recordBlock(state, decision);
  store.setPendingNote(
    sessionID,
    scrubText(`[\u26a0 GUARD:${decision.guard}] ${forcingMessage(state, policy)}`),
  );
  return { block: false, mode, guard: decision.guard };
}

/**
 * Update guard state after an ALLOWED call has executed (we now know ok), and
 * surface any pending advisory banner by appending it to the tool output.
 * No-op when guard state was never created (off mode) => GA-1 preserved.
 */
export function guardAfterCall(params: {
  cfg: RouterConfig;
  tier: string | null;
  sessionID: string;
  tool: string;
  toolArgs: unknown;
  output: { output?: unknown };
  store: GuardStoreLike;
  /** Role dispatch guard profile (§2.6); absent for tier agents. */
  profile?: GuardProfile;
}): void {
  const { cfg, tier, sessionID, tool, toolArgs, output, store, profile } = params;
  const state = store.get(sessionID);
  if (!state) return;
  const policy = buildGuardPolicy(cfg, tier, profile);
  const call: GuardCall = { tool, args: (toolArgs ?? {}) as Record<string, unknown> };
  updateState(state, call, { ok: observationOk(output?.output) }, policy);
  const note = store.takePendingNote(sessionID);
  if (note) {
    const existing = typeof output.output === "string" ? output.output : "";
    output.output = existing ? `${existing}\n\n${note}` : note;
  }
}
