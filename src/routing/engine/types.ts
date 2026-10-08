/**
 * Decision kernel (M4) — shared types of `src/routing/engine/*`.
 *
 * Design: `docs/qa/cost-aware-routing/phase-1.4.md` → "Design (1.4.1)".
 * Plan #74 §1.5 D5, D7, D8, D9 (amendment A16), D12, D13; amendments A1, A11.
 *
 * TYPES ONLY: every import is `import type`, so this module has no runtime
 * dependency (the kernel stays pure and cheap to load). Producers:
 *  - `ladders.ts` (1.4.2) builds a {@link Ladder} per decision;
 *  - the caller (2.2 dispatch wiring, `protocol-line.ts`, `plan.ts`) assembles a
 *    {@link DecisionInput};
 *  - `kernel.ts` turns it into a {@link Decision}, which maps 1:1 onto the
 *    `DecisionRow` fields of the 1.3 decision log.
 */

import type { ResolvedRouting } from "../../router/config";
import type { ExplorationConfig } from "../../router/roles";
import type { Detection, Need, TaskFacts } from "../classify/types";
import type { ClassifiedDispatch, EffectiveDetection } from "../roles/policy";
import type {
  AgentRef,
  CostUnit,
  ModelPricing,
  OutcomeStore,
  RouteChoice,
} from "../outcomes/types";

// ---------------------------------------------------------------------------
// Candidates and ladders
// ---------------------------------------------------------------------------

/**
 * Where a rung comes from (D12):
 *  - `tier`            — a rung of a router tier's own ladder (`resolveCandidates`);
 *  - `role-own-model`  — a `routing.roles` agent on the model the host configured for it;
 *  - `role-tier-rung`  — a `routing.roles` agent on a rung of the tier that owns the class
 *                        (applied at dispatch by a per-call `model` override).
 */
export type CandidateSource = "tier" | "role-own-model" | "role-tier-rung" | "role-range";

/** One `(agent, model#variant)` the engine may dispatch, with what the kernel needs to price it. */
export interface Candidate {
  /** `router` for a tier agent of the active preset, `host` for any other agent (outcome-key origin). */
  readonly agent: AgentRef;
  /** `provider/model`, never with a `#variant` suffix. */
  readonly model: string;
  /** Catalog variant id; `null` = the model's default (stored as `default`, A9). */
  readonly variant: string | null;
  /**
   * Cost of one attempt in `costRatio` units (fast = 1), finite and > 0. Router rungs: the rung's own
   * ratio from `resolveCandidates`. Role rungs: see `ladders.ts` (inherited, never invented).
   */
  readonly costRatio: number;
  /**
   * Capability rank on the escalation ladder: index of the router tier in the escalate ladder for
   * router rungs; for role rungs the rank of the tier that owns the class (D7 "inherited rank").
   */
  readonly rank: number;
  /** Router tier that owns the rung: the tier itself, or the class's owning tier for role rungs. */
  readonly tier: string;
  readonly source: CandidateSource;
  /**
   * Needs the agent's EVALUATED permissions grant (A11), supplied by the caller from host agent
   * info — never inferred from the agent id. `null` = unknown: covers no need at all.
   */
  readonly grants: readonly Need[] | null;
  /** Catalog `cost` of `model`; absent/empty/all-zero = unpriced (A1). */
  readonly pricing?: ModelPricing;
}

/**
 * The candidate graph of one decision. `next[k]` is the index of the rung the cascade of D8 moves to
 * when candidate `k` fails and the failure is detected (`null` = terminal: give up at cost `U`). A candidate
 * that has a simulated runner path in `paths` is priced through that path instead and its `next` is `null`
 * (A25: the router rungs); role chains use `next`.
 * `ladders.ts` guarantees the graph is acyclic; the kernel also treats any back edge, out-of-range or
 * unusable successor as terminal, so no input can make it recurse forever.
 */
