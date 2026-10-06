import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  advance,
  buildEscalatePolicy,
  buildLadderForcingMessage,
  formatLadderScorecard,
  newLadderState,
  nextAction,
  recordAttempt,
  resumeDecision as ladderResumeDecision,
  type EscalatePolicy,
  type LadderAction,
  type LadderSessionPolicyInput,
  type LadderState,
  type LadderVerdict,
  type TierVariantInfo,
} from "../../src/escalate/ladder";
import {
  DEFAULT_VARIANT,
  HOST_EFFORT_ORDER,
  catalogVariantIds,
  estimateTokensFromChars,
  modelRef,
  resumeDecision,
  type CatalogModel,
} from "../../src/escalate/variants";
import { EFFORT_LEVELS, type EnforcementConfig, type RouterConfig, type TierConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-4-5";
const PLAIN = "anthropic/no-variants";
const LUNA_FAST = "openai/gpt-6-luna-fast";

const entry = (variants: string[], limit?: CatalogModel["limit"]): CatalogModel => ({
  variants: variants.map((id) => ({ id })),
  limit,
});

// Live variant lists recorded by Phase 0.P S4 (host effort order).
const CATALOG: Record<string, CatalogModel> = {
  [SONNET]: entry(["low", "medium", "high", "xhigh", "max"], { input: 1_000_000, context: 1_000_000, output: 64_000 }),
  // No limit.input: the budget is context - output = 800 000 (A10).
  [OPUS]: entry(["low", "medium", "high", "xhigh", "max"], { context: 1_000_000, output: 200_000 }),
  [HAIKU]: entry(["high", "max"], { input: 200_000 }),
  [PLAIN]: { limit: { input: 100_000 } },
  [LUNA_FAST]: entry(["none", "low", "medium", "high", "xhigh", "max"], { input: 272_000 }),
};
const lookup = (model: string): CatalogModel | undefined => (Object.hasOwn(CATALOG, model) ? CATALOG[model] : undefined);
const V2: LadderSessionPolicyInput = { host: "v2", catalog: lookup };

function makeConfig(tiers: Record<string, TierConfig>, escalate: EnforcementConfig["escalate"] = {}): RouterConfig {
  return {
    activePreset: "anthropic",
    presets: { anthropic: tiers },
    rules: [],
    defaultTier: "fast",
    enforcement: { escalate },
  };
}

// The owner's `anthropic` preset (plan §3 1.5, F4/F5).
const OWNER: Record<string, TierConfig> = {
  fast: { model: SONNET, variant: "low", costRatio: 1 },
  medium: { model: SONNET, variant: "medium", costRatio: 5 },
  heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
};

// The live `hybrid-2` preset (plan §1.5 owner traces).
const HYBRID2: Record<string, TierConfig> = {
  fast: { model: LUNA_FAST, variant: "medium", costRatio: 1 },
  medium: { model: SONNET, variant: "xhigh", costRatio: 5 },
  heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
};

function info(
  model: string,
  base: string,
  variants: string[],
  budget: number | null = 1_000_000,
  costRatios: Record<string, number> = {},
): TierVariantInfo {
  return { model, base, ladder: { model, variants, source: "catalog", rejected: [], foreign: [] }, inputBudget: budget, costRatios };
}

function handPolicy(
  perTier: Record<string, TierVariantInfo>,
  over: Partial<EscalatePolicy> = {},
  maxContextFraction = 0.6,
): EscalatePolicy {
  return {
    ladder: ["fast", "medium", "heavy"],
    floorTier: null,
    maxAttemptsPerTier: 1,
    maxTotalAttempts: 10,
    costMultiple: null,
    variants: { maxContextFraction, perTier },
    ...over,
  };
}

function sessionState(over: Partial<LadderState> = {}): LadderState {
  return {
    currentTier: "fast",
    attemptsThisTier: 0,
    totalAttempts: 1,
    escalations: 0,
    firstAttemptCost: 1,
    cumulativeCost: 1,
    currentVariant: null,
    variantSteps: 0,
    childSessionID: null,
    lastStepTokens: null,
    nextModelContext: null,
    ...over,
  };
}

const fail: LadderVerdict = { pass: false, outcome: "fail", reasons: ["check failed"] };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drives the real loop: record an attempt (with a child), ask for the next action, advance. */
/** What the runner charges for the next attempt (A17): the action's rung ratio, else the tier's own. */
const chargeBy = (tiers: Record<string, TierConfig>) => (rung: { tier: string; action: LadderAction | null }): number =>
  rung.action?.costRatio ?? tiers[rung.tier]!.costRatio!;

function runLoop(
  policy: EscalatePolicy,
  options: {
    producer?: string;
    charge?: (rung: { tier: string; action: LadderAction | null }) => number;
    tokens?: number | null;
    promptChars?: number;
  } = {},
) {
  let state = newLadderState(options.producer ?? policy.ladder[0]!, policy);
  const actions: LadderAction[] = [];
  const states: LadderState[] = [];
  let previous: LadderAction | null = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    states.push(state);
    state = recordAttempt(state, options.charge?.({ tier: state.currentTier, action: previous }) ?? 1, {
      sessionID: `ses_${attempt + 1}`,
      lastStepTokens: options.tokens === undefined ? 1000 : options.tokens,
    });
    const action = nextAction(state, fail, policy, { dispatchPromptChars: options.promptChars ?? 0 });
    actions.push(action);
    if (action.action === "give_up" || action.action === "accept") return { state, actions, states };
    state = advance(state, action);
    previous = action;
  }
  throw new Error("loop did not terminate");
}

/** The `model#variant` each attempt of a runLoop run executes: the start tier's base, then every action. */
function attemptTrace(policy: EscalatePolicy, run: ReturnType<typeof runLoop>): string[] {
  const start = run.states[0]!;
  const first = policy.variants!.perTier[start.currentTier]!;
  const rungs = [modelRef(first.model, first.base)];
  for (const action of run.actions) {
    if (action.action === "retry" || action.action === "escalate") rungs.push(modelRef(action.model!, action.variant));
  }
  return rungs;
}

// ---------------------------------------------------------------------------
// buildEscalatePolicy(cfg, session?)
// ---------------------------------------------------------------------------

