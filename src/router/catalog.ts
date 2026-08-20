// ---------------------------------------------------------------------------
// src/router/catalog.ts — model catalog normalization, validation, and
// suggestions. PURE module: no fs/network/SDK/process.env. The async fetch of
// opencode's live catalog (client.config.providers()) happens in index.ts; the
// raw payload is handed here for normalization and analysis.
// ---------------------------------------------------------------------------

import { DEFAULT_STRONG_MODEL_PATTERNS, type RouterConfig } from "./config";
import { getActiveTiers } from "./protocol";

export interface CatalogModel {
  id: string;
  /** "active" | "alpha" | "beta" | "deprecated" when known. */
  status?: string;
}

export interface CatalogProvider {
  id: string;
  name?: string;
  /** opencode's default model id for this provider, when known. */
  defaultModel?: string;
  models: CatalogModel[];
}

export interface Catalog {
  providers: CatalogProvider[];
}

/**
 * Normalize the raw `client.config.providers()` payload
 * (`{ providers: Provider[], default: { [providerId]: modelId } }`) into the
 * minimal shape this module needs. Defensive against missing/oddly-typed fields
 * so a catalog-shape change never throws.
 */
export function normalizeCatalog(raw: unknown): Catalog {
  const providers: CatalogProvider[] = [];
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const defaults =
      r.default && typeof r.default === "object"
        ? (r.default as Record<string, unknown>)
        : {};
    const list = Array.isArray(r.providers) ? r.providers : [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const prov = p as Record<string, unknown>;
      if (typeof prov.id !== "string") continue;
      const modelsObj =
        prov.models && typeof prov.models === "object"
          ? (prov.models as Record<string, unknown>)
          : {};
      const models: CatalogModel[] = Object.entries(modelsObj).map(
        ([key, m]) => {
          const mm = (m && typeof m === "object" ? m : {}) as Record<
            string,
            unknown
          >;
          return {
            id: typeof mm.id === "string" ? mm.id : key,
            status: typeof mm.status === "string" ? mm.status : undefined,
          };
        },
      );
      const def = defaults[prov.id];
      providers.push({
        id: prov.id,
        name: typeof prov.name === "string" ? prov.name : undefined,
        defaultModel: typeof def === "string" ? def : undefined,
        models,
      });
    }
  }
  return { providers };
}

/** True when the catalog carries no usable provider data (fetch failed/empty). */
export function isCatalogEmpty(catalog: Catalog): boolean {
  return catalog.providers.length === 0;
}

/**
 * Split a tier model reference (`"provider/model"`) into its parts. Splits on
 * the FIRST slash only, so multi-segment model ids (e.g.
 * `openrouter/deepseek/deepseek-v3.2`) keep their full model id.
 */
export function parseModelRef(
  ref: string,
): { providerId: string; modelId: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

function findProvider(
  catalog: Catalog,
  providerId: string,
): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.id === providerId);
}

/** Levenshtein edit distance (iterative, two-row). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * Rank a provider's model ids by closeness to `target`, preferring non-deprecated
 * models. Returns up to `limit` model ids.
 */
