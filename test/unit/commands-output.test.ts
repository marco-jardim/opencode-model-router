import { describe, it, expect } from "vitest";
import {
  buildTiersOutput,
  buildPresetList,
  buildPresetSwitched,
  buildUnknownPreset,
  buildNoModes,
  buildBudgetList,
  buildBudgetSwitched,
  buildUnknownMode,
  buildBypassMessage,
  buildEnforceSet,
  buildEnforceStatus,
  buildOverridesOutput,
  buildRouterHelp,
  buildModelsOutput,
  formatModelIssues,
  formatOrphanedStrongPatterns,
} from "../../src/commands/output";
import type { RouterConfig, ModeConfig } from "../../src/router/config";
import type { Catalog, ModelIssue } from "../../src/router/catalog";

// A minimal config is enough: these renderers only read what they print.
function cfg(over: Partial<RouterConfig> = {}): RouterConfig {
  return {
    activePreset: "alpha",
    defaultTier: "medium",
    rules: ["r1", "r2"],
    presets: {
      alpha: {
        fast: { model: "p/fast-m", description: "d-fast", steps: 30, whenToUse: ["a", "b"] },
        heavy: { model: "p/heavy-m", description: "d-heavy", steps: 120, whenToUse: ["c"] },
      },
      beta: { fast: { model: "q/other-m" } },
    },
    ...over,
  } as RouterConfig;
}

describe("buildTiersOutput", () => {
  it("lists each tier with model, steps and use cases", () => {
    const out = buildTiersOutput(cfg());
    expect(out).toContain("Active preset: **alpha**");
    expect(out).toContain("## @fast -> `p/fast-m`");
    expect(out).toContain("Steps: 30");
    expect(out).toContain("Use when: a, b");
    expect(out).toContain("Default tier: @medium");
  });

  // A preset defined in an overrides file may carry only `model`.
  it("omits description and use cases when the tier has none", () => {
    const out = buildTiersOutput(
      cfg({ presets: { alpha: { fast: { model: "p/bare" } } } } as never),
    );
    expect(out).toContain("## @fast -> `p/bare`");
    expect(out).toContain("Steps: default");
    expect(out).not.toContain("Use when:");
    expect(out).not.toContain("undefined");
  });

  it("renders thinking and reasoning suffixes", () => {
    const withThinking = buildTiersOutput(
      cfg({
        presets: { alpha: { fast: { model: "m", thinking: { budgetTokens: 99 } } } },
      } as never),
    );
    expect(withThinking).toContain("| thinking: 99 tokens");
    const withReasoning = buildTiersOutput(
      cfg({
        presets: { alpha: { fast: { model: "m", reasoning: { effort: "low" } } } },
      } as never),
    );
    expect(withReasoning).toContain("| reasoning: effort=low");
  });

  // The auto rule silently flips strong models to goal-oriented; /tiers has to
  // say so, otherwise the resolved style is invisible to the user.
  it("shows the auto-resolved style as goal-oriented for a strong model", () => {
    const out = buildTiersOutput(
      cfg({ presets: { alpha: { heavy: { model: "anthropic/claude-opus-4-8" } } } } as never),
    );
    expect(out).toContain("| prompt: goal-oriented (auto)");
  });

  it("shows the auto-resolved style as prescriptive for a weak model", () => {
    const out = buildTiersOutput(
      cfg({ presets: { alpha: { fast: { model: "anthropic/claude-haiku-3" } } } } as never),
    );
    expect(out).toContain("| prompt: prescriptive (auto)");
  });

  it("marks an explicitly configured promptStyle as explicit", () => {
    const out = buildTiersOutput(
      cfg({
        presets: {
          alpha: {
            heavy: { model: "anthropic/claude-opus-4-8", promptStyle: "prescriptive" },
          },
        },
      } as never),
    );
    expect(out).toContain("| prompt: prescriptive (explicit)");
    expect(out).not.toContain("(auto)");
  });

  // An explicit per-tier prompt bypasses style resolution entirely
  // (src/index.ts: `tier.prompt ?? selectTierPrompt(...)`).
  it("reports a per-tier prompt override as custom", () => {
    const out = buildTiersOutput(
      cfg({
        presets: {
          alpha: {
            fast: { model: "p/fast-m", prompt: "bespoke", promptStyle: "goal-oriented" },
          },
        },
      } as never),
    );
    expect(out).toContain("| prompt: custom");
    expect(out).not.toContain("goal-oriented");
  });
});

describe("preset renderers", () => {
  it("marks the active preset in the list and shows bare model names", () => {
    const out = buildPresetList(cfg());
    expect(out).toContain("- **alpha** <- active:");
    expect(out).toContain("fast: fast-m"); // provider prefix stripped
    expect(out).toContain("- **beta**:");
    expect(out).not.toContain("beta** <- active");
  });

  it("lists the switched preset's tiers with full model ids", () => {
    const out = buildPresetSwitched(cfg(), "beta");
    expect(out).toContain("Preset switched to **beta**.");
    expect(out).toContain("@fast -> q/other-m");
  });

  it("names the available presets when the requested one is unknown", () => {
    expect(buildUnknownPreset(cfg(), "zzz")).toBe(
      'Unknown preset: "zzz". Available: alpha, beta',
    );
  });
});