describe("buildEscalatePolicy with session input", () => {
  const cfg = makeConfig(OWNER);

  it("builds one TierVariantInfo per eligible tier on v2 (owner preset, catalog capped at xhigh)", () => {
    const policy = buildEscalatePolicy(cfg, V2);
    expect(policy.variants?.maxContextFraction).toBe(0.6);
    expect(Object.keys(policy.variants!.perTier)).toEqual(["fast", "medium", "heavy"]);
    const { fast, medium, heavy } = policy.variants!.perTier;
    expect(fast).toMatchObject({ model: SONNET, base: "low", inputBudget: 1_000_000 });
    expect(fast!.ladder.variants).toEqual(["low", "medium", "high", "xhigh"]);
    expect(fast!.ladder.source).toBe("catalog");
    expect(medium).toMatchObject({ model: SONNET, base: "medium" });
    expect(heavy).toMatchObject({ model: OPUS, base: "xhigh", inputBudget: 800_000 });
    expect(policy).not.toHaveProperty("effortBump");
  });

  it("leaves the variants key absent for one argument, v1, variantSteps none and a catalog without variants", () => {
    const base = JSON.stringify(buildEscalatePolicy(cfg));
    for (const session of [
      undefined,
      { host: "v1", catalog: lookup } satisfies LadderSessionPolicyInput,
      { host: "v2", variantSteps: "none", catalog: lookup } satisfies LadderSessionPolicyInput,
      { host: "v2", catalog: () => undefined } satisfies LadderSessionPolicyInput,
      { host: "v2", catalog: () => null } satisfies LadderSessionPolicyInput,
      { host: "v2", catalog: () => ({ limit: { input: 1000 } }) } satisfies LadderSessionPolicyInput,
    ]) {
      const policy = buildEscalatePolicy(cfg, session);
      expect(policy).not.toHaveProperty("variants");
      expect(JSON.stringify(policy)).toBe(base);
    }
  });

  it("treats variantSteps auto and an omitted variantSteps the same", () => {
    expect(JSON.stringify(buildEscalatePolicy(cfg, { ...V2, variantSteps: "auto" }))).toBe(
      JSON.stringify(buildEscalatePolicy(cfg, V2)),
    );
  });

  it("gives an effort-configured tier an empty ladder, its budget and its model, and keeps its effortBump (QA-1.5-6, QA-1.5-8)", () => {
    const policy = buildEscalatePolicy(
      makeConfig({
        fast: { model: SONNET, effort: "low" },
        medium: { model: SONNET, variant: "medium" },
        heavy: { model: OPUS, thinking: { budgetTokens: 8000 } },
      }),
      V2,
    );
    expect(Object.keys(policy.variants!.perTier)).toEqual(["fast", "medium", "heavy"]);
    for (const tier of ["fast", "heavy"]) {
      const effortTier = policy.variants!.perTier[tier]!;
      expect(effortTier.ladder).toMatchObject({ variants: [], source: "none" });
      expect(effortTier.base).toBe(DEFAULT_VARIANT);
    }
    expect(policy.variants!.perTier.fast!.inputBudget).toBe(1_000_000);
    expect(policy.variants!.perTier.heavy!.inputBudget).toBe(800_000);
    expect(policy.variants!.perTier.medium!.ladder.variants).not.toEqual([]);
    expect(Object.keys(policy.effortBump?.perTier ?? {})).toContain("fast");
    // exclusivity: a tier in both places never has a variant to step to
    for (const tier of Object.keys(policy.variants!.perTier)) {
      if (Object.keys(policy.effortBump?.perTier ?? {}).includes(tier)) {
        expect(policy.variants!.perTier[tier]!.ladder.variants).toEqual([]);
      }
    }
  });

  it("an effort-configured tier retries with its effort bump and its model, never a variant step", () => {
    const policy = buildEscalatePolicy(
      makeConfig({ fast: { model: SONNET, effort: "low" }, medium: { model: OPUS, variant: "high" } }, { maxTotalAttempts: 10, costCeiling: { multiple: 1000 } }),
      V2,
    );
    const retry = nextAction(sessionState({ currentVariant: null, nextModelContext: 1_000_000 }), fail, policy);
    expect(retry).toMatchObject({ action: "retry", tier: "fast", effort: "medium", model: SONNET, resume: false });
    expect(retry).not.toHaveProperty("variantStep");
    expect(retry).not.toHaveProperty("variant");
    // escalating into it knows its budget, so a resume can be decided
    const escalate = nextAction(
      sessionState({ currentTier: "medium", attemptsThisTier: 1, currentVariant: "high", childSessionID: "ses_a", lastStepTokens: 10 }),
      fail,
      buildEscalatePolicy(makeConfig({ fast: { model: OPUS, variant: "high" }, medium: { model: SONNET, effort: "low" } }), V2),
    );
    expect(escalate.resumeBasis).toMatchObject({ budget: null });
  });

  it("builds info with an empty ladder for a model whose catalog entry has no variants (QA-1.5-6)", () => {
    const policy = buildEscalatePolicy(makeConfig({ fast: { model: PLAIN }, medium: { model: SONNET } }), V2);
    expect(policy.variants!.perTier.fast).toMatchObject({
      model: PLAIN,
      base: DEFAULT_VARIANT,
      inputBudget: 100_000,
      ladder: { variants: [], source: "none" },
    });
    const retry = nextAction(sessionState({ attemptsThisTier: 0 }), fail, policy);
    expect(retry).toMatchObject({ action: "retry", model: PLAIN });
    expect(retry).not.toHaveProperty("variantStep");
    const escalate = nextAction(sessionState({ attemptsThisTier: 1, childSessionID: "ses_a", lastStepTokens: 10 }), fail, policy);
    expect(escalate.resumeBasis).toMatchObject({ budget: 1_000_000 }); // medium's own budget
    const toPlain = nextAction(
      sessionState({ currentTier: "medium", attemptsThisTier: 1, currentVariant: "xhigh", childSessionID: "ses_a", lastStepTokens: 10 }),
      fail,
      buildEscalatePolicy(makeConfig({ medium: { model: SONNET }, heavy: { model: PLAIN } }, { ladder: ["medium", "heavy"] }), V2),
    );
    expect(toPlain).toMatchObject({ action: "escalate", tier: "heavy", model: PLAIN });
    expect(toPlain.resumeBasis).toMatchObject({ budget: 100_000, reason: "under-threshold" });
  });

  it("keeps the policy key off when every tier lacks a catalog entry, and omits only the tiers without one", () => {
    expect(buildEscalatePolicy(makeConfig({ fast: { model: "x/unknown" } }), V2)).not.toHaveProperty("variants");
    const policy = buildEscalatePolicy(makeConfig({ fast: { model: "x/unknown" }, medium: { model: SONNET } }), V2);
    expect(Object.keys(policy.variants!.perTier)).toEqual(["medium"]);
  });

  it("treats a throwing catalog lookup as no catalog entry, logs it and keeps the other tiers (QA-1.5-15)", () => {
    const warnings: string[] = [];
    const policy = buildEscalatePolicy(makeConfig({ fast: { model: "x/boom" }, medium: { model: SONNET } }), {
      host: "v2",
      catalog: (model) => {
        if (model === "x/boom") throw new Error("catalog exploded");
        return lookup(model);
      },
      warn: (message) => warnings.push(message),
    });
    expect(Object.keys(policy.variants!.perTier)).toEqual(["medium"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("x/boom");
    expect(warnings[0]).toContain("catalog exploded");
    // no logger, a logger that throws, and a thrown non-Error are all survivable
    const throwing = { host: "v2", catalog: () => { throw "plain string"; } } satisfies LadderSessionPolicyInput;
    expect(() => buildEscalatePolicy(makeConfig(OWNER), throwing)).not.toThrow();
    expect(buildEscalatePolicy(makeConfig(OWNER), throwing)).not.toHaveProperty("variants");
    expect(() => buildEscalatePolicy(makeConfig(OWNER), { ...throwing, warn: () => { throw new Error("logger down"); } })).not.toThrow();
  });
  it("keeps a tier with both a variant and an effort on the variant path", () => {
    const policy = buildEscalatePolicy(makeConfig({ fast: { model: SONNET, variant: "low", effort: "low" } }), V2);
    expect(Object.keys(policy.variants!.perTier)).toEqual(["fast"]);
    expect(policy).not.toHaveProperty("effortBump");
  });

  it("omits a tier whose configured variant is absent from the catalog", () => {
    const policy = buildEscalatePolicy(
      makeConfig({ fast: { model: SONNET, variant: "turbo" }, medium: { model: SONNET, variant: "medium" } }),
      V2,
    );
    expect(Object.keys(policy.variants!.perTier)).toEqual(["medium"]);
    expect(buildEscalatePolicy(makeConfig({ fast: { model: SONNET, variant: "turbo" } }), V2)).not.toHaveProperty("variants");
    // `default` is never a catalog member either.
    expect(buildEscalatePolicy(makeConfig({ fast: { model: SONNET, variant: "default" } }), V2)).not.toHaveProperty("variants");
  });

  it("uses base default for a tier without a variant and without effort configuration", () => {
    const policy = buildEscalatePolicy(makeConfig({ fast: { model: SONNET }, medium: { model: HAIKU, variant: "" } }), V2);
    expect(policy.variants!.perTier.fast!.base).toBe(DEFAULT_VARIANT);
    expect(policy.variants!.perTier.medium!.base).toBe(DEFAULT_VARIANT);
    // haiku's catalog is [high, max]; the default effortBumpMax (xhigh) caps the ladder at high (F2).
    expect(policy.variants!.perTier.medium!.ladder.variants).toEqual(["high"]);
    expect(
      buildEscalatePolicy(makeConfig({ fast: { model: HAIKU } }, { effortBumpMax: "max" }), V2).variants!.perTier.fast!.ladder.variants,
    ).toEqual(["high", "max"]);
  });

  it("caps catalog ladders at effortBumpMax and defaults the cap to xhigh", () => {
    const tiers = { fast: { model: SONNET } };
    expect(buildEscalatePolicy(makeConfig(tiers, { effortBumpMax: "high" }), V2).variants!.perTier.fast!.ladder.variants)
      .toEqual(["low", "medium", "high"]);
    expect(buildEscalatePolicy(makeConfig(tiers), V2).variants!.perTier.fast!.ladder.variants)
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(buildEscalatePolicy(makeConfig(tiers, { effortBumpMax: "max" }), V2).variants!.perTier.fast!.ladder.variants)
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("honours the raw candidates field, uncapped, and ignores a non-array", () => {
    const withCandidates = { model: SONNET, candidates: [{ variant: "medium" }, { variant: "max" }, { variant: "turbo" }] };
    const policy = buildEscalatePolicy(makeConfig({ fast: withCandidates }, { effortBumpMax: "high" }), V2);
    const ladder = policy.variants!.perTier.fast!.ladder;
    expect(ladder.variants).toEqual(["medium", "max"]);
    expect(ladder.source).toBe("candidates");
    expect(ladder.rejected).toEqual(["turbo"]);
    const notArray = { model: SONNET, candidates: { variant: "max" } };
    expect(buildEscalatePolicy(makeConfig({ fast: notArray }), V2).variants!.perTier.fast!.ladder.source).toBe("catalog");
  });

  it("a candidates array without a rung of the tier's model leaves no variant steps and reports the other rungs (QA-1.5-5)", () => {
    const otherOnly = { model: SONNET, candidates: [{ model: OPUS, variant: "high" }] };
    const policy = buildEscalatePolicy(makeConfig({ fast: otherOnly }), V2);
    const ladder = policy.variants!.perTier.fast!.ladder;
    expect(ladder).toMatchObject({ variants: [], source: "candidates", foreign: [{ model: OPUS, variant: "high" }] });
    expect(nextAction(sessionState({ attemptsThisTier: 0 }), fail, policy)).not.toHaveProperty("variantStep");
  });
  it("reads the budget from the catalog (limit.input, or context - output) and null when unknown", () => {
    const policy = buildEscalatePolicy(
      makeConfig({
        fast: { model: SONNET },
        medium: { model: OPUS },
        heavy: { model: "anthropic/unlimited" },
      }),
      { host: "v2", catalog: (model) => (model === "anthropic/unlimited" ? entry(["high"]) : lookup(model)) },
    );
    expect(policy.variants!.perTier.fast!.inputBudget).toBe(1_000_000);
    expect(policy.variants!.perTier.medium!.inputBudget).toBe(800_000);
    expect(policy.variants!.perTier.heavy!.inputBudget).toBeNull();
  });

  it("defaults maxContextFraction to 0.6 and passes a configured one through", () => {
    expect(buildEscalatePolicy(cfg, V2).variants!.maxContextFraction).toBe(0.6);
    expect(buildEscalatePolicy(cfg, { ...V2, maxContextFraction: 0.35 }).variants!.maxContextFraction).toBe(0.35);
  });

  it("skips tiers without a usable model and null tiers", () => {
    const tiers = JSON.parse(
      `{"fast":{"model":""},"medium":null,"heavy":{"model":7},"ultra":{"model":"${SONNET}"}}`,
    ) as Record<string, TierConfig>;
    const policy = buildEscalatePolicy(makeConfig(tiers), V2);
    expect(Object.keys(policy.variants!.perTier)).toEqual(["ultra"]);
  });

  it("makes prototype-named tiers own entries and never reads inherited ones", () => {
    const tiers = JSON.parse(
      `{"__proto__":{"model":"${SONNET}","variant":"low"},"constructor":{"model":"${OPUS}","variant":"high"}}`,
    ) as Record<string, TierConfig>;
    const policy = buildEscalatePolicy(makeConfig(tiers), V2);
    const perTier = policy.variants!.perTier;
    expect(Object.prototype.hasOwnProperty.call(perTier, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(perTier, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(perTier)).toBe(Object.prototype);

    // A ladder that names an inherited key must not pick up Object.prototype members.
    const hand = handPolicy({ fast: info(SONNET, "high", ["high", "xhigh"]) }, { ladder: ["toString", "fast"] });
    const action = nextAction(sessionState({ currentTier: "toString", attemptsThisTier: 1 }), fail, hand);
    expect(action).toMatchObject({ action: "escalate", tier: "fast", agent: "fast", model: SONNET, variant: "high" });
    const same = nextAction(sessionState({ currentTier: "constructor" }), fail, handPolicy({}, { ladder: ["constructor", "fast"] }));
    expect(same).toMatchObject({ action: "retry", tier: "constructor" });
    expect(same).not.toHaveProperty("variantStep");
    expect(same).not.toHaveProperty("model");
  });

  it("returns a policy whose variants object is JSON-stable across calls", () => {
    expect(JSON.stringify(buildEscalatePolicy(cfg, V2))).toBe(JSON.stringify(buildEscalatePolicy(cfg, V2)));
  });
});

// ---------------------------------------------------------------------------
// newLadderState / recordAttempt
// ---------------------------------------------------------------------------

describe("newLadderState and recordAttempt on a session-aware policy", () => {
  it("initialises the five session fields", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER), V2);
    expect(newLadderState("fast", policy)).toEqual({
      currentTier: "fast",
      attemptsThisTier: 0,
      totalAttempts: 0,
      escalations: 0,
      firstAttemptCost: null,
      cumulativeCost: 0,
      currentVariant: null,
      variantSteps: 0,
      childSessionID: null,
      lastStepTokens: null,
      nextModelContext: 1_000_000,
    });
  });

  it("takes nextModelContext from the start tier after floorTier raises it", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER, { floorTier: "heavy" }), V2);
    const state = newLadderState("fast", policy);
    expect(state.currentTier).toBe("heavy");
    expect(state.nextModelContext).toBe(800_000);
  });

  it("uses a null budget when the start tier has no catalog entry", () => {
    const policy = buildEscalatePolicy(makeConfig({ fast: { model: SONNET, effort: "low" }, medium: { model: SONNET } }), V2);
    // the effort tier now has info (an empty ladder), so its budget is known (QA-1.5-6)
    expect(newLadderState("fast", policy).nextModelContext).toBe(1_000_000);
    expect(newLadderState("fast", policy)).toHaveProperty("childSessionID", null);
    const unknown = buildEscalatePolicy(makeConfig({ fast: { model: "x/unknown" }, medium: { model: SONNET } }), V2);
    expect(newLadderState("fast", unknown).nextModelContext).toBeNull();
    expect(newLadderState("fast", unknown)).toHaveProperty("childSessionID", null);
  });

  it("adds no key without a variant policy", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER));
    expect(Object.keys(newLadderState("fast", policy))).toEqual([
      "currentTier", "attemptsThisTier", "totalAttempts", "escalations", "firstAttemptCost", "cumulativeCost",
    ]);
  });

  it("records the child only on a session-aware state", () => {
    const aware = sessionState({ totalAttempts: 0, firstAttemptCost: null, cumulativeCost: 0 });
    const recorded = recordAttempt(aware, 2, { sessionID: "ses_a", lastStepTokens: 1234 });
    expect(recorded).toMatchObject({ totalAttempts: 1, cumulativeCost: 2, firstAttemptCost: 2, childSessionID: "ses_a", lastStepTokens: 1234 });
    // No child argument: nothing changes but the counters.
    expect(recordAttempt(aware, 2)).toEqual({ ...recorded, childSessionID: null, lastStepTokens: null });
    // A non-session state ignores the observation entirely.
    const plain: LadderState = {
      currentTier: "fast", attemptsThisTier: 0, totalAttempts: 0, escalations: 0, firstAttemptCost: null, cumulativeCost: 0,
    };
    const ignored = recordAttempt(plain, 2, { sessionID: "ses_a", lastStepTokens: 1234 });
    expect(ignored).toEqual(recordAttempt(plain, 2));
    expect(ignored).not.toHaveProperty("childSessionID");
    expect(ignored).not.toHaveProperty("lastStepTokens");
  });

  it("records an unknown token count as null", () => {
    expect(recordAttempt(sessionState(), 1, { sessionID: "ses_a", lastStepTokens: null }).lastStepTokens).toBeNull();
  });

  it("re-exports resumeDecision from ladder.ts", () => {
    expect(ladderResumeDecision).toBe(resumeDecision);
  });
});