export function suggestModels(
  target: string,
  models: CatalogModel[],
  limit = 3,
): string[] {
  return models
    .map((m) => ({
      id: m.id,
      deprecated: m.status === "deprecated" ? 1 : 0,
      dist: editDistance(target, m.id),
    }))
    .sort((a, b) => a.deprecated - b.deprecated || a.dist - b.dist || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((m) => m.id);
}

/**
 * Strong-model patterns (`cfg.modelGenerations.strong`, else
 * {@link DEFAULT_STRONG_MODEL_PATTERNS}) that match NO model in the live
 * catalog. Report-only: the router never rewrites the user's pattern list.
 *
 * Why this exists: prompt-style resolution is a case-insensitive substring match
 * (`isStrongModel` in ./prompts). When a provider renames a model
 * (`claude-opus-4-8` -> `opus-4.8`), every pattern that used to match silently
 * stops matching, the tier drops back to the prescriptive prompt, and nothing
 * anywhere errors. This surfaces that silence.
 *
 * Comparison base: the CATALOG, not the active preset. The default pattern list
 * is a cross-preset union by construction (see DEFAULT_STRONG_MODEL_PATTERNS in
 * ./config), so any single preset leaves most of it unmatched — checking against
 * the active preset would warn on every clean install. A pattern matching no
 * model any configured provider serves is dead in THIS environment, which is
 * exactly the rename signal we want. Refs are compared as `provider/model`,
 * mirroring `isStrongModel`, which is fed the full provider-prefixed tier model.
 *
 * Never cries wolf: an empty catalog (fetch failed) or a catalog with no models
 * returns `[]`, like `validateModels`.
 *
 * Gate: reported only when at least one active tier resolves its style by `auto`
 * (`promptStyle` absent or `"auto"`). With every tier pinned to an explicit
 * style the pattern list decides nothing, so an orphan there is harmless noise.
 */
export function findOrphanedStrongPatterns(
  cfg: RouterConfig,
  catalog: Catalog,
): string[] {
  if (isCatalogEmpty(catalog)) return [];

  const tiers = Object.values(getActiveTiers(cfg) ?? {});
  const usesAuto = tiers.some(
    (t) => t?.promptStyle === undefined || t.promptStyle === "auto",
  );
  if (!usesAuto) return [];

  const refs: string[] = [];
  for (const p of catalog.providers) {
    for (const m of p.models) refs.push(`${p.id}/${m.id}`.toLowerCase());
  }
  if (refs.length === 0) return [];

  const configured = cfg.modelGenerations?.strong;
  const raw = configured ?? DEFAULT_STRONG_MODEL_PATTERNS;
  const patterns = raw.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  // Same semantics as isStrongModel(): case-insensitive substring match.
  const orphans = patterns.filter(
    (p) => !refs.some((r) => r.includes(p.toLowerCase())),
  );

  // Evidence gate for the defaults. A user-authored list is a claim about THIS
  // environment, so a dead entry in it is actionable on its own. The default
  // list is not a claim about anything — it is a cross-provider union we ship,
  // so most of it is unserved on any given install and saying so is noise the
  // user cannot act on.
  //
  // Two conditions have to hold together for a default pattern to be worth
  // reporting, and each rules out a different kind of false positive:
  //
  //  1. A near-miss must exist, proving the model IS served under a drifted
  //     separator. Without this, a pattern for a model the providers simply do
  //     not carry gets reported, and if a tier is on that model the useful
  //     signal is the `model-missing` issue, not a second one about a pattern.
  //  2. The pattern must be about a model the active preset actually uses.
  //     Without this, github-copilot serving `claude-opus-4.8` makes the default
  //     `opus-4-8` reportable for every copilot user, including those whose
  //     tiers are on entirely different models, naming a rename that would not
  //     change their routing.
  //
  // Matching for (2) is separator-insensitive so a tier still pinned to the
  // pre-rename spelling reports, which is the case this check exists for.
  const flatten = (v: string) => v.toLowerCase().replace(/[.\-_]/g, "");
  const activeFlat = tiers
    .map((t) => t?.model)
    .filter((m): m is string => typeof m === "string")
    .map(flatten);
  const aboutAnActiveTier = (pattern: string): boolean => {
    const needle = flatten(pattern);
    return needle.length > 0 && activeFlat.some((m) => m.includes(needle));
  };
  const reportable =
    configured === undefined
      ? orphans.filter(
          (p) =>
            findStrongPatternNearMisses(p, catalog).length > 0 &&
            aboutAnActiveTier(p),
        )
      : orphans;
  return [...new Set(reportable)];
}

/**
 * For an orphaned pattern, the served refs it would match if separators were
 * ignored.
 *
 * `findOrphanedStrongPatterns` says a pattern is dead; this says why. The
 * failure this exists for is separator drift, not a wrong name: `anthropic`
 * ships `claude-opus-4-8` while the copilot preset uses `claude-opus-4.6`, so a
 * provider moving between the two un-matches a pattern that is otherwise still
 * describing the right model. Normalizing `.`, `-` and `_` away turns "this
 * matches nothing" into "this matches nothing, but here is the model it almost
 * certainly means", which is the difference between a warning and a fix.
 *
 * Returns empty when nothing plausibly matches, i.e. the pattern is simply
 * wrong or the model is genuinely gone.
 */
export function findStrongPatternNearMisses(
  pattern: string,
  catalog: Catalog,
): string[] {
  const flatten = (v: string) => v.toLowerCase().replace(/[.\-_]/g, "");
  const needle = flatten(pattern);
  if (!needle) return [];

  const refs: string[] = [];
  for (const p of catalog.providers) {
    for (const m of p.models) refs.push(`${p.id}/${m.id}`);
  }
  return refs.filter((r) => flatten(r).includes(needle));
}

export type ModelIssueKind =
  | "provider-unknown"
  | "model-missing"
  | "model-deprecated"
  | "fallback-provider-unknown"
  | "fallback-preset-unknown";

export interface ModelIssue {
  /** Tier name for `scope: "tier"`; the fallback map key for `scope: "fallback"`. */
  tier: string;
  /** Where the reference came from: an active-preset tier, or a fallback chain. */
  scope: "tier" | "fallback";
  /** Full `provider/model` reference for tier issues; the offending chain entry for fallback issues. */
  ref: string;
  providerId: string;
  modelId: string;
  kind: ModelIssueKind;
  /** Preset a fallback chain entry points at (`fallback-preset-unknown` only). */
  chainTarget?: string;
  /** Suggested replacements, closest first: `provider/model` refs for tier issues, preset names for fallback ones. */
  suggestions: string[];
}

/**
 * The fallback map that actually applies to the active preset, using the same
 * precedence as `buildFallbackInstructions` in ./protocol: a non-empty
 * preset-specific map wins over `fallback.global`.
 */
function activeFallbackMap(
  cfg: RouterConfig,
): { source: string; map: Record<string, unknown> } | undefined {
  const fb = cfg.fallback;
  if (!fb) return undefined;
  const presetMap = fb.presets?.[cfg.activePreset];
  if (presetMap && typeof presetMap === "object" && Object.keys(presetMap).length > 0) {
    return { source: `presets.${cfg.activePreset}`, map: presetMap as Record<string, unknown> };
  }
  if (fb.global && typeof fb.global === "object" && Object.keys(fb.global).length > 0) {
    return { source: "global", map: fb.global as Record<string, unknown> };
  }
  return undefined;
}

/**
 * Validate the fallback chains that apply to the active preset. Report-only.
 *
 * NOTE ON SHAPE: a fallback chain is `providerId -> [presetName, ...]` (see
 * FallbackConfig in ./config and `buildFallbackInstructions` in ./protocol) —
 * it holds provider ids and PRESET names, not `provider/model` refs. So the two
 * things that can silently rot are:
 *  - a chain keyed by a provider opencode does not know about (catalog check:
 *    the chain can never fire), and
 *  - a chain entry naming a preset that does not exist, which ./protocol drops
 *    from the rendered chain without a word (config check, no catalog needed).
 *
 * Dedupe: a provider already reported unknown from a tier model is not reported
 * a second time from a fallback key — `knownBadProviders` carries those ids.
 */
function validateFallbackChains(
  cfg: RouterConfig,
  catalog: Catalog,
  knownBadProviders: Set<string>,
): ModelIssue[] {
  const active = activeFallbackMap(cfg);
  if (!active) return [];

  const issues: ModelIssue[] = [];
  const presetNames = Object.keys(cfg.presets ?? {});
  const label = `fallback.${active.source}`;

  // Providers the active preset actually routes to. The shipped tiers.json
  // chains every provider to every other one, so on a single-provider install
  // most chains are dormant BY DESIGN — warning that a provider you never use
  // is unconfigured is noise. A chain only matters once a tier can fail over
  // from it.
  const usedProviders = new Set<string>();
  for (const tierCfg of Object.values(getActiveTiers(cfg) ?? {})) {
    const ref = tierCfg?.model;
    if (typeof ref !== "string") continue;
    const parsed = parseModelRef(ref);
    if (parsed) usedProviders.add(parsed.providerId);
  }

  for (const [providerId, chain] of Object.entries(active.map)) {
    if (!providerId) continue;
    // ./protocol ignores a non-array chain wholesale, so there is nothing left
    // to warn about for this key — skip it the same way rather than reporting
    // an unknown provider for a chain that could never fire anyway.
    if (!Array.isArray(chain)) continue;

    // KEPT DELIBERATELY, THOUGH CURRENTLY UNREACHABLE via validateModels: the
    // tier pass already reports every unknown provider a tier routes to, and it
    // seeds knownBadProviders with exactly those ids — the same set
    // usedProviders admits here. So the two guards below can never both hold on
    // that path. This stays as a safety net in case the usedProviders gating
    // changes (or a caller drives validateFallbackChains directly).
    // Full analysis: https://github.com/marco-jardim/opencode-model-router/issues/30#issuecomment-5343553727
    if (
      !isCatalogEmpty(catalog) &&
      usedProviders.has(providerId) &&
      !findProvider(catalog, providerId) &&
      !knownBadProviders.has(providerId)
    ) {
      knownBadProviders.add(providerId);
      issues.push({
        tier: label,
        scope: "fallback",
        ref: providerId,
        providerId,
        modelId: "",
        kind: "fallback-provider-unknown",
        suggestions: [],
      });
    }

    for (const target of chain) {
      if (typeof target !== "string" || target.length === 0) continue;
      // ./protocol also drops a self-reference to the active preset, but that
      // is a no-op by design rather than a typo, so it is not reported.
      if (target === cfg.activePreset) continue;
      // Truthiness, for parity with ./protocol's `Boolean(cfg.presets[p])`.
      if (cfg.presets?.[target]) continue;
      issues.push({
        tier: label,
        scope: "fallback",
        ref: `${providerId} → ${target}`,
        providerId,
        modelId: "",
        kind: "fallback-preset-unknown",
        chainTarget: target,
        suggestions: presetNames
          .map((n) => ({ n, d: editDistance(target, n) }))
          .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
          .slice(0, 3)
          .map((x) => x.n),
      });
    }
  }

  return issues;
}

/**
 * Validate the active preset's tier models — and the fallback chains that apply
 * to it — against the live catalog. Catalog-dependent checks are skipped when
 * the catalog is empty (fetch failed): we never cry wolf about missing models
 * when we couldn't see the catalog at all. The fallback preset-name check is
 * pure config analysis, so it still runs in that case.
 */
export function validateModels(cfg: RouterConfig, catalog: Catalog): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const badProviders = new Set<string>();
  if (!isCatalogEmpty(catalog)) {
    issues.push(...validateTierModels(cfg, catalog, badProviders));
  }
  issues.push(...validateFallbackChains(cfg, catalog, badProviders));
  return issues;
}

