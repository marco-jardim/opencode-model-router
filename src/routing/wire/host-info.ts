/**
 * What the dispatch wiring (M7, Phase 2.2) knows about the host: agents with their EVALUATED permissions, and a
 * synchronous view of the model catalog.
 *
 * Why this exists. The kernel (`src/routing/engine/*`) is pure and synchronous; it needs, per decision, a
 * `HostAgentInfo[]` (A11: needs come from evaluated permissions, never from agent ids) and a catalog lookup
 * (pricing for D5, variants and limits for the 1.5 runner simulation). The host offers both only through async
 * calls, so this module turns the raw `ctx.agent.list()` / `ctx.model.list()` answers into the kernel's inputs and
 * caches the catalog (stale-while-revalidate, the first load bounded).
 *
 * Permission semantics (verified against OpenCode 2.0.22 in the 0.P spikes, `docs/qa/cost-aware-routing/phase-0P.md`
 * S1-deny): rules are `{ action, resource, effect }`, an agent's rules come before the session's, and the LAST
 * matching rule wins. Anything this module cannot decide with certainty is "not granted": an uncovered need or a
 * missing permission only makes a candidate ineligible, it never makes a dispatch worse.
 */

import type { Need } from "../classify/types";
import { grantsFromTools } from "../engine/ladders";
import type { HostAgentInfo } from "../engine/types";
import type { ModelPricing } from "../outcomes/types";
import type { CatalogModel } from "../../escalate/variants";

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: PermissionEffect;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `*` matches any run of characters (path separators included); everything else is literal and case-sensitive. */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  if (!pattern.includes("*")) return pattern === value;
  const parts = pattern.split("*");
  let position = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (i === 0) {
      if (!value.startsWith(part)) return false;
      position = part.length;
    } else if (i === parts.length - 1) {
      return value.length - part.length >= position && value.endsWith(part);
    } else {
      const found = value.indexOf(part, position);
      if (found < 0) return false;
      position = found + part.length;
    }
  }
  return true;
}

/** Valid rules only (a malformed entry is ignored, so it can never grant anything). A missing `resource` means `*`. */
export function parseRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const rules: PermissionRule[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.action !== "string") continue;
    const effect = item.effect;
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") continue;
    rules.push({ action: item.action, resource: typeof item.resource === "string" ? item.resource : "*", effect });
  }
  return rules;
}

/** Effect of the last rule matching `(action, resource)`; `null` when none matches. */
export function evaluateRules(rules: readonly PermissionRule[], action: string, resource: string): PermissionEffect | null {
  let effect: PermissionEffect | null = null;
  for (const rule of rules) {
    if (wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource)) effect = rule.effect;
  }
  return effect;
}

/**
 * True only when `action` is allowed for EVERY resource: the last rule that matches the action at all is an `allow`
 * whose resource is `*`. A rule limited to some resources (`bash` for `git *`, `external_directory` for one path)
 * leaves the action conditional, which grants nothing (1.4 handoff, QA-1.4-14).
 */
export function allowedUnconditionally(rules: readonly PermissionRule[], action: string): boolean {
  let allowed = false;
  for (const rule of rules) {
    if (!wildcardMatch(rule.action, action)) continue;
    allowed = rule.effect === "allow" && (rule.resource === "*" || rule.resource === "**");
  }
  return allowed;
}

const TOOLS_OF_INTEREST: readonly string[] = ["shell", "bash", "webfetch", "websearch", "edit", "write", "patch", "apply_patch"];

/** A11: the needs an agent's evaluated rules grant (unconditional allows only). */
export function grantsOfRules(rules: readonly PermissionRule[]): Need[] {
  const tools = TOOLS_OF_INTEREST.filter((tool) => allowedUnconditionally(rules, tool));
  return grantsFromTools(tools, allowedUnconditionally(rules, "external_directory"));
}

/**
 * May the dispatching session start `agentID` as a subagent? Rules are the parent agent's followed by the session's
 * (last match wins). Only an explicit `allow` counts: `ask` would stop the dispatch on a prompt the engine caused, and
 * the host re-checks after a rewrite (`Subagent denied: explore`, A11).
 */
