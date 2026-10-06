/**
 * Phase 2.3: what the delegate runner tells the telemetry about each ladder attempt.
 *
 * Every attempt of a `delegate` ladder (the first dispatch, a variant step, a plain retry, an escalation) is
 * its own attempt in the 2.1 dispatch-facts registry, under the attempt's step label, so that
 *
 * - `session.step.ended` events, verdicts and false refusals land on the right `(class x agent x model#variant)`
 *   key (a resumed child that moved to a higher variant is a different key from the attempt before it);
 * - the variant-refusal rule (QA-2.1-R2-3: a refusal that is a variant attempt's first terminal signal is a
 *   variant failure) and the ladder's `triedByModel` (A17a) name the same rungs;
 * - the delegate ladder's last-step context (`lastStepContext`, D11) is tracked for the child.
 *
 * and, when `routing.engine` is not `static`, enqueues one `DecisionRow` per attempt (1.3 handoff to 2.3):
 * `step` in `dispatch | variant | retry | escalate`, `resume` per D11/A5, `chosen` = the ladder's pick,
 * `best` null, `switched` false. Rows go through the process-wide outcomes bundle (A3), never on a hot path:
 * `enqueue` is an O(1) push and the flusher writes at idle/deleted or every 30 s (D15).
 *
 * Everything here is best effort: a failure is logged and never reaches the delegation.
 */

import { randomBytes } from "node:crypto";
import type { RouterConfig, RouterHost } from "../router/config";
import { resolveRouting } from "../router/config";
import { rememberDispatch, type DetectionDepth } from "../router/sessions";
import { classify, type TaskFacts } from "../routing/classify";
import { acquireOutcomes } from "../routing/outcomes";
import { ingestSettings, type IngestSettings } from "../routing/outcomes/ingest";
import type { AcquireOutcomesOptions } from "../routing/outcomes";
import {
  LOG_ROW_VERSION,
  classifyAgentOrigin,
  makeKey,
  normalizeVariant,
  safeNow,
  type Clock,
  type DecisionFacts,
  type DecisionRow,
  type OutcomeLogger,
  type OutcomesBundle,
} from "../routing/outcomes/types";
import type { AttemptPlan } from "./resume";

/** What one ladder attempt registers. */
export interface AttemptRecord {
  /** The child the attempt runs on (created, or the resumed one). */
  readonly childSessionID: string;
  /** The orchestrator session that called `delegate`. */
  readonly parentSessionID: string | null;
  readonly plan: AttemptPlan;
  /** Typed facts of the delegated task (rules classifier). */
  readonly facts: DecisionFacts;
  /** The delegation's verification depth, from its `[acceptance]` block. */
  readonly acceptance: DetectionDepth | null;
  /** True when the attempt runs on a child that already existed. */
  readonly resumed: boolean;
}

export interface AttemptRecorder {
  /** True when attempts are worth registering for the engine alone (any mode but `static`, on v2). */
  engineLive(): boolean;
  /** Register the attempt and, when the engine is live, enqueue its decision row. Never throws. */
  record(attempt: AttemptRecord): void;
  /** Opportunistic maintenance: releases the outcomes bundle when the engine went back to `static`. */
  sweep(): void;
  /** Releases this recorder's reference to the outcomes bundle. Never rejects. */
  dispose(): Promise<void>;
}

export interface AttemptRecorderDeps {
  readonly host: RouterHost;
  /** The live configuration (hot reload swaps the object). */
  readonly config: () => RouterConfig;
  readonly logger: OutcomeLogger;
  readonly now?: Clock;
  /** Seam over `acquireOutcomes` (tests). */
  readonly acquire?: (options: AcquireOutcomesOptions) => OutcomesBundle;
}

const NONCE = randomBytes(4).toString("hex");
let decisionSeq = 0;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `provider/model` of a plan, or null when the tier's model did not resolve. */
function modelOf(plan: AttemptPlan): string | null {
  return plan.model === undefined ? null : `${plan.model.providerID}/${plan.model.modelID}`;
}

/** The decision row's `reason`: the ladder's step, the D11 verdict with both numbers, and any runner override. */
export function describeAttempt(attempt: AttemptRecord): string {
  const { plan } = attempt;
  const parts = [`ladder ${plan.step} on ${plan.tier}`, attempt.resumed ? "resumed child" : "fresh child"];
  const basis = plan.resumeBasis;
  if (basis !== undefined) {
    const numbers = [
      basis.tokens === null ? null : `tokens=${basis.tokens}`,
      basis.budget === null ? null : `budget=${basis.budget}`,
      basis.threshold === null ? null : `threshold=${basis.threshold}`,
    ].filter((part): part is string => part !== null);
    parts.push(`D11 ${basis.reason}${numbers.length === 0 ? "" : ` (${numbers.join(" ")})`}`);
  }
  if (plan.fresh !== undefined) parts.push(`runner: fresh (${plan.fresh})`);
  if (plan.costRatio !== undefined) parts.push(`rung costRatio ${plan.costRatio}`);
  return parts.join("; ");
}