function validateTierModels(
  cfg: RouterConfig,
  catalog: Catalog,
  badProviders: Set<string>,
): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const preset = getActiveTiers(cfg);

  for (const [tier, tierCfg] of Object.entries(preset)) {
    const ref = tierCfg?.model;
    if (typeof ref !== "string") continue;
    const parsed = parseModelRef(ref);
    if (!parsed) continue;

    const provider = findProvider(catalog, parsed.providerId);
    if (!provider) {
      badProviders.add(parsed.providerId);
      issues.push({
        tier,
        scope: "tier",
        ref,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        kind: "provider-unknown",
        suggestions: [],
      });
      continue;
    }

    const model = provider.models.find((m) => m.id === parsed.modelId);
    if (!model) {
      issues.push({
        tier,
        ref,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        kind: "model-missing",
        scope: "tier",
        suggestions: suggestModels(parsed.modelId, provider.models).map(
          (id) => `${parsed.providerId}/${id}`,
        ),
      });
      continue;
    }

    if (model.status === "deprecated") {
      const alternatives = provider.models.filter(
        (m) => m.status !== "deprecated",
      );
      issues.push({
        tier,
        ref,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        kind: "model-deprecated",
        scope: "tier",
        suggestions: suggestModels(parsed.modelId, alternatives).map(
          (id) => `${parsed.providerId}/${id}`,
        ),
      });
    }
  }

  return issues;
}
