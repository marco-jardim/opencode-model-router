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

  // claude-opus-5 still accepts a manual budget; claude-fable-5 is adaptive-only
  // and now drops it (covered in "provider gate for explicit fields" below).
  test("omits effort but keeps siblings when only thinking is set", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = buildAgentOptions(
      tier("anthropic/claude-opus-5", { thinking: { budgetTokens: 4096 } }),
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
        tier("anthropic/claude-opus-5", {
          effort: "medium",
          thinking: { budgetTokens: 4096 },
        }),
      { budget_tokens: 4096 },
      true,
    ],
    [
      "anthropic adaptive-only effort conflict",
      () =>
        tier("anthropic/claude-fable-5", {
          effort: "medium",
          thinking: { budgetTokens: 4096 },
        }),
      { effort: "medium" },
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
        tier("anthropic/claude-opus-5", { effort: "low", thinking: { budgetTokens: 1 } }),
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

describe("provider gate for explicit fields", () => {
  beforeEach(() => {
    resetAgentOptionsEffortWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    "anthropic/claude-opus-5-5",
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
    "anthropic/claude-mythos-5-1",
    "github-copilot/claude-fable-5-1",
    "openrouter/anthropic/claude-opus-5-5",
  ])("drops budget_tokens on adaptive-only %s with a warning", (model) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(tier(model, { thinking: { budgetTokens: 32000 } }), "medium"),
    ).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("tier medium");
    expect(message).toContain("only accepts adaptive thinking");
    expect(message).toContain("thinking.budgetTokens is ignored");
    expect(message).toContain("use effort instead");
  });

  test.each([
    "anthropic/claude-opus-5",
    "anthropic/claude-mythos-5",
    "anthropic/claude-sonnet-4-6",
    "github-copilot/claude-opus-4.8",
  ])("keeps budget_tokens on Claude model %s that accepts a budget", (model) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(buildAgentOptions(tier(model, { thinking: { budgetTokens: 32000 } }))).toEqual({
      budget_tokens: 32000,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps budget_tokens on non-Claude models", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(tier("openai/gpt-5.5-fast", { thinking: { budgetTokens: 4096 } })),
    ).toEqual({ budget_tokens: 4096 });
    expect(
      buildAgentOptions(tier("google/gemini-3-pro", { thinking: { budgetTokens: 4096 } })),
    ).toEqual({ budget_tokens: 4096 });
    expect(warn).not.toHaveBeenCalled();
  });

  test("still emits effort on an adaptive-only tier that also sets a budget", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-opus-5-5", {
          effort: "high",
          thinking: { budgetTokens: 32000 },
        }),
        "medium",
      ),
    ).toEqual({ effort: "high" });

    // The gated budget does not claim the effort conflict.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("only accepts adaptive thinking");
    expect(warn.mock.calls[0]?.[0]).not.toContain("explicit thinking wins");
  });

  test.each([
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-5-5",
    "github-copilot/claude-sonnet-5",
    "openrouter/anthropic/claude-opus-5-5",
  ])("drops reasoning_* on Claude model %s with a warning", (model) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier(model, { reasoning: { effort: "low", summary: "auto" } }),
        "fast",
      ),
    ).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("tier fast");
    expect(message).toContain("reasoning.effort and reasoning.summary are OpenAI parameters");
    expect(message).toContain("use effort instead");
  });

  test("drops reasoning_* on a Claude tier but keeps its effort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-opus-5", { effort: "high", reasoning: { effort: "low" } }),
        "fast",
      ),
    ).toEqual({ effort: "high" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("are OpenAI parameters");
  });

  test("stays silent for an empty reasoning block on a Claude tier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(rawTier("anthropic/claude-opus-5", { reasoning: {} }), "fast"),
    ).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("drops a summary-only reasoning block on a Claude tier with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(tier("anthropic/claude-opus-5", { reasoning: { summary: "auto" } }), "fast"),
    ).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("are OpenAI parameters");
  });

  test("treats a zero budget on an adaptive-only tier as the zero-budget notice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("anthropic/claude-opus-5-5", { thinking: { budgetTokens: 0 } }),
        "medium",
      ),
    ).toEqual({});
    // Branch order: the adaptive-only drop never fires on a zero budget.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("thinking.budgetTokens: 0 is ignored");
    expect(warn.mock.calls[0]?.[0]).not.toContain("only accepts adaptive thinking");
  });

  test("keeps reasoning_* on non-Claude models", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildAgentOptions(
        tier("openai/gpt-5.5-fast", { reasoning: { effort: "low", summary: "auto" } }),
      ),
    ).toEqual({ reasoning_effort: "low", reasoning_summary: "auto" });
    expect(
      buildAgentOptions(tier("google/gemini-3-pro", { reasoning: { summary: "auto" } })),
    ).toEqual({ reasoning_summary: "auto" });
    expect(warn).not.toHaveBeenCalled();
  });

  test("routes the gate warnings through the logger when one is given", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = { warn: vi.fn(), flush: async () => undefined };

    buildAgentOptions(
      tier("anthropic/claude-opus-5-5", {
        thinking: { budgetTokens: 32000 },
        reasoning: { effort: "low" },
      }),
      "medium",
      logger,
    );

    expect(warn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      { key: "thinking-adaptive-only:medium" },
      { key: "reasoning-claude:medium" },
    ]);
  });

  test("routes the invalid-effort warning through the logger when one is given", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = { warn: vi.fn(), flush: async () => undefined };

    expect(
      buildAgentOptions(rawTier("anthropic/claude-opus-5", { effort: "ultra" }), "fast", logger),
    ).toEqual({});

    expect(warn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[1]).toEqual({ key: "invalid:fast:ultra" });
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

  test("warns once per tier for each provider-gate drop until reset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const budget = tier("anthropic/claude-opus-5-5", { thinking: { budgetTokens: 32000 } });
    const reasoning = tier("anthropic/claude-opus-5-5", { reasoning: { effort: "low" } });

    buildAgentOptions(budget, "medium");
    buildAgentOptions(budget, "medium");
    expect(warn).toHaveBeenCalledTimes(1);

    // Distinct keys: the reasoning drop is not suppressed by the budget drop,
    // and neither suppresses the same drop on another tier.
    buildAgentOptions(reasoning, "medium");
    buildAgentOptions(reasoning, "medium");
    expect(warn).toHaveBeenCalledTimes(2);
    buildAgentOptions(budget, "heavy");
    buildAgentOptions(reasoning, "heavy");
    expect(warn).toHaveBeenCalledTimes(4);

    resetAgentOptionsEffortWarnings();
    buildAgentOptions(budget, "medium");
    buildAgentOptions(reasoning, "medium");
    expect(warn).toHaveBeenCalledTimes(6);
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
