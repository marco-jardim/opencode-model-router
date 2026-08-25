import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { validateConfig } from "../../src/router/config";
import type { PromptStyle, TierConfig } from "../../src/router/config";
import {
  GOAL_ORIENTED_TIER_PROMPTS,
  isStrongModel,
  resolvePromptStyle,
  selectTierPrompt,
} from "../../src/router/prompts";

function cfg(extras: Record<string, unknown> = {}) {
  return validateConfig({
    activePreset: "test",
    defaultTier: "fast",
    rules: [],
    presets: {
      test: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "Test tier",
          whenToUse: ["tests"],
          ...extras,
        },
      },
    },
  });
}

describe("prompt style resolution", () => {
  test.each([
    ["prescriptive", "anthropic/claude-fable-5", "prescriptive"],
    ["prescriptive", "anthropic/claude-haiku-4-5", "prescriptive"],
    ["prescriptive", "weird/unknown-model-x", "prescriptive"],
    ["goal-oriented", "anthropic/claude-fable-5", "goal-oriented"],
    ["goal-oriented", "anthropic/claude-haiku-4-5", "goal-oriented"],
    ["goal-oriented", "weird/unknown-model-x", "goal-oriented"],
    ["auto", "anthropic/claude-fable-5", "goal-oriented"],
    ["auto", "anthropic/claude-haiku-4-5", "prescriptive"],
    ["auto", "weird/unknown-model-x", "prescriptive"],
  ] as const)("resolves %s for %s to %s", (style, model, expected) => {
    expect(resolvePromptStyle(style, model, cfg())).toBe(expected);
  });

  test("treats opus-4-8 as strong by default", () => {
    expect(resolvePromptStyle("auto", "anthropic/claude-opus-4-8", cfg())).toBe("goal-oriented");
  });

  test("does not treat opus-4.6 as strong (dotted generation is a different model)", () => {
    expect(isStrongModel("github-copilot/claude-opus-4.6", cfg())).toBe(false);
    expect(resolvePromptStyle("auto", "github-copilot/claude-opus-4.6", cfg())).toBe("prescriptive");
  });

  test("matches strong-model patterns case-insensitively", () => {
    expect(isStrongModel("Anthropic/Claude-Fable-5", cfg())).toBe(true);
    expect(isStrongModel("ANTHROPIC/CLAUDE-OPUS-4-8", cfg())).toBe(true);
  });

  test("custom strong model generations replace defaults", () => {
    const customCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      modelGenerations: { strong: ["my-model"] },
      presets: {
        test: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "Test tier",
            whenToUse: ["tests"],
          },
        },
      },
    });

    expect(isStrongModel("vendor/my-model-pro", customCfg)).toBe(true);
    expect(resolvePromptStyle("auto", "vendor/my-model-pro", customCfg)).toBe("goal-oriented");
    expect(isStrongModel("anthropic/claude-fable-5", customCfg)).toBe(false);
  });

  test("a model matching several patterns resolves the same way every time", () => {
    const multiCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      modelGenerations: { strong: ["claude", "fable", "claude-fable-5"] },
      presets: {
        test: {
          fast: {
            model: "anthropic/claude-fable-5",
            description: "Test tier",
            whenToUse: ["tests"],
          },
        },
      },
    });

    // Matching is a boolean any(), so overlapping patterns cannot disagree.
    for (let i = 0; i < 3; i++) {
      expect(isStrongModel("anthropic/claude-fable-5", multiCfg)).toBe(true);
      expect(resolvePromptStyle("auto", "anthropic/claude-fable-5", multiCfg)).toBe("goal-oriented");
    }
  });

  test("non-string entries in the pattern list are ignored, not crashed on", () => {
    const dirtyCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      modelGenerations: { strong: [42, null, "", "fable-5"] },
      presets: {
        test: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "Test tier",
            whenToUse: ["tests"],
          },
        },
      },
    });

    expect(isStrongModel("anthropic/claude-fable-5", dirtyCfg)).toBe(true);
    expect(isStrongModel("anthropic/claude-haiku-4-5", dirtyCfg)).toBe(false);
  });

  test("empty list disables strong model generation matching", () => {
    const testCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      modelGenerations: { strong: [] },
      presets: {
        test: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "Test tier",
            whenToUse: ["tests"],
          },
        },
      },
    });

    expect(resolvePromptStyle("auto", "anthropic/claude-fable-5", testCfg)).toBe("prescriptive");
    expect(resolvePromptStyle("auto", "anthropic/claude-opus-4-8", testCfg)).toBe("prescriptive");
  });

  test("fails safe to prescriptive for missing or unknown models", () => {
    const testCfg = cfg();
    expect(resolvePromptStyle("auto", undefined, testCfg)).toBe("prescriptive");
    expect(resolvePromptStyle("auto", "", testCfg)).toBe("prescriptive");
    expect(resolvePromptStyle(undefined, "weird/unknown-model-x", testCfg)).toBe("prescriptive");
  });

  test("an unknown style reaching the runtime degrades to the auto rule, never to nothing", () => {
    // validateConfig rejects unknown styles at load, so this can only happen via
    // a programmatic caller. The cast reproduces that path deliberately.
    const bogus = "ultra" as PromptStyle;
    const testCfg = cfg();

    expect(resolvePromptStyle(bogus, "anthropic/claude-haiku-4-5", testCfg)).toBe("prescriptive");
    expect(resolvePromptStyle(bogus, "anthropic/claude-fable-5", testCfg)).toBe("goal-oriented");

    const tier: TierConfig = {
      model: "anthropic/claude-haiku-4-5",
      promptStyle: bogus,
    };
    const withPrompts = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      tierPrompts: { fast: "prescriptive fast" },
      presets: {
        test: { fast: { model: "anthropic/claude-haiku-4-5" } },
      },
    });

    // Emits the prescriptive prompt rather than an empty/undefined prompt.
    expect(selectTierPrompt("fast", tier, withPrompts)).toBe("prescriptive fast");
  });
});

