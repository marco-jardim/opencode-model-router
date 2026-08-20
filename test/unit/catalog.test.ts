import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findOrphanedStrongPatterns,
  findStrongPatternNearMisses,
  normalizeCatalog,
  isCatalogEmpty,
  parseModelRef,
  editDistance,
  suggestModels,
  validateModels,
  type Catalog,
  type CatalogModel,
} from "../../src/router/catalog";
import { isStrongModel } from "../../src/router/prompts";
import { validateConfig } from "../../src/router/config";
import type { PromptStyle, RouterConfig } from "../../src/router/config";

function cfgWith(models: Record<string, string>): RouterConfig {
  const fast = { model: models.fast, description: "", whenToUse: [] };
  const preset: Record<string, unknown> = {};
  for (const [tier, model] of Object.entries(models)) {
    preset[tier] = { model, description: "", whenToUse: [] };
  }
  void fast;
  return {
    activePreset: "p",
    presets: { p: preset },
    rules: [],
    defaultTier: "fast",
  } as unknown as RouterConfig;
}

const catalog: Catalog = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      defaultModel: "claude-sonnet-4-6",
      models: [
        { id: "claude-haiku-4-5", status: "active" },
        { id: "claude-sonnet-4-6", status: "active" },
        { id: "claude-opus-4-8", status: "active" },
        { id: "claude-opus-4-6", status: "deprecated" },
      ],
    },
  ],
};

describe("normalizeCatalog", () => {
  it("maps providers, models, and per-provider default", () => {
    const raw = {
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-haiku-4-5": { id: "claude-haiku-4-5", status: "active" },
            "claude-opus-4-6": { id: "claude-opus-4-6", status: "deprecated" },
          },
        },
      ],
      default: { anthropic: "claude-haiku-4-5" },
    };
    const cat = normalizeCatalog(raw);
    expect(cat.providers).toHaveLength(1);
    const p = cat.providers[0]!;
    expect(p.id).toBe("anthropic");
    expect(p.defaultModel).toBe("claude-haiku-4-5");
    expect(p.models.map((m) => m.id).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
    ]);
    expect(p.models.find((m) => m.id === "claude-opus-4-6")?.status).toBe(
      "deprecated",
    );
  });

  it("is defensive against missing/garbage payloads", () => {
    expect(normalizeCatalog(undefined).providers).toEqual([]);
    expect(normalizeCatalog(null).providers).toEqual([]);
    expect(normalizeCatalog({}).providers).toEqual([]);
    // provider without an id is skipped; model key used when id absent
    const cat = normalizeCatalog({
      providers: [{ name: "no id" }, { id: "x", models: { foo: {} } }],
    });
    expect(cat.providers).toHaveLength(1);
    expect(cat.providers[0]!.models[0]!.id).toBe("foo");
  });

  it("isCatalogEmpty reflects provider count", () => {
    expect(isCatalogEmpty({ providers: [] })).toBe(true);
    expect(isCatalogEmpty(catalog)).toBe(false);
  });
});

describe("parseModelRef", () => {
  it("splits on the first slash only", () => {
    expect(parseModelRef("anthropic/claude-opus-4.8")).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4.8",
    });
    expect(parseModelRef("openrouter/deepseek/deepseek-v3.2")).toEqual({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v3.2",
    });
  });

  it("rejects malformed refs", () => {
    expect(parseModelRef("noslash")).toBeUndefined();
    expect(parseModelRef("/leading")).toBeUndefined();
    expect(parseModelRef("trailing/")).toBeUndefined();
  });
});

describe("editDistance", () => {
  it("computes basic distances", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("claude-opus-4-6", "claude-opus-4-8")).toBe(1);
  });
});