// ---------------------------------------------------------------------------
// nextAction: D10 variant steps
// ---------------------------------------------------------------------------

describe("nextAction variant steps (5V)", () => {
  const perTier = { fast: info(SONNET, "high", ["high", "xhigh"]), medium: info(OPUS, "medium", ["medium", "high"]) };

  it("steps to the next ladder variant, marked variantStep, with model and resume fields", () => {
    const action = nextAction(sessionState(), fail, handPolicy(perTier));
    expect(action).toMatchObject({
      action: "retry",
      tier: "fast",
      variantStep: true,
      model: SONNET,
      variant: "xhigh",
      resume: false,
    });
    expect(action.forcingMessage).toBe(buildLadderForcingMessage(["check failed"]));
    expect(action.resumeBasis).toMatchObject({ resume: false, reason: "no-child" });
    expect(action).not.toHaveProperty("agent");
    expect(action).not.toHaveProperty("effort");
  });

  it("steps from default to the lowest variant ranked high or above (A9)", () => {
    const policy = handPolicy({ fast: info(SONNET, DEFAULT_VARIANT, ["low", "medium", "high", "xhigh"]) });
    expect(nextAction(sessionState(), fail, policy)).toMatchObject({ variantStep: true, variant: "high" });
    const haiku = handPolicy({ fast: info(HAIKU, DEFAULT_VARIANT, ["high"]) });
    expect(nextAction(sessionState(), fail, haiku)).toMatchObject({ variantStep: true, variant: "high" });
  });

  it("goes straight to retry/escalate when a default-based ladder tops out below high", () => {
    const policy = handPolicy({ fast: info(SONNET, DEFAULT_VARIANT, ["low", "medium"]) });
    const action = nextAction(sessionState(), fail, policy);
    expect(action).toMatchObject({ action: "retry", model: SONNET });
    expect(action).not.toHaveProperty("variantStep");
    expect(action).not.toHaveProperty("variant");
    expect(nextAction(sessionState({ attemptsThisTier: 1 }), fail, handPolicy({ fast: info(SONNET, DEFAULT_VARIANT, ["low", "medium"]) }, { ladder: ["fast", "medium"] })))
      .toMatchObject({ action: "escalate", tier: "medium", agent: "medium" });
  });

  it("continues from the reached variant, then stops at the top", () => {
    const policy = handPolicy({ fast: info(SONNET, "low", ["low", "medium", "high"]) }, { maxAttemptsPerTier: 0 });
    expect(nextAction(sessionState({ currentVariant: "medium" }), fail, policy)).toMatchObject({ variantStep: true, variant: "high" });
    const top = nextAction(sessionState({ currentVariant: "high" }), fail, policy);
    expect(top).toMatchObject({ action: "escalate", tier: "medium" });
    expect(top).not.toHaveProperty("variantStep");
  });

  it("is not gated by attemptsThisTier: a hand-built attemptsThisTier === maxAttemptsPerTier still steps", () => {
    const policy = handPolicy(perTier, { maxAttemptsPerTier: 1 });
    expect(nextAction(sessionState({ attemptsThisTier: 1 }), fail, policy)).toMatchObject({ action: "retry", variantStep: true, variant: "xhigh" });
    expect(nextAction(sessionState({ attemptsThisTier: 5 }), fail, policy)).toMatchObject({ action: "retry", variantStep: true });
  });

  it("falls back to a plain retry without a variant when the reached variant is not emittable", () => {
    const policy = handPolicy(perTier);
    const action = nextAction(sessionState({ currentVariant: "turbo" }), fail, policy);
    expect(action).toMatchObject({ action: "retry", tier: "fast", model: SONNET });
    expect(action).not.toHaveProperty("variantStep");
    expect(action).not.toHaveProperty("variant");
    const asDefault = nextAction(sessionState({ currentVariant: DEFAULT_VARIANT }), fail, handPolicy(perTier, { maxAttemptsPerTier: 1 }));
    expect(asDefault).not.toHaveProperty("variant", DEFAULT_VARIANT);
  });

  it("keeps the reached variant on a fresh plain retry and the base otherwise", () => {
    const policy = handPolicy(perTier);
    expect(nextAction(sessionState({ currentVariant: "xhigh" }), fail, policy)).toMatchObject({
      action: "retry", model: SONNET, variant: "xhigh",
    });
    const flat = handPolicy({ fast: info(SONNET, "high", ["high"]) });
    expect(nextAction(sessionState(), fail, flat)).toMatchObject({ action: "retry", model: SONNET, variant: "high" });
    const bare = handPolicy({ fast: info(SONNET, DEFAULT_VARIANT, []) });
    expect(nextAction(sessionState(), fail, bare)).not.toHaveProperty("variant");
  });

  it("runs after accept, unverifiable, max total attempts and the cost ceiling", () => {
    const policy = handPolicy(perTier, { maxTotalAttempts: 2, costMultiple: 4 });
    expect(nextAction(sessionState(), { pass: true }, policy)).toEqual({ action: "accept" });
    expect(nextAction(sessionState(), { pass: false, outcome: "unverifiable" }, policy)).toEqual({
      action: "give_up",
      reason: "verification unavailable; no producer escalation",
    });
    expect(nextAction(sessionState({ totalAttempts: 2 }), fail, policy)).toEqual({
      action: "give_up",
      reason: "max total attempts (2) reached",
    });
    expect(nextAction(sessionState({ totalAttempts: 1, firstAttemptCost: 1, cumulativeCost: 5 }), fail, policy)).toEqual({
      action: "give_up",
      reason: "cost ceiling exceeded",
    });
  });

  it("gives up on max total attempts before the cost ceiling when both apply", () => {
    const policy = handPolicy(perTier, { maxTotalAttempts: 2, costMultiple: 4 });
    expect(nextAction(sessionState({ totalAttempts: 2, firstAttemptCost: 1, cumulativeCost: 99 }), fail, policy)).toEqual({
      action: "give_up",
      reason: "max total attempts (2) reached",
    });
  });

  it("stops after one variant step when maxTotalAttempts is 2", () => {
    const policy = handPolicy({ fast: info(SONNET, "low", ["low", "medium", "high", "xhigh"]) }, { maxTotalAttempts: 2, ladder: ["fast"] });
    const run = runLoop(policy);
    expect(run.actions.map((a) => a.action)).toEqual(["retry", "give_up"]);
    expect(run.actions[0]).toMatchObject({ variantStep: true, variant: "medium" });
    expect(run.actions[1]).toEqual({ action: "give_up", reason: "max total attempts (2) reached" });
  });

  it("gives up above the cost ceiling with a variant available, and steps exactly at it", () => {
    const policy = handPolicy(perTier, { costMultiple: 4 });
    const above = nextAction(sessionState({ firstAttemptCost: 2, cumulativeCost: 9 }), fail, policy);
    expect(above).toEqual({ action: "give_up", reason: "cost ceiling exceeded" });
    const at = nextAction(sessionState({ firstAttemptCost: 2, cumulativeCost: 8 }), fail, policy);
    expect(at).toMatchObject({ action: "retry", variantStep: true, variant: "xhigh" });
  });

  it("never returns retry or escalate above the cost ceiling in a long variant ladder", () => {
    const policy = handPolicy({ fast: info(SONNET, "low", ["low", "medium", "high", "xhigh", "max"]) }, { costMultiple: 2, maxTotalAttempts: 20 });
    const run = runLoop(policy);
    // first=1, ceiling 2: cumulative 3 on the third attempt exceeds it.
    expect(run.actions.map((a) => a.action)).toEqual(["retry", "retry", "give_up"]);
    expect(run.actions[2]).toEqual({ action: "give_up", reason: "cost ceiling exceeded" });
  });
});

// ---------------------------------------------------------------------------
// Attempt accounting (§9) and the maxAttemptsPerTier interplay
// ---------------------------------------------------------------------------

