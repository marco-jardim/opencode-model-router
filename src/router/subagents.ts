import type { Preset } from "./config";

/**
 * Model override to apply to a pre-existing subagent. `variant` is always
 * present in the result (possibly `undefined`) so callers can distinguish
 * "this tier has no variant" from "leave whatever was there" — an inherited
 * variant from another provider is a silent dispatch-time failure.
 */
export interface SubagentOverride {
  model: string;
  variant: string | undefined;
}

/**
 * Set (non-enumerable, `true`) on the config object the v2 adapter hands to the
 * `config` hook while host agents may still be missing: the "no such agent"
 * notice then waits for its first prompt-time check.
 */
/** v2 only: non-enumerable `Set<string>` of agent names that came from the host setup seed (host built-ins). */
export const HOST_SEED_AGENTS = Symbol.for("opencode-model-router.host-seed-agents");
export const DEFER_MISSING_SUBAGENT_NOTICE = Symbol.for("opencode-model-router.defer-missing-subagent-notice");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolves `subagentTiers` (agent name → tier name) into concrete per-agent
 * model overrides, using the models of the *active* preset. This is what lets
 * a pre-existing agent follow `/preset` instead of pinning a model id in its
 * own definition.
 *
 * Pure. Entries are skipped — never throw — when:
 *  - the named tier does not exist in the active preset (e.g. a map written
 *    for a preset that defines a tier this one doesn't),
 *  - the agent name collides with a tier name, which would clobber the
 *    plugin's own `@fast`/`@medium`/`@heavy` agents,
 *  - the agent is already registered with a `mode` other than "subagent";
 *    primary agents are the orchestrator, and pinning one to a tier model
 *    would defeat the routing design.
 *
 * Note this can only see agents already present in the opencode config —
 * markdown-defined agents are loaded separately, so their `mode` is not
 * visible here. Listing a primary agent defined in markdown is not caught.
 */
export function resolveSubagentOverrides(input: {
  subagentTiers?: Record<string, string>;
  tiers: Preset;
  /** The opencode config's `agent` record, when already populated. */
  existingAgents?: Record<string, unknown>;
  /**
   * Names defined by the router `agents` block (#81). Their `tier` wins, so a
   * `subagentTiers` entry for one of them is skipped.
   */
  pluginAgents?: Record<string, unknown>;
  /** Called for each skipped name whose agent does not exist (phantom) or is plugin-defined. */
  onSkip?: (agentName: string, reason: "missing" | "plugin-agent") => void;
}): Record<string, SubagentOverride> {
  const { subagentTiers, tiers, existingAgents, pluginAgents, onSkip } = input;
  if (!isPlainObject(subagentTiers)) return {};

  const out: Record<string, SubagentOverride> = {};

  for (const [agentName, tierName] of Object.entries(subagentTiers)) {
    if (typeof tierName !== "string" || tierName === "") continue;
    if (agentName === "") continue;

    // Never rewrite the plugin's own tier agents.
    if (Object.prototype.hasOwnProperty.call(tiers, agentName)) continue;

    const tier = tiers[tierName];
    if (!tier || typeof tier.model !== "string" || tier.model === "") continue;

    if (isPlainObject(pluginAgents) && Object.hasOwn(pluginAgents, agentName)) {
      onSkip?.(agentName, "plugin-agent");
      continue;
    }
    // A name that no agent record carries would be created from nothing: a
    // phantom agent with only a model. Only checked when the record is known.
    if (isPlainObject(existingAgents) && !Object.hasOwn(existingAgents, agentName)) {
      onSkip?.(agentName, "missing");
      continue;
    }

    const existing = existingAgents?.[agentName];
    if (isPlainObject(existing) && typeof existing.mode === "string") {
      if (existing.mode !== "subagent") continue;
    }

    out[agentName] = { model: tier.model, variant: tier.variant };
  }

  return out;
}

/**
 * Merges a resolved override onto an agent's existing config entry.
 *
 * `variant` is set or removed explicitly rather than spread, so a tier without
 * a variant clears one left behind by a previous preset instead of inheriting
 * it. Every other field on the entry is preserved.
 */
export function mergeSubagentOverride(
  existing: unknown,
  override: SubagentOverride,
): Record<string, unknown> {
  const base = isPlainObject(existing) ? { ...existing } : {};
  base.model = override.model;
  if (override.variant) base.variant = override.variant;
  else delete base.variant;
  return base;
}