describe("suggestModels", () => {
  it("ranks by closeness and de-prioritizes deprecated", () => {
    // limit 4 so all models appear and the deprecated ordering is observable
    const out = suggestModels("claude-opus-4-6", catalog.providers[0]!.models, 4);
    // closest non-deprecated first (opus-4-8 differs by one char); the exact
    // deprecated match is pushed to last despite distance 0
    expect(out[0]).toBe("claude-opus-4-8");
    expect(out[out.length - 1]).toBe("claude-opus-4-6");
  });

  it("respects the limit and excludes deprecated when active models fill it", () => {
    const out = suggestModels("claude-opus-4-6", catalog.providers[0]!.models, 3);
    expect(out).toHaveLength(3);
    expect(out).not.toContain("claude-opus-4-6");
  });
});

describe("validateModels", () => {
  it("returns no issues when every model is active", () => {
    const cfg = cfgWith({
      fast: "anthropic/claude-haiku-4-5",
      heavy: "anthropic/claude-opus-4-8",
    });
    expect(validateModels(cfg, catalog)).toEqual([]);
  });

  it("flags a missing model with closest suggestions", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-9-9" });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("model-missing");
    expect(issues[0]!.tier).toBe("heavy");
    expect(issues[0]!.suggestions[0]).toBe("anthropic/claude-opus-4-8");
  });

  it("flags a deprecated model and suggests active alternatives", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-4-6" });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("model-deprecated");
    expect(issues[0]!.suggestions).not.toContain("anthropic/claude-opus-4-6");
    expect(issues[0]!.suggestions[0]).toBe("anthropic/claude-opus-4-8");
  });

  it("flags an unconfigured provider", () => {
    const cfg = cfgWith({ fast: "openai/gpt-5" });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("provider-unknown");
    expect(issues[0]!.suggestions).toEqual([]);
  });

  it("never cries wolf when the catalog is empty (fetch failed)", () => {
    const cfg = cfgWith({ heavy: "anthropic/does-not-exist" });
    expect(validateModels(cfg, { providers: [] })).toEqual([]);
  });
});

