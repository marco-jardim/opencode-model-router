import { describe, it, expect } from "vitest";
import {
  DEFAULT_VARIANT,
  DEFAULT_VARIANT_POSITION,
  HOST_EFFORT_ORDER,
  buildVariantLadder,
  catalogVariantIds,
  estimateTokensFromChars,
  inputBudget,
  modelRef,
  nextVariant,
  resumeDecision,
  stepContextTokens,
  variantCovered,
  variantPosition,
  variantRange,
  variantRank,
  type CatalogModel,
  type VariantLadder,
} from "../../src/escalate/variants";

// Live catalog variant lists recorded by Phase 0.P S4 (host effort order).
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-4-5";
const LUNA = "openai/gpt-6-luna";
const catalog = (...ids: string[]): CatalogModel => ({ variants: ids.map((id) => ({ id })) });
const sonnet = catalog("low", "medium", "high", "xhigh", "max");
const haiku = catalog("high", "max");
const luna = catalog("none", "low", "medium", "high", "xhigh", "max");
const deepseek = catalog("low", "high", "max");

function ladder(variants: string[], source: VariantLadder["source"] = "catalog"): VariantLadder {
  return { model: SONNET, variants, source, rejected: [], foreign: [] };
}

describe("variant ranks and the default position (A9)", () => {
  it("ranks host effort ids in order and leaves others unranked", () => {
    expect(HOST_EFFORT_ORDER.map(variantRank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(variantRank("turbo")).toBe(-1);
    expect(variantRank(DEFAULT_VARIANT)).toBe(-1);
  });

  it("places default strictly between medium and high", () => {
    expect(DEFAULT_VARIANT_POSITION).toBeGreaterThan(variantRank("medium"));
    expect(DEFAULT_VARIANT_POSITION).toBeLessThan(variantRank("high"));
    for (const id of [DEFAULT_VARIANT, "", null, undefined]) expect(variantPosition(id)).toBe(DEFAULT_VARIANT_POSITION);
    expect(variantPosition("xhigh")).toBe(5);
    expect(variantPosition("turbo")).toBeNull();
  });
});

describe("variant ranges and coverage (QA-1.5-3)", () => {
  it("gives a ranked id a point and default the interval [-1, rank(high)]", () => {
    expect(variantRange("medium")).toEqual({ low: 3, high: 3 });
    expect(variantRange("none")).toEqual({ low: 0, high: 0 });
    for (const id of [DEFAULT_VARIANT, "", null, undefined]) expect(variantRange(id)).toEqual({ low: -1, high: variantRank("high") });
    expect(variantRange("turbo")).toBeNull();
  });

  it("covers the same variant, and a ranked base at or below the reached rank", () => {
    expect(variantCovered("medium", "medium")).toBe(true);
    expect(variantCovered("low", "medium")).toBe(true);
    expect(variantCovered("none", "max")).toBe(true);
    expect(variantCovered("high", "medium")).toBe(false);
    expect(variantCovered("max", "xhigh")).toBe(false);
  });

  it("covers a default base only from high upwards", () => {
    for (const reached of ["high", "xhigh", "max"]) expect(variantCovered(DEFAULT_VARIANT, reached)).toBe(true);
    for (const reached of ["none", "low", "medium"]) expect(variantCovered(DEFAULT_VARIANT, reached)).toBe(false);
  });

  it("lets a reached default cover nothing but default itself", () => {
    for (const base of ["none", "low", "medium", "high", "max"]) expect(variantCovered(base, DEFAULT_VARIANT)).toBe(false);
    for (const id of [DEFAULT_VARIANT, "", null, undefined]) {
      for (const other of [DEFAULT_VARIANT, "", null, undefined]) expect(variantCovered(id, other)).toBe(true);
    }
  });

  it("covers an unranked id only against itself", () => {
    expect(variantCovered("turbo", "turbo")).toBe(true);
    expect(variantCovered("turbo", "max")).toBe(false);
    expect(variantCovered("high", "turbo")).toBe(false);
    expect(variantCovered("turbo", DEFAULT_VARIANT)).toBe(false);
  });

  it("keeps nextVariant stepping from default at the 3.5 position", () => {
    expect(nextVariant(ladder(["low", "medium", "high"]), DEFAULT_VARIANT)).toBe("high");
    expect(nextVariant(ladder(["low", "medium"]), DEFAULT_VARIANT)).toBeNull();
  });
});
describe("catalogVariantIds", () => {
  it("returns null without a variants array", () => {
    expect(catalogVariantIds(undefined)).toBeNull();
    expect(catalogVariantIds(null)).toBeNull();
    expect(catalogVariantIds({})).toBeNull();
    expect(catalogVariantIds({ variants: null })).toBeNull();
    expect(catalogVariantIds({ variants: "low" as never })).toBeNull();
  });

  it("keeps string ids in catalog order, dropping junk, duplicates and default", () => {
    const messy: CatalogModel = {
      variants: [null, undefined, { id: 3 }, { id: "" }, { id: "low" }, { id: "default" }, { id: "high" }, { id: "low" }, {}],
    };
    expect(catalogVariantIds(messy)).toEqual(["low", "high"]);
    expect(catalogVariantIds({ variants: [] })).toEqual([]);
  });
});

describe("buildVariantLadder", () => {
  it("builds the ladder from [low, medium, high, xhigh] in catalog order", () => {
    expect(buildVariantLadder({ model: SONNET, catalog: catalog("low", "medium", "high", "xhigh") })).toEqual({
      model: SONNET, variants: ["low", "medium", "high", "xhigh"], source: "catalog", rejected: [], foreign: [],
    });
  });

  it("caps catalog ladders at maxEffort and keeps them uncapped without one", () => {
    expect(buildVariantLadder({ model: SONNET, catalog: sonnet, maxEffort: "xhigh" }).variants)
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(buildVariantLadder({ model: SONNET, catalog: sonnet, maxEffort: "max" }).variants)
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(buildVariantLadder({ model: SONNET, catalog: sonnet, maxEffort: null }).variants)
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(buildVariantLadder({ model: LUNA, catalog: luna, maxEffort: "xhigh" }).variants)
      .toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(buildVariantLadder({ model: HAIKU, catalog: haiku, maxEffort: "xhigh" }).variants).toEqual(["high"]);
  });

  it("an unknown cap admits no catalog variant", () => {
    expect(buildVariantLadder({ model: SONNET, catalog: sonnet, maxEffort: "ultra" }).variants).toEqual([]);
  });

  it("keeps only ranked ids that strictly raise the rank", () => {
    expect(buildVariantLadder({ model: SONNET, catalog: catalog("high", "low", "xhigh", "xhigh") }).variants)
      .toEqual(["high", "xhigh"]);
    expect(buildVariantLadder({ model: SONNET, catalog: catalog("fast", "low", "turbo", "high") }).variants)
      .toEqual(["low", "high"]);
  });

  it("has no ladder without a catalog variants array and reports named candidates as rejected", () => {
    expect(buildVariantLadder({ model: SONNET, catalog: undefined, candidates: [{ variant: "high" }] })).toEqual({
      model: SONNET, variants: [], source: "none", rejected: ["high"], foreign: [],
    });
    expect(buildVariantLadder({ model: SONNET, catalog: { limit: { context: 1 } } }).source).toBe("none");
    expect(buildVariantLadder({ model: SONNET, catalog: { variants: [] } })).toEqual({
      model: SONNET, variants: [], source: "catalog", rejected: [], foreign: [],
    });
    // other-model rungs are still reported without a catalog
    expect(buildVariantLadder({ model: SONNET, catalog: undefined, candidates: [{ model: OPUS, variant: "high" }] }).foreign)
      .toEqual([{ model: OPUS, variant: "high" }]);
  });

  it("explicit candidates override catalog order and are not capped", () => {
    const built = buildVariantLadder({
      model: SONNET,
      catalog: sonnet,
      maxEffort: "high",
      candidates: [{ variant: "medium" }, { variant: "max" }],
    });
    expect(built).toEqual({ model: SONNET, variants: ["medium", "max"], source: "candidates", rejected: [], foreign: [] });
  });

  it("drops candidates not ranked above everything kept so far and reports them as rejected (QA-1.5-5)", () => {
    const messy = catalog("low", "medium", "high", "xhigh", "max", "fast");
    expect(buildVariantLadder({ model: SONNET, catalog: messy, candidates: [{ variant: "max" }, { variant: "medium" }, { variant: "high" }] }))
      .toMatchObject({ variants: ["max"], source: "candidates", rejected: ["medium", "high"] });
    expect(buildVariantLadder({ model: SONNET, catalog: messy, candidates: [{ variant: "high" }, { variant: "fast" }, { variant: "xhigh" }, { variant: "low" }] }))
      .toMatchObject({ variants: ["high", "xhigh"], rejected: ["fast", "low"] });
    // a rank is never repeated: the dedupe happens first, a different id with an equal rank cannot exist
    expect(buildVariantLadder({ model: SONNET, catalog: messy, candidates: [{ variant: "low" }, { variant: "low" }, { variant: "medium" }] }))
      .toMatchObject({ variants: ["low", "medium"], rejected: [] });
  });

  it("filters candidates to this model, validates them against the catalog and dedupes", () => {
    const built = buildVariantLadder({
      model: SONNET,
      catalog: sonnet,
      candidates: [
        { variant: "medium" },
        { model: SONNET, variant: "high" },
        { model: OPUS, variant: "xhigh" },
        { variant: "ultra" },
        { variant: "default" },
        { variant: "medium" },
        { variant: "" },
        { model: SONNET },
        null,
        undefined,
      ],
    });
    expect(built).toEqual({
      model: SONNET,
      variants: ["medium", "high"],
      source: "candidates",
      rejected: ["ultra", "default"],
      foreign: [{ model: OPUS, variant: "xhigh" }],
    });
  });

  it("reports other-model rungs once, with a null variant for a model-only rung", () => {
    const built = buildVariantLadder({
      model: SONNET,
      catalog: sonnet,
      candidates: [{ model: OPUS }, { model: OPUS }, { model: OPUS, variant: "high" }, { model: OPUS, variant: "high" }, { variant: "low" }],
    });
    expect(built.variants).toEqual(["low"]);
    expect(built.foreign).toEqual([{ model: OPUS, variant: null }, { model: OPUS, variant: "high" }]);
    expect(Object.isFrozen(built.foreign)).toBe(true);
    expect(Object.isFrozen(built.foreign[0])).toBe(true);
  });

  it("uses the candidates source even when no rung of this model survives (QA-1.5-5)", () => {
    const onlyOther = buildVariantLadder({
      model: SONNET,
      catalog: sonnet,
      maxEffort: "xhigh",
      candidates: [{ model: SONNET }, { model: OPUS, variant: "xhigh" }],
    });
    expect(onlyOther).toEqual({
      model: SONNET,
      variants: [],
      source: "candidates",
      rejected: [],
      foreign: [{ model: OPUS, variant: "xhigh" }],
    });
    const allRejected = buildVariantLadder({ model: SONNET, catalog: sonnet, candidates: [{ variant: "ultra" }] });
    expect(allRejected).toMatchObject({ variants: [], source: "candidates", rejected: ["ultra"] });
  });

  it("falls back to the catalog only for an absent or empty candidates array", () => {
    for (const candidates of [undefined, null, []] as const) {
      expect(buildVariantLadder({ model: SONNET, catalog: sonnet, maxEffort: "xhigh", candidates })).toMatchObject({
        variants: ["low", "medium", "high", "xhigh"],
        source: "catalog",
        foreign: [],
      });
    }
  });
  it("returns a frozen ladder and leaves its inputs untouched", () => {
    const candidates = [{ variant: "high" }];
    const entry = catalog("low", "high");
    const before = JSON.stringify({ candidates, entry });
    const built = buildVariantLadder({ model: SONNET, catalog: entry, candidates });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.variants)).toBe(true);
    expect(Object.isFrozen(built.rejected)).toBe(true);
    expect(Object.isFrozen(built.foreign)).toBe(true);
    expect(JSON.stringify({ candidates, entry })).toBe(before);
  });
});

