import { describe, it, expect } from "vitest";
import {
  MIN_MEASURED_USD_SAMPLES,
  addTokens,
  cleanTokenSample,
  compareUnit,
  emptyCostStats,
  emptyTokenSample,
  expectedAttemptUSD,
  foldAttempt,
  isUnpriced,
  mergeCostStats,
  normalizePricing,
  priceTokens,
  pricingState,
  selectPriceEntry,
  stepUSD,
  taxUSD,
  tokenSampleFromEvent,
  updateMean,
  updateTokenMeans,
} from "../../src/routing/outcomes/cost";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import type {
  CostStats,
  ModelPriceEntry,
  ModelPricing,
  OpenAttempt,
  OutcomeKey,
  StepSample,
  TokenMeans,
  TokenSample,
  UnitCandidate,
} from "../../src/routing/outcomes/types";
import { makeKey } from "../../src/routing/outcomes/types";

const KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium");
const M = 50;

const BASE: ModelPriceEntry = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } };
const TIERED: ModelPriceEntry[] = [
  { input: 2.5, output: 15 },
  { tier: { type: "context", size: 272_000 }, input: 5, output: 22.5, cache: { read: 0.5 } },
];

function tokens(partial: Partial<TokenSample> = {}): TokenSample {
  return { ...emptyTokenSample(), ...partial };
}

function attempt(partial: Partial<OpenAttempt> = {}): OpenAttempt {
  return {
    key: KEY,
    attemptID: "child:0",
    steps: 2,
    usd: 0.5,
    usdKnown: true,
    tokens: tokens({ input: 1000, output: 400, reasoning: 100, cacheRead: 200, cacheWrite: 50 }),
    finalOutput: 150,
    lastStepAt: 0,
    ...partial,
  };
}

function stats(partial: Partial<CostStats> = {}): CostStats {
  return { ...emptyCostStats(), ...partial };
}

function profile(partial: Partial<TokenMeans> = {}): TokenMeans {
  return { n: 1, input: 10_000, output: 2_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...partial };
}

describe("pricing normalisation and A1", () => {
  it("normalizePricing: absent → [], one object → [obj], array → filtered copy", () => {
    expect(normalizePricing(undefined)).toEqual([]);
    expect(normalizePricing(null)).toEqual([]);
    const one = normalizePricing(BASE);
    expect(one).toEqual([BASE]);
    expect(one[0]).toBe(BASE);
    const arr: readonly ModelPriceEntry[] = [BASE, TIERED[1]!];
    const copy = normalizePricing(arr);
    expect(copy).toEqual(arr);
    expect(copy).not.toBe(arr);
  });

  it("normalizePricing drops invalid entries", () => {
    const bad = [
      { input: -1, output: 1 },
      { input: Number.NaN, output: 1 },
      { input: 1, output: Number.POSITIVE_INFINITY },
      { input: 1, output: 1, cache: { read: -2 } },
      { input: 1, output: 1, cache: { write: Number.NaN } },
      { input: 1, output: 1, cache: null },
      { input: 1, output: 1, tier: { type: "context", size: 0 } },
      { input: 1, output: 1, tier: { type: "context", size: Number.NaN } },
      { input: 1, output: 1, tier: { type: "weird", size: 10 } },
      { input: 1, output: 1, tier: null },
      { input: "1", output: 1 },
      null,
      42,
    ] as unknown as ModelPricing;
    expect(normalizePricing(bad)).toEqual([]);
    const mixed = [{ input: -1, output: 1 }, BASE] as unknown as ModelPricing;
    expect(normalizePricing(mixed)).toEqual([BASE]);
  });

  it("isUnpriced (A1): empty, undefined and all-zero (every tier) are unpriced", () => {
    expect(isUnpriced([])).toBe(true);
    expect(isUnpriced(undefined)).toBe(true);
    expect(isUnpriced(null)).toBe(true);
    expect(isUnpriced({ input: 0, output: 0 })).toBe(true);
    expect(isUnpriced({ input: 0, output: 0, cache: { read: 0, write: 0 } })).toBe(true);
    expect(
      isUnpriced([
        { input: 0, output: 0 },
        { tier: { type: "context", size: 200_000 }, input: 0, output: 0, cache: { read: 0, write: 0 } },
      ]),
    ).toBe(true);
    expect(isUnpriced([{ input: -1, output: -1 }] as unknown as ModelPricing)).toBe(true);
  });

  it("isUnpriced is false when any entry has any non-zero price", () => {
    expect(isUnpriced(BASE)).toBe(false);
    expect(isUnpriced({ input: 0, output: 0, cache: { read: 0.1 } })).toBe(false);
    expect(isUnpriced({ input: 0, output: 0, cache: { write: 0.1 } })).toBe(false);
    expect(
      isUnpriced([
        { input: 0, output: 0 },
        { tier: { type: "context", size: 1 }, input: 0, output: 1 },
      ]),
    ).toBe(false);
  });

  it("pricingState maps to the PricingState union", () => {
    expect(pricingState(undefined)).toBe("unpriced");
    expect(pricingState(BASE)).toBe("priced");
  });
});

