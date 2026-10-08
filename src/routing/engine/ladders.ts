/**
 * Candidate ladders (M4) — the graph the decision kernel prices.
 *
 * Design: `docs/qa/cost-aware-routing/phase-1.4.md` → "Design (1.4.1)" §3.
 * Plan #74 §1.5: D7 (inherited ranks), D8 (successor `next`), D10/D12 (tier ladders and role agents),
 * A11 (permissions come from the caller), A17a/A20 (variant coverage, effort-configured tiers).
 *
 * Layout of a {@link Ladder}: the router block first (tier order, then rung order), then one chain per
 * role agent (own model, then the owning tier's rungs). `next` pointers are strictly forward inside the
 * router block, and a role chain only points forward inside itself or into the router block, which never
 * points back: the graph is acyclic by construction.
 *
 * Pure: no I/O, no clock, no randomness, no module state. Runtime imports are pure modules only
 * (`router/config` helpers, `escalate/ladder`, `escalate/variants`, `outcomes/types`, `classify/types`).
 */

import {
  ROUTING_RESERVED_AGENTS,
  resolveCandidates,
  resolveActiveTiers,
  resolvePresetName,
  type ResolvedRouting,
  type ResolvedCandidate,
  type RouterConfig,
  type TierConfig,
} from "../../router/config";
import { presetTierOrder } from "../../router/roles";
import { buildEscalatePolicy, type EscalatePolicy, type LadderSessionPolicyInput } from "../../escalate/ladder";
import { variantCovered } from "../../escalate/variants";
import { CLASS_STATIC_TIER, NEEDS, type Need, type TaskFacts } from "../classify/types";
import { classifyAgentOrigin, normalizeVariant, splitModelRef } from "../outcomes/types";
import type { AgentRef, ModelPricing } from "../outcomes/types";
import { coversNeeds } from "./kernel";
import { simulateAfter, simulateRunner, type RunnerRung } from "./simulate";
import type {
  Candidate,
  ChosenDispatch,
  ExcludedCandidate,
  ExclusionReason,
  HostAgentInfo,
  Ladder,
  PresetRung,
  RoleLadder,
  RoleLadderTier,
  RoleWindow,
} from "./types";

// ---------------------------------------------------------------------------
// Escalate ladder and ranks
// ---------------------------------------------------------------------------

/** The active preset's tiers (the same preset name resolution `resolveCandidates` uses), own keys only. */
function activeTiers(cfg: RouterConfig): Readonly<Record<string, TierConfig>> | undefined {
  const presetName = resolvePresetName(cfg, cfg.activePreset);
  if (presetName === undefined || !Object.hasOwn(cfg.presets, presetName)) return undefined;
  return cfg.presets[presetName];
}

function tierConfigOf(cfg: RouterConfig, tier: string): TierConfig | undefined {
  const tiers = activeTiers(cfg);
  return tiers !== undefined && Object.hasOwn(tiers, tier) ? tiers[tier] : undefined;
}

/** Ids of the router tier agents of the active preset (every tier of the preset, on the ladder or not). */
export function routerTierIds(cfg: RouterConfig): readonly string[] {
  const tiers = activeTiers(cfg);
  return tiers === undefined ? [] : Object.keys(tiers);
}

/**
 * The runtime escalation ladder (`buildEscalatePolicy(cfg).ladder`, default `fast → medium → heavy`),
 * de-duplicated and restricted to tiers that have at least one rung. One source for the kernel's ranks and
 * for the runtime ladder.
 */
export function escalateLadder(cfg: RouterConfig): readonly string[] {
  return ladderOf(cfg, buildEscalatePolicy(cfg).ladder);
}

function ladderOf(cfg: RouterConfig, raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const tier of raw) {
    if (typeof tier !== "string" || tier === "" || out.includes(tier)) continue;
    if (resolveCandidates(tier, cfg).length === 0) continue;
    out.push(tier);
  }
  return out;
}

/** Index of `tier` on the escalate ladder (its capability rank); `null` when absent. */
export function tierRankOf(cfg: RouterConfig, tier: string | null | undefined): number | null {
  if (typeof tier !== "string" || tier === "") return null;
  const rank = escalateLadder(cfg).indexOf(tier);
  return rank >= 0 ? rank : null;
}