describe("validateModels — fallback chains", () => {
  // A fallback chain is `providerId -> [presetName, ...]` (FallbackConfig), so
  // what can rot is a provider the catalog does not know and a chain entry that
  // names no real preset.
  function cfgFb(
    fallback: unknown,
    over: { tiers?: Record<string, string>; presets?: string[] } = {},
  ): RouterConfig {
    const preset: Record<string, unknown> = {};
    for (const [tier, model] of Object.entries(
      over.tiers ?? { heavy: "anthropic/claude-opus-4-8" },
    )) {
      preset[tier] = { model };
    }
    const presets: Record<string, unknown> = { p: preset };
    for (const extra of over.presets ?? []) presets[extra] = preset;
    return {
      activePreset: "p",
      presets,
      rules: [],
      defaultTier: "heavy",
      fallback,
    } as unknown as RouterConfig;
  }

  // Reported by a real user: the shipped tiers.json chains every provider to
  // every other one, so an anthropic-only install warned about the dormant
  // github-copilot chain on a preset that never names github-copilot. A chain
  // keyed by a provider the active preset does not use is dormant by design.
  it("says nothing about a chain keyed by a provider the active preset never uses", () => {
    const cfg = cfgFb(
      { global: { "github-copilot": ["p"], openai: ["p"] } },
      { tiers: { fast: "anthropic/claude-haiku-4-5", heavy: "anthropic/claude-opus-4-8" } },
    );
    expect(validateModels(cfg, catalog)).toEqual([]);
  });

  it("reports an unknown provider the active preset actually uses, exactly once", () => {
    // the tier check gets there first and records the provider, so the chain
    // keyed by the same provider dedupes away instead of repeating it
    const cfg = cfgFb(
      { global: { "github-copilot": ["p"] } },
      { tiers: { heavy: "github-copilot/gpt-5" } },
    );
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.scope).toBe("tier");
    expect(issues[0]!.kind).toBe("provider-unknown");
    expect(issues[0]!.providerId).toBe("github-copilot");
  });

  it("flags a chain entry that names no defined preset, with suggestions", () => {
    const cfg = cfgFb({ global: { anthropic: ["cheap", "pro"] } }, { presets: ["pro"] });
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("fallback-preset-unknown");
    expect(issues[0]!.chainTarget).toBe("cheap");
    expect(issues[0]!.ref).toBe("anthropic → cheap");
    expect(issues[0]!.suggestions).toContain("p");
  });

  it("does not report the same unknown provider twice (tier then fallback)", () => {
    const cfg = cfgFb(
      { global: { openai: ["p"] } },
      { tiers: { fast: "openai/gpt-5" } },
    );
    const issues = validateModels(cfg, catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.scope).toBe("tier");
    expect(issues[0]!.kind).toBe("provider-unknown");
  });

  it("prefers the active preset's fallback map over the global one", () => {
    const cfg = cfgFb({
      global: { anthropic: ["ghost-global"] },
      presets: { p: { anthropic: ["ghost-preset"] } },
    });
    const issues = validateModels(cfg, catalog);
    expect(issues.map((i) => i.chainTarget)).toEqual(["ghost-preset"]);
    expect(issues[0]!.tier).toBe("fallback.presets.p");
  });

  it("ignores self-references, real presets, and malformed chain values", () => {
    const cfg = cfgFb({
      global: {
        anthropic: ["p", "pro", 7, "", null],
        "": ["ghost"],
      },
    }, { presets: ["pro"] });
    expect(validateModels(cfg, catalog)).toEqual([]);
  });

  it("survives a non-array chain and a non-object fallback", () => {
    expect(validateModels(cfgFb({ global: { anthropic: "pro" } }), catalog)).toEqual([]);
    expect(validateModels(cfgFb(undefined), catalog)).toEqual([]);
    expect(validateModels(cfgFb({}), catalog)).toEqual([]);
  });

  it("skips a non-array chain entirely, like ./protocol does", () => {
    // ./protocol drops the whole entry, so there is no chain left to warn
    // about — not even for the unknown provider keying it
    expect(validateModels(cfgFb({ global: { openai: "p" } }), catalog)).toEqual([]);
  });

  it("with an empty catalog: tier checks are skipped, config-only checks still run", () => {
    const cfg = cfgFb(
      { global: { openai: ["ghost"] } },
      { tiers: { heavy: "anthropic/does-not-exist" } },
    );
    const issues = validateModels(cfg, { providers: [] });
    // no tier issue (we could not see the catalog) and no unknown-provider
    // issue either — but the preset name is a config fact, catalog or not
    expect(issues.map((i) => i.kind)).toEqual(["fallback-preset-unknown"]);
    expect(issues[0]!.chainTarget).toBe("ghost");
  });

  it("stays silent for a config without any fallback (no regression)", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-4-8" });
    expect(validateModels(cfg, catalog)).toEqual([]);
    expect(validateModels(cfg, { providers: [] })).toEqual([]);
  });

  it("tags tier issues with scope 'tier'", () => {
    const cfg = cfgWith({ heavy: "anthropic/claude-opus-9-9" });
    expect(validateModels(cfg, catalog)[0]!.scope).toBe("tier");
  });
});

