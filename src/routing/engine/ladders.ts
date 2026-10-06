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
  resolvePresetName,
  type ResolvedRouting,
  type ResolvedCandidate,
  type RouterConfig,
  type TierConfig,
} from "../../router/config";
import { buildEscalatePolicy, type EscalatePolicy, type LadderSessionPolicyInput } from "../../escalate/ladder";
import { variantCovered } from "../../escalate/variants";
import { CLASS_STATIC_TIER, NEEDS, type Need, type TaskFacts } from "../classify/types";
import { classifyAgentOrigin, normalizeVariant, splitModelRef } from "../outcomes/types";
import type { AgentRef, ModelPricing } from "../outcomes/types";
import { coversNeeds } from "./kernel";
import { simulateRunner, type RunnerRung } from "./simulate";
import type {
  Candidate,
  ChosenDispatch,
  ExcludedCandidate,
  ExclusionReason,
  HostAgentInfo,
  Ladder,
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
function priced(input: LadderBuildInput, model: string): { readonly pricing?: ModelPricing } {
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
      // A25: price and rank come from the matching preset rung; the owning tier's rank only caps it.
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
      next.push(inChain ?? firstUncovered(cfg, k, above, candidates, policy.variants != null));
    }
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

  return {
    candidates,
    next,
    classRank: owningRank,
    excluded,
    ...(reachable.length > 0 ? { reachable } : {}),
    paths,
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