describe("attempt accounting", () => {
  const perTier = { fast: info(SONNET, "high", ["high", "xhigh"]), medium: info(OPUS, "medium", ["medium"]) };

  it("maxAttemptsPerTier 1 yields retry(variantStep) → retry → escalate", () => {
    const run = runLoop(handPolicy(perTier, { maxAttemptsPerTier: 1 }), { producer: "fast" });
    expect(run.actions.slice(0, 3).map((a) => [a.action, a.variantStep === true, a.variant])).toEqual([
      ["retry", true, "xhigh"],
      ["retry", false, "xhigh"],
      ["escalate", false, "medium"],
    ]);
    expect(run.actions[2]).toMatchObject({ tier: "medium", agent: "medium", model: OPUS, variant: "medium" });
  });

  it("maxAttemptsPerTier 0 yields retry(variantStep) → escalate", () => {
    const run = runLoop(handPolicy(perTier, { maxAttemptsPerTier: 0 }), { producer: "fast" });
    expect(run.actions.slice(0, 2).map((a) => [a.action, a.variantStep === true])).toEqual([
      ["retry", true],
      ["escalate", false],
    ]);
  });

  it("a variant step does not touch attemptsThisTier and bumps variantSteps; a plain retry is the opposite", () => {
    const state = sessionState({ attemptsThisTier: 0, variantSteps: 0 });
    const step = advance(state, { action: "retry", tier: "fast", variantStep: true, variant: "xhigh", resume: false });
    expect(step).toMatchObject({ attemptsThisTier: 0, variantSteps: 1, currentVariant: "xhigh", totalAttempts: 1, escalations: 0 });
    const plain = advance(step, { action: "retry", tier: "fast", resume: false });
    expect(plain).toMatchObject({ attemptsThisTier: 1, variantSteps: 1, currentVariant: "xhigh" });
    const escalated = advance(plain, { action: "escalate", tier: "medium", resume: false });
    expect(escalated).toMatchObject({
      currentTier: "medium", attemptsThisTier: 0, escalations: 1, variantSteps: 1, currentVariant: null, totalAttempts: 1,
    });
  });

  it("advance never changes totalAttempts, cumulativeCost or firstAttemptCost", () => {
    const state = sessionState({ totalAttempts: 3, cumulativeCost: 7, firstAttemptCost: 2 });
    for (const action of [
      { action: "retry", tier: "fast", variantStep: true, variant: "xhigh" },
      { action: "retry", tier: "fast" },
      { action: "escalate", tier: "medium" },
    ] satisfies LadderAction[]) {
      expect(advance(state, action)).toMatchObject({ totalAttempts: 3, cumulativeCost: 7, firstAttemptCost: 2 });
    }
  });

  it("returns accept and give_up states unchanged", () => {
    const state = sessionState({ childSessionID: "ses_a", lastStepTokens: 10 });
    expect(advance(state, { action: "accept" })).toBe(state);
    expect(advance(state, { action: "give_up", reason: "x" })).toBe(state);
  });

  it("a variant step with no variant resets currentVariant to null instead of leaving undefined", () => {
    expect(advance(sessionState({ currentVariant: "high" }), { action: "retry", variantStep: true })).toMatchObject({ currentVariant: null });
  });

  it("counts variant steps toward the total in the real loop and ends within maxTotalAttempts", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER), V2);
    const run = runLoop(policy);
    // A17: fast#low, fast#medium (variant step); the reserve forces an escalation to medium (it still has
    // headroom above the reached variant, QA-1.5-4) and then to heavy.
    expect(run.state.totalAttempts).toBe(4);
    expect(run.state.variantSteps).toBe(1);
    expect(run.state.attemptsThisTier).toBe(0);
    expect(run.state.escalations).toBe(2);
    expect(run.state.currentTier).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// D11: resume decisions on retry and escalate
// ---------------------------------------------------------------------------

describe("resume decisions", () => {
  const top = { fast: info(SONNET, "xhigh", ["xhigh"], 1_000_000), medium: info(OPUS, "medium", ["medium"], 1_000_000) };
  const escalateState = (over: Partial<LadderState> = {}) =>
    sessionState({ attemptsThisTier: 1, childSessionID: "ses_a", lastStepTokens: 1000, ...over });

  it("escalate carries resume true under the threshold", () => {
    const action = nextAction(escalateState(), fail, handPolicy(top), { dispatchPromptChars: 400 });
    expect(action).toMatchObject({ action: "escalate", tier: "medium", agent: "medium", model: OPUS, variant: "medium", resume: true });
    const forcing = buildLadderForcingMessage(["check failed"]);
    expect(action.resumeBasis).toEqual({
      resume: true,
      reason: "under-threshold",
      tokens: 1000 + Math.ceil((forcing.length + 400) / 4),
      budget: 1_000_000,
      threshold: 0.6 * 1_000_000,
    });
  });

  it("starts fresh exactly at the threshold, computed from the real forcing message length", () => {
    const forcing = buildLadderForcingMessage(fail.reasons ?? []);
    const dispatchPromptChars = 4001;
    const estimate = estimateTokensFromChars(forcing.length + dispatchPromptChars)!;
    const policy = handPolicy(top, {}, 0.5);
    const budget = 1_000_000;
    const threshold = 0.5 * budget;

    const at = nextAction(escalateState({ lastStepTokens: threshold - estimate }), fail, policy, { dispatchPromptChars });
    expect(at).toMatchObject({ action: "escalate", resume: false });
    expect(at.resumeBasis).toEqual({ resume: false, reason: "at-or-over-threshold", tokens: threshold, budget, threshold });

    const under = nextAction(escalateState({ lastStepTokens: threshold - estimate - 1 }), fail, policy, { dispatchPromptChars });
    expect(under).toMatchObject({ resume: true });
    expect(under.resumeBasis).toMatchObject({ reason: "under-threshold", tokens: threshold - 1 });

    const over = nextAction(escalateState({ lastStepTokens: threshold - estimate + 1 }), fail, policy, { dispatchPromptChars });
    expect(over).toMatchObject({ resume: false });
    expect(over.resumeBasis).toMatchObject({ reason: "at-or-over-threshold", tokens: threshold + 1 });
  });

  it("includes the dispatch prompt in the estimate and uses the forcing message alone without it", () => {
    const policy = handPolicy(top, {}, 0.5);
    const forcing = buildLadderForcingMessage(["check failed"]);
    const without = nextAction(escalateState(), fail, policy);
    const withPrompt = nextAction(escalateState(), fail, policy, { dispatchPromptChars: 40_000 });
    expect(without.resumeBasis!.tokens).toBe(1000 + Math.ceil(forcing.length / 4));
    expect(withPrompt.resumeBasis!.tokens).toBe(1000 + Math.ceil((forcing.length + 40_000) / 4));
    // Enough prompt to cross the threshold flips the decision.
    const big = nextAction(escalateState(), fail, policy, { dispatchPromptChars: 4_000_000 });
    expect(big.resume).toBe(false);
    expect(without.resume).toBe(true);
  });

  it("uses the NEXT model's budget, not the current tier's", () => {
    const forcing = buildLadderForcingMessage(["check failed"]);
    const estimate = estimateTokensFromChars(forcing.length)!;
    const lastStepTokens = 450_000 - estimate; // total 450 000: under 500 000 (1M) but over 400 000 (800k)
    const toSmaller = handPolicy(
      { fast: info(SONNET, "xhigh", ["xhigh"], 1_000_000), medium: info(OPUS, "medium", ["medium"], 800_000) },
      {},
      0.5,
    );
    const down = nextAction(escalateState({ lastStepTokens }), fail, toSmaller);
    expect(down).toMatchObject({ action: "escalate", resume: false });
    expect(down.resumeBasis).toMatchObject({ reason: "at-or-over-threshold", budget: 800_000, threshold: 400_000, tokens: 450_000 });

    const toBigger = handPolicy(
      { fast: info(SONNET, "xhigh", ["xhigh"], 800_000), medium: info(OPUS, "medium", ["medium"], 1_000_000) },
      {},
      0.5,
    );
    const up = nextAction(escalateState({ lastStepTokens }), fail, toBigger);
    expect(up).toMatchObject({ action: "escalate", resume: true });
    expect(up.resumeBasis).toMatchObject({ reason: "under-threshold", budget: 1_000_000, threshold: 500_000 });
  });

  it("starts fresh without a child, with unknown tokens and with an invalid fraction", () => {
    const policy = handPolicy(top);
    const noChild = nextAction(escalateState({ childSessionID: null }), fail, policy);
    expect(noChild).toMatchObject({ action: "escalate", resume: false });
    expect(noChild.resumeBasis).toMatchObject({ reason: "no-child" });
    expect(nextAction(escalateState({ childSessionID: "" }), fail, policy).resumeBasis).toMatchObject({ reason: "no-child" });
    expect(nextAction(escalateState({ lastStepTokens: null }), fail, policy).resumeBasis).toMatchObject({ resume: false, reason: "unknown-tokens" });
    expect(nextAction(escalateState(), fail, handPolicy(top, {}, 1.5)).resumeBasis).toMatchObject({ resume: false, reason: "invalid-fraction" });
    expect(nextAction(escalateState(), fail, handPolicy(top, {}, 0)).resumeBasis).toMatchObject({ resume: false, reason: "invalid-fraction" });
  });

  it("escalating to a tier without variant info keeps agent, drops model and variant, and starts fresh (unknown-budget)", () => {
    const policy = handPolicy({ fast: info(SONNET, "xhigh", ["xhigh"]) }); // medium has no info (e.g. effort-configured)
    const action = nextAction(escalateState(), fail, policy);
    expect(action).toMatchObject({ action: "escalate", tier: "medium", agent: "medium", resume: false });
    expect(action).not.toHaveProperty("model");
    expect(action).not.toHaveProperty("variant");
    expect(action.resumeBasis).toMatchObject({ resume: false, reason: "unknown-budget", budget: null });
  });

  it("starts fresh when the target's budget is unknown", () => {
    const policy = handPolicy({ fast: info(SONNET, "xhigh", ["xhigh"]), medium: info(OPUS, "medium", ["medium"], null) });
    const action = nextAction(escalateState(), fail, policy);
    expect(action).toMatchObject({ resume: false, model: OPUS });
    expect(action.resumeBasis).toMatchObject({ reason: "unknown-budget" });
  });

  it("decides a retry against the current tier's own budget", () => {
    const policy = handPolicy({ fast: info(SONNET, "high", ["high", "xhigh"], 100_000) });
    const under = nextAction(sessionState({ childSessionID: "ses_a", lastStepTokens: 1000 }), fail, policy);
    expect(under).toMatchObject({ variantStep: true, resume: true });
    expect(under.resumeBasis).toMatchObject({ budget: 100_000, threshold: 60_000 });
    const over = nextAction(sessionState({ childSessionID: "ses_a", lastStepTokens: 60_000 }), fail, policy);
    expect(over).toMatchObject({ variantStep: true, resume: false });
  });

  it("attaches resume to a plain retry as well", () => {
    const policy = handPolicy({ fast: info(SONNET, "high", ["high"]) });
    const action = nextAction(sessionState({ childSessionID: "ses_a", lastStepTokens: 10 }), fail, policy);
    expect(action).toMatchObject({ action: "retry", resume: true, model: SONNET, variant: "high" });
    expect(action.resumeBasis?.resume).toBe(true);
  });

  it("attaches resume and resumeBasis to every retry and escalate, and to nothing else", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER, { maxTotalAttempts: 10, costCeiling: { multiple: 40 } }), V2);
    const run = runLoop(policy);
    for (const action of run.actions) {
      if (action.action === "retry" || action.action === "escalate") {
        expect(typeof action.resume).toBe("boolean");
        expect(action.resumeBasis?.resume).toBe(action.resume);
      } else {
        expect(action).not.toHaveProperty("resume");
        expect(action).not.toHaveProperty("resumeBasis");
      }
    }
  });

  it("ignores the session argument and adds no variant fields without policy.variants", () => {
    const policy: EscalatePolicy = {
      ladder: ["fast", "medium", "heavy"], floorTier: null, maxAttemptsPerTier: 1, maxTotalAttempts: 4, costMultiple: null,
    };
    const plainState: LadderState = {
      currentTier: "fast", attemptsThisTier: 1, totalAttempts: 1, escalations: 0, firstAttemptCost: 1, cumulativeCost: 1,
    };
    const withSession = nextAction(plainState, fail, policy, { dispatchPromptChars: 1_000_000 });
    expect(JSON.stringify(withSession)).toBe(JSON.stringify(nextAction(plainState, fail, policy)));
    expect(withSession).toEqual({
      action: "escalate",
      tier: "medium",
      forcingMessage: buildLadderForcingMessage(["check failed"]),
    });
    const retry = nextAction({ ...plainState, attemptsThisTier: 0 }, fail, { ...policy, variants: null }, { dispatchPromptChars: 5 });
    expect(Object.keys(retry)).toEqual(["action", "tier", "forcingMessage"]);
  });
});

// ---------------------------------------------------------------------------
// Stale child sessions (advance / applySession / recordAttempt)
// ---------------------------------------------------------------------------