describe("findOrphanedStrongPatterns", () => {
  function strongCfg(
    models: Record<string, string>,
    over: {
      strong?: string[];
      promptStyle?: Record<string, PromptStyle>;
    } = {},
  ): RouterConfig {
    const preset: Record<string, unknown> = {};
    for (const [tier, model] of Object.entries(models)) {
      preset[tier] = { model, promptStyle: over.promptStyle?.[tier] };
    }
    return {
      activePreset: "p",
      presets: { p: preset },
      rules: [],
      defaultTier: "fast",
      ...(over.strong ? { modelGenerations: { strong: over.strong } } : {}),
    } as unknown as RouterConfig;
  }

  /** A catalog serving exactly these `provider/model` refs. */
  function catalogOf(...refs: string[]): Catalog {
    const byProvider = new Map<string, CatalogModel[]>();
    for (const ref of refs) {
      const parsed = parseModelRef(ref)!;
      const list = byProvider.get(parsed.providerId) ?? [];
      list.push({ id: parsed.modelId, status: "active" });
      byProvider.set(parsed.providerId, list);
    }
    return {
      providers: [...byProvider].map(([id, models]) => ({ id, models })),
    };
  }

  // The default pattern list is a cross-preset union, so comparing it against a
  // single preset's models would warn on every clean install. These two pin the
  // shipped config against a healthy catalog: silence is the contract.
  const shippedCfg = validateConfig(
    JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")),
  );

  // Reported by a real user on the fable-effort preset with only anthropic
  // configured: `claude-mythos-5` is simply a model that provider does not
  // serve. No tier names it, nothing is served under a drifted separator, and
  // no edit to the config would change anything — a default pattern with no
  // near-miss is not actionable, so it must stay silent.
  it("says nothing about a default pattern the providers merely do not serve", () => {
    const anthropicOnly = catalogOf(
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
    );
    expect(findStrongPatternNearMisses("claude-mythos-5", anthropicOnly)).toEqual([]);
    expect(findOrphanedStrongPatterns(shippedCfg, anthropicOnly)).toEqual([]);
  });

  it("still reports a user-authored pattern with no near-miss at all", () => {
    // an explicit list is a claim the user made about their own environment,
    // so a dead entry in it is actionable whether or not we can suggest a fix
    const cfg = strongCfg(
      { heavy: "anthropic/claude-opus-4-8" },
      { strong: ["ghost-model-9"] },
    );
    const cat = catalogOf("anthropic/claude-opus-4-8");
    expect(findStrongPatternNearMisses("ghost-model-9", cat)).toEqual([]);
    expect(findOrphanedStrongPatterns(cfg, cat)).toEqual(["ghost-model-9"]);
  });

  it("says nothing for the shipped config against a healthy catalog", () => {
    const healthy = catalogOf(
      "anthropic/claude-opus-4-8",
      "anthropic/claude-fable-5",
      "anthropic/claude-mythos-5",
      "anthropic/claude-haiku-4-5",
    );
    expect(findOrphanedStrongPatterns(shippedCfg, healthy)).toEqual([]);
  });

  it("flags the provider-rename case the check exists for", () => {
    // the rename `claude-opus-4-8` -> `opus-4.8` (dot) stops matching, while
    // the other two default patterns are still served
    const renamed = catalogOf(
      "anthropic/opus-4.8",
      "anthropic/claude-fable-5",
      "anthropic/claude-mythos-5",
    );
    // A tier has to be ON the pre-rename spelling for the warning to mean
    // anything: the pattern is only worth reporting when correcting it would
    // change how THIS config resolves. The shipped anthropic preset moved off
    // `claude-opus-4-8` in 1.8.0, so it no longer exercises this case.
    const pinnedToOldSpelling = {
      ...shippedCfg,
      presets: {
        ...shippedCfg.presets,
        anthropic: {
          ...shippedCfg.presets.anthropic,
          heavy: { model: "anthropic/claude-opus-4-8" },
        },
      },
    } as typeof shippedCfg;
    expect(findOrphanedStrongPatterns(pinnedToOldSpelling, renamed)).toEqual([
      "opus-4-8",
    ]);
    // and the downgrade it warns about is real
    expect(isStrongModel("anthropic/opus-4.8", shippedCfg)).toBe(false);
  });

  // Same catalog, same dead pattern, but no tier is on the pre-rename model.
  // Correcting `opus-4-8` would change nothing here, so it stays silent.
  it("stays silent when no tier is on the renamed model", () => {
    const renamed = catalogOf(
      "anthropic/opus-4.8",
      "anthropic/claude-fable-5",
      "anthropic/claude-mythos-5",
    );
    expect(findOrphanedStrongPatterns(shippedCfg, renamed)).toEqual([]);
  });

  it("never cries wolf when the catalog is empty or model-less", () => {
    const cfg = strongCfg({ fast: "openai/gpt-5" }, { strong: ["opus-4-8"] });
    expect(findOrphanedStrongPatterns(cfg, { providers: [] })).toEqual([]);
    expect(
      findOrphanedStrongPatterns(cfg, { providers: [{ id: "openai", models: [] }] }),
    ).toEqual([]);
  });

  it("matches the full provider/model ref, case-insensitively, like isStrongModel", () => {
    const cfg = strongCfg(
      { heavy: "anthropic/CLAUDE-Opus-4-8" },
      { strong: ["OPUS-4-8", "anthropic/claude-opus"] },
    );
    const cat = catalogOf("anthropic/CLAUDE-Opus-4-8");
    expect(findOrphanedStrongPatterns(cfg, cat)).toEqual([]);
    expect(isStrongModel("anthropic/CLAUDE-Opus-4-8", cfg)).toBe(true);
  });

  it("judges the catalog, not the active preset", () => {
    // the pattern matches a model no tier of the active preset uses — still
    // reachable in this environment, so not an orphan
    const cfg = strongCfg({ fast: "openai/gpt-5" }, { strong: ["opus-4-8"] });
    expect(
      findOrphanedStrongPatterns(cfg, catalogOf("anthropic/claude-opus-4-8")),
    ).toEqual([]);
    expect(findOrphanedStrongPatterns(cfg, catalogOf("openai/gpt-5"))).toEqual([
      "opus-4-8",
    ]);
  });

  it("stays silent when no tier resolves its prompt style by auto", () => {
    const cat = catalogOf("openai/gpt-5");
    const cfg = strongCfg(
      { fast: "openai/gpt-5", heavy: "openai/gpt-5-pro" },
      {
        strong: ["opus-4-8"],
        promptStyle: { fast: "prescriptive", heavy: "goal-oriented" },
      },
    );
    expect(findOrphanedStrongPatterns(cfg, cat)).toEqual([]);
    // one tier back on auto is enough to make the orphan matter again
    const auto = strongCfg(
      { fast: "openai/gpt-5", heavy: "openai/gpt-5-pro" },
      { strong: ["opus-4-8"], promptStyle: { fast: "prescriptive" } },
    );
    expect(findOrphanedStrongPatterns(auto, cat)).toEqual(["opus-4-8"]);
  });

  it("ignores garbage entries and de-duplicates", () => {
    const cfg = strongCfg(
      { fast: "openai/gpt-5" },
      { strong: ["opus-4-8", "opus-4-8", "", null as unknown as string] },
    );
    expect(findOrphanedStrongPatterns(cfg, catalogOf("openai/gpt-5"))).toEqual([
      "opus-4-8",
    ]);
  });
});