describe("goal-oriented prompt contracts", () => {
  test.each([
    ["fast", "`NEED MORE:`", "budget of 8"],
    ["medium", "`NEED CONTEXT:`", "budget of 5"],
    ["heavy", "`SCOPE GROWTH:`", "budget of 3"],
  ] as const)("%s prompt preserves contract tokens", (tier, needToken, budgetText) => {
    const prompt = GOAL_ORIENTED_TIER_PROMPTS[tier];

    expect(prompt).toContain("`DONE:`");
    expect(prompt).toContain(needToken);
    expect(prompt).toContain("`ESCALATE:`");
    expect(prompt).toContain("CAP:N");
    expect(prompt).toContain("CAP:none");
    expect(prompt).toContain("[cap: N/MAX]");
    expect(prompt).toContain("[⚠ REDUNDANT]");
    expect(prompt).toContain(budgetText);
  });

  test("tier-specific safety and role constraints are present", () => {
    expect(GOAL_ORIENTED_TIER_PROMPTS.fast).toContain("never write or edit");
    expect(GOAL_ORIENTED_TIER_PROMPTS.medium).toContain("as any");
    expect(GOAL_ORIENTED_TIER_PROMPTS.medium).toContain("@ts-ignore");
    expect(GOAL_ORIENTED_TIER_PROMPTS.heavy).toContain("prefer @fast pre-exploration of");
  });

  test("goal-oriented prompts avoid prescriptive enumerations", () => {
    const tiers = JSON.parse(readFileSync("tiers.json", "utf8"));

    for (const tier of ["fast", "medium", "heavy"] as const) {
      const prompt = GOAL_ORIENTED_TIER_PROMPTS[tier];
      const prescriptive = tiers.tierPrompts[tier];

      expect(prompt).not.toContain("STOP CONDITIONS");
      expect(prompt).not.toMatch(/^\s*\d+\.\s/m);
      expect(prompt.length).toBeLessThan(0.7 * prescriptive.length);
    }
  });

  // Pins the measured size of the style switch. Update deliberately: a moving
  // delta means one of the two prompt sets changed.
  test.each([
    ["fast", 2072, 1165],
    ["medium", 2337, 1530],
    ["heavy", 2459, 1595],
  ] as const)(
    "%s prescriptive/goal-oriented character counts are pinned",
    (tier, prescriptiveLength, goalOrientedLength) => {
      const tiers = JSON.parse(readFileSync("tiers.json", "utf8"));

      expect(tiers.tierPrompts[tier].length).toBe(prescriptiveLength);
      expect(GOAL_ORIENTED_TIER_PROMPTS[tier].length).toBe(goalOrientedLength);
    },
  );
});