describe("child session bookkeeping", () => {
  const policy = handPolicy({ fast: info(SONNET, "high", ["high", "xhigh"]), medium: info(OPUS, "medium", ["medium", "high"]) });

  it("clears the child after an advance with resume false, and the next action is no-child", () => {
    let state = sessionState({ childSessionID: "ses_a", lastStepTokens: 99_000_000, nextModelContext: 1_000_000 });
    const action = nextAction(state, fail, policy);
    expect(action).toMatchObject({ variantStep: true, resume: false });
    state = advance(state, action);
    expect(state.childSessionID).toBeNull();
    expect(state.lastStepTokens).toBeNull();
    // Without a new observation the next decision reports no child.
    const next = nextAction(recordAttempt(state, 1), fail, policy);
    expect(next.resumeBasis).toMatchObject({ resume: false, reason: "no-child" });
  });

  it("allows resume again after recordAttempt observes the new child", () => {
    let state = sessionState({ childSessionID: "ses_a", lastStepTokens: 99_000_000 });
    state = advance(state, nextAction(state, fail, policy));
    expect(state.childSessionID).toBeNull();
    state = recordAttempt(state, 1, { sessionID: "ses_b", lastStepTokens: 2000 });
    expect(state).toMatchObject({ childSessionID: "ses_b", lastStepTokens: 2000 });
    const next = nextAction(state, fail, handPolicy(policy.variants!.perTier, { maxAttemptsPerTier: 0 }));
    expect(next.resume).toBe(true);
  });

  it("keeps the child on a resumed advance but always clears lastStepTokens", () => {
    const state = sessionState({ childSessionID: "ses_a", lastStepTokens: 500 });
    const action = nextAction(state, fail, policy);
    expect(action.resume).toBe(true);
    const advanced = advance(state, action);
    expect(advanced.childSessionID).toBe("ses_a");
    expect(advanced.lastStepTokens).toBeNull();
    // A runner that forgets to record the resumed attempt gets a fresh start, never a stale number.
    expect(nextAction(advanced, fail, policy).resumeBasis).toMatchObject({ resume: false, reason: "unknown-tokens" });
  });

  it("clears lastStepTokens on every kind of advance", () => {
    const state = sessionState({ childSessionID: "ses_a", lastStepTokens: 500 });
    for (const action of [
      { action: "retry", tier: "fast", variantStep: true, variant: "xhigh", resume: true },
      { action: "retry", tier: "fast", resume: true },
      { action: "retry", tier: "fast", resume: false },
      { action: "escalate", tier: "medium", resume: true },
      { action: "escalate", tier: "medium", resume: false },
    ] satisfies LadderAction[]) {
      expect(advance(state, action).lastStepTokens).toBeNull();
    }
  });

  it("stores the next model's budget in nextModelContext", () => {
    const state = sessionState({ attemptsThisTier: 1, childSessionID: "ses_a", lastStepTokens: 1 });
    const top = handPolicy({ fast: info(SONNET, "xhigh", ["xhigh"], 1_000_000), medium: info(OPUS, "medium", ["medium"], 800_000) });
    const action = nextAction(state, fail, top);
    expect(advance(state, action).nextModelContext).toBe(800_000);
    // An action without resumeBasis (hand-built) falls back to null.
    expect(advance(state, { action: "escalate", tier: "medium" }).nextModelContext).toBeNull();
    expect(advance(state, { action: "escalate", tier: "medium" }).childSessionID).toBeNull();
  });

  it("does not add session keys when advancing a non-session state", () => {
    const plain: LadderState = {
      currentTier: "fast", attemptsThisTier: 0, totalAttempts: 1, escalations: 0, firstAttemptCost: 1, cumulativeCost: 1,
    };
    const retried = advance(plain, { action: "retry", tier: "fast", resume: true });
    const escalated = advance(plain, { action: "escalate", tier: "medium", resume: false });
    for (const next of [retried, escalated]) {
      for (const key of ["childSessionID", "lastStepTokens", "nextModelContext", "currentVariant", "variantSteps"]) {
        expect(next).not.toHaveProperty(key);
      }
    }
    expect(Object.keys(retried)).toEqual(Object.keys(plain));
  });
});

// ---------------------------------------------------------------------------
// Same-model escalation (F4) and loop guards
// ---------------------------------------------------------------------------

describe("skipCoveredTiers (F4)", () => {
  const sameModel = {
    fast: info(SONNET, "low", ["low", "medium", "high", "xhigh"]),
    medium: info(SONNET, "medium", ["low", "medium", "high", "xhigh"]),
    heavy: info(OPUS, "xhigh", ["low", "medium", "high", "xhigh"], 800_000),
  };

  it("passes over a same-model tier whose base the current tier already covered", () => {
    const covered = sessionState({ attemptsThisTier: 1, currentVariant: "xhigh" });
    const action = nextAction(covered, fail, handPolicy(sameModel, { maxAttemptsPerTier: 1 }));
    // currentVariant is on the ladder top, so no variant step; the escalation skips medium.
    expect(action).toMatchObject({ action: "escalate", tier: "heavy", agent: "heavy", model: OPUS, variant: "xhigh" });
  });

  it("does not skip a same-model tier whose base is above the reached variant", () => {
    const action = nextAction(
      sessionState({ attemptsThisTier: 1 }),
      fail,
      handPolicy({ ...sameModel, fast: info(SONNET, "low", []) }, { maxAttemptsPerTier: 1 }),
    );
    expect(action).toMatchObject({ action: "escalate", tier: "medium", agent: "medium", model: SONNET, variant: "medium" });
  });

  it("does not skip a tier on a different model", () => {
    const action = nextAction(
      sessionState({ attemptsThisTier: 1, currentVariant: "xhigh" }),
      fail,
      handPolicy({ ...sameModel, medium: info(OPUS, "low", ["low"]) }),
    );
    expect(action).toMatchObject({ action: "escalate", tier: "medium", model: OPUS, variant: "low" });
  });

  it("gives up when every later tier is covered", () => {
    const covered = { fast: sameModel.fast, medium: sameModel.medium, heavy: info(SONNET, "high", ["low", "medium", "high", "xhigh"]) };
    const action = nextAction(sessionState({ attemptsThisTier: 1, currentVariant: "xhigh" }), fail, handPolicy(covered));
    expect(action).toEqual({ action: "give_up", reason: "no higher tier (already at top of ladder)" });
  });

  it("treats a default-based same-model tier as covered by default", () => {
    const policy = handPolicy({ fast: info(SONNET, DEFAULT_VARIANT, []), medium: info(SONNET, DEFAULT_VARIANT, []), heavy: info(OPUS, "high", ["high"]) });
    expect(nextAction(sessionState({ attemptsThisTier: 1 }), fail, policy)).toMatchObject({ action: "escalate", tier: "heavy" });
  });

  it("does not skip when the reached variant is unranked", () => {
    const action = nextAction(sessionState({ attemptsThisTier: 1, currentVariant: "turbo" }), fail, handPolicy(sameModel));
    expect(action).toMatchObject({ action: "escalate", tier: "medium" });
  });

  it("terminates with give_up on a duplicate-ladder [fast, fast] with a covered tier", () => {
    const policy = handPolicy({ fast: info(SONNET, "low", ["low", "medium"]) }, { ladder: ["fast", "fast"] });
    const action = nextAction(sessionState({ attemptsThisTier: 1, currentVariant: "medium" }), fail, policy);
    expect(action).toEqual({ action: "give_up", reason: "no higher tier (already at top of ladder)" });
    const larger = handPolicy({ fast: info(SONNET, "low", ["low", "medium"]) }, { ladder: ["fast", "fast", "fast", "fast"] });
    expect(nextAction(sessionState({ attemptsThisTier: 1, currentVariant: "medium" }), fail, larger)).toMatchObject({ action: "give_up" });
  });

  it("skips from a tier without info nothing (no info means today's behaviour)", () => {
    const policy = handPolicy({ medium: sameModel.medium });
    expect(nextAction(sessionState({ attemptsThisTier: 1 }), fail, policy)).toMatchObject({ action: "escalate", tier: "medium" });
  });
});

describe("covered tiers (QA-1.5-3, QA-1.5-4)", () => {
  const GENEROUS = { maxTotalAttempts: 10, costCeiling: { multiple: 1000 } };

  it("QA-1.5-3 probe: a default-based fast does not cover sonnet#medium, so medium is tried before heavy", () => {
    const tiers: Record<string, TierConfig> = {
      fast: { model: SONNET },
      medium: { model: SONNET, variant: "medium" },
      heavy: { model: OPUS, variant: "high" },
    };
    const policy = buildEscalatePolicy(makeConfig(tiers, { ...GENEROUS, effortBumpMax: "medium" }), V2);
    expect(policy.variants!.perTier.fast!.ladder.variants).toEqual(["low", "medium"]); // nothing above default
    const run = runLoop(policy);
    // medium is at the top of its capped ladder, so it retries once before heavy.
    expect(attemptTrace(policy, run).slice(0, 5)).toEqual([SONNET, SONNET, `${SONNET}#medium`, `${SONNET}#medium`, `${OPUS}#high`]);
    expect(run.actions[1]).toMatchObject({ action: "escalate", tier: "medium", agent: "medium", variant: "medium" });
    expect(run.actions[1]).not.toHaveProperty("carryVariant");
  });

  it("covers a default-based tier only from high upwards, and a ranked base from its own rank downwards", () => {
    const heavy = info(OPUS, "high", ["high"], 800_000);
    const at = (reached: string, toBase: string) =>
      nextAction(
        sessionState({ attemptsThisTier: 1, currentVariant: reached }),
        fail,
        handPolicy({ fast: info(SONNET, "low", []), medium: info(SONNET, toBase, []), heavy }),
      );
    // default as the target base: covered by high/xhigh/max, not by medium or below
    expect(at("high", DEFAULT_VARIANT)).toMatchObject({ action: "escalate", tier: "heavy" });
    expect(at("xhigh", DEFAULT_VARIANT)).toMatchObject({ action: "escalate", tier: "heavy" });
    expect(at("medium", DEFAULT_VARIANT)).toMatchObject({ action: "escalate", tier: "medium" });
    expect(at("low", DEFAULT_VARIANT)).toMatchObject({ action: "escalate", tier: "medium" });
    // ranked target base: covered iff it is at or below the reached rank
    expect(at("medium", "medium")).toMatchObject({ tier: "heavy" });
    expect(at("medium", "low")).toMatchObject({ tier: "heavy" });
    expect(at("medium", "high")).toMatchObject({ tier: "medium" });
    // default as the reached variant covers nothing but default itself
    const fromDefault = (toBase: string) =>
      nextAction(sessionState({ attemptsThisTier: 1 }), fail, handPolicy({ fast: info(SONNET, DEFAULT_VARIANT, []), medium: info(SONNET, toBase, []), heavy }));
    expect(fromDefault("low")).toMatchObject({ tier: "medium" });
    expect(fromDefault("none")).toMatchObject({ tier: "medium" });
    expect(fromDefault("high")).toMatchObject({ tier: "medium" });
    expect(fromDefault(DEFAULT_VARIANT)).toMatchObject({ tier: "heavy" });
  });

  const probeTiers: Record<string, TierConfig> = {
    fast: { model: SONNET, variant: "xhigh" },
    medium: { model: SONNET, variant: "low", ...{ candidates: [{ variant: "low" }, { variant: "max" }] } },
    heavy: { model: OPUS, variant: "xhigh" },
  };

  it("QA-1.5-4 probe: a covered tier whose ladder still reaches max is tried, at the reached variant, and steps on to max", () => {
    const policy = buildEscalatePolicy(makeConfig(probeTiers, GENEROUS), V2);
    expect(policy.variants!.perTier.medium!.ladder).toMatchObject({ variants: ["low", "max"], source: "candidates" });
    const run = runLoop(policy);
    expect(run.actions.slice(0, 3).map((a) => [a.action, a.tier, a.variant, a.variantStep === true, a.carryVariant === true])).toEqual([
      ["retry", "fast", "xhigh", false, false], // fast is at the top of its capped ladder: a plain retry
      ["escalate", "medium", "xhigh", false, true], // covered (low <= xhigh) but max is above: kept, at the reached variant
      ["retry", "medium", "max", true, false], // the tier's own step continues upwards from the reached variant
    ]);
    expect(attemptTrace(policy, run).slice(0, 4)).toEqual([`${SONNET}#xhigh`, `${SONNET}#xhigh`, `${SONNET}#xhigh`, `${SONNET}#max`]);
    expect(run.states[2]).toMatchObject({ currentTier: "medium", currentVariant: "xhigh" }); // seeded by advance
    expect(formatLadderScorecard(run.states[2]!, false, "m")).toContain("final_tier=medium#xhigh |");
  });

  it("seeds currentVariant on a carried escalation and on nothing else", () => {
    const state = sessionState({ attemptsThisTier: 1, currentVariant: "xhigh", childSessionID: "ses_a" });
    const carried = advance(state, { action: "escalate", tier: "medium", variant: "xhigh", carryVariant: true, resume: true });
    expect(carried).toMatchObject({ currentTier: "medium", currentVariant: "xhigh" });
    const plain = advance(state, { action: "escalate", tier: "medium", variant: "low", resume: true });
    expect(plain.currentVariant).toBeNull();
    const toDefault = advance(state, { action: "escalate", tier: "medium", carryVariant: true });
    expect(toDefault.currentVariant).toBeNull();
    const noSession: LadderState = {
      currentTier: "fast", attemptsThisTier: 1, totalAttempts: 1, escalations: 0, firstAttemptCost: 1, cumulativeCost: 1,
    };
    expect(advance(noSession, { action: "escalate", tier: "medium", variant: "xhigh", carryVariant: true })).not.toHaveProperty("currentVariant");
  });

  it("still skips a covered tier whose ladder has nothing above the reached variant", () => {
    const tiers: Record<string, TierConfig> = {
      ...probeTiers,
      medium: { model: SONNET, variant: "low", ...{ candidates: [{ variant: "low" }, { variant: "high" }] } },
    };
    const policy = buildEscalatePolicy(makeConfig(tiers, GENEROUS), V2);
    const action = nextAction(sessionState({ attemptsThisTier: 1, currentVariant: "xhigh" }), fail, policy);
    expect(action).toMatchObject({ action: "escalate", tier: "heavy", model: OPUS, variant: "xhigh" });
    expect(action).not.toHaveProperty("carryVariant");
  });

  it("emits the reached variant of the current tier, never a variant outside the catalog", () => {
    const policy = buildEscalatePolicy(makeConfig(probeTiers, GENEROUS), V2);
    const action = nextAction(sessionState({ attemptsThisTier: 1, currentVariant: "turbo" }), fail, policy);
    // an unranked reached variant is neither covered nor emittable: the tier is entered at its own base
    expect(action).toMatchObject({ action: "escalate", tier: "medium", variant: "low" });
    expect(action).not.toHaveProperty("carryVariant");
  });
});
// ---------------------------------------------------------------------------
// Owner preset trace (plan §3 1.5 "owner preset trace", F5)
// ---------------------------------------------------------------------------