describe("findStrongPatternNearMisses", () => {
  const cat = (...refs: string[]): Catalog =>
    ({
      providers: [
        {
          id: "anthropic",
          name: "anthropic",
          models: refs.map((r) => ({ id: r, status: "active" as const })),
        },
      ],
    }) as Catalog;

  // The reason this exists: a provider moving hyphen to dot un-matches a
  // pattern that is still naming the right model.
  it("finds a served model that differs only by separator", () => {
    expect(
      findStrongPatternNearMisses("opus-4-8", cat("claude-opus-4.8")),
    ).toEqual(["anthropic/claude-opus-4.8"]);
  });

  it("works in the other direction too", () => {
    expect(
      findStrongPatternNearMisses("opus-4.8", cat("claude-opus-4-8")),
    ).toEqual(["anthropic/claude-opus-4-8"]);
  });

  it("treats underscores as a separator as well", () => {
    expect(
      findStrongPatternNearMisses("opus-4-8", cat("claude_opus_4_8")),
    ).toEqual(["anthropic/claude_opus_4_8"]);
  });

  it("returns empty when the pattern is simply wrong", () => {
    expect(findStrongPatternNearMisses("opus-9", cat("claude-opus-4.8"))).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(
      findStrongPatternNearMisses("OPUS-4-8", cat("claude-Opus-4.8")),
    ).toEqual(["anthropic/claude-Opus-4.8"]);
  });

  it("returns every match, not just the first", () => {
    expect(
      findStrongPatternNearMisses("opus-4-8", cat("claude-opus-4.8", "claude-opus-4_8")),
    ).toHaveLength(2);
  });

  it("returns empty for an all-separator pattern rather than matching everything", () => {
    expect(findStrongPatternNearMisses("---", cat("claude-opus-4.8"))).toEqual([]);
  });
});