/** Rank of `enforcement.escalate.floorTier`; `null` when unset or off the ladder. */
export function floorRankOf(cfg: RouterConfig): number | null {
  return tierRankOf(cfg, cfg.enforcement?.escalate?.floorTier);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const SHELL_TOOLS: readonly string[] = ["shell", "bash"];
const WEB_TOOLS: readonly string[] = ["webfetch", "websearch"];
const EDIT_TOOLS: readonly string[] = ["edit", "write", "patch", "apply_patch"];

/**
 * Handoff to 2.2 (QA-1.4-14): pass only the tools the agent may use UNCONDITIONALLY, i.e. the evaluated
 * permission is `allow` for the tool (and, for `external_dir`, for every path). A tool that is `ask`,
 * `deny` or allowed only for some patterns must be left out: a need that might block at dispatch time is not
 * a need the agent covers (A11), and an uncovered need only makes a candidate ineligible, never worse.
 *
 * A11: the needs covered by an agent's EVALUATED tool set. `network` means going through a shell command
 * (1.2 `NEEDS`), so it follows `shell`; `external_dir` is the host `external_directory` permission
 * evaluated to allow. Unique, in `NEEDS` order.
 */
export function grantsFromTools(tools: readonly string[], externalDirectory: boolean): Need[] {
  const have = new Set(tools.map((tool) => tool.toLowerCase()));
  const has = (ids: readonly string[]): boolean => ids.some((id) => have.has(id));
  const granted = new Set<Need>();
  if (has(SHELL_TOOLS)) {
    granted.add("shell");
    granted.add("network");
  }
  if (has(WEB_TOOLS)) granted.add("web");
  if (has(EDIT_TOOLS)) granted.add("edit");
  if (externalDirectory) granted.add("external_dir");
  return NEEDS.filter((need) => granted.has(need));
}

// ---------------------------------------------------------------------------
// Successor pointers (D8, A17a reduced to a static pointer)
// ---------------------------------------------------------------------------

/** A20 / QA-1.5-18: a tier with `effort`/`thinking`/`reasoning` set is never covered and never a coverage source. */
function effortConfigured(cfg: RouterConfig, tier: string): boolean {
  const config = tierConfigOf(cfg, tier);
  return config !== undefined && (config.effort !== undefined || config.thinking !== undefined || config.reasoning !== undefined);
}

/** `r` adds nothing after `k` was tried: same model, neither tier effort-configured, variant covered. */
function skippedAfter(cfg: RouterConfig, k: Candidate, r: Candidate): boolean {
  if (r.model !== k.model) return false;
  if (effortConfigured(cfg, k.tier) || effortConfigured(cfg, r.tier)) return false;
  return variantCovered(r.variant ?? "default", k.variant ?? "default");
}

/**
 * First rung of `following` (already in walk order) that is not covered by `k`, as an index into
 * `all`; `null` when none is left (give up).
 */
function firstUncovered(
  cfg: RouterConfig,
  k: Candidate,
  following: readonly number[],
  all: readonly Candidate[],
  skipCovered = true,
): number | null {
  for (const j of following) {
    if (!skipCovered || !skippedAfter(cfg, k, all[j]!)) return j;
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildLadder
// ---------------------------------------------------------------------------

export interface LadderBuildInput {
  readonly cfg: RouterConfig;
  readonly routing: Pick<ResolvedRouting, "roles">;
  readonly facts: Pick<TaskFacts, "class" | "needs">;
  /** Router tier agents included. null = unavailable: router grants null, no role candidates. */
  readonly agents: readonly HostAgentInfo[] | null;
  /** Catalog pricing of "provider/model"; a throwing lookup prices as unpriced (QA-1.4-10, A1). */
  readonly pricing?: (model: string) => ModelPricing;
  /** The orchestrator's model: the model of a role agent that has none configured (QA-1.4-4). */
  readonly parentModel?: string | null;
  /** Receives one line per failed pricing lookup; its own failures are swallowed. */
  readonly logger?: { warn(message: string): void };
  /**
   * The input the 1.5 runner's policy is built with (`buildEscalatePolicy(cfg, session)`: host, catalog,
   * `variantSteps`, `maxContextFraction`). Absent = no variant steps, as on v1 or without a catalog (A25).
   */
  readonly session?: LadderSessionPolicyInput;
}

function normalizedVariant(variant: string | null | undefined): string | null {
  return variant === undefined || variant === null || variant === "" ? null : variant;
}

function sameRung(a: { readonly model: string; readonly variant: string | null }, b: { readonly model: string; readonly variant: string | null }): boolean {
  return a.model === b.model && normalizeVariant(a.variant) === normalizeVariant(b.variant);
}

/** Never throws: logging failures are reported through the return value, not raised (QA-1.4-10). */
function tryWarn(logger: LadderBuildInput["logger"], message: string): boolean {
  if (logger === undefined) return false;
  try {
    logger.warn(message);
    return true;
  } catch {
    return false; // a broken logger must not break the decision
  }
}

/** QA-1.4-10: the catalog lookup is the caller's code; a failure makes the model unpriced (A1), never a throw. */
function priced(input: Pick<LadderBuildInput, "pricing" | "logger">, model: string): { readonly pricing?: ModelPricing } {
  if (input.pricing === undefined) return {};
  try {
    return { pricing: input.pricing(model) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    tryWarn(input.logger, `[router] ladder: pricing lookup for ${model} failed (${reason}); treating it as unpriced`);
    return {};
  }
}

function ownRoles(roles: Readonly<Record<string, readonly string[]>>, cls: string): readonly string[] {
  const list = Object.hasOwn(roles, cls) ? roles[cls] : undefined;
  return Array.isArray(list) ? [...new Set(list)] : [];
}

/** A host agent unusable as a dispatch target: `mode: primary`, hidden or not permitted for the parent. */
function agentUnavailable(info: HostAgentInfo): boolean {
  return info.mode === "primary" || info.hidden || !info.permitted;
}

/**
 * Why a `routing.roles` agent cannot be a candidate at the agent level (D12, QA-1.1-18/29): it names a
 * router tier of the active preset (`duplicate`), or it is reserved, absent from the host agent list,
 * `mode: primary`, hidden or not permitted for the parent (`agent-unavailable`). The class-level check
 * (`no-owning-tier`) and the A11 `needs` check are separate; `null` = usable.
 */
export function roleAgentExclusion(
  id: string,
  info: HostAgentInfo | undefined,
  routerIds: readonly string[],
): "duplicate" | "agent-unavailable" | null {
  if (routerIds.includes(id)) return "duplicate";
  if ((ROUTING_RESERVED_AGENTS as readonly string[]).includes(id)) return "agent-unavailable";
  if (info === undefined || agentUnavailable(info)) return "agent-unavailable";
  return null;
}

/** The model a host agent runs on: its configured one, else the parent's (host precedence, QA-1.4-4). */
function modelOfAgent(info: HostAgentInfo, parentModel: string | null | undefined): string | null {
  return nonEmpty(info.model) ?? nonEmpty(parentModel);
}

/** The base rung of a tier: its own model, variant and ratio (the rung `resolveCandidates` lists for it). */
function tierBaseRung(cfg: RouterConfig, tier: string): RunnerRung | undefined {
  const config = tierConfigOf(cfg, tier);
  if (config === undefined || typeof config.model !== "string") return undefined;
  const variant = normalizedVariant(config.variant);
  const rungs = resolveCandidates(tier, cfg);
  const own = rungs.find((rung) => sameRung({ model: rung.model, variant: normalizedVariant(rung.variant) }, { model: config.model, variant }));
  const costRatio = (own ?? rungs[0])?.costRatio;
  return costRatio === undefined ? undefined : { tier, model: config.model, variant, costRatio };
}

/**
 * A25: the rungs of a tier the 1.5 runner can walk — the ones on the tier's own model. A `candidates` rung on
 * another model is escalation territory: the runner never runs it, so it is not modelled (`dropped`).
 */
function modelledRungs(cfg: RouterConfig, tier: string): { readonly kept: readonly ResolvedCandidate[]; readonly dropped: readonly ResolvedCandidate[] } {
  const model = tierConfigOf(cfg, tier)?.model;
  const rungs = resolveCandidates(tier, cfg);
  if (typeof model !== "string") return { kept: rungs, dropped: [] };
  return { kept: rungs.filter((rung) => rung.model === model), dropped: rungs.filter((rung) => rung.model !== model) };
}

/**
 * Build the candidate graph of one decision (§3): the router rungs of the escalate ladder, then the role
 * agents of `facts.class` (D12) with their own-model rung and the owning tier's rungs.
 *
 * Router rungs (A25): every rung on the tier's own model; each carries the attempts the 1.5 runner makes
 * from it — `Ladder.paths`, simulated with `buildEscalatePolicy(cfg, session)` and `nextAction`/`advance` —
 * so the kernel prices retries, `maxTotalAttempts`, the cost ceiling and covered-tier skips as the runner
 * performs them. Rungs only the runner reaches (variant steps) are `Ladder.reachable`, never `best`.
 * `session` is the same input the runner's policy is built with (host, catalog, `variantSteps`); without it
 * the policy has no variant steps, exactly as the runner would behave.
 *
 * Own-model rung of a role agent (D7, A25): when its `(model, variant)` matches a rung of the preset it takes
 * that rung's price AND `min(owningRank, matched.rank)` (an agent on the fast tier's model is a fast-ranked
 * candidate, whatever class it serves); the inherited rank of the owning tier applies only when no rung
 * matches. An agent without a configured model runs on the parent's model and gets its own-model rung there.
 * A role chain is a static successor chain (own model, the owning tier's rungs, then the first router rung of
 * the next tier above, entered as a fresh dispatch).
 *
 * Router rungs of a tier whose agent is `mode: primary`, hidden or not permitted are excluded
 * (`agent-unavailable`): they can never be `best` (a simulated path may still pass through them).
 *
 * Never throws for well-typed input; an unknown preset or a ladder with no resolvable tier yields an empty
 * ladder (the kernel then reports `kept:no-candidates`).
 */
export function buildLadder(input: LadderBuildInput): Ladder {
  const { cfg, facts, agents } = input;
  const policy: EscalatePolicy = buildEscalatePolicy(cfg, input.session);
  const order = ladderOf(cfg, policy.ladder);
  const rankOf = (tier: string | null | undefined): number | null => {
    const rank = typeof tier === "string" ? order.indexOf(tier) : -1;
    return rank >= 0 ? rank : null;
  };
  const routerIds = routerTierIds(cfg);
  const owningTier = Object.hasOwn(CLASS_STATIC_TIER, facts.class) ? CLASS_STATIC_TIER[facts.class] : null;
  const owningRank = rankOf(owningTier);
  const excluded: ExcludedCandidate[] = [];
  const excludedOf = (id: string, why: ExclusionReason, info: HostAgentInfo | undefined): void => {
    const ref = typeof info?.model === "string" ? splitModelRef(info.model) : null;
    excluded.push({
      agent: { origin: classifyAgentOrigin(id, routerIds), id },
      model: ref === null ? (info?.model ?? "") : `${ref.provider}/${ref.model}`,
      variant: ref?.variant ?? null,
      why,
    });
  };

  // --- router block --------------------------------------------------------------------------------
  /** Every rung of the preset, modelled or not, available or not: the price/rank table of own-model rungs. */
  const presetRungs: Candidate[] = [];
  const candidates: Candidate[] = [];
  const next: (number | null)[] = [];
  order.forEach((tier, rank) => {
    const info = agents?.find((agent) => agent.id === tier);
    const unavailable = info !== undefined && agentUnavailable(info);
    const grants = info?.grants ?? null;
    const { kept, dropped } = modelledRungs(cfg, tier);
    const routerRung = (rung: ResolvedCandidate): Candidate => ({
      agent: { origin: "router", id: tier },
      model: rung.model,
      variant: normalizedVariant(rung.variant),
      costRatio: rung.costRatio,
      rank,
      tier,
      source: "tier",
      grants,
      ...priced(input, rung.model),
    });
    for (const rung of dropped) {
      const candidate = routerRung(rung);
      presetRungs.push(candidate);
      excluded.push({ agent: candidate.agent, model: candidate.model, variant: candidate.variant, why: "not-modelled" });
    }
    for (const rung of kept) {
      const candidate = routerRung(rung);
      presetRungs.push(candidate);
      if (unavailable) {
        excluded.push({ agent: candidate.agent, model: candidate.model, variant: candidate.variant, why: "agent-unavailable" });
      } else {
        candidates.push(candidate);
      }
    }
  });
  const routerCount = candidates.length;
  for (let k = 0; k < routerCount; k++) next.push(null); // router rungs are priced through `paths` (below)

  // --- role chains ---------------------------------------------------------------------------------
  const indexes = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let i = from; i < to; i++) out.push(i);
    return out;
  };
  const roleIds = ownRoles(input.routing.roles, facts.class);
  /** Role chains laid out so far, and the in-chain successor of each of their rungs (QA-1.4-16). */
  const roleChains: { readonly start: number; readonly length: number; readonly tier: string }[] = [];
  const chainNext = new Map<number, number | null>();
  const tierRungs = owningTier !== null && owningRank !== null ? modelledRungs(cfg, owningTier).kept : [];
  const firstTierRung = tierRungs[0];
  for (const id of roleIds) {
    const info = agents?.find((agent) => agent.id === id);
    if (owningTier === null || owningRank === null || firstTierRung === undefined) {
      excludedOf(id, "no-owning-tier", info);
      continue;
    }
    const unusable = roleAgentExclusion(id, info, routerIds);
    if (unusable !== null || info === undefined) {
      excludedOf(id, unusable ?? "agent-unavailable", info);
      continue;
    }
    if (!coversNeeds(info.grants, facts.needs)) {
      excludedOf(id, "needs", info);
      continue;
    }

    const agent: AgentRef = { origin: "host", id };
    const chainStart = candidates.length;
    const chain: Candidate[] = [];
    let own: Candidate | null = null;
    const modelRef = modelOfAgent(info, input.parentModel);
    const ref = modelRef === null ? null : splitModelRef(modelRef);
    if (ref !== null) {
      const model = `${ref.provider}/${ref.model}`;
      const matched = presetRungs.find((rung) => sameRung(rung, { model, variant: ref.variant }));
      // A25: price and rank come from the matching preset rung; the owning tier's rank only caps it. The cap is for the CANDIDATE
      // only: when this agent is the pick, never-down compares against its capability rank (`kernel.capabilityRank`, A34).
      const lowered = matched !== undefined && matched.rank < owningRank;
      own = {
        agent,
        model,
        variant: ref.variant,
        costRatio: matched?.costRatio ?? firstTierRung.costRatio,
        rank: lowered ? matched.rank : owningRank,
        tier: lowered ? matched.tier : owningTier,
        source: "role-own-model",
        grants: info.grants,
        ...priced(input, model),
      };
      chain.push(own);
    }
    for (const rung of tierRungs) {
      const candidate: Candidate = {
        agent,
        model: rung.model,
        variant: normalizedVariant(rung.variant),
        costRatio: rung.costRatio,
        rank: owningRank,
        tier: owningTier,
        source: "role-tier-rung",
        grants: info.grants,
        ...priced(input, rung.model),
      };
      if (own !== null && sameRung(own, candidate)) {
        excludedOf(id, "duplicate", info);
        continue;
      }
      chain.push(candidate);
    }

    // After the chain, the cascade continues with the router rungs of the tiers above the owning tier; like
    // the runner, coverage skips apply there only when the policy has variant info.
    const above: number[] = [];
    for (let j = 0; j < routerCount; j++) if (candidates[j]!.rank > owningRank) above.push(j);
    candidates.push(...chain);
    for (let position = 0; position < chain.length; position++) {
      const k = candidates[chainStart + position]!;
      const inChain = firstUncovered(cfg, k, indexes(chainStart + position + 1, chainStart + chain.length), candidates);
      chainNext.set(chainStart + position, inChain);
      next.push(inChain ?? firstUncovered(cfg, k, above, candidates, policy.variants != null));
    }
    roleChains.push({ start: chainStart, length: chain.length, tier: owningTier });
  }

  // --- simulated runner paths (A25) --------------------------------------------------------------------
  const reachable: Candidate[] = [];
  const paths: (number[] | null)[] = candidates.map(() => null);
  const tierBase = (tier: string): RunnerRung | undefined => tierBaseRung(cfg, tier);
  const indexOfRung = (rung: RunnerRung): number | null => {
    const same = (c: Candidate): boolean => c.tier === rung.tier && c.agent.origin === "router" && sameRung(c, rung);
    for (let j = 0; j < routerCount; j++) if (same(candidates[j]!)) return j;
    const known = reachable.findIndex(same);
    if (known >= 0) return candidates.length + known;
    const rank = rankOf(rung.tier);
    if (rank === null) return null;
    reachable.push({
      agent: { origin: "router", id: rung.tier },
      model: rung.model,
      variant: rung.variant,
      costRatio: rung.costRatio,
      rank,
      tier: rung.tier,
      source: "tier",
      grants: agents?.find((agent) => agent.id === rung.tier)?.grants ?? null,
      ...priced(input, rung.model),
    });
    return candidates.length + reachable.length - 1;
  };
  for (let k = 0; k < routerCount; k++) {
    const start = candidates[k]!;
    const attempts = simulateRunner(policy, tierBase, {
      tier: start.tier,
      model: start.model,
      variant: start.variant,
      costRatio: start.costRatio,
    });
    const path: number[] = [];
    for (const attempt of attempts) {
      const j = indexOfRung(attempt);
      if (j === null) break;
      path.push(j);
    }
    // A router rung is priced through its path; its `next` stays null (a path is not a pointer chain).
    paths[k] = path.length > 0 ? path : null;
  }
  // A role rung's path: the rest of its chain (the same coverage-skipping walk as `next` inside the chain),
  // then the runner continuing the SAME delegation from the tier that owns the class, with the chain's attempts
  // and cost already spent (QA-1.4-16), so a native agent's cascade is not given a fresh budget.
  for (const chain of roleChains) {
    for (let at = chain.start; at < chain.start + chain.length; at++) {
      const members: number[] = [];
      for (let m: number | null = at; m !== null && !members.includes(m); m = chainNext.get(m) ?? null) members.push(m);
      const spent: RunnerRung[] = members.map((m) => {
        const c = candidates[m]!;
        return { tier: chain.tier, model: c.model, variant: c.variant, costRatio: c.costRatio };
      });
      const path = [...members];
      for (const attempt of simulateAfter(policy, tierBase, { tier: chain.tier, attempts: spent })) {
        const j = indexOfRung(attempt);
        if (j === null) break;
        path.push(j);
      }
      paths[at] = path;
    }
  }

  return {
    candidates,
    next,
    classRank: owningRank,
    excluded,
    ...(reachable.length > 0 ? { reachable } : {}),
    paths,
    // A34 (QA-G-B1): the capability table. A role rung's rank stays capped at the owning tier; the pick's capability is read here.
    presetRungs: presetRungs.map((rung) => ({ model: rung.model, variant: rung.variant, rank: rung.rank })),
  };
}

// ---------------------------------------------------------------------------
// Role ladders (role-tier-assurance plan §2.1, §2.3, P1.2 T1.2.3)
// ---------------------------------------------------------------------------

export interface RoleLadderInput {
  readonly cfg: RouterConfig;
  readonly facts: Pick<TaskFacts, "class" | "needs">;
  /** The role agent (outcome-key origin `role`). */
  readonly role: string;
  /** `roles/policy.tierBounds(...)` computed with `tiers: escalateLadder(cfg)`. */
  readonly window: RoleWindow;
  /** The class's taxonomy tier; absent = `CLASS_STATIC_TIER[facts.class]` (`null` → the window floor). */
  readonly classTier?: string | null;
  readonly pricing?: (model: string) => ModelPricing;
  readonly logger?: { warn(message: string): void };
  /** The input the runner's policy is built with (same meaning as {@link LadderBuildInput.session}). */
  readonly session?: LadderSessionPolicyInput;
}

interface WindowSpan {
  readonly floor: number;
  readonly ceiling: number;
  readonly reasons: readonly string[];
}

/**
 * The window on the escalate ladder `order`. Fail closed: a floor off the ladder places nothing (`null`, no candidate);
 * a ceiling off the ladder or below the floor collapses to the floor (the narrowest window that keeps the floor).
 */
function windowSpan(order: readonly string[], window: Pick<RoleWindow, "floor" | "ceiling">): WindowSpan | null {
  const floor = order.indexOf(window.floor);
  if (floor < 0) return null;
  const ceiling = order.indexOf(window.ceiling);
  if (ceiling < 0) return { floor, ceiling: floor, reasons: [`window:ceiling-off-ladder:${window.ceiling}`] };
  if (ceiling < floor) return { floor, ceiling: floor, reasons: ["window:ceiling-below-floor"] };
  return { floor, ceiling, reasons: [] };
}

/**
 * The tier order of every role dispatch (QA-P12-1-5, plan R7): `presetTierOrder` of the active preset (cheapest to
 * dearest by `costRatio`, else listing order — the order role tier ranges are placed on), restricted to tiers with at
 * least one rung. Pass it as `tierBounds(..., { tiers })` AND build the
 * ladder with the same `cfg`/`session` ({@link buildRoleLadder}, {@link roleEscalatePolicy} use it), so the window and
 * the ladder can never disagree on tier names.
 */
export function roleTierOrder(cfg: RouterConfig, _session?: LadderSessionPolicyInput): readonly string[] {
  // One tier order for role ranges (`router/roles.ts`) and role ladders: the active preset's cost order. The only
  // narrowing is the one every ladder applies: tiers without a rung are left out. The session never changes tiers.
  return ladderOf(cfg, presetTierOrder(resolveActiveTiers(cfg)));
}

/**
 * The escalation policy of a role dispatch: `buildEscalatePolicy(cfg, session)` with its ladder restricted to the tiers
 * of `[floor, ceiling]` on {@link roleTierOrder} and `floorTier` = the window floor, so the runner never escalates above
 * the ceiling nor starts below the floor (I2). The role runner (P2.1) and {@link buildRoleLadder}'s simulated paths use
 * this one policy, which is what makes `simulate.ts` equal to the runner on role ladders. `null` when the floor is not on
 * the order: P2.1 then refuses the role dispatch — it never falls back to the unrestricted `buildEscalatePolicy`.
 */
export function roleEscalatePolicy(
  cfg: RouterConfig,
  window: Pick<RoleWindow, "floor" | "ceiling">,
  session?: LadderSessionPolicyInput,
): EscalatePolicy | null {
  const policy = buildEscalatePolicy(cfg, session);
  const order = roleTierOrder(cfg, session);
  const span = windowSpan(order, window);
  if (span === null) return null;
  return { ...policy, ladder: order.slice(span.floor, span.ceiling + 1), floorTier: order[span.floor]! };
}

/**
 * Build the candidate graph of a role dispatch (T1.2.3).
 *
 * - Candidates: for every tier of the escalate ladder in `[floor, ceiling]` (tier order, then rung order), the rungs on
 *   the tier's own model (A25; other-model rungs are `not-modelled`), each run by the role agent (`origin: "role"`) at
 *   the tier's rank. A `model#variant` already listed on a lower tier is the same outcome key: kept once (`duplicate`).
 * - Grants: every rung runs the same agent under the same dispatch grant, so `grants` = `facts.needs` (needs a grant
 *   cannot cover are reported by `grantFor` notes, not by the kernel's per-rung `needs` filter).
 * - Paths: the attempts the runner makes under {@link roleEscalatePolicy} (`simulateRunner`), as indices into
 *   `[...candidates, ...reachable]`.
 * - Static default: the class's taxonomy tier clamped into the window (`default:clamp:floor|ceiling`); no class tier or
 *   one off the ladder → the floor. Pin: `window.pinned` (re-clamped defensively, `pin:clamp`), reason `pinned:<tier>`.
 *
 * Never throws for well-typed input; a window that cannot be placed yields an empty ladder (`window:floor-off-ladder`).
 */
export function buildRoleLadder(input: RoleLadderInput): RoleLadder {
  const { cfg, facts, role } = input;
  const order = roleTierOrder(cfg, input.session);
  const agent: AgentRef = { origin: "role", id: role };
  const grants: readonly Need[] = [...facts.needs];
  const classTier = input.classTier !== undefined
    ? input.classTier
    : (Object.hasOwn(CLASS_STATIC_TIER, facts.class) ? CLASS_STATIC_TIER[facts.class] : null);
  const classAt = typeof classTier === "string" ? order.indexOf(classTier) : -1;
  const classRank = classAt >= 0 ? classAt : null;
  const presetRungs: PresetRung[] = [];
  order.forEach((tier, rank) => {
    for (const rung of resolveCandidates(tier, cfg)) presetRungs.push({ model: rung.model, variant: normalizedVariant(rung.variant), rank });
  });

  const span = windowSpan(order, input.window);
  // QA-P12-1-7: the one source of the window's policy (the same call the role runner makes).
  const rolePolicy = roleEscalatePolicy(cfg, input.window, input.session);
  if (span === null || rolePolicy === null) {
    return {
      role,
      candidates: [],
      next: [],
      classRank,
      excluded: [],
      paths: [],
      presetRungs,
      floorRank: null,
      ceilingRank: null,
      tiers: [],
      staticDefault: null,
      pinnedIndex: null,
      reasons: [`window:floor-off-ladder:${input.window.floor}`, "window:no-candidates"],
    };
  }

  // --- candidates: the window's tiers, cheapest first --------------------------------------------------
  const candidates: Candidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  const tiers: RoleLadderTier[] = [];
  const roleRung = (rung: { readonly model: string; readonly variant: string | null; readonly costRatio: number }, tier: string, rank: number): Candidate => ({
    agent,
    model: rung.model,
    variant: normalizedVariant(rung.variant),
    costRatio: rung.costRatio,
    rank,
    tier,
    source: "role-range",
    grants,
    ...priced(input, rung.model),
  });
  for (let rank = span.floor; rank <= span.ceiling; rank++) {
    const tier = order[rank]!;
    const { kept, dropped } = modelledRungs(cfg, tier);
    for (const rung of dropped) excluded.push({ agent, model: rung.model, variant: normalizedVariant(rung.variant), why: "not-modelled" });
    let first: number | null = null;
    for (const rung of kept) {
      const candidate = roleRung({ model: rung.model, variant: normalizedVariant(rung.variant), costRatio: rung.costRatio }, tier, rank);
      if (candidates.some((c) => sameRung(c, candidate))) {
        excluded.push({ agent, model: candidate.model, variant: candidate.variant, why: "duplicate" });
        continue;
      }
      first ??= candidates.length;
      candidates.push(candidate);
    }
    tiers.push({ tier, rank, first });
  }

  // --- simulated runner paths under the window's policy ----------------------------------------------------
  const reachable: Candidate[] = [];
  const indexOfRung = (rung: RunnerRung): number | null => {
    const same = (c: Candidate): boolean => c.tier === rung.tier && sameRung(c, rung);
    const at = candidates.findIndex(same);
    if (at >= 0) return at;
    const known = reachable.findIndex(same);
    if (known >= 0) return candidates.length + known;
    const rank = order.indexOf(rung.tier);
    if (rank < span.floor || rank > span.ceiling) return null; // unreachable under the window policy; defensive
    reachable.push(roleRung(rung, rung.tier, rank));
    return candidates.length + reachable.length - 1;
  };
  const paths = candidates.map((start) => {
    const path: number[] = [];
    for (const attempt of simulateRunner(rolePolicy, (tier) => tierBaseRung(cfg, tier), start)) {
      const j = indexOfRung(attempt);
      if (j === null) break;
      path.push(j);
    }
    return path.length > 0 ? path : null;
  });

  // --- static default and pin --------------------------------------------------------------------------------
  const reasons: string[] = [...span.reasons];
  if (candidates.length === 0) reasons.push("window:no-candidates");
  /** First candidate of the first tier at or above `rank` that has one, else of the highest tier below it. */
  const candidateAt = (rank: number): number | null => {
    for (const t of tiers) if (t.rank >= rank && t.first !== null) return t.first;
    for (let i = tiers.length - 1; i >= 0; i--) if (tiers[i]!.first !== null) return tiers[i]!.first;
    return null;
  };
  let target = span.floor;
  if (classRank === null) reasons.push(typeof classTier === "string" ? `default:off-ladder:${classTier}` : "default:no-class-tier");
  else if (classRank < span.floor) reasons.push("default:clamp:floor");
  else if (classRank > span.ceiling) {
    target = span.ceiling;
    reasons.push("default:clamp:ceiling");
  } else target = classRank;
  const staticDefault = candidateAt(target);

  let pinnedIndex: number | null = null;
  const pin = input.window.pinned;
  if (pin !== null) {
    const at = order.indexOf(pin);
    if (at < 0) reasons.push(`pin:off-ladder:${pin}`);
    else {
      const clamped = Math.min(Math.max(at, span.floor), span.ceiling);
      if (clamped !== at) reasons.push("pin:clamp");
      pinnedIndex = candidateAt(clamped);
      if (pinnedIndex !== null) {
        // QA-P12-1-8: say so when the dispatched rung is not on the requested tier (clamped, or a duplicate rung).
        const got = candidates[pinnedIndex]!.tier;
        reasons.push(got === pin ? `pinned:${pin}` : `pinned:${pin}->${got}`);
      }
    }
  }

  return {
    role,
    candidates,
    next: candidates.map(() => null),
    classRank,
    excluded,
    ...(reachable.length > 0 ? { reachable } : {}),
    paths,
    presetRungs,
    floorRank: span.floor,
    ceilingRank: span.ceiling,
    tiers,
    staticDefault,
    pinnedIndex,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// resolveChosen
// ---------------------------------------------------------------------------

export interface ChosenInput {
  readonly cfg: RouterConfig;
  readonly agents: readonly HostAgentInfo[] | null;
  /** `event.input.agent`. */
  readonly agent: string;
  /** `event.input.model`, when the call set one. */
  readonly model?: string | null;
  readonly parentModel?: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function splitRef(ref: string): { readonly model: string; readonly variant: string | null } {
  const parts = splitModelRef(ref);
  if (parts !== null) return { model: `${parts.provider}/${parts.model}`, variant: parts.variant };
  const hash = ref.lastIndexOf("#");
  if (hash > 0) return { model: ref.slice(0, hash), variant: normalizedVariant(ref.slice(hash + 1)) };
  return { model: ref, variant: null };
}

/**
 * The orchestrator's pick as the kernel's {@link ChosenDispatch}: a router tier agent resolves to the call's
 * `model` or the tier's own base rung; a host agent to the call's `model`, its configured model or the
 * parent's. `null` when nothing resolves (the caller then logs a kept row without calling `decide`).
 */
export function resolveChosen(input: ChosenInput): ChosenDispatch | null {
  const { cfg, agent } = input;
  if (typeof agent !== "string" || agent === "") return null;
  const origin = classifyAgentOrigin(agent, routerTierIds(cfg));
  const callModel = nonEmpty(input.model);
  if (origin === "router") {
    const tier = tierConfigOf(cfg, agent);
    if (callModel !== null) return { agent: { origin, id: agent }, ...splitRef(callModel) };
    if (tier === undefined) return null;
    const base = splitRef(tier.model);
    return { agent: { origin, id: agent }, model: base.model, variant: normalizedVariant(tier.variant) ?? base.variant };
  }
  const info = input.agents?.find((candidate) => candidate.id === agent);
  const ref = callModel ?? nonEmpty(info?.model) ?? nonEmpty(input.parentModel);
  if (ref === null) return null;
  return { agent: { origin, id: agent }, ...splitRef(ref) };
}
