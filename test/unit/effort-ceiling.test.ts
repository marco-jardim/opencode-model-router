import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentOptions,
  effortCeilingFor,
  effortRank,
  minEffort,
  nextEffort,
  resetAgentOptionsEffortWarnings,
} from "../../src/router/agent-options";
import { EFFORT_LEVELS, type EffortLevel, type TierConfig } from "../../src/router/config";
import type { PluginLogger } from "../../src/router/logger";

afterEach(() => {
  resetAgentOptionsEffortWarnings();
  vi.restoreAllMocks();
});

// Independent oracles from phase-1.3.md I1/I2; do not derive expected ranks
// or steps using the helpers under test.
const levels = ["low", "medium", "high", "xhigh", "max"] as const;
const stepGrid: readonly (readonly (EffortLevel | null)[])[] = [
  [null, "medium", "medium", "medium", "medium"],
  [null, null, "high", "high", "high"],
  [null, null, null, "xhigh", "xhigh"],
  [null, null, null, null, "max"],
  [null, null, null, null, null],
];
const pairs = levels.flatMap((current, row) =>
  levels.map((bound, column) => ({
    current,
    bound,
    next: stepGrid[row]![column]!,
    minimum: levels[Math.min(row, column)]!,
  })),
);

describe("effort algebra (I1/I2)", () => {
  it("keeps the documented effort order", () => {
    expect(EFFORT_LEVELS).toEqual(levels);
  });

  it.each(levels.map((level, rank) => ({ level, rank })))(
    "ranks $level as $rank",
    ({ level, rank }) => expect(effortRank(level)).toBe(rank),
  );

  it.each(["ultra", "High", "", null, undefined, 3, true, ["high"], {}])(
    "returns indexOf's -1 for unvalidated runtime input %j",
    (value) => {
      // The public API requires a validated level. Deliberately bypass that
      // boundary to document indexOf semantics, not to add runtime validation.
      expect(effortRank(value as unknown as EffortLevel)).toBe(-1);
    },
  );

  it.each(pairs)("nextEffort($current, $bound) = $next", ({ current, bound, next }) => {
    expect(nextEffort(current, bound)).toBe(next);
  });

  it.each(pairs)("minEffort($current, $bound) = $minimum", ({ current, bound, minimum }) => {
    expect(minEffort(current, bound)).toBe(minimum);
    expect(minEffort(bound, current)).toBe(minimum);
  });
});

type Family = "openai" | "adaptive" | "manual" | "unknown";
const models: { model: string; family: Family }[] = [
  { model: "openai/gpt-5", family: "openai" },
  { model: "OpenAI/GPT-5", family: "openai" },
  { model: "azure/gpt-5", family: "openai" },
  { model: "github-copilot/gpt-5", family: "openai" },
  { model: "github-copilot/claude-sonnet-5", family: "manual" },
  { model: "openrouter/anthropic/claude-sonnet-4.5", family: "manual" },
  { model: "Anthropic/Claude-Sonnet-4-5", family: "manual" },
  { model: "anthropic/claude-fable-5.1", family: "adaptive" },
  { model: "gpt-5", family: "openai" },
  { model: "o3", family: "openai" },
  { model: "azure/o3", family: "openai" },
  { model: "anthropic/claude-fable-5-1", family: "adaptive" },
  { model: "anthropic/claude-opus-5-5", family: "adaptive" },
  { model: "anthropic/claude-opus-5-5-20260101", family: "adaptive" },
  { model: "anthropic/claude-fable-5-1[1m]", family: "adaptive" },
  { model: "anthropic/claude-sonnet-4-5", family: "manual" },
  { model: "google/gemini-3.7-flash", family: "unknown" },
  // These are intentionally unknown to the existing builder (memo F2).
  { model: "amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0", family: "unknown" },
  { model: "amazon-bedrock/us.anthropic.claude-opus-5-5-20260101-v1:0", family: "unknown" },
  { model: "google-vertex-anthropic/claude-sonnet-4-5@20250929", family: "manual" },
  { model: "google-vertex-anthropic/claude-opus-5-5@20260101", family: "adaptive" },
  { model: "openrouter/qwen/qwen3-coder", family: "unknown" },
];

function captureOptions(tier: TierConfig) {
  resetAgentOptionsEffortWarnings();
  const warn = vi.fn<PluginLogger["warn"]>();
  const logger: PluginLogger = { warn, flush: async () => {} };
  const options = buildAgentOptions(tier, "fixture", logger);
  // Compare both message and key: unchanged warnings are tier configuration
  // warnings, not an effect of raising effort (memo I4).
  const warnings = warn.mock.calls.map((call) => JSON.stringify(call));
  return { options, warnings, keys: warn.mock.calls.map(([, extra]) => extra?.key) };
}

const baseEfforts = [undefined, "ultra", "High", null, ...levels];
const thinkingConfigs = [undefined, { budgetTokens: 0 }, { budgetTokens: 8000 }];
const reasoningConfigs: TierConfig["reasoning"][] = [
  undefined,
  { effort: "low" },
  { summary: "auto" },
];