export interface Ladder {
  readonly candidates: readonly Candidate[];
  /** Same length as `candidates`. */
  readonly next: readonly (number | null)[];
  /**
   * Rank of the class's static tier (`CLASS_STATIC_TIER`) on the same scale as `Candidate.rank`;
   * `null` when the class has none (`other`) or that tier is not on the ladder. D7 prior offsets are
   * `rank − classRank`.
   */
  readonly classRank: number | null;
  /** Candidates dropped while building the ladder (permissions, unknown agents, ...), for the log. */
  readonly excluded: readonly ExcludedCandidate[];
  /**
   * Rungs the 1.5 runner reaches (variant steps, covered-tier entries) that the engine never dispatches on
   * its own: priced exactly like candidates, never `best`. Indices `candidates.length + i` in {@link paths}.
   */
  readonly reachable?: readonly Candidate[];
  /**
   * A25: per candidate, the attempts the 1.5 runner makes when every attempt fails and the failure is
   * detected, as indices into `[...candidates, ...reachable]` (first = the candidate itself): retries,
   * variant steps, escalations, covered-tier skips, `maxTotalAttempts` and the cost ceiling are already
   * applied by simulating `nextAction`/`advance`. The path ends in a give-up (cost `U`). `null`/absent =
   * the candidate is priced through its `next` pointer instead (role chains, hand-built ladders).
   */
  readonly paths?: readonly (readonly number[] | null)[];
  /**
   * A34 (QA-G-B1): every rung of the active preset on the escalate ladder — modelled or not, its agent available or not — with
   * its tier's rank: the table a dispatch's CAPABILITY rank is read from (`kernel.capabilityRank`). Absent on hand-built ladders:
   * the router rungs of `candidates` and `reachable` stand in for it.
   */
  readonly presetRungs?: readonly PresetRung[];
}

/** A34: one rung of the active preset and the rank of its tier on the escalate ladder. */
export interface PresetRung {
  /** `provider/model`, never with a `#variant` suffix. */
  readonly model: string;
  readonly variant: string | null;
  readonly rank: number;
}

export type ExclusionReason =
  /** The agent's evaluated permissions do not cover `TaskFacts.needs` (A11, D12). */
  | "needs"
  /** Not in the host agent list, `mode: primary`, `hidden`, not permitted for the parent, or reserved (D12). */
  | "agent-unavailable"
  /** The class has no static tier on the escalate ladder, so a role agent has no inherited rank (D7). */
  | "no-owning-tier"
  /** Same `(agent, model, variant)` as an earlier rung, or a role naming a router tier agent. */
  | "duplicate"
  /** A25: an other-model rung of a tier's `candidates`; the 1.5 runner never runs it (escalation territory). */
  | "not-modelled";

/**
 * What the caller knows about one host agent: `ctx.agent.list()` on v2 (router tier agents
 * included), the config agent map plus the native agents on v1. Supplied, never inferred (A11).
 */
export interface HostAgentInfo {
  readonly id: string;
  /** `provider/model[#variant]` configured for the agent; absent/null = it runs on the parent's model. */
  readonly model?: string | null;
  /** Host agent mode; `primary` agents are never candidates (D12). */
  readonly mode: string;
  readonly hidden: boolean;
  /** The parent session may dispatch it (host permission check). */
  readonly permitted: boolean;
  /** Needs its EVALUATED permissions grant (A11), e.g. via `ladders.grantsFromTools`. */
  readonly grants: readonly Need[];
}

export interface ExcludedCandidate {
  readonly agent: AgentRef;
  readonly model: string;
  readonly variant: string | null;
  readonly why: ExclusionReason;
}

// ---------------------------------------------------------------------------
// Kernel input
// ---------------------------------------------------------------------------

/** What the kernel reads from the 1.3 outcome store. */
export type EngineStoreView = Pick<OutcomeStore, "posterior" | "cost" | "classTokenProfile">;

/** The slice of the resolved `routing` block the kernel uses (D8, D9). */
export type KernelRouting = Pick<ResolvedRouting, "profile" | "margin" | "minClassConfidence" | "detection">;

/**
 * The orchestrator's pick, fully resolved by the caller: the agent it named and the model#variant
 * that agent runs on (the tier's rung for a router tier, the configured model for a host agent).
 */
export interface ChosenDispatch {
  readonly agent: AgentRef;
  /** `provider/model` (a `#variant` suffix is accepted and split off when `variant` is null). */
  readonly model: string;
  readonly variant: string | null;
}

/** Orchestrator pricing for the D8 `tax` term (USD unit only). */
export interface OrchestratorCost {
  readonly pricing: ModelPricing;
  /** Current orchestrator context size in tokens (selects the A10 price entry). */
  readonly contextTokens: number;
}

