/**
 * Decision kernel (M4) — public surface of `src/routing/engine/*`.
 *
 * Re-exports only: no logic, no state. Design: `docs/qa/cost-aware-routing/phase-1.4.md` → §6.
 */

export type * from "./types";
export {
  DEFAULT_REMAINING_TURNS,
  GIVE_UP_COST,
  candidateKey,
  coversNeeds,
  decide,
  giveUpCost,
} from "./kernel";
export {
  buildLadder,
  escalateLadder,
  floorRankOf,
  grantsFromTools,
  resolveChosen,
  tierRankOf,
} from "./ladders";
export type { ChosenInput, LadderBuildInput } from "./ladders";
export { MIN_EVIDENCE_TO_MOVE, generateTaxonomy } from "./protocol-line";
export type { TaxonomyInput } from "./protocol-line";
export { annotateSteps, detectionOf, formatRouteLine } from "./plan";
export type { AnnotateDeps, AnnotatedStep, PlanStep } from "./plan";