export function subagentPermitted(rules: readonly PermissionRule[], agentID: string): boolean {
  return evaluateRules(rules, "subagent", agentID) === "allow";
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** `provider/model[#variant]` of a host `Agent.Info.model`; `null` when the agent has none. */
export function agentModelRef(model: unknown): string | null {
  if (!isRecord(model) || typeof model.providerID !== "string" || typeof model.id !== "string") return null;
  if (model.providerID === "" || model.id === "") return null;
  const variant = typeof model.variant === "string" && model.variant !== "" ? `#${model.variant}` : "";
  return `${model.providerID}/${model.id}${variant}`;
}

export interface AgentView {
  readonly infos: readonly HostAgentInfo[];
  /** Agent id → description (hint text). */
  readonly descriptions: ReadonlyMap<string, string>;
  /** Evaluated rules of the dispatching (parent) agent followed by its session's. */
  readonly parentRules: readonly PermissionRule[];
}

/**
 * The kernel's view of `ctx.agent.list().data`. `parentAgent` is the agent that dispatches (the session's agent);
 * `sessionRules` the session's own `permissions`. An unknown parent agent permits nothing: the engine then keeps the
 * orchestrator's pick.
 */
export function buildAgentView(agents: readonly unknown[], parentAgent: string | undefined, sessionRules: readonly PermissionRule[]): AgentView {
  const records = agents.filter(isRecord);
  const parent = parentAgent === undefined ? undefined : records.find((agent) => agent.id === parentAgent);
  const parentRules: PermissionRule[] = parent === undefined ? [] : [...parseRules(parent.permissions), ...sessionRules];
  const infos: HostAgentInfo[] = [];
  const descriptions = new Map<string, string>();
  for (const agent of records) {
    if (typeof agent.id !== "string" || agent.id === "") continue;
    if (typeof agent.description === "string" && agent.description !== "") descriptions.set(agent.id, agent.description);
    infos.push({
      id: agent.id,
      model: agentModelRef(agent.model),
      mode: typeof agent.mode === "string" ? agent.mode : "primary",
      hidden: agent.hidden === true,
      permitted: parent !== undefined && subagentPermitted(parentRules, agent.id),
      grants: grantsOfRules(parseRules(agent.permissions)),
    });
  }
  return { infos, descriptions, parentRules };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** The part of a host `Model.Info` the wiring reads (variants and limits for the runner, `cost` for D5). */
export interface RawCatalogModel extends CatalogModel {
  readonly providerID: string;
  readonly id: string;
  readonly cost?: unknown;
}

export interface WireCatalog {
  /**
   * Make a recent catalog available to the synchronous lookups below. The first load waits at most `loadTimeoutMs`
   * (then the lookups answer "unknown"); later calls return at once and refresh in the background. Never rejects.
   */
  ensure(): Promise<void>;
  /** `provider/model` (no `#variant`) → the catalog entry, or `undefined` (unknown model, no catalog yet). */
  entry(model: string): RawCatalogModel | undefined;
  /** Catalog `cost` of the model; `undefined` = unpriced (A1). */
  pricing(model: string): ModelPricing;
}

export interface WireCatalogOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly retryMs?: number;
  readonly loadTimeoutMs?: number;
  readonly logger?: { warn(message: string, extra?: Record<string, unknown>): void };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWireCatalog(list: () => Promise<readonly RawCatalogModel[]>, options: WireCatalogOptions = {}): WireCatalog {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const retryMs = options.retryMs ?? 15_000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 2_000;
  let table = new Map<string, RawCatalogModel>();
  let loadedAt: number | null = null;
  let failedAt: number | null = null;
  let loading: Promise<void> | null = null;
  let gaveUpWaiting = false;

  const startLoad = (): Promise<void> => {
    const run = async (): Promise<void> => {
      try {
        const models = await list();
        const next = new Map<string, RawCatalogModel>();
        for (const model of models) next.set(`${model.providerID}/${model.id}`, model);
        table = next;
        loadedAt = now();
        failedAt = null;
        gaveUpWaiting = false;
      } catch (error) {
        failedAt = now();
        options.logger?.warn("[router] routing: model catalog unavailable; pricing and variants are unknown", { error: describeError(error) });
      }
    };
    const load: Promise<void> = run().finally(() => {
      if (loading === load) loading = null;
    });
    loading = load;
    return load;
  };

  return {
    async ensure(): Promise<void> {
      const t = now();
      if (loadedAt !== null && t - loadedAt < ttlMs) return;
      const backingOff = failedAt !== null && t - failedAt < retryMs;
      const load = loading ?? (backingOff ? null : startLoad());
      if (load === null || loadedAt !== null || gaveUpWaiting) return; // stale table served while it reloads
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        load.then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), loadTimeoutMs);
          timer.unref();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "timeout" && loadedAt === null) {
        gaveUpWaiting = true; // nobody waits for a catalog that hung once; the load stays pending
        failedAt = now();
        options.logger?.warn("[router] routing: model catalog is slow; pricing and variants are unknown for now", { loadTimeoutMs });
      }
    },
    entry: (model) => table.get(model),
    pricing(model): ModelPricing {
      const cost = table.get(model)?.cost;
      return typeof cost === "object" && cost !== null ? (cost as ModelPricing) : undefined;
    },
  };
}