export interface DecisionInput {
  /** Classifier output (M2). `confidence` gates switching (D9) and store reads (1.2 → 1.4 handoff). */
  readonly facts: TaskFacts;
  readonly chosen: ChosenDispatch;
  readonly ladder: Ladder;
  /** Verification depth of the dispatch (its `[acceptance]` checks or a plan `d=`); `d = routing.detection[detection]`. */
  readonly detection: Detection;
  /** `[route pin]` (D13): never switched; `best` still computed. */
  readonly pin: boolean;
  readonly routing: KernelRouting;
  /** `null` = no outcome data (static/degenerate case): priors and `costRatio` only. */
  readonly store: EngineStoreView | null;
  /** Rank of `enforcement.escalate.floorTier`; candidates below it are never `best` (D9). */
  readonly floorRank?: number | null;
  /** Needed only for a measured `tax` in USD; absent → `tax = 0`. */
  readonly orchestrator?: OrchestratorCost | null;
  /** D8 `remainingTurnsEstimate`; default 4. */
  readonly remainingTurns?: number;
}

// ---------------------------------------------------------------------------
// Kernel output
// ---------------------------------------------------------------------------

/** Why a candidate (other than the orchestrator's pick) could not be `best`. */
export type IneligibleReason =
  /** Permissions do not cover `needs` (A11). */
  | "needs"
  /** Below `floorTier` (D9). */
  | "floor"
  /**
   * `risk == high` and `d == none`: never down (D9, A34): a rank below the pick's CAPABILITY rank, or the pick's own model on a
   * lower-effort variant at the same rank.
   */
  | "never-down"
  /** Non-finite or non-positive attempt cost. */
  | "invalid-cost"
  /** A27: not ranked above the pick and fewer than 5 recorded outcomes for its key: it cannot be `best`. */
  | "evidence";

export type DecisionReasonCode =
  | "switched"
  | "kept:no-candidates"
  | "kept:pinned"
  | "kept:chosen-not-candidate"
  | "kept:best-is-chosen"
  | "kept:class-confidence"
  | "kept:margin"
  /** A24: a down switch whose `best` has fewer than 5 recorded outcomes. */
  | "kept:evidence"
  | "kept:invalid-config";

export interface Decision {
  /** The orchestrator's pick (as dispatched unless `switched`). */
  readonly chosen: RouteChoice;
  /** Argmin of `C(k)` over the pick and the eligible candidates; `null` when nothing could be priced. */
  readonly best: RouteChoice | null;
  /** The engine would replace `chosen` with `best` (D9 as amended by A16); never with `pinned`. */
  readonly switched: boolean;
  readonly pinned: boolean;
  /**
   * Trust in `best` ∈ [0, 1]: `facts.confidence × n / (n + 5)` with `n` the effective evidence of
   * `best`'s posterior (0 with priors only). Reported, never a gate.
   */
  readonly confidence: number;
  readonly reasonCode: DecisionReasonCode;
  /** Human-readable reason, with the compared costs. */
  readonly reason: string;
  /**
   * A27: the argmin BEFORE the evidence filter (the cheapest candidate that passes the permission, floor and never-down
   * filters, whether or not it has evidence); `null` when nothing could be priced. It differs from `best` exactly when the
   * evidence gate removed a cheaper candidate: the statistics log it in the row's trace.
   */
  readonly argmin: RouteChoice | null;
  /** `C(k)` per candidate key, finite numbers only, in `unit`. */
  readonly costs: Readonly<Record<string, number>>;
  /** D5: every cost of this decision is in this unit. */
  readonly unit: CostUnit;
  /** Candidates that could not be `best`, by key. */
  readonly ineligible: Readonly<Record<string, IneligibleReason>>;
  /** `best`'s candidate (its `agent`/`model`/`variant` are what an `enforce` swap writes); `null` with `best`. */
  readonly target: Candidate | null;
  /**
   * A34 (QA-G-B1): the pick's CAPABILITY rank — the highest rank of a preset rung on the pick's model (`kernel.capabilityRank`),
   * never below its candidate rank. Never-down and the A24/A27 "strictly higher rank" test compare against it; candidate ranks
   * stay capped at the class's owning tier (A25). `null` when the pick is not a candidate.
   */
  readonly pickRank: number | null;
}

// ---------------------------------------------------------------------------
// Role dispatches (role-tier-assurance plan §2.1, §2.3, P1.2 T1.2.3/T1.2.4) — additive
// ---------------------------------------------------------------------------

/**
 * The tier window of one role dispatch, as `roles/policy.tierBounds` returns it (tier names of the escalate ladder):
 * `floor`/`ceiling` already include the authority floor, `floorTier` and the running rung; `pinned` is the route-line
 * `tier=` already lifted or clamped into the window (null = no pin).
 */