describe("nextVariant", () => {
  const four = ladder(["low", "medium", "high", "xhigh"]);

  it("steps to the following ladder entry and stops at the top", () => {
    expect(nextVariant(four, "low")).toBe("medium");
    expect(nextVariant(four, "high")).toBe("xhigh");
    expect(nextVariant(four, "xhigh")).toBeNull();
  });

  it("places an unknown ranked current at the first entry above it", () => {
    expect(nextVariant(four, "minimal")).toBe("low");
    expect(nextVariant(ladder(["medium", "xhigh"]), "high")).toBe("xhigh");
    expect(nextVariant(four, "max")).toBeNull();
  });

  it("does not place an unranked current", () => {
    expect(nextVariant(four, "turbo")).toBeNull();
  });

  it.each([DEFAULT_VARIANT, null, undefined, ""])("steps from default (%s) to the first variant ranked high or above", (current) => {
    expect(nextVariant(buildVariantLadder({ model: SONNET, catalog: sonnet, maxEffort: "xhigh" }), current)).toBe("high");
    expect(nextVariant(buildVariantLadder({ model: HAIKU, catalog: haiku, maxEffort: "xhigh" }), current)).toBe("high");
    expect(nextVariant(buildVariantLadder({ model: LUNA, catalog: luna, maxEffort: "xhigh" }), current)).toBe("high");
    expect(nextVariant(buildVariantLadder({ model: "opencode-go/deepseek-v4.1-flash", catalog: deepseek }), current)).toBe("high");
    expect(nextVariant(ladder(["low", "medium"]), current)).toBeNull();
    expect(nextVariant(ladder(["none"]), current)).toBeNull();
  });

  it("has no step on an empty ladder", () => {
    expect(nextVariant(ladder([]), "low")).toBeNull();
    expect(nextVariant(ladder([]), DEFAULT_VARIANT)).toBeNull();
  });

  it("follows explicit candidate order by index", () => {
    const explicit = ladder(["high", "medium"], "candidates");
    expect(nextVariant(explicit, "high")).toBe("medium");
    expect(nextVariant(explicit, "medium")).toBeNull();
  });

  it("terminates within the ladder length, emits only ladder members and never lowers a catalog rank", () => {
    const catalogs = [sonnet, haiku, luna, deepseek, catalog("high", "low", "xhigh"), catalog("turbo", "medium")];
    const starts = [...HOST_EFFORT_ORDER, DEFAULT_VARIANT, "turbo", null];
    for (const entry of catalogs) {
      for (const maxEffort of [null, ...HOST_EFFORT_ORDER]) {
        const built = buildVariantLadder({ model: SONNET, catalog: entry, maxEffort });
        const catalogIds = catalogVariantIds(entry)!;
        for (const start of starts) {
          let current: string | null = start;
          let previous = variantPosition(start) ?? Number.NEGATIVE_INFINITY;
          let steps = 0;
          for (let next = nextVariant(built, current); next !== null; next = nextVariant(built, current)) {
            expect(built.variants).toContain(next);
            expect(catalogIds).toContain(next);
            expect(next).not.toBe(DEFAULT_VARIANT);
            expect(variantRank(next)).toBeGreaterThan(previous);
            previous = variantRank(next);
            current = next;
            steps++;
            expect(steps).toBeLessThanOrEqual(built.variants.length);
          }
        }
      }
    }
  });
});