describe("stepUSD (D6 + A1)", () => {
  it("cost 0 on an unpriced model is null (the host default, not a measurement)", () => {
    expect(stepUSD(0, pricingState([]))).toBeNull();
    expect(stepUSD(0, pricingState(undefined))).toBeNull();
    expect(stepUSD(0, "unpriced")).toBeNull();
  });

  it("cost 0 on a priced model stays 0 (a zero-token step)", () => {
    expect(stepUSD(0, "priced")).toBe(0);
  });

  it("a positive cost is kept whether or not the model is priced (host measurement)", () => {
    expect(stepUSD(0.0123, "priced")).toBe(0.0123);
    expect(stepUSD(0.0123, "unpriced")).toBe(0.0123);
  });

  it("invalid raw costs are null", () => {
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(stepUSD(bad, "priced")).toBeNull();
      expect(stepUSD(bad, "unpriced")).toBeNull();
    }
    expect(stepUSD("3" as unknown as number, "priced")).toBeNull();
    expect(stepUSD(undefined as unknown as number, "priced")).toBeNull();
  });
});

describe("tokens", () => {
  it("tokenSampleFromEvent flattens cache.read/cache.write", () => {
    expect(tokenSampleFromEvent({ input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } })).toEqual({
      input: 10,
      output: 20,
      reasoning: 5,
      cacheRead: 7,
      cacheWrite: 3,
    });
  });

  it("non-finite and negative fields become 0, and a missing cache is tolerated", () => {
    expect(
      tokenSampleFromEvent({ input: Number.NaN, output: -3, reasoning: Number.POSITIVE_INFINITY, cache: { read: -1, write: 2 } }),
    ).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 2 });
    expect(tokenSampleFromEvent({ input: 1, output: 2, reasoning: 0 } as unknown as Parameters<typeof tokenSampleFromEvent>[0])).toEqual(
      tokens({ input: 1, output: 2 }),
    );
    expect(cleanTokenSample(tokens({ input: -1, output: Number.NaN, cacheRead: 4 }))).toEqual(tokens({ cacheRead: 4 }));
  });

  it("addTokens sums field by field", () => {
    expect(addTokens(tokens({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }), tokens({ input: 10, cacheWrite: 1 }))).toEqual({
      input: 11,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 6,
    });
  });
});

