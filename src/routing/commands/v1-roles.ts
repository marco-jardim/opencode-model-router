/**
 * The v1 text-only `R:` line for an explicit `routing.roles` (plan D1, amendment A28, Phase 2.4).
 *
 * On OpenCode v1 the routing engine does not exist (`engine` is forced to `static`, D1). The one v1 effect is opt-in and prose only: when the
 * user sets `routing.roles` explicitly, the orchestrator protocol's `R:` taxonomy line lists those agents as destinations for their
 * classes (`R: … | by class: search→@explore implement→@general`). No model override, no classification, no outcome store, no new file.
 *
 * Without an explicit `routing.roles` nothing here changes anything: {@link applyV1Roles} returns the prompt it was given, the very same
 * string, so the v1 protocol stays byte-identical (§1.2, D2).
 */

import { resolveRouting, type RouterConfig } from "../../router/config";
import { swapTaxonomyLine } from "../../router/protocol";
import { generateTaxonomy } from "../engine/protocol-line";
import type { HostAgentInfo } from "../engine/types";
import type { PluginLogger } from "../../router/logger";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The v1 agent list (`client.app.agents()`: `Agent` records with `name`, `mode` of `subagent`, `primary` or `all`, an optional model) as the
 * line generator reads it. `all` can be dispatched as a subagent. Nothing is inferred about permissions or tools (the text-only line has
 * no needs check), so every agent counts as permitted with no grants.
 */
export function v1AgentInfos(raw: readonly unknown[]): HostAgentInfo[] {
  const infos: HostAgentInfo[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") continue;
    const model = isRecord(entry.model) && typeof entry.model.providerID === "string" && typeof entry.model.modelID === "string"
      ? `${entry.model.providerID}/${entry.model.modelID}`
      : null;
    infos.push({
      id: entry.name,
      model,
      mode: entry.mode === "primary" ? "primary" : "subagent",
      hidden: entry.hidden === true,
      permitted: true,
      grants: [],
    });
  }
  return infos;
}

/**
 * True when the config carries an explicit `routing.roles` that names at least one agent (the only thing that can make the v1 line differ
 * from today's). `roles: {}` is an explicit "none": nothing to list, so nothing is fetched or changed.
 */
export function hasExplicitV1Roles(cfg: RouterConfig, logger?: Pick<PluginLogger, "warn">): boolean {
  const routing = resolveRouting(cfg, "v1", logger);
  return routing.applied.rolesSource === "configured" && Object.values(routing.roles).some((agents) => agents.length > 0);
}

/**
 * `prompt` (the assembled system prompt) with its `R:` line extended by the configured roles. Returns `prompt` itself when the roles are not
 * explicit, when the agent list is unknown, or when no configured agent is usable (`generateTaxonomy` then answers the shipped line).
 */
export function applyV1Roles(prompt: string, cfg: RouterConfig, agents: readonly HostAgentInfo[] | null, logger?: Pick<PluginLogger, "warn">): string {
  if (!hasExplicitV1Roles(cfg, logger) || agents === null) return prompt;
  const routing = resolveRouting(cfg, "v1", logger);
  const line = generateTaxonomy({ cfg, routing, host: "v1", store: null, agents });
  return swapTaxonomyLine(prompt, cfg, line);
}