describe("modelRef", () => {
  it("appends a real variant and omits default", () => {
    expect(modelRef(SONNET, "high")).toBe(`${SONNET}#high`);
    for (const variant of [DEFAULT_VARIANT, "", null, undefined]) expect(modelRef(SONNET, variant)).toBe(SONNET);
  });
});

describe("inputBudget (A5, A10)", () => {
  it("prefers limit.input", () => {
    expect(inputBudget({ context: 400_000, input: 272_000, output: 128_000 })).toBe(272_000);
  });

  it("falls back to context minus output", () => {
    expect(inputBudget({ context: 200_000, output: 64_000 })).toBe(136_000);
    expect(inputBudget({ context: 1_000_000, output: 0 })).toBe(1_000_000);
    expect(inputBudget({ context: 12_000, input: null, output: 2_000 })).toBe(10_000);
  });

  it("is null when unknown or not positive", () => {
    for (const limit of [
      undefined, null, {}, { context: 1_000 }, { output: 10 }, { context: 100, output: 100 }, { context: 100, output: 200 },
      { context: Number.NaN, output: 1 }, { context: "1000", output: 1 }, { context: 1_000, output: -1 },
      { input: 0, context: 1_000, output: 1 }, { input: -5 }, { input: Number.POSITIVE_INFINITY }, { input: "272000" },
    ] as CatalogModel["limit"][]) {
      expect(inputBudget(limit)).toBeNull();
    }
  });
});

