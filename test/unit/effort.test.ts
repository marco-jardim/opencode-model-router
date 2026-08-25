import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import {
  buildAgentOptions,
  resetAgentOptionsEffortWarnings,
} from "../../src/router/agent-options";
import { nextTierAfter } from "../../src/escalate/ladder";
import { validateConfig, EFFORT_LEVELS, type TierConfig } from "../../src/router/config";

/** A tier that has been through the real validator, as loaded from tiers.json. */
function tier(model: string, extras: Record<string, unknown> = {}): TierConfig {
  const cfg = validateConfig({
    activePreset: "test",
    defaultTier: "fast",
    rules: [],
    presets: {
      test: {
        fast: {
          model,
          description: "Test tier",
          whenToUse: ["tests"],
          ...extras,
        },
      },
    },
  });

  return cfg.presets.test.fast;
}

/**
 * A tier that skipped validation. `validateConfig` rejects a bad `effort`, so
 * the only way an invalid value reaches `buildAgentOptions` is a programmatic
 * caller — which is exactly the defensive path these cases cover.
 */
function rawTier(model: string, extras: Record<string, unknown> = {}): TierConfig {
  return { model, description: "Test tier", ...extras } as unknown as TierConfig;
}

describe("effort validation", () => {
  test.each(EFFORT_LEVELS)("accepts '%s' at load time", (effort) => {
    expect(tier("anthropic/claude-fable-5", { effort }).effort).toBe(effort);
  });

  test.each([["ultra"], ["HIGH"], [""], ["extreme"]])(
    "rejects out-of-set effort %s at load time",
    (effort) => {
      expect(() => tier("anthropic/claude-fable-5", { effort })).toThrow(
        `tiers.json: preset 'test' tier 'fast': effort must be one of low, medium, high, xhigh, max`,
      );
    },
  );

  test.each([[3], [null], [true], [["high"]]])(
    "rejects non-string effort %s at load time",
    (effort) => {
      expect(() => tier("anthropic/claude-fable-5", { effort })).toThrow(
        /effort must be one of/,
      );
    },
  );

  test("leaves the tier alone when effort is absent", () => {
    expect(tier("anthropic/claude-fable-5")).not.toHaveProperty("effort");
  });
});

describe("per-tier effort agent options", () => {
  beforeEach(() => {
    resetAgentOptionsEffortWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each(["low", "xhigh", "max"])("accepts valid anthropic effort %s", (effort) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(buildAgentOptions(tier("anthropic/claude-fable-5", { effort }))).toEqual({
      effort,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["ultra", 3, null])("ignores invalid effort %s without crashing", (effort) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(buildAgentOptions(rawTier("anthropic/claude-fable-5", { effort }))).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("invalid effort");
  });

  test("omits the effort key entirely when absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = buildAgentOptions(tier("anthropic/claude-fable-5"));

    expect(opts).not.toHaveProperty("effort");
    expect(opts).not.toHaveProperty("reasoning_effort");
    expect(opts).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("omits effort but keeps siblings when only thinking is set", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = buildAgentOptions(
      tier("anthropic/claude-fable-5", { thinking: { budgetTokens: 4096 } }),
    );

    expect(opts).toEqual({ budget_tokens: 4096 });
    expect(opts).not.toHaveProperty("effort");
  });

  test.each([
    [
      "anthropic effort alone",
      () => tier("anthropic/claude-fable-5", { effort: "medium" }),
      { effort: "medium" },
      false,
    ],
    [
      "anthropic effort conflict",
      () =>
        tier("anthropic/claude-fable-5", {
          effort: "medium",
          thinking: { budgetTokens: 4096 },
        }),
      { budget_tokens: 4096 },
      true,
    ],
    ["anthropic absent", () => tier("anthropic/claude-fable-5"), {}, false],
    [
      "openai effort alone",
      () => tier("openai/gpt-5.5-fast", { effort: "medium" }),
      { reasoning_effort: "medium" },
      false,
    ],
    [
      "openai effort conflict",
      () =>
        tier("openai/gpt-5.5-fast", {
          effort: "medium",
          reasoning: { effort: "low", summary: "auto" },
        }),
      { reasoning_effort: "low", reasoning_summary: "auto" },
      true,
    ],
    ["openai absent", () => tier("openai/gpt-5.5-fast"), {}, false],
    [
      "unknown effort alone",
      () => tier("google/gemini-3-pro", { effort: "medium" }),
      {},
      true,
    ],
    [
      "unknown effort conflict shape",
      () =>
        tier("google/gemini-3-pro", {
          effort: "medium",
          thinking: { budgetTokens: 4096 },
        }),
      { budget_tokens: 4096 },
      true,
    ],
    ["unknown absent", () => tier("google/gemini-3-pro"), {}, false],
  ])("resolves provider matrix: %s", (_name, input, expected, warns) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(buildAgentOptions(input())).toEqual(expected);
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });

  test("downgrades unsupported OpenAI xhigh effort to high", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(buildAgentOptions(tier("openai/gpt-5.5-fast", { effort: "xhigh" }))).toEqual({
      reasoning_effort: "high",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("downgrading effort 'xhigh' to 'high'");
  });

  test("downgrades max effort for OpenAI reasoning_effort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(buildAgentOptions(tier("openai/gpt-5.5-fast", { effort: "max" }), "fast")).toEqual({
      reasoning_effort: "high",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("downgrading");
  });

  test("keeps Anthropic effort independent from variant", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-fable-5", { effort: "low", variant: "max" }),
        "fast",
      ),
    ).toEqual({ effort: "low" });
    expect(warn).not.toHaveBeenCalled();
  });

  test("allows Anthropic effort with empty thinking config", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-fable-5", { effort: "low", thinking: {} }),
        "fast",
      ),
    ).toEqual({ effort: "low" });
    expect(warn).not.toHaveBeenCalled();
  });

  test("applies Anthropic effort when thinking.budgetTokens is 0", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-fable-5", { effort: "low", thinking: { budgetTokens: 0 } }),
        "fast",
      ),
    ).toEqual({ effort: "low" });

    // A zero budget is not a thinking config, so it must not claim the conflict.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("thinking.budgetTokens: 0 is ignored");
    expect(warn.mock.calls[0]?.[0]).not.toContain("explicit thinking wins");
  });

  test("lets truthy thinking.budgetTokens beat effort with a conflict warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-fable-5", { effort: "low", thinking: { budgetTokens: 1 } }),
        "fast",
      ),
    ).toEqual({ budget_tokens: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("explicit thinking wins");
  });

  test("emits nothing for thinking.budgetTokens 0 without effort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-fable-5", { thinking: { budgetTokens: 0 } }),
        "fast",
      ),
    ).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("thinking.budgetTokens: 0 is ignored");
    expect(warn.mock.calls[0]?.[0]).not.toContain("effort");
  });
});