describe("A10: tiered price lookup", () => {
  it("272 000 tier: 100k → base, 300k → tier", () => {
    expect(selectPriceEntry(TIERED, 100_000)).toBe(TIERED[0]);
    expect(selectPriceEntry(TIERED, 300_000)).toBe(TIERED[1]);
  });

  it("a tier applies strictly above its size (context over N)", () => {
    expect(selectPriceEntry(TIERED, 272_000)).toBe(TIERED[0]);
    expect(selectPriceEntry(TIERED, 272_001)).toBe(TIERED[1]);
  });

  it("tier-only pricing with a small input falls back to the smallest tier", () => {
    const tierOnly: ModelPriceEntry[] = [
      { tier: { type: "context", size: 200_000 }, input: 6, output: 22 },
      { tier: { type: "context", size: 100_000 }, input: 4, output: 18 },
    ];
    expect(selectPriceEntry(tierOnly, 10)).toBe(tierOnly[1]);
    expect(selectPriceEntry(tierOnly, 150_000)).toBe(tierOnly[1]);
    expect(selectPriceEntry(tierOnly, 250_000)).toBe(tierOnly[0]);
  });

  it("the largest matching tier wins regardless of the array order", () => {
    const tiers: ModelPriceEntry[] = [
      { tier: { type: "context", size: 400_000 }, input: 9, output: 9 },
      { input: 1, output: 1 },
      { tier: { type: "context", size: 100_000 }, input: 4, output: 4 },
    ];
    expect(selectPriceEntry(tiers, 500_000)).toBe(tiers[0]);
    expect(selectPriceEntry(tiers, 200_000)).toBe(tiers[2]);
    expect(selectPriceEntry(tiers, 50_000)).toBe(tiers[1]);
  });

  it("returns null without a valid entry and treats a non-finite input as 0", () => {
    expect(selectPriceEntry(undefined, 1000)).toBeNull();
    expect(selectPriceEntry([], 1000)).toBeNull();
    expect(selectPriceEntry(TIERED, Number.NaN)).toBe(TIERED[0]);
    expect(selectPriceEntry(TIERED, Number.POSITIVE_INFINITY)).toBe(TIERED[0]);
  });

  it("priceTokens bills reasoning at the output price and cache at its own prices", () => {
    const usd = priceTokens(BASE, tokens({ input: 1e6, output: 2e5, reasoning: 1e5, cacheRead: 5e5, cacheWrite: 1e5 }));
    expect(usd).toBeCloseTo(3 + 4.5 + 0.15 + 0.375, 12);
  });

  it("priceTokens tolerates absent cache prices (0)", () => {
    expect(priceTokens({ input: 2, output: 4 }, tokens({ input: 1e6, output: 1e6, cacheRead: 1e9, cacheWrite: 1e9 }))).toBeCloseTo(6, 12);
  });
});