// Full Cartesian product, not just isolated overrides: precedence must also
// agree when thinking, reasoning and a variant are present together.
const agreementCases = models.flatMap(({ model, family }) =>
  baseEfforts.flatMap((effort) =>
    thinkingConfigs.flatMap((thinking) =>
      reasoningConfigs.flatMap((reasoning) =>
        [undefined, "high"].map((variant) => {
          const d7 = Boolean(variant) || !levels.some((level) => level === effort);
          const expected: EffortLevel | null = d7 || family === "unknown"
            || (family === "manual" && Boolean(thinking?.budgetTokens))
            || (family === "openai" && Boolean(reasoning?.effort))
            ? null : family === "openai" ? "high" : "max";
          // Invalid effort fixtures intentionally represent programmatic callers
          // that bypass validateConfig, as in effort.test.ts.
          const tier = { model, effort, thinking, reasoning, variant } as unknown as TierConfig;
          return {
            name: `${model} effort=${String(effort)} thinking=${thinking?.budgetTokens ?? "none"}`
              + ` reasoning=${JSON.stringify(reasoning) ?? "none"} variant=${variant ?? "none"}`,
            tier,
            d7,
            expected,
          };
        }),
      ),
    ),
  ),
);

describe("effortCeilingFor / native builder agreement (I3/I4)", () => {
  it.each(agreementCases)("$name", ({ tier, d7, expected }) => {
    const before = structuredClone(tier);
    const ceiling = effortCeilingFor(tier);
    expect(ceiling).toBe(expected);
    expect(tier).toEqual(before);

    const baseline = captureOptions({ ...tier, effort: undefined });
    const passing: EffortLevel[] = [];
    for (const level of levels) {
      const result = captureOptions({ ...tier, effort: level });
      const unchanged = result.options.effort === level || result.options.reasoningEffort === level;
      const addedWarnings = result.warnings.filter((warning) => !baseline.warnings.includes(warning));
      const passes = unchanged && addedWarnings.length === 0;
      if (passes) passing.push(level);
      if (ceiling !== null) {
        const withinCeiling = levels.indexOf(level) <= levels.indexOf(ceiling);
        expect(passes, `level=${level}`).toBe(withinCeiling);
        if (withinCeiling) {
          expect(unchanged).toBe(true);
          expect(addedWarnings).toEqual([]);
        } else {
          expect(result.options.reasoningEffort).toBe("high");
          expect(result.keys).toContain(`openai-downgrade:fixture:${level}`);
        }
      }
    }
    // The biconditional prevents an overly conservative always-null ceiling
    // from satisfying the agreement property vacuously.
    expect(ceiling === null).toBe(d7 || passing.length === 0);
    if (ceiling !== null) expect(passing.at(-1)).toBe(ceiling);
  });

  it.each([
    { model: "openai/gpt-5", expected: "high" },
    { model: "anthropic/claude-sonnet-4-5", expected: "max" },
  ] as const)("treats empty variant and option objects as unset for $model", ({ model, expected }) => {
    const tier: TierConfig = { model, effort: "low", variant: "", thinking: {}, reasoning: {} };
    expect(effortCeilingFor(tier)).toBe(expected);
    expect(captureOptions(tier).warnings).toEqual([]);
  });

  it("is pure and neither consumes nor resets builder warning state", () => {
    resetAgentOptionsEffortWarnings();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warn = vi.fn<PluginLogger["warn"]>();
    const logger: PluginLogger = { warn, flush: async () => {} };
    const tier: TierConfig = Object.freeze({
      model: "anthropic/claude-sonnet-4-5",
      effort: "low",
      thinking: Object.freeze({ budgetTokens: 8000 }),
    });

    expect(effortCeilingFor(tier)).toBeNull();
    expect(consoleWarn).not.toHaveBeenCalled();
    buildAgentOptions(tier, "pure", logger);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(effortCeilingFor(tier)).toBeNull();
    buildAgentOptions(tier, "pure", logger);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

describe("clamped effort bounds (I17 helper algebra; ladder policy tested separately)", () => {
  it.each(models.flatMap(({ model }) => levels.map((max) => ({ model, max }))))(
    "$model with maximum $max never steps past the ceiling or maximum",
    ({ model, max }) => {
      const ceiling = effortCeilingFor({ model, effort: "low" });
      if (ceiling === null) return;
      const bound = minEffort(ceiling, max);
      expect(effortRank(bound)).toBeLessThanOrEqual(effortRank(ceiling));
      expect(effortRank(bound)).toBeLessThanOrEqual(effortRank(max));
      for (const current of levels) {
        const next = nextEffort(current, bound);
        if (next === null) {
          expect(effortRank(current)).toBeGreaterThanOrEqual(effortRank(bound));
        } else {
          expect(effortRank(next)).toBe(effortRank(current) + 1);
          expect(effortRank(next)).toBeLessThanOrEqual(effortRank(bound));
        }
      }
    },
  );
});