describe("owner preset trace", () => {
  const ratios = (tiers: Record<string, TierConfig>) => ({ charge: chargeBy(tiers) });
  const GENEROUS = { costCeiling: { multiple: 1000 } };

  it("anthropic preset, default budget and real ratios: sonnet#low, sonnet#medium, sonnet#medium (medium role), then the ceiling stops it", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER), V2);
    expect(policy.maxTotalAttempts).toBe(4);
    expect(policy.costMultiple).toBe(4);
    const run = runLoop(policy, ratios(OWNER));
    // The reserve (A17) escalates after fast#medium. The medium tier is the same model and its base is the
    // reached variant, but its ladder still has high/xhigh above it (QA-1.5-4), so it is tried, at the reached
    // variant, under the medium role. Its ratio 5 takes the cumulative cost to 1 + 1 + 5 = 7 > 1 × 4.
    expect(attemptTrace(policy, run)).toEqual([`${SONNET}#low`, `${SONNET}#medium`, `${SONNET}#medium`]);
    expect(run.actions.map((a) => [a.action, a.tier, a.variantStep === true, a.costRatio])).toEqual([
      ["retry", "fast", true, 1],
      ["escalate", "medium", false, 5],
      ["give_up", undefined, false, undefined],
    ]);
    expect(run.actions[2]).toEqual({ action: "give_up", reason: "cost ceiling exceeded" });
    expect(run.state.cumulativeCost).toBe(7);
  });

  it("anthropic preset, default budget without the cost ceiling: sonnet#low, sonnet#medium, sonnet#medium, opus#xhigh", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER, GENEROUS), V2);
    const run = runLoop(policy, ratios(OWNER));
    expect(attemptTrace(policy, run)).toEqual([`${SONNET}#low`, `${SONNET}#medium`, `${SONNET}#medium`, `${OPUS}#xhigh`]);
    expect(run.actions.map((a) => [a.action, a.tier, a.variantStep === true])).toEqual([
      ["retry", "fast", true],
      ["escalate", "medium", false],
      ["escalate", "heavy", false],
      ["give_up", undefined, false],
    ]);
    expect(run.actions[3]).toEqual({ action: "give_up", reason: "max total attempts (4) reached" });
    expect(formatLadderScorecard(run.state, false, "owner")).toContain("final_tier=heavy |");
  });
  it("anthropic preset, larger budget: all of fast's variants first, then the covered medium is skipped for heavy", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER, { maxTotalAttempts: 10, costCeiling: { multiple: 40 } }), V2);
    const run = runLoop(policy, ratios(OWNER));
    const summary = run.actions.map((a) => [a.action, a.tier, a.variant, a.variantStep === true]);
    expect(summary.slice(0, 5)).toEqual([
      ["retry", "fast", "medium", true],
      ["retry", "fast", "high", true],
      ["retry", "fast", "xhigh", true],
      ["retry", "fast", "xhigh", false], // plain retry at the reached variant
      ["escalate", "heavy", "xhigh", false],
    ]);
    const escalation = run.actions[4]!;
    expect(escalation).toMatchObject({ agent: "heavy", model: OPUS, costRatio: 20 });
    // heavy sits at its base (the top of the capped catalog ladder), so it only retries once; that second
    // heavy attempt costs 20 and the cumulative cost (5 + 20 + 20 = 45) crosses the ×40 ceiling.
    expect(run.actions.slice(5).map((a) => a.action)).toEqual(["retry", "give_up"]);
    expect(run.actions[5]).toMatchObject({ tier: "heavy", model: OPUS, variant: "xhigh", costRatio: 20 });
    expect(run.actions[5]).not.toHaveProperty("variantStep");
    expect(run.actions[6]).toEqual({ action: "give_up", reason: "cost ceiling exceeded" });
    expect(run.state.cumulativeCost).toBe(45);
    expect(run.state.escalations).toBe(1);
    expect(run.state.currentTier).toBe("heavy");
    expect(run.state.currentVariant).toBeNull();
  });

  it("hybrid-2 preset (luna-fast#medium, sonnet#xhigh, opus#xhigh), real ratios: the ceiling stops it after sonnet#xhigh", () => {
    const policy = buildEscalatePolicy(makeConfig(HYBRID2), V2);
    expect(policy.variants!.perTier.fast!.ladder.variants).toEqual(["none", "low", "medium", "high", "xhigh"]);
    const run = runLoop(policy, ratios(HYBRID2));
    // 1 + 1 + 5 = 7 > 1 × 4 after the third attempt.
    expect(attemptTrace(policy, run)).toEqual([`${LUNA_FAST}#medium`, `${LUNA_FAST}#high`, `${SONNET}#xhigh`]);
    expect(run.actions.map((a) => a.action)).toEqual(["retry", "escalate", "give_up"]);
    expect(run.actions[2]).toEqual({ action: "give_up", reason: "cost ceiling exceeded" });
    expect(run.state.cumulativeCost).toBe(7);
  });

  it("hybrid-2 preset without the cost ceiling: luna#medium, luna#high, sonnet#xhigh, opus#xhigh", () => {
    const policy = buildEscalatePolicy(makeConfig(HYBRID2, GENEROUS), V2);
    const run = runLoop(policy, ratios(HYBRID2));
    expect(attemptTrace(policy, run)).toEqual([`${LUNA_FAST}#medium`, `${LUNA_FAST}#high`, `${SONNET}#xhigh`, `${OPUS}#xhigh`]);
    expect(run.actions.map((a) => a.action)).toEqual(["retry", "escalate", "escalate", "give_up"]);
    expect(run.actions[3]).toEqual({ action: "give_up", reason: "max total attempts (4) reached" });
  });
});