describe("running means", () => {
  it("updateMean is an exact arithmetic mean while n ≤ M", () => {
    let s = { mean: 0, n: 0 };
    for (let x = 1; x <= 10; x++) s = updateMean(s, x, 100);
    expect(s.n).toBe(10);
    expect(s.mean).toBeCloseTo(5.5, 12);
    expect(updateMean({ mean: 0, n: 0 }, 7, 100)).toEqual({ mean: 7, n: 1 });
  });

  it("updateMean becomes an EWMA with weight 1/M after M samples, keeping n uncapped", () => {
    let s = { mean: 0, n: 0 };
    for (let i = 0; i < 3; i++) s = updateMean(s, 3, 3);
    expect(s).toEqual({ mean: 3, n: 3 });
    const next = updateMean(s, 6, 3);
    expect(next.n).toBe(4);
    expect(next.mean).toBeCloseTo(3 + (6 - 3) / 3, 12);
    let big = { mean: 3, n: 3 };
    for (let i = 0; i < 400; i++) big = updateMean(big, 10, 3);
    expect(big.n).toBe(403);
    expect(Math.abs(big.mean - 10)).toBeLessThan(1e-9);
  });

  it("updateTokenMeans keeps one mean per field with a shared n", () => {
    let t: TokenMeans = { n: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    t = updateTokenMeans(t, tokens({ input: 100, output: 10, reasoning: 0, cacheRead: 40, cacheWrite: 4 }), M);
    t = updateTokenMeans(t, tokens({ input: 300, output: 30, reasoning: 20, cacheRead: 0, cacheWrite: 8 }), M);
    expect(t.n).toBe(2);
    expect(t.input).toBeCloseTo(200, 12);
    expect(t.output).toBeCloseTo(20, 12);
    expect(t.reasoning).toBeCloseTo(10, 12);
    expect(t.cacheRead).toBeCloseTo(20, 12);
    expect(t.cacheWrite).toBeCloseTo(6, 12);
  });

  it("emptyCostStats starts at zero and returns fresh objects", () => {
    const a = emptyCostStats();
    expect(a).toEqual({
      measuredUSD: { mean: 0, n: 0 },
      unpricedAttempts: 0,
      tokens: { n: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      steps: { mean: 0, n: 0 },
      finalMessageTokens: { mean: 0, n: 0 },
    });
    expect(emptyCostStats()).not.toBe(a);
    expect(emptyCostStats().tokens).not.toBe(a.tokens);
  });
});

describe("foldAttempt", () => {
  it("a measured attempt feeds USD, tokens, steps and the final message", () => {
    const s = foldAttempt(emptyCostStats(), attempt(), M);
    expect(s.measuredUSD).toEqual({ mean: 0.5, n: 1 });
    expect(s.unpricedAttempts).toBe(0);
    expect(s.tokens).toEqual({ n: 1, input: 1000, output: 400, reasoning: 100, cacheRead: 200, cacheWrite: 50 });
    expect(s.steps).toEqual({ mean: 2, n: 1 });
    expect(s.finalMessageTokens).toEqual({ mean: 150, n: 1 });
  });

  it("an unpriced attempt (null step cost) keeps measuredUSD.n and counts toward unpricedAttempts", () => {
    const before = foldAttempt(emptyCostStats(), attempt({ usd: 0.2 }), M);
    const after = foldAttempt(before, attempt({ usdKnown: false, usd: 0, tokens: tokens({ input: 3000, output: 600 }) }), M);
    expect(after.measuredUSD).toEqual(before.measuredUSD);
    expect(after.unpricedAttempts).toBe(1);
    expect(after.tokens.n).toBe(2);
    expect(after.tokens.input).toBeCloseTo((1000 + 3000) / 2, 12);
    expect(after.steps.n).toBe(2);
  });

  it("an attempt with zero steps is never a USD sample", () => {
    const s = foldAttempt(emptyCostStats(), attempt({ steps: 0, usd: 0, usdKnown: true }), M);
    expect(s.measuredUSD.n).toBe(0);
    expect(s.unpricedAttempts).toBe(1);
  });

  it("finalMessageTokens takes only the final step's output, separate from the step-token sums", () => {
    const s = foldAttempt(emptyCostStats(), attempt({ tokens: tokens({ output: 900 }), finalOutput: 120 }), M);
    expect(s.tokens.output).toBe(900);
    expect(s.finalMessageTokens).toEqual({ mean: 120, n: 1 });
  });

  it("an attempt without a final step leaves finalMessageTokens unchanged", () => {
    const first = foldAttempt(emptyCostStats(), attempt({ finalOutput: 100 }), M);
    const second = foldAttempt(first, attempt({ finalOutput: null }), M);
    expect(second.finalMessageTokens).toEqual(first.finalMessageTokens);
    expect(second.tokens.n).toBe(2);
    expect(second.steps.n).toBe(2);
  });

  it("does not mutate the previous statistics", () => {
    const before = emptyCostStats();
    const frozen = JSON.stringify(before);
    foldAttempt(before, attempt(), M);
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("USD samples use the EWMA after M attempts", () => {
    let s = emptyCostStats();
    for (let i = 0; i < 5; i++) s = foldAttempt(s, attempt({ usd: 1 }), 3);
    s = foldAttempt(s, attempt({ usd: 7 }), 3);
    expect(s.measuredUSD.n).toBe(6);
    expect(s.measuredUSD.mean).toBeCloseTo(1 + (7 - 1) / 3, 12);
  });
});

describe("mergeCostStats", () => {
  it("is n-weighted per field and adds unpriced attempts", () => {
    const a = foldAttempt(emptyCostStats(), attempt({ usd: 1, tokens: tokens({ input: 100 }) }), M);
    let b = foldAttempt(emptyCostStats(), attempt({ usd: 4, tokens: tokens({ input: 400 }) }), M);
    b = foldAttempt(b, attempt({ usd: 4, tokens: tokens({ input: 400 }) }), M);
    b = foldAttempt(b, attempt({ usdKnown: false, tokens: tokens({ input: 400 }) }), M);
    const merged = mergeCostStats(a, b);
    expect(merged.measuredUSD.n).toBe(3);
    expect(merged.measuredUSD.mean).toBeCloseTo((1 + 4 + 4) / 3, 12);
    expect(merged.unpricedAttempts).toBe(1);
    expect(merged.tokens.n).toBe(4);
    expect(merged.tokens.input).toBeCloseTo((100 + 400 * 3) / 4, 12);
  });

  it("merging with an empty side is the identity and n = 0 stays at mean 0", () => {
    const a = foldAttempt(emptyCostStats(), attempt(), M);
    expect(mergeCostStats(a, emptyCostStats())).toEqual(a);
    expect(mergeCostStats(emptyCostStats(), emptyCostStats())).toEqual(emptyCostStats());
  });
});

describe("D5 unit rule (compareUnit)", () => {
  const cand = (partial: Partial<UnitCandidate> = {}): UnitCandidate => ({
    key: KEY as OutcomeKey,
    priced: false,
    measuredUSD: { mean: 0, n: 0 },
    tokenSamples: 0,
    ...partial,
  });

  it("no candidates → ratio", () => {
    expect(compareUnit([])).toBe("ratio");
  });

  it("0 priced candidates → ratio", () => {
    expect(compareUnit([cand(), cand()])).toBe("ratio");
  });

  it("1 of 2 usable → ratio (units are never mixed)", () => {
    expect(compareUnit([cand({ priced: true, tokenSamples: 4 }), cand()])).toBe("ratio");
  });

  it("all priced with a token profile → usd", () => {
    expect(compareUnit([cand({ priced: true, tokenSamples: 1 }), cand({ priced: true, tokenSamples: 9 })])).toBe("usd");
  });

  it("an unpriced candidate with n ≥ 3 measured attempts is usd-comparable", () => {
    const measured = cand({ measuredUSD: { mean: 0.2, n: MIN_MEASURED_USD_SAMPLES } });
    expect(compareUnit([measured])).toBe("usd");
    expect(compareUnit([cand({ measuredUSD: { mean: 0.2, n: MIN_MEASURED_USD_SAMPLES - 1 } })])).toBe("ratio");
    expect(compareUnit([measured, cand({ priced: true, tokenSamples: 2 })])).toBe("usd");
  });

  it("priced without a token profile and n < 3 → ratio (C1)", () => {
    expect(compareUnit([cand({ priced: true, tokenSamples: 0, measuredUSD: { mean: 0.1, n: 2 } })])).toBe("ratio");
  });
});

describe("expectedAttemptUSD (D8 c_k)", () => {
  it("n ≥ 3 measured attempts → the measured mean, even for an unpriced model", () => {
    expect(expectedAttemptUSD(stats({ measuredUSD: { mean: 0.37, n: 3 } }), undefined, null)).toBe(0.37);
  });

  it("an unpriced model with fewer than 3 measured attempts has no USD estimate", () => {
    expect(expectedAttemptUSD(stats({ measuredUSD: { mean: 0.37, n: 2 }, tokens: profile() }), undefined, profile())).toBeNull();
  });

  it("priced with its own token profile → profile priced at the selected entry", () => {
    const s = stats({ tokens: profile({ input: 10_000, output: 2_000 }), steps: { mean: 1, n: 1 } });
    expect(expectedAttemptUSD(s, BASE, null)).toBeCloseTo((10_000 * 3 + 2_000 * 15) / 1e6, 12);
  });

  it("priced with no own tokens uses the class profile; with neither → null", () => {
    expect(expectedAttemptUSD(stats(), BASE, profile({ input: 1_000_000, output: 0 }))).toBeCloseTo(3, 12);
    expect(expectedAttemptUSD(stats(), BASE, null)).toBeNull();
    expect(expectedAttemptUSD(stats(), BASE, profile({ n: 0 }))).toBeNull();
  });

  it("uses the mean context per request (tokens / steps) to pick the tier", () => {
    const heavy = profile({ input: 600_000, output: 0 });
    const oneStep = stats({ tokens: heavy, steps: { mean: 1, n: 3 } });
    const fourSteps = stats({ tokens: heavy, steps: { mean: 4, n: 3 } });
    expect(expectedAttemptUSD(oneStep, TIERED, null)).toBeCloseTo((600_000 * 5) / 1e6, 12); // 600k > 272k tier
    expect(expectedAttemptUSD(fourSteps, TIERED, null)).toBeCloseTo((600_000 * 2.5) / 1e6, 12); // 150k per request → base
  });

  it("defaults steps to 1 when none were measured", () => {
    const s = stats({ tokens: profile({ input: 300_000, output: 0 }) });
    expect(expectedAttemptUSD(s, TIERED, null)).toBeCloseTo((300_000 * 5) / 1e6, 12);
  });

  it("invariant: whenever compareUnit says usd, every expectedAttemptUSD is non-null", () => {
    let seed = 20261006;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const pricings: ModelPricing[] = [undefined, [], { input: 0, output: 0 }, BASE, TIERED, [{ input: -1, output: 1 }] as unknown as ModelPricing];
    let usdSets = 0;
    for (let iter = 0; iter < 3000; iter++) {
      const classProfile = rnd(2) === 0 ? null : profile({ n: 1 + rnd(5) });
      const set = Array.from({ length: 1 + rnd(3) }, () => {
        const pricing = pricings[rnd(pricings.length)];
        const own = rnd(2) === 0 ? profile({ n: 1 + rnd(4) }) : profile({ n: 0 });
        const measured = { mean: rnd(100) / 100, n: rnd(6) };
        const s = stats({ tokens: own, measuredUSD: measured, steps: rnd(2) === 0 ? { mean: 1 + rnd(3), n: 1 } : { mean: 0, n: 0 } });
        const candidate: UnitCandidate = {
          key: KEY,
          priced: pricingState(pricing) === "priced",
          measuredUSD: s.measuredUSD,
          tokenSamples: s.tokens.n > 0 ? s.tokens.n : (classProfile?.n ?? 0),
        };
        return { s, pricing, candidate };
      });
      if (compareUnit(set.map((c) => c.candidate)) === "usd") {
        usdSets++;
        for (const c of set) expect(expectedAttemptUSD(c.s, c.pricing, classProfile)).not.toBeNull();
      }
    }
    expect(usdSets).toBeGreaterThan(50);
  });
});

describe("taxUSD (D8)", () => {
  const ORCH: ModelPricing = [{ input: 15, output: 75, cache: { read: 1.5, write: 18.75 } }];

  it("is null until a final message was measured (D8: 0 until measured)", () => {
    expect(taxUSD({ mean: 0, n: 0 }, 10, ORCH, 50_000)).toBeNull();
  });

  it("is null for an unpriced orchestrator model", () => {
    expect(taxUSD({ mean: 500, n: 2 }, 10, undefined, 50_000)).toBeNull();
    expect(taxUSD({ mean: 500, n: 2 }, 10, { input: 0, output: 0 }, 50_000)).toBeNull();
  });

  it("final-message tokens × remaining turns × cache-read price", () => {
    expect(taxUSD({ mean: 500, n: 2 }, 10, ORCH, 50_000)).toBeCloseTo((500 * 10 * 1.5) / 1e6, 15);
  });

  it("picks the orchestrator tier by its context size (A10)", () => {
    const tiered: ModelPricing = [
      { input: 3, output: 15, cache: { read: 0.3 } },
      { tier: { type: "context", size: 200_000 }, input: 6, output: 22, cache: { read: 0.6 } },
    ];
    expect(taxUSD({ mean: 1000, n: 1 }, 1, tiered, 100_000)).toBeCloseTo((1000 * 0.3) / 1e6, 15);
    expect(taxUSD({ mean: 1000, n: 1 }, 1, tiered, 250_000)).toBeCloseTo((1000 * 0.6) / 1e6, 15);
  });

  it("negative or non-finite remaining turns count as 0 and a missing cache price as 0", () => {
    expect(taxUSD({ mean: 500, n: 1 }, -3, ORCH, 0)).toBe(0);
    expect(taxUSD({ mean: 500, n: 1 }, Number.NaN, ORCH, 0)).toBe(0);
    expect(taxUSD({ mean: 500, n: 1 }, 5, { input: 1, output: 1 }, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Through the store (added with store.ts): D6/A1 exclusion and the final-message separation.
// ---------------------------------------------------------------------------

describe("cost accounting through the outcome store", () => {
  const sample = (attemptID: string, partial: Partial<StepSample> = {}): StepSample => ({
    attemptID,
    cost: 0.1,
    pricing: "priced",
    tokens: tokens({ input: 100, output: 10 }),
    final: false,
    ...partial,
  });

  it("cost == 0 with empty pricing is null: excluded from the means, tokens still counted", () => {
    const store = createOutcomeStore({ now: () => 0 });
    store.recordStep(KEY, sample("a", { cost: 0, pricing: pricingState([]), final: true }));
    store.recordStep(KEY, sample("b", { cost: 0.4, pricing: "priced", final: true }));
    const c = store.cost(KEY);
    expect(c.measuredUSD).toEqual({ mean: 0.4, n: 1 });
    expect(c.unpricedAttempts).toBe(1);
    expect(c.tokens.n).toBe(2);
  });

  it("token means per field over attempts", () => {
    const store = createOutcomeStore({ now: () => 0 });
    store.recordStep(KEY, sample("a", { tokens: tokens({ input: 100, output: 20, reasoning: 4, cacheRead: 10, cacheWrite: 2 }), final: true }));
    store.recordStep(KEY, sample("b", { tokens: tokens({ input: 300, output: 40, reasoning: 8, cacheRead: 30, cacheWrite: 6 }), final: true }));
    expect(store.cost(KEY).tokens).toEqual({ n: 2, input: 200, output: 30, reasoning: 6, cacheRead: 20, cacheWrite: 4 });
  });

  it("finalMessageTokens only takes the final step; closeAttempt without a final step leaves it unchanged", () => {
    const store = createOutcomeStore({ now: () => 0 });
    store.recordStep(KEY, sample("a", { tokens: tokens({ output: 500 }) }));
    store.recordStep(KEY, sample("a", { tokens: tokens({ output: 80 }), final: true }));
    expect(store.cost(KEY).finalMessageTokens).toEqual({ mean: 80, n: 1 });
    expect(store.cost(KEY).tokens.output).toBe(580);
    store.recordStep(KEY, sample("b", { tokens: tokens({ output: 900 }) }));
    store.closeAttempt("b");
    expect(store.cost(KEY).finalMessageTokens).toEqual({ mean: 80, n: 1 });
    expect(store.cost(KEY).tokens.n).toBe(2);
  });

  it("expectedAttemptUSD prices a store-built profile at the catalog entry", () => {
    const store = createOutcomeStore({ now: () => 0 });
    store.recordStep(KEY, sample("a", { cost: 0, pricing: "unpriced", tokens: tokens({ input: 1_000_000, output: 100_000 }), final: true }));
    const usd = expectedAttemptUSD(store.cost(KEY), BASE, store.classTokenProfile("implement"));
    expect(usd).toBeCloseTo(3 + 1.5, 12);
    expect(expectedAttemptUSD(store.cost(KEY), undefined, store.classTokenProfile("implement"))).toBeNull();
  });
});
