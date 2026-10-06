/**
 * Cost doctor findings (M8, plan F4, Phase 2.4.1): what the router's own configuration and the host's catalog say
 * about money and reliability that the user can fix.
 *
 * Pure: no I/O, no clock, no host calls. Every check reads only what it is handed (the merged router config, a view of
 * the host's agents and the host model catalog) and answers with {@link Finding}s. A check that cannot know (no
 * catalog, no agent list) says nothing instead of guessing, and a check that throws is skipped and logged by
 * {@link runChecks}'s caller (`runAdvisor`), never raised into a session.
 *
 * Never invents a model: a suggested model always comes from the catalog it was given, is enabled, active and priced (A1/A2), and
 * for the host's title agent it passes the host's own `Model.small` predicate (text in and out). A finding says where its fix goes:
 * `target: "host"` = the user's `opencode.json`, `target: "router"` = `opencode-model-router.overrides.jsonc`; a snippet is JSON for that
 * file, nothing else.
 */

import { readFileSync } from "node:fs";
import type { RouterConfig, TierConfig } from "../../router/config";
import { configPath, resolveCandidates, resolveClassifierForPreset, resolveRouting, resolveVariantSteps, validateConfig } from "../../router/config";
import { getActiveTiers } from "../../router/protocol";
import { buildEscalatePolicy } from "../../escalate/ladder";
import type { TierVariantInfo } from "../../escalate/ladder";
import { DEFAULT_VARIANT, catalogVariantIds, nextVariant, variantCovered, variantPosition, variantRank } from "../../escalate/variants";
import type { VariantLadder } from "../../escalate/variants";
import { CLASS_STATIC_TIER } from "../classify/types";
import { isUnpriced, selectPriceEntry } from "../outcomes/cost";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `warning`: a misconfiguration that costs reliability or silently disables something; `saving`: a concrete way to spend less; `info`: explains a number. */
export type FindingSeverity = "warning" | "saving" | "info";

export const FINDING_IDS = [
  "title-model-unset",
  "model-not-in-catalog",
  "no-tool-support",
  "variant-not-offered",
  "effort-not-offered",
  "variant-effort",
  "effort-variant-mismatch",
  "rejected-candidates",
  "foreign-candidates",
  "covered-tier",
  "variant-ladder-budget",
  "attempts-without-variants",
  "unpriced-model",
  "subscription-pricing",
  "native-role-unmatched-rung",
  "tier-agent-unavailable",
  "classifier-model-missing",
] as const;
export type FindingId = (typeof FINDING_IDS)[number];

/** Whose configuration the fix belongs to: the host's own (`opencode.json`) or this plugin's (`opencode-model-router.overrides.jsonc`). */
export type FindingTarget = "host" | "router";

/** Only the title agent's model is the host's; everything else is this plugin's configuration. */
export const FINDING_TARGET: Readonly<Record<FindingId, FindingTarget>> = {
  "title-model-unset": "host",
  "model-not-in-catalog": "router",
  "no-tool-support": "router",
  "variant-not-offered": "router",
  "effort-not-offered": "router",
  "variant-effort": "router",
  "effort-variant-mismatch": "router",
  "rejected-candidates": "router",
  "foreign-candidates": "router",
  "covered-tier": "router",
  "variant-ladder-budget": "router",
  "attempts-without-variants": "router",
  "unpriced-model": "router",
  "subscription-pricing": "router",
  "native-role-unmatched-rung": "router",
  "tier-agent-unavailable": "router",
  "classifier-model-missing": "router",
};

export interface Finding {
  readonly id: FindingId;
  readonly severity: FindingSeverity;
  /** Which file the fix is for. */
  readonly target: FindingTarget;
  /** The agent, tier or model the finding is about (`""` for a global finding). */
  readonly subject: string;
  /** What is wrong and what it costs, in one or two sentences. */
  readonly message: string;
  /** A JSON snippet for the `target` file that fixes it, or `null` when there is nothing safe to suggest. */
  readonly snippet: string | null;
  /** The OpenCode v1 spelling of a host-target snippet (`agent.title.model` / `small_model`), or `null`. */
  readonly snippetV1: string | null;
  /** The finding concerns a tier of a bundled preset that the user has not modified (QA-2.4-5): listed in `/router`, never in a notice. */
  readonly bundledTier: boolean;
  /** May appear in a notice: a warning or a saving that is not about an unmodified bundled tier. */
  readonly notify: boolean;
}