describe("stepContextTokens (D11)", () => {
  it("sums input, cache read/write and output, excluding reasoning", () => {
    expect(stepContextTokens({ input: 100, output: 50, reasoning: 999, cache: { read: 1_000, write: 10 } })).toBe(1_160);
  });

  it("counts a missing cache as zero", () => {
    expect(stepContextTokens({ input: 100, output: 50 })).toBe(150);
    expect(stepContextTokens({ input: 100, output: 50, cache: null })).toBe(150);
    expect(stepContextTokens({ input: 100, output: 50, cache: { read: 5 } })).toBe(155);
  });

  it("is null when a counted field is missing or invalid", () => {
    for (const tokens of [
      undefined, null, {}, { input: 1 }, { output: 1 }, { input: -1, output: 1 }, { input: 1, output: Number.NaN },
      { input: 1, output: 1, cache: { read: -1 } }, { input: 1, output: 1, cache: { write: "2" } }, { input: 1, output: 1, cache: 7 },
    ]) {
      expect(stepContextTokens(tokens as never)).toBeNull();
    }
  });
});

describe("estimateTokensFromChars (A5)", () => {
  it("is characters / 4 rounded up", () => {
    expect([0, 1, 4, 5, 8, 4_001].map(estimateTokensFromChars)).toEqual([0, 1, 1, 2, 2, 1_001]);
  });

  it("is null for invalid counts", () => {
    for (const chars of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(estimateTokensFromChars(chars)).toBeNull();
  });
});

describe("resumeDecision (D11 as amended by A5)", () => {
  const cfg = { maxContextFraction: 0.5, nextPromptTokens: 100 };
  const state = { childSessionID: "ses_child", lastStepTokens: 300, nextModelContext: 1_000 };

  it("resumes under the threshold and reports both numbers", () => {
    expect(resumeDecision(state, cfg)).toEqual({ resume: true, reason: "under-threshold", tokens: 400, budget: 1_000, threshold: 500 });
    expect(resumeDecision({ ...state, lastStepTokens: 399 }, cfg)).toMatchObject({ resume: true, tokens: 499 });
  });

  it("starts fresh exactly at the threshold and above it", () => {
    expect(resumeDecision({ ...state, lastStepTokens: 400 }, cfg)).toEqual({
      resume: false, reason: "at-or-over-threshold", tokens: 500, budget: 1_000, threshold: 500,
    });
    expect(resumeDecision({ ...state, lastStepTokens: 401 }, cfg)).toMatchObject({ resume: false, reason: "at-or-over-threshold" });
  });

  it("decides on tokens / budget, so a fraction whose product is inexact still starts fresh exactly at it (QA-1.5-7)", () => {
    // 0.55 × 200 000 = 110 000.00000000001 and 0.07 × 800 000 = 56 000.00000000001 in doubles.
    expect(0.55 * 200_000).toBeGreaterThan(110_000);
    expect(0.07 * 800_000).toBeGreaterThan(56_000);
    const at = (fraction: number, budget: number, tokens: number) =>
      resumeDecision(
        { childSessionID: "ses_child", lastStepTokens: tokens - 100, nextModelContext: budget },
        { maxContextFraction: fraction, nextPromptTokens: 100 },
      );
    expect(at(0.55, 200_000, 110_000)).toMatchObject({ resume: false, reason: "at-or-over-threshold", tokens: 110_000 });
    expect(at(0.55, 200_000, 109_999)).toMatchObject({ resume: true, reason: "under-threshold" });
    expect(at(0.07, 800_000, 56_000)).toMatchObject({ resume: false, reason: "at-or-over-threshold", tokens: 56_000 });
    expect(at(0.07, 800_000, 55_999)).toMatchObject({ resume: true, reason: "under-threshold" });
    // the threshold is still reported for the log
    expect(at(0.55, 200_000, 110_000).threshold).toBeCloseTo(110_000, 6);
  });
  it("uses the budget it is given (the next model's), not a larger one", () => {
    expect(resumeDecision({ ...state, nextModelContext: 800 }, cfg)).toMatchObject({ resume: false, threshold: 400 });
    expect(resumeDecision({ ...state, nextModelContext: 1_000_000 }, cfg)).toMatchObject({ resume: true, threshold: 500_000 });
  });

  it("starts fresh without a child, even with every number known", () => {
    for (const childSessionID of [null, undefined, ""]) {
      expect(resumeDecision({ ...state, childSessionID }, cfg)).toEqual({
        resume: false, reason: "no-child", tokens: 400, budget: 1_000, threshold: 500,
      });
    }
  });

  it("starts fresh when any input is unknown or invalid", () => {
    expect(resumeDecision({ ...state, lastStepTokens: null }, cfg)).toMatchObject({ resume: false, reason: "unknown-tokens", tokens: null });
    expect(resumeDecision({ ...state, lastStepTokens: -1 }, cfg)).toMatchObject({ resume: false, reason: "unknown-tokens" });
    expect(resumeDecision({ ...state, nextModelContext: null }, cfg)).toMatchObject({ resume: false, reason: "unknown-budget", threshold: null });
    expect(resumeDecision({ ...state, nextModelContext: 0 }, cfg)).toMatchObject({ resume: false, reason: "unknown-budget" });
    expect(resumeDecision(state, { ...cfg, nextPromptTokens: null })).toMatchObject({ resume: false, reason: "unknown-estimate" });
    for (const maxContextFraction of [0, -0.1, 1.5, Number.NaN]) {
      expect(resumeDecision(state, { ...cfg, maxContextFraction })).toMatchObject({ resume: false, reason: "invalid-fraction" });
    }
    expect(resumeDecision({}, cfg)).toMatchObject({ resume: false, reason: "no-child" });
  });

  it("does not mutate its inputs", () => {
    const frozenState = Object.freeze({ ...state });
    const frozenCfg = Object.freeze({ ...cfg });
    expect(resumeDecision(frozenState, frozenCfg).resume).toBe(true);
  });
});
