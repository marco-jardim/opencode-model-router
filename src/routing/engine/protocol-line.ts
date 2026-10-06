/**
 * The generated `R:` taxonomy line (M4) — `buildTaskTaxonomy` plus an optional `by class:` suffix.
 *
 * Design: `docs/qa/cost-aware-routing/phase-1.4.md` → "Design (1.4.1)" §4. Plan #74 D2 (the degenerate
 * case is byte-identical to today's line), D1 (v1 is a text-only opt-in), D12, amendment A11.
 *
 *  - The base is `buildTaskTaxonomy(cfg)` itself, never re-implemented: with no evidence and no configured
 *    roles the output equals it byte for byte, by construction.
 *  - v1 (`host === "v1"`): only an explicitly configured `routing.roles` produces segments, listing the
 *    available agents per class. The outcome store is never read on v1.
 *  - v2: with a store, a class moves to another agent only when the kernel says `switched` AND `best` has at
 *    least {@link MIN_EVIDENCE_TO_MOVE} effective evidence. Priors alone can move a class in the kernel
 *    (e.g. `margin: 0`), so the evidence gate is what keeps the line static until data exists.
 *
 * Pure: no I/O, no clock, no randomness, no module state.
 */

import type { ResolvedRouting, RouterConfig, RouterHost } from "../../router/config";
import { buildTaskTaxonomy } from "../../router/protocol";
import {
  CLASS_BASE_RISK,
  CLASS_IMPLIED_NEEDS,
  CLASS_STATIC_TIER,
  TASK_CLASSES,
  type TaskFacts,
} from "../classify/types";
import type { ModelPricing } from "../outcomes/types";
import { MIN_EVIDENCE_TO_SWITCH_DOWN, decide, hasMinEvidence } from "./kernel";
import { buildLadder, type LadderBuildInput, floorRankOf, resolveChosen, roleAgentExclusion, routerTierIds, tierRankOf } from "./ladders";
import type { EngineStoreView, HostAgentInfo } from "./types";

/** `best` must carry evidence at least as strong as the prior before a class line moves (= `PRIOR_STRENGTH`). */
export const MIN_EVIDENCE_TO_MOVE: number = MIN_EVIDENCE_TO_SWITCH_DOWN;

export interface TaxonomyInput {
  readonly cfg: RouterConfig;
  readonly routing: ResolvedRouting;
  readonly host: RouterHost;
  readonly store: EngineStoreView | null;
  readonly agents: readonly HostAgentInfo[] | null;
  readonly pricing?: (model: string) => ModelPricing;
  /** Forwarded to `buildLadder`: the runner policy's session input (A25), the parent model, the pricing logger. */
  readonly session?: LadderBuildInput["session"];
  readonly parentModel?: string | null;
  readonly logger?: LadderBuildInput["logger"];
}

function ownRoleList(roles: Readonly<Record<string, readonly string[]>>, cls: string): readonly string[] {
  const list = Object.hasOwn(roles, cls) ? roles[cls] : undefined;
  return Array.isArray(list) ? [...new Set(list)] : [];
}

/** v1 text-only roles: the available agents of each configured class (no needs check, nothing classified). */
function v1Segments(input: TaxonomyInput): string[] {
  const { cfg, routing, agents } = input;
  if (routing.applied.rolesSource !== "configured" || agents === null) return [];
  const routerIds = routerTierIds(cfg);
  const segments: string[] = [];
  for (const cls of TASK_CLASSES) {
    const destinations = ownRoleList(routing.roles, cls).filter(
      (id) => roleAgentExclusion(id, agents.find((agent) => agent.id === id), routerIds) === null,
    );
    if (destinations.length > 0) segments.push(`${cls}→${destinations.map((id) => `@${id}`).join("/")}`);
  }
  return segments;
}

/** v2: classes whose evidence-backed argmin is another agent than the static tier's. */
function v2Segments(input: TaxonomyInput, store: EngineStoreView): string[] {
  const { cfg, routing, agents } = input;
  const floorRank = floorRankOf(cfg);
  const segments: string[] = [];
  for (const cls of TASK_CLASSES) {
    const staticTier = CLASS_STATIC_TIER[cls];
    if (staticTier === null || tierRankOf(cfg, staticTier) === null) continue;
    const facts: TaskFacts = {
      class: cls,
      risk: CLASS_BASE_RISK[cls],
      scope: "single",
      needs: CLASS_IMPLIED_NEEDS[cls],
      confidence: 1,
      source: "rules",
    };
    const chosen = resolveChosen({ cfg, agents, agent: staticTier });
    if (chosen === null) continue;
    const ladder = buildLadder({
      cfg,
      routing,
      facts,
      agents,
      ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.parentModel === undefined ? {} : { parentModel: input.parentModel }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    const decision = decide({ facts, chosen, ladder, detection: "none", pin: false, routing, store, floorRank });
    if (!decision.switched || decision.best === null || decision.target === null) continue;
    if (decision.best.agent === staticTier) continue; // a variant change inside the same tier never changes the line
    if (!hasMinEvidence(store.posterior(decision.best.key).n)) continue;
    segments.push(`${cls}→@${decision.best.agent}`);
  }
  return segments;
}

/**
 * The `R:` line the protocol should carry: `buildTaskTaxonomy(cfg)` unchanged unless a class has somewhere
 * better to go, then `<base> | by class: c→@agent …` (`R: by class: …` when the base is empty or the bare
 * `R:` header). Classes are listed in `TASK_CLASSES` order, so the text depends on the inputs and never on
 * key order.
 *
 * Engine gate (QA-1.4-5, D1): on v2 the line only changes when the resolved engine is `advise` or `enforce`;
 * `static` and `shadow` never touch the protocol text. On v1 the engine is always `static`; the text-only
 * opt-in is an explicitly configured `routing.roles` (D1), which is what the v1 branch reads.
 *
 * Handoff to 2.2 (QA-1.4-11): (1) substitute with a FUNCTION replacer, `protocol.replace(base, () => line)`:
 * the line carries agent ids, and a string replacement would expand `$&`, `$1` or `$$` inside them;
 * (2) when `buildTaskTaxonomy(cfg)` is empty the protocol has no `R:` line to replace: insert the generated
 * line (`R: by class: …`) where the taxonomy would go, and only when it is non-empty.
 */
export function generateTaxonomy(input: TaxonomyInput): string {
  const base = buildTaskTaxonomy(input.cfg);
  let segments: string[];
  if (input.host === "v1") {
    segments = v1Segments(input);
  } else if (input.routing.engine !== "advise" && input.routing.engine !== "enforce") {
    return base; // static or shadow: the shipped text, byte for byte
  } else {
    segments = input.store === null ? [] : v2Segments(input, input.store);
  }
  if (segments.length === 0) return base;
  const suffix = `by class: ${segments.join(" ")}`;
  return base === "" || base === "R:" ? `R: ${suffix}` : `${base} | ${suffix}`;
}