describe("selectTierPrompt", () => {
  test("goal-oriented overrides beat built-ins and prescriptive uses tierPrompts", () => {
    const testCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      tierPrompts: { fast: "prescriptive fast" },
      tierPromptsGoalOriented: { fast: "goal fast" },
      presets: {
        test: {
          fast: {
            model: "anthropic/claude-fable-5",
            description: "Test tier",
            whenToUse: ["tests"],
          },
        },
      },
    });

    expect(selectTierPrompt("fast", { ...testCfg.presets.test.fast, promptStyle: "goal-oriented" }, testCfg)).toBe("goal fast");
    expect(selectTierPrompt("fast", { ...testCfg.presets.test.fast, promptStyle: "prescriptive" }, testCfg)).toBe("prescriptive fast");
  });

  test("an explicit style overrides auto regardless of the model", () => {
    const testCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      tierPrompts: { fast: "prescriptive fast" },
      tierPromptsGoalOriented: { fast: "goal fast" },
      presets: {
        test: { fast: { model: "anthropic/claude-haiku-4-5" } },
      },
    });

    const weak: TierConfig = { model: "anthropic/claude-haiku-4-5" };
    const strong: TierConfig = { model: "anthropic/claude-fable-5" };

    // auto (unset) follows the model...
    expect(selectTierPrompt("fast", weak, testCfg)).toBe("prescriptive fast");
    expect(selectTierPrompt("fast", strong, testCfg)).toBe("goal fast");

    // ...and an explicit style ignores it in both directions.
    expect(selectTierPrompt("fast", { ...weak, promptStyle: "goal-oriented" }, testCfg)).toBe("goal fast");
    expect(selectTierPrompt("fast", { ...strong, promptStyle: "prescriptive" }, testCfg)).toBe("prescriptive fast");
  });

  test("goal-oriented falls back to the built-in when no override is configured", () => {
    const testCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      presets: {
        test: { fast: { model: "anthropic/claude-fable-5" } },
      },
    });

    expect(selectTierPrompt("fast", testCfg.presets.test.fast, testCfg)).toBe(
      GOAL_ORIENTED_TIER_PROMPTS.fast,
    );
  });

  test("unknown goal-oriented tier falls back to tierPrompts or undefined", () => {
    const testCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      tierPrompts: { custom: "custom prescriptive" },
      presets: {
        test: {
          fast: {
            model: "anthropic/claude-fable-5",
            description: "Test tier",
            whenToUse: ["tests"],
          },
        },
      },
    });

    expect(selectTierPrompt("custom", { ...testCfg.presets.test.fast, promptStyle: "goal-oriented" }, testCfg)).toBe("custom prescriptive");
    expect(selectTierPrompt("missing", { ...testCfg.presets.test.fast, promptStyle: "goal-oriented" }, testCfg)).toBeUndefined();
  });

  test("a tier with no prompt in either style degrades to undefined without throwing", () => {
    const emptyCfg = validateConfig({
      activePreset: "test",
      defaultTier: "fast",
      rules: [],
      presets: {
        test: { custom: { model: "vendor/weak-model" } },
      },
    });

    for (const style of ["auto", "prescriptive", "goal-oriented"] as const) {
      expect(() =>
        selectTierPrompt("custom", { model: "vendor/weak-model", promptStyle: style }, emptyCfg),
      ).not.toThrow();
      expect(
        selectTierPrompt("custom", { model: "vendor/weak-model", promptStyle: style }, emptyCfg),
      ).toBeUndefined();
    }
  });
});

describe("validateConfig prompt style schema", () => {
  test("rejects unknown promptStyle", () => {
    expect(() => cfg({ promptStyle: "ultra" })).toThrow(
      "tiers.json: preset 'test' tier 'fast': promptStyle must be one of prescriptive|goal-oriented|auto",
    );
  });

  test.each(["prescriptive", "goal-oriented", "auto"] as const)(
    "accepts %s promptStyle",
    (style) => {
      expect(cfg({ promptStyle: style }).presets.test.fast.promptStyle).toBe(style);
    },
  );

  test("rejects invalid modelGenerations shapes", () => {
    expect(() =>
      validateConfig({
        activePreset: "test",
        defaultTier: "fast",
        rules: [],
        modelGenerations: [],
        presets: { test: { fast: { model: "p/m", description: "d", whenToUse: ["w"] } } },
      }),
    ).toThrow("tiers.json: modelGenerations must be an object");

    expect(() =>
      validateConfig({
        activePreset: "test",
        defaultTier: "fast",
        rules: [],
        modelGenerations: { strong: "my-model" },
        presets: { test: { fast: { model: "p/m", description: "d", whenToUse: ["w"] } } },
      }),
    ).toThrow("tiers.json: modelGenerations.strong must be an array");

    // `claude5x` was removed: it was validated and documented but never read,
    // so it could only ever mislead. An existing config carrying it must still
    // load — unknown keys are ignored, not rejected.
    expect(() =>
      validateConfig({
        activePreset: "test",
        defaultTier: "fast",
        rules: [],
        modelGenerations: { claude5x: 1, strong: ["claude-opus-5"] },
        presets: { test: { fast: { model: "p/m", description: "d", whenToUse: ["w"] } } },
      }),
    ).not.toThrow();
  });

  test("rejects non-object tierPromptsGoalOriented", () => {
    expect(() =>
      validateConfig({
        activePreset: "test",
        defaultTier: "fast",
        rules: [],
        tierPromptsGoalOriented: ["fast"],
        presets: { test: { fast: { model: "p/m", description: "d", whenToUse: ["w"] } } },
      }),
    ).toThrow("tiers.json: 'tierPromptsGoalOriented' must be an object");
  });

  test("rejects non-string tierPromptsGoalOriented values", () => {
    expect(() =>
      validateConfig({
        activePreset: "test",
        defaultTier: "fast",
        rules: [],
        tierPromptsGoalOriented: { fast: 123 },
        presets: { test: { fast: { model: "p/m", description: "d", whenToUse: ["w"] } } },
      }),
    ).toThrow("tiers.json: tierPromptsGoalOriented.'fast' must be a string");
  });
});