describe("effort warn-once keying", () => {
  beforeEach(() => {
    resetAgentOptionsEffortWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("warns once for repeated invalid effort until reset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalidTier = rawTier("openai/gpt-5", { effort: "invalid" });

    expect(buildAgentOptions(invalidTier, "fast")).toEqual({});
    expect(buildAgentOptions(invalidTier, "fast")).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);

    resetAgentOptionsEffortWarnings();
    expect(buildAgentOptions(invalidTier, "fast")).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("keys invalid-effort warnings by tier and by value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    buildAgentOptions(rawTier("openai/gpt-5", { effort: "invalid" }), "fast");
    buildAgentOptions(rawTier("openai/gpt-5", { effort: "invalid" }), "medium");
    buildAgentOptions(rawTier("openai/gpt-5", { effort: "bogus" }), "fast");

    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("keys the zero-budget notice by tier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const zeroBudget = { thinking: { budgetTokens: 0 } };

    buildAgentOptions(tier("anthropic/claude-fable-5", zeroBudget), "fast");
    buildAgentOptions(tier("anthropic/claude-fable-5", zeroBudget), "fast");
    expect(warn).toHaveBeenCalledTimes(1);

    buildAgentOptions(tier("anthropic/claude-fable-5", zeroBudget), "medium");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("keys OpenAI downgrades by tier and by level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    buildAgentOptions(tier("openai/gpt-5.5-fast", { effort: "xhigh" }), "fast");
    buildAgentOptions(tier("openai/gpt-5.5-fast", { effort: "xhigh" }), "fast");
    expect(warn).toHaveBeenCalledTimes(1);

    buildAgentOptions(tier("openai/gpt-5.5-fast", { effort: "max" }), "fast");
    buildAgentOptions(tier("openai/gpt-5.5-fast", { effort: "xhigh" }), "heavy");
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("effort through override layers", () => {
  beforeEach(() => {
    resetAgentOptionsEffortWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("an override that adds effort leaves sibling tier fields alone", async () => {
    const { deepMerge } = await import("../../src/router/config");
    const raw = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8"));

    const merged = validateConfig(
      deepMerge(raw, {
        presets: { anthropic: { medium: { effort: "high" } } },
      }) as Record<string, unknown>,
    );
    const base = validateConfig(raw);

    expect(merged.presets.anthropic.medium.effort).toBe("high");
    expect(merged.presets.anthropic.medium.model).toBe(
      base.presets.anthropic.medium.model,
    );
    expect(merged.presets.anthropic.medium.steps).toBe(
      base.presets.anthropic.medium.steps,
    );
    expect(merged.presets.anthropic.fast).not.toHaveProperty("effort");
    expect(merged.presets.anthropic.heavy).not.toHaveProperty("effort");
    expect(buildAgentOptions(merged.presets.anthropic.medium, "medium")).toEqual({
      ...buildAgentOptions(base.presets.anthropic.medium, "medium"),
      effort: "high",
    });
  });
});

describe("S3.4.3 escalation effort correctness", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8"));
  const preset = validateConfig(raw).presets["fable-effort"];

  beforeEach(() => {
    resetAgentOptionsEffortWarnings();
  });

  test("keeps fable-effort low for fast and high for medium", () => {
    expect(buildAgentOptions(preset.fast, "fast")).toEqual({ effort: "low" });
    expect(buildAgentOptions(preset.medium, "medium")).toEqual({ effort: "high" });
  });

  test("escalates from fast to medium without dropping effort tiers", () => {
    expect(
      nextTierAfter("fast", {
        ladder: ["fast", "medium", "heavy"],
        maxAttemptsPerTier: 2,
        maxTotalAttempts: 6,
      }),
    ).toBe("medium");
  });

  test("omits effort on escalated tier when no effort is configured", () => {
    expect(buildAgentOptions(preset.medium, "medium")).toEqual({ effort: "high" });

    const heavyWithoutEffort = { ...preset.heavy };
    delete heavyWithoutEffort.effort;

    expect(buildAgentOptions(heavyWithoutEffort, "heavy")).not.toHaveProperty("effort");
  });
});
