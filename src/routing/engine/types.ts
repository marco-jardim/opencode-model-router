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
import type { Detection, Need, TaskFacts } from "../classify/types";
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
export type CandidateSource = "tier" | "role-own-model" | "role-tier-rung";

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
 * when candidate `k` fails and the failure is detected (`null` = terminal: give up at cost `U`).
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
}

export type ExclusionReason =
  /** The agent's evaluated permissions do not cover `TaskFacts.needs` (A11, D12). */
  | "needs"
  /** Not in the host agent list, `mode: primary`, `hidden`, not permitted for the parent, or reserved (D12). */
  | "agent-unavailable"
  /** The class has no static tier on the escalate ladder, so a role agent has no inherited rank (D7). */
  | "no-owning-tier"
  /** Same `(agent, model, variant)` as an earlier rung, or a role naming a router tier agent. */
  | "duplicate";

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
  /** `risk == high` and `d == none`: never down a rank (D9). */
  | "never-down"
  /** Non-finite or non-positive attempt cost. */
  | "invalid-cost";

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
  /** `C(k)` per candidate key, finite numbers only, in `unit`. */
  readonly costs: Readonly<Record<string, number>>;
  /** D5: every cost of this decision is in this unit. */
  readonly unit: CostUnit;
  /** Candidates that could not be `best`, by key. */
  readonly ineligible: Readonly<Record<string, IneligibleReason>>;
  /** `best`'s candidate (its `agent`/`model`/`variant` are what an `enforce` swap writes); `null` with `best`. */
  readonly target: Candidate | null;
}
