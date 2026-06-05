import { describe, it, expect } from "vitest";
import {
  getActiveTiers,
  getActiveMode,
  buildFallbackInstructions,
  buildTaskTaxonomy,
  buildDecomposeHint,
  buildDelegationProtocol,
  isClaudeModel,
  assembleSystemPrompt,
} from "../../src/router/protocol";
import type { RouterConfig } from "../../src/router/config";

function tier(model: string, extra: Record<string, unknown> = {}) {
  return { model, description: "d", whenToUse: [], ...extra };
}

/** Minimal config: single tier, no modes/taskPatterns/fallback/costRatio/variant. */
const minimal = {
  activePreset: "p",
  presets: { p: { only: tier("prov/model-x") } },
  rules: ["alpha", "beta"],
  defaultTier: "only",
} as unknown as RouterConfig;

/** Rich config: multi-tier with costRatio + variant, modes w/ overrideRules, taskPatterns, fallback. */
const rich = {
  activePreset: "anthropic",
  activeMode: "budget",
  presets: {
    anthropic: {
      fast: tier("anthropic/claude-haiku-4-5", { costRatio: 1 }),
      medium: tier("anthropic/claude-sonnet-4-6", { costRatio: 5, variant: "max" }),
    },
    openai: { fast: tier("openai/gpt-x", { costRatio: 1 }) },
  },
  rules: ["base1"],
  defaultTier: "fast",
  modes: { budget: { defaultTier: "fast", description: "cheap", overrideRules: ["o1", "o2"] } },
  taskPatterns: { fast: ["recon", "lookup"], medium: ["impl"] },
  fallback: { global: { anthropic: ["openai"] } },
} as unknown as RouterConfig;

describe("getActiveTiers", () => {
  it("returns the active preset's tiers", () => {
    expect(Object.keys(getActiveTiers(rich))).toEqual(["fast", "medium"]);
  });
  it("falls back to the first preset when activePreset is unknown", () => {
    const cfg = { ...rich, activePreset: "missing" } as unknown as RouterConfig;
    expect(getActiveTiers(cfg)).toBeDefined();
  });
});

describe("getActiveMode", () => {
  it("returns undefined when modes or activeMode absent", () => {
    expect(getActiveMode(minimal)).toBeUndefined();
  });
  it("returns the active mode object when present", () => {
    expect(getActiveMode(rich)?.defaultTier).toBe("fast");
  });
});

describe("buildTaskTaxonomy", () => {
  it("returns '' when taskPatterns absent", () => {
    expect(buildTaskTaxonomy(minimal)).toBe("");
  });
  it("builds a taxonomy line when present", () => {
    const out = buildTaskTaxonomy(rich);
    expect(out).toContain("R:");
    expect(out).toContain("@fast→recon/lookup");
  });
  it("skips empty pattern arrays", () => {
    const cfg = { ...rich, taskPatterns: { fast: [] } } as unknown as RouterConfig;
    expect(buildTaskTaxonomy(cfg)).toBe("R:");
  });
});

describe("buildDecomposeHint", () => {
  it("returns '' when the active mode has overrideRules", () => {
    expect(buildDecomposeHint(rich)).toBe("");
  });
  it("returns '' when fewer than 2 tiers", () => {
    expect(buildDecomposeHint(minimal)).toBe("");
  });
  it("returns an explore→execute hint for >=2 tiers in normal mode", () => {
    const cfg = { ...rich, activeMode: undefined, modes: undefined } as unknown as RouterConfig;
    const out = buildDecomposeHint(cfg);
    expect(out).toContain("explore(@fast)→execute(@medium)");
  });
});

describe("buildFallbackInstructions", () => {
  it("returns '' when no fallback configured", () => {
    expect(buildFallbackInstructions(minimal)).toBe("");
  });
  it("uses fb.global when no preset-specific map", () => {
    const out = buildFallbackInstructions(rich);
    expect(out).toContain("anthropic→openai");
  });
  it("prefers a non-empty preset-specific map over global", () => {
    const cfg = {
      ...rich,
      fallback: { presets: { anthropic: { x: ["openai"] } }, global: { y: ["openai"] } },
    } as unknown as RouterConfig;
    expect(buildFallbackInstructions(cfg)).toContain("x→openai");
  });
  it("returns '' when the chain map yields no valid targets", () => {
    const cfg = { ...rich, fallback: { global: { anthropic: ["nonexistent"] } } } as unknown as RouterConfig;
    expect(buildFallbackInstructions(cfg)).toBe("");
  });
  it("skips non-array chain entries", () => {
    const cfg = { ...rich, fallback: { global: { anthropic: "openai" } } } as unknown as RouterConfig;
    expect(buildFallbackInstructions(cfg)).toBe("");
  });
});

describe("buildDelegationProtocol", () => {
  it("renders minimal config without optional sections (no costRatio/mode/taxonomy/fallback)", () => {
    const out = buildDelegationProtocol(minimal);
    expect(out).toContain("Preset: p.");
    expect(out).toContain("@only=model-x"); // no variant, no (Nx)
    expect(out).not.toContain("mode:");
    expect(out).toContain("1.alpha 2.beta"); // cfg.rules, no overrideRules
  });
  it("renders rich config with variant, costRatio, mode suffix and overrideRules", () => {
    const out = buildDelegationProtocol(rich);
    expect(out).toContain("@medium=claude-sonnet-4-6/max(5x)");
    expect(out).toContain("mode:budget");
    expect(out).toContain("1.o1 2.o2"); // overrideRules win
    expect(out).toContain("R:"); // taxonomy present
    expect(out).toContain("Chain:"); // fallback present
  });
});

describe("isClaudeModel", () => {
  it.each([
    ["undefined", undefined, false],
    ["anthropic/ prefix", "anthropic/claude-haiku-4-5", true],
    ["claude- in path", "bedrock/claude-3-sonnet", true],
    ["leading claude-", "claude-3-opus", true],
    ["non-claude", "openai/gpt-5", false],
  ])("%s", (_label, model, expected) => {
    expect(isClaudeModel(model as string | undefined)).toBe(expected);
  });
});

describe("assembleSystemPrompt", () => {
  it("prepends Claude override + anti-narration for Claude orchestrators", () => {
    const out = assembleSystemPrompt(minimal, "anthropic/claude-haiku-4-5");
    expect(out).toContain("AUTHORITY OVERRIDE");
    expect(out).toContain("ANTI-NARRATION");
    expect(out).toContain("## Model Delegation Protocol");
  });
  it("returns the bare protocol for non-Claude orchestrators", () => {
    const out = assembleSystemPrompt(minimal, "openai/gpt-5");
    expect(out.startsWith("## Model Delegation Protocol")).toBe(true);
    expect(out).not.toContain("AUTHORITY OVERRIDE");
  });
});