describe("costRatio of the rung an action runs (A17)", () => {
  it("builds costRatios from the tier's ratio, overridden by a candidate's own costRatio", () => {
    const withCandidates = {
      model: SONNET,
      variant: "low",
      costRatio: 1,
      candidates: [
        { variant: "low" },
        { variant: "medium", costRatio: 2 },
        { variant: "xhigh", costRatio: 6 },
        { model: OPUS, variant: "high", costRatio: 40 },
        { variant: "max", costRatio: -3 },
      ],
    };
    const policy = buildEscalatePolicy(makeConfig({ fast: withCandidates, medium: { model: SONNET, costRatio: 5 }, heavy: { model: OPUS } }), V2);
    const { fast, medium, heavy } = policy.variants!.perTier;
    // `max` is named by a candidate whose ratio is invalid: it stays on the ladder and charges the tier's ratio.
    expect(fast!.ladder.variants).toEqual(["low", "medium", "xhigh", "max"]);
    expect(fast!.costRatios).toEqual({ low: 1, medium: 2, xhigh: 6, max: 1 });
    // a tier without candidates charges its own ratio on every rung, default included
    expect(medium!.costRatios).toEqual({ default: 5, low: 5, medium: 5, high: 5, xhigh: 5 });
    // no ratio anywhere: nothing to report, the runner falls back to the tier
    expect(heavy!.costRatios).toEqual({});
  });

  it("carries the rung's ratio on variant steps, plain retries and escalations", () => {
    const policy = handPolicy(
      {
        fast: info(SONNET, "low", ["low", "medium", "xhigh"], 1_000_000, { low: 1, medium: 2, xhigh: 6 }),
        medium: info(OPUS, "high", ["high"], 800_000, { high: 9, default: 3 }),
        heavy: info(HAIKU, DEFAULT_VARIANT, [], 200_000, { default: 3 }),
      },
      { maxAttemptsPerTier: 1 },
    );
    expect(nextAction(sessionState(), fail, policy)).toMatchObject({ variantStep: true, variant: "medium", costRatio: 2 });
    expect(nextAction(sessionState({ currentVariant: "medium" }), fail, policy)).toMatchObject({ variantStep: true, variant: "xhigh", costRatio: 6 });
    const plain = nextAction(sessionState({ currentVariant: "xhigh" }), fail, policy);
    expect(plain).toMatchObject({ action: "retry", variant: "xhigh", costRatio: 6 });
    expect(plain).not.toHaveProperty("variantStep");
    expect(nextAction(sessionState({ currentVariant: "xhigh", attemptsThisTier: 1 }), fail, policy))
      .toMatchObject({ action: "escalate", tier: "medium", variant: "high", costRatio: 9 });
    // a default-based rung is keyed `default`
    expect(nextAction(sessionState({ currentTier: "medium", attemptsThisTier: 1, currentVariant: "high" }), fail, policy))
      .toMatchObject({ action: "escalate", tier: "heavy", costRatio: 3 });
    expect(nextAction(sessionState({ currentTier: "heavy" }), fail, policy)).toMatchObject({ action: "retry", tier: "heavy", costRatio: 3 });
  });

  it("omits costRatio when the rung is unknown, on a tier without info, and without a variant policy", () => {
    const policy = handPolicy({ fast: info(SONNET, "low", ["low", "medium"], 1_000_000, { low: 1 }) });
    const step = nextAction(sessionState(), fail, policy); // medium has no ratio
    expect(step).toMatchObject({ variantStep: true, variant: "medium" });
    expect(step).not.toHaveProperty("costRatio");
    expect(nextAction(sessionState({ attemptsThisTier: 1, currentVariant: "medium" }), fail, policy)).not.toHaveProperty("costRatio");
    const plain: EscalatePolicy = { ladder: ["fast", "medium"], maxAttemptsPerTier: 0, maxTotalAttempts: 4, costMultiple: null };
    expect(nextAction(sessionState(), fail, plain)).not.toHaveProperty("costRatio");
  });

  it("charges the action's ratio over the tier's in the real loop", () => {
    const tiers: Record<string, TierConfig> = {
      fast: {
        model: SONNET,
        variant: "low",
        costRatio: 1,
        ...{ candidates: [{ variant: "low", costRatio: 1 }, { variant: "medium", costRatio: 3 }, { variant: "high", costRatio: 9 }] },
      },
    };
    const policy = buildEscalatePolicy(makeConfig(tiers, { maxTotalAttempts: 4, ladder: ["fast"], costCeiling: { multiple: 100 } }), V2);
    const run = runLoop(policy, { charge: chargeBy(tiers) });
    expect(run.actions.map((a) => a.costRatio)).toEqual([3, 9, 9, undefined]); // the plain retry runs high again
    expect(run.state.cumulativeCost).toBe(1 + 3 + 9 + 9);
  });
});
describe("A17 budget reserve", () => {
  const perTier = { fast: info(SONNET, "low", ["low", "medium", "high", "xhigh"]), medium: info(OPUS, "medium", ["medium", "high"]) };

  it("steps only while maxTotalAttempts − totalAttempts − 1 ≥ the number of ladder tiers above (H)", () => {
    // ladder [fast, medium, heavy]: H(fast) = 2, H(medium) = 1, H(heavy) = 0.
    const policy = handPolicy(perTier, { maxTotalAttempts: 5 });
    expect(nextAction(sessionState({ totalAttempts: 2 }), fail, policy)).toMatchObject({ action: "retry", variantStep: true }); // 5-2-1 = 2 ≥ 2
    const escalated = nextAction(sessionState({ totalAttempts: 3 }), fail, policy); // 5-3-1 = 1 < 2
    expect(escalated).toMatchObject({ action: "escalate", tier: "medium", agent: "medium", model: OPUS, variant: "medium" });
    expect(escalated).not.toHaveProperty("variantStep");
    expect(nextAction(sessionState({ currentTier: "medium", totalAttempts: 3 }), fail, policy))
      .toMatchObject({ action: "retry", variantStep: true, variant: "high" }); // 5-3-1 = 1 ≥ 1
    expect(nextAction(sessionState({ currentTier: "medium", totalAttempts: 4 }), fail, policy))
      .toMatchObject({ action: "escalate", tier: "heavy" }); // 5-4-1 = 0 < 1
  });

  it("gates the plain retry too, and leaves the top tier unconstrained", () => {
    const policy = handPolicy({ fast: info(SONNET, "high", ["high"]), heavy: info(OPUS, "xhigh", ["xhigh"]) }, { maxTotalAttempts: 3 });
    // fast has no variant step left, attemptsThisTier 0 < 1, but 3-2-1 = 0 < 2: escalate.
    expect(nextAction(sessionState({ totalAttempts: 2 }), fail, policy)).toMatchObject({ action: "escalate", tier: "medium" });
    // heavy: H = 0, so the last allowed attempt may still retry.
    expect(nextAction(sessionState({ currentTier: "heavy", totalAttempts: 2 }), fail, policy)).toMatchObject({ action: "retry", tier: "heavy" });
    expect(nextAction(sessionState({ currentTier: "heavy", totalAttempts: 3 }), fail, policy)).toMatchObject({ action: "give_up" });
  });

  it("treats a tier that is not on the ladder as H = 0", () => {
    const policy = handPolicy({ fast: info(SONNET, "low", ["low", "medium"]) }, { ladder: ["medium", "heavy"], maxTotalAttempts: 2 });
    expect(nextAction(sessionState({ currentTier: "fast", totalAttempts: 1 }), fail, policy)).toMatchObject({ action: "retry", variantStep: true });
  });

  it("does not touch tiers without variant info", () => {
    const policy = handPolicy({ medium: info(OPUS, "medium", ["medium", "high"]) }, { maxTotalAttempts: 2 });
    const action = nextAction(sessionState({ totalAttempts: 1 }), fail, policy);
    expect(action).toMatchObject({ action: "retry", tier: "fast" }); // plain retry although 2-1-1 = 0 < 2
    expect(action).not.toHaveProperty("model");
    expect(action).not.toHaveProperty("variantStep");
  });

  it("never gives up early on a tier with variant info while total attempts remain and a higher tier exists", () => {
    for (let maxTotalAttempts = 1; maxTotalAttempts <= 8; maxTotalAttempts++) {
      const policy = handPolicy(perTier, { maxTotalAttempts, maxAttemptsPerTier: 2 });
      const run = runLoop(policy);
      expect(run.state.totalAttempts).toBeLessThanOrEqual(maxTotalAttempts);
      if (maxTotalAttempts >= 3) expect(run.state.escalations).toBeGreaterThanOrEqual(1); // the reserve reaches a higher tier
    }
  });
});
// ---------------------------------------------------------------------------
// Scorecard (§10) and purity
// ---------------------------------------------------------------------------

describe("formatLadderScorecard", () => {
  const base = sessionState();
  it("suffixes #variant after a variant step and leaves everything else alone", () => {
    expect(formatLadderScorecard({ ...base, currentVariant: "xhigh" }, false, "m")).toContain("final_tier=fast#xhigh |");
    expect(formatLadderScorecard({ ...base, currentVariant: null }, false, "m")).toContain("final_tier=fast |");
    expect(formatLadderScorecard({ ...base, currentVariant: undefined }, false, "m")).toContain("final_tier=fast |");
    expect(formatLadderScorecard({ ...base, currentVariant: "" }, false, "m")).toContain("final_tier=fast |");
  });

  it("prefers the effort suffix when both are somehow set", () => {
    expect(formatLadderScorecard({ ...base, currentEffort: "high", currentVariant: "xhigh" }, true, "m")).toContain("final_tier=fast@high |");
  });

  it("is byte-identical for a state without the new keys", () => {
    const plain: LadderState = {
      currentTier: "medium", attemptsThisTier: 0, totalAttempts: 2, escalations: 1, firstAttemptCost: 1, cumulativeCost: 3,
    };
    expect(formatLadderScorecard(plain, true, "unit")).toBe(
      "[router delegate scorecard | final_tier=medium | attempts=2 | escalations=1 | cost=3 | verdict=PASS | method=unit]",
    );
  });
});

describe("purity", () => {
  it("does not mutate a deeply frozen policy, state, verdict, session input or actions", () => {
    const policy = deepFreeze(buildEscalatePolicy(makeConfig(OWNER, { maxTotalAttempts: 10, costCeiling: { multiple: 40 } }), V2));
    const policyBefore = JSON.stringify(policy);
    const verdict = deepFreeze({ pass: false, outcome: "fail" as const, reasons: ["check failed"] });
    const session = deepFreeze({ dispatchPromptChars: 1234 });
    const child = deepFreeze({ sessionID: "ses_a", lastStepTokens: 4321 });
    let state = deepFreeze(newLadderState("fast", policy));
    for (let i = 0; i < 6; i++) {
      const recorded = deepFreeze(recordAttempt(state, 1, child));
      const recordedBefore = JSON.stringify(recorded);
      const action = deepFreeze(nextAction(recorded, verdict, policy, session));
      const actionBefore = JSON.stringify(action);
      const advanced = deepFreeze(advance(recorded, action));
      expect(JSON.stringify(recorded)).toBe(recordedBefore);
      expect(JSON.stringify(action)).toBe(actionBefore);
      expect(JSON.stringify(policy)).toBe(policyBefore);
      expect(advanced).not.toBe(recorded);
      if (action.action === "give_up") break;
      state = advanced;
    }
  });

  it("returns equal results for equal inputs", () => {
    const policy = buildEscalatePolicy(makeConfig(OWNER), V2);
    const state = recordAttempt(newLadderState("fast", policy), 1, { sessionID: "ses_a", lastStepTokens: 10 });
    expect(JSON.stringify(nextAction(state, fail, policy, { dispatchPromptChars: 9 })))
      .toBe(JSON.stringify(nextAction(state, fail, policy, { dispatchPromptChars: 9 })));
  });
});

// ---------------------------------------------------------------------------
// Seeded property run over random ladders and catalogs
// ---------------------------------------------------------------------------