export interface RoleWindow {
  readonly floor: string;
  readonly ceiling: string;
  readonly pinned: string | null;
}

/** One tier of a role ladder: its rank on the escalate ladder and its first candidate (`null` when every rung was a duplicate). */
export interface RoleLadderTier {
  readonly tier: string;
  readonly rank: number;
  readonly first: number | null;
}

/**
 * The candidate graph of a role dispatch (T1.2.3): the rungs of every tier in `[floor, ceiling]`, all run by the role agent
 * (`AgentRef` origin `role`, outcome keys `class|role:<agent>|provider/model#variant`). Every rung is priced through its
 * simulated runner path under `ladders.roleEscalatePolicy` (the escalate policy restricted to the window).
 */
export interface RoleLadder extends Ladder {
  /** The role agent. */
  readonly role: string;
  /** Ranks of the window on the escalate ladder; `null` when the window could not be placed (then there are no candidates). */
  readonly floorRank: number | null;
  readonly ceilingRank: number | null;
  readonly tiers: readonly RoleLadderTier[];
  /** Candidate index of the static default: the class's taxonomy tier clamped into the window; `null` when there are no candidates. */
  readonly staticDefault: number | null;
  /** Candidate index of the pinned tier (`RoleWindow.pinned`); `null` when not pinned. */
  readonly pinnedIndex: number | null;
  /** Window, default and pin notes for the decision row (`default:clamp:floor`, `pinned:heavy`, ...). */
  readonly reasons: readonly string[];
}

/** `routing.exploration` for one dispatch (T1.2.4): the rate (clamped to `[0, MAX_EXPLORATION_RATE]`) and the RNG seed. */
export interface RoleExploration extends Pick<ExplorationConfig, "rate"> {
  /** The decision row's id: the only seed of the exploration draw (same id → same draw). */
  readonly decisionID: string;
}

export interface RoleDecisionInput {
  /**
   * The classify result (`ClassifyResult` itself: `facts`, `trace.rules`, `trace.routeLine`). The kernel reads the
   * EFFECTIVE risk and scope from it (`roles/policy.effectiveFactsOf`, raise-only, QA-P12-1-1): never-down, `U` and
   * exploration use that risk.
   */
  readonly classified: ClassifiedDispatch;
  readonly ladder: RoleLadder;
  /**
   * The EFFECTIVE detection (§2.1, A34; `roles/policy.effectiveDetection`): `deterministic` only when the router's own
   * gate runs the checks. Never `ClassifyResult.detection` (the route line's claim).
   */
  readonly detection: EffectiveDetection;
  /** `routing.engine`: only `enforce` applies a kernel switch or explores. */
  readonly engine: ResolvedRouting["engine"];
  readonly routing: KernelRouting;
  readonly store: EngineStoreView | null;
  /** A resume: the rung the child runs on. The dispatch never moves below it and is never switched or explored. */
  readonly resume?: { readonly model: string; readonly variant: string | null } | null;
  /** Absent/null or rate 0 = no exploration. */
  readonly exploration?: RoleExploration | null;
  readonly orchestrator?: OrchestratorCost | null;
  readonly remainingTurns?: number;
}

export interface RoleDecision {
  /** The kernel's decision with `chosen` = {@link base} (`pinned` = the window has a pin). */
  readonly decision: Decision;
  /** The policy's pick before the kernel: the pinned tier, else the static default, raised to the running rung on a resume. */
  readonly base: Candidate | null;
  /**
   * What the router sets as the per-call model. `null` = no candidate (reason `window:no-candidates`): P2.1 REFUSES the
   * role dispatch. It never falls back to `buildEscalatePolicy`/`buildLadder` or to a tier agent on its own (QA-P12-1-5).
   */
  readonly dispatch: Candidate | null;
  /** `enforce` applied the kernel's switch (`dispatch` = `decision.target`); never on a resume, a pin or an exploration draw. */
  readonly switched: boolean;
  /** `dispatch` was drawn by exploration (reason `explore`). */
  readonly explore: boolean;
  /** Probability that this policy dispatches `dispatch` for this input, in (0, 1]; 1 when no draw was possible. */
  readonly propensity: number;
  /**
   * `RoleLadder.reasons` plus `resume:running`, `resume:off-ladder` (raised to the running model's capability rank),
   * `resume:off-ladder:lift` (unknown rank: raised to the window ceiling), `kept:resume`, `explore`.
   */
  readonly reasons: readonly string[];
}
