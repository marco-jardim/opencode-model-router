/**
 * Phase 2.3 (M5 in `delegate`): turns a ladder action into the attempt the runner executes.
 *
 * The ladder algebra (`ladder.ts`) decides WHAT the next attempt is (a variant step, a plain retry, an
 * escalation, with the D11 resume verdict). This module decides HOW the runner carries it out, in one pure
 * place the runner and the tests share:
 *
 * - which agent and `provider/model#variant` the attempt dispatches;
 * - whether it resumes the previous child session (`sessionID`) or starts a fresh one, and why;
 * - the catalog validation of the target variant before the call (D10: an invalid variant never reaches the
 *   host; the attempt starts fresh on the tier's configured model, and its effort travels as an effort
 *   override when the variant is an effort level);
 * - the two host behaviours that are unverified on 2.0.22 and therefore start fresh (see `FreshReason`).
 *
 * Nothing here does I/O. The v1 path never reaches the session-aware branches: they need
 * `action.model`, which only a session-aware policy (v2, `variantSteps: "auto"`, a catalog) sets, so with
 * no `routing` block (A15) the plan is exactly what the runner always dispatched.
 */

import { EFFORT_LEVELS, type EffortLevel, type RouterConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import type { LadderStepKind } from "../routing/outcomes/types";
import type { EscalatePolicy, LadderAction, LadderState } from "./ladder";
import { DEFAULT_VARIANT, catalogVariantIds, type CatalogModel, type ResumeDecision } from "./variants";

/** A catalog entry as the runner needs it: the variants and limits of `variants.ts` plus the model identity. */
export interface RunnerCatalogModel extends CatalogModel {
  readonly providerID: string;
  readonly id: string;
}

/** Non-throwing lookup of a `provider/model` id in the host catalog. */
export type CatalogLookup = (model: string) => CatalogModel | null | undefined;

/** Builds the lookup from a host model list, keyed `providerID/id`. A malformed entry is skipped, a repeat keeps the first. */
export function createCatalogLookup(models: readonly RunnerCatalogModel[]): CatalogLookup {
  const byRef = new Map<string, CatalogModel>();
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.providerID !== "string" || entry.providerID === "" || typeof entry.id !== "string" || entry.id === "") continue;
    const ref = `${entry.providerID}/${entry.id}`;
    if (!byRef.has(ref)) byRef.set(ref, entry);
  }
  return (model) => byRef.get(model);
}

export interface AttemptModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

/**
 * Why an attempt that the ladder marked `resume` (or could have resumed) starts a fresh child instead.
 *
 * - `invalid-variant`: the target variant is not in the live catalog (D10 fallback, logged).
 * - `bare-model-after-variant` (1.5 R1): the escalation sends a bare `provider/model` to a child whose stored
 *   variant was set by an earlier step. 0.P never resumed with a bare model after a variant, so it is unknown
 *   whether the host stores `default` or keeps the old variant; a fresh child is the only path whose effort is known.
 * - `effort-path` (1.5 QA-1.5-22): an escalation (agent switch) across a tier that configures
 *   `effort`/`thinking`/`reasoning`. Whether a resumed child keeps the previous agent's effort options is
 *   unverified, so the least trusted path starts fresh until 3.2 proves it.
 */
export type FreshReason = "invalid-variant" | "bare-model-after-variant" | "effort-path";

/** What the runner executes for one ladder attempt. */
export interface AttemptPlan {
  /** Kind of attempt (the registry's `step`): `dispatch` for the first one. */
  readonly step: LadderStepKind;
  /** Ladder tier the attempt runs for (configuration, guards, cost). */
  readonly tier: string;
  /** Agent id to dispatch (the tier name for a router tier). */
  readonly agent: string;
  /** Model and variant to dispatch; undefined when the tier's model does not resolve (as today). */
  readonly model?: AttemptModel;
  /** Resume this child instead of creating one. */
  readonly resumeSessionID?: string;
  /** The ladder's D11 verdict with both numbers, when the policy is session-aware. */
  readonly resumeBasis?: ResumeDecision;
  /** Set when the ladder said `resume` but the runner starts fresh anyway, or the variant was invalid. */
  readonly fresh?: FreshReason;
  /** Effort-bump override for the attempt's session (the ladder's, or the invalid-variant fallback). */
  readonly effort?: EffortLevel;
  /** costRatio of the rung the attempt runs (A17); undefined = the tier's ratio (also for the `invalid-variant` fallback). */
  readonly costRatio?: number;
  /** The variant the dispatch asks for, for the next plan's R1 check (undefined = the model's default). */
  readonly variant?: string;
}

function splitModel(ref: string | undefined): { providerID: string; modelID: string } | null {
  if (typeof ref !== "string") return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) return null;
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
}