describe("property-based: session-aware loop", () => {
  const MODELS = ["p/m1", "p/m2", "p/m3"];
  for (let seed = 1; seed <= 120; seed++) {
    it(`seed=${seed}: terminates, bounded variant steps, never emits an absent variant or default, never bypasses the ceiling`, () => {
      const rng = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

      // Random catalogs: a subset of the host order (sometimes shuffled), or no variants array at all.
      const catalog: Record<string, CatalogModel> = {};
      for (const model of MODELS) {
        const limit = rng() < 0.2 ? undefined : { input: 50_000 + Math.floor(rng() * 950_000) };
        if (rng() < 0.15) {
          catalog[model] = { limit };
          continue;
        }
        const ids = HOST_EFFORT_ORDER.filter(() => rng() < 0.6);
        if (rng() < 0.2) ids.reverse();
        catalog[model] = entry(ids, limit);
      }
      const catalogLookup = (model: string): CatalogModel | undefined => (Object.hasOwn(catalog, model) ? catalog[model] : undefined);

      const names = ["fast", "medium", "heavy", "ultra"].slice(0, 1 + Math.floor(rng() * 4));
      const tiers: Record<string, TierConfig> = {};
      for (const name of names) {
        const model = pick(MODELS);
        const ids = catalogVariantIds(catalogLookup(model)) ?? [];
        const tier: TierConfig & { candidates?: unknown } = { model };
        const roll = rng();
        if (roll < 0.4 && ids.length > 0) tier.variant = pick(ids);
        else if (roll < 0.5) tier.effort = "low";
        if (rng() < 0.2 && ids.length > 0) tier.candidates = [{ variant: pick(ids) }, { variant: pick([...ids, "turbo"]) }];
        tiers[name] = tier;
      }
      const maxAttemptsPerTier = Math.floor(rng() * 4);
      const maxTotalAttempts = 1 + Math.floor(rng() * 10);
      const multiple = 1 + Math.floor(rng() * 5);
      const config = makeConfig(tiers, {
        ladder: names,
        maxAttemptsPerTier,
        maxTotalAttempts,
        costCeiling: { multiple },
        effortBumpMax: pick(EFFORT_LEVELS),
        floorTier: rng() < 0.2 ? pick(names) : null,
      });
      const policy = buildEscalatePolicy(config, { host: "v2", catalog: catalogLookup, maxContextFraction: pick([0.3, 0.6, 1]) });

      // One effort delivery per tier: a tier on the effort bump never has a variant to step to.
      for (const tier of Object.keys(policy.variants?.perTier ?? {})) {
        if (Object.keys(policy.effortBump?.perTier ?? {}).includes(tier)) {
          expect(policy.variants!.perTier[tier]!.ladder.variants).toEqual([]);
        }
      }

      let state = newLadderState(names[0]!, policy);
      const stepsPerVisit = new Map<string, number>();
      let cycles = 0;
      let done = false;
      while (!done) {
        const cost = Math.floor(rng() * 11);
        state = recordAttempt(state, cost, {
          sessionID: `ses_${cycles}`,
          lastStepTokens: rng() < 0.2 ? null : Math.floor(rng() * 600_000),
        });
        cycles++;
        const verdict: LadderVerdict = rng() < 0.1 ? { pass: true } : { pass: false, reasons: ["failure"] };
        const action = nextAction(state, verdict, policy, { dispatchPromptChars: Math.floor(rng() * 50_000) });

        const exceeded = state.firstAttemptCost != null && state.cumulativeCost > state.firstAttemptCost * multiple;
        if (state.totalAttempts >= maxTotalAttempts || exceeded) {
          expect(action.action).not.toBe("retry");
          expect(action.action).not.toBe("escalate");
        }
        if (verdict.pass) expect(action.action).toBe("accept");
        // A17: a retry on a tier with variant info always leaves one attempt for every tier above it.
        if (action.action === "retry" && policy.variants?.perTier[state.currentTier]) {
          const above = policy.ladder.length - 1 - policy.ladder.indexOf(state.currentTier);
          expect(maxTotalAttempts - state.totalAttempts - 1).toBeGreaterThanOrEqual(above);
        }

        if (action.costRatio !== undefined) expect(action.costRatio).toBeGreaterThan(0);
        if (action.carryVariant === true) {
          expect(action.action).toBe("escalate");
          expect(action.variant).toBeDefined();
        }
        if (action.variant !== undefined) {
          expect(action.variant).not.toBe(DEFAULT_VARIANT);
          expect(action.model).toBeDefined();
          expect(catalogVariantIds(catalogLookup(action.model!)) ?? []).toContain(action.variant);
        }
        if (action.action === "retry" || action.action === "escalate") {
          if (policy.variants) {
            expect(typeof action.resume).toBe("boolean");
            expect(action.resumeBasis?.resume).toBe(action.resume);
            if (action.resume) expect(action.resumeBasis!.tokens!).toBeLessThan(action.resumeBasis!.threshold!);
          } else {
            for (const key of ["variantStep", "agent", "model", "variant", "resume", "resumeBasis"]) {
              expect(action).not.toHaveProperty(key);
            }
          }
        }
        if (action.variantStep === true) {
          expect(action.action).toBe("retry");
          const key = `${state.escalations}:${state.currentTier}`;
          const count = (stepsPerVisit.get(key) ?? 0) + 1;
          stepsPerVisit.set(key, count);
          expect(count).toBeLessThanOrEqual(policy.variants!.perTier[state.currentTier]!.ladder.variants.length);
        }

        if (action.action === "accept" || action.action === "give_up") {
          done = true;
        } else {
          const before = state;
          state = advance(state, action);
          if (action.variantStep === true) {
            expect(state.attemptsThisTier).toBe(before.attemptsThisTier);
            expect(state.variantSteps).toBe((before.variantSteps ?? 0) + 1);
          } else if (action.action === "retry") {
            expect(state.attemptsThisTier).toBe(before.attemptsThisTier + 1);
          } else {
            expect(state.attemptsThisTier).toBe(0);
            expect(state.escalations).toBe(before.escalations + 1);
          }
          if (policy.variants) {
            expect(state.lastStepTokens).toBeNull();
            if (action.resume !== true) expect(state.childSessionID).toBeNull();
          }
        }
        expect(cycles).toBeLessThanOrEqual(maxTotalAttempts);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Goldens: both fixtures byte-identical with variants off (§11 point 8)
// ---------------------------------------------------------------------------

interface GoldenInput { state: LadderState; verdict: LadderVerdict; accepted: boolean; method: string }
interface GoldenEntry { id: string; input: GoldenInput }
interface GoldenSequence { producerTier: string; stream: string; costPerAttempt: number; steps: GoldenEntry[] }
interface GoldenPolicy { name: string; policy: EscalatePolicy; matrix: GoldenEntry[]; sequences: GoldenSequence[] }
interface GoldenFile { version: string; policies: GoldenPolicy[] }

interface CostInput { state: LadderState; verdict: LadderVerdict; policy: EscalatePolicy }
interface CostEntry { input: CostInput }
interface CostSequence { producerTier: string; tierCosts: Record<string, number>; steps: CostEntry[] }
interface CostFile { version: string; source: string; matrix: CostEntry[]; sequences: CostSequence[] }

describe("goldens replay byte-identically with variants off", () => {
  const goldenUrl = new URL("./__fixtures__/ladder-v2.0.0-golden.json", import.meta.url);
  const costUrl = new URL("./__fixtures__/ladder-v2.0.0-golden-cost.json", import.meta.url);
  const read = (url: URL) => readFileSync(url, "utf8").replace(/\r\n/g, "\n");
  const golden: GoldenFile = JSON.parse(read(goldenUrl));
  const cost: CostFile = JSON.parse(read(costUrl));

  const base: RouterConfig = { activePreset: "default", presets: {}, rules: [], defaultTier: "fast" };
  const configs: Record<string, RouterConfig> = {
    default: base,
    "two-attempts-per-tier": { ...base, enforcement: { escalate: { maxAttemptsPerTier: 2 } } },
    "floor-medium": { ...base, enforcement: { escalate: { floorTier: "medium" } } },
  };
  const everything: CatalogModel = entry(["low", "medium", "high", "xhigh", "max"], { input: 1_000_000 });
  const sessions: Record<string, LadderSessionPolicyInput> = {
    v1: { host: "v1", catalog: () => everything },
    none: { host: "v2", variantSteps: "none", catalog: () => everything },
    "no-catalog": { host: "v2", catalog: () => undefined },
  };

  /** Recompute the whole golden document from the recorded inputs, with `policyFor` choosing the policy. */
  function replayGolden(policyFor: (recorded: GoldenPolicy) => EscalatePolicy) {
    return {
      version: golden.version,
      policies: golden.policies.map((recorded) => {
        const policy = policyFor(recorded);
        const capture = (state: LadderState, verdict: LadderVerdict, method: string) => {
          const action = nextAction(state, verdict, policy);
          const advanced = advance(state, action);
          const accepted = action.action === "accept";
          return {
            input: { state, verdict, accepted, method },
            output: {
              nextAction: action,
              advance: advanced,
              formatLadderScorecard: formatLadderScorecard(advanced, accepted, method),
            },
          };
        };
        const matrix = recorded.matrix.map((e) => ({ id: e.id, ...capture(e.input.state, e.input.verdict, e.input.method) }));
        const sequences = recorded.sequences.map((sequence) => {
          const initialState = newLadderState(sequence.producerTier, policy);
          let state = initialState;
          const steps = sequence.steps.map((step) => {
            state = recordAttempt(state, sequence.costPerAttempt);
            const captured = capture(state, step.input.verdict, step.input.method);
            state = captured.output.advance;
            return captured;
          });
          return {
            producerTier: sequence.producerTier,
            stream: sequence.stream,
            costPerAttempt: sequence.costPerAttempt,
            initialState,
            steps,
            finalScorecard: steps.at(-1)!.output.formatLadderScorecard,
          };
        });
        return { name: recorded.name, policy: recorded.policy, matrix, sequences };
      }),
    };
  }

  function replayCost(policyFor: (recorded: EscalatePolicy) => EscalatePolicy) {
    const capture = (state: LadderState, verdict: LadderVerdict, recorded: EscalatePolicy) => {
      const policy = policyFor(recorded);
      const action = nextAction(state, verdict, policy);
      const advanced = advance(state, action);
      return {
        input: { state, verdict, policy: recorded },
        output: {
          action,
          advanced,
          scorecard: formatLadderScorecard(advanced, action.action === "accept", "golden-cost-v2.0.0"),
        },
      };
    };
    return {
      version: cost.version,
      source: cost.source,
      matrix: cost.matrix.map((e) => capture(e.input.state, e.input.verdict, e.input.policy)),
      sequences: cost.sequences.map((sequence) => {
        const recorded = sequence.steps[0]!.input.policy;
        const policy = policyFor(recorded);
        const initialState = newLadderState(sequence.producerTier, policy);
        let state = initialState;
        const steps = sequence.steps.map((step) => {
          state = recordAttempt(state, sequence.tierCosts[state.currentTier]!);
          const captured = capture(state, step.input.verdict, recorded);
          state = captured.output.advanced;
          return captured;
        });
        return { producerTier: sequence.producerTier, tierCosts: sequence.tierCosts, initialState, steps };
      }),
    };
  }

  const bytes = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  it("covers the whole fixtures (guards against an empty replay)", () => {
    expect(golden.policies.map((p) => p.name)).toEqual(Object.keys(configs));
    for (const p of golden.policies) {
      expect(p.matrix.length).toBeGreaterThan(100);
      expect(p.sequences).toHaveLength(9);
    }
    expect(cost.matrix).toHaveLength(576);
    expect(cost.sequences).toHaveLength(6);
  });

  it("builds the same policy bytes as one argument for v1, variantSteps none and a catalog without entries", () => {
    for (const [name, cfg] of Object.entries(configs)) {
      const recorded = golden.policies.find((p) => p.name === name)!.policy;
      const oneArg = JSON.stringify(buildEscalatePolicy(cfg));
      expect(oneArg).toBe(JSON.stringify(recorded));
      for (const session of Object.values(sessions)) {
        const policy = buildEscalatePolicy(cfg, session);
        expect(policy).not.toHaveProperty("variants");
        expect(JSON.stringify(policy)).toBe(oneArg);
      }
    }
  });

  it("replays golden v2.0.0 with the recorded policy plus variants: null", () => {
    const actual = replayGolden((recorded) => ({ ...recorded.policy, variants: null }));
    expect(bytes(actual)).toBe(read(goldenUrl));
  });

  it("replays golden v2.0.0 with variants: null and effortBump: null together", () => {
    const actual = replayGolden((recorded) => ({ ...recorded.policy, effortBump: null, variants: null }));
    expect(bytes(actual)).toBe(read(goldenUrl));
  });

  for (const [label, session] of Object.entries(sessions)) {
    it(`replays golden v2.0.0 with buildEscalatePolicy(cfg, ${label})`, () => {
      const actual = replayGolden((recorded) => buildEscalatePolicy(configs[recorded.name]!, session));
      expect(bytes(actual)).toBe(read(goldenUrl));
    });
  }

  it("replays golden v2.0.0 with the policy built from one argument", () => {
    const actual = replayGolden((recorded) => buildEscalatePolicy(configs[recorded.name]!));
    expect(bytes(actual)).toBe(read(goldenUrl));
  });

  it("replays the cost golden with the recorded policy and with variants: null", () => {
    expect(bytes(replayCost((recorded) => recorded))).toBe(read(costUrl));
    expect(bytes(replayCost((recorded) => ({ ...recorded, variants: null })))).toBe(read(costUrl));
  });

  it("ignores a session argument when the policy has no variants", () => {
    for (const e of cost.matrix.slice(0, 200)) {
      const withArg = nextAction(e.input.state, e.input.verdict, e.input.policy, { dispatchPromptChars: 123_456 });
      expect(JSON.stringify(withArg)).toBe(JSON.stringify(nextAction(e.input.state, e.input.verdict, e.input.policy)));
    }
  });
});