// Reported from a live 1.7.0 install and still reproducing on 1.8.0: a
// github-copilot user on a custom hybrid preset saw the default `opus-4-8`
// reported because copilot serves claude-opus-4.8, a model none of their
// tiers used.
describe("findOrphanedStrongPatterns — relevance to the active preset", () => {
  const mkCatalog = (...refs: string[]): Catalog => {
    const byProvider = new Map<string, string[]>();
    for (const r of refs) {
      const i = r.indexOf("/");
      const p = r.slice(0, i);
      byProvider.set(p, [...(byProvider.get(p) ?? []), r.slice(i + 1)]);
    }
    return {
      providers: [...byProvider].map(([id, models]) => ({
        id,
        name: id,
        models: models.map((m) => ({ id: m, status: "active" as const })),
      })),
    } as Catalog;
  };

  // exactly what `/router models github-copilot` returned on the reporting host
  const copilot = mkCatalog(
    "github-copilot/claude-opus-4.8",
    "github-copilot/claude-opus-4.8-fast",
    "github-copilot/claude-opus-5",
    "github-copilot/claude-sonnet-4.6",
    "github-copilot/claude-sonnet-5",
    "github-copilot/gpt-5.6-luna",
  );
  const hybrid = {
    activePreset: "hybrid",
    defaultTier: "medium",
    rules: [],
    presets: {
      hybrid: {
        fast: { model: "github-copilot/gpt-5.6-luna" },
        medium: { model: "github-copilot/claude-sonnet-5" },
        heavy: { model: "github-copilot/claude-opus-5" },
      },
    },
  } as unknown as RouterConfig;

  it("stays silent when the pattern is about a model no tier uses", () => {
    expect(findOrphanedStrongPatterns(hybrid, copilot)).toEqual([]);
  });

  it("reports once a tier is pinned to the pre-rename spelling", () => {
    const pinned = {
      ...hybrid,
      presets: {
        hybrid: {
          ...hybrid.presets.hybrid,
          heavy: { model: "github-copilot/claude-opus-4-8" },
        },
      },
    } as unknown as RouterConfig;
    expect(findOrphanedStrongPatterns(pinned, copilot)).toEqual(["opus-4-8"]);
  });

  // The case the whole check exists for, and the one that actually happens: the
  // provider renamed the model, the tier follows the NEW spelling the catalog
  // serves, and only the pattern is left behind. Nothing is missing — the tier
  // resolves fine — so `model-missing` stays silent and this warning is the only
  // signal that the prompt style silently downgraded.
  it("reports when a tier is on the served, post-rename spelling", () => {
    const onNewSpelling = {
      ...hybrid,
      presets: {
        hybrid: {
          ...hybrid.presets.hybrid,
          heavy: { model: "github-copilot/claude-opus-4.8" },
        },
      },
    } as unknown as RouterConfig;
    expect(findOrphanedStrongPatterns(onNewSpelling, copilot)).toEqual([
      "opus-4-8",
    ]);
    // and the downgrade it warns about is real: on `auto` this tier drops from
    // goal-oriented to prescriptive without anything else saying so
    expect(isStrongModel("github-copilot/claude-opus-4.8", onNewSpelling)).toBe(
      false,
    );
  });

  // A user-authored list is a claim about this environment, so relevance is
  // not required: they wrote it, a dead entry is theirs to fix.
  it("reports a user-authored dead pattern regardless of relevance", () => {
    const authored = {
      ...hybrid,
      modelGenerations: { strong: ["totally-absent-model"] },
    } as unknown as RouterConfig;
    expect(findOrphanedStrongPatterns(authored, copilot)).toEqual([
      "totally-absent-model",
    ]);
  });
});