function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Today's dispatch of a tier: its configured model and variant. */
function configuredModel(cfg: RouterConfig, tier: string): AttemptModel | undefined {
  const tierCfg = getActiveTiers(cfg)[tier];
  const parsed = splitModel(typeof tierCfg?.model === "string" ? tierCfg.model : undefined);
  if (parsed === null) return undefined;
  return { ...parsed, variant: tierCfg?.variant };
}

/** The first attempt of a delegation: the start tier exactly as the runner always dispatched it. */
export function planFirstAttempt(cfg: RouterConfig, tier: string): AttemptPlan {
  const model = configuredModel(cfg, tier);
  return {
    step: "dispatch",
    tier,
    agent: tier,
    ...(model === undefined ? {} : { model }),
    ...(model?.variant === undefined ? {} : { variant: model.variant }),
  };
}

export interface NextAttemptInput {
  /** The retry/escalate action `nextAction` returned. */
  readonly action: LadderAction;
  /** State after `advance(state, action)`: `currentTier` is the target tier; `childSessionID` survives only on resume. */
  readonly state: LadderState;
  /** The plan of the attempt that just ran (its variant is what the child's stored variant is). */
  readonly previous: AttemptPlan;
  readonly cfg: RouterConfig;
  readonly policy: EscalatePolicy;
  readonly catalog: CatalogLookup | undefined;
}

/** The attempt that follows a retry or escalate action. */
export function planNextAttempt(input: NextAttemptInput): AttemptPlan {
  const { action, state, previous, cfg, policy, catalog } = input;
  const tier = state.currentTier;
  const step: LadderStepKind = action.action === "escalate" ? "escalate" : action.variantStep === true ? "variant" : "retry";
  const agent = action.agent ?? tier;
  const costRatio = action.costRatio;
  const sessionAware = action.model !== undefined;

  let model: AttemptModel | undefined;
  let fresh: FreshReason | undefined;
  let effort: EffortLevel | undefined = action.effort;
  if (!sessionAware) {
    // No variant info for the target (v1, `variantSteps: none`, no catalog entry, an effort-configured tier):
    // exactly what the runner dispatched before this phase.
    model = configuredModel(cfg, tier);
  } else {
    const parsed = splitModel(action.model);
    const ids = catalogVariantIds(catalog?.(action.model!));
    const invalid =
      parsed === null || (action.variant !== undefined && (ids === null || !ids.includes(action.variant)));
    if (invalid) {
      // D10 fallback: a fresh session on the tier's model. When the variant names an effort level, the effort travels
      // as the producer-side effort override (the v1 path) and the model goes bare, so the effort is delivered once
      // and never next to a variant (A7/F3: which one wins on the wire is unverified). Otherwise the tier's own
      // model and variant, with no effort.
      fresh = "invalid-variant";
      const configured = configuredModel(cfg, tier);
      if (configured !== undefined && action.variant !== undefined && isEffortLevel(action.variant)) {
        model = { providerID: configured.providerID, modelID: configured.modelID };
        effort = effort ?? action.variant;
      } else {
        model = configured;
      }
    } else {
      model = { ...parsed, ...(action.variant === undefined ? {} : { variant: action.variant }) };
    }
  }

  let resumeSessionID: string | undefined;
  if (action.resume === true && typeof state.childSessionID === "string" && state.childSessionID !== "") {
    if (fresh === undefined) {
      const stored = previous.variant;
      const storedVariant = stored !== undefined && stored !== "" && stored !== DEFAULT_VARIANT;
      const perTier = policy.variants?.perTier;
      const own = (name: string) => (perTier !== undefined && Object.prototype.hasOwnProperty.call(perTier, name) ? perTier[name] : undefined);
      if (model !== undefined && model.variant === undefined && storedVariant) {
        fresh = "bare-model-after-variant";
      } else if (action.action === "escalate" && (own(previous.tier)?.effortConfigured === true || own(tier)?.effortConfigured === true)) {
        fresh = "effort-path";
      }
    }
    if (fresh === undefined) resumeSessionID = state.childSessionID;
  }

  return {
    step,
    tier,
    agent,
    ...(model === undefined ? {} : { model }),
    ...(resumeSessionID === undefined ? {} : { resumeSessionID }),
    ...(action.resumeBasis === undefined ? {} : { resumeBasis: action.resumeBasis }),
    ...(fresh === undefined ? {} : { fresh }),
    ...(effort === undefined ? {} : { effort }),
    // The rung's ratio is the one the action priced for its own model#variant; the invalid-variant fallback runs the
    // tier's configured model instead, so the runner charges the tier's ratio (QA-2.3-8).
    ...(costRatio === undefined || fresh === "invalid-variant" ? {} : { costRatio }),
    ...(model?.variant === undefined ? {} : { variant: model.variant }),
  };
}