describe("budget renderers", () => {
  const modes: Record<string, ModeConfig> = {
    normal: { defaultTier: "medium", description: "balanced" } as ModeConfig,
    thrifty: {
      defaultTier: "fast",
      description: "cheap",
      overrideRules: ["x"],
    } as ModeConfig,
  };

  it("explains how to enable modes when none are configured", () => {
    expect(buildNoModes()).toContain('Add a "modes" section');
  });

  it("defaults the active marker to normal when no mode is set", () => {
    const out = buildBudgetList(cfg({ modes } as never));
    expect(out).toContain("- **normal** <- active:");
    expect(out).toContain("- **thrifty**:");
  });

  it("follows activeMode when one is set", () => {
    const out = buildBudgetList(cfg({ modes, activeMode: "thrifty" } as never));
    expect(out).toContain("- **thrifty** <- active:");
  });

  it("includes override rules only when the mode declares them", () => {
    expect(buildBudgetSwitched(modes.thrifty!, "thrifty")).toContain("Active rules:");
    expect(buildBudgetSwitched(modes.normal!, "normal")).not.toContain("Active rules:");
  });

  it("names the available modes when the requested one is unknown", () => {
    expect(buildUnknownMode(modes, "zzz")).toBe(
      'Unknown mode: "zzz". Available: normal, thrifty',
    );
  });
});

describe("router and bypass renderers", () => {
  it("renders bypass from the resulting state, not the argument", () => {
    expect(buildBypassMessage(true)).toContain("# Bypass: ON");
    expect(buildBypassMessage(true)).toContain("**bypassed**");
    expect(buildBypassMessage(false)).toContain("# Bypass: OFF");
    expect(buildBypassMessage(false)).toContain("**active**");
  });

  it("describes each enforcement mode distinctly", () => {
    expect(buildEnforceSet("off")).toContain("Hard-block guard disabled");
    expect(buildEnforceSet("advisory")).toContain("never hard-blocks");
    expect(buildEnforceSet("enforced")).toContain("hard-blocks subagent tool calls");
    for (const m of ["off", "advisory", "enforced"] as const) {
      expect(buildEnforceSet(m)).toContain("MODEL_ROUTER_ENFORCE");
    }
  });

  it("shows usage alongside the current mode", () => {
    const out = buildEnforceStatus("advisory");
    expect(out).toContain("**advisory**");
    expect(out).toContain("/router enforce <off|advisory|enforced>");
  });

  it("points at the overrides command from the help output", () => {
    expect(buildRouterHelp("off")).toContain("Enforcement: **off**");
    expect(buildRouterHelp("off")).toContain("/router overrides");
  });
});

describe("buildOverridesOutput", () => {
  const view = {
    globalPath: "/g/overrides.jsonc",
    globalPresent: true,
    localPath: "/p/.opencode/overrides.jsonc",
    localPresent: false,
    localFound: false,
    activePreset: "alpha",
  };

  it("marks each layer present or absent and names the active preset", () => {
    const out = buildOverridesOutput(view);
    expect(out).toContain("`/g/overrides.jsonc` _(present)_");
    expect(out).toContain("`/p/.opencode/overrides.jsonc` _(absent)_");
    expect(out).toContain("Active preset: **alpha**");
  });

  // The create-location hint is only meaningful when no project file was found.
  it("suggests where to create the project file only when none was found", () => {
    expect(buildOverridesOutput(view)).toContain("create at");
    expect(
      buildOverridesOutput({ ...view, localFound: true, localPresent: true }),
    ).not.toContain("create at");
  });
});

describe("buildModelsOutput", () => {
  const catalog: Catalog = {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        defaultModel: "m-a",
        models: [
          { id: "m-b", status: "active" },
          { id: "m-a", status: "active" },
          { id: "m-old", status: "deprecated" },
        ],
      },
      { id: "openai", name: "openai", models: [] },
    ],
  } as Catalog;

  // A failed fetch is a null here, not an exception path.
  it("says so when the catalog could not be fetched", () => {
    expect(buildModelsOutput(null, "")).toContain("Model catalog unavailable");
  });

  it("says so when no providers are configured", () => {
    expect(buildModelsOutput({ providers: [] } as Catalog, "")).toContain(
      "No providers are configured",
    );
  });

  it("lists every provider with fully-qualified ids, sorted", () => {
    const out = buildModelsOutput(catalog, "");
    expect(out.indexOf("`anthropic/m-a`")).toBeLessThan(out.indexOf("`anthropic/m-b`"));
    expect(out).toContain("## anthropic (Anthropic) — default: `anthropic/m-a`");
  });

  it("flags any non-active status", () => {
    expect(buildModelsOutput(catalog, "")).toContain("`anthropic/m-old` _(deprecated)_");
  });

  it("marks a provider that reports no models", () => {
    expect(buildModelsOutput(catalog, "")).toContain("_(no models)_");
  });

  it("omits the parenthetical when name matches id", () => {
    expect(buildModelsOutput(catalog, "")).toContain("## openai\n");
  });

  it("filters to one provider, case-insensitively", () => {
    const out = buildModelsOutput(catalog, "  ANTHROPIC ");
    expect(out).toContain("anthropic/m-a");
    expect(out).not.toContain("## openai");
  });

  it("names what is available when the filter matches nothing", () => {
    const out = buildModelsOutput(catalog, "bedrock");
    expect(out).toContain("No configured provider matches");
    expect(out).toContain("anthropic, openai");
  });
});