/** What a check produces: `runChecks` adds `target`, `snippetV1`, `bundledTier` and `notify`. */
type RawFinding = Omit<Finding, "target" | "snippetV1" | "bundledTier" | "notify"> & { readonly snippetV1?: string | null };

/** The slice of a host `Model.Info` the checks read (structural; extra fields are ignored). */
export interface AdvisorCatalogModel {
  readonly providerID: string;
  readonly id: string;
  readonly enabled?: boolean;
  readonly status?: string;
  /** Model family (`claude-haiku`, `gpt-luna`, …): the host's small-model pick is by family. */
  readonly family?: string;
  readonly capabilities?: { readonly tools?: boolean; readonly input?: readonly string[]; readonly output?: readonly string[] } | null;
  readonly variants?: ReadonlyArray<{ readonly id?: unknown } | null | undefined> | null;
  readonly cost?: unknown;
  readonly limit?: { readonly context?: unknown; readonly input?: unknown; readonly output?: unknown } | null;
}

export interface HostAgentView {
  readonly id: string;
  /** `provider/model[#variant]`, or `null` when the agent has no model of its own. */
  readonly model: string | null;
  /** `subagent`, `primary` or `all` as the host reports it; `null` when the record carries none of those (a check then says nothing about the agent). */
  readonly mode: "subagent" | "primary" | "all" | null;
  readonly hidden: boolean;
}

/** What the checks need to know of the host's own configuration: its agents (a missing `model` = unset) and the session's model. */
export interface HostConfigView {
  readonly agents: readonly HostAgentView[];
  /** The orchestrator's model (the host's "primary"); `null`/absent when not known yet. The host's title pick depends on its provider. */
  readonly primary?: { readonly providerID: string; readonly modelID: string | null } | null;
}

/** Providers whose catalog prices are relative weights, not what is billed (D6). */
export const SUBSCRIPTION_PROVIDERS: readonly string[] = ["opencode", "opencode-go", "github-copilot"];

const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = { warning: 0, saving: 1, info: 2 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `provider/model#variant` → `{ model: "provider/model", variant }`. */
export function splitModelRef(ref: string): { model: string; variant: string | null } {
  const at = ref.indexOf("#");
  return at < 0 ? { model: ref, variant: null } : { model: ref.slice(0, at), variant: ref.slice(at + 1) === "" ? null : ref.slice(at + 1) };
}

function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash < 0 ? "" : model.slice(0, slash);
}

function index(catalog: readonly AdvisorCatalogModel[]): Map<string, AdvisorCatalogModel> {
  const map = new Map<string, AdvisorCatalogModel>();
  for (const model of catalog) map.set(`${model.providerID}/${model.id}`, model);
  return map;
}

function usable(model: AdvisorCatalogModel): boolean {
  return model.enabled === true && model.status !== "deprecated";
}

/** Catalog price of `model` as `input + output` USD per million tokens; `null` when unpriced (A1). */
function pricePerMillion(model: AdvisorCatalogModel): number | null {
  if (isUnpriced(model.cost as Parameters<typeof isUnpriced>[0])) return null;
  const entry = selectPriceEntry(model.cost as Parameters<typeof selectPriceEntry>[0], 0);
  return entry === null ? null : entry.input + entry.output;
}

/**
 * The host's own candidate test for a title model (`Model.small` at v2.0.22, `core/src/model.ts`): enabled, `status: "active"`, and text
 * in AND out. Tool calls are not needed (a title is one text generation), so they are not required here (QA-2.4-11).
 */
function titleEligible(model: AdvisorCatalogModel): boolean {
  const input = model.capabilities?.input;
  const output = model.capabilities?.output;
  return (
    model.enabled === true &&
    model.status === "active" &&
    Array.isArray(input) && input.some((item) => typeof item === "string" && item.startsWith("text")) &&
    Array.isArray(output) && output.some((item) => typeof item === "string" && item.startsWith("text"))
  );
}

/** The families the host's `Model.small` looks for, in its order of preference. */
export const HOST_SMALL_MODEL_FAMILIES: readonly string[] = ["gpt-luna", "gemini-flash-lite", "gemini-flash", "claude-haiku"];

/**
 * What `Model.small(providerID)` would answer for this catalog: among the provider's eligible models, the first of
 * {@link HOST_SMALL_MODEL_FAMILIES} that has one. `null` = the host finds none and a title is generated with the session's own model.
 */