export function createAttemptRecorder(deps: AttemptRecorderDeps): AttemptRecorder {
  const now: Clock = deps.now ?? Date.now;
  const acquire = deps.acquire ?? acquireOutcomes;
  let held: { readonly dir: string; readonly bundle: OutcomesBundle } | null = null;
  let disposed = false;

  const settingsNow = (): IngestSettings | null => ingestSettings(deps.config(), deps.host);

  const release = (): void => {
    const current = held;
    held = null;
    if (current !== null) void current.bundle.release().catch((error: unknown) => deps.logger.warn("[router] ladder attempts: releasing the outcomes bundle failed", { error: describe(error) }));
  };

  const bundleFor = (settings: IngestSettings): OutcomesBundle | null => {
    if (disposed) return null;
    if (held !== null && held.dir === settings.outcomesDir) return held.bundle;
    release();
    const bundle = acquire({ dir: settings.outcomesDir, tuning: settings.tuning, logger: deps.logger });
    held = { dir: settings.outcomesDir, bundle };
    return bundle;
  };

  return {
    engineLive: () => {
      try {
        return settingsNow() !== null;
      } catch (error) {
        deps.logger.warn("[router] ladder attempts: reading the routing settings failed", { error: describe(error) });
        return false;
      }
    },

    record(attempt) {
      try {
        const { plan } = attempt;
        const settings = settingsNow();
        const model = modelOf(plan);
        const decisionID = settings === null || model === null ? null : `ladder-${NONCE}-${++decisionSeq}`;
        rememberDispatch(attempt.childSessionID, {
          facts: attempt.facts,
          agent: plan.agent,
          model,
          variant: plan.model?.variant ?? null,
          tier: plan.tier,
          acceptance: attempt.acceptance,
          parentSessionID: attempt.parentSessionID,
          decisionID,
          step: plan.step,
          // Registered with ingestion off (engine static): no instance may score it (QA-2.3-6).
          outcomes: settings !== null,
        }, safeNow(now));
        if (settings === null || decisionID === null || plan.model === undefined) return;
        const bundle = bundleFor(settings);
        if (bundle === null) return;
        const variant = normalizeVariant(plan.model.variant);
        const origin = classifyAgentOrigin(plan.agent, settings.routerAgentIds);
        const key = makeKey(attempt.facts.class, { origin, id: plan.agent }, plan.model.providerID, plan.model.modelID, variant);
        const chosen = { key, agent: plan.agent, origin, model: `${plan.model.providerID}/${plan.model.modelID}`, variant };
        const row: DecisionRow = {
          v: LOG_ROW_VERSION,
          ts: new Date(safeNow(now)).toISOString(),
          sessionID: attempt.parentSessionID ?? "",
          kind: "decision",
          decisionID,
          mode: settings.engine,
          childSessionID: attempt.childSessionID,
          facts: attempt.facts,
          chosen,
          best: null,
          switched: false,
          pinned: false,
          unit: "ratio",
          costs: {},
          confidence: attempt.facts.confidence,
          reason: describeAttempt(attempt),
          step: plan.step,
          resume: attempt.resumed,
        };
        bundle.flusher.enqueue(row);
      } catch (error) {
        deps.logger.warn("[router] ladder attempts: registering an attempt failed", { error: describe(error), child: attempt.childSessionID });
      }
    },

    sweep() {
      try {
        if (held !== null && settingsNow() === null) release();
      } catch (error) {
        deps.logger.warn("[router] ladder attempts: sweep failed", { error: describe(error) });
      }
    },

    async dispose() {
      disposed = true;
      const current = held;
      held = null;
      if (current === null) return;
      try {
        await current.bundle.release();
      } catch (error) {
        deps.logger.warn("[router] ladder attempts: releasing the outcomes bundle failed", { error: describe(error) });
      }
    },
  };
}

/** What the rules classifier says about a delegated task, for the registry and the decision rows. */
export interface DelegationFacts {
  readonly facts: TaskFacts;
  readonly acceptance: DetectionDepth | null;
}

/**
 * Rules-only facts of a delegation (D3: no backend call, nothing leaves the machine, never throws). The
 * delegate tool has no orchestrator-chosen class, so the class comes from the same rules `/annotate-plan` and
 * the dispatch hook start from; a class below `routing.minClassConfidence` is simply not recorded by the ingest.
 */
export async function classifyDelegation(
  cfg: RouterConfig,
  host: RouterHost,
  task: string,
  acceptance: string | undefined,
  logger: OutcomeLogger,
): Promise<DelegationFacts | null> {
  try {
    const routing = resolveRouting(cfg, host);
    const prompt = acceptance === undefined || acceptance.trim() === "" ? task : `${task}\n\n${acceptance}`;
    const result = await classify({ prompt }, {
      cfg,
      settings: { ...routing.classifier, backend: "rules" },
      minClassConfidence: routing.minClassConfidence,
      backend: null,
      logger: { warn: (message: string) => logger.warn(message) },
    });
    return { facts: result.facts, acceptance: result.detection };
  } catch (error) {
    logger.warn("[router] ladder attempts: classifying the delegation failed", { error: describe(error) });
    return null;
  }
}