describe("buildModelsOutput — orphaned strong patterns", () => {
  const catalog: Catalog = {
    providers: [{ id: "anthropic", models: [{ id: "opus-4.8", status: "active" }] }],
  };

  // `opus-4-8` against a served `opus-4.8` is deliberately NOT the fixture: the
  // matcher normalizes separators, so that pair matches and can never reach
  // this formatter. Only a genuinely absent pattern can.
  it("appends the orphan warning to the model listing", () => {
    const out = buildModelsOutput(catalog, "", ["ghost-model-9"]);
    expect(out).toContain("`anthropic/opus-4.8`");
    expect(out).toContain("matching no model your providers serve");
    expect(out).toContain("- `ghost-model-9`");
    // says whose pattern it is, since defaults are never reported
    expect(out).toContain("modelGenerations.strong");
    // and forecloses the wrong fix: this is not a separator problem
    expect(out).toContain("ignores case and separator style");
    expect(out).not.toContain("now resolves to the **prescriptive** prompt");
  });

  it("warns even when the catalog could not be fetched", () => {
    const out = buildModelsOutput(null, "", ["ghost-model-9"]);
    expect(out).toContain("Model catalog unavailable");
    expect(out).toContain("matching no model your providers serve");
  });

  it("says nothing when there are no orphans", () => {
    expect(buildModelsOutput(catalog, "")).not.toContain("Strong-model patterns");
  });
});

describe("formatModelIssues", () => {
  const issue = (over: Partial<ModelIssue>): ModelIssue =>
    ({
      tier: "fast",
      ref: "p/gone",
      providerId: "p",
      kind: "model-missing",
      suggestions: [],
      ...over,
    }) as ModelIssue;

  it("distinguishes the three failure kinds", () => {
    expect(formatModelIssues([issue({ kind: "provider-unknown" })])).toContain(
      "is not configured/authenticated",
    );
    expect(formatModelIssues([issue({ kind: "model-deprecated" })])).toContain(
      "**deprecated**",
    );
    expect(formatModelIssues([issue({})])).toContain("was not found");
  });

  it("appends suggestions only when there are any", () => {
    expect(
      formatModelIssues([issue({ suggestions: ["p/near", "p/near2"] })]),
    ).toContain("Try: `p/near`, `p/near2`.");
    expect(formatModelIssues([issue({})])).not.toContain("Try:");
  });

  it("names the tier and points at the overrides file", () => {
    const out = formatModelIssues([issue({ tier: "heavy" })]);
    expect(out).toContain("- @heavy:");
    expect(out).toContain("/router overrides");
  });

  it("keys fallback issues by chain provider instead of tier", () => {
    const out = formatModelIssues([
      issue({
        tier: "fallback.global",
        scope: "fallback",
        providerId: "openai",
        ref: "openai",
        kind: "fallback-provider-unknown",
      }),
    ]);
    expect(out).toContain("- fallback.global[openai]:");
    expect(out).toContain("is not configured/authenticated");
    expect(out).toContain("can never fire");
  });

  it("explains a chain entry pointing at a preset that does not exist", () => {
    const out = formatModelIssues([
      issue({
        tier: "fallback.presets.p",
        scope: "fallback",
        providerId: "anthropic",
        ref: "anthropic → ghost",
        kind: "fallback-preset-unknown",
        chainTarget: "ghost",
        suggestions: ["p"],
      }),
    ]);
    expect(out).toContain("- fallback.presets.p[anthropic]:");
    expect(out).toContain("`ghost` is not a defined preset");
    expect(out).toContain("silently dropped");
    expect(out).toContain("Try: `p`.");
  });
});

// This block used to assert a "served under a different separator" hint built
// from near misses. That hint is gone: `isStrongModel` now normalizes
// separators, so a pattern that would have been a near miss simply matches, and
// an orphan reaching this formatter matches nothing under any spelling. There
// is no longer a suggestion to make, only the dead pattern to name.
describe("formatOrphanedStrongPatterns", () => {
  it("names each orphaned pattern", () => {
    const out = formatOrphanedStrongPatterns(["opus-9", "ghost-model"]);
    expect(out).toContain("- `opus-9`");
    expect(out).toContain("- `ghost-model`");
  });

  it("offers no separator suggestion, because a near miss is now a match", () => {
    const out = formatOrphanedStrongPatterns(["opus-4-8"]);
    expect(out).not.toContain("different separator");
  });
});