export function hostSmallModel(catalog: readonly AdvisorCatalogModel[], providerID: string): AdvisorCatalogModel | null {
  const models = catalog.filter((model) => model.providerID === providerID && titleEligible(model));
  for (const family of HOST_SMALL_MODEL_FAMILIES) {
    const hit = models.find((model) => model.family === family);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * A2: the cheapest priced model the host would accept for the title agent (`titleEligible`). Ties break on `provider/id`, so the
 * answer is stable. `null` when the catalog has none.
 */
export function cheapestTitleModel(catalog: readonly AdvisorCatalogModel[]): { ref: string; model: AdvisorCatalogModel; price: number } | null {
  let best: { ref: string; model: AdvisorCatalogModel; price: number } | null = null;
  for (const model of catalog) {
    if (!titleEligible(model)) continue;
    const price = pricePerMillion(model);
    if (price === null) continue;
    const ref = `${model.providerID}/${model.id}`;
    if (best === null || price < best.price || (price === best.price && ref < best.ref)) best = { ref, model, price };
  }
  return best;
}

function fmtPrice(model: AdvisorCatalogModel): string {
  const entry = selectPriceEntry(model.cost as Parameters<typeof selectPriceEntry>[0], 0);
  return entry === null ? "n/a" : `$${entry.input}/$${entry.output} per Mtok in/out`;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function isEffortConfigured(tier: TierConfig): boolean {
  return tier.effort !== undefined || tier.thinking !== undefined || tier.reasoning !== undefined;
}

/** Every `(model, variant)` rung of every active tier, with the tier that owns it. */
function rungsOf(cfg: RouterConfig): Array<{ tier: string; model: string; variant: string | null; costRatio: number }> {
  const rungs: Array<{ tier: string; model: string; variant: string | null; costRatio: number }> = [];
  for (const name of Object.keys(getActiveTiers(cfg) ?? {})) {
    for (const rung of resolveCandidates(name, cfg)) rungs.push({ tier: name, model: rung.model, variant: rung.variant ?? null, costRatio: rung.costRatio });
  }
  return rungs;
}

function activeTierEntries(cfg: RouterConfig): Array<[string, TierConfig]> {
  return Object.entries(getActiveTiers(cfg) ?? {}).filter(([, tier]) => tier !== null && typeof tier === "object" && typeof tier.model === "string" && tier.model !== "");
}

interface CheckInput {
  readonly cfg: RouterConfig;
  readonly host: HostConfigView | null;
  readonly catalog: readonly AdvisorCatalogModel[] | null;
  /** Catalog by `provider/model`; `null` when the catalog is unknown or empty (a catalog check then says nothing). */
  readonly byRef: ReadonlyMap<string, AdvisorCatalogModel> | null;
}

type Check = (input: CheckInput) => RawFinding[];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * F4, QA-2.4-1: the host picks a session title's model as `agents.title.model`, else `Model.small(<session's provider>)` (a small model of
 * the SAME provider: gpt-luna, gemini-flash-lite, gemini-flash or claude-haiku), else the session's own model (v2.0.22
 * `core/src/session/context.ts` `selectTitle`). So the only case where leaving it unset costs anything is the last one: the provider has
 * no such model in the catalog. Everything else is silent: with a small model present the host already picks a cheap one, and without
 * knowing the session's provider (or the catalog) the pick cannot be predicted. No consumer of a `summary` model was found in the host,
 * so none is reported.
 */
const titleModel: Check = ({ host, catalog }) => {
  if (host === null || catalog === null) return [];
  const title = host.agents.find((a) => a.id === "title");
  if (title === undefined || title.model !== null) return [];
  const primary = host.primary;
  if (primary === null || primary === undefined) return [];
  if (hostSmallModel(catalog, primary.providerID) !== null) return [];
  // The host falls back to the primary itself, so that is the price to beat (never when the primary is unpriced: then no saving is claimed).
  const cheapest = cheapestTitleModel(catalog);
  if (cheapest === null) return [];
  const primaryEntry = primary.modelID === null ? undefined : catalog.find((m) => m.providerID === primary.providerID && m.id === primary.modelID);
  const primaryPrice = primaryEntry === undefined ? null : pricePerMillion(primaryEntry);
  if (primaryPrice !== null && cheapest.price >= primaryPrice) return [];
  const primaryRef = primary.modelID === null ? primary.providerID : `${primary.providerID}/${primary.modelID}`;
  const subscription = SUBSCRIPTION_PROVIDERS.includes(cheapest.model.providerID);
  return [{
    id: "title-model-unset",
    severity: "saving",
    subject: "title",
    message: `agents.title.model is unset and the host finds no small model of ${primary.providerID} in your catalog (it looks for ${HOST_SMALL_MODEL_FAMILIES.join(", ")} of the session's provider), so session titles are generated with the session's own model, ${primaryRef}${
      primaryPrice === null ? "" : ` (${fmtPrice(primaryEntry as AdvisorCatalogModel)})`
    }. The cheapest priced model the host accepts for it in your catalog is ${cheapest.ref} (${fmtPrice(cheapest.model)})${
      subscription ? `; ${cheapest.model.providerID} is a subscription provider, so its catalog prices are relative weights, not billed amounts` : ""
    }.`,
    snippet: json({ agents: { title: { model: cheapest.ref } } }),
    snippetV1: `${json({ agent: { title: { model: cheapest.ref } } })} or ${json({ small_model: cheapest.ref })}`,
  }];
};

/** QA-1.1-9: every rung of every tier against the live catalog (existence, tool support, variant). */
const ladderCatalog: Check = ({ cfg, byRef }) => {
  if (byRef === null) return [];
  const findings: RawFinding[] = [];
  const seen = new Set<string>();
  for (const rung of rungsOf(cfg)) {
    const entry = byRef.get(rung.model);
    const key = `${rung.tier}|${rung.model}|${rung.variant ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry === undefined || !usable(entry)) {
      findings.push({
        id: "model-not-in-catalog",
        severity: "warning",
        subject: rung.tier,
        message: `Tier ${rung.tier} uses ${rung.model}, which is ${entry === undefined ? "not in" : "not enabled or deprecated in"} the host's model catalog: a dispatch to it fails, and the engine cannot price or resume it.`,
        snippet: null,
      });
      continue;
    }
    if (entry.capabilities?.tools === false) {
      findings.push({
        id: "no-tool-support",
        severity: "warning",
        subject: rung.tier,
        message: `Tier ${rung.tier} uses ${rung.model}, which does not support tool calls; a subagent cannot read, edit or run anything on it.`,
        snippet: null,
      });
    }
    const ids = catalogVariantIds(entry);
    if (rung.variant !== null && ids !== null && !ids.includes(rung.variant)) {
      findings.push({
        id: "variant-not-offered",
        severity: "warning",
        subject: rung.tier,
        message: `Tier ${rung.tier} asks for ${rung.model}#${rung.variant}, but the catalog offers ${ids.length === 0 ? "no variants" : `only ${ids.join(", ")}`} for it: the variant is dropped, the tier takes no variant steps and cannot be resumed.`,
        snippet: null,
      });
    }
  }
  for (const [name, tier] of activeTierEntries(cfg)) {
    if (tier.effort === undefined) continue;
    const entry = byRef.get(tier.model);
    const ids = entry === undefined ? null : catalogVariantIds(entry);
    if (ids !== null && ids.length > 0 && !ids.includes(tier.effort)) {
      findings.push({
        id: "effort-not-offered",
        severity: "info",
        subject: name,
        message: `Tier ${name} sets effort ${tier.effort}, which is not one of ${tier.model}'s catalog variants (${ids.join(", ")}); the host may map it provider-specifically or ignore it.`,
        snippet: null,
      });
    }
  }
  return findings;
};

/** Ladders the runner will walk: needs variant steps on (v2, `auto`) and a catalog. */
function variantInfos(cfg: RouterConfig, byRef: ReadonlyMap<string, AdvisorCatalogModel> | null): { perTier: Readonly<Record<string, TierVariantInfo>>; maxTotalAttempts: number; ladder: readonly string[] } | null {
  if (byRef === null || resolveVariantSteps(cfg, "v2") !== "auto") return null;
  const policy = buildEscalatePolicy(cfg, {
    host: "v2",
    variantSteps: "auto",
    maxContextFraction: resolveRouting(cfg, "v2").sessionReuse.maxContextFraction,
    catalog: (model) => byRef.get(model) ?? null,
  });
  return { perTier: policy.variants?.perTier ?? {}, maxTotalAttempts: policy.maxTotalAttempts, ladder: policy.ladder };
}

/** A20 / QA-2.3-13: a tier that sets `variant` AND `effort`/`thinking`/`reasoning` has an empty variant ladder. */
const variantWithEffort: Check = ({ cfg, byRef }) => {
  if (resolveVariantSteps(cfg, "v2") !== "auto") return [];
  const findings: RawFinding[] = [];
  for (const [name, tier] of activeTierEntries(cfg)) {
    if (typeof tier.variant !== "string" || tier.variant === "" || !isEffortConfigured(tier)) continue;
    const entry = byRef?.get(tier.model);
    const ids = entry === undefined ? null : catalogVariantIds(entry);
    const above = (ids ?? []).filter((id) => variantRank(id) > variantRank(tier.variant as string));
    const own = resolveCandidates(name, cfg)[0];
    const snippet = ids === null || above.length === 0 || own === undefined
      ? null
      : json({ presets: { [cfg.activePreset]: { [name]: { candidates: [{ variant: tier.variant, costRatio: own.costRatio }, ...above.map((variant) => ({ variant }))] } } } });
    findings.push({
      id: "variant-effort",
      severity: "warning",
      subject: name,
      message: `Tier ${name} sets variant ${tier.variant} together with ${[tier.effort !== undefined ? "effort" : null, tier.thinking !== undefined ? "thinking" : null, tier.reasoning !== undefined ? "reasoning" : null].filter((s) => s !== null).join("/")}: effort is delivered by the effort path only, so the tier has no variant steps, and an escalation across it starts a fresh session instead of resuming the child. Drop the effort setting from the tier and list its variants as \`candidates\`${
        snippet === null ? "" : " (snippet: the variants the catalog offers above it; give each higher rung its own costRatio, it inherits the tier's otherwise, which understates it)"
      }.`,
      snippet,
    });
  }
  return findings;
};

/**
 * QA-3.2 (O-32-5, measured on the real OpenCode 2.0.22 host in Phase 3.2): a tier that sets `variant` AND a different `effort` runs the EFFORT
 * on the wire (the agent's effort option wins over the stored variant: the child is stored `#medium` while the request carries `xhigh`), but
 * the outcome keys, the decision rows and `routing:stats` name the VARIANT. The evidence is then filed under a rung that is not what ran.
 * Only while the engine records anything (`routing.engine` is not `static`). `variant-effort` is a different finding (the tier has no variant steps).
 */
const effortVariantMismatch: Check = ({ cfg, byRef }) => {
  if (resolveRouting(cfg, "v2").engine === "static") return [];
  const findings: RawFinding[] = [];
  for (const [name, tier] of activeTierEntries(cfg)) {
    if (typeof tier.variant !== "string" || tier.variant === "" || typeof tier.effort !== "string" || tier.effort === tier.variant) continue;
    const entry = byRef?.get(tier.model);
    const ids = entry === undefined ? null : catalogVariantIds(entry);
    const offered = ids === null || ids.includes(tier.effort);
    findings.push({
      id: "effort-variant-mismatch",
      severity: "warning",
      subject: name,
      message: `Tier ${name} sets variant ${tier.variant} but effort ${tier.effort}: the request runs effort ${tier.effort} (the agent's effort option wins over the stored variant), while the outcome keys, the decision rows and routing:stats name ${tier.model}#${tier.variant}, so what this tier learns is filed under a rung that is not what runs. Make them agree: ${
        offered ? `set variant to ${tier.effort} (snippet), or ` : ""
      }drop the effort setting.`,
      snippet: offered ? json({ presets: { [cfg.activePreset]: { [name]: { variant: tier.effort } } } }) : null,
    });
  }
  return findings;
};

/** The variant steps a tier takes from its base, in order (the ladder itself also lists the base and the rungs below it). */
function stepsFrom(ladder: VariantLadder, base: string): string[] {
  const steps: string[] = [];
  let current: string | null = base === DEFAULT_VARIANT ? null : base;
  for (let i = 0; i < ladder.variants.length; i += 1) {
    const next = nextVariant(ladder, current);
    if (next === null) break;
    steps.push(next);
    current = next;
  }
  return steps;
}

/** 1.5 handoff: rejected and foreign candidates, tiers a variant ladder covers, F5. */
const variantLadders: Check = ({ cfg, byRef }) => {
  const infos = variantInfos(cfg, byRef);
  if (infos === null) return [];
  const findings: RawFinding[] = [];
  for (const [name, info] of Object.entries(infos.perTier)) {
    if (info.effortConfigured === true) continue; // reported by variantWithEffort
    if (info.ladder.rejected.length > 0) {
      findings.push({
        id: "rejected-candidates",
        severity: "warning",
        subject: name,
        message: `Tier ${name}: candidate variant${info.ladder.rejected.length > 1 ? "s" : ""} ${info.ladder.rejected.join(", ")} of ${info.model} ${info.ladder.rejected.length > 1 ? "are" : "is"} ignored (not offered by the catalog, unranked, or not above the previous rung). Variant steps walk ${info.ladder.variants.length === 0 ? "nothing" : info.ladder.variants.join(" → ")} (base ${info.base}).`,
        snippet: null,
      });
    }
    if (info.ladder.foreign.length > 0) {
      findings.push({
        id: "foreign-candidates",
        severity: "info",
        subject: name,
        message: `Tier ${name}: candidate rung${info.ladder.foreign.length > 1 ? "s" : ""} on another model (${info.ladder.foreign.map((r) => `${r.model}${r.variant === null ? "" : `#${r.variant}`}`).join(", ")}) ${info.ladder.foreign.length > 1 ? "are" : "is"} never walked by variant steps (those stay on ${info.model}); the engine prices ${info.ladder.foreign.length > 1 ? "them" : "it"} as dispatch options only.`,
        snippet: null,
      });
    }
    const steps = stepsFrom(info.ladder, info.base);
    if (steps.length >= infos.maxTotalAttempts - 1 && steps.length > 0) {
      findings.push({
        id: "variant-ladder-budget",
        severity: "info",
        subject: name,
        message: `Tier ${name} has ${steps.length} variant steps (${[info.base, ...steps].join(" → ")}) and maxTotalAttempts is ${infos.maxTotalAttempts}: a failing delegation can spend its whole attempt budget on this tier's variants. The budget reserve still keeps an escalation reachable, but every variant of an unpriced model counts at the tier's costRatio unless you give it its own.`,
        snippet: null,
      });
    }
  }
  // A tier skipped on escalation because an earlier tier on the same model already covers its base.
  const order = infos.ladder.filter((name) => infos.perTier[name] !== undefined);
  for (let i = 0; i < order.length; i += 1) {
    const from = infos.perTier[order[i] as string] as TierVariantInfo;
    if (from.effortConfigured === true) continue;
    const fromSteps = stepsFrom(from.ladder, from.base);
    const top = fromSteps.length === 0 ? from.base : (fromSteps[fromSteps.length - 1] as string);
    const position = (variant: string): number => variantPosition(variant) ?? Number.POSITIVE_INFINITY;
    for (let j = i + 1; j < order.length; j += 1) {
      const to = infos.perTier[order[j] as string] as TierVariantInfo;
      if (to.effortConfigured === true || to.model !== from.model) continue;
      const toSteps = stepsFrom(to.ladder, to.base);
      const toTop = toSteps.length === 0 ? to.base : (toSteps[toSteps.length - 1] as string);
      if (variantCovered(to.base, top) && position(toTop) <= position(top)) {
        findings.push({
          id: "covered-tier",
          severity: "info",
          subject: order[j] as string,
          message: `Tier ${order[j]} (${to.model}#${to.base}) is covered by tier ${order[i]}'s variant steps (up to #${top}): an escalation from ${order[i]} skips it and goes straight to the next tier that adds something.`,
          snippet: null,
        });
      }
    }
  }
  return findings;
};

/** F4: one attempt per tier and no variant steps = every failure pays for a bigger model. */
const attemptsWithoutVariants: Check = ({ cfg }) => {
  const esc = cfg.enforcement?.escalate;
  if (esc === undefined || esc === null) return [];
  const perTier = esc.maxAttemptsPerTier ?? 1;
  if (resolveVariantSteps(cfg, "v2") !== "none" || perTier !== 1) return [];
  return [{
    id: "attempts-without-variants",
    severity: "info",
    subject: "",
    message: "enforcement.escalate.maxAttemptsPerTier is 1 and variantSteps is none: a failed verification escalates straight to the next, more expensive tier. Turn variant steps on (a `routing` block makes the default `auto`) or allow a second attempt per tier.",
    snippet: json({ enforcement: { escalate: { variantSteps: "auto" } } }),
  }];
};

/** D5 / D6: unpriced ladder models and subscription providers. */
const pricing: Check = ({ cfg, byRef }) => {
  if (byRef === null) return [];
  const findings: RawFinding[] = [];
  const models = [...new Set(rungsOf(cfg).map((r) => r.model))];
  const unpriced = models.filter((m) => {
    const entry = byRef.get(m);
    return entry !== undefined && isUnpriced(entry.cost as Parameters<typeof isUnpriced>[0]);
  });
  if (unpriced.length > 0) {
    findings.push({
      id: "unpriced-model",
      severity: "info",
      subject: unpriced.join(", "),
      message: `The catalog has no price for ${unpriced.join(", ")}: the engine compares candidates in costRatio units and reports no USD figure for them (a reported cost of 0 is treated as unknown). Token counts are still recorded.`,
      snippet: null,
    });
  }
  const subscription = [...new Set(models.map(providerOf))].filter((p) => SUBSCRIPTION_PROVIDERS.includes(p));
  if (subscription.length > 0) {
    findings.push({
      id: "subscription-pricing",
      severity: "info",
      subject: subscription.join(", "),
      message: `Provider${subscription.length > 1 ? "s" : ""} ${subscription.join(", ")} ${subscription.length > 1 ? "are" : "is a"} subscription provider${subscription.length > 1 ? "s" : ""}: catalog prices are not what is billed, so the engine uses them as relative weights only.`,
      snippet: null,
    });
  }
  return findings;
};

/** 1.4 handoff (E4): a role agent whose own model matches no rung of the preset is priced at its owning tier's first rung. */
const nativeRoles: Check = ({ cfg, host }) => {
  if (host === null) return [];
  const routing = resolveRouting(cfg, "v2");
  if (routing.engine === "static") return [];
  const rungKeys = new Set(rungsOf(cfg).map((r) => `${r.model}#${r.variant ?? DEFAULT_VARIANT}`));
  const findings: RawFinding[] = [];
  const reported = new Set<string>();
  for (const [taskClass, agents] of Object.entries(routing.roles)) {
    for (const id of agents) {
      const agent = host.agents.find((a) => a.id === id);
      if (agent === undefined || agent.model === null || agent.mode === null || agent.mode === "primary" || agent.hidden || reported.has(id)) continue;
      const { model, variant } = splitModelRef(agent.model);
      if (rungKeys.has(`${model}#${variant ?? DEFAULT_VARIANT}`)) continue;
      reported.add(id);
      const ownerName = CLASS_STATIC_TIER[taskClass as keyof typeof CLASS_STATIC_TIER] ?? cfg.defaultTier;
      const owner = resolveCandidates(ownerName, cfg)[0];
      findings.push({
        id: "native-role-unmatched-rung",
        severity: "info",
        subject: id,
        message: `Agent ${id} (role for ${taskClass}) runs ${agent.model}, which is not a rung of any tier, so the engine prices it at the first rung of tier ${ownerName}${owner === undefined ? "" : ` (${owner.costRatio}×)`}: an assumption, not its real cost. List it as a \`candidates\` rung with its own costRatio to price it properly.`,
        snippet: null,
      });
    }
  }
  return findings;
};

/** 2.2 handoff: the engine routes to agents by id; a tier agent the host does not offer makes it inert for that tier. */
const tierAgents: Check = ({ cfg, host }) => {
  if (host === null || host.agents.length === 0) return [];
  const findings: RawFinding[] = [];
  for (const [name] of activeTierEntries(cfg)) {
    const agent = host.agents.find((a) => a.id === name);
    if (agent !== undefined && (agent.mode === null || (agent.mode !== "primary" && !agent.hidden))) continue; // an unknown mode is not judged
    findings.push({
      id: "tier-agent-unavailable",
      severity: "warning",
      subject: name,
      message: `The host offers no dispatchable subagent named ${name}${agent === undefined ? "" : agent.hidden ? " (it is hidden)" : " (it is a primary agent)"}: the engine cannot route a dispatch to this tier, and any \`ineligible: agent-unavailable\` reason in the decision log comes from this. Check that the plugin is registered and that no permission rule denies \`subagent:${name}\`.`,
      snippet: null,
    });
  }
  return findings;
};

/** QA-1.1-9: the `host` classifier backend names a catalog model. */
const classifierModel: Check = ({ cfg, byRef }) => {
  if (byRef === null) return [];
  const routing = resolveRouting(cfg, "v2");
  const classifier = resolveClassifierForPreset(routing.classifier, cfg.activePreset);
  if (classifier.backend !== "host" || classifier.model === null) return [];
  const { model } = splitModelRef(classifier.model);
  const entry = byRef.get(model);
  if (entry !== undefined && usable(entry)) return [];
  return [{
    id: "classifier-model-missing",
    severity: "warning",
    subject: classifier.model,
    message: `routing.classifier.model is ${classifier.model}, which is ${entry === undefined ? "not in" : "not enabled or deprecated in"} the host's model catalog: the classifier call fails and every dispatch falls back to the rules classifier.`,
    snippet: null,
  }];
};

const CHECKS: ReadonlyArray<readonly [string, Check]> = [
  ["title-model", titleModel],
  ["ladder-catalog", ladderCatalog],
  ["variant-effort", variantWithEffort],
  ["effort-variant", effortVariantMismatch],
  ["variant-ladders", variantLadders],
  ["attempts", attemptsWithoutVariants],
  ["pricing", pricing],
  ["native-roles", nativeRoles],
  ["tier-agents", tierAgents],
  ["classifier-model", classifierModel],
];

/**
 * The findings about the SHAPE of a tier's configuration (`subject` is a tier name of the active preset): what the shipped `tiers.json`
 * defines for that tier is not the user's doing, so while the tier is exactly as shipped these are listed in `/router` and never announced
 * (QA-2.4-R2-7). The findings about the user's ENVIRONMENT (`model-not-in-catalog`, `no-tool-support`, `variant-not-offered`,
 * `tier-agent-unavailable`: the model is not offered, has no tools, the agent is not there) are real whoever wrote the tier, so they
 * always notify.
 */
const CONFIG_SHAPE: ReadonlySet<FindingId> = new Set<FindingId>([
  "variant-effort",
  "effort-variant-mismatch",
  "rejected-candidates",
  "foreign-candidates",
  "covered-tier",
  "variant-ladder-budget",
  "effort-not-offered",
]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The shipped `tiers.json`, validated like any config, read once per loaded config: the memo is keyed by the `RouterConfig` object, and
 * `loadConfig` hands out a new object on every reload, so a `tiers.json` the plugin update replaced is read again (QA-2.4-R2-11) while
 * a config in use is not re-read on every check. `null` = unreadable (a tier is then not "bundled").
 */
let bundledMemo = new WeakMap<RouterConfig, { readonly config: RouterConfig | null }>();

function bundledConfig(cfg: RouterConfig, onError: (check: string, error: unknown) => void): RouterConfig | null {
  let memo = bundledMemo.get(cfg);
  if (memo === undefined) {
    try {
      memo = { config: validateConfig(JSON.parse(readFileSync(configPath(), "utf-8"))) };
    } catch (error) {
      memo = { config: null };
      onError("bundled-preset", error); // reported once per loaded config; every tier then counts as the user's own, so its findings still notify
    }
    bundledMemo.set(cfg, memo);
  }
  return memo.config;
}
/** The tier of the ACTIVE preset is exactly what the shipped `tiers.json` defines for that preset and tier (no override touched it). */
function isUnmodifiedBundledTier(cfg: RouterConfig, tierName: string, onError: (check: string, error: unknown) => void): boolean {
  const live = cfg.presets[cfg.activePreset]?.[tierName];
  const shipped = bundledConfig(cfg, onError)?.presets[cfg.activePreset]?.[tierName];
  return live !== undefined && shipped !== undefined && stable(live) === stable(shipped);
}

/** Test seam: forget every memoized shipped config. */
export function resetBundledConfigMemo(): void {
  bundledMemo = new WeakMap();
}

/**
 * Run every check. A throwing check is reported to `onError` and skipped; the rest still run. Findings come back sorted by
 * severity (warning, saving, info), then by check order, so the list is stable.
 */
export function runChecks(
  cfg: RouterConfig,
  host: HostConfigView | null,
  catalog: readonly AdvisorCatalogModel[] | null,
  onError: (check: string, error: unknown) => void,
): Finding[] {
  const known = catalog !== null && catalog.length > 0 ? catalog : null;
  const input: CheckInput = { cfg, host, catalog: known, byRef: known === null ? null : index(known) };
  const out: Array<{ finding: Finding; order: number }> = [];
  let order = 0;
  for (const [name, check] of CHECKS) {
    try {
      for (const raw of check(input)) {
        const bundledTier = CONFIG_SHAPE.has(raw.id) && isUnmodifiedBundledTier(cfg, raw.subject, onError);
        out.push({
          finding: { ...raw, target: FINDING_TARGET[raw.id], snippetV1: raw.snippetV1 ?? null, bundledTier, notify: raw.severity !== "info" && !bundledTier },
          order: order++,
        });
      }
    } catch (error) {
      onError(name, error);
    }
  }
  return out
    .sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.order - b.order)
    .map((entry) => entry.finding);
}
